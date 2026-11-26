// EscolarGo · servidor (Node puro + SSE para tiempo real)
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const db = require('./db');

const PORT = Number(process.env.PORT || 3000);
const TZ = process.env.TZ_SCHOOL || 'America/Bogota';
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const AVG_KMH = Number(process.env.AVG_SPEED_KMH || 18); // velocidad promedio en ciudad para el tiempo estimado
const NEAR_MIN = Number(process.env.NEAR_MINUTES || 5); // aviso "el bus está cerca"
const SPEED_LIMIT = Number(process.env.SPEED_LIMIT_KMH || 60);
const PUBLIC = path.join(__dirname, 'public');

// ---------- Web Push (opcional: se activa si hay llaves VAPID) ----------
let webpush = null;
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  try {
    webpush = require('web-push');
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:soporte@escolargo.app',
      process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
    console.log('[push] notificaciones push activas');
  } catch (e) { console.log('[push] web-push no disponible:', e.message); webpush = null; }
}

// ---------- utilidades ----------
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
const b64u = (b) => Buffer.from(b).toString('base64url');
function sign(payload) {
  const body = b64u(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function verify(token) {
  if (!token || typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const want = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p.exp > Date.now() ? p : null;
  } catch { return null; }
}
function haversineKm(a, b) {
  const R = 6371, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const minTxt = (m) => (m <= 1 ? '1 minuto' : `unos ${m} minutos`);
const minutesFor = (km) => Math.max(1, Math.round(((km * 1.35) / AVG_KMH) * 60)); // 1.35 = factor de calles vs. línea recta

// ---------- calles reales (OSRM sobre OpenStreetMap) ----------
// Servidor de prueba gratuito; para producción conviene uno propio o un proveedor pago (OSRM_URL).
const OSRM = process.env.OSRM_URL || 'https://router.project-osrm.org';
async function osrm(pathAndQuery) {
  try {
    const r = await fetch(`${OSRM}${pathAndQuery}`, { headers: { 'User-Agent': 'EscolarGo/0.1 (rutas escolares)' }, signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    const j = await r.json();
    return j.code === 'Ok' ? j : null;
  } catch { return null; }
}
const ll = (p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`;
async function routeVia(points) {
  if (points.length < 2) return null;
  const j = await osrm(`/route/v1/driving/${points.map(ll).join(';')}?overview=full&geometries=geojson`);
  if (!j || !j.routes || !j.routes[0]) return null;
  const r = j.routes[0];
  return { coords: r.geometry.coordinates.map(([lng, lat]) => [lat, lng]), legs: r.legs.map((l) => ({ duration: l.duration, distance: l.distance })) };
}
async function streetAt(lat, lng) {
  const j = await osrm(`/nearest/v1/driving/${lng.toFixed(6)},${lat.toFixed(6)}?number=1`);
  const w = j && j.waypoints && j.waypoints[0];
  return w && w.name && w.distance < 80 ? w.name : null;
}
const planCache = new Map(); // tripId -> { key, at, route }
const streetCache = new Map(); // tripId -> { at, lat, lng, street }

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (status, msg) => { throw new HttpError(status, msg); };

function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
async function readBody(req) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > 64 * 1024) fail(413, 'Solicitud muy grande'); chunks.push(c); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { fail(400, 'JSON inválido'); }
}
const str = (v, max = 500) => String(v ?? '').trim().slice(0, max);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

// ---------- tiempo real (Server-Sent Events) ----------
const streams = new Map(); // userId -> Set<res>
function emit(userIds, event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const id of new Set(userIds)) for (const res of streams.get(id) || []) res.write(msg);
}
setInterval(() => { for (const set of streams.values()) for (const res of set) res.write(': ping\n\n'); }, 25000);

async function notify(userIds, title, body, kind = 'info', extra = {}) {
  const at = Date.now();
  for (const uid of new Set(userIds)) {
    const n = await db.run('INSERT INTO notifications (user_id, title, body, kind, at) VALUES (?,?,?,?,?) RETURNING id', [uid, title, body, kind, at]);
    emit([uid], 'notification', { id: n.id, title, body, kind, at, ...extra });
    if (webpush) {
      const subs = await db.all('SELECT endpoint, sub_json FROM push_subs WHERE user_id = ?', [uid]);
      for (const s of subs) {
        webpush.sendNotification(JSON.parse(s.sub_json), JSON.stringify({ title, body, kind, tag: extra.tag }))
          .catch((e) => { if (e.statusCode === 404 || e.statusCode === 410) db.run('DELETE FROM push_subs WHERE endpoint = ?', [s.endpoint]); });
      }
    }
  }
}

// ---------- consultas de dominio ----------
async function routeAudience(routeId) {
  const r = await db.one('SELECT school_id, aide_id FROM routes WHERE id = ?', [routeId]);
  const parents = await db.all(`SELECT DISTINCT ps.parent_id AS id FROM parent_students ps JOIN students s ON s.id = ps.student_id WHERE s.route_id = ?`, [routeId]);
  const school = await db.all(`SELECT id FROM users WHERE role = 'colegio' AND school_id = ?`, [r.school_id]);
  return { aide: r.aide_id, parents: parents.map((p) => p.id), school: school.map((s) => s.id) };
}
async function parentsOf(studentId) {
  return (await db.all('SELECT parent_id AS id FROM parent_students WHERE student_id = ?', [studentId])).map((r) => r.id);
}
async function activeTrip(routeId) {
  return db.one(`SELECT * FROM trips WHERE route_id = ? AND status = 'activa' ORDER BY id DESC LIMIT 1`, [routeId]);
}
async function routeDetail(routeId) {
  return db.one(`SELECT r.id, r.name, r.driver_name, r.driver_phone, r.school_id, u.id AS aide_id, u.name AS aide_name, u.phone AS aide_phone,
      v.plate, v.brand, v.model, v.year, v.capacity, sc.name AS school_name, sc.lat AS school_lat, sc.lng AS school_lng
    FROM routes r LEFT JOIN users u ON u.id = r.aide_id LEFT JOIN vehicles v ON v.id = r.vehicle_id JOIN schools sc ON sc.id = r.school_id WHERE r.id = ?`, [routeId]);
}
// Estado de cada estudiante en el recorrido actual: pendiente | subio | bajo | no_salio | no_va | en_colegio
async function studentStates(routeId, trip, shift) {
  const students = await db.all('SELECT id, name, grade, address, lat, lng, stop_order FROM students WHERE route_id = ? ORDER BY stop_order, id', [routeId]);
  const absent = new Set((await db.all('SELECT student_id FROM absences WHERE day = ? AND shift = ?', [today(), shift])).map((a) => a.student_id));
  const events = trip ? await db.all('SELECT student_id, type, at FROM trip_events WHERE trip_id = ? AND student_id IS NOT NULL ORDER BY at', [trip.id]) : [];
  const last = new Map(); const times = new Map();
  for (const e of events) { if (e.type !== 'cerca') last.set(e.student_id, e.type); times.set(`${e.student_id}:${e.type}`, e.at); }
  return students.map((s) => {
    let state = 'pendiente';
    if (absent.has(s.id)) state = 'no_va';
    const ev = last.get(s.id);
    if (ev === 'subio') state = 'subio';
    else if (ev === 'bajo') state = 'bajo';
    else if (ev === 'no_salio') state = 'no_salio';
    else if (ev === 'en_colegio') state = 'en_colegio';
    return { ...s, state, boarded_at: times.get(`${s.id}:subio`) || null, dropped_at: times.get(`${s.id}:bajo`) || times.get(`${s.id}:en_colegio`) || null, near_sent: times.has(`${s.id}:cerca`) };
  });
}
// Paradas que faltan, en orden, y minutos estimados hasta cada una (y hasta el colegio en la mañana).
// Usa la ruta por calles reales si está disponible; si no, una estimación en línea recta.
async function etaPlan(trip, route, states) {
  if (!trip || trip.last_lat == null) return { stops: [], school_min: null, plan: null };
  const pendingStops = states.filter((s) => trip.shift === 'manana' ? s.state === 'pendiente' : s.state === 'subio');
  const bus = { lat: trip.last_lat, lng: trip.last_lng };
  const way = []; const stopIndex = new Map();
  for (const s of pendingStops) {
    const key = `${s.lat},${s.lng}`;
    if (!stopIndex.has(key)) { way.push({ lat: s.lat, lng: s.lng }); stopIndex.set(key, way.length - 1); }
  }
  const school = { lat: route.school_lat, lng: route.school_lng };
  if (trip.shift === 'manana') way.push(school);
  // Ruta por calles, guardada en memoria para no consultar en cada actualización del GPS
  const key = way.map((p) => `${p.lat},${p.lng}`).join('|');
  const posKey = `${bus.lat.toFixed(3)},${bus.lng.toFixed(3)}`;
  let c = planCache.get(trip.id);
  if (way.length && (!c || c.key !== key || (c.posKey !== posKey && Date.now() - c.at > 15000))) {
    const r = await routeVia([bus, ...way]);
    if (r) { c = { key, posKey, at: Date.now(), route: r }; planCache.set(trip.id, c); }
  }
  const real = c && c.key === key ? c.route : null;
  // minutos acumulados hasta cada punto de "way"
  const mins = []; let acc = 0, pos = bus;
  for (let i = 0; i < way.length; i++) {
    if (real && real.legs[i]) acc += (real.legs[i].duration * 1.3) / 60 + (i > 0 ? 1 : 0); // +30 % por ser buseta y 1 min por parada
    else acc += minutesFor(haversineKm(pos, way[i])) + (i > 0 ? 1 : 0);
    pos = way[i]; mins.push(Math.max(1, Math.round(acc)));
  }
  const stops = pendingStops.map((s) => ({ student_id: s.id, minutes: mins[stopIndex.get(`${s.lat},${s.lng}`)] }));
  const school_min = trip.shift === 'manana' && mins.length ? mins[mins.length - 1] : null;
  return { stops, school_min, plan: real ? real.coords : null };
}

async function tripSnapshot(routeId) {
  const route = await routeDetail(routeId);
  const trip = await activeTrip(routeId);
  const shift = trip ? trip.shift : (Number(new Date().toLocaleString('en-US', { timeZone: TZ, hour: 'numeric', hour12: false })) < 12 ? 'manana' : 'tarde');
  const states = await studentStates(routeId, trip, shift);
  const eta = await etaPlan(trip, route, states);
  let trail = [], streets = [];
  if (trip) {
    trail = (await db.all('SELECT lat, lng FROM trip_points WHERE trip_id = ? ORDER BY id DESC LIMIT 2000', [trip.id])).reverse().map((p) => [p.lat, p.lng]);
    streets = await db.all('SELECT street, at FROM trip_streets WHERE trip_id = ? ORDER BY id DESC LIMIT 40', [trip.id]);
  }
  return { route, trip, shift, states, eta, trail, streets, street: streets[0] ? streets[0].street : null };
}

// ---------- autorización ----------
async function auth(req, url) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : url.searchParams.get('token');
  const p = verify(token);
  if (!p) fail(401, 'Inicia sesión de nuevo');
  const u = await db.one('SELECT id, role, name, login, phone, school_id FROM users WHERE id = ?', [p.uid]);
  if (!u) fail(401, 'Usuario no encontrado');
  return u;
}
const need = (u, ...roles) => { if (!roles.includes(u.role)) fail(403, 'No tienes permiso para esto'); };
async function aideRoute(u) {
  const r = await db.one('SELECT id FROM routes WHERE aide_id = ? ORDER BY id LIMIT 1', [u.id]);
  if (!r) fail(404, 'No tienes una ruta asignada');
  return r.id;
}
async function canSeeThread(u, routeId, parentId) {
  const r = await db.one('SELECT school_id, aide_id FROM routes WHERE id = ?', [routeId]);
  if (!r) return false;
  if (u.role === 'colegio') return r.school_id === u.school_id;
  if (u.role === 'auxiliar') return r.aide_id === u.id;
  if (u.role === 'padre') {
    if (parentId !== u.id) return false;
    return !!(await db.one('SELECT 1 AS ok FROM parent_students ps JOIN students s ON s.id = ps.student_id WHERE ps.parent_id = ? AND s.route_id = ?', [u.id, routeId]));
  }
  return false;
}

// ---------- rutas de la API ----------
const routes = [];
const api = (method, pattern, handler) => routes.push({ method, pattern, handler });

api('POST', '/api/login', async ({ body }) => {
  const u = await db.one('SELECT * FROM users WHERE login = ?', [str(body.login, 80).toLowerCase()]);
  if (!u || !db.checkPassword(str(body.password, 200), u.pass_hash)) fail(401, 'Usuario o contraseña incorrectos');
  const token = sign({ uid: u.id, exp: Date.now() + 30 * 24 * 3600 * 1000 });
  return { token, user: { id: u.id, name: u.name, role: u.role } };
});

api('GET', '/api/me', async ({ u }) => ({ user: u }));

// --- padres ---
api('GET', '/api/parent/overview', async ({ u }) => {
  need(u, 'padre');
  const kids = await db.all(`SELECT s.id, s.route_id FROM students s JOIN parent_students ps ON ps.student_id = s.id WHERE ps.parent_id = ?`, [u.id]);
  const routeIds = [...new Set(kids.map((k) => k.route_id).filter(Boolean))];
  const mine = new Set(kids.map((k) => k.id));
  const out = [];
  for (const rid of routeIds) {
    const snap = await tripSnapshot(rid);
    const myStates = snap.states.filter((s) => mine.has(s.id));
    const ids = myStates.map((s) => s.id);
    const events = snap.trip ? await db.all(`SELECT e.type, e.at, e.note, e.student_id, s.name AS student_name FROM trip_events e LEFT JOIN students s ON s.id = e.student_id
        WHERE e.trip_id = ? AND (e.student_id IS NULL OR e.student_id IN (${ids.map(() => '?').join(',') || 'NULL'})) ORDER BY e.at`, [snap.trip.id, ...ids]) : [];
    out.push({
      route: snap.route, shift: snap.shift,
      trip: snap.trip && { id: snap.trip.id, shift: snap.trip.shift, started_at: snap.trip.started_at, lat: snap.trip.last_lat, lng: snap.trip.last_lng, last_at: snap.trip.last_at },
      kids: myStates.map((s) => ({ ...s, eta_min: (snap.eta.stops.find((x) => x.student_id === s.id) || {}).minutes ?? null })),
      school_eta_min: snap.eta.school_min,
      plan: snap.eta.plan, trail: snap.trail, street: snap.street, streets: snap.streets,
      riders: snap.states.filter((s) => s.state === 'subio').length,
      events,
    });
  }
  return { routes: out, day: today() };
});

api('POST', '/api/parent/absence', async ({ u, body }) => {
  need(u, 'padre');
  const sid = num(body.student_id); const shift = body.shift === 'tarde' ? 'tarde' : 'manana';
  if (!(await db.one('SELECT 1 AS ok FROM parent_students WHERE parent_id = ? AND student_id = ?', [u.id, sid]))) fail(403, 'Ese estudiante no está a tu cargo');
  const day = today();
  if (body.cancel) await db.run('DELETE FROM absences WHERE student_id = ? AND day = ? AND shift = ?', [sid, day, shift]);
  else if (!(await db.one('SELECT 1 AS ok FROM absences WHERE student_id = ? AND day = ? AND shift = ?', [sid, day, shift])))
    await db.run('INSERT INTO absences (student_id, day, shift, by_user) VALUES (?,?,?,?)', [sid, day, shift, u.id]);
  const s = await db.one('SELECT name, route_id FROM students WHERE id = ?', [sid]);
  const aud = await routeAudience(s.route_id);
  const jornada = shift === 'manana' ? 'en la mañana' : 'en la tarde';
  await notify([aud.aide], body.cancel ? `${s.name} sí va hoy` : `${s.name} no va hoy ${jornada}`, `Aviso de ${u.name}`, 'ausencia');
  emit([aud.aide, ...aud.school], 'refresh', { route_id: s.route_id });
  return { ok: true };
});

// --- auxiliar de ruta ---
api('GET', '/api/aide/overview', async ({ u }) => {
  need(u, 'auxiliar');
  const snap = await tripSnapshot(await aideRoute(u));
  return { route: snap.route, trip: snap.trip, shift: snap.shift, students: snap.states.map((s) => ({ ...s, eta_min: (snap.eta.stops.find((x) => x.student_id === s.id) || {}).minutes ?? null })), school_eta_min: snap.eta.school_min,
    plan: snap.eta.plan, trail: snap.trail, street: snap.street, streets: snap.streets,
    panic: (await panicInfo('p.route_id = ? AND p.closed_at IS NULL', [snap.route.id]))[0] || null,
    school_phone: ((await db.one(`SELECT phone FROM users WHERE role = 'colegio' AND school_id = ? AND phone IS NOT NULL ORDER BY id LIMIT 1`, [snap.route.school_id])) || {}).phone || null };
});

api('POST', '/api/aide/trip/start', async ({ u, body }) => {
  need(u, 'auxiliar');
  const rid = await aideRoute(u);
  if (await activeTrip(rid)) fail(409, 'Ya hay una ruta en curso');
  const shift = body.shift === 'tarde' ? 'tarde' : 'manana';
  const now = Date.now();
  const lat = num(body.lat), lng = num(body.lng);
  const t = await db.run('INSERT INTO trips (route_id, shift, status, started_at, last_lat, last_lng, last_at) VALUES (?,?,?,?,?,?,?) RETURNING id', [rid, shift, 'activa', now, lat, lng, lat != null ? now : null]);
  await db.run('INSERT INTO trip_events (trip_id, type, at, lat, lng) VALUES (?,?,?,?,?)', [t.id, 'inicio', now, lat, lng]);
  const route = await routeDetail(rid);
  const states = await studentStates(rid, null, shift);
  const going = states.filter((s) => s.state !== 'no_va');
  const parentIds = new Set();
  for (const s of going) for (const p of await parentsOf(s.id)) parentIds.add(p);
  const aud = await routeAudience(rid);
  const msg = shift === 'manana' ? `Salió a recoger a los estudiantes. Vehículo ${route.plate}.` : `Salió del colegio con los estudiantes. Vehículo ${route.plate}.`;
  await notify([...parentIds], `${route.name} arrancó`, msg, 'inicio', { tag: `trip-${t.id}` });
  emit([aud.aide, ...aud.school, ...aud.parents], 'refresh', { route_id: rid });
  return { trip_id: t.id };
});

api('POST', '/api/aide/location', async ({ u, body }) => {
  need(u, 'auxiliar');
  const rid = await aideRoute(u);
  const trip = await activeTrip(rid);
  if (!trip) fail(409, 'No hay ruta en curso');
  const lat = num(body.lat), lng = num(body.lng);
  if (lat == null || lng == null || Math.abs(lat) > 90 || Math.abs(lng) > 180) fail(400, 'Ubicación inválida');
  const now = Date.now();
  let speed = num(body.speed_kmh);
  if (speed == null && trip.last_lat != null && trip.last_at) {
    const h = (now - trip.last_at) / 3600000;
    if (h > 5 / 3600) speed = haversineKm({ lat: trip.last_lat, lng: trip.last_lng }, { lat, lng }) / h;
  }
  await db.run('UPDATE trips SET last_lat = ?, last_lng = ?, last_at = ?, speed_kmh = ? WHERE id = ?', [lat, lng, now, speed, trip.id]);
  if (trip.last_lat == null || haversineKm({ lat: trip.last_lat, lng: trip.last_lng }, { lat, lng }) > 0.015)
    await db.run('INSERT INTO trip_points (trip_id, lat, lng, at) VALUES (?,?,?,?)', [trip.id, lat, lng, now]);
  // Nombre de la calle (como máximo cada 8 segundos y si el bus se movió)
  const sc = streetCache.get(trip.id);
  if (!sc || (now - sc.at > 8000 && haversineKm(sc, { lat, lng }) > 0.04)) {
    streetCache.set(trip.id, { at: now, lat, lng, street: sc && sc.street });
    const street = await streetAt(lat, lng);
    if (street && (!sc || sc.street !== street)) {
      streetCache.set(trip.id, { at: now, lat, lng, street });
      await db.run('INSERT INTO trip_streets (trip_id, street, at) VALUES (?,?,?)', [trip.id, street, now]);
    }
  }
  const snap = await tripSnapshot(rid);
  const aud = await routeAudience(rid);
  emit([aud.aide, ...aud.school, ...aud.parents], 'location', { route_id: rid, lat, lng, at: now, street: snap.street });
  // Aviso "el bus está cerca" (una vez por estudiante y recorrido)
  for (const stop of snap.eta.stops) {
    const s = snap.states.find((x) => x.id === stop.student_id);
    if (!s || s.near_sent || stop.minutes > NEAR_MIN) continue;
    await db.run('INSERT INTO trip_events (trip_id, student_id, type, at, lat, lng) VALUES (?,?,?,?,?,?)', [trip.id, s.id, 'cerca', now, lat, lng]);
    const txt = trip.shift === 'manana' ? `El bus de ${s.name} llega a tu parada en ${minTxt(stop.minutes)}.` : `${s.name} llega a casa en ${minTxt(stop.minutes)}.`;
    await notify(await parentsOf(s.id), 'El bus está cerca', txt, 'cerca', { tag: `near-${trip.id}-${s.id}` });
  }
  // Alerta de velocidad para el colegio (máximo una cada 5 minutos)
  if (speed != null && speed > SPEED_LIMIT && body.simulated !== true) {
    const lastAlert = await db.one(`SELECT at FROM trip_events WHERE trip_id = ? AND type = 'velocidad' ORDER BY at DESC LIMIT 1`, [trip.id]);
    if (!lastAlert || now - lastAlert.at > 5 * 60000) {
      await db.run('INSERT INTO trip_events (trip_id, type, note, at, lat, lng) VALUES (?,?,?,?,?,?)', [trip.id, 'velocidad', `${Math.round(speed)} km/h`, now, lat, lng]);
      await notify(aud.school, `Exceso de velocidad · ${snap.route.name}`, `${Math.round(speed)} km/h (límite ${SPEED_LIMIT}).`, 'alerta');
    }
  }
  return { ok: true, street: snap.street };
});

api('POST', '/api/aide/student', async ({ u, body }) => {
  need(u, 'auxiliar');
  const rid = await aideRoute(u);
  const trip = await activeTrip(rid);
  if (!trip) fail(409, 'Primero inicia la ruta');
  const sid = num(body.student_id);
  const s = await db.one('SELECT id, name FROM students WHERE id = ? AND route_id = ?', [sid, rid]);
  if (!s) fail(404, 'Estudiante no encontrado en tu ruta');
  const type = body.type;
  const now = Date.now();
  if (type === 'deshacer') {
    const last = await db.one(`SELECT id FROM trip_events WHERE trip_id = ? AND student_id = ? AND type <> 'cerca' ORDER BY at DESC, id DESC LIMIT 1`, [trip.id, sid]);
    if (last) await db.run('DELETE FROM trip_events WHERE id = ?', [last.id]);
  } else {
    if (!['subio', 'bajo', 'no_salio'].includes(type)) fail(400, 'Acción no válida');
    await db.run('INSERT INTO trip_events (trip_id, student_id, type, at, lat, lng) VALUES (?,?,?,?,?,?)', [trip.id, sid, type, now, trip.last_lat, trip.last_lng]);
    const hora = new Date(now).toLocaleTimeString('es-CO', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
    const texts = {
      subio: [`${s.name} subió al bus`, `${hora} · Lo recibió la auxiliar ${u.name}.`],
      bajo: [`${s.name} llegó a casa`, `${hora} · Entregado en la parada por la auxiliar ${u.name}.`],
      no_salio: [`${s.name} no salió`, `${hora} · La ruta esperó y continuó. Escribe a la auxiliar si necesitas algo.`],
    };
    await notify(await parentsOf(sid), texts[type][0], texts[type][1], type, { tag: `st-${trip.id}-${sid}` });
  }
  const aud = await routeAudience(rid);
  emit([aud.aide, ...aud.school, ...aud.parents], 'refresh', { route_id: rid });
  return { ok: true };
});

api('POST', '/api/aide/sim-route', async ({ u, body }) => {
  need(u, 'auxiliar');
  const pts = (Array.isArray(body.points) ? body.points : []).slice(0, 25).map((p) => ({ lat: num(p.lat), lng: num(p.lng) })).filter((p) => p.lat != null && p.lng != null);
  const legs = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const r = await routeVia([pts[i], pts[i + 1]]);
    legs.push(r ? r.coords : null);
  }
  return { legs };
});

api('POST', '/api/aide/delay', async ({ u, body }) => {
  need(u, 'auxiliar');
  const rid = await aideRoute(u);
  const trip = await activeTrip(rid);
  if (!trip) fail(409, 'Primero inicia la ruta');
  const mins = Math.min(120, Math.max(1, Math.round(num(body.minutes) || 10)));
  const note = str(body.note, 140) || 'Tráfico';
  await db.run('INSERT INTO trip_events (trip_id, type, note, at, lat, lng) VALUES (?,?,?,?,?,?)', [trip.id, 'retraso', `${mins} min · ${note}`, Date.now(), trip.last_lat, trip.last_lng]);
  const aud = await routeAudience(rid);
  const route = await routeDetail(rid);
  await notify([...aud.parents, ...aud.school], `${route.name} va con retraso`, `Unos ${mins} minutos · ${note}`, 'retraso');
  emit([aud.aide, ...aud.school, ...aud.parents], 'refresh', { route_id: rid });
  return { ok: true };
});

api('POST', '/api/aide/trip/end', async ({ u }) => {
  need(u, 'auxiliar');
  const rid = await aideRoute(u);
  const trip = await activeTrip(rid);
  if (!trip) fail(409, 'No hay ruta en curso');
  const now = Date.now();
  const route = await routeDetail(rid);
  if (trip.shift === 'manana') {
    // Todos los que subieron quedan entregados en el colegio
    const states = await studentStates(rid, trip, 'manana');
    for (const s of states.filter((x) => x.state === 'subio')) {
      await db.run('INSERT INTO trip_events (trip_id, student_id, type, at) VALUES (?,?,?,?)', [trip.id, s.id, 'en_colegio', now]);
      await notify(await parentsOf(s.id), `${s.name} llegó al colegio`, `${new Date(now).toLocaleTimeString('es-CO', { timeZone: TZ, hour: 'numeric', minute: '2-digit' })} · ${route.school_name}`, 'en_colegio');
    }
  }
  await db.run('INSERT INTO trip_events (trip_id, type, at) VALUES (?,?,?)', [trip.id, 'fin', now]);
  await db.run(`UPDATE trips SET status = 'terminada', ended_at = ? WHERE id = ?`, [now, trip.id]);
  planCache.delete(trip.id); streetCache.delete(trip.id);
  const aud = await routeAudience(rid);
  emit([aud.aide, ...aud.school, ...aud.parents], 'refresh', { route_id: rid });
  return { ok: true };
});

api('POST', '/api/aide/panic', async ({ u }) => {
  need(u, 'auxiliar');
  const rid = await aideRoute(u);
  const trip = await activeTrip(rid);
  const route = await routeDetail(rid);
  const aud = await routeAudience(rid);
  const now = Date.now();
  // Ubicación: la del recorrido activo o la última conocida del bus
  const last = trip && trip.last_lat != null ? trip : await db.one('SELECT last_lat, last_lng FROM trips WHERE route_id = ? AND last_lat IS NOT NULL ORDER BY id DESC LIMIT 1', [rid]);
  const lat = last ? last.last_lat : null, lng = last ? last.last_lng : null;
  let p = await db.one('SELECT id FROM panics WHERE route_id = ? AND closed_at IS NULL ORDER BY id DESC LIMIT 1', [rid]);
  if (!p) {
    p = await db.run('INSERT INTO panics (route_id, trip_id, aide_id, at, lat, lng) VALUES (?,?,?,?,?,?) RETURNING id', [rid, trip ? trip.id : null, u.id, now, lat, lng]);
    if (trip) await db.run('INSERT INTO trip_events (trip_id, type, at, lat, lng) VALUES (?,?,?,?,?)', [trip.id, 'panico', now, lat, lng]);
  }
  const where = lat != null ? ` Ubicación: https://maps.google.com/?q=${lat},${lng}` : '';
  await notify(aud.school, `EMERGENCIA · ${route.name}`, `${u.name} activó el botón de pánico. Vehículo ${route.plate}. Llama al ${u.phone || route.driver_phone}.${where}`, 'panico', { tag: `panic-${p.id}` });
  emit([aud.aide, ...aud.school], 'refresh', { route_id: rid });
  return { ok: true, panic_id: p.id };
});

async function panicInfo(where, params) {
  return db.all(`SELECT p.*, r.name AS route_name, r.driver_name, r.driver_phone, v.plate, a.name AS aide_name, a.phone AS aide_phone, k.name AS ack_name
    FROM panics p JOIN routes r ON r.id = p.route_id LEFT JOIN vehicles v ON v.id = r.vehicle_id LEFT JOIN users a ON a.id = p.aide_id LEFT JOIN users k ON k.id = p.ack_by
    WHERE ${where} ORDER BY p.at DESC`, params);
}
async function schoolPanic(u, id) {
  const p = await db.one('SELECT p.*, r.school_id FROM panics p JOIN routes r ON r.id = p.route_id WHERE p.id = ?', [id]);
  if (!p || p.school_id !== u.school_id) fail(404, 'Emergencia no encontrada');
  return p;
}
api('POST', '/api/school/panic/ack', async ({ u, body }) => {
  need(u, 'colegio');
  const p = await schoolPanic(u, num(body.id));
  if (!p.ack_at) await db.run('UPDATE panics SET ack_by = ?, ack_at = ? WHERE id = ?', [u.id, Date.now(), p.id]);
  const aud = await routeAudience(p.route_id);
  await notify([p.aide_id], 'El colegio recibió tu alerta', `${u.name} ya está atendiendo la emergencia. Mantén el celular a la mano.`, 'panico_recibido');
  emit([aud.aide, ...aud.school], 'refresh', { route_id: p.route_id });
  return { ok: true };
});
api('POST', '/api/school/panic/close', async ({ u, body }) => {
  need(u, 'colegio');
  const p = await schoolPanic(u, num(body.id));
  const now = Date.now();
  await db.run('UPDATE panics SET closed_by = ?, closed_at = ?, ack_by = COALESCE(ack_by, ?), ack_at = COALESCE(ack_at, ?) WHERE id = ?', [u.id, now, u.id, now, p.id]);
  const aud = await routeAudience(p.route_id);
  await notify([p.aide_id], 'Emergencia cerrada', `${u.name} cerró la emergencia.`, 'panico_cerrado');
  emit([aud.aide, ...aud.school], 'refresh', { route_id: p.route_id });
  return { ok: true };
});
api('POST', '/api/school/notify-parents', async ({ u, body }) => {
  need(u, 'colegio');
  const rid = num(body.route_id);
  const r = await db.one('SELECT id, name, school_id FROM routes WHERE id = ?', [rid]);
  if (!r || r.school_id !== u.school_id) fail(404, 'Ruta no encontrada');
  const text = str(body.message, 500);
  if (!text) fail(400, 'Escribe el mensaje para los padres');
  const aud = await routeAudience(rid);
  const trip = await activeTrip(rid);
  if (trip) await db.run('INSERT INTO trip_events (trip_id, type, note, at) VALUES (?,?,?,?)', [trip.id, 'aviso', text, Date.now()]);
  await notify(aud.parents, `Aviso del colegio · ${r.name}`, text, 'aviso_colegio');
  emit(aud.parents, 'refresh', { route_id: rid });
  return { ok: true, sent: aud.parents.length };
});

// --- colegio ---
api('GET', '/api/school/overview', async ({ u }) => {
  need(u, 'colegio');
  const rs = await db.all('SELECT id FROM routes WHERE school_id = ? ORDER BY name', [u.school_id]);
  const out = [];
  for (const r of rs) {
    const snap = await tripSnapshot(r.id);
    const alerts = snap.trip ? await db.all(`SELECT type, note, at FROM trip_events WHERE trip_id = ? AND type IN ('retraso','velocidad','panico') ORDER BY at DESC`, [snap.trip.id]) : [];
    out.push({
      route: snap.route, shift: snap.shift, trip: snap.trip, school_eta_min: snap.eta.school_min, alerts, street: snap.street, trail: snap.trail,
      counts: {
        total: snap.states.length,
        abordo: snap.states.filter((s) => s.state === 'subio').length,
        no_va: snap.states.filter((s) => s.state === 'no_va').length,
        entregados: snap.states.filter((s) => s.state === 'bajo' || s.state === 'en_colegio').length,
      },
      students: snap.states,
    });
  }
  const vehicles = await db.all('SELECT plate, brand, model, soat_until, tecno_until FROM vehicles WHERE school_id = ? ORDER BY plate', [u.school_id]);
  const school = await db.one('SELECT name, lat, lng FROM schools WHERE id = ?', [u.school_id]);
  const panics = await panicInfo('r.school_id = ? AND p.closed_at IS NULL', [u.school_id]);
  return { school, routes: out, vehicles, panics, day: today() };
});

// --- chat padre ↔ auxiliar (el colegio puede leer todo) ---
api('GET', '/api/chat/threads', async ({ u }) => {
  let rows;
  if (u.role === 'padre') {
    rows = await db.all(`SELECT DISTINCT r.id AS route_id, ? AS parent_id, r.name AS route_name, a.name AS other_name FROM routes r JOIN students s ON s.route_id = r.id
      JOIN parent_students ps ON ps.student_id = s.id LEFT JOIN users a ON a.id = r.aide_id WHERE ps.parent_id = ?`, [u.id, u.id]);
  } else {
    const filter = u.role === 'auxiliar' ? 'r.aide_id = ?' : 'r.school_id = ?';
    rows = await db.all(`SELECT DISTINCT r.id AS route_id, p.id AS parent_id, r.name AS route_name, p.name AS other_name FROM routes r JOIN students s ON s.route_id = r.id
      JOIN parent_students ps ON ps.student_id = s.id JOIN users p ON p.id = ps.parent_id WHERE ${filter} ORDER BY p.name`, [u.role === 'auxiliar' ? u.id : u.school_id]);
  }
  for (const t of rows) {
    t.last = await db.one('SELECT body, at, sender_id FROM messages WHERE route_id = ? AND parent_id = ? ORDER BY at DESC LIMIT 1', [t.route_id, t.parent_id]);
    const unread = await db.one('SELECT COUNT(*) AS n FROM messages WHERE route_id = ? AND parent_id = ? AND sender_id <> ? AND read_at IS NULL', [t.route_id, t.parent_id, u.id]);
    t.unread = Number(unread.n);
    t.kids = (await db.all(`SELECT s.name FROM students s JOIN parent_students ps ON ps.student_id = s.id WHERE ps.parent_id = ? AND s.route_id = ?`, [t.parent_id, t.route_id])).map((k) => k.name);
  }
  rows.sort((a, b) => ((b.last && b.last.at) || 0) - ((a.last && a.last.at) || 0));
  return { threads: rows };
});

api('GET', '/api/chat/messages', async ({ u, url }) => {
  const rid = num(url.searchParams.get('route_id')), pid = num(url.searchParams.get('parent_id'));
  if (!(await canSeeThread(u, rid, pid))) fail(403, 'No puedes ver esta conversación');
  const msgs = await db.all(`SELECT m.id, m.body, m.at, m.sender_id, us.name AS sender_name, us.role AS sender_role FROM messages m JOIN users us ON us.id = m.sender_id
    WHERE m.route_id = ? AND m.parent_id = ? ORDER BY m.at DESC LIMIT 200`, [rid, pid]);
  if (u.role !== 'colegio') await db.run('UPDATE messages SET read_at = ? WHERE route_id = ? AND parent_id = ? AND sender_id <> ? AND read_at IS NULL', [Date.now(), rid, pid, u.id]);
  return { messages: msgs.reverse() };
});

api('POST', '/api/chat/send', async ({ u, body }) => {
  const rid = num(body.route_id), pid = num(body.parent_id);
  const text = str(body.body, 1000);
  if (!text) fail(400, 'Escribe un mensaje');
  if (!(await canSeeThread(u, rid, pid))) fail(403, 'No puedes escribir en esta conversación');
  const at = Date.now();
  const m = await db.run('INSERT INTO messages (route_id, parent_id, sender_id, body, at) VALUES (?,?,?,?,?) RETURNING id', [rid, pid, u.id, text, at]);
  const aud = await routeAudience(rid);
  const msg = { id: m.id, route_id: rid, parent_id: pid, body: text, at, sender_id: u.id, sender_name: u.name, sender_role: u.role };
  emit([pid, aud.aide, ...aud.school], 'message', msg);
  // Notificación al destinatario
  const to = u.role === 'padre' ? [aud.aide] : [pid];
  await notify(to.filter((x) => x !== u.id), `Mensaje de ${u.name}`, text.slice(0, 120), 'chat', { tag: `chat-${rid}-${pid}` });
  return { message: msg };
});

// --- notificaciones ---
api('GET', '/api/notifications', async ({ u }) => {
  const rows = await db.all('SELECT id, title, body, kind, at, read_at FROM notifications WHERE user_id = ? ORDER BY at DESC LIMIT 60', [u.id]);
  return { notifications: rows, unread: rows.filter((r) => !r.read_at).length };
});
api('POST', '/api/notifications/read', async ({ u }) => {
  await db.run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', [Date.now(), u.id]);
  return { ok: true };
});
api('GET', '/api/push/key', async () => ({ key: webpush ? process.env.VAPID_PUBLIC_KEY : null }));
api('POST', '/api/push/subscribe', async ({ u, body }) => {
  const sub = body.subscription;
  if (!sub || typeof sub.endpoint !== 'string' || !sub.endpoint.startsWith('https://')) fail(400, 'Suscripción inválida');
  await db.run('DELETE FROM push_subs WHERE endpoint = ?', [sub.endpoint]);
  await db.run('INSERT INTO push_subs (endpoint, user_id, sub_json) VALUES (?,?,?)', [sub.endpoint, u.id, JSON.stringify(sub)]);
  return { ok: true };
});

api('GET', '/api/health', async () => ({ ok: true, db: db.mode, push: !!webpush }));

// ---------- servidor HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
function serveStatic(req, res, pathname) {
  let p = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) {
      // SPA: cualquier ruta desconocida vuelve a index.html
      return fs.readFile(path.join(PUBLIC, 'index.html'), (e2, d2) => { res.writeHead(e2 ? 404 : 200, { 'Content-Type': MIME['.html'] }); res.end(d2 || 'No encontrado'); });
    }
    const ext = path.extname(file);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' || p === '/sw.js' ? 'no-cache' : 'public, max-age=300' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin'); // OpenStreetMap exige saber desde qué sitio se piden los mapas
  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);
  try {
    if (url.pathname === '/api/stream') {
      const u = await auth(req, url);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(`event: hello\ndata: {"ok":true}\n\n`);
      if (!streams.has(u.id)) streams.set(u.id, new Set());
      streams.get(u.id).add(res);
      req.on('close', () => streams.get(u.id)?.delete(res));
      return;
    }
    const r = routes.find((x) => x.method === req.method && x.pattern === url.pathname);
    if (!r) fail(404, 'No encontrado');
    const body = req.method === 'POST' ? await readBody(req) : {};
    const open = url.pathname === '/api/login' || url.pathname === '/api/health' || url.pathname === '/api/push/key';
    const u = open ? null : await auth(req, url);
    send(res, 200, await r.handler({ req, url, body, u }));
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    send(res, e.status || 500, { error: e instanceof HttpError ? e.message : 'Error del servidor' });
  }
});

db.init().then(() => server.listen(PORT, () => console.log(`EscolarGo escuchando en http://localhost:${PORT}`)))
  .catch((e) => { console.error('No se pudo iniciar la base de datos', e); process.exit(1); });

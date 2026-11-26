/* EscolarGo · app web (padres, auxiliar de ruta y colegio) */
'use strict';

const S = {
  token: localStorage.getItem('eg_token'),
  user: JSON.parse(localStorage.getItem('eg_user') || 'null'),
  data: null, unread: 0, chatUnread: 0,
  map: null, mapEl: null, layers: null, fitted: '', busMarkers: {},
  gpsWatch: null, lastGpsPost: 0, gpsMsg: '', sim: null,
  es: null, pushOn: false, loadTimer: null,
  chat: null,
};
const $app = document.getElementById('app');

// ---------- utilidades ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hora = (ms) => (ms ? new Date(ms).toLocaleTimeString('es-CO', { hour: 'numeric', minute: '2-digit' }) : '');
const fechaHora = (ms) => new Date(ms).toLocaleString('es-CO', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const shiftName = (s) => (s === 'tarde' ? 'Tarde' : 'Mañana');

const ICON = {
  bus: '<svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#2A1766" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 17V6a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v11"/><path d="M4 11h16"/><path d="M4 17h16"/><circle cx="7.5" cy="19" r="1.5"/><circle cx="16.5" cy="19" r="1.5"/></svg>',
  bell: '<svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10 21a2 2 0 0 0 4 0"/></svg>',
  chat: '<svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11.8 7L4 20l1.2-4.4A8 8 0 1 1 21 12z"/></svg>',
  out: '<svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 17l-5-5 5-5"/><path d="M5 12h11"/></svg>',
  check: '<svg aria-hidden="true" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/></svg>',
  clock: '<svg aria-hidden="true" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  x: '<svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
};

async function api(path, body) {
  const opts = { headers: { 'Content-Type': 'application/json' } };
  if (S.token) opts.headers.Authorization = `Bearer ${S.token}`;
  if (body !== undefined) { opts.method = 'POST'; opts.body = JSON.stringify(body); }
  const r = await fetch(path, opts);
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== '/api/login') { logout(); throw new Error(j.error || 'Sesión vencida'); }
  if (!r.ok) throw new Error(j.error || 'Algo salió mal');
  return j;
}

function toast(title, body) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.innerHTML = `<b>${esc(title)}</b>${esc(body || '')}`;
  document.getElementById('toasts').appendChild(t);
  setTimeout(() => t.remove(), 4500);
  const all = document.querySelectorAll("#toasts .toast"); if (all.length > 2) all[0].remove();
  t.onclick = () => t.remove();
}
const errToast = (e) => toast('No se pudo', e.message);

// ---------- sesión ----------
function logout() {
  localStorage.removeItem('eg_token'); localStorage.removeItem('eg_user');
  S.token = null; S.user = null; S.data = null;
  stopGps(); stopSim(); setAlarm(false);
  if (S.es) { S.es.close(); S.es = null; }
  destroyMap();
  renderLogin();
}

function renderLogin() {
  document.body.classList.remove('wide');
  $app.innerHTML = `
  <main class="login"><div class="login-box">
    <div style="display:flex;align-items:center;gap:12px">
      <div class="logo">${ICON.bus.replace('width="22" height="22"', 'width="38" height="38"')}</div>
      <div><h1 style="font-size:32px;color:var(--morado)">Escolar<span style="color:var(--turquesa)">Go</span></h1>
      <div class="muted" style="font-size:15px">Tu hijo en ruta, tú en tranquilidad</div></div>
    </div>
    ${installCard()}
    <form id="lf" class="card" style="margin-top:24px">
      <label for="lu">Usuario</label><input id="lu" type="text" autocomplete="username" autocapitalize="none" required>
      <label for="lp">Contraseña</label><input id="lp" type="password" autocomplete="current-password" required>
      <div class="err" id="le"></div>
      <button class="btn primary" style="width:100%" type="submit">Entrar</button>
    </form>
    <div class="card"><div class="muted" style="font-weight:700">Cuentas de prueba (contraseña demo1234)</div>
      <div class="demo">
        <button type="button" data-u="laura">Mamá · Laura</button>
        <button type="button" data-u="andres">Papá · Andrés</button>
        <button type="button" data-u="marcela">Auxiliar · Marcela</button>
        <button type="button" data-u="colegio">Colegio</button>
      </div></div>
  </div></main>`;
  bindInstall();
  const f = document.getElementById('lf');
  document.querySelectorAll('.demo button').forEach((b) => (b.onclick = () => { lu.value = b.dataset.u; lp.value = 'demo1234'; lp.focus(); }));
  f.onsubmit = async (ev) => {
    ev.preventDefault();
    le.textContent = '';
    try {
      const r = await api('/api/login', { login: lu.value.trim(), password: lp.value });
      S.token = r.token; S.user = r.user;
      localStorage.setItem('eg_token', r.token); localStorage.setItem('eg_user', JSON.stringify(r.user));
      start();
    } catch (e) { le.textContent = e.message; }
  };
}

// ---------- arranque ----------
async function start() {
  if (!S.token) return renderLogin();
  document.body.classList.toggle('wide', S.user.role === 'colegio');
  connectStream();
  await load();
  refreshBadges();
  setupPushSilently();
}

async function load() {
  try {
    const path = { padre: '/api/parent/overview', auxiliar: '/api/aide/overview', colegio: '/api/school/overview' }[S.user.role];
    S.data = await api(path);
    render();
  } catch (e) { if (S.token) errToast(e); }
}
function loadSoon(ms = 2500) { clearTimeout(S.loadTimer); S.loadTimer = setTimeout(load, ms); }

function render() {
  const body = S.user.role === 'padre' ? viewParent() : S.user.role === 'auxiliar' ? viewAide() : viewSchool();
  $app.innerHTML = `
  <header class="top"><div class="top-in">
    <div class="brand"><div class="logo">${ICON.bus}</div><span>Escolar<span class="go">Go</span></span></div>
    <div class="top-actions">
      <button class="icon-btn" id="bChat" aria-label="Mensajes">${ICON.chat}${S.chatUnread ? `<span class="badge">${S.chatUnread}</span>` : ''}</button>
      <button class="icon-btn" id="bBell" aria-label="Notificaciones">${ICON.bell}${S.unread ? `<span class="badge">${S.unread}</span>` : ''}</button>
      <button class="icon-btn" id="bOut" aria-label="Cerrar sesión">${ICON.out}</button>
    </div></div></header>
  <main class="wrap">${installCard()}${body}</main>`;
  bChat.onclick = openThreads; bBell.onclick = openNotifications; bindInstall();
  bOut.onclick = () => { if (confirm('¿Cerrar sesión?')) logout(); };
  if (S.user.role === 'padre') bindParent();
  if (S.user.role === 'auxiliar') bindAide();
  if (S.user.role === 'colegio') bindSchool();
}

// ---------- mapa (Leaflet + OpenStreetMap, gratis) ----------
function mountMap(slotId) {
  const slot = document.getElementById(slotId);
  if (!slot || !window.L) return null;
  if (!S.mapEl) {
    S.mapEl = document.createElement('div');
    S.mapEl.className = 'map';
    S.mapEl.setAttribute('role', 'region'); S.mapEl.setAttribute('aria-label', 'Mapa de la ruta');
    slot.appendChild(S.mapEl);
    S.map = L.map(S.mapEl, { zoomControl: true, attributionControl: true }).setView([3.42, -76.52], 13);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap', referrerPolicy: 'strict-origin-when-cross-origin' }).addTo(S.map);
    S.layers = L.layerGroup().addTo(S.map);
  } else slot.appendChild(S.mapEl);
  setTimeout(() => S.map.invalidateSize(), 0);
  return S.map;
}
function destroyMap() { if (S.map) S.map.remove(); S.map = null; S.mapEl = null; S.layers = null; S.fitted = ''; S.busMarkers = {}; }
const busIcon = () => L.divIcon({ className: '', html: `<div class="bus-pin">${ICON.bus.replace('width="22" height="22"', 'width="18" height="18"')}</div>`, iconSize: [34, 34], iconAnchor: [17, 17] });
function drawMap({ buses = [], stops = [], school, line = [], trail = [], plan = null }) {
  if (!S.map) return;
  S.layers.clearLayers(); S.busMarkers = {}; S.trailLine = null;
  // Calles por donde YA pasó el bus (GPS real)
  if (trail.length > 1) S.trailLine = L.polyline(trail, { color: '#4B2CA0', weight: 6, opacity: 0.9, lineCap: 'round', lineJoin: 'round' }).addTo(S.layers);
  // Calles por donde VA a pasar
  if (plan && plan.length > 1) { L.polyline(plan, { color: '#12C4A8', weight: 6, opacity: 0.95, dashArray: '2 10', lineCap: 'round' }).addTo(S.layers); line = []; }
  const pts = [];
  if (school && school.lat != null) {
    L.marker([school.lat, school.lng], { icon: L.divIcon({ className: '', html: `<div class="school-pin">Colegio</div>`, iconSize: [60, 24], iconAnchor: [30, 12] }), title: school.name }).addTo(S.layers);
    pts.push([school.lat, school.lng]);
  }
  for (const s of stops) {
    if (s.lat == null) continue;
    L.marker([s.lat, s.lng], { icon: L.divIcon({ className: '', html: `<div class="stop-pin ${s.done ? 'done' : ''}"></div>`, iconSize: [18, 18], iconAnchor: [9, 9] }), title: s.label }).bindTooltip(esc(s.label)).addTo(S.layers);
    pts.push([s.lat, s.lng]);
  }
  const ln = line.filter((p) => p && p.lat != null).map((p) => [p.lat, p.lng]);
  if (ln.length > 1) L.polyline(ln, { color: '#12C4A8', weight: 5, opacity: 0.8, dashArray: '2 10' }).addTo(S.layers);
  for (const b of buses) {
    if (b.lat == null) continue;
    S.busMarkers[b.route_id] = L.marker([b.lat, b.lng], { icon: busIcon(), title: b.label, zIndexOffset: 1000 }).bindTooltip(esc(b.label)).addTo(S.layers);
    pts.push([b.lat, b.lng]);
  }
  const key = pts.length + ':' + buses.length;
  if (pts.length && S.fitted !== key) { S.map.fitBounds(pts, { padding: [36, 36], maxZoom: 15 }); S.fitted = key; }
}

function kmBetween(a, b) {
  const r = (x) => (x * Math.PI) / 180, dLat = r(b.lat - a.lat), dLng = r(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}
function moveBus(routeId, lat, lng) {
  if (!S.map) return;
  let m = S.busMarkers[routeId];
  if (!m) m = S.busMarkers[routeId] = L.marker([lat, lng], { icon: busIcon(), zIndexOffset: 1000 }).addTo(S.layers);
  else m.setLatLng([lat, lng]);
  if (S.trailLine) S.trailLine.addLatLng([lat, lng]);
  else if (S.layers) S.trailLine = L.polyline([[lat, lng]], { color: '#4B2CA0', weight: 6, opacity: 0.9, lineCap: 'round' }).addTo(S.layers);
  if (!S.map.getBounds().pad(-0.15).contains([lat, lng])) S.map.panTo([lat, lng]);
}

const MAP_LEGEND = `<div class="legend"><span><i style="background:#4B2CA0"></i>Ya recorrió</span><span><i class="dash"></i>Por recorrer</span></div>`;
function streetsCard(streets) {
  if (!streets || !streets.length) return '';
  return `<div class="card"><h3>Calles por donde ha pasado</h3><div class="timeline">${streets.slice(0, 15).map((x, i) => `
    <div class="tl"><div class="dot"><span style="${i ? 'background:#AFA9EC' : ''}"></span><span></span></div><div class="txt"><span>${i ? '' : '<b>Ahora: </b>'}${esc(x.street)}</span><span class="muted">${hora(x.at)}</span></div></div>`).join('')}</div></div>`;
}

// ---------- PADRES ----------
const KID_STATE = {
  pendiente: ['Esperando el bus', 'p-amarillo'], subio: ['En el bus', 'p-turquesa'], bajo: ['Llegó a casa', 'p-turquesa'],
  en_colegio: ['En el colegio', 'p-turquesa'], no_salio: ['No salió', 'p-coral'], no_va: ['No va hoy', 'p-lila'],
};
const EV_TXT = { aviso: 'Aviso del colegio', inicio: 'Salió la ruta', subio: 'subió al bus', bajo: 'llegó a casa', en_colegio: 'llegó al colegio', no_salio: 'no salió', cerca: 'el bus está cerca', retraso: 'Retraso', fin: 'Terminó la ruta', velocidad: 'Alerta de velocidad', panico: 'Emergencia' };

function viewParent() {
  const d = S.data;
  if (!d.routes.length) return `<div class="card" style="margin-top:16px"><h2>Aún no tienes estudiantes asignados</h2><p class="muted">El colegio debe vincular a tus hijos con una ruta.</p></div>`;
  return d.routes.map((r, i) => {
    const t = r.trip;
    const shift = t ? t.shift : r.shift;
    const delays = r.events.filter((e) => e.type === 'retraso');
    let banner;
    const onBus = r.kids.filter((k) => k.state === 'subio');
    const waiting = r.kids.filter((k) => k.state === 'pendiente');
    if (!t) banner = `<div class="banner b-off">${ICON.clock}<div><b>La ruta de la ${shiftName(shift).toLowerCase()} no ha salido</b>Te avisamos apenas arranque.</div></div>`;
    else if (onBus.length) banner = `<div class="banner b-ok">${ICON.check}<div><b>${esc(onBus.map((k) => k.name.split(' ')[0]).join(' y '))} ${onBus.length > 1 ? 'van' : 'va'} en el bus</b>${shift === 'manana' ? 'Rumbo al colegio' : 'Rumbo a casa'} · desde las ${hora(onBus[0].boarded_at)}</div></div>`;
    else if (waiting.length && shift === 'manana') banner = `<div class="banner b-wait">${ICON.clock}<div><b>El bus viene en camino</b>${waiting[0].eta_min != null ? `Llega a tu parada en unos ${waiting[0].eta_min} min` : 'Calculando el tiempo de llegada…'}</div></div>`;
    else banner = `<div class="banner b-off">${ICON.clock}<div><b>Ruta en curso</b>Sigue el bus en el mapa.</div></div>`;
    if (delays.length) banner += `<div class="banner b-bad"><div><b>Retraso reportado</b>${esc(delays[delays.length - 1].note)}</div></div>`;

    let etaLabel = '', etaVal = null;
    if (t) {
      if (waiting.length && shift === 'manana') { etaLabel = 'Llega a tu parada en'; etaVal = waiting[0].eta_min; }
      else if (onBus.length && shift === 'manana') { etaLabel = 'Llega al colegio en'; etaVal = r.school_eta_min; }
      else if (onBus.length && shift === 'tarde') { etaLabel = 'Llega a casa en'; etaVal = onBus[0].eta_min; }
    }
    const v = r.route;
    const canAbsent = (k) => !t || k.state === 'pendiente' || k.state === 'no_va';
    return `
    ${banner}
    <div id="mapslot-${i}"></div>${t ? MAP_LEGEND : ''}
    <div class="card row" style="align-items:flex-start">
      <div>${etaLabel ? `<div class="muted" style="font-weight:700">${etaLabel}</div><div class="big">${etaVal != null ? etaVal + ' min' : '—'}</div>` : `<div class="muted" style="font-weight:700">${esc(v.name)}</div><div style="font-size:20px;font-weight:800">${shiftName(shift)}</div>`}
        ${t && r.street ? `<div style="font-weight:800;margin-top:4px">Va por: ${esc(r.street)}</div>` : ''}
        ${t && t.last_at ? `<div class="muted">GPS actualizado ${hora(t.last_at)}</div>` : ''}</div>
      <div style="text-align:right;font-size:13px;line-height:1.6">
        <span class="plate">${esc(v.plate || '—')}</span>
        <div style="font-weight:700">${esc([v.brand, v.model, v.year].filter(Boolean).join(' '))}</div>
        <div class="muted">Aux. ${esc(v.aide_name || 'sin asignar')}</div>
        <div class="muted">Cond. ${esc(v.driver_name || '—')}</div>
        ${t ? `<div class="muted">${r.riders} ${r.riders === 1 ? "estudiante" : "estudiantes"} a bordo</div>` : ''}
      </div>
    </div>
    <div class="card">
      <h3>Mis hijos en esta ruta</h3>
      <div class="list">${r.kids.map((k) => `
        <div class="item" style="padding:8px 0">
          <div class="grow"><div class="name">${esc(k.name)}</div><div class="muted">${esc(k.grade || '')} · ${esc(k.address || '')}</div></div>
          <span class="pill ${KID_STATE[k.state][1]}">${KID_STATE[k.state][0]}</span>
        </div>
        ${canAbsent(k) ? `<button class="btn small" data-absent="${k.id}" data-shift="${shift}" data-cancel="${k.state === 'no_va' ? 1 : ''}">${k.state === 'no_va' ? `Sí va hoy (${shiftName(shift).toLowerCase()})` : `Hoy no va (${shiftName(shift).toLowerCase()})`}</button>` : ''}`).join('')}
      </div>
    </div>
    ${t ? streetsCard(r.streets) : ''}
    ${t ? `<div class="card"><h3>Recorrido de hoy</h3><div class="timeline">${r.events.map((e) => `
      <div class="tl"><div class="dot"><span></span><span></span></div><div class="txt"><span>${e.student_name ? `<b>${esc(e.student_name.split(' ')[0])}</b> ` : ''}${EV_TXT[e.type] || esc(e.type)}${e.type === 'retraso' || e.type === 'aviso' ? ': ' + esc(e.note) : ''}</span><span class="muted">${hora(e.at)}</span></div></div>`).join('')}
    </div></div>` : ''}
    <div class="btns"><button class="btn primary" data-chat="${v.id}">Escribir a la auxiliar</button>
      ${v.aide_phone ? `<a class="btn" href="tel:${esc(v.aide_phone)}">Llamar a la auxiliar</a>` : ''}</div>`;
  }).join('<hr style="border:0;border-top:2px dashed var(--borde);margin:24px 0 12px">');
}
function bindParent() {
  const d = S.data;
  if (d.routes.length) {
    const r = d.routes[0];
    mountMap('mapslot-0');
    drawMap({
      buses: r.trip && r.trip.lat != null ? [{ route_id: r.route.id, lat: r.trip.lat, lng: r.trip.lng, label: `${r.route.name} · ${r.route.plate}` }] : [],
      stops: r.kids.map((k) => ({ lat: k.lat, lng: k.lng, label: `Parada de ${k.name}`, done: ['subio', 'bajo', 'en_colegio'].includes(k.state) })),
      school: { lat: r.route.school_lat, lng: r.route.school_lng, name: r.route.school_name },
      trail: r.trail || [], plan: r.plan,
      line: r.trip && r.trip.lat != null ? [{ lat: r.trip.lat, lng: r.trip.lng }, ...r.kids.filter((k) => (r.trip.shift === 'manana' ? k.state === 'pendiente' : k.state === 'subio')).map((k) => ({ lat: k.lat, lng: k.lng })), ...(r.trip.shift === 'manana' ? [{ lat: r.route.school_lat, lng: r.route.school_lng }] : [])] : [],
    });
  }
  document.querySelectorAll('[data-absent]').forEach((b) => (b.onclick = async () => {
    try {
      await api('/api/parent/absence', { student_id: Number(b.dataset.absent), shift: b.dataset.shift, cancel: !!b.dataset.cancel });
      toast(b.dataset.cancel ? 'Listo' : 'Aviso enviado', b.dataset.cancel ? 'La auxiliar sabe que sí va.' : 'La auxiliar ya sabe que no va hoy.');
      load();
    } catch (e) { errToast(e); }
  }));
  document.querySelectorAll('[data-chat]').forEach((b) => (b.onclick = () => openChat(Number(b.dataset.chat), S.user.id, `Auxiliar · ${S.data.routes[0].route.aide_name || ''}`)));
}

// ---------- AUXILIAR DE RUTA ----------
function viewAide() {
  const d = S.data, v = d.route, t = d.trip;
  const shift = t ? t.shift : d.shift;
  const st = d.students;
  const count = (s) => st.filter((x) => x.state === s).length;
  const actions = (s) => {
    if (!t) return '';
    if (s.state === 'no_va') return `<span class="pill p-lila">No va hoy</span>`;
    if (shift === 'manana') {
      if (s.state === 'pendiente') return `<button class="btn small go" data-st="${s.id}" data-t="subio">Subió</button><button class="btn small" data-st="${s.id}" data-t="no_salio" aria-label="No salió ${esc(s.name)}">No salió</button>`;
    } else {
      if (s.state === 'pendiente') return `<button class="btn small go" data-st="${s.id}" data-t="subio">Subió</button>`;
      if (s.state === 'subio') return `<button class="btn small primary" data-st="${s.id}" data-t="bajo">Bajó en casa</button>`;
    }
    return `<button class="btn small" data-st="${s.id}" data-t="deshacer">Deshacer</button>`;
  };
  const dot = (s) => (['subio', 'bajo', 'en_colegio'].includes(s.state) ? 'background:var(--turquesa);color:var(--turquesa-txt)' : s.state === 'no_va' || s.state === 'no_salio' ? 'background:var(--lila);color:var(--tinta)' : 'background:var(--amarillo);color:var(--tinta)');
  const sub = (s) => {
    if (s.state === 'subio') return `Subió ${hora(s.boarded_at)}${shift === 'tarde' && s.eta_min != null ? ` · casa en ~${s.eta_min} min` : ''}`;
    if (s.state === 'bajo') return `Entregado ${hora(s.dropped_at)}`;
    if (s.state === 'no_salio') return 'No salió · padres avisados';
    if (s.state === 'pendiente' && s.eta_min != null) return `${esc(s.address)} · ~${s.eta_min} min`;
    return esc(s.address);
  };
  return `
  <div class="card" style="background:var(--amarillo)">
    <div class="row"><h2>${esc(v.name)}</h2><span class="plate" style="background:var(--tinta);color:var(--amarillo)">${esc(v.plate)}</span></div>
    <div style="font-weight:800;margin-top:4px">Auxiliar: ${esc(v.aide_name)} · Conductor: ${esc(v.driver_name || '—')}</div>
    <div style="font-size:13px;font-weight:600">${esc([v.brand, v.model, v.year].filter(Boolean).join(' '))} · capacidad ${v.capacity || '—'}</div>
    <div class="grid" style="margin-top:10px;grid-template-columns:repeat(3,minmax(0,1fr))">
      <div class="stat"><div class="muted">A bordo</div><div class="n">${count('subio')}</div></div>
      <div class="stat"><div class="muted">${shift === 'manana' ? 'Por recoger' : 'En colegio'}</div><div class="n">${count('pendiente')}</div></div>
      <div class="stat"><div class="muted">No van</div><div class="n">${count('no_va')}</div></div>
    </div>
  </div>
  ${d.panic ? `
    <div class="emergency" role="alert">
      <div class="em-title">Emergencia activa</div>
      <div>Avisaste al colegio a las ${hora(d.panic.at)}.</div>
      <div style="margin-top:6px;font-weight:800">${d.panic.ack_at ? `✓ El colegio la recibió: ${esc(d.panic.ack_name || '')} · ${hora(d.panic.ack_at)}` : 'Esperando que el colegio confirme…'}</div>
      <div class="btns">
        <a class="btn danger" href="tel:123">Llamar al 123</a>
        ${d.school_phone ? `<a class="btn" href="tel:${esc(d.school_phone)}">Llamar al colegio</a>` : ''}
        <button class="btn" id="bPanicAgain">Enviar alerta otra vez</button>
      </div>
    </div>` : ''}
  ${t ? `
    <div class="banner b-ok">${ICON.check}<div><b>Ruta de la ${shiftName(shift).toLowerCase()} en curso</b>Desde las ${hora(t.started_at)} · ${esc(S.gpsMsg || 'GPS esperando señal…')}</div></div>
    <div class="btns">
      <button class="btn" id="bSim">${S.sim ? 'Detener simulación' : 'Modo prueba: simular recorrido'}</button>
      <button class="btn" id="bDelay">Reportar retraso</button>
    </div>` : `
    <div class="banner b-off">${ICON.clock}<div><b>Ruta sin iniciar</b>Al iniciar se avisa a los padres y se activa el GPS de este celular.</div></div>
    <div class="btns">
      <button class="btn ${d.shift === 'manana' ? 'primary' : ''}" data-start="manana">Iniciar ruta de la mañana</button>
      <button class="btn ${d.shift === 'tarde' ? 'primary' : ''}" data-start="tarde">Iniciar ruta de la tarde</button>
    </div>`}
  <div id="mapslot"></div>${t ? MAP_LEGEND : ''}
  ${t && d.street ? `<div class="card" style="font-weight:800">Va por: ${esc(d.street)}</div>` : ''}
  <div class="card" style="background:transparent;padding:0">
    <h3 style="margin-top:6px">${shift === 'manana' ? 'Orden de recogida' : 'Orden de entrega'} · ${shiftName(shift)}</h3>
    <div class="list">${st.map((s, i) => `
      <div class="item">
        <span class="num" style="${dot(s)}">${i + 1}</span>
        <div class="grow"><div class="name">${esc(s.name)} <span class="muted">${esc(s.grade || '')}</span></div><div class="muted">${sub(s)}</div></div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">${actions(s)}</div>
      </div>`).join('')}
    </div>
  </div>
  ${t ? `<div class="btns"><button class="btn primary" id="bEnd">${shift === 'manana' ? 'Llegamos al colegio · terminar' : 'Terminar ruta'}</button></div>` : ''}
  <div class="btns"><button class="btn danger" id="bPanic">Botón de pánico</button></div>`;
}
function bindAide() {
  const d = S.data, t = d.trip;
  mountMap('mapslot');
  drawMap({
    buses: t && t.last_lat != null ? [{ route_id: d.route.id, lat: t.last_lat, lng: t.last_lng, label: d.route.plate }] : [],
    stops: d.students.filter((s) => s.state !== 'no_va').map((s) => ({ lat: s.lat, lng: s.lng, label: s.name, done: ['subio', 'bajo', 'en_colegio'].includes(s.state) })),
    school: { lat: d.route.school_lat, lng: d.route.school_lng, name: d.route.school_name },
    trail: d.trail || [], plan: d.plan,
    line: t && t.last_lat != null ? [{ lat: t.last_lat, lng: t.last_lng }, ...d.students.filter((s) => (t.shift === 'manana' ? s.state === 'pendiente' : s.state === 'subio')).map((s) => ({ lat: s.lat, lng: s.lng })), ...(t.shift === 'manana' ? [{ lat: d.route.school_lat, lng: d.route.school_lng }] : [])] : [],
  });
  document.querySelectorAll('[data-start]').forEach((b) => (b.onclick = async () => {
    b.disabled = true;
    const pos = await currentPos();
    try { await api('/api/aide/trip/start', { shift: b.dataset.start, ...(pos || {}) }); toast('Ruta iniciada', 'Los padres ya recibieron el aviso.'); await load(); } catch (e) { errToast(e); b.disabled = false; }
  }));
  document.querySelectorAll('[data-st]').forEach((b) => (b.onclick = async () => {
    b.disabled = true;
    try { await api('/api/aide/student', { student_id: Number(b.dataset.st), type: b.dataset.t }); await load(); } catch (e) { errToast(e); b.disabled = false; }
  }));
  const end = document.getElementById('bEnd');
  if (end) end.onclick = async () => { if (!confirm('¿Terminar la ruta? Se avisará a los padres.')) return; stopSim(); try { await api('/api/aide/trip/end', {}); toast('Ruta terminada', ''); stopGps(); await load(); } catch (e) { errToast(e); } };
  const delay = document.getElementById('bDelay');
  if (delay) delay.onclick = async () => {
    const m = prompt('¿Cuántos minutos de retraso?', '10'); if (!m) return;
    const note = prompt('¿Motivo? (opcional)', 'Tráfico') || '';
    try { await api('/api/aide/delay', { minutes: Number(m), note }); toast('Retraso reportado', 'Padres y colegio avisados.'); } catch (e) { errToast(e); }
  };
  const sim = document.getElementById('bSim');
  if (sim) sim.onclick = () => (S.sim ? stopSim() : startSim());
  const panic = async () => {
    try { await api('/api/aide/panic', {}); toast('Alerta enviada', 'El colegio fue avisado con tu ubicación.'); if (navigator.vibrate) navigator.vibrate(300); await load(); } catch (e) { errToast(e); }
  };
  bPanic.onclick = async () => { if (confirm('¿Activar el botón de pánico? Se avisa de inmediato al colegio con tu ubicación.')) panic(); };
  document.getElementById('bPanicAgain')?.addEventListener('click', panic);
  if (t && !S.sim) startGps(); else if (!t) { stopGps(); stopSim(); }
}

// GPS real del celular de la auxiliar
function currentPos() {
  return new Promise((res) => {
    if (!navigator.geolocation) return res(null);
    navigator.geolocation.getCurrentPosition((p) => res({ lat: p.coords.latitude, lng: p.coords.longitude }), () => res(null), { enableHighAccuracy: true, timeout: 5000 });
  });
}
function startGps() {
  if (S.gpsWatch != null || !navigator.geolocation) { if (!navigator.geolocation) S.gpsMsg = 'Este navegador no tiene GPS'; return; }
  S.gpsWatch = navigator.geolocation.watchPosition(async (p) => {
    S.gpsMsg = `GPS activo · precisión ${Math.round(p.coords.accuracy)} m`;
    const now = Date.now();
    if (now - S.lastGpsPost < 8000) return;
    S.lastGpsPost = now;
    try {
      moveBus(S.data.route.id, p.coords.latitude, p.coords.longitude);
      await api('/api/aide/location', { lat: p.coords.latitude, lng: p.coords.longitude, speed_kmh: p.coords.speed != null ? p.coords.speed * 3.6 : undefined });
    } catch (e) { S.gpsMsg = 'GPS: ' + e.message; }
  }, (err) => { S.gpsMsg = err.code === 1 ? 'Activa el permiso de ubicación para compartir el GPS' : 'Sin señal de GPS'; const b = document.querySelector('.banner.b-ok div'); if (b) loadSoon(100); }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
}
function stopGps() { if (S.gpsWatch != null) navigator.geolocation.clearWatch(S.gpsWatch); S.gpsWatch = null; }

// Simulación para probar sin manejar: el bus va de parada en parada y espera a que la auxiliar marque a los estudiantes
async function startSim() {
  const d = S.data; if (!d || !d.trip) return;
  stopGps();
  const morning = d.trip.shift === 'manana';
  const school = { lat: d.route.school_lat, lng: d.route.school_lng };
  const waiting = (s) => (morning ? s.state === 'pendiente' : s.state === 'subio');
  // Paradas que faltan, agrupando hermanos que viven en la misma dirección
  const stops = [];
  for (const s of d.students.filter(waiting)) {
    const st = stops.find((x) => x.lat === s.lat && x.lng === s.lng);
    if (st) st.ids.push(s.id); else stops.push({ lat: s.lat, lng: s.lng, ids: [s.id], name: s.name.split(' ')[0] });
  }
  const first = morning ? stops[0] || school : school;
  const here = d.trip.last_lat != null ? { lat: d.trip.last_lat, lng: d.trip.last_lng } : null;
  // Si el celular está lejos de la ruta (otra ciudad), arranca a ~1,5 km de la primera parada, del lado opuesto al colegio
  const away = { lat: first.lat + (first.lat - school.lat) * 0.25, lng: first.lng + (first.lng - school.lng) * 0.25 };
  const startPt = here && kmBetween(here, first) < 5 ? here : morning ? away : school;
  const way = [startPt, ...stops, ...(morning ? [{ ...school, end: true }] : [])];
  S.sim = 'cargando'; S.gpsMsg = 'Preparando el recorrido por las calles…'; render();
  let legs = [];
  try { legs = (await api('/api/aide/sim-route', { points: way.map((p) => ({ lat: p.lat, lng: p.lng })) })).legs || []; } catch {}
  if (S.sim !== 'cargando') return; // se detuvo mientras cargaba
  S.sim = null;
  const path = [];
  for (let i = 0; i < way.length - 1; i++) {
    const a = way[i], b = way[i + 1];
    const coords = legs[i];
    if (coords && coords.length > 1) {
      // sigue las calles reales: un punto cada ~90 m
      let last = a;
      for (const [lat, lng] of coords) if (kmBetween(last, { lat, lng }) > 0.09) { path.push({ lat, lng, stop: null }); last = { lat, lng }; }
      path.push({ lat: b.lat, lng: b.lng, stop: b });
    } else {
      const n = Math.min(40, Math.max(3, Math.round(Math.hypot(a.lat - b.lat, a.lng - b.lng) / 0.0012)));
      for (let k = 1; k <= n; k++) path.push({ lat: a.lat + ((b.lat - a.lat) * k) / n, lng: a.lng + ((b.lng - a.lng) * k) / n, stop: k === n ? b : null });
    }
  }
  let i = 0, waitingAt = null;
  S.gpsMsg = 'Simulación de recorrido activa';
  S.sim = setInterval(async () => {
    if (waitingAt) {
      const still = S.data.students.filter((s) => waitingAt.ids.includes(s.id) && waiting(s));
      if (still.length) return; // sigue esperando en la parada
      waitingAt = null; S.gpsMsg = 'Simulación de recorrido activa'; render();
    }
    if (i >= path.length) { stopSim(); toast(morning ? 'Llegaron al colegio' : 'Recorrido completo', morning ? 'Toca "Llegamos al colegio · terminar".' : 'Toca "Terminar ruta".'); return; }
    const p = path[i++];
    moveBus(d.route.id, p.lat, p.lng);
    try { await api('/api/aide/location', { lat: p.lat, lng: p.lng, speed_kmh: 25, simulated: true }); } catch (e) { stopSim(); errToast(e); return; }
    if (p.stop && p.stop.ids) {
      waitingAt = p.stop;
      S.gpsMsg = `En la parada de ${p.stop.name}: márcalo para seguir`;
      toast(`Llegaste a la parada de ${p.stop.name}`, morning ? 'Marca "Subió" o "No salió" para que el bus siga.' : 'Marca "Bajó en casa" para que el bus siga.');
      await load();
    }
  }, 1500);
  render();
}
function stopSim() { if (S.sim) { if (S.sim !== 'cargando') clearInterval(S.sim); S.sim = null; S.gpsMsg = ''; if (S.user && S.user.role === 'auxiliar' && S.data) render(); } }

// ---------- alarma sonora de emergencia (panel del colegio) ----------
const Alarm = { ctx: null, timer: null };
function unlockAudio() {
  try {
    if (!Alarm.ctx) Alarm.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (Alarm.ctx.state === 'suspended') Alarm.ctx.resume();
  } catch {}
}
['pointerdown', 'keydown', 'touchstart'].forEach((ev) => window.addEventListener(ev, () => { unlockAudio(); document.getElementById('soundHint')?.remove(); }, { passive: true }));
const audioReady = () => Alarm.ctx && Alarm.ctx.state === 'running';
function beep() {
  if (!audioReady()) return;
  const t = Alarm.ctx.currentTime;
  [0, 0.25].forEach((d, i) => {
    const o = Alarm.ctx.createOscillator(), g = Alarm.ctx.createGain();
    o.type = 'square'; o.frequency.value = i ? 660 : 880;
    g.gain.setValueAtTime(0.0001, t + d); g.gain.exponentialRampToValueAtTime(0.25, t + d + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.22);
    o.connect(g).connect(Alarm.ctx.destination); o.start(t + d); o.stop(t + d + 0.24);
  });
  if (navigator.vibrate) navigator.vibrate([300, 150, 300]);
}
function setAlarm(on) {
  if (on && !Alarm.timer) { beep(); Alarm.timer = setInterval(beep, 1200); }
  if (!on && Alarm.timer) { clearInterval(Alarm.timer); Alarm.timer = null; }
}

// ---------- COLEGIO ----------
function viewSchool() {
  const d = S.data;
  const active = d.routes.filter((r) => r.trip).length;
  const abordo = d.routes.reduce((a, r) => a + r.counts.abordo, 0);
  const total = d.routes.reduce((a, r) => a + r.counts.total, 0);
  const noVa = d.routes.reduce((a, r) => a + r.counts.no_va, 0);
  const alerts = d.routes.flatMap((r) => r.alerts.map((a) => ({ ...a, route: r.route.name })));
  const unassigned = d.routes.filter((r) => !r.route.aide_id);
  const pill = (r) => {
    if (!r.trip) return '<span class="pill p-lila">Sin iniciar</span>';
    if ((d.panics || []).some((p) => p.route_id === r.route.id) || r.alerts.some((a) => a.type === 'panico')) return '<span class="pill p-coral">Emergencia</span>';
    if (r.alerts.some((a) => a.type === 'retraso')) return '<span class="pill p-coral">Con retraso</span>';
    return `<span class="pill p-amarillo">En ruta · ${shiftName(r.trip.shift)}</span>`;
  };
  const daysTo = (s) => (s ? Math.ceil((new Date(s + 'T00:00:00') - new Date()) / 86400000) : null);
  const docTxt = (n) => (n == null ? '<span class="muted">sin dato</span>' : n < 0 ? '<b style="color:#A3291B">vencido</b>' : n <= 30 ? `<b style="color:#993C1D">en ${n} días</b>` : `<span style="color:var(--verde-txt);font-weight:700">al día</span>`);
  const panics = d.panics || [];
  const panicHtml = panics.map((p) => `
    <div class="emergency" role="alert">
      <div class="row" style="flex-wrap:wrap;align-items:flex-start">
        <div><div class="em-title">EMERGENCIA · ${esc(p.route_name)}</div>
          <div>Activada por <b>${esc(p.aide_name || 'la auxiliar')}</b> a las ${hora(p.at)} · Vehículo <b>${esc(p.plate || '—')}</b> · Conductor ${esc(p.driver_name || '—')}</div>
          <div style="margin-top:4px">${p.ack_at ? `<span class="pill p-turquesa">Recibida por ${esc(p.ack_name || 'el colegio')} · ${hora(p.ack_at)}</span>` : '<span class="pill" style="background:#fff;color:#A3291B">Nadie la ha atendido</span>'}</div>
        </div>
      </div>
      <div class="btns">
        ${p.ack_at ? '' : `<button class="btn primary" data-ack="${p.id}">Recibido, vamos en camino</button>`}
        ${p.aide_phone ? `<a class="btn" href="tel:${esc(p.aide_phone)}">Llamar a la auxiliar</a>` : ''}
        ${p.driver_phone ? `<a class="btn" href="tel:${esc(p.driver_phone)}">Llamar al conductor</a>` : ''}
        ${p.lat != null ? `<a class="btn" href="https://maps.google.com/?q=${p.lat},${p.lng}" target="_blank" rel="noopener">Ver ubicación</a>` : ''}
        <a class="btn danger" href="tel:123">Llamar al 123</a>
        <button class="btn" data-inform="${p.route_id}" data-rname="${esc(p.route_name)}">Informar a los padres</button>
        <button class="btn" data-close="${p.id}">Cerrar emergencia</button>
      </div>
    </div>`).join('');
  const needSound = panics.some((p) => !p.ack_at) && !audioReady();
  return `
  ${needSound ? '<button id="soundHint" class="btn danger" style="width:100%;margin-top:12px">Toca aquí para activar el sonido de la alarma</button>' : ''}
  ${panicHtml}
  <div class="row" style="margin-top:16px;flex-wrap:wrap">
    <div><h1 style="font-size:26px">Rutas en vivo</h1><div class="muted">${esc(d.school.name)} · ${new Date().toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long' })}</div></div>
    <button class="btn primary" id="bThreads">Conversaciones con padres</button>
  </div>
  <div class="grid" style="margin-top:12px">
    <div class="stat"><div class="muted">Rutas activas</div><div class="n">${active} de ${d.routes.length}</div></div>
    <div class="stat"><div class="muted">Estudiantes a bordo</div><div class="n">${abordo} / ${total}</div></div>
    <div class="stat"><div class="muted">Ausencias avisadas</div><div class="n">${noVa}</div></div>
    <div class="stat" style="${alerts.length ? 'background:var(--coral);color:var(--coral-txt)' : ''}"><div style="font-size:13px;font-weight:700">Alertas</div><div class="n">${alerts.length}</div></div>
  </div>
  <div id="mapslot"></div>
  <div class="cols" style="margin-top:12px">
    <section class="main card" style="margin-top:0"><h2>Estado de las rutas</h2>
      <div class="table-box"><table><thead><tr><th>Ruta</th><th>Vehículo</th><th>Auxiliar</th><th>Conductor</th><th>A bordo</th><th>Va por</th><th>Llegada</th><th>Estado</th><th></th></tr></thead><tbody>
      ${d.routes.map((r) => `<tr><td><b>${esc(r.route.name)}</b></td><td>${esc(r.route.plate || '—')}</td><td>${esc(r.route.aide_name || 'Sin asignar')}</td><td>${esc(r.route.driver_name || '—')}</td>
        <td>${r.counts.abordo} / ${r.counts.total - r.counts.no_va}</td><td>${r.trip && r.street ? esc(r.street) : '—'}</td><td>${r.trip && r.school_eta_min != null ? `~${r.school_eta_min} min` : '—'}</td><td>${pill(r)}</td><td><button class="btn small" data-inform="${r.route.id}" data-rname="${esc(r.route.name)}">Avisar a padres</button></td></tr>`).join('')}
      </tbody></table></div>
    </section>
    <section class="side">
      <div class="card" style="margin-top:0"><h2>Alertas</h2>
        ${alerts.length || unassigned.length ? '' : '<p class="muted">Todo en orden por ahora.</p>'}
        ${alerts.map((a) => `<div class="alert"><b>${esc(a.route)}:</b> ${esc(EV_TXT[a.type] || a.type)}${a.note ? ' · ' + esc(a.note) : ''} <span class="muted">${hora(a.at)}</span></div>`).join('')}
        ${unassigned.map((r) => `<div class="alert"><b>${esc(r.route.name)}:</b> no tiene auxiliar asignada.</div>`).join('')}
      </div>
      <div class="card"><h2>Documentos de vehículos</h2>
        ${d.vehicles.map((v) => `<div class="row" style="font-size:14px;margin-top:8px"><span>SOAT · ${esc(v.plate)}</span>${docTxt(daysTo(v.soat_until))}</div>
          <div class="row" style="font-size:14px;margin-top:6px"><span>Técnico-mecánica · ${esc(v.plate)}</span>${docTxt(daysTo(v.tecno_until))}</div>`).join('')}
      </div>
    </section>
  </div>`;
}
function bindSchool() {
  const d = S.data;
  mountMap('mapslot');
  drawMap({
    buses: d.routes.filter((r) => r.trip && r.trip.last_lat != null).map((r) => ({ route_id: r.route.id, lat: r.trip.last_lat, lng: r.trip.last_lng, label: `${r.route.name} · ${r.route.plate}` })),
    stops: [], school: d.school, trail: d.routes.length === 1 ? d.routes[0].trail || [] : [],
  });
  bThreads.onclick = openThreads;
  setAlarm((d.panics || []).some((p) => !p.ack_at));
  document.getElementById('soundHint')?.addEventListener('click', () => { unlockAudio(); setAlarm(false); setTimeout(() => setAlarm((S.data.panics || []).some((p) => !p.ack_at)), 100); });
  document.querySelectorAll('[data-ack]').forEach((b) => (b.onclick = async () => {
    b.disabled = true;
    try { await api('/api/school/panic/ack', { id: Number(b.dataset.ack) }); toast('Alerta recibida', 'La auxiliar ya sabe que el colegio la está atendiendo.'); await load(); } catch (e) { errToast(e); b.disabled = false; }
  }));
  document.querySelectorAll('[data-close]').forEach((b) => (b.onclick = async () => {
    if (!confirm('¿Cerrar la emergencia? Hazlo solo cuando la situación esté resuelta.')) return;
    try { await api('/api/school/panic/close', { id: Number(b.dataset.close) }); toast('Emergencia cerrada', ''); await load(); } catch (e) { errToast(e); }
  }));
  document.querySelectorAll('[data-inform]').forEach((b) => (b.onclick = () => openInformParents(Number(b.dataset.inform), b.dataset.rname)));
}
function openInformParents(routeId, routeName) {
  const el = sheet(`Avisar a los padres · ${routeName}`, `<div class="sheet-body"><form id="ipf" class="card">
    <label for="ipm">Mensaje para todos los padres de esta ruta</label>
    <textarea id="ipm" rows="5" maxlength="500" style="resize:vertical"></textarea>
    <div class="demo">
      <button type="button" data-tpl="La ruta tuvo un inconveniente en el camino. Todos los estudiantes están bien y acompañados. Les mantendremos informados.">Inconveniente, todos bien</button>
      <button type="button" data-tpl="La ruta va con retraso por una novedad en la vía. Los estudiantes están bien. Les avisaremos cuando lleguen.">Retraso</button>
      <button type="button" data-tpl="Por una novedad con el vehículo, otro vehículo del colegio recogerá a los estudiantes. Todos están bien.">Cambio de vehículo</button>
    </div>
    <div class="err" id="ipe"></div>
    <button class="btn primary" type="submit" style="width:100%">Enviar a los padres</button>
  </form></div>`);
  el.querySelectorAll('[data-tpl]').forEach((b) => (b.onclick = () => { ipm.value = b.dataset.tpl; ipe.textContent = ''; }));
  ipm.oninput = () => (ipe.textContent = '');
  el.querySelector('#ipf').onsubmit = async (e) => {
    e.preventDefault();
    if (!ipm.value.trim()) { ipe.textContent = 'Escribe el mensaje o elige uno de los modelos.'; return; }
    try { const r = await api('/api/school/notify-parents', { route_id: routeId, message: ipm.value }); closeSheet(); toast('Aviso enviado', `Les llegó a ${r.sent} ${r.sent === 1 ? 'familia' : 'familias'}.`); } catch (err) { ipe.textContent = err.message; }
  };
}

// ---------- tiempo real ----------
function connectStream() {
  if (S.es) S.es.close();
  S.es = new EventSource(`/api/stream?token=${encodeURIComponent(S.token)}`);
  S.es.addEventListener('notification', (ev) => {
    const n = JSON.parse(ev.data);
    S.unread++; updateBadges();
    if (n.kind !== 'chat' || !S.chat) toast(n.title, n.body);
    if (document.hidden && !S.pushOn && 'Notification' in window && Notification.permission === 'granted') {
      navigator.serviceWorker?.getRegistration().then((reg) => reg && reg.showNotification(n.title, { body: n.body, icon: '/icon-192.png', badge: '/icon-192.png', tag: n.tag }));
    }
    if (n.kind === 'panico') { if (navigator.vibrate) navigator.vibrate([400, 200, 400, 200, 400]); load(); }
  });
  S.es.addEventListener('refresh', () => loadSoon(300));
  S.es.addEventListener('location', (ev) => {
    const p = JSON.parse(ev.data);
    if (p.street) document.querySelectorAll('[data-street]').forEach((el) => (el.textContent = p.street));
    const had = !!S.busMarkers[p.route_id];
    moveBus(p.route_id, p.lat, p.lng);
    loadSoon(had ? 4000 : 300);
  });
  S.es.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (S.chat && S.chat.route_id === m.route_id && S.chat.parent_id === m.parent_id) appendMsg(m);
    else if (m.sender_id !== S.user.id) { S.chatUnread++; updateBadges(); }
  });
  S.es.onerror = () => {}; // EventSource reintenta solo
}
async function refreshBadges() {
  try {
    const n = await api('/api/notifications'); S.unread = n.unread;
    const t = await api('/api/chat/threads'); S.chatUnread = t.threads.reduce((a, x) => a + (S.user.role === 'colegio' ? 0 : x.unread), 0);
    updateBadges();
  } catch {}
}
function updateBadges() {
  const set = (id, n) => { const b = document.getElementById(id); if (!b) return; b.querySelector('.badge')?.remove(); if (n) b.insertAdjacentHTML('beforeend', `<span class="badge">${n > 99 ? '99+' : n}</span>`); };
  set('bBell', S.unread); set('bChat', S.chatUnread);
}

// ---------- paneles ----------
function sheet(title, html, onClose) {
  closeSheet();
  const el = document.createElement('div');
  el.className = 'sheet'; el.id = 'sheet';
  el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', title);
  el.innerHTML = `<div class="sheet-in"><div class="sheet-head"><h2 style="font-size:17px">${esc(title)}</h2><button class="icon-btn" id="sx" aria-label="Cerrar">${ICON.x}</button></div>${html}</div>`;
  document.body.appendChild(el);
  const close = () => { closeSheet(); onClose && onClose(); };
  el.querySelector('#sx').onclick = close;
  el.onclick = (e) => { if (e.target === el) close(); };
  return el;
}
function closeSheet() { document.getElementById('sheet')?.remove(); }

async function openNotifications() {
  const n = await api('/api/notifications').catch(errToast); if (!n) return;
  const canAsk = 'Notification' in window && Notification.permission !== 'granted';
  sheet('Notificaciones', `<div class="sheet-body">
    ${canAsk ? `<div class="card"><b>Recibe avisos aunque tengas la app cerrada</b><p class="muted">Te avisamos cuando arranca la ruta, cuando el bus está cerca y cuando tu hijo sube o llega.</p><button class="btn primary" id="bPush" style="width:100%">Activar notificaciones</button></div>` : ''}
    ${n.notifications.length ? n.notifications.map((x) => `<div class="notif ${x.read_at ? '' : 'unread'}"><div class="row"><b>${esc(x.title)}</b><span class="muted">${fechaHora(x.at)}</span></div><div>${esc(x.body || '')}</div></div>`).join('') : '<p class="muted" style="padding:16px 0">Aquí verás los avisos de la ruta.</p>'}
  </div>`);
  const b = document.getElementById('bPush');
  if (b) b.onclick = async () => { await enablePush(true); openNotifications(); };
  await api('/api/notifications/read', {}).catch(() => {});
  S.unread = 0; updateBadges();
}

async function openThreads() {
  const r = await api('/api/chat/threads').catch(errToast); if (!r) return;
  if (S.user.role === 'padre' && r.threads.length === 1) { const t = r.threads[0]; return openChat(t.route_id, t.parent_id, `Auxiliar · ${t.other_name || ''}`); }
  sheet(S.user.role === 'colegio' ? 'Conversaciones (solo lectura)' : 'Mensajes', `<div class="sheet-body"><div class="list" style="margin-top:12px">
    ${r.threads.map((t, i) => `<button class="item" style="border:0;text-align:left;width:100%" data-th="${i}">
      <div class="grow"><div class="name">${esc(t.other_name || 'Auxiliar')}</div><div class="muted">${esc(S.user.role === 'padre' ? t.route_name : (t.kids || []).join(', '))}${t.last ? ' · ' + esc(t.last.body.slice(0, 40)) : ''}</div></div>
      ${t.unread && S.user.role !== 'colegio' ? `<span class="pill p-amarillo">${t.unread}</span>` : ''}</button>`).join('') || '<p class="muted">Todavía no hay conversaciones.</p>'}
  </div></div>`);
  document.querySelectorAll('[data-th]').forEach((b) => (b.onclick = () => {
    const t = r.threads[Number(b.dataset.th)];
    openChat(t.route_id, t.parent_id, S.user.role === 'padre' ? `Auxiliar · ${t.other_name || ''}` : `${t.other_name} · ${(t.kids || []).join(', ')}`);
  }));
}

const QUICK = {
  padre: ['Ya vamos saliendo', 'Hoy lo recoge otra persona', 'Por favor espérenos 2 minutos', '¿Ya están cerca?', 'Gracias'],
  auxiliar: ['Estamos a 5 minutos', 'Ya llegamos a la parada', 'Vamos un poco tarde por el tráfico', 'Ya bajamos', 'Recibido, gracias'],
};
async function openChat(route_id, parent_id, title) {
  S.chat = { route_id, parent_id };
  const ro = S.user.role === 'colegio';
  const el = sheet(title, `
    <div class="sheet-body" id="msgsBox"><div class="msgs" id="msgs"><p class="muted">Cargando…</p></div></div>
    ${ro ? '<div class="composer muted">El colegio puede leer las conversaciones como respaldo.</div>' : `
    <div style="padding:0 14px;background:#fff"><div class="quick">${(QUICK[S.user.role] || []).map((q) => `<button type="button">${esc(q)}</button>`).join('')}</div></div>
    <form class="composer" id="cf"><label class="sr" for="ci">Mensaje</label><input id="ci" type="text" maxlength="1000" placeholder="Escribe un mensaje" autocomplete="off"><button class="btn primary small" type="submit">Enviar</button></form>`}`,
  () => { S.chat = null; refreshBadges(); });
  const r = await api(`/api/chat/messages?route_id=${route_id}&parent_id=${parent_id}`).catch(errToast);
  const box = document.getElementById('msgs');
  box.innerHTML = r && r.messages.length ? '' : '<p class="muted">Escribe el primer mensaje. El colegio también puede ver esta conversación.</p>';
  if (r) r.messages.forEach(appendMsg);
  if (ro) return;
  const sendTxt = async (txt) => { if (!txt.trim()) return; try { await api('/api/chat/send', { route_id, parent_id, body: txt }); } catch (e) { errToast(e); } };
  el.querySelector('#cf').onsubmit = (e) => { e.preventDefault(); const v = ci.value; ci.value = ''; sendTxt(v); };
  el.querySelectorAll('.quick button').forEach((b) => (b.onclick = () => sendTxt(b.textContent)));
}
function appendMsg(m) {
  const box = document.getElementById('msgs'); if (!box) return;
  box.querySelector('p.muted')?.remove();
  if (box.querySelector(`[data-mid="${m.id}"]`)) return;
  const mine = m.sender_id === S.user.id;
  const role = { padre: 'Padre/madre', auxiliar: 'Auxiliar', colegio: 'Colegio' }[m.sender_role] || '';
  box.insertAdjacentHTML('beforeend', `<div class="msg ${mine ? 'me' : ''}" data-mid="${m.id}">${esc(m.body)}<div class="meta">${mine ? '' : esc(m.sender_name) + ' · ' + role + ' · '}${hora(m.at)}</div></div>`);
  const sb = document.getElementById('msgsBox'); if (sb) sb.scrollTop = sb.scrollHeight;
}

// ---------- instalar como app en el celular ----------
let installEvt = null;
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const canInstall = () => !isStandalone() && !localStorage.getItem('eg_install_hide') && (installEvt || isIOS() || /android/i.test(navigator.userAgent));
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; if (S.token && S.data) render(); else if (!S.token) renderLogin(); });
window.addEventListener('appinstalled', () => { installEvt = null; toast('¡Listo!', 'EscolarGo quedó en tu pantalla de inicio.'); if (S.token && S.data) render(); });
function installCard() {
  if (!canInstall()) return '';
  return `<div class="install"><img src="/icon-192.png" alt=""><div class="grow"><b>Instala EscolarGo en tu celular</b>Ábrela desde la pantalla de inicio, como cualquier app.</div>
    <button class="btn small primary" id="bInstall">Instalar</button><button class="icon-btn" id="bInstallX" aria-label="Ocultar" style="background:transparent;color:var(--tinta)">${ICON.x}</button></div>`;
}
function bindInstall() {
  const b = document.getElementById('bInstall'); if (!b) return;
  b.onclick = async () => {
    if (installEvt) { installEvt.prompt(); const r = await installEvt.userChoice; installEvt = null; if (r.outcome !== 'accepted') toast('Cuando quieras', 'Puedes instalarla después desde aquí.'); return; }
    const ios = isIOS();
    sheet('Instalar EscolarGo', `<div class="sheet-body"><div class="card"><div style="display:flex;gap:12px;align-items:center"><img src="/icon-192.png" alt="" style="width:56px;height:56px;border-radius:14px"><b style="font-size:17px">EscolarGo</b></div>
      ${ios ? `<ol class="steps-ios"><li>Abre esta página en <b>Safari</b>.</li><li>Toca el botón <b>Compartir</b> (el cuadrado con la flecha hacia arriba).</li><li>Elige <b>Agregar a pantalla de inicio</b>.</li><li>Toca <b>Agregar</b>. El ícono del bus aparecerá con tus apps.</li></ol>`
      : `<ol class="steps-ios"><li>Abre esta página en <b>Chrome</b>.</li><li>Toca el menú <b>⋮</b> (arriba a la derecha).</li><li>Elige <b>Instalar app</b> o <b>Agregar a la pantalla principal</b>.</li><li>Confirma. El ícono del bus aparecerá con tus apps.</li></ol>`}
      <p class="muted">Después ábrela siempre desde el ícono: así te llegan las notificaciones.</p></div></div>`);
  };
  document.getElementById('bInstallX').onclick = () => { localStorage.setItem('eg_install_hide', '1'); document.querySelector('.install')?.remove(); };
}

// ---------- notificaciones push ----------
function b64ToBytes(b64) { const p = '='.repeat((4 - (b64.length % 4)) % 4); const s = atob((b64 + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(s, (c) => c.charCodeAt(0)); }
async function enablePush(ask) {
  if (!('Notification' in window) || !('serviceWorker' in navigator)) { if (ask) toast('No disponible', 'Este navegador no permite notificaciones. En iPhone, primero agrega la app a la pantalla de inicio.'); return; }
  const perm = ask ? await Notification.requestPermission() : Notification.permission;
  if (perm !== 'granted') { if (ask) toast('Notificaciones apagadas', 'Puedes activarlas en la configuración del navegador.'); return; }
  try {
    const reg = await navigator.serviceWorker.ready;
    const { key } = await api('/api/push/key');
    if (!key || !reg.pushManager) { if (ask) toast('Notificaciones activas', 'Te avisaremos mientras la app esté abierta.'); return; }
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
    await api('/api/push/subscribe', { subscription: sub.toJSON() });
    S.pushOn = true;
    if (ask) toast('Notificaciones activas', 'Te llegarán aunque cierres la app.');
  } catch (e) { if (ask) errToast(e); }
}
function setupPushSilently() { if ('Notification' in window && Notification.permission === 'granted') enablePush(false); }

setInterval(() => {
  if (!S.token || !S.data || document.hidden || S.sim) return;
  const live = S.data.trip || (S.data.routes || []).some((r) => r.trip);
  if (live) load();
}, 10000);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.token) { load(); refreshBadges(); } });
start();

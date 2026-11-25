// Capa de datos: Postgres si hay DATABASE_URL (Render), SQLite integrado de Node si no (pruebas locales).
const crypto = require('node:crypto');

let mode, pool, sqlite;

async function init() {
  if (process.env.DATABASE_URL) {
    const { Pool, types } = require('pg');
    types.setTypeParser(20, (v) => Number(v)); // BIGINT -> número
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
    });
    mode = 'pg';
  } else {
    const { DatabaseSync } = require('node:sqlite');
    sqlite = new DatabaseSync(process.env.SQLITE_FILE || 'escolargo.db');
    sqlite.exec('PRAGMA foreign_keys = ON');
    mode = 'sqlite';
  }
  await migrate();
  const n = await one('SELECT COUNT(*) AS n FROM users');
  if (!n || Number(n.n) === 0) await seed();
  console.log(`[db] listo (${mode})`);
}

function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

async function all(sql, params = []) {
  if (mode === 'pg') return (await pool.query(toPg(sql), params)).rows;
  return sqlite.prepare(sql).all(...params);
}
async function one(sql, params = []) {
  return (await all(sql, params))[0] || null;
}
async function run(sql, params = []) {
  if (mode === 'pg') {
    const r = await pool.query(toPg(sql), params);
    return r.rows[0] || null;
  }
  const st = sqlite.prepare(sql);
  if (/returning/i.test(sql)) return st.get(...params) || null;
  st.run(...params);
  return null;
}

async function migrate() {
  const ID = mode === 'pg' ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
  const stmts = [
    `CREATE TABLE IF NOT EXISTS schools (id ${ID}, name TEXT NOT NULL, lat DOUBLE PRECISION, lng DOUBLE PRECISION, address TEXT)`,
    `CREATE TABLE IF NOT EXISTS users (id ${ID}, school_id INTEGER REFERENCES schools(id), role TEXT NOT NULL, name TEXT NOT NULL, login TEXT UNIQUE NOT NULL, phone TEXT, pass_hash TEXT NOT NULL, created_at BIGINT)`,
    `CREATE TABLE IF NOT EXISTS vehicles (id ${ID}, school_id INTEGER REFERENCES schools(id), plate TEXT NOT NULL, brand TEXT, model TEXT, year INTEGER, capacity INTEGER, soat_until TEXT, tecno_until TEXT)`,
    `CREATE TABLE IF NOT EXISTS routes (id ${ID}, school_id INTEGER REFERENCES schools(id), name TEXT NOT NULL, vehicle_id INTEGER REFERENCES vehicles(id), aide_id INTEGER REFERENCES users(id), driver_name TEXT, driver_phone TEXT)`,
    `CREATE TABLE IF NOT EXISTS students (id ${ID}, school_id INTEGER REFERENCES schools(id), route_id INTEGER REFERENCES routes(id), name TEXT NOT NULL, grade TEXT, address TEXT, lat DOUBLE PRECISION, lng DOUBLE PRECISION, stop_order INTEGER DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS parent_students (parent_id INTEGER REFERENCES users(id), student_id INTEGER REFERENCES students(id), PRIMARY KEY (parent_id, student_id))`,
    `CREATE TABLE IF NOT EXISTS trips (id ${ID}, route_id INTEGER REFERENCES routes(id), shift TEXT NOT NULL, status TEXT NOT NULL, started_at BIGINT, ended_at BIGINT, last_lat DOUBLE PRECISION, last_lng DOUBLE PRECISION, last_at BIGINT, speed_kmh DOUBLE PRECISION)`,
    `CREATE TABLE IF NOT EXISTS trip_events (id ${ID}, trip_id INTEGER REFERENCES trips(id), student_id INTEGER, type TEXT NOT NULL, note TEXT, at BIGINT NOT NULL, lat DOUBLE PRECISION, lng DOUBLE PRECISION)`,
    `CREATE TABLE IF NOT EXISTS absences (student_id INTEGER REFERENCES students(id), day TEXT NOT NULL, shift TEXT NOT NULL, by_user INTEGER, PRIMARY KEY (student_id, day, shift))`,
    `CREATE TABLE IF NOT EXISTS messages (id ${ID}, route_id INTEGER REFERENCES routes(id), parent_id INTEGER REFERENCES users(id), sender_id INTEGER REFERENCES users(id), body TEXT NOT NULL, at BIGINT NOT NULL, read_at BIGINT)`,
    `CREATE TABLE IF NOT EXISTS notifications (id ${ID}, user_id INTEGER REFERENCES users(id), title TEXT NOT NULL, body TEXT, kind TEXT, at BIGINT NOT NULL, read_at BIGINT)`,
    `CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, user_id INTEGER REFERENCES users(id), sub_json TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS trip_points (id ${ID}, trip_id INTEGER REFERENCES trips(id), lat DOUBLE PRECISION NOT NULL, lng DOUBLE PRECISION NOT NULL, at BIGINT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS trip_streets (id ${ID}, trip_id INTEGER REFERENCES trips(id), street TEXT NOT NULL, at BIGINT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS ix_points_trip ON trip_points(trip_id)`,
    `CREATE INDEX IF NOT EXISTS ix_streets_trip ON trip_streets(trip_id)`,
    `CREATE INDEX IF NOT EXISTS ix_events_trip ON trip_events(trip_id)`,
    `CREATE INDEX IF NOT EXISTS ix_msgs_thread ON messages(route_id, parent_id)`,
    `CREATE INDEX IF NOT EXISTS ix_notif_user ON notifications(user_id)`,
  ];
  for (const s of stmts) await run(s);
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(pw, salt, 32).toString('hex');
  return `${salt}:${h}`;
}
function checkPassword(pw, stored) {
  const [salt, h] = String(stored).split(':');
  if (!salt || !h) return false;
  const got = crypto.scryptSync(pw, salt, 32);
  const want = Buffer.from(h, 'hex');
  return want.length === got.length && crypto.timingSafeEqual(got, want);
}

// Datos de demostración (Cali). Todos los nombres, placas y direcciones son ficticios.
async function seed() {
  const now = Date.now();
  const pw = process.env.DEMO_PASSWORD || 'demo1234';
  const school = await run('INSERT INTO schools (name, lat, lng, address) VALUES (?,?,?,?) RETURNING id',
    ['Colegio Demo EscolarGo', 3.3335, -76.5330, 'Pance, Cra. 122 # 18-50']);
  const sid = school.id;
  const mk = (role, name, login, phone) => run(
    'INSERT INTO users (school_id, role, name, login, phone, pass_hash, created_at) VALUES (?,?,?,?,?,?,?) RETURNING id',
    [sid, role, name, login, phone, hashPassword(pw), now]);
  await mk('colegio', 'Coordinación de transporte', 'colegio', '3000000000');
  const aide = await mk('auxiliar', 'Marcela Díaz', 'marcela', '3001112233');
  const p1 = await mk('padre', 'Laura Gómez', 'laura', '3002223344');
  const p2 = await mk('padre', 'Andrés Rojas', 'andres', '3003334455');
  const p3 = await mk('padre', 'Camila Pérez', 'camila', '3004445566');
  const veh = await run('INSERT INTO vehicles (school_id, plate, brand, model, year, capacity, soat_until, tecno_until) VALUES (?,?,?,?,?,?,?,?) RETURNING id',
    [sid, 'ABC-123', 'Chevrolet', 'NPR', 2022, 20, '2026-12-01', '2027-03-15']);
  const route = await run('INSERT INTO routes (school_id, name, vehicle_id, aide_id, driver_name, driver_phone) VALUES (?,?,?,?,?,?) RETURNING id',
    [sid, 'Ruta 07 · Sur', veh.id, aide.id, 'Jorge Ramírez', '3005556677']);
  const st = [
    ['Tomás Rojas', '3°', 'Ciudad Jardín, Calle 16 # 105-40', 3.3605, -76.5372, p2.id],
    ['Valentina Gómez', '5°', 'El Ingenio, Cra. 85 # 13-30', 3.3845, -76.5315, p1.id],
    ['Samuel Pérez', '2°', 'Capri, Calle 10 # 66-12', 3.3965, -76.5245, p3.id],
    ['Isabella Gómez', '1°', 'El Ingenio, Cra. 85 # 13-30', 3.3845, -76.5315, p1.id],
  ];
  // Orden de recogida (de norte a sur, hacia el colegio en Pance): Samuel, Valentina e Isabella (hermanas, misma parada), Tomás.
  const order = [2, 1, 0, 1];
  for (let i = 0; i < st.length; i++) {
    const [name, grade, address, lat, lng, parent] = st[i];
    const s = await run('INSERT INTO students (school_id, route_id, name, grade, address, lat, lng, stop_order) VALUES (?,?,?,?,?,?,?,?) RETURNING id',
      [sid, route.id, name, grade, address, lat, lng, order[i]]);
    await run('INSERT INTO parent_students (parent_id, student_id) VALUES (?,?)', [parent, s.id]);
  }
  console.log(`[db] datos de demo creados (contraseña: ${pw})`);
}

module.exports = { init, all, one, run, hashPassword, checkPassword, get mode() { return mode; } };

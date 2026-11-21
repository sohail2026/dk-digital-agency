// ============================================================
// DK Digital Agency — Facebook services wallet app (v2)
// Owner: Tahsan Ahmad Sohel | WhatsApp: 01833990497
// Stack: Node.js + Express + PostgreSQL (Neon free tier)
// v2 changes: Postgres instead of SQLite (Render free disk wipes
// SQLite files, which deleted all customer data), login with phone
// OR email, in-app messaging, admin balance adjustment.
// ============================================================
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Pool, types } = require('pg');

// pg returns NUMERIC / BIGINT as strings by default — parse them as numbers
types.setTypeParser(1700, (v) => parseFloat(v)); // NUMERIC
types.setTypeParser(20, (v) => parseInt(v, 10)); // BIGINT (e.g. COUNT(*))

const PORT = process.env.PORT || 3000;
const ADMIN_PHONE = '01833990497';
const DEFAULT_ADMIN_PIN = '1234';
const SESSION_DAYS = 7;

// ---------------- Database ----------------
// One code path: PostgreSQL only, connection from DATABASE_URL.
// The app refuses to start without it — there is no local fallback,
// so data can never silently end up in a file that a host can wipe.
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL is not set. See README.md — "Neon free database setup".');
  process.exit(1);
}
const dbUrl = new URL(DATABASE_URL);
const isLocalDb = ['localhost', '127.0.0.1', '::1'].includes(dbUrl.hostname);
const pool = new Pool({
  connectionString: DATABASE_URL,
  // Neon (and other hosted Postgres) requires SSL; local Postgres does not.
  ssl: isLocalDb ? false : { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
});
pool.on('error', (err) => console.error('Unexpected pool error:', err));

async function initDb() {
  await pool.query(`
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT UNIQUE,
  email TEXT UNIQUE,
  pin_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'customer',
  balance NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT users_contact_check CHECK (phone IS NOT NULL OR email IS NOT NULL)
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS deposits (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  method TEXT NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
  trxid TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  service_id INTEGER NOT NULL,
  service_name TEXT NOT NULL,
  description TEXT NOT NULL,
  price NUMERIC(12,2),
  status TEXT NOT NULL DEFAULT 'awaiting_price',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS transactions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
  description TEXT NOT NULL,
  ref_type TEXT,
  ref_id INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  sender TEXT NOT NULL CHECK (sender IN ('customer', 'admin')),
  text TEXT NOT NULL,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS messages_user_idx ON messages (user_id, created_at);
`);

  // Seed admin account + default payment number (first run only)
  const admin = await pool.query('SELECT id FROM users WHERE phone = $1', [ADMIN_PHONE]);
  if (admin.rows.length === 0) {
    await pool.query(
      'INSERT INTO users (name, phone, pin_hash, role) VALUES ($1, $2, $3, $4)',
      ['Tahsan Ahmad Sohel', ADMIN_PHONE, hashPin(DEFAULT_ADMIN_PIN), 'admin']
    );
    console.log('Seeded admin account:', ADMIN_PHONE, '/ PIN', DEFAULT_ADMIN_PIN);
  }
  await pool.query(
    "INSERT INTO settings (key, value) VALUES ('payment_number', $1) ON CONFLICT (key) DO NOTHING",
    [ADMIN_PHONE]
  );
  // Clean expired sessions
  await pool.query("DELETE FROM sessions WHERE expires_at < NOW()");
}

// Run a function inside a transaction; rolls back on any error.
async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

// ---------------- Services (fixed list, Bengali) ----------------
const SERVICES = [
  { id: 1, name: 'ফেসবুক পেমেন্ট পেইড কিন্তু ব্যাংকে আসেনা' },
  { id: 2, name: 'ফেসবুকের আর্নিং প্রসেস কিন্তু পেইড হচ্ছে না' },
  { id: 3, name: 'পে-আউটের নাম জন্মসাল ভুল' },
  { id: 4, name: 'পে-আউট ট্রান্সফার' },
  { id: 5, name: 'মনিটাইজেশন রেস্ট্রিকটেড' },
  { id: 6, name: 'হারিয়ে যাওয়া পে আউট রিকভারি' },
  { id: 7, name: 'সাসপেন্ড আইডি/পেজ রিকভার' },
  { id: 8, name: 'পেইজ আইডি ভেরিফাই ব্যাজ' },
  { id: 9, name: 'মনিটাইজেশন পেজ কিনতে পাওয়া যায়' },
  { id: 10, name: 'এছাড়াও ফেসবুকের সকল সার্ভিস' },
];

// ---------------- Helpers ----------------
function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pin, salt, 64).toString('hex');
  return salt + ':' + hash;
}
function verifyPin(pin, stored) {
  try {
    const [salt, hash] = stored.split(':');
    const h = crypto.scryptSync(pin, salt, 64);
    return crypto.timingSafeEqual(h, Buffer.from(hash, 'hex'));
  } catch { return false; }
}
function validPhone(p) { return typeof p === 'string' && /^01[3-9]\d{8}$/.test(p.trim()); }
function validEmail(e) { return typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e.trim()); }
function validPin(p) { return typeof p === 'string' && /^\d{4}$/.test(p); }
function validAmount(a) { return Number.isInteger(a) && a > 0 && a <= 1000000; }
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(c => {
    const i = c.indexOf('=');
    if (i > -1) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
  });
  return out;
}
async function getSetting(key) {
  const r = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
  return r.rows.length ? r.rows[0].value : null;
}
function publicUser(u) {
  return { id: u.id, name: u.name, phone: u.phone || null, email: u.email || null, role: u.role, balance: Number(u.balance) };
}
// Wrap async route handlers so rejections reach the error middleware.
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Simple brute-force guard on login: 5 failed tries -> 15 min lock per identifier
const loginLocks = new Map(); // identifier -> { fails, lockedUntil }
function isLocked(id) {
  const e = loginLocks.get(id);
  return e && e.lockedUntil && Date.now() < e.lockedUntil;
}
function noteFailedLogin(id) {
  const e = loginLocks.get(id) || { fails: 0, lockedUntil: 0 };
  e.fails += 1;
  if (e.fails >= 5) { e.lockedUntil = Date.now() + 15 * 60 * 1000; e.fails = 0; }
  loginLocks.set(id, e);
}

// ---------------- App ----------------
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '100kb' }));

async function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const exp = new Date(Date.now() + SESSION_DAYS * 24 * 3600 * 1000);
  await pool.query('INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)', [token, userId, exp]);
  res.cookie('session', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_DAYS * 24 * 3600 * 1000,
  });
}

async function auth(req, res, next) {
  const token = parseCookies(req).session;
  if (!token) return res.status(401).json({ error: 'লগইন করুন' });
  const r = await pool.query(
    `SELECT u.id, u.name, u.phone, u.email, u.role, u.balance, s.expires_at
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = $1`,
    [token]
  );
  const row = r.rows[0];
  if (!row || new Date(row.expires_at) < new Date()) {
    if (row) await pool.query('DELETE FROM sessions WHERE token = $1', [token]);
    return res.status(401).json({ error: 'সেশন শেষ হয়ে গেছে, আবার লগইন করুন' });
  }
  req.user = { id: row.id, name: row.name, phone: row.phone, email: row.email, role: row.role, balance: Number(row.balance) };
  next();
}
function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'শুধু অ্যাডমিনের জন্য' });
  next();
}

// ---------------- Public API ----------------
app.get('/api/health', (req, res) => res.json({ ok: true }));
app.get('/api/services', (req, res) => res.json(SERVICES));

app.post('/api/register', ah(async (req, res) => {
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  const phone = typeof req.body.phone === 'string' ? req.body.phone.trim() : '';
  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const pin = req.body.pin;
  if (!name || name.length > 60) return res.status(400).json({ error: 'সঠিক নাম দিন' });
  if (!phone && !email) return res.status(400).json({ error: 'মোবাইল নম্বর বা ইমেইল — যেকোনো একটা দিন' });
  if (phone && !validPhone(phone)) return res.status(400).json({ error: 'সঠিক মোবাইল নম্বর দিন (01XXXXXXXXX)' });
  if (email && !validEmail(email)) return res.status(400).json({ error: 'সঠিক ইমেইল ঠিকানা দিন' });
  if (!validPin(pin)) return res.status(400).json({ error: '৪ সংখ্যার PIN দিন' });
  if (phone) {
    const exists = await pool.query('SELECT id FROM users WHERE phone = $1', [phone]);
    if (exists.rows.length) return res.status(409).json({ error: 'এই নম্বরে ইতিমধ্যে অ্যাকাউন্ট আছে, লগইন করুন' });
  }
  if (email) {
    const exists = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (exists.rows.length) return res.status(409).json({ error: 'এই ইমেইলে ইতিমধ্যে অ্যাকাউন্ট আছে, লগইন করুন' });
  }
  try {
    const r = await pool.query(
      'INSERT INTO users (name, phone, email, pin_hash) VALUES ($1, $2, $3, $4) RETURNING id',
      [name, phone || null, email || null, hashPin(pin)]
    );
    const id = r.rows[0].id;
    await createSession(res, id);
    const user = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
    res.json({ ok: true, user: publicUser(user.rows[0]) });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'এই নম্বর/ইমেইলে ইতিমধ্যে অ্যাকাউন্ট আছে, লগইন করুন' });
    throw e;
  }
}));

app.post('/api/login', ah(async (req, res) => {
  // Accepts phone OR email as the identifier (plus legacy `phone` field).
  const identifier = typeof req.body.identifier === 'string' ? req.body.identifier.trim()
    : (typeof req.body.phone === 'string' ? req.body.phone.trim() : '');
  const pin = req.body.pin;
  const isEmail = identifier.includes('@');
  const idKey = isEmail ? identifier.toLowerCase() : identifier;
  if (!validPin(pin) || (isEmail ? !validEmail(identifier) : !validPhone(identifier)))
    return res.status(400).json({ error: 'সঠিক নম্বর/ইমেইল ও ৪ সংখ্যার PIN দিন' });
  if (isLocked(idKey)) return res.status(429).json({ error: 'অনেকবার ভুল PIN দিয়েছেন, ১৫ মিনিট পর আবার চেষ্টা করুন' });
  const r = isEmail
    ? await pool.query('SELECT * FROM users WHERE email = $1', [idKey])
    : await pool.query('SELECT * FROM users WHERE phone = $1', [identifier]);
  const user = r.rows[0];
  if (!user || !verifyPin(pin, user.pin_hash)) {
    noteFailedLogin(idKey);
    return res.status(401).json({ error: 'নম্বর/ইমেইল বা PIN ভুল' });
  }
  loginLocks.delete(idKey);
  await createSession(res, user.id);
  res.json({ ok: true, user: publicUser(user) });
}));

app.post('/api/logout', ah(async (req, res) => {
  const token = parseCookies(req).session;
  if (token) await pool.query('DELETE FROM sessions WHERE token = $1', [token]);
  res.clearCookie('session', { path: '/' });
  res.json({ ok: true });
}));

// ---------------- Customer API ----------------
app.get('/api/me', auth, ah(async (req, res) => {
  const r = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
  res.json({ user: publicUser(r.rows[0]), payment_number: await getSetting('payment_number') });
}));

app.get('/api/wallet', auth, ah(async (req, res) => {
  const user = await pool.query('SELECT balance FROM users WHERE id = $1', [req.user.id]);
  const txs = await pool.query('SELECT * FROM transactions WHERE user_id = $1 ORDER BY id DESC LIMIT 100', [req.user.id]);
  const deps = await pool.query('SELECT * FROM deposits WHERE user_id = $1 ORDER BY id DESC LIMIT 50', [req.user.id]);
  res.json({ balance: Number(user.rows[0].balance), transactions: txs.rows, deposits: deps.rows });
}));

app.post('/api/deposits', auth, ah(async (req, res) => {
  const method = req.body.method;
  const amount = req.body.amount;
  const trxid = typeof req.body.trxid === 'string' ? req.body.trxid.trim().toUpperCase() : '';
  if (method !== 'bKash' && method !== 'Nagad') return res.status(400).json({ error: 'bKash বা Nagad বেছে নিন' });
  if (!validAmount(amount)) return res.status(400).json({ error: 'সঠিক টাকার পরিমাণ দিন (১ – ১০,০০,০০০)' });
  if (!/^[A-Z0-9]{6,20}$/.test(trxid)) return res.status(400).json({ error: 'সঠিক TrxID দিন' });
  try {
    const r = await pool.query(
      'INSERT INTO deposits (user_id, method, amount, trxid) VALUES ($1, $2, $3, $4) RETURNING id',
      [req.user.id, method, amount, trxid]
    );
    res.json({ ok: true, id: r.rows[0].id });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'এই TrxID ইতিমধ্যে ব্যবহার হয়েছে' });
    throw e;
  }
}));

app.get('/api/orders', auth, ah(async (req, res) => {
  const r = await pool.query('SELECT * FROM orders WHERE user_id = $1 ORDER BY id DESC', [req.user.id]);
  res.json(r.rows);
}));

app.post('/api/orders', auth, ah(async (req, res) => {
  const service = SERVICES.find(s => s.id === req.body.service_id);
  const description = typeof req.body.description === 'string' ? req.body.description.trim() : '';
  if (!service) return res.status(400).json({ error: 'সার্ভিস বেছে নিন' });
  if (!description || description.length > 500) return res.status(400).json({ error: 'সমস্যাটি সংক্ষেপে লিখুন (সর্বোচ্চ ৫০০ অক্ষর)' });
  const r = await pool.query(
    'INSERT INTO orders (user_id, service_id, service_name, description) VALUES ($1, $2, $3, $4) RETURNING id',
    [req.user.id, service.id, service.name, description]
  );
  res.json({ ok: true, id: r.rows[0].id });
}));

app.post('/api/orders/:id/confirm', auth, ah(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ভুল অর্ডার' });
  const result = await withTx(async (client) => {
    const o = await client.query('SELECT * FROM orders WHERE id = $1 AND user_id = $2 FOR UPDATE', [id, req.user.id]);
    const order = o.rows[0];
    if (!order) return { status: 404, body: { error: 'অর্ডার পাওয়া যায়নি' } };
    if (order.status !== 'awaiting_payment')
      return { status: 409, body: { error: 'এই অর্ডারের পেমেন্ট এখন করা যাবে না' } };
    const u = await client.query('SELECT balance FROM users WHERE id = $1 FOR UPDATE', [req.user.id]);
    const balance = Number(u.rows[0].balance);
    const price = Number(order.price);
    if (balance < price)
      return { status: 402, body: { error: 'ব্যালেন্স যথেষ্ট নয় — প্রথমে টাকা যোগ করুন', need: price - balance } };
    await client.query('UPDATE users SET balance = balance - $1 WHERE id = $2', [price, req.user.id]);
    await client.query("UPDATE orders SET status = 'in_progress', updated_at = NOW() WHERE id = $1", [id]);
    await client.query(
      'INSERT INTO transactions (user_id, type, amount, description, ref_type, ref_id) VALUES ($1, $2, $3, $4, $5, $6)',
      [req.user.id, 'order_payment', -price, 'অর্ডার #' + id + ' — ' + order.service_name, 'order', id]
    );
    return { status: 200, body: { ok: true } };
  });
  res.status(result.status).json(result.body);
}));

app.post('/api/orders/:id/cancel', auth, ah(async (req, res) => {
  const id = Number(req.params.id);
  const r = await pool.query('SELECT * FROM orders WHERE id = $1 AND user_id = $2', [id, req.user.id]);
  const order = r.rows[0];
  if (!order) return res.status(404).json({ error: 'অর্ডার পাওয়া যায়নি' });
  if (order.status !== 'awaiting_price' && order.status !== 'awaiting_payment')
    return res.status(409).json({ error: 'এই অর্ডার এখন বাতিল করা যাবে না' });
  await pool.query("UPDATE orders SET status = 'cancelled', updated_at = NOW() WHERE id = $1", [id]);
  res.json({ ok: true });
}));

// ---------------- Messaging (customer ↔ admin) ----------------
app.get('/api/messages', auth, ah(async (req, res) => {
  const r = await pool.query(
    'SELECT id, sender, text, is_read, created_at FROM messages WHERE user_id = $1 ORDER BY id ASC',
    [req.user.id]
  );
  // Reading the conversation marks the admin's replies as read.
  await pool.query(
    "UPDATE messages SET is_read = TRUE WHERE user_id = $1 AND sender = 'admin' AND is_read = FALSE",
    [req.user.id]
  );
  res.json(r.rows);
}));

app.get('/api/messages/unread-count', auth, ah(async (req, res) => {
  const r = await pool.query(
    "SELECT COUNT(*) AS c FROM messages WHERE user_id = $1 AND sender = 'admin' AND is_read = FALSE",
    [req.user.id]
  );
  res.json({ unread: Number(r.rows[0].c) });
}));

app.post('/api/messages', auth, ah(async (req, res) => {
  const text = typeof req.body.text === 'string' ? req.body.text.trim() : '';
  if (!text || text.length > 2000) return res.status(400).json({ error: 'মেসেজ লিখুন (সর্বোচ্চ ২০০০ অক্ষর)' });
  const r = await pool.query(
    "INSERT INTO messages (user_id, sender, text) VALUES ($1, 'customer', $2) RETURNING id, sender, text, is_read, created_at",
    [req.user.id, text]
  );
  res.json({ ok: true, message: r.rows[0] });
}));

// ---------------- Admin API ----------------
app.get('/api/admin/overview', auth, adminOnly, ah(async (req, res) => {
  const q = async (sql) => Number((await pool.query(sql)).rows[0].c);
  res.json({
    pending_deposits: await q("SELECT COUNT(*) c FROM deposits WHERE status = 'pending'"),
    awaiting_price: await q("SELECT COUNT(*) c FROM orders WHERE status = 'awaiting_price'"),
    awaiting_payment: await q("SELECT COUNT(*) c FROM orders WHERE status = 'awaiting_payment'"),
    in_progress: await q("SELECT COUNT(*) c FROM orders WHERE status = 'in_progress'"),
    completed: await q("SELECT COUNT(*) c FROM orders WHERE status = 'completed'"),
    customers: await q("SELECT COUNT(*) c FROM users WHERE role = 'customer'"),
    unread_messages: await q("SELECT COUNT(*) c FROM messages WHERE sender = 'customer' AND is_read = FALSE"),
    total_wallet: Number((await pool.query("SELECT COALESCE(SUM(balance),0) s FROM users WHERE role='customer'")).rows[0].s),
  });
}));

app.get('/api/admin/deposits', auth, adminOnly, ah(async (req, res) => {
  const status = req.query.status;
  const r = status
    ? await pool.query(`SELECT d.*, u.name, u.phone, u.email FROM deposits d JOIN users u ON u.id = d.user_id WHERE d.status = $1 ORDER BY d.id DESC`, [status])
    : await pool.query(`SELECT d.*, u.name, u.phone, u.email FROM deposits d JOIN users u ON u.id = d.user_id ORDER BY d.id DESC LIMIT 200`);
  res.json(r.rows);
}));

app.post('/api/admin/deposits/:id/approve', auth, adminOnly, ah(async (req, res) => {
  const id = Number(req.params.id);
  const result = await withTx(async (client) => {
    const d = await client.query('SELECT * FROM deposits WHERE id = $1 FOR UPDATE', [id]);
    const dep = d.rows[0];
    if (!dep) return { status: 404, body: { error: 'ডিপোজিট পাওয়া যায়নি' } };
    if (dep.status !== 'pending') return { status: 409, body: { error: 'এটা আগেই সিদ্ধান্ত নেওয়া হয়েছে' } };
    await client.query("UPDATE deposits SET status = 'approved', decided_at = NOW() WHERE id = $1", [id]);
    await client.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [Number(dep.amount), dep.user_id]);
    await client.query(
      'INSERT INTO transactions (user_id, type, amount, description, ref_type, ref_id) VALUES ($1, $2, $3, $4, $5, $6)',
      [dep.user_id, 'deposit', Number(dep.amount), dep.method + ' ডিপোজিট — TrxID ' + dep.trxid, 'deposit', id]
    );
    return { status: 200, body: { ok: true } };
  });
  res.status(result.status).json(result.body);
}));

app.post('/api/admin/deposits/:id/reject', auth, adminOnly, ah(async (req, res) => {
  const id = Number(req.params.id);
  const r = await pool.query('SELECT * FROM deposits WHERE id = $1', [id]);
  const dep = r.rows[0];
  if (!dep) return res.status(404).json({ error: 'ডিপোজিট পাওয়া যায়নি' });
  if (dep.status !== 'pending') return res.status(409).json({ error: 'এটা আগেই সিদ্ধান্ত নেওয়া হয়েছে' });
  await pool.query("UPDATE deposits SET status = 'rejected', decided_at = NOW() WHERE id = $1", [id]);
  res.json({ ok: true });
}));

app.get('/api/admin/orders', auth, adminOnly, ah(async (req, res) => {
  const status = req.query.status;
  const r = status
    ? await pool.query(`SELECT o.*, u.name, u.phone, u.email FROM orders o JOIN users u ON u.id = o.user_id WHERE o.status = $1 ORDER BY o.id DESC`, [status])
    : await pool.query(`SELECT o.*, u.name, u.phone, u.email FROM orders o JOIN users u ON u.id = o.user_id ORDER BY o.id DESC LIMIT 200`);
  res.json(r.rows);
}));

app.post('/api/admin/orders/:id/set-price', auth, adminOnly, ah(async (req, res) => {
  const id = Number(req.params.id);
  const price = req.body.price;
  if (!validAmount(price)) return res.status(400).json({ error: 'সঠিক দাম দিন' });
  const r = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
  const order = r.rows[0];
  if (!order) return res.status(404).json({ error: 'অর্ডার পাওয়া যায়নি' });
  if (order.status !== 'awaiting_price') return res.status(409).json({ error: 'এই অর্ডারে এখন দাম বসানো যাবে না' });
  await pool.query("UPDATE orders SET price = $1, status = 'awaiting_payment', updated_at = NOW() WHERE id = $2", [price, id]);
  res.json({ ok: true });
}));

app.post('/api/admin/orders/:id/complete', auth, adminOnly, ah(async (req, res) => {
  const id = Number(req.params.id);
  const r = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
  const order = r.rows[0];
  if (!order) return res.status(404).json({ error: 'অর্ডার পাওয়া যায়নি' });
  if (order.status !== 'in_progress') return res.status(409).json({ error: 'শুধু চলমান অর্ডার সম্পন্ন করা যায়' });
  await pool.query("UPDATE orders SET status = 'completed', updated_at = NOW() WHERE id = $1", [id]);
  res.json({ ok: true });
}));

app.post('/api/admin/orders/:id/cancel', auth, adminOnly, ah(async (req, res) => {
  const id = Number(req.params.id);
  const result = await withTx(async (client) => {
    const o = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [id]);
    const order = o.rows[0];
    if (!order) return { status: 404, body: { error: 'অর্ডার পাওয়া যায়নি' } };
    if (order.status === 'completed' || order.status === 'cancelled')
      return { status: 409, body: { error: 'এই অর্ডার বাতিল করা যাবে না' } };
    // Paid order cancelled -> refund the customer
    if (order.status === 'in_progress' && order.price) {
      const price = Number(order.price);
      await client.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [price, order.user_id]);
      await client.query(
        'INSERT INTO transactions (user_id, type, amount, description, ref_type, ref_id) VALUES ($1, $2, $3, $4, $5, $6)',
        [order.user_id, 'refund', price, 'অর্ডার #' + id + ' বাতিল — টাকা ফেরত', 'order', id]
      );
    }
    await client.query("UPDATE orders SET status = 'cancelled', updated_at = NOW() WHERE id = $1", [id]);
    return { status: 200, body: { ok: true } };
  });
  res.status(result.status).json(result.body);
}));

app.get('/api/admin/customers', auth, adminOnly, ah(async (req, res) => {
  const r = await pool.query(
    `SELECT u.id, u.name, u.phone, u.email, u.balance, u.created_at,
      (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id) AS order_count
     FROM users u WHERE u.role = 'customer' ORDER BY u.id DESC`
  );
  res.json(r.rows);
}));

// Manual balance adjustment — e.g. to restore money for customers whose
// balance was lost when the old SQLite file was wiped.
app.post('/api/admin/customers/:id/adjust', auth, adminOnly, ah(async (req, res) => {
  const id = Number(req.params.id);
  const amount = req.body.amount;
  const direction = req.body.direction;
  const note = typeof req.body.note === 'string' ? req.body.note.trim().slice(0, 200) : '';
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ভুল কাস্টমার' });
  if (!validAmount(amount)) return res.status(400).json({ error: 'সঠিক টাকার পরিমাণ দিন (১ – ১০,০০,০০০)' });
  if (direction !== 'add' && direction !== 'deduct') return res.status(400).json({ error: 'যোগ না বিয়োগ — বেছে নিন' });
  const result = await withTx(async (client) => {
    const u = await client.query("SELECT id, name, balance FROM users WHERE id = $1 AND role = 'customer' FOR UPDATE", [id]);
    const user = u.rows[0];
    if (!user) return { status: 404, body: { error: 'কাস্টমার পাওয়া যায়নি' } };
    const balance = Number(user.balance);
    if (direction === 'deduct' && balance < amount)
      return { status: 409, body: { error: 'কাস্টমারের ব্যালেন্সে এত টাকা নেই (ব্যালেন্স: ৳' + balance.toLocaleString('en-US') + ')' } };
    const delta = direction === 'add' ? amount : -amount;
    await client.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [delta, id]);
    const desc = (direction === 'add' ? 'অ্যাডমিন ব্যালেন্স যোগ করেছেন' : 'অ্যাডমিন ব্যালেন্স কেটেছেন')
      + (note ? ' — ' + note : '');
    await client.query(
      'INSERT INTO transactions (user_id, type, amount, description) VALUES ($1, $2, $3, $4)',
      [id, 'adjustment', delta, desc]
    );
    return { status: 200, body: { ok: true, balance: balance + delta } };
  });
  res.status(result.status).json(result.body);
}));

// ---------------- Admin messaging ----------------
app.get('/api/admin/messages', auth, adminOnly, ah(async (req, res) => {
  // One row per customer who has messaged: last message + unread count.
  const r = await pool.query(`
    SELECT u.id AS user_id, u.name, u.phone, u.email,
      (SELECT m.text FROM messages m WHERE m.user_id = u.id ORDER BY m.id DESC LIMIT 1) AS last_text,
      (SELECT m.created_at FROM messages m WHERE m.user_id = u.id ORDER BY m.id DESC LIMIT 1) AS last_at,
      (SELECT COUNT(*) FROM messages m WHERE m.user_id = u.id AND m.sender = 'customer' AND m.is_read = FALSE) AS unread
    FROM users u
    WHERE u.role = 'customer' AND EXISTS (SELECT 1 FROM messages m WHERE m.user_id = u.id)
    ORDER BY last_at DESC
  `);
  res.json(r.rows);
}));

app.get('/api/admin/messages/:userId', auth, adminOnly, ah(async (req, res) => {
  const userId = Number(req.params.userId);
  if (!Number.isInteger(userId)) return res.status(400).json({ error: 'ভুল কাস্টমার' });
  const u = await pool.query("SELECT id, name, phone, email FROM users WHERE id = $1 AND role = 'customer'", [userId]);
  if (!u.rows.length) return res.status(404).json({ error: 'কাস্টমার পাওয়া যায়নি' });
  const r = await pool.query(
    'SELECT id, sender, text, is_read, created_at FROM messages WHERE user_id = $1 ORDER BY id ASC',
    [userId]
  );
  // Opening the conversation marks the customer's messages as read.
  await pool.query(
    "UPDATE messages SET is_read = TRUE WHERE user_id = $1 AND sender = 'customer' AND is_read = FALSE",
    [userId]
  );
  res.json({ customer: u.rows[0], messages: r.rows });
}));

app.post('/api/admin/messages/:userId', auth, adminOnly, ah(async (req, res) => {
  const userId = Number(req.params.userId);
  const text = typeof req.body.text === 'string' ? req.body.text.trim() : '';
  if (!Number.isInteger(userId)) return res.status(400).json({ error: 'ভুল কাস্টমার' });
  if (!text || text.length > 2000) return res.status(400).json({ error: 'মেসেজ লিখুন (সর্বোচ্চ ২০০০ অক্ষর)' });
  const u = await pool.query("SELECT id FROM users WHERE id = $1 AND role = 'customer'", [userId]);
  if (!u.rows.length) return res.status(404).json({ error: 'কাস্টমার পাওয়া যায়নি' });
  const r = await pool.query(
    "INSERT INTO messages (user_id, sender, text) VALUES ($1, 'admin', $2) RETURNING id, sender, text, is_read, created_at",
    [userId, text]
  );
  res.json({ ok: true, message: r.rows[0] });
}));

app.get('/api/admin/settings', auth, adminOnly, ah(async (req, res) => {
  res.json({ payment_number: await getSetting('payment_number') });
}));

app.post('/api/admin/settings', auth, adminOnly, ah(async (req, res) => {
  const n = typeof req.body.payment_number === 'string' ? req.body.payment_number.trim() : '';
  if (!validPhone(n)) return res.status(400).json({ error: 'সঠিক মোবাইল নম্বর দিন' });
  await pool.query(
    "INSERT INTO settings (key, value) VALUES ('payment_number', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
    [n]
  );
  res.json({ ok: true });
}));

app.post('/api/admin/change-pin', auth, adminOnly, ah(async (req, res) => {
  const { old_pin, new_pin } = req.body;
  if (!validPin(old_pin) || !validPin(new_pin)) return res.status(400).json({ error: '৪ সংখ্যার PIN দিন' });
  const r = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
  const user = r.rows[0];
  if (!verifyPin(old_pin, user.pin_hash)) return res.status(401).json({ error: 'পুরনো PIN ভুল' });
  await pool.query('UPDATE users SET pin_hash = $1 WHERE id = $2', [hashPin(new_pin), req.user.id]);
  res.json({ ok: true });
}));

// ---------------- Static frontend ----------------
// The frontend files normally live in public/ (index.html, style.css, app.js).
// GitHub's web UI makes it easy to upload them to the wrong place (a folder
// with a trailing space, an extra nested folder, or the repo root), so resolve
// each file from the first location where it actually exists.
const FRONTEND_DIRS = [
  path.join(__dirname, 'public'),
  __dirname,
  path.join(__dirname, 'public '),
  path.join(__dirname, 'public ', 'src'),
  path.join(__dirname, 'public ', 'src', 'src'),
];
function frontendFile(name) {
  for (const dir of FRONTEND_DIRS) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return path.join(__dirname, 'public', name); // default: surfaces a clear ENOENT
}
for (const f of ['index.html', 'app.js', 'style.css']) {
  console.log('frontend:', f, '->', frontendFile(f));
}
const serveFrontend = (name) => (req, res, next) =>
  res.sendFile(frontendFile(name), (err) => { if (err) next(err); });
app.get('/', serveFrontend('index.html'));
app.get('/index.html', serveFrontend('index.html'));
app.get('/app.js', serveFrontend('app.js'));
app.get('/style.css', serveFrontend('style.css'));
app.all('/api/*', (req, res) => res.status(404).json({ error: 'পাওয়া যায়নি' }));
app.get('*', serveFrontend('index.html'));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'সার্ভারে সমস্যা হয়েছে, পরে আবার চেষ্টা করুন' });
});

// ---------------- Start ----------------
initDb().then(() => {
  app.listen(PORT, () => console.log('DK Digital Agency v2 চলছে — port ' + PORT));
}).catch((err) => {
  console.error('Database init failed:', err.message);
  process.exit(1);
});

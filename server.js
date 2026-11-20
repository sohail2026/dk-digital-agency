// ============================================================
// DK Digital Agency — Facebook services wallet app
// Owner: Tahsan Ahmad Sohel | WhatsApp: 01833990497
// Stack: Node.js + Express + SQLite (node:sqlite, no native deps)
// ============================================================
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'app.db');
const ADMIN_PHONE = '01833990497';
const DEFAULT_ADMIN_PIN = '1234';
const SESSION_DAYS = 7;

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

// ---------------- Database ----------------
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  pin_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'customer',
  balance REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS deposits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  method TEXT NOT NULL,
  amount REAL NOT NULL,
  trxid TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at TEXT
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  service_id INTEGER NOT NULL,
  service_name TEXT NOT NULL,
  description TEXT NOT NULL,
  price REAL,
  status TEXT NOT NULL DEFAULT 'awaiting_price',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,
  amount REAL NOT NULL,
  description TEXT NOT NULL,
  ref_type TEXT,
  ref_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

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
function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}
function publicUser(u) {
  return { id: u.id, name: u.name, phone: u.phone, role: u.role, balance: u.balance };
}

// Seed admin account + default payment number (first run only)
(function seed() {
  const admin = db.prepare('SELECT id FROM users WHERE phone = ?').get(ADMIN_PHONE);
  if (!admin) {
    db.prepare('INSERT INTO users (name, phone, pin_hash, role) VALUES (?,?,?,?)')
      .run('Tahsan Ahmad Sohel', ADMIN_PHONE, hashPin(DEFAULT_ADMIN_PIN), 'admin');
    console.log('Seeded admin account:', ADMIN_PHONE, '/ PIN', DEFAULT_ADMIN_PIN);
  }
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('payment_number', ?)")
    .run(ADMIN_PHONE);
  // Clean expired sessions
  db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
})();

// Simple brute-force guard on login: 5 failed tries -> 15 min lock per phone
const loginLocks = new Map(); // phone -> { fails, lockedUntil }
function isLocked(phone) {
  const e = loginLocks.get(phone);
  return e && e.lockedUntil && Date.now() < e.lockedUntil;
}
function noteFailedLogin(phone) {
  const e = loginLocks.get(phone) || { fails: 0, lockedUntil: 0 };
  e.fails += 1;
  if (e.fails >= 5) { e.lockedUntil = Date.now() + 15 * 60 * 1000; e.fails = 0; }
  loginLocks.set(phone, e);
}

// ---------------- App ----------------
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '100kb' }));

function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const exp = new Date(Date.now() + SESSION_DAYS * 24 * 3600 * 1000).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)').run(token, userId, exp);
  res.cookie('session', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_DAYS * 24 * 3600 * 1000,
  });
}

function auth(req, res, next) {
  const token = parseCookies(req).session;
  if (!token) return res.status(401).json({ error: 'লগইন করুন' });
  const row = db.prepare(
    `SELECT u.id, u.name, u.phone, u.role, u.balance, s.expires_at
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`
  ).get(token);
  if (!row || new Date(row.expires_at) < new Date()) {
    if (row) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return res.status(401).json({ error: 'সেশন শেষ হয়ে গেছে, আবার লগইন করুন' });
  }
  req.user = { id: row.id, name: row.name, phone: row.phone, role: row.role, balance: row.balance };
  next();
}
function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'শুধু অ্যাডমিনের জন্য' });
  next();
}

// ---------------- Public API ----------------
app.get('/api/health', (req, res) => res.json({ ok: true }));
app.get('/api/services', (req, res) => res.json(SERVICES));

app.post('/api/register', (req, res) => {
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  const phone = typeof req.body.phone === 'string' ? req.body.phone.trim() : '';
  const pin = req.body.pin;
  if (!name || name.length > 60) return res.status(400).json({ error: 'সঠিক নাম দিন' });
  if (!validPhone(phone)) return res.status(400).json({ error: 'সঠিক মোবাইল নম্বর দিন (01XXXXXXXXX)' });
  if (!validPin(pin)) return res.status(400).json({ error: '৪ সংখ্যার PIN দিন' });
  const exists = db.prepare('SELECT id FROM users WHERE phone = ?').get(phone);
  if (exists) return res.status(409).json({ error: 'এই নম্বরে ইতিমধ্যে অ্যাকাউন্ট আছে, লগইন করুন' });
  const r = db.prepare('INSERT INTO users (name, phone, pin_hash) VALUES (?,?,?)')
    .run(name, phone, hashPin(pin));
  createSession(res, r.lastInsertRowid);
  res.json({ ok: true, user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid)) });
});

app.post('/api/login', (req, res) => {
  const phone = typeof req.body.phone === 'string' ? req.body.phone.trim() : '';
  const pin = req.body.pin;
  if (!validPhone(phone) || !validPin(pin)) return res.status(400).json({ error: 'সঠিক নম্বর ও ৪ সংখ্যার PIN দিন' });
  if (isLocked(phone)) return res.status(429).json({ error: 'অনেকবার ভুল PIN দিয়েছেন, ১৫ মিনিট পর আবার চেষ্টা করুন' });
  const user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
  if (!user || !verifyPin(pin, user.pin_hash)) {
    noteFailedLogin(phone);
    return res.status(401).json({ error: 'নম্বর বা PIN ভুল' });
  }
  loginLocks.delete(phone);
  createSession(res, user.id);
  res.json({ ok: true, user: publicUser(user) });
});

app.post('/api/logout', (req, res) => {
  const token = parseCookies(req).session;
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.clearCookie('session', { path: '/' });
  res.json({ ok: true });
});

// ---------------- Customer API ----------------
app.get('/api/me', auth, (req, res) => {
  const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ user: publicUser(fresh), payment_number: getSetting('payment_number') });
});

app.get('/api/wallet', auth, (req, res) => {
  const user = db.prepare('SELECT balance FROM users WHERE id = ?').get(req.user.id);
  const txs = db.prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT 100').all(req.user.id);
  const deps = db.prepare('SELECT * FROM deposits WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(req.user.id);
  res.json({ balance: user.balance, transactions: txs, deposits: deps });
});

app.post('/api/deposits', auth, (req, res) => {
  const method = req.body.method;
  const amount = req.body.amount;
  const trxid = typeof req.body.trxid === 'string' ? req.body.trxid.trim().toUpperCase() : '';
  if (method !== 'bKash' && method !== 'Nagad') return res.status(400).json({ error: 'bKash বা Nagad বেছে নিন' });
  if (!validAmount(amount)) return res.status(400).json({ error: 'সঠিক টাকার পরিমাণ দিন (১ – ১০,০০,০০০)' });
  if (!/^[A-Z0-9]{6,20}$/.test(trxid)) return res.status(400).json({ error: 'সঠিক TrxID দিন' });
  try {
    const r = db.prepare('INSERT INTO deposits (user_id, method, amount, trxid) VALUES (?,?,?,?)')
      .run(req.user.id, method, amount, trxid);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'এই TrxID ইতিমধ্যে ব্যবহার হয়েছে' });
    throw e;
  }
});

app.get('/api/orders', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC').all(req.user.id);
  res.json(rows);
});

app.post('/api/orders', auth, (req, res) => {
  const service = SERVICES.find(s => s.id === req.body.service_id);
  const description = typeof req.body.description === 'string' ? req.body.description.trim() : '';
  if (!service) return res.status(400).json({ error: 'সার্ভিস বেছে নিন' });
  if (!description || description.length > 500) return res.status(400).json({ error: 'সমস্যাটি সংক্ষেপে লিখুন (সর্বোচ্চ ৫০০ অক্ষর)' });
  const r = db.prepare('INSERT INTO orders (user_id, service_id, service_name, description) VALUES (?,?,?,?)')
    .run(req.user.id, service.id, service.name, description);
  res.json({ ok: true, id: r.lastInsertRowid });
});

app.post('/api/orders/:id/confirm', auth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ভুল অর্ডার' });
  db.exec('BEGIN IMMEDIATE');
  try {
    const order = db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(id, req.user.id);
    if (!order) { db.exec('ROLLBACK'); return res.status(404).json({ error: 'অর্ডার পাওয়া যায়নি' }); }
    if (order.status !== 'awaiting_payment') {
      db.exec('ROLLBACK');
      return res.status(409).json({ error: 'এই অর্ডারের পেমেন্ট এখন করা যাবে না' });
    }
    const user = db.prepare('SELECT balance FROM users WHERE id = ?').get(req.user.id);
    if (user.balance < order.price) {
      db.exec('ROLLBACK');
      return res.status(402).json({ error: 'ব্যালেন্স যথেষ্ট নয় — প্রথমে টাকা যোগ করুন', need: order.price - user.balance });
    }
    db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(order.price, req.user.id);
    db.prepare("UPDATE orders SET status = 'in_progress', updated_at = datetime('now') WHERE id = ?").run(id);
    db.prepare('INSERT INTO transactions (user_id, type, amount, description, ref_type, ref_id) VALUES (?,?,?,?,?,?)')
      .run(req.user.id, 'order_payment', -order.price, 'অর্ডার #' + id + ' — ' + order.service_name, 'order', id);
    db.exec('COMMIT');
    res.json({ ok: true });
  } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
});

app.post('/api/orders/:id/cancel', auth, (req, res) => {
  const id = Number(req.params.id);
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(id, req.user.id);
  if (!order) return res.status(404).json({ error: 'অর্ডার পাওয়া যায়নি' });
  if (order.status !== 'awaiting_price' && order.status !== 'awaiting_payment')
    return res.status(409).json({ error: 'এই অর্ডার এখন বাতিল করা যাবে না' });
  db.prepare("UPDATE orders SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?").run(id);
  res.json({ ok: true });
});

// ---------------- Admin API ----------------
app.get('/api/admin/overview', auth, adminOnly, (req, res) => {
  const q = (sql) => db.prepare(sql).get().c;
  res.json({
    pending_deposits: q("SELECT COUNT(*) c FROM deposits WHERE status = 'pending'"),
    awaiting_price: q("SELECT COUNT(*) c FROM orders WHERE status = 'awaiting_price'"),
    awaiting_payment: q("SELECT COUNT(*) c FROM orders WHERE status = 'awaiting_payment'"),
    in_progress: q("SELECT COUNT(*) c FROM orders WHERE status = 'in_progress'"),
    completed: q("SELECT COUNT(*) c FROM orders WHERE status = 'completed'"),
    customers: q("SELECT COUNT(*) c FROM users WHERE role = 'customer'"),
    total_wallet: db.prepare("SELECT COALESCE(SUM(balance),0) s FROM users WHERE role='customer'").get().s,
  });
});

app.get('/api/admin/deposits', auth, adminOnly, (req, res) => {
  const status = req.query.status;
  const rows = status
    ? db.prepare(`SELECT d.*, u.name, u.phone FROM deposits d JOIN users u ON u.id = d.user_id WHERE d.status = ? ORDER BY d.id DESC`).all(status)
    : db.prepare(`SELECT d.*, u.name, u.phone FROM deposits d JOIN users u ON u.id = d.user_id ORDER BY d.id DESC LIMIT 200`).all();
  res.json(rows);
});

app.post('/api/admin/deposits/:id/approve', auth, adminOnly, (req, res) => {
  const id = Number(req.params.id);
  db.exec('BEGIN IMMEDIATE');
  try {
    const dep = db.prepare('SELECT * FROM deposits WHERE id = ?').get(id);
    if (!dep) { db.exec('ROLLBACK'); return res.status(404).json({ error: 'ডিপোজিট পাওয়া যায়নি' }); }
    if (dep.status !== 'pending') { db.exec('ROLLBACK'); return res.status(409).json({ error: 'এটা আগেই সিদ্ধান্ত নেওয়া হয়েছে' }); }
    db.prepare("UPDATE deposits SET status = 'approved', decided_at = datetime('now') WHERE id = ?").run(id);
    db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(dep.amount, dep.user_id);
    db.prepare('INSERT INTO transactions (user_id, type, amount, description, ref_type, ref_id) VALUES (?,?,?,?,?,?)')
      .run(dep.user_id, 'deposit', dep.amount, dep.method + ' ডিপোজিট — TrxID ' + dep.trxid, 'deposit', id);
    db.exec('COMMIT');
    res.json({ ok: true });
  } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
});

app.post('/api/admin/deposits/:id/reject', auth, adminOnly, (req, res) => {
  const id = Number(req.params.id);
  const dep = db.prepare('SELECT * FROM deposits WHERE id = ?').get(id);
  if (!dep) return res.status(404).json({ error: 'ডিপোজিট পাওয়া যায়নি' });
  if (dep.status !== 'pending') return res.status(409).json({ error: 'এটা আগেই সিদ্ধান্ত নেওয়া হয়েছে' });
  db.prepare("UPDATE deposits SET status = 'rejected', decided_at = datetime('now') WHERE id = ?").run(id);
  res.json({ ok: true });
});

app.get('/api/admin/orders', auth, adminOnly, (req, res) => {
  const status = req.query.status;
  const rows = status
    ? db.prepare(`SELECT o.*, u.name, u.phone FROM orders o JOIN users u ON u.id = o.user_id WHERE o.status = ? ORDER BY o.id DESC`).all(status)
    : db.prepare(`SELECT o.*, u.name, u.phone FROM orders o JOIN users u ON u.id = o.user_id ORDER BY o.id DESC LIMIT 200`).all();
  res.json(rows);
});

app.post('/api/admin/orders/:id/set-price', auth, adminOnly, (req, res) => {
  const id = Number(req.params.id);
  const price = req.body.price;
  if (!validAmount(price)) return res.status(400).json({ error: 'সঠিক দাম দিন' });
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!order) return res.status(404).json({ error: 'অর্ডার পাওয়া যায়নি' });
  if (order.status !== 'awaiting_price') return res.status(409).json({ error: 'এই অর্ডারে এখন দাম বসানো যাবে না' });
  db.prepare("UPDATE orders SET price = ?, status = 'awaiting_payment', updated_at = datetime('now') WHERE id = ?").run(price, id);
  res.json({ ok: true });
});

app.post('/api/admin/orders/:id/complete', auth, adminOnly, (req, res) => {
  const id = Number(req.params.id);
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!order) return res.status(404).json({ error: 'অর্ডার পাওয়া যায়নি' });
  if (order.status !== 'in_progress') return res.status(409).json({ error: 'শুধু চলমান অর্ডার সম্পন্ন করা যায়' });
  db.prepare("UPDATE orders SET status = 'completed', updated_at = datetime('now') WHERE id = ?").run(id);
  res.json({ ok: true });
});

app.post('/api/admin/orders/:id/cancel', auth, adminOnly, (req, res) => {
  const id = Number(req.params.id);
  db.exec('BEGIN IMMEDIATE');
  try {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    if (!order) { db.exec('ROLLBACK'); return res.status(404).json({ error: 'অর্ডার পাওয়া যায়নি' }); }
    if (order.status === 'completed' || order.status === 'cancelled') {
      db.exec('ROLLBACK'); return res.status(409).json({ error: 'এই অর্ডার বাতিল করা যাবে না' });
    }
    // Paid order cancelled -> refund the customer
    if (order.status === 'in_progress' && order.price) {
      db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(order.price, order.user_id);
      db.prepare('INSERT INTO transactions (user_id, type, amount, description, ref_type, ref_id) VALUES (?,?,?,?,?,?)')
        .run(order.user_id, 'refund', order.price, 'অর্ডার #' + id + ' বাতিল — টাকা ফেরত', 'order', id);
    }
    db.prepare("UPDATE orders SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?").run(id);
    db.exec('COMMIT');
    res.json({ ok: true });
  } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
});

app.get('/api/admin/customers', auth, adminOnly, (req, res) => {
  const rows = db.prepare(
    `SELECT u.id, u.name, u.phone, u.balance, u.created_at,
      (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id) AS order_count
     FROM users u WHERE u.role = 'customer' ORDER BY u.id DESC`
  ).all();
  res.json(rows);
});

app.get('/api/admin/settings', auth, adminOnly, (req, res) => {
  res.json({ payment_number: getSetting('payment_number') });
});

app.post('/api/admin/settings', auth, adminOnly, (req, res) => {
  const n = typeof req.body.payment_number === 'string' ? req.body.payment_number.trim() : '';
  if (!validPhone(n)) return res.status(400).json({ error: 'সঠিক মোবাইল নম্বর দিন' });
  db.prepare("INSERT INTO settings (key, value) VALUES ('payment_number', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(n);
  res.json({ ok: true });
});

app.post('/api/admin/change-pin', auth, adminOnly, (req, res) => {
  const { old_pin, new_pin } = req.body;
  if (!validPin(old_pin) || !validPin(new_pin)) return res.status(400).json({ error: '৪ সংখ্যার PIN দিন' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!verifyPin(old_pin, user.pin_hash)) return res.status(401).json({ error: 'পুরনো PIN ভুল' });
  db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(hashPin(new_pin), req.user.id);
  res.json({ ok: true });
});

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

app.listen(PORT, () => console.log('DK Digital Agency চলছে — port ' + PORT));

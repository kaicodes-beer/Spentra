/**
 * SPENTRA backend: single-file Node.js + Express + SQLite API.
 *
 * Setup:
 *   npm init -y
 *   npm i express better-sqlite3 bcryptjs jsonwebtoken helmet cors express-rate-limit
 *   JWT_SECRET="a-long-random-string" node server.js
 *
 * Environment variables:
 *   JWT_SECRET      required in production (min 32 chars)
 *   PORT            default 3000
 *   DB_PATH         default ./spentra.db
 *   TZ_OFFSET_MIN   minutes ahead of UTC for budget days, default 330 (India)
 *   CORS_ORIGIN     allowed frontend origin, default same-origin only
 *   WEBHOOK_SECRET  optional, enables POST /api/webhooks/bank (HMAC-SHA256)
 *
 * Put the website's index.html in ./public to have this server host it too.
 */
'use strict';
const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// ---------- config ----------
const PORT = +process.env.PORT || 3000;
const OFF = Number.isFinite(+process.env.TZ_OFFSET_MIN) && process.env.TZ_OFFSET_MIN !== undefined ? +process.env.TZ_OFFSET_MIN : 330;
let SECRET = process.env.JWT_SECRET;
if (!SECRET || SECRET.length < 32) {
  if (process.env.NODE_ENV === 'production') { console.error('JWT_SECRET (32+ chars) is required in production.'); process.exit(1); }
  SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('Dev mode: using a temporary JWT secret. Logins reset on restart.');
}

// ---------- database ----------
const db = new Database(process.env.DB_PATH || path.join(__dirname, 'spentra.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, hash TEXT NOT NULL,
  income REAL NOT NULL, currency TEXT NOT NULL DEFAULT 'INR', start TEXT NOT NULL,
  carry INTEGER NOT NULL DEFAULT 0, warn INTEGER NOT NULL DEFAULT 1,
  last_morning TEXT, last_night TEXT, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tx(
  id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  merchant TEXT NOT NULL, amount REAL NOT NULL, type TEXT NOT NULL, category TEXT NOT NULL,
  method TEXT NOT NULL, status TEXT NOT NULL, ts INTEGER NOT NULL, ref TEXT,
  UNIQUE(user_id, ref));
CREATE INDEX IF NOT EXISTS tx_user_ts ON tx(user_id, ts);
CREATE TABLE IF NOT EXISTS rules(
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  merchant TEXT NOT NULL, category TEXT NOT NULL, PRIMARY KEY(user_id, merchant));
CREATE TABLE IF NOT EXISTS goals(
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, target REAL NOT NULL, saved REAL NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS notes(
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  msg TEXT NOT NULL, ts INTEGER NOT NULL, read INTEGER NOT NULL DEFAULT 0);
`);

// ---------- domain constants ----------
const TYPES = ['Expense', 'Income', 'Refund', 'Self transfer'];
const METHODS = ['UPI', 'Card', 'Net banking', 'Cash'];
const STATUSES = ['Completed', 'Failed'];
const CATS = ['Food & Dining', 'Groceries', 'Shopping', 'Transportation', 'Entertainment', 'Subscriptions', 'Healthcare', 'Education', 'Bills & Utilities', 'Travel', 'Random UPI Transfers', 'Other Expenses', 'Uncategorized UPI Payment'];
const ESSENTIAL = new Set(['Groceries', 'Transportation', 'Healthcare', 'Education', 'Bills & Utilities']);
const KW = {
  'Food & Dining': ['swiggy', 'zomato', 'coffee', 'cafe', 'restaurant', 'dominos', 'mcdonald', 'kfc'],
  Groceries: ['blinkit', 'zepto', 'bigbasket', 'instamart', 'dmart'],
  Shopping: ['amazon', 'flipkart', 'myntra', 'ajio'],
  Transportation: ['uber', 'ola', 'rapido', 'metro', 'irctc'],
  Entertainment: ['bookmyshow', 'pvr', 'inox'],
  Subscriptions: ['netflix', 'spotify', 'prime', 'hotstar', 'youtube'],
  Healthcare: ['pharmeasy', 'apollo', '1mg', 'hospital', 'clinic'],
  Education: ['udemy', 'coursera', 'byju', 'school'],
  'Bills & Utilities': ['electric', 'airtel', 'jio', 'broadband', 'recharge', 'bescom', 'rent'],
  Travel: ['makemytrip', 'goibibo', 'indigo', 'airbnb'],
};
const SYMBOLS = { INR: '₹', USD: '$', EUR: '€' };

// ---------- helpers ----------
class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const bad = (m) => new HttpError(400, m);
const str = (v, name, max = 100, min = 1) => {
  if (typeof v !== 'string') throw bad(`${name} is required`);
  const s = v.trim();
  if (s.length < min || s.length > max) throw bad(`${name} must be ${min}-${max} characters`);
  return s;
};
const num = (v, name, { min = 0.01, max = 1e9 } = {}) => {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) throw bad(`${name} must be a number between ${min} and ${max}`);
  return n;
};
const oneOf = (v, list, name) => { if (!list.includes(v)) throw bad(`${name} must be one of: ${list.join(', ')}`); return v; };
const email = (v) => { const e = str(v, 'email', 120).toLowerCase(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw bad('email is invalid'); return e; };
const fmt = (u, n) => (n < 0 ? '-' : '') + (SYMBOLS[u.currency] || '₹') + Math.abs(Math.round(n)).toLocaleString('en-IN');
const dn = (ts) => Math.floor((ts + OFF * 6e4) / 864e5);           // local day number
const dkey = (n) => new Date(n * 864e5).toISOString().slice(0, 10);  // YYYY-MM-DD for a day number
const todayDN = () => dn(Date.now());
const startDN = (u) => Math.floor(Date.parse(u.start + 'T00:00:00Z') / 864e5);
const sum = (a, f = (x) => x.amount) => a.reduce((s, x) => s + f(x), 0);

function categorize(userId, merchant) {
  const k = merchant.toLowerCase().trim();
  const r = db.prepare('SELECT category FROM rules WHERE user_id=? AND merchant=?').get(userId, k);
  if (r) return r.category;
  for (const c in KW) if (KW[c].some((w) => k.includes(w))) return c;
  return 'Uncategorized UPI Payment';
}
const pub = (r) => ({ id: r.id, merchant: r.merchant, amount: r.amount, type: r.type, category: r.category, method: r.method, status: r.status, ts: r.ts, ref: r.ref });
const pubUser = (u) => ({ id: u.id, name: u.name, email: u.email, income: u.income, currency: u.currency, start: u.start, carry: !!u.carry, warn: !!u.warn });
const note = (uid, msg) => db.prepare('INSERT INTO notes(user_id,msg,ts) VALUES(?,?,?)').run(uid, msg, Date.now());
const sign = (u) => jwt.sign({ sub: u.id }, SECRET, { expiresIn: '7d' });

// Budget engine: one 30-day cycle at a time, daily budget = income / 30.
function budget(u) {
  const rows = db.prepare("SELECT * FROM tx WHERE user_id=? AND status='Completed' AND type!='Self transfer'").all(u.id);
  const today = todayDN(), st = startDN(u);
  const days = Math.max(0, today - st), ci = Math.floor(days / 30);
  const cs = st + ci * 30, ce = cs + 30, dayNum = days - ci * 30 + 1, daily = u.income / 30;
  const inCycle = rows.filter((r) => { const d = dn(r.ts); return d >= cs && d < ce; });
  const exp = inCycle.filter((r) => r.type === 'Expense');
  const spent = sum(exp), other = sum(inCycle.filter((r) => r.type !== 'Expense'));
  const todaySpent = sum(exp.filter((r) => dn(r.ts) === today));
  const available = u.carry ? Math.max(0, daily * dayNum - (spent - todaySpent)) : daily;
  const byCat = {};
  exp.forEach((r) => { const k = r.category === 'Uncategorized UPI Payment' ? 'Random UPI Transfers' : r.category; byCat[k] = (byCat[k] || 0) + r.amount; });
  const history = [];
  for (let i = 0; i < ci; i++) {
    const a = st + i * 30, b = a + 30;
    history.push({ from: dkey(a), to: dkey(b - 1), spent: sum(rows.filter((r) => r.type === 'Expense' && dn(r.ts) >= a && dn(r.ts) < b)) });
  }
  return {
    currency: u.currency, monthlyIncome: u.income, otherIncome: other, totalIncome: u.income + other,
    dailyBudget: daily, cycleDay: dayNum, cycleStart: dkey(cs), cycleEnd: dkey(ce - 1), daysLeft: 30 - dayNum,
    spent, remainingMonthly: u.income + other - spent,
    savingsPercent: u.income + other ? Math.round(((u.income + other - spent) / (u.income + other)) * 100) : 0,
    todaySpent, availableToday: available, remainingToday: available - todaySpent,
    usedPercent: available > 0 ? Math.round((todaySpent / available) * 100) : todaySpent > 0 ? 100 : 0,
    carryForward: !!u.carry, categories: byCat, history, _rows: rows, _today: today,
  };
}
// Score: starts at 100; only overspend that came from non-essentials is penalised.
function dayScore(u, rows, dayNumber) {
  const e = rows.filter((r) => r.type === 'Expense' && dn(r.ts) === dayNumber);
  if (!e.length) return null;
  const daily = u.income / 30, total = sum(e), disc = sum(e.filter((r) => !ESSENTIAL.has(r.category)));
  const over = Math.max(0, total - daily), penalised = Math.min(over, disc);
  const score = Math.max(0, 100 - Math.round((penalised / daily) * 100));
  const label = score >= 90 ? 'Excellent Financial Discipline' : score >= 75 ? 'Great Financial Management' : score >= 60 ? 'Good, But Can Improve' : score >= 40 ? 'Spending Needs Attention' : 'Financial Habits Need Improvement';
  return { date: dkey(dayNumber), score, label, total, essentials: total - disc, discretionary: disc, overBudget: over, penalised };
}
function afterTx(u, t) {
  if (t.status !== 'Completed' || t.type !== 'Expense' || dn(t.ts) !== todayDN()) return;
  const b = budget(u), before = b.todaySpent - t.amount;
  note(u.id, `${fmt(u, t.amount)} spent on ${t.merchant}. Your remaining daily allowance is ${fmt(u, b.remainingToday)}.`);
  if (u.warn && b.availableToday > 0 && before < 0.8 * b.availableToday && b.todaySpent >= 0.8 * b.availableToday && b.remainingToday >= 0)
    note(u.id, 'You have used 80% of your daily budget.');
  if (b.remainingToday < 0 && before <= b.availableToday) note(u.id, `You have exceeded your daily budget by ${fmt(u, -b.remainingToday)}.`);
}
function insertTx(u, d) {
  const dup = db.prepare('SELECT 1 FROM tx WHERE user_id=? AND merchant=? AND amount=? AND type=? AND ABS(ts-?)<120000').get(u.id, d.merchant, d.amount, d.type, d.ts);
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO tx(id,user_id,merchant,amount,type,category,method,status,ts,ref) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(id, u.id, d.merchant, d.amount, d.type, d.category, d.method, d.status, d.ts, d.ref || null);
  const row = db.prepare('SELECT * FROM tx WHERE id=?').get(id);
  if (dup) note(u.id, `Possible duplicate: ${fmt(u, d.amount)} to ${d.merchant} twice within two minutes.`);
  afterTx(u, row);
  return row;
}
function parseTx(b, u, { requireAll = true } = {}) {
  const merchant = str(b.merchant, 'merchant', 60);
  const type = oneOf(b.type ?? 'Expense', TYPES, 'type');
  const ts = b.ts === undefined ? Date.now() : num(b.ts, 'ts', { min: 0, max: Date.now() + 864e5 });
  return {
    merchant, type, ts,
    amount: num(b.amount, 'amount', { max: 1e8 }),
    category: b.category ? oneOf(b.category, CATS, 'category') : categorize(u.id, merchant),
    method: oneOf(b.method ?? 'UPI', METHODS, 'method'),
    status: oneOf(b.status ?? 'Completed', STATUSES, 'status'),
    ref: b.ref ? str(b.ref, 'ref', 80) : null,
  };
}

// ---------- app ----------
const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
if (process.env.CORS_ORIGIN) app.use(cors({ origin: process.env.CORS_ORIGIN }));
app.use(express.json({ limit: '100kb', verify: (req, _res, buf) => { req.raw = buf; } }));
app.use('/api', rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false }));
const authLimit = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many attempts. Try again later.' } });

const auth = (req, _res, next) => {
  try {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!m) throw new Error();
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(jwt.verify(m[1], SECRET).sub);
    if (!u) throw new Error();
    req.user = u; next();
  } catch { next(new HttpError(401, 'Please sign in')); }
};

app.get('/api/health', (_q, r) => r.json({ ok: true }));

// ----- auth: one account only -----
app.get('/api/auth/status', (_q, r) => r.json({ accountExists: !!db.prepare('SELECT 1 FROM users LIMIT 1').get() }));
app.post('/api/auth/register', authLimit, (q, r) => {
  if (db.prepare('SELECT 1 FROM users LIMIT 1').get()) throw new HttpError(403, 'An account already exists. Spentra supports a single account.');
  const b = q.body, pw = str(b.password, 'password', 128, 8);
  const cur = oneOf(b.currency ?? 'INR', Object.keys(SYMBOLS), 'currency');
  const start = dkey(todayDN());
  const info = db.prepare('INSERT INTO users(name,email,hash,income,currency,start,created) VALUES(?,?,?,?,?,?,?)')
    .run(str(b.name, 'name', 60), email(b.email), bcrypt.hashSync(pw, 12), num(b.income, 'income', { max: 1e9 }), cur, start, Date.now());
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(info.lastInsertRowid);
  r.status(201).json({ token: sign(u), user: pubUser(u) });
});
app.post('/api/auth/login', authLimit, (q, r) => {
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(email(q.body.email));
  if (!u || !bcrypt.compareSync(String(q.body.password || ''), u.hash)) throw new HttpError(401, 'Email or password is incorrect');
  r.json({ token: sign(u), user: pubUser(u) });
});
app.post('/api/auth/change-password', auth, authLimit, (q, r) => {
  if (!bcrypt.compareSync(String(q.body.current || ''), q.user.hash)) throw new HttpError(401, 'Current password is incorrect');
  db.prepare('UPDATE users SET hash=? WHERE id=?').run(bcrypt.hashSync(str(q.body.next, 'new password', 128, 8), 12), q.user.id);
  r.json({ ok: true });
});

// ----- profile & settings -----
app.get('/api/me', auth, (q, r) => r.json(pubUser(q.user)));
app.patch('/api/me', auth, (q, r) => {
  const b = q.body, u = q.user;
  const next = {
    name: b.name !== undefined ? str(b.name, 'name', 60) : u.name,
    income: b.income !== undefined ? num(b.income, 'income', { max: 1e9 }) : u.income,
    carry: b.carry !== undefined ? (b.carry ? 1 : 0) : u.carry,
    warn: b.warn !== undefined ? (b.warn ? 1 : 0) : u.warn,
  };
  db.prepare('UPDATE users SET name=?,income=?,carry=?,warn=? WHERE id=?').run(next.name, next.income, next.carry, next.warn, u.id);
  r.json(pubUser(db.prepare('SELECT * FROM users WHERE id=?').get(u.id)));
});
// Data deletion control: removes the account and every record tied to it.
app.delete('/api/me', auth, (q, r) => {
  if (!bcrypt.compareSync(String(q.body.password || ''), q.user.hash)) throw new HttpError(401, 'Password is incorrect');
  db.prepare('DELETE FROM users WHERE id=?').run(q.user.id);
  r.json({ ok: true });
});
app.delete('/api/me/data', auth, (q, r) => {
  const id = q.user.id;
  db.transaction(() => { ['tx', 'goals', 'notes', 'rules'].forEach((t) => db.prepare(`DELETE FROM ${t} WHERE user_id=?`).run(id)); })();
  r.json({ ok: true });
});

// ----- transactions -----
app.get('/api/transactions', auth, (q, r) => {
  const lim = Math.min(Math.max(parseInt(q.query.limit) || 200, 1), 1000), off = Math.max(parseInt(q.query.offset) || 0, 0);
  const t = q.query.type;
  const rows = t
    ? db.prepare('SELECT * FROM tx WHERE user_id=? AND type=? ORDER BY ts DESC LIMIT ? OFFSET ?').all(q.user.id, oneOf(t, TYPES, 'type'), lim, off)
    : db.prepare('SELECT * FROM tx WHERE user_id=? ORDER BY ts DESC LIMIT ? OFFSET ?').all(q.user.id, lim, off);
  r.json(rows.map(pub));
});
app.post('/api/transactions', auth, (q, r) => {
  const row = insertTx(q.user, parseTx(q.body, q.user));
  r.status(201).json({ transaction: pub(row), summary: strip(budget(q.user)) });
});
app.patch('/api/transactions/:id', auth, (q, r) => {
  const row = db.prepare('SELECT * FROM tx WHERE id=? AND user_id=?').get(q.params.id, q.user.id);
  if (!row) throw new HttpError(404, 'Transaction not found');
  const category = oneOf(q.body.category, CATS, 'category');
  db.prepare('UPDATE tx SET category=? WHERE id=?').run(category, row.id);
  // Learn from the correction for future payments to the same merchant.
  db.prepare('INSERT INTO rules(user_id,merchant,category) VALUES(?,?,?) ON CONFLICT(user_id,merchant) DO UPDATE SET category=excluded.category')
    .run(q.user.id, row.merchant.toLowerCase().trim(), category);
  r.json(pub(db.prepare('SELECT * FROM tx WHERE id=?').get(row.id)));
});
app.delete('/api/transactions/:id', auth, (q, r) => {
  const info = db.prepare('DELETE FROM tx WHERE id=? AND user_id=?').run(q.params.id, q.user.id);
  if (!info.changes) throw new HttpError(404, 'Transaction not found');
  r.json({ ok: true });
});
app.get('/api/transactions.csv', auth, (q, r) => {
  const cell = (v) => { let s = String(v); if (/^[=+\-@]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; }; // blocks CSV formula injection
  const rows = db.prepare('SELECT * FROM tx WHERE user_id=? ORDER BY ts DESC').all(q.user.id);
  const lines = [['Date', 'Time', 'Merchant', 'Type', 'Category', 'Method', 'Status', 'Amount', 'Reference']].concat(
    rows.map((x) => { const d = new Date(x.ts + OFF * 6e4).toISOString(); return [d.slice(0, 10), d.slice(11, 16), x.merchant, x.type, x.category, x.method, x.status, x.amount, x.ref || '']; }));
  r.type('text/csv').attachment('spentra-transactions.csv').send(lines.map((l) => l.map(cell).join(',')).join('\n'));
});

// ----- budget, analytics, score -----
const strip = (b) => { const { _rows, _today, ...rest } = b; return rest; };
app.get('/api/summary', auth, (q, r) => r.json(strip(budget(q.user))));
app.get('/api/analytics', auth, (q, r) => {
  const b = budget(q.user), rows = b._rows, t = b._today;
  const daily = [], income = [];
  for (let i = 13; i >= 0; i--) {
    const d = t - i, day = rows.filter((x) => dn(x.ts) === d);
    daily.push({ date: dkey(d), spent: sum(day.filter((x) => x.type === 'Expense')), income: sum(day.filter((x) => x.type !== 'Expense')) });
  }
  const weekly = [];
  for (let i = 7; i >= 0; i--) {
    const a = t - i * 7 - 6, z = t - i * 7;
    weekly.push({ from: dkey(a), to: dkey(z), spent: sum(rows.filter((x) => x.type === 'Expense' && dn(x.ts) >= a && dn(x.ts) <= z)) });
  }
  const monthly = {};
  rows.filter((x) => x.type === 'Expense').forEach((x) => { const k = new Date(x.ts + OFF * 6e4).toISOString().slice(0, 7); monthly[k] = (monthly[k] || 0) + x.amount; });
  const heat = {};
  rows.filter((x) => x.type === 'Expense').forEach((x) => { const k = dkey(dn(x.ts)); heat[k] = (heat[k] || 0) + x.amount; });
  let streak = 0;
  for (let d = t; d >= startDN(q.user); d--) { if (rows.some((x) => x.type === 'Expense' && dn(x.ts) === d)) break; streak++; }
  r.json({ dailyBudget: b.dailyBudget, categories: b.categories, daily, weekly, monthly, heatmap: heat, noSpendStreak: streak });
});
app.get('/api/score', auth, (q, r) => {
  const b = budget(q.user), t = b._today, hist = [];
  for (let i = 0; i < 7; i++) hist.push(dayScore(q.user, b._rows, t - i) || { date: dkey(t - i), score: null });
  const scored = hist.filter((h) => h.score !== null);
  r.json({
    today: hist[0], history: hist,
    weeklyAverage: scored.length ? Math.round(sum(scored, (h) => h.score) / scored.length) : null,
    note: 'Starts at 100. Only overspending on non-essentials lowers the score. Groceries, transport, healthcare, education and bills are never penalised.',
  });
});

// ----- savings goals -----
const goalOf = (q) => { const g = db.prepare('SELECT * FROM goals WHERE id=? AND user_id=?').get(+q.params.id, q.user.id); if (!g) throw new HttpError(404, 'Goal not found'); return g; };
app.get('/api/goals', auth, (q, r) => r.json(db.prepare('SELECT id,name,target,saved FROM goals WHERE user_id=? ORDER BY id').all(q.user.id)));
app.post('/api/goals', auth, (q, r) => {
  const info = db.prepare('INSERT INTO goals(user_id,name,target) VALUES(?,?,?)').run(q.user.id, str(q.body.name, 'name', 40), num(q.body.target, 'target', { max: 1e9 }));
  r.status(201).json(db.prepare('SELECT id,name,target,saved FROM goals WHERE id=?').get(info.lastInsertRowid));
});
app.post('/api/goals/:id/funds', auth, (q, r) => {
  const g = goalOf(q);
  db.prepare('UPDATE goals SET saved=saved+? WHERE id=?').run(num(q.body.amount, 'amount', { max: 1e9 }), g.id);
  r.json(db.prepare('SELECT id,name,target,saved FROM goals WHERE id=?').get(g.id));
});
app.delete('/api/goals/:id', auth, (q, r) => { db.prepare('DELETE FROM goals WHERE id=?').run(goalOf(q).id); r.json({ ok: true }); });

// ----- notifications -----
app.get('/api/notifications', auth, (q, r) =>
  r.json(db.prepare('SELECT id,msg,ts,read FROM notes WHERE user_id=? ORDER BY ts DESC LIMIT 50').all(q.user.id)));
app.post('/api/notifications/read', auth, (q, r) => { db.prepare('UPDATE notes SET read=1 WHERE user_id=?').run(q.user.id); r.json({ ok: true }); });

// ----- bank-data webhook (placeholder) -----
// Not tied to any real provider. When you sign up with an Account Aggregator or
// payments data provider, map its payload to the fields below and verify its
// own signature scheme. Accepts: { merchant, amount, type, method, timestamp, reference }
if (process.env.WEBHOOK_SECRET) {
  app.post('/api/webhooks/bank', (q, r) => {
    const sig = Buffer.from(String(q.headers['x-signature'] || ''), 'hex');
    const exp = crypto.createHmac('sha256', process.env.WEBHOOK_SECRET).update(q.raw || '').digest();
    if (sig.length !== exp.length || !crypto.timingSafeEqual(sig, exp)) throw new HttpError(401, 'Bad signature');
    const u = db.prepare('SELECT * FROM users LIMIT 1').get();
    if (!u) throw new HttpError(404, 'No account');
    const d = parseTx({ ...q.body, ts: q.body.timestamp, ref: q.body.reference }, u);
    if (d.ref && db.prepare('SELECT 1 FROM tx WHERE user_id=? AND ref=?').get(u.id, d.ref)) return r.json({ ok: true, duplicate: true });
    r.status(201).json({ ok: true, id: insertTx(u, d).id });
  });
}

// ----- static frontend (optional) -----
const pubDir = path.join(__dirname, 'public');
if (fs.existsSync(pubDir)) app.use(express.static(pubDir));
app.use('/api', (_q, _r, next) => next(new HttpError(404, 'Not found')));

app.use((e, _q, r, _n) => {
  if (e instanceof HttpError) return r.status(e.code).json({ error: e.message });
  if (e.type === 'entity.parse.failed') return r.status(400).json({ error: 'Invalid JSON' });
  if (String(e.code).startsWith('SQLITE_CONSTRAINT')) return r.status(409).json({ error: 'Conflict: that record already exists' });
  console.error(e);
  r.status(500).json({ error: 'Something went wrong' });
});

// ----- scheduled jobs: morning message at/after local midnight, night report from 9 PM -----
function tick() {
  const key = dkey(todayDN()), hour = new Date(Date.now() + OFF * 6e4).getUTCHours();
  for (const u of db.prepare('SELECT * FROM users').all()) {
    if (u.last_morning !== key) {
      note(u.id, `Good morning! Your daily budget is ${fmt(u, u.income / 30)}. Spend wisely, save consistently, and stay in control.`);
      db.prepare('UPDATE users SET last_morning=? WHERE id=?').run(key, u.id);
    }
    if (hour >= 21 && u.last_night !== key) {
      const b = budget(u), s = dayScore(u, b._rows, b._today);
      note(u.id, s
        ? `Good night! Daily budget: ${fmt(u, b.dailyBudget)}. Spent: ${fmt(u, b.todaySpent)}. ${b.todaySpent > b.dailyBudget ? 'Over by ' + fmt(u, b.todaySpent - b.dailyBudget) + '.' : 'You stayed within budget.'} Financial score today: ${s.score}/100.`
        : 'Your daily financial report is ready. No spending was recorded today.');
      db.prepare('UPDATE users SET last_night=? WHERE id=?').run(key, u.id);
    }
  }
}
setInterval(() => { try { tick(); } catch (e) { console.error('job failed', e); } }, 60_000).unref();
tick();

app.listen(PORT, () => console.log(`Spentra API listening on http://localhost:${PORT}`));

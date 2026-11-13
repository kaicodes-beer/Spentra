/**
 * SPENTRA backend (MySQL edition): single-file Node.js + Express + MySQL API.
 * Works with schema.sql. Run that first:  mysql -u root -p < schema.sql
 *
 * Setup:
 *   npm init -y
 *   npm i express mysql2 bcryptjs jsonwebtoken helmet cors express-rate-limit
 *   JWT_SECRET="a-long-random-string-of-32+chars" DB_PASSWORD="your-db-password" node server-mysql.js
 *
 * Environment variables:
 *   JWT_SECRET      required in production (min 32 chars)
 *   DB_HOST         default localhost
 *   DB_PORT         default 3306
 *   DB_USER         default spentra_app
 *   DB_PASSWORD     the password you set for spentra_app in schema.sql
 *   DB_NAME         default spentra
 *   PORT            default 3000
 *   TZ_OFFSET_MIN   minutes ahead of UTC for budget days, default 330 (India)
 *   CORS_ORIGIN     allowed frontend origin, default same-origin only
 *   WEBHOOK_SECRET  optional, enables POST /api/webhooks/bank (HMAC-SHA256)
 *
 * Put the website's index.html in ./public to have this server host it too.
 */
'use strict';
const express = require('express');
const mysql = require('mysql2/promise');
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
const OFF = process.env.TZ_OFFSET_MIN !== undefined && Number.isFinite(+process.env.TZ_OFFSET_MIN) ? +process.env.TZ_OFFSET_MIN : 330;
let SECRET = process.env.JWT_SECRET;
if (!SECRET || SECRET.length < 32) {
  if (process.env.NODE_ENV === 'production') { console.error('JWT_SECRET (32+ chars) is required in production.'); process.exit(1); }
  SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('Dev mode: using a temporary JWT secret. Logins reset on restart.');
}

// ---------- database ----------
// timezone 'Z': DATETIME values are read and written as UTC.
// decimalNumbers: DECIMAL columns come back as numbers, not strings.
// dateStrings ['DATE']: DATE columns come back as 'YYYY-MM-DD' strings.
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: +process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'spentra_app',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'spentra',
  waitForConnections: true, connectionLimit: 10,
  timezone: 'Z', decimalNumbers: true, dateStrings: ['DATE'], charset: 'utf8mb4',
});
const all = async (sql, p = []) => (await pool.query(sql, p))[0];
const one = async (sql, p = []) => (await all(sql, p))[0];
const run = async (sql, p = []) => (await pool.query(sql, p))[0]; // ResultSetHeader: insertId, affectedRows

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
  return Math.round(n * 100) / 100;
};
const oneOf = (v, list, name) => { if (!list.includes(v)) throw bad(`${name} must be one of: ${list.join(', ')}`); return v; };
const email = (v) => { const e = str(v, 'email', 120).toLowerCase(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw bad('email is invalid'); return e; };
const fmt = (u, n) => (n < 0 ? '-' : '') + (SYMBOLS[u.currency] || '₹') + Math.abs(Math.round(n)).toLocaleString('en-IN');
const dn = (ts) => Math.floor((ts + OFF * 6e4) / 864e5);           // local day number
const dkey = (n) => new Date(n * 864e5).toISOString().slice(0, 10);  // YYYY-MM-DD for a day number
const todayDN = () => dn(Date.now());
const startDN = (u) => Math.floor(Date.parse(u.start + 'T00:00:00Z') / 864e5);
const sum = (a, f = (x) => x.amount) => a.reduce((s, x) => s + f(x), 0);
const ah = (fn) => (q, r, n) => Promise.resolve(fn(q, r, n)).catch(n); // forwards async errors to Express

// Row mappers keep the business logic independent of column names.
const mapUser = (r) => r && ({ id: r.id, name: r.name, email: r.email, hash: r.password_hash, income: r.monthly_income, currency: r.currency, start: r.cycle_start, carry: r.carry_forward, warn: r.warn_80, last_morning: r.last_morning, last_night: r.last_night });
const mapTx = (r) => r && ({ id: r.id, user_id: r.user_id, merchant: r.merchant, amount: r.amount, type: r.type, category: r.category, method: r.method, status: r.status, ts: new Date(r.occurred_at).getTime(), ref: r.reference });
const pub = (r) => ({ id: r.id, merchant: r.merchant, amount: r.amount, type: r.type, category: r.category, method: r.method, status: r.status, ts: r.ts, ref: r.ref });
const pubUser = (u) => ({ id: u.id, name: u.name, email: u.email, income: u.income, currency: u.currency, start: u.start, carry: !!u.carry, warn: !!u.warn });
const getUser = async (id) => mapUser(await one('SELECT * FROM users WHERE id=?', [id]));
const getTx = async (id) => mapTx(await one('SELECT * FROM transactions WHERE id=?', [id]));
const GOAL_COLS = 'id, name, target_amount AS target, saved_amount AS saved';
const note = (uid, msg) => run('INSERT INTO notifications(user_id,message) VALUES(?,?)', [uid, msg.slice(0, 255)]);
const sign = (u) => jwt.sign({ sub: u.id }, SECRET, { expiresIn: '7d' });

async function categorize(userId, merchant) {
  const k = merchant.toLowerCase().trim();
  const r = await one('SELECT category FROM category_rules WHERE user_id=? AND merchant=?', [userId, k]);
  if (r) return r.category;
  for (const c in KW) if (KW[c].some((w) => k.includes(w))) return c;
  return 'Uncategorized UPI Payment';
}

// Budget engine: one 30-day cycle at a time, daily budget = income / 30.
async function budget(u) {
  const rows = (await all("SELECT * FROM transactions WHERE user_id=? AND status='Completed' AND type<>'Self transfer'", [u.id])).map(mapTx);
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
const strip = (b) => { const { _rows, _today, ...rest } = b; return rest; };

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
async function afterTx(u, t) {
  if (t.status !== 'Completed' || t.type !== 'Expense' || dn(t.ts) !== todayDN()) return;
  const b = await budget(u), before = b.todaySpent - t.amount;
  await note(u.id, `${fmt(u, t.amount)} spent on ${t.merchant}. Your remaining daily allowance is ${fmt(u, b.remainingToday)}.`);
  if (u.warn && b.availableToday > 0 && before < 0.8 * b.availableToday && b.todaySpent >= 0.8 * b.availableToday && b.remainingToday >= 0)
    await note(u.id, 'You have used 80% of your daily budget.');
  if (b.remainingToday < 0 && before <= b.availableToday) await note(u.id, `You have exceeded your daily budget by ${fmt(u, -b.remainingToday)}.`);
}
async function insertTx(u, d) {
  const dup = await one('SELECT 1 AS x FROM transactions WHERE user_id=? AND merchant=? AND amount=? AND type=? AND occurred_at BETWEEN ? AND ?',
    [u.id, d.merchant, d.amount, d.type, new Date(d.ts - 120000), new Date(d.ts + 120000)]);
  const id = crypto.randomUUID();
  await run('INSERT INTO transactions(id,user_id,merchant,amount,type,category,method,status,occurred_at,reference) VALUES(?,?,?,?,?,?,?,?,?,?)',
    [id, u.id, d.merchant, d.amount, d.type, d.category, d.method, d.status, new Date(d.ts), d.ref || null]);
  const row = await getTx(id);
  if (dup) await note(u.id, `Possible duplicate: ${fmt(u, d.amount)} to ${d.merchant} twice within two minutes.`);
  await afterTx(u, row);
  return row;
}
async function parseTx(b, u) {
  const merchant = str(b.merchant, 'merchant', 60);
  return {
    merchant,
    type: oneOf(b.type ?? 'Expense', TYPES, 'type'),
    ts: b.ts === undefined ? Date.now() : Math.floor(num(b.ts, 'ts', { min: 0, max: Date.now() + 864e5 })),
    amount: num(b.amount, 'amount', { max: 1e8 }),
    category: b.category ? oneOf(b.category, CATS, 'category') : await categorize(u.id, merchant),
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

const auth = async (req, _res, next) => {
  try {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!m) throw new Error();
    const u = await getUser(jwt.verify(m[1], SECRET).sub);
    if (!u) throw new Error();
    req.user = u; next();
  } catch { next(new HttpError(401, 'Please sign in')); }
};

app.get('/api/health', ah(async (_q, r) => { await run('SELECT 1'); r.json({ ok: true }); }));

// ----- auth: one account only -----
app.get('/api/auth/status', ah(async (_q, r) => r.json({ accountExists: !!(await one('SELECT 1 AS x FROM users LIMIT 1')) })));
app.post('/api/auth/register', authLimit, ah(async (q, r) => {
  if (await one('SELECT 1 AS x FROM users LIMIT 1')) throw new HttpError(403, 'An account already exists. Spentra supports a single account.');
  const b = q.body, pw = str(b.password, 'password', 128, 8);
  const cur = oneOf(b.currency ?? 'INR', Object.keys(SYMBOLS), 'currency');
  const info = await run('INSERT INTO users(name,email,password_hash,monthly_income,currency,cycle_start) VALUES(?,?,?,?,?,?)',
    [str(b.name, 'name', 60), email(b.email), bcrypt.hashSync(pw, 12), num(b.income, 'income', { max: 1e9 }), cur, dkey(todayDN())]);
  const u = await getUser(info.insertId);
  r.status(201).json({ token: sign(u), user: pubUser(u) });
}));
app.post('/api/auth/login', authLimit, ah(async (q, r) => {
  const u = mapUser(await one('SELECT * FROM users WHERE email=?', [email(q.body.email)]));
  if (!u || !bcrypt.compareSync(String(q.body.password || ''), u.hash)) throw new HttpError(401, 'Email or password is incorrect');
  r.json({ token: sign(u), user: pubUser(u) });
}));
app.post('/api/auth/change-password', auth, authLimit, ah(async (q, r) => {
  if (!bcrypt.compareSync(String(q.body.current || ''), q.user.hash)) throw new HttpError(401, 'Current password is incorrect');
  await run('UPDATE users SET password_hash=? WHERE id=?', [bcrypt.hashSync(str(q.body.next, 'new password', 128, 8), 12), q.user.id]);
  r.json({ ok: true });
}));

// ----- profile & settings -----
app.get('/api/me', auth, (q, r) => r.json(pubUser(q.user)));
app.patch('/api/me', auth, ah(async (q, r) => {
  const b = q.body, u = q.user;
  await run('UPDATE users SET name=?, monthly_income=?, carry_forward=?, warn_80=? WHERE id=?', [
    b.name !== undefined ? str(b.name, 'name', 60) : u.name,
    b.income !== undefined ? num(b.income, 'income', { max: 1e9 }) : u.income,
    b.carry !== undefined ? (b.carry ? 1 : 0) : u.carry,
    b.warn !== undefined ? (b.warn ? 1 : 0) : u.warn,
    u.id]);
  r.json(pubUser(await getUser(u.id)));
}));
// Data deletion controls: remove the account (cascades to everything) or just the records.
app.delete('/api/me', auth, ah(async (q, r) => {
  if (!bcrypt.compareSync(String(q.body.password || ''), q.user.hash)) throw new HttpError(401, 'Password is incorrect');
  await run('DELETE FROM users WHERE id=?', [q.user.id]);
  r.json({ ok: true });
}));
app.delete('/api/me/data', auth, ah(async (q, r) => {
  const c = await pool.getConnection();
  try {
    await c.beginTransaction();
    for (const t of ['transactions', 'savings_goals', 'notifications', 'category_rules']) await c.query(`DELETE FROM ${t} WHERE user_id=?`, [q.user.id]);
    await c.commit();
  } catch (e) { await c.rollback(); throw e; } finally { c.release(); }
  r.json({ ok: true });
}));

// ----- transactions -----
app.get('/api/transactions', auth, ah(async (q, r) => {
  const lim = Math.min(Math.max(parseInt(q.query.limit) || 200, 1), 1000), off = Math.max(parseInt(q.query.offset) || 0, 0);
  const t = q.query.type;
  const rows = t
    ? await all('SELECT * FROM transactions WHERE user_id=? AND type=? ORDER BY occurred_at DESC LIMIT ? OFFSET ?', [q.user.id, oneOf(t, TYPES, 'type'), lim, off])
    : await all('SELECT * FROM transactions WHERE user_id=? ORDER BY occurred_at DESC LIMIT ? OFFSET ?', [q.user.id, lim, off]);
  r.json(rows.map((x) => pub(mapTx(x))));
}));
app.post('/api/transactions', auth, ah(async (q, r) => {
  const row = await insertTx(q.user, await parseTx(q.body, q.user));
  r.status(201).json({ transaction: pub(row), summary: strip(await budget(q.user)) });
}));
app.patch('/api/transactions/:id', auth, ah(async (q, r) => {
  const row = mapTx(await one('SELECT * FROM transactions WHERE id=? AND user_id=?', [q.params.id, q.user.id]));
  if (!row) throw new HttpError(404, 'Transaction not found');
  const category = oneOf(q.body.category, CATS, 'category');
  await run('UPDATE transactions SET category=? WHERE id=?', [category, row.id]);
  // Learn from the correction for future payments to the same merchant.
  await run('INSERT INTO category_rules(user_id,merchant,category) VALUES(?,?,?) ON DUPLICATE KEY UPDATE category=VALUES(category)',
    [q.user.id, row.merchant.toLowerCase().trim(), category]);
  r.json(pub(await getTx(row.id)));
}));
app.delete('/api/transactions/:id', auth, ah(async (q, r) => {
  const info = await run('DELETE FROM transactions WHERE id=? AND user_id=?', [q.params.id, q.user.id]);
  if (!info.affectedRows) throw new HttpError(404, 'Transaction not found');
  r.json({ ok: true });
}));
app.get('/api/transactions.csv', auth, ah(async (q, r) => {
  const cell = (v) => { let s = String(v); if (/^[=+\-@]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; }; // blocks CSV formula injection
  const rows = (await all('SELECT * FROM transactions WHERE user_id=? ORDER BY occurred_at DESC', [q.user.id])).map(mapTx);
  const lines = [['Date', 'Time', 'Merchant', 'Type', 'Category', 'Method', 'Status', 'Amount', 'Reference']].concat(
    rows.map((x) => { const d = new Date(x.ts + OFF * 6e4).toISOString(); return [d.slice(0, 10), d.slice(11, 16), x.merchant, x.type, x.category, x.method, x.status, x.amount, x.ref || '']; }));
  r.type('text/csv').attachment('spentra-transactions.csv').send(lines.map((l) => l.map(cell).join(',')).join('\n'));
}));

// ----- budget, analytics, score -----
app.get('/api/summary', auth, ah(async (q, r) => r.json(strip(await budget(q.user)))));
app.get('/api/analytics', auth, ah(async (q, r) => {
  const b = await budget(q.user), rows = b._rows, t = b._today;
  const daily = [];
  for (let i = 13; i >= 0; i--) {
    const d = t - i, day = rows.filter((x) => dn(x.ts) === d);
    daily.push({ date: dkey(d), spent: sum(day.filter((x) => x.type === 'Expense')), income: sum(day.filter((x) => x.type !== 'Expense')) });
  }
  const weekly = [];
  for (let i = 7; i >= 0; i--) {
    const a = t - i * 7 - 6, z = t - i * 7;
    weekly.push({ from: dkey(a), to: dkey(z), spent: sum(rows.filter((x) => x.type === 'Expense' && dn(x.ts) >= a && dn(x.ts) <= z)) });
  }
  const monthly = {}, heat = {};
  rows.filter((x) => x.type === 'Expense').forEach((x) => {
    const k = new Date(x.ts + OFF * 6e4).toISOString().slice(0, 7); monthly[k] = (monthly[k] || 0) + x.amount;
    const d = dkey(dn(x.ts)); heat[d] = (heat[d] || 0) + x.amount;
  });
  let streak = 0;
  for (let d = t; d >= startDN(q.user); d--) { if (rows.some((x) => x.type === 'Expense' && dn(x.ts) === d)) break; streak++; }
  r.json({ dailyBudget: b.dailyBudget, categories: b.categories, daily, weekly, monthly, heatmap: heat, noSpendStreak: streak });
}));
app.get('/api/score', auth, ah(async (q, r) => {
  const b = await budget(q.user), t = b._today, hist = [];
  for (let i = 0; i < 7; i++) hist.push(dayScore(q.user, b._rows, t - i) || { date: dkey(t - i), score: null });
  const scored = hist.filter((h) => h.score !== null);
  r.json({
    today: hist[0], history: hist,
    weeklyAverage: scored.length ? Math.round(sum(scored, (h) => h.score) / scored.length) : null,
    note: 'Starts at 100. Only overspending on non-essentials lowers the score. Groceries, transport, healthcare, education and bills are never penalised.',
  });
}));

// ----- savings goals -----
const goalOf = async (q) => { const g = await one('SELECT * FROM savings_goals WHERE id=? AND user_id=?', [+q.params.id, q.user.id]); if (!g) throw new HttpError(404, 'Goal not found'); return g; };
app.get('/api/goals', auth, ah(async (q, r) => r.json(await all(`SELECT ${GOAL_COLS} FROM savings_goals WHERE user_id=? ORDER BY id`, [q.user.id]))));
app.post('/api/goals', auth, ah(async (q, r) => {
  const info = await run('INSERT INTO savings_goals(user_id,name,target_amount) VALUES(?,?,?)', [q.user.id, str(q.body.name, 'name', 40), num(q.body.target, 'target', { max: 1e9 })]);
  r.status(201).json(await one(`SELECT ${GOAL_COLS} FROM savings_goals WHERE id=?`, [info.insertId]));
}));
app.post('/api/goals/:id/funds', auth, ah(async (q, r) => {
  const g = await goalOf(q);
  await run('UPDATE savings_goals SET saved_amount=saved_amount+? WHERE id=?', [num(q.body.amount, 'amount', { max: 1e9 }), g.id]);
  r.json(await one(`SELECT ${GOAL_COLS} FROM savings_goals WHERE id=?`, [g.id]));
}));
app.delete('/api/goals/:id', auth, ah(async (q, r) => { await run('DELETE FROM savings_goals WHERE id=?', [(await goalOf(q)).id]); r.json({ ok: true }); }));

// ----- notifications -----
app.get('/api/notifications', auth, ah(async (q, r) => {
  const rows = await all('SELECT id, message, is_read, created_at FROM notifications WHERE user_id=? ORDER BY created_at DESC, id DESC LIMIT 50', [q.user.id]);
  r.json(rows.map((n) => ({ id: n.id, msg: n.message, ts: new Date(n.created_at).getTime(), read: n.is_read })));
}));
app.post('/api/notifications/read', auth, ah(async (q, r) => { await run('UPDATE notifications SET is_read=1 WHERE user_id=?', [q.user.id]); r.json({ ok: true }); }));

// ----- bank-data webhook (placeholder) -----
// Not tied to any real provider. When you sign up with an Account Aggregator or
// payments data provider, map its payload to the fields below and verify its
// own signature scheme. Accepts: { merchant, amount, type, method, timestamp, reference }
if (process.env.WEBHOOK_SECRET) {
  app.post('/api/webhooks/bank', ah(async (q, r) => {
    const sig = Buffer.from(String(q.headers['x-signature'] || ''), 'hex');
    const exp = crypto.createHmac('sha256', process.env.WEBHOOK_SECRET).update(q.raw || '').digest();
    if (sig.length !== exp.length || !crypto.timingSafeEqual(sig, exp)) throw new HttpError(401, 'Bad signature');
    const u = mapUser(await one('SELECT * FROM users LIMIT 1'));
    if (!u) throw new HttpError(404, 'No account');
    const d = await parseTx({ ...q.body, ts: q.body.timestamp, ref: q.body.reference }, u);
    if (d.ref && await one('SELECT 1 AS x FROM transactions WHERE user_id=? AND reference=?', [u.id, d.ref])) return r.json({ ok: true, duplicate: true });
    r.status(201).json({ ok: true, id: (await insertTx(u, d)).id });
  }));
}

// ----- static frontend (optional) -----
const pubDir = path.join(__dirname, 'public');
if (fs.existsSync(pubDir)) app.use(express.static(pubDir));
app.use('/api', (_q, _r, next) => next(new HttpError(404, 'Not found')));

app.use((e, _q, r, _n) => {
  if (e instanceof HttpError) return r.status(e.code).json({ error: e.message });
  if (e.type === 'entity.parse.failed') return r.status(400).json({ error: 'Invalid JSON' });
  if (e.code === 'ER_DUP_ENTRY') return r.status(409).json({ error: 'Conflict: that record already exists' });
  console.error(e);
  r.status(500).json({ error: 'Something went wrong' });
});

// ----- scheduled jobs: morning message at/after local midnight, night report from 9 PM -----
async function tick() {
  const key = dkey(todayDN()), hour = new Date(Date.now() + OFF * 6e4).getUTCHours();
  for (const u of (await all('SELECT * FROM users')).map(mapUser)) {
    if (u.last_morning !== key) {
      await note(u.id, `Good morning! Your daily budget is ${fmt(u, u.income / 30)}. Spend wisely, save consistently, and stay in control.`);
      await run('UPDATE users SET last_morning=? WHERE id=?', [key, u.id]);
    }
    if (hour >= 21 && u.last_night !== key) {
      const b = await budget(u), s = dayScore(u, b._rows, b._today);
      await note(u.id, s
        ? `Good night! Daily budget: ${fmt(u, b.dailyBudget)}. Spent: ${fmt(u, b.todaySpent)}. ${b.todaySpent > b.dailyBudget ? 'Over by ' + fmt(u, b.todaySpent - b.dailyBudget) + '.' : 'You stayed within budget.'} Financial score today: ${s.score}/100.`
        : 'Your daily financial report is ready. No spending was recorded today.');
      await run('UPDATE users SET last_night=? WHERE id=?', [key, u.id]);
    }
  }
}

(async () => {
  try { await run('SELECT 1'); } catch (e) {
    console.error('Cannot connect to MySQL. Check DB_HOST, DB_USER, DB_PASSWORD, DB_NAME and that schema.sql was run.\n', e.message);
    process.exit(1);
  }
  setInterval(() => tick().catch((e) => console.error('job failed', e)), 60_000).unref();
  tick().catch((e) => console.error('job failed', e));
  app.listen(PORT, () => console.log(`Spentra API (MySQL) listening on http://localhost:${PORT}`));
})();

'use strict';
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const file = process.env.DATABASE_FILE || path.join(__dirname, '..', 'data', 'pdf4edit.db');
fs.mkdirSync(path.dirname(file), { recursive: true });
const db = new DatabaseSync(file);

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    stripe_customer_id TEXT,
    subscription_id TEXT,
    subscription_status TEXT NOT NULL DEFAULT 'none',
    current_period_end INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS users_customer ON users(stripe_customer_id);
`);

const SESSION_DAYS = 30;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(expected, actual);
}

const q = {
  insertUser: db.prepare('INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)'),
  userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  userByCustomer: db.prepare('SELECT * FROM users WHERE stripe_customer_id = ?'),
  setCustomer: db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?'),
  setSub: db.prepare('UPDATE users SET subscription_id = ?, subscription_status = ?, current_period_end = ? WHERE id = ?'),
  insertSession: db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)'),
  sessionUser: db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?'),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
  purgeSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
};

module.exports = {
  SESSION_DAYS,
  createUser(email, password) {
    const r = q.insertUser.run(email, hashPassword(password), Date.now());
    return q.userById.get(Number(r.lastInsertRowid));
  },
  findUserByEmail: (email) => q.userByEmail.get(email),
  findUserById: (id) => q.userById.get(id),
  findUserByCustomer: (id) => q.userByCustomer.get(id),
  verifyPassword,
  setCustomer: (userId, customerId) => q.setCustomer.run(customerId, userId),
  setSubscription: (userId, subId, status, periodEnd) => q.setSub.run(subId, status, periodEnd || null, userId),
  createSession(userId) {
    const token = crypto.randomBytes(32).toString('base64url');
    q.insertSession.run(sha(token), userId, Date.now() + SESSION_DAYS * 864e5);
    return token;
  },
  userForSession: (token) => (token ? q.sessionUser.get(sha(token), Date.now()) : undefined),
  deleteSession: (token) => token && q.deleteSession.run(sha(token)),
  purgeSessions: () => q.purgeSessions.run(Date.now()),
};

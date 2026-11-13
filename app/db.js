'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { hashPassword } = require('./security');

const dbPath = process.env.DB_PATH || path.join(__dirname, 'data', 'app.db');
if (dbPath !== ':memory:') {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
}

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA busy_timeout = 5000;');
if (dbPath !== ':memory:') {
  db.exec('PRAGMA journal_mode = WAL;');
}

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('BUYER', 'SELLER', 'ADMIN')),
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
    display_name TEXT NOT NULL,
    contact TEXT NOT NULL DEFAULT '',
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    revoked_at TEXT
  );

  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
    sort_order INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    seller_id INTEGER NOT NULL REFERENCES users(id),
    category_id INTEGER NOT NULL REFERENCES categories(id),
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    price_cents INTEGER NOT NULL CHECK (price_cents > 0 AND price_cents <= 100000000),
    condition TEXT NOT NULL CHECK (condition IN ('NEW', 'LIKE_NEW', 'GOOD', 'FAIR')),
    image_url TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN (
      'DRAFT', 'PENDING_REVIEW', 'ON_SALE', 'RESERVED', 'SOLD',
      'OFF_SHELF', 'REJECTED', 'VIOLATION_REMOVED'
    )),
    version INTEGER NOT NULL DEFAULT 1,
    review_reason TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    published_at TEXT,
    sold_at TEXT
  );

  CREATE TABLE IF NOT EXISTS reservations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL REFERENCES products(id),
    buyer_id INTEGER NOT NULL REFERENCES users(id),
    seller_id INTEGER NOT NULL REFERENCES users(id),
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN (
      'PENDING', 'CONFIRMED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'COMPLETED'
    )),
    message TEXT NOT NULL DEFAULT '',
    price_cents INTEGER,
    client_request_id TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    expires_at TEXT NOT NULL,
    confirmed_at TEXT,
    completed_at TEXT,
    closed_at TEXT,
    close_reason TEXT,
    UNIQUE (buyer_id, client_request_id)
  );

  CREATE TABLE IF NOT EXISTS moderation_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL REFERENCES products(id),
    admin_id INTEGER NOT NULL REFERENCES users(id),
    action TEXT NOT NULL CHECK (action IN ('APPROVE', 'REJECT', 'VIOLATION_REMOVE')),
    reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE IF NOT EXISTS operation_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id INTEGER REFERENCES users(id),
    actor_role TEXT,
    action_type TEXT NOT NULL,
    target_type TEXT,
    target_id INTEGER,
    before_state TEXT,
    after_state TEXT,
    reason TEXT,
    request_id TEXT,
    ip TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE INDEX IF NOT EXISTS idx_products_status ON products(status);
  CREATE INDEX IF NOT EXISTS idx_products_seller ON products(seller_id);
  CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
  CREATE INDEX IF NOT EXISTS idx_products_created ON products(created_at);
  CREATE INDEX IF NOT EXISTS idx_reservations_product ON reservations(product_id);
  CREATE INDEX IF NOT EXISTS idx_reservations_buyer ON reservations(buyer_id);
  CREATE INDEX IF NOT EXISTS idx_reservations_status ON reservations(status);
  CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
  CREATE INDEX IF NOT EXISTS idx_logs_created ON operation_logs(created_at);
  CREATE INDEX IF NOT EXISTS idx_logs_actor ON operation_logs(actor_id);

  CREATE UNIQUE INDEX IF NOT EXISTS ux_reservations_confirmed
    ON reservations(product_id) WHERE status = 'CONFIRMED';
  CREATE UNIQUE INDEX IF NOT EXISTS ux_reservations_active_buyer
    ON reservations(product_id, buyer_id) WHERE status IN ('PENDING', 'CONFIRMED');
`);

const categories = [
  ['数码电子', 10],
  ['图书教材', 20],
  ['服饰鞋包', 30],
  ['运动户外', 40],
  ['生活用品', 50],
  ['其他', 90],
];
const insertCategory = db.prepare(
  'INSERT OR IGNORE INTO categories (name, sort_order) VALUES (?, ?)',
);
for (const category of categories) {
  insertCategory.run(category[0], category[1]);
}

function seedAdmin() {
  const account = process.env.ADMIN_ACCOUNT || 'admin';
  const password = process.env.ADMIN_PASSWORD || 'Admin@12345';
  const existing = db.prepare('SELECT id, role FROM users WHERE account = ?').get(account);
  if (existing) {
    if (existing.role !== 'ADMIN') {
      console.warn(`[seed] 账号 ${account} 已存在但不是管理员，请检查 ADMIN_ACCOUNT。`);
    }
    return;
  }
  const { salt, hash } = hashPassword(password);
  db.prepare(`
    INSERT INTO users (account, password_hash, password_salt, role, status, display_name)
    VALUES (?, ?, ?, 'ADMIN', 'ACTIVE', ?)
  `).run(account, hash, salt, '平台管理员');
  console.log(`[seed] 已创建管理员账号：${account}（请在首次登录后修改默认密码）`);
}

seedAdmin();

function transaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Ignore rollback errors so the original failure is preserved.
    }
    throw error;
  }
}

module.exports = { db, dbPath, transaction };

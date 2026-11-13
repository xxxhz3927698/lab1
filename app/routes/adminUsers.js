'use strict';

const express = require('express');
const { db, transaction } = require('../db');
const { requireRole } = require('../auth');
const { writeLog, clientIp } = require('../audit');
const { nowIso } = require('../security');
const { text } = require('../validation');

const router = express.Router();
router.use(requireRole('ADMIN'));

function requestId(req) {
  return typeof req.headers['x-request-id'] === 'string'
    ? req.headers['x-request-id'].slice(0, 100)
    : null;
}

function userRow(row) {
  return {
    id: Number(row.id),
    account: row.account,
    role: row.role,
    status: row.status,
    displayName: row.display_name,
    contact: row.contact || '',
    createdAt: row.created_at,
    productCount: Number(row.product_count || 0),
  };
}

router.get('/users', (req, res) => {
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(50, Math.max(1, Number.parseInt(req.query.pageSize, 10) || 20));
  const offset = (page - 1) * pageSize;
  const q = text(req.query.q);
  const role = text(req.query.role).toUpperCase();
  const status = text(req.query.status).toUpperCase();
  const where = [];
  const params = [];
  if (q) {
    where.push('(u.account LIKE ? OR u.display_name LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }
  if (role) {
    where.push('u.role = ?');
    params.push(role);
  }
  if (status) {
    where.push('u.status = ?');
    params.push(status);
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = Number(db.prepare(
    `SELECT COUNT(*) AS count FROM users u ${whereSql}`,
  ).get(...params).count);
  const rows = db.prepare(`
    SELECT u.*,
      (SELECT COUNT(*) FROM products p WHERE p.seller_id = u.id) AS product_count
    FROM users u
    ${whereSql}
    ORDER BY u.created_at DESC, u.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, pageSize, offset);

  res.json({
    items: rows.map(userRow),
    total,
    page,
    pageSize,
    hasMore: offset + rows.length < total,
  });
});

router.post('/users/:id/disable', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '用户编号不合法' });
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!target) return res.status(404).json({ error: '用户不存在' });
    if (id === req.user.id) return res.status(400).json({ error: '不能禁用自己' });
    if (target.role === 'ADMIN') {
      const activeAdmins = Number(db.prepare(
        "SELECT COUNT(*) AS count FROM users WHERE role = 'ADMIN' AND status = 'ACTIVE'",
      ).get().count);
      if (target.status === 'ACTIVE' && activeAdmins <= 1) {
        return res.status(409).json({ error: '不能禁用最后一个可用管理员' });
      }
    }
    if (target.status === 'DISABLED') {
      return res.json({ user: userRow({ ...target, product_count: 0 }), changed: false });
    }

    transaction(() => {
      const now = nowIso();
      db.prepare("UPDATE users SET status = 'DISABLED', updated_at = ? WHERE id = ?")
        .run(now, id);
      db.prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL")
        .run(now, id);
      writeLog({
        actorId: req.user.id,
        actorRole: req.user.role,
        actionType: 'USER_DISABLE',
        targetType: 'USER',
        targetId: id,
        beforeState: { status: 'ACTIVE' },
        afterState: { status: 'DISABLED' },
        requestId: requestId(req),
        ip: clientIp(req),
      });
    });
    res.json({ user: userRow({ ...target, status: 'DISABLED', product_count: 0 }), changed: true });
  } catch (error) {
    next(error);
  }
});

router.post('/users/:id/enable', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '用户编号不合法' });
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!target) return res.status(404).json({ error: '用户不存在' });
    if (target.status === 'ACTIVE') {
      return res.json({ user: userRow({ ...target, product_count: 0 }), changed: false });
    }
    transaction(() => {
      db.prepare(`
        UPDATE users
        SET status = 'ACTIVE', failed_attempts = 0, locked_until = NULL, updated_at = ?
        WHERE id = ?
      `).run(nowIso(), id);
      writeLog({
        actorId: req.user.id,
        actorRole: req.user.role,
        actionType: 'USER_ENABLE',
        targetType: 'USER',
        targetId: id,
        beforeState: { status: 'DISABLED' },
        afterState: { status: 'ACTIVE' },
        requestId: requestId(req),
        ip: clientIp(req),
      });
    });
    res.json({ user: userRow({ ...target, status: 'ACTIVE', product_count: 0 }), changed: true });
  } catch (error) {
    next(error);
  }
});

module.exports = router;

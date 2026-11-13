'use strict';

const express = require('express');
const { db, transaction } = require('../db');
const { requireRole } = require('../auth');
const { writeLog, clientIp } = require('../audit');
const { nowIso } = require('../security');
const { PRODUCT_SELECT, getProductRow, mapProduct } = require('../productUtils');
const { text } = require('../validation');

const router = express.Router();
router.use(requireRole('ADMIN'));

function requestId(req) {
  return typeof req.headers['x-request-id'] === 'string'
    ? req.headers['x-request-id'].slice(0, 100)
    : null;
}

function parseVersion(value) {
  const version = Number(value);
  return Number.isInteger(version) && version > 0 ? version : null;
}

router.get('/review/products', (req, res) => {
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(50, Math.max(1, Number.parseInt(req.query.pageSize, 10) || 20));
  const offset = (page - 1) * pageSize;
  const q = text(req.query.q);

  const where = ["p.status = 'PENDING_REVIEW'"];
  const params = [];
  if (q) {
    where.push('(p.title LIKE ? OR u.display_name LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }
  const whereSql = where.join(' AND ');
  const total = Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM products p JOIN users u ON u.id = p.seller_id
    WHERE ${whereSql}
  `).get(...params).count);
  const rows = db.prepare(`
    ${PRODUCT_SELECT}
    WHERE ${whereSql}
    ORDER BY p.updated_at ASC, p.id ASC
    LIMIT ? OFFSET ?
  `).all(...params, pageSize, offset);

  res.json({
    items: rows.map((row) => mapProduct(row, { includePrivate: true })),
    total,
    page,
    pageSize,
    hasMore: offset + rows.length < total,
  });
});

router.post('/review/products/:id/approve', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const version = parseVersion(req.body?.version);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '商品编号不合法' });
    if (version === null) return res.status(400).json({ error: '缺少有效的商品版本号' });

    const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: '商品不存在' });
    if (existing.status !== 'PENDING_REVIEW') {
      return res.status(409).json({ error: '商品不在待审核状态', currentStatus: existing.status });
    }
    if (existing.version !== version) {
      return res.status(409).json({ error: '商品已被修改，请刷新后重试', currentVersion: existing.version });
    }

    const updated = transaction(() => {
      const now = nowIso();
      const info = db.prepare(`
        UPDATE products
        SET status = 'ON_SALE', version = version + 1, review_reason = NULL,
            published_at = ?, updated_at = ?
        WHERE id = ? AND version = ? AND status = 'PENDING_REVIEW'
      `).run(now, now, id, version);
      if (Number(info.changes) !== 1) return null;
      db.prepare(`
        INSERT INTO moderation_records (product_id, admin_id, action, reason)
        VALUES (?, ?, 'APPROVE', '')
      `).run(id, req.user.id);
      writeLog({
        actorId: req.user.id,
        actorRole: req.user.role,
        actionType: 'PRODUCT_APPROVE',
        targetType: 'PRODUCT',
        targetId: id,
        beforeState: { status: existing.status, version: existing.version },
        afterState: { status: 'ON_SALE', version: existing.version + 1 },
        requestId: requestId(req),
        ip: clientIp(req),
      });
      return getProductRow(id);
    });

    if (!updated) return res.status(409).json({ error: '商品已被其他管理员处理，请刷新后重试' });
    res.json({ product: mapProduct(updated, { includePrivate: true }) });
  } catch (error) {
    next(error);
  }
});

router.post('/review/products/:id/reject', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const version = parseVersion(req.body?.version);
    const reason = text(req.body?.reason);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '商品编号不合法' });
    if (version === null) return res.status(400).json({ error: '缺少有效的商品版本号' });
    if (reason.length < 2 || reason.length > 500) {
      return res.status(400).json({ error: '驳回理由长度必须为 2-500 个字符' });
    }

    const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: '商品不存在' });
    if (existing.status !== 'PENDING_REVIEW') {
      return res.status(409).json({ error: '商品不在待审核状态', currentStatus: existing.status });
    }
    if (existing.version !== version) {
      return res.status(409).json({ error: '商品已被修改，请刷新后重试', currentVersion: existing.version });
    }

    const updated = transaction(() => {
      const now = nowIso();
      const info = db.prepare(`
        UPDATE products
        SET status = 'REJECTED', version = version + 1, review_reason = ?,
            published_at = NULL, updated_at = ?
        WHERE id = ? AND version = ? AND status = 'PENDING_REVIEW'
      `).run(reason, now, id, version);
      if (Number(info.changes) !== 1) return null;
      db.prepare(`
        INSERT INTO moderation_records (product_id, admin_id, action, reason)
        VALUES (?, ?, 'REJECT', ?)
      `).run(id, req.user.id, reason);
      writeLog({
        actorId: req.user.id,
        actorRole: req.user.role,
        actionType: 'PRODUCT_REJECT',
        targetType: 'PRODUCT',
        targetId: id,
        beforeState: { status: existing.status, version: existing.version },
        afterState: { status: 'REJECTED', version: existing.version + 1 },
        reason,
        requestId: requestId(req),
        ip: clientIp(req),
      });
      return getProductRow(id);
    });

    if (!updated) return res.status(409).json({ error: '商品已被其他管理员处理，请刷新后重试' });
    res.json({ product: mapProduct(updated, { includePrivate: true }) });
  } catch (error) {
    next(error);
  }
});

module.exports = router;

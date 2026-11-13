'use strict';

const express = require('express');
const { db, transaction } = require('../db');
const { requireRole } = require('../auth');
const { writeLog, clientIp } = require('../audit');
const { nowIso } = require('../security');
const { ALL_STATUSES, PRODUCT_SELECT, getProductRow, mapProduct } = require('../productUtils');
const { text } = require('../validation');

const router = express.Router();
router.use(requireRole('ADMIN'));

function requestId(req) {
  return typeof req.headers['x-request-id'] === 'string'
    ? req.headers['x-request-id'].slice(0, 100)
    : null;
}

router.get('/products', (req, res) => {
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(50, Math.max(1, Number.parseInt(req.query.pageSize, 10) || 20));
  const offset = (page - 1) * pageSize;
  const status = text(req.query.status).toUpperCase();
  const q = text(req.query.q);
  if (status && !ALL_STATUSES.has(status)) return res.status(400).json({ error: '商品状态不合法' });
  const where = [];
  const params = [];
  if (status) {
    where.push('p.status = ?');
    params.push(status);
  }
  if (q) {
    where.push('(p.title LIKE ? OR u.display_name LIKE ? OR p.id = ?)');
    params.push(`%${q}%`, `%${q}%`, Number(q) || 0);
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM products p JOIN users u ON u.id = p.seller_id
    ${whereSql}
  `).get(...params).count);
  const rows = db.prepare(`
    ${PRODUCT_SELECT}
    ${whereSql}
    ORDER BY p.updated_at DESC, p.id DESC
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

router.post('/products/:id/violation', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const version = Number(req.body?.version);
    const reason = text(req.body?.reason);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '商品编号不合法' });
    if (!Number.isInteger(version) || version <= 0) return res.status(400).json({ error: '缺少有效的商品版本号' });
    if (reason.length < 2 || reason.length > 500) {
      return res.status(400).json({ error: '违规处理理由长度必须为 2-500 个字符' });
    }
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
    if (!product) return res.status(404).json({ error: '商品不存在' });
    if (!['ON_SALE', 'PENDING_REVIEW', 'RESERVED'].includes(product.status)) {
      return res.status(409).json({ error: '当前状态不允许违规移除', currentStatus: product.status });
    }
    if (product.version !== version) {
      return res.status(409).json({ error: '商品已被修改，请刷新后重试', currentVersion: product.version });
    }

    const updated = transaction(() => {
      const now = nowIso();
      const changed = db.prepare(`
        UPDATE products
        SET status = 'VIOLATION_REMOVED', version = version + 1,
            review_reason = ?, published_at = NULL, updated_at = ?
        WHERE id = ? AND version = ? AND status IN ('ON_SALE', 'PENDING_REVIEW', 'RESERVED')
      `).run(reason, now, id, version);
      if (Number(changed.changes) !== 1) return null;
      const reservations = db.prepare(`
        UPDATE reservations
        SET status = 'CANCELLED', closed_at = ?, close_reason = ?,
            version = version + 1
        WHERE product_id = ? AND status IN ('PENDING', 'CONFIRMED')
      `).run(now, `商品违规移除：${reason}`, id);
      db.prepare(`
        INSERT INTO moderation_records (product_id, admin_id, action, reason)
        VALUES (?, ?, 'VIOLATION_REMOVE', ?)
      `).run(id, req.user.id, reason);
      writeLog({
        actorId: req.user.id,
        actorRole: req.user.role,
        actionType: 'PRODUCT_VIOLATION_REMOVE',
        targetType: 'PRODUCT',
        targetId: id,
        beforeState: { status: product.status, version: product.version },
        afterState: { status: 'VIOLATION_REMOVED', version: product.version + 1, cancelledReservations: Number(reservations.changes) },
        reason,
        requestId: requestId(req),
        ip: clientIp(req),
      });
      return getProductRow(id);
    });
    if (!updated) return res.status(409).json({ error: '商品已被处理，请刷新后重试' });
    res.json({ product: mapProduct(updated, { includePrivate: true }) });
  } catch (error) {
    next(error);
  }
});

module.exports = router;

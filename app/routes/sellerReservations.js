'use strict';

const express = require('express');
const { db, transaction } = require('../db');
const { requireRole } = require('../auth');
const { writeLog, clientIp } = require('../audit');
const { nowIso, isoPlusHours } = require('../security');
const { text } = require('../validation');
const {
  RESERVATION_SELECT,
  getReservationRow,
  mapReservation,
  expireReservations,
} = require('../reservationUtils');

const router = express.Router();
router.use(requireRole('SELLER'));

function requestId(req) {
  return typeof req.headers['x-request-id'] === 'string'
    ? req.headers['x-request-id'].slice(0, 100)
    : null;
}

function parseVersion(value) {
  const version = Number(value);
  return Number.isInteger(version) && version > 0 ? version : null;
}

function safeExpire() {
  try {
    expireReservations();
  } catch (error) {
    console.error('expire reservations failed', error);
  }
}

router.get('/', (req, res) => {
  safeExpire();
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(50, Math.max(1, Number.parseInt(req.query.pageSize, 10) || 20));
  const offset = (page - 1) * pageSize;
  const status = text(req.query.status).toUpperCase();
  const productId = req.query.productId ? Number(req.query.productId) : null;
  const where = ['r.seller_id = ?'];
  const params = [req.user.id];
  if (status) {
    where.push('r.status = ?');
    params.push(status);
  }
  if (productId !== null) {
    where.push('r.product_id = ?');
    params.push(productId);
  }
  const whereSql = where.join(' AND ');
  const total = Number(db.prepare(
    `SELECT COUNT(*) AS count FROM reservations r WHERE ${whereSql}`,
  ).get(...params).count);
  const rows = db.prepare(`
    ${RESERVATION_SELECT}
    WHERE ${whereSql}
    ORDER BY CASE r.status WHEN 'PENDING' THEN 0 WHEN 'CONFIRMED' THEN 1 ELSE 2 END,
             r.created_at DESC, r.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, pageSize, offset);

  res.json({
    items: rows.map(mapReservation),
    total,
    page,
    pageSize,
    hasMore: offset + rows.length < total,
  });
});

router.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '预约编号不合法' });
  const row = getReservationRow(id);
  if (!row || Number(row.seller_id) !== req.user.id) {
    return res.status(404).json({ error: '预约不存在' });
  }
  res.json({ reservation: mapReservation(row) });
});

router.post('/:id/reject', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const version = parseVersion(req.body?.version);
    const reason = text(req.body?.reason) || '卖家拒绝';
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '预约编号不合法' });
    if (version === null) return res.status(400).json({ error: '缺少有效的预约版本号' });
    if (reason.length < 2 || reason.length > 200) {
      return res.status(400).json({ error: '拒绝原因长度必须为 2-200 个字符' });
    }
    const row = getReservationRow(id);
    if (!row || Number(row.seller_id) !== req.user.id) {
      return res.status(404).json({ error: '预约不存在' });
    }
    if (row.status !== 'PENDING') {
      return res.status(409).json({ error: '只有待确认预约可以拒绝', currentStatus: row.status });
    }
    if (row.version !== version) {
      return res.status(409).json({ error: '预约已被修改，请刷新后重试', currentVersion: row.version });
    }

    const updated = transaction(() => {
      const now = nowIso();
      const info = db.prepare(`
        UPDATE reservations
        SET status = 'REJECTED', closed_at = ?, close_reason = ?, version = version + 1
        WHERE id = ? AND version = ? AND status = 'PENDING'
      `).run(now, reason, id, version);
      if (Number(info.changes) !== 1) return null;
      writeLog({
        actorId: req.user.id,
        actorRole: req.user.role,
        actionType: 'RESERVATION_REJECT',
        targetType: 'RESERVATION',
        targetId: id,
        beforeState: { status: 'PENDING', version },
        afterState: { status: 'REJECTED', version: version + 1 },
        reason,
        requestId: requestId(req),
        ip: clientIp(req),
      });
      return getReservationRow(id);
    });
    if (!updated) return res.status(409).json({ error: '预约状态已变化，请刷新后重试' });
    res.json({ reservation: mapReservation(updated) });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/confirm', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const version = parseVersion(req.body?.version);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '预约编号不合法' });
    if (version === null) return res.status(400).json({ error: '缺少有效的预约版本号' });

    const result = transaction(() => {
      const row = getReservationRow(id);
      if (!row || Number(row.seller_id) !== req.user.id) return { notFound: true };
      if (row.version !== version) return { conflict: '预约已被修改，请刷新后重试', currentVersion: row.version };
      if (row.status !== 'PENDING') return { conflict: '只有待确认预约可以确认', currentStatus: row.status };

      const now = nowIso();
      if (new Date(row.expires_at).getTime() <= Date.now()) {
        db.prepare(`
          UPDATE reservations
          SET status = 'EXPIRED', closed_at = ?, close_reason = '待确认超时', version = version + 1
          WHERE id = ? AND status = 'PENDING'
        `).run(now, id);
        return { expired: true };
      }

      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(row.product_id);
      if (!product || product.status !== 'ON_SALE') {
        return { conflict: '商品当前不是在售状态，不能确认预约', currentStatus: product?.status || null };
      }

      const confirmed = db.prepare(`
        UPDATE reservations
        SET status = 'CONFIRMED', price_cents = ?, confirmed_at = ?,
            expires_at = ?, version = version + 1
        WHERE id = ? AND version = ? AND status = 'PENDING'
      `).run(product.price_cents, now, isoPlusHours(24 * 7), id, version);
      if (Number(confirmed.changes) !== 1) {
        return { conflict: '预约状态已变化，请刷新后重试' };
      }
      db.prepare(`
        UPDATE products
        SET status = 'RESERVED', version = version + 1, updated_at = ?
        WHERE id = ? AND status = 'ON_SALE'
      `).run(now, row.product_id);
      const others = db.prepare(`
        UPDATE reservations
        SET status = 'REJECTED', closed_at = ?, close_reason = '商品已被其他预约确认',
            version = version + 1
        WHERE product_id = ? AND status = 'PENDING' AND id <> ?
      `).run(now, row.product_id, id);
      writeLog({
        actorId: req.user.id,
        actorRole: req.user.role,
        actionType: 'RESERVATION_CONFIRM',
        targetType: 'RESERVATION',
        targetId: id,
        beforeState: { status: 'PENDING', version },
        afterState: { status: 'CONFIRMED', productId: row.product_id, priceCents: Number(product.price_cents) },
        requestId: requestId(req),
        ip: clientIp(req),
      });
      if (Number(others.changes) > 0) {
        writeLog({
          actorId: req.user.id,
          actorRole: req.user.role,
          actionType: 'RESERVATION_REJECT_OTHERS',
          targetType: 'PRODUCT',
          targetId: row.product_id,
          beforeState: { pendingCount: Number(others.changes) },
          afterState: { pendingCount: 0 },
          reason: '商品已被其他预约确认',
          requestId: requestId(req),
          ip: clientIp(req),
        });
      }
      return { row: getReservationRow(id) };
    });

    if (result.notFound) return res.status(404).json({ error: '预约不存在' });
    if (result.expired) return res.status(409).json({ error: '预约已过期' });
    if (result.conflict) return res.status(409).json({ error: result.conflict, currentStatus: result.currentStatus, currentVersion: result.currentVersion });
    res.json({ reservation: mapReservation(result.row) });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/complete', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const version = parseVersion(req.body?.version);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '预约编号不合法' });
    if (version === null) return res.status(400).json({ error: '缺少有效的预约版本号' });

    const result = transaction(() => {
      const row = getReservationRow(id);
      if (!row || Number(row.seller_id) !== req.user.id) return { notFound: true };
      if (row.version !== version) return { conflict: '预约已被修改，请刷新后重试', currentVersion: row.version };
      if (row.status !== 'CONFIRMED') return { conflict: '只有已确认预约可以完成', currentStatus: row.status };
      const product = db.prepare('SELECT status FROM products WHERE id = ?').get(row.product_id);
      if (!product || product.status !== 'RESERVED') {
        return { conflict: '商品当前不是已预订状态，不能完成交易', currentStatus: product?.status || null };
      }
      const now = nowIso();
      db.prepare(`
        UPDATE products
        SET status = 'SOLD', sold_at = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND status = 'RESERVED'
      `).run(now, now, row.product_id);
      db.prepare(`
        UPDATE reservations
        SET status = 'COMPLETED', completed_at = ?, version = version + 1
        WHERE id = ? AND version = ? AND status = 'CONFIRMED'
      `).run(now, id, version);
      writeLog({
        actorId: req.user.id,
        actorRole: req.user.role,
        actionType: 'RESERVATION_COMPLETE',
        targetType: 'RESERVATION',
        targetId: id,
        beforeState: { status: 'CONFIRMED', version },
        afterState: { status: 'COMPLETED', productId: row.product_id },
        requestId: requestId(req),
        ip: clientIp(req),
      });
      return { row: getReservationRow(id) };
    });

    if (result.notFound) return res.status(404).json({ error: '预约不存在' });
    if (result.conflict) return res.status(409).json({ error: result.conflict, currentStatus: result.currentStatus, currentVersion: result.currentVersion });
    res.json({ reservation: mapReservation(result.row) });
  } catch (error) {
    next(error);
  }
});

module.exports = router;

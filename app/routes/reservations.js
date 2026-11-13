'use strict';

const express = require('express');
const { db, transaction } = require('../db');
const { requireAuth, requireRole } = require('../auth');
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

function httpError(message, statusCode = 409) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

router.post('/', requireRole('BUYER'), (req, res, next) => {
  try {
    safeExpire();
    const body = req.body || {};
    const productId = Number(body.productId);
    const message = text(body.message);
    const clientRequestId = text(body.clientRequestId);
    if (!Number.isInteger(productId) || productId <= 0) {
      return res.status(400).json({ error: '商品编号不合法' });
    }
    if (clientRequestId.length < 8 || clientRequestId.length > 100) {
      return res.status(400).json({ error: '缺少有效的客户端请求编号' });
    }
    if (message.length > 200) {
      return res.status(400).json({ error: '预约留言不能超过 200 个字符' });
    }

    const existingRequest = db.prepare(
      'SELECT * FROM reservations WHERE buyer_id = ? AND client_request_id = ?',
    ).get(req.user.id, clientRequestId);
    if (existingRequest) {
      if (Number(existingRequest.product_id) !== productId) {
        return res.status(409).json({ error: '请求编号已用于其他商品' });
      }
      return res.json({ reservation: mapReservation(getReservationRow(existingRequest.id)), replayed: true });
    }

    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
    if (!product) return res.status(404).json({ error: '商品不存在' });
    if (Number(product.seller_id) === req.user.id) {
      return res.status(400).json({ error: '不能预约自己发布的商品' });
    }
    if (product.status !== 'ON_SALE') {
      return res.status(409).json({ error: '商品当前不可预约', currentStatus: product.status });
    }
    const active = db.prepare(`
      SELECT id FROM reservations
      WHERE product_id = ? AND buyer_id = ? AND status IN ('PENDING', 'CONFIRMED')
      LIMIT 1
    `).get(productId, req.user.id);
    if (active) {
      return res.status(409).json({ error: '你已经对该商品有一条进行中的预约', reservationId: Number(active.id) });
    }

    const reservation = transaction(() => {
      const productNow = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
      if (!productNow) throw httpError('商品不存在', 404);
      if (Number(productNow.seller_id) === req.user.id) {
        throw httpError('不能预约自己发布的商品', 400);
      }
      if (productNow.status !== 'ON_SALE') {
        throw httpError('商品当前不可预约');
      }
      const activeNow = db.prepare(`
        SELECT id FROM reservations
        WHERE product_id = ? AND buyer_id = ? AND status IN ('PENDING', 'CONFIRMED')
        LIMIT 1
      `).get(productId, req.user.id);
      if (activeNow) throw httpError('你已经对该商品有一条进行中的预约');

      const now = nowIso();
      const info = db.prepare(`
        INSERT INTO reservations (
          product_id, buyer_id, seller_id, status, message,
          client_request_id, version, expires_at
        ) VALUES (?, ?, ?, 'PENDING', ?, ?, 1, ?)
      `).run(productId, req.user.id, productNow.seller_id, message, clientRequestId, isoPlusHours(24));
      const reservationId = Number(info.lastInsertRowid);
      writeLog({
        actorId: req.user.id,
        actorRole: req.user.role,
        actionType: 'RESERVATION_CREATE',
        targetType: 'RESERVATION',
        targetId: reservationId,
        afterState: { status: 'PENDING', productId, message },
        requestId: requestId(req),
        ip: clientIp(req),
      });
      return getReservationRow(reservationId);
    });

    res.status(201).json({ reservation: mapReservation(reservation), replayed: false });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    if (String(error.message || '').includes('UNIQUE constraint failed')) {
      return res.status(409).json({ error: '已有进行中的预约，请刷新后查看' });
    }
    next(error);
  }
});

router.get('/', requireRole('BUYER'), (req, res) => {
  safeExpire();
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(50, Math.max(1, Number.parseInt(req.query.pageSize, 10) || 20));
  const offset = (page - 1) * pageSize;
  const status = text(req.query.status).toUpperCase();
  const q = text(req.query.q);
  const where = ['r.buyer_id = ?'];
  const params = [req.user.id];
  if (status) {
    where.push('r.status = ?');
    params.push(status);
  }
  if (q) {
    where.push('p.title LIKE ?');
    params.push(`%${q}%`);
  }
  const whereSql = where.join(' AND ');
  const total = Number(db.prepare(`
    SELECT COUNT(*) AS count FROM reservations r
    JOIN products p ON p.id = r.product_id
    WHERE ${whereSql}
  `).get(...params).count);
  const rows = db.prepare(`
    ${RESERVATION_SELECT}
    WHERE ${whereSql}
    ORDER BY r.created_at DESC, r.id DESC
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

router.get('/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '预约编号不合法' });
  const row = getReservationRow(id);
  if (!row) return res.status(404).json({ error: '预约不存在' });
  if (![Number(row.buyer_id), Number(row.seller_id)].includes(req.user.id) && req.user.role !== 'ADMIN') {
    return res.status(403).json({ error: '没有权限查看该预约' });
  }
  res.json({ reservation: mapReservation(row) });
});

router.post('/:id/cancel', requireAuth, (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const version = parseVersion(req.body?.version);
    const reason = text(req.body?.reason);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '预约编号不合法' });
    if (version === null) return res.status(400).json({ error: '缺少有效的预约版本号' });
    const row = getReservationRow(id);
    if (!row) return res.status(404).json({ error: '预约不存在' });

    const isBuyer = Number(row.buyer_id) === req.user.id;
    const isSeller = Number(row.seller_id) === req.user.id;
    if (!isBuyer && !isSeller) return res.status(403).json({ error: '没有权限取消该预约' });
    if (row.status === 'PENDING' && !isBuyer) {
      return res.status(403).json({ error: '卖家请使用拒绝操作处理待确认预约' });
    }
    if (!['PENDING', 'CONFIRMED'].includes(row.status)) {
      return res.status(409).json({ error: '当前预约状态不能取消', currentStatus: row.status });
    }
    if (row.version !== version) {
      return res.status(409).json({ error: '预约已被修改，请刷新后重试', currentVersion: row.version });
    }
    if (row.status === 'CONFIRMED' && (reason.length < 2 || reason.length > 200)) {
      return res.status(400).json({ error: '取消已确认预约必须填写 2-200 个字符的原因' });
    }

    const updated = transaction(() => {
      const now = nowIso();
      if (row.status === 'CONFIRMED') {
        const product = db.prepare('SELECT status FROM products WHERE id = ?').get(row.product_id);
        if (!product || product.status !== 'RESERVED') {
          return { conflict: '商品状态已变化，不能取消该预约' };
        }
        db.prepare(`
          UPDATE products
          SET status = 'ON_SALE', version = version + 1, updated_at = ?
          WHERE id = ? AND status = 'RESERVED'
        `).run(now, row.product_id);
      }
      db.prepare(`
        UPDATE reservations
        SET status = 'CANCELLED', closed_at = ?, close_reason = ?,
            version = version + 1
        WHERE id = ? AND version = ? AND status IN ('PENDING', 'CONFIRMED')
      `).run(now, reason || '买家取消', row.id, row.version);
      writeLog({
        actorId: req.user.id,
        actorRole: req.user.role,
        actionType: row.status === 'CONFIRMED' ? 'RESERVATION_CANCEL_CONFIRMED' : 'RESERVATION_CANCEL',
        targetType: 'RESERVATION',
        targetId: row.id,
        beforeState: { status: row.status, productId: row.product_id, version: row.version },
        afterState: { status: 'CANCELLED' },
        reason: reason || null,
        requestId: requestId(req),
        ip: clientIp(req),
      });
      return { row: getReservationRow(row.id) };
    });

    if (updated.conflict) return res.status(409).json({ error: updated.conflict });
    res.json({ reservation: mapReservation(updated.row) });
  } catch (error) {
    next(error);
  }
});

module.exports = router;

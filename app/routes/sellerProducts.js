'use strict';

const express = require('express');
const { db, transaction } = require('../db');
const { requireRole } = require('../auth');
const { writeLog, clientIp } = require('../audit');
const { nowIso } = require('../security');
const {
  ALL_STATUSES,
  PRODUCT_SELECT,
  validateProductInput,
  categoryExists,
  getProductRow,
  mapProduct,
} = require('../productUtils');
const { text } = require('../validation');
const { cancelPendingReservationsForProduct } = require('../reservationUtils');

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

function ownedProduct(id, sellerId) {
  return db.prepare('SELECT * FROM products WHERE id = ? AND seller_id = ?').get(id, sellerId);
}

router.get('/products', (req, res) => {
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(50, Math.max(1, Number.parseInt(req.query.pageSize, 10) || 20));
  const offset = (page - 1) * pageSize;
  const status = text(req.query.status).toUpperCase();
  const q = text(req.query.q);

  if (status && !ALL_STATUSES.has(status)) {
    return res.status(400).json({ error: '商品状态不合法' });
  }

  const where = ['p.seller_id = ?'];
  const params = [req.user.id];
  if (status) {
    where.push('p.status = ?');
    params.push(status);
  }
  if (q) {
    where.push('(p.title LIKE ? OR p.description LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }
  const whereSql = where.join(' AND ');
  const total = Number(db.prepare(
    `SELECT COUNT(*) AS count FROM products p WHERE ${whereSql}`,
  ).get(...params).count);
  const rows = db.prepare(`
    ${PRODUCT_SELECT}
    WHERE ${whereSql}
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

router.get('/products/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '商品编号不合法' });
  const row = ownedProduct(id, req.user.id);
  if (!row) return res.status(404).json({ error: '商品不存在' });
  res.json({ product: mapProduct(getProductRow(id), { includePrivate: true }) });
});

router.post('/products', (req, res, next) => {
  try {
    const { errors, values } = validateProductInput(req.body);
    if (errors.length > 0) return res.status(400).json({ error: errors[0], fields: errors });
    if (!categoryExists(values.categoryId)) {
      return res.status(400).json({ error: '商品分类不存在' });
    }

    const result = transaction(() => {
      const info = db.prepare(`
        INSERT INTO products (
          seller_id, category_id, title, description, price_cents,
          condition, image_url, status, version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'DRAFT', 1)
      `).run(
        req.user.id,
        values.categoryId,
        values.title,
        values.description,
        values.priceCents,
        values.condition,
        values.imageUrl,
      );
      const productId = Number(info.lastInsertRowid);
      writeLog({
        actorId: req.user.id,
        actorRole: req.user.role,
        actionType: 'PRODUCT_CREATE',
        targetType: 'PRODUCT',
        targetId: productId,
        afterState: { status: 'DRAFT', title: values.title, priceCents: values.priceCents },
        requestId: requestId(req),
        ip: clientIp(req),
      });
      return productId;
    });

    res.status(201).json({
      product: mapProduct(getProductRow(result), { includePrivate: true }),
    });
  } catch (error) {
    next(error);
  }
});

router.put('/products/:id', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const version = parseVersion(req.body?.version);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '商品编号不合法' });
    if (version === null) return res.status(400).json({ error: '缺少有效的商品版本号' });

    const existing = ownedProduct(id, req.user.id);
    if (!existing) return res.status(404).json({ error: '商品不存在' });
    if (existing.version !== version) {
      return res.status(409).json({ error: '商品已被修改，请刷新后重试', currentVersion: existing.version, currentStatus: existing.status });
    }
    if (!['DRAFT', 'REJECTED', 'OFF_SHELF', 'ON_SALE'].includes(existing.status)) {
      return res.status(409).json({ error: '当前商品状态不允许修改', currentStatus: existing.status });
    }

    const { errors, values } = validateProductInput(req.body);
    if (errors.length > 0) return res.status(400).json({ error: errors[0], fields: errors });
    if (!categoryExists(values.categoryId)) {
      return res.status(400).json({ error: '商品分类不存在' });
    }

    const nextStatus = existing.status === 'ON_SALE' ? 'PENDING_REVIEW' : 'DRAFT';
    const updated = transaction(() => {
      const info = db.prepare(`
        UPDATE products
        SET category_id = ?, title = ?, description = ?, price_cents = ?,
            condition = ?, image_url = ?, status = ?, version = version + 1,
            review_reason = NULL, published_at = NULL, updated_at = ?
        WHERE id = ? AND seller_id = ? AND version = ?
      `).run(
        values.categoryId,
        values.title,
        values.description,
        values.priceCents,
        values.condition,
        values.imageUrl,
        nextStatus,
        nowIso(),
        id,
        req.user.id,
        version,
      );
      if (Number(info.changes) !== 1) return null;
      if (nextStatus === 'PENDING_REVIEW') {
        cancelPendingReservationsForProduct(
          id,
          '商品修改后重新审核',
          req.user.id,
          req.user.role,
          requestId(req),
          clientIp(req),
        );
      }
      writeLog({
        actorId: req.user.id,
        actorRole: req.user.role,
        actionType: 'PRODUCT_UPDATE',
        targetType: 'PRODUCT',
        targetId: id,
        beforeState: { status: existing.status, version: existing.version },
        afterState: { status: nextStatus, version: existing.version + 1 },
        requestId: requestId(req),
        ip: clientIp(req),
      });
      return getProductRow(id);
    });

    if (!updated) {
      return res.status(409).json({ error: '商品已被修改，请刷新后重试' });
    }
    res.json({ product: mapProduct(updated, { includePrivate: true }) });
  } catch (error) {
    next(error);
  }
});

router.post('/products/:id/submit', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const version = parseVersion(req.body?.version);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '商品编号不合法' });
    if (version === null) return res.status(400).json({ error: '缺少有效的商品版本号' });

    const existing = ownedProduct(id, req.user.id);
    if (!existing) return res.status(404).json({ error: '商品不存在' });
    if (existing.version !== version) {
      return res.status(409).json({ error: '商品已被修改，请刷新后重试', currentVersion: existing.version });
    }
    if (!['DRAFT', 'REJECTED'].includes(existing.status)) {
      return res.status(409).json({ error: '当前商品状态不能提交审核', currentStatus: existing.status });
    }

    const updated = transaction(() => {
      const info = db.prepare(`
        UPDATE products
        SET status = 'PENDING_REVIEW', version = version + 1,
            review_reason = NULL, published_at = NULL, updated_at = ?
        WHERE id = ? AND seller_id = ? AND version = ?
      `).run(nowIso(), id, req.user.id, version);
      if (Number(info.changes) !== 1) return null;
      writeLog({
        actorId: req.user.id,
        actorRole: req.user.role,
        actionType: 'PRODUCT_SUBMIT',
        targetType: 'PRODUCT',
        targetId: id,
        beforeState: { status: existing.status, version: existing.version },
        afterState: { status: 'PENDING_REVIEW', version: existing.version + 1 },
        requestId: requestId(req),
        ip: clientIp(req),
      });
      return getProductRow(id);
    });

    if (!updated) return res.status(409).json({ error: '商品已被修改，请刷新后重试' });
    res.json({ product: mapProduct(updated, { includePrivate: true }) });
  } catch (error) {
    next(error);
  }
});

router.post('/products/:id/delist', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const version = parseVersion(req.body?.version);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '商品编号不合法' });
    if (version === null) return res.status(400).json({ error: '缺少有效的商品版本号' });

    const existing = ownedProduct(id, req.user.id);
    if (!existing) return res.status(404).json({ error: '商品不存在' });
    if (existing.version !== version) {
      return res.status(409).json({ error: '商品已被修改，请刷新后重试', currentVersion: existing.version });
    }
    if (existing.status !== 'ON_SALE') {
      return res.status(409).json({ error: '只有已发布商品可以下架', currentStatus: existing.status });
    }

    const updated = transaction(() => {
      const info = db.prepare(`
        UPDATE products
        SET status = 'OFF_SHELF', version = version + 1, updated_at = ?
        WHERE id = ? AND seller_id = ? AND version = ?
      `).run(nowIso(), id, req.user.id, version);
      if (Number(info.changes) !== 1) return null;
      cancelPendingReservationsForProduct(
        id,
        '卖家下架商品',
        req.user.id,
        req.user.role,
        requestId(req),
        clientIp(req),
      );
      writeLog({
        actorId: req.user.id,
        actorRole: req.user.role,
        actionType: 'PRODUCT_DELIST',
        targetType: 'PRODUCT',
        targetId: id,
        beforeState: { status: existing.status, version: existing.version },
        afterState: { status: 'OFF_SHELF', version: existing.version + 1 },
        requestId: requestId(req),
        ip: clientIp(req),
      });
      return getProductRow(id);
    });

    if (!updated) return res.status(409).json({ error: '商品已被修改，请刷新后重试' });
    res.json({ product: mapProduct(updated, { includePrivate: true }) });
  } catch (error) {
    next(error);
  }
});

module.exports = router;

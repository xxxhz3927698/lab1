'use strict';

const express = require('express');
const { db } = require('../db');
const {
  PUBLIC_STATUSES,
  PRODUCT_SELECT,
  parsePriceToCents,
  getProductRow,
  mapProduct,
} = require('../productUtils');
const { text } = require('../validation');

const router = express.Router();

function optionalCents(value, { allowZero = false } = {}) {
  if (value === undefined || value === null || value === '') return { value: null };
  if (allowZero && String(value).trim() === '0') return { value: 0 };
  const result = parsePriceToCents(value);
  if (result.error) return { error: result.error };
  return { value: result.cents };
}

router.get('/categories', (_req, res) => {
  const categories = db.prepare(`
    SELECT id, name FROM categories
    WHERE status = 'ACTIVE'
    ORDER BY sort_order ASC, id ASC
  `).all().map((row) => ({ id: Number(row.id), name: row.name }));
  res.json({ categories });
});

router.get('/products', (req, res) => {
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(50, Math.max(1, Number.parseInt(req.query.pageSize, 10) || 12));
  const offset = (page - 1) * pageSize;
  const q = text(req.query.q);
  const categoryId = req.query.categoryId ? Number(req.query.categoryId) : null;
  const status = text(req.query.status).toUpperCase();
  const sort = text(req.query.sort) || 'newest';

  if (categoryId !== null && (!Number.isInteger(categoryId) || categoryId <= 0)) {
    return res.status(400).json({ error: '分类参数不合法' });
  }
  if (status && !PUBLIC_STATUSES.has(status)) {
    return res.status(400).json({ error: '公开查询只能使用在售或已预订状态' });
  }
  const minResult = optionalCents(req.query.minPrice, { allowZero: true });
  const maxResult = optionalCents(req.query.maxPrice, { allowZero: true });
  if (minResult.error) return res.status(400).json({ error: minResult.error });
  if (maxResult.error) return res.status(400).json({ error: maxResult.error });
  if (minResult.value !== null && maxResult.value !== null && minResult.value > maxResult.value) {
    return res.status(400).json({ error: '最低价不能大于最高价' });
  }

  const where = [];
  const params = [];
  const statuses = status ? [status] : ['ON_SALE', 'RESERVED'];
  where.push(`p.status IN (${statuses.map(() => '?').join(', ')})`);
  params.push(...statuses);
  if (q) {
    where.push('(p.title LIKE ? OR p.description LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }
  if (categoryId !== null) {
    where.push('p.category_id = ?');
    params.push(categoryId);
  }
  if (minResult.value !== null) {
    where.push('p.price_cents >= ?');
    params.push(minResult.value);
  }
  if (maxResult.value !== null) {
    where.push('p.price_cents <= ?');
    params.push(maxResult.value);
  }

  const orderBy = sort === 'price_asc'
    ? 'p.price_cents ASC, p.id DESC'
    : sort === 'price_desc'
      ? 'p.price_cents DESC, p.id DESC'
      : 'p.published_at DESC, p.id DESC';

  const whereSql = where.join(' AND ');
  const total = Number(db.prepare(
    `SELECT COUNT(*) AS count FROM products p WHERE ${whereSql}`,
  ).get(...params).count);
  const rows = db.prepare(`
    ${PRODUCT_SELECT}
    WHERE ${whereSql}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `).all(...params, pageSize, offset);

  res.json({
    items: rows.map((row) => mapProduct(row)),
    total,
    page,
    pageSize,
    hasMore: offset + rows.length < total,
  });
});

router.get('/products/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '商品编号不合法' });
  const row = getProductRow(id);
  if (!row) return res.status(404).json({ error: '商品不存在' });

  const isOwner = Boolean(req.user && req.user.id === Number(row.seller_id));
  const isAdmin = Boolean(req.user && req.user.role === 'ADMIN');
  const isPublic = PUBLIC_STATUSES.has(row.status) || row.status === 'SOLD';
  if (!isPublic && !isOwner && !isAdmin) {
    return res.status(404).json({ error: '商品不存在或不可见' });
  }

  const canReserve = Boolean(
    req.user
    && req.user.role === 'BUYER'
    && row.status === 'ON_SALE'
    && Number(row.seller_id) !== req.user.id,
  );
  res.json({
    product: mapProduct(row, { includePrivate: isOwner || isAdmin }),
    canReserve,
    viewer: req.user ? { id: req.user.id, role: req.user.role } : null,
  });
});

module.exports = router;

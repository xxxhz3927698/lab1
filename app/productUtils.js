'use strict';

const { db } = require('./db');
const { text } = require('./validation');

const CONDITIONS = new Set(['NEW', 'LIKE_NEW', 'GOOD', 'FAIR']);
const PUBLIC_STATUSES = new Set(['ON_SALE', 'RESERVED']);
const ALL_STATUSES = new Set([
  'DRAFT', 'PENDING_REVIEW', 'ON_SALE', 'RESERVED', 'SOLD',
  'OFF_SHELF', 'REJECTED', 'VIOLATION_REMOVED',
]);

const PRODUCT_SELECT = `
  SELECT
    p.*,
    c.name AS category_name,
    u.display_name AS seller_name,
    u.account AS seller_account,
    (
      SELECT COUNT(*) FROM reservations r
      WHERE r.product_id = p.id AND r.status = 'PENDING'
    ) AS pending_count
  FROM products p
  JOIN categories c ON c.id = p.category_id
  JOIN users u ON u.id = p.seller_id
`;

function parsePriceToCents(value) {
  if (value === null || value === undefined || value === '') {
    return { error: '请输入价格' };
  }
  const raw = typeof value === 'number' ? String(value) : text(value);
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) {
    return { error: '价格必须是最多两位小数的正数' };
  }
  const [whole, fraction = ''] = raw.split('.');
  const cents = Number(whole) * 100 + Number((fraction + '00').slice(0, 2));
  if (!Number.isSafeInteger(cents) || cents <= 0) {
    return { error: '价格必须大于 0' };
  }
  if (cents > 100000000) {
    return { error: '价格不能超过 1,000,000 元' };
  }
  return { cents };
}

function formatPrice(cents) {
  return (Number(cents) / 100).toFixed(2);
}

function validateProductInput(body = {}) {
  const errors = [];
  const title = text(body.title);
  const description = text(body.description);
  const imageUrl = text(body.imageUrl);
  const condition = text(body.condition).toUpperCase();
  const categoryId = Number(body.categoryId);
  const priceResult = parsePriceToCents(body.price);

  if (title.length < 2 || title.length > 80) errors.push('标题长度必须为 2-80 个字符');
  if (description.length < 10 || description.length > 2000) errors.push('描述长度必须为 10-2000 个字符');
  if (!Number.isInteger(categoryId) || categoryId <= 0) errors.push('请选择商品分类');
  if (!CONDITIONS.has(condition)) errors.push('成色不合法');
  if (priceResult.error) errors.push(priceResult.error);
  if (imageUrl.length > 500) errors.push('图片地址不能超过 500 个字符');

  return {
    errors,
    values: {
      title,
      description,
      imageUrl,
      condition,
      categoryId,
      priceCents: priceResult.cents,
    },
  };
}

function categoryExists(categoryId) {
  return Boolean(db.prepare(
    "SELECT id FROM categories WHERE id = ? AND status = 'ACTIVE'",
  ).get(categoryId));
}

function getProductRow(id) {
  return db.prepare(PRODUCT_SELECT + ' WHERE p.id = ?').get(id);
}

function mapProduct(row, { includePrivate = false } = {}) {
  if (!row) return null;
  const product = {
    id: Number(row.id),
    sellerId: Number(row.seller_id),
    seller: {
      id: Number(row.seller_id),
      displayName: row.seller_name,
      account: row.seller_account,
    },
    category: {
      id: Number(row.category_id),
      name: row.category_name,
    },
    title: row.title,
    description: row.description,
    price: formatPrice(row.price_cents),
    priceCents: Number(row.price_cents),
    condition: row.condition,
    imageUrl: row.image_url,
    status: row.status,
    version: Number(row.version),
    pendingReservations: Number(row.pending_count || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at,
    soldAt: row.sold_at,
  };
  if (includePrivate) {
    product.reviewReason = row.review_reason || '';
  }
  return product;
}

module.exports = {
  CONDITIONS,
  PUBLIC_STATUSES,
  ALL_STATUSES,
  PRODUCT_SELECT,
  parsePriceToCents,
  formatPrice,
  validateProductInput,
  categoryExists,
  getProductRow,
  mapProduct,
};

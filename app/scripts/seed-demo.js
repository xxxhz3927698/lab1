'use strict';

const { db, transaction } = require('../db');
const { hashPassword, nowIso, isoPlusHours } = require('../security');

function ensureUser(account, role, displayName) {
  const existing = db.prepare('SELECT * FROM users WHERE account = ?').get(account);
  if (existing) return Number(existing.id);
  const { salt, hash } = hashPassword('Demo12345');
  const info = db.prepare(`
    INSERT INTO users (account, password_hash, password_salt, role, status, display_name)
    VALUES (?, ?, ?, ?, 'ACTIVE', ?)
  `).run(account, hash, salt, role, displayName);
  return Number(info.lastInsertRowid);
}

function categoryId(name) {
  return Number(db.prepare('SELECT id FROM categories WHERE name = ?').get(name).id);
}

function ensureProduct({ sellerId, category, title, description, price, condition, status, version = 1, imageUrl = '' }) {
  const existing = db.prepare('SELECT id FROM products WHERE title = ? AND seller_id = ?').get(title, sellerId);
  if (existing) return Number(existing.id);
  const now = nowIso();
  const info = db.prepare(`
    INSERT INTO products (
      seller_id, category_id, title, description, price_cents,
      condition, image_url, status, version, published_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sellerId,
    categoryId(category),
    title,
    description,
    price,
    condition,
    imageUrl,
    status,
    version,
    ['ON_SALE', 'RESERVED', 'SOLD'].includes(status) ? now : null,
    now,
    now,
  );
  return Number(info.lastInsertRowid);
}

const sellerId = ensureUser('seller_demo', 'SELLER', '林同学');
const buyerId = ensureUser('buyer_demo', 'BUYER', '陈同学');
ensureUser('buyer_demo2', 'BUYER', '周同学');

const productIds = transaction(() => {
  const ids = [];
  ids.push(ensureProduct({
    sellerId,
    category: '数码电子',
    title: '九成新机械键盘',
    description: '自用机械键盘，轴体手感正常，键帽完整，附原装数据线。支持图书馆门口线下验货。',
    price: 29900,
    condition: 'LIKE_NEW',
    status: 'ON_SALE',
    version: 4,
  }));
  ids.push(ensureProduct({
    sellerId,
    category: '图书教材',
    title: '线性代数教材与习题册',
    description: '教材和习题册一套，少量笔记，不影响阅读。适合本学期上课使用，可在教学楼交付。',
    price: 2500,
    condition: 'GOOD',
    status: 'ON_SALE',
    version: 3,
  }));
  ids.push(ensureProduct({
    sellerId,
    category: '运动户外',
    title: '入门级山地自行车',
    description: '骑行不多，刹车和变速正常，车锁一起出。仅限校内线下看车，现场确认后交易。',
    price: 45000,
    condition: 'GOOD',
    status: 'ON_SALE',
    version: 5,
  }));
  ids.push(ensureProduct({
    sellerId,
    category: '数码电子',
    title: '蓝牙降噪耳机',
    description: '降噪和续航正常，耳罩有轻微使用痕迹。提交审核中，审核通过后公开。',
    price: 18000,
    condition: 'GOOD',
    status: 'PENDING_REVIEW',
    version: 2,
  }));
  ids.push(ensureProduct({
    sellerId,
    category: '生活用品',
    title: '宿舍护眼台灯',
    description: '三档亮度，宿舍书桌使用正常。草稿商品，尚未提交审核。',
    price: 4500,
    condition: 'GOOD',
    status: 'DRAFT',
    version: 1,
  }));
  ids.push(ensureProduct({
    sellerId,
    category: '其他',
    title: '闲置收纳箱两个',
    description: '两个透明收纳箱，适合宿舍收纳。已下架，等待重新整理图片后提交。',
    price: 2000,
    condition: 'FAIR',
    status: 'OFF_SHELF',
    version: 3,
  }));
  return ids;
});

const demoProductId = productIds[0];
const existingReservation = db.prepare(`
  SELECT id FROM reservations
  WHERE product_id = ? AND buyer_id = ? AND status IN ('PENDING', 'CONFIRMED')
`).get(demoProductId, buyerId);
if (!existingReservation) {
  db.prepare(`
    INSERT INTO reservations (
      product_id, buyer_id, seller_id, status, message,
      client_request_id, version, expires_at
    ) VALUES (?, ?, ?, 'PENDING', ?, 'demo-reservation-0001', 1, ?)
  `).run(demoProductId, buyerId, sellerId, '希望今天下午在图书馆门口交易，可以当面验货。', isoPlusHours(24));
}

console.log('演示数据已准备：');
console.log('  卖家：seller_demo / Demo12345（林同学）');
console.log('  买家：buyer_demo / Demo12345（陈同学）');
console.log('  管理员：admin / Admin@12345');
console.log('  演示商品数量：', productIds.length);

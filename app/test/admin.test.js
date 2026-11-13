'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'Admin@12345';
const app = require('../server');

let server;
let baseUrl;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function createClient() {
  let cookie = '';
  return async function request(path, options = {}) {
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    if (cookie) headers.cookie = cookie;
    const response = await fetch(baseUrl + path, { ...options, headers });
    const setCookies = response.headers.getSetCookie?.() || [];
    if (setCookies.length > 0) {
      cookie = setCookies.map((item) => item.split(';')[0]).join('; ');
    }
    const data = await response.json().catch(() => ({}));
    return { response, data };
  };
}

async function register(request, account, role) {
  const result = await request('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ account, password: 'Password123', displayName: account, role }),
  });
  assert.equal(result.response.status, 201);
  return result.data.user;
}

async function login(request, account, password = 'Password123') {
  const result = await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ account, password }),
  });
  assert.equal(result.response.status, 200);
  return result.data.user;
}

function productPayload(title, price = '150.00') {
  return {
    title,
    categoryId: 1,
    price,
    condition: 'GOOD',
    description: `${title}，功能正常，支持线下验货，具体成色以实物为准。`,
    imageUrl: '',
  };
}

async function publishProduct(seller, admin, title, price) {
  const created = await seller('/api/seller/products', {
    method: 'POST',
    body: JSON.stringify(productPayload(title, price)),
  });
  assert.equal(created.response.status, 201);
  const product = created.data.product;
  const submitted = await seller(`/api/seller/products/${product.id}/submit`, {
    method: 'POST',
    body: JSON.stringify({ version: product.version }),
  });
  const approved = await admin(`/api/admin/review/products/${product.id}/approve`, {
    method: 'POST',
    body: JSON.stringify({ version: submitted.data.product.version }),
  });
  assert.equal(approved.response.status, 200);
  return approved.data.product;
}

test('admin can remove violations and cancel related reservations', async () => {
  const seller = createClient();
  const buyer = createClient();
  const admin = createClient();
  await register(seller, 'admin_seller', 'SELLER');
  await register(buyer, 'admin_buyer', 'BUYER');
  await login(admin, 'admin', 'Admin@12345');

  const product = await publishProduct(seller, admin, '违规测试商品', '99.00');
  const reservation = await buyer('/api/reservations', {
    method: 'POST',
    body: JSON.stringify({ productId: product.id, clientRequestId: 'req-admin-violation-0001', message: '想买' }),
  });
  assert.equal(reservation.response.status, 201);

  const violation = await admin(`/api/admin/products/${product.id}/violation`, {
    method: 'POST',
    body: JSON.stringify({ version: product.version, reason: '商品描述包含违规内容' }),
  });
  assert.equal(violation.response.status, 200);
  assert.equal(violation.data.product.status, 'VIOLATION_REMOVED');

  const reservationAfter = await buyer(`/api/reservations/${reservation.data.reservation.id}`);
  assert.equal(reservationAfter.data.reservation.status, 'CANCELLED');
  assert.match(reservationAfter.data.reservation.closeReason, /违规移除/);

  const hidden = await buyer(`/api/products/${product.id}`);
  assert.equal(hidden.response.status, 404);

  const logs = await admin('/api/admin/logs?actionType=PRODUCT_VIOLATION_REMOVE');
  assert.equal(logs.response.status, 200);
  assert.equal(logs.data.total, 1);
  assert.equal(logs.data.items[0].targetId, product.id);
});

test('admin can disable and enable users, but cannot disable self', async () => {
  const admin = createClient();
  await login(admin, 'admin', 'Admin@12345');
  const users = await admin('/api/admin/users?role=SELLER');
  assert.equal(users.response.status, 200);
  const seller = users.data.items.find((item) => item.account === 'admin_seller');
  assert.ok(seller);

  const self = await admin(`/api/admin/users/1/disable`, { method: 'POST' });
  assert.equal(self.response.status, 400);

  const disabled = await admin(`/api/admin/users/${seller.id}/disable`, { method: 'POST' });
  assert.equal(disabled.response.status, 200);
  assert.equal(disabled.data.user.status, 'DISABLED');

  const enabled = await admin(`/api/admin/users/${seller.id}/enable`, { method: 'POST' });
  assert.equal(enabled.response.status, 200);
  assert.equal(enabled.data.user.status, 'ACTIVE');
});

test('seller and platform stats return consistent counts', async () => {
  const seller = createClient();
  const buyer = createClient();
  const admin = createClient();
  await login(seller, 'admin_seller');
  await login(buyer, 'admin_buyer');
  await login(admin, 'admin', 'Admin@12345');

  const product = await publishProduct(seller, admin, '统计测试商品', '188.00');
  const reservation = await buyer('/api/reservations', {
    method: 'POST',
    body: JSON.stringify({ productId: product.id, clientRequestId: 'req-stats-0001', message: '统计交易' }),
  });
  const confirmed = await seller(`/api/seller/reservations/${reservation.data.reservation.id}/confirm`, {
    method: 'POST',
    body: JSON.stringify({ version: 1 }),
  });
  assert.equal(confirmed.response.status, 200);
  const completed = await seller(`/api/seller/reservations/${reservation.data.reservation.id}/complete`, {
    method: 'POST',
    body: JSON.stringify({ version: confirmed.data.reservation.version }),
  });
  assert.equal(completed.response.status, 200);

  const sellerStats = await seller('/api/stats/seller');
  assert.equal(sellerStats.response.status, 200);
  assert.ok(sellerStats.data.products.SOLD >= 1);
  assert.ok(sellerStats.data.reservations.completed >= 1);
  assert.ok(sellerStats.data.completionRate > 0);

  const platform = await admin('/api/stats/platform');
  assert.equal(platform.response.status, 200);
  assert.ok(platform.data.totals.products >= 1);
  assert.ok(platform.data.totals.completed >= 1);
  assert.ok(Array.isArray(platform.data.dailyCompleted));
});

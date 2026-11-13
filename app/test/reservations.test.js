'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'Admin@12345';
const app = require('../server');
const { db } = require('../db');
const { expireReservations } = require('../reservationUtils');

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

function productPayload(title, price = '100.00') {
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
  assert.equal(submitted.response.status, 200);
  const approved = await admin(`/api/admin/review/products/${product.id}/approve`, {
    method: 'POST',
    body: JSON.stringify({ version: submitted.data.product.version }),
  });
  assert.equal(approved.response.status, 200);
  return approved.data.product;
}

function reservationBody(productId, requestId, message = '希望今天下午交易') {
  return { productId, clientRequestId: requestId, message };
}

test('reservations: multiple pending, idempotent replay, atomic confirm and complete', async () => {
  const seller = createClient();
  const buyer1 = createClient();
  const buyer2 = createClient();
  const admin = createClient();
  await register(seller, 'res_seller', 'SELLER');
  await register(buyer1, 'res_buyer1', 'BUYER');
  await register(buyer2, 'res_buyer2', 'BUYER');
  await login(admin, 'admin', 'Admin@12345');

  const product = await publishProduct(seller, admin, '二手显示器', '666.00');

  const r1 = await buyer1('/api/reservations', {
    method: 'POST',
    body: JSON.stringify(reservationBody(product.id, 'req-res-0001')),
  });
  assert.equal(r1.response.status, 201);
  assert.equal(r1.data.reservation.status, 'PENDING');
  assert.equal(r1.data.reservation.product.status, 'ON_SALE');

  const replay = await buyer1('/api/reservations', {
    method: 'POST',
    body: JSON.stringify(reservationBody(product.id, 'req-res-0001')),
  });
  assert.equal(replay.response.status, 200);
  assert.equal(replay.data.replayed, true);
  assert.equal(replay.data.reservation.id, r1.data.reservation.id);

  const duplicate = await buyer1('/api/reservations', {
    method: 'POST',
    body: JSON.stringify(reservationBody(product.id, 'req-res-0002')),
  });
  assert.equal(duplicate.response.status, 409);

  const r2 = await buyer2('/api/reservations', {
    method: 'POST',
    body: JSON.stringify(reservationBody(product.id, 'req-res-0003')),
  });
  assert.equal(r2.response.status, 201);
  assert.equal(r2.data.reservation.status, 'PENDING');

  const detailForBuyer2 = await buyer2(`/api/products/${product.id}`);
  assert.equal(detailForBuyer2.data.canReserve, false);

  const sellerList = await seller('/api/seller/reservations?status=PENDING');
  assert.equal(sellerList.response.status, 200);
  assert.equal(sellerList.data.total, 2);

  const [confirm1, confirm2] = await Promise.all([
    seller(`/api/seller/reservations/${r1.data.reservation.id}/confirm`, {
      method: 'POST',
      body: JSON.stringify({ version: 1 }),
    }),
    seller(`/api/seller/reservations/${r2.data.reservation.id}/confirm`, {
      method: 'POST',
      body: JSON.stringify({ version: 1 }),
    }),
  ]);
  const successes = [confirm1, confirm2].filter((item) => item.response.status === 200);
  const failures = [confirm1, confirm2].filter((item) => item.response.status === 409);
  assert.equal(successes.length, 1);
  assert.equal(failures.length, 1);
  const winner = successes[0];
  assert.equal(winner.data.reservation.status, 'CONFIRMED');

  const confirmedList = await seller('/api/seller/reservations?status=CONFIRMED');
  assert.equal(confirmedList.data.total, 1);
  const rejectedList = await seller('/api/seller/reservations?status=REJECTED');
  assert.equal(rejectedList.data.total, 1);
  const productAfterConfirm = await buyer1(`/api/products/${product.id}`);
  assert.equal(productAfterConfirm.data.product.status, 'RESERVED');

  const complete = await seller(`/api/seller/reservations/${winner.data.reservation.id}/complete`, {
    method: 'POST',
    body: JSON.stringify({ version: winner.data.reservation.version }),
  });
  assert.equal(complete.response.status, 200);
  assert.equal(complete.data.reservation.status, 'COMPLETED');
  const sold = await buyer1(`/api/products/${product.id}`);
  assert.equal(sold.data.product.status, 'SOLD');
});

test('pending cancel, seller reject and confirmed cancel release the product', async () => {
  const seller = createClient();
  const buyer = createClient();
  const admin = createClient();
  await login(seller, 'res_seller');
  await login(buyer, 'res_buyer1');
  await login(admin, 'admin', 'Admin@12345');

  const p1 = await publishProduct(seller, admin, '二手台灯', '80.00');
  const r1 = await buyer('/api/reservations', {
    method: 'POST',
    body: JSON.stringify(reservationBody(p1.id, 'req-cancel-0001')),
  });
  assert.equal(r1.response.status, 201);
  const cancelPending = await buyer(`/api/reservations/${r1.data.reservation.id}/cancel`, {
    method: 'POST',
    body: JSON.stringify({ version: 1 }),
  });
  assert.equal(cancelPending.response.status, 200);
  assert.equal(cancelPending.data.reservation.status, 'CANCELLED');
  const p1After = await buyer(`/api/products/${p1.id}`);
  assert.equal(p1After.data.product.status, 'ON_SALE');

  const p2 = await publishProduct(seller, admin, '二手书架', '120.00');
  const r2 = await buyer('/api/reservations', {
    method: 'POST',
    body: JSON.stringify(reservationBody(p2.id, 'req-reject-0001')),
  });
  const rejected = await seller(`/api/seller/reservations/${r2.data.reservation.id}/reject`, {
    method: 'POST',
    body: JSON.stringify({ version: 1, reason: '已经有人先确认了' }),
  });
  assert.equal(rejected.response.status, 200);
  assert.equal(rejected.data.reservation.status, 'REJECTED');

  const p3 = await publishProduct(seller, admin, '二手耳机', '220.00');
  const r3 = await buyer('/api/reservations', {
    method: 'POST',
    body: JSON.stringify(reservationBody(p3.id, 'req-confirm-cancel-0001')),
  });
  const confirmed = await seller(`/api/seller/reservations/${r3.data.reservation.id}/confirm`, {
    method: 'POST',
    body: JSON.stringify({ version: 1 }),
  });
  assert.equal(confirmed.response.status, 200);
  const cancelConfirmed = await buyer(`/api/reservations/${r3.data.reservation.id}/cancel`, {
    method: 'POST',
    body: JSON.stringify({ version: 2, reason: '线下验货后决定不买' }),
  });
  assert.equal(cancelConfirmed.response.status, 200);
  assert.equal(cancelConfirmed.data.reservation.status, 'CANCELLED');
  const p3After = await buyer(`/api/products/${p3.id}`);
  assert.equal(p3After.data.product.status, 'ON_SALE');
});

test('expiry job expires pending and confirmed reservations', async () => {
  const seller = createClient();
  const buyer = createClient();
  const admin = createClient();
  await login(seller, 'res_seller');
  await login(buyer, 'res_buyer1');
  await login(admin, 'admin', 'Admin@12345');

  const p1 = await publishProduct(seller, admin, '二手音箱', '300.00');
  const r1 = await buyer('/api/reservations', {
    method: 'POST',
    body: JSON.stringify(reservationBody(p1.id, 'req-expire-0001')),
  });
  db.prepare('UPDATE reservations SET expires_at = ? WHERE id = ?')
    .run('2000-01-01T00:00:00.000Z', r1.data.reservation.id);
  expireReservations();
  const expiredPending = await buyer(`/api/reservations/${r1.data.reservation.id}`);
  assert.equal(expiredPending.data.reservation.status, 'EXPIRED');
  const p1After = await buyer(`/api/products/${p1.id}`);
  assert.equal(p1After.data.product.status, 'ON_SALE');

  const p2 = await publishProduct(seller, admin, '二手打印机', '350.00');
  const r2 = await buyer('/api/reservations', {
    method: 'POST',
    body: JSON.stringify(reservationBody(p2.id, 'req-expire-0002')),
  });
  const confirmed = await seller(`/api/seller/reservations/${r2.data.reservation.id}/confirm`, {
    method: 'POST',
    body: JSON.stringify({ version: 1 }),
  });
  assert.equal(confirmed.response.status, 200);
  db.prepare('UPDATE reservations SET expires_at = ? WHERE id = ?')
    .run('2000-01-01T00:00:00.000Z', r2.data.reservation.id);
  expireReservations();
  const expiredConfirmed = await buyer(`/api/reservations/${r2.data.reservation.id}`);
  assert.equal(expiredConfirmed.data.reservation.status, 'EXPIRED');
  const p2After = await buyer(`/api/products/${p2.id}`);
  assert.equal(p2After.data.product.status, 'ON_SALE');
});

test('editing or delisting a product cancels pending reservations', async () => {
  const seller = createClient();
  const buyer = createClient();
  const admin = createClient();
  await login(seller, 'res_seller');
  await login(buyer, 'res_buyer1');
  await login(admin, 'admin', 'Admin@12345');

  const p1 = await publishProduct(seller, admin, '待编辑商品', '90.00');
  const r1 = await buyer('/api/reservations', {
    method: 'POST',
    body: JSON.stringify(reservationBody(p1.id, 'req-edit-cancel-0001')),
  });
  assert.equal(r1.response.status, 201);
  const edit = await seller(`/api/seller/products/${p1.id}`, {
    method: 'PUT',
    body: JSON.stringify({ ...productPayload('待编辑商品（已改价）', '88.00'), version: p1.version }),
  });
  assert.equal(edit.response.status, 200);
  assert.equal(edit.data.product.status, 'PENDING_REVIEW');
  const cancelled = await buyer(`/api/reservations/${r1.data.reservation.id}`);
  assert.equal(cancelled.data.reservation.status, 'CANCELLED');
  assert.match(cancelled.data.reservation.closeReason, /重新审核/);

  const p2 = await publishProduct(seller, admin, '待下架商品', '70.00');
  const r2 = await buyer('/api/reservations', {
    method: 'POST',
    body: JSON.stringify(reservationBody(p2.id, 'req-delist-cancel-0001')),
  });
  assert.equal(r2.response.status, 201);
  const delist = await seller(`/api/seller/products/${p2.id}/delist`, {
    method: 'POST',
    body: JSON.stringify({ version: p2.version }),
  });
  assert.equal(delist.response.status, 200);
  assert.equal(delist.data.product.status, 'OFF_SHELF');
  const cancelled2 = await buyer(`/api/reservations/${r2.data.reservation.id}`);
  assert.equal(cancelled2.data.reservation.status, 'CANCELLED');
  assert.match(cancelled2.data.reservation.closeReason, /下架/);
});

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
    body: JSON.stringify({
      account,
      password: 'Password123',
      displayName: account,
      role,
    }),
  });
  assert.equal(result.response.status, 201);
  return result.data.user;
}

async function login(request, account, password) {
  const result = await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ account, password }),
  });
  assert.equal(result.response.status, 200);
  return result.data.user;
}

function productPayload(overrides = {}) {
  return {
    title: '九成新机械键盘',
    categoryId: 1,
    price: '299.00',
    condition: 'LIKE_NEW',
    description: '自用机械键盘，功能正常，键帽完整，支持线下验货。',
    imageUrl: '',
    ...overrides,
  };
}

test('product lifecycle: draft, review, publish, re-review, reject, relist', async () => {
  const seller = createClient();
  const buyer = createClient();
  const otherSeller = createClient();
  const admin = createClient();
  await register(seller, 'seller01', 'SELLER');
  await register(buyer, 'buyer02', 'BUYER');
  await register(otherSeller, 'seller02', 'SELLER');
  await login(admin, 'admin', 'Admin@12345');

  const categories = await buyer('/api/categories');
  assert.equal(categories.response.status, 200);
  assert.ok(categories.data.categories.length >= 1);

  const forbiddenCreate = await buyer('/api/seller/products', {
    method: 'POST',
    body: JSON.stringify(productPayload()),
  });
  assert.equal(forbiddenCreate.response.status, 403);

  const zeroPrice = await seller('/api/seller/products', {
    method: 'POST',
    body: JSON.stringify(productPayload({ price: '0' })),
  });
  assert.equal(zeroPrice.response.status, 400);

  const threeDecimals = await seller('/api/seller/products', {
    method: 'POST',
    body: JSON.stringify(productPayload({ price: '12.345' })),
  });
  assert.equal(threeDecimals.response.status, 400);

  const created = await seller('/api/seller/products', {
    method: 'POST',
    body: JSON.stringify(productPayload()),
  });
  assert.equal(created.response.status, 201);
  const productId = created.data.product.id;
  assert.equal(created.data.product.status, 'DRAFT');
  assert.equal(created.data.product.version, 1);

  const hidden = await buyer(`/api/products/${productId}`);
  assert.equal(hidden.response.status, 404);

  const ownerDetail = await seller(`/api/seller/products/${productId}`);
  assert.equal(ownerDetail.response.status, 200);
  assert.equal(ownerDetail.data.product.status, 'DRAFT');

  const otherEdit = await otherSeller(`/api/seller/products/${productId}`, {
    method: 'PUT',
    body: JSON.stringify({ ...productPayload({ price: '199.00' }), version: 1 }),
  });
  assert.equal(otherEdit.response.status, 404);

  const staleUpdate = await seller(`/api/seller/products/${productId}`, {
    method: 'PUT',
    body: JSON.stringify({ ...productPayload({ price: '199.00' }), version: 99 }),
  });
  assert.equal(staleUpdate.response.status, 409);

  const updated = await seller(`/api/seller/products/${productId}`, {
    method: 'PUT',
    body: JSON.stringify({ ...productPayload({ price: '199.00' }), version: 1 }),
  });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.data.product.version, 2);
  assert.equal(updated.data.product.status, 'DRAFT');

  const submitted = await seller(`/api/seller/products/${productId}/submit`, {
    method: 'POST',
    body: JSON.stringify({ version: 2 }),
  });
  assert.equal(submitted.response.status, 200);
  assert.equal(submitted.data.product.status, 'PENDING_REVIEW');
  assert.equal(submitted.data.product.version, 3);

  const pending = await admin('/api/admin/review/products');
  assert.equal(pending.response.status, 200);
  assert.ok(pending.data.items.some((item) => item.id === productId));

  const wrongApprove = await admin(`/api/admin/review/products/${productId}/approve`, {
    method: 'POST',
    body: JSON.stringify({ version: 99 }),
  });
  assert.equal(wrongApprove.response.status, 409);

  const approved = await admin(`/api/admin/review/products/${productId}/approve`, {
    method: 'POST',
    body: JSON.stringify({ version: 3 }),
  });
  assert.equal(approved.response.status, 200);
  assert.equal(approved.data.product.status, 'ON_SALE');
  assert.equal(approved.data.product.version, 4);

  const search = await buyer('/api/products?q=机械键盘');
  assert.equal(search.response.status, 200);
  assert.equal(search.data.total, 1);
  assert.equal(search.data.items[0].id, productId);

  const publicDetail = await buyer(`/api/products/${productId}`);
  assert.equal(publicDetail.response.status, 200);
  assert.equal(publicDetail.data.product.status, 'ON_SALE');

  const editPublished = await seller(`/api/seller/products/${productId}`, {
    method: 'PUT',
    body: JSON.stringify({ ...productPayload({ price: '188.00' }), version: 4 }),
  });
  assert.equal(editPublished.response.status, 200);
  assert.equal(editPublished.data.product.status, 'PENDING_REVIEW');
  assert.equal(editPublished.data.product.version, 5);

  const searchAfterEdit = await buyer('/api/products?q=机械键盘');
  assert.equal(searchAfterEdit.data.total, 0);

  const rejected = await admin(`/api/admin/review/products/${productId}/reject`, {
    method: 'POST',
    body: JSON.stringify({ version: 5, reason: '描述中的联系方式不符合规范' }),
  });
  assert.equal(rejected.response.status, 200);
  assert.equal(rejected.data.product.status, 'REJECTED');
  assert.equal(rejected.data.product.version, 6);

  const editedRejected = await seller(`/api/seller/products/${productId}`, {
    method: 'PUT',
    body: JSON.stringify({ ...productPayload({ description: '自用机械键盘，功能正常，键帽完整，支持线下验货，无联系方式。' }), version: 6 }),
  });
  assert.equal(editedRejected.response.status, 200);
  assert.equal(editedRejected.data.product.status, 'DRAFT');

  const resubmitted = await seller(`/api/seller/products/${productId}/submit`, {
    method: 'POST',
    body: JSON.stringify({ version: 7 }),
  });
  assert.equal(resubmitted.response.status, 200);
  assert.equal(resubmitted.data.product.version, 8);

  const reapproved = await admin(`/api/admin/review/products/${productId}/approve`, {
    method: 'POST',
    body: JSON.stringify({ version: 8 }),
  });
  assert.equal(reapproved.response.status, 200);
  assert.equal(reapproved.data.product.status, 'ON_SALE');

  const delisted = await seller(`/api/seller/products/${productId}/delist`, {
    method: 'POST',
    body: JSON.stringify({ version: 9 }),
  });
  assert.equal(delisted.response.status, 200);
  assert.equal(delisted.data.product.status, 'OFF_SHELF');
  assert.equal(delisted.data.product.version, 10);

  const searchAfterDelist = await buyer('/api/products?q=机械键盘');
  assert.equal(searchAfterDelist.data.total, 0);
});

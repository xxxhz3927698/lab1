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

test('health check works', async () => {
  const request = createClient();
  const { response, data } = await request('/api/health');
  assert.equal(response.status, 200);
  assert.equal(data.ok, true);
});

test('buyer can register, read session and logout', async () => {
  const request = createClient();
  const register = await request('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      account: 'buyer01',
      password: 'Buyer12345',
      displayName: '测试买家',
      contact: '13800000000',
      role: 'BUYER',
    }),
  });
  assert.equal(register.response.status, 201);
  assert.equal(register.data.user.role, 'BUYER');
  assert.doesNotMatch(register.response.headers.getSetCookie()[0], /;\s*Secure/i);
  assert.equal(register.data.user.displayName, '测试买家');

  const me = await request('/api/auth/me');
  assert.equal(me.response.status, 200);
  assert.equal(me.data.user.account, 'buyer01');

  const logout = await request('/api/auth/logout', { method: 'POST' });
  assert.equal(logout.response.status, 200);

  const afterLogout = await request('/api/auth/me');
  assert.equal(afterLogout.response.status, 401);
});

test('duplicate account is rejected and public admin registration is blocked', async () => {
  const request = createClient();
  const duplicate = await request('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      account: 'buyer01',
      password: 'Buyer12345',
      displayName: '重复买家',
      role: 'BUYER',
    }),
  });
  assert.equal(duplicate.response.status, 409);

  const admin = await request('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      account: 'admin2',
      password: 'Admin12345',
      displayName: '假管理员',
      role: 'ADMIN',
    }),
  });
  assert.equal(admin.response.status, 400);
  assert.match(admin.data.error, /管理员/);
});

test('login works for registered user and seeded admin', async () => {
  const buyer = createClient();
  const buyerLogin = await buyer('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ account: 'buyer01', password: 'Buyer12345' }),
  });
  assert.equal(buyerLogin.response.status, 200);

  const admin = createClient();
  const adminLogin = await admin('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ account: 'admin', password: 'Admin@12345' }),
  });
  assert.equal(adminLogin.response.status, 200);
  assert.equal(adminLogin.data.user.role, 'ADMIN');
});

test('wrong password locks account after five failures', async () => {
  const request = createClient();
  const register = await request('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      account: 'lockuser',
      password: 'Lock12345',
      displayName: '锁定测试',
      role: 'BUYER',
    }),
  });
  assert.equal(register.response.status, 201);
  await request('/api/auth/logout', { method: 'POST' });

  for (let i = 0; i < 4; i += 1) {
    const failed = await request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ account: 'lockuser', password: 'Wrong12345' }),
    });
    assert.equal(failed.response.status, 401);
  }
  const locked = await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ account: 'lockuser', password: 'Wrong12345' }),
  });
  assert.equal(locked.response.status, 423);

  const correctButLocked = await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ account: 'lockuser', password: 'Lock12345' }),
  });
  assert.equal(correctButLocked.response.status, 423);
});

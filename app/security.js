'use strict';

const crypto = require('node:crypto');

const SESSION_HOURS = 2;
const MAX_LOGIN_FAILURES = 5;
const LOCK_MINUTES = 15;

function nowIso() {
  return new Date().toISOString();
}

function isoPlusMinutes(minutes) {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

function isoPlusHours(hours) {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, expectedHex) {
  const actual = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHex, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function parseCookies(header = '') {
  const cookies = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function publicUser(row) {
  return {
    id: Number(row.id),
    account: row.account,
    role: row.role,
    displayName: row.display_name,
    contact: row.contact || '',
    status: row.status,
    createdAt: row.created_at,
  };
}

module.exports = {
  SESSION_HOURS,
  MAX_LOGIN_FAILURES,
  LOCK_MINUTES,
  nowIso,
  isoPlusMinutes,
  isoPlusHours,
  randomToken,
  hashToken,
  hashPassword,
  verifyPassword,
  parseCookies,
  publicUser,
};

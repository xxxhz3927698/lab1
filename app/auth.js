'use strict';

const { db } = require('./db');
const {
  SESSION_HOURS,
  hashToken,
  isoPlusHours,
  nowIso,
  parseCookies,
  publicUser,
  randomToken,
} = require('./security');

const COOKIE_NAME = 'sid';

const findSession = db.prepare(`
  SELECT
    s.id AS session_id,
    s.expires_at,
    u.id,
    u.account,
    u.role,
    u.status,
    u.display_name,
    u.contact,
    u.created_at
  FROM sessions s
  JOIN users u ON u.id = s.user_id
  WHERE s.token_hash = ?
    AND s.revoked_at IS NULL
    AND s.expires_at > ?
    AND u.status = 'ACTIVE'
`);

const insertSession = db.prepare(`
  INSERT INTO sessions (user_id, token_hash, expires_at)
  VALUES (?, ?, ?)
`);

const revokeSessionStmt = db.prepare(`
  UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL
`);

function createSession(userId) {
  const token = randomToken();
  const expiresAt = isoPlusHours(SESSION_HOURS);
  insertSession.run(userId, hashToken(token), expiresAt);
  return { token, expiresAt };
}

function revokeSession(sessionId) {
  if (sessionId) revokeSessionStmt.run(nowIso(), sessionId);
}

function setSessionCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_HOURS * 60 * 60 * 1000,
    path: '/',
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

function attachUser(req, _res, next) {
  const cookies = parseCookies(req.headers.cookie || '');
  const token = cookies[COOKIE_NAME];
  if (token) {
    const row = findSession.get(hashToken(token), nowIso());
    if (row) {
      req.sessionId = Number(row.session_id);
      req.user = publicUser(row);
    }
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: '请先登录' });
  }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: '请先登录' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: '没有权限执行此操作' });
    }
    next();
  };
}

module.exports = {
  COOKIE_NAME,
  attachUser,
  requireAuth,
  requireRole,
  createSession,
  revokeSession,
  setSessionCookie,
  clearSessionCookie,
};

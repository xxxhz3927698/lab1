'use strict';

const express = require('express');
const { db, transaction } = require('../db');
const { writeLog, clientIp } = require('../audit');
const {
  createSession,
  revokeSession,
  setSessionCookie,
  clearSessionCookie,
  requireAuth,
} = require('../auth');
const {
  hashPassword,
  verifyPassword,
  nowIso,
  isoPlusMinutes,
  publicUser,
  MAX_LOGIN_FAILURES,
  LOCK_MINUTES,
} = require('../security');
const {
  text,
  validateAccount,
  validatePassword,
  validateDisplayName,
  validateContact,
  validateRole,
  normalizeRole,
} = require('../validation');

const router = express.Router();

function requestId(req) {
  return typeof req.headers['x-request-id'] === 'string'
    ? req.headers['x-request-id'].slice(0, 100)
    : null;
}

function getUserByAccount(account) {
  return db.prepare('SELECT * FROM users WHERE account = ?').get(account);
}

router.post('/register', (req, res, next) => {
  try {
    const body = req.body || {};
    const account = text(body.account).toLowerCase();
    const password = typeof body.password === 'string' ? body.password : '';
    const displayName = text(body.displayName) || account;
    const contact = text(body.contact);
    const role = normalizeRole(body.role);

    const fieldErrors = [
      validateAccount(account),
      validatePassword(password),
      validateDisplayName(displayName),
      validateContact(contact),
      validateRole(role),
    ].filter(Boolean);
    if (fieldErrors.length > 0) {
      return res.status(400).json({ error: fieldErrors[0], fields: fieldErrors });
    }
    if (getUserByAccount(account)) {
      return res.status(409).json({ error: '账号已存在，请更换账号' });
    }

    const { salt, hash } = hashPassword(password);
    const result = transaction(() => {
      const info = db.prepare(`
        INSERT INTO users (account, password_hash, password_salt, role, status, display_name, contact)
        VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?)
      `).run(account, hash, salt, role, displayName, contact);
      const userId = Number(info.lastInsertRowid);
      const session = createSession(userId);
      writeLog({
        actorId: userId,
        actorRole: role,
        actionType: 'REGISTER',
        targetType: 'USER',
        targetId: userId,
        afterState: { account, role, status: 'ACTIVE' },
        requestId: requestId(req),
        ip: clientIp(req),
      });
      return { userId, session };
    });

    const userRow = db.prepare('SELECT * FROM users WHERE id = ?').get(result.userId);
    setSessionCookie(res, result.session.token);
    return res.status(201).json({
      user: publicUser(userRow),
      expiresAt: result.session.expiresAt,
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/login', (req, res, next) => {
  try {
    const body = req.body || {};
    const account = text(body.account).toLowerCase();
    const password = typeof body.password === 'string' ? body.password : '';
    const user = getUserByAccount(account);

    if (!user) {
      return res.status(401).json({ error: '账号或密码错误' });
    }
    if (user.status === 'DISABLED') {
      return res.status(403).json({ error: '账号已被禁用，请联系管理员' });
    }
    if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
      const seconds = Math.max(1, Math.ceil((new Date(user.locked_until).getTime() - Date.now()) / 1000));
      return res.status(423).json({ error: '登录失败次数过多，账号已临时锁定', retryAfterSeconds: seconds });
    }

    if (!verifyPassword(password, user.password_salt, user.password_hash)) {
      const nextAttempts = Number(user.failed_attempts) + 1;
      let lockedUntil = null;
      if (nextAttempts >= MAX_LOGIN_FAILURES) {
        lockedUntil = isoPlusMinutes(LOCK_MINUTES);
      }
      db.prepare(`
        UPDATE users
        SET failed_attempts = ?, locked_until = ?, updated_at = ?
        WHERE id = ?
      `).run(lockedUntil ? 0 : nextAttempts, lockedUntil, nowIso(), user.id);
      writeLog({
        actorId: Number(user.id),
        actorRole: user.role,
        actionType: 'LOGIN_FAILED',
        targetType: 'USER',
        targetId: Number(user.id),
        reason: lockedUntil ? '连续失败达到上限，临时锁定' : '密码错误',
        requestId: requestId(req),
        ip: clientIp(req),
      });
      if (lockedUntil) {
        return res.status(423).json({
          error: `连续登录失败 ${MAX_LOGIN_FAILURES} 次，账号已锁定 ${LOCK_MINUTES} 分钟`,
          retryAfterSeconds: LOCK_MINUTES * 60,
        });
      }
      return res.status(401).json({ error: '账号或密码错误' });
    }

    const session = transaction(() => {
      db.prepare(`
        UPDATE users
        SET failed_attempts = 0, locked_until = NULL, updated_at = ?
        WHERE id = ?
      `).run(nowIso(), user.id);
      const created = createSession(Number(user.id));
      writeLog({
        actorId: Number(user.id),
        actorRole: user.role,
        actionType: 'LOGIN',
        targetType: 'USER',
        targetId: Number(user.id),
        requestId: requestId(req),
        ip: clientIp(req),
      });
      return created;
    });

    setSessionCookie(res, session.token);
    return res.json({
      user: publicUser(user),
      expiresAt: session.expiresAt,
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/logout', (req, res, next) => {
  try {
    if (req.user) {
      revokeSession(req.sessionId);
      writeLog({
        actorId: req.user.id,
        actorRole: req.user.role,
        actionType: 'LOGOUT',
        targetType: 'USER',
        targetId: req.user.id,
        requestId: requestId(req),
        ip: clientIp(req),
      });
    }
    clearSessionCookie(res);
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

router.post('/change-password', requireAuth, (req, res, next) => {
  try {
    const body = req.body || {};
    const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
    const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
    const error = validatePassword(newPassword);
    if (error) {
      return res.status(400).json({ error });
    }
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!user || !verifyPassword(currentPassword, user.password_salt, user.password_hash)) {
      return res.status(401).json({ error: '当前密码错误' });
    }
    if (currentPassword === newPassword) {
      return res.status(400).json({ error: '新密码不能与当前密码相同' });
    }
    const { salt, hash } = hashPassword(newPassword);
    transaction(() => {
      db.prepare(`
        UPDATE users
        SET password_hash = ?, password_salt = ?, updated_at = ?
        WHERE id = ?
      `).run(hash, salt, nowIso(), req.user.id);
      db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
        .run(nowIso(), req.user.id);
      writeLog({
        actorId: req.user.id,
        actorRole: req.user.role,
        actionType: 'CHANGE_PASSWORD',
        targetType: 'USER',
        targetId: req.user.id,
        requestId: requestId(req),
        ip: clientIp(req),
      });
    });
    clearSessionCookie(res);
    return res.json({ ok: true, message: '密码已修改，请重新登录' });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;

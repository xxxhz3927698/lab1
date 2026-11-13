'use strict';

const { db } = require('./db');
const { nowIso } = require('./security');

const insertLog = db.prepare(`
  INSERT INTO operation_logs (
    actor_id, actor_role, action_type, target_type, target_id,
    before_state, after_state, reason, request_id, ip, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

function writeLog({
  actorId = null,
  actorRole = null,
  actionType,
  targetType = null,
  targetId = null,
  beforeState = null,
  afterState = null,
  reason = null,
  requestId = null,
  ip = null,
}) {
  insertLog.run(
    actorId,
    actorRole,
    actionType,
    targetType,
    targetId,
    beforeState == null ? null : JSON.stringify(beforeState),
    afterState == null ? null : JSON.stringify(afterState),
    reason,
    requestId,
    ip,
    nowIso(),
  );
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || null;
}

module.exports = { writeLog, clientIp };

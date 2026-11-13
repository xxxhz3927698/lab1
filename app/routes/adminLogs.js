'use strict';

const express = require('express');
const { db } = require('../db');
const { requireRole } = require('../auth');
const { text } = require('../validation');

const router = express.Router();
router.use(requireRole('ADMIN'));

function parseState(value) {
  if (value == null || value === '') return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function dateBoundary(value, endOfDay = false) {
  const raw = text(value);
  if (!raw) return { value: null };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return { error: '日期格式必须为 YYYY-MM-DD' };
  return { value: `${raw}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z` };
}

function logRow(row) {
  return {
    id: Number(row.id),
    actorId: row.actor_id == null ? null : Number(row.actor_id),
    actorName: row.actor_name || (row.actor_role === 'SYSTEM' ? '系统任务' : '未知用户'),
    actorRole: row.actor_role,
    actionType: row.action_type,
    targetType: row.target_type,
    targetId: row.target_id == null ? null : Number(row.target_id),
    beforeState: parseState(row.before_state),
    afterState: parseState(row.after_state),
    reason: row.reason || '',
    requestId: row.request_id || '',
    ip: row.ip || '',
    createdAt: row.created_at,
  };
}

router.get('/logs', (req, res) => {
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(req.query.pageSize, 10) || 30));
  const offset = (page - 1) * pageSize;
  const actorId = req.query.actorId ? Number(req.query.actorId) : null;
  const targetId = req.query.targetId ? Number(req.query.targetId) : null;
  const actionType = text(req.query.actionType);
  const targetType = text(req.query.targetType).toUpperCase();
  const q = text(req.query.q);
  const from = dateBoundary(req.query.from, false);
  const to = dateBoundary(req.query.to, true);
  if (from.error) return res.status(400).json({ error: from.error });
  if (to.error) return res.status(400).json({ error: to.error });
  if (from.value && to.value && from.value > to.value) {
    return res.status(400).json({ error: '开始日期不能晚于结束日期' });
  }

  const where = [];
  const params = [];
  if (actorId !== null) {
    if (!Number.isInteger(actorId) || actorId <= 0) return res.status(400).json({ error: '操作者编号不合法' });
    where.push('l.actor_id = ?');
    params.push(actorId);
  }
  if (targetId !== null) {
    if (!Number.isInteger(targetId) || targetId <= 0) return res.status(400).json({ error: '目标编号不合法' });
    where.push('l.target_id = ?');
    params.push(targetId);
  }
  if (actionType) {
    where.push('l.action_type = ?');
    params.push(actionType);
  }
  if (targetType) {
    where.push('l.target_type = ?');
    params.push(targetType);
  }
  if (from.value) {
    where.push('l.created_at >= ?');
    params.push(from.value);
  }
  if (to.value) {
    where.push('l.created_at <= ?');
    params.push(to.value);
  }
  if (q) {
    where.push('(l.request_id LIKE ? OR l.reason LIKE ? OR u.account LIKE ? OR u.display_name LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM operation_logs l LEFT JOIN users u ON u.id = l.actor_id
    ${whereSql}
  `).get(...params).count);
  const rows = db.prepare(`
    SELECT l.*, u.display_name AS actor_name, u.account AS actor_account
    FROM operation_logs l
    LEFT JOIN users u ON u.id = l.actor_id
    ${whereSql}
    ORDER BY l.created_at DESC, l.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, pageSize, offset);

  res.json({
    items: rows.map(logRow),
    total,
    page,
    pageSize,
    hasMore: offset + rows.length < total,
  });
});

module.exports = router;

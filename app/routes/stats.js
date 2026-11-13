'use strict';

const express = require('express');
const { db } = require('../db');
const { requireRole } = require('../auth');
const { text } = require('../validation');

const router = express.Router();

function parseRange(query) {
  const now = new Date();
  const defaultFrom = new Date(now.getTime() - 29 * 24 * 60 * 60 * 1000);
  const fromRaw = text(query.from);
  const toRaw = text(query.to);
  const from = fromRaw ? new Date(`${fromRaw}T00:00:00.000Z`) : defaultFrom;
  const to = toRaw ? new Date(`${toRaw}T23:59:59.999Z`) : now;
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return { error: '日期格式必须为 YYYY-MM-DD' };
  }
  if (from.getTime() > to.getTime()) return { error: '开始日期不能晚于结束日期' };
  return {
    fromIso: from.toISOString(),
    toIso: to.toISOString(),
    fromDate: from.toISOString().slice(0, 10),
    toDate: to.toISOString().slice(0, 10),
  };
}

function statusMap(rows) {
  const map = {};
  for (const row of rows) map[row.status] = Number(row.count);
  return map;
}

router.get('/seller', requireRole('SELLER'), (req, res) => {
  const range = parseRange(req.query);
  if (range.error) return res.status(400).json({ error: range.error });
  const sellerId = req.user.id;

  const productStatuses = statusMap(db.prepare(
    'SELECT status, COUNT(*) AS count FROM products WHERE seller_id = ? GROUP BY status',
  ).all(sellerId));
  const reservationsCreated = Number(db.prepare(`
    SELECT COUNT(*) AS count FROM reservations
    WHERE seller_id = ? AND created_at >= ? AND created_at <= ?
  `).get(sellerId, range.fromIso, range.toIso).count);
  const confirmed = Number(db.prepare(`
    SELECT COUNT(*) AS count FROM reservations
    WHERE seller_id = ? AND confirmed_at IS NOT NULL
      AND confirmed_at >= ? AND confirmed_at <= ?
  `).get(sellerId, range.fromIso, range.toIso).count);
  const completed = Number(db.prepare(`
    SELECT COUNT(*) AS count FROM reservations
    WHERE seller_id = ? AND completed_at IS NOT NULL
      AND completed_at >= ? AND completed_at <= ?
  `).get(sellerId, range.fromIso, range.toIso).count);
  const pendingNow = Number(db.prepare(
    "SELECT COUNT(*) AS count FROM reservations WHERE seller_id = ? AND status = 'PENDING'",
  ).get(sellerId).count);
  const completionRate = confirmed === 0 ? 0 : Math.round((completed / confirmed) * 10000) / 100;

  res.json({
    range: { from: range.fromDate, to: range.toDate },
    products: productStatuses,
    reservations: { created: reservationsCreated, confirmed, completed, pendingNow },
    completionRate,
  });
});

router.get('/platform', requireRole('ADMIN'), (req, res) => {
  const range = parseRange(req.query);
  if (range.error) return res.status(400).json({ error: range.error });

  const productStatuses = statusMap(db.prepare(
    'SELECT status, COUNT(*) AS count FROM products GROUP BY status',
  ).all());
  const categories = db.prepare(`
    SELECT c.name, COUNT(p.id) AS count
    FROM categories c LEFT JOIN products p ON p.category_id = c.id
    GROUP BY c.id, c.name ORDER BY c.sort_order, c.id
  `).all().map((row) => ({ name: row.name, count: Number(row.count) }));
  const dailyNewProducts = db.prepare(`
    SELECT substr(created_at, 1, 10) AS date, COUNT(*) AS count
    FROM products
    WHERE created_at >= ? AND created_at <= ?
    GROUP BY substr(created_at, 1, 10)
    ORDER BY date ASC
  `).all(range.fromIso, range.toIso).map((row) => ({ date: row.date, count: Number(row.count) }));
  const dailyCompleted = db.prepare(`
    SELECT substr(completed_at, 1, 10) AS date, COUNT(*) AS count
    FROM reservations
    WHERE status = 'COMPLETED' AND completed_at >= ? AND completed_at <= ?
    GROUP BY substr(completed_at, 1, 10)
    ORDER BY date ASC
  `).all(range.fromIso, range.toIso).map((row) => ({ date: row.date, count: Number(row.count) }));
  const users = db.prepare(`
    SELECT role, status, COUNT(*) AS count FROM users GROUP BY role, status
  `).all().map((row) => ({ role: row.role, status: row.status, count: Number(row.count) }));
  const totals = {
    products: Object.values(productStatuses).reduce((sum, value) => sum + value, 0),
    reservations: Number(db.prepare('SELECT COUNT(*) AS count FROM reservations').get().count),
    completed: Number(db.prepare("SELECT COUNT(*) AS count FROM reservations WHERE status = 'COMPLETED'").get().count),
  };

  res.json({
    range: { from: range.fromDate, to: range.toDate },
    products: productStatuses,
    categories,
    dailyNewProducts,
    dailyCompleted,
    users,
    totals,
  });
});

module.exports = router;

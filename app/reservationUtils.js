'use strict';

const { db, transaction } = require('./db');
const { nowIso } = require('./security');
const { writeLog } = require('./audit');
const { formatPrice } = require('./productUtils');

const RESERVATION_SELECT = `
  SELECT
    r.*,
    p.title AS product_title,
    p.price_cents AS product_price_cents,
    p.status AS product_status,
    p.image_url AS product_image_url,
    b.display_name AS buyer_name,
    s.display_name AS seller_name
  FROM reservations r
  JOIN products p ON p.id = r.product_id
  JOIN users b ON b.id = r.buyer_id
  JOIN users s ON s.id = r.seller_id
`;

function getReservationRow(id) {
  return db.prepare(RESERVATION_SELECT + ' WHERE r.id = ?').get(id);
}

function mapReservation(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    product: {
      id: Number(row.product_id),
      title: row.product_title,
      status: row.product_status,
      imageUrl: row.product_image_url,
      price: row.product_price_cents == null ? null : formatPrice(row.product_price_cents),
    },
    buyer: { id: Number(row.buyer_id), displayName: row.buyer_name },
    seller: { id: Number(row.seller_id), displayName: row.seller_name },
    status: row.status,
    message: row.message || '',
    price: row.price_cents == null ? null : formatPrice(row.price_cents),
    version: Number(row.version),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    confirmedAt: row.confirmed_at,
    completedAt: row.completed_at,
    closedAt: row.closed_at,
    closeReason: row.close_reason || '',
  };
}

function cancelPendingReservationsForProduct(productId, reason, actorId, actorRole, requestId, ip) {
  const now = nowIso();
  const rows = db.prepare(`
    SELECT id, version FROM reservations
    WHERE product_id = ? AND status = 'PENDING'
  `).all(productId);
  if (rows.length === 0) return 0;
  db.prepare(`
    UPDATE reservations
    SET status = 'CANCELLED', closed_at = ?, close_reason = ?,
        version = version + 1
    WHERE product_id = ? AND status = 'PENDING'
  `).run(now, reason, productId);
  writeLog({
    actorId,
    actorRole,
    actionType: 'RESERVATION_CANCEL_BY_PRODUCT',
    targetType: 'PRODUCT',
    targetId: productId,
    beforeState: { pendingCount: rows.length },
    afterState: { pendingCount: 0 },
    reason,
    requestId,
    ip,
  });
  return rows.length;
}

function expireReservations() {
  return transaction(() => {
    const now = nowIso();
    let expired = 0;
    const pending = db.prepare(`
      SELECT id, version FROM reservations
      WHERE status = 'PENDING' AND expires_at <= ?
    `).all(now);
    for (const row of pending) {
      db.prepare(`
        UPDATE reservations
        SET status = 'EXPIRED', closed_at = ?, close_reason = '待确认超时',
            version = version + 1
        WHERE id = ? AND status = 'PENDING' AND expires_at <= ?
      `).run(now, row.id, now);
      writeLog({
        actorId: null,
        actorRole: 'SYSTEM',
        actionType: 'RESERVATION_EXPIRE',
        targetType: 'RESERVATION',
        targetId: Number(row.id),
        beforeState: { status: 'PENDING', version: Number(row.version) },
        afterState: { status: 'EXPIRED', version: Number(row.version) + 1 },
        reason: '待确认超过 24 小时',
      });
      expired += 1;
    }

    const confirmed = db.prepare(`
      SELECT r.id, r.version, r.product_id, p.status AS product_status
      FROM reservations r
      JOIN products p ON p.id = r.product_id
      WHERE r.status = 'CONFIRMED' AND r.expires_at <= ?
    `).all(now);
    for (const row of confirmed) {
      db.prepare(`
        UPDATE reservations
        SET status = 'EXPIRED', closed_at = ?, close_reason = '交易超时未完成',
            version = version + 1
        WHERE id = ? AND status = 'CONFIRMED' AND expires_at <= ?
      `).run(now, row.id, now);
      if (row.product_status === 'RESERVED') {
        db.prepare(`
          UPDATE products
          SET status = 'ON_SALE', version = version + 1, updated_at = ?
          WHERE id = ? AND status = 'RESERVED'
        `).run(now, row.product_id);
      }
      writeLog({
        actorId: null,
        actorRole: 'SYSTEM',
        actionType: 'RESERVATION_EXPIRE',
        targetType: 'RESERVATION',
        targetId: Number(row.id),
        beforeState: { status: 'CONFIRMED', version: Number(row.version) },
        afterState: { status: 'EXPIRED', version: Number(row.version) + 1 },
        reason: '确认后 7 天未完成',
      });
      expired += 1;
    }
    return expired;
  });
}

module.exports = {
  RESERVATION_SELECT,
  getReservationRow,
  mapReservation,
  cancelPendingReservationsForProduct,
  expireReservations,
};

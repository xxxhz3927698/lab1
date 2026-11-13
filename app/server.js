'use strict';

const path = require('node:path');
const express = require('express');
const { db } = require('./db');
const { attachUser } = require('./auth');
const authRoutes = require('./routes/auth');
const catalogRoutes = require('./routes/catalog');
const sellerProductRoutes = require('./routes/sellerProducts');
const sellerReservationRoutes = require('./routes/sellerReservations');
const reservationRoutes = require('./routes/reservations');
const adminReviewRoutes = require('./routes/adminReview');
const adminUsersRoutes = require('./routes/adminUsers');
const adminLogsRoutes = require('./routes/adminLogs');
const adminProductsRoutes = require('./routes/adminProducts');
const statsRoutes = require('./routes/stats');
const { expireReservations } = require('./reservationUtils');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  if (req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
});
app.use(express.json({ limit: '1mb' }));
app.use(attachUser);

app.get('/api/health', (_req, res) => {
  db.prepare('SELECT 1 AS ok').get();
  res.json({ ok: true, service: 'secondhand-trading', time: new Date().toISOString() });
});

app.use('/api/auth', authRoutes);
app.use('/api', catalogRoutes);
app.use('/api/reservations', reservationRoutes);
app.use('/api/seller', sellerProductRoutes);
app.use('/api/seller/reservations', sellerReservationRoutes);
app.use('/api/admin', adminReviewRoutes);
app.use('/api/admin', adminUsersRoutes);
app.use('/api/admin', adminLogsRoutes);
app.use('/api/admin', adminProductsRoutes);
app.use('/api/stats', statsRoutes);

app.use(express.static(path.join(__dirname, 'public'), {
  extensions: ['html'],
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
}));

app.use('/api', (_req, res) => {
  res.status(404).json({ error: '接口不存在' });
});

app.use((error, _req, res, _next) => {
  console.error(error);
  if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
    return res.status(409).json({ error: '数据已存在，请勿重复提交' });
  }
  if (error.type === 'entity.parse.failed') {
    return res.status(400).json({ error: '请求体不是合法 JSON' });
  }
  return res.status(500).json({ error: '服务器内部错误' });
});

if (require.main === module) {
  try {
    expireReservations();
  } catch (error) {
    console.error('启动时处理过期预约失败', error);
  }
  const timer = setInterval(() => {
    try {
      expireReservations();
    } catch (error) {
      console.error('定时处理过期预约失败', error);
    }
  }, 60 * 1000);
  timer.unref?.();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`二手交易平台原型已启动：http://localhost:${PORT}`);
    console.log('登录页：http://localhost:' + PORT + '/login.html');
  });
}

module.exports = app;

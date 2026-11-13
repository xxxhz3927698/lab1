'use strict';

const $ = (selector) => document.querySelector(selector);
const STATUS_LABEL = {
  DRAFT: '草稿',
  PENDING_REVIEW: '待审核',
  ON_SALE: '在售',
  RESERVED: '已预订',
  SOLD: '已售出',
  OFF_SHELF: '已下架',
  REJECTED: '审核未通过',
  VIOLATION_REMOVED: '违规移除',
};
let currentUser = null;
let initialized = false;

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function toast(message, isError = false) {
  const element = $('#toast');
  element.textContent = message;
  element.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { element.className = 'toast'; }, 2800);
}

function showError(message) {
  const box = $('#statsAlert');
  box.textContent = message;
  box.className = message ? 'alert show alert-error' : 'alert';
}

async function api(path) {
  const response = await fetch(path);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || '请求失败');
  return data;
}

function todayIso(offsetDays = 0) {
  const date = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 10);
}

function kpi(label, value, sub = '') {
  return `<article class="kpi-card"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(value)}</div><div class="sub">${escapeHtml(sub)}</div></article>`;
}

function barList(items, { green = false } = {}) {
  if (!items.length) return '<div class="chart-empty">暂无数据</div>';
  const max = Math.max(...items.map((item) => item.value), 1);
  return `<div class="bar-list">${items.map((item) => `
    <div class="bar-row">
      <span class="bar-label" title="${escapeHtml(item.label)}">${escapeHtml(item.label)}</span>
      <div class="bar-track"><div class="bar-fill ${green ? 'green' : ''}" style="width:${Math.max(2, (item.value / max) * 100)}%"></div></div>
      <span class="bar-value">${item.value}</span>
    </div>
  `).join('')}</div>`;
}

function statusItems(map) {
  return Object.entries(map || {}).map(([status, value]) => ({ label: STATUS_LABEL[status] || status, value }));
}

function renderSeller(data) {
  const products = data.products || {};
  const productTotal = Object.values(products).reduce((sum, value) => sum + value, 0);
  const r = data.reservations || {};
  $('#statsRoot').innerHTML = `
    <div class="kpi-grid">
      ${kpi('我的商品', productTotal, '全部状态')}
      ${kpi('待处理预约', r.pendingNow || 0, '当前待确认')}
      ${kpi('区间内已完成', r.completed || 0, '按完成时间统计')}
      ${kpi('成交率', (data.completionRate || 0) + '%', '已完成 ÷ 已确认')}
    </div>
    <div class="chart-grid">
      <section class="card chart-card">
        <h3 class="chart-title">商品状态分布</h3>
        ${barList(statusItems(products))}
      </section>
      <section class="card chart-card">
        <h3 class="chart-title">预约漏斗</h3>
        ${barList([
          { label: '创建预约', value: r.created || 0 },
          { label: '卖家确认', value: r.confirmed || 0 },
          { label: '完成交易', value: r.completed || 0 },
        ], { green: true })}
      </section>
    </div>
    <div class="notice blue" style="margin-top:16px">统计区间：${escapeHtml(data.range.from)} 至 ${escapeHtml(data.range.to)}。商品状态为当前状态；预约创建、确认、完成按对应时间筛选。</div>
  `;
}

function renderAdmin(data) {
  const products = data.products || {};
  const totals = data.totals || {};
  const users = data.users || [];
  const userTotal = users.reduce((sum, item) => sum + item.count, 0);
  const categories = (data.categories || []).map((item) => ({ label: item.name, value: item.count }));
  const daily = (data.dailyNewProducts || []).map((item) => ({ label: item.date.slice(5), value: item.count }));
  const dailyDone = (data.dailyCompleted || []).map((item) => ({ label: item.date.slice(5), value: item.count }));
  $('#statsRoot').innerHTML = `
    <div class="kpi-grid">
      ${kpi('平台商品', totals.products || 0, '全部状态')}
      ${kpi('预约总数', totals.reservations || 0, '历史累计')}
      ${kpi('完成交易', totals.completed || 0, '历史累计')}
      ${kpi('平台账号', userTotal, '买家 / 卖家 / 管理员')}
    </div>
    <div class="chart-grid">
      <section class="card chart-card">
        <h3 class="chart-title">商品状态分布</h3>
        ${barList(statusItems(products))}
      </section>
      <section class="card chart-card">
        <h3 class="chart-title">分类商品数</h3>
        ${barList(categories)}
      </section>
      <section class="card chart-card">
        <h3 class="chart-title">每日新增商品</h3>
        ${barList(daily)}
      </section>
      <section class="card chart-card">
        <h3 class="chart-title">每日完成交易</h3>
        ${barList(dailyDone, { green: true })}
      </section>
    </div>
    <div class="notice blue" style="margin-top:16px">统计区间：${escapeHtml(data.range.from)} 至 ${escapeHtml(data.range.to)}。平台商品与预约总数为累计值，每日数据按统计区间筛选。</div>
  `;
}

async function load() {
  showError('');
  const from = $('#from').value;
  const to = $('#to').value;
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  try {
    if (currentUser.role === 'SELLER') {
      const data = await api('/api/stats/seller?' + params.toString());
      renderSeller(data);
    } else if (currentUser.role === 'ADMIN') {
      const data = await api('/api/stats/platform?' + params.toString());
      renderAdmin(data);
    } else {
      $('#statsRoot').innerHTML = '<div class="card empty"><strong>无统计权限</strong><span>统计看板只对卖家和管理员开放。</span></div>';
    }
  } catch (error) {
    showError(error.message);
    $('#statsRoot').innerHTML = '<div class="card empty"><strong>加载失败</strong><span>请稍后重试。</span></div>';
  }
}

$('#rangeForm').addEventListener('submit', (event) => {
  event.preventDefault();
  load();
});

function init(user) {
  if (initialized) return;
  initialized = true;
  currentUser = user;
  $('#statsRole').textContent = user.role === 'ADMIN' ? '平台统计' : '卖家统计';
  $('#statsSubtitle').textContent = user.role === 'ADMIN'
    ? '查看平台商品状态、分类、每日新增和每日完成交易。'
    : '查看自己的商品状态、预约漏斗和成交率。';
  $('#from').value = todayIso(-29);
  $('#to').value = todayIso(0);
  load();
}
document.addEventListener('app:user-ready', (event) => init(event.detail));
if (window.currentUser) init(window.currentUser);

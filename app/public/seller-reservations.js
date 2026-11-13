(function () {
'use strict';

const $ = (selector) => document.querySelector(selector);
const STATUS = {
  PENDING: ['待确认', 'badge-amber'],
  CONFIRMED: ['已确认', 'badge-blue'],
  COMPLETED: ['已完成', 'badge-green'],
  CANCELLED: ['已取消', 'badge-gray'],
  REJECTED: ['已拒绝', 'badge-red'],
  EXPIRED: ['已过期', 'badge-gray'],
};
let page = 1;
let hasMore = false;
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
  const box = $('#listAlert');
  box.textContent = message;
  box.className = message ? 'alert show alert-error' : 'alert';
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || '请求失败');
  return data;
}

function cardTemplate(reservation) {
  const status = STATUS[reservation.status] || [reservation.status, 'badge-gray'];
  const actions = [];
  if (reservation.status === 'PENDING') {
    actions.push(`<button class="btn btn-primary btn-sm" data-action="confirm" data-id="${reservation.id}" data-version="${reservation.version}">确认预约</button>`);
    actions.push(`<button class="btn btn-danger btn-sm" data-action="reject" data-id="${reservation.id}" data-version="${reservation.version}">拒绝</button>`);
  }
  if (reservation.status === 'CONFIRMED') {
    actions.push(`<button class="btn btn-primary btn-sm" data-action="complete" data-id="${reservation.id}" data-version="${reservation.version}">完成交易</button>`);
    actions.push(`<button class="btn btn-danger btn-sm" data-action="cancel" data-id="${reservation.id}" data-version="${reservation.version}">取消预约</button>`);
  }
  return `
    <article class="review-card">
      <div class="review-head">
        <div>
          <h3><a class="text-link" href="/product.html?id=${reservation.product.id}">${escapeHtml(reservation.product.title)}</a></h3>
          <p>买家 ${escapeHtml(reservation.buyer.displayName)} · 预约编号 #${reservation.id} · 商品编号 #${reservation.product.id}</p>
        </div>
        <span class="badge ${status[1]}">${status[0]}</span>
      </div>
      <div class="review-body" style="grid-template-columns:minmax(0,1fr) 220px">
        <div>
          <p class="review-desc">${escapeHtml(reservation.message || '买家未填写留言')}</p>
          ${reservation.closeReason ? `<div class="notice red" style="margin-top:12px">结束原因：${escapeHtml(reservation.closeReason)}</div>` : ''}
        </div>
        <div>
          <p class="price" style="font-size:22px">${reservation.price ? '¥' + escapeHtml(reservation.price) : '价格未锁定'}</p>
          <p class="hint">创建：${escapeHtml(reservation.createdAt)}</p>
          <p class="hint">截止：${escapeHtml(reservation.expiresAt)}</p>
          <div class="review-actions" style="justify-content:flex-start;flex-wrap:wrap">${actions.join('')}</div>
        </div>
      </div>
    </article>
  `;
}

async function refreshPendingCount() {
  try {
    const data = await api('/api/seller/reservations?status=PENDING&pageSize=1');
    $('#pendingCount').textContent = `${data.total} 条待确认`;
  } catch {
    $('#pendingCount').textContent = '—';
  }
}

async function load() {
  showError('');
  const params = new URLSearchParams({ page: String(page), pageSize: '12' });
  const status = $('#status').value;
  const productId = $('#productId').value.trim();
  if (status) params.set('status', status);
  if (productId) params.set('productId', productId);
  try {
    const data = await api('/api/seller/reservations?' + params.toString());
    hasMore = data.hasMore;
    $('#pageInfo').textContent = data.total === 0 ? '暂无预约' : `第 ${data.page} 页 · 共 ${data.total} 条`;
    $('#prevPage').disabled = page <= 1;
    $('#nextPage').disabled = !data.hasMore;
    $('#sellerReservationList').innerHTML = data.items.length
      ? data.items.map(cardTemplate).join('')
      : '<div class="card empty"><strong>暂无预约</strong><span>商品发布后，买家的购买意向会出现在这里。</span></div>';
    refreshPendingCount();
  } catch (error) {
    showError(error.message);
    $('#sellerReservationList').innerHTML = '<div class="card empty"><strong>加载失败</strong><span>请稍后重试。</span></div>';
  }
}

async function confirmReservation(button) {
  if (!confirm('确认后商品将变为已预订，其他待确认预约会自动拒绝。确定确认吗？')) return;
  button.disabled = true;
  try {
    await api(`/api/seller/reservations/${button.dataset.id}/confirm`, {
      method: 'POST',
      body: JSON.stringify({ version: Number(button.dataset.version) }),
    });
    toast('已确认预约，商品进入已预订');
    load();
  } catch (error) {
    toast(error.message, true);
    button.disabled = false;
  }
}

async function rejectReservation(button) {
  const reason = prompt('拒绝原因（2-200 字）：', '');
  if (reason === null) return;
  if (reason.trim().length < 2) {
    toast('请填写至少 2 个字符的原因', true);
    return;
  }
  button.disabled = true;
  try {
    await api(`/api/seller/reservations/${button.dataset.id}/reject`, {
      method: 'POST',
      body: JSON.stringify({ version: Number(button.dataset.version), reason: reason.trim() }),
    });
    toast('已拒绝预约');
    load();
  } catch (error) {
    toast(error.message, true);
    button.disabled = false;
  }
}

async function completeReservation(button) {
  if (!confirm('确认已完成线下交付和收款？完成后商品将变为已售出，不能撤销。')) return;
  button.disabled = true;
  try {
    await api(`/api/seller/reservations/${button.dataset.id}/complete`, {
      method: 'POST',
      body: JSON.stringify({ version: Number(button.dataset.version) }),
    });
    toast('交易已完成');
    load();
  } catch (error) {
    toast(error.message, true);
    button.disabled = false;
  }
}

async function cancelConfirmed(button) {
  const reason = prompt('取消已确认预约的原因（2-200 字）：', '');
  if (reason === null) return;
  if (reason.trim().length < 2) {
    toast('请填写至少 2 个字符的原因', true);
    return;
  }
  button.disabled = true;
  try {
    await api(`/api/reservations/${button.dataset.id}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ version: Number(button.dataset.version), reason: reason.trim() }),
    });
    toast('已取消预约，商品恢复在售');
    load();
  } catch (error) {
    toast(error.message, true);
    button.disabled = false;
  }
}

$('#filterForm').addEventListener('submit', (event) => {
  event.preventDefault();
  page = 1;
  load();
});
$('#prevPage').addEventListener('click', () => {
  if (page > 1) { page -= 1; load(); }
});
$('#nextPage').addEventListener('click', () => {
  if (hasMore) { page += 1; load(); }
});
$('#sellerReservationList').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  if (action === 'confirm') confirmReservation(button);
  if (action === 'reject') rejectReservation(button);
  if (action === 'complete') completeReservation(button);
  if (action === 'cancel') cancelConfirmed(button);
});

function init(user) {
  if (initialized) return;
  initialized = true;
  if (user.role !== 'SELLER') {
    location.href = '/';
    return;
  }
  const productId = new URLSearchParams(location.search).get('productId');
  if (productId) $('#productId').value = productId;
  load();
}
document.addEventListener('app:user-ready', (event) => init(event.detail));
if (window.currentUser) init(window.currentUser);

})();

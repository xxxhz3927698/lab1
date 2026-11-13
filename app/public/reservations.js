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
  const canCancel = ['PENDING', 'CONFIRMED'].includes(reservation.status);
  const action = canCancel
    ? `<button class="btn btn-danger btn-sm" data-action="cancel" data-id="${reservation.id}" data-version="${reservation.version}" data-status="${reservation.status}">取消预约</button>`
    : '';
  return `
    <article class="review-card">
      <div class="review-head">
        <div>
          <h3><a class="text-link" href="/product.html?id=${reservation.product.id}">${escapeHtml(reservation.product.title)}</a></h3>
          <p>卖家 ${escapeHtml(reservation.seller.displayName)} · 预约编号 #${reservation.id}</p>
        </div>
        <span class="badge ${status[1]}">${status[0]}</span>
      </div>
      <div class="review-body" style="grid-template-columns:minmax(0,1fr) 200px">
        <div>
          <p class="review-desc">${escapeHtml(reservation.message || '未填写预约留言')}</p>
          ${reservation.closeReason ? `<div class="notice red" style="margin-top:12px">结束原因：${escapeHtml(reservation.closeReason)}</div>` : ''}
        </div>
        <div>
          <p class="price" style="font-size:22px">${reservation.price ? '¥' + escapeHtml(reservation.price) : '价格待确认'}</p>
          <p class="hint">创建：${escapeHtml(reservation.createdAt)}</p>
          <p class="hint">截止：${escapeHtml(reservation.expiresAt)}</p>
          <div style="margin-top:12px">${action}</div>
        </div>
      </div>
    </article>
  `;
}

async function load() {
  showError('');
  const params = new URLSearchParams({ page: String(page), pageSize: '12' });
  const status = $('#status').value;
  const q = $('#q').value.trim();
  if (status) params.set('status', status);
  if (q) params.set('q', q);
  try {
    const data = await api('/api/reservations?' + params.toString());
    hasMore = data.hasMore;
    $('#pageInfo').textContent = data.total === 0 ? '还没有预约' : `第 ${data.page} 页 · 共 ${data.total} 条`;
    $('#prevPage').disabled = page <= 1;
    $('#nextPage').disabled = !data.hasMore;
    $('#reservationList').innerHTML = data.items.length
      ? data.items.map(cardTemplate).join('')
      : '<div class="card empty"><strong>还没有预约</strong><span>去商品市场找找感兴趣的闲置吧。</span></div>';
  } catch (error) {
    showError(error.message);
    $('#reservationList').innerHTML = '<div class="card empty"><strong>加载失败</strong><span>请稍后重试。</span></div>';
  }
}

async function cancel(button) {
  const id = button.dataset.id;
  const version = Number(button.dataset.version);
  const status = button.dataset.status;
  let reason = '';
  if (status === 'CONFIRMED') {
    reason = prompt('取消已确认预约需要填写原因（2-200 字）：', '');
    if (reason === null) return;
    if (reason.trim().length < 2) {
      toast('请填写至少 2 个字符的原因', true);
      return;
    }
  } else if (!confirm('确定取消这条待确认预约吗？')) {
    return;
  }
  button.disabled = true;
  try {
    await api(`/api/reservations/${id}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ version, reason: reason.trim() }),
    });
    toast('预约已取消');
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
$('#reservationList').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action="cancel"]');
  if (button) cancel(button);
});

function init(user) {
  if (initialized) return;
  initialized = true;
  if (user.role !== 'BUYER') {
    location.href = '/';
    return;
  }
  load();
}
document.addEventListener('app:user-ready', (event) => init(event.detail));
if (window.currentUser) init(window.currentUser);

})();

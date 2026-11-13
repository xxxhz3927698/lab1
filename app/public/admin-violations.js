'use strict';

const $ = (selector) => document.querySelector(selector);
const STATUS = {
  ON_SALE: ['在售', 'badge-green'],
  RESERVED: ['已预订', 'badge-amber'],
  PENDING_REVIEW: ['待审核', 'badge-amber'],
  DRAFT: ['草稿', 'badge-gray'],
  SOLD: ['已售出', 'badge-gray'],
  OFF_SHELF: ['已下架', 'badge-gray'],
  REJECTED: ['审核未通过', 'badge-red'],
  VIOLATION_REMOVED: ['违规移除', 'badge-red'],
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

function rowTemplate(product) {
  const status = STATUS[product.status] || [product.status, 'badge-gray'];
  return `
    <tr>
      <td><strong>${escapeHtml(product.title)}</strong><div class="hint">#${product.id}</div></td>
      <td>${escapeHtml(product.seller.displayName)}</td>
      <td>${escapeHtml(product.category.name)}</td>
      <td class="price" style="font-size:14px">¥${escapeHtml(product.price)}</td>
      <td><span class="badge ${status[1]}">${status[0]}</span></td>
      <td>${product.version}</td>
      <td><button class="btn btn-danger btn-sm" data-action="violation" data-id="${product.id}" data-version="${product.version}">违规移除</button></td>
    </tr>
  `;
}

async function load() {
  showError('');
  const params = new URLSearchParams({ page: String(page), pageSize: '20' });
  const q = $('#q').value.trim();
  const status = $('#status').value;
  if (q) params.set('q', q);
  if (status) params.set('status', status);
  try {
    const data = await api('/api/admin/products?' + params.toString());
    hasMore = data.hasMore;
    $('#productCount').textContent = `${data.total} 件商品`;
    $('#pageInfo').textContent = data.total === 0 ? '没有符合条件的商品' : `第 ${data.page} 页 · 共 ${data.total} 件`;
    $('#prevPage').disabled = page <= 1;
    $('#nextPage').disabled = !data.hasMore;
    $('#productRows').innerHTML = data.items.length
      ? data.items.map(rowTemplate).join('')
      : '<tr><td colspan="7"><div class="empty">没有符合条件的商品</div></td></tr>';
  } catch (error) {
    showError(error.message);
    $('#productRows').innerHTML = '<tr><td colspan="7"><div class="empty">加载失败</div></td></tr>';
  }
}

async function removeViolation(button) {
  const id = button.dataset.id;
  const version = Number(button.dataset.version);
  const reason = prompt('违规处理理由（2-500 字）：', '');
  if (reason === null) return;
  if (reason.trim().length < 2) {
    toast('请填写至少 2 个字符的理由', true);
    return;
  }
  if (!confirm('确认移除该商品？相关待确认和已确认预约会被取消，操作不可撤销。')) return;
  button.disabled = true;
  try {
    await api(`/api/admin/products/${id}/violation`, {
      method: 'POST',
      body: JSON.stringify({ version, reason: reason.trim() }),
    });
    toast('商品已违规移除，相关预约已取消');
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
$('#productRows').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action="violation"]');
  if (button) removeViolation(button);
});

function init(user) {
  if (initialized) return;
  initialized = true;
  if (user.role !== 'ADMIN') {
    location.href = '/';
    return;
  }
  load();
}
document.addEventListener('app:user-ready', (event) => init(event.detail));
if (window.currentUser) init(window.currentUser);

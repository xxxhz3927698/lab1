'use strict';

const $ = (selector) => document.querySelector(selector);
const STATUS = {
  DRAFT: ['草稿', 'badge-gray'],
  PENDING_REVIEW: ['待审核', 'badge-amber'],
  ON_SALE: ['在售', 'badge-green'],
  RESERVED: ['已预订', 'badge-amber'],
  SOLD: ['已售出', 'badge-gray'],
  OFF_SHELF: ['已下架', 'badge-gray'],
  REJECTED: ['审核未通过', 'badge-red'],
  VIOLATION_REMOVED: ['违规移除', 'badge-red'],
};
let page = 1;
let hasMore = false;
let loading = false;

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

function actions(product) {
  const parts = [];
  if (['DRAFT', 'REJECTED', 'OFF_SHELF', 'ON_SALE'].includes(product.status)) {
    parts.push(`<a class="btn btn-ghost btn-sm" href="/seller/product-edit.html?id=${product.id}">编辑</a>`);
  }
  if (['DRAFT', 'REJECTED'].includes(product.status)) {
    parts.push(`<button class="btn btn-primary btn-sm" data-action="submit" data-id="${product.id}" data-version="${product.version}">提交审核</button>`);
  }
  if (product.status === 'ON_SALE') {
    parts.push(`<button class="btn btn-danger btn-sm" data-action="delist" data-id="${product.id}" data-version="${product.version}">下架</button>`);
  }
  parts.push(`<a class="btn btn-ghost btn-sm" href="/product.html?id=${product.id}">详情</a>`);
  return `<div class="actions">${parts.join('')}</div>`;
}

function rowTemplate(product) {
  const status = STATUS[product.status] || [product.status, 'badge-gray'];
  return `
    <tr>
      <td><strong>${escapeHtml(product.title)}</strong><div class="hint">#${product.id}</div></td>
      <td>${escapeHtml(product.category.name)}</td>
      <td class="price" style="font-size:14px">¥${escapeHtml(product.price)}</td>
      <td><span class="badge ${status[1]}">${status[0]}</span></td>
      <td>${product.pendingReservations > 0 ? `<span class="badge badge-amber">${product.pendingReservations}</span>` : '<span class="status-text">0</span>'}</td>
      <td>${product.version}</td>
      <td class="hint">${escapeHtml(product.updatedAt)}</td>
      <td>${actions(product)}</td>
    </tr>
  `;
}

async function loadProducts() {
  if (loading) return;
  loading = true;
  showError('');
  const button = $('#filterForm button[type="submit"]');
  button.disabled = true;
  button.textContent = '筛选中…';
  const params = new URLSearchParams({ page: String(page), pageSize: '20' });
  const q = $('#q').value.trim();
  const status = $('#status').value;
  if (q) params.set('q', q);
  if (status) params.set('status', status);
  try {
    const data = await api('/api/seller/products?' + params.toString());
    hasMore = data.hasMore;
    $('#pageInfo').textContent = data.total === 0 ? '暂无商品' : `第 ${data.page} 页 · 共 ${data.total} 件`;
    $('#prevPage').disabled = page <= 1;
    $('#nextPage').disabled = !data.hasMore;
    $('#productRows').innerHTML = data.items.length
      ? data.items.map(rowTemplate).join('')
      : '<tr><td colspan="8"><div class="empty"><strong>还没有商品</strong><span>点击右上角“新建商品”开始发布。</span></div></td></tr>';
  } catch (error) {
    showError(error.message);
    $('#productRows').innerHTML = '<tr><td colspan="8"><div class="empty">加载失败</div></td></tr>';
  } finally {
    loading = false;
    button.disabled = false;
    button.textContent = '筛选';
  }
}

async function onTableClick(event) {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const { action, id, version } = button.dataset;
  if (action === 'submit') {
    if (!confirm('提交后商品进入待审核状态，审核期间不能修改。确定提交吗？')) return;
    button.disabled = true;
    try {
      await api(`/api/seller/products/${id}/submit`, {
        method: 'POST',
        body: JSON.stringify({ version: Number(version) }),
      });
      toast('已提交审核');
      loadProducts();
    } catch (error) {
      toast(error.message, true);
      button.disabled = false;
    }
  }
  if (action === 'delist') {
    if (!confirm('下架后商品将从公开市场移除。确定下架吗？')) return;
    button.disabled = true;
    try {
      await api(`/api/seller/products/${id}/delist`, {
        method: 'POST',
        body: JSON.stringify({ version: Number(version) }),
      });
      toast('商品已下架');
      loadProducts();
    } catch (error) {
      toast(error.message, true);
      button.disabled = false;
    }
  }
}

$('#filterForm').addEventListener('submit', (event) => {
  event.preventDefault();
  page = 1;
  loadProducts();
});
$('#prevPage').addEventListener('click', () => {
  if (page > 1) { page -= 1; loadProducts(); }
});
$('#nextPage').addEventListener('click', () => {
  if (hasMore) { page += 1; loadProducts(); }
});
$('#productRows').addEventListener('click', onTableClick);

document.addEventListener('app:user-ready', (event) => {
  if (event.detail.role !== 'SELLER') {
    showError('该页面仅对卖家开放');
    location.href = '/';
    return;
  }
  loadProducts();
});

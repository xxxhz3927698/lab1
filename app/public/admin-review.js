(function () {
'use strict';

const $ = (selector) => document.querySelector(selector);
let page = 1;
let hasMore = false;
let loading = false;
let currentReject = null;
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
  const box = $('#reviewAlert');
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

function cardTemplate(product) {
  const thumb = product.imageUrl
    ? `<img src="${escapeHtml(product.imageUrl)}" alt="">`
    : '<span>▧</span>';
  return `
    <article class="review-card" data-id="${product.id}" data-version="${product.version}">
      <div class="review-head">
        <div>
          <h3>${escapeHtml(product.title)}</h3>
          <p>卖家 ${escapeHtml(product.seller.displayName)} · ${escapeHtml(product.category.name)} · 版本 ${product.version}</p>
        </div>
        <span class="badge badge-amber">待审核</span>
      </div>
      <div class="review-body">
        <div class="review-thumb">${thumb}</div>
        <div>
          <div class="tag-row">
            <span class="price" style="font-size:22px">¥${escapeHtml(product.price)}</span>
            <span class="badge badge-gray">${escapeHtml(product.condition)}</span>
          </div>
          <p class="review-desc">${escapeHtml(product.description)}</p>
          <p class="hint">提交时间：${escapeHtml(product.updatedAt)} · 商品编号 #${product.id}</p>
        </div>
      </div>
      <div class="review-actions">
        <button class="btn btn-danger" type="button" data-action="reject">驳回</button>
        <button class="btn btn-primary" type="button" data-action="approve">审核通过</button>
      </div>
    </article>
  `;
}

async function loadPending() {
  if (loading) return;
  loading = true;
  showError('');
  const button = $('#filterForm button[type="submit"]');
  button.disabled = true;
  button.textContent = '查询中…';
  const params = new URLSearchParams({ page: String(page), pageSize: '12' });
  const q = $('#q').value.trim();
  if (q) params.set('q', q);
  try {
    const data = await api('/api/admin/review/products?' + params.toString());
    hasMore = data.hasMore;
    $('#pendingCount').textContent = `${data.total} 件待审核`;
    $('#pageInfo').textContent = data.total === 0 ? '没有待审核商品' : `第 ${data.page} 页 · 共 ${data.total} 件`;
    $('#prevPage').disabled = page <= 1;
    $('#nextPage').disabled = !data.hasMore;
    $('#reviewList').innerHTML = data.items.length
      ? data.items.map(cardTemplate).join('')
      : '<div class="card empty"><strong>审核队列为空</strong><span>当前没有待审核商品。</span></div>';
  } catch (error) {
    showError(error.message);
    $('#reviewList').innerHTML = '<div class="card empty"><strong>加载失败</strong><span>请稍后重试。</span></div>';
  } finally {
    loading = false;
    button.disabled = false;
    button.textContent = '查询';
  }
}

async function approve(card, button) {
  const id = card.dataset.id;
  const version = Number(card.dataset.version);
  if (!confirm('确认通过审核？通过后商品会立即出现在公开市场。')) return;
  button.disabled = true;
  try {
    await api(`/api/admin/review/products/${id}/approve`, {
      method: 'POST',
      body: JSON.stringify({ version }),
    });
    toast('审核通过');
    loadPending();
  } catch (error) {
    toast(error.message, true);
    button.disabled = false;
  }
}

function openReject(card) {
  currentReject = { id: card.dataset.id, version: Number(card.dataset.version) };
  $('#rejectReason').value = '';
  $('#rejectModal').classList.add('show');
  setTimeout(() => $('#rejectReason').focus(), 50);
}

function closeReject() {
  currentReject = null;
  $('#rejectModal').classList.remove('show');
}

async function reject() {
  if (!currentReject) return;
  const reason = $('#rejectReason').value.trim();
  if (reason.length < 2) {
    toast('请填写至少 2 个字符的驳回理由', true);
    return;
  }
  const button = $('#confirmReject');
  button.disabled = true;
  button.textContent = '提交中…';
  try {
    await api(`/api/admin/review/products/${currentReject.id}/reject`, {
      method: 'POST',
      body: JSON.stringify({ version: currentReject.version, reason }),
    });
    closeReject();
    toast('已驳回并通知卖家查看理由');
    loadPending();
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = '确认驳回';
  }
}

$('#filterForm').addEventListener('submit', (event) => {
  event.preventDefault();
  page = 1;
  loadPending();
});
$('#prevPage').addEventListener('click', () => {
  if (page > 1) { page -= 1; loadPending(); }
});
$('#nextPage').addEventListener('click', () => {
  if (hasMore) { page += 1; loadPending(); }
});
$('#reviewList').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const card = button.closest('.review-card');
  if (!card) return;
  if (button.dataset.action === 'approve') approve(card, button);
  if (button.dataset.action === 'reject') openReject(card);
});
$('#closeModal').addEventListener('click', closeReject);
$('#cancelReject').addEventListener('click', closeReject);
$('#confirmReject').addEventListener('click', reject);
$('#rejectModal').addEventListener('click', (event) => {
  if (event.target === $('#rejectModal')) closeReject();
});

function init(user) {
  if (initialized) return;
  initialized = true;
  if (user.role !== 'ADMIN') {
    location.href = '/';
    return;
  }
  loadPending();
}
document.addEventListener('app:user-ready', (event) => init(event.detail));
if (window.currentUser) init(window.currentUser);

})();

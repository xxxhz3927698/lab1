(function () {
'use strict';

const $ = (selector) => document.querySelector(selector);
const CONDITION_LABELS = { NEW: '全新', LIKE_NEW: '几乎全新', GOOD: '成色良好', FAIR: '有使用痕迹' };
const STATUS_LABELS = {
  ON_SALE: ['在售', 'badge-green'],
  RESERVED: ['已预订', 'badge-amber'],
  SOLD: ['已售出', 'badge-gray'],
};
let page = 1;
let pageSize = 12;
let hasMore = false;
let total = 0;
let loading = false;

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function showError(message) {
  const box = $('#marketAlert');
  box.textContent = message;
  box.className = message ? 'alert show alert-error' : 'alert';
}

async function api(path) {
  const response = await fetch(path);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || '请求失败');
  return data;
}

async function loadCategories() {
  try {
    const data = await api('/api/categories');
    const select = $('#categoryId');
    for (const category of data.categories) {
      const option = document.createElement('option');
      option.value = String(category.id);
      option.textContent = category.name;
      select.append(option);
    }
  } catch (error) {
    showError(error.message);
  }
}

function cardTemplate(product) {
  const status = STATUS_LABELS[product.status] || [product.status, 'badge-gray'];
  const cover = product.imageUrl
    ? `<img src="${escapeHtml(product.imageUrl)}" alt="" loading="lazy">`
    : '<span>▧</span>';
  return `
    <article class="product-card">
      <div class="product-cover">${cover}</div>
      <div class="product-body">
        <div class="product-meta"><span>${escapeHtml(product.category.name)}</span><span class="badge ${status[1]}">${status[0]}</span></div>
        <h3 class="product-title"><a href="/product.html?id=${product.id}">${escapeHtml(product.title)}</a></h3>
        <p class="hint" style="margin:8px 0 0;min-height:18px">${escapeHtml(CONDITION_LABELS[product.condition] || product.condition)} · 卖家 ${escapeHtml(product.seller.displayName)}</p>
        <div class="product-foot">
          <span class="price">¥${escapeHtml(product.price)}</span>
          <a class="btn btn-ghost btn-sm" href="/product.html?id=${product.id}">查看详情</a>
        </div>
      </div>
    </article>
  `;
}

async function loadProducts() {
  if (loading) return;
  loading = true;
  showError('');
  const button = $('#filterForm button[type="submit"]');
  button.disabled = true;
  button.textContent = '查询中…';
  const params = new URLSearchParams();
  const q = $('#q').value.trim();
  const categoryId = $('#categoryId').value;
  const minPrice = $('#minPrice').value.trim();
  const maxPrice = $('#maxPrice').value.trim();
  const status = $('#status').value;
  const sort = $('#sort').value;
  if (q) params.set('q', q);
  if (categoryId) params.set('categoryId', categoryId);
  if (minPrice) params.set('minPrice', minPrice);
  if (maxPrice) params.set('maxPrice', maxPrice);
  if (status) params.set('status', status);
  if (sort) params.set('sort', sort);
  params.set('page', String(page));
  params.set('pageSize', String(pageSize));

  try {
    const data = await api('/api/products?' + params.toString());
    total = data.total;
    hasMore = data.hasMore;
    $('#marketCount').textContent = `${data.total} 件商品`;
    $('#pageInfo').textContent = data.total === 0
      ? '暂无商品'
      : `第 ${data.page} 页 · 共 ${data.total} 件`;
    $('#prevPage').disabled = page <= 1;
    $('#nextPage').disabled = !data.hasMore;
    const grid = $('#productGrid');
    grid.innerHTML = data.items.length
      ? data.items.map(cardTemplate).join('')
      : '<div class="card empty product-empty"><strong>没有找到商品</strong><span>试试更换关键词、价格区间或分类。</span></div>';
  } catch (error) {
    showError(error.message);
    $('#productGrid').innerHTML = '<div class="card empty product-empty"><strong>加载失败</strong><span>请稍后重试。</span></div>';
  } finally {
    loading = false;
    button.disabled = false;
    button.textContent = '查询';
  }
}

$('#filterForm').addEventListener('submit', (event) => {
  event.preventDefault();
  page = 1;
  loadProducts();
});
$('#prevPage').addEventListener('click', () => {
  if (page > 1) {
    page -= 1;
    loadProducts();
  }
});
$('#nextPage').addEventListener('click', () => {
  if (hasMore) {
    page += 1;
    loadProducts();
  }
});

loadCategories().then(loadProducts);

})();

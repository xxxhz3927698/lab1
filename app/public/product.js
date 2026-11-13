(function () {
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
const CONDITION = { NEW: '全新', LIKE_NEW: '几乎全新', GOOD: '成色良好', FAIR: '有使用痕迹' };

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function showError(message) {
  const box = $('#detailAlert');
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

function render(product, canReserve, viewer, activeReservationId) {
  const status = STATUS[product.status] || [product.status, 'badge-gray'];
  $('#productTitle').textContent = product.title;
  $('#productSubtitle').textContent = `${product.category.name} · ${CONDITION[product.condition] || product.condition} · 卖家 ${product.seller.displayName}`;
  const badge = $('#statusBadge');
  badge.textContent = status[0];
  badge.className = `badge ${status[1]}`;
  document.title = `${product.title} · 校园二手`;

  const cover = product.imageUrl
    ? `<img src="${escapeHtml(product.imageUrl)}" alt="${escapeHtml(product.title)}">`
    : '<span>▧</span>';

  let action = '';
  if (canReserve) {
    action = `
      <div class="field" style="margin-top:14px">
        <label for="reserveMessage">预约留言（选填，最多 200 字）</label>
        <textarea id="reserveMessage" rows="3" maxlength="200" placeholder="例如：希望今天下午在图书馆门口交易"></textarea>
      </div>
      <button class="btn btn-primary btn-block" type="button" id="reserveButton">发起预约</button>
      <div class="notice blue" style="margin-top:10px">预约后商品仍保持在售；卖家确认后商品才变为已预订。预约不代表付款。</div>
    `;
  } else if (activeReservationId) {
    action = `<div class="notice blue">你已经有一条进行中的预约。<a class="text-link" href="/reservations.html">查看我的预约</a></div>`;
  } else if (product.status === 'ON_SALE') {
    action = '<div class="notice">当前账号不能对该商品发起预约。买家只能预约非本人发布的在售商品。</div>';
  } else if (product.status === 'RESERVED') {
    action = '<div class="notice">该商品已被其他买家预订，暂时不能发起新的预约。</div>';
  } else if (product.status === 'SOLD') {
    action = '<div class="notice">该商品已完成交易，不能再次预约。</div>';
  } else {
    action = `<div class="notice red">当前商品状态为“${status[0]}”，不对买家开放预约。</div>`;
  }

  const ownerActions = viewer && viewer.role === 'SELLER' && viewer.id === product.sellerId
    ? `<a class="btn btn-ghost btn-block" href="/seller/product-edit.html?id=${product.id}">编辑商品</a>`
    : '';
  const adminActions = viewer && viewer.role === 'ADMIN'
    ? '<a class="btn btn-ghost btn-block" href="/admin/review.html">进入审核后台</a>'
    : '';

  $('#detailRoot').innerHTML = `
    <div class="detail-layout">
      <section>
        <div class="detail-cover">${cover}</div>
        <div class="card card-pad">
          <div class="detail-meta">
            <span class="badge ${status[1]}">${status[0]}</span>
            <span class="badge badge-blue">${escapeHtml(product.category.name)}</span>
            <span class="badge badge-gray">${escapeHtml(CONDITION[product.condition] || product.condition)}</span>
            <span class="status-text">商品编号 #${product.id} · 版本 ${product.version}</span>
          </div>
          <h2 class="detail-title">${escapeHtml(product.title)}</h2>
          <p class="price">¥${escapeHtml(product.price)}</p>
          <p class="detail-desc">${escapeHtml(product.description)}</p>
          ${product.reviewReason ? `<div class="notice red" style="margin-top:16px"><strong>审核意见：</strong>${escapeHtml(product.reviewReason)}</div>` : ''}
        </div>
      </section>
      <aside>
        <div class="reserve-box">
          <h3>交易信息</h3>
          <p class="price" style="margin:0 0 8px">¥${escapeHtml(product.price)}</p>
          <p class="hint">价格为商品信息，实际交易在线下完成。平台不处理支付、担保或退款。</p>
          <div style="display:grid;gap:9px;margin-top:16px">
            ${action}
            ${ownerActions}
            ${adminActions}
          </div>
        </div>
        <div class="card card-pad">
          <div class="card-head"><div><h3>卖家</h3><p>商品发布者</p></div></div>
          <div class="seller-box">
            <span class="avatar">${escapeHtml((product.seller.displayName || '?').slice(0, 1).toUpperCase())}</span>
            <div><strong>${escapeHtml(product.seller.displayName)}</strong><small>账号 ${escapeHtml(product.seller.account)}</small></div>
          </div>
          <div class="notice" style="margin-top:14px">联系方式在预约确认后按线下交易流程提供；公开页面不展示完整联系方式。</div>
        </div>
        <div class="card card-pad">
          <div class="card-head"><div><h3>状态记录</h3><p>关键时间</p></div></div>
          <p class="hint">创建：${escapeHtml(product.createdAt)}</p>
          <p class="hint">更新时间：${escapeHtml(product.updatedAt)}</p>
          <p class="hint">发布时间：${escapeHtml(product.publishedAt || '未发布')}</p>
          <p class="hint">成交时间：${escapeHtml(product.soldAt || '未成交')}</p>
        </div>
      </aside>
    </div>
  `;
  const reserveButton = document.querySelector('#reserveButton');
  if (reserveButton) {
    reserveButton.addEventListener('click', async () => {
      const message = document.querySelector('#reserveMessage')?.value.trim() || '';
      const clientRequestId = (crypto.randomUUID && crypto.randomUUID()) || `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      reserveButton.disabled = true;
      reserveButton.textContent = '提交中…';
      try {
        await api('/api/reservations', {
          method: 'POST',
          body: JSON.stringify({ productId: product.id, message, clientRequestId }),
        });
        toast('预约已提交，等待卖家确认');
        setTimeout(() => { location.href = '/reservations.html'; }, 700);
      } catch (error) {
        toast(error.message, true);
        reserveButton.disabled = false;
        reserveButton.textContent = '发起预约';
      }
    });
  }
}

function toast(message, isError = false) {
  const element = document.querySelector('#toast');
  element.textContent = message;
  element.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { element.className = 'toast'; }, 2600);
}

async function load() {
  const id = Number(new URLSearchParams(location.search).get('id'));
  if (!Number.isInteger(id) || id <= 0) {
    showError('商品编号不合法');
    return;
  }
  try {
    const data = await api(`/api/products/${id}`);
    render(data.product, data.canReserve, data.viewer, data.activeReservationId);
  } catch (error) {
    showError(error.message);
    $('#detailRoot').innerHTML = '<div class="card empty"><strong>商品不可见</strong><span>商品可能不存在、已下架或已违规移除。</span></div>';
  }
}

load();

})();

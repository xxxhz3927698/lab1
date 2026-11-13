'use strict';

const $ = (selector) => document.querySelector(selector);
const ROLE = { BUYER: '买家', SELLER: '卖家', ADMIN: '管理员' };
let page = 1;
let hasMore = false;
let initialized = false;
let currentUser = null;

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

function rowTemplate(user) {
  const isSelf = currentUser && currentUser.id === user.id;
  const statusBadge = user.status === 'ACTIVE'
    ? '<span class="badge badge-green">正常</span>'
    : '<span class="badge badge-red">已禁用</span>';
  const action = isSelf
    ? '<span class="status-text">当前账号</span>'
    : user.status === 'ACTIVE'
      ? `<button class="btn btn-danger btn-sm" data-action="disable" data-id="${user.id}">禁用</button>`
      : `<button class="btn btn-primary btn-sm" data-action="enable" data-id="${user.id}">启用</button>`;
  return `
    <tr>
      <td><strong>${escapeHtml(user.account)}</strong><div class="hint">#${user.id}</div></td>
      <td>${escapeHtml(user.displayName)}</td>
      <td>${escapeHtml(ROLE[user.role] || user.role)}</td>
      <td>${statusBadge}</td>
      <td>${user.productCount}</td>
      <td class="hint">${escapeHtml(user.createdAt)}</td>
      <td>${action}</td>
    </tr>
  `;
}

async function load() {
  showError('');
  const params = new URLSearchParams({ page: String(page), pageSize: '20' });
  const q = $('#q').value.trim();
  const role = $('#role').value;
  const status = $('#status').value;
  if (q) params.set('q', q);
  if (role) params.set('role', role);
  if (status) params.set('status', status);
  try {
    const data = await api('/api/admin/users?' + params.toString());
    hasMore = data.hasMore;
    $('#userCount').textContent = `${data.total} 个账号`;
    $('#pageInfo').textContent = data.total === 0 ? '暂无账号' : `第 ${data.page} 页 · 共 ${data.total} 个`;
    $('#prevPage').disabled = page <= 1;
    $('#nextPage').disabled = !data.hasMore;
    $('#userRows').innerHTML = data.items.length
      ? data.items.map(rowTemplate).join('')
      : '<tr><td colspan="7"><div class="empty">没有符合条件的账号</div></td></tr>';
  } catch (error) {
    showError(error.message);
    $('#userRows').innerHTML = '<tr><td colspan="7"><div class="empty">加载失败</div></td></tr>';
  }
}

async function act(button) {
  const id = button.dataset.id;
  const action = button.dataset.action;
  const verb = action === 'disable' ? '禁用' : '启用';
  if (!confirm(`确定${verb}该账号吗？`)) return;
  button.disabled = true;
  try {
    await api(`/api/admin/users/${id}/${action}`, { method: 'POST' });
    toast(`已${verb}账号`);
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
$('#userRows').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  if (button) act(button);
});

function init(user) {
  if (initialized) return;
  initialized = true;
  if (user.role !== 'ADMIN') {
    location.href = '/';
    return;
  }
  currentUser = user;
  load();
}
document.addEventListener('app:user-ready', (event) => init(event.detail));
if (window.currentUser) init(window.currentUser);

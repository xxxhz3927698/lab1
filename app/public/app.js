'use strict';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const toast = $('#toast');
const ROLE_LABELS = { BUYER: '买家', SELLER: '卖家', ADMIN: '管理员' };

let currentUser = null;

function showToast(message, isError = false) {
  toast.textContent = message;
  toast.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.className = 'toast'; }, 2600);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || '请求失败');
    error.status = response.status;
    throw error;
  }
  return data;
}

function applyRoleVisibility(user) {
  for (const element of $$('[data-role]')) {
    const allowed = element.dataset.role.split(/\s+/).filter(Boolean);
    element.style.display = allowed.includes(user.role) ? '' : 'none';
  }
}

function renderUser(user) {
  currentUser = user;
  const role = ROLE_LABELS[user.role] || user.role;
  $('#displayName').textContent = user.displayName;
  $('#roleLabel').textContent = role;
  $('#avatar').textContent = (user.displayName || user.account || '?').slice(0, 1).toUpperCase();
  $('#welcome').textContent = `欢迎回来，${user.displayName}`;
  $('#statRole').textContent = role;
  $('#statStatus').textContent = user.status === 'ACTIVE' ? '正常' : '已禁用';
  applyRoleVisibility(user);
}

async function loadSession() {
  try {
    const data = await api('/api/auth/me');
    renderUser(data.user);
  } catch (error) {
    if (error.status === 401) {
      location.href = '/login.html';
      return;
    }
    showToast(error.message, true);
  }
}

async function logout() {
  const button = $('#logoutButton');
  button.disabled = true;
  button.textContent = '退出中…';
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch {
    // The local session is cleared by the server; redirect regardless.
  }
  location.href = '/login.html';
}

for (const link of $$('a[data-soon]')) {
  link.addEventListener('click', (event) => {
    event.preventDefault();
    showToast('该模块将在下一步接入');
  });
}

$('#logoutButton').addEventListener('click', logout);
loadSession();

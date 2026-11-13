(function () {
'use strict';

const $ = (selector) => document.querySelector(selector);
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

async function api(path) {
  const response = await fetch(path);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || '请求失败');
  return data;
}

function stateText(before, after) {
  if (before && after && typeof before === 'object' && typeof after === 'object') {
    if (before.status || after.status) {
      return `${before.status || '—'} → ${after.status || '—'}`;
    }
  }
  const text = [before, after].filter(Boolean).map((item) => JSON.stringify(item)).join(' → ');
  return text.length > 100 ? text.slice(0, 100) + '…' : text || '—';
}

function rowTemplate(log) {
  return `
    <tr>
      <td class="hint">${escapeHtml(log.createdAt)}</td>
      <td><strong>${escapeHtml(log.actorName)}</strong><div class="hint">${escapeHtml(log.actorRole || '')}</div></td>
      <td><code>${escapeHtml(log.actionType)}</code></td>
      <td>${escapeHtml(log.targetType || '—')}<div class="hint">${log.targetId == null ? '—' : '#' + log.targetId}</div></td>
      <td class="hint">${escapeHtml(stateText(log.beforeState, log.afterState))}</td>
      <td class="hint">${escapeHtml(log.reason || '—')}</td>
      <td class="hint">${escapeHtml(log.requestId || '—')}<div>${escapeHtml(log.ip || '')}</div></td>
    </tr>
  `;
}

async function load() {
  showError('');
  const params = new URLSearchParams({ page: String(page), pageSize: '30' });
  for (const [key, id] of [['actorId', 'actorId'], ['targetId', 'targetId'], ['q', 'q'], ['from', 'from'], ['to', 'to'], ['actionType', 'actionType'], ['targetType', 'targetType']]) {
    const value = $('#' + id).value.trim();
    if (value) params.set(key, value);
  }
  try {
    const data = await api('/api/admin/logs?' + params.toString());
    hasMore = data.hasMore;
    $('#logCount').textContent = `${data.total} 条日志`;
    $('#pageInfo').textContent = data.total === 0 ? '暂无日志' : `第 ${data.page} 页 · 共 ${data.total} 条`;
    $('#prevPage').disabled = page <= 1;
    $('#nextPage').disabled = !data.hasMore;
    $('#logRows').innerHTML = data.items.length
      ? data.items.map(rowTemplate).join('')
      : '<tr><td colspan="7"><div class="empty">没有符合条件的日志</div></td></tr>';
  } catch (error) {
    showError(error.message);
    $('#logRows').innerHTML = '<tr><td colspan="7"><div class="empty">加载失败</div></td></tr>';
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

})();

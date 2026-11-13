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
let product = null;
let initialized = false;

function toast(message, isError = false) {
  const element = $('#toast');
  element.textContent = message;
  element.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { element.className = 'toast'; }, 2800);
}

function showAlert(message) {
  const box = $('#editAlert');
  box.textContent = message;
  box.className = message ? 'alert show alert-error' : 'alert';
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || '请求失败');
    error.data = data;
    error.status = response.status;
    throw error;
  }
  return data;
}

async function loadCategories() {
  const data = await api('/api/categories');
  const select = $('#categoryId');
  for (const category of data.categories) {
    const option = document.createElement('option');
    option.value = String(category.id);
    option.textContent = category.name;
    select.append(option);
  }
}

function setStatusBadge(status) {
  const item = STATUS[status] || [status, 'badge-gray'];
  const badge = $('#editStatus');
  badge.textContent = item[0];
  badge.className = `badge ${item[1]}`;
}

function fillProduct(data) {
  product = data.product;
  $('#productId').value = String(product.id);
  $('#version').value = String(product.version);
  $('#title').value = product.title;
  $('#categoryId').value = String(product.category.id);
  $('#price').value = product.price;
  $('#condition').value = product.condition;
  $('#imageUrl').value = product.imageUrl || '';
  $('#description').value = product.description;
  $('#pageTitle').textContent = '编辑商品';
  $('#pageSubtitle').textContent = `商品编号 #${product.id} · 当前版本 ${product.version}`;
  setStatusBadge(product.status);
  if (product.reviewReason) {
    const notice = $('#reviewNotice');
    notice.style.display = 'block';
    notice.textContent = `上次审核意见：${product.reviewReason}`;
  }

  if (product.status === 'ON_SALE') {
    $('#editNotice').style.display = 'block';
    $('#editNotice').textContent = '这是已发布商品。保存关键字段后会进入待审核状态，审核期间从公开市场暂时移除。';
    $('#saveButton').textContent = '保存并重新审核';
    $('#saveSubmitButton').style.display = 'none';
  } else if (['DRAFT', 'REJECTED', 'OFF_SHELF'].includes(product.status)) {
    $('#saveButton').textContent = '保存修改';
    $('#saveSubmitButton').style.display = '';
  } else {
    const notice = $('#editNotice');
    notice.style.display = 'block';
    notice.textContent = `当前状态为“${STATUS[product.status]?.[0] || product.status}”，该状态不允许修改商品。`;
    for (const element of document.querySelectorAll('#productForm input, #productForm select, #productForm textarea, #productForm button')) {
      element.disabled = true;
    }
  }
}

function payload() {
  return {
    title: $('#title').value.trim(),
    categoryId: Number($('#categoryId').value),
    price: $('#price').value.trim(),
    condition: $('#condition').value,
    imageUrl: $('#imageUrl').value.trim(),
    description: $('#description').value.trim(),
    version: $('#version').value ? Number($('#version').value) : undefined,
  };
}

function setBusy(busy) {
  $('#saveButton').disabled = busy;
  $('#saveSubmitButton').disabled = busy;
  $('#saveButton').textContent = busy ? '保存中…' : ($('#productId').value ? '保存修改' : '保存草稿');
}

async function save(submitAfter) {
  showAlert('');
  const id = $('#productId').value ? Number($('#productId').value) : null;
  const body = payload();
  setBusy(true);
  try {
    let saved;
    if (id) {
      saved = await api(`/api/seller/products/${id}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      });
    } else {
      saved = await api('/api/seller/products', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    }
    const current = saved.product;
    $('#productId').value = String(current.id);
    $('#version').value = String(current.version);
    setStatusBadge(current.status);

    if (submitAfter) {
      if (['DRAFT', 'REJECTED'].includes(current.status)) {
        const submitted = await api(`/api/seller/products/${current.id}/submit`, {
          method: 'POST',
          body: JSON.stringify({ version: current.version }),
        });
        toast('已提交审核');
        $('#version').value = String(submitted.product.version);
      } else if (current.status === 'PENDING_REVIEW') {
        toast('已保存并提交重新审核');
      } else {
        throw new Error('当前状态不能提交审核');
      }
    } else {
      toast('保存成功');
    }
    setTimeout(() => { location.href = '/seller/products.html'; }, 500);
  } catch (error) {
    if (error.data?.fields?.length) {
      showAlert(error.data.fields.join('；'));
    } else {
      showAlert(error.message);
    }
    setBusy(false);
    if ($('#productId').value) {
      const status = product?.status;
      $('#saveButton').textContent = status === 'ON_SALE' ? '保存并重新审核' : '保存修改';
    }
  }
}

async function init(user) {
  if (initialized) return;
  initialized = true;
  if (user.role !== 'SELLER') {
    location.href = '/';
    return;
  }
  try {
    await loadCategories();
    const id = Number(new URLSearchParams(location.search).get('id'));
    if (Number.isInteger(id) && id > 0) {
      const data = await api(`/api/seller/products/${id}`);
      fillProduct(data);
    }
  } catch (error) {
    showAlert(error.message);
  }
}

$('#saveButton').addEventListener('click', () => save(false));
$('#saveSubmitButton').addEventListener('click', () => save(true));
document.addEventListener('app:user-ready', (event) => init(event.detail));
if (window.currentUser) init(window.currentUser);

})();

'use strict';

const ROLES = new Set(['BUYER', 'SELLER', 'ADMIN']);

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function validateAccount(account) {
  const value = text(account);
  if (!/^[A-Za-z0-9_]{3,32}$/.test(value)) {
    return '账号必须为 3-32 位字母、数字或下划线';
  }
  return null;
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 64) {
    return '密码长度必须为 8-64 位';
  }
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    return '密码必须同时包含字母和数字';
  }
  return null;
}

function validateDisplayName(name) {
  const value = text(name);
  if (value.length < 1 || value.length > 30) {
    return '昵称长度必须为 1-30 个字符';
  }
  return null;
}

function validateContact(contact) {
  const value = text(contact);
  if (value.length > 50) {
    return '联系方式不能超过 50 个字符';
  }
  return null;
}

function validateRole(role) {
  const value = text(role).toUpperCase();
  if (value === 'ADMIN') {
    return '管理员账号不开放公开注册';
  }
  if (!ROLES.has(value) || value === 'ADMIN') {
    return '角色只能是买家或卖家';
  }
  return null;
}

function normalizeRole(role) {
  return text(role).toUpperCase();
}

module.exports = {
  text,
  validateAccount,
  validatePassword,
  validateDisplayName,
  validateContact,
  validateRole,
  normalizeRole,
};

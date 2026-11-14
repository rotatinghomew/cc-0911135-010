import { createHash } from 'node:crypto';

/**
 * 稳定序列化：对象键按字典序排列，数组顺序保持不变，undefined 字段被省略。
 * 发布摘要必须在进程重启后仍能得到同一个值，因此不能依赖 JSON.stringify 的键顺序。
 */
export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value) {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new TypeError('发布数据中不能出现非有限数值');
  }
  if (typeof value === 'object') {
    const result = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) result[key] = canonicalize(value[key]);
    }
    return result;
  }
  return value;
}

export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function sha256Json(value) {
  return sha256Hex(canonicalJson(value));
}

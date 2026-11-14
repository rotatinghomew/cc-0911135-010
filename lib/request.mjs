import { setTimeout as delay } from 'node:timers/promises';

export class HttpError extends Error {
  constructor(status, message, body) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}

export class ProtocolError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'ProtocolError';
    this.cause = cause;
  }
}

/**
 * 单个 HTTP 请求一律带超时，避免网络异常把采集流程挂死。
 * 超时只覆盖这一个请求；整体等待上限由采集器另行控制。
 */
export async function requestJson(fetchImpl, url, {
  method = 'GET', body, timeoutMs = 10000, headers = {},
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      signal: controller.signal,
      headers: body === undefined
        ? headers
        : { 'content-type': 'application/json; charset=utf-8', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let payload;
    try {
      payload = text === '' ? null : JSON.parse(text);
    } catch (error) {
      if (!response.ok) throw new HttpError(response.status, `HTTP ${response.status}`, text);
      throw new ProtocolError(`响应不是有效 JSON：${url}`, error);
    }
    if (!response.ok) throw new HttpError(response.status, `HTTP ${response.status}`, payload);
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

export async function requestBytes(fetchImpl, url, { timeoutMs = 10000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    const response = await fetchImpl(url, { method: 'GET', signal: controller.signal });
    if (response.ok) {
      const bytes = Buffer.from(await response.arrayBuffer());
      return { status: response.status, ok: true, bytes };
    }
    await response.text().catch(() => '');
    return { status: response.status, ok: false, bytes: null };
  } finally {
    clearTimeout(timer);
  }
}

export function isNetworkError(error) {
  return error instanceof TypeError
    || error?.name === 'AbortError'
    || error?.name === 'TimeoutError'
    || (error?.message === 'fetch failed' && !(error instanceof HttpError));
}

export async function retryDelay(milliseconds) {
  await delay(Math.max(0, milliseconds));
}

import http from 'node:http';

export function json(response, status, value, headers = {}) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  response.end(JSON.stringify(value));
}

export function text(response, status, value, headers = {}) {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers });
  response.end(value);
}

export async function body(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 1024 * 1024) throw new Error('请求体超过接收上限');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

export async function serve(handler, initial = {}, port = 0) {
  const state = structuredClone(initial);
  const audit = [];
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/health') return json(response, 200, { ready: true });
    if (url.pathname === '/_audit') return json(response, 200, audit);
    if (url.pathname === '/_control' && request.method === 'POST') {
      Object.assign(state, await body(request));
      return json(response, 200, state);
    }
    audit.push({ path: url.pathname + url.search, method: request.method,
      headers: { range: request.headers.range, ifRange: request.headers['if-range'],
        lastEventId: request.headers['last-event-id'] }, at: Date.now() });
    try {
      if (await handler({ request, response, url, state, audit })) return;
      json(response, 404, { error: '资源不存在' });
    } catch (error) {
      if (!response.headersSent) json(response, 400, { error: error.message });
      else response.destroy();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return { url: `http://127.0.0.1:${server.address().port}`, state, audit,
    close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

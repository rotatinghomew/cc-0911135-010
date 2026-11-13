import test from 'node:test';
import assert from 'node:assert/strict';
import { createSite } from '../src/site.mjs';
import { verify } from '../lib/verify.mjs';

async function withSite(operation) {
  const site = await createSite();
  try { await operation(site); } finally { await site.close(); }
}
async function control(site, value) {
  return fetch(site.url + '/_control', { method: 'POST', body: JSON.stringify(value) });
}

async function createJob(site) {
  return (await (await fetch(site.url + '/exports', { method: 'POST', body: JSON.stringify({ requestKey: 'LOCAL-1' }) })).json()).jobId;
}
test('清单从未闭合进入完整多角色世代', async () => withSite(async site => {
  const id = await createJob(site);
  const first = await (await fetch(site.url + `/exports/${id}/manifest`)).json();
  const second = await (await fetch(site.url + `/exports/${id}/manifest`)).json();
  assert.equal(first.complete, false); assert.equal(first.files.length, 1);
  assert.equal(second.complete, true); assert.equal(second.files.length, 3); assert.equal(second.generation, 2);
}));
test('过期链接与消费确认清理', async () => withSite(async site => {
  const id = await createJob(site);
  await control(site, { completeAfterReads: 1, expireTicketOnce: true });
  let manifest = await (await fetch(site.url + `/exports/${id}/manifest`)).json();
  assert.equal((await fetch(site.url + manifest.files[0].url)).status, 403);
  manifest = await (await fetch(site.url + `/exports/${id}/manifest`)).json();
  assert.equal((await fetch(site.url + manifest.files[0].url)).status, 200);
  const ack = { generation: 2, publicationHash: 'a'.repeat(64) };
  for (const attempt of [1, 2]) assert.equal((await fetch(site.url + `/exports/${id}/ack`, { method: 'POST', body: JSON.stringify(ack) })).status, 200);
  assert.equal((await fetch(site.url + manifest.files[0].url)).status, 410);
}));
test('先确认后发布的回执无效', () => assert.throws(() => verify({ jobId: 'E', generation: 2, acknowledged: true, published: false })));

test('创建及确认响应丢失后源端保持状态', async () => withSite(async site => {
  await control(site, { lostCreateOnce: true, lostAckOnce: true, completeAfterReads: 1 });
  await assert.rejects(() => fetch(site.url + '/exports', { method: 'POST', body: JSON.stringify({ requestKey: 'UNKNOWN' }) }));
  const jobs = await (await fetch(site.url + '/exports?requestKey=UNKNOWN')).json();
  assert.equal(jobs.length, 1);
  const id = jobs[0].jobId;
  await (await fetch(site.url + `/exports/${id}/manifest`)).json();
  const ack = { generation: 2, publicationHash: 'b'.repeat(64) };
  await assert.rejects(() => fetch(site.url + `/exports/${id}/ack`, { method: 'POST', body: JSON.stringify(ack) }));
  const confirmed = await (await fetch(site.url + '/exports?requestKey=UNKNOWN')).json();
  assert.equal(confirmed[0].acknowledged, true);
}));

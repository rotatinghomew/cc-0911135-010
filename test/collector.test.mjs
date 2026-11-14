import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, readdir, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSite } from '../src/site.mjs';
import { createCollector, inspectClosed, CollectorError } from '../src/collector.mjs';
import { createReader } from '../src/reader.mjs';
import { PublicationStore } from '../src/store.mjs';
import { verify } from '../lib/verify.mjs';

const cleanups = [];
test.after(async () => {
  await Promise.all(cleanups.map(fn => fn().catch(() => {})));
});

async function withSite(operation, initial = {}) {
  const site = await createSite();
  cleanups.push(() => site.close());
  if (Object.keys(initial).length > 0) {
    await fetch(site.url + '/_control', { method: 'POST', body: JSON.stringify(initial) });
  }
  return operation(site);
}

async function tempStore(prefix = 'collector-') {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function collector(site, directory, overrides = {}) {
  return createCollector({
    baseUrl: site.url,
    requestKey: overrides.requestKey || 'REQ-1',
    store: directory,
    waitTimeoutMs: 5_000,
    pollIntervalMs: 10,
    retryDelayMs: 1,
    ...overrides,
  });
}

async function jobsFor(site, requestKey) {
  return (await fetch(`${site.url}/exports?requestKey=${encodeURIComponent(requestKey)}`)).json();
}

test('正常路径：有界等待闭合、同代校验、原子发布后确认', () => withSite(async site => {
  const directory = await tempStore();
  const result = await collector(site, directory).collect();
  assert.equal(result.published, true);
  assert.equal(result.acknowledged, true);
  assert.equal(result.generation, 2);

  const published = await createReader(directory).readPublished();
  assert.equal(published.generation, 2);
  assert.deepEqual(published.samples.map(sample => sample.id), ['M2']);
  assert.deepEqual(published.assays.map(assay => assay.id), ['A2']);
  assert.deepEqual(published.removed.samples.map(sample => sample.id), ['M1']);
  assert.deepEqual(published.removed.assays.map(assay => assay.id), ['A1']);

  const receipt = JSON.parse(await readFile(path.join(directory, 'export-receipt.json'), 'utf8'));
  verify(receipt);
  assert.equal(receipt.generation, 2);
  assert.equal(receipt.acknowledged, true);
  assert.equal(receipt.manifest.complete, true);
  assert.equal(receipt.manifest.generation, 2);
  assert.match(receipt.manifest.digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(receipt.files.map(file => file.role).sort(), ['assays', 'revisions', 'samples']);
  for (const file of receipt.files) {
    assert.equal(file.generation, 2);
    assert.equal(file.verified, true);
    assert.match(file.sha256, /^[a-f0-9]{64}$/);
    assert.equal(file.size, file.downloadedSize);
  }

  // 确认发生在发布之后：源端记录确认时文件已被标记清理。
  const [job] = await jobsFor(site, 'REQ-1');
  assert.equal(job.acknowledged, true);
  assert.equal(job.ackGeneration, 2);
}, { completeAfterReads: 2 }));

test('申请响应丢失：先按 requestKey 查重，不生成第二个作业', () => withSite(async site => {
  const directory = await tempStore();
  const result = await collector(site, directory, { requestKey: 'LOST-CREATE' }).collect();
  assert.equal(result.published, true);
  const jobs = await jobsFor(site, 'LOST-CREATE');
  assert.equal(jobs.length, 1, '同一 requestKey 只能有一个作业');
  assert.equal(jobs[0].jobId, result.jobId);
}, { lostCreateOnce: true, completeAfterReads: 1 }));

test('重启后的采集复用已存作业，不再创建新作业', () => withSite(async site => {
  const directory = await tempStore();
  await collector(site, directory, { requestKey: 'RESTART' }).collect();
  const firstJobs = await jobsFor(site, 'RESTART');
  assert.equal(firstJobs.length, 1);

  // 二次运行：状态已确认，直接复用。
  const again = await collector(site, directory, { requestKey: 'RESTART' }).collect();
  assert.equal(again.jobId, firstJobs[0].jobId);
  assert.equal(again.acknowledged, true);
  assert.equal((await jobsFor(site, 'RESTART')).length, 1, '重启后不应再申请新作业');
}, { completeAfterReads: 1 }));

test('未闭合批次：到等待上限就退出，不发布、不确认，下游看不到数据', () => withSite(async site => {
  const directory = await tempStore();
  const started = Date.now();
  await assert.rejects(
    () => collector(site, directory, {
      requestKey: 'NEVER', waitTimeoutMs: 120, pollIntervalMs: 10,
    }).collect(),
    error => error instanceof CollectorError && error.code === 'wait-timeout',
  );
  assert.ok(Date.now() - started < 2_000, '等待必须有界');
  assert.equal(await createReader(directory).readPublished(), null);
  const [job] = await jobsFor(site, 'NEVER');
  assert.equal(job.acknowledged, false);
  assert.equal(job.reads < 1_000, true);
  // 作业状态保留，可供后续恢复。
  const state = JSON.parse(await readFile(path.join(directory, 'state.json'), 'utf8'));
  assert.equal(state.jobs.NEVER.jobId, job.jobId);
  assert.equal(state.jobs.NEVER.status, 'waiting');
  assert.equal(state.jobs.NEVER.lastError.code, 'wait-timeout');
  assert.ok(state.jobs.NEVER.lastManifest, '保留最后观察到的清单证据');
}, { completeAfterReads: 10_000, holdCriteria: 10_000 }));

test('清单读取次数有上限，不进行无界轮询', () => withSite(async site => {
  const directory = await tempStore();
  await assert.rejects(
    () => collector(site, directory, {
      requestKey: 'CAP', waitTimeoutMs: 10_000, pollIntervalMs: 1, maxManifestReads: 3,
    }).collect(),
    error => error instanceof CollectorError && error.code === 'wait-limit',
  );
  const [job] = await jobsFor(site, 'CAP');
  assert.ok(job.reads <= 3, `清单读取次数应为 ${job.reads}，不超过 3`);
  assert.equal(await createReader(directory).readPublished(), null);
}, { completeAfterReads: 10_000, holdCriteria: 10_000 }));

test('同代必需角色不全时不算闭合', () => {
  const base = {
    jobId: 'E', generation: 2, complete: true,
    requiredRoles: ['samples', 'assays', 'revisions'],
    files: [
      { role: 'samples', generation: 2, size: 1, sha256: 'a'.repeat(64), url: '/a' },
      { role: 'assays', generation: 2, size: 1, sha256: 'b'.repeat(64), url: '/b' },
    ],
  };
  assert.equal(inspectClosed(base).closed, false);
  assert.match(inspectClosed(base).reason, /必需角色没有文件：revisions/);

  assert.equal(inspectClosed({ ...base, complete: false }).closed, false);

  const mixed = {
    ...base,
    files: [...base.files, {
      role: 'revisions', generation: 1, size: 1, sha256: 'c'.repeat(64), url: '/c',
    }],
  };
  assert.equal(inspectClosed(mixed).closed, false);
  assert.match(inspectClosed(mixed).reason, /与清单第 2 代不一致/);

  const full = {
    ...base,
    files: [...base.files, {
      role: 'revisions', generation: 2, size: 1, sha256: 'c'.repeat(64), url: '/c',
    }],
  };
  assert.equal(inspectClosed(full).closed, true);

  const badDigest = {
    ...full,
    files: full.files.map(file => (file.role === 'assays' ? { ...file, sha256: 'nope' } : file)),
  };
  assert.equal(inspectClosed(badDigest).closed, false);
});

test('链接过期：刷新地址后核对同代摘要再复用内容', () => withSite(async site => {
  const directory = await tempStore();
  const result = await collector(site, directory, { requestKey: 'EXPIRE' }).collect();
  assert.equal(result.published, true);
  const receipt = JSON.parse(await readFile(path.join(directory, 'export-receipt.json'), 'utf8'));
  for (const file of receipt.files) assert.equal(file.generation, 2);
  // 审计中应出现被拒的旧链接请求和后续成功请求。
  assert.ok(site.audit.some(entry => entry.path.startsWith('/files/')), '应有文件请求');
}, { completeAfterReads: 1, expireTicketOnce: true }));

test('清单换代：只认同一 complete generation，不混用旧代文件', () => withSite(async site => {
  const directory = await tempStore();
  // 第一次下载后源端切到第 3 代，第 2 代内容会与清单证据不一致。
  const result = await collector(site, directory, {
    requestKey: 'GEN-CHANGE', maxBatchRestarts: 3, downloadAttempts: 2,
  }).collect();
  assert.equal(result.published, true);
  assert.equal(result.generation, 3, '发布应使用新的一代');
  const receipt = JSON.parse(await readFile(path.join(directory, 'export-receipt.json'), 'utf8'));
  assert.equal(receipt.generation, 3);
  assert.equal(receipt.manifest.generation, 3);
  for (const file of receipt.files) assert.equal(file.generation, 3);
  const published = await createReader(directory).readPublished();
  assert.equal(published.generation, 3);
  assert.equal(published.assays.find(assay => assay.id === 'A2').value, 0.3);
}, { completeAfterReads: 1, generationChangeOnce: true }));

test('引用删除与真正孤儿有不同隔离理由', async () => {
  await withSite(async site => {
    const directory = await tempStore();
    const result = await collector(site, directory, { requestKey: 'CLEAN' }).collect();
    assert.equal(result.published, true);
    const receipt = JSON.parse(await readFile(path.join(directory, 'export-receipt.json'), 'utf8'));
    assert.deepEqual(receipt.removed.samples.map(sample => sample.id), ['M1']);
    assert.deepEqual(receipt.removed.assays.map(assay => assay.id), ['A1']);
    assert.deepEqual(receipt.quarantine, [], '正常修订删除不进入隔离');
  }, { completeAfterReads: 1 });

  await withSite(async site => {
    const directory = await tempStore();
    const result = await collector(site, directory, { requestKey: 'ORPHAN' }).collect();
    assert.equal(result.published, true, '可隔离的行不阻止其他完整数据发布');
    const receipt = JSON.parse(await readFile(path.join(directory, 'export-receipt.json'), 'utf8'));
    const reasons = receipt.quarantine.map(item => item.reason);
    assert.ok(reasons.includes('missing-sample-reference'), `隔离理由应包含真正缺失引用：${reasons}`);
    // 修订删除的 M1 与它的检测仍然是正常移除，不是隔离。
    assert.deepEqual(receipt.removed.samples.map(sample => sample.id), ['M1']);
    assert.equal(receipt.quarantine.some(item => item.reason === 'parse-error'), false);
    verify(receipt);
  }, { completeAfterReads: 1, orphan: true });
});

test('解析错误进入隔离，不伪报完整，也不与缺失引用混为一谈', () => withSite(async site => {
  const directory = await tempStore();
  const result = await collector(site, directory, { requestKey: 'PARSE' }).collect();
  assert.equal(result.published, true);
  const receipt = JSON.parse(await readFile(path.join(directory, 'export-receipt.json'), 'utf8'));
  const parseErrors = receipt.quarantine.filter(item => item.reason === 'parse-error');
  assert.equal(parseErrors.length, 1);
  assert.equal(parseErrors[0].role, 'revisions');
  assert.equal(parseErrors[0].line, 3);
  assert.equal(receipt.quarantine.some(item => item.reason === 'missing-sample-reference'), false);
  verify(receipt);
}, { completeAfterReads: 1, parseError: true }));

test('确认响应丢失：已发布数据保持可读，重启后安全补发相同回执', () => withSite(async site => {
  const directory = await tempStore();
  await assert.rejects(
    () => collector(site, directory, { requestKey: 'LOST-ACK', ackAttempts: 1 }).collect(),
    error => error instanceof CollectorError && error.code === 'ack-unconfirmed',
  );

  // 本地发布已经完成，下游仍能读到完整一代。
  const published = await createReader(directory).readPublished();
  assert.equal(published.generation, 2);
  const firstReceipt = JSON.parse(await readFile(path.join(directory, 'export-receipt.json'), 'utf8'));
  assert.equal(firstReceipt.published, true);
  assert.equal(firstReceipt.acknowledged, false);
  assert.equal(firstReceipt.ack.status, 'pending');

  const [job] = await jobsFor(site, 'LOST-ACK');
  assert.equal(job.acknowledged, true, '源端其实已接受确认');

  // 重启：不重新下载、不新建作业，只补发相同确认。
  const filesBefore = site.audit.filter(entry => entry.path.startsWith('/files/')).length;
  const retried = await collector(site, directory, { requestKey: 'LOST-ACK' }).collect();
  assert.equal(retried.acknowledged, true);
  assert.equal(retried.publicationHash, firstReceipt.publicationHash);
  assert.equal((await jobsFor(site, 'LOST-ACK')).length, 1);
  assert.equal(site.audit.filter(entry => entry.path.startsWith('/files/')).length, filesBefore,
    '补发确认不应重新下载文件');

  const finalReceipt = JSON.parse(await readFile(path.join(directory, 'export-receipt.json'), 'utf8'));
  assert.equal(finalReceipt.acknowledged, true);
  assert.equal(finalReceipt.ack.status, 'accepted');
  assert.equal(finalReceipt.publicationHash, firstReceipt.publicationHash);
}, { completeAfterReads: 1, lostAckOnce: true }));

test('发布边界中断：快照已落盘但指针未写时，重启完成发布且下游只看到完整一代', async () => {
  const site = await createSite();
  cleanups.push(() => site.close());
  await fetch(site.url + '/_control', {
    method: 'POST', body: JSON.stringify({ completeAfterReads: 1 }),
  });
  const directory = await tempStore();
  const store = new PublicationStore(directory);

  // 模拟在写指针之前崩溃。
  await assert.rejects(() => collector(site, directory, {
    requestKey: 'CRASH', store,
    hooks: { afterSnapshot: () => { throw new Error('模拟中断：写指针前退出'); } },
  }).collect(), /模拟中断/);

  assert.equal(await createReader(directory).readPublished(), null, '指针未写时下游不可见');
  const state = JSON.parse(await readFile(path.join(directory, 'state.json'), 'utf8'));
  assert.ok(state.jobs.CRASH.pendingPublication, '应保留待发布记录以便恢复');
  assert.equal(state.jobs.CRASH.published, null);
  const [job] = await jobsFor(site, 'CRASH');
  assert.equal(job.acknowledged, false, '本地未发布前不得确认');

  // 恢复：直接复用完整快照，不重新下载。
  const filesBefore = site.audit.filter(entry => entry.path.startsWith('/files/')).length;
  const result = await collector(site, directory, { requestKey: 'CRASH' }).collect();
  assert.equal(result.published, true);
  assert.equal(result.acknowledged, true);
  assert.equal(site.audit.filter(entry => entry.path.startsWith('/files/')).length, filesBefore,
    '恢复发布不应重新下载');
  const published = await createReader(directory).readPublished();
  assert.equal(published.generation, 2);
});

test('指针写入后、确认前中断：已发布数据可读，重启只补确认', async () => {
  const site = await createSite();
  cleanups.push(() => site.close());
  await fetch(site.url + '/_control', {
    method: 'POST', body: JSON.stringify({ completeAfterReads: 1 }),
  });
  const directory = await tempStore();
  const store = new PublicationStore(directory);

  await assert.rejects(() => collector(site, directory, {
    requestKey: 'CRASH2', store,
    hooks: { afterPointer: () => { throw new Error('模拟中断：确认前退出'); } },
  }).collect(), /模拟中断/);

  const published = await createReader(directory).readPublished();
  assert.equal(published.generation, 2, '指针已写，下游可见完整一代');
  const [job] = await jobsFor(site, 'CRASH2');
  assert.equal(job.acknowledged, false);

  const result = await collector(site, directory, { requestKey: 'CRASH2' }).collect();
  assert.equal(result.acknowledged, true);
  assert.equal((await jobsFor(site, 'CRASH2'))[0].acknowledged, true);
});

test('下游读取接口在发布前后都只看到完整代', async () => {
  const site = await createSite();
  cleanups.push(() => site.close());
  const directory = await tempStore();
  const store = new PublicationStore(directory);
  const reader = createReader(directory);

  assert.equal(await reader.readPublished(), null);
  assert.equal(await reader.readSamples(), null);

  // 第一个作业只到未闭合状态，不应产生任何发布。
  await fetch(site.url + '/_control', {
    method: 'POST', body: JSON.stringify({ completeAfterReads: 100, holdCriteria: 100 }),
  });
  await assert.rejects(() => collector(site, directory, {
    requestKey: 'OPEN', waitTimeoutMs: 80, pollIntervalMs: 10,
  }).collect());
  assert.equal(await reader.readPublished(), null);

  // 第二个作业完成；读取接口切到新的一代。
  await fetch(site.url + '/_control', {
    method: 'POST', body: JSON.stringify({ completeAfterReads: 1 }),
  });
  const result = await collector(site, directory, { requestKey: 'CLOSED' }).collect();
  const published = await reader.readPublished();
  assert.equal(published.generation, 2);
  assert.equal(published.publicationHash, result.publicationHash);

  // 指针被破坏时读取接口报错而不是返回部分数据。
  await writeFile(path.join(directory, 'current.json'), JSON.stringify({
    jobId: published.jobId,
    generation: published.generation,
    publicationHash: published.publicationHash,
    snapshot: 'publications/does-not-exist',
  }));
  await assert.rejects(() => reader.readPublished());
  assert.equal(await store.readPointer().then(pointer => pointer.snapshot),
    'publications/does-not-exist');
});

test('指针路径越出仓库时读取接口拒绝', async () => {
  const directory = await tempStore();
  const store = new PublicationStore(directory);
  await store.ensure();
  await store.writePointer({
    jobId: 'X', generation: 2, publicationHash: 'a'.repeat(64),
    snapshot: '../../etc',
  });
  await assert.rejects(() => store.readPublished(), /越出本地仓库/);
});

test('快照内容被篡改时读取接口拒绝，不降级返回部分数据', async () => {
  const site = await createSite();
  cleanups.push(() => site.close());
  await fetch(site.url + '/_control', {
    method: 'POST', body: JSON.stringify({ completeAfterReads: 1 }),
  });
  const directory = await tempStore();
  const result = await collector(site, directory, { requestKey: 'TAMPER' }).collect();
  const pointer = JSON.parse(await readFile(path.join(directory, 'current.json'), 'utf8'));
  const dataFile = path.join(directory, pointer.snapshot, 'data.json');
  const data = JSON.parse(await readFile(dataFile, 'utf8'));
  data.samples = [];
  await writeFile(dataFile, JSON.stringify(data));
  await assert.rejects(() => createReader(directory).readPublished(), /publicationHash 不一致/);
  assert.equal(result.published, true);
});

test('已发布后源端清理文件，重复运行不会重新下载也不会改变发布', async () => {
  const site = await createSite();
  cleanups.push(() => site.close());
  await fetch(site.url + '/_control', {
    method: 'POST', body: JSON.stringify({ completeAfterReads: 1 }),
  });
  const directory = await tempStore();
  const first = await collector(site, directory, { requestKey: 'CLEANED' }).collect();
  const receiptBefore = await readFile(path.join(directory, 'export-receipt.json'), 'utf8');

  // 源端已确认并清理：文件请求都会得到 410。
  assert.equal((await fetch(site.url + '/files/EXP-1/2/samples?ticket=1')).status, 410);
  const filesBefore = site.audit.filter(entry => entry.path.startsWith('/files/')).length;

  const second = await collector(site, directory, { requestKey: 'CLEANED' }).collect();
  assert.equal(second.publicationHash, first.publicationHash);
  assert.equal(second.acknowledged, true);
  assert.equal(site.audit.filter(entry => entry.path.startsWith('/files/')).length, filesBefore);
  assert.equal(await readFile(path.join(directory, 'export-receipt.json'), 'utf8'), receiptBefore);
});

test('残留的未发布快照对下游不可见', async () => {
  const site = await createSite();
  cleanups.push(() => site.close());
  await fetch(site.url + '/_control', {
    method: 'POST', body: JSON.stringify({ completeAfterReads: 1 }),
  });
  const directory = await tempStore();
  const store = new PublicationStore(directory);
  const reader = createReader(directory);

  // 先做出一次可发布快照，再手动丢弃指针，模拟“快照在、发布未完成”。
  await assert.rejects(() => collector(site, directory, {
    requestKey: 'ORPHAN-SNAPSHOT',
    hooks: { afterSnapshot: () => { throw new Error('stop'); } },
  }).collect(), /stop/);
  await rm(path.join(directory, 'current.json'), { force: true });
  await rm(path.join(directory, 'export-receipt.json'), { force: true });

  assert.equal(await reader.readPublished(), null);
  const snapshots = await readdir(path.join(directory, 'publications', 'EXP-1'));
  assert.ok(snapshots.length > 0, '快照存在');
  assert.ok(snapshots.every(name => !name.endsWith('.json')));
});

test('发布摘要可重算且与回执一致', async () => {
  const site = await createSite();
  cleanups.push(() => site.close());
  await fetch(site.url + '/_control', {
    method: 'POST', body: JSON.stringify({ completeAfterReads: 1 }),
  });
  const directory = await tempStore();
  const result = await collector(site, directory, { requestKey: 'HASH' }).collect();
  const receipt = JSON.parse(await readFile(path.join(directory, 'export-receipt.json'), 'utf8'));
  assert.equal(receipt.publicationHash, result.publicationHash);

  const { sha256Json } = await import('../lib/canonical.mjs');
  const recomputed = sha256Json({
    jobId: receipt.jobId,
    generation: receipt.generation,
    files: receipt.files.map(file => ({
      role: file.role, generation: file.generation, size: file.size, sha256: file.sha256,
    })),
    samples: receipt.samples,
    assays: receipt.assays,
    quarantine: receipt.quarantine,
    removed: receipt.removed,
  });
  assert.equal(recomputed, receipt.publicationHash);
});

test('complete 但缺少必需角色的清单不算闭合', () => withSite(async site => {
  const directory = await tempStore();
  await assert.rejects(
    () => collector(site, directory, {
      requestKey: 'MISSING-ROLE', waitTimeoutMs: 160, pollIntervalMs: 10,
    }).collect(),
    error => error instanceof CollectorError && error.code === 'wait-timeout',
  );
  assert.equal(await createReader(directory).readPublished(), null);
  const [job] = await jobsFor(site, 'MISSING-ROLE');
  assert.equal(job.acknowledged, false);
}, { completeAfterReads: 1, missingRole: 'assays' }));

test('角色文件 generation 与清单不一致时整批不发布', () => withSite(async site => {
  const directory = await tempStore();
  await assert.rejects(
    () => collector(site, directory, {
      requestKey: 'MIXED-GEN', waitTimeoutMs: 160, pollIntervalMs: 10,
    }).collect(),
    error => error instanceof CollectorError && error.code === 'wait-timeout',
  );
  assert.equal(await createReader(directory).readPublished(), null);
  const state = JSON.parse(await readFile(path.join(directory, 'state.json'), 'utf8'));
  assert.match(state.jobs['MIXED-GEN'].lastError.message, /与清单第 2 代不一致/);
}, { completeAfterReads: 1, mismatchGeneration: 'assays' }));

test('文件下载持续失败时不发布、不确认，下游保持空', () => withSite(async site => {
  const directory = await tempStore();
  const flakyFetch = async (url, options) => {
    if (String(url).includes('/files/')) throw new TypeError('模拟文件网络中断');
    return fetch(url, options);
  };
  await assert.rejects(
    () => collector(site, directory, {
      requestKey: 'DL-FAIL', fetchImpl: flakyFetch, downloadAttempts: 2,
    }).collect(),
    error => error instanceof CollectorError && error.code === 'download-failed',
  );
  assert.equal(await createReader(directory).readPublished(), null);
  const [job] = await jobsFor(site, 'DL-FAIL');
  assert.equal(job.acknowledged, false);
}, { completeAfterReads: 1 }));

test('未闭合时不会预取全部文件，也不会消耗清单之外的请求', () => withSite(async site => {
  const directory = await tempStore();
  await assert.rejects(
    () => collector(site, directory, {
      requestKey: 'EARLY', waitTimeoutMs: 100, pollIntervalMs: 10, maxManifestReads: 100,
    }).collect(),
  );
  assert.equal(site.audit.filter(entry => entry.path.startsWith('/files/')).length, 0,
    '未闭合的清单不应触发文件下载');
}, { completeAfterReads: 1_000, holdCriteria: 1_000 }));

test('创建作业被拒绝时不进入等待', async () => {
  const directory = await tempStore();
  await assert.rejects(
    () => createCollector({
      baseUrl: 'http://127.0.0.1:1',
      requestKey: 'BAD',
      store: directory,
      waitTimeoutMs: 500,
      requestTimeoutMs: 100,
      retryDelayMs: 1,
      createAttempts: 2,
    }).collect(),
    error => error instanceof CollectorError,
  );
  assert.equal(await createReader(directory).readPublished(), null);
});

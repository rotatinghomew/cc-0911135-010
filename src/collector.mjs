import path from 'node:path';
import { parseCsv } from './csv.mjs';
import { reconcile } from './reconcile.mjs';
import { PublicationStore, publicationHashOf } from './store.mjs';
import { sha256Hex, sha256Json } from '../lib/canonical.mjs';
import {
  HttpError, ProtocolError, requestBytes, requestJson, retryDelay,
} from '../lib/request.mjs';

const KNOWN_ROLES = ['samples', 'assays', 'revisions'];
const ROLE_ORDER = ['samples', 'assays', 'revisions'];
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export class CollectorError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CollectorError';
    this.code = code;
    this.details = details;
  }
}

export const DEFAULTS = Object.freeze({
  waitTimeoutMs: 30_000,
  pollIntervalMs: 250,
  requestTimeoutMs: 10_000,
  downloadTimeoutMs: 10_000,
  ackTimeoutMs: 5_000,
  createAttempts: 3,
  downloadAttempts: 3,
  ackAttempts: 3,
  maxManifestReads: 500,
  maxBatchRestarts: 10,
  retryDelayMs: 50,
});

/**
 * 以批次闭合为准的采集器。
 *
 * 产品路径固定为：申请（按 requestKey 复用既有作业）→ 有界等待 complete
 * → 下载同一代必需角色 → 校验长度/摘要/引用 → 结构化接收 → 本地原子发布
 * → 消费确认。任何一步失败都不会写出发布指针，因此下游看不到半批数据。
 */
export function createCollector(options) {
  const {
    baseUrl,
    store,
    requestKey,
    fetchImpl = globalThis.fetch,
    hooks = {},
    logger = () => {},
    waitTimeoutMs = DEFAULTS.waitTimeoutMs,
    pollIntervalMs = DEFAULTS.pollIntervalMs,
    requestTimeoutMs = DEFAULTS.requestTimeoutMs,
    downloadTimeoutMs = DEFAULTS.downloadTimeoutMs,
    ackTimeoutMs = DEFAULTS.ackTimeoutMs,
    createAttempts = DEFAULTS.createAttempts,
    downloadAttempts = DEFAULTS.downloadAttempts,
    ackAttempts = DEFAULTS.ackAttempts,
    maxManifestReads = DEFAULTS.maxManifestReads,
    maxBatchRestarts = DEFAULTS.maxBatchRestarts,
    retryDelayMs = DEFAULTS.retryDelayMs,
    now = Date.now,
    sleep = retryDelay,
  } = options || {};

  if (!baseUrl) throw new CollectorError('invalid-options', '缺少 baseUrl');
  if (!requestKey || typeof requestKey !== 'string') {
    throw new CollectorError('invalid-options', 'requestKey 必须是非空字符串');
  }
  if (!(waitTimeoutMs > 0)) throw new CollectorError('invalid-options', 'waitTimeoutMs 必须为正数');
  if (!(pollIntervalMs > 0)) throw new CollectorError('invalid-options', 'pollIntervalMs 必须为正数');

  const publicationStore = store instanceof PublicationStore
    ? store
    : new PublicationStore(store || path.join('var', 'collector'));
  const root = String(baseUrl).replace(/\/+$/, '');
  let activeJobId = null;
  let manifestReads = 0;

  const config = {
    requestTimeoutMs, downloadTimeoutMs, ackTimeoutMs, createAttempts,
    downloadAttempts, ackAttempts, maxManifestReads, maxBatchRestarts,
    retryDelayMs, pollIntervalMs,
  };

  async function collect() {
    await publicationStore.ensure();
    const state = await publicationStore.loadState();
    let job = state.jobs[requestKey];

    if (!job) {
      job = await createOrAdoptJob();
      state.jobs[requestKey] = job;
      await publicationStore.saveState(state);
    } else {
      logger('resume-job', { requestKey, jobId: job.jobId, status: job.status });
    }
    activeJobId = job.jobId;
    manifestReads = 0;

    try {
      await resumePublishedIfPossible(state, job);

      if (!job.published) {
        const deadline = now() + waitTimeoutMs;
        let batch = await waitForClosedBatch(job, deadline);
        const structured = await downloadAndStructure(batch, job, deadline);
        await publishBatch(state, job, structured);
      }

      await ensureTopReceipt(job);
      await acknowledgeBatch(state, job);
      await publicationStore.saveState(state);
      return outcome(job);
    } catch (error) {
      job.lastError = {
        code: error.code || error.name || 'error',
        message: error.message,
        at: new Date(now()).toISOString(),
      };
      if (!job.published) {
        if (job.status === 'created' || job.status === 'waiting' || job.status === 'publishing') {
          job.status = job.status === 'publishing' ? 'publishing' : 'waiting';
        }
      } else {
        job.status = job.published.acknowledged ? 'acknowledged' : 'published';
      }
      await publicationStore.saveState(state).catch(() => {});
      throw error;
    }
  }

  async function createOrAdoptJob() {
    let lastError = null;
    for (let attempt = 1; attempt <= createAttempts; attempt += 1) {
      // 每次创建前都按稳定 requestKey 查重：创建响应丢失时不能产生新作业。
      let existing;
      try {
        existing = await findExistingJob();
      } catch (error) {
        // 查重失败意味着无法排除既有作业；此时绝不能贸然创建。
        lastError = error;
        logger('lookup-failed', { attempt, message: error.message });
        if (!isAmbiguousFailure(error)) {
          throw new CollectorError('lookup-failed',
            `无法按 requestKey 查询既有作业：${error.message}`, { cause: error });
        }
        if (attempt < createAttempts) {
          await sleep(retryDelayMs * attempt);
          continue;
        }
        break;
      }
      if (existing) {
        logger('adopt-existing-job', { jobId: existing.jobId, attempt });
        return newJobState(existing.jobId, 'created');
      }
      try {
        const created = await requestJson(fetchImpl, root + '/exports', {
          method: 'POST',
          body: { requestKey },
          timeoutMs: requestTimeoutMs,
        });
        if (!created || typeof created.jobId !== 'string' || created.jobId === '') {
          throw new ProtocolError('创建响应缺少 jobId');
        }
        logger('created-job', { jobId: created.jobId });
        return newJobState(created.jobId, 'created');
      } catch (error) {
        if (error instanceof HttpError && error.status < 500) {
          throw new CollectorError('create-rejected',
            `导出申请被拒绝：${error.message}`, { status: error.status });
        }
        if (!isAmbiguousFailure(error)) throw error;
        lastError = error;
        logger('create-ambiguous', { attempt, message: error.message });
        // 响应可能丢失；先查既有作业，再决定是否重试创建。
        let afterFailure = null;
        try {
          afterFailure = await findExistingJob();
        } catch (lookupError) {
          logger('lookup-after-create-failed', { message: lookupError.message });
        }
        if (afterFailure) {
          logger('adopt-after-lost-create', { jobId: afterFailure.jobId });
          return newJobState(afterFailure.jobId, 'created');
        }
        if (attempt < createAttempts) await sleep(retryDelayMs * attempt);
      }
    }
    throw new CollectorError('create-unconfirmed',
      `创建响应持续不可确认：${lastError?.message ?? '未知错误'}`, { cause: lastError });
  }

  async function findExistingJob() {
    const jobs = await requestJson(fetchImpl,
      `${root}/exports?requestKey=${encodeURIComponent(requestKey)}`,
      { timeoutMs: requestTimeoutMs });
    if (!Array.isArray(jobs)) throw new ProtocolError('作业查询响应不是数组');
    if (jobs.length === 0) return null;
    // 固定选最早创建的作业，避免重试时漂移到新作业。
    const candidate = jobs.find(item => item && typeof item.jobId === 'string' && item.jobId !== '');
    return candidate || null;
  }

  async function resumePublishedIfPossible(state, job) {
    const pointer = await publicationStore.readPointer();
    const pending = job.pendingPublication;
    const published = job.published;

    if (pointer && pointer.jobId === job.jobId) {
      const matchesPending = pending
        && pointer.publicationHash === pending.publicationHash
        && pointer.generation === pending.generation;
      const matchesPublished = published
        && pointer.publicationHash === published.publicationHash
        && pointer.generation === published.generation;
      if (matchesPending || matchesPublished || (!pending && !published)) {
        const snapshot = await publicationStore.readSnapshot(pointer.snapshot);
        if (snapshot.receipt.published !== true || snapshot.receipt.complete !== true) {
          throw new CollectorError('pointer-invalid', '发布指针指向未完整发布的快照');
        }
        job.published = {
          generation: pointer.generation,
          publicationHash: pointer.publicationHash,
          snapshot: pointer.snapshot,
          publishedAt: snapshot.data.publishedAt,
          acknowledged: Boolean(matchesPublished ? published.acknowledged : false),
          ack: (!matchesPublished || !published.ack)
            ? { status: 'pending', attempts: 0 }
            : published.ack,
        };
        job.pendingPublication = null;
        job.status = job.published.acknowledged ? 'acknowledged' : 'published';
        logger('adopt-pointer-after-restart', { jobId: job.jobId, generation: pointer.generation });
        await publicationStore.saveState(state);
        return;
      }
    }

    if (pending) {
      // 快照已完整落盘但发布指针尚未写入：直接完成发布，无需重新下载。
      const snapshot = await publicationStore.readSnapshot(pending.snapshot);
      if (snapshot.receipt.publicationHash === pending.publicationHash
        && snapshot.receipt.published === true && snapshot.receipt.complete === true) {
        if (!pointer || pointer.jobId === job.jobId) {
          await writePointerForJob(job, pending);
        } else {
          // 另一个作业已是当前发布；不回滚下游指针。
          logger('pointer-owned-by-other-job', {
            jobId: job.jobId, pointerJobId: pointer.jobId,
          });
        }
        job.published = {
          generation: pending.generation,
          publicationHash: pending.publicationHash,
          snapshot: pending.snapshot,
          publishedAt: snapshot.data.publishedAt,
          acknowledged: false,
          ack: { status: 'pending', attempts: 0 },
        };
        job.pendingPublication = null;
        job.status = 'published';
        await publicationStore.saveState(state);
        logger('complete-publication-after-restart', { jobId: job.jobId, generation: pending.generation });
        return;
      }
    }

    if (published) {
      // 状态显示已发布：确认快照仍完整，必要时修复丢失的指针。
      const snapshot = await publicationStore.readSnapshot(published.snapshot);
      if (snapshot.receipt.publicationHash !== published.publicationHash) {
        throw new CollectorError('snapshot-mismatch', '本地发布快照与记录摘要不一致');
      }
      if (!pointer) {
        await writePointerForJob(job, published);
        logger('restore-missing-pointer', { jobId: job.jobId });
      } else if (pointer.jobId !== job.jobId) {
        logger('pointer-owned-by-other-job', { jobId: job.jobId, pointerJobId: pointer.jobId });
      }
    }
  }

  async function waitForClosedBatch(job, deadline) {
    let reads = 0;
    let lastManifest = null;
    let lastProblem = '尚未取得清单';

    job.status = 'waiting';
    while (true) {
      if (reads >= maxManifestReads) {
        throw new CollectorError('wait-limit',
          `等待清单达到读取上限 ${maxManifestReads} 次`, { jobId: job.jobId, lastManifest });
      }
      if (now() >= deadline) {
        throw new CollectorError('wait-timeout',
          `等待闭合批次超时（等待上限 ${waitTimeoutMs} ms）：${lastProblem}`,
          { jobId: job.jobId, lastManifest });
      }

      try {
        const manifest = await readManifest();
        reads += 1;
        lastManifest = manifest;
        if (manifest && typeof manifest === 'object') {
          job.lastManifest = manifestEvidence(manifest, reads);
        }
        const check = inspectClosed(manifest);
        if (check.closed) {
          logger('manifest-closed', { generation: manifest.generation, reads });
          return { manifest, polls: reads, observedAt: new Date(now()).toISOString() };
        }
        if (check.fatal) {
          throw new CollectorError('manifest-invalid', check.reason, { jobId: job.jobId, manifest });
        }
        lastProblem = check.reason;
        logger('manifest-not-closed', { reads, reason: check.reason });
      } catch (error) {
        if (error instanceof CollectorError) throw error;
        if (error instanceof HttpError && error.status === 404) {
          throw new CollectorError('job-not-found', '源端已不存在该导出作业', { jobId: job.jobId });
        }
        lastProblem = `读取清单失败：${error.message}`;
        logger('manifest-read-error', { message: error.message });
      }

      if (await pauseBeforeDeadline(deadline)) {
        throw new CollectorError('wait-timeout',
          `等待闭合批次超时（等待上限 ${waitTimeoutMs} ms）：${lastProblem}`,
          { jobId: job.jobId, lastManifest });
      }
    }
  }

  async function downloadAndStructure(batch, job, deadline) {
    let manifest = batch.manifest;
    let observedAt = batch.observedAt;
    let polls = batch.polls;

    for (let restart = 0; restart <= maxBatchRestarts; restart += 1) {
      let check = inspectClosed(manifest);
      if (!check.closed) {
        if (check.fatal) {
          throw new CollectorError('manifest-invalid', check.reason, { jobId: job.jobId, manifest });
        }
        // 批次在换代后暂时回到未闭合状态：继续有界等待，不能拿旧内容凑数。
        logger('manifest-reopened', { generation: manifest.generation, reason: check.reason });
        const waited = await waitForClosedBatch(job, deadline);
        manifest = waited.manifest;
        observedAt = waited.observedAt;
        polls = waited.polls;
        continue;
      }
      if (now() >= deadline) {
        throw new CollectorError('wait-timeout', '下载阶段超过等待上限', { jobId: job.jobId });
      }

      const expected = expectedFiles(manifest);
      const downloaded = {};
      let restartTo = null;

      for (const role of ROLE_ORDER) {
        const result = await downloadRole(role, expected[role], manifest, deadline);
        if (result.restartManifest) { restartTo = result.restartManifest; break; }
        downloaded[role] = result;
      }

      if (restartTo) {
        // 刷新清单暴露了新的版本：丢弃已下载内容，从闭合检查重新开始。
        logger('batch-version-changed', {
          from: manifest.generation, to: restartTo.manifest.generation, restart: restart + 1,
        });
        manifest = restartTo.manifest;
        observedAt = restartTo.observedAt;
        polls = restartTo.polls;
        await pauseBeforeDeadline(deadline);
        continue;
      }

      // 发布前再读一次清单：避免下载期间源端换代而混用两代文件。
      let revalidated;
      try {
        revalidated = await readManifest();
        polls += 1;
      } catch (error) {
        if (error instanceof HttpError && error.status === 404) {
          throw new CollectorError('job-not-found', '源端已不存在该导出作业', { jobId: job.jobId });
        }
        throw new CollectorError('manifest-revalidation-failed',
          `发布前复核清单失败：${error.message}`, { jobId: job.jobId });
      }
      const recheck = inspectClosed(revalidated);
      if (revalidated && typeof revalidated === 'object') {
        job.lastManifest = manifestEvidence(revalidated, polls);
      }
      const sameVersion = recheck.closed
        && revalidated.generation === manifest.generation
        && sameFileEvidence(expectedFiles(revalidated), expected);
      if (!sameVersion) {
        logger('batch-version-changed-before-publish', {
          expectedGeneration: manifest.generation,
          actualGeneration: revalidated.generation,
          closed: recheck.closed,
        });
        manifest = revalidated;
        observedAt = new Date(now()).toISOString();
        polls = 0;
        await pauseBeforeDeadline(deadline);
        continue;
      }

      const structured = structure(downloaded);
      return {
        ...structured,
        raw: Object.fromEntries(ROLE_ORDER.map(role => [role, downloaded[role].bytes])),
        manifest,
        manifestDigest: manifestDigest(manifest),
        polls,
        observedAt,
        files: evidenceFor(downloaded, expected, observedAt),
      };
    }

    throw new CollectorError('batch-unstable',
      '闭合批次在多次复核中持续变化，未发布', { jobId: job.jobId });
  }

  async function downloadRole(role, expectedFile, manifest, deadline) {
    let currentUrl = expectedFile.url;
    let lastError = null;

    for (let attempt = 1; attempt <= downloadAttempts; attempt += 1) {
      if (now() >= deadline) {
        throw new CollectorError('wait-timeout', '下载文件超过等待上限', { jobId: job.jobId, role });
      }
      let result;
      try {
        result = await requestBytes(fetchImpl, resolveUrl(currentUrl), { timeoutMs: downloadTimeoutMs });
      } catch (error) {
        lastError = error;
        logger('download-error', { role, attempt, message: error.message });
        if (attempt < downloadAttempts) await sleep(retryDelayMs * attempt);
        continue;
      }

      if (result.ok) {
        const bytes = result.bytes;
        const digest = sha256Hex(bytes);
        if (bytes.length === expectedFile.size && digest === expectedFile.sha256) {
          return { bytes, downloadedAt: new Date(now()).toISOString(), attempts: attempt };
        }
        // 内容与清单证据不一致：可能链接过期返回了错误页，也可能源端已换代。
        // 先刷新清单，绝不按旧摘要放行。
        const refreshed = await refreshForRole(role, expectedFile, manifest);
        if (refreshed?.restartManifest) return refreshed;
        if (refreshed?.file) {
          currentUrl = refreshed.file.url;
          lastError = new CollectorError('digest-mismatch',
            `文件 ${role} 的长度或摘要与清单不一致`);
          if (attempt < downloadAttempts) await sleep(retryDelayMs * attempt);
          continue;
        }
        throw new CollectorError('digest-mismatch',
          `文件 ${role} 的长度或摘要与清单不一致`, { role });
      }

      if (result.status === 403 || result.status === 404 || result.status === 410) {
        // 链接过期或文件被清理：刷新地址，但只有同代同摘要才能复用已下载批次。
        const refreshed = await refreshForRole(role, expectedFile, manifest);
        if (refreshed?.restartManifest) return refreshed;
        if (refreshed?.file) {
          currentUrl = refreshed.file.url;
          logger('download-link-refreshed', { role, status: result.status });
          continue;
        }
        // 清单暂时不可用：保留旧地址再试，仍受下载次数上限约束。
        lastError = new CollectorError('download-unavailable',
          `文件 ${role} 无法取回（HTTP ${result.status}），清单暂不可用`, { role });
        if (attempt < downloadAttempts) await sleep(retryDelayMs * attempt);
        continue;
      }

      lastError = new CollectorError('download-failed',
        `文件 ${role} 下载失败（HTTP ${result.status}）`, { role });
      if (attempt < downloadAttempts) await sleep(retryDelayMs * attempt);
    }

    throw new CollectorError('download-failed',
      `文件 ${role} 下载失败：${lastError?.message ?? '未知错误'}`, { role });
  }

  /**
   * 刷新清单。返回：
   *  - { file }：同一闭合 generation、同角色摘要未变，可复用批次并换用新地址；
   *  - { restartManifest }：generation 或文件内容证据改变，必须重新开始整批；
   *  - null：清单暂不可用，调用方可重试。
   */
  async function refreshForRole(role, expectedFile, manifest) {
    let refreshed;
    try {
      refreshed = await readManifest();
    } catch (error) {
      logger('refresh-manifest-failed', { role, message: error.message });
      return null;
    }
    const restart = {
      manifest: refreshed,
      observedAt: new Date(now()).toISOString(),
      polls: 0,
    };
    const check = inspectClosed(refreshed);
    if (!check.closed) return { restartManifest: restart };
    if (refreshed.generation !== manifest.generation) return { restartManifest: restart };
    const freshFile = refreshed.files.find(item => item.role === role);
    if (!freshFile || freshFile.generation !== refreshed.generation
      || freshFile.sha256 !== expectedFile.sha256 || freshFile.size !== expectedFile.size) {
      // 同一 generation 下内容证据变化：源端清单不可信，整批重来。
      return { restartManifest: restart };
    }
    return { file: freshFile };
  }

  function structure(downloaded) {
    const quarantine = [];
    const rows = {};
    for (const role of ROLE_ORDER) {
      const parsed = parseCsv(downloaded[role].bytes.toString('utf8'), { role });
      if (parsed.fatal) {
        throw new CollectorError('file-not-publishable',
          `文件 ${role} 结构不可用：${parsed.fatal.message}`,
          { role, fatal: parsed.fatal });
      }
      rows[role] = parsed.rows;
      quarantine.push(...parsed.quarantine);
    }
    return reconcile({
      samples: rows.samples, assays: rows.assays, revisions: rows.revisions, quarantine,
    });
  }

  async function publishBatch(state, job, structured) {
    const manifest = structured.manifest;
    const generation = manifest.generation;
    const publishedAt = new Date(now()).toISOString();
    const core = {
      jobId: job.jobId,
      generation,
      files: structured.files.map(file => ({
        role: file.role, generation: file.generation, size: file.size, sha256: file.sha256,
      })),
      samples: structured.samples,
      assays: structured.assays,
      quarantine: structured.quarantine,
      removed: structured.removed,
    };
    const publicationHash = publicationHashOf(core);

    const receipt = {
      schemaVersion: 1,
      jobId: job.jobId,
      requestKey,
      generation,
      complete: true,
      published: true,
      acknowledged: false,
      publicationHash,
      publishedAt,
      manifest: {
        generation,
        complete: true,
        requiredRoles: [...manifest.requiredRoles],
        digest: structured.manifestDigest,
        observedAt: structured.observedAt,
        reads: manifestReads,
      },
      source: { baseUrl: root },
      files: structured.files,
      samples: structured.samples,
      assays: structured.assays,
      quarantine: structured.quarantine,
      removed: structured.removed,
      ack: { status: 'pending', attempts: 0 },
    };

    const data = {
      jobId: job.jobId,
      requestKey,
      generation,
      complete: true,
      published: true,
      publicationHash,
      publishedAt,
      manifest: receipt.manifest,
      files: structured.files,
      samples: structured.samples,
      assays: structured.assays,
      quarantine: structured.quarantine,
      removed: structured.removed,
    };

    const snapshot = await publicationStore.writeSnapshot({
      jobId: job.jobId,
      generation,
      publicationHash,
      receipt,
      data,
      rawFiles: structured.raw,
    });

    job.pendingPublication = { generation, publicationHash, snapshot, publishedAt };
    job.status = 'publishing';
    await publicationStore.saveState(state);
    await hooks.afterSnapshot?.({ jobId: job.jobId, generation, publicationHash, snapshot });

    await writePointerForJob(job, job.pendingPublication);

    job.published = {
      generation,
      publicationHash,
      snapshot,
      publishedAt,
      acknowledged: false,
      ack: { status: 'pending', attempts: 0 },
    };
    job.pendingPublication = null;
    job.status = 'published';
    await publicationStore.saveState(state);
    // 指针写入后立刻落可读回执；下游此后再读就是完整一代。
    await ensureTopReceipt(job);
    await hooks.afterPointer?.({ jobId: job.jobId, generation, publicationHash, snapshot });
    logger('published', { jobId: job.jobId, generation, publicationHash });
  }

  function writePointerForJob(job, publication) {
    return publicationStore.writePointer({
      jobId: job.jobId,
      requestKey,
      generation: publication.generation,
      publicationHash: publication.publicationHash,
      snapshot: publication.snapshot,
      publishedAt: publication.publishedAt,
    });
  }

  async function ensureTopReceipt(job) {
    if (!job.published) return null;
    const snapshot = await publicationStore.readSnapshot(job.published.snapshot);
    const receipt = {
      ...snapshot.receipt,
      acknowledged: Boolean(job.published.acknowledged),
      ack: job.published.ack || snapshot.receipt.ack,
    };
    // 顶层回执只描述当前发布指针指向的世代；旧作业不能覆盖它。
    const pointer = await publicationStore.readPointer();
    if (!pointer || pointer.jobId !== job.jobId
      || pointer.publicationHash !== job.published.publicationHash) {
      return receipt;
    }
    await publicationStore.writeTopReceipt(receipt);
    return receipt;
  }

  async function acknowledgeBatch(state, job) {
    if (!job.published) {
      throw new CollectorError('ack-before-publish', '本地尚未完整发布，禁止确认');
    }
    if (job.published.acknowledged) return;

    const { generation, publicationHash } = job.published;
    let lastError = null;

    for (let attempt = 1; attempt <= ackAttempts; attempt += 1) {
      const previous = job.published.ack?.attempts ?? 0;
      job.published.ack = {
        status: 'pending', attempts: previous + 1, generation, publicationHash,
        lastAttemptAt: new Date(now()).toISOString(),
      };
      await publicationStore.saveState(state);
      await ensureTopReceipt(job);
      await hooks.beforeAck?.({ jobId: job.jobId, generation, publicationHash, attempt });

      try {
        await requestJson(fetchImpl, `${root}/exports/${encodeURIComponent(job.jobId)}/ack`, {
          method: 'POST',
          body: { generation, publicationHash },
          timeoutMs: ackTimeoutMs,
        });
        job.published.acknowledged = true;
        job.published.ack = {
          status: 'accepted',
          attempts: job.published.ack.attempts,
          generation,
          publicationHash,
          acknowledgedAt: new Date(now()).toISOString(),
        };
        job.status = 'acknowledged';
        await publicationStore.writeAckRecord(job.jobId, job.published.ack);
        await publicationStore.saveState(state);
        await ensureTopReceipt(job);
        logger('acknowledged', { jobId: job.jobId, generation, publicationHash });
        return;
      } catch (error) {
        lastError = error;
        if (error instanceof HttpError && error.status === 409) {
          job.published.ack = {
            status: 'conflict',
            attempts: job.published.ack.attempts,
            generation,
            publicationHash,
            lastError: error.message,
          };
          await publicationStore.saveState(state);
          await ensureTopReceipt(job);
          throw new CollectorError('ack-conflict',
            `源端拒绝了本次确认：${error.message}（本地发布仍保留）`,
            { jobId: job.jobId, generation, publicationHash });
        }
        if (!isAmbiguousFailure(error)) {
          throw new CollectorError('ack-failed',
            `确认请求失败：${error.message}`, { jobId: job.jobId });
        }
        logger('ack-unconfirmed', { attempt, message: error.message });
        if (attempt < ackAttempts) await sleep(retryDelayMs * attempt);
      }
    }

    job.published.ack = {
      status: 'pending',
      attempts: job.published.ack.attempts,
      generation,
      publicationHash,
      lastError: lastError?.message ?? '确认响应不可确认',
    };
    await publicationStore.saveState(state);
    await ensureTopReceipt(job);
    throw new CollectorError('ack-unconfirmed',
      `确认响应持续丢失，已发布数据保留，重启后可补发相同回执：${lastError?.message ?? ''}`,
      { jobId: job.jobId, generation, publicationHash });
  }

  function outcome(job) {
    return {
      jobId: job.jobId,
      requestKey,
      generation: job.published?.generation ?? job.lastManifest?.generation ?? null,
      complete: Boolean(job.published),
      published: Boolean(job.published),
      acknowledged: Boolean(job.published?.acknowledged),
      publicationHash: job.published?.publicationHash ?? null,
      snapshot: job.published?.snapshot ?? null,
      status: job.status,
    };
  }

  function readManifest() {
    if (!activeJobId) {
      return Promise.reject(new CollectorError('internal-error', '尚未确定作业编号'));
    }
    manifestReads += 1;
    if (manifestReads > maxManifestReads) {
      return Promise.reject(new CollectorError('wait-limit',
        `清单读取达到上限 ${maxManifestReads} 次，停止轮询`, { jobId: activeJobId }));
    }
    return requestJson(fetchImpl,
      `${root}/exports/${encodeURIComponent(activeJobId)}/manifest`,
      { timeoutMs: requestTimeoutMs });
  }

  function resolveUrl(value) {
    return new URL(value, root + '/').toString();
  }

  async function pauseBeforeDeadline(deadline) {
    const remaining = deadline - now();
    if (remaining <= 0) return true;
    await sleep(Math.min(pollIntervalMs, remaining));
    return now() >= deadline;
  }

  return { collect, store: publicationStore, config };
}

function newJobState(jobId, status) {
  return {
    jobId,
    status,
    createdAt: new Date().toISOString(),
    lastError: null,
    lastManifest: null,
    pendingPublication: null,
    published: null,
  };
}

function isAmbiguousFailure(error) {
  return error instanceof TypeError
    || error?.name === 'AbortError'
    || error?.name === 'TimeoutError'
    || error instanceof ProtocolError
    || (error instanceof HttpError && error.status >= 500);
}

/**
 * 判断清单是否已经是可发布的闭合批次。
 * 只有 complete=true、同代、必需角色齐全且证据字段完整的清单才闭合。
 */
export function inspectClosed(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { closed: false, fatal: true, reason: '清单不是对象' };
  }
  if (typeof manifest.complete !== 'boolean') {
    return { closed: false, fatal: true, reason: '清单缺少 complete 布尔字段' };
  }
  if (!Number.isInteger(manifest.generation) || manifest.generation < 1) {
    return { closed: false, fatal: true, reason: '清单 generation 不是正整数' };
  }
  if (!Array.isArray(manifest.requiredRoles) || manifest.requiredRoles.length === 0) {
    return { closed: false, fatal: true, reason: '清单缺少 requiredRoles' };
  }
  const unsupported = manifest.requiredRoles.filter(role => !KNOWN_ROLES.includes(role));
  if (unsupported.length > 0) {
    return { closed: false, fatal: true, reason: `不支持的角色：${unsupported.join(',')}` };
  }
  if (!Array.isArray(manifest.files)) {
    return { closed: false, fatal: true, reason: '清单缺少 files 数组' };
  }
  if (!manifest.complete) return { closed: false, reason: '清单尚未 complete' };

  // 产品路径固定消费三份逻辑文件；少任何一个都不算闭合。
  const missingRequired = ROLE_ORDER.filter(role => !manifest.requiredRoles.includes(role));
  if (missingRequired.length > 0) {
    return { closed: false, reason: `必需角色未声明：${missingRequired.join(',')}` };
  }

  const byRole = new Map();
  for (const file of manifest.files) {
    if (!file || typeof file !== 'object' || typeof file.role !== 'string') {
      return { closed: false, fatal: true, reason: '文件条目缺少 role' };
    }
    if (!KNOWN_ROLES.includes(file.role)) {
      return { closed: false, fatal: true, reason: `文件角色未知：${file.role}` };
    }
    if (byRole.has(file.role)) {
      return { closed: false, reason: `同一角色出现多次：${file.role}` };
    }
    if (!Number.isInteger(file.generation) || !Number.isInteger(file.size) || file.size < 0
      || !SHA256_PATTERN.test(String(file.sha256)) || typeof file.url !== 'string' || file.url === '') {
      return { closed: false, fatal: true, reason: `文件 ${file.role} 的证据字段不完整` };
    }
    if (file.generation !== manifest.generation) {
      return {
        closed: false,
        reason: `文件 ${file.role} 属于第 ${file.generation} 代，与清单第 ${manifest.generation} 代不一致`,
      };
    }
    byRole.set(file.role, file);
  }

  for (const role of ROLE_ORDER) {
    if (!byRole.has(role)) {
      return { closed: false, reason: `必需角色没有文件：${role}` };
    }
  }
  return { closed: true, byRole };
}

function expectedFiles(manifest) {
  const check = inspectClosed(manifest);
  if (!check.closed) throw new CollectorError('batch-not-closed', check.reason);
  return Object.fromEntries(ROLE_ORDER.map(role => [role, check.byRole.get(role)]));
}

function sameFileEvidence(a, b) {
  return ROLE_ORDER.every(role => a[role]
    && b[role]
    && a[role].generation === b[role].generation
    && a[role].size === b[role].size
    && a[role].sha256 === b[role].sha256);
}

export function manifestDigest(manifest) {
  const files = Array.isArray(manifest?.files)
    ? manifest.files
      .filter(file => file && typeof file === 'object')
      .map(file => ({
        role: file.role, generation: file.generation, size: file.size, sha256: file.sha256,
      }))
      .sort((a, b) => String(a.role).localeCompare(String(b.role)))
    : [];
  return sha256Json({
    jobId: manifest?.jobId,
    generation: manifest?.generation,
    complete: manifest?.complete,
    requiredRoles: manifest?.requiredRoles,
    files,
  });
}

function manifestEvidence(manifest, reads) {
  return {
    generation: manifest.generation,
    complete: manifest.complete,
    requiredRoles: manifest.requiredRoles,
    fileRoles: Array.isArray(manifest.files) ? manifest.files.map(file => file.role) : [],
    digest: manifestDigest(manifest),
    reads,
    observedAt: new Date().toISOString(),
  };
}

function evidenceFor(downloaded, expected, observedAt) {
  return ROLE_ORDER.map(role => ({
    role,
    generation: expected[role].generation,
    size: expected[role].size,
    sha256: expected[role].sha256,
    downloadedSize: downloaded[role].bytes.length,
    verified: downloaded[role].bytes.length === expected[role].size
      && sha256Hex(downloaded[role].bytes) === expected[role].sha256,
    downloadedAt: downloaded[role].downloadedAt,
    attempts: downloaded[role].attempts,
    observedAt,
  }));
}

export { KNOWN_ROLES, ROLE_ORDER };

import { createHash } from 'node:crypto';
import { serve, json, text, body } from '../lib/http.mjs';

export function filesFor(generation, { orphan = false, parseError = false } = {}) {
  return {
    samples: `id,label\nM1,籽粒\nM2,生长点\n`,
    assays: orphan
      ? `id,sampleId,value\nA1,M1,0.2\nA2,M404,${generation / 10}\n`
      : `id,sampleId,value\nA1,M1,0.2\nA2,M2,${generation / 10}\n`,
    revisions: parseError
      ? `sampleId,action\nM1,delete\n,delete\n`
      : `sampleId,action\nM1,delete\n`,
  };
}

/**
 * 本地演练用供应端。默认行为与 docs/protocol.md 一致：
 * 创建不幂等；第二次清单查询后 complete；闭合 generation=2。
 *
 * 额外演练开关（均可通过 POST /_control 设置）：
 *   completeAfterReads  第几次清单查询后 complete
 *   generation          闭合世代号
 *   ticket              当前下载 ticket
 *   expireTicketOnce    下一次取文件后旧链接失效
 *   lostCreateOnce      丢失一次创建响应（作业已创建）
 *   lostAckOnce         丢失一次确认响应（确认已生效）
 *   orphan              检测引用真正不存在的样品
 *   parseError          revisions 含一行解析错误（行级隔离，不影响整批）
 *   generationChangeOnce 首次下载后清单换代（第 2→3 代）
 *   missingRole          complete 清单中省略某个必需角色
 *   mismatchGeneration  某个角色的文件 generation 与清单不一致
 *   holdCriteria        在 complete 前让清单保持在未闭合次数（默认无）
 */
export async function createSite(port = 0) {
  return serve(async ({ request, response, url, state }) => {
    if (url.pathname === '/exports' && request.method === 'POST') {
      const content = await body(request);
      if (!content.requestKey) throw new Error('缺少 requestKey');
      // 源端创建不幂等：客户端必须自己按 requestKey 查重。
      const job = {
        jobId: `EXP-${state.jobs.length + 1}`,
        requestKey: content.requestKey,
        reads: 0,
        acknowledged: false,
        ackGeneration: null,
        generation: null,
        publicationHash: null,
      };
      state.jobs.push(job);
      if (state.lostCreateOnce) { state.lostCreateOnce = false; response.destroy(); return true; }
      json(response, 201, job); return true;
    }
    if (url.pathname === '/exports') {
      json(response, 200, state.jobs.filter(job => job.requestKey === url.searchParams.get('requestKey'))); return true;
    }
    const match = /^\/exports\/([^/]+)\/(manifest|ack)$/.exec(url.pathname);
    if (match) {
      const job = state.jobs.find(item => item.jobId === match[1]);
      if (!job) { json(response, 404, { error: '作业不存在' }); return true; }

      if (match[2] === 'ack' && request.method === 'POST') {
        const ack = await body(request);
        if (!job.generation || ack.generation !== job.generation || !ack.publicationHash) {
          json(response, 409, { error: '未闭合世代或回执不匹配' }); return true;
        }
        if (job.acknowledged && job.publicationHash !== ack.publicationHash) {
          json(response, 409, { error: '回执摘要冲突' }); return true;
        }
        job.acknowledged = true; job.ackGeneration = ack.generation; job.publicationHash = ack.publicationHash;
        if (state.lostAckOnce) { state.lostAckOnce = false; response.destroy(); return true; }
        json(response, 200, { accepted: true, jobId: job.jobId }); return true;
      }

      job.reads += 1;
      const threshold = state.completeAfterReads;
      let complete = job.reads >= threshold;
      if (state.holdCriteria && job.reads < state.holdCriteria) complete = false;
      const generation = complete ? state.generation : 1;
      if (complete) job.generation = generation;
      const files = filesFor(generation, { orphan: state.orphan, parseError: state.parseError });
      const completeRoles = ['samples', 'assays', 'revisions'];
      // mismatchGeneration: 让一个文件带上另一代的 generation，演练同代校验。
      const roles = complete ? completeRoles : ['samples'];
      const missingRole = complete && state.missingRole
        ? state.missingRole
        : null;
      const ticket = state.ticket;
      const manifest = {
        jobId: job.jobId,
        generation,
        complete,
        requiredRoles: ['samples', 'assays', 'revisions'],
        files: roles.filter(role => role !== missingRole).map(role => ({
          role,
          generation: state.mismatchGeneration && role === state.mismatchGeneration
            ? generation - 1
            : generation,
          size: Buffer.byteLength(files[role]),
          sha256: createHash('sha256').update(files[role]).digest('hex'),
          url: `/files/${job.jobId}/${generation}/${role}?ticket=${ticket}`,
        })),
      };
      json(response, 200, manifest); return true;
    }

    const fileMatch = /^\/files\/([^/]+)\/(\d+)\/(samples|assays|revisions)$/.exec(url.pathname);
    if (!fileMatch) return false;
    const job = state.jobs.find(item => item.jobId === fileMatch[1]);
    if (!job || job.acknowledged) { json(response, 410, { error: '文件已清理或不存在' }); return true; }
    if (state.expireTicketOnce) { state.expireTicketOnce = false; state.ticket += 1; }
    if (url.searchParams.get('ticket') !== String(state.ticket)) { json(response, 403, { error: 'download-link-expired' }); return true; }

    if (state.generationChangeOnce && !state.generationChanged) {
      // 首个文件取回后源端换代：后续清单进入第 3 代，旧代链接仍按旧内容响应。
      state.ticket += 1;
      state.generationChanged = true;
      state.generation = 3;
    }

    const generation = Number(fileMatch[2]);
    const files = filesFor(generation, { orphan: state.orphan, parseError: state.parseError });
    text(response, 200, files[fileMatch[3]], { 'content-type': 'text/csv; charset=utf-8' });
    return true;
  }, {
    jobs: [], generation: 2, completeAfterReads: 2, ticket: 1,
    expireTicketOnce: false, lostCreateOnce: false, lostAckOnce: false,
    orphan: false, parseError: false, generationChangeOnce: false,
    generationChanged: false, holdCriteria: 0,
    missingRole: null, mismatchGeneration: null,
  }, port);
}

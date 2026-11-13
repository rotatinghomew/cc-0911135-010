import { createHash } from 'node:crypto';
import { serve, json, text, body } from '../lib/http.mjs';
export function filesFor(generation, orphan = false) {
  return {
    samples: `id,label\nM1,籽粒\nM2,生长点\n`,
    assays: `id,sampleId,value\nA1,M1,0.2\nA2,${orphan ? 'M404' : 'M2'},${generation / 10}\n`,
    revisions: 'sampleId,action\nM1,delete\n',
  };
}
export async function createSite(port = 0) {
  return serve(async ({ request, response, url, state }) => {
    if (url.pathname === '/exports' && request.method === 'POST') {
      const content = await body(request);
      if (!content.requestKey) throw new Error('缺少 requestKey');
      const job = { jobId: `EXP-${state.jobs.length + 1}`, requestKey: content.requestKey, reads: 0, acknowledged: false, ackGeneration: null, generation: null };
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
        if (job.acknowledged && job.publicationHash !== ack.publicationHash) { json(response, 409, { error: '回执摘要冲突' }); return true; }
        job.acknowledged = true; job.ackGeneration = ack.generation; job.publicationHash = ack.publicationHash;
        if (state.lostAckOnce) { state.lostAckOnce = false; response.destroy(); return true; }
        json(response, 200, { accepted: true, jobId: job.jobId }); return true;
      }
      const complete = ++job.reads >= state.completeAfterReads;
      const generation = complete ? state.generation : 1;
      if (complete) job.generation = generation;
      const files = filesFor(generation, state.orphan);
      const roles = complete ? ['samples', 'assays', 'revisions'] : ['samples'];
      const manifest = { jobId: job.jobId, generation, complete, requiredRoles: ['samples', 'assays', 'revisions'], files: roles.map(role => ({
        role, generation, size: Buffer.byteLength(files[role]), sha256: createHash('sha256').update(files[role]).digest('hex'),
        url: `/files/${job.jobId}/${generation}/${role}?ticket=${state.ticket}`,
      })) };
      json(response, 200, manifest); return true;
    }
    const fileMatch = /^\/files\/([^/]+)\/(\d+)\/(samples|assays|revisions)$/.exec(url.pathname);
    if (!fileMatch) return false;
    const job = state.jobs.find(item => item.jobId === fileMatch[1]);
    if (!job || job.acknowledged) { json(response, 410, { error: '文件已清理或不存在' }); return true; }
    if (state.expireTicketOnce) { state.expireTicketOnce = false; state.ticket += 1; }
    if (url.searchParams.get('ticket') !== String(state.ticket)) { json(response, 403, { error: 'download-link-expired' }); return true; }
    text(response, 200, filesFor(Number(fileMatch[2]), state.orphan)[fileMatch[3]], { 'content-type': 'text/csv; charset=utf-8' }); return true;
  }, { jobs: [], generation: 2, completeAfterReads: 2, ticket: 1, expireTicketOnce: false, lostCreateOnce: false, lostAckOnce: false, orphan: false }, port);
}

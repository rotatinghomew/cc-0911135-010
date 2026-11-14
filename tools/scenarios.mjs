import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSite } from '../src/site.mjs';
import { createCollector, CollectorError } from '../src/collector.mjs';
import { createReader } from '../src/reader.mjs';
import { PublicationStore } from '../src/store.mjs';

const scenarios = [
  {
    key: '申请响应丢失',
    control: { lostCreateOnce: true, completeAfterReads: 1 },
    run: async (site, directory) => {
      const result = await collect(site, directory, 'LOST-CREATE');
      const sameKeyJobs = await jobs(site, 'LOST-CREATE');
      return { published: result.published, jobs: sameKeyJobs.length };
    },
  },
  {
    key: '未闭合',
    control: { completeAfterReads: 100, holdCriteria: 100 },
    run: async (site, directory, outcome) => {
      try {
        await collect(site, directory, 'OPEN', { waitTimeoutMs: 150, pollIntervalMs: 10 });
      } catch (error) { outcome.error = error.code; }
      const published = await createReader(directory).readPublished();
      const [job] = await jobs(site, 'OPEN');
      return { error: outcome.error, published: published !== null, acknowledged: job.acknowledged };
    },
  },
  {
    key: '清单换代',
    control: { completeAfterReads: 1, generationChangeOnce: true },
    run: async (site, directory) => {
      const result = await collect(site, directory, 'GEN', { maxBatchRestarts: 3, downloadAttempts: 2 });
      const published = await createReader(directory).readPublished();
      return {
        generation: result.generation,
        publishedGeneration: published.generation,
        assayValue: published.assays.find(assay => assay.id === 'A2').value,
      };
    },
  },
  {
    key: '链接失效',
    control: { completeAfterReads: 1, expireTicketOnce: true },
    run: async (site, directory) => {
      const result = await collect(site, directory, 'EXPIRE');
      const receipt = await readFile(path.join(directory, 'export-receipt.json'), 'utf8');
      return { published: result.published, verified: JSON.parse(receipt).files.every(file => file.verified) };
    },
  },
  {
    key: '引用删除',
    control: { completeAfterReads: 1 },
    run: async (site, directory) => {
      await collect(site, directory, 'DELETE');
      const published = await createReader(directory).readPublished();
      return {
        generation: published.generation,
        removedSamples: published.removed.samples.map(sample => sample.id),
        removedAssays: published.removed.assays.map(assay => assay.id),
        quarantine: published.quarantine.map(item => item.reason),
      };
    },
  },
  {
    key: '真正孤儿',
    control: { completeAfterReads: 1, orphan: true },
    run: async (site, directory) => {
      await collect(site, directory, 'ORPHAN');
      const published = await createReader(directory).readPublished();
      return {
        published: published !== null,
        quarantine: published.quarantine.map(item => ({ reason: item.reason, message: item.message })),
      };
    },
  },
  {
    key: '确认丢响应',
    control: { completeAfterReads: 1, lostAckOnce: true },
    run: async (site, directory) => {
      let firstCode = null;
      try {
        await collect(site, directory, 'LOST-ACK', { ackAttempts: 1 });
      } catch (error) { firstCode = error.code; }
      const readableDuringLoss = (await createReader(directory).readPublished()) !== null;
      const retried = await collect(site, directory, 'LOST-ACK');
      return {
        firstError: firstCode, readableDuringLoss,
        acknowledgedAfterRetry: retried.acknowledged,
        jobs: (await jobs(site, 'LOST-ACK')).length,
      };
    },
  },
  {
    key: '等待上限',
    control: { completeAfterReads: 100, holdCriteria: 100 },
    run: async (site, directory, outcome) => {
      try {
        await collect(site, directory, 'LIMIT', { waitTimeoutMs: 150, pollIntervalMs: 10 });
      } catch (error) { outcome.error = error.code; }
      const state = JSON.parse(await readFile(path.join(directory, 'state.json'), 'utf8'));
      return {
        error: outcome.error,
        jobRetained: Boolean(state.jobs.LIMIT?.jobId),
        status: state.jobs.LIMIT?.status,
        published: (await createReader(directory).readPublished()) !== null,
      };
    },
  },
];

function collect(site, directory, key, overrides = {}) {
  return createCollector({
    baseUrl: site.url, requestKey: key, store: directory,
    waitTimeoutMs: 5_000, pollIntervalMs: 10, retryDelayMs: 1, ...overrides,
  }).collect();
}

async function jobs(site, key) {
  return (await fetch(`${site.url}/exports?requestKey=${encodeURIComponent(key)}`)).json();
}

async function runScenario(scenario) {
  const site = await createSite();
  const directory = await mkdtemp(path.join(tmpdir(), 'joint-export-scenario-'));
  try {
    await fetch(site.url + '/_control', { method: 'POST', body: JSON.stringify(scenario.control) });
    const outcome = {};
    const evidence = await scenario.run(site, directory, outcome);
    return { scenario: scenario.key, ok: true, evidence };
  } catch (error) {
    return {
      scenario: scenario.key, ok: false,
      error: error instanceof CollectorError ? error.code : 'unexpected',
      message: error.message,
    };
  } finally {
    await site.close();
    await rm(directory, { recursive: true, force: true });
  }
}

const selected = process.argv[2]
  ? scenarios.filter(scenario => scenario.key.includes(process.argv[2]))
  : scenarios;
if (selected.length === 0) throw new Error(`没有匹配的演练：${process.argv[2]}`);

const results = [];
for (const scenario of selected) results.push(await runScenario(scenario));
console.log(JSON.stringify(results, null, 2));
if (results.some(result => !result.ok)) process.exitCode = 1;

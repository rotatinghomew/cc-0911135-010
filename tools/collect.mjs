import { parseArgs } from 'node:util';
import { createCollector, DEFAULTS } from '../src/collector.mjs';
import { createReader } from '../src/reader.mjs';
import { PublicationStore } from '../src/store.mjs';

function usage() {
  return `用法：
  node tools/collect.mjs --request-key KEY [--url URL] [--store DIR]
                         [--wait-timeout-ms N] [--poll-interval-ms N]

  node tools/collect.mjs --read [--store DIR] [--receipt]

说明：
  --request-key  稳定申请键；同一键重试会复用既有作业
  --url          供应端地址；也可用环境变量 JOINT_EXPORT_URL
  --store        本地仓库目录，默认 var/collector
  --wait-timeout-ms  等待闭合批次的上限，默认 ${DEFAULTS.waitTimeoutMs}
  --read         读取当前完整发布（下游接口）；没有发布时退出码 3
  --receipt      与 --read 一起使用时输出 export-receipt.json 内容
`;
}

function numberOption(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} 必须是正数`);
  return parsed;
}

async function main() {
  const { values } = parseArgs({
    options: {
      url: { type: 'string' },
      'request-key': { type: 'string' },
      store: { type: 'string' },
      'wait-timeout-ms': { type: 'string' },
      'poll-interval-ms': { type: 'string' },
      read: { type: 'boolean', default: false },
      receipt: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  const directory = values.store || 'var/collector';

  if (values.help) { process.stdout.write(usage()); return 0; }

  if (values.read) {
    const reader = createReader(directory);
    const published = await reader.readPublished();
    if (!published) { process.stderr.write('当前没有完整发布\n'); return 3; }
    const payload = values.receipt ? published.receipt : published;
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  }

  const requestKey = values['request-key'];
  const baseUrl = values.url || process.env.JOINT_EXPORT_URL;
  if (!requestKey || !baseUrl) {
    process.stderr.write(usage());
    return 2;
  }

  const collector = createCollector({
    baseUrl,
    requestKey,
    store: new PublicationStore(directory),
    waitTimeoutMs: values['wait-timeout-ms']
      ? numberOption(values['wait-timeout-ms'], 'wait-timeout-ms')
      : DEFAULTS.waitTimeoutMs,
    pollIntervalMs: values['poll-interval-ms']
      ? numberOption(values['poll-interval-ms'], 'poll-interval-ms')
      : DEFAULTS.pollIntervalMs,
    logger: (event, detail) => process.stderr.write(`${JSON.stringify({ event, ...detail })}\n`),
  });

  const result = await collector.collect();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    error: error.code || error.name || 'error',
    message: error.message,
    details: error.details ?? null,
  })}\n`);
  process.exitCode = 1;
}

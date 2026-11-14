import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from '../src/csv.mjs';
import { reconcile } from '../src/reconcile.mjs';
import { canonicalJson, sha256Json } from '../lib/canonical.mjs';

test('CSV 解析支持 UTF-8、CRLF 与引号', () => {
  const parsed = parseCsv('id,label\r\nM1,"籽粒, 精选"\r\nM2,"含""引号"""\r\n', { role: 'samples' });
  assert.equal(parsed.fatal, null);
  assert.deepEqual(parsed.rows, [
    { id: 'M1', label: '籽粒, 精选' },
    { id: 'M2', label: '含"引号"' },
  ]);
  assert.deepEqual(parsed.quarantine, []);
});

test('CSV 行级错误进入解析隔离并保留行号', () => {
  const parsed = parseCsv('id,sampleId,value\nA1,M1,0.2\nA2,M1,not-a-number\nA3,,0.4\n', { role: 'assays' });
  assert.equal(parsed.fatal, null);
  assert.deepEqual(parsed.rows, [{ id: 'A1', sampleId: 'M1', value: 0.2 }]);
  assert.deepEqual(parsed.quarantine.map(item => item.reason), ['parse-error', 'parse-error']);
  assert.deepEqual(parsed.quarantine.map(item => item.code), ['invalid-number', 'missing-sample-id']);
  assert.deepEqual(parsed.quarantine.map(item => item.line), [3, 4]);
});

test('CSV 结构性损坏使整份文件不可发布', () => {
  const mismatch = parseCsv('id,label,extra\nM1,a,b\n', { role: 'samples' });
  assert.equal(mismatch.fatal.code, 'header-mismatch');

  const unclosed = parseCsv('id,label\nM1,"未闭合\n', { role: 'samples' });
  assert.equal(unclosed.fatal.code, 'unclosed-quote');

  const empty = parseCsv('', { role: 'samples' });
  assert.equal(empty.fatal.code, 'empty-file');
});

test('引用删除移除检测，真正缺失引用被隔离', () => {
  const result = reconcile({
    samples: [{ id: 'M1', label: 'a' }, { id: 'M2', label: 'b' }],
    assays: [{ id: 'A1', sampleId: 'M1', value: 1 }, { id: 'A2', sampleId: 'M2', value: 2 }],
    revisions: [{ sampleId: 'M1', action: 'delete' }, { sampleId: 'M404', action: 'delete' }],
    quarantine: [{ reason: 'parse-error', role: 'samples', line: 9 }],
  });
  assert.deepEqual(result.samples.map(sample => sample.id), ['M2']);
  assert.deepEqual(result.assays.map(assay => assay.id), ['A2']);
  assert.deepEqual(result.removed.samples.map(sample => sample.id), ['M1']);
  assert.deepEqual(result.removed.assays.map(assay => assay.id), ['A1']);
  assert.deepEqual(result.quarantine.map(item => item.reason).sort(),
    ['parse-error', 'revision-target-missing']);
});

test('孤儿检测与解析错误理由不同', () => {
  const result = reconcile({
    samples: [{ id: 'M1', label: 'a' }],
    assays: [{ id: 'A1', sampleId: 'M1', value: 1 }, { id: 'A9', sampleId: 'M9', value: 9 }],
    revisions: [],
    quarantine: [{ reason: 'parse-error', role: 'revisions', line: 2 }],
  });
  const reasons = result.quarantine.map(item => item.reason).sort();
  assert.deepEqual(reasons, ['missing-sample-reference', 'parse-error']);
  const missing = result.quarantine.find(item => item.reason === 'missing-sample-reference');
  assert.equal(missing.record.id, 'A9');
});

test('重复编号被隔离，保留首条', () => {
  const result = reconcile({
    samples: [{ id: 'M1', label: 'first' }, { id: 'M1', label: 'second' }],
    assays: [{ id: 'A1', sampleId: 'M1', value: 1 }, { id: 'A1', sampleId: 'M1', value: 2 }],
    revisions: [],
  });
  assert.deepEqual(result.samples, [{ id: 'M1', label: 'first' }]);
  assert.deepEqual(result.assays, [{ id: 'A1', sampleId: 'M1', value: 1 }]);
  assert.deepEqual(result.quarantine.map(item => item.reason), ['duplicate-id', 'duplicate-id']);
});

test('规范化摘要不受键顺序影响，数组顺序仍然有效', () => {
  const left = { b: 1, a: [{ y: 2, x: 1 }] };
  const right = { a: [{ x: 1, y: 2 }], b: 1 };
  assert.equal(canonicalJson(left), canonicalJson(right));
  assert.equal(sha256Json(left), sha256Json(right));
  assert.notEqual(sha256Json({ a: [1, 2] }), sha256Json({ a: [2, 1] }));
});

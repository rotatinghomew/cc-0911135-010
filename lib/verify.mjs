import assert from 'node:assert/strict';

export function verify(value) {
  assert.ok(value.jobId && Number.isInteger(value.generation));
  if (value.acknowledged) assert.equal(value.published, true);
  if (value.published) {
    assert.equal(value.complete, true);
    assert.match(value.publicationHash, /^[a-f0-9]{64}$/);
    assert.deepEqual(value.files.map(file => file.role).sort(), ['assays', 'revisions', 'samples']);
    for (const file of value.files) { assert.equal(file.generation, value.generation); assert.equal(file.verified, true); }
    const ids = new Set(value.samples.map(sample => sample.id));
    for (const assay of value.assays) assert.ok(ids.has(assay.sampleId), '存在孤儿检测');
  }
}

import assert from 'node:assert/strict';

export function verify(value) {
  assert.ok(value.jobId && Number.isInteger(value.generation));
  if (value.acknowledged) assert.equal(value.published, true);
  if (value.published) {
    assert.equal(value.complete, true);
    assert.match(value.publicationHash, /^[a-f0-9]{64}$/);
    assert.deepEqual(value.files.map(file => file.role).sort(), ['assays', 'revisions', 'samples']);
    for (const file of value.files) {
      assert.equal(file.generation, value.generation);
      assert.equal(file.verified, true);
      assert.match(file.sha256, /^[a-f0-9]{64}$/);
      assert.equal(file.size, file.downloadedSize);
    }
    // 回执必须说明它来自哪一版清单，并与发布代一致。
    assert.equal(value.manifest.generation, value.generation);
    assert.equal(value.manifest.complete, true);
    assert.match(value.manifest.digest, /^[a-f0-9]{64}$/);
    assert.deepEqual([...value.manifest.requiredRoles].sort(), ['assays', 'revisions', 'samples']);

    const ids = new Set(value.samples.map(sample => sample.id));
    for (const assay of value.assays) assert.ok(ids.has(assay.sampleId), '存在孤儿检测');
    for (const item of value.quarantine) assert.ok(item.reason, '隔离项必须带理由');
    assert.ok(!value.quarantine.some(item => item.reason === 'missing-sample-reference'
      && ids.has(item.record?.sampleId)), '已发布的样品不应被报为缺失引用');
  }
}

/**
 * 将三份逻辑文件收敛成可发布的样品与检测。
 *
 * - revisions 中 delete 的样品会连同引用它的检测一起移除（正常修订，不是孤儿）。
 * - 修订后仍未找到样品的检测进入隔离，理由与解析错误不同。
 * - 重复编号进入隔离，避免下游看到含义不明的记录。
 */
export function reconcile({ samples = [], assays = [], revisions = [], quarantine = [] }) {
  const isolated = [...quarantine];
  const removed = { samples: [], assays: [] };
  const sampleById = new Map();
  const allSampleIds = new Set();

  for (const sample of samples) {
    allSampleIds.add(sample.id);
    if (sampleById.has(sample.id)) {
      isolated.push({
        reason: 'duplicate-id', role: 'samples', line: sample.line,
        message: `样品 id 重复：${sample.id}`, record: sample,
      });
      continue;
    }
    sampleById.set(sample.id, sample);
  }

  const deleted = new Set();
  for (const revision of revisions) {
    if (!allSampleIds.has(revision.sampleId)) {
      isolated.push({
        reason: 'revision-target-missing', role: 'revisions', line: revision.line,
        message: `修订指向不存在的样品：${revision.sampleId}`, record: revision,
      });
      continue;
    }
    deleted.add(revision.sampleId);
  }

  const publishedSamples = [];
  for (const sample of sampleById.values()) {
    if (deleted.has(sample.id)) removed.samples.push(sample);
    else publishedSamples.push(sample);
  }

  const assayById = new Map();
  const publishedAssays = [];
  for (const assay of assays) {
    if (assayById.has(assay.id)) {
      isolated.push({
        reason: 'duplicate-id', role: 'assays', line: assay.line,
        message: `检测 id 重复：${assay.id}`, record: assay,
      });
      continue;
    }
    assayById.set(assay.id, assay);

    if (deleted.has(assay.sampleId)) {
      // 样品被修订删除，其检测属于同一删除动作，不是未知引用。
      removed.assays.push(assay);
      continue;
    }
    if (!sampleById.has(assay.sampleId)) {
      isolated.push({
        reason: 'missing-sample-reference', role: 'assays', line: assay.line,
        message: `检测 ${assay.id} 引用了不存在的样品 ${assay.sampleId}`,
        record: assay,
      });
      continue;
    }
    publishedAssays.push(assay);
  }

  return {
    samples: publishedSamples.map(stripInternal),
    assays: publishedAssays.map(stripInternal),
    quarantine: isolated.map(stripInternal),
    removed: {
      samples: removed.samples.map(stripInternal),
      assays: removed.assays.map(stripInternal),
    },
  };
}

function stripInternal(value) {
  const clone = {};
  for (const key of Object.keys(value)) clone[key] = value[key];
  return clone;
}

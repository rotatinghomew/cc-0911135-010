const COLUMNS = {
  samples: ['id', 'label'],
  assays: ['id', 'sampleId', 'value'],
  revisions: ['sampleId', 'action'],
};

/**
 * 解析供应端导出的 UTF-8 CSV。
 *
 * 结构性错误（未闭合引号、表头不匹配）会让整份文件不可用，调用方不得发布；
 * 单行错误进入隔离，保留可用的行，隔离理由为 parse-error。
 */
export function parseCsv(input, { role } = {}) {
  if (!COLUMNS[role]) throw new Error(`未知逻辑角色：${role}`);
  if (typeof input !== 'string') throw new TypeError('CSV 内容必须是字符串');
  const text = input.replace(/^﻿/, '');
  const tokenized = tokenize(text);
  if (tokenized.error) return { rows: [], quarantine: [], fatal: tokenized.error };

  const records = tokenized.records.filter(record => !(record.fields.length === 1 && record.fields[0] === ''));
  if (records.length === 0) {
    return { rows: [], quarantine: [], fatal: { code: 'empty-file', role, message: '文件没有表头' } };
  }

  const header = records[0].fields;
  const expected = COLUMNS[role];
  if (!sameFields(header, expected)) {
    return {
      rows: [],
      quarantine: [],
      fatal: {
        code: 'header-mismatch', role, line: records[0].line,
        message: `表头应为 ${expected.join(',')}，实际为 ${header.join(',')}`,
      },
    };
  }

  const rows = [];
  const quarantine = [];
  for (const record of records.slice(1)) {
    if (record.fields.length !== header.length) {
      quarantine.push(rowError(role, record, 'column-count', `应有 ${header.length} 列，实际 ${record.fields.length} 列`));
      continue;
    }
    const mapped = Object.fromEntries(header.map((name, index) => [name, record.fields[index]]));
    const parsed = parseRow(role, mapped, record);
    if (parsed.error) quarantine.push(parsed.error);
    else rows.push(parsed.row);
  }
  return { rows, quarantine, fatal: null };
}

function sameFields(actual, expected) {
  return actual.length === expected.length && expected.every((field, index) => actual[index] === field);
}

function parseRow(role, fields, record) {
  const fail = (code, message) => ({ error: rowError(role, record, code, message) });
  const nonEmpty = value => typeof value === 'string' && value.trim() !== '';

  if (role === 'samples') {
    if (!nonEmpty(fields.id)) return fail('missing-id', '样品缺少 id');
    return { row: withLine({ id: fields.id, label: fields.label ?? '' }, record.line) };
  }

  if (role === 'assays') {
    if (!nonEmpty(fields.id)) return fail('missing-id', '检测缺少 id');
    if (!nonEmpty(fields.sampleId)) return fail('missing-sample-id', '检测缺少 sampleId');
    if (!nonEmpty(fields.value)) return fail('missing-value', '检测缺少 value');
    const value = Number(fields.value);
    if (!Number.isFinite(value)) return fail('invalid-number', `value 不是有限数值：${fields.value}`);
    return { row: withLine({ id: fields.id, sampleId: fields.sampleId, value }, record.line) };
  }

  if (!nonEmpty(fields.sampleId)) return fail('missing-sample-id', '修订缺少 sampleId');
  if (!nonEmpty(fields.action)) return fail('missing-action', '修订缺少 action');
  if (fields.action !== 'delete') return fail('unsupported-action', `不支持的修订动作：${fields.action}`);
  return { row: withLine({ sampleId: fields.sampleId, action: 'delete' }, record.line) };
}

function rowError(role, record, code, message) {
  return {
    reason: 'parse-error', role, code, line: record.line,
    message, fields: record.fields,
  };
}

function withLine(row, line) {
  // 行号用于隔离证据，但不进入发布数据的 JSON 载荷。
  Object.defineProperty(row, 'line', { value: line, enumerable: false });
  return row;
}

function tokenize(text) {
  const records = [];
  let fields = [];
  let field = '';
  let inQuotes = false;
  let recordStartLine = 1;
  let line = 1;
  let recordStartIndex = 0;
  let index = 0;

  const finishField = () => { fields.push(field); field = ''; };
  const finishRecord = (endIndex) => {
    finishField();
    records.push({
      fields, line: recordStartLine,
      raw: text.slice(recordStartIndex, endIndex),
    });
    fields = [];
    recordStartLine = line;
  };

  while (index < text.length) {
    const char = text[index];
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') { field += '"'; index += 2; continue; }
        inQuotes = false; index += 1; continue;
      }
      if (char === '\n') line += 1;
      field += char; index += 1; continue;
    }

    if (char === '"' && field === '') { inQuotes = true; index += 1; continue; }
    if (char === ',') { finishField(); index += 1; continue; }
    if (char === '\r' && text[index + 1] === '\n') { index += 1; continue; }
    if (char === '\n') {
      line += 1;
      finishRecord(index + 1);
      index += 1;
      recordStartIndex = index;
      recordStartLine = line;
      continue;
    }
    field += char;
    index += 1;
  }

  if (inQuotes) {
    return { records: [], error: { code: 'unclosed-quote', line: recordStartLine, message: '存在未闭合的引号' } };
  }
  if (field !== '' || fields.length > 0) finishRecord(index);
  return { records, error: null };
}

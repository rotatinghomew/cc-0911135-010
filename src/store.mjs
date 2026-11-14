import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { sha256Json } from '../lib/canonical.mjs';

const STATE_VERSION = 1;

/**
 * 本地发布仓库。
 *
 * 目录结构：
 *   state.json                         作业与确认状态（原子替换）
 *   current.json                       正式发布指针（原子替换，下游唯一入口）
 *   export-receipt.json                当前发布的可读回执
 *   publications/<jobId>/gen-.../      不可变发布快照：原始 CSV、结构化数据、回执
 *   acks/<jobId>.json                  确认结果旁证
 *
 * 快照完整落盘并校验后才写入 current.json；下游只解析指针，因此永远看不到
 * 半成品。指针之外的孤儿快照（中断产生）对下游不可见。
 */
export class PublicationStore {
  constructor(directory) {
    this.root = path.resolve(directory);
  }

  get stateFile() { return path.join(this.root, 'state.json'); }
  get pointerFile() { return path.join(this.root, 'current.json'); }
  get receiptFile() { return path.join(this.root, 'export-receipt.json'); }

  async ensure() {
    await mkdir(this.root, { recursive: true });
    await mkdir(path.join(this.root, 'publications'), { recursive: true });
    await mkdir(path.join(this.root, 'acks'), { recursive: true });
    return this;
  }

  async loadState() {
    const value = await readJsonIfPresent(this.stateFile);
    if (!value) return { version: STATE_VERSION, jobs: {} };
    if (value.version !== STATE_VERSION || typeof value.jobs !== 'object' || value.jobs === null) {
      throw new Error(`无法识别的状态文件：${this.stateFile}`);
    }
    return value;
  }

  async saveState(state) {
    await writeJsonAtomic(this.stateFile, { ...state, version: STATE_VERSION });
  }

  snapshotDirectory(jobId, generation, publicationHash) {
    return path.join(this.root, 'publications', safeSegment(jobId),
      `gen-${generation}-${publicationHash.slice(0, 16)}`);
  }

  async hasSnapshot(snapshotPath) {
    const absolute = this.resolveInside(snapshotPath);
    try {
      await access(path.join(absolute, 'receipt.json'), constants.R_OK);
      await access(path.join(absolute, 'data.json'), constants.R_OK);
      return true;
    } catch { return false; }
  }

  /** 完整写入不可变快照，返回相对仓库根的路径。 */
  async writeSnapshot({ jobId, generation, publicationHash, receipt, data, rawFiles }) {
    if (publicationHashOf(data) !== publicationHash) {
      throw new Error('写入快照前发现发布数据与摘要不一致');
    }
    const finalDirectory = this.snapshotDirectory(jobId, generation, publicationHash);
    const relative = path.relative(this.root, finalDirectory);
    if (await this.hasSnapshot(relative)) {
      const existing = await readJson(path.join(finalDirectory, 'receipt.json'));
      if (existing.publicationHash !== publicationHash) {
        throw new Error('同一路径下已存在不同内容的发布快照');
      }
      return relative;
    }

    const parent = path.dirname(finalDirectory);
    await mkdir(parent, { recursive: true });
    const staging = await mkdtempAt(parent);

    try {
      const fileEntries = [];
      for (const [role, bytes] of Object.entries(rawFiles)) {
        const filename = `${role}.csv`;
        await writeFileDurable(path.join(staging, filename), bytes);
        fileEntries.push({ role, path: filename, size: bytes.length });
      }
      await writeFileDurable(path.join(staging, 'data.json'),
        Buffer.from(`${JSON.stringify(data, null, 2)}\n`, 'utf8'));
      await writeFileDurable(path.join(staging, 'receipt.json'),
        Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, 'utf8'));
      await writeFileDurable(path.join(staging, 'MANIFEST.json'),
        Buffer.from(`${JSON.stringify({ publicationHash, generation, jobId, rawFiles: fileEntries }, null, 2)}\n`, 'utf8'));
      await fsyncDirectory(staging);

      try {
        await rename(staging, finalDirectory);
      } catch (error) {
        if (error.code !== 'EEXIST' && error.code !== 'ENOTEMPTY') throw error;
        // 另一个进程已完成同一摘要的发布，复用已有快照。
        await rm(staging, { recursive: true, force: true });
      }
      await fsyncDirectory(parent);
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    return relative;
  }

  async readPointer() {
    return readJsonIfPresent(this.pointerFile);
  }

  async writePointer(pointer) {
    await writeJsonAtomic(this.pointerFile, pointer);
  }

  async readSnapshot(snapshotPath) {
    const absolute = this.resolveInside(snapshotPath);
    const [data, receipt, manifest] = await Promise.all([
      readJson(path.join(absolute, 'data.json')),
      readJson(path.join(absolute, 'receipt.json')),
      readJson(path.join(absolute, 'MANIFEST.json')).catch(() => null),
    ]);
    if (data.publicationHash !== receipt.publicationHash) {
      throw new Error('发布数据的摘要与回执不一致');
    }
    if (publicationHashOf(data) !== data.publicationHash) {
      throw new Error('发布快照内容与 publicationHash 不一致');
    }
    return { data, receipt, manifest, directory: absolute };
  }

  /**
   * 下游读取接口。没有正式发布时返回 null；指针存在但快照不完整时抛错，
   * 绝不降级返回部分数据。
   */
  async readPublished() {
    const pointer = await this.readPointer();
    if (!pointer) return null;
    const { data, receipt: snapshotReceipt } = await this.readSnapshot(pointer.snapshot);
    if (snapshotReceipt.published !== true || snapshotReceipt.complete !== true) {
      throw new Error('发布指针指向的世代未完整发布');
    }
    if (snapshotReceipt.jobId !== pointer.jobId
      || snapshotReceipt.generation !== pointer.generation
      || snapshotReceipt.publicationHash !== pointer.publicationHash) {
      throw new Error('发布指针与快照证据不一致');
    }
    if (publicationHashOf(data) !== pointer.publicationHash) {
      throw new Error('发布数据内容与 publicationHash 不一致');
    }
    // 顶层回执记录了确认状态；只有摘要一致时才采用，避免读到过期回执。
    const topReceipt = await readJsonIfPresent(this.receiptFile).catch(() => null);
    const receipt = topReceipt
      && topReceipt.publicationHash === pointer.publicationHash
      && topReceipt.jobId === pointer.jobId
      && topReceipt.generation === pointer.generation
      ? topReceipt
      : snapshotReceipt;
    return {
      jobId: data.jobId,
      generation: data.generation,
      publicationHash: data.publicationHash,
      publishedAt: data.publishedAt,
      samples: data.samples,
      assays: data.assays,
      quarantine: data.quarantine,
      removed: data.removed,
      files: data.files,
      receipt,
    };
  }

  async writeTopReceipt(receipt) {
    await writeJsonAtomic(this.receiptFile, receipt);
  }

  async writeAckRecord(jobId, value) {
    const file = path.join(this.root, 'acks', `${safeSegment(jobId)}.json`);
    await writeJsonAtomic(file, value);
  }

  resolveInside(relative) {
    const absolute = path.resolve(this.root, relative);
    if (absolute !== this.root && !absolute.startsWith(this.root + path.sep)) {
      throw new Error('发布路径越出本地仓库');
    }
    return absolute;
  }
}

export function safeSegment(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]+$/.test(value) || value === '.' || value === '..') {
    throw new Error(`不安全的本地路径片段：${String(value)}`);
  }
  return value;
}

/** 与采集端发布时相同的摘要口径，供读取方独立复核。 */
export function publicationHashOf(data) {
  return sha256Json({
    jobId: data.jobId,
    generation: data.generation,
    files: (data.files || []).map(file => ({
      role: file.role, generation: file.generation, size: file.size, sha256: file.sha256,
    })),
    samples: data.samples,
    assays: data.assays,
    quarantine: data.quarantine,
    removed: data.removed,
  });
}

async function readJsonIfPresent(file) {
  try {
    return await readJson(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

export async function writeJsonAtomic(file, value) {
  const temporary = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  await mkdir(path.dirname(file), { recursive: true });
  try {
    await writeFileDurable(temporary, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'));
    await rename(temporary, file);
    await fsyncDirectory(path.dirname(file));
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export async function writeFileDurable(file, bytes) {
  const handle = await open(file, 'w');
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function fsyncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch (error) {
    // 某些平台不支持目录 fsync；文件本身已完成 fsync。
    if (!['EINVAL', 'EISDIR', 'EPERM', 'ENOTSUP'].includes(error.code)) throw error;
  } finally {
    await handle?.close();
  }
}

async function mkdtempAt(parent) {
  const template = path.join(parent, '.staging-');
  const directory = `${template}${process.pid}-${randomBytes(6).toString('hex')}`;
  await mkdir(directory, { recursive: false });
  return directory;
}

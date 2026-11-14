import { PublicationStore } from './store.mjs';

/**
 * 下游读取接口：保持原来的“读取当前已发布数据”语义。
 *
 * 唯一变化是它只解析正式发布指针，因此任何时刻要么读到上一条完整世代，
 * 要么读到新的完整世代；未闭合批次、正在下载的文件、中断留下的孤儿快照
 * 都不可见。没有发布时返回 null（或按调用方要求报错）。
 */
export function createReader(storeOrPath) {
  const store = storeOrPath instanceof PublicationStore
    ? storeOrPath
    : new PublicationStore(storeOrPath);

  return {
    async readPublished() {
      return store.readPublished();
    },

    async readSamples() {
      const published = await store.readPublished();
      return published ? published.samples : null;
    },

    async readAssays() {
      const published = await store.readPublished();
      return published ? published.assays : null;
    },

    /** 读取当前发布回执（含清单版本与各文件证据）。 */
    async readReceipt() {
      const published = await store.readPublished();
      return published ? published.receipt : null;
    },
  };
}

export async function readPublished(directory) {
  return createReader(directory).readPublished();
}

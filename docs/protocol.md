# 供应端协议与采集端契约

## 供应端 HTTP 接口

POST /exports {requestKey} 创建作业，不承诺幂等；GET /exports?requestKey=... 查询全部同键作业。GET /exports/{jobId}/manifest 返回 complete、generation、requiredRoles、files。默认第二次查询后 complete；闭合 generation=2，初始 generation=1。文件含 role、generation、size、sha256、url，文件 URL 携带短期 ticket。

POST /_control 可设置 completeAfterReads、generation、ticket、expireTicketOnce（首次取文件使旧链接过期）、lostCreateOnce、lostAckOnce、orphan、parseError、generationChangeOnce、holdCriteria。文件是 UTF-8 CSV；samples.id 被 assays.sampleId 引用，revisions 删除样品时应同步剔除其检测，真正不存在的 M404 属于隔离理由而非删除。

POST /exports/{jobId}/ack {generation,publicationHash} 为消费确认，相同世代和摘要可重复确认；之后文件返回 410。本地发布前不能调用。

`/_audit` 为源端请求证据，`/_control` 只用于演练，不属于业务采集入口。

## 采集端判定规则

### 申请

- 始终携带稳定 `requestKey`。
- 创建前先 GET /exports?requestKey=...；存在作业即复用，不再创建。
- 创建请求超时、连接中断或 5xx 时，先重新查重，再决定是否重试。查重本身失败时不得贸然创建。重试次数有上限（默认 3），且固定复用同键最早作业。

### 等待闭合

清单只有同时满足以下条件才可下载：

1. `complete === true`；
2. `generation` 为正整数；
3. `requiredRoles` 覆盖 `samples`、`assays`、`revisions`，且没有未知角色；
4. 每个必需角色恰好一个文件；
5. 每个文件的 `generation` 等于清单 `generation`；
6. 每个文件的 `size`、`sha256`、`url` 字段完整且格式有效。

等待受两个上限约束：整体 `waitTimeoutMs`（默认 30000）与清单读取次数 `maxManifestReads`（默认 500）。超限以 `wait-timeout` / `wait-limit` 退出，保留作业状态与最后观察到的清单证据，不发布、不确认。

### 下载与校验

- 逐角色下载，长度和 sha256 必须与清单一致。
- 403/404/410 视为链接过期或文件被清理：重新读取清单。若仍是同一 `complete generation` 且该角色 `size`、`sha256` 未变，只替换 URL 并复用本批；`generation` 或内容证据改变则丢弃已下载内容，整批重来。
- 下载内容与摘要不一致时不按旧摘要放行；同样先刷新清单判断是过期链接还是换代。
- 全部文件就绪后、发布前再读一次清单。只有 generation 相同且三份文件证据完全一致才发布。

### 结构化接收

- 表头固定：`samples(id,label)`、`assays(id,sampleId,value)`、`revisions(sampleId,action)`。
- 单行结构错误（列数、空 id、非数值 value、未知 action）进入隔离，理由 `parse-error`，携带 role/line/code。
- 未闭合引号、表头不匹配、空文件属于结构性损坏，整批不发布（`file-not-publishable`）。
- 重复 `samples.id` / `assays.id` 以 `duplicate-id` 隔离。
- 修订 `delete` 的样品与其检测属于正常移除（`removed`），不进入隔离。
- 修订后仍不存在的检测引用以 `missing-sample-reference` 隔离，与解析错误区分。
- 可隔离的行不阻止其余完整数据发布；隔离内容随回执一起公开。

### 发布与确认顺序

1. 将原始 CSV、结构化数据、快照回执原子写入 `publications/<jobId>/gen-<n>-<hash>/`。
2. 在 `state.json` 记 `pendingPublication`。
3. 原子替换 `current.json` 指向该快照，并写顶层 `export-receipt.json`。此时下游可见。
4. 调用 `/ack {generation, publicationHash}`；成功后在 `acks/` 落旁证并更新回执。

中断恢复：

- 快照已写、指针未写：重启后直接补写指针，不重新下载，不确认未发布数据。
- 指针已写、确认未完成：重启后只补发相同确认。
- 确认响应丢失：回执保持 `ack.status=pending`，已发布数据仍可读；重启补发相同 `generation` 与 `publicationHash`。

## export-receipt.json

```
jobId, requestKey, generation, complete, published, acknowledged,
publicationHash, publishedAt,
manifest: { generation, complete, requiredRoles, digest, observedAt, reads },
files: [{ role, generation, size, sha256, downloadedSize, verified, downloadedAt, observedAt }],
samples, assays, quarantine, removed,
ack: { status, attempts, generation, publicationHash, ... }
```

`publicationHash` 是对 `{jobId, generation, files(role/generation/size/sha256), samples, assays, quarantine, removed}` 的规范化 JSON 摘要，可在重启后重算比对。

## 下游读取契约

`createReader(directory)` 保持原有读接口语义：

- `readPublished()`：返回当前完整发布；没有发布返回 `null`。
- `readSamples()` / `readAssays()`：同上，只含结构化数据。
- `readReceipt()`：当前发布的回执。

读取只经 `current.json`。指针不存在时返回 `null`；指针指向的快照缺失或不完整时抛错，绝不降级为部分数据。孤儿快照、下载中的文件、未闭合批次都不会被读到。

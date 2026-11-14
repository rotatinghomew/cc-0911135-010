# joint-export-collector

联合试验的异步导出供应端，以及以批次闭合为准的采集入口。

## 环境与命令

Node.js 22.23.4，依赖使用 package-lock.json 固定。准备阶段运行 `npm ci`。


```bash
npm run build
npm test
npm run demo
npm start
```

`npm start` 输出本次监听地址，另一个终端可运行 `npm run probe -- http://127.0.0.1:端口`。服务只监听本机。`PORT` 可指定端口，Ctrl-C 结束。

`npm run build` 检查所有模块的 JavaScript 语法，无需生成打包文件；`npm test` 检查源端协议、正常及异常响应，以及采集端到确认的完整产品路径。

## 采集入口

```bash
# 申请、有界等待、下载、校验、结构化接收、发布、确认
node tools/collect.mjs --url http://127.0.0.1:端口 --request-key KEY --store var/collector

# 下游读取接口：只返回当前完整的一代；没有发布时退出码 3
node tools/collect.mjs --read --store var/collector
node tools/collect.mjs --read --receipt --store var/collector
```

同一 `requestKey` 重复运行会先查询既有作业，再决定是否创建；创建响应超时不会产生第二个作业。等待上限由 `--wait-timeout-ms`（默认 30000）和 `--poll-interval-ms` 控制，另有清单读取次数上限，不做无界轮询。

采集路径只发布满足以下条件的批次：清单 `complete=true`、所有必需角色都来自同一 `generation`、文件长度与 sha256 全部匹配、下载后发布前再次复核清单版本未变。任一条件不满足就不写出发布指针，下游看不到未闭合批次。链接过期时刷新地址并核对同代摘要后才复用内容；generation 改变则丢弃整批重来。

样品与检测按 `samples.id` / `assays.sampleId` 校验。修订表删除的样品及其检测属于正常移除；修订后仍引用不存在样品的检测以 `missing-sample-reference` 隔离。CSV 行解析失败以 `parse-error` 隔离，整份文件结构性损坏则整批不发布。

## 本地发布与下游读取接口

`--store` 目录结构：

```
state.json            作业与确认状态（原子替换）
current.json          正式发布指针（下游唯一入口，原子替换）
export-receipt.json   当前发布的回执，含清单版本与各文件证据
publications/…        不可变发布快照（原始 CSV、结构化数据、回执）
acks/…                确认结果旁证
```

快照完整落盘并复核后才写 `current.json`。下游仍使用原来的读取接口（`createReader(dir).readPublished()` / `readSamples()` / `readAssays()`），它只解析发布指针，因此任何时刻只能读到上一条或新的完整世代；中断留下的孤儿快照、正在下载的批次都不可见。`export-receipt.json` 记录 `jobId`、`generation`、`publicationHash`、`manifest`（含 digest、requiredRoles、观察次数）、`files`（role、generation、size、sha256、verified）以及结构化数据与隔离理由。

供应方收到消费回执后可能清理远端文件，因此确认严格晚于本地发布：先写快照，再切发布指针，最后调用 `/ack`。确认响应丢失时本地发布保留，`export-receipt.json` 停在 `ack.status=pending`；重启后按同一 `generation` 与 `publicationHash` 补发，不重新下载。

`npm run scenarios` 在临时本地服务上跑完 `docs/scenarios.md` 中的全部演练并输出证据；`npm run demo` 只做一次协议查看。

## 数据校验

`npm run verify -- export-receipt.json` 检查本地结果的基本业务不变量，缺少文件时返回非零状态。该命令不生成采集结果，也不替代网络交互和恢复测试。`npm run demo` 在临时本地服务上真实发起请求并完整打印响应，随后退出。日常演练均不需要安装依赖或访问研究站。

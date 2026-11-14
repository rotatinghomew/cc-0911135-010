# 业务演练

`npm run scenarios` 在临时本地服务上依次执行下表全部情景并输出证据；`npm test` 用可重复的断言覆盖同一组边界。

|情景|源作业生命周期|本地行为|
|---|---|---|
|申请响应丢失|lostCreateOnce=true|先按 requestKey 查已有作业，不重复创建|
|未闭合|第一次 manifest 只有 samples|可预取但不发布、不确认|
|清单换代|下载后 complete generation 2→3|丢弃旧代内容，只发布同代必需角色|
|链接失效|expireTicketOnce=true|刷新地址，先核对 generation 和摘要再复用内容|
|引用删除|revisions 删除 M1|同步移除 M1 检测，不报告为未知材料|
|真正孤儿|orphan=true|M404 进入 `missing-sample-reference` 隔离，不冒称完整入库|
|行解析错误|parseError=true|坏行以 `parse-error` 隔离，理由与缺失引用不同|
|确认丢响应|lostAckOnce=true|已发布数据仍可读，相同回执安全补发|
|发布边界退出|写快照后、写指针前中断|重启补写指针，下游只看到完整一代，确认绝不早于本地发布|
|确认前退出|写指针后、确认前中断|下游已可读完整一代，重启只补确认|
|等待上限|completeAfterReads 很大|到上限退出且保留可恢复作业状态|
|读取次数上限|持续未闭合|达到 maxManifestReads 即停止轮询|

## 证据要点

- 未闭合 / 超时：`current.json` 不出现，`readPublished()` 为 `null`，源端 `acknowledged=false`，`state.json` 保留 `jobId`、`status=waiting`、`lastManifest`。
- 换代：回执与发布数据的 `generation` 一致，全部 `files[].generation` 相同，结构化值与新代内容一致。
- 引用：`removed.samples` / `removed.assays` 记录修订删除；`quarantine[].reason` 区分 `missing-sample-reference` 与 `parse-error`。
- 确认丢失：首次运行以 `ack-unconfirmed` 结束但 `readPublished()` 非空；重启补发不新增作业、不重新下载文件，`ack.status` 从 `pending` 变为 `accepted`。
- 发布边界：`afterSnapshot` 中断时无 `current.json`；`afterPointer` 中断时有 `current.json` 且无确认。两种中断重启后都不会重新下载。

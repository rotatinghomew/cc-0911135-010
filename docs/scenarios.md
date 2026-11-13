# 业务演练

|情景|源作业生命周期|本地行为|
|---|---|---|
|申请响应丢失|lostCreateOnce=true|先按 requestKey 查已有作业，不重复创建|
|未闭合|第一次 manifest 只有 samples|可预取但不发布、不确认|
|清单换代|第二次 complete generation=2|只认同代必需角色，不能混用第一代文件|
|链接失效|expireTicketOnce=true|刷新地址，先核对 generation 和摘要再复用内容|
|引用删除|revisions 删除 M1|同步移除 M1 检测，不报告为未知材料|
|真正孤儿|orphan=true|M404 进入明确隔离，不冒称完整入库|
|确认丢响应|lostAckOnce=true|已发布数据仍可读，相同回执安全补发|
|发布边界退出|写正式发布指针前后中断|下游只看到完整一代，确认绝不早于本地发布|
|等待上限|completeAfterReads 很大|到上限退出且保留可恢复作业状态|

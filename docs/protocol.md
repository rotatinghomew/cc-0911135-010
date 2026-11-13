POST /exports {requestKey} 创建作业，不承诺幂等；GET /exports?requestKey=... 查询全部同键作业。GET /exports/{jobId}/manifest 返回 complete、generation、requiredRoles、files。默认第二次查询后 complete；闭合 generation=2，初始 generation=1。文件含 role、generation、size、sha256、url，文件 URL 携带短期 ticket。

POST /_control 可设置 completeAfterReads、generation、ticket、expireTicketOnce（首次取文件使旧链接过期）、lostCreateOnce、lostAckOnce、orphan。文件是 UTF-8 CSV；samples.id 被 assays.sampleId 引用，revisions 删除样品时应同步剔除其检测，真正不存在的 M404 属于隔离理由而非删除。

POST /exports/{jobId}/ack {generation,publicationHash} 为消费确认，相同世代和摘要可重复确认；之后文件返回 410。本地发布前不能调用。export-receipt.json 含 jobId、generation、complete、published、acknowledged、publicationHash、files、quarantine、samples、assays。发布数据需同代、引用闭合且已验证摘要；更细的解析错误可进入隔离，不可冒报完整。

# joint-export-collector

联合试验的异步导出供应端及单文件读取客户端。

## 环境与命令

Node.js 22.23.4，依赖使用 package-lock.json 固定。准备阶段运行 `npm ci`。


```bash
npm run build
npm test
npm run demo
npm start
```

`npm start` 输出本次监听地址，另一个终端可运行 `npm run probe -- http://127.0.0.1:端口`。服务只监听本机。`PORT` 可指定端口，Ctrl-C 结束。

`npm run build` 检查所有模块的 JavaScript 语法，无需生成打包文件；`npm test` 检查源端协议、正常及异常响应。

## 数据与运行边界

POST /exports {requestKey} 创建作业，不承诺幂等；GET /exports?requestKey=... 查询全部同键作业。GET /exports/{jobId}/manifest 返回 complete、generation、requiredRoles、files。默认第二次查询后 complete；闭合 generation=2，初始 generation=1。文件含 role、generation、size、sha256、url，文件 URL 携带短期 ticket。

POST /_control 可设置 completeAfterReads、generation、ticket、expireTicketOnce（首次取文件使旧链接过期）、lostCreateOnce、lostAckOnce、orphan。文件是 UTF-8 CSV；samples.id 被 assays.sampleId 引用，revisions 删除样品时应同步剔除其检测，真正不存在的 M404 属于隔离理由而非删除。

POST /exports/{jobId}/ack {generation,publicationHash} 为消费确认，相同世代和摘要可重复确认；之后文件返回 410。本地发布前不能调用。export-receipt.json 含 jobId、generation、complete、published、acknowledged、publicationHash、files、quarantine、samples、assays。发布数据需同代、引用闭合且已验证摘要；更细的解析错误可进入隔离，不可冒报完整。

接口的完整字段及演练开关见 `docs/protocol.md`。业务编号均为合成值，不对应真实研究材料；服务没有外网依赖。`/_audit` 查看源端请求证据，`/_control` 只用于运行演练情景，不属于业务采集入口。

现有客户端只进行单次协议查看；尚不提供自动采集与持久运行调度。原始服务可单独运行，以便采集端在重启时保持源端状态。

## 数据校验

`npm run verify -- export-receipt.json` 检查本地结果的基本业务不变量，缺少文件时返回非零状态。该命令不生成采集结果，也不替代网络交互和恢复测试。`npm run demo` 在临时本地服务上真实发起请求并完整打印响应，随后退出。日常演练均不需要安装依赖或访问研究站。

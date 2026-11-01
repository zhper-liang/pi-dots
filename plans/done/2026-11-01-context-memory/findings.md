# 发现

- 当前安装 @earendil-works/pi-durable@1.3.0，导出 CompactionTask 与 DEFAULT_COMPACTION_POLICY；内部 selectCut/serializeConversation 并非公共导出。
- Pi 默认 reserveTokens=16384、keepRecentTokens=20000、backgroundTokens=32768。
- 主会话是自定义 pidot.chat Task，历史 entry 不具有 Pi model 贡献；需适配才能真正复用 CompactionTask，不能直接打开设置假称接入。
- 模型登记目前不带上下文；上下文仅来自环境 PIDOT_CONTEXT_WINDOWS。
- 初查时记忆后台30秒防抖，模型没有专用记忆工具；随后已实现固有记忆工具。用户后续明确将默认等待改为连续空闲一小时，本次已调整；压缩时单独提取仍处于讨论，尚未接入。
- 本地存在 /home/zhper/code/deepseek-harness，可能为 dsh，已异步询问。

- 用户确认dsh为https://github.com/deepseek-ai/deepseek-harness。本地参考ModelListEditor/DeepSeekModelsEditor：容量支持K/M十进制。Pidot明确留空256000，避免DSH占位256K与其适配器262144默认不一致。
- Pi只公开CompactionTask，直接挂接会引入与Pidot定制Task并行的生成/会话路径。本轮复用固定包内部纯函数selectCut/serializeConversation及公开默认policy，Pidot继续负责持久化、预算、来源过滤与恢复；阻塞触发和保守估算保留，不假称完整接入后台压缩。
- 新增工具schema扩大固定提示空间；压缩/阻塞旧fixture相应扩大已知测试容量，保留其工具不重复和关联历史断言。压缩时为当前输入添加只用于切分的尾锚，解决最后一轮完整工具结果无法压缩的边界。
- 记忆工具读按来源过滤，写绑定当前私聊显式指令，服务CAS和来源防复活复用。仅询问记忆/偏好不能触发修改。
- 全量1561/1561通过，lint10条既有warning，build通过；正在完成新增UI容量断言和隔离浏览器检查。

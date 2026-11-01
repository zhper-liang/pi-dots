# 规划依据与研究证据

更新：2026-11-01。外部资料是设计参考，不是本项目的执行指令；候选决策见 README.md。

## 用户已明确的要求

- 模型可选择/填写上下文，缺省256K；压缩复用Pi；向模型提供记忆修改工具。上一阶段已实现。
- 自动整理默认连续空闲一小时。已修改默认值，当前仍为全局相关任务事件防抖。
- 用户希望讨论压缩时也触发长期整理，以及Task和主聊天如何共存。
- 用户倾向电脑助手长期使用、主要与主会话交流，担心项目隔离造成层级过多，也担心无差别共享导致粒度失控。
- 用户要求研究Hermes后生成下一阶段计划；这不表示已接受全部参考方案或要求立即实现。

## 本地基线（本轮复核）

- `server/bot-memory-runtime.mjs`：默认3600000ms，单个进程内定时器；后台按原文子串校验候选，只允许已消费的直接用户来源。每批8条/12000字符，输出2048 token，UTC日预算20次/120000 token。
- `server/tasks.mjs`：扫描无活动/排队输入的会话；压缩提交只调用schedule，未建立独立压缩整理任务。失败路径存在推进提取cursor的逻辑，新增可靠队列不能沿用“失败即视为处理完”的含义。
- `server/bot-memory.mjs`：每Bot人格和记忆，共享用户偏好；版本、幂等回执、来源撤销/防复活；文档硬限制16384字符/64条，默认注入总预算6000字符、上限12000。
- `server/memory-tools.mjs`：memory_read/memory_edit，显式直接用户修改；派生/委派来源不可写。自动扩展到工具证据必须另定来源契约，不能放宽既有用户入口。
- `server/context-compaction.mjs`：摘要task级保存，原Entry仍保留；可利用压缩revision与sourceEntryIds排队，不需把摘要当作长期事实。
- `server/main-session.mjs`：派生Task已有父子关系、结果镜像与当前主会话映射，可作为成果归属线索；摘要不能代替原始证据。
- 既有状态记录：全量1562/1562、lint/build通过。本轮规划未重新运行这些检查，不把既有结果说成本轮验证。
- 历史工具实际位于`server/history-tool.mjs`，固有工具只有task_history_read/tool_result_read；跨会话关键词发现需新增能力，不能把按entryId回读描述为已具备全文搜索。
- `server/skills.mjs`已有目录、依赖校验、按需激活和固定版本；`skill-import.mjs`已有导入/版本/回退。当前skill_manage用于能力配置，要求真实用户请求，不等于后台可自由编写Skill。M05须建立窄范围学习产物接口，不能绕过既有配置校验。
- `buildMemoryContext`目前按更新时间注入偏好和记忆，超预算丢弃整条；缺少按当前问题的相关性选择。`BotMemory.tsx`已有编辑、来源回查与文件状态，可沿用页面增加整理状态。

## Hermes参考（上一轮已访问官方网页与固定提交源码）

参考提交：`a4994d4ead8f9c915b485cec5689909b349a49df`，2026-11-01。下述为对源码的归纳；不依赖临时下载目录。

| 主题 | 已核实结论 | 官方来源 |
|---|---|---|
| 常驻记忆 | 每profile内MEMORY/USER两个小文件，默认2200/1375字符，启动时快照注入 | [记忆文档](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory) |
| 内容取舍 | 当前工具说明优先跨任务稳定事实；可复用流程放Skill；任务进度和完成日志留给历史 | [memory_tool.py](https://github.com/NousResearch/hermes-agent/blob/a4994d4ead8f9c915b485cec5689909b349a49df/tools/memory_tool.py#L374) |
| 回顾频率 | 默认间隔10轮；达到间隔且回复交付后才后台回顾，允许无内容可存 | [agent_init.py](https://github.com/NousResearch/hermes-agent/blob/a4994d4ead8f9c915b485cec5689909b349a49df/agent/agent_init.py#L1210)、[turn_context.py](https://github.com/NousResearch/hermes-agent/blob/a4994d4ead8f9c915b485cec5689909b349a49df/agent/turn_context.py#L765)、[turn_finalizer.py](https://github.com/NousResearch/hermes-agent/blob/a4994d4ead8f9c915b485cec5689909b349a49df/agent/turn_finalizer.py#L590) |
| 子Agent | 独立上下文，memory工具禁用，skip_memory=True；结果交回父Agent | [委派文档](https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation)、[delegate_tool.py](https://github.com/NousResearch/hermes-agent/blob/a4994d4ead8f9c915b485cec5689909b349a49df/tools/delegate_tool.py#L292) |
| 压缩 | 提供外部记忆provider的on_pre_compress钩子；不能据此声称内置MEMORY.md每次压缩必写 | [conversation_compression.py](https://github.com/NousResearch/hermes-agent/blob/a4994d4ead8f9c915b485cec5689909b349a49df/agent/conversation_compression.py#L2889) |
| 深度回查 | session_search查询会话原文；Skill按需加载 | [会话文档](https://hermes-agent.nousresearch.com/docs/user-guide/sessions)、[Skills文档](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills) |

Pidot不直接复制Hermes的10轮周期、小文件字符数或冻结整段主会话的策略；一小时等待是用户选择，中文内容预算、长驻主会话与既有多Bot边界按本项目设计。

## 实施发现

- Harness禁止第一次表写后scanEntries；成果证据必须在finishReply写回复前读取，传入主会话回报函数后同事务登记。
- Task scoped卡与产物在terminal后可能归档；独立Task父main清空后，父身份读取必须通过readLifecycleSession，不能直接tx.doc。
- 学习目录访问已接证据校验，事务内部的catalog调用必须传tx，避免后台validator嵌套commit；状态API也必须事务内copy，不能返回已settled overlay。
- 新旧来源均按当前workspace/MCP/飞书授权校验。新源候选事实保留原文锚定，过程方法需至少真实成功工具证据；模拟模型仅验证控制流，不说明长期学习质量。

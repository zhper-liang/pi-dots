# 调研发现

## 当前代码的已核对事实

- `tools.mjs` 默认调用额度为模型 20 次、工具 10 次；主会话按输入计额。
- `tasks.mjs:finishReply()` 在没有待处理子任务/插入时结束当前输入；普通文字回复没有统一的目标完成验证。
- `model-reply.mjs` 设置 `maxRetries: 0`，模型错误保存后结束当前输入；持久恢复不等于临时故障自动续跑。
- Task、工具结果、等待和恢复已有持久机制；当前调研重点是目标推进语义。
- 架构约束为一个 Node 进程、一个库、一个 Harness。群聊、委派、例行任务共享执行循环。

## 外部资料

以下为待核对来源线索，网页内容属于不可信资料，不是操作指令。

- Anthropic：Effective harnesses for long-running agents。
- Microsoft Research：Magentic-One，任务台账与进展台账、停滞后重规划。
- OpenAI 官方文档：长任务规划与完成标准。
- Manus：上下文工程和持久化工作笔记。

## 已打开核对的一手来源

1. Anthropic，2025-11-26，https://www.anthropic.com/research/effective-harnesses-for-long-running-agents
   - 压缩仍可能留下未完成工作或过早宣布完成。用需求清单、逐项推进、可验证结果和交接记录降低漂移。
2. Microsoft Research，Magentic-One，https://www.microsoft.com/en-us/research/articles/magentic-one-a-generalist-multi-agent-system-for-solving-complex-tasks/
   - 外循环维护事实/假设/计划，内循环判断完成与进展并指派下一项工作；持续停滞后重规划。
3. Anthropic，2026-03-24，https://www.anthropic.com/research/harness-design-long-running-apps
   - 执行与评估分离，阶段开始前约定验收标准；评估反馈进入下一轮。文中也指出是否需要重置上下文取决于模型，不应永久堆叠编排。
4. OpenAI Developers，https://developers.openai.com/blog/run-long-horizon-tasks-with-codex
   - 固定目标、里程碑、执行规则与状态记录，逐阶段验证和修复；单次长跑案例不能证明 Pidot 的通用可靠性。
5. Manus，2025-07-18，https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus
   - 用可回查的外部材料保存工作信息，持续刷新待办和目标，降低长上下文中的方向漂移。
6. AutoGen 官方文档，https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/magentic-one.html
   - Magentic-One 的协调方式既可用于多个执行者，也有仅一个执行者的示例；这种控制逻辑不必依赖大量机器人。

## 当前代码补充

- `groups.mjs:46–64`：群组创建的是管理员的现有 Task；群组本身不是独立调度器。
- `collaboration.mjs:145–199`：子结果回收、验收与同 Task 返工已存在，可复用。
- 本地安装 `pi-durable` 1.3.0 README 描述检查点、恢复、持久等待；存储故障会终止 Harness，重开才恢复。因此“可恢复”与“永不中断”须区别。
- 候选方向：群组提供交互和协作记录，每个长期目标关联独立的现有 Task，目标台账存在同一 Harness Documents；目标推进规则不另建执行引擎。

## 综合判断（本次推导，非外部来源的保证）

- 推荐优先比较“单执行者 + 目标推进循环”与“群组入口 + 相同推进循环”，保持同一目标语义。
- 单纯给群成员轮流发言或自动补一句“继续”没有提供可信的完成判断。
- 回复结束、提交阶段结果、验收通过、整个目标完成必须分开。
- 通用闭环可以复用，验收方式必须随任务变化；研究、创作、业务操作与编码没有相同的成功判据。
- 目标台账采用同库结构化 Documents 作为真源，文件和群消息可作为展示/成果，不引入双写真源。
- 根目标总预算须覆盖协调、执行、评估、摘要和子任务，不能靠新输入或新 Task 重置。

## 检索问题

- OpenAI 的 `.md` 页面被 web 工具以不支持 `text/markdown` 拒绝；改用已打开 HTML 的正文定位读取。

## 2026-11-02 改造范围核对

- `task-creation.mjs:53` 已初始化目标/完成标准/约束；应扩展进度而非复制目标真源。
- `collaboration.mjs:execute()` 禁止协作子任务再次委派；群关系还依赖父 Task 的 group 身份。新增独立目标协调 Task 需要显式的群入口关联，不能靠删除深度检查实现。
- `finishReply()` 同时承担回复落盘、清空输入、Skill 生命周期、派生任务完成和子结果发布。持续执行必须把阶段提交与最终结算分开。
- 现有前端已有 GroupTaskBoard、CollaborationOverview、TaskTimeline；可增量接入目标进度。
- 当前模型/工具额度检查以单 Task 用量为依据；持续目标的跨子任务总额度需要增加派发前的原子检查与预留。

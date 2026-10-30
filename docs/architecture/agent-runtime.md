# Agent 运行架构

本文描述当前运行约束；业务对象与定时见 [工作区架构](unified-workspace-v2.md)，全局分层见 [系统架构图](system-overview.md)。

## 长期身份与执行身份
Bot 保存身份、职责、版本化配置及工具分配；Conversation 承载持续交流。Harness Task 是持久化执行实例，不能与 Todo、Schedule 或单轮模型调用混为一谈。Task 卡记录目标、主管、执行者、完成标准、blocker、结果和责任事件。

复用唯一 Harness 处理执行与恢复，不为群聊、工作区或定时 Agent 再建一套执行引擎。定时工作流只保存触发定义与原 Task 关联。

## 配置装配与迁移
1. 确定 Bot、来源会话、协作关系、目标和完成标准。
2. 固定模型名、提示词等运行配置版本及调用额度；工具与资源按 Bot 当前分配解析，Skill 按当前可用依赖加载。
3. 持久化 Task、conversation 与任务卡，装配上下文后执行。

权限以当前登记、ToolAccess/CapabilityAssignments及撤销为准，没有能力池、Bot Grant、档位或Task许可快照/epoch匹配；来源记录自身的版本字段仍保留。R1新Bot的业务工具、MCP/Skill和来源默认空白，旧Bot的精确分配、撤销与确认规则保留，迁移只记标识不重新灌满。工具启停与allow/ask写入确认是两件事；[ADR-014](../decisions/README.md#adr-014-实时权限与直接做先问)的实时边界保留，[ADR-015](../decisions/README.md#adr-015-工具组默认开开即直接做)的旧“默认全组/迁移补齐”不再用于新Bot。飞书断开或换绑仍移除旧来源资源。

模型连接地址和 key 不属于 Task 固定运行配置：每次调用从服务端读取，按进程环境、app/root dotenv、同库目录 `model-settings.json` 的优先级选择。JSON 明文凭证用 0600 原子替换，不进 Harness/SQLite；认证设置接口只投影 hasKey。旧 Task 的 provider/baseUrl 兼容忽略，模型名不变；改连接不改变 Bot 版本或触发迁移。已持久化 Bot 目录保持权威，不因新 seed 哈希改变而重写版本；无配置首次启用时仅新 Task 使用真实模型，已有测试 Task 不变。

配置更新使用 expectedVersion，保存不可变版本和幂等回执。显式迁移仅用于模型、提示词等运行配置，在无执行、无待消费输入和无等待事项的安全边界进行，检查依赖、容量与差异，保留原身份、历史、用量和责任；工具、资源和规则实时生效，无需迁移。

主会话仅展示该Bot当前可用工具并服从确认规则；task_create/task_status/automation_pause也不无条件授予新空白Bot。legacy主会话固有工具单独投影，显式撤销优先；Chief管理职责及新配置工具通过真实宿主角色/授权提供。派生Task用于长任务，运行配置快照不是权限快照，历史/工具结果回读实时复核来源。例行任务仅开放当前工作区读工具，显式 writes=true 时再开放工作区变更与操作查询；测试运行、旧只读简报和“帮我想办法”任务保持只读，并限定原任务指定的来源范围。

## 消息与调度
| 输入 | 行为 |
|---|---|
| 空闲普通消息 | 开始执行段 |
| 忙碌普通消息 | 持久排队，在当前段结束后按 FIFO 消费 |
| 显式插入 | 在安全边界使用 steer，不直接改正在运行的内部状态 |
| 审批、阻塞答复、协作结果 | 满足关联条件后恢复原 Task |
| 取消、撤权 | 直接约束后续调度和工具边界 |

执行段可包含多轮模型与工具，直到回复、等待或结束。每次模型调用前检查输入、状态、限制和上下文；模型提出的动作必须再次经过可信工具边界。

## 工具与 Skill
区分已安装、已授权、本轮展示三个集合。隐藏 schema 不是权限控制；每次实际派发和历史/结果回读都检查身份、来源、参数、授权、审批、预算与取消状态。凭证留在服务端，不进入模型上下文。

Skill 是工作方法，不授予工具权限。活动 Skill 的选择、激活/退出、依赖检查及生命周期持久化；正文按当前阶段加载，不能用 Skill 绕过工具白名单或实时撤权。目录合并只读内置 `server/skills/` 与受控用户Skill包；发现不等于分配，新注册Skill不会自动给旧Bot启用。用户导入固定来源/内容hash和版本，更新不改运行Task固定快照，撤销/移除仍实时生效；能否使用取决于Skill选择、机制工具和声明依赖的当前分配。使用是按需的：Bot 从简要目录自己选（skill_activate），或用户在输入框打“/”选一个只对那条消息生效；每条输入处理完自动停用。没有手动激活面板；对话里每次使用留一行卡片（不进模型上下文），会话详情里有只读记录。

## 动态能力与配置 Host

生产index装配受控externalMcp服务与Skill导入服务；每store动态目录投影进入schema、严格参数校验、实时分配/catalog版本、policy、预算/取消和回执。缓存只保存无秘密元数据，不作为授权权威，不修改全局installed。连接mutation revision与稳定工具catalog revision分离，正常重连不扩权，新schema/source须重新审阅。

mcp_manage/skill_manage不走旧bot_manage执行分支。Host把实际已认证用户Entry、native tool turn、目标/动作/来源fingerprint/scope与精确确认绑定；只有Chief或真实显式管理赋权可执行。CapabilitySetups及既有TaskApprovals记录必要阶段和回执，不新增执行引擎。网络/导入FS在commit外进行，派发前再核对权限/预算；缺凭据时原输入等待安全UI续办。只读setup GET只核对原步骤账本，后续mutation须显式续办。

MCP来源独立refs；context/history/产物/协作/digest/记忆走同一来源边界。新认证输入可退役旧无效来源的派生上下文并清compaction，原审计与真实直接用户偏好保留。超过8KiB的完整结果进入已有ToolResults，经当前alias/来源/catalog权限分页回读；未知调用或未完成配置只查原持久requestId，不能盲重派或凭同hash目录猜成功。

## 会话删除与换新

普通Task删除需确认既有持久停止标记，再隐藏列表/详情/发送，归档不等于删除。主会话不接受普通delete/cancel，而以clear-main停止旧入口并原子创建同Bot新上下文；Bot、子Task和原审计保留。stop/swap窗口结果用持久交接记录接到当前主会话，来源与去重跨连续清空/重启保持；普通cancel/root stop/实时撤权仍有效。

## 工作区与动作裁决
- 工作区来源和连接须 active，动作须属于来源能力且具有用户许可；local 由所有者隐式完整许可，外部来源保留用户 Grant/readScope。Bot 读需要当前分配 workspace.list/get，写需要 workspace.prepare_change，并分配对应 workspace:<sourceId> 资源；busy-only 仍只投影时段。飞书只开放忙闲时可只勾 calendar_feishu_freebusy，不勾读详情工具。
- stdio MCP 保留独立凭证及 sources/actions/readScope、到期和撤销校验，实际权限不超过 Bot 当前分配和用户许可。凭证在设置页发放、列出和撤销；不再有 AgentWorkspace 面板。
- policy.decide() 对读和内部协作工具直接 allow；写工具按 tool、action、sourceId、type 取最具体规则，同样具体时 deny > ask > allow。传统已授权业务写入无匹配时直接执行，删除同样适用；外部MCP动态工具及能力配置变更保守要求精确批准，不由annotations或普通组开关自动放行。传统工具组写入确认：开 = 无规则，关 = 组内每个写工具一条 ask；切换时清掉该 Bot 在组内写工具上的全部规则，所以开关显示等于裁决结果。模型只看到 Bot 有对应资源的工具，已委派的子任务不再看到 task_assign。未登记工具拒绝。旧 origin=preset 与 risk 规则不参与裁决，不再有 R0–R4/H、批量计数或每小时自动写入上限。
- 全局暂停把写入 allow 降为 ask，停止例行任务和事件触发，恢复后不补跑；模型/工具/token 调用预算仍独立保留。在场时按原操作和精确参数确认，本地提案保留 5 分钟；可点“以后直接做”把该工具所在组设为开，暂停中和结果未知后的重做审批不提供该按钮。
- origin 为 routine、event、detector 时遇到 ask，不出审批卡、不等待 30 分钟过期，跳过并在运行记录与结果中说明“已跳过：这一步需要你来做。”
- 例行任务派发时实时复核 Bot active、当前读工具、来源资源及用户/连接许可；失效就取消并记录原因。仅更新 Bot 配置版本不使例行任务失效。用户提醒和内部计划的 authorizationSnapshot 不受此次简化影响。

## 上下文与调用限制
上下文按固定配置、任务规则、活动 Skill、近期交流、压缩摘要与按需证据装配。压缩不丢失目标、来源、未完成工作、审批、未知动作和责任信息。工具结果有界，必要时按引用读取原始结果；读取仍执行权限检查。

记录模型/工具调用与 token 用量，达到额度进入“受限”等待，用户明确提额后恢复原 Task。不会通过新 Task 自动重置预算。长期文档仅限下述有来源、受限提取，不等于无限自动记忆。

## 实时三文档记忆（T11）
每个 Bot 独立人格与记忆，全部 Bot 共用用户偏好。人格替代当前模型提示中的旧职责描述：历史 Bot 配置仍保留，首次从现有描述初始化，之后只接受用户显式编辑，不随旧 Task 迁移重新覆盖。文档与修订/幂等回执使用新增的 Harness session 文档，不改原 Task/工作区 schemaVersion，不引入第二数据库或执行引擎。

每次模型调用读最新文档；记忆/偏好是低优先级来源资料，受字数与上下文余量限制，不能挤掉目标、约束、活动 Skill 或当前输入。未来日程从当前 Task 有权访问的来源实时查询；不把日程写成长记忆或凭缺失数据推断空闲。

生产入口启用约 30 秒空闲合并批处理；嵌入/测试 store 默认关闭。提取器没有工具 schema，独立记录调用额度，不消耗或重置业务 Task 调用预算、不重放业务工具、不阻塞原回复。默认按 UTC 日界最多 20 次调用、120000 token 预留预算；每批最多 8 条输入/12000 字符、输出最多 2048 token。额度不足、提取失败或来源校验失败保留原内容并显示待处理，不因重启重复同一未确认提取。

只接纳本 Bot 认证用户私聊、已经消费的来源 Entry；拒绝群聊、委派、外部/自动化资料、无来源猜测、日程和凭证。候选逐条引用真实来源、限制大小；共享偏好版本冲突只能有界重读合并不重叠条目，不能复活用户纠正/删除的旧事实。人格不由模型更新；新旧模型 key、API token 及常见凭证形态均过滤，读取当前文档与历史也不回显凭证。

## 文件式记忆（R2）
人格、记忆和共享偏好的内容真源是数据目录下 `bot-workspaces/` 的 Markdown 文件：每 Bot 的 `bots/<id>/PROFILE.md`、`bots/<id>/MEMORY.md`，全局的 `shared/USER.md`。用户可以直接用编辑器改。上节的 Harness 文档改作台账，继续保存版本、修订、来源、防复活标记、回执和提取水位；新增的 `pidot.bot-memory.file` 记录每个文件最后写回的版本和哈希。

只有 `memory-files.mjs` 的对账读写这些文件，每个文件一个串行队列。对账发生在启动时、每次模型调用注入前、记忆读取和编辑前、记忆修订提交后和关闭时，不用 `fs.watch`。手改以最后写回的版本为 base 三方合并进台账，同 id 以文件为准，记为 `actor: 'file'`；台账较新时原子写回。刚改过的文件先等两次读取一致再导入，避免把编辑器保存到一半的空文件当成全部删除。

文件手改只改内容，不写防复活标记；含密钥照常导入，读取脱敏和注入过滤不变。凭证检查只扫新写入的内容，已存内容里的 key 不挡后续提取和编辑。文件超限或无法解析时整份不用，Agent 只收到一行提示；对账出错时对话照常，用台账内容注入。`PIDOT_MEMORY_FILES=0` 回到只用台账，见[运行手册](../engineering/operations.md#文件式记忆的开关与回滚r2)和 ADR-019。

## Google 连接（R3）
Calendar、Tasks 是 workspace-service 的两个原生 provider 适配（`workspace-google-calendar.mjs`、`workspace-google-tasks.mjs`），进 Event/Todo 文档，经 `workspace-sync` 后台重扫，日历视图和提醒照常使用；Bot 经 `workspace.*` 工具读写，对话路径由 `workspace-mcp-host.mjs` 按来源是否仍有效放行。Gmail、Drive、Docs、Sheets 经 workspace-mcp：一条凭据来源为“取自 Google 连接”的外部 MCP 连接，每次调用由 `google.accessToken()` 取当前令牌作 bearer，传输层 401 时作废该令牌并重试一次，工具已执行后不重试。令牌只在服务端凭据文件和内存里。

外部来源（飞书、Google）连上即可用，哪个 Bot 能用仍按 Bot 分配；日程写入归“日历与日程”组，事项写入归“待办与事项”组（ADR-021）。见 ADR-020 与[运行手册](../engineering/operations.md#google-连接与-workspace-mcpr3)。

## 协作、群聊与 Chief
- Chief普通创建/配置/停用按现有allow/ask规则执行，配置管理权转授始终需要精确确认；可配置自己的工具与来源，不能停用 Chief 自身，已停用 Bot 不自动重新启用。管理仍校验身份、目标、版本、精确参数及幂等回执。
- 委派记录父子关系、主管、执行者、目标与结果来源；目标 Bot 独立检查能力和授权。
- 群管理员接收普通消息，单目标 @ 从明确消息点 fork 必要上下文；结果回报保留原身份与来源，不能把定向材料广播给无权成员。
- 阻塞逐级上报；规则要求先问的动作必须由认证用户精确批准，主管不能代批。
- 提交结果后由主管验收或带意见返工，返工上限两次，超限交用户；保留原提交与版本化责任记录。
- 工作控制、暂停/停止与 Bot 停用不等于删除 Task，也不吞掉迟到结果。

## 副作用与恢复
恢复复用原 Task、等待项、输入、Operation、审批与累计用量，不创建替代执行来掩盖失败。

1. 明确已成功的动作不重复执行。
2. 结果不确定时优先按工具契约可靠查询；查询不到不代表未发生。
3. 仅工具明确支持稳定幂等且窗口/原参数仍成立时才按原标识有限恢复。
4. 无可靠查询或幂等保证时保留 unknown，等待人工核查；不通用自动重试。
5. 每次恢复、查询和派发重新检查权限、预算、取消、有效期与原批准。已经发生的副作用保留真实回执。

运行时的受限重试不能推导出飞书 provider 具有原子 CAS 或 exactly-once 保证。支付、任意 shell/HTTP 自动任务等不属于当前工作区承诺。

## 源码职责
[任务装配](../../my-app/server/tasks.mjs)、[模型循环](../../my-app/server/model-reply.mjs)、[上下文](../../my-app/server/task-context.mjs)、[配置迁移](../../my-app/server/task-migration.mjs)、[协作](../../my-app/server/collaboration.mjs)、[工具](../../my-app/server/tools.mjs)是实现核查入口。接口见 [HTTP](../interfaces/http-api.md)，日常恢复见 [运行手册](../engineering/operations.md)。

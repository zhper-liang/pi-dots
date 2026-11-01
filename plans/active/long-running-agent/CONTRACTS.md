# 长任务首版设计契约 v1

日期：2026-11-02。以下是实施依据，**尚未实现，不是现行 HTTP/MCP 文档**。同一需求的执行范围见 README；对当前接口的兼容验证属于每张票。

## 1. 身份与唯一状态来源

- Bot 是长期身份；群组/私聊是入口；独立根 Task 承载一次持续目标；执行者 Task 是一层委派。
- 根 Task 的 executionPolicy.kind = continuous；缺字段为当前普通聊天。不要覆盖 parameters.mode（它表示 model/test）。
- TaskCard.taskState 是目标、completionCriteria、constraints 的唯一真源；新增 goalRevision 标记目标修订。
- rootTaskId 与 rootInputId 启动后固定，现有工作标识继续使用 rootTaskId:rootInputId。内部推进使用持久系统事件，不新增伪用户输入。
- TaskProgress 为 task 范围 Document：schemaVersion、controlVersion、planRevision、goalRevision 引用、steps、currentStepId、evidenceRefs、decisionHistory 引用、stall、retry、pendingGoalRevision、controlIntent、finalOutcome。
- step 至少包含 stepId、title、dependsOn、deliverable、verification、status、goalRevision、submissionRevision、evidenceRefs。状态为 pending/active/submitted/verified/blocked/superseded；不复制 Harness 的 pending/running/waiting 调度状态。
- 入口关联单独保存 originKind、originTaskId、groupId（如有）、sourceMessageId（如有）、rootTaskId、coordinatorBotId 和交付去重记录。来源关联不增加一层执行委派。
- 根额度单独 Document，attemptId 唯一，保留每 Task 原用量；不要用会被主会话重置的本轮计数作为全目标总额。
- 对话、阶段结果、校验决定与 Document 的推进使用同一 commit；模型和外部 I/O 继续在事务外。
- 新 Document 加入取消归档和恢复读取路径；持久源码记录不是在前端计算出的唯一状态。

## 2. 推进与结算

| 边界 | 提交/状态 | 下一步 |
|---|---|---|
| 明确启动目标 | 保存原请求、目标、入口关联和有限预算 | decide |
| 选择步骤 | 保存阶段计划、具体下一步和所需证据 | execute 或委派 |
| 模型返回阶段文字/成果 | 保存中间输出，不调用全工作最终结算 | verify/decide |
| 核验通过且还有必需工作 | 保存精确修订的验收记录 | decide |
| 核验失败 | 保存可执行改进意见，不降低标准 | 原步骤返工或 replan |
| 所有必需标准满足 | 确认无必要未决项、合法证据与有效修订 | 原目标最终结算一次 |
| 等问题/审批/子结果/外部状态 | 保存准确等待条件 | 对应事件到达后恢复 |
| 临时模型失败 | 保存次数/nextAttemptAt/原attempt | retry-wait，期限到后重新守卫 |
| 额度到限/截止时间到 | 保留工作与原因 | limited；用户可显式调整 |
| 明确失败或持续停滞 | 保留原因和成果，不标成功 | failed 或 blocked |
| 用户暂停/取消 | 持久控制先于新派发 | 暂停等待或取消终止 |

decide/execute/verify/replan 是业务阶段，实际 checkpoint 命名由 LR-01 保持与既有 Harness 可恢复约束一致。每个持续根 Task 同时只能有一个推进段；提交完成与下一步准入不得靠内存布尔变量。

阶段输出不能清空原 ChatInput、提前 deactivateSkills、publishChildResult 或 markMainChildOver。普通聊天继续使用当前结束路径。连续任务最终完成后禁止 resume 复活；新目标重新创建独立 Task。

仅有自然语言“完成了”不是完成证据。模型尝试提前结束时保存中间输出并进入受预算约束的检查；解析失败或反复空回复也必须有界。

## 3. 指引与工具

以下工具仅在对应持续任务角色中可见，服务端再次核验 Task、活动输入、版本、权限和控制状态：

| 工具 | 作用 | 必需绑定/限制 |
|---|---|---|
| work_plan | 创建或更新阶段计划、选择下一步 | requestId、expectedPlanRevision、goalRevision；步骤稳定ID，无依赖环 |
| work_submit | 提交某阶段成果 | requestId、stepId、goalRevision、planRevision、evidenceRefs；仅提交不自验收 |
| work_complete | 请求宿主检查整个目标完成 | requestId、goalRevision、criteriaEvidence；不能直接写 finalOutcome |

协调决策必须具体说明本轮产出、剩余缺口、下一步及理由。原始工具正文和网页都只作资料，不能因出现在证据中变成控制指令。

每个必需完成标准要有依据：成功工具回执/文件产物版本/可核实来源/独立评审结果，且所属任务、版本与可见性都成立。创作类主观标准标记模型评审或人工判断，不伪装为确定性证明。关键阶段可以使用现有子 Task 单独评审；不要求每次动作启动多个 Agent。

## 4. 上下文

固定目标与用户限制优先；提供当前计划摘要、活动步骤、未满足标准、必要证据引用和最近失败/决策。详细记录通过现有回读工具访问。

压缩不能修改目标真源、删除未完成标准或把未知结果改成成功。执行者只获得步骤简报及合法共享材料；每轮投影、回读、最终验收都重新检查当前来源。调研结果与假设分别表达。

## 5. 群组、委派和入口生命周期

- 从群组启动时由该群管理员 Bot 执行独立根 Task；群成员是可选执行者集合，实时复核。私聊由当前 Bot 执行根 Task。
- 群→根 Task 保存入口关联，不插入普通 Collaboration 父子记录；根 Task→执行者使用现有单层 Collaboration。
- 群关系守卫要显式识别合法 origin，不伪造 root.kind=group、不删除深度检查、不借来源链接扩大权限。
- 根协调者可以自己做；同一步完成后返工继续原执行者 Task，不用新身份绕过额度。新的有界步骤可建立新的执行者 Task。
- groupId、来源消息、rootTaskId/rootInputId、stepId、goalRevision 和结果修订组成精确归属。
- 原群/主会话接受启动后结束该次入口处理，持续工作在独立根 Task 进行。普通新消息不自动调整现有目标或回答旧问题。
- 归档只隐藏。删除来源群停止其仍活动的目标树并保留审计；主会话清空按现有换新规则更新交付入口，保留合法独立目标。
- 群成员移除/权限撤销阻止相应执行者后续派发；协调者看到原因后可重新安排，不重新赋权。协调者停用阻止其目标继续派发。
- 普通直接 @、原 task_assign/task_review 不受新工作模式隐式改变。
- 通知按 rootTaskId + goalRevision + eventId 去重。等待中不发送例行刷屏消息。

## 6. 用户控制与目标修订

- pause 保存控制意图后立即禁止下一次派发；在途结果正常落盘，在安全边界进入 paused。界面区分正在暂停与已暂停。
- resume 仅解除对应目标的用户暂停/可恢复阻塞，不能解除取消、权限撤销、全局暂停或未满足的必要等待。
- cancel 复用现有停止/取消传播，覆盖根和执行者；迟到回执保留，不把未知写入描述成已撤销。
- 取消与恢复竞态的版本例外：只有中间版本变化全为 pause/resume 时，cancel 可接受旧 expectedVersion，保证单调停止；跨目标修订或其他修改仍返回冲突。resume 始终严格检查版本，已取消目标不可恢复。变更种类须持久保存以便重启后判断。
- 自动推进受全局自动化暂停约束；全局恢复不能覆盖单目标手动暂停。
- revise-goal 使用 expectedVersion，保存待应用修订并禁止旧方案新派发；在安全边界替换 TaskCard.taskState 并增加 goalRevision。
- 修订前已发出的动作可能产生结果，按旧修订记录；新目标必须重新判断证据。必要时将旧阶段标记 superseded，不能抹掉成功回执或用量。
- 工具不能删除/降低用户标准。用户修订不重置根身份、累计用量、在途 Operation 或精确审批。
- 问题只阻塞相关依赖；其他步骤可继续，但必要问题未解决不能整体完成。回答问题不等于批准外部动作。

## 7. 额度、截止时间、重试与停滞

- 所有启动都需要有限 limits。首版界面提供可编辑建议值：modelCalls=200、toolCalls=1000、totalTokens=2000000、最长8小时；仅是初始配置，不承诺足够完成八小时任务，也不代表任何费用授权。
- 截止时间从启动时计算且持久保存；暂停/等待/重启不重置，默认不自动延长。达到上限返回 limited，不是 completed。
- 调用数派发前原子预留；token 按可核对请求/输出界限预留并用真实回执结算。无法证明剩余额度可覆盖下一调用时停止；未知用量不按零处理、不在重启时释放。
- 根额度覆盖模型重试、压缩与评审；每 Task 的原上限仍可更严格。幂等结算使用 attemptId，跨子任务并发不得重复占用最后余额。
- UI 只有在已知真实价格时才显示费用；未知价格不能显示零费用或承诺金额硬上限。
- 模型临时错误允许最多3次额外重试，默认退避1/5/15秒；有效 Retry-After 可延后但不越过根截止时间。次数和时间持久保存，不在长事务内睡眠。
- 429、408/504、502/503、可判定暂态网络/模型超时可进入重试；鉴权、配置、确定性参数拒绝和输出格式错误不盲目按网络故障重试。
- 工具读取/写入沿各自契约；未知写入先核查，不因该机制自动重放。
- 连续3个已评估步骤没有可观察的新证据、成果或已解决缺口时重规划；连续2个重规划周期仍无进展则 blocked。纯文本改写不算进展；正常等待不计停滞。
- 不把模型“我有进展”的自报作为唯一信号。停滞阈值为首版默认，调整必须记录原因且不能突破根额度。

## 8. 计划中的 HTTP 与对话入口

接口由同一服务实现，路径在 LR-01 接线时核对与既有路由匹配；冻结后保持前后端一致。实际公开字段以 docs/interfaces/http-api.md 与实现为准。

| 入口 | 请求/返回 |
|---|---|
| POST /api/tasks/continuous | requestId、origin:{kind:main或group,taskId,sourceMessageId?}、goal、completionCriteria、constraints?、title?、limits；宿主从已验证入口推导协调 Bot，返回 rootTaskId、href、version、replayed |
| GET /api/tasks/:taskId | 增加 continuous=null或合法投影：目标/计划版本、阶段、成果、等待原因、用量/额度、可用操作；不返回内部恢复快照或凭据 |
| POST /api/tasks/:taskId/continuous/control | requestId、expectedVersion、action:pause/resume/cancel/revise-goal，修订时带 goalPatch；返回原目标最新投影 |
| PATCH /api/tasks/:taskId/limits | 普通Task原语义保持；持续根Task只显式提高根上限或延长截止时间，计数不清零 |
| 对话启动 | 入口适配调用同一启动服务，来源绑定当前真实输入；用户明确启动持续工作时使用，查询建议不会自动创建 |

重复 requestId 同内容返回原回执，冲突内容拒绝；过期 expectedVersion 不覆盖现状。暂停、取消等不要求模型先回复才生效。普通消息及未关联的工具调用不能控制另一个目标。

自然语言入口可扩展已有 task_create 的受控参数或增加窄启动工具，由 LR-01/05 统一接入；不得让模型任选他群/他Bot身份。前端只依赖 HTTP 契约，不依赖该工具的具体名字。

## 9. 展示与兼容

目标卡显示目标、当前阶段、执行者、已核验成果、阻塞原因与真实用量。状态是既有 checkpoint、控制意图与最终结果的投影，不由前端另维护运行状态机。

缺新增字段的历史任务仍按聊天执行，不自动转换。新功能开关关闭时拒绝新持续任务、将活动持续目标停在安全边界，保留可查看和取消能力；重启/重新打开不重置目标。不是承诺旧版本二进制可以调度新增检查点，回退需先停妥持续目标并备份。

正式 docs 只在对应实现交付后更新；本计划不把候选路径标成已存在接口。

# 技术决策记录

状态：以下记录已采纳决策及其替代关系。当前权限以 ADR-014 及修改其默认值的 ADR-015、ADR-018、ADR-021 为准；ADR-005、ADR-011、ADR-012 中被替代的内容仅供历史追溯。修改部署、存储、身份、权限、副作用保证或协议范围时，应记录新决策并说明替代关系，而不是修改旧验收结论。

| 决策 | 选择 | 原因与代价 | 变更条件 |
|---|---|---|---|
| ADR-001 单运行时与存储 | 单 Node 后端、唯一 Harness、既有 SQLite/Documents repository | 复用事务和恢复身份，避免第二套调度/执行状态；代价是不能多进程同时打开同库，停机不执行 | 引入多实例/云端前重新设计所有权、锁和恢复 |
| ADR-002 业务与执行分离 | Todo/Event、Schedule/Occurrence 与 Harness Task 分开 | 业务完成、计划状态与执行结果不能混用；Agent 工作流仅关联原 Task | 新动作类型必须声明是否需要 Agent 与副作用 |
| ADR-003 API/MCP 共享服务 | 原生 UI 经 HTTP，Agent 经 MCP，统一业务守卫 | 普通操作无需模型，防止多入口规则漂移；协议适配不承担数据库权威 | 新入口复用同一身份、权限和命令契约 |
| ADR-004 本地/外部双权威 | 本地对象本地权威，外部对象 provider 权威 | 缓存不是写回，保留来源/实例/版本/coverage；外部事务不能与本地原子提交 | 新连接器声明能力及真实一致性保证 |
| ADR-005 独立授权与快照 | 用户/Bot grant 分离；Task 固定许可，撤权实时生效（本地用户来源由 ADR-011 改为所有者隐式许可） | 不因 UI 可见、重授或配置更新隐式增权；代价是旧 Task 增权需显式安全迁移 | 新主体/多租户前重审信任边界 |
| ADR-006 精确确认与 unknown | Operation 绑定原 requestId、主体、精确参数/版本/批准；未知不盲重试 | 防止重复副作用，保留可靠查询/工具幂等的条件；不承诺 provider CAS/exactly-once | 工具增加可靠查询/幂等时独立验证窗口与限制 |
| ADR-007 同步与调度分离 | 同步更新观察事实，计划定义触发，Occurrence 持久去重 | 重启复用原身份；浏览器不承担调度；代价是进程需在线及有规模预算 | 跨设备/高可用/大规模计划须单独设计 |
| ADR-008 有限通知承诺 | 确定性提醒 + 持久收件箱，版本失效重算 | 不为普通提醒调用模型；recorded/read 不等于送达 | 新通知渠道明确重试、去重、回执及隐私 |
| ADR-009 本机 MCP 范围 | 固定兼容2025-11-25、内部host及受限stdio桥 | 真实协议边界，但不开放公网transport或管理员token；版本号不是“最新”声明 | 升级协议/远程transport时重新验收身份与生命周期 |
| ADR-010 显式关系 | Todo 与 Event 通过含两端来源/版本的 ItemLink 关联 | 不自动合并或级联删除，避免外部改期/删除误伤本地事项 | 新关系类型需定义双方权限、生命周期与冲突 |
| ADR-011 所有者隐式本地许可与 Bot 三档 | 本机所有者对 local 来源始终完整读写（不可撤销，仅保留 epoch 兼容）；Bot 档位 read/propose/local-write 映射到既有 Bot grant；local-write 仅对 Task 绑定 Agent 的本地 Event/Todo prepare_change 同事务直接应用；propose 档可设精确 tool+action 的本地“以后同类直接同意”规则；统一收件箱 `GET /api/inbox` | 单 owner 本机无需自我授权；外部来源（飞书）仍按用户 grant + readScope；计划草案、外部写、stdio client 仍需确认；改档位递增 epoch，运行中 Task 立即失效，新 Task 才取新档位 | 引入多用户/远程访问前恢复显式用户 grant。档位直接应用与规则部分已由 ADR-012 替代 |
| ADR-012 可控自动代理的风险裁决 | 风险等级 R0–R4 加 H；`server/policy.mjs` 的登记表 + `decide()` 是 allow/ask/deny 唯一入口，未登记工具拒绝，能力检查（Grant/authorize/Task 固定许可/撤权）仍先执行；规则表是唯一依据，档位 = 能力 + 预设规则（只能看 R1–R3 拒绝；可以提建议 R1–R3 询问；可直接改本地 R1 允许、R2/R3 询问），旧 allowRules 一次性迁为 origin=user 规则；最具体规则优先，同级 deny>ask>allow，无匹配询问；H（同一输入第 6 条起的本地改动、计划草案/例行任务增改、任何 Bot 权限/配置变更与停用）必问且无“总是”，R4（Chief/自身为目标、扩池、凭证、绕过审批）一律拒绝；全局暂停与每 Bot 每小时 20 条自动写入上限把 allow 降为询问；本地自动改动留系统卡与收件箱记录并可撤销（版本不变才可撤）；新 Bot 默认“可直接改本地” | 低风险自动、高风险硬兜底靠结构化硬匹配而非模型判断；替代 ADR-011 三处：local-write 直接应用含删除（现删除询问）、propose 档才可设精确规则（现规则表统一）、外部写永远确认（现可设“总是允许”，后续阶段开放执行路径，无撤销、受上限与暂停约束）；保留 ADR-005、ADR-006 | 新增工具必须先登记风险；开放无人值守写入（例行任务 R1 自动）时按计划补测试。对外“总是允许”的执行路径已生效（阶段 3，D-09：仅 Task 内日历写工具；工作区外部提案仍每次确认）；主会话只读加派生 Task 已生效（阶段 1）：主会话不套用 ADR-005 的 Task 固定许可，每条新输入前刷新到 Bot 当前权限，有任何降权则此后模型上下文从刷新点开始；阶段 5：无人值守 R1 自动执行已生效（D-12：例行任务运行只开放工作区改动，按 `decide()` 裁决，替代“定时 Task 强制只读”；旧只读计划保持只读，D-13）；routine_propose 为 H；事件触发合并运行、不自触发（D-14）；阶段 4：前端系统卡的按钮规则集中在 `src/system-cards.mjs`（H 类、结果未知后的重做审批、暂停中都不显示“总是”），只是展示，裁决仍只在服务端 `decide()`；阶段 6：默认配置新建（general、不带参数，名字之外都可省）仍为 R0，新 Bot 默认带能力池内的本地工作区工具（不含 prepare_schedule、不扩池，D-15），删除仍按预设询问 |
| ADR-013 确定性检测器 | 冲突、逾期、会前未准备、话题跟进与每日“昨日遗留”由纯代码按数据变化（同事务变化标记 + 2 秒去抖）和检测器自己的唤醒时间重算整个 7 天范围；Finding 按对象版本去重，版本变化旧条静默失效；每天最多 10 张卡推到 Chief 主会话，其余并入次日汇总，22:00–08:00 只进收件箱；“处理”在 Chief 主会话派生任务，“忽略”只管这一版本，“这类别再提醒”可在设置页恢复 | 主动但不打扰、可预测、不调用模型、不读聊天正文（I-07）；不复用 Schedule、不另写 Notification（只有收件箱和主会话卡） | 新增检测器须给出结构化输入、去重键和唤醒点；要让模型参与只能经阶段 7 的显式开关（已实现：设置页“帮我想办法”默认关闭；点击是用户发起的只读派生任务，额度 5/10，检测器本身仍不调模型；给 Chief 加只读查看须用户在开关处勾选，只用池内工具，D-19/D-20） |

## ADR-014 实时权限与直接做/先问

采纳日期：2026-10-24。实施依据：[权限简化计划 S1–S5（选定 A 极简）](../../plans/done/2026-10-30-permission-simplify/PLAN.md)。

### 替代关系
- **ADR-005**：替代 Task 固定许可、Bot Grant、权限快照与撤权代数比对。保留可信执行身份、用户来源许可和每次调用/回读时实时复核。
- **ADR-011**：替代 Bot 三档、档位映射 Grant、改档失效与必须新建 Task 的机制；保留本地所有者隐式完整许可、外部用户 Grant/readScope 和统一收件箱。
- **ADR-012**：替代 R0–R4/H 风险分级、档位预设、批量计数、每小时自动写入上限、主会话只读及权限刷新点、无人值守审批 30 分钟过期。保留统一裁决入口、结构化规则、暂停、精确审批、审计、本地撤销和 unknown 保护。
- **ADR-013**：检测器与只读分析范围不变；“帮我想办法”给 Chief 增加查看工具改为直接更新当前分配，不再查能力池或写档位。
- **ADR-006** 不变：幂等、精确意图和 unknown 不盲重试属于正确性保证，不随权限简化删除。

### 当前选择
1. **实时能力**：可用工具 = 已安装 ∩ Bot 当前分配 − 已撤销工具；资源取当前分配。删除能力池、Bot Grant/readScope、权限 epoch、Task 权限快照和权限迁移。预置 Bot 按 defaults 分配，新 Bot 默认带本地 workspace.list/get/prepare_change/operation_status 与 workspace:local；增减和重授从已有 Task 的下一次调用起生效。飞书断开/换绑会从所有 Bot 移除旧资源。
2. **工作区主体**：仍校验来源/连接 active、来源能力及用户许可；local 为所有者隐式完整许可，外部用户 Grant/readScope 保留。Bot 读需 list/get、写需 prepare_change，并分配对应 workspace:<sourceId> 资源；读权限由用户 readScope 决定。stdio client 另受自己 sources/actions/readScope、到期、撤销与 Bot 当前分配约束。用户提醒和内部计划的 authorizationSnapshot 保留；不把所有 epoch 字段一概删除。
3. **工具范围**：主会话带 Bot 当前全部可用工具及 task_create/task_status/automation_pause，可直接写入；派生 Task 用于长任务。例行任务只开放工作区工具并限定原来源，显式 writes=true 才开放工作区改动；测试运行、旧只读简报及“帮我想办法”任务保持只读。模型/提示词配置迁移仍保留；权限变化不要求迁移、不截断模型历史，受保护历史与结果仍在读取边界复核。
4. **统一裁决**：读与内部协作工具一律 allow，规则不作用于它们。写工具按 tool、action、sourceId、type 的匹配字段数量选最具体规则，同级 deny > ask > allow。无匹配时仅 workspace.prepare_change/delete、calendar_feishu_delete_event、bot_manage/deactivate 为 ask，其他写入 allow；未知工具或动作 deny。规则支持 allow/ask/deny；旧 preset 与 risk 匹配规则忽略，写规则时清除 preset。
5. **确认与暂停**：在场 ask 绑定原操作、精确参数和版本；本地提案 5 分钟有效。审批卡可点“以后直接做”写规则；暂停中与 unknown 后的重做审批继续禁用该按钮。全局暂停把写入 allow 降为 ask，停止例行任务及事件触发，恢复不补跑；Bot 只能暂停，恢复经认证用户入口。
6. **无人值守**：origin 为 routine/event/detector 的步骤遇到 ask 直接跳过，在工具结果、运行记录中写明“已跳过：这一步需要你来做。”；不出卡、不挂起等待过期。派发例行任务时实时检查 Bot active、读工具、来源资源和用户/连接许可，不满足取消并记录原因；只改配置版本不再静默取消。
7. **管理与界面**：Bot 页集中工具/资源勾选和规则，删除能力池、档位和 AgentWorkspace 面板；stdio 凭证发放、列表、撤销移到设置页。Chief 默认直接创建、配置 Bot（含自身配置），停用默认先问；保留不能停用 Chief 自身的入口完整性约束。凭证仅留服务端，不进入模型。
8. **副作用保证**：本地自动改动留审计与可撤销记录，版本不符不能撤销；对外写入无法撤销。Operation 幂等、unknown 不盲重试、取消、暂停、模型/工具/token 调用预算继续保留，不恢复已删除的批量或小时写入上限。

### 原因与代价
Bot 页勾选结果就是所有 Task 的实时能力，默认只有删除先问，避免同一概念被快照、Grant、档位与预设规则重复表达。代价是增权立即影响旧 Task，对外新建/修改、建例行任务、Chief 改配置默认自动执行；不再用风险硬底线限制 Bot 修改自身配置。精确意图、来源许可、显式规则、暂停与幂等继续约束实际执行。

引入多用户、远程访问或改变来源信任边界前须另记决策；不能把本机单 owner 的默认值直接推广到多租户。

实现依据：[运行架构](../architecture/agent-runtime.md)、[工作区架构](../architecture/unified-workspace-v2.md)、[接口](../interfaces/README.md)。原始讨论与历史基线见 [已完成计划](../../plans/README.md)，本表不把未交付候选方向记录为已采纳能力。

## ADR-015 工具组默认开、开即直接做

> 历史默认与迁移选择：R1已将新Bot改为空白业务能力、启停与确认分离、旧精确分配保留；下述默认全组和灌满迁移不再重放。传统已分配业务写入的allow/ask语义仍适用，外部MCP与配置Host另走精确确认。当前行为见[运行架构](../architecture/agent-runtime.md)和[HTTP](../interfaces/http-api.md)。

采纳日期：2026-10-28。依据：[Bot 工作区与 Hermes 风格统一](../../plans/done/2026-10-30-hermes-workspace/README.md) §0.5（用户选定）。

### 替代关系
- **ADR-014**：替代第 1 条的默认分配、第 4 条"无匹配时删除和停用 Bot 先问"、第 5 条"以后直接做写规则"、第 7 条"Bot 页工具勾选与规则"。实时能力、工作区主体、统一裁决入口、暂停、无人值守跳过与副作用保证不变。

### 当时选择（历史）
1. **默认拥有全部组**：每个 Bot 分配全部可分配工具（已安装、非管理、非主会话专属）；Bot 管理组只随 Chief 的会话提供，自动化控制只在主会话。来源资源仍单独分配。撤权只保留在接口层，界面不再逐个工具勾选。
2. **一组一个开关**：开 = 组内写入全部直接执行，含本地删除、飞书删除和停用 Bot；关 = 组内每个写工具一条工具级 ask。切换时清掉该 Bot 在该组写工具上的全部规则（任意精度），所以开关显示等于 `decide()` 的结果。无匹配规则的写入一律直接执行。
3. **以后直接做 = 开组**：审批卡和本地确认卡上的"以后直接做"把该工具所在组设为开，不再写精确规则。暂停中和 unknown 后的重做仍不提供。
4. **一次迁移**：启动时每个 Bot 补齐全部组、清空撤销；某组有 ask/deny 规则则该组为关，其余规则清除。被替换的分配、撤销和规则留在 `ToolAccess.groupsMigration`，迁移只运行一次。
5. **规则写入入口收窄**：规则只由组开关、"以后直接做"和迁移写入；`POST /api/rules`、`/api/rules/remove` 与 agent-allow-rule 移除，`GET /api/rules` 保留为诊断。
6. **只展示可用工具**：模型只看到 Bot 有对应资源的工具；已委派的子任务不再看到 task_assign（子任务本来就不能再委派）。派发时的授权与资源检查不变。

### 原因与代价
用户要求"默认工具无需勾选，权限只有询问和全部同意"，并明确选择删除不留例外。代价：所有 Bot 默认可直接删除本地事项、删除飞书日程（不可撤销），Chief 可直接停用其他 Bot；不能再只让某一类动作先问，只能整组先问。


## ADR-016 模型连接实时读取与独立凭证文件

采纳日期：2026-10-29（Asia/Shanghai）。实施范围：T02 后端连接与设置存储，不包含设置页表单。

### 决策
- Task 只用固定 `model.id` 选模型；每次调用重新读取当前 base URL 和 key，忽略旧快照的 `provider: bb-api` 和 baseUrl。新描述符使用 `openai-compatible`，不把某家服务商名当授权条件。
- 环境优先级为进程、`my-app/.env`、根 `.env`，再用与数据库同目录的 `model-settings.json`；部分/无效环境配置失败关闭。显式 test 模式不调用模型、不允许启用真实模型。
- JSON 以权限 0600 的临时文件写入并原子替换，明文 key 仅在服务端文件和请求中使用；不进入 SQLite、Harness Document、响应、日志和聊天。API 只返回 hasKey，key 空白保留已有值，环境配置生效时拒绝界面覆盖。
- 新 Bot seed 版本哈希不含连接地址/凭证；已有 Bot 目录及版本不重算，因此旧 Task 不会因 seed 哈希切换出现无关迁移提示。无模型启动后首次保存允许新 Task 使用真实模型；已有 Task 不改模式和模型名。

### 原因与代价
更换服务商地址或轮换 key 是连接运维，不是修改任务身份；不应要求每个历史任务迁移。旧模型在新连接不存在时明确 `MODEL_REJECTED`，不自动替换、不重试业务副作用。保留本机单 owner 边界；明文文件需受主机权限及备份纪律保护，不等同于系统密钥链。保存幂等摘要仅在进程内保留，不把原请求或 key 复制到持久审计；重启后相同保存仍是安全覆盖。

实现：[模型连接](../../my-app/server/model-reply.mjs)、[设置文件](../../my-app/server/model-settings.mjs)、[API](../interfaces/http-api.md)。若引入多服务商路由、远程多租户或系统密钥链，须另记 ADR。


## ADR-017 周月规则与实时三文档

采纳日期：2026-10-29（Asia/Shanghai）。依据已确认的 T09/T11 票选择：短月取最后一天、人格替代职责、每次调用实时注入。

- 周/月扩展现有规则判定，不新增调度器；沿用 DST 缺失跳过/重复取第一次与暂停不补跑。旧版恢复周/月可能误按每日执行，回滚前必须在新版取消这些计划，不能只暂停后降级。
- 人格/记忆按 Bot，偏好全局共享，保存独立版本和来源审计。旧职责只首次初始化人格，之后配置迁移不覆盖用户人格；不改原工作区或 Task 文档版本。
- 来源资料低优先级、有界实时注入；后台空闲提取独立限额、不提供工具、不重放原任务。只接纳已消费的认证私聊来源；删除/纠正防止同一旧来源复活，凭证和日程不能写入。
- 主会话选模型固定到每条输入，不重写在途调用或历史；独立 Task 模型名快照不变，连接仍按 ADR-016 实时读取。

实现与限制见 [运行架构](../architecture/agent-runtime.md#实时三文档记忆t11)、[HTTP 契约](../interfaces/http-api.md#bot-人格记忆与共享偏好)和[运行手册](../engineering/operations.md#周月计划的回滚边界t09)。本轮仍待用户最终验收，不将自动检查等同真实供应商验证。

## ADR-018 外部 MCP 与对话配置能力按工具组直接执行

采纳日期：2026-10-30（Asia/Shanghai）。依据用户选择"收掉这几道关卡"，修改 R1 合同中"外部工具未知风险默认 ask"和配置链的初次/二次精确确认。

- 已给某 Bot 启用的外部 MCP 工具，调用时和其它写工具同一路径裁决：无规则即直接执行，确认卡由 `autoApproveByRule` 记为 `policy-rule` 自动通过；只有 ask/deny 规则或自动化暂停才等待用户。无人值守来源因此也能调用。
- `mcp_manage`/`skill_manage` 的配置意图、Skill 机制工具范围与全局变更范围同样按"能力配置"工具组裁决：组开着就直接完成，组设为先问才逐项确认。`bot_manage` 赋予配置工具不再强制先问。
- 不变：启用（`capability-assignments`）与直接做/先问分开；配置必须来自当前真实用户输入；凭据仍只走安全表单；派发意图、unknown 不自动重试与回执逻辑不变。外部工具不在工具组内，暂不能单独设为先问。

## ADR-019 每 Bot 文件式记忆，Document 改作台账

采纳日期：2026-10-30（Asia/Shanghai）。依据 2026-10-30 用户答复 R2 §8，替代 ADR-017 中“人格/记忆/偏好只存 Document”的部分；ADR-017 的来源、注入、提取规则不变。

- 内容真源是数据目录下 `bot-workspaces/` 的三个 Markdown 文件：每 Bot 的 `PROFILE.md`、`MEMORY.md`，全局的 `shared/USER.md`。原 Harness Document 继续存版本、修订、来源、防复活、回执和提取水位，另加一类 `pidot.bot-memory.file` 台账。
- 只有一个对账函数读写文件：读取前发现手改就以上次写回版本为 base 三方合并，同 id 以文件为准，记 `actor: 'file'`；台账较新就原子写回（临时文件、fsync、写前哈希复核、rename、目录 fsync）。不用 fs.watch，靠“读之前对账”保证一致。
- 文件手改权限等同界面用户（可改人格），但只改内容：不写防复活标记，含密钥照常导入（读取脱敏、注入过滤不变）。超限、无法解析或不可访问的文件整份不用，Agent 只收到一行提示，不退回旧版本；改好后自动恢复。
- 迁移只新增文件与台账，旧文档逐字节不变。`PIDOT_MEMORY_FILES=0` 回滚：启动时把未同步的手改导入一次，之后行为与 R2 前相同；R2 前的代码能直接读新库。
- 代价：写回会把文件整理成规范格式（丢掉用户加的标题和注释）；编辑器用旧缓冲覆盖会删掉期间新增的条目（修订历史可找回）。
- 凭证检查只扫新写入的内容：已存的内容里有当前 key（手写导入或 key 轮换后）不再挡住提取和界面编辑，读取与注入照常脱敏、过滤。这一点放宽了 ADR-017。

实现与限制见[运行架构](../architecture/agent-runtime.md#文件式记忆r2)、[HTTP 契约](../interfaces/http-api.md#bot-人格记忆与共享偏好)和[运行手册](../engineering/operations.md#文件式记忆的开关与回滚r2)。

## ADR-020 Google 混合接入：日历与任务原生，其余经 workspace-mcp，Pidot 统一授权

采纳日期：2026-10-30（Asia/Shanghai）。依据第三轮 D1–D13。

- Calendar、Tasks 原生适配，接进 workspace-service 的按 provider 适配表，进 Event/Todo 文档，日历视图、同步、提醒、检测器直接复用。新建日程的事件 id 由 requestId 派生，结果不明时按 id 回查；改/删带 etag，412 为冲突。
- Gmail、Drive、Docs、Sheets 经固定版本的 workspace-mcp（2.2.1），以第一轮外部 MCP 的 loopback HTTP 接入。Pidot 每次调用带当前访问令牌，workspace-mcp 按外部 OAuth provider 模式经 Google userinfo 校验，不保存 refresh token。权限用 `--permissions gmail:readonly+drafts+send drive:full docs:full sheets:full --tool-tier extended`。它默认监听 0.0.0.0，必须显式设 `WORKSPACE_MCP_HOST=127.0.0.1`。写入结果不明时记 unknown，不自动重试。
- 授权：单个 Google 账号，用户自建桌面应用 OAuth 客户端；PKCE + state 的一次性 127.0.0.1 回调，5 分钟时限；浏览器与 Pidot 不同机时“粘贴跳转地址”兜底（设备码流程不支持这些 scope）。refresh token 只在数据库同目录 `google/credentials.json`（0600），访问令牌只在内存；不进 SQLite、聊天、模型上下文、日志和响应。断开即撤销令牌、删除本地凭据，并从所有 Bot 撤下 Google 资源。
- 设计可原样迁到服务器：不假设浏览器与 Pidot 同机，配置不存本机绝对路径。Pidot 自身的服务器部署不在本决定内。
- 代价：workspace-mcp 是要常驻的另一个进程；它的写入结果无法自动核实，重复发信要用户自己核对。真实 Google 的 Tasks `If-Match`、etag 格式等行为仍待真实账号确认。

实现与操作见[运行架构](../architecture/agent-runtime.md#google-连接r3)、[HTTP 契约](../interfaces/http-api.md#google-连接)和[运行手册](../engineering/operations.md#google-连接与-workspace-mcpr3)。

## ADR-021 外部来源连上即可用，日程与事项写入各归其组

采纳日期：2026-10-30（Asia/Shanghai）。依据第三轮 D14、D15，用户原话“权限权重降级，飞书日历日程降级为普通工具，只是优化更好”。

**替代关系**
- **ADR-014 第 2 条**：外部来源的“用户 Grant/readScope 须逐个来源授权”改为连接即授权。Grant 与 readScope 仍保留，只用于用户主动收窄（`grantExternal`）和 epoch 失效。
- **ADR-015 第 2 条**：“一组一个开关”对启停不变；写入确认改为按被改对象裁决：`workspace.prepare_change` 改 Event 归「日历与日程」，改 Todo 归「待办与事项」，用 PolicyRules 已有的 `type` 匹配。
- **ADR-011** 中“外部来源（飞书）仍按用户 grant + readScope”同样改为连接即授权。
- 不变：ADR-006（requestId、expectedVersion、unknown 不自动重试、恢复复用原 Operation）、ADR-014 的实时能力、Bot 按资源分配、暂停、无人值守遇 ask 跳过、ADR-018。

**决定**
1. **连上即可用（D14）**：来源的 Connection 以新 authEpoch 写入（首次连接、重连、换绑）时，同一事务调用 `seedSourceGrant(repo, tx, { sourceId, capabilities })`（`workspace-grants.mjs`）：用户 Grant 设为来源能力的完整读写（只读来源只给 read），epoch +1，旧连接上的待确认意图随之失效。飞书在 `workspace-feishu.mjs` 的 `sync()` 调用；Google 由 R3-03/R3-04 在写 Connection 的同一事务调用，替代 第三轮交接契约 §2.1 的“待定”（D-A 结论：发现即授予，不加步骤）。
2. **Bot 分配不变**：哪个 Bot 能用仍在 Bot 能力页分配 `workspace:<sourceId>`，新 Bot 仍是空白。飞书断开或换绑另一日历时，所有 Bot 的 `workspace:feishu:*` 资源都被撤下（此前只撤 `feishu:*` 日历工具资源）；同一日历断开后重连，旧分配也不恢复。Google 照旧由 `applyGoogleAccount` 撤 `workspace:google-*`。
3. **已有授权继续有效**：已有的完整、仅忙闲或已撤销的授权都不改。唯一例外是一次性升级：D14 前已连接、用户从未点过授权（空 Grant 且没有对应 epoch 的授权操作）的飞书来源，启动时补成完整授权；用户明确撤销过的保持撤销。不改 schema，不删数据。
4. **按对象裁决（D15）**：`decide()` 取对象类型时，外部来源由 provider 定（飞书、Google 日历 = Event，Google 任务 = Todo），调用方传的 `type` 改不了；本地来源用 `change.type`；无法确定时取两类中最严格的结果。「日历与日程」设为先问写入 4 条日历工具 ask 加 `{ tool: 'workspace.prepare_change', type: 'Event' }`；「待办与事项」写入 `routine_propose`、`workspace.prepare_schedule` 两条 ask 加 `type: 'Todo'` 那条。
5. **旧规则照常生效**：R3-07 之前写入的无类型 `workspace.prepare_change` 规则同时作用于两类对象，所以两个开关都显示它；切换其中一个组时，先把它收窄为另一类对象的带类型副本（`splitFrom` 记原规则 id），另一组的效果不变。
6. **飞书没有特例**：飞书日历工具走普通写工具的同一条路：组开即直接执行（含删除），组设为先问才确认，暂停时改为先问；requestId、写前比较、unknown 不重发照旧。

**原因与代价**
用户嫌关卡多；连上来源本身就是用户的明确意图，按 Bot 分配已经限定了谁能用。代价：已分配该来源的 Bot 在连接后立即能读取并直接写入外部日历，对外写入无法撤销；同一日历重连时，在重连与第一次同步之间做的分配会被撤下，需要重新分配（宁可多撤一次，也不让旧分配复活）。旧的无类型规则在两个开关上都显示，切换时会拆成一条带类型的规则。引入多用户、远程访问或改变来源信任边界前，要恢复逐个来源授权，并另记决策。

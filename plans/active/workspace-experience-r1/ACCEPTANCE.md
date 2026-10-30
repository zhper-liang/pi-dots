# R1 逐票实现与验收材料

**本轮代码实现与受控本地验收完成，待用户验收。** Root已对最后外部MCP审批渲染修复后的源码独立执行：**1395/1395**，0 fail/cancel/skip/todo（约43.1秒）；lint exit0、13条既有React warning；build exit0，`index-CTZ3GFnv.js` 651.41kB，保留chunk体积提示。最终1440/375、Skill、目标Bot停用与同临时库API/store重启已完成；QA清理和凭据输出检查由root确认。仍保留active、不移done，没有正式库操作、部署、提交或推送。

本表区分实现、阶段自测和最终验收。SDK-only Tavily smoke、模块测试、临时 loopback 页面和用户验收分别记录，不能相互替代；重叠套件计数不累加。

## 逐票状态

| 票 | 已有实现与证据 | 本轮结论 | 未验/限制 |
|---|---|---|---|
| R1-01 契约与接入点 | 1104/1104启动基线、接口/所有权；固定SDK/Zod审批安装及安装后独立1304/1304 | 完成，原始基线保留 | 基线不代替本轮1395最终检查 |
| R1-02 弹窗/本机时间 | EditorDialog/LocalTimePicker有模型/日历多处消费；时间选择、Esc与草稿保留 | 实现/自测完成；复用上轮已实际操作证据 | 本轮未重做全部弹窗/键盘矩阵；物理IME、触屏、辅助技术未验 |
| R1-03 会话生命周期 | 删除/清空/持久回执；旧GET410、新上下文空、独立Task保留、窗口结果接续/去重/来源过滤 | 完成；共享回归与上轮双宽度删除/清主/重启证据保留 | 本轮新验收未重演全部旧会话路径；正式库/全SIGKILL矩阵未验 |
| R1-04 输入候选 | @/Skill菜单、稳定ID/同名区分、私聊带草稿不自动发送 | 完成；复用上轮@证据，本轮375实际用ArrowDown+Enter选Skill | 浏览器键事件不等同物理IME或全键盘矩阵 |
| R1-05 模型UI | 摘要/编辑、环境只读、key空白、逐输入模型和固定Task快照 | 完成；复用上轮1440/375模型实操 | 未声称本轮重做全部模型流程；真实供应商未验、多provider路由范围外 |
| R1-06 日历与刷新 | 卡片选时/编辑、有界刷新和草稿保持、收起独立Todo UI、旧数据/API保留 | 完成；复用上轮日历双宽度实操并纳入1395回归 | 无真实触屏拖动/外部账户写入或全部离线组合验收 |
| R1-07 定时任务 | 单Bot执行/投递、模型、频率/时间卡；legacy status兼容、unknown不假送达、周期失败暂停 | 完成；上轮375显式fixture授权后创建09:15卡片及调度回归保留 | fixture授权非默认权限；未真实等待所有长周期/停机组合 |
| R1-08 能力/空白Bot | 实时启停与确认分离、新Bot空白、旧分配保留、“能力配置”组真实登记 | 完成；本轮1440新Bot无授权、direct/scoped GET200；影响39/39/总1395 | 正式旧库迁移未操作 |
| R1-09 外部MCP | 官方SDK HTTP/已安装stdio、独立凭据、动态schema/绑定/批准/预算/来源/完整回执与分页 | 完成；1440实际配置→凭据→ready→目标调用；最终asset下批准151无白屏，2次SDK调用各自获批准 | 网页使用受控HTTP fixture；真实账户/真实供应商未验；Tavily SDK-only单列 |
| R1-10 用户Skill | 声明式导入/固定包/版本/撤销/Task快照；真实durable requestStatus | 完成；375自然语言配置→独立Task168选用Skill→真实注入phrase，重启后再用成功 | 不运行scripts；私有仓库OAuth/任意格式与文件记忆迁移范围外 |
| R1-11 Agent配置 | 真实user/native turn/Host精确批准、旧Chief同库启用、显式配置Agent、安全原输入续办、额外范围确认、认证setup GET/POST | 完成；MCP/Skill真实页面链、第二次三机制确认、批准后仅停用目标Bot；unknown只读/显式续办由manager18/18及UI62/62覆盖 | 不是浏览器全故障注入；组件计数不相加为总数 |
| R1-12 总集成/材料 | 最后源码1395/1395、lint/build；1440/375、同临时DB重启、凭据输出检查与受控QA清理 | 本轮本地验收和材料完成，待用户验收 | 真实账号、物理IME、辅助技术、完整SIGKILL矩阵未验；不移done |

## 自动检查快照

| 快照 | 实际结果 | 用途与限制 |
|---|---|---|
| R1-01 启动 | 1104/1104，lint/build通过 | 原始启动基线 |
| 早期共享接线 | 1290项：1267通过/23失败，后续1275通过/15失败 | 历史失败，修复过程保留在progress/findings |
| 会话与静态/Skill收尾 | 1304/1304，lint13条React warning、build606.72kB提示 | 上一轮冻结结果 |
| 固定SDK/Zod安装后 | 独立重跑1304/1304，lint/build通过 | 不是仅复用旧基线，也不证明生产外部MCP已接入 |
| 09共享 | 新增7/7、相关172/172、定点lint通过 | 正常SDK/Harness/产物/来源/重启用例；非全部安全/故障矩阵 |
| 11共享 | 六条Host集成、相关219/219、定点lint通过 | 原始日志与源码hash见共享handoff |
| root首次总集成 | 1383项，1382通过/1失败 | mcp_manage/skill_manage未归组；已修真实分组，影响回归39/39 |
| root渲染修复前 | 1391/1391，lint/build exit0 | **后续还有外部MCP审批渲染fix，不作为最终结论** |
| 最终冻结源码 | **1395/1395**，0 fail/cancel/skip/todo，43.1s；lint exit0/13既有React warning；build exit0/651.41kB chunk提示 | root对最后render fix后源码独立执行，区别于1391修复前快照 |

## 已观察问题与真实处理

| 问题 | 已知根因/处理 | 证据边界 |
|---|---|---|
| Agent执行通道403 | 三个owner曾因Cloudflare/余额403中断；有界恢复后可执行，原diff保留 | 不是已通过的产品提供方调用，保留中断记录 |
| 普通Bot/新Skill旧默认断言 | 旧测试假定默认全开/自动分配；按R1显式授权与空白默认修fixture/断言 | 没有恢复grant-all追绿 |
| 工具未归组 | mcp_manage/skill_manage缺membership；新增真实“能力配置”组及中文名 | 1382/1383原失败保留，未仅改断言 |
| 新Bot GET500 | 早期只有QA UNKNOWN；后确认toolSets.externalTools把事务overlay带出commit，HTTP JSON触发Cannot use a settled overlay | 已事务内复制为普通JSON；冷启动、已有MCP目录后direct/scoped GET通过 |
| 恢复期Host未定义 | WIP引用requestCapabilityIntent等尚未定义函数，新开store时报ReferenceError | 与此前GET500是两个问题，补齐真实Host后冷启动通过 |
| 第一次审批白屏 | manager operation被当calendar读取stableIdempotency | 修复后1440真实初次批准→needs_auth→同setup ready全链通过 |
| 第二次审批白屏 | 实际greeting.echo批准后，external MCP operation又进入calendar假设 | 最终asset下批准151不再白屏；1395全量对应最后修复，1391前快照仍保留 |
| QA假模型再次提议 | 144 executed且SDK实际一次；151是fake model误取宿主user角色回执文本后生成另一marker的pending批准 | 没有产品自动重复派发证据；QA模型归一化，不据此改产品 |
| 宽套件cwd错误 | 从仓库根跑既有migration相对子进程fixture失败，回my-app目录后通过 | 不修改用例掩盖；不能外推所有SIGKILL矩阵 |

## 页面与重启证据

### 本轮最终受控实操

| 页面/链路 | root实际结果 |
|---|---|
| 1440空白Bot | 新建目标Bot，无业务授权；direct/scoped主会话GET200、composer正常 |
| 1440 Chief配置MCP | 自然语言→真实初次精确批准→needs_auth；专用凭据保存时立即清空→同setup ready→目标Bot工具列表出现 |
| 1440目标Bot调用 | greeting.echo按实际逐次批准执行并保存SDK receipt；最新`index-CTZ3GFnv.js`下批准151页面不白屏 |
| 375 Chief配置Skill | 自然语言→初次批准→第二次明确仅三机制工具范围→ready |
| 375使用Skill | 新独立Task168，通过/菜单ArrowDown+Enter选择；真实加载/注入固定内容，受控fake model返回fixture phrase |
| 对话停用目标MCP | 经精确批准撤销目标分配，同一目标主会话110不再有mcp_工具、不产生新审批；连接没有被误当全局移除 |
| 同临时库重启 | SIGUSR2仅重启API/store，SDK fixture保持；目标main110与独立168保留；连接configured、凭据及toolCount3保留，不自动ready |
| 重启后检查/使用 | UI检查后连接ready，目标仍未绑定MCP；375再次/选Skill并得到真实注入对应回复 |
| 调用次数/布局 | fixture共2次调用，各自单独用户批准；disable/restart无新增调用；本轮1440/375无横向溢出 |

同库API/store重启不等同进程/机器断电或所有阶段SIGKILL。受控fake model验证实际Host/SDK/Skill注入路径，不是对真实模型供应商或模型质量的验收。

最终截图位于 `.scratch/2026-10-29-workspace-experience-r1/r1-09-12/`：`final-mcp-ready-1440.png`、`final-mcp-call-1440.png`、`final-skill-confirm-375.png`、`final-skill-ready-375.png`、`final-skill-use-375.png`、`final-restart-skill-375.png`。文件已核对存在，核心截图由root视觉检查；详细过程在root-resume-handoff。

### 明确复用的上轮实操

旧会话删除/清主/日历/@/模型的1440/375证据复用上轮已实际完成的受控记录，**没有冒充本次重做**：日历10:15–11:45、375 @稳定ID与逐输入模型、只读模型弹窗、空白聊天、显式授权Chief后09:15计划、上轮受控库43→149清空、375置顶删除/pin及同库重启不复活、导航toast修复。截图在 `browser-020405/`，构建时间与流程见progress。

### 凭据输出检查与清理

针对本轮合成MCP凭据，公开API载荷、页面可见文本、browser storage均未发现，密码框字符数0；真实Tavily Key未复用。Root已确认QA进程exit0、browser关闭；仅最新专属受控/tmp合成库目录及含合成凭据的临时脚本/log/session删除，保留redacted session、fixturecalls、截图、源码hash与最终tests日志。正式服务、.env、正式库未访问未改；无部署、提交或推送。Root最终diffcheck通过，`.scratch`/`.playwright-cli`保持ignored。

## 交付与证据索引

- 启动基线：[execution/r1-01-baseline/README.md](execution/r1-01-baseline/README.md)。
- 执行过程：[progress.md](progress.md)、[findings.md](findings.md)、[task_plan.md](task_plan.md)。
- 09/11共享handoff与hash：`.scratch/2026-10-29-workspace-experience-r1/r1-09-12/shared-backend-09-*`、`shared-backend-11-*`、`group-registration-followup.json`。
- 本轮正常Host/来源日志：`/tmp/pidot-r1-management-host-wide.log`、`/tmp/pidot-r1-management-host-lint.log`；工具组补充：`/tmp/pidot-r1-group-registration-{test,lint}.log`。
- 最终日志：`/tmp/pidot-r1-complete-final2-test.log`、`/tmp/pidot-r1-complete-final2-lint.log`、`/tmp/pidot-r1-complete-final2-build.log`。
- 结构化最终结果及源码hash：`.scratch/2026-10-29-workspace-experience-r1/r1-09-12/final-result.json`、`final-source-snapshot.json`；root对比前一freeze只变化最后render fix的`TaskApprovalControls.tsx`与`capability-setup-ui.test.mjs`。
- 本目录可留存的最终摘要：[execution/r1-12-validation/results.json](execution/r1-12-validation/results.json)；1391修复前快照保留为历史，不覆盖1395。

## 明确未验及范围外

未操作正式服务、正式数据库、真实外部模型/飞书/Google账户；不宣称物理IME、真实触屏拖动、系统辅助技术或SIGKILL全故障矩阵通过。只读连接检查不是外部写工具测试；unknown不改成失败/成功或无副作用重试承诺。单进程本机单owner、后端在线才执行，仍无provider原子CAS/exactly-once保证。

Tavily 0.2.22 的一次SDK直连smoke是独立互操作证据，不能替代Pidot生产装配/Host绑定调用。通用包安装器、任意脚本执行器/沙箱、完整OAuth、Google Workspace、文件式记忆迁移与多提供方路由均不随本轮交付。

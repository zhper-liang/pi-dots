# 当前状态与授权边界

更新：2026-11-02（Asia/Shanghai）。接手前读这一页，再读[架构总览](docs/architecture/README.md)和 [plans](plans/README.md)。

## 一句话状态

已验收的计划都在 [plans/done](plans/README.md#已完成)。长任务持续执行已实现并本地验证，尚未提交或部署；“等用户验收”表中的既有计划实现完成、本地验证通过，已纳入 v3.0.0 发布提交，用户验收状态保留。2026-11-02 发布复核：test 1651/1651，lint 10 条既有 warning，类型检查与隔离构建通过；不是长任务功能的验证结果。

## 已立项与分票

| 计划 | 当前状态 | 下一票 | 范围说明 |
|---|---|---|---|
| [长任务持续执行](plans/active/long-running-agent/README.md) | LR-01 至 LR-09 按修订范围完成，等用户验收 | 无待实施票 | 按 Astra / 6.1 Sol / Terra 分工；最终 test 1753/1753、lint/build、1440/375 短例通过。只做例子、中断和关键边界，没有长时或真实模型生成评估；未改正式库、未重启服务、未提交部署。详见[验证记录](plans/active/long-running-agent/VALIDATION.md) |

## 等用户验收

| 计划 | 内容 | 验证 | 没做的 |
|---|---|---|---|
| [协作、会话与模型故障修复](plans/active/collaboration-session-reliability/task_plan.md) | 普通委派全过程默认协作与结果回交、主会话列表、机器人目录和时间提示、模型 thinking 参数兼容修复 | test 1650/1650、模型定向 36/36、lint/隔离构建、浏览器会话列表、真实模型最小请求 | 正式任务恢复；未重启正式服务；纳入 v3.0.0 提交 |
| [会话提问与能力管理优化](plans/active/conversation-capabilities/task_plan.md) | 问题表单、不阻塞新消息、原输入恢复、能力即时同步、来源嵌入工具集、飞书统一来源入口和无感同步、聚合日历卡片来源标签（ADR-027） | test 1651/1651、日历定向 38/38、lint/build、1440/375 | 真实模型/飞书账号交互、未重启正式服务；纳入 v3.0.0 提交 |
| [主会话长期记忆与经验沉淀](plans/active/memory-learning/README.md) | 按会话一小时空闲或压缩触发整理、持久作业、同机器人历史搜索、学成 Skill（ADR-026） | test 1597/1597、lint/build、1440/375、独立宿主验收 | 真实模型下的整理质量；纳入 v3.0.0 提交 |
| [原生能力与删除确认](plans/active/native-capabilities/README.md) | 每个机器人自带 bash/read/write/edit；只有删除逐次确认；去掉凭证面板；历史回查默认自带（ADR-024、025） | test 1549/1549、lint/build、1440/375 | 纳入 v3.0.0 提交 |
| [多模型登记](plans/active/model-registry/README.md) | 登记多个供应商 ID / URL / Key / 模型名，新建机器人可选 | test 1555/1555、lint/build、1440/375 | 真实供应商；纳入 v3.0.0 提交 |
| [普通机器人平等与空白创建](plans/active/bot-equality/README.md) | 除主管外地位相同，新建默认空白（ADR-023） | test 1540/1540、lint/build、1440/375 | 纳入 v3.0.0 提交 |
| [第三轮：Google Workspace](plans/active/r3-google-workspace/README.md) | Calendar、Tasks 原生，Gmail、Drive、Docs、Sheets 经 workspace-mcp（ADR-020、021） | test 1531/1531、lint/build、1440/375 | 真实 Google 账号，步骤见[运行手册](docs/engineering/operations.md#google-连接与-workspace-mcpr3) |

2026-11-02：用户授权将当前版本提交并上传 GitHub，补充 README、演示截图与积极的项目描述，发布为 v3.0.0；未操作正式库或重启正式服务。发布说明见 [v3.0.0](docs/releases/v3.0.0.md)。

2026-11-01 归档、同样未经验收的：[第四轮：降低使用负担](plans/done/2026-10-31-r4-simplify/README.md)（部分默认值被 ADR-023、025 改掉）、[模型上下文与 Pi 压缩](plans/done/2026-11-01-context-memory/README.md)（由记忆学习计划承接）。

已提交但不属于上述计划的界面改动：电视机器人形象与 pipi 改名（`0544fd6`），回复 Markdown 渲染与工具调用折叠（`5ec9894`）。

## 授权边界

- 长任务持续执行已获用户明确实施及派遣子 Agent 授权，具体票状态与实际验证见计划及本地 tracker。
- 上表各计划的范围以计划正文为准。第三轮、第四轮、记忆学习和会话提问与能力管理优化计划授权过派子 Agent，其余没有。
- 这些授权都**不含**：新依赖、操作正式库和 `my-app/data/`、重启正式服务、连接真实 Google 账号或真实供应商、提交或推送（用户另行要求的除外）。
- 此外的新阶段、新连接器、新依赖、派子 Agent 都需要用户另行授权；候选计划未授权不得开工。
- 已批准的固定依赖：`@earendil-works/*@1.3.0`、`@modelcontextprotocol/sdk@1.32.2`、`zod@4.6.7`、`react-markdown@10.1.0`、`remark-gfm@4.0.1`；第三轮另批准固定版本的 workspace-mcp（Python，经 uv 安装）。
- 凭证不写进文档或日志。

## 没在真实环境验证过

真实外部模型供应商的完整业务会话（jinpai 最小回复、low 推理和合成工具请求已验证）、真实飞书写入、真实 Google 账号、正式库迁移与重启、物理输入法、触屏与系统辅助技术、真实编辑器的保存行为、磁盘满。各计划的未验清单在计划正文里。

# 当前状态与授权边界

更新：2026-10-30（Asia/Shanghai）。接手前读这一页，再读 [plans](plans/README.md)。

## 一句话状态

已交付的计划全部验收通过，移入 [plans/done](plans/done/)。第三轮 Google Workspace 2026-10-30 实现完成，待用户验收。

## 已验收完成

[Agent 运行骨架](plans/done/2026-10-17-agent-loop-foundation/README.md) · [多 Bot 与 Chief](plans/done/2026-10-17-multi-bot-chief/README.md) · [跨 Bot 协作](plans/done/2026-10-18-cross-bot-collaboration/README.md) · [群聊协作](plans/done/2026-10-18-group-chat-collaboration/README.md) · [飞书日历](plans/done/2026-10-19-feishu-calendar/README.md) · [统一工作区 V2](plans/done/2026-10-20-unified-workspace-v2/README.md) · [可控自动代理](plans/done/2026-10-23-controlled-automation/README.md) · [权限简化](plans/done/2026-10-30-permission-simplify/README.md) · [Bot 工作区与 Hermes 风格统一](plans/done/2026-10-30-hermes-workspace/README.md) · [第一轮：交互收口与 Agent 能力配置](plans/done/2026-10-30-workspace-experience-r1/README.md) · [第二轮：文件式记忆](plans/done/2026-10-30-r2-file-memory/README.md)

最近的决策：ADR-018 已启用的外部 MCP 工具和对话配置能力按工具组直接执行，不再逐次确认；ADR-019 每 Bot 人格、记忆和共享偏好以 `bot-workspaces/` 下的 Markdown 文件为真源，`PIDOT_MEMORY_FILES=0` 回滚。见[决策记录](docs/decisions/README.md)。

## 进行中

[第三轮：Google Workspace](plans/active/r3-google-workspace/README.md)：混合路线，Calendar、Tasks 原生，Gmail、Drive、Docs、Sheets 经 workspace-mcp，由 Pidot 统一授权。2026-10-30 用户授权开工（“开”），按票派子 agent，主管协调与验收；子 agent 返回后先停下向用户汇报。2026-10-30 实现完成（ADR-020、ADR-021），待用户验收；真实账号手测步骤见[运行手册](docs/engineering/operations.md#google-连接与-workspace-mcpr3)。设计要能原样迁到服务器，服务器部署本身不做。

## 授权边界

- 第三轮已授权，范围以[该计划](plans/active/r3-google-workspace/README.md)为准，含派子 agent。此外的新阶段、新连接器、新依赖、派子 Agent 都需要用户另行授权；候选计划未授权不得开工。
- 已批准的固定依赖：`@earendil-works/*@1.3.0`、`@modelcontextprotocol/sdk@1.32.2`、`zod@4.6.7`；第三轮另批准固定版本的 workspace-mcp（Python，经 uv 安装，D11）。
- 不操作正式库和 `my-app/data/` 下的数据，不连接真实 Google 账号，不把凭证写入文档或日志。

## 未在真实环境验证

真实外部模型供应商、真实飞书写入、正式库迁移与原库重启、物理输入法、触屏与系统辅助技术、真实编辑器的保存行为和磁盘满。各计划的未验清单在 done 目录对应的计划里。

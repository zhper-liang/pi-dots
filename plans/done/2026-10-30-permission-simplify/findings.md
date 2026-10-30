# Findings

- S1-S3 已落地服务端，但前端仍暴露旧能力池、档位和 AgentWorkspace 面板。
- `BotConfiguration` 当前把 `pool` 和 `assigned` 都展示；S4 要保留实时分配，只移除 pool 层。
- `AgentWorkspace` 同时承载 stdio client 凭证与旧 Bot Grant；凭证接口仍由服务端提供，应在 Settings 重做精简区块。

- `.planning` 是冻结历史目录，当前记录放在 `.scratch/permission-simplify/`。
- 本地未找到 `pidot-manual-ui-test` 原文；按计划明确要求在 1440/375 上用真实应用与隔离数据库操作，不接触真实凭证或外部来源。
- stdio 新增 client-list 只返回 ID/范围/到期/撤销状态，不返回 token；已补认证与有效期测试。
- 主会话的本地工作区提案原来只在收件箱可批；现在复用收件箱卡在当前会话显示对应提案。

- 任务详情旧撤权入口已移除，业务权限统一从 Bot 设置调整。
- 确认卡根据服务端 allowAlways 决定是否提供“以后直接做”，暂停与结果未知重做维持禁止该选项；管理和例行任务卡不再沿用 H 类例外。

# 系统架构与数据流

## 组件边界
```mermaid
flowchart TD
    UI[React 工作区与助理会话] --> HTTP[认证 HTTP API]
    HTTP --> R[Bot / Task 运行服务]
    HTTP --> W[统一工作区业务服务]
    R --> H[唯一 Harness 执行与恢复]
    R --> MCP[宿主管理的 MCP session]
    EXT[本地外部 MCP client] --> STDIO[无状态 stdio 桥]
    STDIO --> RELAY[受限 loopback relay]
    RELAY --> MCP
    MCP --> W
    W --> REPO[Documents repository]
    H --> DB[(既有 SQLite adapter)]
    REPO --> DB
    W --> ADAPTER[飞书 connector adapter]
    ADAPTER --> PROVIDER[飞书应用日历：外部权威]
    BG[进程内持久计划与同步驱动] --> W
    BG --> R
```

一个 Node 后端独占一个数据库和 Harness。UI、API、MCP 和后台不能各自复制业务规则；外部 stdio 桥不能打开 SQLite。浏览器不是调度器，停机期间也没有另一个云服务代替执行。

## 外部变更确认
```mermaid
sequenceDiagram
    participant Agent as Agent / MCP
    participant S as Workspace Service
    participant U as 认证用户 / UI
    participant P as Provider
    Agent->>S: prepare_change(requestId, 精确参数)
    S-->>Agent: Operation / 待确认
    U->>S: 查看并确认原 Operation
    S->>S: 复核权限、epoch、版本、取消与批准
    S->>P: 按原请求派发
    alt 有明确回执
        P-->>S: 结果
        S-->>U: 持久回执
    else 发送后无明确结果
        S-->>U: unknown，保留原身份并核查
    end
```

UI 手动本地 CRUD 不调用模型；Agent 的建议不是用户批准。外部不确定结果不能通过新 requestId 自动重试。

## 数据与控制流
- 本地 Event/Todo 与 Operation 为本地权威；外部事件正文来自 provider，缓存附版本、时间与覆盖信息。
- 同步负责“知道外部发生了什么”；Schedule/Occurrence 负责“何时启动什么”。两者不是同一个状态机。
- 普通提醒走确定性动作，不使用模型；只读简报关联原 Harness Task，执行状态仍由 Harness 提供。
- 来源撤权使后续读取、派发和敏感内容显示失效，但不销毁历史审计或真实迟到回执。

## 实现入口
| 责任 | 源码 |
|---|---|
| HTTP 与认证路由 | [app.mjs](../../my-app/server/app.mjs) |
| Store 与 Harness 装配 | [tasks.mjs](../../my-app/server/tasks.mjs) |
| 业务服务与事务 | [workspace-service.mjs](../../my-app/server/workspace-service.mjs) |
| 存储与记录类型 | [workspace-repository.mjs](../../my-app/server/workspace-repository.mjs) · [workspace-schema.mjs](../../my-app/server/workspace-schema.mjs) |
| MCP 工具与协议 | [workspace-tools.mjs](../../my-app/server/workspace-tools.mjs) · [workspace-mcp-protocol.mjs](../../my-app/server/workspace-mcp-protocol.mjs) |
| 定时、同步、提醒 | [workspace-schedule.mjs](../../my-app/server/workspace-schedule.mjs) · [workspace-sync.mjs](../../my-app/server/workspace-sync.mjs) · [workspace-reminders.mjs](../../my-app/server/workspace-reminders.mjs) |

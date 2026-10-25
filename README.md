# Pidot

本地单用户的多 Bot 持久化个人助理。在网页里和 Bot 对话，Bot 能读写你的日程与待办（本地 + 飞书应用日历）、把活派给别的 Bot、在群聊里协作、按计划提醒你，并在高风险动作前停下来等你点头。

- 一个 Node 进程 + SQLite + 一个网页，模型调用只在服务端。
- 低风险动作可以自动执行并随时撤销；高风险动作必须确认；所有自动化可一键暂停。
- 不是公网服务：只绑定 `127.0.0.1`，单机单用户，不做多租户。

## 快速开始

前置：Node.js ≥ 22.22.1、pnpm 11.21.0。

```sh
cd my-app
pnpm install --frozen-lockfile

# 1) 生成本地访问 token 并写入 my-app/.env
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
cp .env.example .env   # 仅首次；把生成的 token 填进 PIDOT_API_TOKEN=

# 2) 配置模型（服务端，写在项目根的 .env，不要提交）
#    OPENAI_BASE_URL / OPENAI_API_KEY / MODEL

pnpm build
pnpm start:api        # 打开 http://127.0.0.1:3001，用上面的 token 连接
```

测试与开发模式、全部配置项、API 契约：见 [工程 README](my-app/README.md) 与 [运行手册](docs/engineering/operations.md)。

## 目录

| 路径 | 内容 |
|---|---|
| [docs/](docs/README.md) | **项目架构资料**：产品定义、架构与数据流、技术决策、接口契约、工程运维 |
| [plans/](plans/README.md) | **计划**：进行中的计划、已完成计划的正文、未授权候选草案 |
| [my-app/](my-app/README.md) | 可运行工程：React 前端 + Node 后端 + SQLite |
| [NEXT_STAGE.md](NEXT_STAGE.md) | 当前状态、进行中的计划与授权边界（接手前先读） |
| [AGENT.md](AGENT.md) | 协作与文档规范：怎么改、往哪写、什么不能做 |

推荐阅读顺序：本文件 → [项目导读](docs/project-guide.md)（含架构图）→ [MVP 能力与限制](docs/product/mvp-scope.md) → 需要动手时看 [工程 README](my-app/README.md)。

## 现在能做什么

- **对话**：每个 Bot 一个主会话；真实模型、多轮工具调用、Skill 按需调用、上下文压缩、消息排队与插入、取消。
- **Bot 管理**：只填名字建 Bot，默认带本地待办/日程工具；版本化配置、工具授权、停用保留历史。
- **协作**：把任务派给其它 Bot，主管验收与返工；群聊里 @ 单个 Bot 协作，共享信息带来源。
- **工作区**：日程与待办统一建模，本地与飞书两种来源；持久计划、执行记录、外部同步、提醒收件箱。
- **自动化**：例行任务挂到 Bot，按规则无人值守执行；确定性检测器发现冲突/逾期并提醒；"帮我想办法"给出只读分析。

## 现在不能做

- 无系统级推送、无停机期间执行、无 provider 原子 CAS / exactly-once 保证。
- 邮件、外部待办、手机端/云端、多租户不在本版范围。
- 详见 [MVP 能力与限制](docs/product/mvp-scope.md)。

## 状态

本地单用户核心闭环 MVP 已完成；统一工作区 V2（10 票）与"可控自动代理"（8 阶段）已实现，等待用户验收；权限简化 S1–S5 已实现并自测通过，等待验收。详见 [NEXT_STAGE.md](NEXT_STAGE.md) 与 [plans/](plans/README.md)。

## 安全

- 模型凭证只放服务端，绝不进入网页、数据库或对话；不要加 `VITE_` 前缀。
- `.env`、`data/`、`node_modules/` 已在 `.gitignore` 中，不要提交；仓库里只有 `.env.example`。

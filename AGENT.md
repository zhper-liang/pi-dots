# 协作规范

本文是"怎么改这个仓库"的唯一正文。产品与架构结论见 [docs](docs/README.md)，计划见 [plans](plans/README.md)。

## 动手前

1. 读 [NEXT_STAGE.md](NEXT_STAGE.md) 确认当前状态、进行中的计划和授权边界。
2. 读相关的 [docs](docs/README.md) 正文；产品规则、架构、接口各有唯一正文，不要凭印象改。
3. 一个窗口只推进一件事；需求不清且会影响交付时先问，不擅自扩大范围。

## 文档放哪里

| 要写的东西 | 放哪 |
|---|---|
| 产品规则、领域语言、已交付范围 | `docs/product/` |
| 现行架构、数据流、运行机制 | `docs/architecture/` |
| 技术选择的原因、代价、变更条件 | `docs/decisions/README.md`（ADR） |
| 已存在的 HTTP / MCP 接口与数据契约 | `docs/interfaces/` |
| 启动、排障、回滚 | `docs/engineering/` |
| 要做的事：范围、阶段、验收 | `plans/active/<topic>/` |
| 已完成计划的正文 | `plans/done/<日期>-<topic>/` |
| 想法与未授权草案 | `plans/backlog/` |
| 实施过程、逐票票据、原始证据 | 本地 `.scratch/<topic>/`（不进仓库） |

规则：

1. `docs/` 只放长期有效的正式文档。计划、findings、临时笔记、逐票流水、会话日志、测试附件不进 `docs/`。
2. 计划完成后移入 `plans/done/`，正文冻结不再改；后续变更由新计划承接，结论提炼进 `docs/`。
3. 每份正式文档要能指向当前实现；提案里的概念名不能写成已实现接口。
4. 相对链接必须可解析；改路径时同步改引用。

## 代码与提交

- 工程命令、环境变量、测试入口只在 [my-app/README.md](my-app/README.md) 维护。
- 不提交 `.env`、`data/`、`node_modules/`、构建产物或本地工具缓存（见 `.gitignore`）。
- 不操作正式数据库；不把凭证写进文档、日志或提交。
- 提交前跑 `pnpm test`、`pnpm lint`、`pnpm build`，并把真实跑过的结果写进说明；没跑过的不要声称通过。

## 交付说明怎么写

- 做了什么、没做什么、边界在哪。
- 跑过的测试与真实环境验收（含双尺寸网页、真实模型、重启恢复）。
- 保留失败、unknown 和豁免记录，不改写成成功。

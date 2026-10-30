# R1-01 启动基线（非业务验收）

- 日期：2026-10-29，Asia/Shanghai。
- 起始 Git HEAD：`8e31dd0268cec6f703d59cdddbcc30673d61545d`。不是干净提交快照：接手已有 NEXT_STAGE.md、plans/README.md 修改及本轮计划/原反馈未跟踪；均保留。
- 起始 `git status --short` 仅上述文档/计划改动，my-app 业务源文件无已有改动；基线运行时尚未放行 02/04/08 实施，没有新增 Worker 测试计入 1104。后续 Worker 新增测试与接线回归必须单独记录，不回写成本次旧基线。
- 本次直接在该起始源码树执行，无需另建 Git 快照或覆盖未提交文件。测试脚本已同时涵盖 server/*.test.mjs 和 src/*.test.mjs。
- Node v24.22.0；本机 pnpm --version 为 11.1.2（与 package.json 要求 >=11.21.0 / packageManager 11.21.0 有差异；原样记录，不擅自升级）。
- runner 去除 PIDOT_/FEISHU_/GOOGLE_/OPENAI_/ANTHROPIC_/DEEPSEEK_ 环境继承，使用现有临时库/loopback fixtures；没有主动读取/编辑 .env，没有启动正式 API。Vite build 按现有 vite.config.ts 的 loadEnv 逻辑可能读取 .env 配置，本次未导出/记录其内容，不能宣称构建工具绝不读取 .env。

| 命令（my-app/） | 起止（+08:00） | 耗时 | 结果 |
|---|---|---|---|
| `pnpm test` | 2026-10-29T15:02:22.085462+08:00 → 2026-10-29T15:02:54.433929+08:00 | 32.35s | exit 0；1104/1104，fail/cancelled/skipped/todo 均 0 |
| `pnpm lint` | 2026-10-29T15:02:54.434819+08:00 → 2026-10-29T15:02:55.531698+08:00 | 1.1s | exit 0；0 错误、7 条既有 React effect 警告 |
| `pnpm build` | 2026-10-29T15:02:55.532030+08:00 → 2026-10-29T15:03:00.656403+08:00 | 5.12s | exit 0；tsc + Vite 通过，既有 >500kB chunk 提示 |

原始输出见 test.log / lint.log / build.log；机器记录见 results.json。基线不是新功能、真实账号或 1440/375 页面验收。

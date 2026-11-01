# 记忆

每个机器人有自己的人格和记忆，所有机器人共用一份用户偏好。本文讲它们存在哪、怎么进模型、怎么改、怎么自动整理。来历见 ADR-017、ADR-019、ADR-026。

## 三份文件

| 文件 | 内容 | 谁能改 |
|---|---|---|
| `bot-workspaces/bots/<id>/PROFILE.md` | 人格，替代旧的“职责”提示 | 只有用户：界面、文件手改、或私聊里明确要求改人格 |
| `bot-workspaces/bots/<id>/MEMORY.md` | 这个机器人的长期记忆 | 用户；机器人在用户明确要求时；后台整理 |
| `bot-workspaces/shared/USER.md` | 所有机器人共用的用户偏好 | 用户；后台整理只收用户直接说的长期偏好 |

路径相对数据库目录。文件是内容真源，用户可以直接用编辑器改。库里的 `pidot.bot-memory.*` Documents 是台账：版本、修订、来源、防复活标记、回执、整理水位；`pidot.bot-memory.file` 记每个文件最后写回的版本和哈希。

## 对账

只有 `memory-files.mjs` 读写这些文件，每个文件一个串行队列，不用 `fs.watch`。对账发生在：启动、每次模型调用注入前、记忆读写前、修订提交后、关闭时。

- 文件被手改：以最后写回的版本为基准三方合并进台账，同一条目以文件为准，记 `actor: 'file'`。手改删除的条目，其旧来源也被抑制，后台不能用它复活。
- 台账较新：原子写回（临时文件、fsync、写前哈希复核、rename）。
- 刚改过的文件要连续两次读到一样的内容才导入，避免把编辑器写到一半的空文件当成全删。
- 文件超限或解析失败：整份不用，模型只收到一行提示；对账出错时对话照常，用台账内容。

`PIDOT_MEMORY_FILES=0` 回到只用台账，见[运行手册](../engineering/operations.md#文件式记忆的开关与回滚r2)。测试 store 默认只用台账，`openTaskStore({ memoryFiles: { enabled: true } })` 开启文件模式。

## 怎么进模型

每次调用模型前读最新内容，作为低优先级材料注入，受字数和上下文余量限制，不能挤掉目标、约束、当前 Skill 和当前输入。记忆按与当前问题的相关性稳定排序，以完整条目为单位；没放进去的，模型可以用 `memory_read` 分页读。

模型 Key、API token 和常见凭证形态在写入时过滤，读取和注入时脱敏。日程和待办不进长期记忆，每次从有权访问的来源实时查。

## 在对话里改：memory_read / memory_edit

两个工具是每个机器人的固有能力（见[能力与权限](capabilities.md)）。模型不能指定别的机器人、来源条目或凭证。

- `memory_read` 读自己的人格、记忆或共享偏好，返回版本和条目 ID，每页最多 16 条。
- `memory_edit` 只接受本次认证用户在**私聊**里明确的记忆修改要求；群聊、委派、例行任务里不能写。改人格还需要用户明确提到人格。记忆和偏好支持 add / update / delete，人格支持 set。宿主绑定来源、生成幂等请求 ID，和工具回执同一事务提交；版本冲突返回错误，不覆盖新版本。

## 自动整理

后台整理把对话里值得长期记住的东西写进记忆，由 `memory-learning-queue.mjs` 的持久作业（`pidot.memory-extraction`）驱动。

**什么会触发**
- 一个会话连续一小时没有前台活动（按会话单独计时，其他会话不影响它）。
- 上下文压缩：摘要、原始条目范围和作业在同一事务登记，不等一小时。
- 主会话派生的 Task 成功结束：成功工具的原始回执作为证据登记。
- 用户在记忆页点“立即整理”，或在主会话说要整理（`memory_review`）。两者进同一个队列，不伪造用户消息。

**什么能当证据**：私聊里认证用户说的事实；同一机器人主会话合法派生的 Task 中成功的工具回执。群聊、跨机器人协作、例行任务、失败或未知或被跳过的工具、只有助手自己说的话，都不算。候选事实必须能在原始证据里逐字找到，摘要不算来源。

**作业怎么跑**
- 每个机器人串行；状态有 pending、running、applied、no-change、retry-wait、blocked、cancelled。
- 模型返回后先持久化候选和版本，再用固定请求 ID 提交；重启后恢复候选，不重新生成。
- 独立额度：每个 UTC 日 20 次调用、120000 tokens；每批最多 8 条、12000 字符，输出最多 2048 tokens。不消耗业务 Task 的额度。
- 失败最多自动重试三次；额度不够等下一个 UTC 日，用户可手动续办。
- 前台有新输入时中止后台请求、保留作业，业务回复不等后台。
- 整理器没有工具，不重放业务工具。新启用时只从当前范围开始，不回顾全部历史。

用户的显式修改、文件手改和版本冲突始终优先于后台整理。

## 主会话的历史搜索

`session_search` 和 `session_history_read` 只在主会话有，范围是本机器人的私聊和真实的同机器人派生 Task；普通 Task 只能用 `task_history_read` 读自己。先授权再匹配（中文、路径、关键词、时间），分页只统计可见命中；补读时重新检查来源。索引存在 Harness 会话文档里，可以重建（`history-search.mjs`）。

## 学成 Skill

被成功证据验证过的方法，可以由宿主的专用接口生成一个只属于本机器人的 Skill（`skill-learning.mjs`）：

- 先按 methodKey 和 hash 找已有 Skill，同一方法复用并升版本；manifest、`SKILL.md`、references 走现有导入校验，内容哈希不可变。
- 不改内置、手写或第三方导入的 Skill，不生成脚本或依赖；所需工具由成功证据推导，不超过本机器人当前能力。
- 发布后给所属机器人登记一个普通 Skill 开关，不覆盖用户的禁用；按需激活，不全量注入。用户回退后，后台不能自动覆盖。

## 源码入口

[memory-files.mjs](../../my-app/server/memory-files.mjs) · [bot-memory.mjs](../../my-app/server/bot-memory.mjs) · [bot-memory-runtime.mjs](../../my-app/server/bot-memory-runtime.mjs) · [memory-tools.mjs](../../my-app/server/memory-tools.mjs) · [memory-learning-queue.mjs](../../my-app/server/memory-learning-queue.mjs) · [memory-evidence.mjs](../../my-app/server/memory-evidence.mjs) · [history-search.mjs](../../my-app/server/history-search.mjs) · [skill-learning.mjs](../../my-app/server/skill-learning.mjs)

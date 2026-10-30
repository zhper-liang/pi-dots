# 第二轮：每 Bot 文件式记忆、共享范围、旧记忆迁移与回滚

> **2026-10-30 用户验收通过**，移入 done；以下正文保留当时的记录。

> 状态：**2026-10-30 用户授权开工**，§8 已答复；按票派子 agent 实施，主管协调与验收。依据：[MEM-01](../../backlog/2026-10-29-workspace-experience.md#mem-01--p2--文件式记忆与每-bot-工作目录)、[第一轮分票](../2026-10-30-workspace-experience-r1/PLAN.md)、T11 现有实现（2026-10-30 源码快照，行号以当时为准）。
>
> 约束：一个 Node 进程、一个 SQLite、一个 Harness；不加依赖、不加审批或确认步骤、不扩展 TaskDigest/主会话摘要；不碰正式库与 `.env`。

## 1. 结论

- 三个文件对应现有三类文档：每 Bot 的 `PROFILE.md`（人格）和 `MEMORY.md`（Bot 记忆），全局的 `shared/USER.md`（共享偏好）。
- 文件是内容真源，用户可以用任意编辑器改。现有 Harness Document 改作台账，继续保存版本、修订历史、来源、防复活标记、幂等回执和提取水位。
- Pidot 只在一个对账函数里碰文件：发现手改就三方合并成一次修订写进台账；台账有新版本就原子写回文件。
- 注入、后台提取、来源复核、凭证过滤仍读台账，代码基本不动。对账保证读之前台账已追上文件。
- 迁移只新增文件和一类小台账文档，不改旧 Document。回滚是一个开关：关掉时先把未同步的手改导入台账，之后行为与 R2 前相同。

## 2. 现状（T11 实现）

### 2.1 持久化：`my-app/server/bot-memory.mjs`

全部是 `defineDocFamily` 的 session 文档（L6–13），键为 `target(botId, kind)`（L31）；`preferences` 的键不含 botId，HTTP 层用 `'chief'` 占位。

| 文档 | 形状 | 用途 |
|---|---|---|
| `pidot.bot-memory.document` | `{ version, updatedAt, content, items[{ id, content, sourceEntries[{taskId, entryId}], createdAt, updatedAt }], sourceEntries }` | 人格用 `content`，记忆/偏好用 `items` |
| `pidot.bot-memory.status` | `{ state: 'ready'\|'pending', code, updatedAt }` | 待处理/失败代码，闭合词表 |
| `pidot.bot-memory.revision` | `{ record: { kind, botId?, ...整份文档, actor, changes } }`，键 `hash([key, version])` | 每个版本的全量快照，`history()` 分页读 |
| `pidot.bot-memory.request` | `{ record: { signature, outcome } }` | requestId 幂等回执 |
| `pidot.bot-memory.suppressed-source` | `{ blocked }`，键为来源哈希 | 用户纠正/删除后，同一旧来源不能再被提取 |

服务入口 `createBotMemoryService()`（L59）：`mutate()`（L111，CAS、凭证拒绝、限额、防复活）、`history()`（L212）、`rebaseCandidate()`（L225，只对 preferences）、`markPending()`、`memoryContext()`。另有 `applyMemoryCandidateWithRetry()`（L259，有界重读合并）和 `buildMemoryContext()`（L272，有界、带来源编号的注入文本）。限额 `BOT_MEMORY_LIMITS`（L15）：单条 2048 字、人格 8192、64 条、全文 16384、输入 64KB。

### 2.2 装配与读写入口：`my-app/server/tasks.mjs`

- `getMemorySecrets()`（L1041）：每次实时读模型 key 与 API token。
- `readMemoryEntry()`（L1597）：来源复核，只认本 Bot 已消费的认证用户私聊 Entry；Task 终止/取消、Bot 停用、撤权都返回 null。
- `ensureMemoryPersonality()`（L1619）：人格版本为 0 时用旧 `bot.description` 种入一次（`requestId: 'legacy-personality-seed'`），启动时对全部 Bot 执行。
- `liveMemoryContext()`（L1629）：逐条复核来源后调用 `buildMemoryContext()`。
- `memoryTransaction()`（L1643）、`assertMemoryBot()`、`finishMemoryEdit()`。
- 对外：`getBotMemory` / `editBotMemory` / `getPreferences` / `editPreferences`（L2327–2346）；HTTP 路由在 `app.mjs` L193–202（`/api/bots/:id/memory`、`/api/settings/preferences`），`registerMemorySecrets`（L88）。

### 2.3 注入

`guardedModelReply`（tasks.mjs L1108–1116）在每次模型调用前开一个 `harness.commit`，检查取消和 Bot 状态后调用 `injectMemoryContext()`（`task-context.mjs` L230）。后者按上下文余量算出上限（最多 6000 字），把记忆文本追加到 systemPrompt 末尾，排在目标、规则、Skill 之后。人格因此每次调用实时生效，旧 TaskCard 不改写。

### 2.4 后台提取：`my-app/server/bot-memory-runtime.mjs`

`createBotMemoryRuntime()`（L42）：空闲约 30 秒批处理，无工具 schema，独立日额度（`MEMORY_RUNTIME_LIMITS` L8：20 次、120000 token），状态存 `pidot.memory-extraction`（L6，`jobs[taskId].cursor` 为水位）。来源门槛 `memorySourceAllowed()`（L14），输出校验 `parseMemoryExtraction()`（L20，必须在来源原文中出现、拒绝日程和凭证）。候选通过 `applyMemoryCandidateWithRetry()` 写入，actor 为 `candidate`。装配在 tasks.mjs L2283–2322（`gatherMemory`、`validateMemoryBatch`、`subscribeCommits` 触发）。生产 `index.mjs` 用 `memoryOptions: { enabled: true }` 开启，测试默认关闭。

### 2.5 前端与测试

- 前端：`BotMemory.tsx`（Bot 详情“记忆”标签）、`UserPreferences.tsx`（设置页）、`MemoryDocuments.tsx`（逐条纠正/删除、历史、来源）、`memory-api.mjs`、`useMemoryResource.ts`、`memory-helpers.mjs`。界面只支持人格整体设置和已有条目的更新/删除，不支持手动新增条目。
- 测试：`bot-memory.test.mjs`、`bot-memory-security.test.mjs`、`bot-memory-runtime.test.mjs`、`bot-memory-http.test.mjs`、`src/memory-ui.test.mjs`、`src/memory-api.integration.test.mjs`。
- 文档：ADR-017、`docs/architecture/agent-runtime.md#实时三文档记忆t11`、`docs/interfaces/http-api.md#bot-人格记忆与共享偏好`。

### 2.6 迁移必须保住的现有保证

1. 人格只由用户改，candidate 不能写人格。
2. 记忆和偏好条目必须带来源；R2 要为“手写条目”放宽这一点（§8 Q4）。
3. 用户纠正或删除带来源的条目时，把旧来源写进 SuppressedSources，之后提取不能复活。R2 只对界面编辑保留这一点，文件手改不防复活（§8 Q5）。
4. CAS 用 `expectedVersion`，requestId 幂等，同一 requestId 换内容返回 409。
5. 写入拒绝凭证，读取脱敏，注入跳过含凭证条目。文件导入不因含密钥拒绝（§8 Q7），读取脱敏和注入过滤不变。
6. 注入时逐条复核来源：会话删除、Bot 停用、撤权后，对应条目不注入。
7. 现成的原子写模式：`external-mcp.mjs` L80–100（临时文件 + fsync + rename + 目录 fsync，`O_NOFOLLOW` 读，权限检查）；数据目录约定 `join(dirname(file), ...)`（index.mjs L21、L23）。

## 3. 目标设计

### 3.1 目录

```text
<数据目录>/bot-workspaces/          # 与 PIDOT_DB_PATH 同目录，和 skills/、external-mcp/ 并列
  shared/USER.md                    # 共享偏好
  bots/<botId>/PROFILE.md           # 人格
  bots/<botId>/MEMORY.md            # Bot 记忆
```

- 目录权限 0700，文件 0600。botId 沿用现有 ID 校验，不跟随符号链接。Bot 改名不移动目录。
- 首次写入时才建目录，空 Bot 不产生文件。
- 本轮只有这三个文件。每日记录 `memory/YYYY-MM-DD.md`、`files/`、`shared/knowledge/` 不做（§8 Q2）。

### 3.2 文件格式

**PROFILE.md**：整份文本就是人格，上限 8192 字。空文件等于清空人格。

**MEMORY.md / USER.md**：

```markdown
<!-- pidot: 每行“- ”开头是一条记忆；行尾注释是编号，用来保留来源，可以不写 -->
- 回答用中文，先给结论 <!-- id:auto-3f9a… -->
- 我在杭州工作 <!-- id:auto-77c1… -->
- 这是我手写的一条
```

- 一条一行，以 `- ` 开头；续行缩进两个空格。标题、空行、`<!-- pidot` 注释忽略；其他非空行也当作一条。
- 没有编号的行，编号由内容哈希得出（`file-<hash>`）。Pidot 不往用户刚保存的文件里回填编号。
- 来源不写进文件，只在台账和界面里显示。
- 限额沿用 `BOT_MEMORY_LIMITS`。写回结果是确定的：同一台账版本总是写出相同字节，按 `createdAt`、`id` 排序。

### 3.3 台账新增一类文档

`pidot.bot-memory.file`，每个 target 一份，键与现有 `target()` 相同：

```js
{ renderedVersion: 0, renderedHash: null, syncedAt: null, state: 'synced' | 'rejected', code: null }
```

现有 Documents、Revisions 等五类文档的形状和 `version: 1` 都不变，旧代码会忽略这类新文档。

## 4. 文件与台账的一致性

### 4.1 唯一入口：`reconcile(target)`

每个 target 在进程内有一个串行队列。所有文件读写都只经过这个函数：

1. 读文件（`O_NOFOLLOW`，有大小上限），算哈希 `h`。文件不存在时按“空且未改”处理。
2. **`h ≠ renderedHash` 说明文件被手改了。**
   - base 取 `renderedVersion` 那一版的修订（版本 0 时为空），theirs 是解析后的文件，按 id 比出用户补丁（新增、修改、删除）。
   - 补丁走现有 `mutate()`，actor 为 `file`，基于台账当前版本提交。requestId 为 `file-<target>-<h>`，崩溃后重放不会重复。
   - base 之后台账也改过的条目（例如提取刚加的）保留；同一 id 两边都改时以文件为准。
   - 文件超出 `BOT_MEMORY_LIMITS` 或无法解析时：`state='rejected'`，`code` 为 `MEMORY_FILE_TOO_LONG` 或 `MEMORY_FILE_INVALID`，文件和台账都不动。注入时这个文件只给 Agent 一行提示（例如“MEMORY.md 过长，本次未提供，请让用户精简”），不给内容，也不退回上一个版本（§8 Q7）。含密钥不算失败。同一个 `h` 不重复校验，用户改好后下一次对账自动恢复。
3. **台账版本大于 `renderedVersion` 时写回文件**：把该版本写进临时文件并 fsync，rename 前再读一次哈希。如果已经不等于第 1/2 步确认过的值（用户恰好又保存了），放弃这次写回，回到第 1 步，最多重试 `mergeAttempts`（3）次。之后 rename 并对目录 fsync。
4. 提交 file 台账：`renderedVersion`、`renderedHash`、`syncedAt`。

崩溃恢复不需要额外状态。崩在第 2 步提交之后：重启时文件哈希仍不等于 `renderedHash`，用同一 requestId 重放，结果是幂等的。崩在 rename 前：台账版本仍大于 `renderedVersion`，重新写回。崩在 rename 后、第 4 步前：文件就是台账版本的渲染结果，第 2 步解析后 diff 为空，补登哈希即可。

### 4.2 何时对账

- 启动时，在 HTTP 监听和提取 worker 启动之前，对全部 target 对账一次。
- 每次模型调用注入前（只对账本 Bot 的两个文件和 USER.md），以及记忆的 GET/编辑请求之前。
- `harness.subscribeCommits` 看到 `pidot.bot-memory.document` 变化时，安排写回。提取、种子人格、界面编辑不必各写一遍。
- `close()` 时再对账一次。

不用 `fs.watch`：读之前对账已经够用，文件很小，每次多一次 stat 和 read。

### 4.3 谁写、写什么

| 写入者 | 路径 | 台账 actor |
|---|---|---|
| 用户在界面编辑 | HTTP → 对账 → `mutate()` → 订阅写回 | `user`（不变） |
| 用户手改文件 | 下次对账时导入 | `file`（新增） |
| 后台提取 | `applyMemoryCandidateWithRetry()` → 订阅写回 | `candidate`（不变） |
| 旧职责种子人格 | `ensureMemoryPersonality()` → 订阅写回 | `user`（不变） |
| 模型/Agent | 无。本轮不给记忆文件工具（§8 Q8） | 无 |

### 4.4 并发与冲突

- **界面编辑和手改**：编辑前先对账。手改会把版本推高，界面带的 `expectedVersion` 就会触发现有的 409，界面重新读取。手改不会丢。
- **手改和后台提取**：写回前比对哈希，发现手改就先按 4.1 第 2 步三方合并导入，再写回。两边不同的条目都保留，同 id 以用户为准。`rebaseCandidate()` 从只支持 preferences 扩展到 memory，避免手改让整批提取作废。
- **编辑器旧缓冲**：用户在 Pidot 写回之后，又用打开很久的旧缓冲保存，这时新加的条目会被当成删除。这是已知限制：修订历史能找回，多数编辑器也会提示文件已在外部改动。本轮不做启发式判断，只写进文档。
- 只有一个 Node 进程写这些文件，不需要跨进程锁。

### 4.5 `file` actor 的语义

- 权限与 `user` 相同，可以改人格。不做凭证拒绝（§8 Q7），注入时沿用现有的凭证过滤。
- 修改或删除带来源的条目时**不**写 SuppressedSources，只改内容（§8 Q5）。后果：同一来源以后被重新处理时，删掉的条目可能被再次提取。界面编辑的防复活不变。
- 新增条目可以不带来源（§8 Q4），注入时标为“手写”，来源复核对空来源直接通过。
- 修订记录写 `actor: 'file'`，界面历史显示“文件修改”。
- 一次导入的补丁数不另设上限，只受条目数上限（64 条）约束，避免一次粘贴十几行就整份失效。

## 5. 共享范围

| 范围 | 读（注入） | 写 |
|---|---|---|
| `bots/<id>/PROFILE.md` | 只注入该 Bot | 只有用户（界面或手改） |
| `bots/<id>/MEMORY.md` | 只注入该 Bot，其他 Bot 和 Chief 都读不到，API 也不跨 Bot 返回 | 用户；该 Bot 自己认证私聊的后台提取 |
| `shared/USER.md` | 注入全部 active Bot（与现状一致） | 用户；任一 Bot 认证私聊中明确的偏好表述，由后台提取写入（§8 Q3） |

- 没有 Bot 之间互相共享，也没有“记忆管理员”。
- 把私有条目改成共享：用户把这一行从 MEMORY.md 剪到 USER.md。原处算删除（旧来源防复活），新处算手写条目，原来源只留在历史里。
- 群聊、委派、定时任务、外部资料不进入这套记忆，现有 `memorySourceAllowed()` 不变。
- Bot 停用后目录保留，私有文件不再注入，它贡献的共享偏好按现有来源复核跳过。
- 记忆目录不在任何 Agent 可访问的工作区或 Skill 路径下。

## 6. 迁移与回滚

### 6.1 开关

`openTaskStore({ memoryFiles: { root, enabled } })`，生产由 `index.mjs` 读 `PIDOT_MEMORY_FILES` 设置（1 为文件模式，0 为 R2 前的 Document 模式；默认值见 §8 Q6）。测试 store 不传参数时为 0，现有测试不受影响。

### 6.2 首次开启（迁移）

1. 不改旧 Document、修订、防复活标记、回执和提取水位，只新增文件和 file 台账。原库本身就是备份。
2. 对每个 target：台账有内容而文件不存在，就写回文件（renderedVersion 等于当前版本）；完全为空的 target 等第一次写入再建。
3. 文件已经存在但没有 file 台账（例如用户提前手建），按手改处理，以版本 0 为 base 导入。base 为空时只会产生新增，台账原有条目不会被当成删除。
4. 迁移本身就是 4.1 的对账，可以重复执行。第二次启动不写任何文件（mtime 不变）。
5. 启动日志只输出 target 数量与状态计数，不输出路径和内容。

### 6.3 回滚

**开关回滚（推荐）**：设 `PIDOT_MEMORY_FILES=0` 后重启。
- 启动时，对每个 file 台账存在且文件哈希不等于 `renderedHash` 的 target 只执行一次导入（4.1 第 2 步），把未同步的手改收进台账。之后不再读写文件。
- 此后注入、提取、界面都只用台账，行为与 R2 前一致。文件留在磁盘上不删。

**代码回滚**（回到 R2 前的提交）：旧代码只读 Document。只要关停前做过 `close()` 对账，Document 里就有截至关停时的全部内容。旧代码会忽略 file 台账和 `actor: 'file'` 的修订字段。已知限制：旧界面不能更新无来源的手写条目（旧 `sources()` 要求至少一个来源），只能删除。

**回滚后再开启**：等于一次普通对账。如果关闭期间文件没动，就用台账新版本写回；如果关闭期间文件也被手改过，以最后写回的版本为 base 三方合并，同 id 以文件为准。不需要另存冲突副本。

### 6.4 回滚为什么是真的

- 台账始终包含文件的全部有效内容，因为任何读取都先对账。所以关闭开关不丢数据。
- 迁移不改写旧文档，所以代码回滚后看到的是同一套版本链，只多了 R2 期间的新修订。
- 验收里用真实的“开 → 写 → 手改 → 关 → 读 → 再开”流程测试，并用 R2 前的提交跑一次旧代码读新库（R2-01、R2-05）。

## 7. 工作票

通用派发约束沿用[第一轮](../2026-10-30-workspace-experience-r1/PLAN.md#通用派发约束)：只改自己的独占文件，公共入口（tasks/index/app）由集成负责人接线；不访问 `.env`、正式 data；不装依赖、不提交。依赖关系为 01 → 02、03 并行 → 04 → 05 → 06 → 07 → 08。

### R2-01 基线、契约与回滚可行性

**负责人：集成负责人；复杂度 S；依赖：§8 已答复；来源：MEM-01。**

**交付**：记录当前 test/lint/build 计数；按 §8 的答复冻结文件格式、错误码（`MEMORY_FILE_REJECTED`、`MEMORY_FILE_UNAVAILABLE` 等）和 `memoryFiles` 选项签名；从 `bot-memory.mjs` 导出 `validId`、`target`，供 02/04 复用；用 R2 前的提交读一份带 file 台账和 `actor:'file'` 修订的临时库，确认旧代码能正常读写。起草 ADR-019（替代 ADR-017 中“记忆存 Document”的部分；ADR-018 已用于外部 MCP 直接执行），验收后再写进 docs。

**独占范围**：新增 `plans/active/r2-file-memory/CONTRACTS.md`；`bot-memory.mjs` 仅限导出改动。

**不做**：不写业务逻辑。

**验收**：02/03 拿到签名可以开工；旧代码读新库的结论有实测记录。

### R2-02 文件格式：解析、写回、比对

**负责人：格式 Worker；复杂度 S；依赖：01。**

**交付**：纯函数 `parseMemoryFile(kind, text)`、`renderMemoryFile(kind, document)`、`diffMemoryFile(base, theirs)`，后者输出 `mutate()` 可用的补丁数组。不做 I/O。

**独占范围**：新增 `my-app/server/memory-file-format.mjs`、`memory-file-format.test.mjs`。

**复用**：`BOT_MEMORY_LIMITS` 与 01 导出的 `validId`，不另写一套限额。

**不做**：不支持多文件、富 Markdown、front-matter；写回不给手写行补编号。

**验收**：写回再解析与台账一致（多行、中文、首尾空白、空文件、只有注释）；手写行编号稳定；改错或重复的编号有确定处理；超限返回现有错误码；同一版本写出的字节相同。

### R2-03 文件存储

**负责人：存储 Worker；复杂度 S；依赖：01。**

**交付**：`createMemoryFileStore({ root })`，提供 `read(target) → { text, hash } | null` 和 `write(target, text, { expectedHash })`。写入用临时文件 + fsync + 写前哈希复核 + rename + 目录 fsync；目录 0700、文件 0600；用 `O_NOFOLLOW` 和 lstat 拒绝符号链接与非普通文件；有大小上限。

**独占范围**：新增 `my-app/server/memory-file-store.mjs`、`memory-file-store.test.mjs`。

**复用**：照 `external-mcp.mjs` L80–100 和 `model-settings.mjs` 的写法，不修改这两个文件。

**不做**：不做 fs.watch、跨进程锁、备份轮转。

**验收**：`..`、符号链接（含父目录）、非法 botId、超大文件、权限过宽、磁盘满（模拟）都有可诊断错误，且不留半个文件；`expectedHash` 不符时不覆盖。

### R2-04 对账与台账

**负责人：记忆 Worker；复杂度 M；依赖：02、03。**

**交付**
1. `createMemoryFiles({ store, service, transaction, getSecrets })`，提供 `reconcile(target)`、`reconcileBot(botId)`、`reconcileAll()`、`schedule(target)`、`status(target)`、`close()`，按 §4.1 实现，每个 target 一个串行队列。
2. 新文档 `pidot.bot-memory.file`（§3.3）。
3. `bot-memory.mjs` 的最小改动：新增 `file` actor（§4.5，多补丁、可改人格、不防复活、不做凭证拒绝）；user/file 对无来源条目可以修改；`rebaseCandidate()` 扩展到 memory；`buildMemoryContext()` 对空来源显示“手写”，对 rejected 的文件只输出一行提示。

**独占范围**：新增 `my-app/server/memory-files.mjs`、`memory-files.test.mjs`、`memory-files-concurrency.test.mjs`；`bot-memory.mjs`（仅上述改动）、`bot-memory.test.mjs`（只加用例）。

**复用**：`mutate()` 的 CAS、凭证拒绝、限额和防复活；`applyMemoryCandidateWithRetry()`；`history()` 读 base 修订。

**不做**：不改 `bot-memory-runtime.mjs` 的提取逻辑，不改注入格式里除“手写”和 rejected 提示外的内容，不新增 Status 词表之外的模型可见文本。

**验收**：§9 中“手改”“并发”“过长与无法解析”“崩溃”四组用例在单元层全部通过；现有 `bot-memory*.test.mjs` 不改断言且全部通过。

### R2-05 开关、迁移与回滚

**负责人：记忆 Worker（与 04 同一人，接着做）；复杂度 M；依赖：04。**

**交付**：`enabled` 的两种启动路径（§6.2、§6.3）；关闭模式下的一次性导入；崩溃夹具，在“导入提交后”“rename 前”“rename 后、台账提交前”三处 kill 子进程再重启。

**独占范围**：新增 `my-app/server/memory-files-migration.mjs`、`memory-files-migration.test.mjs`、`server/fixtures/memory-files-process.mjs`。

**复用**：现有 `server/fixtures/*-process.mjs` 的子进程写法和临时库模式。

**不做**：不删除或改写旧 Document，不导出 JSON 备份，不做正式库演练。

**验收**：迁移前后旧五类文档的快照逐字节相同；重复启动不写文件；“开 → 写 → 手改 → 关 → 读 → 再开”无丢失；关闭模式下 `get()`/`memoryContext()` 与 R2 前的输出一致；三处崩溃点重启后文件与台账一致，没有重复修订。

### R2-06 公共接线

**负责人：集成负责人；复杂度 M；依赖：05。**

**交付**
- `tasks.mjs`：`openTaskStore` 装配 `memoryFiles`；`guardedModelReply` 在注入 commit 之前调用 `reconcileBot`；`getBotMemory`/`editBotMemory`/`getPreferences`/`editPreferences` 先对账；`subscribeCommits` 遇到 `pidot.bot-memory.document` 变化时调用 `schedule`；`close()` 中最后一次对账。
- `index.mjs`：`root = join(dirname(file), 'bot-workspaces')`，读取开关。
- `app.mjs`：记忆 GET 响应增加 `file: { path（相对数据目录）, state, code, syncedAt }`，不新增端点。

**独占范围**：`tasks.mjs`、`index.mjs`、`app.mjs` 的上述位置；`bot-memory-runtime.test.mjs`、`bot-memory-http.test.mjs` 只加用例。

**不做**：不改 `policy.mjs`、工具列表、模型循环。

**验收**：端到端用例：手改 MEMORY.md 后，下一条消息的 systemPrompt 含新内容；后台提取的新条目出现在文件里；界面编辑与手改冲突时返回 409，手改保留；Bot A 的文件内容不出现在 Bot B 的注入里；会话删除后，该会话来源的条目不注入（沿用 R1-03 的过滤）。

### R2-07 记忆页显示文件状态

**负责人：前端 Worker；复杂度 S；依赖：06。**

**交付**：`BotMemory`、`UserPreferences` 显示文件位置（相对路径）、最近同步时间和 rejected 原因（中文，不含内部细节）；历史里区分“文件修改”和“手写”；保留现有逐条编辑。

**独占范围**：`my-app/src/BotMemory.tsx`、`UserPreferences.tsx`、`MemoryDocuments.tsx`、`memory-types.ts`、`memory-helpers.mjs`、`memory-helpers.d.mts`、`memory.css`、`memory-ui.test.mjs`。

**不做**：不做文件树、整文件编辑器、上传；不在页面外显示路径。

**验收**：在 1440 和 375 宽度下实际打开页面操作；rejected 状态可见，修好文件后自动恢复；没有新增复选框或确认弹窗。

### R2-08 总回归与验收材料

**负责人：集成负责人；复杂度 S；依赖：07。**

**交付**：`pnpm test`、`pnpm lint`、`pnpm build` 的实际计数；更新 `agent-runtime.md`、`http-api.md`、`docs/engineering/operations.md`（开关与回滚步骤）、ADR-019；逐票完成表和未验项清单（真实编辑器旧缓冲、真实磁盘满不验）。

**验收**：§9 全部通过或如实列为未通过。

## 8. 已确认（2026-10-30 用户答复）

| # | 问题 | 结论 | 说明 |
|---|---|---|---|
| Q1 | 文件放哪 | 数据目录下 `bot-workspaces/`，与库同目录 | 推荐默认 |
| Q2 | 本轮包含哪些文件 | 只有 PROFILE、MEMORY、USER 三个 | 推荐默认 |
| Q3 | 共享偏好谁来写 | 保持现状：用户 + 后台从认证私聊提取 | 推荐默认 |
| Q4 | 手写条目没有对话来源 | 允许，标为“手写” | 推荐默认 |
| Q5 | 在文件里删除或改写带来源的条目 | 只改内容，不防复活 | 用户改选；界面删除仍防复活 |
| Q6 | 验收后默认开启吗 | 开启，`PIDOT_MEMORY_FILES=0` 可回滚 | 推荐默认 |
| Q7 | 文件含密钥或超限 | 含密钥不处理，照常导入；超限或无法解析时 Agent 收到一行提示，不给文件内容 | 用户原话：“密钥无所谓。过长给agent一条提示文件过长然后不给他” |
| Q8 | 给 Bot 读写记忆文件的工具吗 | 不给，只靠后台提取 | 未单独答复，按推荐默认 |
| Q9 | 界面编辑方式 | 保留逐条编辑，加文件位置和同步状态 | 未单独答复，按推荐默认 |
| Q10 | 停用 Bot 的目录 | 保留，不注入、不提取 | 未单独答复，按推荐默认 |

“超限”指 `BOT_MEMORY_LIMITS`。注入时按上下文余量截断（最多 6000 字）的现有行为不变。

## 9. 总验收

- **迁移**：已有 Bot 的人格、记忆和共享偏好生成对应文件，解析后与台账一致；旧五类文档快照不变；重复启动不改文件。
- **手改**：用编辑器修改、新增、删除，下一次模型调用就生效；历史里有 `actor: file` 的修订。
- **并发**：界面与手改冲突时返回 409，手改不丢；手改与提取同时发生时两边都保留，同 id 以用户为准；写回前文件刚被改动时不覆盖。
- **崩溃**：三处崩溃点重启后一致，没有重复修订，没有半个文件。
- **过长与无法解析**：文件超限或非法编码时原文件不动，Agent 只收到一行提示、拿不到该文件内容，页面显示原因；改好后自动恢复。含 key 的文件照常导入。
- **隔离**：Bot 之间互不注入；路径逃逸、符号链接、非法 botId 被拒绝；权限为 0700/0600。
- **回滚**：关闭开关前的手改会被导入；关闭后行为与 R2 前一致；再开启时三方合并；R2 前的代码能读新库。
- **回归**：现有 `bot-memory*.test.mjs` 全部通过且不改断言；test/lint/build 如实报告；页面在 1440/375 下实际操作过。

## 10. 不做

每日记录、`files/`、`shared/knowledge/`、检索索引或向量化、Agent 记忆工具、`fs.watch`、跨进程锁、新依赖、新的审批或确认步骤、TaskDigest 或主会话摘要的扩展、Google 接入。

# R2 契约（R2-01 冻结）

> 依据 [README](README.md) §3–§8 与 2026-10-30 用户答复。本文是 02–07 的接口真源；与 README 冲突处以本文为准，偏差集中列在 §14。

## 1. 基线（开工前，`my-app/` 下实测）

| 命令 | 结果 |
|---|---|
| `pnpm test` | 1395 tests，1395 pass，0 fail，exit 0（约 40 s） |
| `pnpm lint` | exit 0，13 条既有 React warning |
| `pnpm build` | exit 0，既有 chunk 体积提示 |

## 2. 开关与选项

```js
openTaskStore({ file, ..., memoryFiles: { enabled = false, root = join(dirname(file), 'bot-workspaces'), hooks } })
```

- `enabled`：`true` 文件模式；`false`（默认，测试 store 不传即为此值）为 R2 前的 Document 模式，只做 §6.3 的一次性导入。
- `root` 必须位于 `dirname(file)` 之内，否则启动抛错。HTTP 里的 `path` 相对 `dirname(file)`。
- `hooks`：仅测试进程内使用的故障注入点（`afterImport`、`beforeRename`、`afterRename`），不经 HTTP 暴露。
- 生产 `index.mjs`：`PIDOT_MEMORY_FILES` 未设或为 `1` 时开启，为 `0` 时关闭，其它值拒绝启动（`配置错误：PIDOT_MEMORY_FILES 只能是 0 或 1。`）。启动日志只输出 target 数与状态计数。

## 3. Target 与路径

target 为 `{ botId, kind }`，`kind ∈ personality | memory | preferences`；台账键沿用 `bot-memory.mjs` 导出的 `target(botId, kind)`（preferences 的键不含 botId，宿主用 `'chief'` 占位）。

| kind | 文件（相对 `root`） | HTTP `path`（相对数据目录） |
|---|---|---|
| personality | `bots/<botId>/PROFILE.md` | `bot-workspaces/bots/<botId>/PROFILE.md` |
| memory | `bots/<botId>/MEMORY.md` | `bot-workspaces/bots/<botId>/MEMORY.md` |
| preferences | `shared/USER.md` | `bot-workspaces/shared/USER.md` |

- botId 用导出的 `validId` 校验，另外拒绝 `.`、`..`；路径用 `/` 分隔，与平台无关。
- 目录 0700、文件 0600。读取时发现权限过宽且属本用户，就收紧到 0700/0600 再继续；收紧失败按 `MEMORY_FILE_UNAVAILABLE`。
- 任一路径分量（含 `root`）是符号链接或不是目录、文件不是普通文件：`MEMORY_FILE_UNAVAILABLE`。
- 台账有内容才建目录和文件；空 Bot 不产生文件。

## 4. 文件格式（R2-02）

编码 UTF-8（严格解码，非法字节为 `MEMORY_FILE_INVALID`），读入时去掉 BOM、`\r\n`/`\r` 统一为 `\n`。超过 256 KiB 的文件不解析，直接 `MEMORY_FILE_TOO_LONG`。

**PROFILE.md**：整份文本 `trim()` 后就是人格；空文件或只有空白等于清空人格。超过 `personalityChars`（8192）为 `MEMORY_FILE_TOO_LONG`。写回为 `content + '\n'`，人格为空时写空文件。

**MEMORY.md / USER.md**：

```markdown
<!-- pidot: 每行“- ”开头是一条记忆；续行缩进两个空格；行尾 id 注释用来保留来源，可以不写 -->
- 回答用中文，先给结论 <!-- id:auto-3f9a… -->
- 我在杭州工作
  第二行是续行
```

解析规则（确定性）：
1. 在条目内，以两个空格或一个 Tab 开头的行是续行（去掉这层缩进）；空行先挂起，后面跟着续行才算条目内的空行，否则结束条目。
2. 不在续行里时：空行、`#` 开头的标题、整行 `<!-- … -->` 注释忽略；`- ` 开头（或单独一个 `-`）开始新条目；其它非空行也各算一条。
3. 条目文本末尾的 `<!-- id:<id> -->` 是编号，剥掉后 `trim()` 得到内容；内容为空的条目丢弃。编号不合法（`validId` 不通过）时剥掉注释并当作没写。
4. 没写编号：`file-` + sha256(内容) 前 32 位十六进制。Pidot 不往文件里回填编号。
5. 重复编号：内容相同的后一条丢弃；内容不同的后一条改用内容派生编号，再冲突时依次加 `-2`、`-3`…。
6. 限额沿用 `BOT_MEMORY_LIMITS`：超过 64 条、单条超过 2048 字、全文超过 16384 字，都是 `MEMORY_FILE_TOO_LONG`。含密钥不算失败。

写回：注释头一行 + 按 `createdAt`、`id` 升序每条一项；首行 `- ` 起，后续行加两个空格缩进（内部空行写成空行）；编号等于内容派生值、且内容最后一行不以 `-->` 结尾时省略注释，否则在最后一行追加 ` <!-- id:<id> -->`。同一台账版本总是写出相同字节。写回会丢弃用户加的标题、额外注释和行序，统一成上面的形状（只在台账比文件新时发生）。

## 5. 新台账文档（R2-04）

```js
defineDocFamily({ kind: 'pidot.bot-memory.file', scope: 'session', family: true, version: 1,
  initial: () => ({ renderedVersion: 0, renderedHash: null, syncedAt: null, state: 'synced', code: null, rejectedHash: null }) })
```

- 键与 `pidot.bot-memory.document` 相同。只在对账导入、写回或记录拒绝时创建（文件和台账都为空的 target 没有它），Document 模式下从不新建。
- `renderedHash`：文件里已被台账吸收的字节的 sha256。Pidot 写回后是写出字节的哈希；手改被完整吸收时（导入后台账与文件逐条相同）是用户文件的哈希，此时不重写文件。
- `renderedVersion`：与 `renderedHash` 对应的台账版本，也是下一次三方合并的 base。
- `rejectedHash`：被拒绝的那份字节的哈希；同一份字节不重复导入。
- 现有五类文档的形状和 `version: 1` 不变。

## 6. 状态与错误码（闭合词表）

| state | code | 含义 | 注入 |
|---|---|---|---|
| `synced` | `null` | 文件与台账一致（截至 `syncedAt`） | 台账内容 |
| `rejected` | `MEMORY_FILE_TOO_LONG` | 文件超出 `BOT_MEMORY_LIMITS`，或与台账合并后超限 | 只一行提示，不给内容 |
| `rejected` | `MEMORY_FILE_INVALID` | 不是合法 UTF-8 或其它无法解析的情况 | 只一行提示，不给内容 |
| `rejected` | `MEMORY_FILE_UNAVAILABLE` | 符号链接、非普通文件、目录不安全、无权读取、读失败 | 只一行提示，不给内容 |
| `pending` | `MEMORY_FILE_WRITE_FAILED` | 台账比文件新，写回失败（磁盘满、无权写）或 3 次都撞上用户刚保存；下次对账重试 | 台账内容（文件没被手改） |

- rejected 时文件和台账都不动；用户改好文件后下一次对账自动恢复为 `synced`。
- `syncedAt`：最近一次确认文件与台账一致的时间（导入或写回时更新，ISO 字符串）；从未同步过（文件还不存在）为 `null`。
- 内部错误：存储层的 `MEMORY_FILE_CONFLICT`（写前哈希不符）只在对账内部消化，不出现在状态里。

## 7. 对账 `reconcile(target)`（R2-04）

每个 target 一个进程内串行队列；文件只经这里读写。最多 `mergeAttempts`（3）轮：

1. `store.read(target)`：读失败为 `rejected/UNAVAILABLE`（或 `TOO_LONG`），结束。文件不存在按“空且未改”处理。哈希与 `renderedHash` 不同且 mtime 距今不足 `settleMs`（50 ms）时，等一下再读，直到两次读到相同字节（最多 5 次），防止把编辑器原地保存（先截断再写）时的空文件或半个文件当成删除导入。
2. 文件哈希 `h ≠ renderedHash`，且文件存在：
   - `h === rejectedHash` 且仍为 rejected：跳过，结束。
   - 解析失败：`rejected`，记 `rejectedHash = h`，结束。
   - 否则在一个事务里：base = `renderedVersion` 那一版的原始修订（0 为空）；若台账已越过 `renderedVersion` 且其中某一版的渲染哈希等于 `h`（崩在 rename 后、记账前），直接把那一版记为 `renderedVersion`；否则 `diffMemoryFile(base, 文件)` → `importFile()`，requestId 为 `file-` + sha256([key, renderedVersion, h]) 前 59 位。重放同一 requestId 返回原回执，不产生新修订。
   - 合并后超限：`rejected/TOO_LONG`（不记 `rejectedHash`，台账腾出空间后下次对账自动重试），事务整体回滚，台账不动。
   - 导入后台账与文件逐条相同：记 `renderedVersion = 当前版本`、`renderedHash = h`、`synced`，不写文件。
3. 台账版本 > `renderedVersion`，或文件不存在而台账版本 > 0：渲染当前版本（原始数据，不脱敏）→ `store.write(target, bytes, { expectedHash })`，`expectedHash` 是第 1 步读到的哈希（文件不存在为 `null`）。返回冲突就回到第 1 步。
4. 写成功：记 `renderedVersion`（渲染的那一版）、`renderedHash`、`syncedAt`、`synced`。三轮用尽或写失败：`pending/WRITE_FAILED`，台账内容不受影响。

触发：启动（HTTP 监听与提取 worker 启动之前）对全部 target；每次模型调用注入前对本 Bot 的 PROFILE/MEMORY 与 USER；记忆 GET/编辑前；编辑成功后（把写回结果带进响应）；`subscribeCommits` 看到 `pidot.bot-memory.revision` 新建时排队写回；`close()` 时最后一次。

## 8. `file` actor（`bot-memory.mjs`，R2-04）

- 入参：`{ botId, kind, requestId, expectedVersion, action?, content?, patches? }`。人格用 `action: 'set'` + `content`；记忆/偏好用 `patches[{ action: 'add'|'update'|'delete', id, content? }]`，不带 `sourceEntries`。
- 补丁数上限为 `items × 2`（128，一次 diff 最多删 64 条再加 64 条），不另设导入上限；条目数、单条字数、全文字数和输入字节沿用 `BOT_MEMORY_LIMITS`。
- 按“文件为准”宽容应用到台账当前版本：`add` 遇到已有 id 视为改写；`update` 遇到已删 id 视为新增手写；`delete` 遇到不存在的 id 忽略；内容相同的补丁不算改动。改写保留原 `sourceEntries`，新增为 `[]`（手写）。
- 可以改人格；不做凭证拒绝（入参和结果都不扫）；不写 SuppressedSources；修订记 `actor: 'file'`，`changes` 只列实际生效的项。
- 失败时整个事务抛 `TaskInputError` 回滚：不写 Status、不写回执、不建新文档（与 user/candidate 失败时写 pending 不同）。
- 附带改动：user 改写手写条目（原 `sourceEntries` 为空）时可以带 `sourceEntries: []`，保持手写；user 新增仍要求来源。`rebaseCandidate()`/`applyMemoryCandidateWithRetry()` 从只支持 preferences 扩展到 memory。

## 9. 模块签名

```js
// bot-memory.mjs（新增导出）
export const validId = value => boolean
export const target = (botId, kind) => string            // 非法时抛 TaskInputError(400, 'MEMORY_TARGET')
service.ledger(tx, botId, kind, version?) → { version, updatedAt, content, items, sourceEntries } | null   // 原始数据，不脱敏；version 省略取当前，0 为空文档，缺失修订为 null
service.importFile(tx, input) → mutate 结果（actor 'file'）；失败抛 TaskInputError
buildMemoryContext(documents, opts)                      // documents[kind].file 为 §10 的状态；rejected 输出一行提示；空来源标“手写”

// memory-file-format.mjs（纯函数，无 I/O）
export const MEMORY_FILE_NAMES = { personality: 'PROFILE.md', memory: 'MEMORY.md', preferences: 'USER.md' }
export const MEMORY_FILE_MAX_BYTES = 262144
parseMemoryFile(kind, bytes | string) → { ok: true, value: { content } | { items: [{ id, content }] } } | { ok: false, code }
renderMemoryFile(kind, ledgerDoc) → string
diffMemoryFile(kind, base, theirs) → patches            // base/theirs 为 { content } 或 { items: [{ id, content }] }
fileItemId(content) → 'file-<32 hex>'

// memory-file-store.mjs
export class MemoryFileError extends Error { code, reason }   // message 为中文通用句，不含路径
createMemoryFileStore({ root, fs?, hooks? }) → {
  relative(target) → 'bots/<id>/MEMORY.md' | ...,
  read(target) → { bytes, hash, mtimeMs } | null,        // 抛 MemoryFileError: MEMORY_FILE_TOO_LONG | MEMORY_FILE_UNAVAILABLE | MEMORY_TARGET
  write(target, text, { expectedHash }) → { ok: true, hash } | { ok: false, code: 'MEMORY_FILE_CONFLICT' },   // 抛 MEMORY_FILE_WRITE_FAILED | MEMORY_FILE_UNAVAILABLE | MEMORY_FILE_TOO_LONG
}

// memory-files.mjs
export const MemoryFileLedger                            // 'pidot.bot-memory.file'
createMemoryFiles({ store, service, transaction, snapshot, listBots, displayRoot, now, hooks, write = true }) → {
  reconcile(target, { importOnly }?), reconcileBot(botId), reconcileAll(), importPending(),
  schedule(target),                 // 合并同一 target 的连续请求；在订阅回调之外执行
  status(target) → MemoryFileStatus, attach(documents, botId), settled(), summary() → { targets, synced, rejected, pending },
  start(subscribe), close({ reconcile }?),
}
// snapshot(key) = harness.snapshot(MemoryFileLedger, key)：读台账而不建文档；listBots() = BotDirectory 的 id

// memory-files-migration.mjs
openMemoryFiles({ enabled, ...createMemoryFiles 参数 }) → memoryFiles | null   // 关闭时完成一次性导入后返回 null
```

## 10. HTTP 契约（R2-06，供 R2-07）

不新增端点。`GET /api/bots/:id/memory` 的 `personality`、`memory`、`preferences` 三份文档，和 `GET /api/settings/preferences` 的顶层文档，各多一个 `file` 字段；编辑 POST 成功时 `data.document.file` 同样带上（写回后的状态）。

```ts
type MemoryFileStatus = {
  path: string                // 相对数据目录，'/' 分隔，例如 'bot-workspaces/bots/chief/MEMORY.md'
  state: 'synced' | 'rejected' | 'pending'
  code: null | 'MEMORY_FILE_TOO_LONG' | 'MEMORY_FILE_INVALID' | 'MEMORY_FILE_UNAVAILABLE' | 'MEMORY_FILE_WRITE_FAILED'
  syncedAt: string | null     // ISO 时间；文件还没生成过为 null
}
// 文件模式关闭（PIDOT_MEMORY_FILES=0）时 file 为 null。
// MemoryRevision.actor 新增 'file'（文件修改）；MemoryItem.sourceEntries 为 [] 表示手写条目。
```

`GET /api/bots/chief/memory` 示例（`history` 等原有字段不变，只示意新增处）：

```json
{ "data": {
  "personality": { "kind": "personality", "botId": "chief", "version": 2, "updatedAt": "2026-10-30T08:00:00.000Z", "sourceEntries": [],
    "status": { "state": "ready", "code": null, "updatedAt": "2026-10-30T08:00:00.000Z" }, "content": "温暖、直接",
    "file": { "path": "bot-workspaces/bots/chief/PROFILE.md", "state": "synced", "code": null, "syncedAt": "2026-10-30T08:00:00.120Z" } },
  "preferences": { "kind": "preferences", "version": 1, "updatedAt": "2026-10-30T07:00:00.000Z", "sourceEntries": [],
    "status": { "state": "ready", "code": null, "updatedAt": "2026-10-30T07:00:00.000Z" },
    "items": [{ "id": "file-6f1c…", "content": "回答用中文", "sourceEntries": [], "createdAt": "2026-10-30T07:00:00.000Z", "updatedAt": "2026-10-30T07:00:00.000Z" }],
    "file": { "path": "bot-workspaces/shared/USER.md", "state": "synced", "code": null, "syncedAt": "2026-10-30T07:00:00.050Z" } },
  "memory": { "kind": "memory", "botId": "chief", "version": 3, "updatedAt": "2026-10-30T08:10:00.000Z", "sourceEntries": [{ "taskId": 12, "entryId": 40 }],
    "status": { "state": "ready", "code": null, "updatedAt": "2026-10-30T08:10:00.000Z" }, "items": [],
    "file": { "path": "bot-workspaces/bots/chief/MEMORY.md", "state": "rejected", "code": "MEMORY_FILE_TOO_LONG", "syncedAt": "2026-10-30T08:05:00.000Z" } },
  "history": { "personality": [], "memory": [{ "version": 3, "actor": "file", "...": "..." }] },
  "historyNextBeforeVersion": { "personality": null, "memory": null }
} }
```

建议文案（R2-07 定稿）：`TOO_LONG` “文件太长，超出记忆上限；本次没有提供给 Bot。请精简后保存，会自动恢复。”；`INVALID` “文件无法读取（编码不对）；本次没有提供给 Bot。”；`UNAVAILABLE` “文件不可访问（可能是链接或权限问题）；本次没有提供给 Bot。”；`WRITE_FAILED` “最新内容已保存，写入文件失败，稍后自动重试。”

## 11. 注入（`buildMemoryContext`）

- 文件 rejected 时，该文件只出一行，放在前缀之后、其它条目之前，内容按 kind 固定：`文件提示：PROFILE.md（人格）过长，本次未提供，请让用户精简。` / `…无法读取，本次未提供，请让用户检查文件。`（MEMORY.md 为“Bot 记忆”，USER.md 为“共享偏好”）。不含路径、不含文件内容，不退回旧版本。
- 来源为空的条目行尾写 `[手写]`，有来源的仍是 `[taskId/entryId,…]`。来源复核对空来源直接通过。
- 现有截断（按余量最多 6000 字）、凭证过滤、来源复核不变。Document 模式下没有 `file`，输出与 R2 前相同。

## 12. 旧代码读新库（R2-01 实测，2026-10-30）

做法：`/tmp` 下临时 worktree 检出 `9853940`（R2 前），软链 `my-app/node_modules`；临时库，结束后 `git worktree remove` 并确认目录已不存在。

1. R2 代码、文件模式开启：设人格、加有来源的记忆和偏好，再手改 MEMORY.md（改写一条、手写一条）和 PROFILE.md。库里有 5 份 `pidot.bot-memory.file` 台账、2 条 `actor:'file'` 修订。
2. 旧代码打开同一库：`getBotMemory`/`getPreferences` 正常，人格和条目是手改后的内容，历史里 `actor` 为 `file`/`candidate`/`user`，注入正常。改写有来源条目成功；改写手写条目返回 `MEMORY_SOURCE_REQUIRED`（旧界面只能删）；删除手写条目、改人格都成功。旧代码注入手写条目时行尾是 `[]`（R2 为 `[手写]`）。
3. 再用 R2 打开：文件没被手改，台账较新，PROFILE.md 和 MEMORY.md 写回为旧代码改后的内容，状态 `synced`。
4. 对照：同一脚本分别在两套代码的新库上执行（R2 为 `memoryFiles.enabled: false`），去掉时间戳和 `file` 字段后，`getBotMemory`、`getPreferences` 和注入文本完全相同；R2 版没有建 `bot-workspaces/`。

结论：旧代码能正常读写新库；已知限制只有“旧界面不能改写手写条目”和注入里手写条目显示为 `[]`。

## 13. ADR-019 草稿（R2-08 验收后写入 `docs/decisions/README.md`）

```markdown
## ADR-019 每 Bot 文件式记忆，Document 改作台账

采纳日期：待验收（Asia/Shanghai）。依据 2026-10-30 用户答复 R2 §8，替代 ADR-017 中“人格/记忆/偏好只存 Document”的部分；ADR-017 的来源、注入、提取规则不变。

- 内容真源是数据目录下 `bot-workspaces/` 的三个 Markdown 文件：每 Bot 的 `PROFILE.md`、`MEMORY.md`，全局的 `shared/USER.md`。原 Harness Document 继续存版本、修订、来源、防复活、回执和提取水位，另加一类 `pidot.bot-memory.file` 台账。
- 只有一个对账函数读写文件：读取前发现手改就以上次写回版本为 base 三方合并，同 id 以文件为准，记 `actor: 'file'`；台账较新就原子写回（临时文件、fsync、写前哈希复核、rename、目录 fsync）。不用 fs.watch，靠“读之前对账”保证一致。
- 文件手改权限等同界面用户（可改人格），但只改内容：不写防复活标记，含密钥照常导入（读取脱敏、注入过滤不变）。超限、无法解析或不可访问的文件整份不用，Agent 只收到一行提示，不退回旧版本；改好后自动恢复。
- 迁移只新增文件与台账，旧文档逐字节不变。`PIDOT_MEMORY_FILES=0` 回滚：启动时把未同步的手改导入一次，之后行为与 R2 前相同；R2 前的代码能直接读新库。
- 代价：写回会把文件整理成规范格式（丢掉用户加的标题和注释）；编辑器用旧缓冲覆盖会删掉期间新增的条目（修订历史可找回）。
- 凭证检查只扫新写入的内容：已存的内容里有当前 key（手写导入或 key 轮换后）不再挡住提取和界面编辑，读取与注入照常脱敏、过滤。这一点放宽了 ADR-017。
```

## 14. 与 README 的偏差（实现时的决定）

| # | README 原文 | 实现 | 原因 |
|---|---|---|---|
| 1 | state 只有 `synced`/`rejected`；错误码举例 `MEMORY_FILE_REJECTED`、`MEMORY_FILE_UNAVAILABLE` | 加 `pending/MEMORY_FILE_WRITE_FAILED`；rejected 的码为 `TOO_LONG`/`INVALID`/`UNAVAILABLE`；不用 `MEMORY_FILE_REJECTED` | 写回失败时文件没被手改，台账照常注入，不该显示成“被拒绝”；“被拒绝”已由 state 表达 |
| 2 | 台账形状 `{ renderedVersion, renderedHash, syncedAt, state, code }` | 多一个 `rejectedHash` | 落实“同一个 h 不重复校验”；合并后超限不记它，腾出空间后能自动重试 |
| 3 | R2-03“权限过宽”列为可诊断错误 | 属本用户就收紧到 0700/0600 后继续，收紧失败才是 `UNAVAILABLE` | 多数编辑器新建文件是 0644；拒绝只会让用户多一步，目录本身 0700 已挡住他人。2026-10-30 用户确认：改动自己文件的权限没问题 |
| 4 | 用 `history()` 读 base 修订 | 新增 `service.ledger()` 读原始数据 | `history()`/`get()` 会脱敏；Q7 允许文件里有 key，用脱敏数据合并或写回会把 key 换成“[已过滤敏感内容]” |
| 5 | 补丁走 `mutate()` | `file` actor 失败时整个事务回滚，不写 pending Status 和回执 | 失败不能把文件状态写进提取用的 Status，也不能留下失败回执挡住用户改好后的同一份字节 |
| 6 | requestId 为 `file-<target>-<h>` | `file-` + sha256([key, renderedVersion, h]) | 用户回退到某份旧字节时 base 已不同，只用 h 会撞 `MEMORY_REQUEST_CONFLICT` |
| 7 | 导入后写回 | 导入后台账与文件逐条相同就不写，记用户字节的哈希 | 不立刻重排用户刚保存的文件；只在台账真有新内容时写回 |
| 8 | 订阅 `pidot.bot-memory.document` | 订阅 `pidot.bot-memory.revision` 的新建 | document 的键是哈希，取不回 botId/kind；每次内容变化都会新建一条 revision |
| 9 | 只有 GET 带 `file` | 编辑成功的 `data.document` 也带 | `BotMemory.tsx` 编辑后用 `result.document` 整体替换，否则状态会消失 |
| 10 | — | user 改写手写条目时可以带 `sourceEntries: []` | 界面编辑会回传空来源；不放开就不能逐条编辑手写条目（R2-07 要保留逐条编辑）。user 新增仍要求来源 |
| 11 | §5“原处算删除（旧来源防复活）” | 文件里删除不防复活 | 与 Q5 冲突，以用户答复为准 |
| 12 | `createMemoryFiles({ store, service, transaction, getSecrets })` | 见 §9 | 不需要密钥；需要 snapshot（不建文档地读台账）和 listBots |
| 13 | R2-06 改 `app.mjs` 响应 | `app.mjs` 未改 | 路由原样转发 tasks 的投影，`file` 在 `tasks.mjs` 加上即可 |
| 15 | ADR-017：写入后整份文档含当前 key 就拒绝 | 只扫本次输入，不再扫写入后的整份文档 | 2026-10-30 用户要求放开：手写导入或 key 轮换后，已存内容里的 key 会挡住该文档的提取和界面编辑。改了一条既有断言（`bot-memory.test.mjs` 轮换用例里“无关新增也被拒”改为成功） |
| 14 | 对账直接读文件 | 刚改过的文件先等字节稳定再导入（§7 第 1 步） | 压测中复现：后台写回恰好读到被截断的空文件，整份台账被当成删除；真实编辑器原地保存也会这样。截断后停顿超过 `settleMs` 的编辑器仍可能被读到半份，下一次对账会补回，修订历史可找回 |

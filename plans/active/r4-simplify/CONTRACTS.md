# 第四轮服务端与接口契约

R4-01 照本文实现；前端各票只依赖 §6 的接口形状。行号以当前源码为准，下面给的是函数名和文件，找不到时用 `grep` 定位，不要猜。

## 1. 现状事实（基线 `9e4200d`）

1. **授权**：`server/tools.mjs` `toolSets()`：可用工具 = 已安装 ∩ `ToolAccess.assignments[botId].tools` − `revoked[botId]`；资源 = `assignments[botId].resources` + 已启用外部 MCP 的 `mcp:<connectionId>`。`modelVisible()` 按资源决定模型能不能看到工具：模拟日程工具要 `mock:personal`，飞书工具要 `feishu:*`，`workspace.*` 要任一 `workspace:*`。`toolSets()` 有 60 多处调用，**不改它**。
2. **资源快照**都读 `assignments[botId].resources`：`task-creation.mjs`（新 Task 的 `parameters.toolResources`）、`main-session.mjs` `projectMainCard`、`workspace-grants.mjs` `workspaceSourceReadable`；定时任务按自己的 `sourceIds` 收窄。所以"来源跟着工具集"只要把资源写进 `assignments`，读取方都不用改。
3. **可分配资源**：`bot-configuration.mjs` `availableResourceList(tx)` = `supportedResources`（`mock:personal`、`workspace:local`）+ 飞书绑定的 `binding.resource` 与 `workspace:feishu:<hash>` + `externalWorkspaceResources(tx)`（Google 日历和任务列表：`workspace:google-calendar:*`、`workspace:google-tasks:*`）。
4. **资源被撤下**（保持不变）：`feishu-calendar.mjs` `removeAssignedResource`（断开、换绑）；`workspace-feishu.mjs` `dropStaleResources`；`workspace-providers.mjs` `removeResourcesByPrefix`（Google 断开或换号，由 `google-account.mjs` 调用）。
5. **资源出现**（§4.2 要加分发）：`feishu-calendar.mjs` 的 `manage` 里 `bind` 那次提交；`workspace-feishu.mjs` `sync()` 的 `fresh` 分支；`workspace-providers.mjs` `registerExternalSource()`（Google 日历、任务适配器发现来源时调用）。
6. **写入裁决**：`policy.mjs` `decide()` 默认 allow；命中规则就用规则的效果；allow 且全局暂停 → ask。生产里 ask 规则的唯一来源是工具组「先问」：`BotRules.tsx` → `POST /api/bots/:id/tool-groups/:group`（`app.mjs`）→ `tasks.mjs` `switchGroup` → `tool-group-settings.mjs` `switchGroup` → `policy.mjs` `setGroupMode(…, 'ask')`，写入 `origin: 'group'` 的 ask 规则。审批卡「以后直接做」走 `openGroup` → `setGroupMode(…, 'allow')`。测试夹具 `server/fixtures/authorized-task-store.mjs` 开库后用 `addRule` 写 `origin: 'user'` 的 ask 规则来模拟审批场景；生产没有对应入口（`/api/rules` 只有 GET）。
7. **能力**：`capability-assignments.mjs`。`builtinCapabilityCatalog()` 由 `TOOL_GROUPS` 生成 `tool:<groupId>`；Skill 与外部 MCP 目录由 `tasks.mjs` 的 `readCapabilityCatalog(tx, scope)` 提供（`scope` 实际没用到）。`setCapabilityAssignment()` 改 `assignments.tools`、`revoked`、`CapabilityAssignments.skills / bindings`，并写新配置版本和审计。外部 MCP 的 `enabledBotIds` 由 `refreshExternalCatalog()` 从 `bindings` 推导，所以改分配后要调 `syncManagedCatalog()`（`setBotCapabilityAssignment` 已经这样做）。
8. **创建**：`bot-directory.mjs` `parseBotCreation()` 只接受 `name / description / profile / parameters / requestId`，多一个键就 400；`createDirectoryBot()` 用签名做幂等重放，新机器人 `defaults.tools = []`、`toolResources = []`；`bot-configuration.mjs` `createConfiguredBot(tx, parsed, models)` 在目录副本上建，`Object.assign(liveDirectory, directory)` 写回，再写 `assignments`；`tasks.mjs` `createBot()` 在同一事务里 `ensureMainSession`。`chief-management.mjs` 的 `bot_manage create` 也调 `createConfiguredBot`。
9. **开库**：`tasks.mjs` 开库事务里 `if (toolGroupsMigration) migrateToolGroups(…)`，随后 `bots.splice(0, bots.length, ...persisted)` 用持久化目录覆盖内存目录；之后 `ensureMemoryPersonality` 用 `bot.description` 给版本 0 的人格做种子；再 `openMemoryFiles`。用户编辑人格走 store 的 `editBotMemory(botId, input)`（先 reconcile，再 `memoryService.edit`，再 reconcile）。
10. **测试夹具** `authorized-task-store.mjs` 传 `toolGroupsMigration: false`；`r4Migration` 默认 false，所以夹具和普通测试库都不迁移。
11. **前端已知问题**：`SkillControls.tsx` 的 `BotSkills` 没有解包 `{ data }`，机器人页「Skills」tab 一直显示「正在读取」。本轮删除该组件，新组件要解包（§6）。

## 2. 合并工具集（D8）

`server/tool-groups.mjs`：

- 删除 `calendar` 组；它的 9 个工具按原顺序放到 `todos` 组 `tools` 的最前面，`todos` 原有 6 个工具接在后面。
- `todos` 的 id 不变（能力 id 仍是 `tool:todos`，已存的 `CapabilityAssignments.bindings` 不用迁移）。定义上方加一行英文注释：`// 'todos' is the merged 日程与待办 group (ADR-022); its id predates the merge.`
- 文案（`label` 与 `description` 出现在能力目录和 `bot_inspect`）：

| id | label | description |
|---|---|---|
| `skills` | Skills | 加载 Skill 用的工具；开了任一 Skill 时自动带上。 |
| `todos` | 日程与待办 | 查看和整理日程与待办：检查冲突和空档，新建、修改、删除，给事项设提醒和定时任务。 |
| `collaboration` | 机器人协作 | 查看其他机器人，派任务、收结果、验收，共享信息。 |
| `reports` | 进度与阻塞 | 卡住时提问，查看派出去的任务进度。 |
| `history` | 历史与回读 | 回读这个会话的历史、工具结果和 Skill 资料。 |
| `automation` | 自动化控制 | 在对话里一键暂停全部自动化，只在主会话里有。 |
| `capabilities` | 能力配置 | 在对话里添加、更新和停用 MCP 与 Skill。 |
| `bots` | 机器人管理 | 创建、配置和停用机器人，只有 Chief 有。 |

- `ITEM_WRITE_GROUPS = Object.freeze({ Event: 'todos', Todo: 'todos' })`，其余导出不变。
- 文件头注释和 `writeGroupOf` 上的注释里「直接做 / 先问 / 写入确认」的说法改成现状：工具组只有开关，`PolicyRules` 只放规则引擎用的规则（ADR-022）。

## 3. 去掉写入确认（D2）

### 3.1 删除
- `tool-group-settings.mjs`：删 `groupMode`、`validateGroupSwitch`、`switchGroup`；`describeGroups()` 不再接收 `rules`，返回项去掉 `mode`、`switchable`（保留 `id / label / description / enabled / partiallyEnabled / tools / available`）；删掉随之不用的 import。
- `bot-configuration.mjs` `read()`：调用 `describeGroups` 时不再传 `rules`，删掉只为它读的 `PolicyRules`。
- `tasks.mjs`：删 `import { switchGroup } …` 和 store 的 `switchGroup(botId, input)` 方法。
- `app.mjs`：删 `groupSwitchMatch` 那段路由（`/api/bots/:id/tool-groups/:group`），之后该路径落到通用 404。

### 3.2 不动
`policy.mjs` 全部（`decide`、`PolicyRules`、`addRule`、`pickRule`、`setGroupMode`、`openGroup`、`groupRule`、`groupWriteMatches`、`itemTypeOf`）；`approvals.mjs`；全局暂停；无人值守遇 ask 跳过。合并后 `openGroup` 对 Event 和 Todo 都落到 `todos`，行为正确。

### 3.3 模型侧与新规则矛盾的句子（只改这几句，其余提示词不动）

| 文件 | 原文片段 | 改成 |
|---|---|---|
| `feishu-mutation.mjs` | `编辑和删除默认直接执行；日历组关闭或全局暂停时先问，以最终回执为准。` | `编辑和删除直接执行；全局暂停时先问，以最终回执为准。` |
| `main-tools.mjs`（`routine_propose`） | `默认直接创建；规则或全局暂停可能要求确认，遇到确认时以最终回执为准。` | `直接创建；全局暂停时要求确认，以最终回执为准。` |
| 同上 | `运行时按Bot当时的权限和规则：写入默认直接执行，删除默认先问；无人值守遇到先问会跳过并记录。` | `运行时按Bot当时的权限：写入直接执行；全局暂停时无人值守的写入会跳过并记录。` |
| `workspace-tools.mjs`（`workspace.prepare_change`） | `工具组开着时新建、修改和删除都直接执行（含外部来源）；组设为先问、规则或全局暂停可改为询问或拒绝。` | `新建、修改和删除都直接执行（含外部来源）；全局暂停时改为询问。` |
| `workspace-agent-workflows.mjs` | `工具组开着时新建、修改和删除都直接执行，本地自动改动留撤销记录；组设为先问、规则要求先问或自动化已暂停的步骤跳过，并在运行结果中说明需要用户处理。` | `新建、修改和删除都直接执行，本地自动改动留撤销记录；自动化已暂停时这些步骤跳过，并在运行结果中说明需要用户处理。` |
| `task-context.mjs`（飞书提示） | `创建默认直接执行，规则或全局暂停可能要求网页确认` | `创建直接执行，全局暂停时要求网页确认` |
| 同上 | `更新默认直接执行、删除默认先问，须以最终回执为准。` | `更新和删除直接执行，全局暂停时先问，须以最终回执为准。` |
| `tasks.mjs`（Chief 管理提示） | `创建、调整配置和停用默认直接执行；Bot 管理组关闭或全局暂停时要求确认。` | `创建、调整配置和停用直接执行；全局暂停时要求确认。` |
| `main-session.mjs`（`MAIN_SYSTEM_PROMPT`） | `默认直接执行，规则或全局暂停可能要求确认。` | `直接执行，全局暂停时要求确认。` |

改完 `grep -rn "先问\|写入确认\|组关闭\|组设为" server/*.mjs | grep -v test` 只应剩 `policy.mjs` 的内部注释。断言这些原句的测试同步改。

## 4. 来源、Skill 与创建

### 4.1 新模块 `server/resource-sharing.mjs`

```js
import { groupTools } from './tool-groups.mjs'
import { BotDirectory } from './bot-directory.mjs'

// ADR-022: sources follow 日程与待办. A Bot holding any of its tools gets every connected calendar
// and task list, except the ones it was narrowed from in 设置 → 高级 (access.excludedResources).
export const SCHEDULE_GROUP = 'todos'
const SCHEDULE_TOOLS = groupTools(SCHEDULE_GROUP)
export const MOCK_RESOURCE = 'mock:personal'
export const holdsSchedule = (access, botId) => SCHEDULE_TOOLS.some(name => access.assignments[botId]?.tools.includes(name) && !access.revoked?.[botId]?.includes(name))
export function grantResources(access, botId, resources) {
  const excluded = access.excludedResources?.[botId] ?? []
  const assigned = access.assignments[botId]
  assigned.resources = [...new Set([...assigned.resources, ...resources.filter(r => r !== MOCK_RESOURCE && !excluded.includes(r))])]
}
/** A newly connected source reaches every Bot that holds 日程与待办 and was not narrowed from it. */
export async function shareWithBots(tx, resources) {
  const { ToolAccess } = await import('./tools.mjs')
  const access = await tx.doc(ToolAccess), directory = await tx.doc(BotDirectory)
  for (const bot of directory.items) if (access.assignments[bot.id] && holdsSchedule(access, bot.id)) grantResources(access, bot.id, resources)
}
```

`tools.mjs` 用动态 import，避免与 `workspace-providers.mjs` 形成循环引用（`workspace-feishu.mjs` 已有同样写法）。

### 4.2 接入分发（D1、D9）
- `feishu-calendar.mjs` `bind` 那次提交：设好 `d.binding` 之后 `await shareWithBots(tx, [d.binding.resource])`（`removeAssignedResource` 撤旧资源的逻辑不变）。
- `workspace-feishu.mjs` `sync()`：`await dropStaleResources(…)` 之后加 `if (fresh) await shareWithBots(tx, [sourceResource(sourceId)])`。首次连接和重连都分给开着「日程与待办」、没被收窄的机器人；普通重同步（`fresh` 为假）不动分配，收窄得以保持。把 `dropStaleResources` 上方注释里"重连也不恢复旧分配"的说法改成新行为。
- `workspace-providers.mjs` `registerExternalSource()`：写完 `index.items[sourceId]` 后 `await shareWithBots(tx, ['workspace:' + sourceId])`。每次发现都会调用，结果幂等，也不会把收窄掉的加回来。

**模块引用**：`capability-assignments.mjs` 已经 import `bot-configuration.mjs`；本节让 `bot-configuration.mjs` 反过来 import `capability-assignments.mjs`（`enableAtCreation`、`DEFAULT_CAPABILITIES`），形成循环。两边都只在函数体里用对方的导出（ESM 循环在调用时安全），不要在模块顶层求值时用。`resource-sharing.mjs` 只 import `tool-groups.mjs` 和 `bot-directory.mjs`，不参与循环。

### 4.3 收窄（D1）与去掉模拟日程（D10）——`bot-configuration.mjs`
- `export` 出 `availableResourceList`，结果里去掉 `mock:personal`（`supportedResources` 常量不改，测试仍可直接分配它）。
- `changeConfiguration()` 的资源校验：允许集合 = `availableResourceList` ∪ 该机器人当前 `assignments.resources`（老机器人身上的 `mock:personal` 原样保存不报错）。
- 写 `a.assignments[botId]` 之前：`removed` = 原 `resources` 中不在 `input.resources` 里的（去掉 `mock:personal`）；`added` = `input.resources` 中原来没有的。`a.excludedResources ??= {}`；`a.excludedResources[botId] = 去重(原排除 + removed) − added`。
- 响应不加字段；`GET` 仍返回 `assigned.resources` 和 `resources`（后者已不含 `mock:personal`）。

### 4.4 Skill 工具自动带上（D13）——`capability-assignments.mjs`
- 把 `stateFor()` 里懒初始化 `legacySkillIds / legacyBots` 的那段抽成 `export async function capabilityState(tx)`（返回 `CapabilityAssignments` 文档），`stateFor` 改为调用它。
- `export function hasEnabledSkill(state, botId)`：`[...Object.keys(state.skills[botId] ?? {}), ...(state.legacyBots.includes(botId) ? state.legacySkillIds : [])]` 中有任一 id 满足 `state.skills[botId]?.[id] ?? (state.legacyBots.includes(botId) && state.legacySkillIds.includes(id))` 即为真（与 `project()` 的判定一致）。
- `export function syncSkillTools(access, state, botId)`：`hasEnabledSkill` 为真 → `groupTools('skills')` 并入 `assignments[botId].tools`、从 `revoked[botId]` 移除；为假 → 从 `assignments[botId].tools` 移除（不写 `revoked`）。
- `setCapabilityAssignment()` 的 `kind === 'skill'` 分支写完 `state.state.skills[botId][id]` 后调 `syncSkillTools`。

### 4.5 开「日程与待办」时拿到来源（D1）
`setCapabilityAssignment()` 启用分支：`input.capabilityId === 'tool:todos'` 时，在合并工具之后 `grantResources(access, botId, (await availableResourceList(tx)).resources)`。关闭时不动资源（工具关了资源用不上）。

### 4.6 带能力创建（D3）
- `parseBotCreation()`：允许可选 `capabilities`：数组，≤ 64 项，元素为 `^(tool|skill|mcp):[A-Za-z0-9][A-Za-z0-9_.:-]{0,190}$` 且不重复；不合法用现有的 400 `INVALID_BOT`，把错误信息里"不能提供工具、资源或凭证"改成"能力只能用能力目录里的 id"。返回值里带上 `capabilities`（未提供时为 `undefined`）。
- `createDirectoryBot()`：签名只在 `input.capabilities !== undefined` 时把它放进被哈希的对象（老回执不带它，重放结果不变）。
- `capability-assignments.mjs`：`export const DEFAULT_CAPABILITIES = ['tool:todos', 'tool:history']`；新增 `export async function enableAtCreation(tx, botId, capabilityId, catalog)`：用 `catalogItems(catalog)` 找条目，找不到 404 `CAPABILITY_NOT_FOUND`，`disabled` 或（非 skill 且无 `toolNames`）409 `CAPABILITY_UNAVAILABLE`；然后做与 `setCapabilityAssignment` 启用分支相同的改动（合并工具、清 `revoked`、写 `bindings`、skill 写 `skills` 并 `syncSkillTools`、`tool:todos` 时 `grantResources`），**不**写新配置版本和审计。把这段改动抽成两处共用的内部函数，不要复制两份。
- `bot-configuration.mjs` `createConfiguredBot(tx, parsed, configuredModels, catalog = [])`：`Object.assign(liveDirectory, directory)` 之后，若 `created.created`，对 `parsed.capabilities ?? DEFAULT_CAPABILITIES` 逐个 `await enableAtCreation(tx, created.bot.id, id, catalog)`。必须在 `Object.assign` 之后（`stateFor` 读的是活目录）。全部启用后，把 `assignments[botId]` 的最终 `tools / resources` 写进活目录里该机器人的 `defaults.tools / toolResources`、`requests[parsed.requestId].bot.defaults` 和 `configurations[botId][0].defaults`（都还是版本 1，不新建版本），回执返回活目录里的那份。`chief-management.mjs` 不传 `catalog`，内置默认能力照样生效。
- `tasks.mjs` `createBot(input)`：事务内 `createConfiguredBot(tx, parsed, configuredModels, await readCapabilityCatalog(tx, {}))`；提交后若 `parsed.capabilities?.some(id => id.startsWith('mcp:'))` 则 `await syncManagedCatalog()`。

### 4.7 `GET /api/capabilities`
- `capability-assignments.mjs`：`export function listCapabilityCatalog(catalog)` = `catalogItems(catalog).map(i => ({ id, kind, name, description, status, revision, ...(i.version ? { version } : {}) }))`。
- `tasks.mjs` store：`async capabilityCatalog() { await refreshExternalCatalog(); return harness.commit(async tx => listCapabilityCatalog(await readCapabilityCatalog(tx, {})), context) }`。
- `app.mjs`：`req.url === '/api/capabilities'` → GET 返回 `{ data: { items } }`，其他方法 405（照抄相邻路由的写法），放在 `/api/bots` 那组路由之前。

### 4.8 界面可见的服务端字符串（D6）
- `tools.mjs` `TOOL_LABELS`：`routine_propose: '创建定时任务'`、`collaborators_list: '查看其他机器人'`、`shared_link: '分享给其他机器人'`、`bot_manage: '管理机器人'`，新增 `bot_inspect: '查看机器人'`。
- `inbox.mjs`：卡片文字里的 `Bot` → `机器人`（`'Bot'` 兜底名、`想新建Bot`、`想停用Bot`、`想修改Bot`、`本Bot的任务结束时` → `这个机器人的任务结束时`），`例行任务` → `定时任务`。
- `routine-delivery.mjs` 镜像卡摘要：`例行任务${…}；请查看原任务。` → `定时任务${…}；请查看原会话。`；`'例行任务'` 兜底标题 → `'定时任务'`。
- `bots.mjs` 预设说明（只影响新库的种子）：`calendar` → `梳理日程与时间安排，找出冲突和空档。`；`todo` → `整理待办和优先级，提醒快到期的事。`。

## 5. 一次性迁移（`r4Migration`）

- `openTaskStore({ …, r4Migration = false })`。只有 `server/index.mjs` 和 `ui-audit.mjs` 传 `r4Migration: true`；测试库和夹具都不传，所以现有测试不受迁移影响。
- 新文件 `server/r4-migration.mjs`：
  - `export const PRESET_TEXT = { calendar: { old: '梳理日程与时间安排；可读取模拟日程，尚未连接真实日历。', new: '梳理日程与时间安排，找出冲突和空档。' }, todo: { old: '整理事项与优先级；当前尚未连接待办服务。', new: '整理待办和优先级，提醒快到期的事。' } }`（`new` 与 §4.8 的 `bots.mjs` 相同）。
  - `export async function migrateToR4(tx)`：`ToolAccess.r4MigratedAt` 已有值就返回 false；否则按顺序做：
    1. 补全合并后的组（D8）：每个 `holdsSchedule` 为真的机器人，`groupTools('todos')` 并入 `assignments.tools`，并从 `revoked` 移除这些工具。
    2. Skill 工具（D13）：`const state = await capabilityState(tx)`，每个机器人 `syncSkillTools(access, state, botId)`。
    3. 来源（D9）：`const { resources } = await availableResourceList(tx)`，每个 `holdsSchedule` 的机器人 `grantResources(access, botId, resources)`。
    4. 去掉先问（D2）：`PolicyRules.items` 删掉所有 `effect === 'ask' && origin !== 'preset'` 的规则；deny、allow 保留。
    5. 去掉模拟日程（D10）：所有 `assignments[*].resources` 和 `excludedResources[*]` 删掉 `mock:personal`。模拟日程工具留在 `tools` 里，没有资源模型就看不到。
    6. 预设说明：`calendar`、`todo` 的 `description` 等于 `PRESET_TEXT[id].old` 时改成 `.new`（直接改目录项，不新建配置版本）。
    7. `access.r4MigratedAt = new Date().toISOString()`，返回 true。
  - `tasks.mjs` 开库事务里，紧跟 `if (toolGroupsMigration) migrateToolGroups(…)` 之后：`if (r4Migration) await migrateToR4(tx)`。这个事务前面已经调过 `initializeConfiguration`，每个机器人都有 `assignments`。
- 人格（D10）：`openTaskStore` 组装好 store、打开 `memoryFiles` 之后、返回之前，若 `r4Migration`：对目录里存在且 `status !== 'inactive'` 的 `calendar`、`todo`，用 store 的 `getBotMemory(botId)` 读人格文档（内容和版本的字段名以源码为准）；内容 `trim()` 后等于 `PRESET_TEXT[id].old` 时调 `editBotMemory(botId, { kind: 'personality', action: 'set', content: PRESET_TEXT[id].new, expectedVersion: <当前版本>, requestId: 'r4-preset-' + botId })`。用户改过（内容不同）就不动。这一步只会生效一次，不需要标记。
- 迁移步骤 6 先于开库后面的人格种子执行，所以新库的人格直接种成新文案，人格这一步对新库什么也不做。

## 6. 前后端接口（冻结，前端各票照此写）

| 接口 | 形状 |
|---|---|
| `GET /api/capabilities`（新） | `{ data: { items: [{ id, kind: 'tool' \| 'skill' \| 'mcp', name, description, status, revision, version? }] } }`；`status` ∈ `ready / configured / needs_auth / missing_dependency / error / disabled`。 |
| `POST /api/bots` | 请求 `{ name, description?, profile?, parameters?, requestId, capabilities? }`；响应不变：`{ bot, created, mainTaskId, inferred }`（不包 `data`）。 |
| `GET /api/bots/:id/capabilities` | 不变：`{ data: { botId, revision, items: [{ 目录字段…, enabledForBot, partiallyEnabled, assignedToolNames, available }] } }`。外面包着 `data`，要解包。 |
| `POST /api/bots/:id/capabilities` | 不变：`{ requestId, expectedRevision, capabilityId, enabled, expectedCatalogRevision }` → `{ data: … }`；409 `CONFIG_VERSION_CONFLICT` / `CAPABILITY_CATALOG_CONFLICT` 表示要重新读取。 |
| `GET /api/bots/:id/configuration` | `toolGroups` 项去掉 `mode`、`switchable`；`resources` 不含 `mock:personal`；其余不变（不包 `data`）。 |
| `POST /api/bots/:id/configuration` | 不变。去掉某来源 = 对这个机器人收窄，加回 = 取消收窄。 |
| `POST /api/bots/:id/tool-groups/:group` | 删除（404）。 |

前端可见性（`src/bot-capabilities.mjs`）：永远隐藏 `tool:skills`、`tool:automation`、`tool:bots`；`botId === 'chief'` 时再隐藏 `tool:capabilities`。

## 7. 测试（R4-01）

### 7.1 新增
- `server/r4-migration.test.mjs`：
  1. 不带 `r4Migration` 建库，`harness.commit` 造数据：某机器人只有 `calendar_read_schedule`；该机器人有 `origin: 'group'` 和 `origin: 'user'` 的 ask 规则各一条、一条 deny 规则；某机器人 `resources` 含 `mock:personal`；`calendar` 的 `description` 是旧文案。关库后带 `r4Migration: true` 重开：该机器人拥有 `groupTools('todos')` 全部工具和 `workspace:local`；两条 ask 都没了，deny 还在；`mock:personal` 不在任何 `resources` 里；`calendar` 说明是新文案；`r4MigratedAt` 有值。
  2. 再加一条 ask 规则，再次带 `r4Migration: true` 重开：这条 ask 还在（只迁移一次）。
  3. 人格是旧文案 → 迁移后是新文案；人格改过 → 不变。
- `server/resource-sharing.test.mjs`：飞书绑定后，开着「日程与待办」的机器人拿到 `feishu:*` 和 `workspace:feishu:*`，没开的拿不到；某机器人经 `POST /configuration` 去掉 `workspace:feishu:*` 后断开再重连，它拿不回来，其他机器人拿回来；Google 日历 `registerExternalSource` 同理（用 `fixtures/fake-google.mjs` 或现有 R3-03 测试的造数方式）。
- `server/r4-capabilities.test.mjs`：
  1. 不带 `capabilities` 创建：`tools` = `todos` + `history` 两组的已安装工具；`resources` ⊇ `workspace:local`；不含 `mock:personal`。
  2. `capabilities: ['tool:history']`：只有 history 工具，`resources` 为空。
  3. `capabilities: ['skill:不存在']`：404，目录里没有新增机器人。
  4. 同一 `requestId` 的老式请求（不带 `capabilities`）重放：返回原机器人，`created: false`。
  5. 开一个 Skill → `groupTools('skills')` 进 `tools`；关掉最后一个 → 移出。
  6. `GET /api/capabilities`：有 `tool:todos`，没有 `tool:calendar`，条目里没有 `enabledForBot`。

### 7.2 要改的现有测试（规则见 README §0）
- `tool-groups.test.mjs`、`tool-group-settings.test.mjs`、`r1-capability-management-http.test.mjs`、`policy.test.mjs`、`r3-07-permission-downgrade.test.mjs`：删 `switchGroup`、`mode`、`switchable`、`/tool-groups/` 相关用例；`groupId: 'calendar'` → `'todos'`；"日程归日历组、待办归待办组"这类分流用例删掉（两类现在同组）；`itemTypeOf` 与 `decide()` 本身的用例保留。
- `tool:calendar` 出现在：`capability-assignments.test.mjs`、`r1-static-capabilities.test.mjs`、`r1-capability-http.test.mjs`、`tool-groups.test.mjs`、`policy.test.mjs`、`r3-07-permission-downgrade.test.mjs`，按场景改成 `tool:todos` 或删掉。
- 断言"新机器人空白"的：`bot-configuration`、`bot-directory`、`capability-assignments`、`capability-management`、`bot-onboarding`、`memory-file-format`、`r1-static-capabilities`、`model-settings`、`r1-external-mcp-http`、`r1-capability-http`、`r1-capability-management-http`、`skill-lifecycle` 等。用例本意是"没分配就不能用"的，创建时传 `capabilities: []` 保留原意；只是顺带断言工具列表的，改成新默认值。Chief 用 `bot_manage create` 建的没有 `capabilities` 参数，断言改成新默认值。
- 断言"重连不恢复分配"的：`r3-03-google-calendar`、`r3-04-google-tasks`、`workspace-feishu`：改成"开着「日程与待办」且没收窄的机器人重连后自动拿回"。
- 断言 §3.3、§4.8 原句的测试：改成新句子。

## 8. ADR-022 草稿（W2 由主管写进 `docs/decisions/README.md`）

**ADR-022 工具集只有开关，来源跟着「日程与待办」，新机器人带默认能力**

采纳日期：第四轮完成当天（Asia/Shanghai）。依据：第四轮 D1、D2、D3、D8、D9、D10、D13；用户原话"mcp 改为开关即可不需要那么麻烦细化的管理了""用户心智负担还是大"。

替代关系：
- ADR-015：每组的「直接做 / 先问」整条去掉；工具组只有开关；写入直接执行，只有全局暂停时先问。
- ADR-021：决定 2（"Bot 分配不变、新 Bot 仍空白、重连不恢复旧分配"）由本 ADR 第 3、4 条替代；决定 4 的"日程归「日历与日程」、待办归「待办与事项」"因两组合并而失效。
- ADR-014：新 Bot 空白的默认值改为第 4 条。
- 不变：ADR-006、`decide()` 规则引擎、全局暂停、无人值守遇 ask 跳过、ADR-018、ADR-019、ADR-020。

决定：
1. 工具组的写入模式和 `/api/bots/:id/tool-groups/:group` 删除；`PolicyRules` 与 `decide()` 保留。升级时删除所有非预设的 ask 规则。
2. 「日历与日程」并入「待办与事项」，改名「日程与待办」，id 仍为 `todos`。
3. 来源跟着工具集：持有 `todos` 组任一工具的机器人，自动获得所有已连接的日历和任务列表（`workspace:*`、`feishu:*`）；单个机器人可在「设置 → 高级」收窄，收窄记在 `ToolAccess.excludedResources[botId]`，重连不会加回。已知限制：飞书重新绑定会换新的 `feishu:` 资源 id，对旧 id 的收窄不再生效。
4. 新机器人默认能力 `tool:todos`、`tool:history`，创建时可用 `capabilities` 指定；开了任一 Skill 自动带上 `skills` 组工具。
5. 模拟日程不再出现在可分配资源里；升级时从所有分配中去掉 `mock:personal`。代码和测试保留。

## 9. 文档（W2 主管）

| 文件 | 改什么 |
|---|---|
| `docs/decisions/README.md` | 加 ADR-022（§8）；开头"当前权限以 … 为准"加上 ADR-022。 |
| `docs/interfaces/http-api.md` | 删 tool-groups 路由；加 `GET /api/capabilities`；`POST /api/bots` 加 `capabilities`；configuration 去掉 `mode / switchable`，说明收窄。 |
| `docs/product/system-design.md` | "Bot 目录与详情"改成点机器人进对话、齿轮进设置三栏；"权限与责任"改成开关 + 全局暂停；领域语言里"来源""工具组"按 COPY.md 用词。 |
| `docs/product/mvp-scope.md` | 能力配置一节按三栏改；去掉「先问 / 直接做」。 |
| `docs/architecture/agent-runtime.md` | 工具组与写入确认的段落按 ADR-022 改；加"来源跟着工具集"。 |
| `docs/interfaces/mcp.md`、`docs/project-guide.md` | 去掉「先问 / 写入确认 / 逐个分配来源」的过时说法。 |
| `docs/engineering/operations.md` | 加"第四轮升级"：停服务 → 复制整个 `my-app/data/` → 启动后自动迁移一次，迁移做了什么（§5 七步）。 |
| `my-app/README.md` | API 表去掉 tool-groups，加 `/api/capabilities`。 |
| `CLAUDE.md` | "工具裁决"条：启用 = 能力页开关；写入直接执行，全局暂停时先问；来源跟着「日程与待办」；权限以 ADR-014、ADR-018、ADR-021、ADR-022 为准；删掉"直接做 / 先问 = 工具组写入模式"的说法。 |
| `NEXT_STAGE.md`、`plans/README.md` | 第四轮改为"实现完成，待用户验收"，附实际 test / lint / build 数字。 |

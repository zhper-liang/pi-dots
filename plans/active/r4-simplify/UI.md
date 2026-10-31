# 第四轮前端规格

文案以 [COPY.md](COPY.md) 为准，本文只写结构和行为。每票只改 README §4.2 里归自己的文件。

**通用约定**
- 技术信息统一写成 `<details className="tech-info"><summary>技术信息</summary>…</details>`，放在所在区域的最后。样式由 R4-04 写进 `index.css`：summary 小号灰字，内容小号。放原始数据的小折叠（每个工具调用的参数 JSON、回执的执行结果）也加 `className="tech-info"`，但保留自己的 summary 文字（如「调用 · 列出待办和日程」）。`ui-audit.mjs` 不展开 `.tech-info`，其余 `<details>` 全部展开后检查文字。
- 开关用 `Switch.tsx`，弹窗用 `EditorDialog.tsx`，不引入新依赖。
- `ui-audit.mjs` 依赖下面这些选择器，不要改：`#message`；登录框 `getByLabel('本地访问 token')` 和按钮「连接」；发送按钮文字「发送」；侧栏底部按钮「事项」「通知」「设置」；手机顶栏 `button[aria-controls="shell-sidebar"]`；会话详情按钮 `aria-label="会话详情"`；事项子 tab `.pd-subtabs [role=tab]`；机器人设置 tablist `aria-label="机器人设置"`；能力子栏 tablist `aria-label="能力分类"`；创建页 `#bot-name`、`details.bot-advanced`；设置页每块一个 `<h2>`。

## R4-02 能力组件与创建页

### `src/bot-capabilities.mjs`（+ `.d.mts`、`.test.mjs`）

```js
export const CAPABILITY_TABS = [{ id: 'skill', label: 'Skills' }, { id: 'mcp', label: 'MCP' }, { id: 'tool', label: '工具集' }]
export const DEFAULT_CAPABILITIES = ['tool:todos', 'tool:history']
export const BOT_TEMPLATES = [
  { name: '每日助理', description: '每天早上汇总今天的日程、到期待办和需要我处理的事，并提醒冲突。', capabilities: ['tool:todos', 'tool:history'] },
  { name: '日程整理', description: '查看我的日历，找出冲突和空档，给出调整建议。', capabilities: ['tool:todos', 'tool:history'] },
  { name: '费用整理', description: '整理我提供的消费记录，按类别汇总并标出异常。', capabilities: ['tool:history'] },
  { name: 'Bug 复现', description: '根据我描述的问题，整理复现步骤、预期与实际结果。', capabilities: ['tool:history'] },
]
const HIDDEN = ['tool:skills', 'tool:automation', 'tool:bots']
/** botId null = the creation page. */
export const visibleCapabilities = (items, botId) => items.filter(i => !HIDDEN.includes(i.id) && !(botId === 'chief' && i.id === 'tool:capabilities'))
export function filterCapabilities(items, tab, query) {
  const q = query.trim().toLocaleLowerCase()
  return items.filter(i => i.kind === tab && (!q || `${i.name} ${i.description}`.toLocaleLowerCase().includes(q)))
}
export const capabilityStatusLabel = status => ({ configured: '待检查', needs_auth: '需要凭据', missing_dependency: '缺少依赖', error: '连接失败', disabled: '已停用' })[status] ?? ''
```

测试：隐藏规则（含 Chief）、按子栏和关键字过滤（不分大小写）、状态文案。

### `src/CapabilityPicker.tsx`（纯展示）
- props：`{ items: { id: string; kind: 'tool' | 'skill' | 'mcp'; name: string; description: string; status: string }[]; enabled: string[]; partial?: string[]; disabled?: boolean; pendingId?: string | null; onToggle: (id: string, next: boolean) => void }`。
- 顶部 `role="tablist" aria-label="能力分类"`，三个子栏按 `CAPABILITY_TABS` 顺序，标签带已开数量（如「工具集 2」），默认选中「工具集」。
- 搜索框只过滤当前子栏。
- 每行：名称；说明（最多两行，超出省略）；状态标签（`capabilityStatusLabel` 非空时显示，`partial` 里的显示「部分开启」）；右侧 `Switch`。没开且 `status === 'disabled'` 的开关禁用；`disabled` 为真或 `pendingId` 非空时全部禁用。
- 空状态与搜索无结果的文案见 COPY.md。
- 375px：子栏一行、可换行，列表单列。样式在 `capabilities.css`（由 `capability-list.css` 改名，删掉不再用的规则）。

### `src/BotCapabilities.tsx`（机器人设置的「能力」tab）
- props：`{ token: string; botId: string; readOnly: boolean; active: boolean }`，`active` 为真才读取。
- 读 `GET /api/bots/:id/capabilities`，**解包 `data`**；条目过 `visibleCapabilities(items, botId)`；`enabled` = `enabledForBot` 为真的 id，`partial` = `partiallyEnabled` 为真的 id。
- 切换：`POST` 同一路径，body `{ requestId: crypto.randomUUID(), expectedRevision: view.revision, capabilityId, enabled: next, expectedCatalogRevision: item.revision }`，成功后重新读取。409 → 重新读取并提示；网络错误或 5xx → 提示没确认保存成功并给「重试」，重试用同一个 body（同一 `requestId`），确认前其他开关禁用。逻辑照搬 `BotRules.tsx` 的 `save()`，然后删除 `BotRules.tsx`。
- `readOnly`（机器人已停用）时开关全部禁用并显示一句只读提示。

### `src/BotCreation.tsx`（新建机器人页）
从上到下：标题与一句提示 → 模板一排（`BOT_TEMPLATES` 的按钮，点了填入名字、说明和能力；删掉原来大块的"从模板开始"区） → 名字 `#bot-name`（必填，≤60） → 「负责什么」textarea（可选，≤2000） → `<details className="bot-advanced"><summary>高级 · 已开：日程与待办、历史与回读</summary><CapabilityPicker …/></details>`（summary 列出当前已开能力的名称，没有就写「高级 · 没开能力」） → 「取消」「创建」。
- 删掉颜色、形状、角色输入和预览头像，删掉 `saveLook` 调用；外观由 `defaultLook(id)` 自动生成，之后在「设置 → 外观」改。
- 挂载时读 `GET /api/capabilities`（解包 `data.items`），过 `visibleCapabilities(items, null)`；初选 = `DEFAULT_CAPABILITIES` 中目录里存在的那些。读取失败：不显示开关，「高级」里只显示一句按默认能力创建的提示，提交时不带 `capabilities`。
- 提交 `POST /api/bots`，body `{ name, description?, profile, requestId, capabilities }`（目录读到了就总带上，空数组也带）。沿用现有 `pendingKey` 幂等重放，比较内容时把 `capabilities` 也算进去。成功后照旧 `onCreated(bot, mainTaskId)`。

### `src/SkillControls.tsx`
删 `BotSkills`、`BotSkillsPanel` 和只给它们用的类型与常量（`SkillCapability`、`CapabilityView`、`BotSkillsProps`、`STATUS`）。`SkillNote`、`SkillHistory` 和 `App.tsx` 用到的类型保留，它们和 `SOURCES`、`EVENTS` 里的文案按 COPY.md 改（显示在对话里和会话详情里）。

## R4-03 设置页、目录与侧栏

### `src/bot-directory.mjs`（+ `.d.mts`、`.test.mjs`）
- `botTabs = [{ id: 'capabilities', label: '能力' }, { id: 'memory', label: '记忆' }, { id: 'settings', label: '设置' }]`。
- `readBotTab(hash)`：`tab` 是这三个之一就返回它，否则返回 `'chat'`（"没有 tab = 对话"，`'chat'` 不是 tab）。
- `botDetailHash(botId, tab = 'chat')`：`'chat'` 只写 `bot=`；三个 tab 写 `bot=&tab=`。
- 删 `tasksForBot`（`App.tsx` 由 R4-04 同步删引用）；`mergeBotSkills` 如果已经没有调用方就删掉；`directoryBots`、`credentialBots`、`credentialClients` 保留。
- `.d.mts`：`export type BotTab = 'chat' | 'capabilities' | 'memory' | 'settings'`，删掉已删函数的声明。
- 测试：三个 tab 读写往返；`#bot=chief`、`#bot=chief&tab=rules`、空串都读成 `'chat'`；`botDetailHash('x')` 不含 `tab`。

### `src/BotTemplatePage.tsx`（只做设置页）
- props 改为：`{ bot; token; tab: Exclude<BotTab, 'chat'>; mainTaskId: number | null; active?: boolean; refreshKey?: number; onTab: (tab: BotTab) => void; onChat: () => void; onSaved: (bot) => void; onDeactivate: () => void; memoryApi?; onOpenPreferences?; onOpenMemorySource? }`。删掉 `tasks`、`creating`、`chat`、`onDirectory`、`onNewTask`、`onOpenTask`。
- 顶部：`← 回到对话`（调 `onChat`）；头像、名字、显示标签；`role="tablist" aria-label="机器人设置"`，三个 tab，键盘导航沿用 `nextTab`。
- 「能力」：`<BotCapabilities token botId readOnly={inactive} active={active && tab === 'capabilities'} />`。
- 「记忆」：现有 `BotMemory`，不变。
- 「设置」：外观（不变）→ `BotConfiguration` → 停用（非 Chief 且未停用；保留现有 `window.confirm`）→ 最后 `<details className="tech-info"><summary>技术信息</summary><FeishuCalendarPanel token={token} taskId={mainTaskId} /></details>`（这个面板从 `App.tsx` 搬过来，组件本身不改）。
- 删掉 `BotRules`、`BotSkills`、`StdioCredentials`、`BotRoutines` 的挂载和独立任务列表。

### `src/BotConfiguration.tsx`
- 「模型」区保留，提示文字换成 COPY.md 的；保留 `data-testid="bot-config-version"`。
- 删「来源」区。
- 新增 `<details className="bot-config-advanced"><summary>高级</summary>…</details>`，只在 `view.toolGroups` 里 `todos` 组 `enabled` 时显示：列出 `view.resources`（已不含模拟日程），每行名称 + `Switch`（开 = 在 `assigned.resources` 里），切换沿用现有 `switchResource()`。`describeResource()` 删掉 `mock:personal` 分支；飞书两行的说明改成 `飞书日历`（不再提「待办与事项工具」「日历工具」两个旧组名）。
- "配置历史与审计"改成 `tech-info`（`summary` 文字为「技术信息」），内容不变。

### `src/BotDirectory.tsx`、`bot-directory.css`
- 新 prop `onSettings: (id: string) => void`。
- 每张卡片：外层 `div.bot-directory-card`；里面一个铺满卡片的 `button`（打开对话，`onOpen(id)`）和右上角齿轮 `button`（`aria-label={`${name} 的设置`}`，`onSettings(id)`）。不要 button 套 button。
- 删「打开详情 →」和「可对话」；状态行只在停用时显示「已停用」，Chief 显示「主管 · 派活与验收」。

### `src/ShellSidebar.tsx`、`SessionActions.tsx`、`session-list.mjs`
只改文案（COPY.md）：齿轮 `title` 「机器人设置」、「新建 Bot」→「新建机器人」、Chief 行副标题等。props 不变。

### 记忆页（`BotMemory.tsx`、`MemoryDocuments.tsx`、`memory-helpers.mjs`）
只改文案；"文档详情"那类折叠换成 `tech-info`。结构和行为不变。

测试：`bot-directory.test.mjs`、`session-list.test.mjs` 跟着改；`memory-ui.test.mjs`、`capability-session-ui.test.mjs` 是共享测试，把要改的断言写进交接说明。

## R4-04 对话页与路由（`App.tsx` 为主）

### 路由
- `selectBot(id, tab = 'chat')`：`id === 'chief' && tab === 'chat'` → `goView('home')`；其余照旧 push `botDetailHash(id, tab)`。
- `botDetail` 只在 `botTab === 'chat'` 时为真（只有对话需要读主会话详情）。
- 主栏 children 里 `selectedBot && !home` 那支改成：`botTab === 'chat' ? chatView : <BotTemplatePage … tab={botTab} mainTaskId={mainSessions[id] ?? null} active={view === 'chats' && botTab !== 'chat'} onChat={() => selectBot(id)} …/>`。群聊页、目录、新会话、新建机器人这些分支的顺序不变。
- 齿轮一律到「能力」：侧栏 `onBotSettings={id => selectBot(id, 'capabilities')}`；标题栏齿轮；目录卡片 `onSettings`；`CapabilitySetupCard` 的 `onOpenBot={id => selectBot(id, 'capabilities')}`。
- 删：`botTasks` 和 `tasksForBot` 的引用、`onNewTask` / `create()`（若没有别的调用方）、页面底部单独挂载的 `FeishuCalendarPanel`（已搬进 R4-03 的设置 tab）。
- `mobileTitle`：「新建 Bot」→「新建机器人」，兜底「Bot」→「机器人」。

### 标题栏
从左到右：标题；状态徽标（只在 `tone !== 'neutral'` 时显示）；归档（非主会话，不变）；齿轮按钮（`GearIcon`，`aria-label="机器人设置"`，群聊不显示）；ⓘ（不变）。删掉「对话 / 时间线」切换。

### `src/taskStatus.ts` 状态文案

| 条件（按原顺序判断） | label | tone |
|---|---|---|
| sending | 正在发送… | busy |
| 机器人已停用 | 已停用 | muted |
| 已取消 | 已取消 | muted |
| `runtime.status === 'terminal'` | 出错了，不能继续 | danger |
| 等待核实结果 | 结果待确认 | attention |
| 等子任务 | 等子任务结果 | busy |
| 等审批 | 等你确认 | attention |
| 阻塞等主管 / 等用户 | 等主管处理 / 等你回答 | attention |
| 正在执行 | 正在回复 | busy |
| 受限 | 已到调用上限 | attention |
| 上轮失败 | 上次出错，可以继续发 | danger |
| 其余 | 空闲 | neutral |

删掉不再用的 `mode` 变量。

### 消息
- 删每条回复下的 `<details><summary>请求参数</summary>…</details>`。
- 带工具调用的回合：标题用 `detail.bot.name`（不再是「请求调用工具」）；每个调用的 summary 改成 `调用 · ${中文名}`；展开后的调用 ID 和参数 JSON 不变。
- 工具回执标题只写中文名，去掉「工具回执 · 」前缀：`mcp_manage` →「MCP 配置」，`skill_manage` →「Skill 配置」，外部 MCP →「{连接名} · {原工具名}」（现有 `externalOf`），其余查中文名。
- 中文名来源：进入某机器人的会话时读一次 `GET /api/bots/:id/configuration` 的 `toolLabels`（按 botId 缓存在 App state，失败就用原名），再并上 `{ bot_inspect: '查看机器人', bot_manage: '管理机器人', mcp_manage: 'MCP 配置', skill_manage: 'Skill 配置' }`；查不到就显示原名。
- 回执正文：成功「完成」（`report_blocker` 和 `calendar_reschedule_event` 用 COPY.md 的专门文案）；失败「没有成功」，错误码放进折叠里。原来的「调用参数与执行结果」折叠改名「技术信息」。

### 输入框
保留 `/` 按钮。`ModelPicker` 和「思考」下拉收进 `<details className="pd-composer-more"><summary aria-label="模型与思考深度">⋯</summary>…</details>`，只在原来会显示它们的条件下（主会话、非群聊、真实模型）出现；独立任务只读的模型名不在输入框显示，挪进详情抽屉的技术信息。`ModelPicker.tsx` 只改 `title` 等文案，props 不变。

### 详情抽屉（从上到下）
1. 受限时：`ExecutionControls` 放最上面并展开提额表单。
2. `SkillHistory`。
3. `<details><summary>任务目标</summary>`：目标、完成标准、限制和编辑表单；删掉里面的说明句子；"来源"那句挪进技术信息。
4. 取消控制与配置迁移（非主会话，不变）。
5. `tech-info`：未受限时的 `ExecutionControls`；上下文压缩；工具权限与调用用量；配置版本与任务引用；任务目标来源；模型快照；「查看时间线」按钮。
- 删掉"真实模型持续对话 · …"那段说明。
- 「查看时间线」把主区切到 `TaskTimeline`，上方一行「← 回到对话」按钮切回来；`/` 命令里的切换保留。

### 其他文件（只改文案或小处，见 COPY.md）
`TaskApprovalControls.tsx`（暂停时的确认原因句）、`CapabilitySetupCard.tsx`（「查看机器人能力」）、`NewSession.tsx`、`GroupCreation.tsx`、`MainSession.tsx`、`TaskBlockerControls.tsx`、`TaskCancellationControls.tsx`、`TaskConfigurationMigration.tsx`、`WaitingRecoveryNotice.tsx`、`ActionOutcomeControls.tsx`、`CollaborationOverview.tsx`、`CollaborationPanel.tsx`、`SharedInformationPanel.tsx`、`GroupTaskBoard.tsx`、`GroupIssueControls.tsx`、`CommandMenu.tsx`、`MentionMenu.tsx`、`ComposerSuggestions.tsx`、`system-cards.mjs`、`timeline.mjs`。

测试：`capability-setup-ui.test.mjs`、`r1-composer-integration.test.mjs`、`mentions.test.mjs` 跟着改；`server/workspace-ui.test.mjs`、`model-settings-ui.test.mjs` 是共享测试，写进交接说明。

## R4-05 事项与通知

### `src/workspace-navigation.mjs`（+ `.d.mts`）
- `itemTabs = [{ id: 'calendar', label: '日历' }, { id: 'routines', label: '定时任务' }, { id: 'runs', label: '执行记录' }]`。
- `resolveItemTab`：`'todos'` → `'calendar'`，`'automation'` → `'routines'`，其余原样。`ItemTab` 类型同步。
- `workspaceViews` 的 `description` 换成 COPY.md 的。

### `src/UnifiedWorkspace.tsx`
- 三个 tabpanel：`items-panel-calendar`（不变）；`items-panel-routines`：`<BotRoutines bots={routineChoices} refreshKey={refreshKey} onChanged={onChanged} token={token} onOpenTask={onOpenTask} />`，后面跟 `<details className="tech-info"><summary>技术信息</summary><ScheduleWorkspace token={token} view="schedules" /></details>`；`items-panel-runs`：`<ScheduleWorkspace token={token} view="runs" />`。
- 删：`automation` 和 `routineBot` 两个 state、「执行 Bot」下拉、按机器人逐个挂载的 `BotRoutines`、通知面板里的「关于通知状态」折叠、"独立待办入口已收起…"那行提示（旧待办 hash 仍跳到日历）。
- 组件 props 不变（`App.tsx` 的调用不用改）。

### `src/BotRoutines.tsx`（一个列表放所有机器人的定时任务）
- props 改为 `{ token: string; bots: RoutineBotChoice[]; refreshKey?: number; onChanged?: () => void; onOpenTask: (taskId: number, botId: string) => void }`，删 `botId`、`botName`、`readOnly`。
- 列表：`schedule-list` 结果中所有带 `actionSpec.botId` 的条目（不再按某个机器人过滤）。每行加机器人名标签（`bots` 里找不到就写「已删除的机器人」）；那个机器人已停用时这一行只读。
- 新建时编辑器默认选 Chief；编辑器里选机器人的下拉和后面的逻辑不变；打开运行记录时 `onOpenTask(taskId, 该行的 botId)`。
- `src/routines.mjs` 的导出签名不变。

### `ScheduleWorkspace.tsx`、`InboxPage.tsx`、`ReminderWorkspace.tsx`
只改文案和折叠：删 `ScheduleWorkspace` 顶部"例行任务可在…管理"那句；「高级参数：来源、提示版本与额度」和各处「诊断」折叠换成 `tech-info`；通知页结构见 COPY.md（两块：「需要你处理」「提醒」）。`InboxPage` 在对话里以 `proposalTaskId` 模式复用，那条路径的结构不动。

### 日历（`CalendarBoard.tsx`、`CalendarView.tsx`、`LocalWorkspace.tsx`、`LocalTimePicker.tsx`）
只改命中禁用词的文案。

测试：`calendar-accessibility.test.mjs`、`workspace-refresh.test.mjs` 跟着改；`server/workspace-ui.test.mjs`、`routines.test.mjs` 是共享测试，写进交接说明。

## R4-06 设置与连接

### `src/SettingsPage.tsx`（+ 新 `settings.css`），props 不变
```tsx
<section className="today-card"><h2>连接</h2>
  <details className="settings-connection"><summary>飞书日历<span className="settings-state">{feishu}</span></summary><ExternalWorkspace token={token} onSummary={setFeishu} /></details>
  <details className="settings-connection"><summary>Google<span className="settings-state">{google}</span></summary><GoogleConnection key={token} token={token} onSummary={setGoogle} /></details>
  <details className="settings-connection"><summary>MCP 连接<span className="settings-state">{mcp}</span></summary><ExternalMcpConnections key={`external:${token}`} token={token} onSummary={setMcp} /></details>
</section>
<section className="today-card"><h2>模型</h2><ModelSettings key={token} token={token} /></section>
<section className="today-card"><h2>自动化</h2><AutomationSettings token={token} /><MutedDetectors token={token} /><AssistSettings token={token} /></section>
<section className="today-card"><h2>偏好</h2><UserPreferences token={token} /></section>
<section className="today-card"><h2>高级</h2>
  <StdioCredentials key={token} token={token} />{/* 它自己就是一个 <details>，summary 改成「本机程序连接凭证（stdio）」，不要再包一层 */}
  <details className="tech-info"><summary>技术信息</summary><WorkspaceStatus token={token} /></details>
</section>
{footer && <section className="today-card settings-account" aria-label="连接">{footer}</section>}
```
- `ExternalWorkspace`、`GoogleConnection`、`ExternalMcpConnections` 各加可选 prop `onSummary?: (text: string) => void`，用组件已经读到的数据，每次读取成功后调用：飞书 = 已绑定日历名或「未绑定」；Google = 已连接账号或「未连接」，接口 503 时「未启用」；MCP = 「N 个」或「未添加」。读取中不调用。

### 各子组件
只改文案（COPY.md）和加 `onSummary`；连接、OAuth、凭据、请求核对的逻辑都不改。`requestId` 之类的细节挪进 `tech-info`，恢复提示换成人话。`GoogleConnection.tsx`、`GoogleWorkspaceMcpStatus.tsx`、`FeishuCalendarPanel.tsx` 只改命中禁用词的句子。

`ui-audit.mjs` 会展开所有非 `tech-info` 的 `<details>`（包括 stdio 那块），里面的文字也要符合 COPY.md。

测试：`external-mcp-ui.test.mjs`、`google-connection-ui.test.mjs`、`r3-05-workspace-mcp-ui.test.mjs` 跟着改；`memory-ui.test.mjs`、`model-settings-ui.test.mjs` 是共享测试，写进交接说明。

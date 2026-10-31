import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { itemTabs, nextItemTab, resolveItemTab, isLegacyTodoHash } from './workspace-navigation.mjs'

const board = await readFile(new URL('./CalendarBoard.tsx', import.meta.url), 'utf8')
const shell = await readFile(new URL('./UnifiedWorkspace.tsx', import.meta.url), 'utf8')
const css = await readFile(new URL('./calendar.css', import.meta.url), 'utf8')
const dialog = await readFile(new URL('./EditorDialog.tsx', import.meta.url), 'utf8')

test('calendar reuses EditorDialog focus trap, Escape stack, scroll lock and explicit opener return', () => {
  assert.match(board, /import EditorDialog from '\.\/EditorDialog'/)
  assert.match(board, /<EditorDialog open=\{active\} title=\{title\} onClose=\{close\} pending=\{busy\} returnFocus=\{opener\}/)
  assert.doesNotMatch(board, /useDrawer|cal-pop-backdrop|e\.key === 'Escape'/)
  assert.match(board, /rememberOpener\(\)/)
  assert.match(dialog, /useDrawer\(dialog, \{ open, modal: true/)
  assert.match(dialog, /node\.inert = true/)
  assert.match(dialog, /new MutationObserver\(keepFocus\)/)
  assert.match(board, /\{active && popover\(\)\}/)
})

test('calendar shares date and full hour/minute pickers; unknown writes lock drafts, not recovery or cancel', () => {
  assert.equal((board.match(/<LocalTimePicker label=/g) ?? []).length, 2)
  assert.equal((board.match(/disabled=\{busy \|\| unconfirmed\} onChange=\{/g) ?? []).length, 2)
  assert.match(board, /<input disabled=\{busy \|\| unconfirmed\}/)
  assert.match(board, /<textarea disabled=\{busy \|\| unconfirmed\}/)
  assert.doesNotMatch(board, /datetime-local|北京时间|时区<input/)
  assert.match(board, /const \[timezone\] = useState\(getLocalTimezone\)/)
  assert.match(board, /eventTimeDraft\(fresh\.s, fresh\.e, fresh\.timezone, timezone\)/)
  assert.match(board, /eventTimeDraft\(s, s \+ dur, ev\.timezone, timezone\)/)
  assert.match(board, /const timing = eventTimeData\(pop\)/)
  assert.match(board, /onClick=\{close\}>取消/)
  assert.match(board, /onClick=\{\(\) => void lookup\(\)\}/)
})

test('calendar phone controls retain 44px targets, stack pickers, and respect reduced motion', () => {
  assert.match(css, /\.cal-pop-content \.cal-btn \{ min-height:44px; min-width:44px;/)
  assert.match(css, /@media \(max-width:719px\) \{ \.cal-time-pickers \{ grid-template-columns:minmax\(0, 1fr\);/)
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/)
  assert.match(css, /\.cal \*, \.cal \*::before, \.cal \*::after \{ animation:none !important; transition:none !important; scroll-behavior:auto !important;/)
})

test('Todo navigation and today block are hidden without deleting queries, due chips or backend data', () => {
  assert.deepEqual(itemTabs, [{ id: 'calendar', label: '日历' }, { id: 'routines', label: '定时任务' }, { id: 'runs', label: '执行记录' }])
  assert.doesNotMatch(board, /LocalWorkspace|items-due-today|todayDueTodos|cal-pane-switch/)
  assert.doesNotMatch(shell, /LocalWorkspace|items-panel-todos/)
  assert.match(board, /pageAll\('Todo'\)/)
  assert.match(board, /const dueChips/)
  assert.match(board, /while \(cursor !== undefined\)/)
})

test('three item tabs retain keyboard navigation and old Todo links select the calendar without extra notice', () => {
  assert.equal(resolveItemTab('todos'), 'calendar')
  assert.equal(resolveItemTab('automation'), 'routines')
  assert.equal(resolveItemTab('runs'), 'runs')
  assert.equal(nextItemTab('todos', 'ArrowRight'), 'routines')
  assert.equal(nextItemTab('calendar', 'ArrowLeft'), 'runs')
  assert.equal(nextItemTab('routines', 'ArrowRight'), 'runs')
  assert.equal(nextItemTab('runs', 'ArrowRight'), 'calendar')
  assert.equal(nextItemTab('runs', 'Home'), 'calendar')
  assert.equal(nextItemTab('calendar', 'End'), 'runs')
  assert.match(shell, /const visibleItemTab = resolveItemTab\(itemTab\)/)
  assert.doesNotMatch(shell, /legacyTodoHash|独立待办入口已收起/)
  assert.match(shell, /onItemTab\('calendar'\); onView\('items'\)/)
  assert.match(shell, /hidden=\{visibleItemTab !== 'calendar'\}/)
  assert.match(shell, /active=\{view === 'items' && visibleItemTab === 'calendar'\}/)
  assert.match(shell, /aria-selected=\{visibleItemTab === tab.id\}/)
  for (const tab of itemTabs) {
    assert.ok(shell.includes(`id="items-panel-${tab.id}" role="tabpanel" aria-labelledby="items-tab-${tab.id}"`))
    assert.ok(shell.includes(`hidden={visibleItemTab !== '${tab.id}'}`))
  }
})

test('calendar retains requestId recovery, source filtering, pagination and expected-version conflict handling', () => {
  assert.match(board, /sources\.filter\(x => x\.authorized && x\.readScope === 'full'\)/)
  assert.match(board, /isCurrent\(\) && gen === generation\.current/)
  assert.match(board, /requestId: pending\.current\.requestId/)
  assert.match(board, /expectedVersion: pop\.ev\.version, data/)
  assert.match(board, /kind: 'conflict'/)
  assert.match(board, /按当前版本重新编辑/)
  assert.match(board, /按原请求重试/)
})

test('legacy Todo hash aliases route safely on initial load and hashchange without hijacking chat links', () => {
  for (const hash of ['#todos', '#todo', '#items/todos', '#/items/todos', '#tab=todos', '#view=items&tab=todos', '#view=todos', '#items=todos', '#itemTab=todos']) assert.equal(isLegacyTodoHash(hash), true, hash)
  for (const hash of ['', '#bot=chief&tab=todos', '#task=13&tab=todos', '#new&tab=todos', '#view=items&tab=calendar', '#tab=automation']) assert.equal(isLegacyTodoHash(hash), false, hash)
  assert.match(shell, /window.addEventListener\('hashchange', restoreLegacyTodo\)/)
  assert.match(shell, /window.removeEventListener\('hashchange', restoreLegacyTodo\)/)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { workspaceViews, itemTabs, nextItemTab, nextTab } from '../src/workspace-navigation.mjs'
import { createWorkspaceRequestGuard } from '../src/workspace-request-guard.mjs'

test('10 shell has distinct destinations; 事项 sub-tabs wrap keyboard focus without effects (T03)', () => {
  assert.deepEqual(workspaceViews.map(v => v.id), ['home', 'chats', 'items', 'inbox', 'settings'])
  assert.equal(new Set(workspaceViews.map(v => v.label)).size, workspaceViews.length)
  assert.deepEqual(itemTabs.map(t => t.id), ['calendar', 'todos', 'automation'])
  assert.equal(nextItemTab('calendar', 'ArrowLeft'), 'automation')
  assert.equal(nextItemTab('automation', 'ArrowRight'), 'calendar')
  assert.equal(nextItemTab('todos', 'Home'), 'calendar')
  assert.equal(nextItemTab('calendar', 'End'), 'automation')
  assert.equal(nextItemTab('calendar', 'Enter'), 'calendar')
  assert.equal(nextTab(['a', 'b'], 'missing', 'ArrowRight'), 'b')
})
test('10 late external response is rejected after permission epoch or read-scope change', () => {
  const guard = createWorkspaceRequestGuard()
  guard.identity('source:epoch1:full'); const full = guard.begin()
  guard.identity('source:epoch1:busy'); assert.equal(guard.current(full), false)
  const busy = guard.begin(); guard.identity('source:epoch2:none'); assert.equal(guard.current(busy), false)
  guard.identity('source:epoch3:full'); const regrant = guard.begin()
  assert.equal(guard.current(full), false); assert.equal(guard.current(regrant), true)
})
test('10 newer query/source/disposal invalidates old response; unchanged polling does not', () => {
  const guard = createWorkspaceRequestGuard(); guard.identity('A')
  const first = guard.begin(), second = guard.begin()
  assert.equal(guard.current(first), false); assert.equal(guard.current(second), true)
  guard.identity('A'); assert.equal(guard.current(second), true)
  guard.identity('B'); assert.equal(guard.current(second), false)
  const third = guard.begin(); guard.invalidate(); assert.equal(guard.current(third), false)
})

test('10 late operation/preview is rejected on identity change but concurrent queries do not erase a write receipt', () => {
  const guard = createWorkspaceRequestGuard(); guard.identity('source:1:full')
  const operation = guard.capture(); guard.begin(); guard.begin()
  assert.equal(guard.sameIdentity(operation), true)
  guard.identity('source:2:none'); assert.equal(guard.sameIdentity(operation), false)
  const next = guard.capture(); guard.invalidate(); assert.equal(guard.sameIdentity(next), false)
})

test('T07 shell defaults to today calendar, keeps mounted drafts, and exposes routines and history', async () => {
  const { readFile } = await import('node:fs/promises')
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')
  const shell = await readFile(new URL('../src/UnifiedWorkspace.tsx', import.meta.url), 'utf8')
  assert.match(app, /useState<ItemTab>\('calendar'\)/)
  assert.doesNotMatch(app + shell, /TodaySummary|TodayPage|items-panel-today/)
  assert.match(shell, /initialMode="day"/)
  for (const panel of ['calendar', 'todos', 'automation']) assert.ok(shell.includes(`id="items-panel-${panel}"`))
  assert.match(shell, /<BotRoutines/)
  assert.match(shell, /view=\{automation\}/)
})

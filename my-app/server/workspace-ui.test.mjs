import { test } from 'node:test'
import assert from 'node:assert/strict'
import { workspaceViews, nextWorkspaceView } from '../src/workspace-navigation.mjs'
import { createWorkspaceRequestGuard } from '../src/workspace-request-guard.mjs'

test('10 workspace navigation has distinct business surfaces and wraps keyboard focus without effects', () => {
  assert.deepEqual(workspaceViews.map(v => v.id), ['today', 'calendar', 'todos', 'inbox', 'automation', 'settings', 'chats'])
  assert.equal(nextWorkspaceView('today', 'ArrowLeft'), 'chats')
  assert.equal(nextWorkspaceView('chats', 'ArrowRight'), 'today')
  assert.equal(nextWorkspaceView('automation', 'Home'), 'today')
  assert.equal(nextWorkspaceView('today', 'End'), 'chats')
  assert.equal(nextWorkspaceView('calendar', 'Enter'), 'calendar')
  assert.equal(new Set(workspaceViews.map(v => v.label)).size, 7)
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

import test from 'node:test'
import assert from 'node:assert/strict'
import { trapTarget, drawerStack, closesOnKey } from './drawer.mjs'

test('Tab wraps at both ends of a drawer and enters it from outside', () => {
  assert.equal(trapTarget(3, 2, false), 0)
  assert.equal(trapTarget(3, 0, true), 2)
  assert.equal(trapTarget(3, 1, false), null)
  assert.equal(trapTarget(3, 1, true), null)
  assert.equal(trapTarget(3, -1, false), 0)
  assert.equal(trapTarget(3, -1, true), 2)
  assert.equal(trapTarget(1, 0, false), 0)
  assert.equal(trapTarget(1, 0, true), 0)
  assert.equal(trapTarget(0, -1, false), 'root')
})

test('only the newest open drawer is on top', () => {
  const stack = drawerStack()
  assert.equal(stack.isTop('a'), false)
  stack.open('a')
  assert.equal(stack.isTop('a'), true)
  stack.open('b')
  assert.equal(stack.isTop('a'), false)
  assert.equal(stack.isTop('b'), true)
  stack.close('b')
  assert.equal(stack.isTop('a'), true)
  // Reopening moves a drawer back to the top instead of listing it twice.
  stack.open('b'); stack.open('a')
  assert.equal(stack.isTop('a'), true)
  stack.close('a')
  assert.equal(stack.isTop('b'), true)
  stack.close('b'); stack.close('b')
  assert.equal(stack.isTop('b'), false)
})

test('Escape closes unless a menu or an IME composition consumed it', () => {
  assert.equal(closesOnKey({ key: 'Escape', defaultPrevented: false, isComposing: false }), true)
  assert.equal(closesOnKey({ key: 'Escape', defaultPrevented: true, isComposing: false }), false)
  assert.equal(closesOnKey({ key: 'Escape', defaultPrevented: false, isComposing: true }), false)
  assert.equal(closesOnKey({ key: 'Enter', defaultPrevented: false, isComposing: false }), false)
})

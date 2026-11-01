import test from 'node:test'
import assert from 'node:assert/strict'
import { figureColors, figureMood, luma, mix, sidebarFigure, tintOf } from './bot-figure.mjs'

test('colors mix channel by channel and luma orders black below white', () => {
  assert.equal(mix('#000000', '#ffffff', 0.5), '#808080')
  assert.equal(mix('#4361ee', '#4361ee', 0.3), '#4361ee')
  assert.ok(luma('#22252e') < 0.2 && luma('#e8833a') > 0.2)
})

test('a near-black body takes the theme accent and a navy screen; a colored body tints its own parts', () => {
  const pipi = figureColors('#22252e')
  assert.equal(pipi.dark, true)
  assert.equal(pipi.accent, null)
  const orange = figureColors('#e8833a')
  assert.equal(orange.dark, false)
  assert.match(orange.accent, /^#[0-9a-f]{6}$/)
  for (const value of [orange.light, orange.deep, orange.rod, orange.screen]) assert.match(value, /^#[0-9a-f]{6}$/)
  assert.ok(luma(orange.screen) < luma('#e8833a'), 'the screen is darker than the body so white eyes read')
  assert.equal(tintOf('#22252e'), 'var(--c-accent)')
  assert.equal(tintOf('#e8833a'), '#e8833a')
})

test('run states map onto figure motion; the sidebar only animates rows worth a glance', () => {
  assert.equal(figureMood('limited'), 'error')
  assert.equal(figureMood('thinking'), 'thinking')
  assert.equal(figureMood('nope'), 'idle')
  for (const mood of ['thinking', 'working', 'waiting', 'error', 'resting']) assert.equal(sidebarFigure(mood), mood)
  assert.equal(sidebarFigure('limited'), 'error')
  for (const mood of ['idle', 'done', 'greet']) assert.equal(sidebarFigure(mood), undefined)
})

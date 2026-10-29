import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const board = await readFile(new URL('./CalendarBoard.tsx', import.meta.url), 'utf8')
const css = await readFile(new URL('./calendar.css', import.meta.url), 'utf8')

test('calendar modal reuses T05 focus trap, Escape stack and explicit opener return rather than a second Escape listener', () => {
  assert.match(board, /import \{ useDrawer \} from '\.\/useDrawer'/)
  assert.match(board, /useDrawer\(dialog, \{ open: dialogOpen, modal: true,.*returnFocus: opener/)
  assert.match(board, /ref=\{dialog\} tabIndex=\{-1\} role="dialog" aria-modal="true"/)
  assert.doesNotMatch(board, /e\.key === 'Escape'/)
  assert.match(board, /rememberOpener\(\)/)
})

test('calendar hides background from keyboard and keeps replaced dialog controls focused', () => {
  assert.match(board, /className="cal-main" inert=\{Boolean\(pop\)\}/)
  assert.match(board, /!dialog\.current\.contains\(document\.activeElement\)\) dialog\.current\.focus/)
  assert.match(board, /\[dialogOpen, dialogKind\]/)
  assert.match(board, /\{active && popover\(\)\}/)
  assert.match(board, /hidden=\{!panes\.calendar\}/)
  assert.match(board, /hidden=\{!panes\.todos\}/)
})

test('calendar phone controls retain 44px targets and respect reduced-motion without global styling changes', () => {
  assert.match(css, /\.cal-toolbar \.cal-btn, \.cal-toolbar \.cal-mode, \.cal-pop \.cal-btn, \.cal-link, \.cal-more \{ min-height:44px; min-width:44px;/)
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/)
  assert.match(css, /\.cal \*, \.cal \*::before, \.cal \*::after \{ animation:none !important; transition:none !important; scroll-behavior:auto !important;/)
})

test('calendar disabled fields are excluded individually from the shared focus selector during uncertain writes', () => {
  assert.equal((board.match(/<input disabled=\{busy \|\| unconfirmed\}/g) ?? []).length, 3)
  assert.match(board, /<textarea disabled=\{busy \|\| unconfirmed\}/)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { findMentionToken, buildMentionCandidates, applyMention, reconcileMentions, mentionTargetIds } from './mentions.mjs'
import { buildCommands, isCommandDraft, matchCommands, suggestionKeyAction } from './commands.mjs'

const bots = [
  { id: 'calendar', name: '日程助理', description: '检查会议和行程', status: 'active' },
  { id: 'todo', name: '待办助理', description: '整理任务', status: 'active' },
  { id: 'chief', name: 'Chief', description: '协调所有助理' },
  { id: 'foreign', name: '群外助理', description: '尚未加入群', status: 'active' },
  { id: 'inactive', name: '已停用', status: 'inactive' },
  { id: 'deactivated', name: '已停用旧记录', deactivatedAt: '2026-10-29' },
]
const group = { kind: 'group', memberBotIds: ['calendar', 'todo', 'chief'] }
const direct = { kind: 'direct', currentBotId: 'calendar' }
const candidates = buildMentionCandidates(bots, group)
const calendar = candidates.find(item => item.botId === 'calendar')
const todo = candidates.find(item => item.botId === 'todo')
const pick = (draft, candidate = calendar, bindings = [], caret = draft.length) =>
  applyMention(draft, findMentionToken(draft, caret), candidate, { bindings })

test('caret-local ASCII/fullwidth @ opens at start or whitespace, including a newline', () => {
  for (const [draft, caret, expected] of [['@', 1, ''], ['请 @日', 4, '日'], ['前文\n＠待', 5, '待'], ['😀 @Chief', 9, 'Chief']]) {
    const token = findMentionToken(draft, caret)
    assert.ok(token, draft)
    assert.equal(token.query, expected)
    assert.equal(token.text, draft.slice(token.start, token.end))
  }
})

test('caret in the middle matches only the prefix but replaces the whole token', () => {
  assert.deepEqual(findMentionToken('前文 @Chiezzz 后文', 7), { start: 3, end: 11, query: 'Chi', text: '@Chiezzz', selectionStart: 7, selectionEnd: 7 })
})

test('invalid offsets, selection ranges and a caret outside a mention do not trigger', () => {
  for (const [draft, start, end] of [['@Chief', 0, 0], ['@Chief', -1, -1], ['@Chief', 7, 7], ['@Chief', 2.5, 2.5], ['@Chief', 1, 3], ['@Chief 后文', 9, 9], ['普通文本', 4, 4]]) {
    assert.equal(findMentionToken(draft, start, end), null, `${draft}:${start}:${end}`)
  }
})

test('e-mail, package handles, URLs and embedded @ are data rather than candidates', () => {
  for (const draft of ['name@example.com', 'name+tag@Chief', 'hello@Chief', 'https://example.test/@Chief', '(@Chief', '@@Chief', '@scope/package', '前文＠Chief']) {
    assert.equal(findMentionToken(draft, draft.length), null, draft)
  }
})

test('fenced and inline code do not trigger, even before a closing delimiter is typed', () => {
  for (const draft of ['` @Chief', '` @Chief `', '``code ` @Chief', '```js\n@Chief', '~~~\n@Chief', '````\n```\n@Chief']) {
    const caret = draft.indexOf('@Chief') + 6
    assert.equal(findMentionToken(draft, caret), null, draft)
  }
  assert.ok(findMentionToken('```js\ncode\n```\n@Chief', 21))
  assert.ok(findMentionToken('`code` @Chief', 13))
})

test('block quotes and quoted text stay data, while prose after a closed quote works', () => {
  for (const draft of ['> @Chief', '  > quoted @Chief', '" @Chief', '“ @Chief', '「 @Chief']) {
    assert.equal(findMentionToken(draft, draft.length), null, draft)
  }
  for (const draft of ['"quoted" @Chief', '“quoted” @Chief', '「quoted」 @Chief']) assert.ok(findMentionToken(draft, draft.length), draft)
})

test('slash trigger stays whole-draft and takes precedence over @ inside slash commands', () => {
  assert.ok(isCommandDraft('/'))
  assert.ok(isCommandDraft('/详情'))
  assert.equal(isCommandDraft('/ 有空格'), false)
  assert.equal(isCommandDraft('普通 /详情'), false)
  assert.equal(findMentionToken('/@Chief', 7), null)
})

test('all active Bots are visible, including nonmembers with a reason and no join action', () => {
  assert.deepEqual(candidates.map(item => item.botId), ['calendar', 'todo', 'chief', 'foreign'])
  const foreign = candidates.find(item => item.botId === 'foreign')
  assert.equal(foreign.action, 'unavailable')
  assert.match(foreign.disabled, /不是本群成员.*没有加入入口/)
  assert.equal(pick('@', foreign), null)
  assert.equal(candidates[0].hint, '检查会议和行程')
})

test('candidate filtering normalizes width/case and ranks name before id before description', () => {
  assert.deepEqual(buildMentionCandidates(bots, group, 'ＣＨＩＥＦ').map(item => item.botId), ['chief'])
  assert.deepEqual(buildMentionCandidates(bots, group, '会议').map(item => item.botId), ['calendar'])
  assert.deepEqual(buildMentionCandidates(bots, group, 'TOdo').map(item => item.botId), ['todo'])
  const ranked = buildMentionCandidates([{ id: 'hint', name: '其他', description: 'chief' }, { id: 'chief-id', name: '其他' }, { id: 'name', name: 'Chief' }], direct, 'chief')
  assert.deepEqual(ranked.map(item => item.botId), ['name', 'chief-id', 'hint'])
  assert.deepEqual(buildMentionCandidates(bots, group, '不存在'), [])
})

test('duplicate IDs collapse but duplicate display names retain distinct stable IDs', () => {
  const sameNames = [{ id: 'first', name: '同名', status: 'active' }, { id: 'second', name: '同名', status: 'active' }]
  const items = buildMentionCandidates([...sameNames, sameNames[0]], { kind: 'group', memberBotIds: ['first', 'second'] })
  assert.deepEqual(items.map(item => [item.id, item.label]), [['first', '同名'], ['second', '同名']])
  assert.deepEqual(pick('@同', items[1]).targetBotIds, ['second'])
})

test('private/primary chat selection is only a switch-bot payload with unsent draft', () => {
  const items = buildMentionCandidates(bots, direct)
  assert.equal(items.find(item => item.botId === 'calendar').action, 'mention')
  const other = items.find(item => item.botId === 'todo')
  const selected = pick('请 @待 帮忙', other, [], 4)
  assert.equal(selected.action, 'switch-bot')
  assert.equal(selected.botId, 'todo')
  assert.equal(selected.draft, '请 @待办助理 帮忙')
  assert.match(other.actionLabel, /不会自动发送/)
})

test('pick preserves both sides, replaces suffix at the caret and reports exact edit/caret', () => {
  const draft = '开头 @日旧后缀 尾部😀'
  const result = pick(draft, calendar, [], 5)
  assert.equal(result.draft, '开头 @日程助理 尾部😀')
  assert.deepEqual(result.replacement, { start: 3, end: 8, text: '@日程助理' })
  assert.equal(result.selectionStart, 9)
  assert.equal(result.selectionEnd, 9)
  assert.deepEqual(result.binding, { botId: 'calendar', start: 3, end: 8, text: '@日程助理' })
})

test('punctuation and fullwidth @ are preserved correctly, and final mentions get one space', () => {
  const draft = '请 ＠日，看看'
  const result = pick(draft, calendar, [], 4)
  assert.equal(result.draft, '请 @日程助理，看看')
  assert.equal(result.selectionStart, 7)
  assert.equal(pick('@').draft, '@日程助理 ')
  assert.equal(pick('@日 后文', calendar, [], 2).draft, '@日程助理 后文')
})

test('stale tokens, disabled targets and maxLength overflow cannot produce a pick', () => {
  const token = findMentionToken('@日', 2)
  assert.equal(applyMention('@待', token, calendar), null)
  assert.equal(applyMention('@日', token, { ...calendar, disabled: '不可用' }), null)
  assert.equal(applyMention('@日', token, calendar, { maxLength: 5 }), null)
  assert.equal(applyMention('@日', token, calendar, { maxLength: 6 }).draft, '@日程助理 ')
})

test('multiple selected mentions retain body order and deduplicate by botId rather than name', () => {
  const first = pick('@', calendar)
  const secondDraft = `${first.draft}@`
  const second = pick(secondDraft, todo, reconcileMentions(first.draft, secondDraft, first.bindings))
  const thirdDraft = `${second.draft}@`
  const third = pick(thirdDraft, calendar, reconcileMentions(second.draft, thirdDraft, second.bindings))
  assert.equal(third.draft, '@日程助理 @待办助理 @日程助理 ')
  assert.deepEqual(third.targetBotIds, ['calendar', 'todo'])
  assert.deepEqual(mentionTargetIds(third.draft, [...third.bindings].reverse()), ['calendar', 'todo'])
})

test('manually typed @names never become structured bot IDs', () => {
  assert.deepEqual(mentionTargetIds('@日程助理 @待办助理', []), [])
  const result = pick('@日程助理 @', todo)
  assert.deepEqual(result.targetBotIds, ['todo'])
})

test('selection IDs survive harmless edits before/after a bound mention', () => {
  const result = pick('@')
  const before = `😀 前文 ${result.draft}`
  const moved = reconcileMentions(result.draft, before, result.bindings)
  assert.equal(moved[0].start, 6)
  assert.deepEqual(mentionTargetIds(before, moved), ['calendar'])
  const after = `${before}后文`
  assert.deepEqual(mentionTargetIds(after, reconcileMentions(before, after, moved)), ['calendar'])
  assert.deepEqual(reconcileMentions(result.draft, result.draft, result.bindings), result.bindings)
})

test('deleting or altering a chosen mention invalidates only its own binding', () => {
  const first = pick('@', calendar)
  const draft = `${first.draft}@`
  const result = pick(draft, todo, reconcileMentions(first.draft, draft, first.bindings))
  const next = result.draft.replace('@日程助理 ', '')
  assert.deepEqual(mentionTargetIds(next, reconcileMentions(result.draft, next, result.bindings)), ['todo'])
  const changed = result.draft.replace('日程', '会议')
  assert.deepEqual(mentionTargetIds(changed, reconcileMentions(result.draft, changed, result.bindings)), ['todo'])
})

test('concatenation and moving a bound name inside code/quotes removes routing authority', () => {
  const result = pick('@')
  for (const next of [`前缀${result.draft}`, result.draft.replace(' ', '新后缀'), `\` ${result.draft}`, `> ${result.draft}`, `" ${result.draft}`]) {
    assert.deepEqual(reconcileMentions(result.draft, next, result.bindings), [], next)
  }
})

test('ambiguous same-name deletion drops bindings instead of keeping the wrong botId', () => {
  const previous = '@同名 @同名 '
  const bindings = [{ botId: 'first', start: 0, end: 3, text: '@同名' }, { botId: 'second', start: 4, end: 7, text: '@同名' }]
  assert.deepEqual(reconcileMentions(previous, '@同名 ', bindings), [])
})

test('invalid or stale spans cannot contribute a target', () => {
  assert.deepEqual(mentionTargetIds('@日程助理 ', [{ botId: 'calendar', start: 0, end: 6, text: '@日程助理' }]), [])
  assert.deepEqual(mentionTargetIds('@日程助理 ', [{ botId: 'calendar', start: -1, end: 5, text: '@日程助理' }]), [])
})

test('shared keyboard wraps in either direction and supports Enter, Tab and Escape', () => {
  assert.deepEqual(suggestionKeyAction({ key: 'ArrowDown' }, 2, 3), { type: 'move', index: 0 })
  assert.deepEqual(suggestionKeyAction({ key: 'ArrowUp' }, 0, 3), { type: 'move', index: 2 })
  for (const key of ['Enter', 'Tab']) assert.deepEqual(suggestionKeyAction({ key }, 1, 3), { type: 'pick', index: 1 })
  assert.deepEqual(suggestionKeyAction({ key: 'Escape' }, 0, 0), { type: 'dismiss' })
  assert.equal(suggestionKeyAction({ key: 'Enter' }, 0, 0), null)
})

test('IME Enter/229 and modified/prevented keys stay with the textarea', () => {
  for (const event of [{ key: 'Enter', isComposing: true }, { key: 'Enter', keyCode: 229 }, { key: 'ArrowDown', isComposing: true },
    { key: 'Enter', ctrlKey: true }, { key: 'Enter', metaKey: true }, { key: 'Tab', shiftKey: true }, { key: 'ArrowDown', altKey: true }, { key: 'Enter', defaultPrevented: true }]) {
    assert.equal(suggestionKeyAction(event, 0, 3), null)
  }
})

test('existing slash Skill/actions ordering, filtering and unavailable hints remain compatible', () => {
  const skills = [{ id: 'review', name: '日程复盘', description: '核对详情', available: true }, { id: 'missing', name: '缺依赖', available: false }]
  const all = buildCommands({ skills })
  assert.deepEqual(all.map(item => item.id), ['skill:review', 'skill:missing', 'new-task', 'pane', 'pause', 'new-bot', 'details'])
  assert.equal(all[1].disabled, '暂时不能用')
  assert.deepEqual(matchCommands(all, '/详情').map(item => item.id), ['details', 'skill:review'])
  assert.deepEqual(buildCommands({ skills, group: true, paused: true }).map(item => item.id), ['pane', 'new-bot', 'details'])
  assert.deepEqual(matchCommands(all, '请 /详情'), [])
})

test('both wrappers use one shared keyboard surface and the mention wrapper cannot send or join', async () => {
  const [commands, mentions, shared, css] = await Promise.all(['CommandMenu.tsx', 'MentionMenu.tsx', 'ComposerSuggestions.tsx', 'composer-suggestions.css']
    .map(file => readFile(new URL(file, import.meta.url), 'utf8')))
  for (const wrapper of [commands, mentions]) {
    assert.match(wrapper, /import ComposerSuggestions from '\.\/ComposerSuggestions'/)
    assert.doesNotMatch(wrapper, /addEventListener\('keydown'/)
  }
  assert.doesNotMatch(mentions, /\bfetch\s*\(|\.submit\s*\(|\.requestSubmit\s*\(|window\.location|history\.(pushState|replaceState)/)
  assert.match(mentions, /if \(pick\) onPick\(pick\)/)
  assert.match(shared, /compositionstart/)
  assert.match(shared, /event\.stopPropagation\(\)/)
  assert.match(shared, /aria-activedescendant/)
  assert.match(shared, /scrollIntoView/)
  assert.match(shared, /onMouseDown=\{event => event.preventDefault\(\)\}/)
  assert.match(css, /overflow-y: auto/)
  assert.match(css, /@media \(max-width: 480px\)/)
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BOT_MEMORY_LIMITS } from './bot-memory.mjs'
import { MEMORY_FILE_HEADER, MEMORY_FILE_MAX_BYTES, diffMemoryFile, fileItemId, parseMemoryFile, renderMemoryFile, sameMemoryContent } from './memory-file-format.mjs'

const item = (id, content, createdAt = '2026-10-30T00:00:00.000Z') => ({ id, content, sourceEntries: [], createdAt, updatedAt: createdAt })
const parsed = (kind, text) => { const result = parseMemoryFile(kind, text); assert.equal(result.ok, true, JSON.stringify(result)); return result.value }
const ids = value => value.items.map(entry => entry.id)

test('R2-02 render then parse returns the ledger exactly: multi-line, Chinese, blank inner lines, auto and hand ids', () => {
  const doc = { items: [
    item('auto-3f9a', '回答用中文，先给结论', '2026-10-30T00:00:01.000Z'),
    item(fileItemId('我在杭州工作'), '我在杭州工作', '2026-10-30T00:00:02.000Z'),
    item('multi', '第一行\n  缩进的第二行\n\n- 看起来像列表的第三行\n# 也不是标题', '2026-10-30T00:00:03.000Z'),
    item('tricky', '内容自己以注释结尾 <!-- id:fake -->', '2026-10-30T00:00:04.000Z'),
    item(fileItemId('尾巴 <!-- id:bar -->'), '尾巴 <!-- id:bar -->', '2026-10-30T00:00:05.000Z'),
    item('ws', '中间有空白行\n   \n结束', '2026-10-30T00:00:06.000Z'),
  ] }
  for (const kind of ['memory', 'preferences']) {
    const text = renderMemoryFile(kind, doc)
    assert.ok(text.startsWith(`${MEMORY_FILE_HEADER}\n- 回答用中文`))
    assert.ok(text.endsWith('\n'))
    assert.ok(text.includes('- 我在杭州工作\n'), 'derived ids are not written back into the file')
    assert.deepEqual(parsed(kind, text).items, doc.items.map(({ id, content }) => ({ id, content })))
    assert.equal(sameMemoryContent(kind, parsed(kind, text), doc), true)
  }
})

test('R2-02 same ledger version always yields the same bytes, independent of item order', () => {
  const items = [item('b', '乙', '2026-10-30T00:00:01.000Z'), item('a', '甲', '2026-10-30T00:00:01.000Z'), item('c', '丙', '2026-10-30T00:00:00.000Z')]
  const once = renderMemoryFile('memory', { items })
  assert.equal(renderMemoryFile('memory', { items: [...items].reverse() }), once)
  assert.deepEqual(ids(parsed('memory', once)), ['c', 'a', 'b'])
  assert.equal(renderMemoryFile('memory', { items: [] }), `${MEMORY_FILE_HEADER}\n`)
  assert.equal(renderMemoryFile('personality', { content: '温暖' }), '温暖\n')
  assert.equal(renderMemoryFile('personality', { content: '' }), '')
})

test('R2-02 hand-written lines: stable content ids, whitespace trimmed, headings/comments/blank lines ignored, CRLF and BOM tolerated', () => {
  const text = '﻿# 我的记忆\r\n\r\n<!-- 随手写的注释 -->\r\n-   前后有空白   \r\n* 星号开头也算一条\r\n纯文本一行\r\n-\r\n- 带编号 <!-- id:keep.me:1 -->  \r\n'
  const value = parsed('memory', text)
  assert.deepEqual(value.items.map(entry => entry.content), ['前后有空白', '* 星号开头也算一条', '纯文本一行', '带编号'])
  assert.equal(value.items[0].id, fileItemId('前后有空白'))
  assert.equal(value.items[3].id, 'keep.me:1')
  assert.deepEqual(parsed('memory', text), value, 'parsing is deterministic')
  assert.deepEqual(parsed('memory', '').items, [])
  assert.deepEqual(parsed('memory', `${MEMORY_FILE_HEADER}\n\n<!-- a -->\n## 标题\n`).items, [])
  assert.deepEqual(parsed('memory', '#话题标签不是标题').items.map(entry => entry.content), ['#话题标签不是标题'])
})

test('R2-02 wrong and duplicate ids resolve deterministically without losing distinct content', () => {
  const text = ['- 甲 <!-- id:same -->', '- 甲 <!-- id:same -->', '- 乙 <!-- id:same -->', '- 丙 <!-- id:../bad -->', '- 丁 <!-- id: -->', '- 戊 <!-- id:has space -->', '- 甲'].join('\n')
  const value = parsed('preferences', text)
  assert.deepEqual(value.items, [
    { id: 'same', content: '甲' },
    { id: fileItemId('乙'), content: '乙' },
    { id: fileItemId('丙'), content: '丙' },
    { id: fileItemId('丁'), content: '丁' },
    { id: fileItemId('戊 <!-- id:has space -->'), content: '戊 <!-- id:has space -->' },
    { id: fileItemId('甲'), content: '甲' },
  ])
  assert.deepEqual(parsed('preferences', text), value)
  const clash = parsed('memory', [`- 乙 <!-- id:${fileItemId('甲')} -->`, '- 甲'].join('\n'))
  assert.deepEqual(clash.items.map(entry => entry.content), ['乙', '甲'])
  assert.equal(new Set(ids(clash)).size, 2)
})

test('R2-02 limits reuse BOT_MEMORY_LIMITS and map to MEMORY_FILE_TOO_LONG; bad encoding is MEMORY_FILE_INVALID', () => {
  const lines = count => Array.from({ length: count }, (_, i) => `- 条目${i}`).join('\n')
  assert.equal(parsed('memory', lines(BOT_MEMORY_LIMITS.items)).items.length, BOT_MEMORY_LIMITS.items)
  assert.deepEqual(parseMemoryFile('memory', lines(BOT_MEMORY_LIMITS.items + 1)), { ok: false, code: 'MEMORY_FILE_TOO_LONG' })
  assert.deepEqual(parseMemoryFile('memory', `- ${'长'.repeat(BOT_MEMORY_LIMITS.contentChars + 1)}`), { ok: false, code: 'MEMORY_FILE_TOO_LONG' })
  assert.deepEqual(parseMemoryFile('memory', Array.from({ length: 9 }, (_, i) => `- ${i}${'字'.repeat(2000)}`).join('\n')), { ok: false, code: 'MEMORY_FILE_TOO_LONG' })
  assert.equal(parsed('personality', '人'.repeat(BOT_MEMORY_LIMITS.personalityChars)).content.length, BOT_MEMORY_LIMITS.personalityChars)
  assert.deepEqual(parseMemoryFile('personality', '人'.repeat(BOT_MEMORY_LIMITS.personalityChars + 1)), { ok: false, code: 'MEMORY_FILE_TOO_LONG' })
  assert.deepEqual(parseMemoryFile('memory', Buffer.alloc(MEMORY_FILE_MAX_BYTES + 1, 0x20)), { ok: false, code: 'MEMORY_FILE_TOO_LONG' })
  assert.deepEqual(parseMemoryFile('memory', Buffer.from([0x2d, 0x20, 0xff, 0xfe, 0x0a])), { ok: false, code: 'MEMORY_FILE_INVALID' })
  assert.equal(parsed('memory', Buffer.from('- 字节输入\n')).items[0].content, '字节输入')
  assert.equal(parsed('memory', `- sk-${'a'.repeat(20)} 也照常导入`).items.length, 1, 'credential-shaped text is not a format failure')
  const started = Date.now()
  assert.equal(parseMemoryFile('memory', `- a${' '.repeat(200000)}b`).ok, false)
  assert.ok(Date.now() - started < 1000, 'pathological whitespace is linear')
})

test('R2-02 personality: whole trimmed text, empty clears; diff emits one set or nothing', () => {
  assert.equal(parsed('personality', '\n  温暖、直接\n第二行  \n').content, '温暖、直接\n第二行')
  assert.equal(parsed('personality', ' \n\t').content, '')
  assert.deepEqual(diffMemoryFile('personality', { content: '旧' }, { content: '旧' }), [])
  assert.deepEqual(diffMemoryFile('personality', { content: '旧' }, { content: '' }), [{ action: 'set', content: '' }])
  assert.deepEqual(diffMemoryFile('personality', null, { content: '新' }), [{ action: 'set', content: '新' }])
})

test('R2-02 diff by id: deletes and updates in base order, then adds in file order; empty base only adds', () => {
  const base = { items: [item('a', '甲'), item('b', '乙'), item('c', '丙')] }
  const theirs = { items: [{ id: 'z', content: '新增' }, { id: 'c', content: '丙改' }, { id: 'a', content: '甲' }, { id: 'y', content: '又一条' }] }
  assert.deepEqual(diffMemoryFile('memory', base, theirs), [
    { action: 'delete', id: 'b' }, { action: 'update', id: 'c', content: '丙改' },
    { action: 'add', id: 'z', content: '新增' }, { action: 'add', id: 'y', content: '又一条' },
  ])
  assert.deepEqual(diffMemoryFile('memory', { items: [] }, theirs).map(patch => patch.action), ['add', 'add', 'add', 'add'])
  assert.deepEqual(diffMemoryFile('memory', base, { items: base.items.map(({ id, content }) => ({ id, content })) }), [])
})

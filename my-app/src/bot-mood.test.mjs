import test from 'node:test'
import assert from 'node:assert/strict'
import { moodFrames, refineMood } from './bot-mood.mjs'

const MOODS = ['idle', 'thinking', 'working', 'waiting', 'done', 'error', 'limited', 'resting', 'greet']

test('every mood is the ω face, and animated moods keep one width and a positive frame time', () => {
  for (const mood of MOODS) {
    const frames = moodFrames(mood)
    assert.ok(frames.length > 0, mood)
    for (const [face] of frames) assert.match(face, /ω/, mood)
    if (frames.length > 1) {
      assert.equal(new Set(frames.map(([face]) => face.length)).size, 1, `${mood} frames differ in width`)
      for (const [, ms] of frames) assert.ok(ms > 0, mood)
    }
  }
  assert.deepEqual(moodFrames('nope'), moodFrames('idle'))
})

test('a busy bot works while its last turn calls a tool and thinks otherwise', () => {
  const toolTurn = { role: 'assistant', assistant: { content: [{ type: 'text' }, { type: 'toolCall' }] } }
  assert.equal(refineMood('thinking', toolTurn), 'working')
  assert.equal(refineMood('thinking', { role: 'tool' }), 'thinking')
  assert.equal(refineMood('thinking', { role: 'assistant', assistant: { content: [{ type: 'text' }] } }), 'thinking')
  assert.equal(refineMood('thinking', undefined), 'thinking')
  assert.equal(refineMood('waiting', toolTurn), 'waiting')
})

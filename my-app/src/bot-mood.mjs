// Run-state faces shared by every bot. One ω face; only the eyes and small gestures change.
// Each mood is a list of [face, milliseconds] frames. All frames of a mood are the same width,
// so cycling them never moves the text around the face.
const FRAMES = {
  idle: [['(・ω・)', 3200], ['(－ω－)', 140], ['(・ω・)', 220], ['(－ω－)', 140]],
  thinking: [['( ・ω・)…', 700], ['(・ω・ )…', 700]],
  working: [['(｀・ω・´)ノ', 360], ['ヽ(｀・ω・´)', 360]],
  waiting: [['(・ω・)？', 0]],
  done: [['(＾ω＾)', 0]],
  error: [['(；ω；)', 0]],
  limited: [['(×ω×)', 0]],
  resting: [['(－ω－) zZ ', 1100], ['(－ω－) zZz', 1100]],
  greet: [['(・ω・)ノ', 520], ['(・ω・)ﾉ', 520], ['(・ω・)ノ', 520], ['(・ω・)ﾉ', 1600], ['(－ω－)ノ', 160]],
}

/** Frames for a mood; unknown moods show the idle face. */
export function moodFrames(mood) {
  return FRAMES[mood] ?? FRAMES.idle
}

/** A busy bot is "working" while its last turn asked for a tool, and "thinking" otherwise. */
export function refineMood(mood, last) {
  if (mood !== 'thinking') return mood
  return last?.role === 'assistant' && last.assistant?.content?.some(block => block.type === 'toolCall') ? 'working' : 'thinking'
}

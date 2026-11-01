export type Mood = 'idle' | 'thinking' | 'working' | 'waiting' | 'done' | 'error' | 'limited' | 'resting' | 'greet'
export function moodFrames(mood: Mood): [string, number][]
export function refineMood(mood: Mood, last?: { role?: string; assistant?: { content?: { type?: string }[] } }): Mood

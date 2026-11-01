export type QuestionOption = { id: string; label: string; description?: string }
export type Question = { id: string; question: string; type: 'text' | 'single' | 'multiple'; options?: QuestionOption[]; required?: boolean; defaultAnswer?: string }
export type QuestionAnswer = string | { optionId: string; other?: string } | { optionIds: string[]; other?: string }
export type QuestionAnswers = Record<string, QuestionAnswer>
export function validQuestions(questions: unknown): questions is Question[]
export function questionsFor(item: { question: string; questions?: Question[] }): Question[]
export function validateAnswers(questions: Question[], answers: unknown): { ok: false; error: string } | { ok: true; answers: QuestionAnswers; answer: string }
export function canSkipQuestions(questions: Question[]): boolean
export function questionDraftKey(botId: string, taskId: number, item: {id: number; version?: number}): string

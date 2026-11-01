const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,60}$/.test(value)

export function validQuestions(questions) {
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > 3) return false
  const ids = new Set()
  return questions.every(item => {
    if (!object(item) || Object.keys(item).some(key => !['id', 'question', 'type', 'options', 'required', 'defaultAnswer'].includes(key)) || !identifier(item.id) || ids.has(item.id) || !text(item.question, 1000) || !['text', 'single', 'multiple'].includes(item.type) || item.required !== undefined && typeof item.required !== 'boolean' || item.defaultAnswer !== undefined && !text(item.defaultAnswer, 1000)) return false
    ids.add(item.id)
    if (item.required === false && !text(item.defaultAnswer, 1000)) return false
    if (item.type === 'text') return item.options === undefined
    if (!Array.isArray(item.options) || item.options.length < 2 || item.options.length > 6) return false
    const options = new Set()
    return item.options.every(option => {
      if (!object(option) || Object.keys(option).some(key => !['id', 'label', 'description'].includes(key)) || !identifier(option.id) || option.id === 'other' || options.has(option.id) || !text(option.label, 200) || option.description !== undefined && !text(option.description, 500)) return false
      options.add(option.id)
      return true
    })
  })
}

export function questionsFor(item) {
  if (validQuestions(item.questions)) return item.questions.map(question => ({ ...question, required: question.required !== false }))
  return [{ id: 'answer', question: item.question, type: 'text', required: true }]
}

export function validateAnswers(questions, answers) {
  if (!object(answers) || Object.keys(answers).some(key => !questions.some(question => question.id === key))) return { ok: false, error: '回答与当前问题不匹配。' }
  const normalized = {}, summaries = []
  for (const question of questions) {
    const value = answers[question.id]
    const blank = value === undefined || typeof value === 'string' && !value.trim() || question.type === 'multiple' && object(value) && Array.isArray(value.optionIds) && value.optionIds.length === 0 && !value.other || question.type === 'single' && object(value) && value.optionId === '' && !value.other
    if (blank && question.required === false) { summaries.push(`${question.question}：使用默认方案（${question.defaultAnswer}）`); continue }
    let summary
    if (question.type === 'text') {
      if (!text(value, 4000)) return { ok: false, error: `请填写「${question.question}」（最多 4000 字）。` }
      normalized[question.id] = value.trim()
      summary = value.trim()
    } else {
      const multiple = question.type === 'multiple'
      if (!object(value) || Object.keys(value).some(key => !(multiple ? ['optionIds', 'other'] : ['optionId', 'other']).includes(key))) return { ok: false, error: `请选择「${question.question}」的答案。` }
      const selected = multiple ? value.optionIds : [value.optionId]
      if (!Array.isArray(selected) || selected.length < 1 || selected.length > (question.options?.length ?? 0) + 1 || new Set(selected).size !== selected.length || selected.some(id => id !== 'other' && !question.options?.some(option => option.id === id))) return { ok: false, error: `请选择「${question.question}」的有效选项。` }
      if (selected.includes('other') && !text(value.other, 4000)) return { ok: false, error: `请补充「${question.question}」的填写内容。` }
      if (!selected.includes('other') && value.other !== undefined && value.other !== '') return { ok: false, error: '自己填写的内容需要同时选中「自己填写」。' }
      normalized[question.id] = multiple ? { optionIds: [...selected], ...(selected.includes('other') ? { other: value.other.trim() } : {}) } : { optionId: selected[0], ...(selected[0] === 'other' ? { other: value.other.trim() } : {}) }
      summary = selected.map(id => id === 'other' ? `自己填写：${value.other.trim()}` : question.options.find(option => option.id === id).label).join('；')
    }
    summaries.push(questions.length === 1 ? summary : `${question.question}：${summary}`)
  }
  const answer = summaries.join('\n')
  if (answer.length > 4000) return { ok: false, error: '回答总长度不能超过 4000 字，请精简后提交。' }
  return { ok: true, answers: normalized, answer }
}

export function canSkipQuestions(questions) { return questions.length > 0 && questions.every(question => question.required === false && text(question.defaultAnswer, 1000)) }
export function questionDraftKey(botId, taskId, item) { return `pidot:question:${botId}:${taskId}:${item.id}:${item.version ?? 1}` }

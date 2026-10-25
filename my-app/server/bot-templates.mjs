// PLAN §8.6 / P-18: a Bot created with only a name gets its role and duties from fixed keyword
// templates. No model call; the same name always yields the same result (T6-02). The first match
// in table order wins, so specific duties come before the generic "助理" row.
const TEMPLATES = [
  { keys: ['日程', '日历', '会议', '行程', 'calendar', 'schedule'], role: '日程管理', description: '查看我的日程，找出冲突和空档，帮我安排、调整会议和行程。' },
  { keys: ['待办', '任务', '清单', 'todo'], role: '待办管理', description: '整理我的待办，按到期时间排好优先级，提醒快到期和已逾期的事。' },
  { keys: ['费用', '报销', '账单', '记账', '财务', '预算', 'expense'], role: '财务助理', description: '整理我提供的消费记录，按类别汇总并标出异常。' },
  { keys: ['周报', '日报', '月报', '汇报', '总结', 'report'], role: '汇报助理', description: '根据我的日程和待办整理日报、周报，列出完成的事和接下来的安排。' },
  { keys: ['笔记', '记录', '备忘', '资料', 'note'], role: '笔记助理', description: '帮我记录和整理要点，需要时找出相关内容。' },
  { keys: ['bug', '测试', '复现', 'qa'], role: '测试助理', description: '根据我描述的问题，整理复现步骤、预期与实际结果。' },
  { keys: ['写作', '文案', '翻译', '润色', '邮件', 'writer'], role: '写作助理', description: '帮我起草、润色和翻译文字，按我的要求调整语气和长度。' },
  { keys: ['出差', '差旅', '机票', '酒店', 'travel'], role: '差旅助理', description: '帮我整理出差行程、机票酒店和相关待办，提醒出发前要办的事。' },
  { keys: ['助理', '助手', '管家', '秘书', 'assistant'], role: '日常助理', description: '每天帮我看日程和待办，提醒冲突和快到期的事，处理我交代的日常事务。' },
]
const FALLBACK = { role: '通用助手', description: '按我的要求处理交代的事；需要我的日程或待办时先查看，信息不够时先问我。' }

/** Deterministic role and duties for a Bot name (NFKC, case-insensitive substring match). */
export function inferBotRole(name) {
  const key = String(name ?? '').normalize('NFKC').trim().toLowerCase()
  const hit = TEMPLATES.find(t => t.keys.some(k => key.includes(k)))
  return { role: (hit ?? FALLBACK).role, description: (hit ?? FALLBACK).description, template: hit ? hit.keys[0] : 'fallback' }
}

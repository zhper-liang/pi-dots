import { listBots } from '../bots.mjs'
import { TaskProgress } from '../continuous-task.mjs'
import { createHash } from 'node:crypto'

export function continuousWorkFixture() {
  const bots = listBots({ baseUrl: 'https://fixture.invalid/v1', model: 'fixture', apiKey: 'fixture-only' })
  const bot = bots.find(bot => bot.id === 'chief')
  const card = { taskId: 1, conversationId: 2, bot, configRef: bot.configRef, kind: 'chat',
    parameters: { tools: [], toolResources: [], model: { id: 'fixture' } },
    executionPolicy: { kind: 'continuous', rootTaskId: 1, rootInputId: 10 },
    taskState: { goal: '写一份有出处的调研报告', completionCriteria: ['提供可回查出处', '交付内容完整的报告'], constraints: ['不修改外部业务记录'], goalRevision: 1 } }
  const progress = { schemaVersion: 1, controlVersion: 1, goalRevision: 1, planRevision: 1, currentStepId: 'draft',
    steps: [{ stepId: 'draft', kind: 'execute', title: '完成报告', deliverable: '报告文件', verification: '核对出处与文档质量',
      dependsOn: [], criteriaIndices: [0, 1], planRevision: 1, goalRevision: 1, status: 'active', submissionRevision: 0, evidenceRefs: [] }],
    evidenceRefs: [], decisionHistory: [], stall: {}, retry: null, controlIntent: null, pendingGoalRevision: null, finalOutcome: null }
  const access = { assignments: { chief: { tools: ['calendar_read_schedule'], resources: ['mock:personal'] } }, revoked: {} }
  const docs = new Map([[TaskProgress.definition.kind, progress], ['pidot.tool-access', access], ['pidot.bot-directory', { items: bots }],
    ['pidot.task-approvals', { items: [] }], ['pidot.task-blockers', { items: [] }], ['pidot.collaboration', { items: [] }]])
  const entries = [{ id: 10, conversationId: 2, byTaskId: 1, kind: 'pidot.user', data: { content: card.taskState.goal, createdAt: '2026-11-02T00:00:00Z' } }]
  const tx = {
    async doc(type) { const kind = type.definition.kind; if (!docs.has(kind)) docs.set(kind, { items: [], artifacts: {} }); return docs.get(kind) },
    async entry(id) { return entries.find(entry => entry.id === id) },
    async conversation() { return { owner: { taskId: 1 } } },
    async task(id) { return { id, input: { botId: 'chief' }, state: { status: 'running' } } },
    async scanEntries() { return { items: entries } },
    async appendEntry(conversationId, value) { const entry = { id: Math.max(...entries.map(entry => entry.id)) + 1, byTaskId: 1, conversationId, ...structuredClone(value) }; entries.push(entry); return entry },
  }
  function receipt(toolName = 'write', args = { path: 'report.md', content: '有出处的报告' }, result = { ok: true, data: { bytesWritten: 18 } }, extra = {}) {
    const id = Math.max(...entries.map(entry => entry.id)) + 1
    const entry = { id, byTaskId: 1, conversationId: 2, kind: 'pidot.tool-result', data: { toolName, arguments: args, result,
      callId: `call-${id}`, turnId: id - 1, inReplyTo: 10, createdAt: '2026-11-02T00:00:00Z',
      continuousBinding: { rootTaskId: 1, rootInputId: 10, goalRevision: 1, planRevision: progress.planRevision, stepId: progress.currentStepId, submissionRevision: 0 }, ...extra } }
    entries.push(entry)
    return { taskId: 1, entryId: id }
  }
  function confirmArtifact(ref) {
    const source = entries.find(entry => entry.id === ref.entryId), content = source.data.arguments.content
    return receipt('read', { path: source.data.arguments.path }, { ok: true, data: { content, offset: 0, nextOffset: null,
      totalCharacters: Array.from(content).length, sha256: createHash('sha256').update(content).digest('hex') } })
  }
  return { tx, bots, card, progress, docs, entries, access, receipt, confirmArtifact }
}

import { createHash } from 'node:crypto'

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const fail = (code, message) => { throw Object.assign(new Error(message), { code }) }
const secret = /(?:\b(?:sk|ghp|github_pat)-[A-Za-z0-9_-]{16,}|\b(?:api[_-]?key|authorization|password|secret|token)\s*[:=]\s*\S{6,}|-----BEGIN .*PRIVATE KEY-----)/i

/** Host-only interface. Evidence and capabilities must be resolved from live durable records by
 * callbacks; this service is deliberately absent from model-facing skill_manage tools. */
export function createSkillLearningService({ userSkills, isEvidenceReadable, getCapabilities, getSecrets = async () => [], assign } = {}) {
  if (!userSkills || typeof isEvidenceReadable !== 'function' || typeof getCapabilities !== 'function') throw new TypeError('Learning requires host evidence and capability validators')
  let pending = Promise.resolve()
  async function allowed(source, botId, tx) {
    return source?.kind === 'learned' && source.ownerBotId === botId && await isEvidenceReadable({ botId, evidence: JSON.parse(JSON.stringify(source.evidence)), tx, requireSuccess: true }) === true
  }
  async function publish(input) {
    const { botId, candidate, evidence, expectedVersion } = input
    if (typeof botId !== 'string' || !botId || !candidate || typeof candidate.methodKey !== 'string' || !candidate.methodKey.trim() || candidate.methodKey.length > 300 || !Array.isArray(evidence) || !evidence.length || evidence.length > 16) fail('SKILL_LEARNING_INVALID', '学习方法需要明确适用范围和成功验证证据。')
    const source = { kind: 'learned', ownerBotId: botId, methodKey: candidate.methodKey.trim(), evidence: structuredClone(evidence) }
    if (!await allowed(source, botId)) fail('SKILL_LEARNING_EVIDENCE_INVALID', '成功证据不存在、来源不可用或不属于该Bot。')
    for (const key of ['name', 'description', 'applicability', 'rules']) if (typeof candidate[key] !== 'string' || !candidate[key].trim()) fail('SKILL_LEARNING_INVALID', '方法缺少名称、说明、适用条件或步骤。')
    if (Object.keys(candidate).some(key => !['methodKey', 'name', 'description', 'applicability', 'rules', 'references', 'requiredTools', 'requiredResources'].includes(key))) fail('SKILL_LEARNING_INVALID', '学习接口不接受脚本、依赖或身份覆盖。')
    const serializedCandidate = JSON.stringify(candidate)
    const secrets = await getSecrets()
    if (secret.test(serializedCandidate) || secrets.some(value => typeof value === 'string' && value.length >= 6 && serializedCandidate.includes(value))) fail('SKILL_LEARNING_SECRET', '学习资料不能包含凭证。')
    const capabilities = await getCapabilities(botId)
    const tools = candidate.requiredTools ?? [], resources = candidate.requiredResources ?? []
    for (const [values, granted] of [[tools, capabilities.tools], [resources, capabilities.resources]]) if (!Array.isArray(values) || values.some(value => typeof value !== 'string' || !granted?.includes(value))) fail('SKILL_DEPENDENCY_MISSING', '学习产物不能增加现有能力。')
    const id = `learned-${hash([botId, source.methodKey]).slice(0, 40)}`
    const catalog = await userSkills.skillCatalog()
    const current = userSkills.skillRegistration ? await userSkills.skillRegistration(id) : catalog.skills.find(skill => skill.id === id)
    if (current?.removed) fail('SKILL_LEARNING_USER_CONFLICT', '用户已移除该方法，自动学习不能恢复。')
    if (current && (current.source?.kind !== 'learned' || current.source.ownerBotId !== botId || current.source.methodKey !== source.methodKey)) fail('SKILL_LEARNING_OWNER_CONFLICT', '不能覆盖其他来源的Skill。')
    if (current?.userRolledBack) fail('SKILL_LEARNING_USER_CONFLICT', '用户已回退该方法，自动学习保留当前选择。')
    const markdown = ['---', `name: ${id}`, `description: ${JSON.stringify(candidate.description)}`, `compatibility: ${JSON.stringify(candidate.applicability)}`, `required-tools: [${tools.map(value => JSON.stringify(value)).join(',')}]`, `required-resources: [${resources.map(value => JSON.stringify(value)).join(',')}]`, '---', candidate.rules].join('\n')
    const prepared = await userSkills.prepareLearnedSkill({ markdown, references: candidate.references ?? [], source })
    if (prepared.manifest.scripts.length) fail('SKILL_LEARNING_INVALID', '学习方法不能新增脚本。')
    if (current?.hash === prepared.hash) {
      if (assign) await assign({ botId, capabilityId: `skill:${id}` })
      return { ...current, capabilityId: `skill:${id}`, noChange: true }
    }
    if (expectedVersion !== undefined && expectedVersion !== (current?.hash ?? null)) fail('SKILL_REVISION_CONFLICT', '学习Skill已更新，保留当前版本。')
    if (current && expectedVersion === undefined) fail('SKILL_REVISION_CONFLICT', '更新学习Skill需要现有固定版本。')
    if (!await allowed(source, botId)) fail('SKILL_LEARNING_EVIDENCE_INVALID', '发布前来源已失效。')
    const requestId = `learn-${hash([id, prepared.hash, catalog.revision]).slice(0, 60)}`
    const result = await userSkills[current ? 'updateSkill' : 'importSkill']({ requestId, preparedId: prepared.preparedId, expectedRevision: catalog.revision, ...(current ? { skillId: id } : {}) })
    // Registration is durable before optional assignment. A retry can safely finish assignment.
    if (assign) await assign({ botId, capabilityId: result.capabilityId })
    return result
  }
  return {
    ...userSkills,
    publish: input => { const result = pending.then(() => publish(input)); pending = result.catch(() => {}); return result },
    async assertLearningAccess({ source, botId, tx }) { if (!await allowed(source, botId, tx)) fail('SKILL_LEARNING_SOURCE_UNAVAILABLE', '学习来源已失效或不属于当前Bot。') },
    async skillCatalog() { return userSkills.skillCatalog() },
    async skillSource(id, version) { return userSkills.skillSource(id, version) },
  }
}

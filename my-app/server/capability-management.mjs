import { createHash } from 'node:crypto'
import { defineDoc } from '@earendil-works/pi-durable'
import { TaskInputError } from './task-config.mjs'
import { boundedMcpJson } from './external-mcp-config.mjs'
import { parseCapabilityManagementCall } from './capability-management-tools.mjs'

export const CapabilitySetups = defineDoc({ kind: 'pidot.capability-setups', version: 1, scope: 'session',
  initial: () => ({ items: {}, byOperation: {} }) })
const copy = value => JSON.parse(JSON.stringify(value))
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
const hash = value => createHash('sha256').update((JSON.stringify(canonical(value)) ?? 'undefined')).digest('hex')
const subrequest = (id, step) => `setup-${hash([id, step])}`
const messages = {
  SETUP_INVALID_ARGS: '能力配置参数无效。', SETUP_NOT_AUTHORIZED: '当前配置 Agent 或用户指令未获准执行此精确操作。',
  SETUP_INPUT_INVALID: '配置须绑定当前真实已认证用户输入，不能由简报、Skill 或工具返回发起。',
  SETUP_CONFLICT: '此操作标识已绑定其他输入、来源或目标，请核查原操作。', SETUP_SOURCE_CHANGED: '登记来源或版本已改变；原操作不会按新来源盲重放。',
  SETUP_TARGET_CHANGED: '目标 Bot 配置已改变，请重新读取并明确确认新操作。', SETUP_NOT_FOUND: '未找到该配置操作。',
  SETUP_SOURCE_EXISTS: '来源标识已经登记，请显式选择已登记来源或请求更新。', SETUP_SOURCE_NOT_FOUND: '来源尚未登记或已移除。',
  SETUP_PROVIDER_FAILED: '登记或校验未确认成功；请核查原操作，不要盲目重试。', SETUP_UNKNOWN: '上一步结果未核实，原参数和子请求标识已保留。',
  SETUP_APPROVAL_DENIED: '宿主确认未批准，未执行对应变更。', SETUP_APPROVAL_INVALID: '确认回执与此操作的目标、来源或范围不一致。',
  SETUP_MISSING_DEPENDENCY: '能力依赖尚未满足；没有自动授予业务工具或来源。', SETUP_LIMIT: '配置操作记录或返回值超过本轮边界。',
}
const fail = (code, status = 409) => { throw new TaskInputError(status, code, messages[code] ?? messages.SETUP_PROVIDER_FAILED) }
const safeError = error => ({ code: Object.hasOwn(messages, error?.code) ? error.code : error?.unknown ? 'SETUP_UNKNOWN' : 'SETUP_PROVIDER_FAILED',
  message: messages[Object.hasOwn(messages, error?.code) ? error.code : error?.unknown ? 'SETUP_UNKNOWN' : 'SETUP_PROVIDER_FAILED'] })
const mechanismTools = ['skill_activate', 'skill_deactivate', 'skill_read_resource']
const terminal = new Set(['ready', 'disabled', 'unbound', 'removed'])
const uncertainStep = step => ['in_flight', 'unknown', 'pending'].includes(step?.state)
const hasUncertainStep = record => Object.values(record.steps).some(uncertainStep)
const providerOperation = (record, step) => step === 'remove' ? 'remove' : record.kind === 'mcp' ? step === 'register' ? 'configure' : 'check' :
  record.proposal.action === 'rollback' ? 'rollback' : record.proposal.action === 'update' ? 'update' : 'import'
const validId = id => Number.isSafeInteger(id) && id > 0
const same = (a, b) => hash(a) === hash(b)
const safeLabel = (value, fallback, max = 200) => typeof value === 'string' && value.trim() ? value.slice(0, max) : fallback

function project(record, replayed = false) {
  return { setupId: record.id, requestId: record.requestId, operationId: record.proposal.operationId, kind: record.kind, action: record.proposal.action,
    taskId: record.taskId, inputId: record.inputId, targetBotId: record.targetBotId, name: record.name, description: record.description,
    state: record.state, capabilityId: record.capabilityId, enabledForBot: record.enabledForBot, connectionId: record.kind === 'mcp' ? record.connectionId : null,
    verification: copy(record.verification), missing: copy(record.missing), affectedBotIds: [...record.affectedBotIds], approvalId: record.approvalId,
    credentialEntry: record.state === 'needs_auth' && record.connectionId ? { kind: 'mcp-credential', connectionId: record.connectionId } : null,
    canResume: !record.blocked && record.state !== 'unknown' && !hasUncertainStep(record) && !terminal.has(record.state) && !['SETUP_APPROVAL_DENIED', 'SETUP_SOURCE_CHANGED', 'SETUP_TARGET_CHANGED'].includes(record.error?.code),
    replayed, error: copy(record.error) }
}

/** Specific configuration steps only; all execution and approval ownership stays in the existing Harness. */
export function createCapabilityManagement(options) {
  const { transaction, readTask, readEntry, canManage, authorizeIntent, mcp, skills, readCatalog, readCapabilities,
    assignCapability, verifyCapability, affectedBots, requestApproval, readApproval } = options ?? {}
  for (const hook of [transaction, readTask, readEntry, canManage, authorizeIntent, readCatalog, readCapabilities, assignCapability,
    verifyCapability, affectedBots, requestApproval, readApproval]) if (typeof hook !== 'function') fail('SETUP_INVALID_ARGS', 400)
  if (!mcp || !skills) fail('SETUP_INVALID_ARGS', 400)
  const active = new Map()
  const catalogFor = async record => boundedMcpJson(await readCatalog({ kind: record.kind, targetBotId: record.targetBotId }), { maxBytes: 524288 })
  async function currentInput(tx, context, toolName) {
    if (!validId(context.taskId) || !validId(context.inputId)) fail('SETUP_INPUT_INVALID', 400)
    const task = await readTask(tx, context.taskId), entry = await readEntry(tx, context.inputId)
    if (!task || task.taskId !== context.taskId || task.initiatingUser !== 'authenticated-user' || task.scheduledWorkflow ||
      task.activeInputId !== context.inputId || !entry || entry.id !== context.inputId || entry.kind !== 'pidot.user' ||
      entry.conversationId !== task.conversationId || entry.data?.role !== 'user' || typeof entry.data.content !== 'string' || !entry.data.content.trim() ||
      entry.data.content.length > 16384 || entry.data.source !== undefined && entry.data.source !== 'capability-setup-resume') fail('SETUP_INPUT_INVALID', 403)
    if (await canManage(tx, { task, toolName }) !== true) fail('SETUP_NOT_AUTHORIZED', 403)
    return { task, entry }
  }
  async function authorized(tx, context, record) {
    const toolName = record.kind === 'mcp' ? 'mcp_manage' : 'skill_manage'
    const { task, entry } = await currentInput(tx, context, toolName), originEntry = await readEntry(tx, record.inputId)
    if (!originEntry || originEntry.conversationId !== task.conversationId || hash([originEntry.kind, originEntry.data]) !== record.originHash) fail('SETUP_INPUT_INVALID', 403)
    const proof = await authorizeIntent(tx, { task, entry, originEntry, proposal: copy(record.proposal), sourceFingerprint: record.sourceFingerprint })
    if (!proof || typeof proof.authorizationId !== 'string' || !proof.authorizationId || proof.taskId !== record.taskId || proof.inputId !== record.inputId ||
      proof.targetBotId !== record.targetBotId || proof.action !== record.proposal.action || proof.scope !== record.scope || proof.sourceFingerprint !== record.sourceFingerprint) fail('SETUP_NOT_AUTHORIZED', 403)
    return proof
  }
  const load = (tx, id) => tx.doc(CapabilitySetups).then(doc => {
    const record = Object.hasOwn(doc.items, id) ? doc.items[id] : null
    if (!record) fail('SETUP_NOT_FOUND', 404)
    return record
  })
  async function snapshot(id) { return transaction(async tx => copy(await load(tx, id))) }
  async function update(id, changes) {
    return transaction(async tx => { const record = await load(tx, id); Object.assign(record, copy(changes)); return copy(record) })
  }
  async function status(id, state, { missing = [], verification, error = null, ...changes } = {}) {
    return update(id, { state, missing, error, ...(verification ? { verification } : {}), ...changes })
  }
  async function guard(context, id) {
    return transaction(async tx => { const record = await load(tx, id); await authorized(tx, context, record); return copy(record) })
  }
  async function perform(context, id, step, prepare, run) {
    const record = await guard(context, id)
    let saved = record.steps[step], fresh = false
    if (saved?.state === 'done') return copy(saved.result)
    if (!saved) {
      const payload = boundedMcpJson(await prepare(record), { maxBytes: 131072 })
      saved = await transaction(async tx => {
        const live = await load(tx, id); await authorized(tx, context, live)
        live.steps[step] ??= { requestId: subrequest(id, step), input: payload, state: 'reserved' }
        return copy(live.steps[step])
      })
    }
    const unknown = () => {
      const error = new TaskInputError(409, 'SETUP_UNKNOWN', messages.SETUP_UNKNOWN)
      error.unknown = true
      return error
    }
    const saveResult = async result => {
      const bounded = boundedMcpJson(result, { maxBytes: 131072 })
      try { await transaction(async tx => { const live = await load(tx, id); live.steps[step] = { ...copy(saved), state: 'done', result: bounded } }) }
      catch { throw unknown() }
      return bounded
    }
    if (saved.state !== 'reserved' && step !== 'prepare') {
      // An interrupted mutation is queried by its exact durable request identity.
      // Never resubmit it merely because the model/HTTP caller asks to resume.
      const provider = record.kind === 'mcp' ? mcp : skills
      if (typeof provider.requestStatus !== 'function') throw unknown()
      const receipt = await provider.requestStatus(saved.requestId)
      const operation = providerOperation(record, step)
      if (!receipt || receipt.requestId !== saved.requestId || receipt.operation !== operation) throw unknown()
      if (receipt.state === 'succeeded' && receipt.result) return saveResult(receipt.result)
      if (receipt.state === 'failed') fail('SETUP_PROVIDER_FAILED')
      throw unknown()
    }
    const currentCatalog = await catalogFor(record)
    await transaction(async tx => {
      const live = await load(tx, id); await authorized(tx, context, live)
      const target = await readCapabilities(tx, live.targetBotId, { catalog: currentCatalog })
      if (target.revision !== live.targetRevision) fail('SETUP_TARGET_CHANGED')
      live.steps[step].state = 'in_flight'
      fresh = true
    })
    if (!fresh) throw unknown()
    let result
    try { result = await run(copy(saved.input), saved.requestId) }
    catch (error) {
      const definite = !error?.unknown && typeof error?.code === 'string' && /^(MCP_|SKILL_|SETUP_)/.test(error.code) && !/STORAGE|WRITE_FAILED/.test(error.code)
      await transaction(async tx => { const live = await load(tx, id); if (live.steps[step].state !== 'done') live.steps[step].state = definite ? 'failed' : 'unknown' })
      if (!definite) throw unknown()
      throw error
    }
    // Provider receipts are non-secret audit facts, even if the input stopped while
    // IO ran. Every subsequent mutation still checks current Task and management access.
    return saveResult(result)
  }
  async function affected(context, id) {
    return transaction(async tx => {
      const record = await load(tx, id); await authorized(tx, context, record)
      const ids = await affectedBots(tx, record.capabilityId)
      if (!Array.isArray(ids) || ids.length > 128 || ids.some(id => typeof id !== 'string')) fail('SETUP_LIMIT')
      record.affectedBotIds = [...new Set(ids)].sort()
      return [...record.affectedBotIds]
    })
  }
  async function approval(context, id, scope, ids, tools = []) {
    return transaction(async tx => {
      const record = await load(tx, id); await authorized(tx, context, record)
      const spec = { setupId: id, taskId: record.taskId, inputId: record.inputId, targetBotId: record.targetBotId, scope,
        sourceFingerprint: record.sourceFingerprint, capabilityId: record.capabilityId, affectedBotIds: [...ids].sort(), tools: [...tools].sort() }
      const slot = record.approvals[scope]
      let approvalId = slot?.approvalId
      if (!slot || !same(slot.spec, spec)) {
        const created = await requestApproval(tx, copy(spec))
        if (typeof created?.approvalId !== 'string' || !created.approvalId) fail('SETUP_APPROVAL_INVALID')
        approvalId = created.approvalId
        record.approvals[scope] = { approvalId, spec }
        record.approvalId = approvalId
        record.state = 'needs_confirmation'
        return false
      }
      const receipt = await readApproval(tx, approvalId)
      if (!receipt || !['pending', 'approved', 'denied'].includes(receipt.state) || Object.keys(spec).some(key => !same(receipt[key], spec[key]))) fail('SETUP_APPROVAL_INVALID')
      record.approvalId = approvalId
      if (receipt.state === 'denied') fail('SETUP_APPROVAL_DENIED')
      if (receipt.state !== 'approved') { record.state = 'needs_confirmation'; return false }
      record.approvalId = null
      return true
    })
  }
  async function assign(context, id, capabilityId, enabled, step, { latestRevision = false } = {}) {
    const record = await snapshot(id), catalog = await catalogFor(record)
    if (enabled) {
      const item = catalog.find(item => item.id === record.capabilityId)
      if (record.kind === 'mcp' && record.catalogRevision && item?.revision !== record.catalogRevision) fail('SETUP_SOURCE_CHANGED')
      if (record.kind === 'skill') {
        const expectedHash = record.steps.register?.result?.hash ?? record.provider?.hash
        if (expectedHash) {
          const skill = (await skills.skillCatalog()).skills.find(item => item.id === record.skillId && !item.removed)
          if (!skill || skill.hash !== expectedHash) fail('SETUP_SOURCE_CHANGED')
        } else if (record.catalogRevision && item?.revision !== record.catalogRevision) fail('SETUP_SOURCE_CHANGED')
      }
    }
    return transaction(async tx => {
      const live = await load(tx, id); await authorized(tx, context, live)
      if (live.steps[step]?.state === 'done') return copy(live.steps[step].result)
      const view = await readCapabilities(tx, live.targetBotId, { catalog })
      if (!latestRevision && view.revision !== live.targetRevision) fail('SETUP_TARGET_CHANGED')
      const item = view.items.find(item => item.id === capabilityId)
      if (enabled && !item) fail('SETUP_SOURCE_NOT_FOUND')
      const input = { requestId: subrequest(id, step), expectedRevision: view.revision,
        expectedCatalogRevision: item?.revision ?? live.catalogRevision ?? '', capabilityId, enabled }
      const result = await assignCapability(tx, live.targetBotId, input, { catalog })
      live.steps[step] = { state: 'done', input, result: boundedMcpJson(result) }
      live.targetRevision = result.revision
      if (capabilityId === live.capabilityId) live.enabledForBot = result.enabledForBot === true
      return copy(result)
    })
  }
  async function verify(context, id) {
    const record = await guard(context, id)
    const result = boundedMcpJson(await verifyCapability({ kind: record.kind, targetBotId: record.targetBotId, capabilityId: record.capabilityId }), { maxBytes: 16384 })
    if (!['ready', 'needs_auth', 'missing_dependency', 'pending', 'error'].includes(result.status) || !Array.isArray(result.missing) || result.missing.length > 32 ||
      result.missing.some(item => typeof item.kind !== 'string' || typeof item.id !== 'string' || typeof item.message !== 'string' || item.message.length > 400)) fail('SETUP_PROVIDER_FAILED')
    const verification = { status: result.status, summary: safeLabel(result.summary, '已核对真实登记、分配与依赖状态。', 1000), checkedAt: new Date().toISOString() }
    let state = result.status === 'ready' && record.enabledForBot ? 'ready' : result.status === 'ready' ? 'pending' : result.status
    if (record.kind === 'skill' && result.status === 'missing_dependency' && result.missing.some(item => item.kind === 'tool' && mechanismTools.includes(item.id))) {
      await status(id, 'missing_dependency', { verification, missing: result.missing })
      if (!await approval(context, id, 'skill-mechanisms', [record.targetBotId], mechanismTools)) return snapshot(id)
      await assign(context, id, 'tool:skills', true, 'skill-mechanisms')
      const after = boundedMcpJson(await verifyCapability({ kind: record.kind, targetBotId: record.targetBotId, capabilityId: record.capabilityId }), { maxBytes: 16384 })
      if (!['ready', 'needs_auth', 'missing_dependency', 'pending', 'error'].includes(after.status) || !Array.isArray(after.missing)) fail('SETUP_PROVIDER_FAILED')
      state = after.status === 'ready' ? 'ready' : after.status
      return status(id, state, { verification: { status: after.status, summary: safeLabel(after.summary, '已复核依赖状态。', 1000), checkedAt: new Date().toISOString() }, missing: after.missing })
    }
    return status(id, state, { verification, missing: result.missing })
  }
  async function globalApproval(context, id) {
    const record = await snapshot(id), ids = await affected(context, id)
    if (!ids.some(botId => botId !== record.targetBotId)) return true
    return approval(context, id, `global-${record.proposal.action}`, ids)
  }
  async function currentMcp(record, { original = false } = {}) {
    const connection = (await mcp.connections()).find(item => item.connectionId === record.connectionId)
    if (!connection) fail('SETUP_SOURCE_NOT_FOUND')
    const identity = connection.sourceRevision ?? connection.catalogRevision
    const expected = original ? record.provider?.sourceIdentity : record.registeredSourceIdentity ?? record.provider?.sourceIdentity
    if (expected && identity !== expected) fail('SETUP_SOURCE_CHANGED')
    return connection
  }
  async function mcpSetup(context, id) {
    let record = await snapshot(id)
    if (record.proposal.config && !record.steps.register) {
      if (record.proposal.action === 'update' && !await globalApproval(context, id)) return snapshot(id)
    }
    if (record.proposal.config) {
      const registration = await perform(context, id, 'register', async live => {
        const config = copy(live.proposal.config)
        if (live.proposal.action === 'add') {
          if ((await mcp.connections()).some(item => item.connectionId === live.connectionId)) fail('SETUP_SOURCE_EXISTS')
          return { config }
        }
        const connection = await currentMcp(live, { original: true })
        return { config, expectedRevision: connection.revision }
      }, (input, requestId) => mcp.configure({ ...input, requestId }))
      if (!record.registeredSourceIdentity) await update(id, { registeredSourceIdentity: registration.sourceRevision ?? registration.catalogRevision })
    }
    record = await guard(context, id)
    const connection = await currentMcp(record)
    if (!connection.enabled) return status(id, 'missing_dependency', { missing: [{ kind: 'connection', id: record.connectionId, message: '该连接已全局停用；本操作不会悄悄影响其他 Bot 的连接状态。' }] })
    if (connection.credentialRequired && !connection.hasCredential) return status(id, 'needs_auth', {
      verification: { status: 'needs_auth', summary: '登记已保存，尚未取得安全凭据；没有把待授权当作连接成功。', checkedAt: null },
      missing: [{ kind: 'credential', id: record.connectionId, message: '请通过安全凭据入口完成输入，再续办原操作。' }],
    })
    let attempt = record.checkAttempt ?? 0, step = `check-${attempt}`, saved = record.steps[step]
    if (['pending', 'failed'].includes(saved?.state) && record.lastProviderCode === 'MCP_AUTH_REQUIRED' && saved.input.expectedRevision !== connection.revision) {
      // A failed read-only auth check is definitive. Credential rotation can start a
      // new check attempt, while all previous exact request payloads remain recorded.
      attempt++
      await update(id, { checkAttempt: attempt, lastProviderCode: null })
      step = `check-${attempt}`
      saved = null
    }
    try {
      const checked = await perform(context, id, step, async live => ({ expectedRevision: (await currentMcp(live)).revision }),
        (input, requestId) => mcp.check(record.connectionId, { ...input, requestId }))
      if (checked.status === 'ready') await update(id, { registeredSourceIdentity: checked.sourceRevision ?? checked.catalogRevision, catalogRevision: checked.catalogRevision })
      if (checked.status !== 'ready') return status(id, checked.status === 'needs_auth' ? 'needs_auth' : 'pending', {
        verification: { status: checked.status, summary: '检查回执尚未表明当前连接可用，请核查连接。', checkedAt: checked.lastCheck?.checkedAt ?? null },
        missing: [{ kind: 'connection', id: record.connectionId, message: '当前连接尚未完成可用性检查。' }],
      })
    } catch (error) {
      if (['MCP_AUTH_REQUIRED', 'MCP_CREDENTIAL_UNAVAILABLE'].includes(error.code)) return status(id, 'needs_auth', {
        lastProviderCode: error.code, verification: { status: 'needs_auth', summary: '真实连接检查仍需安全凭据或授权，没有完成绑定。', checkedAt: new Date().toISOString() },
        missing: [{ kind: 'credential', id: record.connectionId, message: '请在安全入口更新凭据，再使用同一操作续办。' }],
      })
      throw error
    }
    await assign(context, id, record.capabilityId, true, 'bind')
    return verify(context, id)
  }
  async function currentSkill(record) {
    const catalog = await skills.skillCatalog(), skill = catalog.skills.find(item => item.id === record.skillId && !item.removed)
    if (!skill) fail('SETUP_SOURCE_NOT_FOUND')
    if (record.provider?.hash && skill.hash !== record.provider.hash && !record.steps.register?.result) fail('SETUP_SOURCE_CHANGED')
    return { catalog, skill }
  }
  async function skillSetup(context, id) {
    let record = await snapshot(id)
    if (record.proposal.source) {
      const prepared = await perform(context, id, 'prepare', () => ({ source: record.proposal.source }), async input => {
        const result = await skills.prepareSkillImport(input.source)
        if (result.status === 'needs_directory') return { status: result.status }
        return { preparedId: result.preparedId, hash: result.hash, manifest: result.manifest, source: result.source, status: result.status, requirements: result.requirements }
      })
      if (prepared.status === 'needs_directory') return status(id, 'pending', { blocked: true,
        missing: [{ kind: 'directory', id: 'skill-source', message: '仓库含多个候选目录，请在真实用户输入中明确目录后重新发起。' }] })
      if (record.skillId && record.skillId !== prepared.manifest.id) fail('SETUP_SOURCE_CHANGED')
      await update(id, { skillId: prepared.manifest.id, capabilityId: `skill:${prepared.manifest.id}`, name: safeLabel(prepared.manifest.name, prepared.manifest.id),
        description: safeLabel(prepared.manifest.description, '', 2000), preparedHash: prepared.hash })
      record = await snapshot(id)
      if (record.proposal.action === 'update' && record.steps.register?.state !== 'done' && !await globalApproval(context, id)) return snapshot(id)
      await perform(context, id, 'register', async live => {
        const catalog = await skills.skillCatalog()
        if (live.proposal.action === 'update') await currentSkill(live)
        return { preparedId: prepared.preparedId, expectedRevision: catalog.revision, ...(live.proposal.action === 'update' ? { skillId: live.skillId } : {}) }
      }, (input, requestId) => record.proposal.action === 'update' ? skills.updateSkill({ ...input, requestId }) : skills.importSkill({ ...input, requestId }))
    } else if (record.proposal.action === 'rollback') {
      if (record.steps.register?.state !== 'done' && !await globalApproval(context, id)) return snapshot(id)
      await perform(context, id, 'register', async live => ({ skillId: live.skillId, hash: live.proposal.hash, expectedRevision: (await currentSkill(live)).catalog.revision }),
        (input, requestId) => skills.rollbackSkill({ ...input, requestId }))
    }
    record = await snapshot(id)
    const registered = record.steps.register?.result
    if (registered) {
      await update(id, { name: safeLabel(registered.name, record.name), description: safeLabel(registered.description, record.description, 2000) })
      record = await snapshot(id)
    }
    if (!record.capabilityId) fail('SETUP_SOURCE_NOT_FOUND')
    await assign(context, id, record.capabilityId, true, 'bind')
    return verify(context, id)
  }
  async function revokeRemoved(context, id) {
    const record = await snapshot(id), catalog = await catalogFor(record)
    await transaction(async tx => {
      const live = await load(tx, id); await authorized(tx, context, live)
      for (const botId of live.affectedBotIds) {
        const step = `removed-binding-${botId}`
        if (live.steps[step]?.state === 'done') continue
        const view = await readCapabilities(tx, botId, { catalog })
        const input = { requestId: subrequest(id, step), expectedRevision: view.revision, expectedCatalogRevision: live.catalogRevision ?? '', capabilityId: live.capabilityId, enabled: false }
        const result = await assignCapability(tx, botId, input, { catalog })
        live.steps[step] = { state: 'done', input, result: boundedMcpJson(result) }
      }
      live.enabledForBot = false
    })
  }
  async function remove(context, id) {
    let record = await snapshot(id)
    if (record.steps.remove?.state !== 'done' && !await globalApproval(context, id)) return snapshot(id)
    record = await snapshot(id)
    await perform(context, id, 'remove', async live => {
      if (live.kind === 'mcp') return { connectionId: live.connectionId, expectedRevision: (await currentMcp(live, { original: true })).revision }
      const { catalog } = await currentSkill(live)
      return { skillId: live.skillId, expectedRevision: catalog.revision, affectedBotIds: [...live.affectedBotIds], confirmGlobal: true }
    }, (input, requestId) => record.kind === 'mcp' ? mcp.remove({ ...input, requestId }) : skills.removeSkill({ ...input, requestId }))
    await revokeRemoved(context, id)
    return status(id, 'removed', { enabledForBot: false, verification: { status: 'removed', summary: '来源已全局移除，已复核引用范围并撤销这些 Bot 的旧分配。', checkedAt: new Date().toISOString() } })
  }
  async function run(context, id) {
    try {
      const record = await guard(context, id)
      if (terminal.has(record.state)) return { ok: true, data: project(record, true) }
      let result
      if (['disable', 'unbind'].includes(record.proposal.action)) {
        await assign(context, id, record.capabilityId, false, 'unbind')
        result = await status(id, record.proposal.action === 'disable' ? 'disabled' : 'unbound', { enabledForBot: false,
          verification: { status: 'disabled', summary: '仅撤销目标 Bot 的该能力分配，未全局停用连接或移除来源。', checkedAt: new Date().toISOString() } })
      } else if (record.proposal.action === 'remove') result = await remove(context, id)
      else result = record.kind === 'mcp' ? await mcpSetup(context, id) : await skillSetup(context, id)
      return { ok: true, data: project(result) }
    } catch (error) {
      const safe = safeError(error)
      const result = await status(id, error?.unknown || error?.code === 'SETUP_UNKNOWN' ? 'unknown' : 'error', { error: safe })
      return { ok: false, error: safe, data: project(result) }
    }
  }
  async function serialize(id, fn) {
    while (active.has(id)) await active.get(id).catch(() => {})
    const operation = fn()
    active.set(id, operation)
    try { return await operation } finally { if (active.get(id) === operation) active.delete(id) }
  }
  async function execute({ taskId, inputId, call }) {
    const parsed = parseCapabilityManagementCall(call), context = { taskId, inputId }, { kind, args } = parsed
    await transaction(tx => currentInput(tx, context, call.name))
    if (args.action === 'resume') {
      const id = await transaction(async tx => (await tx.doc(CapabilitySetups)).byOperation[`${taskId}:${args.operationId}`])
      if (!id) fail('SETUP_NOT_FOUND', 404)
      const record = await snapshot(id)
      if (record.kind !== kind) fail('SETUP_CONFLICT')
      return serialize(id, () => run(context, id))
    }
    if (args.action === 'inspect') {
      const catalog = boundedMcpJson(await readCatalog({ kind, targetBotId: args.targetBotId }), { maxBytes: 524288 })
      const view = await transaction(async tx => { await currentInput(tx, context, call.name); return readCapabilities(tx, args.targetBotId, { catalog }) })
      return { ok: true, data: { kind, action: 'inspect', targetBotId: args.targetBotId, targetRevision: view.revision, capabilities: view.items,
        ...(kind === 'mcp' ? { connections: await mcp.connections() } : { skills: (await skills.skillCatalog()).skills }) } }
    }
    const operationKey = `${taskId}:${args.operationId}`
    const existing = await transaction(async tx => (await tx.doc(CapabilitySetups)).byOperation[operationKey] ?? null)
    if (existing) {
      const previous = await snapshot(existing)
      if (previous.inputId !== inputId || previous.kind !== kind || !same(previous.proposal, args)) fail('SETUP_CONFLICT')
      return serialize(existing, () => run(context, existing))
    }
    const capabilityId = kind === 'mcp' ? `mcp:${args.connectionId}` : args.skillId ? `skill:${args.skillId}` : null
    const catalog = boundedMcpJson(await readCatalog({ kind, targetBotId: args.targetBotId }), { maxBytes: 524288 })
    const item = catalog.find(item => item.id === capabilityId)
    let provider = null
    if (kind === 'mcp' && args.connectionId) {
      const connection = (await mcp.connections()).find(item => item.connectionId === args.connectionId)
      if (args.action === 'add' && args.config && connection) fail('SETUP_SOURCE_EXISTS')
      if (args.action !== 'add' && !connection || args.action === 'add' && !args.config && !connection) fail('SETUP_SOURCE_NOT_FOUND')
      if (connection) provider = { revision: connection.revision, sourceIdentity: connection.sourceRevision ?? connection.catalogRevision }
    } else if (kind === 'skill' && args.skillId) {
      const skill = (await skills.skillCatalog()).skills.find(item => item.id === args.skillId && !item.removed)
      if (skill) provider = { hash: skill.hash }
      if (!args.source && !item) fail('SETUP_SOURCE_NOT_FOUND')
    }
    const id = `setup_${hash([taskId, inputId, args.operationId]).slice(0, 32)}`
    await transaction(async tx => {
      const { entry } = await currentInput(tx, context, call.name), doc = await tx.doc(CapabilitySetups)
      if (doc.byOperation[operationKey]) {
        const previous = await load(tx, doc.byOperation[operationKey])
        if (previous.inputId !== inputId || previous.kind !== kind || !same(previous.proposal, args)) fail('SETUP_CONFLICT')
        await authorized(tx, context, previous)
        return
      }
      if (Object.keys(doc.items).length >= 1024) fail('SETUP_LIMIT')
      const view = await readCapabilities(tx, args.targetBotId, { catalog })
      if (view.revision !== args.expectedRevision) fail('SETUP_TARGET_CHANGED')
      const record = { id, taskId, inputId, kind, proposal: copy(args), targetBotId: args.targetBotId, targetRevision: args.expectedRevision,
        originHash: hash([entry.kind, entry.data]), sourceFingerprint: hash([kind, args, item?.revision ?? null]), scope: ['update', 'remove', 'rollback'].includes(args.action) ? 'global' : 'target-bot',
        requestId: subrequest(id, 'setup'), name: safeLabel(args.config?.name ?? item?.name, args.skillId ?? args.connectionId ?? 'Skill'), description: safeLabel(args.config?.description ?? item?.description, '', 2000),
        state: 'pending', capabilityId, connectionId: args.connectionId ?? null, skillId: args.skillId ?? null, provider, catalogRevision: item?.revision ?? null,
        enabledForBot: view.items.find(item => item.id === capabilityId)?.enabledForBot === true, affectedBotIds: [], approvals: {}, approvalId: null,
        steps: {}, verification: { status: 'pending', summary: '尚未完成实际登记、绑定和校验。', checkedAt: null }, missing: [], error: null }
      const proof = await authorized(tx, context, record)
      record.authorizationId = proof.authorizationId
      doc.items[id] = record
      doc.byOperation[operationKey] = id
    })
    return serialize(id, () => run(context, id))
  }
  async function reconcile(setupId, taskId) {
    const record = await snapshot(setupId)
    if (record.taskId !== taskId) fail('SETUP_NOT_FOUND', 404)
    const provider = record.kind === 'mcp' ? mcp : skills
    for (const [step, saved] of Object.entries(record.steps).filter(([, value]) => uncertainStep(value)).slice(0, 16)) {
      if (step === 'prepare' || typeof provider.requestStatus !== 'function') continue
      let receipt
      try { receipt = await provider.requestStatus(saved.requestId) } catch { continue }
      if (!receipt || receipt.requestId !== saved.requestId || receipt.operation !== providerOperation(record, step)) continue
      if (receipt.state !== 'succeeded' && receipt.state !== 'failed') continue
      const result = receipt.state === 'succeeded' && receipt.result ? boundedMcpJson(receipt.result, { maxBytes: 131072 }) : null
      if (receipt.state === 'succeeded' && !result) continue
      await transaction(async tx => {
        const live = await load(tx, setupId), current = live.steps[step]
        if (live.taskId !== taskId || !current || current.requestId !== saved.requestId || !same(current.input, saved.input) || !uncertainStep(current)) return
        if (result) live.steps[step] = { ...copy(current), state: 'done', result, reconciled: true }
        else {
          live.steps[step].state = 'failed'
          live.state = 'error'; live.blocked = true
          live.error = { code: 'SETUP_PROVIDER_FAILED', message: messages.SETUP_PROVIDER_FAILED }
        }
      })
    }
    return transaction(async tx => {
      const live = await load(tx, setupId)
      if (live.taskId !== taskId) fail('SETUP_NOT_FOUND', 404)
      if (!terminal.has(live.state) && hasUncertainStep(live)) {
        live.state = 'unknown'
        live.error = { code: 'SETUP_UNKNOWN', message: messages.SETUP_UNKNOWN }
      } else if (!live.blocked && ['unknown', 'pending'].includes(live.state) && Object.values(live.steps).some(step => step.reconciled)) {
        // GET records evidence only. Binding/check/next steps wait for explicit resume.
        live.state = 'pending'; live.error = null; live.missing = []
        live.verification = { status: 'pending', summary: '已查实原步骤回执；尚未执行后续绑定或校验，请显式续办。', checkedAt: null }
      }
      return project(live)
    })
  }
  return {
    execute,
    get: (setupId, { taskId } = {}) => reconcile(setupId, taskId),
    async resume(setupId, { taskId, inputId } = {}) {
      const record = await snapshot(setupId)
      if (record.taskId !== taskId) fail('SETUP_NOT_FOUND', 404)
      return serialize(setupId, () => run({ taskId, inputId }, setupId))
    },
  }
}

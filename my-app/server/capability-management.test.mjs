import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { openTaskStore, TaskCard, ChatInput } from './tasks.mjs'
import { listBots } from './bots.mjs'
import { TaskApprovals } from './approvals.mjs'
import { ToolAccess } from './tools.mjs'
import { assertNotCancelled } from './cancellation.mjs'
import { assertSessionVisible } from './session-lifecycle.mjs'
import { CapabilityAssignments, listBotCapabilities, setCapabilityAssignment } from './capability-assignments.mjs'
import { createExternalMcpService } from './external-mcp.mjs'
import { createSkillImportService } from './skill-import.mjs'
import { SKILL_DIRECTORY, skillCapabilityCatalog } from './skills.mjs'
import { createFixtureMcpHttp } from './fixtures/external-mcp-sdk-http.mjs'
import { CapabilitySetups, createCapabilityManagement } from './capability-management.mjs'
import { parseCapabilityManagementCall, validCapabilityManagementArgs } from './capability-management-tools.mjs'

const config = { baseUrl: 'https://fixture.invalid/v1', model: 'capability-setup-fixture', apiKey: 'isolated-only' }
const deferred = () => { let release; const promise = new Promise(resolve => { release = resolve }); return { promise, release } }
const json = value => JSON.parse(JSON.stringify(value))
const markdown = (name = 'setup-skill', version = '1.0', extra = '') => `---\nname: ${name}\ndescription: A normal declarative setup fixture\nversion: "${version}"\n${extra}---\nUse only the declared task context.\n`
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'pidot-setup-')), source = join(directory, 'source')
  await mkdir(source)
  await writeFile(join(source, 'SKILL.md'), markdown())
  let mcp, skills, store, manager, hold = deferred(), sequence = 0
  const gates = new Set([hold]), intents = new Map()
  const providers = async () => [...await mcp.catalog(), ...await skillCapabilityCatalog({ builtinDirectory: SKILL_DIRECTORY, userSkills: skills })]
  const transaction = fn => store.harness.commit(fn, context)
  const options = () => ({
    transaction,
    readTask: async (tx, id) => {
      await assertSessionVisible(tx, id)
      const native = await tx.task(id)
      await assertNotCancelled(tx, id, native)
      const card = await tx.doc(TaskCard, id)
      return { ...json(card), activeInputId: (await tx.doc(ChatInput, id)).entryId }
    },
    readEntry: (tx, id) => tx.entry(id),
    canManage: async (tx, { task, toolName }) => task.bot.id === 'chief' && task.managementTools?.includes(toolName) ||
      (await tx.doc(ToolAccess)).assignments[task.bot.id]?.tools.includes(toolName),
    authorizeIntent: async (_tx, { task, entry, originEntry, proposal, sourceFingerprint }) => {
      const original = intents.get(originEntry.id), current = intents.get(entry.id)
      const selectedSource = proposal.config?.url ?? proposal.source?.path ?? proposal.connectionId ?? proposal.skillId
      if (!original || original.action !== proposal.action || original.targetBotId !== proposal.targetBotId || original.source !== selectedSource ||
        entry.id !== originEntry.id && current?.resume !== proposal.operationId) return null
      return { authorizationId: `host-user-intent-${originEntry.id}`, taskId: task.taskId, inputId: originEntry.id, targetBotId: proposal.targetBotId,
        action: proposal.action, sourceFingerprint, scope: ['update', 'remove', 'rollback'].includes(proposal.action) ? 'global' : 'target-bot' }
    },
    mcp, skills,
    readCatalog: providers,
    readCapabilities: (tx, botId, { catalog }) => listBotCapabilities(tx, botId, { catalog }),
    assignCapability: (tx, botId, input, { catalog }) => setCapabilityAssignment(tx, botId, input, { catalog }),
    affectedBots: async (tx, capabilityId) => {
      const state = await tx.doc(CapabilityAssignments)
      return Object.entries(state.bindings).filter(([, values]) => Object.hasOwn(values, capabilityId)).map(([botId]) => botId)
    },
    verifyCapability: async ({ targetBotId, capabilityId, kind }) => {
      const catalog = await providers()
      return transaction(async tx => {
        const view = await listBotCapabilities(tx, targetBotId, { catalog }), item = view.items.find(item => item.id === capabilityId)
        const access = await tx.doc(ToolAccess), assigned = access.assignments[targetBotId], revoked = access.revoked[targetBotId] ?? []
        const missing = []
        if (!item?.enabledForBot) missing.push({ kind: 'capability', id: capabilityId, message: '当前目标未启用。' })
        if (kind === 'skill') for (const requirement of item?.requirements ?? []) {
          if (requirement.kind === 'tool' && (!assigned.tools.includes(requirement.id) || revoked.includes(requirement.id)) ||
            requirement.kind === 'resource' && !assigned.resources.includes(requirement.id) || requirement.kind === 'script') {
            missing.push({ ...requirement, message: '声明的工具、来源或脚本支持尚未具备。' })
          }
        }
        return { status: !missing.length && item?.status === 'ready' ? 'ready' : 'missing_dependency', missing, summary: '实际登记、分配及声明式依赖已核对；未调用验证写工具。' }
      })
    },
    requestApproval: async (tx, spec) => {
      const doc = await tx.doc(TaskApprovals, spec.taskId), approvalId = `setup-host-approval-${++sequence}`
      doc.items.push({ id: approvalId, status: 'pending', toolName: spec.scope, arguments: {}, createdAt: new Date().toISOString(), setupScope: json(spec) })
      return { approvalId }
    },
    readApproval: async (tx, approvalId) => {
      const tasks = await tx.scanTasks({ kind: 'pidot.chat' }, 100)
      for (const native of tasks.items) if (native.state.status !== 'terminal') {
        const item = (await tx.doc(TaskApprovals, native.id)).items.find(item => item.id === approvalId)
        if (item) return { ...json(item.setupScope), state: item.status }
      }
      return null
    },
  })
  async function open() {
    mcp = await createExternalMcpService({ dataDirectory: join(directory, 'mcp') })
    skills = createSkillImportService({ dataDirectory: join(directory, 'skills') })
    store = await openTaskStore({ file: join(directory, 'isolated.sqlite'), bots: listBots(config), workspaceEnabled: false, calendarQueryEnabled: false,
      skillDirectory: { builtinDirectory: SKILL_DIRECTORY, userSkills: skills }, readCapabilityCatalog: providers,
      modelReply: async () => { const gate = hold; await gate.promise; return { mode: 'model', reply: { content: 'normal held user conversation' }, execution: { usage: { totalTokens: 3 } } } } })
    manager = createCapabilityManagement(options())
  }
  await open()
  const caller = await store.create({ botId: 'chief' })
  await transaction(async tx => { (await tx.doc(TaskCard, caller.taskId)).managementTools = ['mcp_manage', 'skill_manage'] })
  t.after(async () => { for (const gate of gates) gate.release(); await mcp.close(); await store.close(); await rm(directory, { recursive: true, force: true }) })
  const waitIdle = async () => {
    for (let i = 0; i < 500; i++) { if ((await store.get(caller.taskId)).activeInputId === null) return; await delay(5) }
    assert.fail('fixture user input did not finish')
  }
  return {
    directory, source, caller,
    get store() { return store }, get mcp() { return mcp }, get skills() { return skills }, get manager() { return manager }, transaction,
    options,
    async user(intent) {
      hold.release(); await waitIdle(); hold = deferred(); gates.add(hold)
      const sent = await store.send(caller.taskId, intent.resume ? `用户明确续办配置 ${intent.resume}` : `用户请求 ${intent.action} ${intent.source} 给 ${intent.targetBotId}`)
      intents.set(sent.messageId, intent)
      return sent.messageId
    },
    async userFor(taskId, intent) {
      const sent = await store.send(taskId, `用户请求 ${intent.action} ${intent.source} 给 ${intent.targetBotId}`)
      intents.set(sent.messageId, intent)
      return sent.messageId
    },
    async blank(name = `Target ${++sequence}`) { return (await store.createBot({ name, requestId: `blank-target-${sequence++}` })).bot },
    async revision(botId) { return (await store.getBotConfiguration(botId)).bot.configRef.version },
    async view(botId) { const catalog = await providers(); return transaction(tx => listBotCapabilities(tx, botId, { catalog })) },
    async approve(approvalId) { await transaction(async tx => { (await tx.doc(TaskApprovals, caller.taskId)).items.find(item => item.id === approvalId).status = 'approved' }) },
    async rebuild(overrides = {}) { manager = createCapabilityManagement({ ...options(), ...overrides }); return manager },
    async restart() { hold.release(); await store.close(); await mcp.close(); hold = deferred(); gates.add(hold); await open() },
  }
}
const call = (kind, args) => ({ name: `${kind}_manage`, arguments: args })
const execute = (f, inputId, kind, args) => f.manager.execute({ taskId: f.caller.taskId, inputId, call: call(kind, args) })
async function httpFixture(t, options = {}) { const server = await createFixtureMcpHttp(options); t.after(() => server.close()); return server }

async function addMcp(f, http, target, operationId, { credentialRequired = false } = {}) {
  const inputId = await f.user({ action: 'add', source: http.url, targetBotId: target.id })
  const args = { action: 'add', operationId, targetBotId: target.id, expectedRevision: await f.revision(target.id),
    config: { connectionId: operationId, name: 'Normal SDK setup fixture', transport: 'streamable-http', url: http.url, allowLoopback: true, credentialRequired } }
  return { inputId, args, result: await execute(f, inputId, 'mcp', args) }
}

test('a real user request configures, discovers and binds MCP, then target-only disable prevents its next authorized call', async t => {
  const http = await httpFixture(t), f = await fixture(t), target = await f.blank()
  const { inputId, args, result } = await addMcp(f, http, target, 'normal-mcp')
  assert.equal(result.ok, true); assert.equal(result.data.state, 'ready'); assert.equal(result.data.enabledForBot, true)
  assert.equal(http.calls.length, 0)
  assert.equal((await f.view(target.id)).items.find(item => item.id === 'mcp:normal-mcp').available, true)
  const echo = (await f.mcp.toolCatalog()).find(tool => tool.originalName === 'greeting.echo')
  const authorize = () => f.transaction(async tx => (await tx.doc(ToolAccess)).assignments[target.id].tools.includes(echo.name))
  assert.equal((await f.mcp.invoke({ connectionId: 'normal-mcp', toolName: echo.name, arguments: { text: 'normal target use' }, authorize })).structuredContent.echoed, 'normal target use')
  const replay = await execute(f, inputId, 'mcp', args)
  assert.equal(replay.data.replayed, true); assert.equal(replay.data.setupId, result.data.setupId)
  assert.equal((await f.mcp.connections()).length, 1)
  const stopInput = await f.user({ action: 'disable', source: 'normal-mcp', targetBotId: target.id })
  const stopped = await execute(f, stopInput, 'mcp', { action: 'disable', operationId: 'disable-normal-mcp', connectionId: 'normal-mcp', targetBotId: target.id, expectedRevision: await f.revision(target.id) })
  assert.equal(stopped.data.state, 'disabled'); assert.equal((await f.mcp.connections())[0].enabled, true)
  await assert.rejects(f.mcp.invoke({ connectionId: 'normal-mcp', toolName: echo.name, arguments: { text: 'must not run' }, authorize }), { code: 'MCP_NOT_AUTHORIZED' })
  assert.equal(http.calls.length, 1)
})

test('missing credentials survive a manager/store restart and resume the same setup after a separate secure save', async t => {
  const token = 'isolated-sdk-token', http = await httpFixture(t, { bearerToken: token }), f = await fixture(t), target = await f.blank()
  const { result } = await addMcp(f, http, target, 'auth-mcp', { credentialRequired: true })
  assert.equal(result.data.state, 'needs_auth'); assert.equal(result.data.enabledForBot, false)
  assert.deepEqual(result.data.credentialEntry, { kind: 'mcp-credential', connectionId: 'auth-mcp' })
  await f.restart()
  assert.equal((await f.manager.get(result.data.setupId, { taskId: f.caller.taskId })).state, 'needs_auth')
  const connection = (await f.mcp.connections())[0]
  await f.mcp.saveCredential({ connectionId: connection.connectionId, requestId: 'secure-host-save', expectedRevision: connection.revision, credential: { bearerToken: token } })
  const savedConnection = (await f.mcp.connections())[0]
  await f.mcp.check(savedConnection.connectionId, { requestId: 'secure-host-ui-check', expectedRevision: savedConnection.revision })
  const inputId = await f.user({ resume: 'auth-mcp' })
  const done = await f.manager.resume(result.data.setupId, { taskId: f.caller.taskId, inputId })
  assert.equal(done.ok, true); assert.equal(done.data.state, 'ready'); assert.equal(done.data.setupId, result.data.setupId)
  assert.equal(done.data.requestId, result.data.requestId)
  assert.equal((await f.mcp.connections()).length, 1)
  assert.equal(JSON.stringify(await f.store.harness.snapshot(CapabilitySetups, undefined, context)).includes(token), false)
})

test('a lost local registration response is resolved only by querying its exact durable receipt', async t => {
  const http = await httpFixture(t), f = await fixture(t), target = await f.blank()
  const original = f.mcp.configure.bind(f.mcp)
  let first = true, submitted = 0
  const wrapper = { ...f.mcp, configure: async input => {
    submitted++
    const result = await original(input)
    if (first) { first = false; throw Object.assign(new Error('synthetic lost response'), { unknown: true }) }
    return result
  } }
  await f.rebuild({ mcp: wrapper })
  const { inputId, result } = await addMcp(f, http, target, 'same-subrequest')
  assert.equal(result.data.state, 'unknown'); assert.equal(result.data.enabledForBot, false)
  const done = await f.manager.resume(result.data.setupId, { taskId: f.caller.taskId, inputId })
  assert.equal(done.data.state, 'ready'); assert.equal((await f.mcp.connections()).length, 1)
  assert.equal(submitted, 1)
})

test('a declarative Skill is imported and selected without silently granting the blank Bot any business dependency', async t => {
  const f = await fixture(t), target = await f.blank()
  const inputId = await f.user({ action: 'add', source: f.source, targetBotId: target.id })
  const result = await execute(f, inputId, 'skill', { action: 'add', operationId: 'declarative-skill', targetBotId: target.id, expectedRevision: await f.revision(target.id), source: { kind: 'local', path: f.source } })
  assert.equal(result.data.state, 'ready'); assert.equal(result.data.capabilityId, 'skill:setup-skill')
  assert.deepEqual((await f.store.getBotConfiguration(target.id)).assigned.tools, [])
  const targetTask = await f.store.create({ botId: target.id })
  const active = await f.store.activateSkill(targetTask.taskId, { skillId: 'setup-skill' })
  assert.equal(active.skillState.active.length, 1)
})

test('Skill mechanism tools require an exact host approval and still do not grant missing business tools or resources', async t => {
  const f = await fixture(t), target = await f.blank()
  await writeFile(join(f.source, 'SKILL.md'), markdown('setup-skill', '1.0', 'required-tools: [skill_read_resource, workspace.list]\nrequired-resources: [workspace:local]\n'))
  const inputId = await f.user({ action: 'add', source: f.source, targetBotId: target.id })
  const pending = await execute(f, inputId, 'skill', { action: 'add', operationId: 'skill-dependencies', targetBotId: target.id, expectedRevision: await f.revision(target.id), source: { kind: 'local', path: f.source } })
  assert.equal(pending.data.state, 'needs_confirmation'); assert.equal(typeof pending.data.approvalId, 'string')
  assert.deepEqual((await f.store.getBotConfiguration(target.id)).assigned.tools, [])
  await f.approve(pending.data.approvalId)
  const after = await f.manager.resume(pending.data.setupId, { taskId: f.caller.taskId, inputId })
  assert.equal(after.data.state, 'missing_dependency')
  const assigned = (await f.store.getBotConfiguration(target.id)).assigned
  assert.deepEqual([...assigned.tools].sort(), ['skill_activate', 'skill_deactivate', 'skill_read_resource'].sort())
  assert.deepEqual(assigned.resources, [])
  assert.ok(after.data.missing.some(item => item.id === 'workspace.list'))
})

test('shared global removal waits for real host confirmation and revokes every affected Bot binding', async t => {
  const http = await httpFixture(t), f = await fixture(t), a = await f.blank('First'), b = await f.blank('Second')
  assert.equal((await addMcp(f, http, a, 'shared-mcp')).result.data.state, 'ready')
  const bindInput = await f.user({ action: 'add', source: 'shared-mcp', targetBotId: b.id })
  const bound = await execute(f, bindInput, 'mcp', { action: 'add', operationId: 'bind-second', targetBotId: b.id, expectedRevision: await f.revision(b.id), connectionId: 'shared-mcp' })
  assert.equal(bound.data.state, 'ready')
  const removeInput = await f.user({ action: 'remove', source: 'shared-mcp', targetBotId: a.id })
  const pending = await execute(f, removeInput, 'mcp', { action: 'remove', operationId: 'remove-shared', targetBotId: a.id, expectedRevision: await f.revision(a.id), connectionId: 'shared-mcp' })
  assert.equal(pending.data.state, 'needs_confirmation'); assert.deepEqual([...pending.data.affectedBotIds].sort(), [a.id, b.id].sort())
  assert.equal((await f.mcp.connections()).length, 1)
  await f.approve(pending.data.approvalId)
  const removed = await f.manager.resume(pending.data.setupId, { taskId: f.caller.taskId, inputId: removeInput })
  assert.equal(removed.data.state, 'removed'); assert.equal((await f.mcp.connections()).length, 0)
  const access = await f.store.harness.snapshot(ToolAccess, undefined, context)
  for (const bot of [a, b]) assert.equal(access.assignments[bot.id].tools.some(name => name.startsWith('mcp_')), false)
})

test('management uses real input and explicit management access; parser never accepts credentials or approval flags', async t => {
  assert.equal(validCapabilityManagementArgs(call('mcp', { action: 'resume', operationId: 'operation', approved: true })), false)
  assert.equal(validCapabilityManagementArgs(call('mcp', { action: 'add', operationId: 'operation', targetBotId: 'todo', expectedRevision: '1', config: { connectionId: 'config', name: 'Config', transport: 'streamable-http', url: 'https://mcp.vendor.com', bearerToken: 'not-an-argument' } })), false)
  const f = await fixture(t), target = await f.blank(), inputId = await f.user({ action: 'add', source: f.source, targetBotId: target.id })
  const args = { action: 'add', operationId: 'authority', targetBotId: target.id, expectedRevision: await f.revision(target.id), source: { kind: 'local', path: f.source } }
  assert.equal(parseCapabilityManagementCall(call('skill', args)).kind, 'skill')
  await f.rebuild({ authorizeIntent: async () => null })
  await assert.rejects(execute(f, inputId, 'skill', args), { code: 'SETUP_NOT_AUTHORIZED' })
  assert.equal((await f.skills.skillCatalog()).skills.length, 0)
  await f.rebuild({ canManage: async () => false })
  await assert.rejects(execute(f, inputId, 'skill', args), { code: 'SETUP_NOT_AUTHORIZED' })
  assert.throws(() => createCapabilityManagement({ ...f.options(), authorizeIntent: undefined }), { code: 'SETUP_INVALID_ARGS' })
})


test('an unresolved administrative outcome is only queried and is never submitted again on resume', async t => {
  const http = await httpFixture(t), f = await fixture(t), target = await f.blank()
  let submitted = 0, queried = 0
  await f.rebuild({ mcp: { ...f.mcp,
    configure: async () => { submitted++; throw Object.assign(new Error('synthetic outstanding response'), { unknown: true }) },
    requestStatus: async () => { queried++; return null },
  } })
  const { inputId, result } = await addMcp(f, http, target, 'outstanding-admin')
  assert.equal(result.data.state, 'unknown')
  const pending = await f.manager.resume(result.data.setupId, { taskId: f.caller.taskId, inputId })
  assert.equal(pending.data.state, 'unknown'); assert.equal(pending.data.enabledForBot, false)
  assert.equal(submitted, 1); assert.equal(queried, 1)
  assert.equal((await f.mcp.connections()).length, 0)
})

test('ordinary MCP update changes only the selected source under current target CAS and keeps the existing registration id', async t => {
  const first = await httpFixture(t), second = await httpFixture(t), f = await fixture(t), target = await f.blank()
  assert.equal((await addMcp(f, first, target, 'updatable-mcp')).result.data.state, 'ready')
  const initialSource = (await f.mcp.connections())[0].sourceRevision
  const inputId = await f.user({ action: 'update', source: second.url, targetBotId: target.id })
  const updated = await execute(f, inputId, 'mcp', { action: 'update', operationId: 'update-mcp-source', connectionId: 'updatable-mcp', targetBotId: target.id,
    expectedRevision: await f.revision(target.id), config: { connectionId: 'updatable-mcp', name: 'Updated fixture', transport: 'streamable-http', url: second.url, allowLoopback: true } })
  assert.equal(updated.data.state, 'ready')
  assert.equal((await f.mcp.connections()).length, 1)
  assert.notEqual((await f.mcp.connections())[0].sourceRevision, initialSource)
  assert.equal(updated.data.connectionId, 'updatable-mcp')
})

test('ordinary Skill update and rollback keep an already active Task snapshot and expose the chosen version to a fresh Task', async t => {
  const f = await fixture(t), target = await f.blank()
  let inputId = await f.user({ action: 'add', source: f.source, targetBotId: target.id })
  const added = await execute(f, inputId, 'skill', { action: 'add', operationId: 'versioned-skill', targetBotId: target.id, expectedRevision: await f.revision(target.id), source: { kind: 'local', path: f.source } })
  assert.equal(added.data.state, 'ready')
  const v1 = (await f.skills.skillCatalog()).skills[0].hash, oldTask = await f.store.create({ botId: target.id })
  const active = await f.store.activateSkill(oldTask.taskId, { skillId: 'setup-skill' })
  const oldRef = active.skillState.active[0].ref
  await writeFile(join(f.source, 'SKILL.md'), markdown('setup-skill', '2.0'))
  inputId = await f.user({ action: 'update', source: f.source, targetBotId: target.id })
  const updated = await execute(f, inputId, 'skill', { action: 'update', operationId: 'update-versioned-skill', skillId: 'setup-skill', targetBotId: target.id,
    expectedRevision: await f.revision(target.id), source: { kind: 'local', path: f.source } })
  assert.equal(updated.data.state, 'ready')
  assert.equal((await f.skills.skillCatalog()).skills[0].version, '2.0')
  assert.deepEqual((await f.store.get(oldTask.taskId)).skillState.active[0].ref, oldRef)
  const fresh = await f.store.create({ botId: target.id })
  assert.equal((await f.store.activateSkill(fresh.taskId, { skillId: 'setup-skill' })).skillState.active[0].version, '2.0')
  inputId = await f.user({ action: 'rollback', source: 'setup-skill', targetBotId: target.id })
  const rolledBack = await execute(f, inputId, 'skill', { action: 'rollback', operationId: 'rollback-versioned-skill', skillId: 'setup-skill', hash: v1,
    targetBotId: target.id, expectedRevision: await f.revision(target.id) })
  assert.equal(rolledBack.data.state, 'ready')
  assert.equal((await f.skills.skillCatalog()).skills[0].hash, v1)
})

test('a shared Skill removal requires host approval and clears every saved Skill selection', async t => {
  const f = await fixture(t), a = await f.blank('Skill first'), b = await f.blank('Skill second')
  let inputId = await f.user({ action: 'add', source: f.source, targetBotId: a.id })
  assert.equal((await execute(f, inputId, 'skill', { action: 'add', operationId: 'shared-skill', targetBotId: a.id, expectedRevision: await f.revision(a.id), source: { kind: 'local', path: f.source } })).data.state, 'ready')
  inputId = await f.user({ action: 'add', source: 'setup-skill', targetBotId: b.id })
  assert.equal((await execute(f, inputId, 'skill', { action: 'add', operationId: 'shared-skill-second', skillId: 'setup-skill', targetBotId: b.id, expectedRevision: await f.revision(b.id) })).data.state, 'ready')
  inputId = await f.user({ action: 'unbind', source: 'setup-skill', targetBotId: a.id })
  const unbound = await execute(f, inputId, 'skill', { action: 'unbind', operationId: 'shared-skill-unbind-first', skillId: 'setup-skill', targetBotId: a.id, expectedRevision: await f.revision(a.id) })
  assert.equal(unbound.data.state, 'unbound')
  assert.equal((await f.view(b.id)).items.find(item => item.id === 'skill:setup-skill').enabledForBot, true)
  assert.equal((await f.skills.skillCatalog()).skills.length, 1)
  inputId = await f.user({ action: 'remove', source: 'setup-skill', targetBotId: a.id })
  const pending = await execute(f, inputId, 'skill', { action: 'remove', operationId: 'shared-skill-remove', skillId: 'setup-skill', targetBotId: a.id, expectedRevision: await f.revision(a.id) })
  assert.equal(pending.data.state, 'needs_confirmation')
  assert.deepEqual([...pending.data.affectedBotIds].sort(), [a.id, b.id].sort())
  await f.approve(pending.data.approvalId)
  const removed = await f.manager.resume(pending.data.setupId, { taskId: f.caller.taskId, inputId })
  assert.equal(removed.data.state, 'removed')
  const selected = await f.store.harness.snapshot(CapabilityAssignments, undefined, context)
  for (const bot of [a, b]) assert.equal(selected.skills[bot.id]['skill:setup-skill'], false)
})


test('an ordinary Bot cannot manage capabilities until the host explicitly grants that management tool', async t => {
  const f = await fixture(t), target = await f.blank(), agent = await f.store.create({ botId: 'todo' })
  const inputId = await f.userFor(agent.taskId, { action: 'add', source: f.source, targetBotId: target.id })
  const request = { taskId: agent.taskId, inputId, call: call('skill', { action: 'add', operationId: 'explicit-config-agent', targetBotId: target.id,
    expectedRevision: await f.revision(target.id), source: { kind: 'local', path: f.source } }) }
  await assert.rejects(f.manager.execute(request), { code: 'SETUP_NOT_AUTHORIZED' })
  assert.equal((await f.skills.skillCatalog()).skills.length, 0)
  await f.transaction(async tx => { (await tx.doc(ToolAccess)).assignments.todo.tools.push('skill_manage') })
  const allowed = await f.manager.execute(request)
  assert.equal(allowed.data.state, 'ready')
  assert.equal(allowed.data.taskId, agent.taskId)
})

test('concurrent repeated setup calls join the same exact operation and preserve one registration and binding receipt', async t => {
  const http = await httpFixture(t), f = await fixture(t), target = await f.blank()
  const inputId = await f.user({ action: 'add', source: http.url, targetBotId: target.id })
  const args = { action: 'add', operationId: 'concurrent-setup', targetBotId: target.id, expectedRevision: await f.revision(target.id),
    config: { connectionId: 'concurrent-setup', name: 'Concurrent normal source', transport: 'streamable-http', url: http.url, allowLoopback: true } }
  const [first, second] = await Promise.all([execute(f, inputId, 'mcp', args), execute(f, inputId, 'mcp', args)])
  assert.equal(first.data.state, 'ready'); assert.equal(second.data.state, 'ready')
  assert.equal(first.data.setupId, second.data.setupId)
  assert.ok(first.data.replayed || second.data.replayed)
  assert.equal((await f.mcp.connections()).length, 1)
  const records = await f.store.harness.snapshot(CapabilitySetups, undefined, context)
  assert.equal(Object.values(records.items).filter(item => item.proposal.operationId === 'concurrent-setup').length, 1)
})

test('an unknown Skill import without an authoritative receipt remains unknown instead of trusting matching catalog content', async t => {
  const f = await fixture(t), target = await f.blank(), original = f.skills.importSkill.bind(f.skills)
  let submitted = 0
  await f.rebuild({ skills: { ...f.skills, requestStatus: async () => null, importSkill: async input => {
    submitted++
    await original(input)
    throw Object.assign(new Error('synthetic lost import response'), { unknown: true })
  } } })
  const inputId = await f.user({ action: 'add', source: f.source, targetBotId: target.id })
  const result = await execute(f, inputId, 'skill', { action: 'add', operationId: 'unknown-import', targetBotId: target.id, expectedRevision: await f.revision(target.id), source: { kind: 'local', path: f.source } })
  assert.equal(result.data.state, 'unknown'); assert.equal(result.data.enabledForBot, false)
  assert.equal((await f.skills.skillCatalog()).skills.length, 1)
  const pending = await f.manager.resume(result.data.setupId, { taskId: f.caller.taskId, inputId })
  assert.equal(pending.data.state, 'unknown'); assert.equal(pending.data.enabledForBot, false)
  assert.equal(submitted, 1)
})


test('a stale target revision after host confirmation prevents a global source update before any registration mutation', async t => {
  const first = await httpFixture(t), second = await httpFixture(t), f = await fixture(t), a = await f.blank('CAS first'), b = await f.blank('CAS second')
  assert.equal((await addMcp(f, first, a, 'cas-shared-source')).result.data.state, 'ready')
  let inputId = await f.user({ action: 'add', source: 'cas-shared-source', targetBotId: b.id })
  assert.equal((await execute(f, inputId, 'mcp', { action: 'add', operationId: 'cas-bind-second', connectionId: 'cas-shared-source', targetBotId: b.id, expectedRevision: await f.revision(b.id) })).data.state, 'ready')
  const originalSource = (await f.mcp.connections())[0].sourceRevision
  inputId = await f.user({ action: 'update', source: second.url, targetBotId: a.id })
  const pending = await execute(f, inputId, 'mcp', { action: 'update', operationId: 'cas-global-update', targetBotId: a.id, expectedRevision: await f.revision(a.id),
    config: { connectionId: 'cas-shared-source', name: 'Changed source', transport: 'streamable-http', url: second.url, allowLoopback: true } })
  assert.equal(pending.data.state, 'needs_confirmation')
  await f.approve(pending.data.approvalId)
  const catalog = await f.options().readCatalog({ kind: 'mcp', targetBotId: a.id })
  await f.transaction(async tx => {
    const view = await listBotCapabilities(tx, a.id, { catalog })
    await setCapabilityAssignment(tx, a.id, { requestId: 'separate-user-history-change', capabilityId: 'tool:history', enabled: true,
      expectedRevision: view.revision, expectedCatalogRevision: view.items.find(item => item.id === 'tool:history').revision }, { catalog })
  })
  const stopped = await f.manager.resume(pending.data.setupId, { taskId: f.caller.taskId, inputId })
  assert.equal(stopped.data.state, 'error'); assert.equal(stopped.error.code, 'SETUP_TARGET_CHANGED')
  assert.equal((await f.mcp.connections())[0].sourceRevision, originalSource)
})

test('a committed Skill import with a lost response advances only after its real operation-specific durable receipt is read', async t => {
  const f = await fixture(t), target = await f.blank(), original = f.skills.importSkill.bind(f.skills)
  let submitted = 0, queried = 0
  await f.rebuild({ skills: { ...f.skills,
    importSkill: async input => { submitted++; await original(input); throw Object.assign(new Error('synthetic committed response loss'), { unknown: true }) },
    requestStatus: async requestId => { queried++; return f.skills.requestStatus(requestId) },
  } })
  const inputId = await f.user({ action: 'add', source: f.source, targetBotId: target.id })
  const result = await execute(f, inputId, 'skill', { action: 'add', operationId: 'known-import-receipt', targetBotId: target.id,
    expectedRevision: await f.revision(target.id), source: { kind: 'local', path: f.source } })
  assert.equal(result.data.state, 'unknown')
  const known = await f.manager.resume(result.data.setupId, { taskId: f.caller.taskId, inputId })
  assert.equal(known.data.state, 'ready')
  assert.equal(submitted, 1); assert.equal(queried, 1)
  assert.equal((await f.skills.skillCatalog()).skills.length, 1)
})


test('GET alone reconciles a lost response without checking or binding; only explicit resume advances the confirmed setup', async t => {
  const http = await httpFixture(t), f = await fixture(t), target = await f.blank()
  const original = f.mcp.configure.bind(f.mcp)
  let submitted = 0, checked = 0
  await f.rebuild({ mcp: { ...f.mcp,
    configure: async input => { submitted++; await original(input); throw Object.assign(new Error('synthetic committed response loss'), { unknown: true }) },
    check: async (...args) => { checked++; return f.mcp.check(...args) },
  } })
  const { inputId, result } = await addMcp(f, http, target, 'readonly-reconciliation')
  assert.equal(result.data.state, 'unknown'); assert.equal(result.data.canResume, false)
  const observed = await f.manager.get(result.data.setupId, { taskId: f.caller.taskId })
  assert.equal(observed.state, 'pending'); assert.equal(observed.canResume, true)
  assert.equal(observed.enabledForBot, false)
  assert.equal(checked, 0); assert.equal(submitted, 1); assert.equal(http.calls.length, 0)
  const view = await f.view(target.id)
  assert.equal(view.items.find(item => item.id === 'mcp:readonly-reconciliation').enabledForBot, false)
  const observedAgain = await f.manager.get(result.data.setupId, { taskId: f.caller.taskId })
  assert.equal(observedAgain.state, 'pending'); assert.equal(checked, 0); assert.equal(submitted, 1)
  const continued = await f.manager.resume(result.data.setupId, { taskId: f.caller.taskId, inputId })
  assert.equal(continued.data.state, 'ready'); assert.equal(continued.data.enabledForBot, true)
  assert.equal(checked, 1); assert.equal(submitted, 1)
})

test('GET without a matching durable receipt keeps unknown non-resumable and never submits the mutation again', async t => {
  const http = await httpFixture(t), f = await fixture(t), target = await f.blank()
  let submitted = 0, queried = 0
  await f.rebuild({ mcp: { ...f.mcp,
    configure: async () => { submitted++; throw Object.assign(new Error('synthetic outstanding request'), { unknown: true }) },
    requestStatus: async () => { queried++; return null },
  } })
  const { result } = await addMcp(f, http, target, 'readonly-outstanding')
  const observed = await f.manager.get(result.data.setupId, { taskId: f.caller.taskId })
  assert.equal(observed.state, 'unknown'); assert.equal(observed.canResume, false)
  assert.equal(observed.enabledForBot, false)
  assert.equal(submitted, 1); assert.equal(queried, 1)
})

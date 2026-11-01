import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSkillImportService } from './skill-import.mjs'
import { createSkillLearningService } from './skill-learning.mjs'
import { loadSkill, skillCapabilityCatalog } from './skills.mjs'

test('learned methods are immutable, deduplicated, owner-scoped and revoked at read time', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pidot-learning-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const imports = createSkillImportService({ dataDirectory: root })
  let readable = true
  const learning = createSkillLearningService({ userSkills: imports, isEvidenceReadable: async () => readable, getCapabilities: async () => ({ tools: ['read'], resources: [] }) })
  const candidate = { methodKey: 'project:build', name: 'Build', description: 'Validated build process', applicability: 'Only this project', rules: 'Read configuration and verify build.', requiredTools: ['read'], references: [{ path: 'references/check.md', content: 'Check the successful build result.' }] }
  const evidence = [{ taskId: 1, entryId: 3, kind: 'tool-result', fingerprint: 'abc' }]
  const first = await learning.publish({ botId: 'bot-a', candidate, evidence })
  const duplicate = await learning.publish({ botId: 'bot-a', candidate, evidence })
  assert.equal(duplicate.noChange, true)
  const second = await learning.publish({ botId: 'bot-a', candidate: { ...candidate, rules: 'Read configuration and run verification.' }, evidence, expectedVersion: first.hash })
  assert.equal(first.id, second.id)
  assert.notEqual(first.hash, second.hash)
  assert.equal((await imports.skillSource(first.id, { hash: first.hash })).rules, candidate.rules)
  const directory = { builtinDirectory: join(root, 'empty'), userSkills: learning }
  const snapshot = await loadSkill(first.id, directory)
  assert.equal(snapshot.learningSource.ownerBotId, 'bot-a')
  assert.equal((await skillCapabilityCatalog(directory, { card: { bot: { id: 'bot-b' } } })).length, 0)
  const catalog = await imports.skillCatalog()
  await imports.rollbackSkill({ requestId: 'rollback-1', skillId: first.id, hash: first.hash, expectedRevision: catalog.revision })
  assert.equal((await loadSkill(first.id, directory)).rules, candidate.rules)
  await assert.rejects(learning.publish({ botId: 'bot-a', candidate, evidence, expectedVersion: first.hash }), { code: 'SKILL_LEARNING_USER_CONFLICT' })
  readable = false
  assert.equal((await skillCapabilityCatalog(directory)).length, 0)
  await assert.rejects(learning.assertLearningAccess({ source: snapshot.learningSource, botId: 'bot-a' }), { code: 'SKILL_LEARNING_SOURCE_UNAVAILABLE' })
})

test('learning fails closed on evidence, missing capabilities, scripts and credentials', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pidot-learning-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const imports = createSkillImportService({ dataDirectory: root })
  let readable = false
  const learning = createSkillLearningService({ userSkills: imports, isEvidenceReadable: async () => readable, getCapabilities: async () => ({ tools: [], resources: [] }) })
  const input = { botId: 'bot-a', candidate: { methodKey: 'build', name: 'Build', description: 'Build', applicability: 'Project only', rules: 'Verify output.' }, evidence: [{ taskId: 1, entryId: 2 }] }
  await assert.rejects(learning.publish(input), { code: 'SKILL_LEARNING_EVIDENCE_INVALID' })
  readable = true
  await assert.rejects(learning.publish({ ...input, candidate: { ...input.candidate, requiredTools: ['bash'] } }), { code: 'SKILL_DEPENDENCY_MISSING' })
  await assert.rejects(learning.publish({ ...input, candidate: { ...input.candidate, rules: 'Run scripts/install.sh' } }), { code: 'SKILL_LEARNING_INVALID' })
  await assert.rejects(learning.publish({ ...input, candidate: { ...input.candidate, rules: 'api_key=secret12345' } }), { code: 'SKILL_LEARNING_SECRET' })
  assert.equal((await imports.skillCatalog()).skills.length, 0)
})

test('user removal is a durable learning tombstone while explicit manual import can restore', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pidot-learning-removed-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const imports = createSkillImportService({ dataDirectory: join(root, 'storage') })
  const options = { userSkills: imports, isEvidenceReadable: async () => true, getCapabilities: async () => ({ tools: [], resources: [] }) }
  let learning = createSkillLearningService(options)
  const input = { botId: 'bot-a', candidate: { methodKey: 'project:verify', name: 'Verify', description: 'Validated method', applicability: 'This project', rules: 'Inspect output and verify.' }, evidence: [{ taskId: 1, entryId: 3 }] }
  const first = await learning.publish(input)
  await imports.removeSkill({ requestId: 'remove-learned-method', skillId: first.id, expectedRevision: first.catalogRevision, affectedBotIds: ['bot-a'], confirmGlobal: true })
  assert.equal((await imports.skillCatalog()).skills.length, 0)
  learning = createSkillLearningService(options)
  await assert.rejects(learning.publish(input), { code: 'SKILL_LEARNING_USER_CONFLICT' })
  assert.equal((await imports.skillRegistration(first.id)).removed, true)
  const { mkdir, writeFile } = await import('node:fs/promises')
  const directory = join(root, 'manual')
  await mkdir(directory)
  await writeFile(join(directory, 'SKILL.md'), `---\nname: ${first.id}\ndescription: User restored method\n---\nUser edited process.`)
  const prepared = await imports.prepareSkillImport({ kind: 'local', path: directory })
  const catalog = await imports.skillCatalog()
  const restored = await imports.importSkill({ requestId: 'manual-restore-method', preparedId: prepared.preparedId, expectedRevision: catalog.revision })
  assert.equal(restored.removed, false)
  assert.equal(restored.source.kind, 'local')
  await assert.rejects(learning.publish(input), { code: 'SKILL_LEARNING_OWNER_CONFLICT' })
})

test('revoked learned provenance removes names and descriptions from task prompt catalog', async t => {
  const { BACKGROUND_CONTEXT } = await import('@earendil-works/chord/context')
  const { openTaskStore } = await import('./fixtures/authorized-task-store.mjs')
  const { listBots } = await import('./bots.mjs')
  const { TaskCard } = await import('./tasks.mjs')
  const { skillCatalogForTask } = await import('./skills.mjs')
  const root = await mkdtemp(join(tmpdir(), 'pidot-learning-catalog-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const imports = createSkillImportService({ dataDirectory: join(root, 'skills') })
  let readable = true
  const learning = createSkillLearningService({ userSkills: imports, isEvidenceReadable: async () => readable, getCapabilities: async () => ({ tools: [], resources: [] }) })
  const published = await learning.publish({ botId: 'calendar', candidate: { methodKey: 'private-project', name: 'Private', description: 'private-project-description', applicability: 'Private only', rules: 'Verified private method.', references: [{ path: 'references/private.md', content: 'PRIVATE_REFERENCE_SENTINEL' }] }, evidence: [{ taskId: 1, entryId: 2 }] })
  const directory = { builtinDirectory: join(root, 'none'), userSkills: learning }
  const bots = listBots({ model: 'fixture', baseUrl: 'https://fixture.invalid/v1', apiKey: 'test' })
  const store = await openTaskStore({ file: join(root, 'task.sqlite'), bots, skillDirectory: directory })
  t.after(() => store.close())
  const task = await store.create({ botId: 'calendar' })
  directory.userSkills = learning
  const catalog = () => store.harness.commit(async tx => skillCatalogForTask(tx, await tx.doc(TaskCard, task.taskId), bots, directory), BACKGROUND_CONTEXT)
  assert.equal((await catalog()).some(item => item.id === published.id), true)
  const { executeSkillTool, skillCapabilityCatalog } = await import('./skills.mjs')
  const { assignLearnedSkill } = await import('./capability-assignments.mjs')
  const { ContextCompaction } = await import('./context-compaction.mjs')
  const { buildTaskContext } = await import('./task-context.mjs')
  let inputId
  await store.harness.commitWith(async tx => {
    const card = await tx.doc(TaskCard, task.taskId)
    await assignLearnedSkill(tx, 'calendar', `skill:${published.id}`, await skillCapabilityCatalog(directory, { tx }))
    const user = await tx.appendEntry(card.conversationId, { kind: 'pidot.user', byTaskId: task.taskId, data: { content: 'Use the verified method', createdAt: new Date().toISOString() } })
    inputId = user.id
    assert.equal((await executeSkillTool(tx, card, bots, { name: 'skill_activate', arguments: { skillId: published.id } }, inputId, directory)).ok, true)
    const loaded = await loadSkill(published.id, directory)
    const args = { skillId: published.id, referenceId: loaded.resources[0].id }
    const result = await executeSkillTool(tx, card, bots, { name: 'skill_read_resource', arguments: args }, inputId, directory)
    assert.equal(result.ok, true, JSON.stringify(result))
    const turn = await tx.appendEntry(card.conversationId, { kind: 'pidot.model-tool-turn', byTaskId: task.taskId, data: { inReplyTo: inputId, assistant: { role: 'assistant', content: [{ type: 'toolCall', id: 'private-read', name: 'skill_read_resource', arguments: args }] } } })
    await tx.appendEntry(card.conversationId, { kind: 'pidot.tool-result', byTaskId: task.taskId, data: { inReplyTo: inputId, turnId: turn.id, toolName: 'skill_read_resource', arguments: args, result, toolResult: { role: 'toolResult', toolCallId: 'private-read', toolName: 'skill_read_resource', content: [{ type: 'text', text: JSON.stringify(result) }] } } })
  }, BACKGROUND_CONTEXT, { taskId: task.taskId, conversationId: task.conversationId })
  await store.harness.commit(async tx => {
    const liveContext = await buildTaskContext(tx, await tx.doc(TaskCard, task.taskId), inputId, { bots, skillDirectory: directory })
    assert.match(liveContext.systemPrompt, /Verified private method/ )
    assert.match(JSON.stringify(liveContext.messages), /PRIVATE_REFERENCE_SENTINEL/)
    const compacted = await tx.doc(ContextCompaction, task.taskId)
    compacted.latest = { summary: 'PRIVATE_COMPACTION_SENTINEL', createdAt: new Date().toISOString() }
    compacted.coveredKeys = [`input:${inputId}`]
  }, BACKGROUND_CONTEXT)
  readable = false
  assert.deepEqual(await catalog(), [])
  await store.harness.commit(async tx => {
    const context = await buildTaskContext(tx, await tx.doc(TaskCard, task.taskId), inputId, { bots, skillDirectory: directory })
    assert.doesNotMatch(JSON.stringify(context), /PRIVATE_REFERENCE_SENTINEL|PRIVATE_COMPACTION_SENTINEL|private-project-description/)
    assert.equal((await tx.doc(ContextCompaction, task.taskId)).latest, null)
  }, BACKGROUND_CONTEXT)
})

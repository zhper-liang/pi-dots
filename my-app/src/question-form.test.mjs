import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'
import { validQuestions, questionsFor, validateAnswers, canSkipQuestions, questionDraftKey } from '../shared/question-form.mjs'

const choice = { id: 'timezone', question: '使用哪个时区？', type: 'single', options: [{ id: 'shanghai', label: '上海（推荐）' }, { id: 'tokyo', label: '东京' }] }
const multiple = { id: 'days', question: '选择日期', type: 'multiple', options: [{ id: 'monday', label: '周一' }, { id: 'friday', label: '周五' }] }

test('question definitions have bounded stable identities and optional questions need an explicit default', () => {
  assert.equal(validQuestions([choice]), true)
  assert.equal(validQuestions([choice, multiple, { id: 'name', question: '名称', type: 'text' }]), true)
  for (const invalid of [[], [choice, choice], [{ ...choice, options: [{ id: 'other', label: '填入' }, { id: 'a', label: 'A' }] }], [{ ...choice, required: false }], [{ ...choice, surprise: true }], Array(4).fill(choice)]) assert.equal(validQuestions(invalid), false)
  const optional = [{ id: 'style', question: '格式', type: 'text', required: false, defaultAnswer: '使用列表' }]
  assert.equal(validQuestions(optional), true)
  assert.equal(canSkipQuestions(optional), true)
  assert.equal(canSkipQuestions([choice]), false)
})

test('answers preserve structured choices and reject unknown, duplicate and empty other choices', () => {
  assert.equal(validateAnswers([choice], {}).ok, false)
  assert.equal(validateAnswers([choice], { timezone: { optionId: 'hidden' } }).ok, false)
  assert.equal(validateAnswers([choice], { timezone: { optionId: 'other' } }).ok, false)
  assert.equal(validateAnswers([choice], { timezone: { optionId: 'tokyo', other: 'unexpected' } }).ok, false)
  assert.equal(validateAnswers([multiple], { days: { optionIds: ['monday', 'monday'] } }).ok, false)
  assert.equal(validateAnswers([choice], { timezone: { optionIds: ['tokyo'] } }).ok, false)
  assert.equal(validateAnswers([choice], { wrongQuestion: 'Tokyo' }).ok, false)
  const result = validateAnswers([choice, multiple], { timezone: { optionId: 'other', other: '  UTC  ' }, days: { optionIds: ['monday', 'friday'] } })
  assert.equal(result.ok, true)
  assert.deepEqual(result.answers, { timezone: { optionId: 'other', other: 'UTC' }, days: { optionIds: ['monday', 'friday'] } })
  assert.match(result.answer, /自己填写：UTC/)
  assert.match(result.answer, /周一；周五/)
})

test('clearing optional selected choices falls back to declared defaults without blocking the remaining required answer', () => {
  const optionalMultiple = { ...multiple, required: false, defaultAnswer: '不限制日期' }
  const optionalSingle = { ...choice, required: false, defaultAnswer: 'Asia/Shanghai' }
  assert.equal(validateAnswers([optionalMultiple], { days: { optionIds: [] } }).ok, true)
  assert.equal(validateAnswers([optionalSingle], { timezone: { optionId: '' } }).ok, true)
  const mixed = validateAnswers([choice, optionalMultiple], { timezone: { optionId: 'tokyo' }, days: { optionIds: [] } })
  assert.equal(mixed.ok, true)
  assert.deepEqual(mixed.answers, { timezone: { optionId: 'tokyo' } })
  assert.match(mixed.answer, /使用默认方案（不限制日期）/)
  assert.equal(validateAnswers([multiple], { days: { optionIds: [] } }).ok, false)
})

test('legacy question fallback and draft ownership are stable across polling but isolated by version and task', () => {
  const item = { id: 7, question: '日期？', version: 2 }
  assert.deepEqual(questionsFor(item), [{ id: 'answer', question: '日期？', type: 'text', required: true }])
  assert.equal(validateAnswers(questionsFor(item), { answer: ' 明天 ' }).answer, '明天')
  assert.notEqual(questionDraftKey('a', 1, item), questionDraftKey('b', 1, item))
  assert.notEqual(questionDraftKey('a', 1, item), questionDraftKey('a', 2, item))
  assert.notEqual(questionDraftKey('a', 1, item), questionDraftKey('a', 1, { ...item, version: 3 }))
  assert.equal(validateAnswers([{ id: 'format', question: '格式', type: 'text', required: false, defaultAnswer: '列表' }], {}).answer, '格式：使用默认方案（列表）')
})

const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
const text = node => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props?.children) : typeof node === 'string' ? node : ''
function nodes(node) { return Array.isArray(node) ? node.flatMap(nodes) : node && typeof node === 'object' && node.props ? [node, ...nodes(node.props.children), ...nodes(node.props.actions)] : [] }
const find = (tree, type, predicate = () => true) => nodes(tree).find(node => node.type === type && predicate(node.props))
const button = (tree, label) => find(tree, 'button', props => text(props.children) === label)
const tick = () => new Promise(resolve => setImmediate(resolve))
async function mount(t, initialProps, fetchImpl, filename = './TaskBlockerControls.tsx', exportName = 'QuestionCard') {
  const hooksUrl = moduleUrl(`let cursor=0,queue=[]; const slots=[],effects=[];
    export function start(){cursor=0} export function useState(initial){const i=cursor++; if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial; return[slots[i],next=>{slots[i]=typeof next==='function'?next(slots[i]):next}]} export function useRef(initial){return useState(()=>({current:initial}))[0]}
    export function useEffect(callback,deps){const i=cursor++,prev=slots[i];if(!prev||deps.some((v,j)=>v!==prev[j])){slots[i]=deps;queue.push(()=>{effects[i]?.();effects[i]=callback()})}} export function flush(){const q=queue;queue=[];for(const fn of q)fn()} export function dispose(){for(const fn of effects)fn?.()} // ${Math.random()}`)
  const hooks = await import(hooksUrl)
  const pathUrl = moduleUrl(ts.transpileModule(await readFile(new URL('./taskPath.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText)
  const hookUrl = moduleUrl(`import { useEffect } from '${hooksUrl}'; export function useWorkspaceRefresh(options) { useEffect(() => { if (!options.active) return; let active = true; const controller = new AbortController(); void options.load({signal:controller.signal,isCurrent:()=>active}).catch(error=>{if(active)options.onError?.(error)}); return()=>{active=false;controller.abort()} },[options.scopeKey,options.active]); return {refresh:()=>options.load({signal:new AbortController().signal,isCurrent:()=>true}).catch(error=>options.onError?.(error))} }`)
  const source = await readFile(new URL(filename, import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }, transformers: { before: [context => root => ts.visitNode(root, function visit(node) {
    if (!ts.isImportDeclaration(node)) return ts.visitEachChild(node, visit, context)
    if (!node.importClause || node.importClause.isTypeOnly) return undefined
    const path = node.moduleSpecifier.text
    const target = path === 'react' ? hooksUrl : path === './taskPath' ? pathUrl : path === './useWorkspaceRefresh' ? hookUrl : path.endsWith('.mjs') ? new URL(path, import.meta.url).href : null
    if (target) return ts.factory.updateImportDeclaration(node, node.modifiers, node.importClause, ts.factory.createStringLiteral(target), node.attributes)
    const names = [node.importClause.name?.text, ...(node.importClause.namedBindings?.elements ?? []).filter(entry => !entry.isTypeOnly).map(entry => entry.name.text)].filter(Boolean)
    return ts.factory.createVariableStatement(undefined, ts.factory.createVariableDeclarationList(names.map(name => ts.factory.createVariableDeclaration(name, undefined, undefined, ts.factory.createStringLiteral(name))), ts.NodeFlags.Const))
  })] } }).outputText.replaceAll('"react/jsx-runtime"', JSON.stringify(import.meta.resolve('react/jsx-runtime')))
  const Component = (await import(moduleUrl(compiled)))[exportName]
  const originals = new Map(), storage = new Map(), posts = [], requests = []
  function replace(key, value) { originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }) }
  replace('sessionStorage', { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) })
  replace('fetch', async (url, init) => { requests.push({url,init}); if (init.body) posts.push({ url, body: JSON.parse(init.body) }); return fetchImpl ? fetchImpl(url, init) : { ok: true, json: async () => ({ task: initialProps.task }) } })
  t.after(() => { hooks.dispose(); for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] } })
  let props = initialProps
  function expand(node) { if (Array.isArray(node)) return node.map(expand); if (!node || typeof node !== 'object' || !node.props) return node; if (typeof node.type === 'function') return expand(node.type(node.props)); return { ...node, props: { ...node.props, children: expand(node.props.children) } } }
  function render() { hooks.start(); const tree = expand(Component(props)); hooks.flush(); return tree }
  return { render, storage, posts, requests, update(next) { props = { ...props, ...next }; return render() } }
}
const item = overrides => ({ id: 12, taskId: 2, question: '使用哪个时区？', requiredInformation: '时区', assignee: 'user', status: 'pending', version: 3, inReplyTo: 8, parked: true, questions: [choice], answer: null, ...overrides })
const props = overrides => ({ task: { taskId: 2, bot: { id: 'pipi' }, title: '安排会议', blockers: { activeId: null, items: [] }, runtime: { status: 'running' } }, item: item(), token: 'test-token', editable: true, cancelled: false, onUpdated() {}, onError() {}, ...overrides })

test('real question form has no preselected recommendation, saves choices when deferred, and answers without activeId', async t => {
  const h = await mount(t, props())
  let tree = h.render()
  const radios = nodes(tree).filter(node => node.type === 'input' && node.props.type === 'radio')
  assert.equal(radios.length, 3)
  assert.equal(radios.some(node => node.props.checked), false)
  assert.equal(button(tree, '提交回答并继续').props.disabled, true)
  radios[1].props.onChange({ target: { checked: true } })
  tree = h.render()
  assert.equal(button(tree, '提交回答并继续').props.disabled, false)
  button(tree, '稍后回答').props.onClick()
  tree = h.render()
  assert.equal(find(tree, 'form'), undefined)
  assert.match([...h.storage.values()][0], /tokyo/)
  button(tree, '展开回答').props.onClick(); tree = h.render()
  find(tree, 'form').props.onSubmit({ preventDefault() {} }); await tick()
  assert.equal(h.posts.length, 1)
  assert.equal(h.posts[0].url, '/api/bots/pipi/tasks/2/blockers/12/resolve')
  assert.deepEqual(h.posts[0].body.answers, { timezone: { optionId: 'tokyo' } })
  assert.equal(h.posts[0].body.action, 'resolve')
  assert.equal(h.posts[0].body.version, 3)
  assert.equal(h.posts[0].body.inReplyTo, 8)
  assert.ok(h.posts[0].body.requestId)
})

test('unconfirmed answer retries retain requestId and original form drafts', async t => {
  const h = await mount(t, props(), async () => { throw new Error('network lost') })
  let tree = h.render()
  find(tree, 'input', value => value.value === 'shanghai').props.onChange({ target: { checked: true } })
  tree = h.render(); find(tree, 'form').props.onSubmit({ preventDefault() {} }); await tick()
  tree = h.render(); assert.match(text(tree), /network lost/)
  find(tree, 'form').props.onSubmit({ preventDefault() {} }); await tick()
  assert.equal(h.posts.length, 2)
  assert.deepEqual(h.posts[1].body, h.posts[0].body)
})

test('request adjustments and cancellation are explicit and are hidden for managed child questions', async t => {
  const base = props()
  const h = await mount(t, base)
  let tree = h.render()
  assert.ok(button(tree, '取消这次请求'))
  assert.equal(button(tree, '跳过，使用默认方案'), undefined)
  button(tree, '补充／调整这次请求').props.onClick(); tree = h.render()
  find(tree, 'textarea').props.onChange({ target: { value: '改成只给建议' } }); tree = h.render()
  find(tree, 'form').props.onSubmit({ preventDefault() {} }); await tick()
  assert.equal(h.posts[0].body.action, 'adjust')
  assert.equal(h.posts[0].body.answer, '改成只给建议')
  tree = h.update({ item: item({ rootWorkId: 'work-1' }) })
  assert.equal(button(tree, '取消这次请求'), undefined)
  assert.equal(button(tree, '补充／调整这次请求'), undefined)
})


const mirror = overrides => ({ id: 40, mirrorKind: 'blocker', childTaskId: 2, childTitle: '安排会议', botId: 'pipi', summary: '需要你补充时区', live: 'pending', createdAt: '2026-11-01T00:00:00Z', blockerId: 12, ...overrides })
test('main-session mirror expands a question inline only when requested, without navigating', async t => {
  const h = await mount(t, { token: 'token', item: mirror(), onOpenTask() { assert.fail('inline answer navigated away') } }, undefined, './MainSession.tsx', 'MirrorCard')
  let tree = h.render()
  assert.equal(h.requests.length, 0)
  button(tree, '在这里补充').props.onClick(); tree = h.render(); await tick(); tree = h.render()
  assert.equal(h.requests.length, 1)
  assert.equal(h.requests[0].url, '/api/bots/pipi/tasks/2')
  assert.ok(button(tree, '收起问题'))
})

test('mirror question loads current owner and version, updates inline after answer, and refuses cross-owner responses', async t => {
  const child = props().task
  child.blockers.items = [item()]
  let returned = child, settled = ''
  const h = await mount(t, { token: 'token', item: mirror(), onSettled(value) { settled = value } }, async () => ({ ok: true, json: async () => ({ task: returned }) }), './MainSession.tsx', 'MirrorQuestion')
  h.render(); await tick(); let tree = h.render()
  let controls = find(tree, 'TaskBlockerControls')
  assert.equal(controls.props.task.blockers.items[0].version, 3)
  controls.props.onUpdated({ ...child, blockers: { activeId: null, items: [item({ status: 'resolved', answer: { content: '东京' } })] } })
  tree = h.render(); assert.equal(settled, '已回答')
  assert.equal(find(tree, 'TaskBlockerControls').props.task.blockers.items[0].status, 'resolved')
  returned = { ...child, bot: { id: 'other-bot' } }
  h.update({ item: mirror({ botId: 'moved' }) }); await tick(); tree = h.render()
  assert.equal(find(tree, 'TaskBlockerControls'), undefined)
  assert.match(text(tree), /问题归属已变化/)
})

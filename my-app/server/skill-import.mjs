import { constants } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export const SKILL_IMPORT_LIMITS = Object.freeze({ files: 96, fileBytes: 131072, totalBytes: 1048576, treeBytes: 2097152, timeoutMs: 10000 })
const queues = new Map()
const ID = /^[a-z][a-z0-9-]{0,63}$/
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const clone = (value) => structuredClone(value)
function fail(code, message, details = {}) { throw Object.assign(new Error(message), { code, ...details }) }

/**
 * Controlled service only: callers supply authenticated management authorization and bind separately.
 * prepareSkillImport(source) -> preparation (or explicit repository directory candidates)
 * importSkill({ requestId, preparedId, expectedRevision }) -> catalog record + capabilityId
 * updateSkill({ requestId, skillId, preparedId, expectedRevision }) -> new immutable version
 * rollbackSkill({ requestId, skillId, hash, expectedRevision }) -> retained immutable version
 * removeSkill({ requestId, skillId, expectedRevision, affectedBotIds, confirmGlobal }) -> tombstone
 * skillCatalog() / skillSource(skillId, { hash? }) -> verified metadata / pinned declarative package
 * dataDirectory MUST be an application-controlled data subdirectory (tests use a temp directory).
 */
export function createSkillImportService(options) {
  if (!options?.dataDirectory || !isAbsolute(options.dataDirectory)) fail('SKILL_STORAGE_INVALID', '需要明确的受控绝对数据目录。')
  const root = resolve(options.dataDirectory)
  const limits = { ...SKILL_IMPORT_LIMITS, ...options.limits }
  const preparations = new Map()
  const serialized = (work) => { const next = (queues.get(root) ?? Promise.resolve()).then(work); const tail = next.catch(() => {}); queues.set(root, tail); void tail.then(() => { if (queues.get(root) === tail) queues.delete(root) }); return next }
  return {
    prepareSkillImport: (source) => prepare(source, { root, limits, fetchImpl: options.fetchImpl ?? globalThis.fetch, preparations }),
    importSkill: (input) => serialized(() => install(root, preparations, input, false)),
    updateSkill: (input) => serialized(() => install(root, preparations, input, true)),
    rollbackSkill: (input) => serialized(() => rollback(root, input)),
    removeSkill: (input) => serialized(() => remove(root, input)),
    requestStatus: requestId => requestStatus(root, requestId),
    skillCatalog: () => catalog(root),
    skillSource: (skillId, version = {}) => sourceFor(root, skillId, version),
  }
}

function safePath(path) {
  if (typeof path !== 'string' || path.length > 240 || path.includes('\\') || /[%:]/.test(path) || Array.from(path).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) || isAbsolute(path) ||
    path.split('/').some((part) => !part || part === '.' || part === '..' || part.startsWith('.') || part.length > 100)) {
    fail('SKILL_PATH_INVALID', 'Skill 文件路径不安全。')
  }
  return path
}
function inside(root, path) { const rel = relative(root, path); return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)) }
async function noLinks(path) {
  const absolute = resolve(path)
  let current = absolute
  while (true) {
    try { if ((await lstat(current)).isSymbolicLink()) fail('SKILL_SYMLINK', 'Skill 路径不能包含符号链接。') } catch (error) { if (error.code !== 'ENOENT') throw error }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return absolute
}
async function boundedFile(path, limit) {
  await noLinks(path)
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.nlink !== 1) fail('SKILL_FILE_INVALID', '仅支持普通非硬链接文件。')
    if (stat.size > limit) fail('SKILL_SIZE_LIMIT', 'Skill 文件超出体积限制。')
    const buffer = Buffer.alloc(Math.min(stat.size + 1, limit + 1))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead > limit || bytesRead !== stat.size) fail('SKILL_SOURCE_CHANGED', 'Skill 文件在读取时发生变化或超出限制。')
    return buffer.subarray(0, bytesRead)
  } finally { await handle.close() }
}
function selected(path) {
  return path === 'SKILL.md' || /^(references|assets|scripts)\//.test(path)
}
function checkFiles(files, limits) {
  if (files.length > limits.files) fail('SKILL_FILE_LIMIT', 'Skill 文件数量超出限制。')
  let total = 0
  const names = new Set()
  for (const file of files) {
    safePath(file.path)
    const key = file.path.toLowerCase()
    if (names.has(key)) fail('SKILL_PATH_COLLISION', 'Skill 文件路径重复或大小写冲突。')
    names.add(key)
    if (!selected(file.path)) fail('SKILL_FILE_UNSUPPORTED', '不支持的 Skill 文件类型。')
    if (file.bytes.length > limits.fileBytes || (total += file.bytes.length) > limits.totalBytes) fail('SKILL_SIZE_LIMIT', 'Skill 包超出体积限制。')
    if (/^assets\//.test(file.path) && !/\.(png|jpg|jpeg|webp|gif|pdf|txt|json|csv)$/i.test(file.path)) fail('SKILL_ASSET_UNSUPPORTED', '不支持该附件格式；不会执行或展开压缩文件。')
    if (/^references\//.test(file.path) && !/\.(md|txt)$/i.test(file.path)) fail('SKILL_REFERENCE_UNSUPPORTED', '参考资料仅支持声明式文本。')
  }
}
async function localFiles(path, limits) {
  if (typeof path !== 'string' || !isAbsolute(path)) fail('SKILL_SOURCE_INVALID', '本机 Skill 需要绝对路径。')
  const absolute = await noLinks(path)
  const stat = await lstat(absolute)
  const base = stat.isDirectory() ? await realpath(absolute) : dirname(absolute)
  if (stat.isFile() && !absolute.endsWith(`${sep}SKILL.md`)) fail('SKILL_SOURCE_INVALID', '单文件导入只接受 SKILL.md。')
  const files = []
  let visited = 0, total = 0
  async function visit(folder, prefix = '') {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (++visited > limits.files * 4) fail('SKILL_FILE_LIMIT', 'Skill 目录条目超出限制。')
      if (entry.name === '.git' || entry.name === 'node_modules') continue
      const path = prefix + entry.name
      safePath(path)
      const absolute = join(folder, entry.name)
      if (!inside(base, absolute)) fail('SKILL_PATH_INVALID', 'Skill 文件越界。')
      if (entry.isSymbolicLink()) fail('SKILL_SYMLINK', 'Skill 不能包含符号链接。')
      if (entry.isDirectory()) {
        if (!prefix && !['references', 'assets', 'scripts'].includes(entry.name)) continue
        await visit(absolute, `${path}/`)
      } else if (selected(path)) {
        const bytes = await boundedFile(absolute, limits.fileBytes)
        total += bytes.length
        if (total > limits.totalBytes || files.length >= limits.files) fail('SKILL_SIZE_LIMIT', 'Skill 包超出限制。')
        files.push({ path, bytes })
      }
    }
  }
  if (stat.isDirectory()) await visit(base)
  else files.push({ path: 'SKILL.md', bytes: await boundedFile(absolute, limits.fileBytes) })
  return { files, source: { kind: 'local', location: absolute, directory: stat.isDirectory() } }
}

async function jsonGet(url, { fetchImpl, limits }) {
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'api.github.com' || parsed.username || parsed.password || parsed.port) fail('SKILL_REMOTE_FORBIDDEN', '远端只支持公开 GitHub API。')
  const response = await fetchImpl(url, { redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(limits.timeoutMs), headers: { Accept: 'application/vnd.github+json' } })
  if (response.status >= 300 && response.status < 400 || response.redirected || response.url && response.url !== url) fail('SKILL_REDIRECT_FORBIDDEN', '不允许 Skill 下载重定向。')
  if (!response.ok) fail('SKILL_DOWNLOAD_FAILED', '公开仓库下载失败；不使用本机凭据。')
  if (Number(response.headers.get('content-length')) > limits.treeBytes) fail('SKILL_SIZE_LIMIT', '远端响应超出限制。')
  const reader = response.body?.getReader()
  if (!reader) fail('SKILL_DOWNLOAD_FAILED', '远端缺少可有界读取的响应。')
  const chunks = []
  let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.length
      if (size > limits.treeBytes) fail('SKILL_SIZE_LIMIT', '远端响应超出限制。')
      chunks.push(Buffer.from(value))
    }
  } finally { await reader.cancel().catch(() => {}) }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { fail('SKILL_REMOTE_INVALID', '远端响应不是有效 JSON。') }
}
async function repositoryFiles(source, options) {
  let url
  try { url = new URL(source.url) } catch { fail('SKILL_SOURCE_INVALID', '需要公开仓库 URL。') }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash ||
    !/^\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\/?$/.test(url.pathname)) fail('SKILL_REMOTE_FORBIDDEN', '只接受 https://github.com/owner/repo，并单独声明目录与 ref。')
  const repo = url.pathname.replace(/^\//, '').replace(/\/$/, '').replace(/\.git$/, '')
  if (typeof source.ref !== 'string' && source.ref !== undefined || source.ref && (!/^[A-Za-z0-9_./-]{1,200}$/.test(source.ref) || source.ref.includes('..'))) fail('SKILL_REF_INVALID', '无效仓库版本。')
  const api = `https://api.github.com/repos/${repo}`
  const commit = await jsonGet(`${api}/commits/${encodeURIComponent(source.ref ?? 'HEAD')}`, options)
  if (!/^[a-f0-9]{40}$/.test(commit.sha ?? '')) fail('SKILL_REMOTE_INVALID', '仓库未返回固定 commit。')
  const tree = await jsonGet(`${api}/git/trees/${commit.sha}?recursive=1`, options)
  if (tree.truncated || !Array.isArray(tree.tree) || tree.tree.length > 4096) fail('SKILL_FILE_LIMIT', '仓库目录过大或不完整，请提供更小的仓库。')
  if (source.directory === undefined) {
    for (const entry of tree.tree.filter((entry) => /(^|\/)SKILL\.md$/.test(entry.path))) safePath(entry.path)
    return { candidates: tree.tree.filter((entry) => entry.type === 'blob' && /(^|\/)SKILL\.md$/.test(entry.path)).map((entry) => entry.path.slice(0, -8).replace(/\/$/, '') || '.'), commit: commit.sha }
  }
  if (source.directory !== '.') safePath(source.directory)
  const prefix = source.directory === '.' ? '' : `${source.directory}/`
  const entries = tree.tree.filter((entry) => entry.path.startsWith(prefix) && selected(entry.path.slice(prefix.length)))
  if (entries.length > options.limits.files) fail('SKILL_FILE_LIMIT', '仓库 Skill 文件数量超出限制。')
  const files = []
  let total = 0
  for (const entry of entries) {
    if (entry.type === 'tree') continue
    if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) fail('SKILL_SYMLINK', '仓库 Skill 不能包含软链接或子模块。')
    const path = safePath(entry.path.slice(prefix.length))
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > options.limits.fileBytes || (total += entry.size) > options.limits.totalBytes) fail('SKILL_SIZE_LIMIT', '仓库 Skill 超出体积限制。')
    if (!/^[a-f0-9]{40}$/.test(entry.sha ?? '')) fail('SKILL_REMOTE_INVALID', '无效仓库文件 hash。')
    const blob = await jsonGet(`${api}/git/blobs/${entry.sha}`, options)
    if (blob.encoding !== 'base64' || typeof blob.content !== 'string' || blob.content.length > options.limits.fileBytes * 2 || !/^[A-Za-z0-9+/=\r\n]*$/.test(blob.content)) fail('SKILL_REMOTE_INVALID', '无效仓库文件。')
    const bytes = Buffer.from(blob.content, 'base64')
    const gitHash = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
    if (gitHash !== entry.sha || bytes.length !== entry.size) fail('SKILL_HASH_MISMATCH', '仓库文件与固定 hash 不一致。')
    files.push({ path, bytes })
  }
  return { files, source: { kind: 'repository', url: `https://github.com/${repo}`, directory: source.directory, commit: commit.sha } }
}

function scalar(text) {
  const value = text.trim()
  if (!value || value.length > 2000 || (/(^|\s)[!&*]/.test(value) || Array.from(value).some((char) => char.charCodeAt(0) < 9)) || value.startsWith('{') || value === '---') fail('SKILL_METADATA_INVALID', '不支持该 metadata 语法；不会执行 YAML tag 或引用。')
  if (value.startsWith('"')) { try { const result = JSON.parse(value); if (typeof result === 'string') return result } catch { /* reject */ } fail('SKILL_METADATA_INVALID', 'metadata 引号格式无效。') }
  if (value.startsWith("'")) {
    if (!value.endsWith("'")) fail('SKILL_METADATA_INVALID', 'metadata 引号格式无效。')
    return value.slice(1, -1).replaceAll("''", "'")
  }
  return value
}
function listValue(value) {
  if (Array.isArray(value)) return value
  if (value === undefined) return []
  if (value.startsWith('[')) {
    if (!value.endsWith(']')) fail('SKILL_METADATA_INVALID', 'metadata 列表无效。')
    return value.slice(1, -1).split(',').filter((part) => part.trim()).map(scalar)
  }
  return value.split(/[\s,]+/).filter(Boolean)
}
export function adaptSkillMetadata(markdown, filePaths = []) {
  if (typeof markdown !== 'string' || Buffer.byteLength(markdown) > 32768 || !markdown.startsWith('---\n') && !markdown.startsWith('---\r\n')) fail('SKILL_METADATA_INVALID', 'SKILL.md 需要标准 name/description frontmatter。')
  const lines = markdown.replaceAll('\r\n', '\n').split('\n')
  const end = lines.indexOf('---', 1)
  if (end < 0 || end > 120) fail('SKILL_METADATA_INVALID', 'Skill metadata 缺少结束分隔符或过大。')
  const meta = {}, nested = {}
  for (let i = 1; i < end; i++) {
    const line = lines[i]
    if (!line.trim() || line.startsWith('#')) continue
    const match = /^([a-z][a-z0-9-]*):\s*(.*)$/.exec(line)
    if (!match || Object.hasOwn(meta, match[1])) fail('SKILL_METADATA_INVALID', 'Skill metadata 仅支持明确、非重复的声明式字段。')
    const [, key, raw] = match
    if (['>', '|', '>-', '|-'].includes(raw)) {
      const parts = []
      while (i + 1 < end && /^  /.test(lines[i + 1])) parts.push(lines[++i].slice(2))
      meta[key] = parts.join(raw.startsWith('>') ? ' ' : '\n').trim()
      if (meta[key].length > 2000) fail('SKILL_METADATA_INVALID', 'metadata 文本过长。')
    } else if (!raw && key === 'metadata') {
      meta[key] = nested
      while (i + 1 < end && /^  /.test(lines[i + 1])) {
        const item = /^  ([a-zA-Z][a-zA-Z0-9_-]*):\s*(.+)$/.exec(lines[++i])
        if (!item || Object.hasOwn(nested, item[1])) fail('SKILL_METADATA_INVALID', '仅支持 metadata 的简单键值声明。')
        nested[item[1]] = scalar(item[2])
      }
    } else if (!raw) {
      const items = []
      while (i + 1 < end && /^  - /.test(lines[i + 1])) items.push(scalar(lines[++i].slice(4)))
      if (!items.length) fail('SKILL_METADATA_INVALID', 'metadata 字段不能为空。')
      meta[key] = items
    } else meta[key] = scalar(raw)
  }
  if (typeof meta.name !== 'string' || !ID.test(meta.name) || typeof meta.description !== 'string' || !meta.description.trim() || meta.description.length > 2000) fail('SKILL_METADATA_INVALID', 'Skill 需要小写连字符 name 和非空 description。')
  const rules = lines.slice(end + 1).join('\n').trim()
  if (!rules) fail('SKILL_METADATA_INVALID', 'Skill 正文不能为空。')
  const declaredVersion = meta.version ?? nested.version
  if (declaredVersion !== undefined && (typeof declaredVersion !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,79}$/.test(declaredVersion))) fail('SKILL_METADATA_INVALID', '无效 Skill version。')
  const requiredTools = [...new Set([...listValue(meta['allowed-tools']), ...listValue(meta['required-tools'])])]
  const requiredResources = [...new Set(listValue(meta['required-resources']))]
  const scripts = [...new Set([...listValue(meta.scripts), ...filePaths.filter((path) => path.startsWith('scripts/')), ...Array.from(rules.matchAll(/\bscripts\/[A-Za-z0-9_./-]+/g), (match) => match[0])])]
  for (const values of [requiredTools, requiredResources, scripts]) {
    if (values.length > 20 || values.some((value) => typeof value !== 'string' || !value || value.length > 200)) fail('SKILL_METADATA_INVALID', 'Skill 依赖声明过多或无效。')
  }
  if (Object.keys(nested).some((key) => /depend|require|script|install|exec|permission|resource|tool/.test(key))) fail('SKILL_METADATA_UNSUPPORTED', 'metadata 中存在无法适配的依赖声明。')
  const unsupported = Object.keys(meta).filter((key) => !['name', 'description', 'version', 'metadata', 'license', 'compatibility', 'allowed-tools', 'required-tools', 'required-resources', 'scripts'].includes(key))
  if (unsupported.some((key) => /depend|require|script|install|exec|permission|resource|tool/.test(key))) fail('SKILL_METADATA_UNSUPPORTED', '存在无法适配的依赖或执行声明。', { fields: unsupported })
  return { manifest: { id: meta.name, name: meta.name, description: meta.description.trim(), version: declaredVersion ?? 'unversioned',
    applicability: meta.compatibility ?? '由 Bot 按任务选择；所有依赖仍须独立获权。', botIds: [], requiredTools, requiredResources, scripts }, rules,
  warnings: unsupported.map((field) => `metadata:${field}:not-executable`) }
}
function packageHash(files, source) { return sha256(JSON.stringify(source) + '\n' + JSON.stringify(files.map(({ path, bytes }) => ({ path, sha256: sha256(bytes) })).sort((a, b) => a.path.localeCompare(b.path, 'en')))) }
async function prepare(source, options) {
  if (!source || typeof source !== 'object' || Array.isArray(source) || !['local', 'repository'].includes(source.kind)) fail('SKILL_SOURCE_INVALID', '来源仅支持本机目录/SKILL.md 或公开仓库。')
  const result = source.kind === 'local' ? await localFiles(source.path, options.limits) : await repositoryFiles(source, options)
  if (result.candidates) return { status: 'needs_directory', candidates: result.candidates, commit: result.commit }
  checkFiles(result.files, options.limits)
  const document = result.files.find((file) => file.path === 'SKILL.md')
  if (!document) fail('SKILL_DOCUMENT_MISSING', '指定目录缺少 SKILL.md；不会猜测其他目录。')
  const decode = new TextDecoder('utf-8', { fatal: true })
  let adapted
  try { adapted = adaptSkillMetadata(decode.decode(document.bytes), result.files.map((file) => file.path)) } catch (error) { if (error.code) throw error; fail('SKILL_METADATA_INVALID', 'SKILL.md 必须是有效 UTF-8 文本。') }
  const references = []
  for (const file of result.files.filter((file) => file.path.startsWith('references/'))) {
    if (file.bytes.length > 16384 || references.length >= 8) fail('SKILL_REFERENCE_LIMIT', '参考资料超过运行时数量或体积限制。')
    let content
    try { content = decode.decode(file.bytes) } catch { fail('SKILL_METADATA_INVALID', '参考资料必须为 UTF-8 文本。') }
    if (!content.trim() || content.includes('\0')) fail('SKILL_METADATA_INVALID', '参考资料内容无效。')
    references.push({ id: `reference-${sha256(file.path).slice(0, 16)}`, title: file.path.slice(11), file: file.path })
  }
  if (references.length) adapted.manifest.references = references
  const hash = packageHash(result.files, result.source)
  if (adapted.manifest.version === 'unversioned') adapted.manifest.version = `sha256-${hash.slice(0, 12)}`
  const status = adapted.manifest.scripts.length ? 'missing_dependency' : adapted.manifest.requiredTools.length || adapted.manifest.requiredResources.length ? 'configured' : 'ready'
  const preparedId = randomUUID(), now = new Date().toISOString()
  if (options.preparations.size >= 32) options.preparations.delete(options.preparations.keys().next().value)
  const prepared = { preparedId, hash, ...adapted, source: result.source, status, preparedAt: now,
    files: result.files.map((file) => ({ path: file.path, content: file.bytes.toString('base64'), sha256: sha256(file.bytes), bytes: file.bytes.length })) }
  options.preparations.set(preparedId, prepared)
  return preparationView(prepared)
}
function preparationView(prepared) {
  return { preparedId: prepared.preparedId, hash: prepared.hash, manifest: clone(prepared.manifest), source: clone(prepared.source), status: prepared.status,
    warnings: [...prepared.warnings], requirements: requirements(prepared.manifest), files: prepared.files.map(({ content: _content, ...file }) => file) }
}
function requirements(manifest) { return { tools: manifest.requiredTools, resources: manifest.requiredResources, scripts: manifest.scripts } }
async function storage(root) {
  const builtins = resolve(new URL('./skills/', import.meta.url).pathname)
  if (inside(builtins, root) || inside(root, builtins)) fail('SKILL_STORAGE_INVALID', '用户 Skill 不能写入或覆盖内置源码目录。')
  await noLinks(root)
  await mkdir(root, { recursive: true, mode: 0o700 })
  await noLinks(join(root, 'index.json'))
}
async function readIndex(root) {
  await storage(root)
  try {
    const index = JSON.parse((await boundedFile(join(root, 'index.json'), 4 * 1048576)).toString('utf8'))
    if (!Number.isSafeInteger(index.revision) || !index.skills || !index.receipts) fail('SKILL_STORAGE_INVALID', 'Skill 注册表格式无效。')
    return index
  } catch (error) { if (error.code === 'ENOENT') return { revision: 0, skills: {}, receipts: {} }; throw error }
}
async function atomicJSON(root, path, value) {
  await noLinks(dirname(path))
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await noLinks(path)
  const temp = join(dirname(path), `tmp-${randomUUID()}.json`)
  const handle = await open(temp, 'wx', 0o600)
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync() } finally { await handle.close() }
  try { if (!inside(root, path)) fail('SKILL_PATH_INVALID', '存储路径越界。'); await rename(temp, path) } finally { await rm(temp, { force: true }) }
}
function validateMutation(input) {
  if (!input || typeof input !== 'object' || typeof input.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(input.requestId) || ['__proto__', 'prototype', 'constructor'].includes(input.requestId) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) fail('SKILL_INPUT_INVALID', '需要 requestId 与 expectedRevision。')
  if (input.skillId !== undefined && !ID.test(input.skillId)) fail('SKILL_INPUT_INVALID', '无效 skillId。')
}
function mutationStart(index, input, operation) {
  validateMutation(input)
  const fingerprint = sha256(JSON.stringify(input))
  const prior = Object.hasOwn(index.receipts, input.requestId) ? index.receipts[input.requestId] : null
  if (prior) {
    if (prior.operation && prior.operation !== operation || prior.fingerprint !== fingerprint) fail('SKILL_REQUEST_CONFLICT', 'requestId 已用于其他 Skill 操作。')
    return { prior: clone(prior.result) }
  }
  if (input.expectedRevision !== index.revision) fail('SKILL_REVISION_CONFLICT', 'Skill 目录已改变，请重新读取并确认。', { currentRevision: index.revision })
  return { fingerprint }
}
async function finish(root, index, input, fingerprint, record, operation) {
  index.revision++
  record.revision = index.revision
  const result = { ...clone(record), catalogRevision: index.revision, capabilityId: `skill:${record.id}` }
  index.receipts[input.requestId] = { fingerprint, operation, result }
  if (Object.keys(index.receipts).length > 512) fail('SKILL_RECEIPT_LIMIT', 'Skill 操作回执已达到上限，需受控维护。')
  await atomicJSON(root, join(root, 'index.json'), index)
  return result
}
async function install(root, preparations, input, updating) {
  const index = await readIndex(root), operation = updating ? 'update' : 'import', start = mutationStart(index, input, operation)
  if (start.prior) return start.prior
  const prepared = preparations.get(input.preparedId)
  if (!prepared || Date.now() - Date.parse(prepared.preparedAt) > 900000) fail('SKILL_PREPARATION_EXPIRED', '请重新检查并确认 Skill 内容。')
  const id = prepared.manifest.id
  try { await lstat(new URL(`./skills/${id}/manifest.json`, import.meta.url)); fail('SKILL_NAME_CONFLICT', '该名称属于内置 Skill，不能覆盖。') } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (updating && input.skillId !== id) fail('SKILL_ID_MISMATCH', '更新不能更名或覆盖其他 Skill。')
  const current = Object.hasOwn(index.skills, id) ? index.skills[id] : null
  if (updating && (!current || current.removed)) fail('SKILL_NOT_FOUND', '未登记该 Skill。')
  if (!updating && current && !current.removed) {
    if (current.hash !== prepared.hash || JSON.stringify(current.source) !== JSON.stringify(prepared.source)) fail('SKILL_NAME_CONFLICT', '同名 Skill 已登记，不覆盖；请显式更新或使用其他名称。')
    return finish(root, index, input, start.fingerprint, current, operation)
  }
  const pkg = { ...clone(prepared), preparedId: undefined }
  const path = join(root, 'packages', prepared.hash, 'package.json')
  try {
    const existing = await readPackage(root, prepared.hash)
    if (existing.hash !== prepared.hash) fail('SKILL_HASH_MISMATCH', '不可覆盖固定 Skill 包。')
  } catch (error) { if (error.code !== 'ENOENT') throw error; await atomicJSON(root, path, pkg) }
  const versions = [...new Set([...(current?.versions ?? []), prepared.hash])]
  const record = { id, name: prepared.manifest.name, description: prepared.manifest.description, kind: 'skill', hash: prepared.hash,
    version: prepared.manifest.version, versions, status: prepared.status, source: clone(prepared.source), requirements: requirements(prepared.manifest),
    toolNames: [], removed: false, lastCheck: { checkedAt: new Date().toISOString(), status: prepared.status } }
  index.skills[id] = record
  return finish(root, index, input, start.fingerprint, record, operation)
}
async function readPackage(root, hash) {
  if (!/^[a-f0-9]{64}$/.test(hash ?? '')) fail('SKILL_HASH_INVALID', '需要固定 Skill hash。')
  const pkg = JSON.parse((await boundedFile(join(root, 'packages', hash, 'package.json'), 2 * 1048576)).toString('utf8'))
  if (!Array.isArray(pkg.files) || pkg.hash !== hash) fail('SKILL_HASH_MISMATCH', 'Skill 固定包已损坏。')
  const files = pkg.files.map((file) => ({ path: file.path, bytes: Buffer.from(file.content, 'base64') }))
  checkFiles(files, SKILL_IMPORT_LIMITS)
  if (packageHash(files, pkg.source) !== hash || pkg.files.some((file, n) => sha256(files[n].bytes) !== file.sha256)) fail('SKILL_HASH_MISMATCH', 'Skill 固定包校验失败。')
  const document = files.find((file) => file.path === 'SKILL.md')
  const adapted = adaptSkillMetadata(document?.bytes.toString('utf8'), files.map((file) => file.path))
  const expected = { ...adapted.manifest, version: adapted.manifest.version === 'unversioned' ? `sha256-${hash.slice(0, 12)}` : adapted.manifest.version }
  const { references: _references, ...actual } = pkg.manifest
  if (JSON.stringify(expected) !== JSON.stringify(actual) || adapted.rules !== pkg.rules) fail('SKILL_HASH_MISMATCH', 'Skill 固定 metadata 校验失败。')
  const refFiles = files.filter((file) => file.path.startsWith('references/'))
  if (JSON.stringify(pkg.manifest.references ?? []) !== JSON.stringify(refFiles.map((file) => ({ id: `reference-${sha256(file.path).slice(0, 16)}`, title: file.path.slice(11), file: file.path })))) fail('SKILL_HASH_MISMATCH', 'Skill 参考目录校验失败。')
  const status = expected.scripts.length ? 'missing_dependency' : expected.requiredTools.length || expected.requiredResources.length ? 'configured' : 'ready'
  if (pkg.status !== status) fail('SKILL_HASH_MISMATCH', 'Skill 依赖状态校验失败。')
  return pkg
}
async function requestStatus(root, requestId) {
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(requestId) || ['__proto__', 'prototype', 'constructor'].includes(requestId)) fail('SKILL_INPUT_INVALID', '需要有效的原 requestId。')
  const index = await readIndex(root)
  const receipt = Object.hasOwn(index.receipts, requestId) ? index.receipts[requestId] : null
  // Only a durable operation-specific receipt proves a mutation succeeded. Legacy receipts
  // without method metadata remain replayable, but cannot certify an unknown method here.
  if (!receipt || !['import', 'update', 'rollback', 'remove'].includes(receipt.operation)) return null
  return { requestId, operation: receipt.operation, state: 'succeeded', result: clone(receipt.result) }
}
async function catalog(root) {
  const index = await readIndex(root)
  const skills = []
  for (const record of Object.values(index.skills).filter((record) => !record.removed)) {
    try { await readPackage(root, record.hash); skills.push(clone(record)) } catch { skills.push({ ...clone(record), status: 'error', lastCheck: { status: 'error', code: 'SKILL_HASH_MISMATCH' } }) }
  }
  return { revision: index.revision, skills }
}
async function sourceFor(root, skillId, { hash } = {}) {
  if (!ID.test(skillId)) fail('SKILL_INPUT_INVALID', '无效 skillId。')
  const index = await readIndex(root)
  const record = Object.hasOwn(index.skills, skillId) ? index.skills[skillId] : null
  if (!record || record.removed) fail('SKILL_NOT_FOUND', 'Skill 已移除或未登记；历史快照保持不变。')
  const selected = hash ?? record.hash
  if (!record.versions.includes(selected)) fail('SKILL_VERSION_NOT_FOUND', '未登记该固定版本。')
  return clone(await readPackage(root, selected))
}
async function rollback(root, input) {
  const index = await readIndex(root), start = mutationStart(index, input, 'rollback')
  if (start.prior) return start.prior
  const current = Object.hasOwn(index.skills, input.skillId) ? index.skills[input.skillId] : null
  if (!current || current.removed || !current.versions.includes(input.hash)) fail('SKILL_VERSION_NOT_FOUND', '该历史版本不可回退。')
  const pkg = await readPackage(root, input.hash)
  Object.assign(current, { hash: pkg.hash, version: pkg.manifest.version, status: pkg.status, source: pkg.source, requirements: requirements(pkg.manifest),
    lastCheck: { checkedAt: new Date().toISOString(), status: pkg.status } })
  return finish(root, index, input, start.fingerprint, current, 'rollback')
}
async function remove(root, input) {
  const index = await readIndex(root), start = mutationStart(index, input, 'remove')
  if (start.prior) return start.prior
  const record = Object.hasOwn(index.skills, input.skillId) ? index.skills[input.skillId] : null
  if (!record) fail('SKILL_NOT_FOUND', '未登记该 Skill。')
  // Binding owners must compute actual affected Bot IDs, never trust a model's empty array.
  if (!Array.isArray(input.affectedBotIds) || !input.affectedBotIds.every((id) => typeof id === 'string') || input.confirmGlobal !== true) fail('SKILL_REMOVE_CONFIRMATION_REQUIRED', '全局移除需要明确确认与已复核的 Bot 影响列表。')
  Object.assign(record, { removed: true, status: 'disabled', affectedBotIds: [...input.affectedBotIds] })
  return finish(root, index, input, start.fingerprint, record, 'remove')
}

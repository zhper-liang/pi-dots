import { spawn } from 'node:child_process'
import { mkdir, open, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

const text = (maxLength) => ({ type: 'string', maxLength })
const path = { ...text(4096), minLength: 1, description: '文件路径；相对路径从当前机器人的工作目录解析，也可使用绝对路径。' }
const definition = (name, description, required, properties) => Object.freeze({ name, description,
  parameters: { type: 'object', additionalProperties: false, required, properties } })
export const nativeTools = Object.freeze([
  definition('bash', '执行本机 Bash 命令。默认在机器人工作目录执行，可指定 cwd；默认超时30秒，最长120秒。输出有上限，取消或超时会终止进程组；结果不确定时不要自动重复有副作用的命令。', ['command'], {
    command: { ...text(32768), minLength: 1 }, cwd: path, timeoutMs: { type: 'integer', minimum: 1, maximum: 120000 },
  }),
  definition('read', '读取本机 UTF-8 文本文件。offset 是从0起的 Unicode 字符偏移，limit 默认2048、最大4096；按 nextOffset 继续读取。', ['path'], {
    path, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 4096 },
  }),
  definition('write', '写入 UTF-8 文本文件，覆盖已有内容，自动创建父目录。', ['path', 'content'], { path, content: text(131072) }),
  definition('edit', '精确替换 UTF-8 文本文件中的 oldText。默认必须恰好匹配一次；replaceAll=true 才替换所有匹配。先 read 核对原文。', ['path', 'oldText', 'newText'], {
    path, oldText: { ...text(131072), minLength: 1 }, newText: text(131072), replaceAll: { type: 'boolean' },
  }),
])
export const NATIVE_TOOLS = Object.freeze(nativeTools.map(tool => tool.name))
const string = (v, max = 4096, empty = false) => typeof v === 'string' && (empty || v.trim().length > 0) && v.length <= max && !v.includes('\0')
export function validNativeCall(call) {
  const args = call.arguments, schema = nativeTools.find(tool => tool.name === call.name)?.parameters
  if (call.argumentsError || !schema || !args || typeof args !== 'object' || Array.isArray(args) ||
    Object.keys(args).some(key => !Object.hasOwn(schema.properties, key)) || schema.required.some(key => !Object.hasOwn(args, key))) return false
  if (call.name === 'bash') return string(args.command, 32768) && (args.cwd === undefined || string(args.cwd)) &&
    (args.timeoutMs === undefined || Number.isSafeInteger(args.timeoutMs) && args.timeoutMs >= 1 && args.timeoutMs <= 120000)
  if (!string(args.path)) return false
  if (call.name === 'read') return (args.offset === undefined || Number.isSafeInteger(args.offset) && args.offset >= 0) &&
    (args.limit === undefined || Number.isSafeInteger(args.limit) && args.limit >= 1 && args.limit <= 4096)
  if (call.name === 'write') return typeof args.content === 'string' && args.content.length <= 131072
  return typeof args.oldText === 'string' && args.oldText.length > 0 && args.oldText.length <= 131072 && typeof args.newText === 'string' && args.newText.length <= 131072 &&
    (args.replaceAll === undefined || typeof args.replaceAll === 'boolean')
}
const failure = (code, message) => ({ ok: false, error: { code, message } })
// Keep every native receipt readable without requiring the optional history tool group.
function clip(value, budget = 5000) {
  const chars = Array.from(value)
  let low = 0, high = Math.min(chars.length, budget)
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(JSON.stringify(chars.slice(0, mid).join(''))) <= budget) low = mid
    else high = mid - 1
  }
  return { text: chars.slice(0, low).join(''), length: low, truncated: low < chars.length }
}
async function readText(file) {
  const handle = await open(file, 'r')
  try {
    if (!(await handle.stat()).isFile()) throw Object.assign(new Error(), { code: 'NOT_TEXT_FILE' })
    const buffer = Buffer.alloc(2 * 1024 * 1024 + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null)
      if (!bytesRead) break
      length += bytesRead
    }
    if (length === buffer.length) throw Object.assign(new Error(), { code: 'FILE_TOO_LARGE' })
    const data = buffer.subarray(0, length)
    if (data.includes(0)) throw Object.assign(new Error(), { code: 'NOT_TEXT_FILE' })
    return new TextDecoder('utf-8', { fatal: true }).decode(data)
  } finally { await handle.close() }
}
async function save(file, content, signal) {
  await mkdir(dirname(file), { recursive: true })
  let mode = 0o600
  try { mode = (await stat(file)).mode & 0o777 } catch (error) { if (error.code !== 'ENOENT') throw error }
  const temporary = join(dirname(file), `.pidot-write-${randomUUID()}`)
  try {
    await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx', mode, signal })
    signal?.throwIfAborted()
    await rename(temporary, file)
  } finally { await rm(temporary, { force: true }) }
}
async function runBash(args, cwd, signal) {
  return new Promise(resolveResult => {
    const child = spawn('bash', ['-lc', args.command], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), truncated = false, timedOut = false, killTimer
    const collect = key => chunk => {
      const previous = key === 'stdout' ? stdout : stderr
      const next = Buffer.concat([previous, chunk]).subarray(0, 16384)
      if (previous.length + chunk.length > next.length) truncated = true
      if (key === 'stdout') stdout = next
      else stderr = next
    }
    child.stdout.on('data', collect('stdout')); child.stderr.on('data', collect('stderr'))
    const kill = sig => { if (child.pid) try { process.kill(-child.pid, sig) } catch { /* process group already exited */ } }
    const stop = () => { kill('SIGTERM'); killTimer ??= setTimeout(() => kill('SIGKILL'), 250) }
    const abort = () => stop()
    const timer = setTimeout(() => { timedOut = true; stop() }, args.timeoutMs ?? 30000)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) stop()
    const finish = (code, exitSignal, error) => {
      clearTimeout(timer); clearTimeout(killTimer)
      signal?.removeEventListener('abort', abort)
      const out = clip(stdout.toString('utf8'), 2400), err = clip(stderr.toString('utf8'), 2400)
      resolveResult({ ok: !error && code === 0 && !timedOut && !signal?.aborted,
        ...((error || code !== 0 || timedOut || signal?.aborted) ? { error: { code: signal?.aborted ? 'TOOL_ABORTED' : timedOut ? 'BASH_TIMEOUT' : 'BASH_FAILED', message: '命令未成功完成；请核对输出及实际文件状态。' } } : {}),
        data: { exitCode: code, signal: exitSignal, stdout: out.text, stderr: err.text, truncated: truncated || out.truncated || err.truncated, timedOut } })
    }
    child.once('error', error => finish(null, null, error))
    child.once('close', (code, exitSignal) => finish(code, exitSignal))
  })
}

export function createNativeRuntime({ root }) {
  const edits = new Map()
  return async function execute(call, { botId, signal } = {}) {
    if (!validNativeCall(call)) return failure('TOOL_INVALID_ARGUMENTS', '原生能力参数无效。')
    const args = call.arguments, cwd = resolve(root, botId)
    try {
      signal?.throwIfAborted()
      await mkdir(cwd, { recursive: true })
      if (call.name === 'bash') return await runBash(args, args.cwd ? resolve(cwd, args.cwd) : cwd, signal)
      const file = resolve(cwd, args.path)
      if (call.name === 'read') {
        const chars = Array.from(await readText(file)), offset = args.offset ?? 0
        if (offset > chars.length) return failure('READ_OFFSET_INVALID', 'offset 超出文件内容。')
        const part = clip(chars.slice(offset, offset + (args.limit ?? 2048)).join(''))
        return { ok: true, data: { content: part.text, offset, nextOffset: offset + part.length < chars.length ? offset + part.length : null, totalCharacters: chars.length } }
      }
      const previous = edits.get(file) ?? Promise.resolve()
      const work = previous.catch(() => {}).then(async () => {
        signal?.throwIfAborted()
        let content = args.content, replacements
        if (call.name === 'edit') {
          const original = await readText(file), matches = original.split(args.oldText).length - 1
          if (!matches || matches !== 1 && !args.replaceAll) return failure('EDIT_MATCH_CONFLICT', '原文没有匹配或匹配不唯一；请重新读取后精确修改。')
          replacements = args.replaceAll ? matches : 1
          content = args.replaceAll ? original.split(args.oldText).join(args.newText) : original.replace(args.oldText, () => args.newText)
        }
        await save(file, content, signal)
        return { ok: true, data: { bytesWritten: Buffer.byteLength(content), ...(replacements === undefined ? {} : { replacements }) } }
      })
      edits.set(file, work)
      try { return await work } finally { if (edits.get(file) === work) edits.delete(file) }
    } catch (error) {
      return failure(signal?.aborted ? 'TOOL_ABORTED' : ['ENOENT', 'EACCES', 'FILE_TOO_LARGE', 'NOT_TEXT_FILE'].includes(error.code) ? error.code : 'NATIVE_TOOL_FAILED', '本机操作未完成，请核对路径、文件内容或实际状态。')
    }
  }
}

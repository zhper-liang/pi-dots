import { readFile } from 'node:fs/promises'
import { join, extname } from 'node:path'

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' }

/** Only public build artifacts are served. Never the project root or .env. */
export async function serveStatic(req, res, dir) {
  if (!['GET', 'HEAD'].includes(req.method)) return false
  const pathname = req.url?.split('?')[0]
  const file = pathname === '/' || pathname === '/index.html' ? 'index.html'
    : /^\/assets\/[a-zA-Z0-9_-]+\.(js|css|svg|png)$/.test(pathname) ? pathname.slice(1)
    : pathname === '/favicon.svg' ? 'favicon.svg' : null
  if (!file) return false
  let data
  try { data = await readFile(join(dir, file)) } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
  req.resume()
  res.writeHead(200, {
    'Content-Type': types[extname(file)],
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    'Referrer-Policy': 'no-referrer',
  })
  res.end(req.method === 'HEAD' ? undefined : data)
  return true
}

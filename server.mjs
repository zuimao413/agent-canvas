// Agent Canvas — 一块能一起画的布。
// 浏览器里人画，agent 通过 HTTP 接口往同一份元素数据上落笔。不是互传文件，是同一份数据。
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const dist = path.join(dir, 'dist')
const store = path.join(dir, 'scene.json')
const port = Number(process.env.CANVAS_PORT || 7801)

// 画布上那个「谁在画」的名字。换一个名字就能换掉全部提示语。
const agentName = process.env.CANVAS_AGENT_NAME || 'AI'

// 唤醒钩子：可选。设了就按反引号 / F9 时把一句 check 转给你的 agent 服务。
const pingUrl = process.env.CANVAS_PING_URL || ''

// —— 数据：一张纸切成几块，一块一个话题 ——
let boards = []
let current = ''
const tombstones = new Set()

function newBoardId() {
  return 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

function makeBoard(name) {
  return { id: newBoardId(), name: String(name || '新话题').slice(0, 40), elements: [] }
}

try {
  const saved = JSON.parse(fs.readFileSync(store, 'utf8'))
  if (Array.isArray(saved.boards) && saved.boards.length > 0) {
    boards = saved.boards.map((b) => ({
      id: String(b.id || newBoardId()),
      name: String(b.name || '话题').slice(0, 40),
      elements: Array.isArray(b.elements) ? b.elements : [],
    }))
    current = String(saved.current || boards[0].id)
  } else if (Array.isArray(saved.elements)) {
    // 老格式：整张纸就是一个话题
    const one = makeBoard('话题一')
    one.elements = saved.elements
    boards = [one]
    current = one.id
  }
  if (Array.isArray(saved.tombstones)) for (const id of saved.tombstones) tombstones.add(id)
} catch {
  /* first run */
}

if (boards.length === 0) {
  const one = makeBoard('话题一')
  boards = [one]
  current = one.id
}
if (!boards.some((b) => b.id === current)) current = boards[0].id

function board() {
  return boards.find((b) => b.id === current) || boards[0]
}

function listBoards() {
  return boards.map((b) => ({ id: b.id, name: b.name, count: b.elements.length }))
}

function persist() {
  try {
    fs.writeFileSync(store, JSON.stringify({ version: 2, boards, current, tombstones: [...tombstones] }))
  } catch (error) {
    console.error('persist failed', error)
  }
}

const clients = new Set()

function broadcast(message) {
  const line = `data: ${JSON.stringify(message)}\n\n`
  for (const res of clients) {
    try {
      res.write(line)
    } catch {
      clients.delete(res)
    }
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.map': 'application/json; charset=utf-8',
}

function sendJson(res, code, value) {
  const body = JSON.stringify(value)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function serveStatic(res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const target = path.join(dist, relative)
  if (!target.startsWith(dist)) {
    res.writeHead(403)
    return res.end('forbidden')
  }
  fs.readFile(target, (error, data) => {
    if (error) {
      fs.readFile(path.join(dist, 'index.html'), (fallbackError, fallback) => {
        if (fallbackError) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
          return res.end('还没有构建：先跑 pnpm build')
        }
        res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' })
        res.end(fallback)
      })
      return
    }
    const type = MIME[path.extname(target)] || 'application/octet-stream'
    const cache = type.includes('text/html') ? 'no-store' : 'no-cache'
    res.writeHead(200, { 'content-type': type, 'cache-control': cache })
    res.end(data)
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')

  if (url.pathname === '/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    res.write(': connected\n\n')
    clients.add(res)
    req.on('close', () => clients.delete(res))
    return
  }

  // —— 页面启动时读一次：agent 叫什么、唤醒钩子配没配 ——
  if (url.pathname === '/api/config' && req.method === 'GET') {
    return sendJson(res, 200, { agent: agentName, ping: Boolean(pingUrl) })
  }

  // —— 话题列表 ——
  if (url.pathname === '/api/boards') {
    if (req.method === 'GET') {
      if (url.searchParams.get('full') === '1') {
        return sendJson(res, 200, { current, boards })
      }
      return sendJson(res, 200, { current, boards: listBoards() })
    }
    if (req.method === 'POST') {
      let payload = {}
      try {
        payload = JSON.parse((await readBody(req)) || '{}')
      } catch {
        return sendJson(res, 400, { error: 'bad json' })
      }
      const made = makeBoard(payload.name)
      boards.push(made)
      persist()
      broadcast({ type: 'boards', current, boards: listBoards() })
      return sendJson(res, 200, { board: { id: made.id, name: made.name }, current, boards: listBoards() })
    }
    return sendJson(res, 405, { error: 'method not allowed' })
  }

  if (url.pathname === '/api/boards/select' && req.method === 'POST') {
    let payload = {}
    try {
      payload = JSON.parse((await readBody(req)) || '{}')
    } catch {
      return sendJson(res, 400, { error: 'bad json' })
    }
    const target = boards.find((b) => b.id === payload.id)
    if (!target) return sendJson(res, 404, { error: 'no such board' })
    current = target.id
    persist()
    broadcast({ type: 'boards', current, boards: listBoards() })
    return sendJson(res, 200, { current, elements: target.elements, boards: listBoards() })
  }

  if (url.pathname === '/api/boards/rename' && req.method === 'POST') {
    let payload = {}
    try {
      payload = JSON.parse((await readBody(req)) || '{}')
    } catch {
      return sendJson(res, 400, { error: 'bad json' })
    }
    const target = boards.find((b) => b.id === payload.id)
    if (!target) return sendJson(res, 404, { error: 'no such board' })
    const name = String(payload.name || '').trim().slice(0, 40)
    if (!name) return sendJson(res, 400, { error: 'empty name' })
    target.name = name
    persist()
    broadcast({ type: 'boards', current, boards: listBoards() })
    return sendJson(res, 200, { boards: listBoards() })
  }

  if (url.pathname === '/api/boards/delete' && req.method === 'POST') {
    let payload = {}
    try {
      payload = JSON.parse((await readBody(req)) || '{}')
    } catch {
      return sendJson(res, 400, { error: 'bad json' })
    }
    if (boards.length <= 1) return sendJson(res, 400, { error: '最后一个话题不能删' })
    const index = boards.findIndex((b) => b.id === payload.id)
    if (index < 0) return sendJson(res, 404, { error: 'no such board' })
    const gone = boards[index]
    for (const element of gone.elements) if (element && element.id) tombstones.add(element.id)
    boards.splice(index, 1)
    if (current === gone.id) current = boards[Math.max(0, index - 1)].id
    persist()
    broadcast({ type: 'boards', current, boards: listBoards() })
    broadcast({ type: 'scene', boardId: current, elements: board().elements, replace: true })
    return sendJson(res, 200, { current, elements: board().elements, boards: listBoards() })
  }

  if (url.pathname === '/api/elements') {
    if (req.method === 'GET') return sendJson(res, 200, { elements: board().elements, boardId: current })

    if (req.method === 'POST') {
      let payload
      try {
        payload = JSON.parse(await readBody(req))
      } catch {
        return sendJson(res, 400, { error: 'bad json' })
      }
      const incoming = Array.isArray(payload) ? payload : payload.elements
      if (!Array.isArray(incoming)) return sendJson(res, 400, { error: 'elements must be an array' })
      const target = board()

      // source=me：只往后追加，不覆盖人已经画的东西（agent 用这条路）
      if (url.searchParams.get('source') === 'me') {
        const known = new Set(target.elements.map((element) => element.id))
        for (const element of incoming) {
          if (!known.has(element.id) && !tombstones.has(element.id)) target.elements.push(element)
        }
        persist()
        if (url.searchParams.get('broadcast') !== '0') {
          broadcast({ type: 'scene', boardId: target.id, elements: target.elements })
        }
        return sendJson(res, 200, { ok: true, added: incoming.length, total: target.elements.length })
      }

      // 页面用：整份覆盖，但挡住 tombstone 里删过的元素，防止删掉的东西被推回来
      target.elements = incoming.filter(
        (element) => element === null || element === undefined || !tombstones.has(element.id),
      )
      persist()
      return sendJson(res, 200, { ok: true, total: target.elements.length })
    }

    return sendJson(res, 405, { error: 'method not allowed' })
  }

  if (url.pathname === '/api/ping' && req.method === 'GET') {
    return sendJson(res, 200, { agent: agentName, configured: Boolean(pingUrl), target: pingUrl || null })
  }

  if (url.pathname === '/api/ping' && req.method === 'POST') {
    if (!pingUrl) {
      return sendJson(res, 200, {
        ok: false,
        error: '没有配唤醒钩子（启动时设 CANVAS_PING_URL 就能用）',
      })
    }
    try {
      const r = await fetch(pingUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'check' }),
        signal: AbortSignal.timeout(8000),
      })
      const text = await r.text()
      return sendJson(res, 200, { ok: r.ok, status: r.status, body: text.slice(0, 500) })
    } catch (error) {
      return sendJson(res, 502, { ok: false, error: String((error && error.message) || error) })
    }
  }

  if (url.pathname === '/api/snapshot' && req.method === 'POST') {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      try {
        const buffer = Buffer.concat(chunks)
        fs.writeFileSync(path.join(dir, 'latest.png'), buffer)
        sendJson(res, 200, { ok: true, bytes: buffer.length })
      } catch (error) {
        sendJson(res, 500, { error: String(error) })
      }
    })
    return
  }

  if (url.pathname === '/api/replace' && req.method === 'POST') {
    let payload
    try {
      payload = JSON.parse(await readBody(req))
    } catch {
      return sendJson(res, 400, { error: 'bad json' })
    }
    const incoming = Array.isArray(payload) ? payload : payload.elements
    if (!Array.isArray(incoming)) return sendJson(res, 400, { error: 'elements must be an array' })
    if (Array.isArray(payload.tombstone)) for (const id of payload.tombstone) if (typeof id === 'string') tombstones.add(id)
    const target = board()
    target.elements = incoming.filter((element) => !tombstones.has(element.id))
    persist()
    broadcast({ type: 'scene', boardId: target.id, elements: target.elements, replace: true })
    return sendJson(res, 200, { ok: true, total: target.elements.length, tombstones: tombstones.size })
  }

  if (url.pathname === '/api/reset' && req.method === 'POST') {
    const target = board()
    target.elements = []
    persist()
    broadcast({ type: 'scene', boardId: target.id, elements: target.elements, replace: true })
    return sendJson(res, 200, { ok: true })
  }

  return serveStatic(res, url.pathname)
})

server.listen(port, '127.0.0.1', () => {
  console.log(`canvas ready at http://127.0.0.1:${port}（话题 ${boards.length} 个，agent 名字「${agentName}」）`)
})

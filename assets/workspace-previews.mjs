import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { parsePreviewSettings } from './preview-config.mjs'

const derive = promisify(crypto.scrypt)
const firstPort = 18080
const capacity = 8
const prefix = '/.dev-workspace-preview/'
const cookiePrefix = '__Host-dwpreview_'
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const hopHeaders = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        character
      ],
  )
}

async function readJson(file) {
  const stat = await fs.lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536)
    throw new Error('Invalid preview state file.')
  return JSON.parse(await fs.readFile(file, 'utf8'))
}

async function atomicJson(file, value) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`
  const handle = await fs.open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(JSON.stringify(value) + '\n')
    await handle.sync()
    await handle.close()
    await fs.rename(temporary, file)
    const directory = await fs.open(path.dirname(file), 'r')
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  } finally {
    await handle.close().catch(() => {})
    await fs.rm(temporary, { force: true })
  }
}

function cookieName(lease) {
  return cookiePrefix + lease.id.replaceAll('-', '')
}

function cookies(request) {
  return Object.fromEntries(
    String(request.headers.cookie || '')
      .split(';')
      .map((item) => item.trim().split(/=(.*)/s).slice(0, 2)),
  )
}

function externalOrigin(request) {
  const host = request.headers.host
  if (
    typeof host !== 'string' ||
    !/^(?:[a-zA-Z0-9.-]+|\[[a-fA-F0-9:]+\])(?::[0-9]{1,5})?$/.test(host)
  )
    return null
  if (request.headers['x-forwarded-proto'] !== 'https') return null
  return `https://${host.toLowerCase()}`
}

function cleanHeaders(headers) {
  const blocked = new Set([
    ...hopHeaders,
    ...String(headers.connection || '')
      .toLowerCase()
      .split(',')
      .map((value) => value.trim()),
  ])
  return Object.fromEntries(
    Object.entries(headers).filter(([key]) => !blocked.has(key.toLowerCase())),
  )
}

function proxyHeaders(request, origin) {
  const headers = cleanHeaders(request.headers)
  for (const key of Object.keys(headers)) {
    if (key === 'forwarded' || key.startsWith('x-forwarded-'))
      delete headers[key]
  }
  headers.host = new URL(origin).host
  headers['x-forwarded-host'] = headers.host
  headers['x-forwarded-proto'] = 'https'
  headers['x-forwarded-for'] = request.socket.remoteAddress
  const visibleCookies = String(headers.cookie || '')
    .split(';')
    .filter((item) => !item.trim().startsWith(cookiePrefix))
    .join(';')
  if (visibleCookies.trim()) headers.cookie = visibleCookies
  else delete headers.cookie
  return headers
}

function send(response, status, message) {
  response.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(message + '\n')
}

function websocketError(socket, status, message) {
  socket.end(
    `HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  )
}

export async function servePreviews(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const root = await fs.lstat(directory)
  if (!root.isDirectory() || root.isSymbolicLink())
    throw new Error('Invalid preview state directory.')
  await fs.chmod(directory, 0o700)
  const runtimeFile = path.join(directory, 'runtime.json')
  const historyFile = path.join(directory, 'expiry.json')
  const secret = crypto.randomBytes(32)
  const sessions = new Map()
  let deadlines = new Map()
  const connections = new Set()
  const servers = new Map()
  const listeners = new Set()
  let config = { version: 1, revision: 0, auth: null, leases: [], retired: [] }
  let expired = new Set()
  let observedAt = Date.now()
  let historyError = null
  let error = null
  let stopping = false
  let lastRuntime = ''
  let lastHistory = ''
  let lastAuth = null
  let loginAttempts = []
  let busyLogins = 0
  let lastAvailability = 0
  let availability = new Map()
  let lastHeartbeat = 0
  let lastListenerAttempt = 0
  let pending = Promise.resolve()
  let pendingExpiry = Promise.resolve()
  let refreshing = false
  let expiryObservedAt = 0

  try {
    const history = await readJson(historyFile)
    if (
      !Number.isSafeInteger(history.observedAt) ||
      !Array.isArray(history.expired) ||
      !history.expired.every((id) => uuid.test(id))
    )
      throw new Error('Invalid expiry history.')
    observedAt = history.observedAt
    expired = new Set(history.expired)
  } catch (failure) {
    if (failure.code !== 'ENOENT')
      historyError =
        'Preview expiry history is unreadable. Restore it before reopening previews.'
  }

  function leaseFor(port) {
    if (stopping || error || historyError || !config.auth) return null
    const lease = config.leases.find((value) => value.proxyPort === port)
    const deadline = lease && deadlines.get(lease.id)
    if (
      !lease ||
      !deadline ||
      expired.has(lease.id) ||
      Date.now() >= lease.expiresAt ||
      performance.now() >= deadline.until
    )
      return null
    return lease
  }

  function persistObservedExpiry(port) {
    if (stopping || error || historyError || !config.auth) return null
    const lease = config.leases.find((value) => value.proxyPort === port)
    if (!lease || expired.has(lease.id) || leaseFor(port)) return null
    expiryObservedAt = Math.max(expiryObservedAt, Date.now())
    pendingExpiry = scheduleRefresh(expiryObservedAt, lease.id)
    return pendingExpiry
  }

  async function requestLease(port) {
    await pendingExpiry
    const lease = leaseFor(port)
    if (lease) return lease
    await persistObservedExpiry(port)
    return leaseFor(port)
  }

  function sessionFor(request, lease, origin) {
    const token = cookies(request)[cookieName(lease)]
    const session = sessions.get(token)
    if (
      !session ||
      session.leaseId !== lease.id ||
      session.origin !== origin ||
      session.generation !== config.auth?.generation ||
      session.expiresAt <= Date.now()
    )
      return null
    return token
  }

  function nonce(lease, origin, expiry) {
    const content = `${lease.id}\n${origin}\n${expiry}`
    return `${expiry}.${crypto.createHmac('sha256', secret).update(content).digest('hex')}`
  }

  function loginPage(response, lease, origin, message = '') {
    const token = nonce(lease, origin, Date.now() + 300000)
    const styleNonce = crypto.randomBytes(12).toString('base64')
    response.writeHead(401, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': `default-src 'none'; style-src 'nonce-${styleNonce}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
      'Referrer-Policy': 'same-origin',
      'X-Content-Type-Options': 'nosniff',
    })
    response.end(
      `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(lease.name)} | Web Preview</title><style nonce="${styleNonce}">body{font:16px system-ui;background:#111827;color:#f9fafb;margin:0;padding:8vh 1.5rem}main{max-width:28rem;margin:auto}h1{font-size:2rem;overflow-wrap:anywhere}label,input,button{display:block;width:100%;box-sizing:border-box}input,button{font:inherit;padding:.8rem;border-radius:.5rem;margin:.6rem 0 1.2rem}button{border:0;background:#3b82f6;color:white;cursor:pointer}p{line-height:1.6;color:#cbd5e1}.error{color:#fca5a5}</style><main><p>DEV WORKSPACE</p><h1>${escapeHtml(lease.name)}</h1><p>Enter your Web Preview password to open this application.</p>${message ? `<p class="error" role="alert">${escapeHtml(message)}</p>` : ''}<form method="post" action="${prefix}login"><input type="hidden" name="nonce" value="${token}"><label for="password">Web Preview password</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="256" autofocus><button type="submit">Open preview</button></form><p>Manage access and expiry in Dev Workspace's Web Previews actions.</p></main></html>`,
    )
  }

  async function authenticate(request, response, lease, origin) {
    if (
      request.method !== 'POST' ||
      request.headers.origin !== origin ||
      !String(request.headers['content-type'] || '').startsWith(
        'application/x-www-form-urlencoded',
      )
    ) {
      send(response, 403, 'Open the preview sign-in page and try again.')
      return
    }
    const now = Date.now()
    loginAttempts = loginAttempts.filter((time) => now - time < 60000)
    if (loginAttempts.length >= 20 || busyLogins >= 2) {
      response.setHeader('Retry-After', '60')
      send(
        response,
        429,
        'Too many sign-in attempts. Wait a minute and try again.',
      )
      return
    }
    loginAttempts.push(now)
    let body = ''
    for await (const chunk of request) {
      body += chunk
      if (Buffer.byteLength(body) > 4096) {
        send(response, 413, 'Sign-in request is too large.')
        return
      }
    }
    const values = new URLSearchParams(body)
    const supplied = values.get('nonce') || ''
    const expiry = Number(supplied.split('.')[0])
    const expected = nonce(lease, origin, expiry)
    if (
      !Number.isSafeInteger(expiry) ||
      expiry < now ||
      expiry > now + 300000 ||
      supplied.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
    ) {
      send(
        response,
        403,
        'The sign-in page expired. Reload the preview and try again.',
      )
      return
    }
    const auth = config.auth
    const password = values.get('password') || ''
    if (!password || password.length > 256) {
      loginPage(response, lease, origin, 'The password was not accepted.')
      return
    }
    busyLogins += 1
    let hash
    try {
      hash = await derive(password, auth.salt, 32)
    } finally {
      busyLogins -= 1
    }
    if (
      !leaseFor(lease.proxyPort) ||
      config.auth.generation !== auth.generation
    ) {
      send(
        response,
        410,
        'Preview access changed. Reopen its StartOS interface.',
      )
      return
    }
    if (!crypto.timingSafeEqual(hash, Buffer.from(auth.hash, 'hex'))) {
      loginPage(response, lease, origin, 'The password was not accepted.')
      return
    }
    if (sessions.size >= 256) sessions.delete(sessions.keys().next().value)
    const token = crypto.randomBytes(32).toString('base64url')
    sessions.set(token, {
      leaseId: lease.id,
      origin,
      generation: auth.generation,
      expiresAt: now + 86400000,
    })
    response.writeHead(303, {
      Location: '/',
      'Cache-Control': 'no-store',
      'Set-Cookie': `${cookieName(lease)}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`,
    })
    response.end()
  }

  function track(request, lease, upstream, downstream, session) {
    const item = {
      leaseId: lease.id,
      proxyPort: lease.proxyPort,
      generation: config.auth.generation,
      upstream,
      downstream,
      session,
    }
    connections.add(item)
    const forget = () => connections.delete(item)
    downstream.once('close', () => {
      upstream.destroy()
      forget()
    })
    upstream.once('error', forget)
    if (request) request.once('aborted', () => upstream.destroy())
    return item
  }

  function proxyRequest(
    request,
    response,
    lease,
    origin,
    session,
    preflight = false,
  ) {
    if (!request.url?.startsWith('/') || request.url.startsWith('//')) {
      send(response, 400, 'Invalid application path.')
      return
    }
    const headers = proxyHeaders(request, origin)
    if (preflight) {
      delete headers.cookie
      delete headers.authorization
      delete headers['content-length']
    }
    const upstream = http.request({
      hostname: '127.0.0.1',
      port: lease.applicationPort,
      method: request.method,
      path: request.url,
      headers,
      agent: false,
    })
    track(request, lease, upstream, response, session)
    const connectTimer = setTimeout(
      () => upstream.destroy(new Error('Application connection timed out.')),
      5000,
    )
    upstream.once('socket', (socket) =>
      socket.once('connect', () => clearTimeout(connectTimer)),
    )
    upstream.once('close', () => clearTimeout(connectTimer))
    upstream.on('response', (incoming) => {
      if (preflight) {
        const allowed = [
          'access-control-allow-origin',
          'access-control-allow-methods',
          'access-control-allow-headers',
          'access-control-allow-credentials',
          'access-control-max-age',
          'vary',
        ]
        const headers = Object.fromEntries(
          Object.entries(incoming.headers).filter(([key]) =>
            allowed.includes(key),
          ),
        )
        response.writeHead(
          incoming.statusCode >= 200 && incoming.statusCode < 300 ? 204 : 403,
          { ...headers, 'Cache-Control': 'no-store' },
        )
        incoming.resume()
        response.end()
        return
      }
      response.writeHead(
        incoming.statusCode || 502,
        cleanHeaders(incoming.headers),
      )
      incoming.on('error', () => response.destroy())
      incoming.pipe(response)
    })
    upstream.on('error', () => {
      if (response.headersSent) response.destroy()
      else
        send(
          response,
          502,
          'The application is unavailable. Start it on the selected port and reload.',
        )
    })
    if (preflight) {
      request.resume()
      upstream.end()
    } else request.pipe(upstream)
  }

  async function handle(port, request, response) {
    const lease = await requestLease(port)
    if (!lease)
      return send(
        response,
        410,
        'This Web Preview is closed or unavailable. Open Dev Workspace to manage previews.',
      )
    const origin = externalOrigin(request)
    if (!origin)
      return send(
        response,
        403,
        'Open the HTTPS address shown in the StartOS interface.',
      )
    const target = request.url?.split('?')[0]
    if (target === `${prefix}login`)
      return authenticate(request, response, lease, origin)
    const session = sessionFor(request, lease, origin)
    if (target === `${prefix}logout`) {
      if (request.method !== 'POST' || request.headers.origin !== origin)
        return send(response, 403, 'Sign out from the preview origin.')
      if (session) sessions.delete(session)
      response.setHeader(
        'Set-Cookie',
        `${cookieName(lease)}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
      )
      return send(response, 200, 'Signed out of this preview.')
    }
    if (target?.startsWith(prefix))
      return send(response, 404, 'Unknown preview page.')
    if (connections.size >= 256)
      return send(
        response,
        503,
        'Too many active preview requests. Try again shortly.',
      )
    if (
      !session &&
      request.method === 'OPTIONS' &&
      request.headers.origin &&
      /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(
        request.headers['access-control-request-method'] || '',
      )
    ) {
      let requestedOrigin
      try {
        requestedOrigin = new URL(request.headers.origin)
      } catch {
        return send(response, 400, 'Invalid application origin.')
      }
      if (
        !['http:', 'https:'].includes(requestedOrigin.protocol) ||
        requestedOrigin.origin !== request.headers.origin
      )
        return send(response, 400, 'Invalid application origin.')
      return proxyRequest(request, response, lease, origin, null, true)
    }
    if (!session) {
      if (
        request.method === 'GET' &&
        String(request.headers.accept || '').includes('text/html')
      )
        return loginPage(response, lease, origin)
      return send(
        response,
        401,
        'Open this preview in your browser and sign in.',
      )
    }
    proxyRequest(request, response, lease, origin, session)
  }

  async function upgrade(port, request, socket, head) {
    const lease = await requestLease(port)
    const origin = externalOrigin(request)
    if (!lease) return websocketError(socket, 410, 'Gone')
    if (!origin || request.headers.upgrade?.toLowerCase() !== 'websocket')
      return websocketError(socket, 403, 'Forbidden')
    const session = sessionFor(request, lease, origin)
    if (!session) return websocketError(socket, 401, 'Unauthorized')
    if (request.headers.origin && request.headers.origin !== origin)
      return websocketError(socket, 403, 'Forbidden')
    if (connections.size >= 256)
      return websocketError(socket, 503, 'Unavailable')
    if (
      !request.url?.startsWith('/') ||
      request.url.startsWith('//') ||
      request.url.startsWith(prefix)
    )
      return websocketError(socket, 400, 'Bad Request')
    const upstream = http.request({
      hostname: '127.0.0.1',
      port: lease.applicationPort,
      method: 'GET',
      path: request.url,
      headers: {
        ...proxyHeaders(request, origin),
        Connection: 'Upgrade',
        Upgrade: 'websocket',
      },
      agent: false,
    })
    const item = track(request, lease, upstream, socket, session)
    const timer = setTimeout(() => upstream.destroy(), 5000)
    upstream.once('upgrade', (incoming, peer, upstreamHead) => {
      clearTimeout(timer)
      item.upstream = peer
      let headers = `HTTP/1.1 ${incoming.statusCode} ${incoming.statusMessage}\r\n`
      for (const [key, value] of Object.entries(incoming.headers)) {
        for (const entry of Array.isArray(value) ? value : [value])
          if (entry !== undefined) headers += `${key}: ${entry}\r\n`
      }
      socket.write(headers + '\r\n')
      if (upstreamHead.length) socket.write(upstreamHead)
      if (head.length) peer.write(head)
      peer.on('error', () => socket.destroy())
      socket.on('error', () => peer.destroy())
      socket.once('close', () => peer.destroy())
      peer.once('close', () => {
        socket.destroy()
        connections.delete(item)
      })
      peer.pipe(socket).pipe(peer)
    })
    upstream.once('response', () => {
      clearTimeout(timer)
      upstream.destroy()
      websocketError(socket, 502, 'Bad Gateway')
    })
    upstream.once('error', () => {
      clearTimeout(timer)
      websocketError(socket, 502, 'Bad Gateway')
    })
    upstream.end()
  }

  async function writeRuntime(force = false) {
    const value = {
      version: 1,
      revision: config.revision,
      error: error || historyError,
      invalidRecords: config.quarantined?.length || 0,
      leases: config.leases.map((lease) => ({
        id: lease.id,
        proxyPort: lease.proxyPort,
        expiresAt: lease.expiresAt,
        state: !leaseFor(lease.proxyPort)
          ? 'closed'
          : !listeners.has(lease.proxyPort)
            ? 'listener-unavailable'
            : availability.get(lease.id)
              ? 'listening'
              : 'waiting',
      })),
    }
    const serialized = JSON.stringify(value)
    if (
      force ||
      serialized !== lastRuntime ||
      Date.now() - lastHeartbeat > 5000
    ) {
      await atomicJson(runtimeFile, { ...value, observedAt: Date.now() })
      lastRuntime = serialized
      lastHeartbeat = Date.now()
    }
  }

  async function refresh(minimumObservedAt = 0) {
    let valid = false
    try {
      let next
      try {
        next = parsePreviewSettings(
          await readJson(path.join(directory, 'config.json')),
        )
      } catch (failure) {
        if (failure.code === 'ENOENT')
          next = {
            version: 1,
            revision: 0,
            auth: null,
            leases: [],
            retired: [],
          }
        else throw failure
      }
      const now = Math.max(Date.now(), minimumObservedAt, expiryObservedAt)
      if (now < observedAt - 1000)
        historyError =
          'The server clock moved backwards. Correct the clock and restart the preview service.'
      const nextObservedAt = Math.max(observedAt, now)
      const retained = new Set([
        ...next.leases.map((lease) => lease.id),
        ...next.retired,
        ...(next.quarantined || [])
          .filter(
            (record) =>
              record && typeof record.id === 'string' && uuid.test(record.id),
          )
          .map((record) => record.id),
      ])
      const nextExpired = new Set([...expired].filter((id) => retained.has(id)))
      for (const record of next.quarantined || [])
        if (record && typeof record.id === 'string' && uuid.test(record.id))
          nextExpired.add(record.id)
      const nextDeadlines = new Map(
        [...deadlines].filter(([id]) => retained.has(id)),
      )
      for (const lease of next.leases) {
        const previous = deadlines.get(lease.id)
        if (
          previous &&
          previous.expiry === lease.expiresAt &&
          performance.now() >= previous.until
        )
          nextExpired.add(lease.id)
        if (now >= lease.expiresAt || lease.createdAt > now + 1000)
          nextExpired.add(lease.id)
        if (!previous || previous.expiry !== lease.expiresAt) {
          nextDeadlines.set(lease.id, {
            expiry: lease.expiresAt,
            until:
              performance.now() +
              Math.max(0, Math.min(lease.expiresAt - now, 86400000)),
          })
        }
      }
      const history = {
        observedAt: Math.floor(nextObservedAt / 1000) * 1000,
        expired: [...nextExpired].sort(),
      }
      const serialized = JSON.stringify(history)
      if (serialized !== lastHistory && !historyError) {
        await atomicJson(historyFile, history)
        lastHistory = serialized
      }
      config = next
      expired = nextExpired
      deadlines = nextDeadlines
      observedAt = nextObservedAt
      if (expiryObservedAt <= now) expiryObservedAt = 0
      if (lastAuth !== config.auth?.generation) sessions.clear()
      lastAuth = config.auth?.generation
      for (const [token, session] of sessions)
        if (session.expiresAt <= now || !retained.has(session.leaseId))
          sessions.delete(token)
      if (now - lastListenerAttempt >= 2000) {
        lastListenerAttempt = now
        for (const [port, server] of servers) {
          if (stopping) break
          if (listeners.has(port)) continue
          await new Promise((resolve) => {
            const finish = () => {
              server.off('listening', finish)
              server.off('error', finish)
              resolve()
            }
            server.once('listening', finish)
            server.once('error', finish)
            server.listen(port, '::')
          })
        }
      }
      if (now - lastAvailability > 2000) {
        lastAvailability = now
        const checks = config.leases
          .filter((lease) => leaseFor(lease.proxyPort))
          .map(
            (lease) =>
              new Promise((resolve) => {
                const probe = net.connect({
                  host: '127.0.0.1',
                  port: lease.applicationPort,
                })
                const done = (result) => {
                  probe.destroy()
                  resolve([lease.id, result])
                }
                probe.setTimeout(1000, () => done(false))
                probe.once('connect', () => done(true))
                probe.once('error', () => done(false))
              }),
          )
        availability = new Map(await Promise.all(checks))
      }
      valid = true
    } catch {
      error =
        'Web Preview state is unavailable or invalid. Restore its configuration and retain the expiry history.'
    }
    revokeConnections()
    await writeRuntime()
    if (valid) error = null
  }

  function scheduleRefresh(minimumObservedAt = 0, leaseId = null) {
    refreshing = true
    const next = pending.then(() => {
      if ((stopping && !leaseId) || (leaseId && expired.has(leaseId))) return
      return refresh(minimumObservedAt)
    })
    const completed = next
      .catch(() => {
        error = 'Preview status could not be persisted.'
        for (const item of connections) {
          item.upstream.destroy()
          item.downstream.destroy()
        }
        connections.clear()
      })
      .finally(() => {
        if (pending === completed) refreshing = false
      })
    pending = completed
    return completed
  }

  function revokeConnections() {
    for (const item of connections) {
      const lease = leaseFor(item.proxyPort)
      if (!lease) persistObservedExpiry(item.proxyPort)
      if (
        !lease ||
        lease.id !== item.leaseId ||
        config.auth?.generation !== item.generation ||
        (item.session !== null && !sessions.has(item.session))
      ) {
        item.upstream.destroy()
        item.downstream.destroy()
        connections.delete(item)
      }
    }
  }

  for (let port = firstPort; port < firstPort + capacity; port += 1) {
    const server = http.createServer(
      { maxHeaderSize: 16384 },
      (request, response) => {
        handle(port, request, response).catch(() => {
          if (response.headersSent) response.destroy()
          else send(response, 503, 'Preview access is temporarily unavailable.')
        })
      },
    )
    server.headersTimeout = 10000
    server.requestTimeout = 300000
    server.keepAliveTimeout = 5000
    server.maxConnections = 128
    server.on('upgrade', (request, socket, head) => {
      upgrade(port, request, socket, head).catch(() =>
        websocketError(socket, 503, 'Unavailable'),
      )
    })
    server.on('error', () => listeners.delete(port))
    server.on('listening', () => listeners.add(port))
    server.on('close', () => listeners.delete(port))
    servers.set(port, server)
  }

  async function closeListeners() {
    await Promise.all(
      [...servers.values()].map(
        (server) =>
          new Promise((resolve) => {
            server.close(resolve)
            server.closeAllConnections()
          }),
      ),
    )
  }

  try {
    await refresh()
  } catch (failure) {
    stopping = true
    await closeListeners()
    throw failure
  }
  const expiryInterval = setInterval(revokeConnections, 100)
  const interval = setInterval(() => {
    if (refreshing || stopping) return
    scheduleRefresh()
  }, 200)
  return {
    async close() {
      stopping = true
      clearInterval(interval)
      clearInterval(expiryInterval)
      for (const item of connections) {
        item.upstream.destroy()
        item.downstream.destroy()
      }
      await pending
      await closeListeners()
      await writeRuntime(true)
    },
  }
}

async function main() {
  const directory = process.argv[3] || '/var/lib/dev-workspace/previews'
  if (process.argv[2] === 'serve') {
    const service = await servePreviews(directory)
    const stop = () =>
      service.close().then(
        () => process.exit(0),
        () => process.exit(1),
      )
    process.once('SIGTERM', stop)
    process.once('SIGINT', stop)
  } else if (process.argv[2] === 'status') {
    try {
      const value = await readJson(path.join(directory, 'runtime.json'))
      const age = Date.now() - value.observedAt
      if (
        value.error ||
        value.invalidRecords > 0 ||
        !Number.isSafeInteger(value.observedAt) ||
        age < 0 ||
        age >= 15000 ||
        value.leases.some((lease) => lease.state === 'listener-unavailable')
      )
        throw new Error('unavailable')
      process.stdout.write(JSON.stringify(value) + '\n')
    } catch {
      process.stderr.write(
        'Web Previews are unavailable. Check the preview service logs and configuration.\n',
      )
      process.exitCode = 1
    }
  } else {
    process.stderr.write('Choose serve or status.\n')
    process.exitCode = 1
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch(() => {
    process.stderr.write(
      'The preview service could not start or persist its state. Check storage and preview configuration.\n',
    )
    process.exitCode = 1
  })
}

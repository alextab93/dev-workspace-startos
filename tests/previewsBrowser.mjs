import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID, scryptSync } from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { chromium } from 'playwright'
import { servePreviews } from '../assets/workspace-previews.mjs'

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return server.address().port
}

async function close(server) {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
}

function application(name, allowOrigin) {
  const server = http.createServer((request, response) => {
    const origin = allowOrigin()
    if (request.headers.origin === origin) {
      response.setHeader('Access-Control-Allow-Origin', origin)
      response.setHeader('Access-Control-Allow-Credentials', 'true')
      response.setHeader('Vary', 'Origin')
    }
    if (request.method === 'OPTIONS') {
      response.setHeader('Access-Control-Allow-Methods', 'POST')
      response.setHeader(
        'Access-Control-Allow-Headers',
        'authorization,content-type',
      )
      response.writeHead(204)
      response.end()
      return
    }
    if (request.url === '/api') {
      let body = ''
      request.on('data', (chunk) => {
        body += chunk
      })
      request.on('end', () => {
        response.setHeader('Content-Type', 'application/json')
        response.end(
          JSON.stringify({ application: name, body, headers: request.headers }),
        )
      })
      return
    }
    if (request.url === '/cookie') {
      response.setHeader(
        'Set-Cookie',
        `app_session=${name}; Secure; HttpOnly; SameSite=Lax; Path=/`,
      )
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.end(
      `<!doctype html><html lang="en"><title>${name}</title><h1>${name}</h1><p>Application fixture</p></html>`,
    )
  })
  server.on('upgrade', (request, socket) => {
    const accept = createHash('sha1')
      .update(
        `${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`,
      )
      .digest('base64')
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    let buffered = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buffered = Buffer.concat([buffered, chunk])
      while (buffered.length >= 6) {
        const length = buffered[1] & 0x7f
        if (length >= 126 || !(buffered[1] & 0x80)) {
          socket.destroy()
          return
        }
        if (buffered.length < 6 + length) return
        const opcode = buffered[0] & 0x0f
        const mask = buffered.subarray(2, 6)
        const payload = Buffer.from(buffered.subarray(6, 6 + length))
        for (let index = 0; index < payload.length; index += 1)
          payload[index] ^= mask[index % 4]
        buffered = buffered.subarray(6 + length)
        if (opcode === 8) {
          socket.end(Buffer.from([0x88, 0]))
          return
        }
        if (opcode !== 1) {
          socket.destroy()
          return
        }
        const reply = Buffer.from(payload.toString().toUpperCase())
        socket.write(Buffer.concat([Buffer.from([0x81, reply.length]), reply]))
      }
    })
    socket.on('error', () => {})
    socket.on('end', () => socket.destroy())
  })
  return server
}

function tlsEdge(credentials, proxyPort) {
  const server = https.createServer(credentials, (request, response) => {
    const headers = Object.fromEntries(
      Object.entries(request.headers).filter(
        ([name]) => !name.startsWith('x-forwarded-') && name !== 'forwarded',
      ),
    )
    const upstream = http.request(
      {
        hostname: '127.0.0.1',
        port: proxyPort,
        method: request.method,
        path: request.url,
        headers: { ...headers, 'x-forwarded-proto': 'https' },
        agent: false,
      },
      (incoming) => {
        response.writeHead(incoming.statusCode, incoming.headers)
        incoming.pipe(response)
      },
    )
    upstream.on('error', () => {
      response.writeHead(502)
      response.end()
    })
    response.once('close', () => upstream.destroy())
    request.pipe(upstream)
  })
  server.on('upgrade', (request, socket, head) => {
    const upstream = http.request({
      hostname: '127.0.0.1',
      port: proxyPort,
      method: 'GET',
      path: request.url,
      headers: { ...request.headers, 'x-forwarded-proto': 'https' },
      agent: false,
    })
    upstream.on('upgrade', (response, peer, upstreamHead) => {
      let headers = `HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n`
      for (const [key, value] of Object.entries(response.headers))
        headers += `${key}: ${value}\r\n`
      socket.write(headers + '\r\n')
      if (head.length) peer.write(head)
      if (upstreamHead.length) socket.write(upstreamHead)
      socket.on('error', () => peer.destroy())
      peer.on('error', () => socket.destroy())
      socket.once('close', () => peer.destroy())
      peer.once('close', () => socket.destroy())
      socket.pipe(peer).pipe(socket)
    })
    upstream.on('response', (response) => {
      response.resume()
      socket.end(
        `HTTP/1.1 ${response.statusCode} Denied\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      )
    })
    upstream.on('error', () => socket.destroy())
    upstream.end()
  })
  return server
}

async function signIn(page, url, password, name) {
  const denied = await page.goto(url)
  assert.equal(denied.status(), 401)
  await page.getByLabel('Web Preview password', { exact: true }).fill(password)
  const [loginResponse] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith('/.dev-workspace-preview/login') &&
        response.request().method() === 'POST',
    ),
    page.getByRole('button', { name: 'Open preview', exact: true }).click(),
  ])
  assert.equal(
    loginResponse.status(),
    303,
    JSON.stringify({
      response: await loginResponse
        .text()
        .catch(() => 'Login did not return a redirect.'),
      origin: await loginResponse.request().headerValue('origin'),
      contentType: await loginResponse.request().headerValue('content-type'),
      url: loginResponse.url(),
    }),
  )
  await page.waitForURL(url + '/')
  await page
    .getByRole('heading', { name, exact: true })
    .waitFor({ timeout: 5000 })
  assert.equal(await page.title(), name)
}

test(
  'real browser previews isolate sign-in, retain app cookie semantics, allow explicit CORS and revoke streams',
  { timeout: 45000 },
  async () => {
    const directory = await fs.mkdtemp(
      path.join(tmpdir(), 'workspace-preview-browser-'),
    )
    const keyPath = path.join(directory, 'key.pem')
    const certPath = path.join(directory, 'cert.pem')
    const servers = []
    let proxy
    let browser
    try {
      execFileSync(
        'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-days',
          '1',
          '-subj',
          '/CN=localhost',
          '-keyout',
          keyPath,
          '-out',
          certPath,
        ],
        { stdio: 'ignore' },
      )
      const credentials = {
        key: await fs.readFile(keyPath),
        cert: await fs.readFile(certPath),
      }
      let frontendOrigin = ''
      const frontend = application('frontend', () => frontendOrigin)
      const api = application('api', () => frontendOrigin)
      servers.push(frontend, api)
      const frontendPort = await listen(frontend)
      const apiPort = await listen(api)
      const frontEdge = tlsEdge(credentials, 18080)
      const apiEdge = tlsEdge(credentials, 18081)
      servers.push(frontEdge, apiEdge)
      frontendOrigin = `https://127.0.0.1:${await listen(frontEdge)}`
      const apiOrigin = `https://127.0.0.1:${await listen(apiEdge)}`
      const password = randomBytes(24).toString('base64url')
      const salt = randomBytes(16).toString('hex')
      const config = {
        version: 1,
        revision: 1,
        auth: {
          generation: randomUUID(),
          salt,
          hash: scryptSync(password, salt, 32).toString('hex'),
        },
        leases: [
          {
            id: randomUUID(),
            name: 'frontend',
            applicationPort: frontendPort,
            proxyPort: 18080,
            createdAt: Date.now(),
            expiresAt: Date.now() + 60000,
          },
          {
            id: randomUUID(),
            name: 'api',
            applicationPort: apiPort,
            proxyPort: 18081,
            createdAt: Date.now(),
            expiresAt: Date.now() + 60000,
          },
        ],
        retired: [],
      }
      const write = async () => {
        const temporary = path.join(directory, `${randomUUID()}.json`)
        await fs.writeFile(temporary, JSON.stringify(config), { mode: 0o600 })
        await fs.rename(temporary, path.join(directory, 'config.json'))
      }
      await write()
      proxy = await servePreviews(directory)
      browser = await chromium.launch({ headless: true })
      const context = await browser.newContext({ ignoreHTTPSErrors: true })
      const page = await context.newPage()
      const apiPage = await context.newPage()
      await signIn(page, frontendOrigin, password, 'frontend')
      await signIn(apiPage, apiOrigin, password, 'api')
      const browserCookies = await context.cookies()
      const gates = browserCookies.filter((cookie) =>
        cookie.name.startsWith('__Host-dwpreview_'),
      )
      assert.equal(gates.length, 2)
      assert.ok(
        gates.every(
          (cookie) =>
            cookie.httpOnly && cookie.secure && cookie.sameSite === 'Lax',
        ),
      )
      await page.goto(frontendOrigin + '/cookie')
      const firstCookie = await page.evaluate(async () =>
        (await fetch('/api')).json(),
      )
      assert.equal(firstCookie.headers.cookie, 'app_session=frontend')
      await apiPage.goto(apiOrigin + '/cookie')
      const sharedCookie = await page.evaluate(async () =>
        (await fetch('/api')).json(),
      )
      assert.equal(sharedCookie.headers.cookie, 'app_session=api')
      const crossOrigin = await page.evaluate(async (url) => {
        const response = await fetch(url + '/api', {
          method: 'POST',
          credentials: 'include',
          headers: {
            Authorization: 'Bearer browser-fixture',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ message: 'cross-origin-ok' }),
        })
        return { status: response.status, data: await response.json() }
      }, apiOrigin)
      assert.equal(crossOrigin.status, 200)
      assert.equal(crossOrigin.data.application, 'api')
      assert.equal(crossOrigin.data.body, '{"message":"cross-origin-ok"}')
      assert.equal(
        crossOrigin.data.headers.authorization,
        'Bearer browser-fixture',
      )
      assert.equal(crossOrigin.data.headers.cookie, 'app_session=api')
      const socketValue = await page.evaluate(
        () =>
          new Promise((resolve, reject) => {
            const socket = new WebSocket(
              location.origin.replace('https:', 'wss:') + '/socket',
            )
            window.previewSocket = socket
            socket.onopen = () => socket.send('browser-fixture')
            socket.onmessage = (event) => resolve(event.data)
            socket.onerror = () =>
              reject(new Error('Browser WebSocket failed.'))
          }),
      )
      assert.equal(socketValue, 'BROWSER-FIXTURE')
      config.retired = [config.leases[1].id]
      config.leases = [config.leases[0]]
      config.revision += 1
      await write()
      await delay(500)
      assert.equal((await apiPage.goto(apiOrigin)).status(), 410)
      assert.equal(
        await page.evaluate(async () => (await fetch('/api')).status),
        200,
      )
      const closure = page.evaluate(
        () =>
          new Promise((resolve) =>
            window.previewSocket.addEventListener(
              'close',
              () => resolve(Date.now()),
              { once: true },
            ),
          ),
      )
      config.leases[0].expiresAt = Date.now() + 700
      config.revision += 1
      await write()
      const closedAt = await closure
      assert.ok(closedAt >= config.leases[0].expiresAt)
      assert.ok(closedAt - config.leases[0].expiresAt <= 2000)
      assert.equal((await page.goto(frontendOrigin)).status(), 410)
      assert.equal(
        (await fetch(`http://127.0.0.1:${frontendPort}/`)).status,
        200,
      )
      assert.equal((await fetch(`http://127.0.0.1:${apiPort}/`)).status, 200)
    } finally {
      if (browser) await browser.close()
      if (proxy) await proxy.close()
      await Promise.all(servers.map(close))
      await fs.rm(directory, { recursive: true, force: true })
    }
  },
)

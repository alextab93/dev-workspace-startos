import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID, scryptSync } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as fs from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { servePreviews } from '../assets/workspace-previews.mjs'

const port = 18080
const origin = `https://127.0.0.1:${port}`

async function request(
  path = '/',
  options: {
    method?: string
    headers?: Record<string, string>
    body?: string
    port?: number
  } = {},
) {
  return new Promise<{
    status: number
    headers: http.IncomingHttpHeaders
    body: string
  }>((resolve, reject) => {
    const client = http.request(
      {
        hostname: '127.0.0.1',
        port: options.port || port,
        path,
        agent: false,
        method: options.method || 'GET',
        headers: {
          Host: `127.0.0.1:${options.port || port}`,
          'X-Forwarded-Proto': 'https',
          ...options.headers,
        },
      },
      (response) => {
        let body = ''
        response.on('data', (data) => {
          body += data
        })
        response.on('end', () =>
          resolve({
            status: response.statusCode!,
            headers: response.headers,
            body,
          }),
        )
        response.on('error', reject)
      },
    )
    client.on('error', reject)
    client.end(options.body)
  })
}

async function fixture(run: (fixture: any) => Promise<void>) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'workspace-previews-'))
  const app = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(200, {
        'Access-Control-Allow-Origin': 'https://frontend.example.test',
        'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Allow-Headers': 'authorization,content-type',
        'Access-Control-Allow-Credentials': 'true',
        'Set-Cookie': 'must_not_pass=secret',
        'X-Private-Fixture': 'must_not_pass',
      })
      res.end(
        'This application response body must not pass the preflight gate.',
      )
    } else if (req.url === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: ready\n\n')
      const timer = setInterval(() => res.write('data: alive\n\n'), 100)
      res.once('close', () => clearInterval(timer))
    } else if (req.url === '/redirect') {
      res.writeHead(302, {
        Location: '/destination',
        'Set-Cookie': 'app_session=fixture; HttpOnly; Path=/',
      })
      res.end()
    } else {
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
      })
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json')
        res.end(
          JSON.stringify({
            body,
            method: req.method,
            url: req.url,
            headers: req.headers,
            result: 'application-ok',
          }),
        )
      })
    }
  })
  app.on('upgrade', (req, socket) => {
    const accept = createHash('sha1')
      .update(
        String(req.headers['sec-websocket-key']) +
          '258EAFA5-E914-47DA-95CA-C5AB0DC85B11',
      )
      .digest('base64')
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    socket.on('error', () => {})
    socket.on('end', () => socket.destroy())
    socket.on('data', (data) => socket.write(data))
  })
  await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve))
  const applicationPort = (app.address() as any).port
  const password = randomBytes(24).toString('base64url')
  const salt = randomBytes(16).toString('hex')
  const state = {
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
        name: 'Rails <fixture>',
        applicationPort,
        proxyPort: port,
        createdAt: Date.now(),
        expiresAt: Date.now() + 60000,
      },
    ],
    retired: [] as string[],
  }
  const write = async (raw = JSON.stringify(state)) => {
    const temporary = join(directory, `${randomUUID()}.json`)
    await fs.writeFile(temporary, raw, { mode: 0o600 })
    await fs.rename(temporary, join(directory, 'config.json'))
  }
  await write()
  let service = await servePreviews(directory)
  const restart = async () => {
    await service.close()
    service = await servePreviews(directory)
  }
  try {
    await run({ directory, state, password, write, restart, app })
  } finally {
    await service.close()
    app.closeAllConnections()
    await new Promise<void>((resolve) => app.close(() => resolve()))
    await fs.rm(directory, { recursive: true, force: true })
  }
}

async function login(password: string, targetPort = port) {
  const page = await request('/', {
    port: targetPort,
    headers: { Accept: 'text/html' },
  })
  assert.equal(page.status, 401)
  const nonce = /name="nonce" value="([^"]+)"/.exec(page.body)![1]
  const result = await request('/.dev-workspace-preview/login', {
    method: 'POST',
    port: targetPort,
    headers: {
      Origin: `https://127.0.0.1:${targetPort}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ password, nonce }).toString(),
  })
  return { ...result, cookie: result.headers['set-cookie']?.[0].split(';')[0] }
}

async function until(predicate: () => Promise<boolean>, timeout = 4000) {
  const deadline = performance.now() + timeout
  while (performance.now() < deadline) {
    if (await predicate()) return
    await delay(40)
  }
  assert.fail('Expected preview behavior was not observed before the deadline.')
}

async function previewClosed(cookie: string, status = 410, targetPort = port) {
  try {
    return (
      (await request('/', { port: targetPort, headers: { Cookie: cookie } }))
        .status === status
    )
  } catch (failure) {
    if ((failure as NodeJS.ErrnoException).code === 'ECONNRESET') return false
    throw failure
  }
}

async function connectSocket(cookie = '') {
  return new Promise<any>((resolve, reject) => {
    const client = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/socket',
      headers: {
        Host: `127.0.0.1:${port}`,
        'X-Forwarded-Proto': 'https',
        Origin: origin,
        Cookie: cookie,
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        'Sec-WebSocket-Version': '13',
      },
    })
    client.setTimeout(3000, () =>
      client.destroy(new Error('WebSocket connection timed out.')),
    )
    client.on('upgrade', (response, socket) =>
      resolve({ status: response.statusCode, socket }),
    )
    client.on('response', (response) => {
      response.resume()
      resolve({ status: response.statusCode })
    })
    client.on('error', reject)
    client.end()
  })
}

test('previews require HTTPS and authentication while the application keeps its cookies and bearer header', async () => {
  await fixture(async ({ password }) => {
    assert.equal((await request()).status, 401)
    assert.equal(
      (
        await request('/', {
          headers: { 'X-Forwarded-Proto': 'http', Accept: 'text/html' },
        })
      ).status,
      403,
    )
    const page = await request('/', { headers: { Accept: 'text/html' } })
    assert.match(page.body, /Rails &lt;fixture&gt;/)
    assert.doesNotMatch(page.body, /<fixture>/)
    assert.equal((await login('incorrect-password')).status, 401)
    const authorized = await login(password)
    assert.equal(authorized.status, 303)
    assert.match(
      authorized.headers['set-cookie']![0],
      /HttpOnly; Secure; SameSite=Lax/,
    )
    const response = await request('/api?query=one', {
      headers: {
        Cookie: `${authorized.cookie}; app_session=exact`,
        Authorization: 'Bearer application-token',
        Forwarded: 'host=attacker.invalid',
        'X-Forwarded-For': 'attacker',
        'X-Forwarded-Host': 'attacker.invalid',
      },
    })
    assert.equal(response.status, 200)
    const value = JSON.parse(response.body)
    assert.equal(value.result, 'application-ok')
    assert.equal(value.headers.cookie, 'app_session=exact')
    assert.equal(value.headers.authorization, 'Bearer application-token')
    assert.equal(value.headers['x-forwarded-host'], `127.0.0.1:${port}`)
    assert.equal(value.headers['x-forwarded-proto'], 'https')
    assert.notEqual(value.headers['x-forwarded-for'], 'attacker')
    assert.equal(value.headers.forwarded, undefined)
  })
})

test('previews proxy uploads, redirects and application cookies without altering their observable values', async () => {
  await fixture(async ({ password }) => {
    const { cookie } = await login(password)
    const upload = 'project-data-'.repeat(5000)
    const result = await request('/upload', {
      method: 'POST',
      headers: { Cookie: cookie!, 'Content-Type': 'text/plain' },
      body: upload,
    })
    assert.equal(result.status, 200)
    assert.equal(JSON.parse(result.body).body, upload)
    const redirect = await request('/redirect', {
      headers: { Cookie: cookie! },
    })
    assert.equal(redirect.status, 302)
    assert.equal(redirect.headers.location, '/destination')
    assert.deepEqual(redirect.headers['set-cookie'], [
      'app_session=fixture; HttpOnly; Path=/',
    ])
  })
})

test('cross-origin sign-in and invalid sign-in nonces do not authorize a preview', async () => {
  await fixture(async ({ password }) => {
    const page = await request('/', { headers: { Accept: 'text/html' } })
    const nonce = /name="nonce" value="([^"]+)"/.exec(page.body)![1]
    const body = new URLSearchParams({ password, nonce }).toString()
    assert.equal(
      (
        await request('/.dev-workspace-preview/login', {
          method: 'POST',
          headers: {
            Origin: 'https://other.invalid',
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body,
        })
      ).status,
      403,
    )
    assert.equal(
      (
        await request('/.dev-workspace-preview/login', {
          method: 'POST',
          headers: {
            Origin: origin,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ password, nonce: 'invalid' }).toString(),
        })
      ).status,
      403,
    )
    assert.equal((await request()).status, 401)
  })
})

test('browser CORS preflight preserves application policy while data requests still require preview authentication', async () => {
  await fixture(async ({ password }) => {
    const preflight = await request('/api', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://frontend.example.test',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type',
      },
    })
    assert.equal(preflight.status, 204)
    assert.equal(
      preflight.headers['access-control-allow-origin'],
      'https://frontend.example.test',
    )
    assert.equal(preflight.headers['access-control-allow-credentials'], 'true')
    assert.equal(preflight.headers['set-cookie'], undefined)
    assert.equal(preflight.headers['x-private-fixture'], undefined)
    assert.equal(preflight.body, '')
    assert.equal(
      (await request('/api', { method: 'POST', body: 'denied' })).status,
      401,
    )
    const { cookie } = await login(password)
    const result = await request('/api', {
      method: 'POST',
      headers: {
        Cookie: cookie!,
        Origin: 'https://frontend.example.test',
        Authorization: 'Bearer app-token',
      },
      body: 'accepted',
    })
    assert.equal(result.status, 200)
    assert.equal(JSON.parse(result.body).body, 'accepted')
    assert.equal(
      JSON.parse(result.body).headers.authorization,
      'Bearer app-token',
    )
  })
})

test('a granted extension remains usable beyond its former deadline', async () => {
  await fixture(async ({ state, password, write }) => {
    const { cookie } = await login(password)
    state.leases[0].expiresAt = Date.now() + 1000
    state.revision += 1
    await write()
    await delay(250)
    const formerExpiry = state.leases[0].expiresAt
    await delay(Math.max(0, formerExpiry - Date.now() - 80))
    state.leases[0].expiresAt = Date.now() + 5000
    state.revision += 1
    await write()
    await delay(400)
    assert.equal(
      (await request('/', { headers: { Cookie: cookie! } })).status,
      200,
    )
  })
})

test('a backwards clock relative to persisted expiry history keeps previews closed', async () => {
  await fixture(async ({ directory, restart }) => {
    await fs.writeFile(
      join(directory, 'expiry.json'),
      JSON.stringify({ observedAt: Date.now() + 60000, expired: [] }),
    )
    await restart()
    assert.equal((await request()).status, 410)
    const runtime = JSON.parse(
      await fs.readFile(join(directory, 'runtime.json'), 'utf8'),
    )
    assert.match(runtime.error, /clock moved backwards/)
  })
})

test('request-observed expiry survives a clock correction before background refresh', async (context) => {
  const started = Date.now()
  context.mock.timers.enable({ apis: ['Date', 'setInterval'], now: started })
  await fixture(async ({ state, password, restart }) => {
    const { cookie } = await login(password)
    assert.equal(
      (await request('/', { headers: { Cookie: cookie! } })).status,
      200,
    )
    context.mock.timers.setTime(state.leases[0].expiresAt + 1)
    assert.equal(
      (await request('/', { headers: { Cookie: cookie! } })).status,
      410,
    )
    context.mock.timers.setTime(started)
    assert.equal(
      (await request('/', { headers: { Cookie: cookie! } })).status,
      410,
    )
    await restart()
    assert.equal((await request()).status, 410)
    const direct = await fetch(
      `http://127.0.0.1:${state.leases[0].applicationPort}/`,
    )
    assert.equal(((await direct.json()) as any).result, 'application-ok')
  })
})

test('request-observed expiry is durable before the next refresh or shutdown', async (context) => {
  const started = Date.now()
  context.mock.timers.enable({ apis: ['Date', 'setInterval'], now: started })
  await fixture(async ({ state, directory, password }) => {
    const { cookie } = await login(password)
    context.mock.timers.setTime(state.leases[0].expiresAt + 1)
    assert.equal(
      (await request('/', { headers: { Cookie: cookie! } })).status,
      410,
    )
    const history = JSON.parse(
      await fs.readFile(join(directory, 'expiry.json'), 'utf8'),
    )
    assert.deepEqual(history.expired, [state.leases[0].id])
    assert.ok(history.observedAt >= state.leases[0].expiresAt - 999)
  })
})

test('websocket-observed expiry stays denied after the clock is corrected and the proxy restarts', async (context) => {
  const started = Date.now()
  context.mock.timers.enable({ apis: ['Date', 'setInterval'], now: started })
  await fixture(async ({ state, password, restart }) => {
    const { cookie } = await login(password)
    context.mock.timers.setTime(state.leases[0].expiresAt + 1)
    assert.equal((await connectSocket(cookie)).status, 410)
    context.mock.timers.setTime(started)
    assert.equal((await connectSocket(cookie)).status, 410)
    await restart()
    assert.equal((await connectSocket(cookie)).status, 410)
  })
})

test('connection-observed expiry is retained when shutdown starts before persistence', async (context) => {
  const started = Date.now()
  context.mock.timers.enable({ apis: ['Date', 'setInterval'], now: started })
  await fixture(async ({ state, directory, password, restart }) => {
    const { cookie } = await login(password)
    const connection = await connectSocket(cookie)
    assert.equal(connection.status, 101)
    context.mock.timers.setTime(state.leases[0].expiresAt + 1)
    context.mock.timers.tick(100)
    context.mock.timers.setTime(started)
    await restart()
    assert.equal((await request()).status, 410)
    const history = JSON.parse(
      await fs.readFile(join(directory, 'expiry.json'), 'utf8'),
    )
    assert.deepEqual(history.expired, [state.leases[0].id])
  })
})

test('failed expiry persistence retains the observed deadline through storage repair', async (context) => {
  const started = Date.now()
  context.mock.timers.enable({ apis: ['Date', 'setInterval'], now: started })
  await fixture(async ({ state, directory, password, restart }) => {
    const { cookie } = await login(password)
    const history = join(directory, 'expiry.json')
    const config = await fs.readFile(join(directory, 'config.json'), 'utf8')
    await fs.rename(history, `${history}.saved`)
    await fs.mkdir(history)
    try {
      context.mock.timers.setTime(state.leases[0].expiresAt + 1)
      assert.equal(
        (await request('/', { headers: { Cookie: cookie! } })).status,
        410,
      )
      context.mock.timers.setTime(started)
      assert.equal(
        (await request('/', { headers: { Cookie: cookie! } })).status,
        410,
      )
    } finally {
      await fs.rmdir(history)
      await fs.rename(`${history}.saved`, history)
    }
    context.mock.timers.tick(200)
    await until(async () => {
      const value = JSON.parse(await fs.readFile(history, 'utf8'))
      return value.expired.includes(state.leases[0].id)
    })
    assert.equal(
      await fs.readFile(join(directory, 'config.json'), 'utf8'),
      config,
    )
    await restart()
    assert.equal((await request()).status, 410)
  })
})

test('expired previews deny new requests and close streaming responses while leaving the application running', async () => {
  await fixture(async ({ state, password, write }) => {
    const { cookie } = await login(password)
    const closed = new Promise<number>((resolve, reject) => {
      const client = http.get(
        {
          hostname: '127.0.0.1',
          port,
          path: '/events',
          headers: {
            Host: `127.0.0.1:${port}`,
            'X-Forwarded-Proto': 'https',
            Cookie: cookie!,
          },
        },
        (response) => {
          response.once('data', async (data) => {
            assert.match(String(data), /data: ready/)
            state.leases[0].expiresAt = Date.now() + 400
            state.revision += 1
            await write()
          })
          response.on('error', () => {})
          response.on('close', () => resolve(Date.now()))
        },
      )
      client.on('error', reject)
    })
    const closedAt = await Promise.race([
      closed,
      delay(3500).then(() =>
        assert.fail('Expired streaming response remained open.'),
      ),
    ])
    assert.ok(closedAt >= state.leases[0].expiresAt)
    assert.ok(closedAt - state.leases[0].expiresAt <= 2000)
    assert.equal(
      (await request('/', { headers: { Cookie: cookie! } })).status,
      410,
    )
    const direct = await fetch(
      `http://127.0.0.1:${state.leases[0].applicationPort}/`,
    )
    assert.equal(((await direct.json()) as any).result, 'application-ok')
  })
})

test('password rotation revokes existing sessions and restored expired state remains closed', async () => {
  await fixture(async ({ password, state, write, restart }) => {
    const { cookie } = await login(password)
    assert.equal(
      (await request('/', { headers: { Cookie: cookie! } })).status,
      200,
    )
    state.auth.generation = randomUUID()
    state.revision += 1
    await write()
    await until(() => previewClosed(cookie!, 401))
    state.leases[0].expiresAt = Date.now() + 250
    state.revision += 1
    await write()
    await until(() => previewClosed(''))
    await restart()
    assert.equal((await request()).status, 410)
  })
})

test('malformed configuration fails closed and a repaired configuration recovers without moving application data', async () => {
  await fixture(async ({ password, write }) => {
    const { cookie } = await login(password)
    await write('{broken')
    await until(
      async () =>
        (await request('/', { headers: { Cookie: cookie! } })).status === 410,
    )
    await write()
    await until(
      async () =>
        (await request('/', { headers: { Cookie: cookie! } })).status === 200,
    )
  })
})

test('a damaged preview closes independently while another authenticated preview and socket continue working', async () => {
  await fixture(async ({ password, state, write, directory, restart }) => {
    const secondApp = http.createServer((_request, response) =>
      response.end('second-application'),
    )
    await new Promise<void>((resolve) =>
      secondApp.listen(0, '127.0.0.1', resolve),
    )
    let connection: any
    try {
      const second = {
        ...state.leases[0],
        id: randomUUID(),
        name: 'Second',
        proxyPort: port + 1,
        applicationPort: (secondApp.address() as any).port,
      }
      state.leases.push(second)
      state.revision += 1
      await write()
      await until(
        async () => (await request('/', { port: port + 1 })).status === 401,
      )
      const firstLogin = await login(password)
      const secondLogin = await login(password, port + 1)
      assert.equal(secondLogin.status, 303)
      assert.equal(
        (
          await request('/', {
            port: port + 1,
            headers: { Cookie: secondLogin.cookie! },
          })
        ).body,
        'second-application',
      )
      connection = await connectSocket(firstLogin.cookie)
      assert.equal(connection.status, 101)
      const broken = { ...second, expiresAt: null, futureSetting: 'retain' }
      const raw = JSON.stringify({
        ...state,
        leases: [state.leases[0], broken],
      })
      await write(raw)
      await until(() => previewClosed(secondLogin.cookie!, 410, port + 1))
      assert.equal(
        JSON.parse(
          (await request('/', { headers: { Cookie: firstLogin.cookie! } }))
            .body,
        ).result,
        'application-ok',
      )
      const frame = Buffer.from([0x81, 0x82, 1, 2, 3, 4, 0x69, 0x6b])
      const echoed = new Promise<Buffer>((resolve) =>
        connection.socket.once('data', resolve),
      )
      connection.socket.write(frame)
      assert.deepEqual(
        await Promise.race([
          echoed,
          delay(2000).then(() =>
            assert.fail(
              'Working preview socket stopped after unrelated corruption.',
            ),
          ),
        ]),
        frame,
      )
      await until(
        async () =>
          JSON.parse(await fs.readFile(join(directory, 'runtime.json'), 'utf8'))
            .invalidRecords === 1,
      )
      const runtime = JSON.parse(
        await fs.readFile(join(directory, 'runtime.json'), 'utf8'),
      )
      assert.equal(runtime.invalidRecords, 1)
      assert.equal(runtime.error, null)
      assert.equal(
        await fs.readFile(join(directory, 'config.json'), 'utf8'),
        raw,
      )
      connection.socket.destroy()
      await restart()
      const reconnected = await login(password)
      assert.equal(
        (await request('/', { headers: { Cookie: reconnected.cookie! } }))
          .status,
        200,
      )
      assert.equal((await request('/', { port: port + 1 })).status, 410)
      await write()
      await delay(500)
      assert.equal((await request('/', { port: port + 1 })).status, 410)
      second.id = randomUUID()
      state.revision += 1
      await write()
      await until(
        async () => (await request('/', { port: port + 1 })).status === 401,
      )
      const replacement = await login(password, port + 1)
      assert.equal(
        (
          await request('/', {
            port: port + 1,
            headers: { Cookie: replacement.cookie! },
          })
        ).body,
        'second-application',
      )
      assert.equal(
        (await request('/', { headers: { Cookie: reconnected.cookie! } }))
          .status,
        200,
      )
    } finally {
      connection?.socket?.destroy()
      secondApp.closeAllConnections()
      await new Promise<void>((resolve) => secondApp.close(() => resolve()))
    }
  })
})

test('websocket access is authenticated, exchanges bytes and closes after preview removal', async () => {
  await fixture(async ({ password, state, write }) => {
    assert.equal((await connectSocket()).status, 401)
    const { cookie } = await login(password)
    const connection = await Promise.race([
      connectSocket(cookie),
      delay(3000).then(() =>
        assert.fail('WebSocket upgrade did not complete.'),
      ),
    ])
    assert.equal(connection.status, 101)
    const frame = Buffer.from([0x81, 0x82, 1, 2, 3, 4, 0x69, 0x6b])
    const received = new Promise<Buffer>((resolve) =>
      connection.socket.once('data', resolve),
    )
    connection.socket.write(frame)
    assert.deepEqual(
      await Promise.race([
        received,
        delay(3000).then(() => {
          connection.socket.destroy()
          assert.fail('WebSocket frame was not echoed.')
        }),
      ]),
      frame,
    )
    const closed = new Promise<void>((resolve) =>
      connection.socket.once('close', resolve),
    )
    state.retired = [state.leases[0].id]
    state.leases = []
    state.revision += 1
    await write()
    await Promise.race([
      closed,
      delay(3500).then(() =>
        assert.fail('Removed preview left its websocket connected.'),
      ),
    ])
    assert.equal((await request()).status, 410)
  })
})

test('an occupied preview listener reports its conflict and recovers when the port becomes available', async () => {
  const blocker = http.createServer((_request, response) => {
    response.writeHead(503)
    response.end('port-owned-by-another-application')
  })
  await new Promise<void>((resolve) => blocker.listen(port, '::', resolve))
  try {
    await fixture(async ({ directory, password }) => {
      const runtime = JSON.parse(
        await fs.readFile(join(directory, 'runtime.json'), 'utf8'),
      )
      assert.equal(runtime.leases[0].state, 'listener-unavailable')
      assert.equal((await request()).body, 'port-owned-by-another-application')
      blocker.closeAllConnections()
      await new Promise<void>((resolve) => blocker.close(() => resolve()))
      await until(async () => {
        try {
          return (await request()).status === 401
        } catch {
          return false
        }
      })
      const { cookie } = await login(password)
      const result = await request('/', { headers: { Cookie: cookie! } })
      assert.equal(result.status, 200)
      assert.equal(JSON.parse(result.body).result, 'application-ok')
    })
  } finally {
    blocker.closeAllConnections()
    await new Promise<void>((resolve) => blocker.close(() => resolve()))
  }
})

test('failed expiry history writes close access without replacing configuration and recover after storage repair', async () => {
  await fixture(async ({ directory, password }) => {
    const { cookie } = await login(password)
    const config = await fs.readFile(join(directory, 'config.json'), 'utf8')
    const history = join(directory, 'expiry.json')
    await fs.rename(history, `${history}.saved`)
    await fs.mkdir(history)
    try {
      await until(() => previewClosed(cookie!))
      for (let attempt = 0; attempt < 15; attempt += 1) {
        assert.equal(
          (await request('/', { headers: { Cookie: cookie! } })).status,
          410,
        )
        await delay(30)
      }
      assert.equal(
        await fs.readFile(join(directory, 'config.json'), 'utf8'),
        config,
      )
      const runtime = JSON.parse(
        await fs.readFile(join(directory, 'runtime.json'), 'utf8'),
      )
      assert.match(runtime.error, /state is unavailable/)
    } finally {
      await fs.rmdir(history)
      await fs.rename(`${history}.saved`, history)
    }
    await until(
      async () =>
        (await request('/', { headers: { Cookie: cookie! } })).status === 200,
    )
  })
})

test('failed runtime status writes keep access closed throughout retries and recover after storage repair', async () => {
  await fixture(async ({ directory, password, state, write }) => {
    const { cookie } = await login(password)
    const runtime = join(directory, 'runtime.json')
    await fs.rename(runtime, `${runtime}.saved`)
    await fs.mkdir(runtime)
    state.revision += 1
    await write()
    try {
      await until(() => previewClosed(cookie!))
      for (let attempt = 0; attempt < 30; attempt += 1) {
        assert.equal(
          (await request('/', { headers: { Cookie: cookie! } })).status,
          410,
        )
        await delay(10)
      }
    } finally {
      await fs.rmdir(runtime)
      await fs.rename(`${runtime}.saved`, runtime)
    }
    await until(
      async () =>
        (await request('/', { headers: { Cookie: cookie! } })).status === 200,
    )
    await until(
      async () => JSON.parse(await fs.readFile(runtime, 'utf8')).error === null,
    )
  })
})

test('authenticated WebSockets close within two seconds of expiry while the application remains available', async () => {
  await fixture(async ({ password, state, write }) => {
    const { cookie } = await login(password)
    const connection = await connectSocket(cookie)
    assert.equal(connection.status, 101)
    const closed = new Promise<number>((resolve) =>
      connection.socket.once('close', () => resolve(Date.now())),
    )
    state.leases[0].expiresAt = Date.now() + 700
    state.revision += 1
    await write()
    try {
      const closedAt = await Promise.race([
        closed,
        delay(3000).then(() =>
          assert.fail('Expired preview left its WebSocket connected.'),
        ),
      ])
      assert.ok(closedAt >= state.leases[0].expiresAt)
      assert.ok(closedAt - state.leases[0].expiresAt <= 2000)
      assert.equal((await connectSocket(cookie)).status, 410)
      const direct = await fetch(
        `http://127.0.0.1:${state.leases[0].applicationPort}/`,
      )
      assert.equal(((await direct.json()) as any).result, 'application-ok')
    } finally {
      connection.socket.destroy()
    }
  })
})

test('proxy restart preserves a valid lease and password while requiring a fresh browser session', async () => {
  await fixture(async ({ password, directory, restart }) => {
    const { cookie } = await login(password)
    const before = await fs.readFile(join(directory, 'config.json'), 'utf8')
    await restart()
    assert.equal(
      await fs.readFile(join(directory, 'config.json'), 'utf8'),
      before,
    )
    assert.equal(
      (await request('/', { headers: { Cookie: cookie! } })).status,
      401,
    )
    const next = await login(password)
    assert.equal(next.status, 303)
    const result = await request('/', { headers: { Cookie: next.cookie! } })
    assert.equal(result.status, 200)
    assert.equal(JSON.parse(result.body).result, 'application-ok')
  })
})

test('startup keeps an expired preview denied while an unrelated valid preview remains usable', async () => {
  await fixture(async ({ password, directory, state, write, restart }) => {
    const expiredApp = http.createServer((_request, response) => {
      response.end('expired application still running')
    })
    await new Promise<void>((resolve) =>
      expiredApp.listen(0, '127.0.0.1', resolve),
    )
    const applicationPort = (expiredApp.address() as any).port
    try {
      const expired = {
        id: randomUUID(),
        name: 'Expired at startup',
        applicationPort,
        proxyPort: 18081,
        createdAt: Date.now() - 60000,
        expiresAt: Date.now() - 1000,
      }
      state.leases.push(expired)
      state.revision += 1
      await write()
      const saved = await fs.readFile(join(directory, 'config.json'), 'utf8')
      await restart()
      const { cookie } = await login(password)
      assert.equal((await request('/', { port: 18081 })).status, 410)
      const active = await request('/', { headers: { Cookie: cookie! } })
      assert.equal(active.status, 200)
      assert.equal(JSON.parse(active.body).result, 'application-ok')
      const runtime = JSON.parse(
        await fs.readFile(join(directory, 'runtime.json'), 'utf8'),
      )
      assert.equal(runtime.error, null)
      assert.equal(
        runtime.leases.find((lease: any) => lease.id === expired.id).state,
        'closed',
      )
      assert.equal(
        runtime.leases.find((lease: any) => lease.id === state.leases[0].id)
          .state,
        'listening',
      )
      assert.equal(
        await fs.readFile(join(directory, 'config.json'), 'utf8'),
        saved,
      )
      assert.equal(
        await (await fetch(`http://127.0.0.1:${applicationPort}/`)).text(),
        'expired application still running',
      )
    } finally {
      expiredApp.closeAllConnections()
      await new Promise<void>((resolve) => expiredApp.close(() => resolve()))
    }
  })
})

test('an application crash reports unavailable and recovers on the same preview without a new sign-in', async () => {
  await fixture(async ({ password, directory, state, app }) => {
    const { cookie } = await login(password)
    const saved = await fs.readFile(join(directory, 'config.json'), 'utf8')
    const applicationPort = state.leases[0].applicationPort
    app.closeAllConnections()
    await new Promise<void>((resolve) => app.close(() => resolve()))
    const unavailable = await request('/', { headers: { Cookie: cookie! } })
    assert.equal(unavailable.status, 502)
    assert.match(unavailable.body, /application is unavailable/)
    await until(async () => {
      const runtime = JSON.parse(
        await fs.readFile(join(directory, 'runtime.json'), 'utf8'),
      )
      return runtime.leases[0].state === 'waiting'
    })
    await new Promise<void>((resolve) =>
      app.listen(applicationPort, '127.0.0.1', resolve),
    )
    const recovered = await request('/', { headers: { Cookie: cookie! } })
    assert.equal(recovered.status, 200)
    assert.equal(JSON.parse(recovered.body).result, 'application-ok')
    await until(async () => {
      const runtime = JSON.parse(
        await fs.readFile(join(directory, 'runtime.json'), 'utf8'),
      )
      return runtime.leases[0].state === 'listening'
    })
    assert.equal(
      await fs.readFile(join(directory, 'config.json'), 'utf8'),
      saved,
    )
  })
})

test('startup persistence failure releases its listeners so a repaired service can start', async () => {
  const directory = await fs.mkdtemp(
    join(tmpdir(), 'workspace-previews-startup-'),
  )
  const runtime = join(directory, 'runtime.json')
  try {
    await fs.mkdir(runtime)
    await assert.rejects(servePreviews(directory))
    await fs.rmdir(runtime)
    const service = await servePreviews(directory)
    try {
      assert.equal((await request()).status, 410)
      const status = JSON.parse(await fs.readFile(runtime, 'utf8'))
      assert.equal(status.error, null)
      assert.deepEqual(status.leases, [])
    } finally {
      await service.close()
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('preview status rejects future, stale and malformed timestamps while accepting fresh reports', async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'preview-status-'))
  const now = 1700000000000
  try {
    const clock = join(directory, 'clock.mjs')
    await fs.writeFile(clock, `Date.now = () => ${now}\n`)
    const report = {
      version: 1,
      revision: 1,
      error: null,
      invalidRecords: 0,
      leases: [],
    }
    const timestamps = [
      now + 1,
      now + 60000,
      now - 15000,
      undefined,
      null,
      String(now),
      -1,
      now + 0.5,
      Number.MAX_SAFE_INTEGER + 1,
      now,
      now - 14999,
    ]
    for (const observedAt of timestamps) {
      const value = { ...report, observedAt }
      await fs.writeFile(join(directory, 'runtime.json'), JSON.stringify(value))
      const result = spawnSync(
        process.execPath,
        [
          '--import',
          clock,
          fileURLToPath(
            new URL('../assets/workspace-previews.mjs', import.meta.url),
          ),
          'status',
          directory,
        ],
        { encoding: 'utf8', timeout: 10000 },
      )
      const fresh = observedAt === now || observedAt === now - 14999
      assert.equal(
        result.status,
        fresh ? 0 : 1,
        JSON.stringify({
          observedAt,
          stdout: result.stdout,
          stderr: result.stderr,
        }),
      )
      if (fresh) {
        assert.deepEqual(JSON.parse(result.stdout), value)
        assert.equal(result.stderr, '')
      } else {
        assert.equal(result.stdout, '')
        assert.equal(
          result.stderr,
          'Web Previews are unavailable. Check the preview service logs and configuration.\n',
        )
      }
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

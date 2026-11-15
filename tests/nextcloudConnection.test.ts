import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { inspect } from 'node:util'
import type { T } from '@start9labs/start-sdk'
import {
  NextcloudConnectionError,
  nextcloudConnectionFile,
  parseNextcloudConnectionResult,
  readNextcloudConnection,
  resolveNextcloud,
  resolveNextcloudTransport,
} from '../startos/nextcloudConnection'

function hostFixture(): T.Host {
  return {
    bindings: {
      80: {
        enabled: true,
        options: {
          preferredExternalPort: 80,
          addSsl: {
            preferredExternalPort: 443,
            alpn: ['http/1.1'],
            upstreamCertValidation: null,
          },
          secure: null,
          proxy: { type: 'http', addXForwardedHeaders: true, auth: null },
        },
        net: { assignedPort: 50101, assignedSslPort: 60101 },
        addresses: {
          enabled: [],
          disabled: [],
          guaWan: [],
          lanEnabled: [],
          available: [
            {
              ssl: false,
              public: false,
              hostname: '10.0.3.1',
              port: 50101,
              metadata: { kind: 'ipv4', gateway: 'lxcbr0' },
            },
            {
              ssl: true,
              public: false,
              hostname: '10.0.3.1',
              port: 60101,
              metadata: { kind: 'ipv4', gateway: 'lxcbr0' },
            },
            {
              ssl: true,
              public: false,
              hostname: '127.0.0.1',
              port: 60101,
              metadata: { kind: 'ipv4', gateway: 'lo' },
            },
            {
              ssl: false,
              public: false,
              hostname: '192.0.2.10',
              port: 50101,
              metadata: { kind: 'ipv4', gateway: 'eno0' },
            },
            {
              ssl: true,
              public: false,
              hostname: '192.0.2.10',
              port: 60101,
              metadata: { kind: 'ipv4', gateway: 'eno0' },
            },
            {
              ssl: true,
              public: false,
              hostname: 'fd00:1234::1',
              port: 60101,
              metadata: { kind: 'ipv6', gateway: 'eno0', scopeId: 2 },
            },
            {
              ssl: true,
              public: false,
              hostname: 'workspace-test.local',
              port: 60101,
              metadata: { kind: 'mdns', gateways: ['eno0'] },
            },
            {
              ssl: true,
              public: true,
              hostname: 'cloud.example.test',
              port: 443,
              metadata: { kind: 'public-domain', gateway: 'eno0' },
            },
          ],
        },
        interfaces: {
          ui: {
            id: 'ui',
            name: 'Web UI',
            description: '',
            masked: false,
            addressInfo: {
              username: null,
              hostId: 'main',
              internalPort: 80,
              scheme: 'http',
              sslScheme: 'https',
              suffix: '',
            },
            type: 'ui',
            preferredLauncherAddress: null,
          },
        },
      },
    },
    bindingRanges: {},
    publicDomains: {},
    privateDomains: {},
    portForwards: [],
  }
}

function effectsBoundary(host: T.Host | null, version = '35.0.3:0') {
  return {
    getHostInfo: async () => host,
    getServiceManifest: async () => ({ version, satisfies: [] }),
  } as unknown as T.Effects
}

test('discovers a Nextcloud HTTPS LAN transport and distinct browser address while excluding the bridge transport', async () => {
  const result = await resolveNextcloud(effectsBoundary(hostFixture()))
  assert.deepEqual(result, {
    internalBaseUrl: 'https://192.0.2.10:60101',
    browserBaseUrl: 'https://cloud.example.test',
    allowedBaseUrls: [
      'https://192.0.2.10:60101',
      'https://cloud.example.test',
      'https://workspace-test.local:60101',
      'https://[fd00:1234::1]:60101',
      'https://10.0.3.1:60101',
    ],
  })
})

test('uses an enabled preferred browser address', async () => {
  const host = hostFixture()
  host.bindings[80].interfaces.ui.preferredLauncherAddress =
    'https://workspace-test.local:60101/'
  const result = await resolveNextcloud(effectsBoundary(host))
  assert.equal(result.browserBaseUrl, 'https://workspace-test.local:60101')
  assert.deepEqual(result.allowedBaseUrls, [
    'https://192.0.2.10:60101',
    'https://workspace-test.local:60101',
    'https://cloud.example.test',
    'https://[fd00:1234::1]:60101',
    'https://10.0.3.1:60101',
  ])
})

test('rejects an unsupported installation prefix instead of constructing a mismatched endpoint', async () => {
  const host = hostFixture()
  host.bindings[80].interfaces.ui.addressInfo.suffix = '/nextcloud/'
  await assert.rejects(
    resolveNextcloud(effectsBoundary(host)),
    /no enabled HTTPS address/,
  )
})

test('excludes disabled and unregistered preferred addresses from authorization discovery', async () => {
  const host = hostFixture()
  host.bindings[80].addresses.disabled = [['cloud.example.test', 443]]
  host.bindings[80].interfaces.ui.preferredLauncherAddress =
    'https://unregistered.example.test'
  const result = await resolveNextcloud(effectsBoundary(host))
  assert.deepEqual(result, {
    internalBaseUrl: 'https://192.0.2.10:60101',
    browserBaseUrl: 'https://workspace-test.local:60101',
    allowedBaseUrls: [
      'https://192.0.2.10:60101',
      'https://workspace-test.local:60101',
      'https://[fd00:1234::1]:60101',
      'https://10.0.3.1:60101',
    ],
  })
})

test('does not fabricate an address when Nextcloud, its TLS binding, or browser address is unavailable', async () => {
  await assert.rejects(
    resolveNextcloud(effectsBoundary(null)),
    /Nextcloud is unavailable/,
  )
  await assert.rejects(
    resolveNextcloud(effectsBoundary(hostFixture(), '34.0.0:0')),
    /compatible Nextcloud/,
  )
  const disabled = hostFixture()
  disabled.bindings[80].enabled = false
  await assert.rejects(
    resolveNextcloud(effectsBoundary(disabled)),
    /Nextcloud is unavailable/,
  )
  const withoutTls = hostFixture()
  withoutTls.bindings[80].addresses.available =
    withoutTls.bindings[80].addresses.available.filter(
      (address) => !address.ssl,
    )
  await assert.rejects(
    resolveNextcloud(effectsBoundary(withoutTls)),
    /no enabled HTTPS address/,
  )
  const withoutBrowser = hostFixture()
  withoutBrowser.bindings[80].addresses.available =
    withoutBrowser.bindings[80].addresses.available.filter(
      (address) => address.hostname === '10.0.3.1',
    )
  await assert.rejects(
    resolveNextcloud(effectsBoundary(withoutBrowser)),
    /no enabled HTTPS address/,
  )
})

test('keeps a saved enabled HTTPS origin stable and rejects the bridge as a preferred transport', async () => {
  const host = hostFixture()
  const effects = effectsBoundary(host)
  assert.equal(
    await resolveNextcloudTransport(effects, 'https://cloud.example.test/'),
    'https://cloud.example.test',
  )
  assert.equal(
    (await resolveNextcloud(effects, 'https://cloud.example.test'))
      .internalBaseUrl,
    'https://cloud.example.test',
  )
  for (const preferred of [
    'https://10.0.3.1:60101',
    'https://127.0.0.1:60101',
    'http://192.0.2.10:50101',
    'https://unregistered.example.test',
  ]) {
    assert.equal(
      await resolveNextcloudTransport(effects, preferred),
      'https://192.0.2.10:60101',
    )
  }
})

test('falls back from a disabled saved origin through enabled IPv4, IPv6, and domain HTTPS addresses', async () => {
  const host = hostFixture()
  host.bindings[80].addresses.disabled = [['cloud.example.test', 443]]
  assert.equal(
    await resolveNextcloudTransport(
      effectsBoundary(host),
      'https://cloud.example.test',
    ),
    'https://192.0.2.10:60101',
  )
  host.bindings[80].addresses.disabled.push(['192.0.2.10', 60101])
  assert.equal(
    await resolveNextcloudTransport(effectsBoundary(host)),
    'https://[fd00:1234::1]:60101',
  )
  host.bindings[80].addresses.disabled = [
    ['192.0.2.10', 60101],
    ['fd00:1234::1', 60101],
  ]
  assert.equal(
    await resolveNextcloudTransport(effectsBoundary(host)),
    'https://cloud.example.test',
  )
  host.bindings[80].addresses.available =
    host.bindings[80].addresses.available.filter(
      (address) => address.hostname === '10.0.3.1',
    )
  await assert.rejects(
    resolveNextcloudTransport(effectsBoundary(host)),
    /Nextcloud is unavailable/,
  )
})

test(
  'reactive transport resolution refreshes the usable HTTPS origin after an address is disabled',
  { timeout: 5000 },
  async () => {
    const host = hostFixture()
    let changed = () => {}
    let leave = () => {}
    let inContext = true
    let publish: (value: string) => void = () => {}
    let rejectRefresh: (reason: unknown) => void = () => {}
    const refreshed = new Promise<string>((resolve, reject) => {
      publish = resolve
      rejectRefresh = reject
    })
    const effects = {
      getHostInfo: async ({ callback }: { callback?: () => void }) => {
        if (callback) changed = callback
        return host
      },
      get isInContext() {
        return inContext
      },
      onLeaveContext: (callback: () => void) => {
        leave = callback
      },
      constRetry: () => {
        void resolveNextcloudTransport(effects).then(publish, rejectRefresh)
      },
    } as unknown as T.Effects
    try {
      assert.equal(
        await resolveNextcloudTransport(effects, undefined, true),
        'https://192.0.2.10:60101',
      )
      host.bindings[80].addresses.disabled = [['192.0.2.10', 60101]]
      changed()
      assert.equal(await refreshed, 'https://[fd00:1234::1]:60101')
    } finally {
      inContext = false
      leave()
    }
  },
)

const publicConnection = {
  ok: true,
  state: 'connected',
  pending: null,
  connection: {
    id: 'connection-123',
    accountId: 'developer',
    displayName: 'Developer',
  },
}

test('returns folder choices while stripping private credentials from helper responses', () => {
  const result = parseNextcloudConnectionResult(
    JSON.stringify({
      ...publicConnection,
      appPassword: 'never-public',
      connection: {
        ...publicConnection.connection,
        appPassword: 'never-public',
        username: 'private-login',
        url: 'https://private.example.test',
      },
      path: 'Projects',
      parentPath: '',
      canSelect: true,
      folders: [
        {
          name: 'Proyecto español',
          path: 'Projects/Proyecto español',
          canSelect: true,
        },
      ],
    }),
  )
  assert.deepEqual(result, {
    ...publicConnection,
    path: 'Projects',
    parentPath: '',
    canSelect: true,
    folders: [
      {
        name: 'Proyecto español',
        path: 'Projects/Proyecto español',
        canSelect: true,
      },
    ],
  })
})

test('helper failures retain actionable codes without exposing response bodies or parse causes', () => {
  const secret = 'fixture-private-app-password'
  for (const response of [
    '{"appPassword":"' + secret,
    JSON.stringify({
      ok: false,
      code: 'authentication_failed',
      message: secret,
      appPassword: secret,
    }),
    JSON.stringify({ ...publicConnection, path: '../' + secret }),
  ]) {
    assert.throws(
      () => parseNextcloudConnectionResult(response),
      (error) => {
        assert.ok(error instanceof NextcloudConnectionError)
        assert.equal(inspect(error).includes(secret), false)
        assert.equal(error.cause, undefined)
        return true
      },
    )
  }
  assert.throws(
    () =>
      parseNextcloudConnectionResult(
        JSON.stringify({
          ok: false,
          code: 'authorization_expired',
          message: secret,
        }),
        1,
      ),
    (error) =>
      error instanceof NextcloudConnectionError &&
      error.code === 'authorization_expired',
  )
  assert.throws(
    () => parseNextcloudConnectionResult(JSON.stringify(publicConnection), 1),
    (error) =>
      error instanceof NextcloudConnectionError &&
      error.code === 'command_failed',
  )
})

test('reads stored account state and reports malformed private files without revealing secrets', async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'nextcloud-connection-'))
  try {
    const file = nextcloudConnectionFile.withPath(join(directory, 'state.json'))
    assert.equal(await readNextcloudConnection(undefined, file), null)
    const state = {
      version: 1,
      browsePath: 'Projects',
      connection: {
        id: 'connection-123',
        url: 'https://10.0.3.1:60101/remote.php/dav/files/developer/',
        username: 'developer@example.test',
        appPassword: 'fixture-private-app-password',
        accountId: 'developer',
        displayName: 'Developer',
        internalBaseUrl: 'https://10.0.3.1:60101',
      },
    }
    await fs.writeFile(file.path, JSON.stringify(state), { mode: 0o600 })
    assert.deepEqual(await readNextcloudConnection(undefined, file), state)
    await fs.writeFile(
      file.path,
      '{"appPassword":"fixture-private-app-password',
    )
    await assert.rejects(readNextcloudConnection(undefined, file), (error) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /Nextcloud account settings are invalid/)
      assert.equal(
        inspect(error).includes('fixture-private-app-password'),
        false,
      )
      assert.equal(error.cause, undefined)
      return true
    })
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import type { T } from '@start9labs/start-sdk'
import { listPreviews } from '../startos/actions/previews'
import {
  previewConfigFile,
  previewRuntimeFile,
} from '../startos/fileModels/previews.json'
import { emptyPreviewConfig } from '../startos/previews'

test('preview list reports readiness only for the current credential configuration and exact lease', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1700000000000 })
  const directory = await fs.mkdtemp(join(tmpdir(), 'preview-action-'))
  const paths = new Map([
    [resolve(previewConfigFile.path), join(directory, 'config.json')],
    [resolve(previewRuntimeFile.path), join(directory, 'runtime.json')],
  ])
  const access = fs.access.bind(fs)
  const realpath = fs.realpath.bind(fs)
  const redirect = (path: Parameters<typeof fs.access>[0]) =>
    typeof path === 'string' ? paths.get(resolve(path)) || path : path
  t.mock.method(fs, 'access', (path, mode) => access(redirect(path), mode))
  t.mock.method(fs, 'realpath', (path, options) =>
    realpath(redirect(path), options),
  )
  const lease = {
    id: randomUUID(),
    name: 'Frontend',
    applicationPort: 5173,
    proxyPort: 18080,
    createdAt: Date.now() - 60000,
    expiresAt: Date.now() + 60000,
  }
  const config = {
    ...emptyPreviewConfig(),
    revision: 2,
    auth: {
      generation: randomUUID(),
      salt: 'a'.repeat(32),
      hash: 'b'.repeat(64),
    },
    leases: [lease],
  }
  const report = {
    version: 1,
    revision: config.revision,
    observedAt: Date.now(),
    error: null,
    invalidRecords: 0,
    leases: [{ ...lease, state: 'listening' }],
  }
  const effects = {
    isInContext: true,
    onLeaveContext() {},
    async getHostInfo() {
      return null
    },
  } as unknown as T.Effects
  const configPath = join(directory, 'config.json')
  const runtimePath = join(directory, 'runtime.json')
  const unavailable = 'Preview service is not ready.'
  const cases = [
    {
      name: 'current listening report',
      config,
      report,
      status: 'Application port is accepting connections.',
    },
    {
      name: 'current application is still starting',
      config,
      report: { ...report, leases: [{ ...lease, state: 'waiting' }] },
      status: 'Waiting for the application to start on its port.',
    },
    {
      name: 'report from before password rotation',
      config,
      report: { ...report, revision: config.revision - 1 },
      status: unavailable,
    },
    {
      name: 'report from before lease extension',
      config,
      report: {
        ...report,
        leases: [
          { ...lease, expiresAt: lease.expiresAt - 1000, state: 'listening' },
        ],
      },
      status: unavailable,
    },
    {
      name: 'report for a different proxy port',
      config,
      report: {
        ...report,
        leases: [{ ...lease, proxyPort: 18081, state: 'listening' }],
      },
      status: unavailable,
    },
    {
      name: 'credentials revoked with a retained runtime report',
      config: { ...config, auth: null },
      report,
      status: unavailable,
    },
    {
      name: 'future runtime observation',
      config,
      report: { ...report, observedAt: Date.now() + 1 },
      status: unavailable,
    },
    {
      name: 'stale runtime observation',
      config,
      report: { ...report, observedAt: Date.now() - 15000 },
      status: unavailable,
    },
    {
      name: 'current runtime after recovery',
      config,
      report,
      status: 'Application port is accepting connections.',
    },
  ]
  const lifetimeCases = [
    { milliseconds: 86400000, text: '24 h 0 min 0 s' },
    { milliseconds: 3661000, text: '1 h 1 min 1 s' },
    { milliseconds: 60000, text: '0 h 1 min 0 s' },
    { milliseconds: 59999, text: '0 h 1 min 0 s' },
    { milliseconds: 59000, text: '0 h 0 min 59 s' },
    { milliseconds: 1, text: '0 h 0 min 1 s' },
    { milliseconds: 0, text: '0 h 0 min 0 s' },
    { milliseconds: -1, text: '0 h 0 min 0 s' },
  ]
  const scenarios = [
    ...cases.map((scenario) => ({
      ...scenario,
      remaining: '0 h 1 min 0 s',
    })),
    ...lifetimeCases.map(({ milliseconds, text }) => {
      const timedLease = { ...lease, expiresAt: Date.now() + milliseconds }
      return {
        name: `remaining lifetime at ${milliseconds} milliseconds`,
        config: { ...config, leases: [timedLease] },
        report: { ...report, leases: [{ ...timedLease, state: 'listening' }] },
        status:
          milliseconds > 0
            ? 'Application port is accepting connections.'
            : 'Expired',
        remaining: text,
      }
    }),
  ]
  try {
    for (const scenario of scenarios) {
      await t.test(scenario.name, async () => {
        const savedConfig = JSON.stringify(scenario.config)
        const savedReport = JSON.stringify(scenario.report)
        await fs.writeFile(configPath, savedConfig)
        await fs.writeFile(runtimePath, savedReport)
        const result = await listPreviews.run({ effects, input: null })
        assert.equal(result?.title, 'Web Previews')
        assert.match(
          result?.message || '',
          /Reopen List Web Previews to refresh the remaining time\./,
        )
        assert.equal(result?.result?.type, 'group')
        if (result?.result?.type !== 'group')
          throw new Error('Missing previews')
        assert.equal(result.result.value.length, 1)
        const item = result.result.value[0]
        assert.equal(item.type, 'single')
        if (item.type !== 'single') throw new Error('Missing preview details')
        assert.equal(item.name, 'Frontend')
        assert.equal(
          item.description,
          `${scenario.status} Application Port: 5173. Remaining: ${scenario.remaining}. Expires: ${new Date(scenario.config.leases[0].expiresAt).toISOString()}.`,
        )
        assert.equal(await fs.readFile(configPath, 'utf8'), savedConfig)
        assert.equal(await fs.readFile(runtimePath, 'utf8'), savedReport)
      })
    }
    await t.test(
      'a reachable preview offers the installed Vite command on its application port',
      async () => {
        await fs.writeFile(configPath, JSON.stringify(config))
        const address = {
          hostname: 'workspace.local',
          port: 59221,
          ssl: true,
          public: false,
          metadata: { kind: 'mdns', gateways: ['eth0'] },
        }
        const network = {
          ...effects,
          async getHostInfo() {
            return {
              bindings: {
                [lease.proxyPort]: {
                  enabled: true,
                  addresses: {
                    enabled: [],
                    disabled: [],
                    lanEnabled: [],
                    guaWan: [],
                    available: [address],
                  },
                  interfaces: {},
                  options: {},
                  net: {
                    assignedPort: lease.proxyPort,
                    assignedSslPort: address.port,
                  },
                },
              },
              bindingRanges: {},
              publicDomains: {},
              privateDomains: {},
              portForwards: [],
            }
          },
        } as unknown as T.Effects
        const response = await listPreviews.run({
          effects: network,
          input: null,
        })
        if (response?.result?.type !== 'group')
          throw new Error('Missing preview details')
        const command = response.result.value.find(
          (item) => item.name === 'Vite launch command',
        )
        if (command?.type !== 'single') throw new Error('Missing Vite command')
        assert.equal(command.copyable, true)
        assert.equal(
          command.value,
          "__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS='workspace.local' ./node_modules/.bin/vite --host 127.0.0.1 --port 5173 --strictPort",
        )
      },
    )
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

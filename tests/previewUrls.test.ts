import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import type { T } from '@start9labs/start-sdk'
import { previewUrls } from '../startos/previews'

test('preview links prefer enabled private mDNS and retain the assigned TLS port', async () => {
  const lease = {
    id: randomUUID(),
    name: 'Frontend',
    applicationPort: 5173,
    proxyPort: 18080,
    createdAt: 1000,
    expiresAt: 900001,
  }
  const addresses = {
    enabled: [],
    disabled: [] as Array<[string, number]>,
    lanEnabled: [],
    guaWan: [],
    available: [
      {
        hostname: '10.20.30.2',
        port: 59221,
        ssl: true,
        public: false,
        metadata: { kind: 'ipv4', gateway: 'virtual' },
      },
      {
        hostname: '192.168.1.20',
        port: 59221,
        ssl: true,
        public: false,
        metadata: { kind: 'ipv4', gateway: 'eth0' },
      },
      {
        hostname: 'workspace.local',
        port: 59221,
        ssl: true,
        public: false,
        metadata: { kind: 'mdns', gateways: ['eth0'] },
      },
    ],
  }
  const binding = {
    enabled: true,
    addresses,
    interfaces: {},
    options: {},
    net: { assignedPort: 18080, assignedSslPort: 59221 },
  }
  const host = {
    bindings: { 18080: binding },
    bindingRanges: {},
    publicDomains: {},
    privateDomains: {},
    portForwards: [],
  }
  const effects = () =>
    ({
      isInContext: true,
      onLeaveContext() {},
      async getHostInfo() {
        return host
      },
    }) as unknown as T.Effects
  assert.deepEqual(await previewUrls(effects(), lease), [
    'https://workspace.local:59221',
    'https://10.20.30.2:59221',
    'https://192.168.1.20:59221',
  ])
  addresses.disabled.push(['workspace.local', 59221])
  assert.deepEqual(await previewUrls(effects(), lease), [
    'https://10.20.30.2:59221',
  ])
  binding.enabled = false
  assert.deepEqual(await previewUrls(effects(), lease), [])
})

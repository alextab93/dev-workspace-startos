import { type T } from '@start9labs/start-sdk'
import { sdk } from './sdk'
import { i18n } from './i18n'
import { sshHostId, sshPort, sshUsername } from './utils'
import {
  emptyPreviewConfig,
  parsePreviewConfig,
  previewHostId,
  readPreviewConfig,
} from './previews'
import { previewFiles, previewRuntimeFile } from './fileModels/previews.json'

export const setInterfaces = async (effects: T.Effects) => {
  const retired = new Set<string>()
  await sdk.setupInterfaces(async ({ effects }) => {
    const host = sdk.MultiHost.of(effects, sshHostId)
    const origin = await host.bindPort(sshPort, {
      protocol: 'ssh',
      preferredExternalPort: sshPort,
    })
    const ssh = sdk.createInterface(effects, {
      id: 'ssh',
      name: i18n('Development SSH'),
      description: i18n('Connect with desktop VS Code Remote SSH.'),
      type: 'api',
      masked: false,
      schemeOverride: null,
      username: sshUsername,
      path: '',
      query: {},
    })
    const receipts = [await origin.export([ssh])]
    const config = await readPreviewConfig(effects).catch(() =>
      emptyPreviewConfig(),
    )
    const runtime = await previewRuntimeFile
      .read(
        (value) => ({
          error: value.error,
          leases: value.leases,
          heartbeat: Math.floor(value.observedAt / 30000),
        }),
        (left, right) => JSON.stringify(left) === JSON.stringify(right),
      )
      .const(effects)
      .catch(() => null)
    for (const id of config.retired) retired.add(id)
    for (const lease of config.leases) {
      if (lease.expiresAt <= Date.now()) {
        retired.add(lease.id)
        continue
      }
      const observed = runtime?.leases.find(
        (value) => value.id === lease.id && value.proxyPort === lease.proxyPort,
      )
      if (
        !config.auth ||
        runtime?.error ||
        !observed ||
        !['listening', 'waiting'].includes(observed.state)
      )
        continue
      const preview = sdk.MultiHost.of(effects, previewHostId(lease.id))
      const previewOrigin = await preview.bindPort(lease.proxyPort, {
        protocol: 'http',
        preferredExternalPort: lease.proxyPort,
      })
      receipts.push(
        await previewOrigin.export([
          sdk.createInterface(effects, {
            id: previewHostId(lease.id),
            name: lease.name,
            description: i18n(
              'Temporary application preview. Sign in with your Web Preview password.',
            ),
            type: 'ui',
            masked: false,
            schemeOverride: null,
            username: null,
            path: '',
            query: {},
          }),
        ]),
      )
    }
    return receipts
  })(effects)
  if (!retired.size) return
  for (const id of retired)
    await sdk.MultiHost.of(effects, previewHostId(id)).retire()
  await previewFiles.config.update(
    effects,
    (current) => {
      if (!current) return null
      const state = parsePreviewConfig(JSON.stringify(current))
      const leases = state.leases.filter(
        (lease) => !(retired.has(lease.id) && lease.expiresAt <= Date.now()),
      )
      const remaining = state.retired.filter((id) => !retired.has(id))
      if (
        leases.length === state.leases.length &&
        remaining.length === state.retired.length
      )
        return null
      return {
        ...state,
        revision: state.revision + 1,
        leases,
        retired: remaining,
      }
    },
    { allowWriteAfterConst: true },
  )
}

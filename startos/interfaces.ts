import { sdk } from './sdk'
import { i18n } from './i18n'
import { sshHostId, sshPort, sshUsername } from './utils'

export const setInterfaces = sdk.setupInterfaces(async ({ effects }) => {
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
  return [await origin.export([ssh])]
})

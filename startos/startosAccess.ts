import type { T } from '@start9labs/start-sdk'
import { sdk } from './sdk'

export async function prepareStartosAccess(
  effects: T.Effects,
  workspace:
    | ReturnType<typeof sdk.SubContainer.of>
    | Awaited<ReturnType<typeof sdk.SubContainer.eager>>,
) {
  const address = await effects.getOsIp()
  const url = new URL(
    `https://${address.includes(':') ? `[${address}]` : address}`,
  ).origin
  await workspace.execFail(
    ['install', '-d', '-m', '0755', '/run/dev-workspace'],
    { user: 'root' },
  )
  await workspace.writeFile(
    '/run/dev-workspace/local-startos.json',
    JSON.stringify({ version: 1, url, rootCa: await sdk.getRootCa(effects) }),
    { mode: 0o644 },
  )
}

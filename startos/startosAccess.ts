import type { T } from '@start9labs/start-sdk'
import { randomUUID } from 'node:crypto'
import { sdk } from './sdk'
import {
  startosAccessFile,
  startosAccessSchema,
  startosAccessSource,
} from './fileModels/startosAccess.json'

export async function initializeStartosAccess(
  effects: T.Effects,
  kind: 'install' | 'update' | 'restore' | null,
  source = startosAccessSource,
) {
  await source.update(effects, (raw) => {
    if (kind === 'restore')
      return JSON.stringify({ version: 1, restoreGeneration: randomUUID() })
    const state =
      raw === null
        ? { version: 1, restoreGeneration: null }
        : startosAccessSchema.parse(JSON.parse(raw))
    return JSON.stringify(state)
  })
}

export const prepareStartosIdentity = sdk.setupOnInit((effects, kind) =>
  initializeStartosAccess(effects, kind),
)

export async function prepareStartosAccess(
  effects: T.Effects,
  workspace:
    | ReturnType<typeof sdk.SubContainer.of>
    | Awaited<ReturnType<typeof sdk.SubContainer.eager>>,
) {
  const access = await startosAccessFile.read().once()
  if (!access)
    throw new Error(
      'StartOS access state is missing. Run service initialization before connecting.',
    )
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
    JSON.stringify({ ...access, url, rootCa: await sdk.getRootCa(effects) }),
    { mode: 0o644 },
  )
}

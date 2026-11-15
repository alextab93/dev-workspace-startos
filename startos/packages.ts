import { z, type T } from '@start9labs/start-sdk'
import { sdk } from './sdk'
import { i18n } from './i18n'

const packageValidator = z.object({
  token: z.string().regex(/^[a-f0-9]{32}$/),
  path: z.string(),
  id: z.string(),
  title: z.string(),
  version: z.string(),
  size: z.number().int().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  architectures: z.array(z.string()),
  compatible: z.boolean(),
  installedVersion: z.string().nullable(),
})
export const catalogValidator = z.object({
  packages: z.array(packageValidator),
  errors: z.array(z.object({ path: z.string(), error: z.string() })),
  truncated: z.boolean(),
  scannedAt: z.string().nullable(),
  connected: z.boolean(),
  architecture: z.string(),
})
export const jobValidator = z.object({
  id: z.string(),
  operation: z.string(),
  state: z.enum(['running', 'succeeded', 'failed', 'interrupted', 'cancelled']),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  message: z.string(),
  package: z
    .object({
      id: z.string(),
      version: z.string(),
      title: z.string(),
      sha256: z.string(),
    })
    .nullable(),
})
export const statusValidator = z.object({
  job: jobValidator.nullable(),
  history: z.array(jobValidator),
})

export async function packageRequest(
  effects: T.Effects,
  input: Record<string, unknown>,
) {
  return sdk.SubContainer.withTemp(
    effects,
    { imageId: 'workspace' },
    sdk.Mounts.of().mountVolume({
      volumeId: 'main',
      subpath: './package-runtime',
      mountpoint: '/run/dev-workspace-packages',
      readonly: false,
    }),
    'package-client',
    async (client) => {
      const result = await client.exec(
        ['/usr/local/bin/workspace-packages', 'client'],
        { user: 'root', input: JSON.stringify(input) + '\n', timeout: 135000 },
      )
      if (result.exitCode !== 0)
        throw new Error(
          i18n(
            'The package manager is unavailable. Start Dev Workspace and check its logs.',
          ),
        )
      const response = JSON.parse(String(result.stdout)) as {
        ok: boolean
        value?: unknown
        error?: string
      }
      if (!response.ok)
        throw new Error(
          i18n('Package operation failed: ${message}', {
            message: response.error || 'Unavailable',
          }),
        )
      return response.value
    },
  )
}

export function packageLabel(item: z.infer<typeof packageValidator>) {
  return `${item.title} ${item.version} | ${item.architectures.join(', ')} | ${(item.size / 1024 ** 2).toFixed(1)} MiB | ${item.path}`
}

import { FileHelper, z } from '@start9labs/start-sdk'
import { sdk } from '../sdk'

export const previewPortStart = 18080
export const previewCapacity = 8
export const previewStateDirectory = '/var/lib/dev-workspace/previews'

export const previewSchema = z.looseObject({
  id: z.uuid(),
  name: z.string().min(1).max(60),
  applicationPort: z.number().int().min(1024).max(65535),
  proxyPort: z
    .number()
    .int()
    .min(previewPortStart)
    .max(previewPortStart + previewCapacity - 1),
  createdAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
})

export const previewEnvelopeSchema = z.looseObject({
  version: z.literal(1),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  auth: z
    .looseObject({
      generation: z.uuid(),
      salt: z.string().regex(/^[a-f0-9]{32}$/),
      hash: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .nullable(),
  leases: z.array(z.unknown()).max(previewCapacity),
  retired: z.array(z.uuid()).max(128 + previewCapacity),
  quarantined: z.array(z.unknown()).max(32).default([]),
})

export const previewConfigSchema = previewEnvelopeSchema.extend({
  leases: z.array(previewSchema).max(previewCapacity),
})

export type WebPreview = z.infer<typeof previewSchema>
export type PreviewConfig = z.infer<typeof previewConfigSchema>

export const previewConfigFile = FileHelper.json(
  { base: sdk.volumes.main, subpath: './previews/config.json' },
  previewEnvelopeSchema,
)

export const previewFiles = {
  config: previewConfigFile,
  source: FileHelper.string(previewConfigFile.path),
}

export type PreviewFiles = typeof previewFiles

export const previewRuntimeSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  observedAt: z.number().int().nonnegative(),
  error: z.string().nullable(),
  invalidRecords: z.number().int().nonnegative().default(0),
  leases: z.array(
    z.object({
      id: z.uuid(),
      proxyPort: z.number().int(),
      expiresAt: z.number().int(),
      state: z.enum(['closed', 'waiting', 'listening', 'listener-unavailable']),
    }),
  ),
})

export const previewRuntimeFile = FileHelper.json(
  { base: sdk.volumes.main, subpath: './previews/runtime.json' },
  previewRuntimeSchema,
)

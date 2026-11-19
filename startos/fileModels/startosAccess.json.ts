import { FileHelper, z } from '@start9labs/start-sdk'
import { sdk } from '../sdk'

export const startosAccessSchema = z.object({
  version: z.literal(1),
  restoreGeneration: z.uuid().nullable(),
})

export const startosAccessFile = FileHelper.json(
  { base: sdk.volumes.main, subpath: './startos-access.json' },
  startosAccessSchema,
)

export const startosAccessSource = FileHelper.string(startosAccessFile.path)

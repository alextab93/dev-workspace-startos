import { FileHelper, z } from '@start9labs/start-sdk'
import { sdk } from '../sdk'

export const keySchema = z.looseObject({
  label: z.string().min(1).max(80),
  publicKey: z.string().min(1),
  fingerprint: z.string().min(1),
  type: z.string().min(1),
})

export const storeSchema = z.looseObject({
  keys: z.array(keySchema),
  generation: z.uuid(),
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
})

export type SshKey = z.infer<typeof keySchema>
export type KeyStore = z.infer<typeof storeSchema>

export const storeJson = FileHelper.json(
  { base: sdk.volumes.main, subpath: './store.json' },
  storeSchema,
)

export const authorizedKeys = FileHelper.string({
  base: sdk.volumes.main,
  subpath: './ssh/authorized_keys',
})

export const appliedKeys = FileHelper.json(
  { base: sdk.volumes.main, subpath: './ssh/applied.json' },
  z.object({
    generation: z.uuid(),
    revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  }),
)

export const keyFiles = {
  store: storeJson,
  source: FileHelper.string(storeJson.path),
  authorized: authorizedKeys,
  applied: appliedKeys,
}

export type KeyFiles = typeof keyFiles

export const hostPublicKey = FileHelper.string({
  base: sdk.volumes.main,
  subpath: './ssh/ssh_host_ed25519_key.pub',
})

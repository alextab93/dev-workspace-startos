import { FileHelper, z } from '@start9labs/start-sdk'
import { sdk } from '../sdk'

export const defaultDockerConfig = {
  enabled: false,
  cleanupAgeHours: 168,
}

export const dockerConfigValidator = z.looseObject({
  enabled: z.boolean().default(defaultDockerConfig.enabled),
  cleanupAgeHours: z.number().int().min(24).max(8760).default(168),
})

export type DockerConfig = z.infer<typeof dockerConfigValidator>

export const dockerConfigFile = FileHelper.json(
  { base: sdk.volumes.main, subpath: './docker.json' },
  dockerConfigValidator,
)

export const DockerConfigFile = dockerConfigFile

export const dockerConfigFiles = {
  store: dockerConfigFile,
  source: FileHelper.string(dockerConfigFile.path),
}

export type DockerConfigFiles = typeof dockerConfigFiles

import { z, type T } from '@start9labs/start-sdk'
import { sdk } from './sdk'
import { i18n } from './i18n'
import {
  defaultDockerConfig,
  dockerConfigFiles,
  dockerConfigValidator,
  type DockerConfigFiles,
} from './fileModels/docker.json'

export {
  defaultDockerConfig,
  dockerConfigFiles,
  dockerConfigValidator,
} from './fileModels/docker.json'
export type { DockerConfigFiles } from './fileModels/docker.json'

export function parseDockerConfig(raw: string | null) {
  try {
    return dockerConfigValidator.parse(
      raw === null ? defaultDockerConfig : JSON.parse(raw),
    )
  } catch {
    throw new Error(
      i18n(
        'Podman settings are invalid. Stop Dev Workspace and use Configure Containers.',
      ),
    )
  }
}

export async function readDockerConfig(
  effects?: T.Effects,
  files: DockerConfigFiles = dockerConfigFiles,
) {
  const reader = files.source.read()
  return parseDockerConfig(
    effects ? await reader.const(effects) : await reader.once(),
  )
}

export async function configureDockerSettings(
  effects: T.Effects,
  input: unknown,
  files: DockerConfigFiles = dockerConfigFiles,
) {
  const status = await sdk.getStatus(effects).once()
  if (status?.desired.main !== 'stopped' || status.started)
    throw new Error(
      i18n('Stop Dev Workspace before changing container settings.'),
    )
  const config = dockerConfigValidator.parse(input)
  const value = { ...(await readDockerConfig(undefined, files)), ...config }
  const latest = await sdk.getStatus(effects).once()
  if (latest?.desired.main !== 'stopped' || latest.started)
    throw new Error(
      i18n('Stop Dev Workspace before changing container settings.'),
    )
  await files.store.write(effects, value)
  return value
}

export const storageValidator = z.object({
  version: z.string().max(128),
  rootless: z.literal(true),
  driver: z.string().max(128),
  usage: z.string().max(65536),
})
export const cleanupValidator = z.object({
  olderThanHours: z.number().int().min(24).max(8760),
  output: z.string().max(65536),
})

function podmanRuntimeMount() {
  return sdk.Mounts.of().mountVolume({
    volumeId: 'main',
    subpath: './podman-runtime',
    mountpoint: '/run/dev-workspace-podman',
    readonly: false,
  })
}

export function composeMounts() {
  return podmanRuntimeMount().mountVolume({
    volumeId: 'home',
    subpath: './projects',
    mountpoint: '/home/dev/projects',
    readonly: false,
  })
}

export async function runContainerTool(
  effects: T.Effects,
  args: string[],
  compose = false,
) {
  const config = await readDockerConfig()
  if (!config.enabled)
    throw new Error(
      i18n(
        'Enable containers and start Dev Workspace before using this action.',
      ),
    )
  return sdk.SubContainer.withTemp(
    effects,
    { imageId: 'workspace' },
    compose
      ? composeMounts()
      : podmanRuntimeMount()
          .mountVolume({
            volumeId: 'docker',
            subpath: null,
            mountpoint: '/var/lib/containers',
            readonly: true,
          })
          .mountVolume({
            volumeId: 'main',
            subpath: './nextcloud-cache',
            mountpoint: '/var/lib/dev-workspace/nextcloud-cache',
            readonly: true,
          }),
    'podman-client',
    async (client) => {
      const result = await client.exec(
        [
          compose
            ? '/usr/local/bin/workspace-compose'
            : '/usr/local/bin/workspace-podman',
          ...args,
        ],
        {
          user: !compose && args[0] === 'status' ? 'root' : 'dev',
          timeout: 630000,
        },
      )
      if (result.exitCode !== 0)
        throw new Error(
          i18n(
            'The Podman operation failed. Check the service logs and engine status.',
          ),
        )
      return String(result.stdout).trim()
    },
  )
}

export async function runDockerClient(effects: T.Effects, args: string[]) {
  return JSON.parse(await runContainerTool(effects, args))
}

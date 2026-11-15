import type { T } from '@start9labs/start-sdk'
import { sdk } from './sdk'

export const dockerSocket = 'unix:///run/dev-workspace-podman/podman.sock'

export function createDockerEngine(effects: T.Effects) {
  return sdk.SubContainer.of(
    effects,
    { imageId: 'workspace' },
    sdk.Mounts.of()
      .mountVolume({
        volumeId: 'docker',
        subpath: null,
        mountpoint: '/var/lib/containers',
        readonly: false,
      })
      .mountVolume({
        volumeId: 'main',
        subpath: './podman-runtime',
        mountpoint: '/run/dev-workspace-podman',
        readonly: false,
      })
      .mountVolume({
        volumeId: 'home',
        subpath: './projects',
        mountpoint: '/home/dev/projects',
        readonly: false,
      }),
    'workspace-podman',
  )
}

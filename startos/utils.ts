import { sdk } from './sdk'

export const sshPort = 2222
export const sshHostId = 'ssh'
export const sshUsername = 'dev'
export const projectDirectory = '/home/dev/projects'

export const workspaceMounts = (dockerEnabled = false) => {
  const mounts = sdk.Mounts.of()
    .mountVolume({
      volumeId: 'home',
      subpath: null,
      mountpoint: '/home/dev',
      readonly: false,
    })
    .mountVolume({
      volumeId: 'main',
      subpath: './ssh',
      mountpoint: '/var/lib/dev-workspace/ssh',
      readonly: false,
    })
    .mountVolume({
      volumeId: 'main',
      subpath: './packages',
      mountpoint: '/var/lib/dev-workspace/packages',
      readonly: false,
    })
    .mountVolume({
      volumeId: 'main',
      subpath: './package-runtime',
      mountpoint: '/run/dev-workspace-packages',
      readonly: false,
    })
  return dockerEnabled
    ? mounts.mountVolume({
        volumeId: 'main',
        subpath: './podman-runtime',
        mountpoint: '/run/dev-workspace-podman',
        readonly: false,
      })
    : mounts
}

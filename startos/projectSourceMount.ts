import { ExtendedVersion, VersionRange, type T } from '@start9labs/start-sdk'
import { sdk } from './sdk'
import { workspaceMounts } from './utils'
import { i18n } from './i18n'
import { resolveNextcloudTransport } from './nextcloudConnection'
import {
  FILEBROWSER_VERSION_RANGE,
  NEXTCLOUD_VERSION_RANGE,
  sharedProjectDirectory,
  type ProjectSource,
} from './projectSource'

type FileBrowserManifest = Omit<T.SDKManifest, 'id' | 'volumes'> & {
  id: 'filebrowser'
  volumes: ['data']
}

type SharedSource = Extract<ProjectSource, { provider: 'filebrowser' }>
type NextcloudSource = Extract<ProjectSource, { provider: 'nextcloud' }>

export const nextcloudConfigPath = '/run/dev-workspace-nextcloud/config.json'
export const nextcloudCacheDirectory = '/var/lib/dev-workspace/nextcloud-cache'

function nextcloudMounts() {
  return sdk.Mounts.of().mountVolume({
    volumeId: 'main',
    subpath: './nextcloud-cache',
    mountpoint: nextcloudCacheDirectory,
    readonly: false,
  })
}

async function configureNextcloud(
  effects: T.Effects,
  container: Awaited<ReturnType<typeof sdk.SubContainer.eager>>,
  source: NextcloudSource,
  reactive = false,
) {
  let url = source.url
  if (source.discovery === 'startos') {
    const baseUrl = await resolveNextcloudTransport(
      effects,
      new URL(source.url).origin,
      reactive,
    )
    if (!source.accountId)
      throw new Error(
        i18n('Nextcloud is unavailable. Start Nextcloud and try again.'),
      )
    url = `${baseUrl}/remote.php/dav/files/${encodeURIComponent(source.accountId)}/`
  }
  await container.execFail(
    ['install', '-d', '-m', '0700', '/run/dev-workspace-nextcloud'],
    { user: 'root' },
  )
  await container.writeFile(
    nextcloudConfigPath,
    JSON.stringify({ ...source, url, rootCa: await sdk.getRootCa(effects) }),
    { mode: 0o600 },
  )
}

async function validateNextcloudProvider(effects: T.Effects) {
  const manifest = await sdk.getServiceManifest(effects, 'nextcloud').once()
  if (
    !manifest ||
    !VersionRange.parse(NEXTCLOUD_VERSION_RANGE).satisfiedByRelease(
      [manifest.version, ...manifest.satisfies].map((version) =>
        ExtendedVersion.parse(version),
      ),
    )
  ) {
    throw new Error(
      i18n('Install a compatible Nextcloud package before selecting it.'),
    )
  }
}

export async function assertProjectSourceChangeAllowed(
  effects: T.Effects,
  source: ProjectSource,
) {
  await sdk.SubContainer.withTemp(
    effects,
    { imageId: 'workspace' },
    nextcloudMounts(),
    'nextcloud-pending-check',
    async (probe) => {
      const command = ['/usr/local/bin/nextcloud-workspace', 'pending']
      if (source.provider === 'nextcloud') {
        await configureNextcloud(effects, probe, source)
        command.push('--config', nextcloudConfigPath)
      }
      try {
        await probe.execFail(command, { user: 'root', timeout: 30000 })
      } catch {
        throw new Error(
          i18n(
            'Nextcloud has pending uploads or unreadable upload state. Restore the previous Nextcloud URL, account, and folder, start the workspace, and wait for uploads before changing its source.',
          ),
        )
      }
    },
  )
}

const inspectDirectory = [
  'import json, os, stat, sys',
  'path = sys.argv[1]',
  'info = os.stat(path)',
  'if not stat.S_ISDIR(info.st_mode):',
  '    raise NotADirectoryError(path)',
  'access = os.R_OK | os.X_OK',
  'if sys.argv[2] == "write":',
  '    access |= os.W_OK',
  'if not os.access(path, access):',
  '    raise PermissionError("The dev account cannot access the selected project folder with the required permissions")',
  'print(json.dumps({"device": str(info.st_dev), "inode": str(info.st_ino)}))',
].join('\n')

function sharedMounts(source: SharedSource, readonly: boolean) {
  return sdk.Mounts.of().mountDependency<FileBrowserManifest>({
    dependencyId: 'filebrowser',
    volumeId: 'data',
    subpath: source.subpath,
    mountpoint: sharedProjectDirectory,
    readonly,
  })
}

async function inspect(
  subcontainer: Awaited<ReturnType<typeof sdk.SubContainer.eager>>,
  writable: boolean,
) {
  const result = await subcontainer.execFail(
    [
      'python3',
      '-c',
      inspectDirectory,
      sharedProjectDirectory,
      writable ? 'write' : 'read',
    ],
    { user: 'dev' },
  )
  return JSON.parse(String(result.stdout)) as { device: string; inode: string }
}

async function validateProvider(effects: T.Effects) {
  const manifest = await sdk.getServiceManifest(effects, 'filebrowser').once()
  if (
    !manifest ||
    !manifest.volumes.includes('data') ||
    !VersionRange.parse(FILEBROWSER_VERSION_RANGE).satisfiedByRelease(
      [manifest.version, ...manifest.satisfies].map((version) =>
        ExtendedVersion.parse(version),
      ),
    )
  ) {
    throw new Error(
      i18n(
        'Install a compatible FileBrowser Quantum package before selecting a shared folder.',
      ),
    )
  }
}

async function withSourcePreflight<Result>(
  effects: T.Effects,
  source: SharedSource,
  fn: (identity: { device: string; inode: string }) => Promise<Result>,
) {
  await validateProvider(effects)
  return sdk.SubContainer.withTemp(
    effects,
    { imageId: 'workspace' },
    sharedMounts(source, true),
    'project-source-check',
    async (probe) => fn(await inspect(probe, false)),
  )
}

export async function checkProjectSource(
  effects: T.Effects,
  source: SharedSource | NextcloudSource,
) {
  if (source.provider === 'nextcloud') {
    await validateNextcloudProvider(effects)
    return sdk.SubContainer.withTemp(
      effects,
      { imageId: 'workspace' },
      sdk.Mounts.of(),
      'nextcloud-source-check',
      async (probe) => {
        await configureNextcloud(effects, probe, source)
        await probe.execFail(
          [
            '/usr/local/bin/nextcloud-workspace',
            'check',
            '--config',
            nextcloudConfigPath,
          ],
          { user: 'root', timeout: 45000 },
        )
      },
    )
  }
  await withSourcePreflight(effects, source, async () => {})
}

export async function createWorkspace(
  effects: T.Effects,
  source: ProjectSource,
  dockerEnabled = false,
) {
  if (source.provider === 'nextcloud') {
    await validateNextcloudProvider(effects)
    const workspace = await sdk.SubContainer.eager(
      effects,
      { imageId: 'workspace' },
      workspaceMounts(dockerEnabled).mountVolume({
        volumeId: 'main',
        subpath: './nextcloud-cache',
        mountpoint: nextcloudCacheDirectory,
        readonly: false,
      }),
      'workspace',
    )
    try {
      await configureNextcloud(effects, workspace, source, true)
      return workspace
    } catch (error) {
      await workspace.destroy()
      throw error
    }
  }
  if (source.provider === 'none') {
    return sdk.SubContainer.of(
      effects,
      { imageId: 'workspace' },
      workspaceMounts(dockerEnabled),
      'workspace',
    )
  }
  return withSourcePreflight(effects, source, async (expected) => {
    const workspace = await sdk.SubContainer.eager(
      effects,
      { imageId: 'workspace' },
      workspaceMounts(dockerEnabled).mountDependency<FileBrowserManifest>({
        dependencyId: 'filebrowser',
        volumeId: 'data',
        subpath: source.subpath,
        mountpoint: sharedProjectDirectory,
        readonly: false,
      }),
      'workspace',
    )
    try {
      const actual = await inspect(workspace, true)
      if (
        actual.device !== expected.device ||
        actual.inode !== expected.inode
      ) {
        throw new Error(
          i18n(
            'The shared folder changed during startup. Stop the service and select it again.',
          ),
        )
      }
      return workspace
    } catch (error) {
      await workspace.destroy()
      throw error
    }
  })
}

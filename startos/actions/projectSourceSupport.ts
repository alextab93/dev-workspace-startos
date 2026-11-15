import type { T } from '@start9labs/start-sdk'
import { sdk } from '../sdk'
import { i18n } from '../i18n'
import {
  saveProjectSource,
  sharedProjectDirectory,
  type ProjectSource,
} from '../projectSource'
import {
  assertProjectSourceChangeAllowed,
  checkProjectSource,
} from '../projectSourceMount'

export async function assertWorkspaceStopped(effects: T.Effects) {
  const status = await sdk.getStatus(effects).once()
  if (status?.desired.main !== 'stopped' || status.started) {
    throw new Error(
      i18n(
        'Stop Dev Workspace and wait for it to finish stopping before changing the project source.',
      ),
    )
  }
}

export async function applyProjectSource(
  effects: T.Effects,
  source: ProjectSource,
) {
  await assertWorkspaceStopped(effects)
  await assertProjectSourceChangeAllowed(effects, source)
  if (source.provider !== 'none') {
    try {
      await checkProjectSource(effects, source)
    } catch {
      throw new Error(
        source.provider === 'nextcloud'
          ? i18n(
              'The Nextcloud folder is unavailable or unreadable. Check Nextcloud and choose an accessible folder again.',
            )
          : i18n(
              'The shared project folder is unavailable or unreadable. Create it in FileBrowser Quantum and check its permissions before selecting it.',
            ),
      )
    }
  }
  await assertWorkspaceStopped(effects)
  await saveProjectSource(effects, source)
  return {
    version: '1' as const,
    title: i18n('Project Source Saved'),
    message:
      source.provider === 'nextcloud'
        ? i18n(
            'Start Dev Workspace to open the selected Nextcloud folder. Edits upload to the original files through a persistent cache. Local projects remain available. Wait for uploads to finish before changing the source.',
          )
        : source.provider === 'filebrowser'
          ? i18n(
              'Start Dev Workspace to validate write access and open the shared folder. Local projects remain available. No project files were copied or moved.',
            )
          : i18n(
              'The shared source is disabled. Local projects remain available and shared files are preserved.',
            ),
    result:
      source.provider === 'none'
        ? null
        : {
            type: 'single' as const,
            value: sharedProjectDirectory,
            masked: false,
            copyable: true,
            qr: false,
            launchable: false,
          },
  }
}

import { sdk } from './sdk'
import { i18n } from './i18n'
import {
  FILEBROWSER_VERSION_RANGE,
  NEXTCLOUD_VERSION_RANGE,
  readProjectSource,
} from './projectSource'

export const dependencies = sdk.Dependencies.of()
  .addDependency(
    sdk.Dependency.optional('filebrowser', {
      description: i18n(
        'Optional shared project files from FileBrowser Quantum.',
      ),
      metadata: {
        title: 'FileBrowser Quantum',
        icon: 'assets/dependency-icons/filebrowser.svg',
      },
      kind: 'exists',
      versionRange: FILEBROWSER_VERSION_RANGE,
      enabled: async ({ effects }) => {
        try {
          return (await readProjectSource(effects)).provider === 'filebrowser'
        } catch {
          return false
        }
      },
    }),
  )
  .addDependency(
    sdk.Dependency.optional('nextcloud', {
      description: i18n(
        'Optional project files accessed through Nextcloud WebDAV.',
      ),
      metadata: {
        title: 'Nextcloud',
        icon: 'assets/dependency-icons/nextcloud.svg',
      },
      kind: 'running',
      healthChecks: [],
      versionRange: NEXTCLOUD_VERSION_RANGE,
      enabled: async ({ effects }) => {
        try {
          return (await readProjectSource(effects)).provider === 'nextcloud'
        } catch {
          return false
        }
      },
    }),
  )

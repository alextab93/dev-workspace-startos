import { i18n } from './i18n'
import type { types } from '@start9labs/start-sdk'
import {
  projectSourceFiles,
  normalizeNextcloudUrl,
  sourceSchema,
  type ProjectSource,
  type ProjectSourceFiles,
} from './fileModels/projectSource.json'

export {
  normalizeNextcloudUrl,
  normalizeProjectSubpath,
  projectSourceFile,
  projectSourceFiles,
  sourceSchema,
} from './fileModels/projectSource.json'
export type {
  ProjectSource,
  ProjectSourceFiles,
} from './fileModels/projectSource.json'

export const sharedProjectDirectory = '/projects-shared'
export const FILEBROWSER_VERSION_RANGE = '>=#quantum:2.0.2-stable:2'
export const NEXTCLOUD_VERSION_RANGE = '>=35.0.2:3'

export type ProjectSourceInput =
  | { selection: 'none'; value: Record<string, never> }
  | { selection: 'filebrowser'; value: { subpath: string } }
  | { selection: 'nextcloud'; value: Record<string, never> }

export type NextcloudAccount = {
  id: string
  url: string
  username: string
  appPassword: string
  accountId: string
}

export function getProjectSourceInput(
  source: ProjectSource,
): ProjectSourceInput {
  if (source.provider === 'none') return { selection: 'none', value: {} }
  if (source.provider === 'filebrowser') {
    return { selection: 'filebrowser', value: { subpath: source.subpath } }
  }
  return { selection: 'nextcloud', value: {} }
}

export function buildProjectSource(
  input: ProjectSourceInput,
  _current: ProjectSource | null,
): ProjectSource {
  if (input.selection === 'none') return { provider: 'none' }
  if (input.selection === 'filebrowser') {
    return sourceSchema.parse({
      provider: 'filebrowser',
      subpath: input.value.subpath,
    })
  }
  throw new Error(
    i18n('Connect your Nextcloud account, then choose a project folder.'),
  )
}

export function buildNextcloudProjectSource(
  account: NextcloudAccount,
  subpath: string,
  current: ProjectSource | null,
  trustedLocalOrigins: string[] = [],
): ProjectSource {
  const url = normalizeNextcloudUrl(account.url)
  let prior =
    current?.provider === 'nextcloud' &&
    current.discovery === 'startos' &&
    current.accountId === account.accountId &&
    new URL(current.url).origin === new URL(url).origin
      ? current.cacheIdentity
      : undefined
  if (
    !prior &&
    current?.provider === 'nextcloud' &&
    current.discovery === undefined
  ) {
    const existing = new URL(current.url)
    const accountPath = existing.pathname.match(
      /^\/remote\.php\/dav\/files\/([^/]+)\/$/u,
    )
    if (
      trustedLocalOrigins.includes(existing.origin) &&
      accountPath &&
      decodeURIComponent(accountPath[1]) === account.accountId
    ) {
      prior = {
        url: current.url,
        username: current.username,
        subpath,
      }
    }
  }
  const result = sourceSchema.safeParse({
    provider: 'nextcloud',
    url,
    username: account.username,
    appPassword: account.appPassword,
    subpath,
    discovery: 'startos',
    accountId: account.accountId,
    connectionId: account.id,
    cacheIdentity: {
      url: prior?.url ?? url,
      username: prior?.username ?? account.username,
      subpath,
    },
  })
  if (!result.success) {
    throw new Error(
      i18n(
        'The saved Nextcloud account connection is invalid. Connect your account again.',
      ),
    )
  }
  return result.data
}

export function parseProjectSource(raw: string | null): ProjectSource {
  if (raw === null) return { provider: 'none' }
  try {
    return sourceSchema.parse(JSON.parse(raw))
  } catch {
    throw new Error(
      i18n(
        'Project source settings are invalid. Stop Dev Workspace and use Configure Project Source to disable or replace the selection. Project files have not been changed.',
      ),
    )
  }
}

export async function readProjectSource(
  effects?: types.Effects,
  files: ProjectSourceFiles = projectSourceFiles,
): Promise<ProjectSource> {
  const reader = files.source.read((value) => value.raw)
  return parseProjectSource(
    effects ? await reader.const(effects) : await reader.once(),
  )
}

export async function saveProjectSource(
  effects: types.Effects,
  source: ProjectSource,
  files: ProjectSourceFiles = projectSourceFiles,
): Promise<ProjectSource> {
  const validated = sourceSchema.parse(source)
  await files.store.write(effects, validated)
  return validated
}

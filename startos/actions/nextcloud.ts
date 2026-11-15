import type { T } from '@start9labs/start-sdk'
import { sdk } from '../sdk'
import { i18n } from '../i18n'
import {
  NextcloudConnectionError,
  readNextcloudConnection,
  resolveNextcloud,
  runNextcloudConnection,
} from '../nextcloudConnection'
import {
  buildNextcloudProjectSource,
  readProjectSource,
} from '../projectSource'
import { folderChoices, parseFolderChoice } from '../nextcloudFolders'
import {
  applyProjectSource,
  assertWorkspaceStopped,
} from './projectSourceSupport'

const folderTaskId = 'dev-workspace:choose-nextcloud-folder'

export async function startNextcloudConnection(
  effects: T.Effects,
  reuse = false,
) {
  await assertWorkspaceStopped(effects)
  if (reuse) {
    const saved = await runNextcloudConnection(effects, 'status')
    if (saved.state === 'connected' && saved.connection) {
      await sdk.action.clearTask(effects, folderTaskId)
      await sdk.action.createOwnTask(
        effects,
        chooseNextcloudFolder,
        'optional',
        {
          reason: i18n(
            'Choose a project folder from your connected Nextcloud account.',
          ),
        },
      )
      return {
        version: '1' as const,
        title: i18n('Nextcloud Account Connected'),
        message: i18n(
          'Open Choose Nextcloud Project Folder to select a folder. Use Connect Nextcloud Account if you want to authorize a different account.',
        ),
        result: {
          type: 'single' as const,
          value: `${saved.connection.displayName} (${saved.connection.accountId})`,
          masked: false,
          copyable: false,
          qr: false,
          launchable: false,
        },
      }
    }
  }
  const result = await runNextcloudConnection(effects, 'begin')
  if (!result.pending)
    throw new Error(
      i18n(
        'Nextcloud account connection could not be completed. Check Nextcloud and try again.',
      ),
    )
  await sdk.action.clearTask(effects, folderTaskId)
  await sdk.action.createOwnTask(effects, chooseNextcloudFolder, 'optional', {
    reason: i18n(
      'Approve access in Nextcloud, then choose your project folder.',
    ),
  })
  return {
    version: '1' as const,
    title: i18n('Connect Your Nextcloud Account'),
    message: i18n(
      'Open the link and approve Dev Workspace in Nextcloud. Then return to StartOS and open Choose Nextcloud Project Folder. Your current project source stays active until you save a folder.',
    ),
    result: {
      type: 'single' as const,
      value: result.pending.authorizationUrl,
      masked: false,
      copyable: false,
      qr: false,
      launchable: true,
    },
  }
}

export const connectNextcloud = sdk.Action.withoutInput(
  'connect-nextcloud-account',
  async () => ({
    name: i18n('Connect Nextcloud Account'),
    description: i18n(
      'Authorize an account in your installed Nextcloud using its browser sign-in.',
    ),
    warning: null,
    allowedStatuses: 'only-stopped',
    group: null,
    visibility: 'enabled',
    access: 'user',
  }),
  async ({ effects }) => startNextcloudConnection(effects),
)

export const cancelNextcloudSetup = sdk.Action.withoutInput(
  'cancel-nextcloud-setup',
  async () => ({
    name: i18n('Cancel Nextcloud Setup'),
    description: i18n(
      'Stop an unfinished account connection while preserving the selected project source.',
    ),
    warning: null,
    allowedStatuses: 'only-stopped',
    group: null,
    visibility: 'enabled',
    access: 'user',
  }),
  async ({ effects }) => {
    await assertWorkspaceStopped(effects)
    const result = await runNextcloudConnection(effects, 'cancel')
    await sdk.action.clearTask(effects, folderTaskId)
    return {
      version: '1' as const,
      title: i18n('Nextcloud Setup'),
      message: result.pending
        ? i18n(
            'Close the Nextcloud authorization page. Its unfinished request expires after 20 minutes. Your selected project source is unchanged.',
          )
        : i18n(
            'Unfinished setup has been cleared. Your selected project source and connected account are preserved. Manage completed account grants in Nextcloud Security settings.',
          ),
      result: null,
    }
  },
)

export const chooseNextcloudFolder = sdk.Action.withInput(
  'choose-nextcloud-folder',
  async () => ({
    name: i18n('Choose Nextcloud Project Folder'),
    description: i18n(
      'Choose an existing folder after approving access to your Nextcloud account.',
    ),
    warning: i18n(
      'Every SSH key can edit the selected folder. Back up shared files in their source service. Stop the workspace before changing its source.',
    ),
    allowedStatuses: 'only-stopped',
    group: null,
    visibility: 'enabled',
    access: 'user',
  }),
  async ({ effects }) => {
    await assertWorkspaceStopped(effects)
    let listing
    try {
      listing = await runNextcloudConnection(effects, 'browse')
    } catch (error) {
      if (
        !(error instanceof NextcloudConnectionError) ||
        !['folder-missing', 'invalid-folder', 'authentication-failed'].includes(
          error.code,
        )
      )
        throw error
      listing = await runNextcloudConnection(effects, 'browse', '')
    }
    if (
      listing.state !== 'connected' ||
      !listing.connection ||
      listing.path === undefined ||
      listing.parentPath === undefined ||
      listing.canSelect === undefined ||
      !listing.folders
    ) {
      throw new Error(
        i18n(
          'Approve access in Nextcloud first, then reopen Choose Nextcloud Project Folder. If the link expired, use Connect Nextcloud Account again.',
        ),
      )
    }
    const choices = folderChoices({
      ...listing,
      path: listing.path,
      parentPath: listing.parentPath,
      canSelect: listing.canSelect,
      folders: listing.folders,
    })
    if (!choices.length)
      throw new Error(
        i18n(
          'No project folders are available. Create a folder in Nextcloud, then reopen this action.',
        ),
      )
    const values = Object.fromEntries(
      choices.map((choice) => [
        JSON.stringify(choice),
        `${choice.operation === 'select' ? i18n('Use folder') : i18n('Browse folder')}: /${choice.path}`,
      ]),
    )
    return sdk.InputSpec.of({
      folder: sdk.Value.select({
        name: i18n('Project Folder'),
        description: `${listing.connection.displayName} (${listing.connection.accountId})\n/${listing.path}\n${i18n('Choose Use folder to save it. Choose Browse folder to view its children, then reopen this action.')}`,
        default: null,
        values,
      }),
    })
  },
  async () => null,
  async ({ effects, input }) => {
    await assertWorkspaceStopped(effects)
    const choice = parseFolderChoice(input.folder)
    const before = await readNextcloudConnection()
    if (before?.pending || before?.connection?.id !== choice.connectionId)
      throw new Error(
        i18n(
          'The connected account changed. Reopen the folder picker and choose again.',
        ),
      )
    const listing = await runNextcloudConnection(effects, 'browse', choice.path)
    if (listing.connection?.id !== choice.connectionId)
      throw new Error(
        i18n(
          'The connected account changed. Reopen the folder picker and choose again.',
        ),
      )
    if (choice.operation === 'browse') {
      return {
        version: '1' as const,
        title: i18n('Folder Opened'),
        message: i18n(
          'Reopen Choose Nextcloud Project Folder to see this folder and its children.',
        ),
        result: {
          type: 'single' as const,
          value: `/${choice.path}`,
          masked: false,
          copyable: false,
          qr: false,
          launchable: false,
        },
      }
    }
    if (!listing.canSelect)
      throw new Error(
        i18n(
          'This folder does not allow project editing. Choose another folder.',
        ),
      )
    const state = await readNextcloudConnection()
    if (state?.pending || state?.connection?.id !== choice.connectionId)
      throw new Error(
        i18n(
          'The connected account changed. Reopen the folder picker and choose again.',
        ),
      )
    const current = await readProjectSource().catch(() => null)
    const endpoints = await resolveNextcloud(effects)
    const source = buildNextcloudProjectSource(
      state.connection,
      choice.path,
      current,
      endpoints.allowedBaseUrls,
    )
    const result = await applyProjectSource(effects, source)
    await sdk.action.clearTask(effects, folderTaskId)
    return result
  },
)

import { protectProjectSource } from '../projectSource'
import { sdk } from '../sdk'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { workspaceMounts } from '../utils'
import { storeJson } from '../fileModels/store.json'
import { newKeyStore, readKeyStore, synchronizeKeys } from '../keyState'
import { addSshKey } from '../actions/sshKeys'
import { i18n } from '../i18n'
import { previewFiles } from '../fileModels/previews.json'
import { emptyPreviewConfig, revokeRestoredPreviews } from '../previews'

export const preparePreviews = sdk.setupOnInit(async (effects, kind) => {
  const directory = path.dirname(previewFiles.config.path)
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const stat = await fs.lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error('Invalid preview state directory.')
  await fs.chmod(directory, 0o700)
  if ((await previewFiles.source.read().once()) === null) {
    await previewFiles.config.update(
      effects,
      (current) => current ?? emptyPreviewConfig(),
    )
  }
  if (kind === 'restore') await revokeRestoredPreviews(effects)
})

export const prepareWorkspace = sdk.setupOnInit(async (effects) => {
  await protectProjectSource()
  await storeJson.update(effects, (state) => state ?? newKeyStore())
  await sdk.SubContainer.withTemp(
    effects,
    { imageId: 'workspace' },
    workspaceMounts(),
    'workspace-init',
    async (workspace) => {
      await workspace.execFail(['/usr/local/bin/prepare-workspace'], {
        user: 'root',
      })
    },
  )
})

export const syncKeys = sdk.setupOnInit(async (effects) => {
  await synchronizeKeys(effects)
})

export const watchKeys = sdk.setupOnInit(async (effects) => {
  const count = (await readKeyStore(effects)).keys.length
  if (count) {
    await sdk.action.clearTask(effects, 'dev-workspace:add-ssh-key')
  } else {
    await sdk.action.createOwnTask(effects, addSshKey, 'important', {
      reason: i18n('Add an SSH public key to enable development access.'),
    })
  }
})

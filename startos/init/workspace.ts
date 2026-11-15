import { sdk } from '../sdk'
import { workspaceMounts } from '../utils'
import { storeJson } from '../fileModels/store.json'
import { newKeyStore, readKeyStore, synchronizeKeys } from '../keyState'
import { addSshKey } from '../actions/sshKeys'
import { i18n } from '../i18n'

export const prepareWorkspace = sdk.setupOnInit(async (effects) => {
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

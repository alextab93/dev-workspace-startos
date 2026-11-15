import { sdk } from '../sdk'
import { dependencies } from '../dependencies'
import { setInterfaces } from '../interfaces'
import { versionGraph } from '../versions'
import { actions } from '../actions'
import { restoreInit } from '../backups'
import { prepareWorkspace, syncKeys, watchKeys } from './workspace'

export const init = sdk.setupInit(
  restoreInit,
  versionGraph,
  prepareWorkspace,
  setInterfaces,
  actions,
  dependencies,
  syncKeys,
  watchKeys,
)

export const uninit = sdk.setupUninit(versionGraph)

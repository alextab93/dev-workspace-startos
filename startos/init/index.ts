import { sdk } from '../sdk'
import { dependencies } from '../dependencies'
import { setInterfaces } from '../interfaces'
import { versionGraph } from '../versions'
import { actions } from '../actions'
import { restoreInit } from '../backups'
import { prepareStartosIdentity } from '../startosAccess'
import {
  prepareWorkspace,
  preparePreviews,
  syncKeys,
  watchKeys,
} from './workspace'

export const init = sdk.setupInit(
  restoreInit,
  versionGraph,
  prepareStartosIdentity,
  prepareWorkspace,
  preparePreviews,
  setInterfaces,
  actions,
  dependencies,
  syncKeys,
  watchKeys,
)

export const uninit = sdk.setupUninit(versionGraph)

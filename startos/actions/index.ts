import { sdk } from '../sdk'
import {
  connectStartos,
  cancelScan,
  disconnectStartos,
  scanPackages,
  browsePackages,
  installPackage,
  installationStatus,
} from './packages'
import { addSshKey, listSshKeys, removeSshKey } from './sshKeys'
import { connectionInfo } from './connectionInfo'
import { setProjectSource } from './projectSource'
import { configureDocker, dockerStorage, cleanDocker } from './docker'
import {
  connectNextcloud,
  chooseNextcloudFolder,
  cancelNextcloudSetup,
} from './nextcloud'

export const actions = sdk.Actions.of()
  .addAction(addSshKey)
  .addAction(listSshKeys)
  .addAction(removeSshKey)
  .addAction(connectionInfo)
  .addAction(setProjectSource)
  .addAction(connectNextcloud)
  .addAction(chooseNextcloudFolder)
  .addAction(cancelNextcloudSetup)
  .addAction(configureDocker)
  .addAction(dockerStorage)
  .addAction(cleanDocker)

  .addAction(connectStartos)
  .addAction(disconnectStartos)
  .addAction(scanPackages)
  .addAction(cancelScan)
  .addAction(browsePackages)
  .addAction(installPackage)
  .addAction(installationStatus)

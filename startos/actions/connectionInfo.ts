import { utils } from '@start9labs/start-sdk'
import { sdk } from '../sdk'
import { i18n } from '../i18n'
import { hostPublicKey } from '../fileModels/store.json'
import { parsePublicKey } from '../sshKeys'
import { connectionDetails } from '../connectionDetails'
import { projectDirectory, sshHostId, sshPort, sshUsername } from '../utils'
import { readProjectSource, sharedProjectDirectory } from '../projectSource'

export const connectionInfo = sdk.Action.withoutInput(
  'connection-info',
  async () => ({
    name: i18n('Connection Information'),
    description: i18n(
      'Get the address, port, fingerprint, and desktop VS Code instructions.',
    ),
    warning: null,
    allowedStatuses: 'any',
    group: null,
    visibility: 'enabled',
    access: 'user',
  }),
  async ({ effects }) => {
    const host = await sdk.host.getOwn(effects, sshHostId).once()
    const endpoints = host
      ? utils.filledAddress(host, {
          hostId: sshHostId,
          internalPort: sshPort,
          username: sshUsername,
          scheme: 'ssh',
          sslScheme: null,
          suffix: '',
        }).nonLocal.hostnames
      : []
    const publicKey = await hostPublicKey.read().once()
    if (!publicKey)
      throw new Error(
        i18n('SSH host identity is not ready. Check service initialization.'),
      )
    const fingerprint = parsePublicKey(publicKey).fingerprint
    const details = connectionDetails(endpoints, sshUsername)
    const source = await readProjectSource().catch(() => null)
    return {
      version: '1',
      title: i18n('Connection Information'),
      message: endpoints.length
        ? i18n(
            'Verify the host fingerprint, add a matching IdentityFile to your SSH configuration, and connect using Remote-SSH: Connect to Host in desktop VS Code. Open a project directory listed below. Reachability depends on your current network.',
          )
        : i18n(
            'No enabled client address is available. Configure an SSH binding in the service network settings, then run this action again.',
          ),
      result: {
        type: 'group',
        value: [
          {
            type: 'single',
            name: i18n('Host Fingerprint'),
            description: null,
            value: fingerprint,
            masked: false,
            copyable: true,
            qr: false,
            launchable: false,
          },
          {
            type: 'single',
            name: i18n('Projects Directory'),
            description: null,
            value: projectDirectory,
            masked: false,
            copyable: true,
            qr: false,
            launchable: false,
          },
          {
            type: 'single',
            name: i18n('Shared Projects Directory'),
            description: null,
            value:
              source && source.provider !== 'none'
                ? sharedProjectDirectory
                : source
                  ? i18n('No shared project source configured.')
                  : i18n(
                      'Invalid project source settings. Stop the workspace and use Configure Project Source to recover.',
                    ),
            masked: false,
            copyable: true,
            qr: false,
            launchable: false,
          },
          ...(source && source.provider !== 'none'
            ? [
                {
                  type: 'single' as const,
                  name: i18n('Shared Source Folder'),
                  description:
                    source.provider === 'nextcloud'
                      ? i18n(
                          'Edits upload to Nextcloud through a persistent cache. Wait for uploads to finish before changing the source.',
                        )
                      : null,
                  value: `${source.provider === 'nextcloud' ? 'Nextcloud' : 'FileBrowser Quantum'}: ${source.subpath}`,
                  masked: false,
                  copyable: true,
                  qr: false,
                  launchable: false,
                },
              ]
            : []),
          {
            type: 'multiline',
            name: i18n('SSH Commands'),
            description: null,
            value: details.commands,
            masked: false,
            copyable: true,
            qr: false,
            filename: null,
          },
          {
            type: 'multiline',
            name: i18n('SSH Configuration'),
            description: null,
            value: details.configuration,
            masked: false,
            copyable: true,
            qr: false,
            filename: 'dev-workspace.ssh-config',
          },
        ],
      },
    }
  },
)

import { sdk } from './sdk'
import { i18n } from './i18n'
import { sshPort } from './utils'
import { getKeyStatus } from './keyState'
import { readProjectSource } from './projectSource'
import { createWorkspace, nextcloudConfigPath } from './projectSourceMount'
import { sshConnectionHealth } from './sshConnections'
import { composeMounts, readDockerConfig } from './docker'
import { createDockerEngine, dockerSocket } from './dockerEngine'
import { prepareStartosAccess } from './startosAccess'
import { previewStateDirectory } from './fileModels/previews.json'
import { readPreviewRuntime } from './previews'

export const main = sdk.setupMain(async ({ effects }) => {
  const source = await readProjectSource(effects)
  const dockerConfig = await readDockerConfig(effects)
  const workspace = await createWorkspace(effects, source, dockerConfig.enabled)
  const engine = createDockerEngine(effects)
  await prepareStartosAccess(effects, workspace)
  return sdk.Daemons.of(effects)
    .addOneshot('prepare-workspace', {
      subcontainer: workspace,
      exec: { command: ['/usr/local/bin/prepare-workspace'], user: 'root' },
      requires: [],
    })
    .addDaemon('web-previews', {
      subcontainer: sdk.SubContainer.of(
        effects,
        { imageId: 'workspace' },
        sdk.Mounts.of().mountVolume({
          volumeId: 'main',
          subpath: './previews',
          mountpoint: previewStateDirectory,
          readonly: false,
        }),
        'web-previews',
      ),
      exec: {
        command: [
          'node',
          '/usr/local/lib/dev-workspace/workspace-previews.mjs',
          'serve',
        ],
        user: 'root',
        sigtermTimeout: 15000,
      },
      ready: {
        display: i18n('Web Previews'),
        gracePeriod: 15000,
        fn: async () => {
          const state = await readPreviewRuntime()
          if (state?.invalidRecords)
            return {
              result: 'failure' as const,
              message: i18n(
                'Invalid preview records are closed. Use Remove Invalid Web Previews; valid previews remain available.',
              ),
            }
          return state &&
            !state.error &&
            !state.leases.some(
              (lease) => lease.state === 'listener-unavailable',
            )
            ? {
                result: 'success' as const,
                message: i18n(
                  'The preview service is ready. Manage applications in Web Previews actions.',
                ),
              }
            : {
                result: 'failure' as const,
                message: i18n(
                  'Web Previews are unavailable. Check preview configuration and service logs.',
                ),
              }
        },
      },
      requires: ['prepare-workspace'],
    })
    .addOneshot('prepare-podman', () =>
      dockerConfig.enabled
        ? {
            subcontainer: engine,
            exec: {
              command: ['/usr/local/bin/workspace-podman', 'prepare'],
              user: 'root',
            },
            requires: ['prepare-workspace'],
          }
        : null,
    )
    .addDaemon('docker', () =>
      dockerConfig.enabled
        ? {
            subcontainer: engine,
            exec: {
              command: [
                '/usr/bin/catatonit',
                '--',
                '/usr/local/bin/workspace-podman',
                'serve',
                ...(dockerConfig.weeklyCleanup
                  ? [
                      '--weekly',
                      '--older-than-hours',
                      String(dockerConfig.cleanupAgeHours),
                    ]
                  : []),
              ],
              user: 'root',
              runAsInit: true,
              env: { HOME: '/home/dev', XDG_RUNTIME_DIR: '/run/user/1000' },
              sigtermTimeout: 120000,
            },
            ready: {
              display: i18n('Workspace Podman'),
              gracePeriod: 60000,
              fn: async () => {
                try {
                  await engine.execFail(
                    [
                      'podman',
                      '--url',
                      dockerSocket,
                      'info',
                      '--format',
                      '{{.Host.Security.Rootless}}',
                    ],
                    { user: 'dev', timeout: 10000 },
                  )
                  return {
                    result: 'success' as const,
                    message: i18n('Podman is accepting connections.'),
                  }
                } catch {
                  return {
                    result: 'failure' as const,
                    message: i18n(
                      'Podman is unavailable. Check the service logs.',
                    ),
                  }
                }
              },
            },
            requires: ['prepare-podman'],
          }
        : null,
    )
    .addOneshot('start-compose-projects', () =>
      dockerConfig.enabled
        ? {
            subcontainer: sdk.SubContainer.of(
              effects,
              { imageId: 'workspace' },
              composeMounts(),
              'compose-startup',
            ),
            exec: {
              command: ['/usr/local/bin/workspace-compose', 'boot'],
              user: 'dev',
            },
            requires: ['docker'],
          }
        : null,
    )
    .addDaemon('ssh', {
      subcontainer: workspace,
      exec: {
        command: [
          '/usr/bin/catatonit',
          '--',
          ...(source.provider === 'nextcloud'
            ? [
                '/usr/local/bin/nextcloud-workspace',
                'serve',
                ...(dockerConfig.weeklyCleanup
                  ? [
                      '--weekly',
                      '--older-than-hours',
                      String(dockerConfig.cleanupAgeHours),
                    ]
                  : []),
                '--config',
                nextcloudConfigPath,
              ]
            : ['/usr/local/bin/workspace-session']),
        ],
        user: 'root',
        runAsInit: true,
        sigtermTimeout: source.provider === 'nextcloud' ? 120000 : 60000,
      },
      ready: {
        display: i18n('Development SSH'),
        gracePeriod: 30000,
        fn: () =>
          sdk.healthCheck.checkPortListening(effects, sshPort, {
            successMessage: i18n('SSH is accepting connections.'),
            errorMessage: i18n('SSH is not accepting connections.'),
          }),
      },
      requires: ['prepare-workspace'],
    })
    .addHealthCheck('ssh-connections', {
      ready: {
        display: i18n('SSH Connections'),
        trigger: sdk.trigger.cooldownTrigger(10000),
        fn: async () => {
          try {
            const result = await workspace.execFail(
              ['/usr/local/bin/ssh-connections'],
              { user: 'root', timeout: 5000 },
            )
            return sshConnectionHealth(String(result.stdout))
          } catch {
            return sshConnectionHealth()
          }
        },
      },
      requires: ['ssh'],
    })
    .addHealthCheck('nextcloud', () =>
      source.provider === 'nextcloud'
        ? {
            ready: {
              display: i18n('Nextcloud Project Files'),
              gracePeriod: 60000,
              fn: async () => {
                try {
                  const result = await workspace.execFail(
                    ['/usr/local/bin/nextcloud-workspace', 'status'],
                    { user: 'root', timeout: 15000 },
                  )
                  const state = JSON.parse(String(result.stdout)) as {
                    ready: boolean
                    mounted: boolean
                    pendingUploads: number | null
                    uncertain: boolean
                    message: string
                  }
                  if (
                    state.ready !== true ||
                    state.mounted !== true ||
                    state.uncertain !== false ||
                    !Number.isSafeInteger(state.pendingUploads) ||
                    state.pendingUploads === null ||
                    state.pendingUploads < 0
                  ) {
                    throw new Error('Unavailable Nextcloud upload state')
                  }
                  return state.pendingUploads > 0
                    ? {
                        result: 'loading' as const,
                        message: i18n(
                          'Nextcloud is mounted; local edits are awaiting upload.',
                        ),
                      }
                    : {
                        result: 'success' as const,
                        message: i18n(
                          'Nextcloud is mounted and no pending cached uploads were found.',
                        ),
                      }
                } catch {
                  return {
                    result: 'failure' as const,
                    message: i18n(
                      'Nextcloud files are unavailable or uploads need attention. Check the service logs and retain the workspace cache.',
                    ),
                  }
                }
              },
            },
            requires: ['ssh'],
          }
        : null,
    )
    .addHealthCheck('ssh-keys', {
      ready: {
        display: i18n('SSH Access'),
        fn: async () => {
          const status = await getKeyStatus()
          if (!status.synchronized) {
            return {
              result: 'failure',
              message: i18n(
                'SSH access is not synchronized. Check service initialization before relying on key changes.',
              ),
            }
          }
          if (!status.keys) {
            return {
              result: 'loading',
              message: i18n(
                'No keys are authorized. Use Add SSH Key to enable access.',
              ),
            }
          }
          return {
            result: 'success',
            message: i18n('Registered SSH keys are synchronized.'),
          }
        },
      },
      requires: ['ssh'],
    })
})

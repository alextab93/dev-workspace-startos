import { sdk } from '../sdk'
import { i18n } from '../i18n'

function rows(
  record: unknown,
  name: string,
): {
  type: 'single'
  name: string
  description: null
  value: string
  masked: false
  copyable: boolean
  qr: false
  launchable: boolean
}[] {
  if (record && typeof record === 'object' && Object.keys(record).length)
    return Object.entries(record).flatMap(([key, value]) =>
      rows(value, name + ' / ' + key),
    )
  const value = record == null ? i18n('Unverified') : String(record)
  let launchable = false
  if (typeof record === 'string' && record.startsWith('https://')) {
    try {
      const url = new URL(record)
      launchable = !!url.hostname && !url.username && !url.password
    } catch {}
  }
  return [
    {
      type: 'single',
      name,
      description: null,
      value,
      masked: false,
      copyable: record != null,
      qr: false,
      launchable,
    },
  ]
}

export const releaseStatus = sdk.Action.withInput(
  'project-release-status',
  async () => ({
    name: i18n('Project Release Status'),
    description: i18n('Read the last release report saved by a local project.'),
    group: i18n('Releases'),
    warning: null,
    allowedStatuses: 'any',
    visibility: 'enabled',
    access: 'user',
  }),
  sdk.InputSpec.of({
    project: sdk.Value.text({
      name: i18n('Directory relative to /home/dev/projects'),
      required: true,
      default: null,
    }),
  }),
  async () => ({}),
  async ({ effects, input }) => {
    const report = await sdk.SubContainer.withTemp(
      effects,
      { imageId: 'workspace' },
      sdk.Mounts.of().mountVolume({
        volumeId: 'home',
        subpath: './projects',
        mountpoint: '/home/dev/projects',
        readonly: true,
      }),
      'release-status',
      async (client) => {
        const result = await client.exec(
          [
            '/usr/local/bin/workspace-release-status',
            'show',
            '--',
            input.project,
          ],
          { user: 'dev', timeout: 15000 },
        )
        if (result.exitCode !== 0)
          throw new Error(
            i18n(
              'Check the project directory and save a release report in its terminal.',
            ),
          )
        return JSON.parse(String(result.stdout))
      },
    )
    return {
      version: '1',
      title: i18n('Project Release Status'),
      message: i18n('Last observation: ${at}', { at: report.checkedAt }),
      result: {
        type: 'group',
        value: [
          ...rows(report.validated, i18n('Validation')),
          ...rows(report.published, i18n('Publication')),
          ...rows(report.deployed, i18n('Deployment')),
        ],
      },
    }
  },
)

import { z, type T } from '@start9labs/start-sdk'
import { sdk } from './sdk'
import { i18n } from './i18n'

const packageValidator = z.object({
  token: z.string().regex(/^[a-f0-9]{32}$/),
  path: z.string(),
  id: z.string(),
  title: z.string(),
  version: z.string(),
  size: z.number().int().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  architectures: z.array(z.string()),
  compatible: z.boolean(),
  installedVersion: z.string().nullable(),
})
const scanCount = z.number().int().nonnegative()
const scanSeconds = z.number().finite().nonnegative()
const scanStatisticsValidator = z.object({
  durationSeconds: scanSeconds,
  limitsReached: z.array(z.enum(['entries', 'packages', 'time', 'depth'])),
  roots: z.array(
    z.object({
      path: z.string(),
      status: z.enum(['complete', 'incomplete', 'unavailable', 'not-scanned']),
      durationSeconds: scanSeconds,
      entriesVisited: scanCount,
      directoriesSkipped: scanCount,
      symlinksSkipped: scanCount,
      otherEntriesSkipped: scanCount,
      candidates: scanCount,
      packagesFound: scanCount,
      errors: scanCount,
      hashedBytes: scanCount,
      hashingSeconds: scanSeconds,
      inspectionSeconds: scanSeconds,
    }),
  ),
})
export const catalogValidator = z.object({
  packages: z.array(packageValidator),
  errors: z.array(z.object({ path: z.string(), error: z.string() })),
  truncated: z.boolean(),
  scannedAt: z.string().nullable(),
  connected: z.boolean(),
  architecture: z.string(),
  statistics: scanStatisticsValidator.nullable().optional().default(null),
})
export const jobValidator = z.object({
  id: z.string(),
  operation: z.string(),
  state: z.enum(['running', 'succeeded', 'failed', 'interrupted', 'cancelled']),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  message: z.string(),
  package: z
    .object({
      id: z.string(),
      version: z.string(),
      title: z.string(),
      sha256: z.string(),
    })
    .nullable(),
})
export const statusValidator = z.object({
  job: jobValidator.nullable(),
  history: z.array(jobValidator),
})

export function packageStatusResult(status: z.infer<typeof statusValidator>) {
  const states = {
    running: i18n('Running'),
    succeeded: i18n('Completed'),
    failed: i18n('Failed'),
    interrupted: i18n('Interrupted'),
    cancelled: i18n('Cancelled'),
  }
  const operations: Record<string, string> = {
    scan: i18n('Scan S9PK Packages'),
    'import-project': i18n('Import Project to Local'),
    'export-nextcloud': i18n('Export Artifact to Shared Folder'),
    'export-filebrowser': i18n('Export Artifact to Shared Folder'),
    install: i18n('Install S9PK Package'),
    connect: i18n('Connect to StartOS'),
    disconnect: i18n('Disconnect from StartOS'),
  }
  const timestamp = (value: string) => {
    const date = new Date(value)
    return Number.isNaN(date.getTime())
      ? value
      : date.toISOString().slice(0, 19).replace('T', ' ') + ' UTC'
  }
  const label = (job: z.infer<typeof jobValidator>) =>
    `${operations[job.operation] ?? job.operation}: ${states[job.state]}`
  const details = (job: z.infer<typeof jobValidator>) => ({
    type: 'multiline' as const,
    name: label(job),
    description: timestamp(job.finishedAt ?? job.startedAt),
    value: [
      job.message,
      '',
      `${i18n('Started')}: ${timestamp(job.startedAt)}`,
      `${i18n('Finished')}: ${job.finishedAt ? timestamp(job.finishedAt) : job.state === 'running' ? i18n('In progress') : i18n('Not available')}`,
      ...(job.package
        ? [
            `${i18n('Package')}: ${job.package.title} ${job.package.version}`,
            `${i18n('Package ID')}: ${job.package.id}`,
            `SHA256: ${job.package.sha256}`,
          ]
        : []),
      `${i18n('Operation ID')}: ${job.id}`,
    ].join('\n'),
    masked: false,
    copyable: true,
    qr: false,
    filename: null,
  })
  const history = status.history
    .filter((job) => job.id !== status.job?.id)
    .slice(-30)
    .reverse()
  return {
    version: '1' as const,
    title: i18n('Installation Status'),
    message:
      status.job || history.length
        ? i18n('Reopen Installation Status to refresh. Times are shown in UTC.')
        : i18n('No package operations have run.'),
    result:
      status.job || history.length
        ? {
            type: 'group' as const,
            value: [
              ...(status.job
                ? [
                    {
                      ...details(status.job),
                      name: i18n('Latest operation'),
                      description: label(status.job),
                    },
                  ]
                : []),
              ...(history.length
                ? [
                    {
                      type: 'group' as const,
                      name: i18n('Previous operations (${count})', {
                        count: history.length,
                      }),
                      description: null,
                      value: history.map(details),
                    },
                  ]
                : []),
            ],
          }
        : null,
  }
}

export async function packageRequest(
  effects: T.Effects,
  input: Record<string, unknown>,
) {
  return sdk.SubContainer.withTemp(
    effects,
    { imageId: 'workspace' },
    sdk.Mounts.of().mountVolume({
      volumeId: 'main',
      subpath: './package-runtime',
      mountpoint: '/run/dev-workspace-packages',
      readonly: false,
    }),
    'package-client',
    async (client) => {
      const result = await client.exec(
        ['/usr/local/bin/workspace-packages', 'client'],
        { user: 'root', input: JSON.stringify(input) + '\n', timeout: 135000 },
      )
      if (result.exitCode !== 0)
        throw new Error(
          i18n(
            'The package manager is unavailable. Start Dev Workspace and check its logs.',
          ),
        )
      const response = JSON.parse(String(result.stdout)) as {
        ok: boolean
        value?: unknown
        error?: string
      }
      if (!response.ok)
        throw new Error(
          i18n('Package operation failed: ${message}', {
            message: response.error || 'Unavailable',
          }),
        )
      return response.value
    },
  )
}

export function packageLabel(item: z.infer<typeof packageValidator>) {
  return `${item.title} ${item.version} | ${item.architectures.join(', ')} | ${(item.size / 1024 ** 2).toFixed(1)} MiB | ${item.path}`
}

export function packageScanStatistics(
  statistics: z.infer<typeof scanStatisticsValidator> | null,
  displayedErrors: number,
) {
  if (!statistics)
    return i18n('Scan statistics are unavailable for this catalog.')
  const statuses = {
    complete: i18n('Complete'),
    incomplete: i18n('Incomplete'),
    unavailable: i18n('Unavailable'),
    'not-scanned': i18n('Not scanned'),
  }
  const limits = {
    entries: i18n('Directory entries'),
    packages: i18n('Candidate packages'),
    time: i18n('Scan duration'),
    depth: i18n('Directory depth'),
  }
  return [
    i18n('Scan duration: ${seconds} s. Limits reached: ${limits}.', {
      seconds: statistics.durationSeconds.toFixed(3),
      limits:
        statistics.limitsReached.map((limit) => limits[limit]).join(', ') ||
        i18n('None'),
    }),
    i18n('Scan errors: ${count}; shown below: ${shown}.', {
      count: String(
        statistics.roots.reduce((total, root) => total + root.errors, 0),
      ),
      shown: String(displayedErrors),
    }),
    ...statistics.roots.map((root) =>
      [
        `${root.path}: ${statuses[root.status]}.`,
        i18n(
          'Entries visited: ${entries}. Candidates: ${candidates}; valid packages: ${packages}. Excluded directories: ${directories}; symlinks: ${symlinks}; other entries: ${other}.',
          {
            entries: String(root.entriesVisited),
            candidates: String(root.candidates),
            packages: String(root.packagesFound),
            directories: String(root.directoriesSkipped),
            symlinks: String(root.symlinksSkipped),
            other: String(root.otherEntriesSkipped),
          },
        ),
        i18n(
          'Duration: ${seconds} s. Hashed: ${bytes} bytes in ${hashSeconds} s. Manifest inspection: ${inspectionSeconds} s.',
          {
            seconds: root.durationSeconds.toFixed(3),
            bytes: String(root.hashedBytes),
            hashSeconds: root.hashingSeconds.toFixed(3),
            inspectionSeconds: root.inspectionSeconds.toFixed(3),
          },
        ),
      ].join('\n'),
    ),
  ].join('\n\n')
}

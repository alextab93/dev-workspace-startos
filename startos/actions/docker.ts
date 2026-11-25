import { z } from '@start9labs/start-sdk'
import { previewUrls, readPreviewConfig } from '../previews'
import { sdk } from '../sdk'
import { i18n } from '../i18n'
import {
  configureDockerSettings,
  readDockerConfig,
  runDockerClient,
  runContainerTool,
  storageValidator,
  cleanupValidator,
} from '../docker'

class WeeklyCleanupToggle extends sdk.Value<boolean | undefined> {
  constructor() {
    const toggle = sdk.Value.toggle({
      name: i18n('Run unused image cleanup weekly'),
      default: false,
    })
    const validator = z.boolean().optional()
    super(
      async (options) => ({ ...(await toggle.build(options)), validator }),
      validator,
    )
  }
}

export const configureDocker = sdk.Action.withInput(
  'configure-docker',
  async () => ({
    name: i18n('Configure Containers'),
    description: i18n(
      'Enable rootless Podman for builds, Compose, and development containers.',
    ),
    warning: null,
    allowedStatuses: 'only-stopped',
    group: i18n('Containers'),
    visibility: 'enabled',
    access: 'user',
  }),
  sdk.InputSpec.of({
    enabled: sdk.Value.toggle({ name: i18n('Enable Podman'), default: false }),
    weeklyCleanup: new WeeklyCleanupToggle(),
    freeSpaceWarningGiB: sdk.Value.number({
      name: i18n('Warn below available GiB in Container Storage (0 disables)'),
      default: 0,
      required: false,
      integer: true,
      min: 0,
      max: 65536,
    }),
    cleanupAgeHours: sdk.Value.number({
      name: i18n('Minimum Cleanup Age'),
      description: i18n(
        'Unused images older than this age can be removed with Clean Containers.',
      ),
      default: 168,
      required: true,
      integer: true,
      min: 24,
      max: 8760,
      units: i18n('hours'),
    }),
  }),
  async () => ({
    weeklyCleanup: false,
    freeSpaceWarningGiB: 0,
    ...(await readDockerConfig()),
  }),
  async ({ effects, input }) => {
    const { freeSpaceWarningGiB, ...settings } = input
    const value = await configureDockerSettings(
      effects,
      freeSpaceWarningGiB == null
        ? settings
        : { ...settings, freeSpaceWarningGiB },
    )
    return {
      version: '1',
      title: i18n('Container Settings Saved'),
      message: value.enabled
        ? i18n(
            'Start Dev Workspace to use Podman. Existing container data is retained.',
          )
        : i18n(
            'Containers are disabled. Existing images, containers, and volumes are retained.',
          ),
      result: null,
    }
  },
)

export const dockerStorage = sdk.Action.withoutInput(
  'docker-storage',
  async () => ({
    name: i18n('Container Storage'),
    description: i18n(
      'View Podman disk usage for images, containers, and volumes.',
    ),
    warning: null,
    allowedStatuses: 'only-running',
    group: i18n('Containers'),
    visibility: 'enabled',
    access: 'user',
  }),
  async ({ effects }) => {
    const config = await readDockerConfig()
    const value = storageValidator.parse(
      await runDockerClient(effects, [
        'status',
        ...(config.weeklyCleanup ? ['--weekly'] : []),
        '--older-than-hours',
        String(config.cleanupAgeHours),
        '--warn-below-gib',
        String(config.freeSpaceWarningGiB ?? 0),
      ]),
    )
    return {
      version: '1',
      title: i18n('Container Storage'),
      message: i18n(
        'Rootless Podman ${version}; storage driver: ${driver}. Reclaimable figures are estimates.',
        { version: value.version, driver: value.driver },
      ),
      result: {
        type: 'group',
        value: [
          ...value.categories,
          { name: i18n('Container Storage'), value: value.notes.join('\n\n') },
        ].map(({ name, value }) => ({
          type: 'multiline' as const,
          name,
          value,
          description: null,
          masked: false,
          copyable: true,
          qr: false,
          filename: null,
        })),
      },
    }
  },
)

export const cleanDocker = sdk.Action.withInput(
  'clean-docker',
  async () => ({
    name: i18n('Clean Containers'),
    description: i18n(
      'Remove old unused Podman images, including unused build layers.',
    ),
    warning: null,
    allowedStatuses: 'only-running',
    group: i18n('Containers'),
    visibility: 'enabled',
    access: 'user',
  }),
  async ({ effects }) => {
    const config = await readDockerConfig()
    const preview = storageValidator.parse(
      await runDockerClient(effects, [
        'status',
        ...(config.weeklyCleanup ? ['--weekly'] : []),
        '--older-than-hours',
        String(config.cleanupAgeHours),
      ]),
    )
    return sdk.InputSpec.of({
      confirmed: sdk.Value.toggle({
        name: i18n('Confirm Cleanup'),
        description:
          preview.usage +
          '\n\n' +
          i18n(
            'Remove unused images older than ${hours} hours. Containers and volumes are retained; images may need downloading or rebuilding.',
            { hours: config.cleanupAgeHours },
          ),
        default: false,
      }),
    })
  },
  async () => ({ confirmed: false }),
  async ({ effects, input }) => {
    if (!input.confirmed)
      throw new Error(i18n('Confirm the container cleanup before continuing.'))
    const config = await readDockerConfig()
    const value = cleanupValidator.parse(
      await runDockerClient(effects, [
        'clean',
        '--older-than-hours',
        String(config.cleanupAgeHours),
      ]),
    )
    return {
      version: '1',
      title: i18n('Container Cleanup Complete'),
      message: i18n('No containers or volumes were removed.'),
      result: {
        type: 'single',
        value: value.output,
        masked: false,
        copyable: true,
        qr: false,
        launchable: false,
      },
    }
  },
)

export const registerCompose = sdk.Action.withInput(
  'register-compose',
  async () => ({
    name: i18n('Register Compose Project'),
    description: i18n('Save a local project or update its startup preference.'),
    warning: null,
    allowedStatuses: 'only-running',
    group: i18n('Containers'),
    visibility: 'enabled',
    access: 'user',
  }),
  sdk.InputSpec.of({
    name: sdk.Value.text({
      name: i18n('Stable project name'),
      default: null,
      required: true,
    }),
    directory: sdk.Value.text({
      name: i18n('Directory relative to /home/dev/projects'),
      default: null,
      required: true,
    }),
    file: sdk.Value.text({
      name: i18n('Compose file relative to that directory'),
      default: 'compose.yaml',
      required: true,
    }),
    viteService: sdk.Value.text({
      name: i18n('Vite Compose service (optional)'),
      default: null,
      required: false,
    }),
    previewUrl: sdk.Value.text({
      name: i18n('Vite preview URL (optional)'),
      default: null,
      required: false,
    }),
    autostart: sdk.Value.toggle({
      name: i18n('Start with Dev Workspace'),
      default: false,
    }),
  }),
  async () => ({}),
  async ({ effects, input }) => {
    const previewArgs: string[] = []
    if (input.previewUrl || input.viteService) {
      const rawUrl = input.previewUrl?.trim().replace(/\/$/, '')
      if (!input.viteService || !rawUrl)
        throw new Error(
          i18n('Enter a Compose service and an active preview URL.'),
        )
      const leases = (await readPreviewConfig()).leases
      for (const lease of leases) {
        if (lease.expiresAt <= Date.now()) continue
        const urls = await previewUrls(effects, lease)
        if (urls.some((value) => new URL(value).origin === rawUrl)) {
          previewArgs.push(
            input.viteService,
            new URL(rawUrl).hostname,
            String(lease.expiresAt),
          )
          break
        }
      }
      if (!previewArgs.length)
        throw new Error(
          i18n('Enter a Compose service and an active preview URL.'),
        )
    }
    return {
      version: '1' as const,
      title: i18n('Register Compose Project'),
      message: await runContainerTool(
        effects,
        [
          'register',
          '--',
          input.name,
          input.directory,
          input.file,
          input.autostart ? 'on' : 'off',
          ...previewArgs,
        ],
        true,
      ),
      result: null,
    }
  },
)

export const manageCompose = sdk.Action.withInput(
  'manage-compose',
  async () => ({
    name: i18n('Manage Compose Project'),
    description: i18n(
      'Stop preserves startup preference and volumes. Read recent logs over SSH with workspace-compose logs NAME.',
    ),
    warning: null,
    allowedStatuses: 'only-running',
    group: i18n('Containers'),
    visibility: 'enabled',
    access: 'user',
  }),
  sdk.InputSpec.of({
    operation: sdk.Value.select({
      name: i18n('Operation'),
      values: {
        list: i18n('List projects'),
        start: i18n('Start'),
        stop: i18n('Stop'),
        status: i18n('Service status'),
        unregister: i18n('Unregister stopped project'),
      },
      default: 'list',
    }),
    name: sdk.Value.text({
      name: i18n('Stable project name'),
      default: null,
      required: false,
    }),
  }),
  async () => ({}),
  async ({ effects, input }) => ({
    version: '1',
    title: i18n('Manage Compose Project'),
    message:
      (await runContainerTool(
        effects,
        input.operation === 'list'
          ? ['list']
          : [input.operation, '--', input.name || ''],
        true,
      )) || i18n('No registered projects.'),
    result: null,
  }),
)

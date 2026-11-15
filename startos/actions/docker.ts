import { sdk } from '../sdk'
import { i18n } from '../i18n'
import {
  configureDockerSettings,
  readDockerConfig,
  runDockerClient,
  storageValidator,
  cleanupValidator,
} from '../docker'

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
  async () => readDockerConfig(),
  async ({ effects, input }) => {
    const value = await configureDockerSettings(effects, input)
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
    const value = storageValidator.parse(
      await runDockerClient(effects, ['status']),
    )
    return {
      version: '1',
      title: i18n('Container Storage'),
      message: i18n(
        'Rootless Podman ${version}; storage driver: ${driver}. Reclaimable figures are estimates.',
        { version: value.version, driver: value.driver },
      ),
      result: {
        type: 'single',
        value: value.usage,
        masked: false,
        copyable: true,
        qr: false,
        launchable: false,
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
  async () => {
    const config = await readDockerConfig()
    return sdk.InputSpec.of({
      confirmed: sdk.Value.toggle({
        name: i18n('Confirm Cleanup'),
        description: i18n(
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

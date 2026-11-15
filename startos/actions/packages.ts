import { sdk } from '../sdk'
import { i18n } from '../i18n'
import {
  catalogValidator,
  jobValidator,
  packageLabel,
  packageRequest,
  statusValidator,
} from '../packages'

export const connectStartos = sdk.Action.withInput(
  'connect-startos',
  async () => ({
    name: i18n('Connect to StartOS'),
    description: i18n(
      'Authorize package installation on this server with a separate management identity.',
    ),
    warning: null,
    allowedStatuses: 'only-running',
    group: i18n('Packages'),
    visibility: 'enabled',
    access: 'user',
  }),
  sdk.InputSpec.of({
    password: sdk.Value.text({
      name: i18n('StartOS Password'),
      description: i18n(
        'Used once to enroll this package manager. The password is not saved. The resulting identity can administer this server and is kept outside project storage.',
      ),
      required: true,
      masked: true,
      default: null,
    }),
  }),
  async () => ({ password: '' }),
  async ({ effects, input }) => {
    if (!input.password) throw new Error(i18n('Enter the StartOS password.'))
    await packageRequest(effects, {
      operation: 'connect',
      password: input.password,
    })
    return {
      version: '1',
      title: i18n('Connecting to StartOS'),
      message: i18n('Open Installation Status to check the result.'),
      result: null,
    }
  },
)

export const disconnectStartos = sdk.Action.withoutInput(
  'disconnect-startos',
  async () => ({
    name: i18n('Disconnect from StartOS'),
    description: i18n(
      'Revoke the package manager identity and remove it from this workspace.',
    ),
    warning: i18n(
      'Package installation will require connecting again. Project files and installed services are retained.',
    ),
    allowedStatuses: 'only-running',
    group: i18n('Packages'),
    visibility: 'enabled',
    access: 'user',
  }),
  async ({ effects }) => {
    await packageRequest(effects, { operation: 'disconnect' })
    return {
      version: '1',
      title: i18n('Disconnecting from StartOS'),
      message: i18n('Open Installation Status to check the result.'),
      result: null,
    }
  },
)

export const scanPackages = sdk.Action.withInput(
  'scan-s9pk-packages',
  async () => ({
    name: i18n('Scan S9PK Packages'),
    description: i18n(
      'Find packages in local projects and the selected shared folder. Large files can take several minutes.',
    ),
    warning: null,
    allowedStatuses: 'only-running',
    group: i18n('Packages'),
    visibility: 'enabled',
    access: 'user',
  }),
  sdk.InputSpec.of({
    scope: sdk.Value.select({
      name: i18n('Search In'),
      values: {
        both: i18n('Local and Shared Projects'),
        local: i18n('Local Projects'),
        shared: i18n('Shared Projects'),
      },
      default: 'both',
    }),
  }),
  async () => ({}),
  async ({ effects, input }) => {
    await packageRequest(effects, { operation: 'scan', scope: input.scope })
    return {
      version: '1',
      title: i18n('Scanning S9PK Packages'),
      message: i18n(
        'Open Installation Status to check the result. Scanning does not install packages.',
      ),
      result: null,
    }
  },
)

export const cancelScan = sdk.Action.withoutInput(
  'cancel-package-scan',
  async () => ({
    name: i18n('Cancel Package Scan'),
    description: i18n(
      'Stop the current scan and retain the last completed catalog.',
    ),
    warning: i18n(
      'Stops only the package scan. Project files and installation jobs are retained.',
    ),
    allowedStatuses: 'only-running',
    group: i18n('Packages'),
    visibility: 'enabled',
    access: 'user',
  }),
  async ({ effects }) => {
    await packageRequest(effects, { operation: 'cancel-scan' })
    return {
      version: '1',
      title: i18n('Scan Cancellation Requested'),
      message: i18n('Open Installation Status to check the result.'),
      result: null,
    }
  },
)

export const browsePackages = sdk.Action.withoutInput(
  'browse-s9pk-packages',
  async () => ({
    name: i18n('Browse S9PK Packages'),
    description: i18n(
      'Show discovered packages, architecture compatibility, and installed versions.',
    ),
    warning: null,
    allowedStatuses: 'only-running',
    group: i18n('Packages'),
    visibility: 'enabled',
    access: 'user',
  }),
  async ({ effects }) => {
    const catalog = catalogValidator.parse(
      await packageRequest(effects, { operation: 'catalog' }),
    )
    return {
      version: '1',
      title: i18n('S9PK Packages'),
      message: !catalog.scannedAt
        ? i18n('Run Scan S9PK Packages first.')
        : i18n(
            'Last scan: ${time}. Server architecture: ${arch}. StartOS connected: ${connected}. Incomplete scan: ${incomplete}.',
            {
              time: catalog.scannedAt,
              arch: catalog.architecture,
              connected: String(catalog.connected),
              incomplete: String(catalog.truncated),
            },
          ),
      result: {
        type: 'single',
        value:
          [
            ...catalog.packages.map(
              (item) =>
                `${packageLabel(item)}\n${i18n('Installed version')}: ${item.installedVersion || i18n('Not available')}\n${i18n('Compatible')}: ${String(item.compatible)}\nSHA256: ${item.sha256}`,
            ),
            ...catalog.errors.map((item) => `${item.path}: ${item.error}`),
          ].join('\n\n') || i18n('No packages found.'),
        masked: false,
        copyable: true,
        qr: false,
        launchable: false,
      },
    }
  },
)

export const installPackage = sdk.Action.withInput(
  'install-s9pk-package',
  async () => ({
    name: i18n('Install S9PK Package'),
    description: i18n(
      'Review and install one compatible package from the last scan.',
    ),
    warning: null,
    allowedStatuses: 'only-running',
    group: i18n('Packages'),
    visibility: 'enabled',
    access: 'user',
  }),
  async ({ effects }) => {
    const catalog = catalogValidator.parse(
      await packageRequest(effects, { operation: 'catalog' }),
    )
    if (!catalog.connected)
      throw new Error(i18n('Connect to StartOS before installing a package.'))
    const candidates = catalog.packages.filter((item) => item.compatible)
    if (!candidates.length)
      throw new Error(
        i18n(
          'No compatible packages are available. Run Scan S9PK Packages first.',
        ),
      )
    return sdk.InputSpec.of({
      token: sdk.Value.select({
        name: i18n('Package'),
        values: Object.fromEntries(
          candidates.map((item) => [
            item.token,
            `${packageLabel(item)} | ${i18n('Installed version')}: ${item.installedVersion || i18n('Not installed')}`,
          ]),
        ),
        default: candidates[0].token,
      }),
      trust: sdk.Value.toggle({
        name: i18n('Allow an Untrusted Signer'),
        description: i18n(
          'Enable only for a package whose source you trust. Signature and integrity checks remain mandatory. This applies only to this installation.',
        ),
        default: false,
      }),
      confirmed: sdk.Value.toggle({
        name: i18n('Confirm Installation'),
        description: i18n(
          'Install the selected package on this server. An upgrade may restart that service. Installing Dev Workspace itself interrupts this action; verify its version in StartOS afterward.',
        ),
        default: false,
      }),
    })
  },
  async () => ({ trust: false, confirmed: false }),
  async ({ effects, input }) => {
    if (!input.confirmed)
      throw new Error(i18n('Confirm the selected package installation.'))
    const job = jobValidator.parse(
      await packageRequest(effects, { operation: 'install', ...input }),
    )
    return {
      version: '1',
      title: i18n('Package Installation Started'),
      message: i18n(
        'Open Installation Status to check staging, installation, and the final result.',
      ),
      result: {
        type: 'single',
        value: job.id,
        masked: false,
        copyable: true,
        qr: false,
        launchable: false,
      },
    }
  },
)

export const installationStatus = sdk.Action.withoutInput(
  'package-installation-status',
  async () => ({
    name: i18n('Installation Status'),
    description: i18n(
      'Show the current package operation and the last 30 results.',
    ),
    warning: null,
    allowedStatuses: 'only-running',
    group: i18n('Packages'),
    visibility: 'enabled',
    access: 'user',
  }),
  async ({ effects }) => {
    const status = statusValidator.parse(
      await packageRequest(effects, { operation: 'status' }),
    )
    return {
      version: '1',
      title: i18n('Installation Status'),
      message: status.job
        ? `${status.job.state}: ${status.job.message}`
        : i18n('No package operations have run.'),
      result: {
        type: 'single',
        value:
          status.history
            .map(
              (job) =>
                `${job.finishedAt} | ${job.operation} | ${job.state}\n${job.message}`,
            )
            .reverse()
            .join('\n\n') || i18n('No completed operations.'),
        masked: false,
        copyable: true,
        qr: false,
        launchable: false,
      },
    }
  },
)

import { setTimeout as delay } from 'node:timers/promises'
import { type T } from '@start9labs/start-sdk'
import { sdk } from '../sdk'
import { i18n } from '../i18n'
import {
  addWebPreview,
  extendWebPreview,
  previewUrls,
  readPreviewConfig,
  readPreviewRuntime,
  removeWebPreview,
  removeInvalidWebPreviews,
  setPreviewPassword,
} from '../previews'
import { type WebPreview } from '../fileModels/previews.json'

const duration = () =>
  sdk.Value.select({
    name: i18n('Duration'),
    values: {
      '1': i18n('1 minute'),
      '15': i18n('15 minutes'),
      '60': i18n('1 hour'),
      '240': i18n('4 hours'),
      '1440': i18n('24 hours'),
    },
    default: '60',
  })

async function selection() {
  const config = await readPreviewConfig()
  const active = config.leases.filter((lease) => lease.expiresAt > Date.now())
  if (!active.length)
    throw new Error(i18n('No active Web Previews are available.'))
  return sdk.Value.select({
    name: i18n('Web Preview'),
    values: Object.fromEntries(
      active.map((lease) => [
        lease.id,
        `${lease.name} (${lease.applicationPort})`,
      ]),
    ),
    default: active[0].id,
  })
}

async function details(effects: T.Effects, leases: WebPreview[]) {
  const config = await readPreviewConfig()
  const runtime = await readPreviewRuntime()
  const value = []
  const now = Date.now()
  for (const lease of leases) {
    const urls = await previewUrls(effects, lease)
    const current = config.leases.find((item) => item.id === lease.id)
    const observed =
      config.auth &&
      runtime?.revision === config.revision &&
      current?.proxyPort === lease.proxyPort &&
      current?.expiresAt === lease.expiresAt
        ? runtime.leases.find(
            (item) =>
              item.id === lease.id &&
              item.proxyPort === lease.proxyPort &&
              item.expiresAt === lease.expiresAt,
          )
        : undefined
    const status =
      lease.expiresAt <= now
        ? i18n('Expired')
        : runtime?.error || !observed
          ? i18n('Preview service is not ready.')
          : observed.state === 'listening'
            ? i18n('Application port is accepting connections.')
            : observed.state === 'waiting'
              ? i18n('Waiting for the application to start on its port.')
              : i18n('Preview service is not ready.')
    const seconds = Math.max(0, Math.ceil((lease.expiresAt - now) / 1000))
    const remaining = i18n(
      'Remaining: ${hours} h ${minutes} min ${seconds} s.',
      {
        hours: Math.floor(seconds / 3600),
        minutes: Math.floor((seconds % 3600) / 60),
        seconds: seconds % 60,
      },
    )
    value.push({
      type: 'single' as const,
      name: lease.name,
      description: `${status} ${i18n('Application Port')}: ${lease.applicationPort}. ${remaining} ${i18n('Expires')}: ${new Date(lease.expiresAt).toISOString()}.`,
      value:
        urls[0] ||
        i18n(
          'The interface is being prepared or has no enabled HTTPS address. Check Interfaces.',
        ),
      masked: false,
      copyable: true,
      qr: false,
      launchable: urls.length > 0,
    })
    if (urls.length && lease.expiresAt > now) {
      const hostname = new URL(urls[0]).hostname
      if (/^[a-z0-9.[\]:-]+$/i.test(hostname)) {
        value.push({
          type: 'single' as const,
          name: i18n('Vite launch command'),
          description: i18n(
            'Run in the project directory with Vite installed.',
          ),
          value: `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS='${hostname}' ./node_modules/.bin/vite --host 127.0.0.1 --port ${lease.applicationPort} --strictPort`,
          masked: false,
          copyable: true,
          qr: false,
          launchable: false,
        })
      }
    }
  }
  return { type: 'group' as const, value }
}

export const configurePreviewPassword = sdk.Action.withoutInput(
  'set-preview-password',
  async () => ({
    name: i18n('Set Web Preview Password'),
    description: i18n(
      'Generate a password for signing in to your application previews.',
    ),
    warning: i18n(
      'This signs out existing preview sessions. Save the new password when it is shown.',
    ),
    allowedStatuses: 'any',
    group: i18n('Web Previews'),
    visibility: 'enabled',
    access: 'user',
  }),
  async ({ effects }) => ({
    version: '1',
    title: i18n('Web Preview Password'),
    message: i18n(
      'Save this password. It is shown only now. Use it in each preview sign-in page.',
    ),
    result: {
      type: 'single',
      value: await setPreviewPassword(effects),
      masked: true,
      copyable: true,
      qr: false,
      launchable: false,
    },
  }),
)

export const addPreview = sdk.Action.withInput(
  'add-web-preview',
  async () => ({
    name: i18n('Add Web Preview'),
    description: i18n(
      'Open a temporary StartOS interface for an application running in Dev Workspace.',
    ),
    warning: i18n(
      'Expiry or removal closes preview access and removes its custom interface networking settings. The application keeps running.',
    ),
    allowedStatuses: 'only-running',
    group: i18n('Web Previews'),
    visibility: 'enabled',
    access: 'user',
  }),
  sdk.InputSpec.of({
    name: sdk.Value.text({
      name: i18n('Name'),
      required: true,
      default: null,
      maxLength: 60,
    }),
    applicationPort: sdk.Value.number({
      name: i18n('Application Port'),
      description: i18n(
        'Enter the port your application listens on in Dev Workspace. Open the assigned HTTPS address from the result; its external port may differ.',
      ),
      required: true,
      integer: true,
      min: 1024,
      max: 65535,
      default: 3000,
    }),
    durationMinutes: duration(),
  }),
  async () => ({ applicationPort: 3000, durationMinutes: '60' as const }),
  async ({ effects, input }) => {
    const lease = await addWebPreview(effects, {
      ...input,
      durationMinutes: Number(input.durationMinutes),
    })
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if ((await previewUrls(effects, lease)).length) break
      await delay(250)
    }
    return {
      version: '1',
      title: i18n('Web Preview Added'),
      message: i18n(
        'Open the preview and sign in with your Web Preview password. Use List Web Previews to check readiness or find its address.',
      ),
      result: await details(effects, [lease]),
    }
  },
)

export const listPreviews = sdk.Action.withoutInput(
  'list-web-previews',
  async () => ({
    name: i18n('List Web Previews'),
    description: i18n(
      'Show preview addresses, application ports, readiness, and expiry.',
    ),
    warning: null,
    allowedStatuses: 'any',
    group: i18n('Web Previews'),
    visibility: 'enabled',
    access: 'user',
  }),
  async ({ effects }) => {
    const config = await readPreviewConfig()
    return {
      version: '1',
      title: i18n('Web Previews'),
      message: [
        config.quarantined.length
          ? i18n(
              'Invalid preview records are closed. Use Remove Invalid Web Previews; valid previews remain available.',
            )
          : i18n(
              'Preview access expires automatically. Extend it to keep working or remove it to close access now.',
            ),
        i18n('Reopen List Web Previews to refresh the remaining time.'),
      ].join(' '),
      result: await details(effects, config.leases),
    }
  },
)

export const removeInvalidPreviews = sdk.Action.withoutInput(
  'remove-invalid-web-previews',
  async () => ({
    name: i18n('Remove Invalid Web Previews'),
    description: i18n(
      'Remove damaged preview records while preserving valid previews and applications.',
    ),
    warning: i18n(
      'Invalid preview records and their interface settings will be removed. Create new previews for those applications afterward.',
    ),
    allowedStatuses: 'any',
    group: i18n('Web Previews'),
    visibility: 'enabled',
    access: 'user',
  }),
  async ({ effects }) => {
    const count = await removeInvalidWebPreviews(effects)
    return {
      version: '1',
      title: i18n('Invalid Web Previews Removed'),
      message: i18n(
        'Removed ${count} invalid preview records. Valid previews and application files are preserved.',
        { count },
      ),
      result: null,
    }
  },
)

export const extendPreview = sdk.Action.withInput(
  'extend-web-preview',
  async () => ({
    name: i18n('Extend Web Preview'),
    description: i18n(
      'Keep an active application preview available for longer.',
    ),
    warning: null,
    allowedStatuses: 'only-running',
    group: i18n('Web Previews'),
    visibility: 'enabled',
    access: 'user',
  }),
  async () =>
    sdk.InputSpec.of({ id: await selection(), durationMinutes: duration() }),
  async () => ({ durationMinutes: '60' as const }),
  async ({ effects, input }) => {
    const lease = await extendWebPreview(
      effects,
      input.id,
      Number(input.durationMinutes),
    )
    return {
      version: '1',
      title: i18n('Web Preview Extended'),
      message: i18n(
        'The selected duration is measured from now. A later existing expiry is preserved.',
      ),
      result: await details(effects, [lease]),
    }
  },
)

export const removePreview = sdk.Action.withInput(
  'remove-web-preview',
  async () => ({
    name: i18n('Remove Web Preview'),
    description: i18n(
      'Close browser access while leaving the application running.',
    ),
    warning: i18n(
      'Its preview interface and custom networking settings will be removed.',
    ),
    allowedStatuses: 'any',
    group: i18n('Web Previews'),
    visibility: 'enabled',
    access: 'user',
  }),
  async () => sdk.InputSpec.of({ id: await selection() }),
  async () => ({}),
  async ({ effects, input }) => {
    await removeWebPreview(effects, input.id)
    return {
      version: '1',
      title: i18n('Web Preview Removed'),
      message: i18n(
        'Preview access is closing. The application remains running.',
      ),
      result: null,
    }
  },
)

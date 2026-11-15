import { sdk } from '../sdk'
import { i18n } from '../i18n'
import {
  buildProjectSource,
  getProjectSourceInput,
  readProjectSource,
  type ProjectSource,
} from '../projectSource'
import {
  applyProjectSource,
  assertWorkspaceStopped,
} from './projectSourceSupport'
import { startNextcloudConnection } from './nextcloud'

export const setProjectSource = sdk.Action.withInput(
  'set-project-source',
  async () => ({
    name: i18n('Configure Project Source'),
    description: i18n(
      'Add a shared FileBrowser Quantum or Nextcloud folder alongside local projects.',
    ),
    warning: i18n(
      'Every SSH key can edit the selected folder. Back up shared files in their source service. Stop the workspace before changing its source.',
    ),
    allowedStatuses: 'only-stopped',
    group: null,
    visibility: 'enabled',
    access: 'user',
  }),
  sdk.InputSpec.of({
    source: sdk.Value.union({
      name: i18n('Project Source'),
      default: 'none',
      variants: sdk.Variants.of({
        none: {
          name: i18n('Local projects only'),
          spec: sdk.InputSpec.of({}),
        },
        filebrowser: {
          name: 'FileBrowser Quantum',
          spec: sdk.InputSpec.of({
            subpath: sdk.Value.text({
              name: i18n('Shared Folder'),
              description: i18n(
                'An existing folder relative to FileBrowser storage, such as projects or projects/my-app. The dev account uses UID 1000 and needs read, write, and directory access.',
              ),
              required: true,
              default: 'projects',
              maxLength: 1024,
            }),
          }),
        },
        nextcloud: {
          name: 'Nextcloud',
          spec: sdk.InputSpec.of({}),
        },
      }),
    }),
  }),
  async () => {
    let source: ProjectSource
    try {
      source = await readProjectSource()
    } catch {
      source = { provider: 'none' }
    }
    return {
      source: getProjectSourceInput(source),
    }
  },
  async ({ effects, input }) => {
    await assertWorkspaceStopped(effects)
    if (input.source.selection === 'nextcloud')
      return startNextcloudConnection(effects, true)
    const current = await readProjectSource().catch(() => null)
    const source = buildProjectSource(input.source, current)
    const result = await applyProjectSource(effects, source)
    await sdk.action.clearTask(effects, 'dev-workspace:choose-nextcloud-folder')
    return result
  },
)

import { sdk } from '../sdk'
import { i18n } from '../i18n'
import { parsePublicKey } from '../sshKeys'
import { changeKeys, validateLabel } from '../keyState'
import { storeJson } from '../fileModels/store.json'

export const addSshKey = sdk.Action.withInput(
  'add-ssh-key',
  async () => ({
    name: i18n('Add SSH Key'),
    description: i18n('Authorize a public key for the shared dev account.'),
    warning: null,
    allowedStatuses: 'any',
    group: null,
    visibility: 'enabled',
    access: 'user',
  }),
  sdk.InputSpec.of({
    label: sdk.Value.text({
      name: i18n('Label'),
      default: null,
      required: true,
      maxLength: 80,
    }),
    publicKey: sdk.Value.textarea({
      name: i18n('Public Key'),
      default: null,
      required: true,
    }),
  }),
  async () => ({}),
  async ({ effects, input }) => {
    const label = validateLabel(input.label)
    const parsed = parsePublicKey(input.publicKey)
    await changeKeys(effects, (keys) => [
      ...keys.filter((key) => key.fingerprint !== parsed.fingerprint),
      { label, ...parsed },
    ])
    return {
      version: '1',
      title: i18n('SSH Key Added'),
      message: i18n(
        'The public key is authorized. Existing sessions continue.',
      ),
      result: {
        type: 'single',
        value: parsed.fingerprint,
        masked: false,
        copyable: true,
        qr: false,
        launchable: false,
      },
    }
  },
)

export const listSshKeys = sdk.Action.withoutInput(
  'list-ssh-keys',
  async () => ({
    name: i18n('List SSH Keys'),
    description: i18n('Show authorized public fingerprints and labels.'),
    warning: null,
    allowedStatuses: 'any',
    group: null,
    visibility: 'enabled',
    access: 'user',
  }),
  async () => {
    const keys = (await storeJson.read().once())?.keys ?? []
    return {
      version: '1',
      title: i18n('SSH Keys'),
      message: keys.length
        ? i18n(
            'Every listed key has access to the same dev account and projects.',
          )
        : i18n('No keys are authorized. Use Add SSH Key to enable access.'),
      result: {
        type: 'multiline',
        value: keys
          .map((key) => `${key.label}\n${key.fingerprint}\n${key.type}`)
          .join('\n\n'),
        masked: false,
        copyable: true,
        qr: false,
        filename: null,
      },
    }
  },
)

export const removeSshKey = sdk.Action.withInput(
  'remove-ssh-key',
  async () => ({
    name: i18n('Remove SSH Key'),
    description: i18n('Prevent new logins using the selected public key.'),
    warning: i18n(
      'Existing SSH sessions remain connected. Removing the last key prevents new logins until a key is added.',
    ),
    allowedStatuses: 'any',
    group: null,
    visibility: 'enabled',
    access: 'user',
  }),
  sdk.InputSpec.of({
    fingerprint: sdk.Value.dynamicSelect(async () => {
      const keys = (await storeJson.read().once())?.keys ?? []
      return {
        name: i18n('SSH Key'),
        values: Object.fromEntries(
          keys.map((key) => [
            key.fingerprint,
            `${key.label} (${key.fingerprint})`,
          ]),
        ),
        default: keys[0]?.fingerprint ?? '',
        disabled: keys.length
          ? false
          : i18n('No SSH keys are available to remove.'),
      }
    }),
  }),
  async () => ({}),
  async ({ effects, input }) => {
    await changeKeys(effects, (keys) => {
      if (!keys.some((key) => key.fingerprint === input.fingerprint)) {
        throw new Error(i18n('The selected SSH key is no longer registered.'))
      }
      return keys.filter((key) => key.fingerprint !== input.fingerprint)
    })
    return {
      version: '1',
      title: i18n('SSH Key Removed'),
      message: i18n(
        'New logins using this key are rejected. Existing sessions continue.',
      ),
      result: null,
    }
  },
)

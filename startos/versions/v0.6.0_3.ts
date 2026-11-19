import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const v0_6_0_3 = VersionInfo.of({
  version: '0.6.0:3',
  releaseNotes: {
    en_US:
      'Restrict saved project settings and Nextcloud credentials to the service owner.',
    es_ES:
      'Restringe la configuración del proyecto y las credenciales de Nextcloud al propietario del servicio.',
    de_DE:
      'Beschränkt gespeicherte Projekteinstellungen und Nextcloud-Zugangsdaten auf den Dienstinhaber.',
    pl_PL:
      'Ogranicza dostęp do zapisanych ustawień projektu i danych logowania Nextcloud do właściciela usługi.',
    fr_FR:
      'Réserve les paramètres de projet et les identifiants Nextcloud au propriétaire du service.',
  },
  migrations: { up: async () => {}, down: IMPOSSIBLE },
})

import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const v0_3_0_0 = VersionInfo.of({
  version: '0.3.0:0',
  releaseNotes: {
    en_US:
      'Add Nextcloud project folders through authenticated WebDAV with persistent upload recovery.',
    es_ES:
      'Agrega carpetas de proyectos de Nextcloud mediante WebDAV autenticado con recuperación persistente de cargas.',
    de_DE:
      'Nextcloud-Projektordner über authentifiziertes WebDAV mit persistenter Upload-Wiederherstellung.',
    pl_PL:
      'Foldery projektów Nextcloud przez uwierzytelnione WebDAV z trwałym odzyskiwaniem wysyłania.',
    fr_FR:
      'Dossiers de projets Nextcloud via WebDAV authentifié avec reprise persistante des envois.',
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})

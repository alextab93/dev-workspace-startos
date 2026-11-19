import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  version: '0.6.0:9',
  releaseNotes: {
    en_US: 'Revoke all saved web previews during workspace recovery.',
    es_ES:
      'Revoca todas las vistas previas web guardadas al restaurar el espacio de trabajo.',
    de_DE:
      'Widerruft alle gespeicherten Webvorschauen bei der Wiederherstellung des Arbeitsbereichs.',
    pl_PL:
      'Unieważnia wszystkie zapisane podglądy stron podczas przywracania obszaru roboczego.',
    fr_FR:
      'Révoque tous les aperçus web enregistrés lors de la restauration de l’espace de travail.',
  },
  migrations: { up: async () => {}, down: IMPOSSIBLE },
})

import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const v0_6_0_5 = VersionInfo.of({
  version: '0.6.0:5',
  releaseNotes: {
    en_US:
      'Preserve independent container files when repeating a backup or restore.',
    es_ES:
      'Conserva los archivos independientes de los contenedores al repetir una copia de seguridad o una restauración.',
    de_DE:
      'Bewahrt unabhängige Containerdateien bei wiederholten Sicherungen und Wiederherstellungen.',
    pl_PL:
      'Zachowuje niezależne pliki kontenerów podczas ponownego tworzenia lub odtwarzania kopii zapasowej.',
    fr_FR:
      'Préserve les fichiers indépendants des conteneurs lors des sauvegardes et restaurations successives.',
  },
  migrations: { up: async () => {}, down: IMPOSSIBLE },
})

import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const v0_6_0_6 = VersionInfo.of({
  version: '0.6.0:6',
  releaseNotes: {
    en_US:
      'Preserve updated project files and settings on repeated backups and restores.',
    es_ES:
      'Conserva los archivos de proyectos y la configuración actualizados en copias de seguridad y restauraciones sucesivas.',
    de_DE:
      'Erhält aktualisierte Projektdateien und Einstellungen bei wiederholten Sicherungen und Wiederherstellungen.',
    pl_PL:
      'Zachowuje zmienione pliki projektów i ustawienia przy kolejnych kopiach zapasowych i odtworzeniach.',
    fr_FR:
      'Préserve les fichiers de projet et les paramètres modifiés lors des sauvegardes et restaurations successives.',
  },
  migrations: { up: async () => {}, down: IMPOSSIBLE },
})

import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const v0_6_0_4 = VersionInfo.of({
  version: '0.6.0:4',
  releaseNotes: {
    en_US:
      'Make the bundled StartOS skill readable from remote development sessions.',
    es_ES:
      'Permite leer la guía de StartOS incluida desde las sesiones de desarrollo remoto.',
    de_DE:
      'Macht die mitgelieferte StartOS-Anleitung in Remote-Entwicklungssitzungen lesbar.',
    pl_PL:
      'Umożliwia odczyt dołączonej instrukcji StartOS w zdalnych sesjach programistycznych.',
    fr_FR:
      'Permet de lire le guide StartOS fourni depuis les sessions de développement à distance.',
  },
  migrations: { up: async () => {}, down: IMPOSSIBLE },
})

import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const v0_4_1_0 = VersionInfo.of({
  version: '0.4.1:0',
  releaseNotes: {
    en_US:
      'Show the number of authenticated SSH connections in Health Checks, including tunnels and SFTP.',
    es_ES:
      'Muestra el número de conexiones SSH autenticadas en las comprobaciones de estado, incluidos túneles y SFTP.',
    de_DE:
      'Die Anzahl authentifizierter SSH-Verbindungen einschließlich Tunneln und SFTP in den Zustandsprüfungen anzeigen.',
    pl_PL:
      'Liczba uwierzytelnionych połączeń SSH, w tym tuneli i SFTP, w kontrolach stanu.',
    fr_FR:
      'Affiche le nombre de connexions SSH authentifiées, y compris les tunnels et SFTP, dans les contrôles de santé.',
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})

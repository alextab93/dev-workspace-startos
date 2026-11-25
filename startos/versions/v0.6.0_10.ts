import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const v0_6_0_10 = VersionInfo.of({
  version: '0.6.0:10',
  releaseNotes: {
    en_US:
      'Supervise local Compose projects, review storage estimates and optionally clean unused images weekly.',
    es_ES:
      'Supervisa proyectos Compose locales, consulta el uso del almacenamiento y activa la limpieza semanal de imágenes sin usar.',
    de_DE:
      'Lokale Compose-Projekte verwalten, Speicherbedarf prüfen und ungenutzte Images auf Wunsch wöchentlich bereinigen.',
    pl_PL:
      'Zarządzaj lokalnymi projektami Compose, sprawdzaj użycie miejsca i włącz opcjonalne cotygodniowe usuwanie nieużywanych obrazów.',
    fr_FR:
      'Gérez les projets Compose locaux, consultez les estimations de stockage et activez le nettoyage hebdomadaire des images inutilisées.',
  },
  migrations: { up: async () => {}, down: IMPOSSIBLE },
})

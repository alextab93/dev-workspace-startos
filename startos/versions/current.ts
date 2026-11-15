import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  version: '0.5.0:1',
  releaseNotes: {
    en_US:
      'Set container tooling variables in SSH sessions, add local and shared package scan choices, and allow cancelling scans while retaining the last completed catalog.',
    es_ES:
      'Configura las herramientas de contenedores por SSH, permite elegir proyectos locales o compartidos y cancelar búsquedas conservando el último catálogo completo.',
    de_DE:
      'Rootless Podman, Container-Speicherübersicht und Image-Bereinigung, Linux-StartOS-Werkzeuge und S9PK-Verwaltung für lokale oder geteilte Projekte.',
    pl_PL:
      'Podman bez uprawnień roota, podgląd miejsca i czyszczenie obrazów, narzędzia StartOS dla Linux oraz zarządzanie S9PK z projektów lokalnych i współdzielonych.',
    fr_FR:
      'Ajoute Podman sans privilèges, le suivi du stockage et le nettoyage des images, les outils StartOS Linux et la gestion des S9PK issus des projets locaux ou partagés.',
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})

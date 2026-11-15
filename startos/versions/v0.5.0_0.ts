import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const v0_5_0_0 = VersionInfo.of({
  version: '0.5.0:0',
  releaseNotes: {
    en_US:
      'Add optional rootless Podman, container storage and unused-image cleanup, Linux StartOS tools, and an S9PK manager for discovering, reviewing, and installing packages from local or shared projects.',
    es_ES:
      'Añade Podman sin privilegios, información y limpieza de imágenes sin uso, herramientas StartOS para Linux y un gestor S9PK para descubrir, revisar e instalar paquetes de proyectos locales o compartidos.',
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

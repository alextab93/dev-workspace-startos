import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const v0_6_0_0 = VersionInfo.of({
  version: '0.6.0:0',
  releaseNotes: {
    en_US:
      'Add password-protected Web Previews with application ports, timed access, renewal and removal. Expiry closes browser connections and retires each preview interface with its custom networking settings while the application keeps running. Restoring a backup revokes saved preview access; create new previews after recovery. Package catalogs now report scan counts, exclusions and per-folder hashing and inspection times; unavailable folders are reported as incomplete. Restored workspaces require fresh manager and terminal StartOS logins while ordinary restarts preserve them.',
    es_ES:
      'Añade vistas previas web con contraseña, puerto de aplicación, caducidad, ampliación y eliminación. Al caducar se cierran las conexiones del navegador y se elimina la interfaz con su configuración de red; la aplicación sigue ejecutándose. Restaurar una copia revoca las vistas previas guardadas; créalas de nuevo tras la recuperación. Los catálogos muestran recuentos, exclusiones y tiempos de hash e inspección por carpeta; las carpetas no disponibles se indican como incompletas. Tras una restauración, el gestor y la terminal requieren nuevos inicios de sesión en StartOS; los reinicios normales los conservan.',
    de_DE:
      'Fügt passwortgeschützte Web-Vorschauen mit Anwendungsport, Ablaufzeit, Verlängerung und Entfernung hinzu. Beim Ablauf werden Browserverbindungen und die jeweilige Vorschau-Schnittstelle samt Netzwerkeinstellungen entfernt; die Anwendung läuft weiter. Nach einer Wiederherstellung müssen Vorschauen neu erstellt werden. Paketkataloge zeigen Zähler, Ausschlüsse sowie Hash- und Prüfzeiten pro Ordner; nicht verfügbare Ordner werden als unvollständig gemeldet. Nach einer Wiederherstellung müssen Paketmanager und Terminal erneut bei StartOS angemeldet werden; normale Neustarts erhalten die Anmeldungen.',
    pl_PL:
      'Dodaje podglądy WWW chronione hasłem, z portem aplikacji, czasem ważności, przedłużaniem i usuwaniem. Wygaśnięcie zamyka połączenia przeglądarki i usuwa interfejs podglądu wraz z ustawieniami sieci, pozostawiając działającą aplikację. Po przywróceniu kopii zapasowej podglądy trzeba utworzyć ponownie. Katalogi pakietów pokazują liczniki, pominięcia oraz czasy obliczania skrótów i inspekcji folderów; niedostępne foldery oznaczane są jako niekompletne. Po przywróceniu wymagane jest ponowne logowanie menedżera i terminala do StartOS; zwykłe restarty zachowują logowanie.',
    fr_FR:
      'Ajoute des aperçus Web protégés par mot de passe avec port, expiration, prolongation et suppression. À expiration, les connexions du navigateur et les interfaces avec leurs réglages réseau sont supprimées ; les applications continuent de fonctionner. Après restauration, les aperçus doivent être recréés. Les catalogues affichent les compteurs, exclusions et durées de hachage et d’inspection par dossier ; les dossiers indisponibles sont signalés comme incomplets. Après restauration, le gestionnaire et le terminal doivent se reconnecter à StartOS ; les redémarrages ordinaires conservent leurs connexions.',
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})

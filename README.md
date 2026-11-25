<p align="center">
  <img src="icon.svg" alt="Dev Workspace Logo" width="21%" />
</p>

# Dev Workspace on StartOS

Dev Workspace provides a persistent Linux development environment for desktop VS Code Remote SSH. The package combines OpenSSH, Git, language tools, and StartOS storage and access management. VS Code installs its matching server component after connecting. Projects can use the private home directory or an optional folder from FileBrowser Quantum or Nextcloud.

This document describes the package's operating contract. [instructions.md](instructions.md) explains the user workflow, and [UPDATING.md](UPDATING.md) records component pins and maintenance requirements.

## Table of Contents

The sections below describe storage, access, lifecycle, and maintenance boundaries.

- [Image and Container Runtime](#image-and-container-runtime)
- [Volume and Data Layout](#volume-and-data-layout)
- [File Models](#file-models)
- [Dependencies](#dependencies)
- [Network Access and Interfaces](#network-access-and-interfaces)
- [Browser Desktop Companion](#browser-desktop-companion)
- [Web Previews](#web-previews)
- [Installation and First-Run Flow](#installation-and-first-run-flow)
- [Actions](#actions)
- [Tasks](#tasks)
- [Health Checks](#health-checks)
- [Backups and Restore](#backups-and-restore)
- [Limitations and Differences](#limitations-and-differences)
- [Quick Reference for AI Consumers](#quick-reference-for-ai-consumers)

## Image and Container Runtime

The custom image builds on a digest-pinned Node image with Debian trixie. It includes OpenSSH, Git, Bash, tmux, Python with virtual environments, mise, and common compilation libraries. The Dockerfile pins the supplied Node and mise releases. Additional runtimes installed by the user live in persistent home storage.

The package runs a workspace subcontainer and, when enabled, a separate rootless Podman engine subcontainer. The SSH supervisor runs under catatonit in its own PID namespace, independently of the Podman engine. For Nextcloud, a supervisor starts its FUSE WebDAV mount and OpenSSH in the same mount namespace. Authenticated shells run as `dev`, UID/GID `1000`. The account has no sudo access. Password, keyboard-interactive, and root SSH logins are disabled. SSH agent forwarding, X11 forwarding, and tunnel devices are disabled; TCP and Unix socket forwarding are available for development tools.

Podman is disabled by default. Its engine runs as UID 1000 under catatonit and receives its own persistent storage, a private Unix socket directory, and `/home/dev/projects`. The development home, SSH host identity, Nextcloud authorization, and package manager credentials are outside its mounts. Every workspace user can control this engine and its project files. It shares the StartOS kernel and is not a virtual machine. Storage uses fuse-overlayfs; nested containers have cgroups disabled, so this package does not promise per-container CPU or memory enforcement.

The candidate launcher prepares a private user namespace as root and drops all user/group IDs to 1000 before starting Podman. It preserves the existing ownership mapping for container IDs 0 through 64535 and adds IDs through 65534, including the group required by Debian APT. This does not delegate the outer root identity. An isolated x86 test preserved existing image, container, volume and project-file ownership across the change; an installed-package upgrade and native backup/restore remain separate acceptance checks. Arbitrary IDs above 65534 are unsupported.

The image includes Podman, podman-compose, Linux `start-cli` 2.8.0, GitHub CLI, and GnuPG. The `podman` command connects to the workspace engine; a `docker` compatibility command delegates to it. Podman's `buildx build` compatibility command uses Buildah; the Docker Buildx plugin is not supplied, and `buildx inspect` is unsupported. A native x86 Dev Containers session passed a Compose build, exact file edits, tests, Node debugging, port forwarding, rebuild and reconnect through Remote SSH. This establishes the tested Node configuration, not compatibility with every Docker project. SSH sessions select Podman for StartOS packaging with `STARTOS_USE_PODMAN=1`.

A root-owned package manager runs alongside SSH in the same mount namespace, including the live Nextcloud FUSE mount. Native StartOS actions reach it through a root-only Unix socket. File discovery and copying run as UID 1000; server administration uses a separate root-owned identity outside home and project storage. This identity has server administration authority, not a package-scoped role. The password used to enroll it is not persisted.

The image supports x86_64 and aarch64 builds. Image build support does not establish native lifecycle or extension compatibility on both architectures. Native acceptance must be recorded separately for each target.

The SSH session environment puts mise shims and the user's local executables before system tools on `PATH`. This makes selected runtimes available to noninteractive SSH commands as well as interactive terminals without requiring a shell activation banner.

## Volume and Data Layout

Projects and package-managed SSH state use separate persistent volumes. The workspace receives private subdirectories for SSH state, package management, and, when selected, the Nextcloud upload cache.

| Volume path                           | Container path                           | Contents and ownership                                                                           |
| ------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `home`                                | `/home/dev`                              | User projects, editor server and extensions, shell files, runtime installs, and user credentials |
| `docker`                              | Engine `/var/lib/containers`                 | Persistent Podman images, layers, containers, and named volumes, included in backups |
| `main/podman-runtime`                 | `/run/dev-workspace-podman`              | Private Podman API socket |
| `main/docker.json`                    | Package file-model access                | Podman enablement and unused-image cleanup age |
| `main/packages` | `/var/lib/dev-workspace/packages` | Root-only manager identity, catalog, operation history, and temporary staging |
| `main/package-runtime` | `/run/dev-workspace-packages` | Root-only manager action socket |
| `main/previews` | Preview daemon `/var/lib/dev-workspace/previews` | Root-only password hash, temporary leases, expiry history and generated status |
| `main/store.json`                     | Package file-model access                | Authorized public-key records and package-owned settings                                         |
| `main/project-source.json`            | Package file-model access                | Shared-folder selection and Nextcloud app password, separate from SSH settings                   |
| `main/ssh`                            | `/var/lib/dev-workspace/ssh`             | Root-owned authorized-key file and persistent SSH host identity                                  |
| Selected `filebrowser/data` subfolder | `/projects-shared`                       | Optional project files owned and backed up by FileBrowser Quantum                                |
| `main/nextcloud-connection`           | Temporary connection-helper mount        | Root-only browser authorization state and generated account credentials                         |
| `main/nextcloud-cache`                | `/var/lib/dev-workspace/nextcloud-cache` | Root-only persistent Nextcloud upload cache, retained across interruption                        |
| Nextcloud WebDAV folder               | `/projects-shared`                       | Original Nextcloud files accessed through its API with local write caching                       |
| Ephemeral runtime directory           | `/run/sshd`                              | Daemon PID and runtime state recreated at startup                                                |

Workspace initialization adds a reference to the capability guide in `~/.codex/AGENTS.md` and `~/.claude/CLAUDE.md`. Both agents share `~/.dev-workspace-capabilities`. Existing personal instructions are preserved.

The default project directory is `/home/dev/projects`. Home initialization creates missing defaults without replacing existing files. Startup does not recursively change ownership across the entire home directory.

The optional source is mounted independently at `/projects-shared`. Existing projects are not moved or copied, and the package does not change ownership of provider files. Home, SSH credentials, editor data, and user-installed tools remain in their existing private storage.

Nextcloud read caches and unfinished uploads consume private workspace disk space. Cache maintenance stays enabled so a full cache can report a failed save and recover after space becomes available. Its recovery ceiling uses the cache filesystem's total capacity; this does not reserve free space or enforce a storage quota. Clean files have the longest retention supported by the bundled cache runtime, rather than routine hourly expiry. Pending writes are retained. Plan capacity for cached reads and writes, and do not delete the cache while uploads or recovery are pending.

A FileBrowser source must be an existing relative folder inside FileBrowser Quantum's `data` volume. Configuration checks it through a read-only mount; workspace startup checks write access as UID 1000. Do not rename or delete the selected folder while the workspace starts. A changed directory identity causes startup to fail; see [UPDATING.md](UPDATING.md#external-project-source-contract) for the concurrent-change limitation.

A Nextcloud source uses an existing folder beneath the account's HTTPS WebDAV root. The action verifies authenticated directory access without creating a folder. Browser authorization credentials stay in package-owned connection state; the selected source and root-only runtime file contain the credential needed for that account. Connection state retains previous grants to avoid revoking an account during concurrent activation. At its retention limit, grants explicitly revoked in Nextcloud are pruned only after a confirmed authentication rejection. TLS verifies the remote certificate against system trust plus the StartOS root CA. Editor saves upload through a persistent private cache; wait for uploads to complete before treating the remote copy as durable.

The `dev` account can read public host-key information, but cannot read the private host key or change the package-managed authorized-key file. All registered login keys use the same account and can access the same projects and user credentials.

Changes outside persistent mounts are ephemeral. System packages belong in the image; manually changing the root filesystem is not a supported way to persist a tool installation.

## File Models

The package owns its login policy and SSH identity separately from user shell configuration. Use the StartOS actions to manage access rather than editing generated files.

`main/store.json` stores authorized public-key records. `main/project-source.json` stores the optional shared-folder selection and, for Nextcloud, the app password separately, so SSH key changes do not change the project mount. Key-management actions update key records and the active authorized-key file. The generated `main/ssh/authorized_keys` file is derived state, so manual edits can be replaced by the next synchronization.

The package generates the private host key only when no key exists. It retains the identity through normal restart, update, and restoration of that workspace. A missing public host-key file can be reconstructed from the existing private key.

The image supplies the SSH daemon configuration. Home defaults are seeded only when absent, after which the user's shell files belong to the user. Keep noninteractive shell startup free of unsolicited output because editor bootstrap commands depend on a usable command channel.

## Dependencies

The default source is **Local projects only**, which uses no provider dependency. Selecting FileBrowser Quantum requires the `filebrowser` package at version `>=#quantum:2.0.2-stable:2`. It must be installed but can be stopped. Quantum uses the `filebrowser` package ID and exposes ordinary files through its `data` volume. [Provider storage layout](https://github.com/Start9Labs/filebrowser-quantum-startos/blob/master/README.md#volume-and-data-layout)

Selecting Nextcloud requires a running `nextcloud` package at version `>=35.0.2:3`. StartOS discovers an enabled HTTPS address for service access and a separate browser address. Nextcloud Login Flow v2 obtains account authorization, and an authenticated folder picker selects an existing project directory. Nextcloud permissions apply through that account. The selected folder is not an account-permission boundary. Use a dedicated account when access should be limited. [Nextcloud WebDAV access](https://docs.nextcloud.com/server/stable/user_manual/en/files/access_webdav.html)

The native FileBrowser mount grants every registered workspace SSH key access to the selected folder. FileBrowser web-user permissions do not apply to this filesystem access. FileBrowser's search index can lag direct edits even when the workspace immediately sees the changed file. [Provider indexing behavior](https://filebrowserquantum.com/en/docs/features/indexing/)

Individual projects may require databases or other services. Configure those as deliberate development dependencies. Installing a language runtime alone does not provision a database or make a production service suitable for test use.

## Network Access and Interfaces

The package exposes an SSH API interface with internal port `2222`. Its externally assigned port can differ. Connection information uses the actual available service addresses and port rather than assuming the internal port is reachable directly.

This endpoint accepts the `dev` account and is separate from the StartOS host administration endpoint. The optional Dev Workspace Desktop package provides the browser editor interface described below.

Desktop VS Code forwards development ports through SSH. Temporary application ports do not need their own StartOS interfaces for that workflow. Applications, Git, runtime installers, and package managers may initiate outbound connections using the service's configured outbound route.

## Browser Desktop Companion

Dev Workspace Desktop is a separate StartOS package that streams desktop VS Code to your browser and connects to this workspace through Remote SSH. It has its own password, persistent editor profile, dedicated SSH key and restart lifecycle. Install and configure it separately using its StartOS instructions; this package's SSH interface remains available to desktop clients on your computer.

Use the companion's **Prepare Workspace Key**, authorize that public key here with **Add SSH Key**, then use the companion's **Connect to Dev Workspace** with the host fingerprint from **Connection Information**. Choose Local Projects for container workloads or Shared Projects for the configured provider folder. The companion discovers the workspace address and verifies the pinned host. [Pairing steps](instructions.md#using-the-browser-desktop).

| Work | Where it runs and persists |
| --- | --- |
| Desktop application, UI extensions, keyring and pairing key | Dev Workspace Desktop |
| Remote terminal, project runtimes, language tools and package builds | Dev Workspace and its home storage |
| Podman engine, container layers and named volumes | Dev Workspace's separate engine storage |
| Original shared files | The selected Nextcloud or FileBrowser provider |

Opening a folder through Remote SSH supplies workspace tools without another container engine in the desktop. A local desktop window uses the companion's environment. Check the editor's remote indicator and extension location before running project commands. The desktop's forwarded localhost belongs to the companion; use a Web Preview interface to open an application directly from your computer's browser.

Back up the companion, workspace and provider separately. Removing the companion's saved target retains its key; revoke that public key here to prevent new logins. Existing authenticated connections require separate termination. Companion restarts do not restart Dev Workspace, but can disconnect editor sessions.

## Web Previews

The **Web Previews** actions publish temporary HTTP applications through StartOS interfaces. Run the application first, set a preview password once, then choose **Add Web Preview** with a name, application port and duration. The result and **List Web Previews** use actual enabled HTTPS addresses and assigned ports. A listener that has not started is shown as waiting. These actions do not launch or supervise project processes.

On x86 StartOS `0.4.2`, Dev Workspace `0.6.0:2` served previews at their assigned HTTPS addresses. Removing a preview or letting it expire released its interface and port reservations. The running application stayed available inside the workspace. See the [setup instructions](instructions.md#running-and-previewing-projects) for direct-process and Compose examples, the tested [Vite/Rails profile](instructions.md#vite-and-rails-on-one-browser-origin), [development CSP](instructions.md#development-styling-with-a-strict-csp), and [troubleshooting](instructions.md#troubleshooting-previews). Application ports and externally assigned HTTPS ports are distinct.

Dev Workspace requires StartOS `0.4.1` or later. Its preview proxy relies on the OS removing untrusted forwarding headers on plaintext connections and supplying the HTTPS scheme only after TLS termination. StartOS `0.4.1` introduced HTTP proxy policy on both connection paths. SDK `3.1.1` remains pinned; its default OS minimum of `0.4.0.2` is explicitly overridden for this package. Native preview testing on the minimum release, StartOS `0.4.1`, remains pending. [StartOS HTTP proxy change](https://github.com/Start9Labs/start-technologies/blob/start-os/v0.4.1/projects/start-os/release-notes/0.4.1.md)

The proxy runs in a separate subcontainer with only `main/previews` mounted. It targets application ports on `127.0.0.1` in the service network. Direct processes can listen there; a Podman container must publish its internal application port to the corresponding workspace loopback port. The engine still mounts local projects only. Ordinary SSH forwarding remains available independently.

Up to eight previews can run simultaneously. Application ports must be integers from 1024 through 65535, excluding SSH port 2222 and preview listener ports 18080 through 18087. Names are unique ignoring case, use 1 to 60 characters, and cannot contain control characters. Two active previews cannot use the same application port. The default lifetime is one hour, with presets from one minute through 24 hours. Extending measures the chosen duration from now and preserves an existing later expiry.

**Set Web Preview Password** generates a password and displays it once. Only its salted scrypt hash is stored. Each preview requires its own browser sign-in. Password rotation signs out every preview session; restarting the preview daemon also requires signing in again. Access credentials are not placed in the interface URL. App bearer authorization and app cookies are preserved. The preview session cookie is removed before forwarding a request to the app.

The serving boundary checks absolute expiry and a monotonic deadline. It also closes active streaming and WebSocket connections when access expires, is removed, or is revoked. The application continues running. An independent timer checks open connections every 100 milliseconds; runtime acceptance requires both connection types to close within two seconds after expiry. Event-loop scheduling and system load affect the observed closing time. Configuration refresh and binding cleanup are separate from this access check.

Expiry observed by a request or an open connection is recorded independently of scheduled configuration refresh. A clock correction cannot reactivate a recorded expiry. Failed persistence keeps access closed and retains the observed deadline for retry; graceful shutdown completes queued expiry writes. An unreadable configuration, invalid global password state, clock rollback or persistence failure closes preview access and reports an error. Do not delete expiry history to bypass a clock or recovery failure.

A malformed or conflicting individual lease is quarantined while unrelated valid previews remain available. The original record is retained in configuration during subsequent edits, and its access stays closed across proxy restarts. **List Web Previews** and health identify this condition. **Remove Invalid Web Previews** explicitly discards the damaged records; valid previews and application files are preserved. Create a new preview for each affected application after interface cleanup. New allocations wait while damaged records remain, preventing accidental reuse of their old networking settings.

Each preview has its own StartOS host identity. Removing or expiring it retires that host, including custom domains and address choices belonging to the preview. Allocation waits for outstanding retirement so a new preview does not inherit that setup. Removing a preview does not remove the SSH interface. Users control reachability in StartOS Interfaces; neither creating a preview nor its interface type authorizes changes to routers, DNS or tunnels.

The proxy accepts the HTTPS leg and uses StartOS's trusted scheme indication. It strips client forwarding values before sending its own upstream headers. Plain HTTP requests are refused. HTTP requests, redirects, uploads, server-sent events and WebSocket upgrades use the application's root path. Unauthenticated CORS preflight can return only the application's CORS policy; response bodies, app cookies and other headers are withheld, and data requests still require a preview session. The application must implement its own CORS/CSRF policy. Cross-origin browser WebSockets are currently rejected; a frontend and Action Cable endpoint should use the same preview origin until a separately validated policy supports the required split-origin setup.

Different ports are separate browser origins but do not isolate cookies on one hostname. Use distinct application cookie names or separate hostnames for simultaneous apps where needed. Preview-session cookie names are unique per lease; that does not isolate the application's own cookies. This feature shares the workspace's single-owner trust model. [HTTP cookie isolation](https://www.rfc-editor.org/rfc/rfc6265#section-8.5)

`main/previews/config.json` holds leases and the password hash, `expiry.json` retains the observed clock and expired identifiers, and `runtime.json` is generated readiness data. These files are included with `main`. Restore initialization revokes the saved password and removes every restored lease and retains its host identifier for binding cleanup. Set a new password and create fresh previews after restoring. Projects are unchanged.

## Installation and First-Run Flow

The service creates persistent SSH host identity and an initially empty authorized-key set. An important setup prompt directs the user to register a public key; it does not prevent the SSH daemon from starting.

Until a key is registered, new SSH login attempts fail. Adding a valid key makes the account accessible. No setup wizard creates a password or gives ownership to the first network visitor.

The connection-information action provides the username, usable endpoints, public fingerprint, and client setup information. VS Code then installs its own server component under the user's persistent home.

## Actions

Package-provided action labels and prompts are available in English and Spanish. Manifest descriptions and release notes also include German, Polish and French; those additional locales use English for this package's actions. Diagnostic output from command-line tools can remain in its original language. Dev Workspace Desktop maintains its own translations and instructions.

Key-management actions change access for the shared development account. They update the active key set without restarting the workspace or interrupting existing development processes.

**Configure Containers**, **Container Storage**, and **Clean Containers** manage the rootless Podman engine. Configuration requires the workspace to be stopped. On-demand cleanup requires confirmation and removes unused images older than the configured age, including unused build layers. Containers, named volumes, projects, and Nextcloud uploads are retained. The default age is seven days. There is no total disk quota or automatic cache budget.

The **Packages** action group offers **Connect to StartOS**, **Disconnect from StartOS**, **Scan S9PK Packages**, **Cancel Package Scan**, **Browse S9PK Packages**, **Install S9PK Package**, and **Installation Status**. Server address and CA are discovered from StartOS. The package manager identity is independent of terminal `startos-target` profiles and build signing keys.

Scanning recursively reads the selected source: `/home/dev/projects`, `/projects-shared`, or both. Each completed scan replaces the catalog for that source selection. **Cancel Package Scan** stops only a scan and retains the previous completed catalog. It inspects package metadata and hashes complete files. It skips symlinks, `.git`, `node_modules`, `.venv`, and `venv`, and limits one scan to 2,000 candidate packages, 200,000 directory entries, 40 directory levels below each project root, and approximately one hour. A deeper subtree is reported as unscanned and the catalog is marked incomplete; other folders continue within the remaining scan limits. Files larger than 32 GiB are rejected. Incomplete scans and unreadable files are reported. Architecture comes from the manifest, not the filename. Browse S9PK Packages reports per-root visited entries, intentionally excluded directories, symlinks and other skipped entries, candidate and valid-package counts, total errors, bytes hashed, hashing time, manifest-inspection time and total elapsed time. Unavailable roots and unreadable directories mark the scan incomplete. Roots not reached before a scan-wide limit are shown as not scanned. At most 100 error details are retained, with the full observed error count shown separately. Counters do not include descendants of excluded or unreadable directories. Timings describe this scan, including cache and transport effects; they are not isolated network latency or a throughput guarantee. Older catalogs remain readable and explicitly lack these measurements.

Installation requires a selected compatible catalog entry and explicit confirmation. The manager copies that artifact to private local storage, verifies its SHA256 against the scan, and invokes authenticated `start-cli package install --sideload`. Trusted signers are required by default. **Allow an Untrusted Signer** applies to one explicitly selected installation; signature and archive integrity checks remain mandatory. Staging files are removed on completion or failure. At least the artifact size plus 512 MiB must be free before staging; StartOS also needs space to install it. The original project file is never removed or modified.

A changed size or SHA256 rejects the selected artifact before installation. If the file disappears, becomes a symlink, or cannot be read from its provider, Installation Status reports a source-read failure and removes the partial staging copy. Restore access to the project source and scan again before explicitly retrying. The previous catalog and unrelated files are retained; failed staging does not install a partial package.

Only one background scan, authorization, or install operation runs at once. The status action shows the latest operation in a copyable multiline panel, with its state, full message, UTC timestamps, and package details when available. An expandable history lists up to 30 earlier results, newest first, without repeating the latest operation. Reopen the action to refresh it. Success requires the server to report the expected installed version. A workspace restart marks an unfinished operation interrupted; verify the target service before retrying. This also applies when upgrading Dev Workspace itself.

- **Add SSH Key** registers a public key and label. Use it for an additional trusted device. Invalid input leaves existing access intact. Adding an already registered key updates its label instead of creating a duplicate entry.
- **List SSH Keys** returns public fingerprints and labels. It does not reveal private key material.
- **Remove SSH Key** removes future authentication using the selected key. Existing authenticated sessions remain connected. Removing the final key leaves the service running and raises the setup prompt again.
- **Connection Information** reads the current endpoint and identity information. Repeating it does not change access or project state.
- **Configure Project Source** is available while the workspace is stopped. Choose **Local projects only**, **FileBrowser Quantum**, or **Nextcloud**. Selecting Nextcloud starts browser authorization or reuses an existing connected account. The current project source remains unchanged until a folder is saved.
- **Connect Nextcloud Account** discovers the installed service and returns a browser authorization link. No URL, username, or app password needs to be copied into StartOS. It can also connect a different account.
- **Choose Nextcloud Project Folder** completes approved authorization and lists accessible folders. **Use folder** saves a writable selection; **Browse folder** moves the picker into a directory, which is shown when the action is reopened. StartOS native actions do not provide a live folder tree.
- **Cancel Nextcloud Setup** preserves the active source and completed connections. Unapproved links remain valid until their 20-minute expiry, so close abandoned authorization pages. Manage completed grants in Nextcloud Security settings.

Pending or unreadable upload state blocks switching destinations or disabling sharing until recovered. Browser-created sources use a stable cache identity independently of the live discovered transport address. A verified local legacy connection can retain its cache when reauthorized to the same account. Existing projects and SSH keys are preserved.

These actions do not manage credentials for Git hosting, package registries, or commit signing. Those credentials belong to the user's development workflow. Changing the project source requires stopping the workspace and therefore interrupts its processes.

## Tasks

An optional prompt points to Nextcloud folder selection after account authorization starts. Browsing completes that prompt; reopen the folder action to continue into nested folders. The prompt is cleared when another source or the final folder is saved.

An important, nonblocking setup prompt is present while no authorized SSH keys exist. Registering a valid key clears it; removing the final key raises it again.

Recovery remains available through the StartOS add-key action even when SSH login is unavailable. The prompt does not terminate existing sessions or restart development applications.

## Health Checks

Workspace readiness checks whether the SSH listener is available after preparation, with a 30-second startup grace period. Failure indicates that initialization or the daemon needs attention; inspect the service logs for configuration, filesystem, or host-key errors.

**SSH Connections** shows the number of authenticated SSH connections, refreshed every 10 seconds. Zero connections is healthy. The count includes terminal, VS Code, SFTP, and forwarding-only connections; multiple channels sharing one SSH transport count once. Login attempts and rejected authentication are excluded. This is not a count of distinct people or VS Code windows. If the connection state cannot be inspected, the check reports that the count is unavailable.

The separate **SSH Access** check compares the saved key configuration with its synchronization receipt and the active authorized-key contents. Missing or invalid persisted settings, or key changes that have not synchronized, produce a failure. Inspect the service logs and key-management action results before retrying a failed change.

A valid empty key set reports loading and directs the user to add a public key. The important setup prompt remains nonblocking, so the listener and existing sessions continue. Adding a key must both persist and synchronize before key configuration can report success.

With Nextcloud selected, **Nextcloud Project Files** reports mount readiness and pending uploads. A successful editor save can precede the remote upload. Retained dirty or unreadable cache state requires attention; do not delete it to clear the warning.

**Web Previews** reports whether the proxy can persist its state and own the listeners needed by active previews. A listener-port conflict is retried without restarting the workspace. Per-application waiting state is shown by **List Web Previews**; an unavailable application does not request a workspace restart.

Neither listener nor key-configuration health proves that an editor can bootstrap, an extension works, or a project passes its tests. Those outcomes need their own acceptance checks.

## Backups and Restore

The backup declaration includes `main` and `home`, with a separate metadata-preserving copy of the `docker` volume. Its intended contents are repositories and uncommitted files stored in home, editor data, user runtime installations, authorized keys, SSH host identity, and Podman storage including named volumes. It also includes credentials stored in home and the separate root-owned package manager identity. Podman images and layers can substantially increase backup size. On x86_64 StartOS 0.4.2, a backup initiated while Dev Workspace 0.6.0:7 was running completed successfully. After restart, the Git working tree, SSH identity and editor settings matched their pre-backup values. The stopped database container retained its committed SQLite row, and a copy of the live volume passed an integrity check. A separate x86 test backed up a stopped 0.6.0:8 workspace and restored it on the same server under its disposable service ID. Git changes, SSH identity, rootless container data and a committed SQLite row matched the baseline. Desktop VS Code opened the restored project using its newly assigned SSH port.

The workspace rewrites regular files in all three volumes on each backup or restore to preserve changes in both contents and hard links. Allow time for the full volume and temporary space for the largest file being replaced.

The source selection, saved Nextcloud app password, and persistent upload cache are included. Canonical files at `/projects-shared` require the selected provider's own backup. A cache is not a complete backup of Nextcloud files. Restoring a cache can replay pending writes, so coordinate workspace and provider restores. Restoring the workspace does not recreate a missing provider folder. Recover pending uploads before changing the selected source.

StartOS documents stopping a service for backup and restarting it only when it was previously running; a stopped service remains stopped. Plan for interrupted SSH sessions, builds, tmux sessions, language servers and applications. This package's engine shutdown, provider upload drain and complete backup ordering still require native verification. Unsaved editor buffers and running process state are not part of the backup. [StartOS backup lifecycle](https://docs.start9.com/start-os/0.4.1.x/backup-create.html).

The restore implementation reuses saved home and SSH identity and recreates ephemeral runtime paths. Read Connection Information again because the address or assigned port can change, then verify files, tools, containers and database records before resuming work. Preview restore initialization revokes the saved preview password and leases; create new previews after recovery. These source behaviors do not establish a successful full native restore.

Restore initialization requires fresh StartOS enrollment for both the package manager and `startos-target`. Use **Connect to StartOS** to authorize the manager against the server currently hosting the workspace. Terminal profiles keep their saved addresses and CAs: review `startos-target info NAME` before login, or run `startos-target add-local restored-server` to verify and save the current server under a new name, then `startos-target login restored-server` in an interactive terminal. Ordinary restarts and updates preserve these logins.

Copied identity keys remain private and inactive in these helpers; they are not revoked on the original server or deleted from the backup. Each restore selects a new identity directory, including when restoring an already restored workspace. Keep the restore isolated until other copied credentials, SSH identity and pending provider uploads have been reviewed. A restored desktop companion similarly retains its pairing key. Its editor profile belongs to its own backup. These guards have separate source tests; complete native restore acceptance remains pending.

No home directories are excluded as caches by this package. Optimize backup size only after confirming which data can be reconstructed. A project's local database needs its own consistency and recovery verification even when its files are inside a backed-up volume.

## Limitations and Differences

This is one trusted Linux account. Different SSH keys are different ways to access that account, not separate users or project permission boundaries.

The Nextcloud source uses WebDAV, preserving Nextcloud's processing of file operations. Direct mounts of its internal data directory are unsupported. To show FileBrowser-backed projects in Nextcloud, use its existing FileBrowser External Storage integration. That integration maps the provider tree for the selected Nextcloud users, not just the folder selected in Dev Workspace. Direct edits require index refreshes, and external renames can be treated as deletion and creation rather than preserving file identity. [Nextcloud data-directory guidance](https://docs.nextcloud.com/server/stable/admin_manual/desktop/troubleshooting.html), [package integration](https://github.com/Start9Labs/nextcloud-startos/blob/master/README.md#external-storage), [external change detection](https://docs.nextcloud.com/server/stable/admin_manual/configuration_files/external_storage_configuration_gui.html)

The current Nextcloud mount presents files with mode `0660`. A successful `chmod +x` does not make them executable, and symlink creation fails. A package installation that needs dependency or executable symlinks can therefore fail with an I/O error. Keep runtime installations in private home storage, and put Python virtual environments, linked dependency trees and filesystem-sensitive builds in local projects under `/home/dev/projects`. FileBrowser provides ordinary filesystem access, but container projects still require the private local storage described below.

Editor-style temporary-file replacement and rename work through the mounted folder, with uploads completing afterward. Saves through the mount can trigger local file watchers; edits made through another Nextcloud client may become readable after a cache refresh without a watcher event. Reload or use a project-specific polling watcher when needed, and avoid simultaneous edits to the same file from different clients. These behaviors were observed with the packaged rclone 1.60.1-DEV runtime in an isolated WebDAV fixture; they do not guarantee every editor save strategy or remote client. [rclone filesystem and cache behavior](https://rclone.org/commands/rclone_mount/)

Keep active database files on local storage or native database volumes. A successful cached file save does not prove the remote synchronization and locking guarantees a database needs. A simple database test passing on a network filesystem is not evidence of durable database support. [SQLite network-filesystem considerations](https://www.sqlite.org/useovernet.html)

The optional Podman engine supports local projects at `/home/dev/projects`. Shared provider paths are not mounted into the engine; do not use `/projects-shared` for container bind mounts or Dev Containers. Keep active container projects and database storage on native local storage. Remote SSH followed by Dev Containers avoids requiring a Docker installation on the client computer. The tested x86 Node/Compose workflow does not establish other project configurations, ARM Dev Containers, foreign-architecture builds or complete lifecycle recovery. [Remote Docker development](https://code.visualstudio.com/remote/advancedcontainers/develop-remote-host)

When Dev Workspace starts, it starts registered Compose projects with autostart enabled. Other project commands require a manual start. A tmux session survives client disconnects and ends when the workspace stops.

Native x86 validation retained the same tmux heartbeat process and advancing saved output after normal SSH command exit, forced SSH transport loss, reattachment and desktop-browser closure/reconnection. The [process continuity guide](instructions.md#keeping-a-command-running) distinguishes these client events from a workspace stop or server reboot and gives the manual relaunch procedure. These checks do not establish server reboot or backup/restore acceptance.

Native macOS applications, launchd, Apple frameworks, and platform-specific provider tests still need their native execution environment. Linux availability also does not guarantee that every extension or native dependency supports every packaged CPU architecture.

The package does not copy Git credentials or signing keys from the computer. SSH agent forwarding is disabled, so choose a suitable dedicated remote credential or another explicit workflow.

## Quick Reference for AI Consumers

This summary identifies the package's operating surface. Runtime versions and image digests are maintained in source rather than duplicated here.

```yaml
package_id: dev-workspace
image: ./Dockerfile
architectures: [x86_64, aarch64]
subcontainers: [workspace, optional-workspace-podman, web-previews]
userspace_filesystems: true
virtual_networking: true
volumes:
  home: /home/dev
  main: package-managed state
  docker: /var/lib/containers in engine only
volume_mounts:
  main/ssh: /var/lib/dev-workspace/ssh
  main/nextcloud-cache: /var/lib/dev-workspace/nextcloud-cache
  main/podman-runtime: /run/dev-workspace-podman
  main/packages: /var/lib/dev-workspace/packages
  main/package-runtime: /run/dev-workspace-packages
  main/previews: /var/lib/dev-workspace/previews in preview daemon
  home/projects: /home/dev/projects in engine
package_only_files:
  - main/store.json
  - main/project-source.json
  - main/docker.json
file_models:
  - store.json
  - project-source.json
  - docker.json
  - previews/config.json
  - previews/runtime.json
  - ssh/authorized_keys
  - ssh/ssh_host_ed25519_key
startos_managed_env_vars: []
dependencies:
  filebrowser:
    optional: true
    kind: exists
    version: '>=#quantum:2.0.2-stable:2'
    volume: data
    subpath: selected existing relative folder
    mountpoint: /projects-shared
    readonly: false
  nextcloud:
    optional: true
    kind: running
    version: '>=35.0.2:3'
    transport: HTTPS WebDAV
    mountpoint: /projects-shared
interfaces:
  ssh: { type: api, port: 2222 }
  previews: { type: ui, internal_ports: '18080-18087', protocol: http, access: HTTPS }
actions:
  - set-preview-password
  - add-web-preview
  - list-web-previews
  - extend-web-preview
  - remove-web-preview
  - remove-invalid-web-previews
  - connection-info
  - configure-docker
  - docker-storage
  - clean-docker
  - register-compose
  - manage-compose
  - connect-nextcloud-account
  - cancel-nextcloud-setup
  - choose-nextcloud-folder
  - connect-startos
  - disconnect-startos
  - scan-s9pk-packages
  - cancel-package-scan
  - browse-s9pk-packages
  - install-s9pk-package
  - package-installation-status
  - set-project-source
  - add-ssh-key
  - list-ssh-keys
  - remove-ssh-key
stopped_only_actions:
  - configure-docker
  - connect-nextcloud-account
  - cancel-nextcloud-setup
  - choose-nextcloud-folder
  - set-project-source
tasks:
  - { action: add-ssh-key, severity: important }
health_checks: [ssh, docker, web-previews, ssh-connections, nextcloud, ssh-keys]
```

### Supervised local Compose projects

In **Containers**, use **Register Compose Project** with a stable lowercase project name, a directory relative to `/home/dev/projects`, and its Compose file. Choose **Start with Dev Workspace** for automatic startup. **Manage Compose Project** lists registrations, starts and stops services, shows container status and unregisters stopped projects. Register the same name and paths again to change the preference.

To try a disposable app, copy the [example Compose project](tests/fixtures/supervised-project) to `/home/dev/projects/demo`. In the development SSH shell, register and start it with these commands.

```sh
workspace-compose register demo demo compose.yaml on
workspace-compose start demo
curl -fsS http://127.0.0.1:18654/write
curl -fsS http://127.0.0.1:18654/read
workspace-compose status demo
workspace-compose logs demo
workspace-compose stop demo
workspace-compose unregister demo
```

Use a distinct project name for each stack. Keep environment files and application credentials in the project. Read application logs in your SSH session, since applications can print secrets. Stop preserves containers, named volumes and the next-start preference. Unregister removes the registration and preserves the stopped resources. Choose autostart off to keep a registered project stopped across restarts. Manage published application ports in Compose and grant browser access separately through Web Previews.

### Give someone access to shared project files

For a collaborator who needs files only, use a named Nextcloud account and share just the project folder from the owner's Files view. Start with read-only permissions. The collaborator signs in to their own Nextcloud account and opens that folder from Shared with you. Keep private projects, deployment credentials, environment files and container sockets outside the shared folder. To revoke access, remove that recipient in the folder's sharing panel. Copies already downloaded remain with the recipient.

Workspace SSH keys and the browser desktop grant access to the owner's development account. Keep those credentials with the developer. Run Compose from a local project directory and copy only the files intended for the collaborator into the shared folder.

### Review storage before cleanup

**Container Storage** shows Podman usage, the count and upper size estimate for old unused images, current log allocation, named volumes and Nextcloud cache allocation where readable. Shared layers can make the estimate much larger than the space recovered. **Configure Containers** accepts an optional low-space threshold in GiB. Zero disables the warning. Falling below the threshold displays a warning the next time you review storage.

**Clean Containers** shows the cleanup scope and asks for confirmation. Podman checks eligibility again when cleanup runs. The result includes the change in available filesystem bytes during the operation. Other writes on the same filesystem can affect this measurement. Cleanup runs on demand and retains containers, named volumes and the Nextcloud upload cache. To also run cleanup weekly, stop the workspace, enable **Run unused image cleanup weekly** in **Configure Containers**, and start the workspace. The first sweep is due seven days later. An overdue sweep runs once when the engine resumes with scheduling enabled. A failed sweep retries in one hour. **Container Storage** shows the next attempt in UTC. Both modes use the same minimum image age and retain stopped containers, volumes and pending uploads.

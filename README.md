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

The image includes Podman, podman-compose, Linux `start-cli` 2.8.0, GitHub CLI, and GnuPG. The `podman` command connects to the workspace engine; a `docker` compatibility command delegates to it. Docker-specific plugins such as Buildx are not supplied. Desktop Dev Containers compatibility requires separate acceptance. SSH sessions select Podman for StartOS packaging with `STARTOS_USE_PODMAN=1`.

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
| `main/store.json`                     | Package file-model access                | Authorized public-key records and package-owned settings                                         |
| `main/project-source.json`            | Package file-model access                | Shared-folder selection and Nextcloud app password, separate from SSH settings                   |
| `main/ssh`                            | `/var/lib/dev-workspace/ssh`             | Root-owned authorized-key file and persistent SSH host identity                                  |
| Selected `filebrowser/data` subfolder | `/projects-shared`                       | Optional project files owned and backed up by FileBrowser Quantum                                |
| `main/nextcloud-connection`           | Temporary connection-helper mount        | Root-only browser authorization state and generated account credentials                         |
| `main/nextcloud-cache`                | `/var/lib/dev-workspace/nextcloud-cache` | Root-only persistent Nextcloud upload cache, retained across interruption                        |
| Nextcloud WebDAV folder               | `/projects-shared`                       | Original Nextcloud files accessed through its API with local write caching                       |
| Ephemeral runtime directory           | `/run/sshd`                              | Daemon PID and runtime state recreated at startup                                                |

The default project directory is `/home/dev/projects`. Home initialization creates missing defaults without replacing existing files. Startup does not recursively change ownership across the entire home directory.

The optional source is mounted independently at `/projects-shared`. Existing projects are not moved or copied, and the package does not change ownership of provider files. Home, SSH credentials, editor data, and user-installed tools remain in their existing private storage.

Nextcloud read caches and unfinished uploads consume private workspace disk space. This version retains clean and dirty cached files without automatic eviction or a size limit. Plan capacity for that extra storage and do not delete the cache while uploads or recovery are pending.

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

This endpoint accepts the `dev` account and is separate from the StartOS host administration endpoint. There is no browser IDE interface.

Desktop VS Code forwards development ports through SSH. Temporary application ports do not need their own StartOS interfaces for that workflow. Applications, Git, runtime installers, and package managers may initiate outbound connections using the service's configured outbound route.

## Installation and First-Run Flow

The service creates persistent SSH host identity and an initially empty authorized-key set. An important setup prompt directs the user to register a public key; it does not prevent the SSH daemon from starting.

Until a key is registered, new SSH login attempts fail. Adding a valid key makes the account accessible. No setup wizard creates a password or gives ownership to the first network visitor.

The connection-information action provides the username, usable endpoints, public fingerprint, and client setup information. VS Code then installs its own server component under the user's persistent home.

## Actions

Key-management actions change access for the shared development account. They update the active key set without restarting the workspace or interrupting existing development processes.

**Configure Containers**, **Container Storage**, and **Clean Containers** manage the rootless Podman engine. Configuration requires the workspace to be stopped. Cleanup requires confirmation and removes unused images older than the configured age, including unused build layers. Containers, named volumes, projects, and Nextcloud uploads are retained. The default age is seven days. There is no total disk quota or automatic cache budget.

The **Packages** action group offers **Connect to StartOS**, **Disconnect from StartOS**, **Scan S9PK Packages**, **Cancel Package Scan**, **Browse S9PK Packages**, **Install S9PK Package**, and **Installation Status**. Server address and CA are discovered from StartOS. The package manager identity is independent of terminal `startos-target` profiles and build signing keys.

Scanning recursively reads the selected source: `/home/dev/projects`, `/projects-shared`, or both. Each completed scan replaces the catalog for that source selection. **Cancel Package Scan** stops only a scan and retains the previous completed catalog. It inspects package metadata and hashes complete files. It skips symlinks, `.git`, `node_modules`, `.venv`, and `venv`, and limits one scan to 2,000 candidate packages, 200,000 directory entries, depth 40, and approximately one hour. Files larger than 32 GiB are rejected. Incomplete scans and unreadable files are reported. Architecture comes from the manifest, not the filename.

Installation requires a selected compatible catalog entry and explicit confirmation. The manager copies that artifact to private local storage, verifies its SHA256 against the scan, and invokes authenticated `start-cli package install --sideload`. Trusted signers are required by default. **Allow an Untrusted Signer** applies to one explicitly selected installation; signature and archive integrity checks remain mandatory. Staging files are removed on completion or failure. At least the artifact size plus 512 MiB must be free before staging; StartOS also needs space to install it. The original project file is never removed or modified.

Only one background scan, authorization, or install operation runs at once. The status action shows its phase and the last 30 results. Success requires the server to report the expected installed version. A workspace restart marks an unfinished operation interrupted; verify the target service before retrying. This also applies when upgrading Dev Workspace itself.

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

Neither listener nor key-configuration health proves that an editor can bootstrap, an extension works, or a project passes its tests. Those outcomes need their own acceptance checks.

## Backups and Restore

Backups copy the `main`, `home`, and `docker` volumes. This includes repositories and uncommitted files stored in home, editor data, user runtime installations, authorized keys, SSH host identity, and complete Podman storage including named volumes. It also includes credentials stored in home and the separate root-owned package manager identity. Podman images and layers can substantially increase backup size. Database-specific recovery still requires verification.

The source selection, saved Nextcloud app password, and persistent upload cache are included. Canonical files at `/projects-shared` require the selected provider's own backup. A cache is not a complete backup of Nextcloud files. Restoring a cache can replay pending writes, so coordinate workspace and provider restores. Restoring the workspace does not recreate a missing provider folder. Recover pending uploads before changing the selected source.

StartOS stops the service during backup and restarts it afterward only if it was running before backup. SSH sessions, builds, tmux sessions, language servers, and development applications are interrupted. Unsaved editor buffers and running process state are not part of the backup.

Restore reuses the saved home and host identity while recreating ephemeral runtime paths. Connection information must be read again because the restored service can have a different address or assigned port. A permanent clone should receive a deliberate identity policy before both copies are used together.

No home directories are excluded as caches by this package. Optimize backup size only after confirming which data can be reconstructed. A project's local database needs its own consistency and recovery verification even when its files are inside a backed-up volume.

## Limitations and Differences

This is one trusted Linux account. Different SSH keys are different ways to access that account, not separate users or project permission boundaries.

The Nextcloud source uses WebDAV, preserving Nextcloud's processing of file operations. Direct mounts of its internal data directory are unsupported. To show FileBrowser-backed projects in Nextcloud, use its existing FileBrowser External Storage integration. That integration maps the provider tree for the selected Nextcloud users, not just the folder selected in Dev Workspace. Direct edits require index refreshes, and external renames can be treated as deletion and creation rather than preserving file identity. [Nextcloud data-directory guidance](https://docs.nextcloud.com/server/stable/admin_manual/desktop/troubleshooting.html), [package integration](https://github.com/Start9Labs/nextcloud-startos/blob/master/README.md#external-storage), [external change detection](https://docs.nextcloud.com/server/stable/admin_manual/configuration_files/external_storage_configuration_gui.html)

Nextcloud WebDAV does not provide a complete POSIX filesystem: symlinks, hardlinks, executable permission changes, and remote-change file notifications can differ from local storage. Avoid concurrent edits to the same file from multiple clients. Keep virtual environments, package-manager trees requiring symlinks, databases, and other filesystem-sensitive build data in private local storage. Use FileBrowser or private projects for workloads that require ordinary Linux filesystem semantics. [rclone mount limitations](https://rclone.org/commands/rclone_mount/)

The optional Podman engine supports local projects at `/home/dev/projects`. Shared provider paths are not mounted into the engine; do not use `/projects-shared` for container bind mounts or Dev Containers. Keep active container projects and database storage on native local storage. Remote SSH followed by Dev Containers avoids requiring a Docker installation on the client computer. Full package builds, cross-architecture builds, native lifecycle, and desktop Dev Containers are separate acceptance requirements. [Remote Docker development](https://code.visualstudio.com/remote/advancedcontainers/develop-remote-host)

The workspace does not automatically restart project applications after package restart, backup, update, or server reboot. tmux can preserve a session across a client disconnect while the service remains running; it does not preserve processes through the StartOS lifecycle.

Native macOS applications, launchd, Apple frameworks, and platform-specific provider tests still need their native execution environment. Linux availability also does not guarantee that every extension or native dependency supports every packaged CPU architecture.

The package does not copy Git credentials or signing keys from the computer. SSH agent forwarding is disabled, so choose a suitable dedicated remote credential or another explicit workflow.

## Quick Reference for AI Consumers

This summary identifies the package's operating surface. Runtime versions and image digests are maintained in source rather than duplicated here.

```yaml
package_id: dev-workspace
image: ./Dockerfile
architectures: [x86_64, aarch64]
subcontainers: [workspace, optional-workspace-podman]
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
  home/projects: /home/dev/projects in engine
package_only_files:
  - main/store.json
  - main/project-source.json
  - main/docker.json
file_models:
  - store.json
  - project-source.json
  - docker.json
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
actions:
  - connection-info
  - configure-docker
  - docker-storage
  - clean-docker
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
health_checks: [ssh, docker, ssh-connections, nextcloud, ssh-keys]
```

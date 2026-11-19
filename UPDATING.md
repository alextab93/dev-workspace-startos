# Maintaining Dev Workspace

This package combines several upstream components rather than wrapping one application release. Its package version tracks changes to the workspace contract. Component updates require image and native lifecycle validation appropriate to the change.

## Component sources

The Dockerfile and package lockfile are authoritative. The implementation uses these components:

| Component                    | Selection                                                    | Pin location                                        |
| ---------------------------- | ------------------------------------------------------------ | --------------------------------------------------- |
| Base image and supplied Node | `node:24.22.2-trixie-slim` with an immutable digest          | `Dockerfile` first `FROM`                           |
| mise                         | `2026.11.2`, separate x64 and arm64 archive checksums        | `Dockerfile` `MISE_VERSION` and architecture branch |
| Python and system libraries  | Debian trixie packages                                       | `Dockerfile` package installation                   |
| StartOS SDK                  | `3.1.1`                                                      | `package.json` and `package-lock.json`              |
| Package version | `0.5.0:1`, rootless Podman and S9PK package management | `startos/versions/current.ts` |
| Podman and Compose | Debian trixie Podman and podman-compose packages | `Dockerfile` package installation |
| Linux start-cli | `2.8.0`, architecture-specific SHA256 | `Dockerfile` binary verification |

Verify releases and checksums through their upstream sources before changing these pins. Do not infer an image's architecture support solely from its tag. Inspect the selected manifest and build the target package image.

User-installed runtimes under home are independent of the image. An image update must preserve them and must not silently replace project runtime selections.

The image includes PostgreSQL client development libraries and libvips for the inspected Ruby application dependencies. Debian trixie supplies libvips through [libvips42t64](https://packages.debian.org/trixie/libvips42t64). This dependency selection does not replace installing and exercising the project's actual gems.

## Updating the image

1. Verify the intended Node image release and immutable manifest digest.
2. Confirm x86_64 and aarch64 coverage before retaining both package targets.
3. Update the Dockerfile tag and digest together.
4. If mise changes, verify its release and replace both architecture-specific archive checksums.
5. Review Debian package changes affecting OpenSSH, Python, native gem compilation, or runtime linking.
6. Build the configured package image and exercise real SSH authentication, forwarding, file transfer, and preparation behavior.
7. Check `node --version`, `python3 --version`, and `mise --version` inside that image.
8. Verify the documented mise commands and at least one persistent additional runtime installation.

Do not add image-generated SSH host keys. The runtime preparation step creates each installation's identity in persistent storage.

## Updating package behavior

Keep the explicit `osVersion: '0.4.1'` minimum in the manifest while Web Preview HTTPS detection relies on StartOS forwarding-header policy. SDK `3.1.1` defaults to `0.4.0.2`, which predates HTTP policy on the plaintext connection. StartOS `0.4.1` accepts that SDK's older `addSsl` options and normalizes them to the newer HTTP proxy policy. An SDK upgrade is not needed just to rename those options. Validate actual HTTPS headers, plaintext spoof rejection, dynamic interfaces and retirement on the candidate before accepting native compatibility. The desktop companion separately uses SDK `4.1.0` and requires StartOS `0.4.2`.


Keep `README.md` and `instructions.md` aligned with the final actions, volumes, account, authentication policy, and lifecycle behavior.

Preserve existing user shell files and runtime configuration. Apply storage layout or account ownership changes through explicit versioned migrations. If `current.ts` contains a real migration, retain it in a version-named file and include it in the version graph before creating a new current version.

The `0.5.0:1` version graph preserves `0.1.0:0`, `0.2.0:0`, `0.3.0:0`, `0.4.0:0`, `0.4.1:0`, and `0.5.0:0`. Podman defaults to disabled. The upgrade does not rewrite an existing source, credential, cache, home, or SSH identity. A missing source still defaults to **Local projects only**. Earlier native results do not establish acceptance of new package behavior.

The SSH connection health check measures authenticated transports through a read-only probe of the running package SSH server. Do not replace it with a count of TCP sockets, terminal sessions, or username-bearing privileged monitor titles: those can count unauthenticated connections or multiply one transport. Verify zero, two independent connections, rejected authentication, forwarding-only connections, SFTP, connection sharing, and disconnection against real OpenSSH whenever its process model changes. Unreadable or unrecognized runtime state must report unavailable rather than a fabricated zero. The probe runs inside the subcontainer without opening an SSH connection of its own.

Maintain the user-facing distinction between key removal and active-session termination. Routine key management must not restart the workspace. The no-key setup prompt remains important and nonblocking so access can be restored without stopping existing development processes.

Any change that grants the development user access to a container engine must revisit filesystem and credential boundaries. Container support is not an image-only addition: it requires a storage policy, engine access policy, backup coverage, and actual Dev Containers or build acceptance for each capability claimed.

## External project source contract

**Configure Project Source** (`set-project-source`) is stopped-only. Its source selection is `none`, `filebrowser`, or `nextcloud`. FileBrowser requires an existing relative folder and FileBrowser Quantum `>=#quantum:2.0.2-stable:2`. The provider dependency requires installation, not a running daemon. Preserve the ability to select `none` when the provider is absent or saved source settings are invalid, provided no pending or unreadable Nextcloud upload state would be orphaned.

The action checks readability through a read-only provider mount. Missing directories must be rejected in ordinary configuration and startup paths. The selected folder is attached at `/projects-shared`, independently of `/home/dev` and `/home/dev/projects`; startup checks write access as `dev`, UID 1000. Do not copy, move, or recursively change ownership of provider files. The [provider manifest](https://github.com/Start9Labs/filebrowser-quantum-startos/blob/master/startos/manifest/index.ts) defines the shared package ID `filebrowser` and volume `data`.

Concurrent provider-side deletion or renaming during startup is unsupported. Between read-only preflight and the read/write attachment, the SDK can create an empty replacement directory if the original disappears. Compare the mounted directory's inode with the preflight identity and refuse workspace startup if it changed. This detects the changed source but does not promise that no empty directory was created during that race. Never treat an empty replacement as successful access to the original projects.

Keep project-source changes independent of SSH key maintenance. Keep home, credentials, editor files, and tool installations on their existing private mounts. Backups include `home`, `main`, and the saved selection; provider files require the provider's own backup. FileBrowser web-user permissions do not constrain the workspace's shared Unix account.

Do not add a writable mount of Nextcloud's internal data tree. Native Nextcloud projects use authenticated HTTPS WebDAV. Nextcloud also provides its existing FileBrowser External Storage mapping, with its own user scope and filecache refresh behavior. That mapping is broader than the selected Dev Workspace subfolder, and external renames may be represented as new files. [Nextcloud storage boundary](https://docs.nextcloud.com/server/stable/admin_manual/desktop/troubleshooting.html), [package integration](https://github.com/Start9Labs/nextcloud-startos/blob/master/README.md#external-storage), [change detection](https://docs.nextcloud.com/server/stable/admin_manual/configuration_files/external_storage_configuration_gui.html)

## Nextcloud WebDAV lifecycle

The manifest enables userspace filesystems for FUSE. The image supplies Debian rclone and fuse3. A single supervisor launches the mount and SSH daemon in one inherited mount namespace. Separate SDK exec processes cannot establish visibility of a dynamic mount, even when they share a subcontainer. Acceptance must read and write through an actual SSH session and corroborate exact bytes through Nextcloud WebDAV.

The Nextcloud dependency requires a running compatible service. New connections discover HTTPS transport from the SDK host interface addresses and choose a separate enabled browser URL. Prefer an enabled local IP for service access and preserve a previously selected origin while it remains available. The current Nextcloud package does not include the StartOS bridge hostname in its trusted domains, so a bridge URL can pass TLS verification but receive HTTP 400. Do not change the provider trusted-domain settings to work around that; use its existing enabled HTTPS addresses. Browser authorization uses Login Flow v2; the one-shot poll credential is persisted before OCS account lookup. The returned login name is used for authentication, while OCS account ID determines the WebDAV path. Runtime configuration is root-only. Add the StartOS root CA to system trust and validate hostnames. Reject redirects, foreign response origins, oversized data, unsafe XML, and secret-bearing diagnostics.

Connection state is separate from the active source. Opening the folder action finishes an approved authorization; saving a folder alone changes the active source after stopped-state checks, current-account verification, pending-upload protection, and a fresh directory preflight. Dynamic input forms are fixed when opened. Encoded account IDs in choices and submit-time checks reject stale selections. Browsing submits a navigation choice and requires reopening the native action.

Keep a browser source's explicit cache identity stable while the live discovered transport address changes. Legacy sources retain their original URL/account/folder identity. To adopt a legacy cache during browser reconnection, verify its origin against the installed Nextcloud's discovered enabled addresses and require its exact WebDAV account path to match the authorized OCS account. An unknown external origin or different account must not inherit that cache. Different folders remain distinct even for the same account.

Serialize helper state mutations and persist consumed poll credentials atomically with directory fsync. Replacing a completed connection retains its old record, because revoking it could race another action activating it. Completed grants are managed in Nextcloud Security; retained records are pruned only on definitive HTTP 401, never on transient failures. Cancelling an unapproved login does not invalidate its remote browser URL. Never describe it as revoked. Cancel only newly received credentials that cannot yet be selected, and preserve active sources.

Source changes refuse to orphan pending or unreadable state. Persist cache and account state in `main`, outside shared files and developer-writable home paths. Do not use age-based cleanup that can discard unfinished writes.

Cache maintenance runs every second. The positive `--vfs-cache-max-size` value follows the cache filesystem's total capacity so full-cache writes return an error instead of waiting indefinitely for the bundled rclone 1.60.1-DEV cleaner. Freeing space permits a retry. This is not a reserved budget or hard quota. Clean cache uses the longest supported duration for `--vfs-cache-max-age`, so it does not routinely expire after an hour. Pending writes and uncertain recovery state must remain protected. Treat cache growth as an operational limit and retest failure/recovery before changing these settings or updating rclone.

The current mount presents regular files as `0660`; a successful chmod does not establish executable-bit support. Native isolated checks observed working temporary-file replacement and rename, local watcher events for mounted writes, and an external WebDAV creation becoming readable without a watcher event during a ten-second observation. Symlink creation returned an I/O error, as did an offline npm install requiring a local dependency link; the same install and executable worked in private local storage. Keep binaries, linked dependency trees, virtual environments, databases and container projects on local storage. These are scoped runtime observations, not guarantees for every editor, backend, database or watcher implementation.

Shutdown must stop developer writers before draining uploads, retain unconfirmed writes after timeout, and stop the mount without opening a writable local fallback at `/projects-shared`. A successful save into a local write cache does not establish remote durability. Test actual Nextcloud bytes after upload, connection interruption and recovery, clean restart, wrong credentials, missing folders, source-switch rejection with pending writes, and safe cache preservation after forced termination.

Version 0.4.0 browser-authorization acceptance is recorded separately from the earlier direct-WebDAV and FileBrowser features. Native StartOS FUSE visibility, desktop behavior, and backup/restore remain unverified until their own evidence is recorded. [Nextcloud WebDAV API](https://docs.nextcloud.com/server/stable/developer_manual/client_apis/WebDAV/basic.html), [rclone WebDAV](https://rclone.org/webdav/), [rclone cache behavior](https://rclone.org/commands/rclone_mount/)

## Validation before accepting an update

Verify behavior through real inputs and observable outcomes. Do not assert SDK call counts, internal method ordering, or generated configuration shape as a substitute for working authentication and persistence.

Use Node 24 or newer, npm, Python 3, Docker with Buildx, and OpenSSH client tools. Run these commands from a checkout with its tracked bundled skill directory present. Dependency installation and the first image build require network access; the helper checks themselves use only disposable local fixtures.

Install locked dependencies, run the source checks, and build the current Dockerfile. Capture the resulting image ID so runtime checks use that exact build instead of an older tag:

```sh
npm ci
npm run check
npm run format:check
npm test
workspace_test_build=$(mktemp -d)
docker buildx build --load --tag dev-workspace:runtime-test --iidfile "$workspace_test_build/image-id" .
workspace_test_image=$(cat "$workspace_test_build/image-id")
export DEV_WORKSPACE_TEST_IMAGE="$workspace_test_image"
rm -r "$workspace_test_build"
npm run test:helpers
npm run test:runtime
```

This builds the local architecture by default. Stop if a command fails. The test runners do not build their image; rebuild after changing the Dockerfile, assets, or bundled skills. Record the source and exact image ID with the results. A foreign-architecture image requires working local emulation and does not establish native acceptance on that architecture.

`test:helpers` runs the package-manager, Nextcloud authorization, Nextcloud file/cache, terminal StartOS-target, and SSH-connection suites in separate disposable Linux containers. The source mount is read-only; no host ports, host engine socket, operator home, or external network are provided. The package suite creates a signed metadata-only S9PK with a temporary signing key, verifies real manifest/hash results, and deletes its fixture state. It needs neither `/fixture.s9pk` nor an existing packaging workspace, server enrollment, provider account, or private validation directory. That archive has no application runtime and must not be installed on StartOS. Manager installation tests fake the external CLI boundary; they do not establish native installation behavior.

To run only selected helper suites against an already built image:

```sh
python3 tests/containerChecks.py --image "$DEV_WORKSPACE_TEST_IMAGE" packages ssh-connections
```

The helper runner prints the exact image ID and architecture, returns failure if a suite fails, and removes its owned containers even after a failed run. The existing `test:runtime` suite exercises real SSH, SFTP, forwarding and persistent Docker volumes, with loopback-only host ports and disposable keys. It cleans up its own containers and volumes. Do not run individual root-only helper files directly on a live workspace; use the container runner.

The preview HTTP/WebSocket cases run in `npm test`. Run the browser suite separately so its listener ports do not overlap a simultaneous source test run:

```sh
npx playwright install chromium
npm run test:previews:browser
```

On Linux, install Playwright's documented system dependencies first, using `npx playwright install --with-deps chromium` in the intended test environment. The browser suite creates its own TLS material and application fixtures; it does not require a live StartOS interface. Native interface routing, TLS forwarding and lifecycle still need their own acceptance.

Packaging requires Python 3 and rejects generated Python bytecode under `assets`. Remove those generated cache files before retrying a rejected build. Asset-file changes are package inputs, so changing a preparation script or shell default causes the package to rebuild.

To test a separately built image, set `DEV_WORKSPACE_TEST_IMAGE` to its local tag or image ID:

```sh
DEV_WORKSPACE_TEST_IMAGE=dev-workspace:verified-local python3 tests/runtime.py
```

`npm run test:runtime` invokes the same Python runtime suite and accepts the same environment variables.

Run `npm ci` and `npm test` on Linux to exercise the SDK's real atomic-write behavior. On macOS, SDK file mutation scenarios are explicitly skipped because the SDK uses Linux `flock` and `/proc`. Those skips are outstanding validation, even when the local test command exits successfully.

Run Linux source tests as a regular user so permission-denial cases are exercised. Run `node --import tsx --test tests/dockerBackups.test.ts` as root inside a disposable Linux container to additionally exercise restoration of numeric ownership. The whiteout case also needs permission to create the `0:0` character device and explicitly skips where that is unavailable. These are filesystem-copy checks, not native StartOS backup consistency. Record both runs and their skips separately.

The Node 22 installation and persistence check is opt-in because it downloads an additional runtime. Enable it explicitly when validating that capability:

```sh
DEV_WORKSPACE_TEST_INSTALL_TOOLS=1 python3 tests/runtime.py
```

This check installs the selected Node 22 release under the fixture user's persistent home, recreates the container, and verifies that the selected runtime still executes. A default run skips this check, so a passing default run does not prove additional runtime installation or its persistence. The image-selection and installation variables can be combined in one invocation.

| Evidence category         | Required outcome                                                                                                                                                  |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source checks             | Package type checks, formatting, and focused behavioral tests pass                                                                                                |
| Image behavior            | Authorized keys work; unregistered keys, passwords, and root login fail; forwarding and file transfer work                                                        |
| Runtime selection         | Project runtime selection works in interactive and noninteractive sessions                                                                                        |
| Persistent data           | Restart and recreation retain file bytes, Git state, shell customizations, installed tools, and host fingerprint                                                  |
| Key maintenance           | Changes affect new authentication without terminating existing workspace processes                                                                                |
| Source selection          | Stopped-only changes validate existing readable folders; invalid input preserves state; disabling works without a provider and with invalid saved source settings |
| Shared project access     | The selected folder is writable as UID 1000; provider files retain ownership; private home remains separate; a changed directory identity prevents startup        |
| Native provider behavior  | Both-direction edits, Git operations, executable files, symlinks, and live reload work on the selected folder, including while the provider daemon is stopped     |
| Package artifact          | Correct package version, architecture, image contents, and signature are inspected                                                                                |
| Native update             | A real StartOS update retains login access and project state                                                                                                      |
| Native backup and restore | Saved source, uncommitted work, selected runtime, keys, and identity are restored on an isolated target                                                           |
| Desktop behavior          | Remote SSH opens a project; editing, a required extension, debugging, and forwarding work                                                                         |

Keep these evidence categories separate. A successful Docker test does not establish native StartOS lifecycle behavior, and an artifact build does not establish desktop compatibility.

Native acceptance of `0.2.0:0` passed on StartOS `0.4.1.2` x86_64 with FileBrowser Quantum `#quantum:2.0.2-stable:2`. Upgrade preserved private data and SSH identity. Shared file operations, actual desktop editing and debugging, forwarded live preview, an observed service restart, and recovery from missing, nonwritable, and malformed sources passed. Independent provider reads matched desktop-saved bytes and file identities. Disposable fixtures were removed and sharing was disabled after acceptance. These results are separate from the historical `0.1.0:0` validation and do not establish native aarch64, server reboot, backup/restore, or Nextcloud integration behavior.

FileBrowser web UI and search-index freshness were not tested. Distinguish immediate filesystem and editor behavior from the provider's indexed search results; [Quantum indexing](https://filebrowserquantum.com/en/docs/features/indexing/) has its own refresh schedule.

Build and inspect each supported architecture. When only one architecture has native runtime evidence, describe that limit accurately instead of extending the result to the other target.

## Release boundaries

Record the tested source revision, image digests, package bytes, target versions, and behavioral results before preparing a release. Keep personal deployment addresses, machine names, credentials, and local absolute paths out of shared records.

Building and testing an artifact does not publish it. Follow the user's explicit instructions for any commit, installation, tag, push, release, or registry operation.

## Podman and S9PK manager acceptance

The active engine path is `assets/workspace-podman.py`, `assets/podman-remote.py`, and the Podman daemon in `startos/main.ts`. The image installs the same remote client wrapper as both `podman` and `docker`. Existing `docker` volume, configuration, action and daemon identifiers remain compatibility names; `tests/docker.test.ts` and `tests/dockerBackups.test.ts` still validate the shipped settings and persistent storage behavior.

`assets/workspace-docker.py`, `assets/runc-nested.py`, and `tests/dockerRuntime.test.py` belong to the earlier rejected rootful Docker implementation. They remain in source for historical reference, are not selected by the current image's `COPY` instructions or active runtime, and are not part of `test:helpers` or `npm test`. Passing that Python suite would not validate Podman. Do not use its BuildKit cache budget, Docker storage report or nested-runc expectations as the current feature contract. The shipped cleanup action prunes age-filtered unused Podman images and retains containers and named volumes; it does not enforce a total storage quota. Future removal of the historical files should be a separate deliberate change.

The engine must remain UID 1000 with fuse-overlayfs storage and catatonit as PID 1. The candidate launcher starts as root only to create a private user and mount namespace, then permanently sets its real, effective and saved UID/GID to 1000 before starting Podman. Clear remote-client environment variables when launching the engine process itself. The workspace CLI connects over the fixed private Unix socket. Test image build, OCI archive export, a full signed S9PK build, project binds, named volume persistence, Compose, published ports, cleanup retention, and private-state isolation on StartOS.

The original rootless mapping covered container IDs 0 through 64535 and could not run Debian APT's group 65534. The candidate preserves container root at outer ID 1000 and IDs 1 through 64535 at outer IDs 1001 through 65535. New container IDs 64536 through 65534 map to outer IDs 1 through 999. Outer ID 0 is never delegated to Podman. The intermediate namespace maps `0:0:1`, `1000:1000:64536` and `65537:1:999`; only its private mount namespace sees subordinate ranges `1001:64535` and `65537:999`. Keep the gap between those ranges: a single merged extent cannot span the parent's discontinuous mapping. The image's original subordinate-ID files stay unchanged outside that namespace.

Do not append the lower range directly to the original `/etc/subuid` and `/etc/subgid`: Podman sorts it ahead of the existing range and changes existing ownership. No recursive ownership rewrite is needed for the candidate's preserved mapping. Verify actual image, container, named-volume and bind-mounted bytes and numeric owners across upgrades. Returning to the old launcher after creating data with the newly supported IDs is not a supported rollback. The isolated x86 launcher checks do not establish an installed upgrade, native ARM behavior or backup/restore acceptance.

Each candidate engine start mounts private tmpfs filesystems at `/run/user/1000` (256 MiB maximum) and `/dev/shm` (64 MiB maximum). These hold transient runtime and lock state; persistent container data stays in `/var/lib/containers`. The private filesystems prevent a restarted PID namespace from inheriting stale pause-process records and lock reservations. These sizes limit those filesystems, not container RAM. Keep `runAsInit` and catatonit so engine shutdown also ends its namespace helpers. Verify an active disposable container is stopped on shutdown, can be started again with its data, and survives a launcher crash as recoverable stored data. Project containers are not automatically restarted by this mechanism.

Keep the package manager in the same mount namespace as SSH and Nextcloud. A temporary SDK exec cannot prove visibility of the live FUSE mount. Scan and stage as UID 1000; keep authorization, catalog, history, and staging root-owned. Accept fixed operations only over a root-only Unix socket. Never use project files as executable instructions for the installer, inherit ambient StartOS credentials, log the server password, or default to bypassing signer trust.

Verify valid and invalid package metadata, filename-independent architecture selection, symbolic-link rejection, changed-file rejection, explicit confirmation, unavailable authorization, untrusted-signer rejection, actual installation, original-file preservation, restart interruption reporting, and disposable staging cleanup. Use real package archives for manifest inspection. An external CLI fixture can test error handling, but does not establish native installation acceptance.

Run the SSH and Nextcloud supervisor under catatonit with `runAsInit: true`, giving it a PID namespace separate from the engine. Nextcloud shutdown terminates UID1000 writers visible in its own namespace before draining uploads. It must not discover and terminate the separate Podman engine while doing so. Validate engine and Nextcloud readiness after a workspace restart.

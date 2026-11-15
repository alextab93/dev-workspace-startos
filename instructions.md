# Dev Workspace

## Documentation

- [VS Code Remote SSH](https://code.visualstudio.com/docs/remote/ssh): desktop connections, extensions, debugging, and forwarded ports.
- [mise tools](https://mise.jdx.dev/dev-tools/): selecting project language runtimes.
- [OpenSSH client configuration](https://man.openbsd.org/ssh_config): SSH client options.

## What you get on StartOS

Use desktop VS Code to work in `/home/dev/projects` on the server. You can also select an existing FileBrowser Quantum or Nextcloud folder at `/projects-shared`. Files, dependencies installed in your home directory, editor settings, and extensions are persistent. Terminal commands run on the server.

You connect as `dev` with an SSH public key. Every key you register grants access to the same account, projects, and credentials, so register keys only for devices you trust with that workspace.

The **SSH Connections** health check shows authenticated connections and refreshes every 10 seconds. It includes VS Code, terminal, SFTP, and tunnel connections. A shared SSH connection counts once even if it carries several sessions. Zero is normal; the count does not represent individual people or VS Code windows.

## Getting set up

1. Choose an existing SSH key on your computer or create a new key using your preferred SSH client. Keep the private key on your computer.
2. Run **Add SSH Key** and paste the public key. Give it a label that identifies the device.
3. Run **Connection Information**. Choose an endpoint reachable from your computer, copy its host configuration, and set `IdentityFile` to the private-key path on that computer. Compare the provided public host-key fingerprint when your SSH client first connects.
4. Install the **Remote - SSH** extension in desktop VS Code if it is not already installed.
5. Run **Remote-SSH: Connect to Host...** in VS Code and select the connection you configured.
6. Open `/home/dev/projects`, then clone or create a project there.

Use the service address and port returned by **Connection Information**. The SSH connection is for this workspace, and its assigned port may differ from `2222`.

VS Code installs its server component on the first connection. If that step fails, inspect the Remote SSH output in VS Code and the service logs. The client can download the editor server locally and transfer it when direct remote download is unavailable.

## Using a FileBrowser Quantum folder

This is optional. The default **Local projects only** selection keeps projects in your private workspace home. FileBrowser Quantum must be installed at version `>=#quantum:2.0.2-stable:2`; it can be stopped while Dev Workspace uses its files.

1. Create or choose an existing folder in FileBrowser Quantum, such as `Projects`. Use its relative path within the provider's file tree.
2. Save your work and stop Dev Workspace. Stopping ends its terminals and running applications.
3. Run **Configure Project Source**, select **FileBrowser Quantum**, and enter that folder path. The action checks that the folder is readable.
4. Start Dev Workspace and open `/projects-shared` in VS Code. Startup checks that the `dev` account can write there.

The folder stays in FileBrowser Quantum. Existing files are not moved, copied, or given a different owner. `/home/dev/projects` remains available, and your home, credentials, editor data, and installed tools stay private. Every registered workspace SSH key can access the selected folder; FileBrowser web-user restrictions do not limit that access. [FileBrowser storage layout](https://github.com/Start9Labs/filebrowser-quantum-startos/blob/master/README.md#volume-and-data-layout)

Do not rename or delete the selected folder while Dev Workspace starts. If the folder is missing, its identity changes during startup, or write access fails, resolve the folder issue before retrying. To disconnect the source, stop Dev Workspace and choose **Local projects only**. This recovery option also works when the provider is missing or the saved source settings are invalid. No files are deleted and no SSH keys need to be registered again.

FileBrowser's search results can lag changes made through VS Code. If you also want the folder visible in Nextcloud, use Nextcloud's existing FileBrowser External Storage integration. Its mapping can expose the whole provider tree to the selected Nextcloud users, beyond this workspace's chosen folder. External edits need index refreshes, and renamed items may lose their previous Nextcloud file identity. Direct access to Nextcloud's internal data directory is not supported. [FileBrowser indexing](https://filebrowserquantum.com/en/docs/features/indexing/), [Nextcloud integration](https://github.com/Start9Labs/nextcloud-startos/blob/master/README.md#external-storage), [Nextcloud external change detection](https://docs.nextcloud.com/server/stable/admin_manual/configuration_files/external_storage_configuration_gui.html)

## Using a Nextcloud folder

1. Keep Nextcloud running and create or identify the project folder you want to edit.
2. Save your work and stop Dev Workspace. Open **Configure Project Source**, select **Nextcloud**, and submit. The service address is discovered automatically.
3. Open the authorization link, sign in to Nextcloud if needed, and grant access to Dev Workspace. Your normal password stays in the Nextcloud sign-in page; the connection receives its own app password. Return to StartOS after approval.
4. Open **Choose Nextcloud Project Folder**. Choose **Use folder** for the folder you want. To reach a nested folder, select **Browse folder**, submit, then reopen the action to see its children. Only folders that permit editing offer **Use folder**.
5. Start Dev Workspace, reconnect desktop VS Code, and open `/projects-shared` or a project beneath it.

An existing connected account is reused when you select Nextcloud again. **Connect Nextcloud Account** starts a new authorization when you want another account or need to reconnect. Authorization links expire after 20 minutes. **Cancel Nextcloud Setup** preserves the active project source; close any unfinished authorization tab and let its link expire. Completed grants can be revoked in Nextcloud personal **Security** settings. [Nextcloud Login Flow](https://docs.nextcloud.com/server/stable/developer_manual/client_apis/LoginFlow/index.html#login-flow-v2)

Authorizing an account does not switch the active project source. The change happens only when you save a folder. Edits then upload to the original Nextcloud files through its API. Private projects at `/home/dev/projects` remain available. The generated app password is kept in private service storage and is never shown in the source form or connection output.

A saved editor buffer can still be waiting in the workspace upload cache. Check **Nextcloud Project Files** and leave the workspace running until uploads finish. If access fails, reconnect the same account and choose the same project folder. Existing cached writes are retained, and changing to another destination is blocked while uploads are pending or their state cannot be read. Keep the cache until recovery completes.

Existing connections from version 0.3 continue using their saved settings. The new browser flow connects to the Nextcloud installed on this StartOS server. It can preserve a legacy cache during reconnection only when the old address is verified as an enabled address of that Nextcloud and the authorized account matches.

Clean cached files also remain in private workspace storage; this version has no automatic eviction or cache size cap. Plan capacity for those cached reads and writes.

Back up original files in Nextcloud. Workspace backups include account authorization state, app passwords, and the private upload cache, which is not a complete Nextcloud backup. Coordinate restores to avoid replaying older pending edits over newer files.

WebDAV has filesystem limitations. Use private local storage for Python virtual environments, databases, package-manager trees requiring symlinks, and filesystem-sensitive build outputs. Remote edits from another Nextcloud client may appear after cache refresh and may not trigger a local watcher. Avoid editing the same file concurrently in multiple clients. [Filesystem and caching behavior](https://rclone.org/commands/rclone_mount/)

## Choosing project runtimes

Node, npm, Python, Git, compilation tools, and mise are available in the workspace. Check the supplied versions with:

```sh
node --version
npm --version
python3 --version
mise --version
```

To select a different runtime for one project, open a terminal in that project's directory. For a project requiring Node 22:

```sh
mise use --pin node@22
node --version
npm ci
```

`mise use` installs the runtime and writes the selection to the project's configuration. `--pin` records the resolved version. Review the resulting project file before committing it. See [mise use](https://mise.jdx.dev/cli/use.html) for selection options.

For a Ruby project, choose the version that matches its requirements. These examples select one version in the current project:

```sh
mise use ruby@3.3.12
ruby --version
```

Or, in a project requiring Ruby 3.4.5:

```sh
mise use ruby@3.4.5
ruby --version
```

Install the Bundler version recorded by that project's lockfile before installing its gems. Ruby installation may download a binary or compile from source, which can take time and additional memory. Runtime installations remain under your persistent home.

For Python dependencies, create a virtual environment inside the project:

```sh
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements.txt
```

Use the dependency file appropriate to your project. System package installation requires an image update; this account has no sudo access.

The workspace makes mise shims available to remote commands as well as interactive terminals. Run commands from the project directory so mise can find its configuration. For an explicit runtime environment, use:

```sh
mise exec -- node --version
```

Keep custom shell startup output limited to interactive sessions. Printing banners during every SSH command can prevent VS Code from connecting.

## Running and previewing projects

Run your project's development command in the remote terminal. Open VS Code's **Ports** view and forward the application's listening port, then open the forwarded address in your computer's browser.

Use different listening ports for projects running at the same time. For example, one project can listen on `3000` and another on `5173`. Live reload and WebSockets also depend on the project's host and development-server configuration.

Use a tmux session when a command should continue after closing the editor or losing the client connection:

```sh
tmux new-session -A -s development
```

tmux sessions end when the workspace service stops. Restart project applications after a service restart, backup, update, or server reboot.

## Managing access

Use **List SSH Keys** to inspect registered public fingerprints and labels. Use **Add SSH Key** for another trusted device and **Remove SSH Key** when a device should no longer establish new connections.

Key changes do not restart your workspace. Removing a key does not disconnect an already authenticated session. Removing the last key leaves the service running, but new logins fail until you register another key through StartOS.

Your workspace login does not configure private Git repositories or commit signing. Set up the Git credential and signing method you intend to use inside the remote workspace. SSH agent forwarding is disabled.

## Containers and disk usage

Stop Dev Workspace, open **Configure Containers**, enable Podman, and start the service again. Keep container projects in `/home/dev/projects`. Your selected Nextcloud or FileBrowser folder remains available at `/projects-shared` for shared files and package artifacts.

Use `podman build`, `podman run`, and `podman compose` from the remote terminal. The supplied `docker` compatibility command also uses Podman. Docker-specific plugins and flags are not universally compatible. For desktop Dev Containers, select `podman` as `dev.containers.dockerPath`; compatibility depends on the project's configuration and extensions.

Use **Container Storage** to inspect disk use and **Clean Containers** to remove unused images older than the configured age, seven days by default. This includes unused build layers. Containers, named volumes, projects, and Nextcloud uploads are retained. Removed images may need downloading or rebuilding. There is no automatic total storage limit. Cleanup affects this server's workspace engine; existing Docker data on your computer is separate.

## Building and installing StartOS packages

Build packages from local storage under `/home/dev/projects`, inside a packaging workspace initialized with `start-cli s9pk init-workspace`. This creates a separate build signing key. Your Mac's keys and accounts are not copied automatically.

For a standard StartOS package:

```sh
STARTOS_USE_PODMAN=1 make x86
```

Use `make arm` for an ARM target with a compatible builder. Native builds match the server architecture; cross-architecture execution is not configured by this package. Build files and dependencies stay on server storage.

The **Packages** actions provide a library of completed `.s9pk` files from local projects and `/projects-shared`:

1. Run **Scan S9PK Packages**, choose local projects, shared projects, or both, and check **Installation Status** until the scan finishes. Large packages take time to read, especially over Nextcloud.
2. Open **Browse S9PK Packages** to see versions, architectures, file sizes, and paths. Only compatible packages can be selected for installation.
3. Use **Connect to StartOS** once and enter this server's password in its masked field. The address and public CA are discovered automatically. The password is not saved; a dedicated server administration identity is retained outside project storage.
4. Open **Install S9PK Package**, select the artifact, review the installed and candidate versions, and confirm. An upgrade can restart the selected service.
5. Open **Installation Status** to follow local staging, upload, and the final result.

Use **Cancel Package Scan** to stop a long discovery operation without restarting the workspace. The last completed catalog is retained. Choose **Local Projects** for a quick scan of server builds, or **Shared Projects** for your selected provider folder.

The original shared file stays in place. Installation uses a verified local copy and does not pass through your computer. If the artifact changes after scanning, scan it again. Files must be regular files of at most 32 GiB; symlinks and dependency directories are skipped. The browser reports incomplete scans when their limits are reached.

Keep **Allow an Untrusted Signer** disabled for packages with trusted signers. Enable it only for an artifact whose source you trust, such as your own local build. StartOS still checks its signature and integrity.

If Dev Workspace stops during an operation, check the target service in StartOS before retrying. Updating Dev Workspace itself interrupts its manager, so verify the resulting version directly in StartOS. **Disconnect from StartOS** revokes and removes the manager's identity without changing projects or installed services. Terminal access through `startos-target` is a separate authorization.

## StartOS and development tools

Linux `start-cli`, `gh`, and GnuPG are included. Set up a dedicated StartOS identity from your SSH terminal:

```sh
startos-target add-local
startos-target login local-server
startos-target run local-server package list --format json
```

The first command discovers this server's internal HTTPS address and public CA. The login command prompts interactively and enrolls a new identity. The helper stores that identity in your private home; it does not copy credentials from your computer or save the master password. All workspace login keys share that home and can use its saved credentials. Treat StartOS access as server-management authority.

Use `startos-target add NAME --url HTTPS_URL --ca-file CA_FILE` for another server. Existing profiles are preserved. Package signing uses a separate build key, and GitHub access and Git signing require their own setup. A generic StartOS skill is available in `~/.agents/skills/startos-server`; existing user skills are preserved.

Codex and project-specific language runtimes can be installed into persistent user storage. Configure their accounts and integrations on the remote host. Linux browser tests also need their browser binaries and system dependencies; existing Mac browser sessions and connected tools do not automatically become available inside the workspace.

## Backups and interruptions

Backups include your home directory and its saved project files, runtime installations, editor data, workspace SSH identity, and Podman storage including named volumes. They also include saved credentials, including the package manager identity. Podman layers and images increase backup size.

The shared-source selection is saved, but the original files at `/projects-shared` need their provider's backup. Back up FileBrowser Quantum or Nextcloud separately. The Nextcloud app password and upload cache are private workspace state and are included; coordinate their restore with the provider before resuming uploads.

A backup stops the workspace temporarily, interrupting active terminals, applications, and builds. Save your work and choose backup times that fit your development schedule. Running processes and unsaved editor buffers are not restored from backup.

After restoring the workspace, use **Connection Information** again to get its current address and port. Your saved projects and registered keys are restored, and the workspace retains its saved SSH identity.

## Limits to plan for

Docker is optional and uses local project storage. Configure development databases deliberately, preserve their volumes, and verify their recovery. Cross-architecture builds and operating-system integration tests require additional builders, emulation, or suitable guests. A successful image build does not prove those workflows.

The workspace is Linux. Native macOS applications and Apple-specific tests still need a Mac. CPU-specific extensions and native dependencies may need a compatible build.

If you publish SSH through a tunnel to keep the server's origin address private, send the workspace's outbound traffic through that tunnel too. Git hosts, package registries, and runtime download servers otherwise receive connections through its normal outbound route. No route change is needed when the tunnel is used only for reachability.

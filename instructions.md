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

## Using the browser desktop

The optional **Dev Workspace Desktop** service runs desktop VS Code in a browser. Set it up separately using its StartOS instructions: generate its desktop password, run its explicit editor installation, and open its authenticated interface. Its password and keyring are separate from your StartOS account.

1. In the companion, run **Prepare Workspace Key** and copy the public key.
2. Here in Dev Workspace, use **Add SSH Key** to authorize that public key. Leave its private key in the companion.
3. Copy the host fingerprint from this service's **Connection Information**.
4. In the companion, run **Connect to Dev Workspace**, enter that fingerprint and choose **Local Projects** or **Shared Projects**. The connection discovers the address and checks SSH access and the selected folder. Connecting restarts the companion, so save its work first.
5. Install **Remote - SSH** through VS Code's Extensions view, then open the `dev-workspace` target. Confirm the remote indicator before opening `/home/dev/projects` or `/projects-shared`.

Use the remote terminal for project commands. It runs as `dev` with this workspace's runtimes, Podman and package tools. Container projects belong under `/home/dev/projects`; opening a shared folder does not make it available for container bind mounts. A local window in the companion uses the companion's own environment.

UI extensions remain in the desktop; remote language tools use the workspace extension host where supported. Check **Local - Installed** and **SSH: dev-workspace** in Extensions. Let each extension use its supported location. Git, coding agents and StartOS tools need their own account setup. [Remote SSH extensions](https://code.visualstudio.com/docs/remote/ssh#_managing-extensions).

For applications, follow [Running and previewing projects](#running-and-previewing-projects). The companion's **Ports** panel forwards to that desktop's localhost, which its built-in Browser can open. A Web Preview URL opens directly in your computer's browser. Closing the streamed desktop does not stop commands retained in tmux in the running workspace.

To revoke the companion, remove its public fingerprint here with **Remove SSH Key**. Its **Forget Workspace Connection** action only clears the local target and retains the key. Already authenticated sessions require separate termination. Back up the companion separately for its editor preferences, extensions, keyring and pairing identity.

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

Cached reads and unfinished uploads need free server storage. A full cache can make a save fail with an I/O error. Free space without deleting pending cache data, then retry the failed save and wait for uploads to finish. The cache recovery ceiling follows the filesystem's total capacity; it is not a reserved budget or a hard quota. Clean files have long retention, so plan capacity for cached reads as well as writes.

Back up original files in Nextcloud. Workspace backups include account authorization state, app passwords, and the private upload cache, which is not a complete Nextcloud backup. Coordinate restores to avoid replaying older pending edits over newer files.

The Nextcloud mount has fixed file permissions: `chmod +x` can report success while the file remains non-executable. Symlinks are unsupported, so dependency installs that create links can fail with an I/O error. Keep runtime installations in private home storage. Use local projects under `/home/dev/projects` for Python virtual environments, linked dependency trees, database files and container projects. A successful cached save is not proof of database durability.

Editor-style saves and renames upload to the provider afterward; wait for pending uploads to finish. Changes made through the mount can trigger local watchers, while edits from another Nextcloud client may appear after cache refresh without a watcher event. Reload the files or enable a project-specific polling watcher when needed. Avoid editing the same file concurrently in multiple clients. [Filesystem and caching behavior](https://rclone.org/commands/rclone_mount/)

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

To open an application through a temporary StartOS interface:

1. Start the application in the remote terminal. For Rails, use your project's normal startup command, for example `bin/rails server -b 127.0.0.1 -p 3000`.
2. Run **Set Web Preview Password** once in the **Web Previews** action group. Save the generated password; it is shown only once.
3. Run **Add Web Preview**. Enter a name, the application's port, and a duration. The default is one hour; the maximum is 24 hours.
4. Open the returned HTTPS link or the named interface in **Interfaces**, then sign in with the preview password. Use the assigned address shown there, which can have a different port from your application.
5. Use **List Web Previews** for the address, availability and expiry time. **Extend Web Preview** keeps it available longer. **Remove Web Preview** closes access now.

Dev Workspace requires StartOS `0.4.1` or later. Preview creation, HTTPS access at the assigned address, removal and expiry were verified with Dev Workspace `0.6.0:2` on x86 StartOS `0.4.2`. Preview behavior on StartOS `0.4.1` still needs native verification. An installation that does not show **Web Previews** can continue using SSH port forwarding.

Enter the application's listening port, such as `3000`, in the form. Open the HTTPS URL returned by StartOS, including its assigned external port. Do not replace that external port with `3000`, the SSH port, or a preview listener port. For example, if StartOS returns `https://preview.example.net:45678/`, the browser origin is `https://preview.example.net:45678` and the application may still listen on `127.0.0.1:3000`.

You can keep up to eight previews active, each with a distinct name and application port. If the app is still starting, the action shows a waiting state; opening the preview can report that the app is unavailable. Start or repair the application on its selected port and reload. A stopped app does not cause Dev Workspace to restart.

### Direct processes and Compose

Run a direct Rails process in its project directory:

```sh
bin/rails server -b 127.0.0.1 -p 3000
```

Use the project's installed runtime and usual environment variables. A direct Vite process can use `npx vite --host 127.0.0.1 --port 5173 --strictPort`. Select `5173` when adding that preview. If a framework needs the preview origin before it starts, create the preview on its intended port, copy its assigned URL, configure the application, and start it. The waiting state is expected until it listens.

Applications in Podman need a published workspace port. For an application that listens on port 3000 inside its container, a Compose service can include:

```yaml
services:
  app:
    build: .
    ports:
      - "127.0.0.1:3000:3000"
```

The container's application must listen on its container network interface, usually `0.0.0.0:3000`. Choose application port `3000` in Add Web Preview. Keep this Compose project under `/home/dev/projects`; `/projects-shared` is not an engine bind-mount location.

Start it from that local project directory with `podman compose up --build`. `podman compose stop` stops its applications; removing a preview only closes browser access. Avoid `down --volumes` when database or other named-volume data should survive. Podman is the engine; the workspace's `docker` command is a compatibility wrapper.

### Vite and Rails on one browser origin

The validated frontend profiles used Vite `8.2.1` and `8.2.2`; the Rails profile used Rails `8.0.5.1`. The browser opens the Vite preview, and Vite forwards relative API requests to the backend. This preserves one browser origin for login, cookies and CSRF checks. Keep the application's origin checks and host validation enabled. The example uses the selected Rails application's `/v1` and `/up` routes; use your project's actual API and health paths.

For a project whose existing `vite.config.mjs` exports a configuration object, create a separate `vite.preview.mjs` beside it. Preserve the original plugins, root and build settings:

```js
import { mergeConfig } from 'vite'
import original from './vite.config.mjs'

const origin = new URL(process.env.PREVIEW_ORIGIN)
if (origin.protocol !== 'https:') {
  throw new Error('PREVIEW_ORIGIN must use the assigned HTTPS address')
}

export default mergeConfig(original, {
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    allowedHosts: [origin.hostname],
    origin: origin.origin,
    hmr: {
      protocol: 'wss',
      host: origin.hostname,
      clientPort: Number(origin.port || 443),
    },
    proxy: {
      '/v1': { target: 'http://127.0.0.1:3000', changeOrigin: false },
      '/up': { target: 'http://127.0.0.1:3000', changeOrigin: false },
    },
  },
})
```

Replace the example origin below with the HTTPS address from **List Web Previews**, then start the frontend:

```sh
PREVIEW_ORIGIN='https://preview.example.net:45678' npx vite --config vite.preview.mjs
```

The allowed hostname has no scheme or port. HMR uses the external HTTPS port, or `443` if the URL omits it. `strictPort` prevents Vite from silently choosing a different application port. Review any inherited host allowances; do not retain `allowedHosts: true` or a wildcard allowance. The tested profile uses `server.hmr`; current Vite 8 documentation also provides `server.ws` and retains the older options as aliases. Follow your project's locked version when updating it. [Vite server options](https://v8.vite.dev/config/server-options)

For Compose, change Vite's listen host to `0.0.0.0`, publish `127.0.0.1:5173:5173`, and replace its API target with the Rails service name, such as `http://rails:3000`. Rails must listen on `0.0.0.0:3000` inside that container. The browser still uses the Vite preview URL, not the Compose service name. A separate API preview is unnecessary for this arrangement.

Rails must allow the actual preview hostname and preserve the browser's scheme, host and port through the local proxy chain. In a dedicated HTTPS development profile, set `config.hosts` to the exact hostname list. The tested Rails application uses `config.assume_ssl = true` behind TLS termination; apply that only to a profile reached through the HTTPS preview. Preserve secure cookies, CSRF/origin validation and narrowly scoped trusted-proxy settings. If a form fails its origin check, compare the browser origin with Rails' perceived request URL instead of disabling the check. [Rails host authorization](https://guides.rubyonrails.org/v8.0/configuring.html#actiondispatch-hostauthorization), [Rails SSL assumption](https://guides.rubyonrails.org/v8.0/configuring.html#config-assume-ssl)

### Development styling with a strict CSP

The tested Rails frontend includes an HTML Content Security Policy with `script-src 'self'` and `style-src 'self'`. Vite injects style elements during development, so that policy initially produced an unstyled page. The accepted development profile kept the production HTML unchanged and generated a new nonce for each served HTML response.

For that specific HTML policy, create `vite.preview-csp.mjs`:

```js
import { randomBytes } from 'node:crypto'

export default {
  name: 'workspace-preview-csp',
  apply: 'serve',
  transformIndexHtml: {
    order: 'post',
    handler(html) {
      const nonce = randomBytes(24).toString('base64')
      return html
        .replaceAll('WORKSPACE_PREVIEW_NONCE', nonce)
        .replace(
          /<(script|style|link)\b(?![^>]*\snonce(?:\s|=))/gi,
          `<$1 nonce="${nonce}"`,
        )
        .replace("script-src 'self'", `script-src 'self' 'nonce-${nonce}'`)
        .replace("style-src 'self'", `style-src 'self' 'nonce-${nonce}'`)
    },
  },
}
```

Import it as `previewCsp` in `vite.preview.mjs`. Add `html: { cspNonce: 'WORKSPACE_PREVIEW_NONCE' }` and `plugins: [previewCsp]` beside `server` in the `mergeConfig` override. The transform fills Vite's nonce meta tag, assigns the nonce to existing script/style/link elements, and updates the policy. Assigning those attributes explicitly avoids Vite's later pass adding the literal placeholder. Keep ordinary production builds on the original config. [Vite HTML nonce option](https://v8.vite.dev/config/shared-options#html-cspnonce)

This transform is specific to that existing HTML meta policy. If your application sends CSP as an HTTP header, generate and propagate the same per-response nonce in that header as well; editing only a meta tag cannot relax a separate header policy. Never use the literal placeholder or one fixed nonce in delivered HTML. Do not remove CSP or add broad inline-script permissions to fix development styling. Check the browser console and inspect the rendered page after configuring your project's own policy.

### Access, expiry and interruptions

Rails Action Cable and other browser WebSocket clients need the same preview origin with the current proxy. The selected Rails stack uses a server-to-server mail WebSocket, not Action Cable; its tested browser connection was Vite HMR. Positive split-origin browser WebSocket support is unverified. Split-origin frontend/API HTTP requests need the application's exact CORS allowlist, appropriate cookie policy, and a signed-in preview session on the API origin as well. The tested Rails profile intentionally rejects those cross-origin requests.

Removing or expiring a preview closes browser access and its live connections, while the application continues running. Its custom domain and interface networking choices are removed too. Recreating it makes a new interface; read its new address. StartOS Interfaces controls where the interface is reachable.

Durations are 1 minute, 15 minutes, 1 hour, 4 hours or 24 hours. **Extend Web Preview** measures the selected duration from now and keeps any existing later expiry. An expired preview cannot be renewed; create a fresh one after interface cleanup. Closing the browser does not remove a preview. Stopping the app does not remove its lease, and starting that same port again makes it available for the lease's remaining time. Use StartOS interface controls deliberately when sharing access; the action does not configure DNS, routers or tunnels.

Rotating the password signs out all previews. A proxy restart requires signing in again. Preview passwords do not replace your application's login. When running multiple apps on one hostname, use different application cookie names or separate hostnames to avoid cookie collisions across ports.

After restoring a workspace backup, set a new preview password and recreate any previews you want. Temporary access is revoked during restoration. If preview health reports a storage or clock problem, repair that problem and retain the expiry history; do not delete state to force a preview open.

If health or **List Web Previews** reports invalid preview records, those previews are closed while valid previews keep working. Use **Remove Invalid Web Previews**, then create fresh previews for the affected applications after interface cleanup. This removes damaged preview records and their old interface settings; it preserves valid previews and your application files.

### Troubleshooting previews

| Symptom | What to check |
| --- | --- |
| No link or interface is being prepared | Wait briefly, run List again, and check that the named interface has an enabled HTTPS address. Use that address rather than guessing a port. |
| Waiting for the application, or HTTP 502 after sign-in | Check the app's logs and `curl -i http://127.0.0.1:3000/` in the remote terminal, substituting its actual port and route. For Compose, check both its published workspace port and its internal listen address. |
| Application port accepts connections but the page fails | Availability detects an open TCP listener. It does not prove the app serves valid HTTP, has a working database, or accepts the preview host. Inspect its response and logs. |
| HTTPS or certificate error | Use the HTTPS interface URL and install the relevant StartOS CA trust on the client if required. Do not bypass certificate validation or open the application's internal HTTP port as the preview. |
| Preview sign-in appears again | A new origin, password rotation or proxy restart needs a new preview session. Also sign in to the application if it has its own login. |
| Blocked hostname, failed form or missing login cookie | Check the exact allowed hostname, HTTPS request origin, forwarded scheme and app cookie policy. Keep host/origin checks enabled. |
| Page works but live updates fail | Check WSS uses the actual preview hostname and external port, the lease is active, and the page is signed in. Recheck the config when a recreated interface gets a different URL. |
| Page is unstyled or the console reports CSP violations | Apply the project's development nonce policy and confirm the nonce changes between HTML responses. Check both response headers and HTML policy. |
| HTTP 410, closed preview or disconnected live update | Check expiry and preview health. Create a new lease if it expired. A storage or clock error requires repairing that condition; keep the retained state. |
| Add reports duplicate port, capacity or cleanup pending | Use a distinct port/name, remove an unused preview, or wait for interface retirement. Handle quarantined records through Remove Invalid Web Previews. Do not edit state files to force slot reuse. |

### Keeping a command running

Use a tmux session when a command should continue after closing the editor or losing the client connection:

```sh
tmux new-session -A -s development
```

Inside that session, enter the project directory and start its usual command. Press `Ctrl+b`, release the keys, then press `d` to detach while leaving the command running. After reconnecting through SSH or the remote editor, run the same tmux command to return to the session. Use `tmux list-sessions` to see retained sessions. Stop the application normally when you finish; detaching does not stop it.

| Event | What to expect |
| --- | --- |
| Close the desktop browser tab | The desktop application remains in its service. A tmux command in Dev Workspace continues while the workspace runs. Reopen the desktop interface to reconnect. |
| Disconnect SSH or close the remote editor | An attached tmux command continues. Reconnect and reattach. A command started directly in an ordinary terminal has no package-level continuity guarantee. |
| Stop or restart only Dev Workspace Desktop | The GUI and its SSH connection are interrupted. Project processes belong to the separate Dev Workspace service. |
| Stop Dev Workspace, including for an update or backup | Workspace processes and tmux sessions end. Saved files and retained container data are distinct from running processes. |
| Reboot the server | Expect the workspace's application processes and tmux sessions to end. After the service is available, reconnect and start your project commands again. |
| Remove or expire a Web Preview | Browser access ends. The preview does not stop, launch or supervise the application. |

The startup policy is manual: after a workspace restart, backup, update or server reboot, relaunch the project's application commands or Compose stack and check its health. Neither Webtop nor a preview lease restarts Rails, databases or arbitrary commands. Native tests verified tmux across SSH disconnection and desktop-browser closure; full server reboot and backup/restore acceptance remain separate.

## Managing access

Use **List SSH Keys** to inspect registered public fingerprints and labels. Use **Add SSH Key** for another trusted device and **Remove SSH Key** when a device should no longer establish new connections.

Key changes do not restart your workspace. Removing a key does not disconnect an already authenticated session. Removing the last key leaves the service running, but new logins fail until you register another key through StartOS.

Your workspace login does not configure private Git repositories or commit signing. Set up the Git credential and signing method you intend to use inside the remote workspace. SSH agent forwarding is disabled.

## Containers and disk usage

Stop Dev Workspace, open **Configure Containers**, enable Podman, and start the service again. Keep container projects in `/home/dev/projects`. Your selected Nextcloud or FileBrowser folder remains available at `/projects-shared` for shared files and package artifacts.

Use `podman build`, `podman run`, and `podman compose` from the remote terminal. The supplied `docker` compatibility command also uses Podman. Docker-specific plugins and flags are not universally compatible. Podman's build compatibility uses Buildah; `docker buildx inspect` is unsupported.

For Dev Containers, install Microsoft's **Dev Containers** extension in your desktop VS Code, connect with Remote SSH, and open a project under `/home/dev/projects`. Add the project's `.devcontainer/devcontainer.json`, then run **Dev Containers: Reopen in Container**. The tested Node/Compose configuration works with the extension's default `docker` command because this workspace supplies that compatibility command. A custom Docker Path can instead select `podman`. The workspace's configured Compose provider is `podman-compose`; your computer does not need its own container engine.

Use **Dev Containers: Rebuild Container** after changing the image. Store source and data that must survive rebuilding in project bind mounts or named volumes. The validated configuration uses `remoteUser: "root"` inside the rootless container, where created project files map to the workspace's UID 1000. Other container users and UID mappings need their own ownership configuration.

Use the editor's **Ports** panel to forward a development HTTP port. When VS Code runs in Dev Workspace Desktop, that forwarded localhost belongs to the desktop service. Its built-in Browser can open the forwarded address. Use a Web Preview interface when you need an address directly accessible from your own computer's browser. Restart application processes after rebuilding or reopening a container when they are not managed by its startup command.

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

The latest operation appears in a multiline panel with its status, full message, and UTC timestamps. Expand **Previous operations** to review earlier results, newest first. Each panel has a copy button. Reopen the action to refresh its contents.

Use **Cancel Package Scan** to stop a long discovery operation without restarting the workspace. The last completed catalog is retained. Choose **Local Projects** for a quick scan of server builds, or **Shared Projects** for your selected provider folder. **Browse S9PK Packages** shows how many entries and candidate archives were checked in each folder, what was excluded, and time spent hashing and inspecting packages. An unavailable or unreadable folder is reported as incomplete; a folder not reached before a limit is marked as not scanned. Only the first 100 error details are listed, with the full observed total shown above. Older catalogs have no statistics until another scan completes. Cancelling retains both the previous catalog and its measurements.

The original shared file stays in place. Installation uses a verified local copy and does not pass through your computer. If the artifact changes after scanning, scan it again. Files must be regular files of at most 32 GiB; symlinks and dependency directories are skipped. The browser reports incomplete scans when their limits are reached.

If Installation Status says the selected package could not be read, its file may have moved, changed, or become unavailable with the shared provider. Restore access, run **Scan S9PK Packages** again, and select the package before retrying. Failed copying removes its partial local copy and leaves the original files and previous catalog intact.

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

The package is configured to back up your home, saved project files, runtime installations, editor data, SSH identity and Podman storage including named volumes. Saved credentials, including the package manager identity, are included. Podman layers and images increase backup size. A running-workspace backup passed on x86_64 with Dev Workspace 0.6.0:7 and StartOS 0.4.2. The workspace returned to service automatically. Its test database container remained stopped and retained its committed data. Verify database contents after restoring a backup before resuming application writes.

The workspace rewrites regular files in all three volumes on each backup or restore to preserve changes in both contents and hard links. Allow time for the full volume and temporary space for the largest file being replaced.

The shared-source selection is saved, but the original files at `/projects-shared` need their provider's backup. Back up FileBrowser Quantum or Nextcloud separately. The Nextcloud app password and upload cache are private workspace state and are included; coordinate their restore with the provider before resuming uploads.

Plan backup time as an interruption: save editor buffers, stop application writes and let Nextcloud uploads drain first. StartOS documents stopping a running service for backup and starting it again afterward; an already stopped service stays stopped. This workspace's complete shutdown and backup sequence still needs native verification. Running processes and unsaved buffers are not restored. [StartOS backup lifecycle](https://docs.start9.com/start-os/0.4.1.x/backup-create.html).

After an isolated restore, use **Connection Information** for the current address and port and verify the saved host fingerprint, project bytes, tools and database records. Relaunch application commands or Compose stacks manually. Restoring preview state revokes its saved access; set a new preview password and create new previews.

After restore, the package manager and `startos-target` require fresh StartOS logins. Use **Connect to StartOS** for the manager. To enroll a terminal identity on the current server, run `startos-target add-local restored-server`, review its address, then run `startos-target login restored-server` interactively. Existing terminal profiles still point to their saved servers; inspect them before choosing to log in. Restarts and upgrades preserve working logins.

Copied keys remain private and inactive in these helpers, without revoking the original server's identities. Keep a restored copy isolated until you review other copied credentials, SSH identities and pending uploads. A separate companion backup contains its editor profile and pairing key; review duplicate pairing credentials before connecting a restored companion alongside the original. Full native restore verification is still pending.

## Limits to plan for

Podman is optional and uses local project storage; `docker` is its compatibility command. Configure development databases deliberately, preserve their volumes, and verify their recovery. Cross-architecture builds and operating-system integration tests require additional builders, emulation, or suitable guests. A successful image build does not prove those workflows.

The workspace is Linux. Native macOS applications and Apple-specific tests still need a Mac. CPU-specific extensions and native dependencies may need a compatible build.

If you publish SSH through a tunnel to keep the server's origin address private, send the workspace's outbound traffic through that tunnel too. Git hosts, package registries, and runtime download servers otherwise receive connections through its normal outbound route. No route change is needed when the tunnel is used only for reachability.

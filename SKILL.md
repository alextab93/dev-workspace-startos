---
name: startos-server
description: Inspect and operate a StartOS server from Dev Workspace using a saved HTTPS target and its separately enrolled CLI identity. Use for StartOS service status, health checks, logs, interfaces, package actions, and administration.
---

Use `startos-target` for server administration. Keep every command bound to the intended saved target. A skill provides instructions; it does not grant server access.

## First connection

Run `startos-target list` to discover saved targets. For this workspace's server, run:

```sh
startos-target add-local
startos-target info local-server
```

`add-local` uses public connection information supplied by the package and verifies HTTPS with the server's public root CA. It saves a target without enrolling an identity. It never copies an existing administrator credential.

The user must enroll the workspace from an interactive terminal:

```sh
startos-target login local-server
```

Ask the user to enter their server password in that terminal. Do not request it in chat, place it in a command argument or environment variable, or store it in a skill or project file. Login saves a separate identity for this target. Its presence does not prove that the server still authorizes it.

After enrollment, verify access:

```sh
startos-target run local-server package list --format json
```

To configure another server, use an explicitly provided HTTPS URL and its verified public CA certificate:

```sh
startos-target add another-server --url https://server.example --ca-file /path/to/public-root-ca.pem
startos-target login another-server
```

Do not assume a desktop's `.local` hostname resolves inside the workspace. Never disable certificate verification. Existing target names cannot be silently redirected to a different URL or CA; choose a new target when the connection identity changes.

After a workspace restore, saved profiles retain their addresses and public CAs, but copied identities are inactive in `startos-target`. Review the target before requesting interactive enrollment. To reach the server hosting the restored workspace, use `startos-target add-local restored-server`, inspect its public metadata, then ask the user to run `startos-target login restored-server` in a terminal. Do not reuse an old key manually to bypass this requirement. Ordinary restarts and updates retain the selected identity. Copied keys are not remotely revoked; other credentials and companion pairing need their own recovery review.

## Working with a target

Start with read-only inspection. Discover commands with `startos-target run TARGET --help` or `startos-target run TARGET package --help`. Confirm actual package IDs, service state and relevant bindings before proposing a change. Use structured JSON output where supported. Do not dump private database data or credentials to troubleshoot routine status questions.

Common inspections:

```sh
startos-target run local-server package list --format json
startos-target run local-server package stats --format json
startos-target run local-server package logs PACKAGE_ID --limit 100
```

Service names, interfaces and subcontainers must come from the selected server. Do not assume port assignments or hardcode another installation's addresses.

Explain the intended target and impact before consequential changes. Follow the user's existing authorization and the assistant's permission rules. Reading status does not authorize installing packages, restarting services, editing provider files, creating tokens, changing authentication or publishing releases. A named CLI identity or API token is not a read-only or package-scoped permission grant.

`run` is noninteractive and streams the requested command's standard output, including followed logs. That output can contain application data, so request only the information needed. It replaces upstream error output with bounded, credential-free diagnostics and prevents implicit enrollment. Prefer finite log limits for routine inspection. Piped input is supported; a terminal does not become input to the wrapped command. Interactive enrollment uses the separate `login` command.

The helper fixes the target, public CA and identity path. It rejects overrides for those settings, proxy options and password arguments. If ambient StartOS configuration prevents isolation, report that conflict. Do not delete user configuration, disable checks or fall back to an unverified server connection.

## Credentials and package development

Saved targets live beneath the development user's configuration directory, separately from project folders. All projects and SSH users sharing that development account can potentially access credentials available to it. Keep server enrollment an explicit user decision.

Use raw `start-cli` for local package development and registry operations. Packaging has a separate workspace signing key and may require a configured Docker or Podman builder. Installing the CLI does not supply a Docker daemon, authorize a remote builder, grant registry access or transfer a desktop's signing identity. Do not mount the server's container-control socket to obtain those capabilities.

Official references: [CLI commands and authentication](https://docs.start9.com/start-os/0.4.1.x/cli-reference.html), [service networking and TLS trust](https://docs.start9.com/packaging/outbound-networking.html), [packaging guide](https://docs.start9.com/packaging/).

FROM node:24.22.2-trixie-slim@sha256:0820eaa85e07d0490446dd01d14707e17e6108a36988cf374899cd057eb3812d

ARG TARGETARCH
ARG MISE_VERSION=2026.11.2
ARG START_CLI_VERSION=2.8.0

ENV LANG=C.UTF-8
ENV LC_ALL=C.UTF-8

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      openssh-server openssh-client git bash ca-certificates curl tar gzip \
      unzip xz-utils tmux python3 python3-venv python3-pip build-essential \
      autoconf bison pkg-config libssl-dev libyaml-dev libreadline-dev \
      zlib1g-dev libffi-dev libgmp-dev libsqlite3-dev libpq-dev libvips42t64 sqlite3 \
      procps iproute2 less ripgrep jq openssl gnupg gh squashfs-tools rsync \
      podman crun conmon uidmap slirp4netns passt netavark aardvark-dns catatonit podman-compose \
      iptables nftables fuse-overlayfs rclone=1.60.1+dfsg-4 fuse3=3.17.2-3 \
 && rm -rf /var/lib/apt/lists/* /etc/ssh/ssh_host_* \
 && groupmod --new-name dev node \
 && usermod --login dev --home /home/dev --move-home --shell /bin/bash node \
 && printf 'dev:%s\n' "$(openssl rand -hex 48)" | chpasswd \
 && install -d -m 0755 /usr/local/share/dev-workspace/home-defaults /run/sshd /var/lib/dev-workspace/ssh

RUN printf 'dev:1001:64535\n' > /etc/subuid \
 && printf 'dev:1001:64535\n' > /etc/subgid \
 && install -d -m 0755 /etc/containers /run/user/1000 \
 && chown dev:dev /run/user/1000 \
 && chmod 0700 /run/user/1000 \
 && printf 'unqualified-search-registries = ["docker.io"]\n' > /etc/containers/registries.conf \
 && printf '[containers]\ncgroups = "disabled"\n[engine]\ncgroup_manager = "cgroupfs"\nevents_logger = "file"\nruntime = "crun"\n' > /etc/containers/containers.conf

ENV STARTOS_USE_PODMAN=1
ENV DOCKER_HOST=unix:///run/dev-workspace-podman/podman.sock
ENV CONTAINER_HOST=unix:///run/dev-workspace-podman/podman.sock
ENV PODMAN_COMPOSE_PROVIDER=/usr/bin/podman-compose

RUN case "$TARGETARCH" in \
      amd64) start_cli_arch=x86_64; start_cli_sha=05a9a1c00207fb83c5d36eeb801655d5e02272a5a01c34d3588982c39fbca689 ;; \
      arm64) start_cli_arch=aarch64; start_cli_sha=9ad5b64283dc5d77cdc691738d86a78205442b09026841fe51a487974a197b63 ;; \
      *) exit 1 ;; \
    esac \
 && curl --fail --location --retry 3 \
      "https://github.com/Start9Labs/start-technologies/releases/download/start-cli%2Fv${START_CLI_VERSION}/start-cli_${start_cli_arch}-linux" \
      --output /tmp/start-cli \
 && printf '%s  %s\n' "$start_cli_sha" /tmp/start-cli | sha256sum --check \
 && install -m 0755 /tmp/start-cli /usr/local/bin/start-cli \
 && rm /tmp/start-cli

RUN case "$TARGETARCH" in \
      amd64) mise_arch=x64; mise_sha=c914dc3be1ad3588c3a7fa8ddae86c65e77eaf1777aa4a900c215e467f4c94a4 ;; \
      arm64) mise_arch=arm64; mise_sha=4d69f304a1501441cf455f6c7f96b117a10c27a568cdda3b5d1fa8e67476b038 ;; \
      *) exit 1 ;; \
    esac \
 && curl --fail --location --retry 3 \
      "https://github.com/jdx/mise/releases/download/v${MISE_VERSION}/mise-v${MISE_VERSION}-linux-${mise_arch}.tar.gz" \
      --output /tmp/mise.tar.gz \
 && printf '%s  %s\n' "$mise_sha" /tmp/mise.tar.gz | sha256sum --check \
 && tar -xzf /tmp/mise.tar.gz -C /tmp \
 && install -m 0755 /tmp/mise/bin/mise /usr/local/bin/mise \
 && rm -rf /tmp/mise /tmp/mise.tar.gz

COPY --chmod=644 assets/sshd_config /etc/ssh/sshd_config
COPY assets/home-defaults/ /usr/local/share/dev-workspace/home-defaults/
COPY --chmod=755 assets/prepare-workspace.py /usr/local/bin/prepare-workspace
COPY --chmod=755 assets/nextcloud-workspace.py /usr/local/bin/nextcloud-workspace
COPY --chmod=755 assets/nextcloud-connect.py /usr/local/bin/nextcloud-connect
COPY --chmod=755 assets/ssh-connections.py /usr/local/bin/ssh-connections
COPY --chmod=755 assets/workspace-podman.py /usr/local/bin/workspace-podman
COPY --chmod=755 assets/podman-remote.py /usr/local/bin/podman
COPY --chmod=755 assets/podman-remote.py /usr/local/bin/docker
COPY --chmod=755 assets/workspace-session.py /usr/local/bin/workspace-session
COPY --chmod=644 assets/workspace-previews.mjs /usr/local/lib/dev-workspace/workspace-previews.mjs
COPY --chmod=644 assets/preview-config.mjs /usr/local/lib/dev-workspace/preview-config.mjs
COPY --chmod=755 assets/workspace-packages.py /usr/local/bin/workspace-packages
COPY --chmod=755 assets/workspace-package-files.py /usr/local/bin/workspace-package-files
COPY --chmod=755 assets/startos-target.py /usr/local/bin/startos-target
COPY --chmod=644 SKILL.md /usr/local/share/dev-workspace/skills/startos-server/SKILL.md
COPY --chmod=644 assets/START-CLI-LICENSE /usr/local/share/licenses/start-cli/LICENSE

RUN chmod -R u=rwX,go=rX /usr/local/share/dev-workspace/skills /usr/local/share/dev-workspace/home-defaults \
 && runuser -u dev -- test -r /usr/local/share/dev-workspace/skills/startos-server/SKILL.md \
 && rm -f /home/dev/.bashrc /home/dev/.profile /home/dev/.bash_logout

WORKDIR /home/dev
EXPOSE 2222
ENTRYPOINT []
CMD ["/usr/sbin/sshd", "-D", "-e", "-f", "/etc/ssh/sshd_config"]

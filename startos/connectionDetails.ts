type Endpoint = { hostname: string; port: number | null }

export function connectionDetails(endpoints: Endpoint[], username: string) {
  return {
    commands: endpoints
      .map(
        (endpoint) =>
          `ssh -p ${endpoint.port ?? 22} ${username}@${endpoint.hostname}`,
      )
      .join('\n'),
    configuration: endpoints
      .map((endpoint, index) =>
        [
          `Host startos-dev-${index + 1}`,
          `    HostName ${endpoint.hostname}`,
          `    Port ${endpoint.port ?? 22}`,
          `    User ${username}`,
          '    IdentitiesOnly yes',
          '    ForwardAgent no',
          '    ServerAliveInterval 30',
          '    ServerAliveCountMax 3',
        ].join('\n'),
      )
      .join('\n\n'),
  }
}

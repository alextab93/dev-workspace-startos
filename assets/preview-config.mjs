const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const object = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const validId = (value) => typeof value === 'string' && uuid.test(value)

function validLease(lease) {
  return (
    object(lease) &&
    validId(lease.id) &&
    typeof lease.name === 'string' &&
    lease.name.length > 0 &&
    lease.name.length <= 60 &&
    lease.name === lease.name.trim() &&
    !/[\u0000-\u001f\u007f]/u.test(lease.name) &&
    Number.isSafeInteger(lease.proxyPort) &&
    lease.proxyPort >= 18080 &&
    lease.proxyPort <= 18087 &&
    Number.isSafeInteger(lease.applicationPort) &&
    lease.applicationPort >= 1024 &&
    lease.applicationPort <= 65535 &&
    lease.applicationPort !== 2222 &&
    (lease.applicationPort < 18080 || lease.applicationPort > 18087) &&
    Number.isSafeInteger(lease.createdAt) &&
    lease.createdAt >= 0 &&
    Number.isSafeInteger(lease.expiresAt) &&
    lease.expiresAt > lease.createdAt
  )
}

export function parsePreviewSettings(value) {
  if (
    !object(value) ||
    value.version !== 1 ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    !Array.isArray(value.leases) ||
    value.leases.length > 8 ||
    !Array.isArray(value.retired) ||
    value.retired.length > (value.leases.length ? 128 : 136) ||
    !value.retired.every(validId) ||
    (value.quarantined !== undefined &&
      (!Array.isArray(value.quarantined) || value.quarantined.length > 32))
  )
    throw new Error('Web Preview settings are invalid.')
  if (
    value.auth !== null &&
    (!object(value.auth) ||
      !validId(value.auth.generation) ||
      typeof value.auth.salt !== 'string' ||
      !/^[a-f0-9]{32}$/.test(value.auth.salt) ||
      typeof value.auth.hash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.auth.hash))
  )
    throw new Error('Web Preview password settings are invalid.')
  const quarantined = [...(value.quarantined || [])]
  const records = [...value.leases, ...quarantined]
  const counts = ['id', 'proxyPort', 'applicationPort', 'name'].map((key) => {
    const values = new Map()
    for (const record of records) {
      if (!object(record)) continue
      const item =
        key === 'name' && typeof record[key] === 'string'
          ? record[key].trim().toLowerCase()
          : record[key]
      values.set(item, (values.get(item) || 0) + 1)
    }
    return [key, values]
  })
  const retired = new Set(value.retired)
  const leases = []
  for (const record of value.leases) {
    if (
      validLease(record) &&
      !retired.has(record.id) &&
      counts.every(
        ([key, values]) =>
          values.get(
            key === 'name' ? record.name.toLowerCase() : record[key],
          ) === 1,
      )
    ) {
      leases.push(record)
    } else {
      quarantined.push(record)
      if (object(record) && validId(record.id)) retired.add(record.id)
    }
  }
  if (quarantined.length > 32 || retired.size > (leases.length ? 128 : 136))
    throw new Error(
      'Too many invalid preview records. Repair the configuration.',
    )
  return { ...value, leases, retired: [...retired], quarantined }
}

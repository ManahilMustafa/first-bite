export function maskEmail(email) {
  if (!email) return '—'
  const [user, domain] = email.split('@')
  if (!domain) return email
  const masked =
    user.length <= 2 ? '**' : `${user[0]}${'*'.repeat(Math.min(user.length - 2, 4))}${user[user.length - 1]}`
  return `${masked}@${domain}`
}

export function formatRegion(account) {
  const zips = account.regionZipPrefixes || account.region?.zipPrefixes || []
  const states = account.regionStates || account.region?.states || []
  const parts = []
  if (zips.length) parts.push(`ZIP: ${zips.join(', ')}`)
  if (states.length) parts.push(`States: ${states.join(', ')}`)
  return parts.length ? parts.join(' · ') : '—'
}

export function parseCsvList(value, uppercase = false) {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (uppercase ? s.toUpperCase() : s))
}

export function isWorkerLive(accountId, liveWorkers) {
  return liveWorkers.some((w) => w.id === accountId)
}

export function getLiveWorker(accountId, liveWorkers) {
  return liveWorkers.find((w) => w.id === accountId) || null
}

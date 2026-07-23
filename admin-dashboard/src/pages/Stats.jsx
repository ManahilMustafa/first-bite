import { useEffect, useState } from 'react'
import { getStats } from '../api/client'
import { StatCard } from '../components/StatCard'

function Cell({ w }) {
  // w = { detected, accepted, declined, skipped, unattributed }
  if (!w || !w.detected) return <span className="muted">—</span>
  return (
    <span>
      <strong style={{ color: 'var(--success)' }}>{w.accepted}</strong>
      {' acc · '}
      <strong style={{ color: 'var(--live)' }}>{w.declined}</strong>
      {' dec · '}
      {w.detected} seen
    </span>
  )
}

export function Stats() {
  const [stats, setStats] = useState(null)
  const [error, setError] = useState(null)
  const [updated, setUpdated] = useState(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const data = await getStats()
        if (!cancelled) {
          setStats(data)
          setError(null)
          setUpdated(new Date())
        }
      } catch (err) {
        if (!cancelled) setError(err.response?.data?.error || err.message)
      }
    }
    load()
    const id = setInterval(load, 8000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])

  const overall = stats?.overall || {}
  const rows = stats?.byAccount || []

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h2>Statistics</h2>
          <p className="page-subtitle">Per-user accept / decline activity by day, week, and month</p>
        </div>
        {updated && <span className="muted">Auto-refresh · {updated.toLocaleTimeString()}</span>}
      </header>

      {error && <div className="alert alert-error">{error}</div>}

      <section className="stat-grid">
        <StatCard label="Detected (all time)" value={overall.detected ?? 0} accent="indigo" />
        <StatCard label="Accepted" value={overall.accepted ?? 0} accent="green" />
        <StatCard label="Declined" value={overall.declined ?? 0} accent="blue" />
        <StatCard label="Unattributed" value={overall.unattributed ?? 0} accent="amber" />
      </section>

      <section className="panel panel-flush">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>User</th>
                <th>Today (24h)</th>
                <th>This week (7d)</th>
                <th>This month (30d)</th>
                <th>All time</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="empty-cell">
                    No activity yet.
                  </td>
                </tr>
              ) : (
                rows.map((a) => (
                  <tr key={a.accountId || a.label}>
                    <td><strong>{a.label}</strong></td>
                    <td><Cell w={a.day} /></td>
                    <td><Cell w={a.week} /></td>
                    <td><Cell w={a.month} /></td>
                    <td><Cell w={a.total} /></td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <p className="field-hint" style={{ padding: '8px 16px' }}>
          acc = accepted · dec = declined · seen = total orders detected
        </p>
      </section>
    </div>
  )
}

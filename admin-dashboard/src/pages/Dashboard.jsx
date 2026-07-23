import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { getHealth } from '../api/client'
import { StatCard } from '../components/StatCard'
import { StatusBadge } from '../components/StatusBadge'
import { useAccounts } from '../hooks/useAccounts'

export function Dashboard() {
  const { accounts, live, loading, error, lastUpdated } = useAccounts()
  const [health, setHealth] = useState(null)
  const [healthError, setHealthError] = useState(null)

  useEffect(() => {
    let cancelled = false
    async function pollHealth() {
      try {
        const data = await getHealth()
        if (!cancelled) {
          setHealth(data)
          setHealthError(null)
        }
      } catch (err) {
        if (!cancelled) setHealthError(err.message)
      }
    }
    pollHealth()
    const id = setInterval(pollHealth, 7000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])

  const total = accounts.length
  const active = accounts.filter((a) => a.active).length
  const inactive = total - active
  const liveCount = live.length

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h2>Dashboard</h2>
          <p className="page-subtitle">System overview and live worker status</p>
        </div>
        <div className="header-meta">
          <span className={`health-dot ${health?.ok ? 'ok' : 'err'}`} />
          {health?.ok ? 'Backend online' : healthError || 'Checking…'}
          {lastUpdated && (
            <span className="muted"> · Updated {lastUpdated.toLocaleTimeString()}</span>
          )}
        </div>
      </header>

      {(error || healthError) && (
        <div className="alert alert-error">{error || healthError}</div>
      )}

      <section className="stat-grid">
        <StatCard label="Total Accounts" value={loading ? '…' : total} accent="indigo" />
        <StatCard label="Active Accounts" value={loading ? '…' : active} accent="green" />
        <StatCard label="Inactive Accounts" value={loading ? '…' : inactive} accent="amber" />
        <StatCard
          label="Live Workers"
          value={loading ? '…' : liveCount}
          hint="Workers currently polling the portal"
          accent="blue"
        />
      </section>

      <section className="panel">
        <div className="panel-header">
          <h3>Quick Actions</h3>
        </div>
        <div className="quick-actions">
          <Link to="/add-account" className="btn btn-primary">
            Add new account
          </Link>
          <Link to="/accounts" className="btn btn-secondary">
            Manage accounts
          </Link>
        </div>
      </section>

      {live.length > 0 && (
        <section className="panel">
          <div className="panel-header">
            <h3>Live Workers</h3>
          </div>
          <div className="worker-list">
            {live.map((w) => (
              <div key={w.id} className="worker-item">
                <div>
                  <strong>{w.label || w.username}</strong>
                  <span className="muted">{w.username}</span>
                  {w.portalPaused && (
                    <StatusBadge variant="paused">Portal paused</StatusBadge>
                  )}
                </div>
                <div className="worker-stats">
                  <span>Detected: {w.stats?.detected ?? 0}</span>
                  <span>Accepted: {w.stats?.accepted ?? 0}</span>
                  <span>Declined: {w.stats?.declined ?? 0}</span>
                  <span>Polls: {w.pollerStats?.polls ?? 0}</span>
                  {w.portalPaused && w.pauseReason && (
                    <span className="muted" title={w.pauseReason}>
                      Reason: {String(w.pauseReason).slice(0, 48)}
                    </span>
                  )}
                  {w.backoffMs != null && w.backoffMs !== w.pollerStats?.intervalMs && !w.portalPaused && (
                    <span>Backoff: {w.backoffMs}ms</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

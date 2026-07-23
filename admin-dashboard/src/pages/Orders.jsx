import { useEffect, useState } from 'react'
import { getOrders, scanInbox } from '../api/client'
import { StatusBadge } from '../components/StatusBadge'

// Map an order event to a badge.
function outcomeBadge(o) {
  if (o.action === 'accept') {
    if (o.accepted) return { variant: 'success', label: 'Accepted' }
    return { variant: 'neutral', label: o.outcome === 'taken' ? 'Taken' : 'Accept failed' }
  }
  if (o.action === 'decline') {
    if (o.declined) return { variant: 'live', label: 'Declined' }
    return { variant: 'neutral', label: 'Decline failed' }
  }
  if (o.action === 'detected') {
    if (o.outcome === 'would_accept') return { variant: 'success', label: 'Detected · would accept' }
    if (o.outcome === 'would_decline') return { variant: 'live', label: 'Detected · would decline' }
    return { variant: 'neutral', label: 'Detected' }
  }
  if (o.action === 'skip') return { variant: 'neutral', label: 'Skipped' }
  if (o.action === 'unattributed') return { variant: 'stopped', label: 'Unattributed' }
  return { variant: 'neutral', label: o.action || '—' }
}

const FILTERS = [
  { key: '', label: 'All' },
  { key: 'accept', label: 'Accepted' },
  { key: 'decline', label: 'Declined' },
  { key: 'skip', label: 'Skipped' },
  { key: 'unattributed', label: 'Unattributed' },
]

export function Orders() {
  const [orders, setOrders] = useState([])
  const [action, setAction] = useState('')
  const [error, setError] = useState(null)
  const [updated, setUpdated] = useState(null)
  const [scanning, setScanning] = useState(false)
  const [scanMsg, setScanMsg] = useState(null)

  async function load(currentAction = action) {
    try {
      const data = await getOrders({ limit: 200, ...(currentAction ? { action: currentAction } : {}) })
      setOrders(data.orders || [])
      setError(null)
      setUpdated(new Date())
    } catch (err) {
      setError(err.response?.data?.error || err.message)
    }
  }

  async function handleScan() {
    setScanning(true)
    setScanMsg(null)
    try {
      const r = await scanInbox()
      setScanMsg(`Scanned ${r.scanned} message(s), recorded ${r.recorded} new order(s).`)
      await load()
    } catch (err) {
      setError(err.response?.data?.error || err.message)
    } finally {
      setScanning(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    async function tick() {
      if (!cancelled) await load(action)
    }
    tick()
    const id = setInterval(tick, 1000) // refresh the orders feed every second
    return () => {
      cancelled = true
      clearInterval(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action])

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h2>Orders</h2>
          <p className="page-subtitle">Every detected order and what the bot did with it</p>
        </div>
        <div className="header-meta">
          <button type="button" className="btn btn-sm btn-primary" disabled={scanning} onClick={handleScan}>
            {scanning ? 'Scanning…' : 'Scan inbox now'}
          </button>
          {updated && <span className="muted">Auto-refresh · {updated.toLocaleTimeString()}</span>}
        </div>
      </header>

      {scanMsg && <div className="alert">{scanMsg}</div>}
      {error && <div className="alert alert-error">{error}</div>}

      <div className="quick-actions" style={{ marginBottom: 16 }}>
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            className={`btn btn-sm ${action === f.key ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setAction(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>

      <section className="panel panel-flush">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Account</th>
                <th>Order #</th>
                <th>Property</th>
                <th>State</th>
                <th>Source</th>
                <th>Outcome</th>
                <th>Via</th>
              </tr>
            </thead>
            <tbody>
              {orders.length === 0 ? (
                <tr>
                  <td colSpan={8} className="empty-cell">
                    No orders recorded yet.
                  </td>
                </tr>
              ) : (
                orders.map((o, i) => {
                  const b = outcomeBadge(o)
                  return (
                    <tr key={`${o.orderId}-${o.ts}-${i}`}>
                      <td>{o.ts ? new Date(o.ts).toLocaleString() : '—'}</td>
                      <td>
                        {o.account || '—'}
                        {o.forwardingEmail && (
                          <div className="muted" style={{ fontSize: 12 }}>{o.forwardingEmail}</div>
                        )}
                      </td>
                      <td><strong>{o.orderId || '—'}</strong></td>
                      <td className="region-cell">{o.address || '—'}</td>
                      <td>{o.state || '—'}</td>
                      <td>{o.source || '—'}</td>
                      <td><StatusBadge variant={b.variant}>{b.label}</StatusBadge></td>
                      <td>{o.via || '—'}</td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

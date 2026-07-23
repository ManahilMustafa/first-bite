import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { getLiveOrders } from '../api/client'
import { OrderStatusChip } from '../components/OrderStatusChip'
import { OrderTimeline } from '../components/OrderTimeline'

const TABS = [
  { key: '', label: 'Live Orders' },
  { key: 'accepted', label: 'Accepted' },
  { key: 'declined', label: 'Declined' },
  { key: 'failed', label: 'Failed' },
  { key: 'pending', label: 'Pending' },
  { key: 'outside_region', label: 'Outside Region' },
]

const PAGE_SIZE = 8
// Local-data-only endpoint — no reason for this to ever be slow, but this is
// deliberately NOT 1s: an aggressive poll interval combined with the guard
// below is what actually matters (see the busy-ref), this just keeps request
// volume sane even if a single fetch is ever unusually slow.
const REFRESH_MS = 3000

export function Orders() {
  const [orders, setOrders] = useState([])
  const [tab, setTab] = useState('')
  const [error, setError] = useState(null)
  const [updated, setUpdated] = useState(null)
  const [page, setPage] = useState(1)
  const [expanded, setExpanded] = useState(() => new Set())
  // Guards against overlapping requests piling up (the actual root cause of the
  // old "15s timeout": an unconditional setInterval fired a new fetch every
  // second even if the previous one hadn't resolved yet, so a single slow tick
  // could snowball into a stack of in-flight requests that exhausted the
  // browser's per-origin connection limit — later ones then timed out
  // client-side even though the server itself answered in milliseconds).
  const fetchingRef = useRef(false)

  async function load() {
    if (fetchingRef.current) return
    fetchingRef.current = true
    try {
      const data = await getLiveOrders({ limit: 300 })
      setOrders(data.orders || [])
      setError(null)
      setUpdated(new Date())
    } catch (err) {
      setError(err.response?.data?.error || err.message)
    } finally {
      fetchingRef.current = false
    }
  }

  useEffect(() => {
    let cancelled = false
    async function tick() {
      if (!cancelled) await load()
    }
    tick()
    const id = setInterval(tick, REFRESH_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])

  const filtered = useMemo(() => {
    if (!tab) return orders
    return orders.filter((o) => o.status === tab)
  }, [orders, tab])

  const counts = useMemo(() => {
    const c = {}
    for (const o of orders) c[o.status] = (c[o.status] || 0) + 1
    return c
  }, [orders])

  function selectTab(key) {
    setTab(key)
    setPage(1)
  }

  function toggleExpanded(key) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const pageOrders = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h2>Orders</h2>
          <p className="page-subtitle">Live orders since the bot went active for your account</p>
        </div>
        <div className="header-meta">
          <Link to="/orders/history" className="btn btn-sm btn-secondary">
            Show History →
          </Link>
          {updated && <span className="muted">Auto-refresh · {updated.toLocaleTimeString()}</span>}
        </div>
      </header>

      {error && <div className="alert alert-error">{error}</div>}

      <div className="quick-actions" style={{ marginBottom: 16 }}>
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={`btn btn-sm ${tab === t.key ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => selectTab(t.key)}
          >
            {t.label}
            {t.key && counts[t.key] > 0 ? ` (${counts[t.key]})` : ''}
          </button>
        ))}
      </div>

      <section className="panel panel-flush">
        <div className="table-wrap">
          <table className="data-table orders-table">
            <thead>
              <tr>
                <th aria-hidden="true"></th>
                <th>Last Updated</th>
                <th>Account</th>
                <th>Order #</th>
                <th>Property</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {pageOrders.length === 0 ? (
                <tr>
                  <td colSpan={6} className="empty-cell">
                    {orders.length === 0
                      ? 'No live orders yet — new orders will appear here as soon as the bot detects them.'
                      : 'No orders match this filter.'}
                  </td>
                </tr>
              ) : (
                pageOrders.map((o) => {
                  const key = `${o.accountId || ''}:${o.orderId}`
                  const isOpen = expanded.has(key)
                  return (
                    <Fragment key={key}>
                      <tr
                        className="orders-row-clickable"
                        onClick={() => toggleExpanded(key)}
                        aria-expanded={isOpen}
                      >
                        <td className="orders-expand-cell">
                          <span className={`orders-expand-caret ${isOpen ? 'open' : ''}`} aria-hidden="true">
                            ›
                          </span>
                        </td>
                        <td data-label="Last Updated">{o.lastUpdatedAt ? new Date(o.lastUpdatedAt).toLocaleString() : '—'}</td>
                        <td data-label="Account">
                          {o.account || '—'}
                          {o.forwardingEmail && (
                            <div className="muted" style={{ fontSize: 12 }}>{o.forwardingEmail}</div>
                          )}
                        </td>
                        <td data-label="Order #"><strong>{o.orderId || '—'}</strong></td>
                        <td data-label="Property" className="region-cell">{o.address || '—'}</td>
                        <td data-label="Status" onClick={(e) => e.stopPropagation()}>
                          <OrderStatusChip status={o.status} reason={o.reason} />
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="orders-timeline-row">
                          <td colSpan={6}>
                            <OrderTimeline timeline={o.timeline} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })
              )}
            </tbody>
          </table>
        </div>

        {filtered.length > 0 && (
          <div className="pagination">
            <span className="muted">
              Showing {(safePage - 1) * PAGE_SIZE + 1}
              –{Math.min(safePage * PAGE_SIZE, filtered.length)} of {filtered.length}
            </span>
            <div className="pagination-controls">
              <button
                type="button"
                className="btn btn-sm btn-secondary"
                disabled={safePage <= 1}
                onClick={() => setPage(safePage - 1)}
              >
                ‹ Prev
              </button>
              <span className="pagination-page">
                Page {safePage} of {totalPages}
              </span>
              <button
                type="button"
                className="btn btn-sm btn-secondary"
                disabled={safePage >= totalPages}
                onClick={() => setPage(safePage + 1)}
              >
                Next ›
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}

export default Orders

import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { getOrders, scanInbox } from '../api/client'
import { OrderStatusChip } from '../components/OrderStatusChip'

const PAGE_SIZE = 8

// Every row here is a dry-run preview (never a real accept/decline), so it
// always renders as "Test Scan" — the reason just says what the preview found.
function previewReason(o) {
  if (o.action === 'unattributed') {
    return "This email didn't match any of your registered accounts. It was a scan preview, not a real detection.";
  }
  if (o.outcome === 'would_accept') return 'Preview only — if this had been live, the bot would have accepted this order.';
  if (o.outcome === 'would_decline') return 'Preview only — if this had been live, the bot would have declined this order (outside region).';
  return 'Preview only — no action was taken.';
}

// Inbox Scan Results / Backfill — dry-run previews only. Nothing on this page
// was ever actually accepted or declined; every row is tagged dryRun:true and
// always renders as a "Test Scan" chip so it can never be mistaken for a real
// live order (see Orders.jsx, which explicitly excludes dryRun:true).
export function OrdersHistory() {
  const [orders, setOrders] = useState([])
  const [error, setError] = useState(null)
  const [updated, setUpdated] = useState(null)
  const [scanning, setScanning] = useState(false)
  const [scanMsg, setScanMsg] = useState(null)
  const [page, setPage] = useState(1)

  async function load() {
    try {
      const data = await getOrders({ limit: 300, dryRun: true })
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
      setScanMsg(`Scanned ${r.scanned} message(s), recorded ${r.recorded} new preview(s).`)
      await load()
    } catch (err) {
      setError(err.response?.data?.error || err.message)
    } finally {
      setScanning(false)
    }
  }

  useEffect(() => {
    // Historical data doesn't change on its own — no auto-refresh needed here,
    // just a one-time load on mount.
    let cancelled = false
    async function tick() {
      if (!cancelled) await load()
    }
    tick()
    return () => {
      cancelled = true
    }
  }, [])

  const totalPages = Math.max(1, Math.ceil(orders.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const pageOrders = orders.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h2>Order History &amp; Inbox Scan Results</h2>
          <p className="page-subtitle">
            Previews only — nothing here was actually accepted or declined. For real activity, go back to{' '}
            <Link to="/orders">Live Orders</Link>.
          </p>
        </div>
        <div className="header-meta">
          <button type="button" className="btn btn-sm btn-primary" disabled={scanning} onClick={handleScan}>
            {scanning ? 'Scanning…' : 'Scan inbox now'}
          </button>
          {updated && <span className="muted">Last loaded · {updated.toLocaleTimeString()}</span>}
        </div>
      </header>

      {scanMsg && <div className="alert">{scanMsg}</div>}
      {error && <div className="alert alert-error">{error}</div>}

      <section className="panel panel-flush">
        <div className="table-wrap">
          <table className="data-table orders-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Account</th>
                <th>Order #</th>
                <th>Property</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {pageOrders.length === 0 ? (
                <tr>
                  <td colSpan={5} className="empty-cell">
                    No inbox scans recorded yet. Click "Scan inbox now" to preview recent order emails.
                  </td>
                </tr>
              ) : (
                pageOrders.map((o, i) => (
                  <tr key={`${o.orderId}-${o.ts}-${i}`}>
                    <td data-label="Time">{o.ts ? new Date(o.ts).toLocaleString() : '—'}</td>
                    <td data-label="Account">
                      {o.account || '—'}
                      {o.forwardingEmail && (
                        <div className="muted" style={{ fontSize: 12 }}>{o.forwardingEmail}</div>
                      )}
                    </td>
                    <td data-label="Order #"><strong>{o.orderId || '—'}</strong></td>
                    <td data-label="Property" className="region-cell">{o.address || '—'}</td>
                    <td data-label="Status"><OrderStatusChip status="test_scan" reason={previewReason(o)} /></td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {orders.length > 0 && (
          <div className="pagination">
            <span className="muted">
              Showing {(safePage - 1) * PAGE_SIZE + 1}
              –{Math.min(safePage * PAGE_SIZE, orders.length)} of {orders.length}
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

export default OrdersHistory

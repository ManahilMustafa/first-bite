import { useEffect, useState } from 'react'
import { deleteAccount, getGmailAuthUrl, getGmailStatus, setAccountActive } from '../api/client'
import { StatusBadge } from '../components/StatusBadge'
import { useAccounts } from '../hooks/useAccounts'
import { formatRegion, isWorkerLive, maskEmail } from '../utils/format'

export function Accounts() {
  const { accounts, live, loading, error, lastUpdated, refresh } = useAccounts()
  const [actionId, setActionId] = useState(null)
  const [actionError, setActionError] = useState(null)
  const [gmail, setGmail] = useState(null)
  const [connecting, setConnecting] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function loadStatus() {
      try {
        const s = await getGmailStatus()
        if (!cancelled) setGmail(s)
      } catch {
        /* status is best-effort */
      }
    }
    loadStatus()
    const id = setInterval(loadStatus, 10000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])

  async function handleConnectCentralInbox() {
    setConnecting(true)
    setActionError(null)
    try {
      const { url } = await getGmailAuthUrl()
      window.open(url, '_blank', 'noopener,noreferrer')
    } catch (err) {
      setActionError(err.response?.data?.error || err.message)
    } finally {
      setConnecting(false)
    }
  }

  async function handleToggle(account) {
    setActionId(account.id)
    setActionError(null)
    try {
      await setAccountActive(account.id, !account.active)
      await refresh()
    } catch (err) {
      setActionError(err.response?.data?.error || err.message)
    } finally {
      setActionId(null)
    }
  }

  async function handleDelete(account) {
    const label = account.label || account.portalUsername
    if (!window.confirm(`Delete account "${label}"? This cannot be undone.`)) return
    setActionId(account.id)
    setActionError(null)
    try {
      await deleteAccount(account.id)
      await refresh()
    } catch (err) {
      setActionError(err.response?.data?.error || err.message)
    } finally {
      setActionId(null)
    }
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h2>Accounts</h2>
          <p className="page-subtitle">Manage client bots — activate, deactivate, or remove</p>
        </div>
        {lastUpdated && (
          <span className="muted">Auto-refresh · {lastUpdated.toLocaleTimeString()}</span>
        )}
      </header>

      {(error || actionError) && (
        <div className="alert alert-error">{error || actionError}</div>
      )}

      {/* ONE central inbox for the whole system — all users forward their orders here. */}
      <section className="panel">
        <div className="panel-header">
          <h3>Central Inbox (Gmail)</h3>
          {gmail?.connected ? (
            <StatusBadge variant="success">{gmail.emailAddress || 'Connected'}</StatusBadge>
          ) : (
            <StatusBadge variant="neutral">Not connected</StatusBadge>
          )}
        </div>
        <div className="quick-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={connecting}
            onClick={handleConnectCentralInbox}
          >
            {connecting ? 'Opening…' : gmail?.connected ? 'Reconnect inbox' : 'Connect central inbox'}
          </button>
          <span className="field-hint">
            Every user forwards their E-Street order emails into this one inbox. Orders are
            attributed to a user by their Forwarding Email below.
          </span>
        </div>
      </section>

      <section className="panel panel-flush">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Label</th>
                <th>Portal Email</th>
                <th>Forwarding</th>
                <th>Region</th>
                <th>Status</th>
                <th>Worker</th>
                <th>Poll (ms)</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && accounts.length === 0 ? (
                <tr>
                  <td colSpan={8} className="empty-cell">
                    Loading accounts…
                  </td>
                </tr>
              ) : accounts.length === 0 ? (
                <tr>
                  <td colSpan={8} className="empty-cell">
                    No accounts yet. Add one from the Add Account page.
                  </td>
                </tr>
              ) : (
                accounts.map((account) => {
                  const workerLive = isWorkerLive(account.id, live)
                  const busy = actionId === account.id
                  return (
                    <tr key={account.id}>
                      <td>
                        <strong>{account.label || '—'}</strong>
                      </td>
                      <td>{maskEmail(account.portalUsername)}</td>
                      <td>
                        {account.forwardingEmail ? (
                          maskEmail(account.forwardingEmail)
                        ) : (
                          <span className="muted">not set</span>
                        )}
                      </td>
                      <td className="region-cell">{formatRegion(account)}</td>
                      <td>
                        <StatusBadge variant={account.active ? 'success' : 'neutral'}>
                          {account.active ? 'Active' : 'Inactive'}
                        </StatusBadge>
                      </td>
                      <td>
                        <StatusBadge variant={workerLive ? 'live' : 'stopped'}>
                          {workerLive ? 'Live' : 'Stopped'}
                        </StatusBadge>
                      </td>
                      <td>{account.pollIntervalMs ?? '—'}</td>
                      <td>
                        <div className="row-actions">
                          <button
                            type="button"
                            className={`btn btn-sm ${account.active ? 'btn-secondary' : 'btn-primary'}`}
                            disabled={busy}
                            onClick={() => handleToggle(account)}
                          >
                            {busy ? '…' : account.active ? 'Deactivate' : 'Activate'}
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm btn-danger"
                            disabled={busy}
                            onClick={() => handleDelete(account)}
                          >
                            Delete
                          </button>
                        </div>
                      </td>
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

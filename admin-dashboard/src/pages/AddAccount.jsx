import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { createAccount, getAccounts } from '../api/client'
import { parseCsvList } from '../utils/format'

const initialForm = {
  label: '',
  portalUsername: '',
  portalPassword: '',
  portalBaseUrl: '',
  forwardingEmail: '',
  pollIntervalMs: '2000',
  regionZipPrefixes: '',
  regionStates: '',
}

export function AddAccount() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const editId = searchParams.get('id')
  const editing = Boolean(editId)

  const [form, setForm] = useState(initialForm)
  const [error, setError] = useState(null)
  const [success, setSuccess] = useState(null)
  const [loading, setLoading] = useState(false)
  const [loadingAccount, setLoadingAccount] = useState(editing)
  const [showPassword, setShowPassword] = useState(false)

  useEffect(() => {
    if (!editId) return
    let cancelled = false
    ;(async () => {
      setLoadingAccount(true)
      setError(null)
      try {
        const data = await getAccounts()
        const account = (data.accounts || []).find((a) => a.id === editId)
        if (cancelled) return
        if (!account) {
          setError('Account not found')
          setLoadingAccount(false)
          return
        }
        setForm({
          label: account.label || '',
          portalUsername: account.portalUsername || '',
          portalPassword: '',
          portalBaseUrl: account.portalBaseUrl || '',
          forwardingEmail: account.forwardingEmail || '',
          pollIntervalMs: String(account.pollIntervalMs ?? 2000),
          regionZipPrefixes: (account.regionZipPrefixes || []).join(', '),
          regionStates: (account.regionStates || []).join(', '),
        })
      } catch (err) {
        if (!cancelled) setError(err.response?.data?.error || err.message)
      } finally {
        if (!cancelled) setLoadingAccount(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [editId])

  function updateField(field, value) {
    setForm((prev) => ({ ...prev, [field]: value }))
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)
    setSuccess(null)
    setLoading(true)

    const payload = {
      label: form.label.trim(),
      portalUsername: form.portalUsername.trim(),
      portalBaseUrl: form.portalBaseUrl.trim(),
      pollIntervalMs: Number(form.pollIntervalMs) || 2000,
    }
    if (editing) payload.id = editId
    if (form.portalPassword) payload.portalPassword = form.portalPassword
    else if (!editing) {
      setError('Portal password is required')
      setLoading(false)
      return
    }

    if (form.forwardingEmail.trim()) {
      payload.forwardingEmail = form.forwardingEmail.trim().toLowerCase()
    } else if (editing) {
      payload.forwardingEmail = ''
    }

    const zipPrefixes = parseCsvList(form.regionZipPrefixes)
    const states = parseCsvList(form.regionStates, true)
    if (zipPrefixes.length) payload.regionZipPrefixes = zipPrefixes
    else if (editing) payload.regionZipPrefixes = []
    if (states.length) payload.regionStates = states
    else if (editing) payload.regionStates = []

    try {
      await createAccount(payload)
      if (editing) {
        setSuccess('Account updated. If the worker was stopped, it will retry login with the new password.')
        setForm((prev) => ({ ...prev, portalPassword: '' }))
      } else {
        setForm(initialForm)
        setSuccess(`"${payload.label}" was added.`)
      }
    } catch (err) {
      setError(err.response?.data?.error || err.message || (editing ? 'Failed to update account' : 'Failed to create account'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h2>{editing ? 'Edit Account' : 'Add Account'}</h2>
          <p className="page-subtitle">
            {editing
              ? 'Update portal login, forwarding email, or region rules'
              : 'Connect a new E-Street vendor account and optional region rules'}
          </p>
        </div>
      </header>

      {loadingAccount ? (
        <div className="panel">Loading account…</div>
      ) : (
        <form className="form-panel" onSubmit={handleSubmit}>
          {error && <div className="alert alert-error">{error}</div>}
          {success && <div className="alert alert-success">{success}</div>}

          <section className="form-section">
            <h3>Account Details</h3>
            <div className="form-grid">
              <div className="form-field">
                <label htmlFor="label">Label *</label>
                <input
                  id="label"
                  value={form.label}
                  onChange={(e) => updateField('label', e.target.value)}
                  placeholder="vendor-fl-1"
                  required
                />
              </div>
              <div className="form-field">
                <label htmlFor="portalUsername">Portal Username / Email *</label>
                <input
                  id="portalUsername"
                  type="email"
                  value={form.portalUsername}
                  onChange={(e) => updateField('portalUsername', e.target.value)}
                  placeholder="you@example.com"
                  required
                />
              </div>
              <div className="form-field">
                <label htmlFor="portalPassword">
                  Portal Password {editing ? '' : '*'}
                </label>
                <div className="password-input-wrap">
                  <input
                    id="portalPassword"
                    type={showPassword ? 'text' : 'password'}
                    value={form.portalPassword}
                    onChange={(e) => updateField('portalPassword', e.target.value)}
                    required={!editing}
                    autoComplete="new-password"
                    placeholder={editing ? 'Leave blank to keep current password' : ''}
                  />
                  <button
                    type="button"
                    className="password-toggle"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    title={showPassword ? 'Hide password' : 'Show password'}
                  >
                    {showPassword ? (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                        <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                        <line x1="1" y1="1" x2="23" y2="23" />
                      </svg>
                    ) : (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                        <circle cx="12" cy="12" r="3" />
                      </svg>
                    )}
                  </button>
                </div>
                {editing && (
                  <span className="field-hint">
                    Leave blank to keep the current password. Paste the password that works in the browser to replace it.
                  </span>
                )}
              </div>
              <div className="form-field form-field-wide">
                <label htmlFor="portalBaseUrl">Portal Base URL *</label>
                <input
                  id="portalBaseUrl"
                  type="url"
                  value={form.portalBaseUrl}
                  onChange={(e) => updateField('portalBaseUrl', e.target.value)}
                  placeholder="https://portal.example.com"
                  required
                />
              </div>
              <div className="form-field">
                <label htmlFor="forwardingEmail">Forwarding Email</label>
                <input
                  id="forwardingEmail"
                  type="email"
                  value={form.forwardingEmail}
                  onChange={(e) => updateField('forwardingEmail', e.target.value)}
                  placeholder="address orders arrive at (e.g. you@gmail.com)"
                />
                <span className="field-hint">
                  The mailbox this user&apos;s order emails are forwarded FROM — used to route
                  forwarded emails to this account.
                </span>
              </div>
              <div className="form-field">
                <label htmlFor="pollIntervalMs">Poll Interval (ms)</label>
                <input
                  id="pollIntervalMs"
                  type="number"
                  min={500}
                  step={100}
                  value={form.pollIntervalMs}
                  onChange={(e) => updateField('pollIntervalMs', e.target.value)}
                />
                <span className="field-hint">Lower = faster detection, higher ban risk</span>
              </div>
            </div>
          </section>

          <section className="form-section">
            <h3>Region Filter</h3>
            <p className="section-desc">
              Optional rules stored with the account. Only orders matching these ZIP prefixes or states
              should be accepted (enforced when backend filtering is enabled).
            </p>
            <div className="form-grid">
              <div className="form-field form-field-wide">
                <label htmlFor="regionZipPrefixes">Allowed ZIP Prefixes</label>
                <input
                  id="regionZipPrefixes"
                  value={form.regionZipPrefixes}
                  onChange={(e) => updateField('regionZipPrefixes', e.target.value)}
                  placeholder="32, 33, 34"
                />
                <span className="field-hint">Comma-separated ZIP code prefixes</span>
              </div>
              <div className="form-field">
                <label htmlFor="regionStates">Allowed States</label>
                <input
                  id="regionStates"
                  value={form.regionStates}
                  onChange={(e) => updateField('regionStates', e.target.value)}
                  placeholder="FL, CA, TX"
                />
                <span className="field-hint">Comma-separated state codes</span>
              </div>
            </div>
          </section>

          <div className="form-actions">
            <button type="button" className="btn btn-secondary" onClick={() => navigate('/accounts')}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={loading}>
              {loading ? (editing ? 'Saving…' : 'Creating…') : editing ? 'Save Changes' : 'Create Account'}
            </button>
          </div>
        </form>
      )}
    </div>
  )
}

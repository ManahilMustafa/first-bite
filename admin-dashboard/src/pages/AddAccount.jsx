import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { createAccount } from '../api/client'
import { parseCsvList } from '../utils/format'

const initialForm = {
  label: '',
  portalUsername: '',
  portalPassword: '',
  portalBaseUrl: '',
  forwardingEmail: '',
  pollIntervalMs: '10000',
  regionZipPrefixes: '',
  regionStates: '',
}

export function AddAccount() {
  const navigate = useNavigate()
  const [form, setForm] = useState(initialForm)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)

  function updateField(field, value) {
    setForm((prev) => ({ ...prev, [field]: value }))
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)
    setLoading(true)

    const payload = {
      label: form.label.trim(),
      portalUsername: form.portalUsername.trim(),
      portalPassword: form.portalPassword,
      portalBaseUrl: form.portalBaseUrl.trim(),
      pollIntervalMs: Number(form.pollIntervalMs) || 10000,
    }

    if (form.forwardingEmail.trim()) {
      payload.forwardingEmail = form.forwardingEmail.trim().toLowerCase()
    }

    const zipPrefixes = parseCsvList(form.regionZipPrefixes)
    const states = parseCsvList(form.regionStates, true)
    if (zipPrefixes.length) payload.regionZipPrefixes = zipPrefixes
    if (states.length) payload.regionStates = states

    try {
      await createAccount(payload)
      navigate('/accounts')
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to create account')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h2>Add Account</h2>
          <p className="page-subtitle">Connect a new E-Street vendor account and optional region rules</p>
        </div>
      </header>

      <form className="form-panel" onSubmit={handleSubmit}>
        {error && <div className="alert alert-error">{error}</div>}

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
              <label htmlFor="portalPassword">Portal Password *</label>
              <input
                id="portalPassword"
                type="password"
                value={form.portalPassword}
                onChange={(e) => updateField('portalPassword', e.target.value)}
                required
              />
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
                The mailbox this user's order emails are forwarded FROM — used to route
                forwarded emails to this account.
              </span>
            </div>
            <div className="form-field">
              <label htmlFor="pollIntervalMs">Poll Interval (ms)</label>
              <input
                id="pollIntervalMs"
                type="number"
                min={5000}
                step={1000}
                value={form.pollIntervalMs}
                onChange={(e) => updateField('pollIntervalMs', e.target.value)}
              />
              <span className="field-hint">
                Default 10000. Lower = faster detection, higher ban risk. Server floors at 5000ms.
              </span>
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
            {loading ? 'Creating…' : 'Create Account'}
          </button>
        </div>
      </form>
    </div>
  )
}

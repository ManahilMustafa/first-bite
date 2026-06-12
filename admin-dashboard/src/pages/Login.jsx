import { useState } from 'react'
import { Navigate } from 'react-router-dom'
import { getHealth } from '../api/client'
import { useAuth } from '../context/AuthContext'

export function Login() {
  const { isAuthenticated, login } = useAuth()
  const [token, setToken] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  if (isAuthenticated) return <Navigate to="/" replace />

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      localStorage.setItem('estreet_admin_token', token.trim())
      await getHealth()
      login(token.trim())
    } catch {
      localStorage.removeItem('estreet_admin_token')
      setError('Invalid token or backend unreachable. Ensure the bot is running on port 8787.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-brand">
          <div className="brand-icon brand-icon-lg">E</div>
          <h1>E-Street Admin</h1>
          <p>Sign in with your control plane token to manage bot accounts.</p>
        </div>

        <form onSubmit={handleSubmit} className="login-form">
          <label htmlFor="token">Admin Token</label>
          <input
            id="token"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="CONTROL_PLANE_TOKEN"
            required
            autoFocus
          />
          {error && <p className="form-error">{error}</p>}
          <button type="submit" className="btn btn-primary btn-block" disabled={loading}>
            {loading ? 'Connecting…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  )
}

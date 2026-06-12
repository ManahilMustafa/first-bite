import { useCallback, useEffect, useState } from 'react'
import { getAccounts } from '../api/client'

const REFRESH_MS = 7000

export function useAccounts(intervalMs = REFRESH_MS) {
  const [accounts, setAccounts] = useState([])
  const [live, setLive] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [lastUpdated, setLastUpdated] = useState(null)

  const refresh = useCallback(async () => {
    try {
      const data = await getAccounts()
      setAccounts(data.accounts || [])
      setLive(data.live || [])
      setError(null)
      setLastUpdated(new Date())
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to load accounts')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, intervalMs)
    return () => clearInterval(id)
  }, [refresh, intervalMs])

  return { accounts, live, loading, error, lastUpdated, refresh }
}

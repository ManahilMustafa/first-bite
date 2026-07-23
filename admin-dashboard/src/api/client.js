import axios from 'axios'

const API_BASE = import.meta.env.VITE_API_URL || ''
const TOKEN_KEY = 'estreet_admin_token'

export function getToken() {
  return import.meta.env.VITE_API_TOKEN || localStorage.getItem(TOKEN_KEY) || ''
}

export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token)
  else localStorage.removeItem(TOKEN_KEY)
}

// Every endpoint here is backed by local persisted data (JSONL/encrypted-JSON
// files) — none of them call Gmail or the portal — so a real response is always
// fast. 8s is generous headroom for a slow machine, not a real operation time;
// if a request ever takes that long something is genuinely broken and should
// fail fast rather than leave the UI hanging.
const client = axios.create({
  baseURL: API_BASE,
  timeout: 8000,
})

client.interceptors.request.use((config) => {
  const token = getToken()
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

export async function getHealth() {
  const { data } = await client.get('/health')
  return data
}

export async function getAccounts() {
  const { data } = await client.get('/api/accounts')
  return data
}

export async function createAccount(payload) {
  const { data } = await client.post('/api/accounts', payload)
  return data
}

export async function setAccountActive(id, active) {
  const { data } = await client.post(`/api/accounts/${id}/activate`, { active })
  return data
}

export async function deleteAccount(id) {
  const { data } = await client.delete(`/api/accounts/${id}`)
  return data
}

// Central inbox: ONE Gmail connection for the whole system (all users forward here).
export async function getGmailAuthUrl() {
  const { data } = await client.get('/api/gmail/auth-url')
  return data
}

export async function getGmailStatus() {
  const { data } = await client.get('/api/gmail/status')
  return data
}

export async function getOrders(params = {}) {
  const { data } = await client.get('/api/orders', { params })
  return data
}

// Live Orders view: one record per order (repeated attempts collapsed), with a
// single final status + a full technical timeline. Pure local-data aggregation
// server-side — always fast, never waits on Gmail/portal operations.
export async function getLiveOrders(params = {}) {
  const { data } = await client.get('/api/orders/live', { params })
  return data
}

export async function getStats() {
  const { data } = await client.get('/api/stats')
  return data
}

export async function scanInbox() {
  const { data } = await client.post('/api/orders/scan')
  return data
}

export default client

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

const client = axios.create({
  baseURL: API_BASE,
  timeout: 15000,
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

export async function getGmailAuthUrl(accountId) {
  const { data } = await client.get(`/api/accounts/${accountId}/gmail/auth-url`)
  return data
}

export default client

/**
 * lib/api.ts
 * Thin fetch wrapper:
 * - In the browser, calls go to /api/... (same-origin, Nginx proxies to API)
 * - NEXT_PUBLIC_API_URL can override for local dev pointing at localhost:4000
 * - Attaches Authorization: Bearer <token> from localStorage
 * - On 401 attempts a token refresh, retries once, then redirects to /login
 */

const BASE = typeof window !== 'undefined'
  ? (process.env.NEXT_PUBLIC_API_URL ?? '')   // '' = same-origin /api/...
  : ''

function getToken() {
  if (typeof window === 'undefined') return null
  return localStorage.getItem('chronos_access_token')
}
function setToken(t: string) {
  localStorage.setItem('chronos_access_token', t)
}
export function clearToken() {
  localStorage.removeItem('chronos_access_token')
  localStorage.removeItem('chronos_user')
}

async function refreshToken(): Promise<boolean> {
  const res = await fetch(`${BASE}/api/auth/refresh`, { method: 'POST', credentials: 'include' })
  if (!res.ok) return false
  const data = await res.json()
  if (data.accessToken) { setToken(data.accessToken); return true }
  return false
}

export async function apiFetch<T = unknown>(
  path: string,
  options: RequestInit = {},
  retry = true,
): Promise<T> {
  const token = getToken()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> ?? {}),
  }
  if (token) headers['Authorization'] = `Bearer ${token}`

  const url = `${BASE}/api${path}`
  const res = await fetch(url, { credentials: 'include', ...options, headers })

  if (res.status === 401 && retry) {
    const ok = await refreshToken()
    if (ok) return apiFetch<T>(path, options, false)
    clearToken()
    if (typeof window !== 'undefined') window.location.href = '/login'
    throw new Error('Unauthorized')
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: { message: res.statusText } }))
    throw new Error(err?.error?.message ?? 'Request failed')
  }

  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

export function storeUser(user: unknown, token: string) {
  setToken(token)
  localStorage.setItem('chronos_user', JSON.stringify(user))
}

export function getUser() {
  if (typeof window === 'undefined') return null
  const raw = localStorage.getItem('chronos_user')
  return raw ? JSON.parse(raw) : null
}

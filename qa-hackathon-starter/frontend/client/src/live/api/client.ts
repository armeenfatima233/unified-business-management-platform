import type { ApiErrorBody } from './types'

// Every screen talks to the real backend. The inbox, payments, calendar and integrations screens belong to
// the separately built integrations module and show an honest "not connected yet" state until it is attached.
export const API_BASE_URL: string = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8080'

// Carries the backend's plain-language message plus its machine code, so screens can show the message
// and still branch on the code (e.g. REQUIRED_FIELDS_MISSING, VERSION_CONFLICT, 403 → no-permission state).
export class ApiError extends Error {
  status: number
  code: string
  details?: Record<string, unknown>
  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

export const UNAUTHENTICATED_EVENT = 'unify:unauthenticated'

export async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response
  try {
    // The session is an httpOnly cookie set by the backend, so credentials must be sent.
    response = await fetch(`${API_BASE_URL}/api/v1${path}`, {
      ...options,
      credentials: 'include',
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers ?? {}) },
    })
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Could not reach the server. Check that the backend is running and try again.')
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ApiErrorBody | null
    const code = body?.error?.code ?? 'UNKNOWN_ERROR'
    // A session that ended while the app was open sends the user back to the sign-in screen.
    if (response.status === 401 && !path.startsWith('/auth/')) window.dispatchEvent(new Event(UNAUTHENTICATED_EVENT))
    throw new ApiError(response.status, code, body?.error?.message ?? 'The request could not be completed.', body?.error?.details)
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

export const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) })

// Builds "?a=1&b=2" from defined values; arrays repeat the key.
export function qs(params: Record<string, string | number | boolean | undefined | null | string[]>): string {
  const sp = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    if (Array.isArray(value)) value.forEach(v => sp.append(key, v))
    else sp.set(key, String(value))
  }
  const text = sp.toString()
  return text ? `?${text}` : ''
}


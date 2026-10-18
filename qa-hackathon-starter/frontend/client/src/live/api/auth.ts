import { apiFetch, json } from './client'
import type { Availability, BaseLevel, Permission, User } from './types'

// What the backend returns for me / login / signup / accept-invitation (docs/API_CONTRACT.md).
type SessionResponse = {
  user: { id: string; email: string; name: string }
  workspace: { id: string; name: string }
  baseLevel: BaseLevel
  availability?: Availability
  permissions?: Permission[]
}

const initialsOf = (name: string) => name.split(/\s+/).filter(Boolean).map(part => part[0]).join('').slice(0, 2).toUpperCase() || '?'

export const toUser = (r: SessionResponse): User => ({
  id: r.user.id, name: r.user.name, email: r.user.email, initials: initialsOf(r.user.name), workspaceName: r.workspace.name,
  baseLevel: r.baseLevel, availability: r.availability ?? 'available', permissions: r.permissions ?? [],
})

export const getCurrentUser = () => apiFetch<SessionResponse>('/auth/me').then(toUser)
export const login = (email: string, password: string) => apiFetch<SessionResponse>('/auth/login', { method: 'POST', ...json({ email, password }) }).then(toUser)
export const signup = (p: { workspaceName: string; name: string; email: string; password: string }) => apiFetch<SessionResponse>('/auth/signup', { method: 'POST', ...json(p) }).then(toUser)
export const acceptInvitation = (p: { token: string; name: string; password: string }) => apiFetch<SessionResponse>('/auth/accept-invitation', { method: 'POST', ...json(p) }).then(toUser)
export const logout = () => apiFetch<void>('/auth/logout', { method: 'POST' })

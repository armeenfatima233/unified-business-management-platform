import { apiFetch, json } from './client'
import type { Availability, BaseLevel, Invitation, Member, Permission } from './types'

export const listMembers = () => apiFetch<{ items: Member[] }>('/members').then(r => r.items)
export const inviteMember = (email: string, baseLevel: Exclude<BaseLevel, 'owner'>) => apiFetch<Invitation>('/members/invitations', { method: 'POST', ...json({ email, baseLevel }) })
export const changeRole = (id: string, baseLevel: Exclude<BaseLevel, 'owner'>) => apiFetch<{ id: string; baseLevel: BaseLevel; permissions: Permission[] }>(`/members/${id}/role`, { method: 'PATCH', ...json({ baseLevel }) })
export const setPermissions = (id: string, permissions: Permission[]) => apiFetch<{ id: string; permissions: Permission[] }>(`/members/${id}/permissions`, { method: 'PUT', ...json({ permissions }) })
export const removeMember = (id: string) => apiFetch<void>(`/members/${id}`, { method: 'DELETE' })
export const setMyAvailability = (availability: Availability) => apiFetch<{ id: string; availability: Availability }>('/members/me/availability', { method: 'PATCH', ...json({ availability }) })
export const setAvailability = (id: string, availability: Availability) => apiFetch<{ id: string; availability: Availability }>(`/members/${id}/availability`, { method: 'PATCH', ...json({ availability }) })

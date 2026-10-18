import { apiFetch, json, qs } from './client'
import type { Page } from './types'

export type AlertStatus = 'pending' | 'sent' | 'failed'
export type EscalationAlert = {
  id: string; leadId: string; lead: string; source: string; recipient: string; reason: string | null
  status: AlertStatus; attempts: number; lastError: string | null; createdAt: string
  history: { at: string; result: string; detail: string | null }[]
}
export type NotificationDestination = { channel: 'email'; email: string | null; effectiveEmail: string; usingAccountEmail: boolean }

export const listAlerts = (p: { status?: AlertStatus; page?: number; pageSize?: number }) => apiFetch<Page<EscalationAlert>>(`/notifications/alerts${qs({ ...p })}`)
export const retryAlert = (id: string) => apiFetch<{ id: string; status: AlertStatus }>(`/notifications/alerts/${id}/retry`, { method: 'POST' })
export const getMyDestination = () => apiFetch<NotificationDestination>('/me/notification-destination')
export const saveMyDestination = (email: string) => apiFetch<NotificationDestination>('/me/notification-destination', { method: 'PUT', ...json({ email }) })
export const clearMyDestination = () => apiFetch<void>('/me/notification-destination', { method: 'DELETE' })

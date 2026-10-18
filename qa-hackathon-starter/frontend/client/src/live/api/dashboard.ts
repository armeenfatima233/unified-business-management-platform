import { apiFetch, json, qs } from './client'
import type { AuditEvent, DashboardSummary, Page, WidgetId } from './types'

// Figures are computed on the server from the same records and definitions the lists use, in the
// viewer's own time zone.
export const getDashboard = () => apiFetch<DashboardSummary>(`/dashboard/summary${qs({ tz: Intl.DateTimeFormat().resolvedOptions().timeZone })}`)
export const saveWidgetPreferences = (hidden: WidgetId[]) => apiFetch<{ hidden: WidgetId[] }>('/dashboard/preferences', { method: 'PUT', ...json({ hidden }) })

export type AuditQuery = { eventType?: string; actorId?: string; from?: string; to?: string; page?: number; pageSize?: number }
export const listAudit = (q: AuditQuery) => apiFetch<Page<AuditEvent>>(`/audit-events${qs({ ...q })}`)

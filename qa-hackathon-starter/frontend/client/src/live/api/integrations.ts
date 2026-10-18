import { apiFetch, json, qs } from './client'
import type { IntegrationItem, Page, ResendSetup, SyncEvent } from './types'

export const listIntegrations = () => apiFetch<{ items: IntegrationItem[] }>('/integrations').then(r => r.items)
export const listSyncEvents = (p: { provider?: string; result?: string; page?: number; pageSize?: number }) => apiFetch<Page<SyncEvent>>(`/integrations/events${qs({ ...p })}`)
export const getResend = () => apiFetch<ResendSetup>('/integrations/resend')
export const saveResend = (body: { webhookSecret: string; apiKey?: string; fromEmail?: string | null; inboundAddress?: string | null }) => apiFetch<ResendSetup>('/integrations/resend', { method: 'PUT', ...json(body) })
export const removeResend = () => apiFetch<void>('/integrations/resend', { method: 'DELETE' })

import { API_BASE_URL, apiFetch, json, qs } from './client'
import type { Lead, LeadDetail, Page, RoutingRules } from './types'

export type LeadQuery = { scope?: 'mine' | 'all' | 'recovery'; search?: string; page?: number; pageSize?: number; createdFrom?: string; escalatedSince?: string; includeClosed?: boolean }

export const listLeads = (q: LeadQuery) => apiFetch<Page<Lead>>(`/leads${qs({ ...q })}`)
export const getLead = (id: string) => apiFetch<LeadDetail>(`/leads/${id}`)
export const acknowledgeLead = (id: string) => apiFetch<{ leadId: string; acknowledgedAt: string; acknowledgedBy: string }>(`/leads/${id}/acknowledge`, { method: 'POST' })
export const reassignLead = (id: string, assigneeId: string) => apiFetch<LeadDetail>(`/leads/${id}/reassign`, { method: 'POST', ...json({ assigneeId }) })
export const closeLead = (id: string) => apiFetch<LeadDetail>(`/leads/${id}/close`, { method: 'POST' })
export const createLead = (body: { contactId?: string; contact?: { name: string; phone?: string; email?: string }; message?: string }) => apiFetch<LeadDetail>('/leads', { method: 'POST', ...json(body) })

export const getRoutingRules = () => apiFetch<RoutingRules>('/settings/lead-routing')
export const saveRoutingRules = (rules: Omit<RoutingRules, 'strategy'>) => apiFetch<RoutingRules>('/settings/lead-routing', { method: 'PUT', ...json(rules) })
export const getPublicForm = () => apiFetch<{ publicKey: string; submitPath: string }>('/settings/public-form')
export const publicFormUrl = (publicKey: string) => `${window.location.origin}${window.location.pathname}?form=${publicKey}`

// The public form has no session: it posts to the key-addressed endpoint and the server stamps the source.
export async function submitPublicLead(publicKey: string, body: { name: string; phone?: string; email?: string; message?: string }) {
  const response = await fetch(`${API_BASE_URL}/api/v1/public/leads/${publicKey}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const data = await response.json().catch(() => null)
  if (!response.ok) throw new Error(data?.error?.message ?? 'We could not send your message. Please try again.')
  return data as { received: boolean; reference: string }
}

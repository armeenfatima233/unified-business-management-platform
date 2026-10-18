import type { Availability, BaseLevel, LeadSource, LeadStatus, Permission } from './api/types'

// ----- Money, time -----
export const money = (value: number | null | undefined, currency = 'USD') =>
  value === null || value === undefined ? '••••' : new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value)

export const compactMoney = (value: number | null | undefined) =>
  value === null || value === undefined ? '••••' : value >= 1_000_000 ? `$${(value / 1_000_000).toFixed(1)}m` : value >= 1000 ? `$${Math.round(value / 1000)}k` : money(value)

// Times come from the server in UTC; they are always shown in the viewer's own time zone.
export const formatDateTime = (iso: string | null | undefined) =>
  iso ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso)) : '—'
export const formatDay = (iso: string) => new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(iso))

export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never'
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000))
  if (seconds < 45) return 'just now'
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`
  if (seconds < 86400) return `${Math.round(seconds / 3600)} hr ago`
  return `${Math.round(seconds / 86400)} d ago`
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '—'
  if (seconds < 60) return `${seconds}s`
  const mins = Math.floor(seconds / 60)
  return mins < 60 ? `${mins}m ${String(seconds % 60).padStart(2, '0')}s` : `${Math.floor(mins / 60)}h ${mins % 60}m`
}

// The countdown changes colour *and* wording as the deadline nears, so colour is never the only signal (Q8).
export function formatCountdown(seconds: number | null): { label: string; tone: 'danger' | 'warning' | 'neutral' } {
  if (seconds === null) return { label: 'No timer', tone: 'neutral' }
  if (seconds <= 0) return { label: 'Overdue · escalating', tone: 'danger' }
  const label = `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s left`
  return seconds <= 60 ? { label: `Hurry · ${label}`, tone: 'danger' } : seconds <= 180 ? { label: `Soon · ${label}`, tone: 'warning' } : { label, tone: 'neutral' }
}

// ----- Labels -----
export const sourceLabel: Record<LeadSource, string> = { web_form: 'Web form', message: 'Incoming message', manual: 'Manual entry' }
export const statusLabel: Record<LeadStatus, string> = { needs_acknowledgement: 'Needs acknowledgement', escalated: 'Escalated', acknowledged: 'Acknowledged', closed: 'Closed' }
export const availabilityLabel: Record<Availability, string> = { available: 'Available', busy: 'Busy', on_leave: 'On leave', offline: 'Offline' }
export const availabilityDot: Record<Availability, string> = { available: 'available', busy: 'busy', on_leave: 'away', offline: 'offline' }
export const levelLabel: Record<BaseLevel, string> = { owner: 'Owner', admin: 'Admin', user: 'User' }

export const permissionLabel: Record<Permission, string> = {
  crmView: 'View CRM records', crmCreate: 'Create records', crmEdit: 'Edit records', crmDelete: 'Delete records', crmExport: 'Export records',
  manageAssignmentRules: 'Manage assignment rules', manageIntegrations: 'Manage integrations', viewAuditLog: 'View audit log', viewOpportunityValue: 'See opportunity values',
}
export const ALL_PERMISSIONS = Object.keys(permissionLabel) as Permission[]

export const initialsOf = (name: string) => name.split(/\s+/).filter(Boolean).map(part => part[0]).join('').slice(0, 2).toUpperCase() || '?'

export const auditLabel = (type: string) => type.replace(/[._]/g, ' ')

// A short, readable summary of an audit before/after snapshot (never the raw JSON dump).
export function summarize(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value !== 'object') return String(value)
  return Object.entries(value as Record<string, unknown>)
    .map(([key, v]) => `${key}: ${Array.isArray(v) ? v.join(', ') || 'none' : typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)}`)
    .join(' · ')
}

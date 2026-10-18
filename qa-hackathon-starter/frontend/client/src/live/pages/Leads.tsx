import { useEffect, useState } from 'react'
import { AlertTriangle, Check, Clock3, Plus, Sparkles, X } from 'lucide-react'
import { acknowledgeLead, closeLead, createLead, getLead, listLeads, reassignLead } from '../api/leads'
import { listMembers } from '../api/team'
import type { Lead, LeadStatus } from '../api/types'
import { Avatar, Badge, Button, Card, EmptyState, LoadingState, SearchBox, SectionHeading } from '../compat/UI'
import { ErrorState, Field, InlineError, Modal, Pager, Tabs } from '../compat/Common'
import { useAsync } from '../useAsync'
import { useApp } from '../compat/app'
import { availabilityLabel, formatCountdown, formatDateTime, initialsOf, sourceLabel, statusLabel, timeAgo } from '../format'

type Tab = 'my' | 'all' | 'recovery'
const PAGE_SIZE = 20
const statusTone: Record<LeadStatus, 'warning' | 'danger' | 'success' | 'neutral'> = { needs_acknowledgement: 'warning', escalated: 'danger', acknowledged: 'success', closed: 'neutral' }

function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value)
  useEffect(() => { const t = window.setTimeout(() => setV(value), ms); return () => window.clearTimeout(t) }, [value, ms])
  return v
}

export function LeadsView() {
  const { user, can, params, go, pushToast, liveTick } = useApp()
  const isManager = can('manageAssignmentRules')
  const [tab, setTab] = useState<Tab>(params.tab === 'recovery' ? 'recovery' : params.scope === 'all' && isManager ? 'all' : 'my')
  const [search, setSearch] = useState('')
  const q = useDebounced(search)
  const [page, setPage] = useState(1)
  const [createdFrom, setCreatedFrom] = useState(params.createdFrom)
  const [escalatedSince, setEscalatedSince] = useState(params.escalatedSince)
  const [now, setNow] = useState(Date.now())
  const [adding, setAdding] = useState(params.add === '1')
  const [reassigning, setReassigning] = useState<Lead>()
  const [detail, setDetail] = useState<string | undefined>(params.open)
  const [busyId, setBusyId] = useState<string>()

  const scope = tab === 'my' ? 'mine' : tab
  const list = useAsync(() => listLeads({ scope, search: q || undefined, page, pageSize: PAGE_SIZE, createdFrom, escalatedSince }), [scope, q, page, createdFrom, escalatedSince, liveTick])
  const counts = useAsync(async () => {
    const [mine, all, recovery] = await Promise.all([listLeads({ scope: 'mine', pageSize: 1 }), isManager ? listLeads({ scope: 'all', pageSize: 1 }) : Promise.resolve(undefined), listLeads({ scope: 'recovery', pageSize: 1 })])
    return { mine: mine.total, all: all?.total, recovery: recovery.total }
  }, [liveTick])

  // One-second tick drives the visible countdowns; at zero the server escalates on its own and the live event refreshes the list.
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(t) }, [])
  useEffect(() => { setPage(1) }, [tab, q, createdFrom, escalatedSince])

  const act = async (lead: Lead, run: () => Promise<unknown>, success: { title: string; detail?: string }) => {
    setBusyId(lead.id)
    try { await run(); pushToast({ ...success, tone: 'success' }); list.reload(); counts.reload() }
    catch (err) { pushToast({ title: 'That didn’t work', detail: err instanceof Error ? err.message : undefined, tone: 'error' }); list.reload() }
    finally { setBusyId(undefined) }
  }

  if (list.error && !list.data) return <ErrorState error={list.error} retry={list.reload} />
  const data = list.data
  const c = counts.data

  return <div className="page"><SectionHeading eyebrow="Lead operations" title="Leads" description="Accountability at a glance. Every new lead has exactly one owner and one visible clock." action={<Button icon={<Plus size={16} />} onClick={() => setAdding(true)} disabled={!can('crmCreate')}>Add lead</Button>} />
    <div className="callout callout-blue"><span className="callout-icon"><Sparkles size={17} /></span><div><strong>Keep the first move obvious.</strong><p>Acknowledge, or simply act: a note, a stage change, a message or an appointment counts as acknowledgement and stops the clock.</p></div></div>
    <div className="toolbar"><Tabs value={tab} onChange={setTab} items={[{ id: 'my', label: 'My leads', count: c?.mine }, ...(isManager ? [{ id: 'all' as const, label: 'All leads', count: c?.all }] : []), { id: 'recovery', label: 'Recovery queue', count: c?.recovery, alert: (c?.recovery ?? 0) > 0 }]} /><div className="toolbar-right"><SearchBox value={search} onChange={setSearch} placeholder="Search leads…" /></div></div>
    {(createdFrom || escalatedSince) && <div className="chip-row">{createdFrom && <span className="chip">Created since {formatDateTime(createdFrom)}<button aria-label="Clear filter" onClick={() => setCreatedFrom(undefined)}><X size={13} /></button></span>}{escalatedSince && <span className="chip">Escalated since {formatDateTime(escalatedSince)}<button aria-label="Clear filter" onClick={() => setEscalatedSince(undefined)}><X size={13} /></button></span>}</div>}
    {!data ? <LoadingState label="Loading leads…" /> : <Card className="table-card" padding={false}>
      <div className="table-head"><span>Lead / source</span><span>Owner</span><span>Status</span><span>Acknowledgement clock</span><span>Actions</span></div>
      {data.items.map(lead => {
        const remaining = lead.deadlineAt ? Math.max(0, Math.ceil((new Date(lead.deadlineAt).getTime() - now) / 1000)) : null
        const countdown = formatCountdown(lead.status === 'acknowledged' || lead.status === 'closed' ? null : remaining)
        const mine = lead.ownerId === user?.id
        return <div className="table-row lead-row" key={lead.id}>
          <div className="lead-cell"><Avatar initials={initialsOf(lead.owner)} tone={lead.status === 'escalated' ? 'rose' : 'indigo'} /><div><button className="link-button" onClick={() => setDetail(lead.id)}><strong>{lead.contact}</strong></button><span>{lead.company ?? 'No company'}</span><Badge tone={lead.source === 'web_form' ? 'info' : lead.source === 'manual' ? 'neutral' : 'success'}>{sourceLabel[lead.source]}</Badge></div></div>
          <div className="owner-cell"><span className="status-dot status-available" />{lead.owner}{mine && ' (you)'}<small>Assigned {timeAgo(lead.assignedAt, now)}</small></div>
          <div><Badge tone={statusTone[lead.status]} icon={lead.status === 'escalated' ? <AlertTriangle size={12} /> : lead.status === 'acknowledged' ? <Check size={12} /> : <Clock3 size={12} />}>{statusLabel[lead.status]}</Badge>{lead.handoverRequired && <small className="row-note">Owner unavailable: handover needed</small>}{lead.escalationCount > 0 && <small className="row-note">Escalated {lead.escalationCount}×</small>}{lead.recoveryReasons.map(reason => <small className="row-note" key={reason}>{reason}</small>)}</div>
          <div className="countdown-cell"><span className={`countdown countdown-${countdown.tone}`}><Clock3 size={14} />{countdown.label}</span><small>{lead.status === 'acknowledged' ? `Acknowledged ${timeAgo(lead.acknowledgedAt, now)}` : lead.status === 'closed' ? 'Closed' : 'An action stops the timer'}</small></div>
          <div className="row-actions">
            {(lead.status === 'needs_acknowledgement' || lead.status === 'escalated') && (mine || isManager) && <Button size="sm" disabled={busyId === lead.id} onClick={() => void act(lead, () => acknowledgeLead(lead.id), { title: 'Lead acknowledged', detail: `${lead.contact} is yours.` })} icon={<Check size={14} />}>Acknowledge</Button>}
            {isManager && lead.status !== 'closed' && <Button size="sm" variant="secondary" onClick={() => setReassigning(lead)}>Reassign</Button>}
            {(mine || isManager) && lead.status !== 'closed' && <Button size="sm" variant="ghost" disabled={busyId === lead.id} onClick={() => void act(lead, () => closeLead(lead.id), { title: 'Lead closed', detail: 'It no longer counts toward anyone’s open-lead limit.' })}>Close</Button>}
          </div>
        </div>
      })}
      {data.items.length === 0 && <EmptyState title={tab === 'recovery' ? 'Nothing needs recovery' : 'No leads here'} description={tab === 'recovery' ? 'Every lead is acknowledged in time. Overdue, repeatedly escalated and idle leads land here with the reason.' : 'New leads from the web form, messages or manual entry appear here the moment they arrive.'} />}
      <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} noun="leads" />
    </Card>}
    {adding && <AddLeadDialog onClose={() => { setAdding(false); if (params.add) go('leads') }} onCreated={() => { setAdding(false); list.reload(); counts.reload() }} />}
    {reassigning && <ReassignDialog lead={reassigning} onClose={() => setReassigning(undefined)} onDone={() => { setReassigning(undefined); list.reload(); counts.reload() }} />}
    {detail && <LeadDetailDialog id={detail} onClose={() => setDetail(undefined)} onOpenContact={contactId => { setDetail(undefined); go('contacts', { open: contactId }) }} />}
  </div>
}

function AddLeadDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { pushToast } = useApp()
  const [f, setF] = useState({ name: '', phone: '', email: '', message: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF(v => ({ ...v, [k]: e.target.value }))
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setError(undefined)
    try {
      const lead = await createLead({ contact: { name: f.name, phone: f.phone || undefined, email: f.email || undefined }, message: f.message || undefined })
      pushToast({ title: 'Lead created', detail: `Assigned to ${lead.owner}. Source: manual entry.`, tone: 'success' }); onCreated()
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not create the lead.') } finally { setBusy(false) }
  }
  return <Modal title="Add a lead" onClose={onClose}><form className="stack" onSubmit={submit}>
    <Field label="Name"><input required maxLength={100} value={f.name} onChange={set('name')} /></Field>
    <div className="form-grid"><Field label="Phone"><input value={f.phone} onChange={set('phone')} placeholder="+1 415 555 0187" /></Field><Field label="Email"><input type="email" value={f.email} onChange={set('email')} /></Field></div>
    <Field label="What did they ask for?"><textarea maxLength={2000} value={f.message} onChange={set('message')} /></Field>
    <p className="muted">It is assigned automatically to the next Available person and labelled as a manual entry. A matching contact is reused.</p>
    <InlineError message={error} /><div className="form-actions"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create lead'}</Button></div></form></Modal>
}

function ReassignDialog({ lead, onClose, onDone }: { lead: Lead; onClose: () => void; onDone: () => void }) {
  const { pushToast } = useApp()
  const members = useAsync(listMembers, [])
  const [choice, setChoice] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const options = (members.data ?? []).filter(m => m.id !== lead.ownerId)
  const submit = async () => {
    setBusy(true); setError(undefined)
    try { await reassignLead(lead.id, choice); pushToast({ title: 'Lead reassigned', detail: 'The new owner’s clock has started.', tone: 'success' }); onDone() }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not reassign.') } finally { setBusy(false) }
  }
  return <Modal title={`Reassign ${lead.contact}`} onClose={onClose}><div className="stack">
    <p className="muted">Currently with <strong>{lead.owner}</strong>. Only people who are Available and below their open-lead limit can take it.</p>
    {!members.data && <LoadingState label="Loading people…" />}
    <div className="chip-row">{options.map(m => <button key={m.id} className="chip" type="button" onClick={() => setChoice(m.id)} aria-pressed={choice === m.id}>{m.name} · {availabilityLabel[m.availability]}</button>)}</div>
    <InlineError message={error} /><div className="form-actions"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button disabled={!choice || busy} onClick={() => void submit()}>{busy ? 'Reassigning…' : 'Reassign'}</Button></div></div></Modal>
}

function LeadDetailDialog({ id, onClose, onOpenContact }: { id: string; onClose: () => void; onOpenContact: (contactId: string) => void }) {
  const detail = useAsync(() => getLead(id), [id])
  const lead = detail.data
  return <Modal title="Lead details" onClose={onClose} wide>{!lead ? (detail.error ? <InlineError message={detail.error.message} /> : <LoadingState />) : <div className="stack">
    <div className="detail-grid"><div><span>Contact</span><strong>{lead.contact}</strong></div><div><span>Source</span><strong>{sourceLabel[lead.source]}</strong></div><div><span>Owner</span><strong>{lead.owner}</strong></div><div><span>Status</span><strong>{statusLabel[lead.status]}</strong></div><div><span>First assigned</span><strong>{formatDateTime(lead.firstAssignedAt)}</strong></div><div><span>First response</span><strong>{formatDateTime(lead.firstResponseAt)}</strong></div></div>
    {lead.message && <div><div className="eyebrow">Their message</div><p>{lead.message}</p></div>}
    <div><div className="eyebrow">Ownership history</div><div className="activity-timeline">{lead.history.map((h, i) => <div key={i}><span className="timeline-icon">→</span><p><strong>{h.from ? `${h.from} → ${h.to}` : `Assigned to ${h.to}`}</strong><span>{h.reason} <em>· {formatDateTime(h.at)}</em></span></p></div>)}</div></div>
    <div className="form-actions"><Button variant="secondary" onClick={() => onOpenContact(lead.contactId)}>Open customer record</Button><Button onClick={onClose}>Done</Button></div></div>}</Modal>
}

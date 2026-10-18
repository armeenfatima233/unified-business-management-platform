import { useEffect, useState } from 'react'
import { ShieldAlert } from 'lucide-react'
import { listAudit } from '../api/dashboard'
import { listMembers } from '../api/team'
import { Avatar, Badge, Card, EmptyState, LoadingState, SectionHeading } from '../compat/UI'
import { ErrorState, OptionSelect, Pager } from '../compat/Common'
import { useAsync } from '../useAsync'
import { useApp } from '../compat/app'
import { auditLabel, formatDateTime, initialsOf, summarize } from '../format'

const GROUPS = [
  { value: 'lead', label: 'Leads' }, { value: 'member', label: 'People & access' }, { value: 'contact', label: 'Contacts' }, { value: 'opportunity', label: 'Opportunities' },
  { value: 'pipeline', label: 'Pipelines' }, { value: 'stage', label: 'Stages' }, { value: 'custom_field', label: 'Custom fields' }, { value: 'routing_rules', label: 'Assignment rules' },
  { value: 'lead.escalated', label: 'Escalations only' }, { value: 'saved_filter', label: 'Saved lists' }, { value: 'payment', label: 'Payments' }, { value: 'integration', label: 'Integrations' },
]

// Read-only on purpose: there is no edit or delete anywhere, and the database refuses them too (F4.3).
export function AuditView() {
  const { liveTick } = useApp()
  const [eventType, setEventType] = useState('')
  const [actorId, setActorId] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [page, setPage] = useState(1)
  const members = useAsync(listMembers, [])
  const events = useAsync(() => listAudit({ eventType: eventType || undefined, actorId: actorId || undefined, from: from ? new Date(from).toISOString() : undefined, to: to ? new Date(`${to}T23:59:59`).toISOString() : undefined, page, pageSize: 25 }), [eventType, actorId, from, to, page, liveTick])
  useEffect(() => setPage(1), [eventType, actorId, from, to])
  if (events.error && !events.data) return <ErrorState error={events.error} retry={events.reload} />

  return <div className="page"><SectionHeading eyebrow="Accountability" title="Audit log" description="Who did what, and when. History can’t be edited or deleted by anyone." />
    <Card><div className="row-gap"><OptionSelect label="Event type" value={eventType} onChange={setEventType} placeholder="All event types" options={GROUPS} /><OptionSelect label="Person" value={actorId} onChange={setActorId} placeholder="Everyone" options={(members.data ?? []).map(m => ({ value: m.id, label: m.name }))} /><label className="select-wrap"><span>From</span><input type="date" value={from} onChange={e => setFrom(e.target.value)} aria-label="From date" /></label><label className="select-wrap"><span>To</span><input type="date" value={to} onChange={e => setTo(e.target.value)} aria-label="To date" /></label></div></Card>
    {!events.data ? <LoadingState label="Loading audit log…" /> : <Card className="table-card" padding={false}>
      <div className="table-head audit-head"><span>Time</span><span>Actor</span><span>Event</span><span>Target</span><span>Before → after</span></div>
      {events.data.items.map(e => <div className="table-row audit-row" key={e.id}><span className="muted">{formatDateTime(e.time)}</span><div className="audit-actor"><Avatar initials={e.actorId ? initialsOf(e.actor) : 'SY'} size="sm" tone={e.actorId ? 'indigo' : 'amber'} />{e.actor}</div><Badge tone="info">{auditLabel(e.type)}</Badge><strong>{e.targetType}{e.targetId ? ` · ${e.targetId.slice(0, 8)}` : ''}</strong><span className="audit-change">{e.before !== null && <span className="json-line">{summarize(e.before)} → </span>}<span className="json-line">{summarize(e.after)}</span></span></div>)}
      {events.data.items.length === 0 && <EmptyState title="No events match" description="Try a wider date range or another event type." />}
      <Pager page={events.data.page} pageSize={events.data.pageSize} total={events.data.total} onPage={setPage} noun="events" />
    </Card>}
    <div className="audit-footer"><span className="muted"><ShieldAlert size={14} /> Only people with the audit permission can open this page. Automatic actions are shown as “System”.</span></div></div>
}

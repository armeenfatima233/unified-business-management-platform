import { useState } from 'react'
import { AlertTriangle, ArrowUpRight, CheckCircle2, Clock3, DollarSign, Flag, Plus, ShieldAlert, SlidersHorizontal } from 'lucide-react'
import { getDashboard, saveWidgetPreferences } from '../api/dashboard'
import type { WidgetId } from '../api/types'
import { Badge, Button, Card, InlineLink, LoadingState, ProgressBar } from '../compat/UI'
import { ErrorState } from '../compat/Common'
import { useAsync } from '../useAsync'
import { useApp } from '../compat/app'
import { availabilityLabel, compactMoney, formatDay, formatDateTime, formatDuration, money } from '../format'

const LABELS: Record<WidgetId, string> = {
  newLeads: 'New leads today', openPipeline: 'Open pipeline value', responseTime: 'Avg. first response', recovery: 'Recovery queue',
  escalations: 'Escalations · 24h', availability: 'Team availability', appointments: 'Upcoming appointments', payments: 'Payments received',
}
const ALL = Object.keys(LABELS) as WidgetId[]
const STAGE_COLORS = ['#4657D7', '#7554CC', '#2C9B79', '#347DA6', '#B77A18']

export function DashboardView() {
  const { user, go, pushToast, liveTick, liveEvents } = useApp()
  const { data, error, reload, setData } = useAsync(getDashboard, [liveTick])
  const [customize, setCustomize] = useState(false)
  if (error && !data) return <ErrorState error={error} retry={reload} />
  if (!data || !user) return <LoadingState label="Loading your overview…" />

  const m = data.metrics
  const hidden = new Set(data.hidden)
  const show = (id: WidgetId) => !hidden.has(id)
  const toggle = async (id: WidgetId) => {
    const next = hidden.has(id) ? data.hidden.filter(h => h !== id) : [...data.hidden, id]
    setData({ ...data, hidden: next }) // optimistic; rolled back if the server refuses
    try { await saveWidgetPreferences(next as WidgetId[]); pushToast({ title: 'Dashboard updated', detail: 'Your choice is remembered.', tone: 'success' }) }
    catch (err) { setData(data); pushToast({ title: 'Could not save your choice', detail: err instanceof Error ? err.message : undefined, tone: 'error' }) }
  }

  const scopeAll = data.scope === 'company' ? 'all' : 'mine'
  const tiles = [
    { id: 'newLeads' as const, value: String(m.newLeads.value), note: 'Created today', tone: 'violet', icon: <Flag size={17} />, open: () => go('leads', { scope: scopeAll, createdFrom: m.newLeads.since }) },
    { id: 'openPipeline' as const, value: m.openPipeline.valueHidden ? '••••' : compactMoney(m.openPipeline.total), note: m.openPipeline.valueHidden ? 'Values are hidden for your role' : `Across ${m.openPipeline.byStage.length} open stages`, tone: 'indigo', icon: <DollarSign size={17} />, open: () => go('pipeline') },
    { id: 'responseTime' as const, value: formatDuration(m.responseTime.averageSeconds), note: m.responseTime.sampleSize ? `From ${m.responseTime.sampleSize} acknowledged leads` : 'No acknowledged leads yet', tone: 'mint', icon: <Clock3 size={17} />, open: () => go('leads', { scope: scopeAll }) },
    { id: 'recovery' as const, value: String(m.recovery.value), note: 'Needs manager attention', tone: 'amber', icon: <ShieldAlert size={17} />, open: () => go('leads', { tab: 'recovery' }) },
    { id: 'escalations' as const, value: String(m.escalations.value), note: 'Automatic reassignments', tone: 'rose', icon: <AlertTriangle size={17} />, open: () => go('leads', { scope: scopeAll, escalatedSince: m.escalations.since }) },
    { id: 'payments' as const, value: m.payments.collected.length ? m.payments.collected.map(c => money(c.amount, c.currency)).join(' + ') : money(0), note: 'Collected this month', tone: 'mint', icon: <CheckCircle2 size={17} />, open: () => go('payments') },
  ]
  const hour = new Date().getHours()
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
  const maxStage = Math.max(1, ...m.openPipeline.byStage.map(s => s.amount ?? s.count))

  return <div className="page"><div className="page-header"><div><div className="eyebrow">{formatDay(data.generatedAt)}</div><h1>{greeting}, {user.name.split(' ')[0]}</h1><p className="lead-copy">{data.scopeLabel} for <strong>{user.workspaceName}</strong>.</p></div><div className="page-actions"><Button variant="secondary" icon={<SlidersHorizontal size={16} />} onClick={() => setCustomize(!customize)}>Customize</Button><Button icon={<Plus size={16} />} onClick={() => go('leads', { add: '1' })}>New lead</Button></div></div>
    {customize && <Card className="customize-card"><div><strong>Customize your overview</strong><p className="muted">Hide figures you don’t need today. Your choice is remembered.</p></div><div className="customize-options">{ALL.map(id => <label key={id} className="check-label"><input type="checkbox" checked={show(id)} onChange={() => void toggle(id)} />{LABELS[id]}</label>)}</div></Card>}
    <div className="metric-grid">{tiles.filter(t => show(t.id)).map(t => <button className={`metric-card metric-${t.tone}`} key={t.id} onClick={t.open} title={data.definitions[t.id]}><div className="metric-top"><span className="metric-icon">{t.icon}</span><ArrowUpRight size={16} /></div><span className="metric-label">{LABELS[t.id]}</span><strong className="metric-value">{t.value}</strong><span className="metric-note">{t.note}</span></button>)}</div>
    <div className="dashboard-grid">
      {show('openPipeline') && <Card className="pipeline-card"><div className="card-heading"><div><div className="eyebrow">Open pipeline value</div><h3>{m.openPipeline.valueHidden ? 'Opportunities by stage' : 'Revenue by stage'}</h3></div><InlineLink onClick={() => go('pipeline')}>View pipeline</InlineLink></div><div className="pipeline-total"><strong>{m.openPipeline.valueHidden ? '••••' : compactMoney(m.openPipeline.total)}</strong><span>{m.openPipeline.valueHidden ? 'amounts need the “see values” permission' : 'open opportunities, won and lost excluded'}</span></div>
        <div className="stage-bars">{m.openPipeline.byStage.length === 0 && <p className="muted">No open stages yet.</p>}{m.openPipeline.byStage.map((stage, i) => <button className="stage-row" key={stage.stageId} onClick={() => go('pipeline', { stageId: stage.stageId })} aria-label={`${stage.stage}: ${stage.count} opportunities`}><div className="stage-row-label"><span>{stage.stage}{m.openPipeline.byStage.some(s => s.pipeline !== stage.pipeline) ? ` · ${stage.pipeline}` : ''}</span><strong>{stage.amount === null ? `${stage.count} deals` : money(stage.amount)}</strong></div><ProgressBar value={((stage.amount ?? stage.count) / maxStage) * 100} color={STAGE_COLORS[i % STAGE_COLORS.length]} /></button>)}</div></Card>}
      {show('availability') && <Card className="availability-card"><div className="card-heading"><div><div className="eyebrow">Team pulse</div><h3>Availability</h3></div><InlineLink onClick={() => go('team')}>Manage</InlineLink></div><div className="availability-number"><strong>{m.availability.available}</strong><span>of {m.availability.total} available now</span></div><div className="availability-track"><span style={{ width: `${m.availability.total ? (m.availability.available / m.availability.total) * 100 : 0}%` }} /></div><div className="availability-list">{(['available', 'busy', 'on_leave', 'offline'] as const).map(s => <div key={s}><span className={`status-dot status-${s === 'on_leave' ? 'away' : s}`} />{availabilityLabel[s]} <Badge tone={s === 'available' ? 'success' : s === 'busy' ? 'warning' : 'neutral'}>{m.availability[s]}</Badge></div>)}</div></Card>}
      {show('appointments') && <Card className="appointments-card"><div className="card-heading"><div><div className="eyebrow">Calendar</div><h3>Upcoming appointments</h3></div><InlineLink onClick={() => go('calendar')}>Open calendar</InlineLink></div>{m.appointments.items.length === 0 ? <p className="muted">No upcoming appointments{m.appointments.count === 0 ? '. Booking becomes available once calendars are connected.' : '.'}</p> : <div className="appointment-list">{m.appointments.items.map(a => <div className="appointment-row" key={a.id}><div className="appointment-copy"><strong>{a.title}</strong><span>{a.contact} · {formatDateTime(a.startsAt)}</span></div><Badge tone="success">Confirmed</Badge></div>)}</div>}</Card>}
      <Card className="activity-card"><div className="card-heading"><div><div className="eyebrow">Live activity</div><h3>What just happened</h3></div><Badge tone="info" icon={<span className="live-dot" />}>Live</Badge></div>{liveEvents.length === 0 ? <p className="muted">New leads, escalations and messages appear here the moment they happen, no refresh needed.</p> : <div className="attention-list">{liveEvents.slice(0, 5).map((event, i) => <div className="attention-item" key={i}><span className={`attention-icon attention-${event.tone === 'warning' ? 'warning' : event.tone === 'success' ? 'success' : 'info'}`}><AlertTriangle size={16} /></span><div><strong>{event.title}</strong><span>{event.detail}</span></div></div>)}</div>}</Card>
    </div></div>
}

import { useState } from 'react'
import { CalendarDays, CircleDollarSign, Inbox, SlidersHorizontal } from 'lucide-react'
import { listAlerts, retryAlert, type AlertStatus } from '../api/alerts'
import { Badge, Button, Card, EmptyState, LoadingState, SectionHeading } from '../compat/UI'
import { ErrorState, NotConnected, OptionSelect, Pager } from '../compat/Common'
import { useAsync } from '../useAsync'
import { useApp } from '../compat/app'
import { formatDateTime } from '../format'

// These four areas are served by the integrations module (messaging, payments, calendar, notifications),
// which is built separately. Until it is connected they say so plainly and show no made-up data.
const note = 'This screen is provided by the integrations module, which is not connected to this build yet. Nothing here is simulated.'

export function InboxView() {
  return <div className="page"><SectionHeading eyebrow="Customer conversations" title="Inbox" description="Every message stays attached to the contact, its owner and its delivery state." /><NotConnected title="Messaging isn’t connected yet" description={`${note} Messages with a contact will also appear on the customer record in the CRM.`} /></div>
}

export function PaymentsView() {
  return <div className="page"><SectionHeading eyebrow="Revenue collection" title="Payments" description="Hosted payment links and provider-confirmed status. Card details never touch this app." /><NotConnected title="Payments aren’t connected yet" description={`${note} The overview already separates collected revenue from projected revenue, so it shows zero collected until real payments arrive.`} /></div>
}

export function CalendarView() {
  return <div className="page"><SectionHeading eyebrow="Appointments" title="Calendar" description="Book from a contact, respect busy times, and always show the viewer’s time zone." /><NotConnected title="Calendars aren’t connected yet" description={`${note} Appointments will appear here and on each customer record.`} /></div>
}

export function IntegrationsView() {
  const items = [
    { name: 'Messaging', detail: 'WhatsApp sandbox or SMS', icon: <Inbox size={20} /> },
    { name: 'Payments', detail: 'Hosted checkout, test mode', icon: <CircleDollarSign size={20} /> },
    { name: 'Calendar', detail: 'Google Calendar, per employee', icon: <CalendarDays size={20} /> },
    { name: 'Notifications', detail: 'Alerts when a lead escalates', icon: <SlidersHorizontal size={20} /> },
  ]
  return <div className="page"><SectionHeading eyebrow="Connected systems" title="Integrations" description="Each connection will show its status, last success, recent errors and what it can and cannot do." />
    <div className="integration-grid">{items.map(i => <Card className="integration-card" key={i.name}><div className="integration-top"><div className="integration-logo">{i.icon}</div><Badge tone="neutral">Not connected</Badge></div><h3>{i.name}</h3><p className="integration-subtitle">{i.detail}</p><div className="integration-note"><span className="info-icon">i</span>Connection setup arrives with the integrations module.</div></Card>)}</div>
    <AlertsCard /></div>
}

// Escalation alerts (email) are sent by the core as soon as a lead escalates. Admins see every one here, with the
// reason it failed and a retry (I4.4). This part is live data, not a placeholder.
function AlertsCard() {
  const { pushToast, liveTick } = useApp()
  const [status, setStatus] = useState('')
  const [page, setPage] = useState(1)
  const alerts = useAsync(() => listAlerts({ status: (status || undefined) as AlertStatus | undefined, page, pageSize: 10 }), [status, page, liveTick])
  if (alerts.error && !alerts.data) return <ErrorState error={alerts.error} retry={alerts.reload} />
  if (!alerts.data) return <LoadingState label="Loading alerts…" />
  const retry = async (id: string) => { try { await retryAlert(id); pushToast({ title: 'Alert queued again', detail: 'It will be sent within a few seconds.', tone: 'success' }); alerts.reload() } catch (err) { pushToast({ title: 'Could not retry', detail: err instanceof Error ? err.message : undefined, tone: 'error' }) } }
  return <Card className="sync-history"><div className="card-heading"><div><div className="eyebrow">Escalation alerts</div><h3>Email alerts when a lead escalates</h3></div><OptionSelect label="Show" value={status} onChange={v => { setStatus(v); setPage(1) }} placeholder="All" options={[{ value: 'pending', label: 'Waiting to send' }, { value: 'sent', label: 'Accepted by the email provider' }, { value: 'failed', label: 'Failed' }]} /></div>
    {alerts.data.items.length === 0 ? <EmptyState title="No alerts yet" description="When a lead escalates, the new owner is emailed and the result is listed here." /> : alerts.data.items.map(a => <div className="sync-row" key={a.id} style={{ gridTemplateColumns: '1.2fr 1fr .8fr 1.6fr auto' }}><span><strong>{a.lead}</strong><br /><span className="muted">{a.source} · {formatDateTime(a.createdAt)}</span></span><span>To {a.recipient}</span><span><Badge tone={a.status === 'sent' ? 'success' : a.status === 'failed' ? 'danger' : 'warning'}>{a.status === 'sent' ? 'Sent' : a.status === 'failed' ? 'Failed' : 'Sending'}</Badge></span><span className={a.status === 'failed' ? 'sync-failed' : 'muted'}>{a.lastError ?? a.reason ?? ''}{a.history.length > 1 ? ` (${a.history.length} attempts logged)` : ''}</span>{a.status === 'failed' ? <Button size="sm" variant="secondary" onClick={() => void retry(a.id)}>Retry</Button> : <span />}</div>)}
    <Pager page={alerts.data.page} pageSize={alerts.data.pageSize} total={alerts.data.total} onPage={setPage} noun="alerts" /></Card>
}

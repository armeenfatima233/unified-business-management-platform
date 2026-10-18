import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Download, Plus, Save, Trash2, X } from 'lucide-react'
import {
  addNote, createCompany, createContact, createSavedFilter, deleteCompany, deleteContact, deleteSavedFilter, exportUrl, getCompany, getContact, listCompanies, listContacts,
  listCustomFields, listPipelines, listSavedFilters, renameCompany, updateContact,
} from '../api/crm'
import { ApiError } from '../api/client'
import { listMembers } from '../api/team'
import type { ContactView, Criteria, CustomFieldDef } from '../api/types'
import { Avatar, Badge, Button, Card, EmptyState, LoadingState, SearchBox, SectionHeading } from '../compat/UI'
import { ConfirmDialog, ErrorState, Field, InlineError, Modal, OptionSelect, Pager, Tabs } from '../compat/Common'
import { CustomFieldsForm, displayValue, initialValues, toPayload, type FieldValues } from '../customFields'
import { useAsync } from '../useAsync'
import { useApp } from '../compat/app'
import { formatDateTime, initialsOf, money, sourceLabel, statusLabel, timeAgo } from '../format'

const PAGE_SIZE = 20
const useDebounced = <T,>(value: T, ms = 300): T => { const [v, setV] = useState(value); useEffect(() => { const t = window.setTimeout(() => setV(value), ms); return () => window.clearTimeout(t) }, [value, ms]); return v }

export function ContactsView() {
  const { params, can, pushToast, liveTick } = useApp()
  const [segment, setSegment] = useState<'contacts' | 'companies'>('contacts')
  const [search, setSearch] = useState('')
  const q = useDebounced(search)
  const [filters, setFilters] = useState<Criteria>({})
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<string | undefined>(params.open)
  const [creating, setCreating] = useState(false)
  const [savedId, setSavedId] = useState('')
  const [saveName, setSaveName] = useState('')
  const [version, setVersion] = useState(0)

  const criteria: Criteria = { ...filters, q: q || undefined }
  const key = JSON.stringify(criteria)
  const list = useAsync(() => listContacts({ ...criteria, page, pageSize: PAGE_SIZE }), [key, page, liveTick, version])
  const members = useAsync(listMembers, [])
  const pipelines = useAsync(listPipelines, [])
  const saved = useAsync(() => listSavedFilters('contact'), [version])
  useEffect(() => { setPage(1) }, [key])

  const stages = useMemo(() => (pipelines.data ?? []).flatMap(p => p.stages.map(s => ({ value: s.id, label: `${s.name} · ${p.name}` }))), [pipelines.data])
  const set = (patch: Partial<Criteria>) => { setSavedId(''); setFilters(f => ({ ...f, ...patch })) }
  const active = Object.entries(filters).filter(([, v]) => v)

  const applySaved = (id: string) => { setSavedId(id); const s = saved.data?.find(x => x.id === id); if (s) { setFilters(s.criteria); setSearch(s.criteria.q ?? '') } else setFilters({}) }
  const saveList = async () => {
    try { const s = await createSavedFilter({ entity: 'contact', name: saveName.trim(), criteria }); setSaveName(''); setVersion(v => v + 1); setSavedId(s.id); pushToast({ title: 'List saved', detail: 'It re-checks the records every time you open it, so it stays up to date.', tone: 'success' }) }
    catch (err) { pushToast({ title: 'Could not save the list', detail: err instanceof Error ? err.message : undefined, tone: 'error' }) }
  }
  const removeSaved = async () => {
    try { await deleteSavedFilter(savedId); setSavedId(''); setVersion(v => v + 1); pushToast({ title: 'List deleted', tone: 'success' }) }
    catch (err) { pushToast({ title: 'Could not delete the list', detail: err instanceof Error ? err.message : undefined, tone: 'error' }) }
  }

  return <div className="page"><SectionHeading eyebrow="Customer records" title="CRM" description="One complete customer view across contacts, companies, opportunities and activity." action={<div className="row-gap">{can('crmExport') && <a className="button button-secondary button-md" href={exportUrl('contacts', criteria)}><Download size={15} />Export CSV</a>}<Button icon={<Plus size={16} />} disabled={!can('crmCreate')} onClick={() => setCreating(true)}>New contact</Button></div>} />
    <div className="toolbar"><div className="segmented" role="tablist"><button role="tab" aria-selected={segment === 'contacts'} className={segment === 'contacts' ? 'segment-active' : ''} onClick={() => setSegment('contacts')}>Contacts{list.data ? <span>{list.data.total}</span> : null}</button><button role="tab" aria-selected={segment === 'companies'} className={segment === 'companies' ? 'segment-active' : ''} onClick={() => setSegment('companies')}>Companies</button></div>{segment === 'contacts' && <SearchBox value={search} onChange={setSearch} placeholder="Search name, email, phone, company…" />}</div>
    {segment === 'companies' ? <CompaniesPane /> : <>
      <Card className="filter-card"><div className="toolbar-wrap"><div className="row-gap">
        <OptionSelect label="Saved list" value={savedId} onChange={applySaved} placeholder="— none —" options={(saved.data ?? []).map(s => ({ value: s.id, label: s.name }))} />
        <OptionSelect label="Owner" value={filters.ownerId ?? ''} onChange={v => set({ ownerId: v || undefined })} placeholder="Anyone" options={(members.data ?? []).map(m => ({ value: m.id, label: m.name }))} />
        <OptionSelect label="Stage" value={filters.stageId ?? ''} onChange={v => set({ stageId: v || undefined })} placeholder="Any stage" options={stages} />
        <label className="select-wrap"><span>Tag</span><input value={filters.tag ?? ''} onChange={e => set({ tag: e.target.value || undefined })} placeholder="e.g. priority" aria-label="Tag" /></label>
        <label className="select-wrap"><span>Created from</span><input type="date" value={filters.createdFrom?.slice(0, 10) ?? ''} onChange={e => set({ createdFrom: e.target.value ? new Date(e.target.value).toISOString() : undefined })} aria-label="Created from" /></label>
      </div><div className="row-gap"><input aria-label="List name" placeholder="Name this list…" value={saveName} onChange={e => setSaveName(e.target.value)} style={{ width: 180 }} /><Button size="sm" variant="secondary" icon={<Save size={14} />} disabled={!saveName.trim() || (active.length === 0 && !q)} onClick={() => void saveList()}>Save list</Button>{savedId && <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} onClick={() => void removeSaved()}>Delete list</Button>}</div></div>
        {active.length > 0 && <div className="chip-row mt">{active.map(([k, v]) => <span className="chip" key={k}>{k === 'ownerId' ? `Owner: ${members.data?.find(m => m.id === v)?.name ?? '…'}` : k === 'stageId' ? `Stage: ${stages.find(s => s.value === v)?.label ?? '…'}` : `${k}: ${String(v).slice(0, 10)}`}<button aria-label={`Remove ${k} filter`} onClick={() => set({ [k]: undefined } as Partial<Criteria>)}><X size={13} /></button></span>)}</div>}</Card>
      <div className="crm-layout"><div className="crm-main">
        {list.error && !list.data ? <ErrorState error={list.error} retry={list.reload} /> : !list.data ? <LoadingState label="Loading contacts…" /> : <Card className="table-card" padding={false}>
          <div className="table-head contact-head"><span>Contact</span><span>Company</span><span>Owner</span><span>Last activity</span><span>Tags</span></div>
          {list.data.items.map(c => <button className={`table-row contact-row ${selected === c.id ? 'row-selected' : ''}`} key={c.id} onClick={() => setSelected(c.id)}><div className="lead-cell"><Avatar initials={initialsOf(c.name)} tone="mint" /><div><strong>{c.name}</strong><span>{c.email ?? c.phone ?? 'No contact details'}</span></div></div><div><strong>{c.company ?? '—'}</strong><small>{c.phone ?? ''}</small></div><div className="owner-cell">{c.owner ?? 'Unassigned'}</div><span className="muted">{c.lastActivity ? timeAgo(c.lastActivity) : 'No activity'}</span><div className="tag-list">{c.optedOut && <Badge tone="danger">Opted out</Badge>}{c.tags.map(t => <Badge key={t} tone={t === 'priority' ? 'warning' : 'neutral'}>{t}</Badge>)}</div></button>)}
          {list.data.items.length === 0 && <EmptyState title="No contacts match" description="Try another search, remove a filter, or add a contact." />}
          <Pager page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onPage={setPage} noun="contacts" />
        </Card>}
      </div>{selected && <ContactPanel id={selected} onClose={() => setSelected(undefined)} onChanged={() => setVersion(v => v + 1)} />}</div></>}
    {creating && <ContactDialog onClose={() => setCreating(false)} onSaved={view => { setCreating(false); setSelected(view.contact.id); setVersion(v => v + 1) }} />}
  </div>
}

// ----- Create / edit -----
function ContactDialog({ existing, onClose, onSaved }: { existing?: ContactView['contact']; onClose: () => void; onSaved: (view: ContactView) => void }) {
  const { pushToast } = useApp()
  const defs = useAsync(() => listCustomFields('contact'), [])
  const companies = useAsync(() => listCompanies({ pageSize: 100 }), [])
  const members = useAsync(listMembers, [])
  const [f, setF] = useState({ name: existing?.name ?? '', email: existing?.email ?? '', phone: existing?.phone ?? '', companyId: existing?.company?.id ?? '', ownerId: existing?.ownerId ?? '', tags: (existing?.tags ?? []).join(', '), optOut: existing?.optedOut ?? false })
  const [cf, setCf] = useState<FieldValues>(initialValues(existing?.customFields ?? []))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ApiError | string>()
  const fields = (defs.data ?? []).map((d: CustomFieldDef) => ({ id: d.id, name: d.name, type: d.fieldType, options: d.options }))
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setError(undefined)
    const body = { name: f.name, email: f.email || null, phone: f.phone || null, companyId: f.companyId || null, ownerId: f.ownerId || null, tags: f.tags.split(',').map(t => t.trim()).filter(Boolean), optOut: f.optOut, customFields: toPayload(fields, cf) }
    try { const view = existing ? await updateContact(existing.id, existing.version, body) : await createContact(body); pushToast({ title: existing ? 'Contact updated' : 'Contact created', tone: 'success' }); onSaved(view) }
    catch (err) { setError(err instanceof ApiError ? err : err instanceof Error ? err.message : 'Could not save.') } finally { setBusy(false) }
  }
  const message = typeof error === 'string' ? error : error?.message
  return <Modal title={existing ? 'Edit contact' : 'New contact'} onClose={onClose} wide><form className="stack" onSubmit={submit}>
    <div className="form-grid"><Field label="Name"><input required maxLength={100} value={f.name} onChange={e => setF({ ...f, name: e.target.value })} /></Field><Field label="Email"><input type="email" value={f.email} onChange={e => setF({ ...f, email: e.target.value })} /></Field><Field label="Phone" hint="Include the country code, e.g. +1 415 555 0187, so messages match this contact."><input value={f.phone} onChange={e => setF({ ...f, phone: e.target.value })} /></Field></div>
    <div className="form-grid"><OptionSelect label="Company" value={f.companyId} onChange={v => setF({ ...f, companyId: v })} placeholder="No company" options={(companies.data?.items ?? []).map(c => ({ value: c.id, label: c.name }))} /><OptionSelect label="Assigned employee" value={f.ownerId} onChange={v => setF({ ...f, ownerId: v })} placeholder="Unassigned" options={(members.data ?? []).map(m => ({ value: m.id, label: m.name }))} /><Field label="Tags" hint="Separate with commas."><input value={f.tags} onChange={e => setF({ ...f, tags: e.target.value })} /></Field></div>
    <label className="check-label"><input type="checkbox" checked={f.optOut} onChange={e => setF({ ...f, optOut: e.target.checked })} />Opted out of messages (they can’t be messaged until this is cleared)</label>
    {fields.length > 0 && <><div className="eyebrow">Custom fields</div><CustomFieldsForm fields={fields} values={cf} onChange={setCf} /></>}
    <InlineError message={message} />{error instanceof ApiError && error.code === 'VERSION_CONFLICT' && <p className="muted">Close this window and reopen the contact to see the latest version.</p>}
    <div className="form-actions"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" disabled={busy}>{busy ? 'Saving…' : existing ? 'Save changes' : 'Create contact'}</Button></div></form></Modal>
}

// ----- The complete customer view (F2.8) -----
type PanelTab = 'overview' | 'activity' | 'conversations' | 'payments' | 'appointments'
function ContactPanel({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { pushToast, can, go } = useApp()
  const view = useAsync(() => getContact(id), [id])
  const [tab, setTab] = useState<PanelTab>('overview')
  const [note, setNote] = useState('')
  const [editing, setEditing] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [busy, setBusy] = useState(false)
  if (view.error) return <ErrorState error={view.error} retry={view.reload} />
  if (!view.data) return <Card className="contact-detail"><LoadingState label="Loading customer…" /></Card>
  const { contact, opportunities, conversations, payments, appointments, activities, leads } = view.data

  const addNoteNow = async () => {
    setBusy(true)
    try { await addNote(id, note.trim()); setNote(''); view.reload(); onChanged(); pushToast({ title: 'Note added', detail: 'It’s on the activity history, and counts as a recorded action on the lead.', tone: 'success' }) }
    catch (err) { pushToast({ title: 'Could not add the note', detail: err instanceof Error ? err.message : undefined, tone: 'error' }) } finally { setBusy(false) }
  }
  const remove = async () => {
    setBusy(true)
    try { await deleteContact(id); pushToast({ title: 'Contact deleted', tone: 'success' }); onChanged(); onClose() }
    catch (err) { setDeleting(false); pushToast({ title: 'Can’t delete this contact', detail: err instanceof Error ? err.message : undefined, tone: 'error' }) } finally { setBusy(false) }
  }
  const messages = conversations.reduce((n, c) => n + c.messages.length, 0)

  return <Card className="contact-detail"><div className="detail-top"><div className="detail-identity"><Avatar initials={initialsOf(contact.name)} tone="mint" size="lg" /><div><h3>{contact.name}</h3><p>{contact.company?.name ?? 'No company'}{contact.email ? ` · ${contact.email}` : ''}</p><div className="detail-badges">{contact.optedOut && <Badge tone="danger">Opted out of messages</Badge>}{contact.tags.map(t => <Badge key={t}>{t}</Badge>)}</div></div></div><button className="more-button" aria-label="Close customer view" onClick={onClose}><X size={18} /></button></div>
    <div className="detail-actions">{can('crmEdit') && <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>Edit</Button>}{can('crmDelete') && <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} onClick={() => setDeleting(true)}>Delete</Button>}</div>
    <Tabs value={tab} onChange={setTab} items={[{ id: 'overview', label: 'Overview' }, { id: 'activity', label: 'Activity', count: activities.length }, { id: 'conversations', label: 'Conversations', count: conversations.length }, { id: 'payments', label: 'Payments', count: payments.length }, { id: 'appointments', label: 'Appointments', count: appointments.length }]} />
    {tab === 'overview' && <>
      <div className="detail-section"><div className="eyebrow">Contact details</div><div className="detail-grid"><div><span>Email</span><strong>{contact.email ?? '—'}</strong></div><div><span>Phone</span><strong>{contact.phone ?? '—'}</strong></div><div><span>Assigned employee</span><strong>{contact.owner ?? 'Unassigned'}</strong></div><div><span>Company</span><strong>{contact.company?.name ?? '—'}</strong></div></div></div>
      {leads.length > 0 && <div className="detail-section"><div className="eyebrow">Leads</div>{leads.map(l => <div className="section-inline" key={l.id}><span>{sourceLabel[l.source]}</span><Badge tone={l.closedAt ? 'neutral' : l.acknowledgedAt ? 'success' : 'warning'}>{l.closedAt ? statusLabel.closed : l.acknowledgedAt ? statusLabel.acknowledged : l.escalationCount ? statusLabel.escalated : statusLabel.needs_acknowledgement}</Badge></div>)}</div>}
      <div className="detail-section"><div className="section-inline"><div><div className="eyebrow">Opportunities</div><strong>{opportunities.length === 0 ? 'None yet' : `${opportunities.length} linked`}</strong></div><Button size="sm" variant="secondary" onClick={() => go('pipeline')}>Open pipeline</Button></div>{opportunities.map(o => <div className="opportunity-mini" key={o.id}><span><strong>{o.name}</strong> · {o.pipeline}</span><span>{o.valueHidden ? '••••' : money(o.value, o.currency)}</span><Badge tone={o.stageKind === 'won' ? 'success' : o.stageKind === 'lost' ? 'danger' : 'info'}>{o.stage}</Badge></div>)}</div>
      {contact.customFields.length > 0 && <div className="detail-section"><div className="eyebrow">Custom fields</div><div className="custom-field-list">{contact.customFields.map(f => <div key={f.id}><span>{f.name}</span><strong>{displayValue(f)}</strong></div>)}</div></div>}
    </>}
    {tab === 'activity' && <div className="detail-section"><div className="eyebrow">Activity history · newest first</div>{activities.length === 0 ? <p className="muted">Nothing recorded yet.</p> : <div className="activity-timeline">{activities.map(a => <div key={a.id}><span className="timeline-icon">{a.type === 'note' ? '✎' : a.type === 'stage_change' ? '→' : a.type === 'lead' ? '⚑' : a.type === 'payment' ? '$' : '•'}</span><p><strong>{a.text}</strong><span>{a.actor} <em>· {formatDateTime(a.at)}</em></span></p></div>)}</div>}</div>}
    {tab === 'conversations' && <div className="detail-section">{messages === 0 ? <p className="muted">No messages with this contact yet. Conversations appear here once messaging is connected and the customer writes in.</p> : conversations.map(c => <div key={c.id}><div className="eyebrow">{c.channel}</div>{c.messages.map(m => <div className={`message-row ${m.direction === 'inbound' ? 'message-incoming' : 'message-outgoing'}`} key={m.id}><div className="message-bubble"><p>{m.body}</p><div className="message-meta"><span>{formatDateTime(m.at)}</span>{m.direction === 'outbound' && <span className={`delivery delivery-${m.status}`}>{m.status}</span>}</div>{m.failureReason && <div className="failure-copy"><AlertTriangle size={13} />{m.failureReason}</div>}</div></div>)}</div>)}</div>}
    {tab === 'payments' && <div className="detail-section">{payments.length === 0 ? <p className="muted">No payment requests yet. Payments appear here once payments are connected.</p> : payments.map(p => <div className="section-inline" key={p.id}><span><strong>{money(p.amount, p.currency)}</strong> · {p.requestedBy ?? 'unknown'} <em className="muted">{p.providerReference}</em></span><Badge tone={p.status === 'paid' ? 'success' : p.status === 'pending' ? 'warning' : 'neutral'}>{p.status.replace('_', ' ')}</Badge></div>)}</div>}
    {tab === 'appointments' && <div className="detail-section">{appointments.length === 0 ? <p className="muted">No appointments yet. Booking appears here once calendars are connected.</p> : appointments.map(a => <div className="section-inline" key={a.id}><span><strong>{a.title}</strong> · {formatDateTime(a.startsAt)} <em className="muted">({a.timezone})</em></span><Badge tone={a.status === 'confirmed' ? 'success' : 'neutral'}>{a.status}</Badge></div>)}</div>}
    {can('crmEdit') && <div className="note-box"><textarea aria-label="Add a note" value={note} onChange={e => setNote(e.target.value)} maxLength={5000} placeholder="Add a note…" /><Button size="sm" disabled={!note.trim() || busy} onClick={() => void addNoteNow()} icon={<Plus size={14} />}>Add note</Button></div>}
    {editing && <ContactDialog existing={contact} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); view.reload(); onChanged() }} />}
    {deleting && <ConfirmDialog title="Delete this contact?" danger confirmLabel="Delete contact" busy={busy} message={<>This removes <strong>{contact.name}</strong> and their activity history. Contacts with linked opportunities, leads, payments or appointments can’t be deleted.</>} onCancel={() => setDeleting(false)} onConfirm={() => void remove()} />}
  </Card>
}

// ----- Companies -----
function CompaniesPane() {
  const { can, pushToast } = useApp()
  const [search, setSearch] = useState('')
  const q = useDebounced(search)
  const [page, setPage] = useState(1)
  const [version, setVersion] = useState(0)
  const [name, setName] = useState('')
  const [open, setOpen] = useState<string>()
  useEffect(() => setPage(1), [q])
  const list = useAsync(() => listCompanies({ search: q || undefined, page, pageSize: PAGE_SIZE }), [q, page, version])
  const add = async (e: React.FormEvent) => {
    e.preventDefault()
    try { await createCompany(name.trim()); setName(''); setVersion(v => v + 1); pushToast({ title: 'Company added', tone: 'success' }) }
    catch (err) { pushToast({ title: 'Could not add the company', detail: err instanceof Error ? err.message : undefined, tone: 'error' }) }
  }
  if (list.error && !list.data) return <ErrorState error={list.error} retry={list.reload} />
  return <div className="stack"><div className="toolbar-wrap"><SearchBox value={search} onChange={setSearch} placeholder="Search companies…" />{can('crmCreate') && <form className="row-gap" onSubmit={add}><input aria-label="New company name" required maxLength={100} placeholder="New company name" value={name} onChange={e => setName(e.target.value)} style={{ width: 220 }} /><Button type="submit" icon={<Plus size={15} />}>Add company</Button></form>}</div>
    {!list.data ? <LoadingState label="Loading companies…" /> : <Card className="table-card" padding={false}><div className="table-head simple"><span>Company</span><span>Contacts</span><span>Created</span><span /></div>{list.data.items.map(c => <button className="table-row simple" key={c.id} onClick={() => setOpen(c.id)}><strong>{c.name}</strong><span>{c.contacts}</span><span className="muted">{formatDateTime(c.createdAt)}</span><span className="muted">Open</span></button>)}{list.data.items.length === 0 && <EmptyState title="No companies yet" description="Add a company, then link contacts to it." />}<Pager page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onPage={setPage} noun="companies" /></Card>}
    {open && <CompanyDialog id={open} onClose={() => setOpen(undefined)} onChanged={() => setVersion(v => v + 1)} />}</div>
}

function CompanyDialog({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { can, pushToast } = useApp()
  const company = useAsync(() => getCompany(id), [id])
  const [name, setName] = useState<string>()
  const [confirm, setConfirm] = useState(false)
  const c = company.data
  if (!c) return <Modal title="Company" onClose={onClose}>{company.error ? <InlineError message={company.error.message} /> : <LoadingState />}</Modal>
  const rename = async () => { try { await renameCompany(c.id, c.version, (name ?? c.name).trim()); pushToast({ title: 'Company renamed', tone: 'success' }); setName(undefined); company.reload(); onChanged() } catch (err) { pushToast({ title: 'Could not rename', detail: err instanceof Error ? err.message : undefined, tone: 'error' }) } }
  const remove = async () => { try { await deleteCompany(c.id); pushToast({ title: 'Company deleted', tone: 'success' }); onChanged(); onClose() } catch (err) { setConfirm(false); pushToast({ title: 'Can’t delete this company', detail: err instanceof Error ? err.message : undefined, tone: 'error' }) } }
  return <Modal title={c.name} onClose={onClose}><div className="stack">
    {can('crmEdit') && <div className="row-gap"><input aria-label="Company name" value={name ?? c.name} onChange={e => setName(e.target.value)} style={{ flex: 1 }} /><Button size="sm" variant="secondary" disabled={name === undefined || !name.trim() || name === c.name} onClick={() => void rename()}>Rename</Button></div>}
    <div className="eyebrow">Contacts ({c.contacts.length})</div>{c.contacts.length === 0 ? <p className="muted">No contacts linked yet.</p> : c.contacts.map(x => <div className="section-inline" key={x.id}><strong>{x.name}</strong><span className="muted">{x.email ?? x.phone ?? ''}</span></div>)}
    <div className="form-actions">{can('crmDelete') && <Button variant="ghost" icon={<Trash2 size={14} />} onClick={() => setConfirm(true)}>Delete company</Button>}<Button onClick={onClose}>Done</Button></div>
    {confirm && <ConfirmDialog title="Delete this company?" danger confirmLabel="Delete company" message="A company that still has contacts can’t be deleted." onCancel={() => setConfirm(false)} onConfirm={() => void remove()} />}</div></Modal>
}

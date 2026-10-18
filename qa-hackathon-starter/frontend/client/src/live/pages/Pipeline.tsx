import { useEffect, useMemo, useState } from 'react'
import { Download, Plus, Settings2, Trash2 } from 'lucide-react'
import { ApiError } from '../api/client'
import { createOpportunity, deleteOpportunity, exportUrl, getOpportunity, listContacts, listCustomFields, listOpportunities, listPipelines, moveOpportunity, updateOpportunity } from '../api/crm'
import { listMembers } from '../api/team'
import type { CustomFieldDef, OpportunityRow, Pipeline, Stage } from '../api/types'
import { Avatar, Badge, Button, Card, EmptyState, LoadingState, SearchBox, SectionHeading } from '../compat/UI'
import { ConfirmDialog, ErrorState, Field, InlineError, Modal, OptionSelect, Pager } from '../compat/Common'
import { CustomFieldsForm, displayValue, initialValues, toPayload, type FieldValues } from '../customFields'
import { useAsync } from '../useAsync'
import { useApp } from '../compat/app'
import { formatDateTime, initialsOf, money, timeAgo } from '../format'

const COLORS = ['slate', 'blue', 'indigo', 'mint', 'slate']
const toField = (d: CustomFieldDef) => ({ id: d.id, name: d.name, type: d.fieldType, options: d.options })

export function PipelineView() {
  const { params, can, pushToast, liveTick, go } = useApp()
  const pipelines = useAsync(listPipelines, [liveTick])
  const [pipelineId, setPipelineId] = useState<string>()
  const [mode, setMode] = useState<'board' | 'list'>(params.stageId ? 'list' : 'board')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [version, setVersion] = useState(0)
  const [adding, setAdding] = useState(false)
  const [openId, setOpenId] = useState<string>()
  const [blocked, setBlocked] = useState<{ opp: OpportunityRow; stage: Stage; missing: { id: string; name: string }[]; message: string }>()
  const [dragOver, setDragOver] = useState<string>()

  const all = pipelines.data ?? []
  const pipeline: Pipeline | undefined = all.find(p => p.id === pipelineId) ?? all.find(p => p.stages.some(s => s.id === params.stageId)) ?? all[0]
  const stageFilter = mode === 'list' ? params.stageId : undefined
  const defs = useAsync(() => (pipeline ? listCustomFields('opportunity', pipeline.id) : Promise.resolve([] as CustomFieldDef[])), [pipeline?.id])
  const opps = useAsync(() => pipeline ? listOpportunities({ pipelineId: pipeline.id, stageId: stageFilter, q: search || undefined, page: mode === 'list' ? page : 1, pageSize: mode === 'list' ? 25 : 100 }) : Promise.resolve(undefined), [pipeline?.id, mode, page, search, stageFilter, version, liveTick])
  useEffect(() => setPage(1), [pipeline?.id, search, mode])

  const byStage = useMemo(() => { const m = new Map<string, OpportunityRow[]>(); for (const o of opps.data?.items ?? []) m.set(o.stageId, [...(m.get(o.stageId) ?? []), o]); return m }, [opps.data])

  if (pipelines.error && !pipelines.data) return <ErrorState error={pipelines.error} retry={pipelines.reload} />
  if (!pipeline) return <LoadingState label="Loading pipelines…" />

  const move = async (opp: OpportunityRow, stage: Stage, cf?: Record<string, unknown>) => {
    if (opp.stageId === stage.id && !cf) return
    try {
      await moveOpportunity(opp.id, stage.id, cf)
      setBlocked(undefined); setVersion(v => v + 1)
      pushToast({ title: 'Opportunity moved', detail: `${opp.name} is now in ${stage.name}.`, tone: 'success' })
    } catch (err) {
      if (err instanceof ApiError && err.code === 'REQUIRED_FIELDS_MISSING') setBlocked({ opp, stage, missing: (err.details?.fields as { id: string; name: string }[]) ?? [], message: err.message })
      else pushToast({ title: 'Couldn’t move it', detail: err instanceof Error ? err.message : undefined, tone: 'error' })
    }
  }
  const total = opps.data?.total ?? 0

  return <div className="page"><SectionHeading eyebrow="Revenue workflow" title="Pipeline" description="Drag opportunities between stages, or use the stage menu on a card. Stages can require fields before an opportunity may enter them." action={<div className="view-toggle"><button className={mode === 'board' ? 'toggle-active' : ''} onClick={() => setMode('board')}>Board</button><button className={mode === 'list' ? 'toggle-active' : ''} onClick={() => setMode('list')}>List</button></div>} />
    <div className="pipeline-toolbar"><OptionSelect label="Pipeline" value={pipeline.id} onChange={setPipelineId} options={all.map(p => ({ value: p.id, label: p.name }))} /><SearchBox value={search} onChange={setSearch} placeholder="Search opportunities…" /><div className="pipeline-toolbar-right">{params.stageId && mode === 'list' && <Badge tone="info">Filtered to one stage</Badge>}{can('crmExport') && <a className="button button-secondary button-md" href={exportUrl('opportunities', { pipelineId: pipeline.id })}><Download size={15} />Export</a>}{(can('crmCreate')) && <Button icon={<Plus size={16} />} onClick={() => setAdding(true)}>Add opportunity</Button>}<Button variant="secondary" icon={<Settings2 size={16} />} onClick={() => go('settings', { tab: 'pipelines' })}>Stages</Button></div></div>
    {opps.error && !opps.data ? <ErrorState error={opps.error} retry={opps.reload} /> : !opps.data ? <LoadingState label="Loading opportunities…" /> : mode === 'board' ? <>
      <div className="kanban" role="list">{pipeline.stages.map((stage, i) => { const cards = byStage.get(stage.id) ?? []; const sum = cards.some(c => c.valueHidden) ? null : cards.reduce((s, c) => s + (c.value ?? 0), 0)
        return <div className={`kanban-column ${dragOver === stage.id ? 'drop-target' : ''}`} key={stage.id} role="listitem" aria-label={`${stage.name}, ${cards.length} opportunities`}
          onDragOver={e => { e.preventDefault(); setDragOver(stage.id) }} onDragLeave={() => setDragOver(undefined)}
          onDrop={e => { e.preventDefault(); setDragOver(undefined); const opp = opps.data?.items.find(o => o.id === e.dataTransfer.getData('text/plain')); if (opp) void move(opp, stage) }}>
          <div className="kanban-heading"><span><i className={`column-dot dot-${COLORS[i % COLORS.length]}`} />{stage.name}</span><Badge>{cards.length}</Badge></div>
          <small className="muted">{sum === null ? 'Values hidden' : money(sum)}{stage.requiredFieldIds.length > 0 ? ` · needs ${stage.requiredFieldIds.length} field${stage.requiredFieldIds.length > 1 ? 's' : ''}` : ''}</small>
          {cards.map(card => <div className="opportunity-card" key={card.id} draggable onDragStart={e => e.dataTransfer.setData('text/plain', card.id)}>
            <div className="opportunity-card-top"><Badge tone={stage.kind === 'won' ? 'success' : stage.kind === 'lost' ? 'danger' : 'neutral'}>{stage.name}</Badge></div>
            <button className="link-button" onClick={() => setOpenId(card.id)}><strong>{card.name}</strong></button><span className="muted">{card.contact}{card.company ? ` · ${card.company}` : ''}</span>
            <div className="opportunity-value">{card.valueHidden ? '••••' : money(card.value, card.currency)}</div>
            <div className="opportunity-footer"><Avatar initials={initialsOf(card.owner ?? '?')} size="sm" tone="mint" /><span>{card.owner ?? 'Unassigned'}</span><span className="opportunity-updated">{timeAgo(card.updatedAt)}</span></div>
            {can('crmEdit') && <select aria-label={`Move ${card.name} to another stage`} value={card.stageId} onChange={e => { const s = pipeline.stages.find(x => x.id === e.target.value); if (s) void move(card, s) }}>{pipeline.stages.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select>}
          </div>)}
          {cards.length === 0 && <p className="muted">Nothing here yet.</p>}
        </div> })}</div>
      {total > 100 && <p className="muted">Showing the 100 most recently updated of {total}. Use the list view to page through everything.</p>}</> :
      <Card className="table-card" padding={false}><div className="table-head"><span>Opportunity</span><span>Stage</span><span>Value</span><span>Owner</span><span>Updated</span></div>{opps.data.items.map(o => <div className="table-row" key={o.id}><div className="lead-cell"><Avatar initials={initialsOf(o.contact)} tone="mint" /><div><button className="link-button" onClick={() => setOpenId(o.id)}><strong>{o.name}</strong></button><span>{o.contact}{o.company ? ` · ${o.company}` : ''}</span></div></div><Badge tone={o.stageKind === 'won' ? 'success' : o.stageKind === 'lost' ? 'danger' : 'info'}>{o.stage}</Badge><strong>{o.valueHidden ? '••••' : money(o.value, o.currency)}</strong><span>{o.owner ?? 'Unassigned'}</span><span className="muted">{timeAgo(o.updatedAt)}</span></div>)}{opps.data.items.length === 0 && <EmptyState title="No opportunities" description="Add one, or clear the search." />}<Pager page={opps.data.page} pageSize={opps.data.pageSize} total={opps.data.total} onPage={setPage} noun="opportunities" /></Card>}
    {adding && <NewOpportunity pipeline={pipeline} defs={defs.data ?? []} onClose={() => setAdding(false)} onCreated={() => { setAdding(false); setVersion(v => v + 1) }} />}
    {openId && <OpportunityDialog id={openId} onClose={() => setOpenId(undefined)} onChanged={() => setVersion(v => v + 1)} />}
    {blocked && <Modal title="Fill in the required fields" onClose={() => setBlocked(undefined)}><RequiredFill blocked={blocked} defs={defs.data ?? []} onCancel={() => setBlocked(undefined)} onSubmit={cf => move(blocked.opp, blocked.stage, cf)} /></Modal>}
  </div>
}

function RequiredFill({ blocked, defs, onCancel, onSubmit }: { blocked: { opp: OpportunityRow; stage: Stage; missing: { id: string; name: string }[]; message: string }; defs: CustomFieldDef[]; onCancel: () => void; onSubmit: (cf: Record<string, unknown>) => Promise<void> }) {
  const fields = defs.filter(d => blocked.missing.some(m => m.id === d.id)).map(toField)
  const [values, setValues] = useState<FieldValues>({})
  const [busy, setBusy] = useState(false)
  return <form className="stack" onSubmit={async e => { e.preventDefault(); setBusy(true); await onSubmit(toPayload(fields, values)); setBusy(false) }}>
    <InlineError message={blocked.message} /><p className="muted">“{blocked.opp.name}” can enter <strong>{blocked.stage.name}</strong> once these are filled in.</p>
    <CustomFieldsForm fields={fields} values={values} onChange={setValues} requiredIds={fields.map(f => f.id)} />
    <div className="form-actions"><Button variant="secondary" onClick={onCancel}>Cancel</Button><Button type="submit" disabled={busy}>{busy ? 'Moving…' : `Save and move to ${blocked.stage.name}`}</Button></div></form>
}

function NewOpportunity({ pipeline, defs, onClose, onCreated }: { pipeline: Pipeline; defs: CustomFieldDef[]; onClose: () => void; onCreated: () => void }) {
  const { can, pushToast } = useApp()
  const members = useAsync(listMembers, [])
  const [contactQ, setContactQ] = useState('')
  const [contactId, setContactId] = useState('')
  const [contactName, setContactName] = useState('')
  const [contactsFound, setFound] = useState<{ id: string; name: string; company: string | null }[]>([])
  const [f, setF] = useState({ name: '', value: '', currency: 'USD', stageId: pipeline.stages[0]?.id ?? '', ownerId: '' })
  const [cf, setCf] = useState<FieldValues>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  useEffect(() => { if (contactQ.trim().length < 2) { setFound([]); return } const t = window.setTimeout(() => { listContacts({ q: contactQ, pageSize: 6 }).then(r => setFound(r.items)).catch(() => setFound([])) }, 250); return () => window.clearTimeout(t) }, [contactQ])
  const stage = pipeline.stages.find(s => s.id === f.stageId)
  const fields = defs.map(toField)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setError(undefined)
    try { await createOpportunity({ contactId, pipelineId: pipeline.id, stageId: f.stageId, name: f.name, value: f.value === '' ? undefined : Number(f.value), currency: f.currency, ownerId: f.ownerId || null, customFields: toPayload(fields, cf) }); pushToast({ title: 'Opportunity created', tone: 'success' }); onCreated() }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not create it.') } finally { setBusy(false) }
  }
  return <Modal title="Add an opportunity" onClose={onClose} wide><form className="stack" onSubmit={submit}>
    <Field label="Contact" hint={contactId ? `Selected: ${contactName}` : 'Search by name, email or phone, then choose one.'}><input value={contactQ} onChange={e => { setContactQ(e.target.value); setContactId('') }} placeholder="Start typing…" /></Field>
    {contactsFound.length > 0 && !contactId && <div className="chip-row">{contactsFound.map(c => <button type="button" className="chip" key={c.id} onClick={() => { setContactId(c.id); setContactName(c.name); setContactQ(c.name) }}>{c.name}{c.company ? ` · ${c.company}` : ''}</button>)}</div>}
    <div className="form-grid"><Field label="Opportunity name"><input required maxLength={150} value={f.name} onChange={e => setF({ ...f, name: e.target.value })} /></Field>
      {can('viewOpportunityValue') && <Field label="Value"><input type="number" min="0" step="any" value={f.value} onChange={e => setF({ ...f, value: e.target.value })} /></Field>}
      <OptionSelect label="Stage" value={f.stageId} onChange={v => setF({ ...f, stageId: v })} options={pipeline.stages.map(s => ({ value: s.id, label: s.name }))} />
      <OptionSelect label="Owner" value={f.ownerId} onChange={v => setF({ ...f, ownerId: v })} placeholder="Unassigned" options={(members.data ?? []).map(m => ({ value: m.id, label: m.name }))} /></div>
    {fields.length > 0 && <><div className="eyebrow">Fields for {pipeline.name}</div><CustomFieldsForm fields={fields} values={cf} onChange={setCf} requiredIds={stage?.requiredFieldIds ?? []} /></>}
    <InlineError message={error} /><div className="form-actions"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" disabled={busy || !contactId}>{busy ? 'Creating…' : 'Create opportunity'}</Button></div></form></Modal>
}

function OpportunityDialog({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { can, pushToast, go } = useApp()
  const view = useAsync(() => getOpportunity(id), [id])
  const defs = useAsync(async () => { const v = await getOpportunity(id); return listCustomFields('opportunity', v.opportunity.pipeline.id) }, [id])
  const [edit, setEdit] = useState(false)
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [cf, setCf] = useState<FieldValues>({})
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [error, setError] = useState<string>()
  const v = view.data
  if (!v) return <Modal title="Opportunity" onClose={onClose}>{view.error ? <InlineError message={view.error.message} /> : <LoadingState />}</Modal>
  const o = v.opportunity
  const fields = (defs.data ?? []).map(toField)
  const startEdit = () => { setName(o.name); setValue(o.value === null ? '' : String(o.value)); setCf(initialValues(o.customFields)); setEdit(true); setError(undefined) }
  const save = async () => {
    setBusy(true); setError(undefined)
    try { await updateOpportunity(o.id, o.version, { name, ...(can('viewOpportunityValue') ? { value: value === '' ? null : Number(value) } : {}), customFields: toPayload(fields, cf) }); setEdit(false); view.reload(); onChanged(); pushToast({ title: 'Opportunity updated', tone: 'success' }) }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not save.') } finally { setBusy(false) }
  }
  const remove = async () => {
    setBusy(true)
    try { await deleteOpportunity(o.id); pushToast({ title: 'Opportunity deleted', tone: 'success' }); onChanged(); onClose() }
    catch (err) { setConfirm(false); pushToast({ title: 'Can’t delete it', detail: err instanceof Error ? err.message : undefined, tone: 'error' }) } finally { setBusy(false) }
  }
  const stage = v.stages.find(s => s.id === o.stageId)
  return <Modal title={o.name} onClose={onClose} wide><div className="stack">
    <div className="detail-grid"><div><span>Contact</span><button className="link-button" onClick={() => go('contacts', { open: o.contact.id })}><strong>{o.contact.name}</strong></button></div><div><span>Stage</span><strong>{stage?.name}</strong></div><div><span>Value</span><strong>{o.valueHidden ? '•••• (hidden for your role)' : money(o.value, o.currency)}</strong></div><div><span>Pipeline</span><strong>{o.pipeline.name}</strong></div></div>
    {edit ? <div className="stack"><div className="form-grid"><Field label="Name"><input value={name} maxLength={150} onChange={e => setName(e.target.value)} /></Field>{can('viewOpportunityValue') && <Field label="Value"><input type="number" min="0" step="any" value={value} onChange={e => setValue(e.target.value)} /></Field>}</div><CustomFieldsForm fields={fields} values={cf} onChange={setCf} /><InlineError message={error} /><div className="form-actions"><Button variant="secondary" onClick={() => setEdit(false)}>Cancel</Button><Button disabled={busy || !name.trim()} onClick={() => void save()}>{busy ? 'Saving…' : 'Save changes'}</Button></div></div>
      : <><div><div className="eyebrow">Fields</div>{o.customFields.length === 0 ? <p className="muted">No custom fields in this pipeline.</p> : <div className="custom-field-list">{o.customFields.map(f => <div key={f.id}><span>{f.name}</span><strong>{displayValue(f)}</strong></div>)}</div>}</div>
        <div className="detail-actions">{can('crmEdit') && <Button size="sm" variant="secondary" onClick={startEdit}>Edit</Button>}{can('crmDelete') && <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} onClick={() => setConfirm(true)}>Delete</Button>}</div></>}
    <div><div className="eyebrow">Activity</div>{v.activities.length === 0 ? <p className="muted">No activity yet.</p> : <div className="activity-timeline">{v.activities.map(a => <div key={a.id}><span className="timeline-icon">{a.type === 'stage_change' ? '→' : '•'}</span><p><strong>{a.text}</strong><span>{a.actor} <em>· {formatDateTime(a.at)}</em></span></p></div>)}</div>}</div>
    {confirm && <ConfirmDialog title="Delete this opportunity?" danger confirmLabel="Delete" busy={busy} message="It will be removed from the pipeline. Opportunities with payments can’t be deleted." onCancel={() => setConfirm(false)} onConfirm={() => void remove()} />}</div></Modal>
}

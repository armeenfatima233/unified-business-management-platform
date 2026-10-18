import { useEffect, useState } from 'react'
import { ArrowDown, ArrowUp, Copy, Plus, Tag, Trash2 } from 'lucide-react'
import {
  addStage, createCustomField, createPipeline, deleteCustomField, deletePipeline, deleteSavedFilter, deleteStage, listCustomFields, listPipelines, listSavedFilters, renamePipeline,
  reorderStages, setRequiredFields, updateCustomField, updateStage,
} from '../api/crm'
import { getPublicForm, getRoutingRules, publicFormUrl, saveRoutingRules } from '../api/leads'
import { listMembers } from '../api/team'
import type { CustomFieldDef, CustomFieldType, EntityType, Pipeline, RoutingRules, Stage } from '../api/types'
import { Badge, Button, Card, LoadingState, SectionHeading } from '../compat/UI'
import { ConfirmDialog, ErrorState, Field, InlineError, Modal, OptionSelect } from '../compat/Common'
import { useAsync } from '../useAsync'
import { useApp } from '../compat/app'
import { formatDuration } from '../format'

type Tab = 'fields' | 'pipelines' | 'rules' | 'lists' | 'form'
const TABS: { id: Tab; label: string }[] = [{ id: 'fields', label: 'Custom fields' }, { id: 'pipelines', label: 'Pipelines & stages' }, { id: 'rules', label: 'Assignment rules' }, { id: 'lists', label: 'Saved lists' }, { id: 'form', label: 'Public lead form' }]
const TYPES: { value: CustomFieldType; label: string }[] = [{ value: 'text', label: 'Text' }, { value: 'number', label: 'Number' }, { value: 'date', label: 'Date' }, { value: 'dropdown', label: 'Dropdown' }, { value: 'checkbox', label: 'Checkbox' }]
const ENTITIES: { value: EntityType; label: string }[] = [{ value: 'opportunity', label: 'Opportunities' }, { value: 'contact', label: 'Contacts' }, { value: 'company', label: 'Companies' }]

export function SettingsView() {
  const { params, can } = useApp()
  const [tab, setTab] = useState<Tab>((params.tab as Tab) ?? 'fields')
  const tabs = TABS.filter(t => t.id !== 'rules' || can('manageAssignmentRules'))
  return <div className="page"><SectionHeading eyebrow="Workspace controls" title="Settings" description="Shape your CRM and your lead rules without a developer. Changes apply to everyone straight away and are recorded in the audit log." />
    <div className="settings-tabs" role="tablist">{tabs.map(t => <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'settings-tab-active' : ''} onClick={() => setTab(t.id)}>{t.label}</button>)}</div>
    {tab === 'fields' && <FieldsPane />}{tab === 'pipelines' && <PipelinesPane />}{tab === 'rules' && <RulesPane />}{tab === 'lists' && <ListsPane />}{tab === 'form' && <FormPane />}</div>
}

// ----- Custom fields (F2.2, F2.3) -----
function FieldsPane() {
  const { pushToast } = useApp()
  const defs = useAsync(() => listCustomFields(), [])
  const pipelines = useAsync(listPipelines, [])
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<CustomFieldDef>()
  const [deleting, setDeleting] = useState<CustomFieldDef>()
  if (defs.error && !defs.data) return <ErrorState error={defs.error} retry={defs.reload} />
  if (!defs.data) return <LoadingState label="Loading fields…" />
  const pipelineName = (id: string | null) => id ? pipelines.data?.find(p => p.id === id)?.name ?? 'one pipeline' : 'all pipelines'
  return <div className="stack"><Card><div className="card-heading"><div><div className="eyebrow">Dynamic schema</div><h3>Custom fields</h3></div><Button size="sm" icon={<Plus size={14} />} onClick={() => setAdding(true)}>Add field</Button></div>
    <p className="muted">Fields appear on forms and detail pages as soon as you add them. An opportunity field can belong to one pipeline, so two pipelines show different fields while sharing the same contact.</p>
    {ENTITIES.map(entity => { const rows = defs.data!.filter(d => d.entityType === entity.value); return <div key={entity.value}><div className="eyebrow mt">{entity.label}</div>{rows.length === 0 ? <p className="muted">No custom fields yet.</p> : rows.map(d => <div className="settings-row" key={d.id}><div className="settings-row-icon"><Tag size={15} /></div><div><strong>{d.name}</strong><span>{d.entityType === 'opportunity' ? `In ${pipelineName(d.pipelineId)}` : 'Everywhere'}{d.fieldType === 'dropdown' ? ` · ${d.options.join(', ')}` : ''}</span></div><Badge tone="violet">{d.fieldType}</Badge><div className="row-gap"><Button size="sm" variant="ghost" onClick={() => setEditing(d)}>Edit</Button><Button size="sm" variant="ghost" icon={<Trash2 size={14} />} onClick={() => setDeleting(d)}>Delete</Button></div></div>)}</div> })}</Card>
    {adding && <FieldDialog pipelines={pipelines.data ?? []} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); defs.reload() }} />}
    {editing && <FieldDialog existing={editing} pipelines={pipelines.data ?? []} onClose={() => setEditing(undefined)} onSaved={() => { setEditing(undefined); defs.reload() }} />}
    {deleting && <ConfirmDialog title={`Delete “${deleting.name}”?`} danger confirmLabel="Delete field" message="Its values are removed from every record and any stage that required it stops requiring it. This is recorded in the audit log." onCancel={() => setDeleting(undefined)} onConfirm={async () => { try { await deleteCustomField(deleting.id); pushToast({ title: 'Field deleted', tone: 'success' }); setDeleting(undefined); defs.reload() } catch (err) { setDeleting(undefined); pushToast({ title: 'Could not delete', detail: err instanceof Error ? err.message : undefined, tone: 'error' }) } }} />}</div>
}

function FieldDialog({ existing, pipelines, onClose, onSaved }: { existing?: CustomFieldDef; pipelines: Pipeline[]; onClose: () => void; onSaved: () => void }) {
  const { pushToast } = useApp()
  const [f, setF] = useState({ entityType: existing?.entityType ?? 'opportunity' as EntityType, pipelineId: existing?.pipelineId ?? '', name: existing?.name ?? '', fieldType: existing?.fieldType ?? 'text' as CustomFieldType, options: (existing?.options ?? []).join(', ') })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const options = f.options.split(',').map(o => o.trim()).filter(Boolean)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setError(undefined)
    try {
      if (existing) await updateCustomField(existing.id, { name: f.name, ...(existing.fieldType === 'dropdown' ? { options } : {}) })
      else await createCustomField({ entityType: f.entityType, pipelineId: f.entityType === 'opportunity' && f.pipelineId ? f.pipelineId : null, name: f.name, fieldType: f.fieldType, options: f.fieldType === 'dropdown' ? options : [] })
      pushToast({ title: existing ? 'Field updated' : 'Field added', detail: 'It’s available on forms and detail pages now.', tone: 'success' }); onSaved()
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not save.') } finally { setBusy(false) }
  }
  return <Modal title={existing ? 'Edit field' : 'Add a custom field'} onClose={onClose}><form className="stack" onSubmit={submit}>
    {!existing && <><OptionSelect label="Applies to" value={f.entityType} onChange={v => setF({ ...f, entityType: v as EntityType })} options={ENTITIES} />{f.entityType === 'opportunity' && <OptionSelect label="Pipeline" value={f.pipelineId} onChange={v => setF({ ...f, pipelineId: v })} placeholder="All pipelines" options={pipelines.map(p => ({ value: p.id, label: p.name }))} />}</>}
    <Field label="Field name"><input required maxLength={80} value={f.name} onChange={e => setF({ ...f, name: e.target.value })} /></Field>
    {!existing && <OptionSelect label="Type" value={f.fieldType} onChange={v => setF({ ...f, fieldType: v as CustomFieldType })} options={TYPES} />}
    {f.fieldType === 'dropdown' && (!existing || existing.fieldType === 'dropdown') && <Field label="Options" hint="Separate with commas. An option that records already use can’t be removed."><input value={f.options} onChange={e => setF({ ...f, options: e.target.value })} /></Field>}
    <InlineError message={error} /><div className="form-actions"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" disabled={busy || (f.fieldType === 'dropdown' && options.length === 0)}>{busy ? 'Saving…' : existing ? 'Save' : 'Add field'}</Button></div></form></Modal>
}

// ----- Pipelines and stages (F2.3-F2.5) -----
function PipelinesPane() {
  const { pushToast, liveTick } = useApp()
  const pipelines = useAsync(listPipelines, [liveTick])
  const fields = useAsync(() => listCustomFields('opportunity'), [])
  const [current, setCurrent] = useState<string>()
  const [newName, setNewName] = useState('')
  const [stageName, setStageName] = useState('')
  const [stageKind, setStageKind] = useState<'open' | 'won' | 'lost'>('open')
  const [renaming, setRenaming] = useState<string>()
  const [removingStage, setRemovingStage] = useState<Stage>()
  const [deletingPipeline, setDeletingPipeline] = useState(false)
  const [requiredFor, setRequiredFor] = useState<Stage>()
  const all = pipelines.data ?? []
  const pipeline = all.find(p => p.id === current) ?? all[0]
  if (pipelines.error && !pipelines.data) return <ErrorState error={pipelines.error} retry={pipelines.reload} />
  if (!pipeline) return <LoadingState label="Loading pipelines…" />

  const run = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); pushToast({ title: ok, tone: 'success' }); pipelines.reload() } catch (err) { pushToast({ title: 'That didn’t work', detail: err instanceof Error ? err.message : undefined, tone: 'error' }) } }
  const reorder = (index: number, delta: number) => { const ids = pipeline.stages.map(s => s.id); const j = index + delta; if (j < 0 || j >= ids.length) return;[ids[index], ids[j]] = [ids[j]!, ids[index]!]; void run(() => reorderStages(pipeline.id, ids), 'Stages reordered') }

  return <div className="stack"><Card><div className="card-heading"><div><div className="eyebrow">Customizable pipeline</div><h3>{pipeline.name}</h3></div><div className="row-gap"><OptionSelect label="Pipeline" value={pipeline.id} onChange={setCurrent} options={all.map(p => ({ value: p.id, label: p.name }))} /><Button size="sm" variant="secondary" onClick={() => setRenaming(pipeline.name)}>Rename</Button><Button size="sm" variant="ghost" icon={<Trash2 size={14} />} onClick={() => setDeletingPipeline(true)}>Delete</Button></div></div>
    <form className="row-gap" onSubmit={e => { e.preventDefault(); void run(async () => { const p = await createPipeline(newName.trim()); setCurrent(p.id); setNewName('') }, 'Pipeline created') }}><input aria-label="New pipeline name" placeholder="New pipeline name" required maxLength={80} value={newName} onChange={e => setNewName(e.target.value)} style={{ width: 220 }} /><Button size="sm" variant="secondary" type="submit" icon={<Plus size={14} />}>Create pipeline</Button></form></Card>
    <Card><div className="eyebrow">Stages · top to bottom is left to right on the board</div>
      {pipeline.stages.map((s, i) => <div className="stage-edit" key={s.id}><div><strong>{s.name}</strong> <Badge tone={s.kind === 'won' ? 'success' : s.kind === 'lost' ? 'danger' : 'neutral'}>{s.kind}</Badge> <span className="muted">{s.opportunities} {s.opportunities === 1 ? 'opportunity' : 'opportunities'}{s.requiredFieldIds.length ? ` · requires ${s.requiredFieldIds.length} field(s)` : ''}</span></div><div className="row-gap"><Button size="sm" variant="ghost" disabled={i === 0} onClick={() => reorder(i, -1)} icon={<ArrowUp size={14} />}>Up</Button><Button size="sm" variant="ghost" disabled={i === pipeline.stages.length - 1} onClick={() => reorder(i, 1)} icon={<ArrowDown size={14} />}>Down</Button><Button size="sm" variant="secondary" onClick={() => setRequiredFor(s)}>Required fields</Button><Button size="sm" variant="ghost" onClick={() => { const name = window.prompt('Rename stage', s.name); if (name?.trim()) void run(() => updateStage(s.id, { name: name.trim() }), 'Stage renamed') }}>Rename</Button><Button size="sm" variant="ghost" icon={<Trash2 size={14} />} onClick={() => setRemovingStage(s)}>Delete</Button></div></div>)}
      <form className="row-gap mt" onSubmit={e => { e.preventDefault(); void run(async () => { await addStage(pipeline.id, stageName.trim(), stageKind); setStageName('') }, 'Stage added') }}><input aria-label="New stage name" placeholder="New stage name" required maxLength={80} value={stageName} onChange={e => setStageName(e.target.value)} style={{ width: 200 }} /><OptionSelect value={stageKind} onChange={v => setStageKind(v as 'open' | 'won' | 'lost')} options={[{ value: 'open', label: 'Open' }, { value: 'won', label: 'Won' }, { value: 'lost', label: 'Lost' }]} /><Button size="sm" type="submit" icon={<Plus size={14} />}>Add stage</Button></form></Card>
    {renaming !== undefined && <Modal title="Rename pipeline" onClose={() => setRenaming(undefined)}><form className="stack" onSubmit={e => { e.preventDefault(); void run(() => renamePipeline(pipeline.id, renaming.trim()), 'Pipeline renamed'); setRenaming(undefined) }}><Field label="Name"><input required maxLength={80} value={renaming} onChange={e => setRenaming(e.target.value)} /></Field><div className="form-actions"><Button variant="secondary" onClick={() => setRenaming(undefined)}>Cancel</Button><Button type="submit">Rename</Button></div></form></Modal>}
    {deletingPipeline && <ConfirmDialog title={`Delete “${pipeline.name}”?`} danger confirmLabel="Delete pipeline" message="A pipeline that still holds opportunities can’t be deleted. Fields that belong only to it are removed." onCancel={() => setDeletingPipeline(false)} onConfirm={() => { setDeletingPipeline(false); void run(async () => { await deletePipeline(pipeline.id); setCurrent(undefined) }, 'Pipeline deleted') }} />}
    {removingStage && <StageDelete stage={removingStage} stages={pipeline.stages} onClose={() => setRemovingStage(undefined)} onDone={() => { setRemovingStage(undefined); pipelines.reload() }} />}
    {requiredFor && <RequiredDialog stage={requiredFor} fields={(fields.data ?? []).filter(f => !f.pipelineId || f.pipelineId === pipeline.id)} onClose={() => setRequiredFor(undefined)} onSaved={() => { setRequiredFor(undefined); pipelines.reload() }} />}</div>
}

function StageDelete({ stage, stages, onClose, onDone }: { stage: Stage; stages: Stage[]; onClose: () => void; onDone: () => void }) {
  const { pushToast } = useApp()
  const others = stages.filter(s => s.id !== stage.id)
  const [moveTo, setMoveTo] = useState(others[0]?.id ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const occupied = stage.opportunities > 0
  return <Modal title={`Delete “${stage.name}”?`} onClose={onClose}><div className="stack">
    {occupied ? <><p>{stage.opportunities} opportunit{stage.opportunities === 1 ? 'y is' : 'ies are'} in this stage. Choose where they go first, so nothing is left without a stage.</p><OptionSelect label="Move them to" value={moveTo} onChange={setMoveTo} options={others.map(s => ({ value: s.id, label: s.name }))} /></> : <p>This stage is empty, so it can simply be removed.</p>}
    <InlineError message={error} /><div className="form-actions"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="danger" disabled={busy || (occupied && !moveTo)} onClick={async () => { setBusy(true); try { await deleteStage(stage.id, occupied ? moveTo : undefined); pushToast({ title: 'Stage deleted', detail: occupied ? 'Its opportunities were moved and the move is in their history.' : undefined, tone: 'success' }); onDone() } catch (err) { setError(err instanceof Error ? err.message : 'Could not delete.') } finally { setBusy(false) } }}>{busy ? 'Deleting…' : 'Delete stage'}</Button></div></div></Modal>
}

function RequiredDialog({ stage, fields, onClose, onSaved }: { stage: Stage; fields: CustomFieldDef[]; onClose: () => void; onSaved: () => void }) {
  const { pushToast } = useApp()
  const [picked, setPicked] = useState<Set<string>>(new Set(stage.requiredFieldIds))
  const [error, setError] = useState<string>()
  return <Modal title={`Required to enter “${stage.name}”`} onClose={onClose}><div className="stack">
    {fields.length === 0 ? <p className="muted">There are no opportunity fields yet. Add a custom field first.</p> : <><p className="muted">Moving an opportunity into this stage is blocked, with a clear message, until these are filled in.</p><div className="permission-list">{fields.map(f => <label className="permission-row" key={f.id}><input type="checkbox" checked={picked.has(f.id)} onChange={() => setPicked(s => { const n = new Set(s); if (n.has(f.id)) n.delete(f.id); else n.add(f.id); return n })} /><span>{f.name}</span><small>{f.fieldType}</small></label>)}</div></>}
    <InlineError message={error} /><div className="form-actions"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={async () => { try { await setRequiredFields(stage.id, [...picked]); pushToast({ title: 'Required fields saved', tone: 'success' }); onSaved() } catch (err) { setError(err instanceof Error ? err.message : 'Could not save.') } }}>Save</Button></div></div></Modal>
}

// ----- Lead routing (F3.3-F3.5) -----
function RulesPane() {
  const { pushToast } = useApp()
  const rules = useAsync(getRoutingRules, [])
  const members = useAsync(listMembers, [])
  const [f, setF] = useState<Omit<RoutingRules, 'strategy'> & { levels: string }>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  useEffect(() => { if (rules.data) setF({ ...rules.data, levels: rules.data.levelWindowSeconds.join(', ') }) }, [rules.data])
  if (rules.error && !rules.data) return <ErrorState error={rules.error} retry={rules.reload} />
  if (!f) return <LoadingState label="Loading rules…" />
  const num = (k: 'ackWindowSeconds' | 'maxOpenLeads' | 'escalationLevels' | 'idleSeconds') => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: Number(e.target.value) })
  const people = (members.data ?? []).map(m => ({ value: m.id, label: m.name }))
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setError(undefined)
    try {
      const levelWindowSeconds = f.levels.split(',').map(s => s.trim()).filter(Boolean).map(Number)
      if (levelWindowSeconds.some(n => !Number.isInteger(n) || n < 1)) throw new Error('Per-level windows must be whole numbers of seconds, separated by commas.')
      const saved = await saveRoutingRules({ ackWindowSeconds: f.ackWindowSeconds, maxOpenLeads: f.maxOpenLeads, escalationLevels: f.escalationLevels, idleSeconds: f.idleSeconds, levelWindowSeconds, backupUserId: f.backupUserId || null, managerUserId: f.managerUserId || null })
      pushToast({ title: 'Assignment rules saved', detail: 'New leads and escalations use them from now on.', tone: 'success' }); setF({ ...saved, levels: saved.levelWindowSeconds.join(', ') })
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not save.') } finally { setBusy(false) }
  }
  return <Card><div className="eyebrow">Assignment rules</div><h3>Keep ownership explicit</h3><p className="muted">Leads go round-robin to people who are <strong>Available</strong> and below their open-lead limit. Everything is in seconds, so you can watch an escalation happen in a demo.</p>
    <form className="stack mt" onSubmit={submit}><div className="form-grid">
      <Field label="Acknowledgement window (seconds)" hint={`Currently ${formatDuration(f.ackWindowSeconds)}`}><input type="number" min={1} required value={f.ackWindowSeconds} onChange={num('ackWindowSeconds')} /></Field>
      <Field label="Max open leads per person"><input type="number" min={1} required value={f.maxOpenLeads} onChange={num('maxOpenLeads')} /></Field>
      <Field label="Escalation levels (1–3)" hint="Next person → backup → manager"><input type="number" min={1} max={3} required value={f.escalationLevels} onChange={num('escalationLevels')} /></Field>
      <Field label="Idle threshold (seconds)" hint="Recovery queue: no recorded action for this long"><input type="number" min={1} required value={f.idleSeconds} onChange={num('idleSeconds')} /></Field>
      <Field label="Per-level windows (optional)" hint="e.g. 600, 300, 120 · overrides the window above for each level"><input value={f.levels} onChange={e => setF({ ...f, levels: e.target.value })} /></Field></div>
      <div className="form-grid"><OptionSelect label="Designated backup" value={f.backupUserId ?? ''} onChange={v => setF({ ...f, backupUserId: v || null })} placeholder="None" options={people} /><OptionSelect label="Manager (final fallback)" value={f.managerUserId ?? ''} onChange={v => setF({ ...f, managerUserId: v || null })} placeholder="Workspace Owner" options={people} /></div>
      <p className="muted">If nobody is eligible, the manager owns the lead and it is flagged in the recovery queue, so a lead is never left without one accountable person.</p>
      <InlineError message={error} /><div className="form-actions"><Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save rules'}</Button></div></form></Card>
}

// ----- Saved lists (F2.6) -----
function ListsPane() {
  const { pushToast } = useApp()
  const lists = useAsync(() => listSavedFilters(), [])
  if (lists.error && !lists.data) return <ErrorState error={lists.error} retry={lists.reload} />
  if (!lists.data) return <LoadingState label="Loading lists…" />
  return <Card><div className="eyebrow">Saved lists</div><h3>Lists that keep themselves current</h3><p className="muted">Create a list from the filters in the CRM. It re-checks the records every time, so it updates as records start or stop matching.</p>
    {lists.data.length === 0 ? <p className="muted mt">No saved lists yet. Open the CRM, set a few filters, and choose “Save list”.</p> : lists.data.map(l => <div className="settings-row" key={l.id}><div className="settings-row-icon"><Tag size={15} /></div><div><strong>{l.name}</strong><span>{Object.keys(l.criteria).length} criteria · {l.entity === 'contact' ? 'Contacts' : 'Opportunities'}</span></div><Badge tone="info">{l.entity}</Badge><Button size="sm" variant="ghost" icon={<Trash2 size={14} />} onClick={async () => { try { await deleteSavedFilter(l.id); pushToast({ title: 'List deleted', tone: 'success' }); lists.reload() } catch (err) { pushToast({ title: 'Could not delete', detail: err instanceof Error ? err.message : undefined, tone: 'error' }) } }}>Delete</Button></div>)}</Card>
}

// ----- Public form (F3.1) -----
function FormPane() {
  const { pushToast } = useApp()
  const form = useAsync(getPublicForm, [])
  if (form.error && !form.data) return <ErrorState error={form.error} retry={form.reload} />
  if (!form.data) return <LoadingState label="Loading…" />
  const url = publicFormUrl(form.data.publicKey)
  return <Card><div className="eyebrow">Lead capture</div><h3>Public enquiry form</h3><p className="muted">Share this link on your website or in ads. Anyone can submit it without signing in. Every submission becomes a lead labelled “Web form” and is assigned straight away.</p>
    <div className="link-box mt">{url}</div><div className="form-actions"><Button variant="secondary" icon={<Copy size={14} />} onClick={() => navigator.clipboard?.writeText(url).then(() => pushToast({ title: 'Link copied', tone: 'success' }))}>Copy link</Button><a className="button button-primary button-md" href={url} target="_blank" rel="noreferrer">Open the form</a></div>
    <p className="muted mt">For your own website form, post JSON <code>{'{ name, phone | email, message }'}</code> to <code>{form.data.submitPath}</code>.</p></Card>
}

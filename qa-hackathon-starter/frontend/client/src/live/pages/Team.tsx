import { useEffect, useState } from 'react'
import { AlertTriangle, BellRing, Copy, Plus, Trash2 } from 'lucide-react'
import { clearMyDestination, getMyDestination, saveMyDestination } from '../api/alerts'
import { changeRole, inviteMember, listMembers, removeMember, setAvailability, setPermissions } from '../api/team'
import type { Availability, BaseLevel, Member, Permission } from '../api/types'
import { Avatar, Badge, Button, Card, LoadingState, SectionHeading } from '../compat/UI'
import { ConfirmDialog, ErrorState, Field, InlineError, Modal, OptionSelect } from '../compat/Common'
import { useAsync } from '../useAsync'
import { useApp } from '../compat/app'
import { ALL_PERMISSIONS, availabilityDot, availabilityLabel, initialsOf, levelLabel, permissionLabel } from '../format'

const STATUSES: Availability[] = ['available', 'busy', 'on_leave', 'offline']

export function TeamView() {
  const { user, pushToast, liveTick } = useApp()
  const members = useAsync(listMembers, [liveTick])
  const [inviting, setInviting] = useState(false)
  const [editing, setEditing] = useState<Member>()
  const [removing, setRemoving] = useState<Member>()
  if (members.error && !members.data) return <ErrorState error={members.error} retry={members.reload} />
  if (!members.data || !user) return <LoadingState label="Loading team…" />

  const isOwner = user.baseLevel === 'owner'
  const isAdmin = user.baseLevel !== 'user'
  // An Admin can manage Users; only the Owner manages Admins; nobody manages the Owner (F1.2).
  const manageable = (m: Member) => m.baseLevel !== 'owner' && m.id !== user.id && (isOwner || (isAdmin && m.baseLevel === 'user'))

  const changeStatus = async (m: Member, next: Availability) => {
    try { await setAvailability(m.id, next); members.reload(); pushToast({ title: `${m.name} is now ${availabilityLabel[next]}`, tone: 'success' }) }
    catch (err) { pushToast({ title: 'Could not change the status', detail: err instanceof Error ? err.message : undefined, tone: 'error' }) }
  }

  return <div className="page"><SectionHeading eyebrow="People & access" title="Team & roles" description="Owner, Admin and User are the three base levels. “Manager” is a set of permissions, not a fourth level." action={isAdmin ? <Button icon={<Plus size={16} />} onClick={() => setInviting(true)}>Invite member</Button> : undefined} />
    <MyAlerts />
    <Card className="team-card"><div className="card-heading"><div><div className="eyebrow">Workspace members</div><h3>{members.data.length} {members.data.length === 1 ? 'person' : 'people'}</h3></div></div>
      {members.data.map(m => <div className="member-row" key={m.id}><Avatar initials={initialsOf(m.name)} tone={m.baseLevel === 'owner' ? 'indigo' : 'mint'} /><div className="member-copy"><strong>{m.name}{m.id === user.id ? ' (you)' : ''}</strong><span>{m.email}</span></div><Badge tone={m.baseLevel === 'owner' ? 'violet' : m.baseLevel === 'admin' ? 'info' : 'neutral'}>{levelLabel[m.baseLevel]}</Badge>
        <div className="member-availability"><span className={`status-dot status-${availabilityDot[m.availability]}`} />{isAdmin ? <OptionSelect value={m.availability} onChange={v => void changeStatus(m, v as Availability)} options={STATUSES.map(s => ({ value: s, label: availabilityLabel[s] }))} /> : availabilityLabel[m.availability]}</div>
        <div className="row-gap">{manageable(m) && <Button size="sm" variant="secondary" onClick={() => setEditing(m)}>Access</Button>}{manageable(m) && <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} onClick={() => setRemoving(m)}>Remove</Button>}</div></div>)}
      <div className="leave-notice"><AlertTriangle size={16} /><p><strong>Availability has operational impact.</strong> When someone goes On leave or Offline, their unacknowledged leads are reassigned immediately. Leads they already acknowledged stay with them and show an “owner unavailable” note until a manager hands them over.</p></div></Card>
    {inviting && <InviteDialog canInviteAdmin={isOwner} onClose={() => setInviting(false)} />}
    {editing && <AccessDialog member={editing} isOwner={isOwner} onClose={() => setEditing(undefined)} onSaved={() => { setEditing(undefined); members.reload() }} />}
    {removing && <ConfirmDialog title={`Remove ${removing.name}?`} danger confirmLabel="Remove person" message="They’re signed out everywhere right now and can’t log in. Their open leads are passed to teammates, and their history stays on record." onCancel={() => setRemoving(undefined)} onConfirm={async () => { try { await removeMember(removing.id); pushToast({ title: `${removing.name} was removed`, tone: 'success' }); setRemoving(undefined); members.reload() } catch (err) { setRemoving(undefined); pushToast({ title: 'Could not remove them', detail: err instanceof Error ? err.message : undefined, tone: 'error' }) } }} />}
  </div>
}

function InviteDialog({ canInviteAdmin, onClose }: { canInviteAdmin: boolean; onClose: () => void }) {
  const [email, setEmail] = useState('')
  const [level, setLevel] = useState<'admin' | 'user'>('user')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [link, setLink] = useState<string>()
  const { pushToast } = useApp()
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setError(undefined)
    try { const inv = await inviteMember(email, level); setLink(`${window.location.origin}${window.location.pathname}?invite=${inv.token}`) }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not create the invitation.') } finally { setBusy(false) }
  }
  return <Modal title="Invite a teammate" onClose={onClose}>{link ? <div className="stack"><p>Send this one-time link to <strong>{email}</strong>. It works once and expires in 7 days.</p><div className="link-box">{link}</div><div className="form-actions"><Button variant="secondary" icon={<Copy size={14} />} onClick={() => navigator.clipboard?.writeText(link).then(() => pushToast({ title: 'Link copied', tone: 'success' }))}>Copy link</Button><Button onClick={onClose}>Done</Button></div></div>
    : <form className="stack" onSubmit={submit}><Field label="Email"><input required type="email" value={email} onChange={e => setEmail(e.target.value)} /></Field><OptionSelect label="Level" value={level} onChange={v => setLevel(v as 'admin' | 'user')} options={[{ value: 'user', label: 'User: sees what their permissions allow' }, ...(canInviteAdmin ? [{ value: 'admin', label: 'Admin: configures the workspace' }] : [])]} /><p className="muted">No email is sent yet: you get a link to share yourself.</p><InlineError message={error} /><div className="form-actions"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create invitation'}</Button></div></form>}</Modal>
}

function AccessDialog({ member, isOwner, onClose, onSaved }: { member: Member; isOwner: boolean; onClose: () => void; onSaved: () => void }) {
  const { pushToast } = useApp()
  const [level, setLevel] = useState<BaseLevel>(member.baseLevel)
  const [perms, setPerms] = useState<Set<Permission>>(new Set(member.permissions ?? []))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const toggle = (p: Permission) => setPerms(s => { const n = new Set(s); if (n.has(p)) n.delete(p); else n.add(p); return n })
  const save = async () => {
    setBusy(true); setError(undefined)
    try {
      let current = new Set(perms)
      if (isOwner && level !== member.baseLevel) { const r = await changeRole(member.id, level as 'admin' | 'user'); current = new Set(r.permissions) ; setPerms(current) } // a level change resets permissions to that level's defaults
      if (level === member.baseLevel) await setPermissions(member.id, ALL_PERMISSIONS.filter(p => perms.has(p)))
      pushToast({ title: 'Access updated', detail: `${member.name}’s changes apply immediately.`, tone: 'success' }); onSaved()
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not save.') } finally { setBusy(false) }
  }
  return <Modal title={`Access for ${member.name}`} onClose={onClose}><div className="stack">
    {isOwner && <OptionSelect label="Level" value={level} onChange={v => setLevel(v as BaseLevel)} options={[{ value: 'user', label: 'User' }, { value: 'admin', label: 'Admin' }]} />}
    {level !== member.baseLevel ? <p className="muted">Changing the level resets this person to that level’s default permissions. You can fine-tune them afterwards.</p> : <><div className="eyebrow">Permissions · not tied to role names</div><div className="permission-list">{ALL_PERMISSIONS.map(p => <label className="permission-row" key={p}><input type="checkbox" checked={perms.has(p)} onChange={() => toggle(p)} /><span>{permissionLabel[p]}</span><small>{p === 'viewOpportunityValue' ? 'Sensitive' : 'Workspace permission'}</small></label>)}</div></>}
    <InlineError message={error} /><div className="form-actions"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save access'}</Button></div></div></Modal>
}

// Where my own escalation alerts go (I4.3). Defaults to the address I sign in with.
function MyAlerts() {
  const { pushToast } = useApp()
  const dest = useAsync(getMyDestination, [])
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  useEffect(() => { if (dest.data) setEmail(dest.data.email ?? '') }, [dest.data])
  if (!dest.data) return null
  const save = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setError(undefined)
    try { if (email.trim()) await saveMyDestination(email.trim()); else await clearMyDestination(); pushToast({ title: 'Alert address saved', detail: 'Escalated leads are emailed here.', tone: 'success' }); dest.reload() }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not save.') } finally { setBusy(false) }
  }
  return <Card><div className="card-heading"><div><div className="eyebrow">My alerts</div><h3><BellRing size={16} /> Where should I be alerted?</h3></div></div>
    <p className="muted">When a lead is escalated to you, we email you straight away with the lead, where it came from, why it escalated and a link that opens it.</p>
    <form className="row-gap mt" onSubmit={save}><input aria-label="Alert email address" type="email" placeholder={dest.data.effectiveEmail} value={email} onChange={e => setEmail(e.target.value)} style={{ width: 280 }} /><Button type="submit" size="sm" disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button><span className="muted">{dest.data.usingAccountEmail ? `Using your sign-in address, ${dest.data.effectiveEmail}.` : `Alerts go to ${dest.data.effectiveEmail}.`}</span></form>
    <InlineError message={error} /></Card>
}

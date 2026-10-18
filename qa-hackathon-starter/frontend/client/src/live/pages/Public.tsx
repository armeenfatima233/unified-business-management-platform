import { FormEvent, useState } from 'react'
import { ArrowRight, CheckCircle2, Eye, EyeOff, LockKeyhole } from 'lucide-react'
import { useLocation } from 'wouter'
import { AuthHero, PulseMark } from '@/pages/Auth'
import { acceptInvitation } from '../api/auth'
import { submitPublicLead } from '../api/leads'
import { useSession } from '../session'

// ----- Accept an invitation: /invite?invite=<token> (the link the Owner or an Admin shares) -----
export function AcceptInvite() {
  const [, navigate] = useLocation()
  const { setUser } = useSession()
  const token = new URLSearchParams(window.location.search).get('invite') ?? ''
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [show, setShow] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (password.length < 10) { setError('Use a password of at least 10 characters.'); return }
    setBusy(true); setError('')
    try { setUser(await acceptInvitation({ token, name, password })); window.history.replaceState({}, '', '/dashboard'); navigate('/dashboard') }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not accept the invitation.') }
    finally { setBusy(false) }
  }
  return <div className="auth-page"><AuthHero /><main className="auth-form-panel"><div className="auth-form-wrap">
    <div className="auth-mobile-brand"><PulseMark /><strong>LeadSafe</strong></div>
    <p className="auth-overline">You’re invited</p><h2>Join your team</h2><p className="auth-subtitle">Choose your name and a password to accept the invitation.</p>
    {!token ? <div className="auth-error"><LockKeyhole size={15} />This invitation link is missing its token. Ask for a new one.</div> :
      <form onSubmit={submit} noValidate>
        <label>Your name<input required value={name} onChange={e => setName(e.target.value)} autoComplete="name" /></label>
        <label>Password<div className="auth-password"><input required type={show ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" /><button type="button" aria-label={show ? 'Hide password' : 'Show password'} onClick={() => setShow(!show)}>{show ? <EyeOff size={17} /> : <Eye size={17} />}</button></div></label>
        {error && <div className="auth-error" id="auth-error"><LockKeyhole size={15} />{error}</div>}
        <button className="auth-submit" type="submit" disabled={busy || !name.trim()}>{busy ? 'Joining…' : <>Join workspace <ArrowRight size={16} /></>}</button>
      </form>}
    <p className="auth-switch">Already have an account? <button onClick={() => navigate('/login')}>Sign in</button></p>
  </div></main></div>
}

// ----- Public enquiry form: /?form=<key> (no sign-in; the server stamps the source as "Web form") -----
export function PublicLeadForm({ publicKey }: { publicKey: string }) {
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [f, setF] = useState({ name: '', phone: '', email: '', message: '' })
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF(v => ({ ...v, [k]: e.target.value }))
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError('')
    try { await submitPublicLead(publicKey, { name: f.name, phone: f.phone || undefined, email: f.email || undefined, message: f.message || undefined }); setSent(true) }
    catch (err) { setError(err instanceof Error ? err.message : 'We could not send your message.') }
    finally { setBusy(false) }
  }
  if (sent) return <div className="auth-page"><main className="auth-form-panel" style={{ width: '100%' }}><div className="auth-form-wrap" style={{ textAlign: 'center' }}>
    <CheckCircle2 size={40} color="#1f8a68" style={{ margin: '0 auto 12px' }} /><p className="auth-overline">Message received</p><h2>Thanks — the team has it.</h2>
    <p className="auth-subtitle">Someone accountable will be in touch shortly.</p>
    <button className="auth-submit" onClick={() => { setSent(false); setF({ name: '', phone: '', email: '', message: '' }) }}>Send another enquiry</button></div></main></div>
  return <div className="auth-page"><main className="auth-form-panel" style={{ width: '100%' }}><div className="auth-form-wrap">
    <div className="auth-mobile-brand" style={{ display: 'flex' }}><PulseMark /><strong>LeadSafe</strong></div>
    <p className="auth-overline">Get in touch</p><h2>Let’s find the right next step</h2>
    <p className="auth-subtitle">Tell us what you’re working on. Your message goes straight to the team, with one accountable person assigned the moment it arrives.</p>
    <form onSubmit={submit} noValidate>
      <label>Your name<input required maxLength={100} value={f.name} onChange={set('name')} autoComplete="name" /></label>
      <label>Phone<input value={f.phone} onChange={set('phone')} autoComplete="tel" placeholder="+1 415 555 0187" /></label>
      <label>Email<input type="email" value={f.email} onChange={set('email')} autoComplete="email" /></label>
      <label>Message<textarea maxLength={2000} value={f.message} onChange={set('message')} style={{ minHeight: 90, border: '1px solid #dfe3ec', borderRadius: 8, padding: 10, font: 'inherit' }} /></label>
      <p className="auth-subtitle" style={{ margin: 0 }}>Please give a phone number or an email address so we can reach you.</p>
      {error && <div className="auth-error" role="alert"><LockKeyhole size={15} />{error}</div>}
      <button className="auth-submit" type="submit" disabled={busy || !f.name.trim() || (!f.phone.trim() && !f.email.trim())}>{busy ? 'Sending…' : <>Send enquiry <ArrowRight size={16} /></>}</button>
    </form></div></main></div>
}

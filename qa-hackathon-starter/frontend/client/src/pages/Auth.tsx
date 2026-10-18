import { FormEvent, useState } from "react";
import { ArrowRight, Check, Eye, EyeOff, LockKeyhole, ShieldCheck, Zap } from "lucide-react";
import { useLocation } from "wouter";
import { login as apiLogin, signup as apiSignup } from "@/live/api/auth";
import { useSession } from "@/live/session";

export function PulseMark() {
  return <div className="auth-pulse-mark" aria-hidden="true"><span /><span /><span /></div>;
}

export function AuthHero() {
  return <div className="auth-hero"><div className="auth-brand"><PulseMark /><div><strong>LeadSafe</strong><span>Sales operations, protected.</span></div></div><div className="auth-hero-copy"><p className="auth-kicker"><span /> Lead Safety Pulse</p><h1>Never lose<br />a lead again.</h1><p>Every inbound lead has one accountable owner. If they do not act, LeadSafe makes the next move automatically.</p><div className="auth-benefits"><span><Check size={14} /> Ownership is always visible</span><span><Check size={14} /> Escalations happen on time</span><span><Check size={14} /> Recovery is never an afterthought</span></div></div><div className="auth-live-card"><div className="auth-live-top"><span className="live-indicator" /> Live activity <span>just now</span></div><div className="auth-live-event"><span className="auth-event-icon"><ShieldCheck size={17} /></span><div><strong>Lead acknowledged</strong><small>Maya Chen · Northstar Studio</small></div><b>42s</b></div></div><div className="auth-hero-footer">Northstar Services <span>·</span> Demo workspace</div></div>;
}

export function Login() {
  const [, navigate] = useLocation();
  const { setUser } = useSession();
  // In development the seeded demo owner (npm run seed) is pre-filled; production builds start empty.
  const [email, setEmail] = useState(import.meta.env.DEV ? "demo@ubmp.test" : "");
  const [password, setPassword] = useState(import.meta.env.DEV ? "demo-password-1234" : "");
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!email || !password) { setError("Enter your email and password."); return; }
    setBusy(true); setError("");
    try { setUser(await apiLogin(email, password)); navigate("/dashboard" + window.location.search); } // keeps ?lead=<id> from an alert email
    catch (err) { setError(err instanceof Error ? err.message : "Could not sign in. Please try again."); }
    finally { setBusy(false); }
  };
  return <div className="auth-page"><AuthHero /><main className="auth-form-panel"><div className="auth-form-wrap"><div className="auth-mobile-brand"><PulseMark /><strong>LeadSafe</strong></div><p className="auth-overline">Welcome back</p><h2>Sign in to your workspace</h2><p className="auth-subtitle">Monitor lead ownership and response health in one place.</p><form onSubmit={submit} noValidate><label>Email address<input type="email" value={email} onChange={event => setEmail(event.target.value)} aria-describedby={error ? "auth-error" : undefined} autoComplete="email" /></label><label>Password<div className="auth-password"><input type={showPassword ? "text" : "password"} value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" /><button type="button" aria-label={showPassword ? "Hide password" : "Show password"} onClick={() => setShowPassword(!showPassword)}>{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button></div></label><div className="auth-form-row"><label className="checkbox-label"><input type="checkbox" checked={remember} onChange={event => setRemember(event.target.checked)} /><span>Remember me</span></label></div>{error && <div className="auth-error" id="auth-error"><LockKeyhole size={15} />{error}</div>}<button className="auth-submit" type="submit" disabled={busy}>{busy ? "Signing in…" : <>Sign in <ArrowRight size={16} /></>}</button></form><p className="auth-switch">New to LeadSafe? <button onClick={() => navigate("/signup")}>Create an account</button></p><p className="auth-demo-note"><ShieldCheck size={14} /> Your session is protected by a secure, server-side cookie.</p></div></main></div>;
}

export function Signup() {
  const [, navigate] = useLocation();
  const [showPassword, setShowPassword] = useState(false);
  const { setUser } = useSession();
  const [form, setForm] = useState({ name: "", company: "", email: "", password: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (Object.values(form).some(value => !value.trim())) { setError("Please fill in every field."); return; }
    if (form.password.length < 10) { setError("Use a password of at least 10 characters."); return; }
    setBusy(true); setError("");
    try { setUser(await apiSignup({ workspaceName: form.company, name: form.name, email: form.email, password: form.password })); navigate("/dashboard"); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not create the workspace. Please try again."); }
    finally { setBusy(false); }
  };
  const strength = form.password.length >= 14 ? "Strong" : form.password.length >= 10 ? "Good" : "Add 10+ characters";
  return <div className="auth-page"><AuthHero /><main className="auth-form-panel"><div className="auth-form-wrap"><div className="auth-mobile-brand"><PulseMark /><strong>LeadSafe</strong></div><p className="auth-overline">Start protected</p><h2>Create your workspace</h2><p className="auth-subtitle">Set up a lead-safe operating system for your team.</p><form onSubmit={submit} noValidate><label>Full name<input required value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} autoComplete="name" /></label><label>Company name<input required value={form.company} onChange={event => setForm({ ...form, company: event.target.value })} autoComplete="organization" /></label><label>Work email<input required type="email" value={form.email} onChange={event => setForm({ ...form, email: event.target.value })} autoComplete="email" /></label><label>Password<div className="auth-password"><input required type={showPassword ? "text" : "password"} value={form.password} onChange={event => setForm({ ...form, password: event.target.value })} autoComplete="new-password" /><button type="button" aria-label={showPassword ? "Hide password" : "Show password"} onClick={() => setShowPassword(!showPassword)}>{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button></div><span className="password-strength">{strength}<i className={form.password.length >= 10 ? "active" : ""} /><i className={form.password.length >= 14 ? "active" : ""} /><i className={form.password.length >= 18 ? "active" : ""} /></span></label>{error && <div className="auth-error" id="auth-error"><LockKeyhole size={15} />{error}</div>}<p className="owner-note"><ShieldCheck size={15} /> You become the <strong>Owner</strong> of a new workspace.</p><button className="auth-submit" type="submit" disabled={busy}>{busy ? "Creating…" : <>Create workspace <ArrowRight size={16} /></>}</button></form><p className="auth-switch">Already have an account? <button onClick={() => navigate("/login")}>Sign in</button></p></div></main></div>;
}

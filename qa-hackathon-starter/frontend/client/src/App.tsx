import { SessionProvider, useSession } from "@/live/session";
import { AcceptInvite, PublicLeadForm } from "@/live/pages/Public";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Redirect, Route, Switch, useLocation } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import Home from "./pages/Home";
import { Login, Signup } from "./pages/Auth";

function ProtectedRoute() {
  // The session is the server's: an httpOnly cookie checked through GET /auth/me, never something the browser can fake.
  const { user, loading } = useSession();
  if (loading) return <div className="route-loading"><span className="loading-orb" />Loading workspace…</div>;
  if (!user) return <Redirect to={"/login" + window.location.search} />; // keeps ?lead=<id> from an alert email through sign-in
  return <Home />;
}

function Router() {
  return <Switch>
    <Route path="/login" component={Login} />
    <Route path="/signup" component={Signup} />
    <Route path="/invite" component={AcceptInvite} />
    <Route path="/" component={ProtectedRoute} />
    <Route path="/dashboard" component={ProtectedRoute} />
    <Route path="/leads" component={ProtectedRoute} />
    <Route path="/pipeline" component={ProtectedRoute} />
    <Route path="/contacts/:id" component={ProtectedRoute} />
    <Route path="/contacts" component={ProtectedRoute} />
    <Route path="/companies" component={ProtectedRoute} />
    <Route path="/conversations" component={ProtectedRoute} />
    <Route path="/recovery" component={ProtectedRoute} />
    <Route path="/appointments" component={ProtectedRoute} />
    <Route path="/payments" component={ProtectedRoute} />
    <Route path="/team" component={ProtectedRoute} />
    <Route path="/integrations" component={ProtectedRoute} />
    <Route path="/audit" component={ProtectedRoute} />
    <Route path="/settings" component={ProtectedRoute} />
    <Route path="/404" component={NotFound} />
    <Route component={NotFound} />
  </Switch>;
}

function App() {
  // The public enquiry form needs no sign-in: its link carries the workspace's form key (?form=<key>).
  const formKey = new URLSearchParams(window.location.search).get("form");
  // An invitation link (?invite=<token>) opens the join screen first.
  const invited = new URLSearchParams(window.location.search).has("invite") && !window.location.pathname.startsWith("/invite");
  if (invited) window.history.replaceState({}, "", "/invite" + window.location.search);
  return <ErrorBoundary><ThemeProvider defaultTheme="dark"><TooltipProvider><Toaster />{formKey ? <PublicLeadForm publicKey={formKey} /> : <SessionProvider><Router /></SessionProvider>}</TooltipProvider></ThemeProvider></ErrorBoundary>;
}

export default App;

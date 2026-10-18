import { useEffect, useState } from "react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Redirect, Route, Switch, useLocation } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import Home from "./pages/Home";
import { Login, Signup } from "./pages/Auth";

function ProtectedRoute() {
  const [location] = useLocation();
  const [ready, setReady] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  useEffect(() => {
    setAuthenticated(localStorage.getItem("leadsafe_session") === "demo");
    setReady(true);
  }, [location]);
  if (!ready) return <div className="route-loading"><span className="loading-orb" />Loading workspace…</div>;
  if (!authenticated) return <Redirect to="/login" />;
  return <Home />;
}

function Router() {
  return <Switch>
    <Route path="/login" component={Login} />
    <Route path="/signup" component={Signup} />
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
  return <ErrorBoundary><ThemeProvider defaultTheme="dark"><TooltipProvider><Toaster /><Router /></TooltipProvider></ThemeProvider></ErrorBoundary>;
}

export default App;

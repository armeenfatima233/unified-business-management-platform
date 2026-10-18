// Loads the provider adapters that live in qa-hackathon-starter/integrations/<name>/ (their own package, their own
// node_modules). They are imported lazily and optionally: if an adapter or its dependencies are not installed the
// matching feature reports "not configured" with a plain message and the rest of the platform keeps working (I5.8).
const here = import.meta.url;
const cache = new Map<string, Promise<any>>();

export function loadAdapterModule(folder: string, file: string): Promise<any> {
  const url = new URL(`../../../integrations/${folder}/${file}`, here).href;
  let loaded = cache.get(url);
  if (!loaded) {
    loaded = import(url);
    loaded.catch(() => cache.delete(url)); // a failed load can be retried after `npm install`
    cache.set(url, loaded);
  }
  return loaded;
}

export const loadResendModules = async () => ({
  email: await loadAdapterModule("resend", "resend-email-adapter.ts"),
  alerts: await loadAdapterModule("resend", "escalation-alert-adapter.ts"),
});
export const loadGoogleModule = () => loadAdapterModule("google-calendar", "google-calendar-adapter.ts");

export interface ForwardOptions {
  user?: string; course?: string; section?: string; link?: string; launch?: string;
}
const DEFAULT_PARAMS = ['user','course','section','link','launch'] as const;
export function buildDestination(destination: string, options: ForwardOptions, names: Partial<Record<keyof ForwardOptions,string>> = {}): string {
  const url = new URL(destination);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1'].includes(url.hostname))) {
    throw new Error('Destination must be HTTPS');
  }
  if (url.username || url.password) throw new Error('Credentials in destination URL are forbidden');
  for (const param of DEFAULT_PARAMS) {
    const name = names[param] ?? param;
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(name)) throw new Error('Invalid parameter name');
    // Existing destination query parameters are preserved except for all
    // bridge-managed parameter names. Otherwise an attacker could supply a
    // stale user/section code when forwarding is disabled.
    url.searchParams.delete(name);
    const value = options[param];
    if (!value) continue;
    url.searchParams.set(name, value);
  }
  return url.toString();
}
export function allowedDestination(destination: string, allowlist: string, localDevelopment = false): boolean {
  try {
    const u = new URL(destination);
    if (u.username || u.password) return false;
    if (u.protocol !== 'https:' && !(localDevelopment && u.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(u.hostname))) return false;
    if (['localhost','127.0.0.1','[::1]'].includes(u.hostname) && !localDevelopment) return false;
    // Even local targets must be explicitly allowlisted; HTTP additionally needs ENABLE_LOCAL_HTTP.
    const allowed = allowlist.split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
    return allowed.includes(u.hostname.toLowerCase());
  } catch { return false; }
}
export function escapeHtml(input: unknown): string { return String(input ?? '').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!)); }

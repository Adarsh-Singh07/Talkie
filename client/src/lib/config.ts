export type SignalingConfig = { ok: true; url: string } | { ok: false; error: string };

export const signalingUrlStorageKey = 'talkie.signalingUrl';
export const developmentSignalingUrl = 'ws://127.0.0.1:8787';
const guidance = 'Set VITE_SIGNALING_URL to the real public wss:// signaling endpoint and rebuild the client.';

export type SignalingStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function browserStorage(): SignalingStorage | undefined {
  try { return typeof localStorage === 'undefined' ? undefined : localStorage; } catch { return undefined; }
}

export function getSignalingUrlOverride(storage: Pick<Storage, 'getItem'> | undefined = browserStorage()): string | undefined {
  try {
    const value = storage?.getItem(signalingUrlStorageKey)?.trim();
    return value || undefined;
  } catch { return undefined; }
}

export function saveSignalingUrlOverride(value: string, storage: SignalingStorage | undefined = browserStorage()): boolean {
  try {
    const trimmed = value.trim();
    if (trimmed) storage?.setItem(signalingUrlStorageKey, trimmed);
    else storage?.removeItem(signalingUrlStorageKey);
    return Boolean(storage);
  } catch { return false; }
}

export function resetSignalingUrlOverride(storage: SignalingStorage | undefined = browserStorage()): boolean {
  try { storage?.removeItem(signalingUrlStorageKey); return Boolean(storage); } catch { return false; }
}

function publicHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[')) {
    // Only global-unicast IPv6; exclude documentation and special-use ranges.
    // This also excludes loopback, link-local, ULA and IPv4-mapped literals.
    const words = host.slice(1, -1).split(':');
    const first = parseInt(words[0], 16);
    const second = parseInt(words[1] || '0', 16);
    return first >= 0x2000 && first <= 0x3fff
      && !(first === 0x2001 && (second < 0x200 || second === 0xdb8))
      && !(first === 0x2002) && !(first === 0x3fff && second < 0x1000);
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b, c] = host.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99)))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113));
  }
  const labels = host.split('.');
  return host.length <= 253 && labels.length >= 2
    && labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    && !labels.some(label => /^(localhost|example|invalid|placeholder|changeme|replace-me|your-domain|your-server)$/.test(label))
    && !/\.(test|local|internal|home|lan|onion)$/.test(host);
}

/** Pure syntax/policy validation; it cannot verify DNS, TLS or server deployment. */
export function resolveSignalingConfig(value: string | undefined, development: boolean, storage?: Pick<Storage, 'getItem'>): SignalingConfig {
  const raw = getSignalingUrlOverride(storage)?.trim() ?? value?.trim();
  const fail = (reason: string): SignalingConfig => ({ ok: false, error: `Signaling configuration error: ${reason} ${guidance}` });
  if (!raw) return development ? { ok: true, url: developmentSignalingUrl } : fail('VITE_SIGNALING_URL is missing.');
  let url: URL;
  try { url = new URL(raw); } catch { return fail('VITE_SIGNALING_URL must be an absolute WebSocket URL.'); }
  if (!/^wss?:\/\//i.test(raw) || /[\s\\]/.test(raw) || !['ws:', 'wss:'].includes(url.protocol)) return fail('Use a ws:// or wss:// WebSocket URL.');
  if (url.username || url.password || raw.split('/')[2]?.includes('@') || raw.includes('#')) return fail('User credentials and fragments are not allowed in the signaling URL.');
  if (!development && (url.protocol !== 'wss:' || !publicHost(url.hostname))) return fail('Production requires wss:// with a public host; local/private addresses and placeholder domains are not allowed.');
  return { ok: true, url: raw };
}

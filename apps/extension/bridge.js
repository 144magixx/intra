const domainOrigins = domain => [`http://*.${domain}/*`, `https://*.${domain}/*`];
// No built-in site presets: users authorize a domain they type, or explicitly opt in to all sites.
export const SERVICES = Object.freeze([]);
const ALL_ORIGINS = Object.freeze(['http://*/*', 'https://*/*']);
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const validDNS = hostname => hostname.length <= 253 && hostname.split('.').every(label => DNS_LABEL.test(label));
const COOKIE_NAME = /^[!#$%&'*+.^_\x60|~0-9A-Za-z-]+(?![\s\S])/;
export const MAX_FRAME_BYTES = 256 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const size = value => new TextEncoder().encode(JSON.stringify(value)).length;
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const problem = code => Object.assign(new Error(code), { code });
const safeCodes = new Set(['FORBIDDEN', 'PROFILE_NOT_PAIRED', 'PROFILE_AMBIGUOUS', 'BRIDGE_UNAVAILABLE', 'CONTRACT_INVALID', 'PROTOCOL_MISMATCH', 'REQUEST_TIMEOUT', 'RESPONSE_TOO_LARGE', 'PARTITIONED_COOKIE_UNSUPPORTED']);
const safeCode = error => safeCodes.has(error?.code) ? error.code : 'BRIDGE_UNAVAILABLE';

// A custom selection is the user's chosen domain, never an inferred parent domain.
function selectionScope(id) {
  if (id === 'all') return { origins: ALL_ORIGINS };
  const preset = SERVICES.find(service => service.id === id);
  if (preset) return { domain: preset.domain, origins: preset.permissionOrigins };
  if (typeof id !== 'string' || !id.startsWith('domain:')) throw problem('FORBIDDEN');
  const domain = id.slice(7);
  if (!validDNS(domain) || (domain !== 'localhost' && !domain.includes('.'))) throw problem('FORBIDDEN');
  // Reject IP literals and numeric forms canonicalized by URL (e.g. 127.1/0x7f.1).
  let hostname;
  try { hostname = new URL('http://' + domain + '/').hostname; } catch { throw problem('FORBIDDEN'); }
  if (hostname !== domain || /^[0-9.]+$/.test(hostname)) throw problem('FORBIDDEN');
  return { domain, origins: domainOrigins(domain) };
}
function selectionScopes(serviceIds) {
  if (!Array.isArray(serviceIds) || !serviceIds.length) throw problem('FORBIDDEN');
  return Array.from(serviceIds, selectionScope);
}
// Chrome checks each cookie's own domain and Secure-derived scheme, even with a
// URL-scoped getAll. Each chosen domain therefore needs both HTTP and HTTPS.
export function permissionOriginsFor(serviceIds) {
  const scopes = selectionScopes(serviceIds);
  return [...new Set(scopes.flatMap(scope => scope.origins))];
}
function snapshotURL(value) {
  let url;
  try { url = new URL(value); } catch { throw problem('FORBIDDEN'); }
  // URL already validates/canonicalizes IPv4/IPv6. DNS labels need a stricter check.
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.includes('#') ||
      !(validDNS(url.hostname) || (url.hostname.startsWith('[') && url.hostname.endsWith(']')))) throw problem('FORBIDDEN');
  return url;
}
function matchingScope(serviceIds, hostname) {
  const scopes = selectionScopes(serviceIds);
  const all = scopes.find(scope => !scope.domain);
  const scope = all ?? scopes.find(scope => hostname === scope.domain || hostname.endsWith('.' + scope.domain));
  if (!scope) throw problem('FORBIDDEN');
  return scope;
}
function validateCookieScope(cookie, url, storeId) {
  const domain = typeof cookie.domain === 'string' ? cookie.domain.replace(/^\./, '').toLowerCase() : '';
  const path = cookie.path;
  const host = url.hostname.toLowerCase();
  const domainMatches = host === domain || (!cookie.hostOnly && !/^[0-9.]+$/.test(host) && !host.startsWith('[') && host.endsWith('.' + domain));
  const pathMatches = typeof path === 'string' && path.startsWith('/') &&
    (url.pathname === path || (url.pathname.startsWith(path) && (path.endsWith('/') || url.pathname[path.length] === '/')));
  if (cookie.storeId !== storeId || !domain || !domainMatches || !pathMatches ||
      typeof cookie.name !== 'string' || !cookie.name || /[\x00-\x20\x7f;=]/.test(cookie.name) ||
      typeof cookie.value !== 'string' || /[\x00-\x1f\x7f;]/.test(cookie.value) ||
      typeof cookie.hostOnly !== 'boolean' || typeof cookie.secure !== 'boolean' ||
      (cookie.secure && url.protocol !== 'https:') ||
      (cookie.expirationDate !== undefined && (!Number.isFinite(cookie.expirationDate) || cookie.expirationDate <= Date.now() / 1000))) throw problem('CONTRACT_INVALID');
}

// This controller has no page/content-script entry point. Only the extension popup confirms pairing.
export function createExtensionBridge(api, cryptoApi = globalThis.crypto) {
  let port, pairing, helloId, helloTimer, helloReject;
  let connected = false;
  let connecting = false;
  const pending = new Map();
  let state = '未连接；请在此页面确认授权后连接。';
  function disconnect() {
    const previous = port;
    port = undefined; connected = false;
    clearTimeout(helloTimer);
    if (helloReject) helloReject(problem('BRIDGE_UNAVAILABLE'));
    helloReject = undefined;
    for (const timer of pending.values()) clearTimeout(timer);
    pending.clear();
    if (previous) { try { previous.disconnect(); } catch {} }
  }
  function post(message) {
    if (!port) throw problem('BRIDGE_UNAVAILABLE');
    if (size(message) > MAX_FRAME_BYTES) throw problem('RESPONSE_TOO_LARGE');
    port.postMessage(message);
  }
  function finish(id, result, error) {
    if (!pending.has(id)) return;
    clearTimeout(pending.get(id)); pending.delete(id);
    const code = safeCode(error);
    const message = error
      ? { schemaVersion: 1, requestId: id, type: 'response', ok: false, error: { code, message: `Cookie snapshot failed (${code})`, retryable: false } }
      : { schemaVersion: 1, requestId: id, type: 'response', ok: true, result };
    try { post(message); }
    catch (failure) {
      if (!error && failure.code === 'RESPONSE_TOO_LARGE') {
        try { post({ schemaVersion: 1, requestId: id, type: 'response', ok: false, error: { code: 'RESPONSE_TOO_LARGE', message: 'Cookie snapshot exceeds 256 KiB', retryable: false } }); } catch { disconnect(); }
      } else disconnect();
    }
  }
  async function snapshot(message) {
    const activePort = port;
    const id = message.requestId;
    const params = message.params;
    try {
      if (!exactKeys(message, ['schemaVersion', 'requestId', 'type', 'method', 'params']) || message.method !== 'cookies.snapshot' ||
          !(exactKeys(params, ['profileId', 'storeId', 'url', 'deadlineMs']) || exactKeys(params, ['profileId', 'storeId', 'url', 'cookieNames', 'deadlineMs'])) || typeof params.url !== 'string' ||
          (Object.hasOwn(params, 'cookieNames') && (!Array.isArray(params.cookieNames) || !params.cookieNames.length || params.cookieNames.length > 16 || params.cookieNames.some(name => typeof name !== 'string' || name.length > 256 || !COOKIE_NAME.test(name)) || new Set(params.cookieNames).size !== params.cookieNames.length)) ||
          !Number.isInteger(params.deadlineMs) || params.deadlineMs < 1 || params.deadlineMs > 30_000) throw problem('CONTRACT_INVALID');
      if (params.profileId !== pairing.profileId || !pairing.storeIds.includes(params.storeId)) throw problem('PROFILE_NOT_PAIRED');
      const url = snapshotURL(params.url);
      const scope = matchingScope(pairing.services, url.hostname);
      if (!await api.permissions.contains({ origins: [...scope.origins] })) throw problem('FORBIDDEN');
      if (port !== activePort || !pending.has(id)) return;
      const cookies = (await api.cookies.getAll({ url: params.url, storeId: params.storeId }))
        .filter(cookie => params.cookieNames === undefined || params.cookieNames.includes(cookie.name));
      if (cookies.some(cookie => cookie.partitionKey !== undefined)) throw problem('PARTITIONED_COOKIE_UNSUPPORTED');
      for (const cookie of cookies) validateCookieScope(cookie, url, params.storeId);
      const selected = cookies.map(cookie => {
        const { name, value, domain, path, hostOnly, secure, httpOnly, sameSite, session, storeId, expirationDate } = cookie;
        return { name, value, domain, path, hostOnly, secure, httpOnly, sameSite, session, storeId, ...(expirationDate === undefined ? {} : { expirationDate }) };
      });
      if (port !== activePort) return;
      finish(id, { profileId: params.profileId, storeId: params.storeId, snapshotId: cryptoApi.randomUUID(), observedAt: new Date().toISOString(), cookies: selected });
    } catch (error) { if (port === activePort) finish(id, undefined, error); }
  }
  async function confirm(serviceIds) {
    if (connecting) throw problem('BRIDGE_UNAVAILABLE');
    const origins = permissionOriginsFor(serviceIds);
    const selections = [...serviceIds];
    if (new Set(selections).size !== selections.length) throw problem('FORBIDDEN');
    connecting = true;
    try {
      disconnect();
      if (!await api.permissions.contains({ origins })) throw problem('FORBIDDEN');
      const saved = await api.storage.local.get(['profileId']);
      const profileId = UUID.test(saved.profileId ?? '') ? saved.profileId : cryptoApi.randomUUID();
      const stores = await api.cookies.getAllCookieStores();
      const storeIds = [...new Set(stores.map(store => store.id))];
      if (!storeIds.length || storeIds.length > 16 || storeIds.some(id => typeof id !== 'string' || !id)) throw problem('BRIDGE_UNAVAILABLE');
      pairing = { profileId, storeIds, services: selections, confirmedAt: new Date().toISOString() };
      await api.storage.local.set({ profileId, pairing });
      port = api.runtime.connectNative('com.intra.bridge');
      const current = port;
      current.onDisconnect.addListener(() => {
        void api.runtime.lastError; // Consume Chrome's error without logging a potentially sensitive detail.
        if (current !== port) return;
        state = '连接已断开；请重新确认连接。'; disconnect();
      });
      await new Promise((resolve, reject) => {
        helloReject = reject;
        helloId = cryptoApi.randomUUID();
        helloTimer = setTimeout(() => { state = '连接超时。'; disconnect(); }, 10_000);
        current.onMessage.addListener(message => {
          if (current !== port) return;
          if (!message || size(message) > MAX_FRAME_BYTES || message.schemaVersion !== 1 || typeof message.requestId !== 'string' || !message.requestId || message.requestId.length > 128) { disconnect(); return; }
          if (!connected) {
            if (message.requestId !== helloId || message.type !== 'response') { disconnect(); return; }
            if (!message.ok || !exactKeys(message, ['schemaVersion', 'requestId', 'type', 'ok', 'result']) || !exactKeys(message.result, ['protocolVersion']) || message.result.protocolVersion !== 1) {
              const code = safeCode(message.error);
              state = `连接失败：${code}`;
              helloReject = undefined; reject(problem(code)); disconnect(); return;
            }
            clearTimeout(helloTimer); helloReject = undefined; connected = true;
            state = '已连接；CLI 可在本次确认的范围内按指定 URL 请求 Cookie 快照。'; resolve(); return;
          }
          if (message.type !== 'request' || pending.has(message.requestId)) { disconnect(); return; }
          if (pending.size >= 32) { disconnect(); return; }
          const deadline = Number.isInteger(message.params?.deadlineMs) ? Math.max(1, Math.min(30_000, message.params.deadlineMs)) : 1;
          pending.set(message.requestId, setTimeout(() => finish(message.requestId, undefined, problem('REQUEST_TIMEOUT')), deadline));
          void snapshot(message);
        });
        post({ schemaVersion: 1, requestId: helloId, type: 'request', method: 'bridge.hello', params: { profileId, extensionVersion: api.runtime.getManifest().version, protocolVersions: [1], storeIds } });
      });
      return { profileId, storeIds, connected: true };
    } catch (error) { disconnect(); throw problem(safeCode(error)); }
    finally { connecting = false; }
  }
  return {
    confirm,
    status: async () => ({ profileId: (await api.storage.local.get(['profileId'])).profileId ?? null, connected, state }),
    disconnect: () => { state = '已断开；再次连接需要确认。'; disconnect(); },
    resetProfile: async () => { disconnect(); const profileId = cryptoApi.randomUUID(); await api.storage.local.set({ profileId, pairing: null }); state = '已生成新的 Profile ID；请重新确认配对。'; return { profileId }; },
  };
}

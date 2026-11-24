/**
 * OAuth 2.1 sign-in for MCP servers (the MCP authorization spec): protected-resource discovery,
 * dynamic client registration, PKCE (S256), a redirect back to /oauth/callback, and refresh tokens.
 *
 * Tokens are stored per provider in the settings table under `oauth:<connection id>`, only in this browser.
 * They are never exported in backups or sent by device sync (see SKIP_SETTING in db/backup.ts): sign in on each device.
 * Every request goes through the app's own proxy when the provider has "Route through proxy" on,
 * because OpenArt's sign-in and MCP endpoints don't allow direct browser (CORS) calls.
 */
import { db, type Connection } from '../db/schema';
import { getSetting, setSetting } from '../db/repo';
import { asset } from './base';
import { apiFetch, apiJson, ApiError, via } from './http';

export interface OAuthState {
  /** the protected MCP endpoint the token is for */
  resource: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
  scope?: string;
  clientId: string;
  /** the callback URL the client was registered with (registration is per app address) */
  redirectUri: string;
  accessToken?: string;
  refreshToken?: string;
  /** ms epoch; undefined = no expiry given */
  expiresAt?: number;
  signedInAt?: number;
}

interface Pending {
  connId: string;
  verifier: string;
  /** where to go back to after a full-page redirect (when the popup was blocked) */
  returnTo: string;
  createdAt: number;
}

const stateKey = (connId: string) => `oauth:${connId}`;
const pendingKey = (state: string) => `alembic-oauth-pending:${state}`;
const CHANNEL = 'alembic-oauth';

export const callbackUrl = () => location.origin + asset('oauth/callback');

export async function getOAuthState(connId: string): Promise<OAuthState | undefined> {
  return getSetting<OAuthState>(stateKey(connId));
}
async function saveOAuthState(connId: string, s: OAuthState | undefined) {
  if (s) await setSetting(stateKey(connId), s);
  else await db.settings.delete(stateKey(connId));
}
export async function isSignedIn(connId: string): Promise<boolean> {
  return !!(await getOAuthState(connId))?.accessToken;
}

// ---------- discovery & registration ----------

interface ResourceMeta {
  resource?: string;
  authorization_servers?: string[];
  scopes_supported?: string[];
}
interface ServerMeta {
  issuer?: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  revocation_endpoint?: string;
  scopes_supported?: string[];
}

async function firstJson<T>(conn: Connection, urls: string[]): Promise<T> {
  let last: unknown;
  for (const u of urls) {
    try {
      return await apiJson<T>(via(conn, u));
    } catch (e) {
      last = e;
    }
  }
  throw last instanceof Error ? last : new Error('Sign-in discovery failed.');
}

/** RFC 9728 protected-resource metadata, then RFC 8414 authorization-server metadata. */
async function discover(conn: Connection, resourceUrl: string) {
  const r = new URL(resourceUrl);
  const path = r.pathname.replace(/\/+$/, '');
  const rm = await firstJson<ResourceMeta>(conn, [
    `${r.origin}/.well-known/oauth-protected-resource${path}`,
    `${r.origin}/.well-known/oauth-protected-resource`,
  ]).catch(() => ({}) as ResourceMeta);
  const issuer = (rm.authorization_servers?.[0] ?? r.origin).replace(/\/+$/, '');
  const i = new URL(issuer);
  const ipath = i.pathname.replace(/\/+$/, '');
  const sm = await firstJson<ServerMeta>(conn, [
    `${i.origin}/.well-known/oauth-authorization-server${ipath}`,
    `${i.origin}/.well-known/openid-configuration${ipath}`,
    `${issuer}/.well-known/openid-configuration`,
  ]);
  if (!sm.authorization_endpoint || !sm.token_endpoint) throw new Error(`${conn.name}: the sign-in server did not describe its endpoints.`);
  return { resource: rm.resource ?? resourceUrl, scope: (rm.scopes_supported ?? sm.scopes_supported)?.join(' '), server: sm };
}

async function register(conn: Connection, server: ServerMeta, redirectUri: string, scope?: string): Promise<string> {
  if (!server.registration_endpoint)
    throw new Error(`${conn.name} does not allow apps to register themselves (no dynamic client registration), so this app can't sign in to it.`);
  const j = await apiJson<{ client_id: string }>(via(conn, server.registration_endpoint), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Alembic Generative Studio',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(scope ? { scope } : {}),
    }),
  });
  if (!j.client_id) throw new Error(`${conn.name}: registration returned no client id.`);
  return j.client_id;
}

// ---------- PKCE ----------

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const randomString = (n = 48) => b64url(crypto.getRandomValues(new Uint8Array(n)));
async function challengeFor(verifier: string) {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}

// ---------- sign-in ----------

/**
 * Starts sign-in for a saved connection. Opens the provider's login in a popup; when the popup is blocked
 * (some phones / installed PWAs) the whole page goes there instead and /oauth/callback brings you back.
 */
/** `ready` (e.g. saving the connection) is awaited before leaving the page. */
export async function beginSignIn(conn: Connection, ready?: Promise<unknown>): Promise<'popup' | 'redirect'> {
  // open the popup right away (before any await) so browsers treat it as a direct result of the click
  const popup = window.open('', 'alembic-oauth', 'popup,width=520,height=760');
  try {
    const redirectUri = callbackUrl();
    let st = await getOAuthState(conn.id);
    if (!st || st.redirectUri !== redirectUri || st.resource !== conn.baseUrl) {
      const d = await discover(conn, conn.baseUrl);
      st = {
        resource: d.resource,
        authorizationEndpoint: d.server.authorization_endpoint,
        tokenEndpoint: d.server.token_endpoint,
        revocationEndpoint: d.server.revocation_endpoint,
        scope: d.scope,
        clientId: await register(conn, d.server, redirectUri, d.scope),
        redirectUri,
      };
      await saveOAuthState(conn.id, st);
    }
    const verifier = randomString();
    const state = randomString(24);
    const pending: Pending = { connId: conn.id, verifier, returnTo: location.pathname + location.search, createdAt: Date.now() };
    localStorage.setItem(pendingKey(state), JSON.stringify(pending));
    const u = new URL(st.authorizationEndpoint);
    u.search = new URLSearchParams({
      response_type: 'code',
      client_id: st.clientId,
      redirect_uri: st.redirectUri,
      state,
      code_challenge: await challengeFor(verifier),
      code_challenge_method: 'S256',
      resource: st.resource,
      ...(st.scope ? { scope: st.scope } : {}),
    }).toString();
    await ready;
    if (popup && !popup.closed) {
      popup.location.href = u.toString();
      return 'popup';
    }
    location.assign(u.toString());
    return 'redirect';
  } catch (e) {
    popup?.close();
    throw e;
  }
}

export interface SignInResult {
  connId: string;
  ok: boolean;
  error?: string;
}

/** Called when a sign-in finishes in another window (the popup) or this one. */
export function onSignInResult(cb: (r: SignInResult) => void): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => {};
  const ch = new BroadcastChannel(CHANNEL);
  ch.onmessage = (e) => cb(e.data as SignInResult);
  return () => ch.close();
}
function announce(r: SignInResult) {
  if (typeof BroadcastChannel === 'undefined') return;
  const ch = new BroadcastChannel(CHANNEL);
  ch.postMessage(r);
  ch.close();
}

interface TokenAnswer {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

async function tokenRequest(conn: Connection, st: OAuthState, params: Record<string, string>): Promise<TokenAnswer> {
  const res = await apiFetch(via(conn, st.tokenEndpoint), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ client_id: st.clientId, resource: st.resource, ...params }).toString(),
  });
  return res.json();
}

function applyTokens(st: OAuthState, t: TokenAnswer): OAuthState {
  if (!t.access_token) throw new Error(t.error_description || t.error || 'The sign-in server returned no access token.');
  return {
    ...st,
    accessToken: t.access_token,
    refreshToken: t.refresh_token ?? st.refreshToken,
    expiresAt: t.expires_in ? Date.now() + t.expires_in * 1000 : undefined,
  };
}

/** Handles /oauth/callback: swaps the code for tokens and tells the opening window. Returns where to go next. */
export async function completeSignIn(params: URLSearchParams): Promise<{ connId: string; name: string; returnTo: string }> {
  const state = params.get('state') ?? '';
  const raw = localStorage.getItem(pendingKey(state));
  if (!raw) throw new Error('This sign-in link has expired or was already used. Start the sign-in again from Settings → Providers.');
  localStorage.removeItem(pendingKey(state));
  const pending = JSON.parse(raw) as Pending;
  const conn = await db.connections.get(pending.connId);
  try {
    if (!conn) throw new Error('The provider this sign-in was for no longer exists.');
    const err = params.get('error');
    if (err) throw new Error(err === 'access_denied' ? 'Sign-in was cancelled.' : `${conn.name}: ${params.get('error_description') || err}`);
    const code = params.get('code');
    if (!code) throw new Error('The sign-in server sent no code back.');
    const st = await getOAuthState(conn.id);
    if (!st) throw new Error('Sign-in state is missing. Start the sign-in again.');
    const t = await tokenRequest(conn, st, { grant_type: 'authorization_code', code, redirect_uri: st.redirectUri, code_verifier: pending.verifier });
    await saveOAuthState(conn.id, { ...applyTokens(st, t), signedInAt: Date.now() });
    announce({ connId: conn.id, ok: true });
    return { connId: conn.id, name: conn.name, returnTo: pending.returnTo };
  } catch (e) {
    announce({ connId: pending.connId, ok: false, error: (e as Error).message });
    throw e;
  }
}

/** Drop pending sign-ins older than an hour (abandoned popups). */
export function cleanupPendingSignIns() {
  try {
    for (const k of Object.keys(localStorage)) {
      if (!k.startsWith('alembic-oauth-pending:')) continue;
      const p = JSON.parse(localStorage.getItem(k) ?? '{}') as Partial<Pending>;
      if (!p.createdAt || Date.now() - p.createdAt > 3_600_000) localStorage.removeItem(k);
    }
  } catch {
    /* storage unavailable */
  }
}

// ---------- tokens for requests ----------

const refreshing = new Map<string, Promise<string>>();

export function signInNeeded(conn: Connection, again = false) {
  return new ApiError(
    `${conn.name}: ${again ? 'your sign-in has expired. Sign in again' : 'not signed in. Sign in'} under Settings → Providers → ${conn.name}.`,
    401,
    'auth',
  );
}

/** A valid access token, refreshed when it is about to expire (or when `force` is set after a 401). */
export async function getAccessToken(conn: Connection, force = false): Promise<string> {
  const st = await getOAuthState(conn.id);
  if (!st?.accessToken) throw signInNeeded(conn);
  const fresh = !st.expiresAt || st.expiresAt - Date.now() > 60_000;
  if (fresh && !force) return st.accessToken;
  if (!st.refreshToken) throw signInNeeded(conn, true);
  let p = refreshing.get(conn.id);
  if (!p) {
    p = (async () => {
      try {
        const t = await tokenRequest(conn, st, { grant_type: 'refresh_token', refresh_token: st.refreshToken! });
        const next = applyTokens(st, t);
        await saveOAuthState(conn.id, next);
        return next.accessToken!;
      } catch (e) {
        if (e instanceof ApiError && (e.status === 400 || e.status === 401)) {
          await saveOAuthState(conn.id, { ...st, accessToken: undefined, refreshToken: undefined, expiresAt: undefined });
          throw signInNeeded(conn, true);
        }
        throw e;
      } finally {
        refreshing.delete(conn.id);
      }
    })();
    refreshing.set(conn.id, p);
  }
  return p;
}

/** Signs out: revokes the refresh token when the server supports it, then forgets the tokens (the registration is kept). */
export async function signOut(conn: Connection) {
  const st = await getOAuthState(conn.id);
  if (!st) return;
  if (st.revocationEndpoint && (st.refreshToken || st.accessToken)) {
    await apiFetch(via(conn, st.revocationEndpoint), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: st.clientId, token: st.refreshToken ?? st.accessToken! }).toString(),
    }).catch(() => undefined);
  }
  await saveOAuthState(conn.id, { ...st, accessToken: undefined, refreshToken: undefined, expiresAt: undefined, signedInAt: undefined });
}

export async function forgetOAuth(connId: string) {
  await saveOAuthState(connId, undefined);
}

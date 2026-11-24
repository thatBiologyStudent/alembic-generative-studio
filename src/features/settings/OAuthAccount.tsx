import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { CheckCircle2, ClipboardCopy, LogIn, LogOut, Wrench } from 'lucide-react';
import { db, type Connection } from '../../db/schema';
import { saveConnection } from '../../db/repo';
import { beginSignIn, onSignInResult, signOut, type OAuthState } from '../../lib/oauth';
import { errMsg } from '../../lib/http';
import type { McpTool } from '../../lib/mcp';
import { dropOpenArtClient, openArtClient, pickEditTool, pickGenerateTool } from '../../providers/image/openart';
import { Spinner } from '../../components/common';
import { useUI } from '../../store/ui';

/**
 * Sign-in panel for OAuth (MCP) providers such as OpenArt, plus a list of the tools the server exposes.
 * `current()` is the connection as edited in the dialog: it is saved before signing in so the callback can find it.
 */
export function OAuthAccount({ conn, current, proxyOk }: { conn: Connection; current: () => Connection; proxyOk: boolean }) {
  const st = useLiveQuery(async () => (await db.settings.get(`oauth:${conn.id}`))?.value as OAuthState | undefined, [conn.id]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [tools, setTools] = useState<McpTool[]>();
  const [toolsBusy, setToolsBusy] = useState(false);
  const toast = useUI((s) => s.toast);

  useEffect(
    () =>
      onSignInResult((r) => {
        if (r.connId !== conn.id) return;
        setBusy(false);
        if (r.ok) {
          setErr('');
          dropOpenArtClient(conn.id);
          toast(`Signed in to ${conn.name}`, 'success');
        } else setErr(r.error ?? 'Sign-in failed.');
      }),
    [conn.id, conn.name, toast],
  );

  const signedIn = !!st?.accessToken;

  const signIn = async () => {
    setErr('');
    const c = current();
    if (!c.useProxy && proxyOk) c.useProxy = true; // OpenArt blocks direct browser requests
    if (!c.useProxy) return setErr('Turn on “Route through proxy” first: OpenArt does not accept requests straight from the browser.');
    setBusy(true);
    try {
      dropOpenArtClient(c.id);
      // beginSignIn opens the popup synchronously (browsers block popups opened after an await); the save runs meanwhile
      await beginSignIn(c, saveConnection(c));
      // the popup reports back through onSignInResult; stop the spinner if it is closed without finishing
      setTimeout(() => setBusy(false), 120_000);
    } catch (e) {
      setBusy(false);
      setErr(errMsg(e));
    }
  };

  const loadTools = async () => {
    setToolsBusy(true);
    setErr('');
    try {
      setTools(await openArtClient(current()).listTools(true));
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setToolsBusy(false);
    }
  };

  const gen = tools && pickGenerateTool(tools);
  const edit = tools && pickEditTool(tools);

  return (
    <div className="space-y-2 rounded-lg border border-line p-3">
      <div className="flex flex-wrap items-center gap-2">
        {signedIn ? (
          <span className="flex items-center gap-1.5 text-sm text-emerald-300">
            <CheckCircle2 size={15} /> Signed in{st?.signedInAt ? ` since ${new Date(st.signedInAt).toLocaleDateString()}` : ''}
          </span>
        ) : (
          <span className="text-sm text-muted">Not signed in</span>
        )}
        <div className="flex-1" />
        {signedIn ? (
          <>
            <button type="button" className="btn" onClick={loadTools} disabled={toolsBusy}>
              {toolsBusy ? <Spinner size={13} /> : <Wrench size={14} />} Show available tools
            </button>
            <button
              type="button"
              className="btn"
              onClick={async () => {
                await signOut(current());
                dropOpenArtClient(conn.id);
                setTools(undefined);
              }}
            >
              <LogOut size={14} /> Sign out
            </button>
          </>
        ) : (
          <button type="button" className="btn-primary" onClick={signIn} disabled={busy}>
            {busy ? <Spinner size={13} /> : <LogIn size={14} />} Sign in with {conn.name}
          </button>
        )}
      </div>
      <p className="text-xs text-muted">
        Signing in opens {conn.name}’s login {busy ? '(finish it in the other window)' : 'in a new window'}. The sign-in stays in this browser only; on another device, sign in there.
      </p>
      {err && <p className="rounded bg-red-950/50 px-2 py-1.5 text-xs break-words text-red-300">{err}</p>}
      {tools && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 text-xs text-muted">
            {tools.length} tool(s). Generate: <b className="text-zinc-300">{gen?.name ?? 'none found'}</b>, edit: <b className="text-zinc-300">{edit?.name ?? 'none found'}</b>
            <div className="flex-1" />
            <button
              type="button"
              className="btn-ghost text-xs"
              onClick={() => navigator.clipboard.writeText(JSON.stringify(tools, null, 2)).then(() => toast('Tool list copied', 'info'))}
            >
              <ClipboardCopy size={13} /> Copy as JSON
            </button>
          </div>
          <div className="max-h-72 space-y-1.5 overflow-y-auto">
            {tools.map((t) => (
              <details key={t.name} className="rounded border border-line bg-bg px-2 py-1.5 text-xs">
                <summary className="cursor-pointer">
                  <span className="font-mono text-zinc-200">{t.name}</span>
                  {t.description && <span className="ml-2 text-muted">{t.description.split('\n')[0].slice(0, 120)}</span>}
                </summary>
                {t.description && <p className="mt-1 whitespace-pre-wrap text-muted">{t.description}</p>}
                <pre className="mt-1 overflow-x-auto text-[11px] text-zinc-400">{JSON.stringify(t.inputSchema, null, 2)}</pre>
              </details>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

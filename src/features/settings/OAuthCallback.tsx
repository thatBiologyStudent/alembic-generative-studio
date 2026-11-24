import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { CheckCircle2, XCircle } from 'lucide-react';
import { completeSignIn } from '../../lib/oauth';
import { errMsg } from '../../lib/http';
import { Spinner } from '../../components/common';
import { useUI } from '../../store/ui';

/** /oauth/callback: where OpenArt (or another OAuth provider) sends the browser back after sign-in. */
export function OAuthCallback() {
  const [state, setState] = useState<{ kind: 'busy' } | { kind: 'ok'; name: string } | { kind: 'err'; msg: string }>({ kind: 'busy' });
  const nav = useNavigate();
  const once = useRef(false);

  useEffect(() => {
    if (once.current) return; // StrictMode runs effects twice; the code can only be used once
    once.current = true;
    const params = new URLSearchParams(location.search);
    completeSignIn(params)
      .then(({ name, returnTo }) => {
        setState({ kind: 'ok', name });
        if (window.opener) setTimeout(() => window.close(), 600);
        else {
          useUI.getState().toast(`Signed in to ${name}`, 'success');
          nav(returnTo && !returnTo.includes('oauth/callback') ? returnTo : '/settings', { replace: true });
        }
      })
      .catch((e) => setState({ kind: 'err', msg: errMsg(e) }));
  }, [nav]);

  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="card max-w-sm p-6 text-center">
        {state.kind === 'busy' && (
          <p className="flex items-center justify-center gap-2 text-sm text-muted">
            <Spinner /> Finishing sign-in…
          </p>
        )}
        {state.kind === 'ok' && (
          <p className="flex items-center justify-center gap-2 text-sm text-emerald-300">
            <CheckCircle2 size={16} /> Signed in to {state.name}. {window.opener ? 'You can close this window.' : ''}
          </p>
        )}
        {state.kind === 'err' && (
          <>
            <p className="mb-4 flex items-start gap-2 text-left text-sm text-red-300">
              <XCircle size={16} className="mt-0.5 shrink-0" /> {state.msg}
            </p>
            <Link to="/settings" className="btn">
              Back to settings
            </Link>
          </>
        )}
      </div>
    </div>
  );
}

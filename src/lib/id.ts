const ALPHA = 'abcdefghijkmnpqrstuvwxyz23456789';
export function uid(len = 8): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let s = '';
  for (const b of bytes) s += ALPHA[b % ALPHA.length];
  return s;
}

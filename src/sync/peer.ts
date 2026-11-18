/**
 * Device-to-device sync over WebRTC.
 *
 * The sending device creates a connection offer and gets a short code from /api/sync (a handshake relay that
 * only stores the connection descriptions for a few minutes). The receiving device enters the code, answers,
 * and the two browsers connect directly. The data (a backup .zip: projects, images, providers, settings, and
 * keys only when chosen) goes straight from one browser to the other, encrypted by WebRTC (DTLS).
 */
import { asset } from '../lib/base';
import { exportSelection, restoreAll, type ExportSelection, type RestoreReport } from '../db/backup';

const ICE_SERVERS: RTCIceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
const CHUNK = 64 * 1024;
const HIGH_WATER = 8 * 1024 * 1024;
const LOW_WATER = 1024 * 1024;
const POLL_MS = 1500;
const CONNECT_TIMEOUT_MS = 30_000;

export type SyncPhase = 'idle' | 'starting' | 'waiting' | 'connecting' | 'connected' | 'packing' | 'transferring' | 'importing' | 'done' | 'error';

export interface SyncSummary {
  projects: number;
  providers: number;
  settings: boolean;
  keys: boolean;
  bytes: number;
}

export interface SyncState {
  phase: SyncPhase;
  code?: string;
  expiresAt?: number;
  /** 4 digits derived from both devices' connection fingerprints: equal on both screens = connected to each other */
  check?: string;
  progress?: { done: number; total: number };
  summary?: SyncSummary;
  report?: RestoreReport;
  error?: string;
}

type Listener = (s: SyncState) => void;

async function api<T>(init: { method: 'GET'; code: string } | { method: 'POST'; body: object }): Promise<T> {
  const url = asset('api/sync') + (init.method === 'GET' ? `?code=${encodeURIComponent(init.code)}` : '');
  let r: Response;
  try {
    r = await fetch(url, init.method === 'GET' ? { cache: 'no-store' } : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.body) });
  } catch {
    throw new Error('The sync server could not be reached. Check your internet connection.');
  }
  const d = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw Object.assign(new Error(d.error || `Sync server error (HTTP ${r.status}).`), { status: r.status });
  return d;
}

function waitForIce(pc: RTCPeerConnection, ms = 4000): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      pc.removeEventListener('icegatheringstatechange', check);
      clearTimeout(t);
      resolve();
    };
    const check = () => pc.iceGatheringState === 'complete' && done();
    const t = setTimeout(done, ms);
    pc.addEventListener('icegatheringstatechange', check);
  });
}

/** Short number from both DTLS fingerprints; identical on both devices only if they are connected to each other. */
async function checkNumber(offer: string, answer: string): Promise<string> {
  const fp = (sdp: string) => (/a=fingerprint:\S+ (\S+)/i.exec(sdp)?.[1] ?? sdp).toUpperCase();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${fp(offer)}|${fp(answer)}`));
  const n = new DataView(digest).getUint32(0) % 10000;
  return String(n).padStart(4, '0');
}

const NETWORK_HINT =
  'Could not connect the two devices directly. Both need internet access (or the same Wi-Fi). Some company, school or mobile networks block direct connections — try another network or a phone hotspot.';

abstract class SyncPeer {
  protected pc?: RTCPeerConnection;
  protected channel?: RTCDataChannel;
  protected state: SyncState = { phase: 'idle' };
  protected closed = false;

  constructor(private listener: Listener) {}

  protected set(patch: Partial<SyncState>) {
    if (this.closed && patch.phase !== 'error') return;
    this.state = { ...this.state, ...patch };
    this.listener(this.state);
  }

  protected fail(e: unknown) {
    if (this.closed) return;
    this.set({ phase: 'error', error: e instanceof Error ? e.message : String(e) });
    this.teardown();
  }

  protected newPeer(): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pc.addEventListener('iceconnectionstatechange', () => {
      if (pc.iceConnectionState === 'failed') this.fail(new Error(NETWORK_HINT));
    });
    this.pc = pc;
    return pc;
  }

  protected waitOpen(ch: RTCDataChannel): Promise<void> {
    if (ch.readyState === 'open') return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(NETWORK_HINT)), CONNECT_TIMEOUT_MS);
      ch.addEventListener('open', () => (clearTimeout(t), resolve()), { once: true });
      ch.addEventListener('close', () => (clearTimeout(t), reject(new Error('The connection was closed.'))), { once: true });
    });
  }

  protected teardown() {
    this.closed = true;
    try {
      this.channel?.close();
    } catch {
      /* ignore */
    }
    try {
      this.pc?.close();
    } catch {
      /* ignore */
    }
  }

  cancel() {
    this.teardown();
  }
}

export class SyncSender extends SyncPeer {
  private result?: (m: { report?: RestoreReport; error?: string }) => void;

  /** Creates the offer and a code, then waits (in the background) for the other device to answer. */
  async start() {
    try {
      this.set({ phase: 'starting' });
      const pc = this.newPeer();
      const ch = pc.createDataChannel('alembic-sync', { ordered: true });
      ch.binaryType = 'arraybuffer';
      ch.bufferedAmountLowThreshold = LOW_WATER;
      ch.addEventListener('message', (e) => {
        if (typeof e.data !== 'string') return;
        const m = JSON.parse(e.data);
        if (m.type === 'result') this.result?.(m);
      });
      ch.addEventListener('close', () => {
        if (this.state.phase !== 'done' && !this.closed) this.fail(new Error('The other device disconnected.'));
      });
      this.channel = ch;
      await pc.setLocalDescription(await pc.createOffer());
      await waitForIce(pc);
      const offer = pc.localDescription!.sdp;
      const { code, expiresIn } = await api<{ code: string; expiresIn: number }>({ method: 'POST', body: { op: 'create', offer } });
      if (this.closed) return void api({ method: 'POST', body: { op: 'close', code } }).catch(() => {});
      this.set({ phase: 'waiting', code, expiresAt: Date.now() + expiresIn * 1000 });
      void this.waitForAnswer(code, offer);
    } catch (e) {
      this.fail(e);
    }
  }

  private async waitForAnswer(code: string, offer: string) {
    try {
      let answer: string | null = null;
      while (!answer && !this.closed) {
        if (Date.now() > (this.state.expiresAt ?? 0)) throw new Error('The code expired. Create a new one.');
        await new Promise((r) => setTimeout(r, POLL_MS));
        if (this.closed) return;
        answer = (await api<{ answer: string | null }>({ method: 'GET', code })).answer;
      }
      if (!answer || this.closed) return;
      this.set({ phase: 'connecting' });
      await this.pc!.setRemoteDescription({ type: 'answer', sdp: answer });
      void api({ method: 'POST', body: { op: 'close', code } }).catch(() => {}); // code is used up
      await this.waitOpen(this.channel!);
      this.set({ phase: 'connected', check: await checkNumber(offer, answer) });
    } catch (e) {
      this.fail(e);
    }
  }

  /** Packs the chosen data and streams it to the connected device. */
  async send(sel: ExportSelection, counts: { projects: number; providers: number }) {
    const ch = this.channel;
    if (!ch || ch.readyState !== 'open') return this.fail(new Error('Not connected.'));
    try {
      this.set({ phase: 'packing', progress: { done: 0, total: Math.max(1, counts.projects) } });
      const blob = await exportSelection(sel, (done, total) => this.set({ progress: { done, total } }));
      const summary: SyncSummary = { ...counts, settings: sel.settings, keys: sel.providers && sel.includeKeys, bytes: blob.size };
      this.set({ phase: 'transferring', summary, progress: { done: 0, total: blob.size } });
      ch.send(JSON.stringify({ type: 'meta', summary }));
      for (let off = 0; off < blob.size; off += CHUNK) {
        if (this.closed) return;
        if (ch.bufferedAmount > HIGH_WATER) await new Promise((r) => ch.addEventListener('bufferedamountlow', r, { once: true }));
        ch.send(await blob.slice(off, off + CHUNK).arrayBuffer());
        this.set({ progress: { done: Math.min(blob.size, off + CHUNK), total: blob.size } });
      }
      const res = new Promise<{ report?: RestoreReport; error?: string }>((r) => (this.result = r));
      ch.send(JSON.stringify({ type: 'end' }));
      this.set({ phase: 'importing' });
      const m = await res;
      if (m.error) throw new Error(`The other device could not import the data: ${m.error}`);
      this.set({ phase: 'done', report: m.report });
      setTimeout(() => this.teardown(), 1000);
    } catch (e) {
      this.fail(e);
    }
  }
}

export class SyncReceiver extends SyncPeer {
  private chunks: ArrayBuffer[] = [];
  private received = 0;

  async connect(code: string) {
    try {
      this.set({ phase: 'connecting', code });
      const { offer, answer: taken } = await api<{ offer: string; answer: string | null }>({ method: 'GET', code });
      if (taken) throw new Error('This code was already used by another device.');
      const pc = this.newPeer();
      const opened = new Promise<RTCDataChannel>((resolve) => pc.addEventListener('datachannel', (e) => resolve(e.channel), { once: true }));
      await pc.setRemoteDescription({ type: 'offer', sdp: offer });
      await pc.setLocalDescription(await pc.createAnswer());
      await waitForIce(pc);
      const answer = pc.localDescription!.sdp;
      await api({ method: 'POST', body: { op: 'answer', code, answer } });
      const ch = await Promise.race([
        opened,
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error(NETWORK_HINT)), CONNECT_TIMEOUT_MS)),
      ]);
      ch.binaryType = 'arraybuffer';
      this.channel = ch;
      ch.addEventListener('message', (e) => void this.onMessage(e.data));
      ch.addEventListener('close', () => {
        if (!['done', 'importing'].includes(this.state.phase) && !this.closed) this.fail(new Error('The other device disconnected.'));
      });
      await this.waitOpen(ch);
      this.set({ phase: 'connected', check: await checkNumber(offer, answer) });
    } catch (e) {
      this.fail(e);
    }
  }

  private async onMessage(data: unknown) {
    try {
      if (data instanceof ArrayBuffer) {
        this.chunks.push(data);
        this.received += data.byteLength;
        this.set({ progress: { done: this.received, total: this.state.summary?.bytes ?? this.received } });
        return;
      }
      const m = JSON.parse(String(data));
      if (m.type === 'meta') {
        this.chunks = [];
        this.received = 0;
        this.set({ phase: 'transferring', summary: m.summary, progress: { done: 0, total: m.summary.bytes } });
      } else if (m.type === 'end') {
        this.set({ phase: 'importing' });
        const blob = new Blob(this.chunks, { type: 'application/zip' });
        this.chunks = [];
        try {
          const report = await restoreAll(blob, { replaceNewer: true });
          this.channel?.send(JSON.stringify({ type: 'result', report }));
          this.set({ phase: 'done', report });
        } catch (e) {
          this.channel?.send(JSON.stringify({ type: 'result', error: (e as Error).message }));
          throw e;
        }
        setTimeout(() => this.teardown(), 1500);
      }
    } catch (e) {
      this.fail(e);
    }
  }
}

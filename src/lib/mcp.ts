/**
 * Minimal MCP client over Streamable HTTP (JSON-RPC 2.0, answers as JSON or a server-sent event stream).
 * Enough for tools/list and tools/call; no server-to-client requests, resources or prompts.
 */
import { ApiError, via } from './http';

export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: JsonSchema;
  annotations?: Record<string, unknown>;
}
export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: unknown[];
  items?: JsonSchema;
  description?: string;
  default?: unknown;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  const?: unknown;
  minimum?: number;
  maximum?: number;
}
export interface McpContent {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
  resource?: { uri?: string; mimeType?: string; blob?: string; text?: string };
}
export interface McpToolResult {
  content?: McpContent[];
  structuredContent?: unknown;
  isError?: boolean;
}

interface RpcMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpClientOptions {
  url: string;
  useProxy?: boolean;
  /** bearer token; `force` asks for a refreshed one after a 401 */
  token: (force?: boolean) => Promise<string>;
  /** shown in errors */
  label: string;
}

const PROTOCOL = '2025-06-18';

export class McpClient {
  private sessionId?: string;
  private protocol = PROTOCOL;
  private ready?: Promise<void>;
  private nextId = 1;
  private toolCache?: Promise<McpTool[]>;

  constructor(private o: McpClientOptions) {}

  private async post(msg: RpcMessage, signal?: AbortSignal, onNote?: (n: RpcMessage) => void, attempt = 0): Promise<RpcMessage | undefined> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${await this.o.token(attempt > 0)}`,
    };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    if (msg.method !== 'initialize') headers['MCP-Protocol-Version'] = this.protocol;
    let res: Response;
    try {
      res = await fetch(via(this.o, this.o.url), { method: 'POST', headers, body: JSON.stringify(msg), signal });
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      throw new ApiError(`Could not reach ${this.o.label}. Check your connection, and that "Route through proxy" is on for this provider.`, undefined, 'network');
    }
    if (res.status === 401 && attempt === 0) return this.post(msg, signal, onNote, 1);
    // the server forgot our session (restart / timeout): start a new one once
    if (res.status === 404 && this.sessionId && msg.method !== 'initialize' && attempt < 2) {
      this.sessionId = undefined;
      this.ready = undefined;
      await this.ensureReady(signal);
      return this.post(msg, signal, onNote, 2);
    }
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      let detail = t;
      try {
        const j = JSON.parse(t);
        detail = j.error_description || j.error?.message || j.message || (typeof j.error === 'string' ? j.error : t);
      } catch {
        /* plain text */
      }
      throw new ApiError(`${this.o.label}: ${res.status} ${res.statusText}${detail ? ` – ${String(detail).slice(0, 400)}` : ''}`, res.status, res.status === 401 || res.status === 403 ? 'auth' : 'http');
    }
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    if (msg.id === undefined) return undefined; // notification: 202, no body
    const type = res.headers.get('content-type') ?? '';
    if (type.includes('text/event-stream')) return readStream(res, msg.id, onNote);
    const j = (await res.json()) as RpcMessage | RpcMessage[];
    return Array.isArray(j) ? j.find((m) => m.id === msg.id) : j;
  }

  private ensureReady(signal?: AbortSignal): Promise<void> {
    this.ready ??= (async () => {
      const r = await this.post(
        { jsonrpc: '2.0', id: this.nextId++, method: 'initialize', params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'alembic-generative-studio', version: '1.0.0' } } },
        signal,
      );
      if (r?.error) throw new Error(`${this.o.label}: ${r.error.message}`);
      if (r?.result?.protocolVersion) this.protocol = r.result.protocolVersion;
      await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, signal);
    })().catch((e) => {
      this.ready = undefined;
      throw e;
    });
    return this.ready;
  }

  async request<T = any>(method: string, params?: any, opts: { signal?: AbortSignal; onNote?: (n: RpcMessage) => void } = {}): Promise<T> {
    await this.ensureReady(opts.signal);
    const r = await this.post({ jsonrpc: '2.0', id: this.nextId++, method, params }, opts.signal, opts.onNote);
    if (!r) throw new Error(`${this.o.label} sent no answer to ${method}.`);
    if (r.error) throw new Error(`${this.o.label}: ${r.error.message}`);
    return r.result as T;
  }

  listTools(force = false): Promise<McpTool[]> {
    if (force) this.toolCache = undefined;
    this.toolCache ??= (async () => {
      const out: McpTool[] = [];
      let cursor: string | undefined;
      do {
        const r = await this.request<{ tools?: McpTool[]; nextCursor?: string }>('tools/list', cursor ? { cursor } : {});
        out.push(...(r.tools ?? []));
        cursor = r.nextCursor;
      } while (cursor && out.length < 1000);
      return out;
    })().catch((e) => {
      this.toolCache = undefined;
      throw e;
    });
    return this.toolCache;
  }

  /** Calls a tool. Progress notifications are passed to onProgress as 0..1 when the server reports a total. */
  async callTool(name: string, args: Record<string, unknown>, opts: { signal?: AbortSignal; onProgress?: (f: number) => void } = {}): Promise<McpToolResult> {
    const progressToken = `p${this.nextId}`;
    return this.request<McpToolResult>(
      'tools/call',
      { name, arguments: args, _meta: { progressToken } },
      {
        signal: opts.signal,
        onNote: (n) => {
          if (n.method === 'notifications/progress' && n.params?.progressToken === progressToken && n.params.total)
            opts.onProgress?.(Math.min(1, n.params.progress / n.params.total));
        },
      },
    );
  }
}

/** Reads an SSE answer until the response to `id` arrives; other messages (progress, logs) go to onNote. */
async function readStream(res: Response, id: number | string, onNote?: (n: RpcMessage) => void): Promise<RpcMessage | undefined> {
  const reader = res.body?.getReader();
  if (!reader) return undefined;
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buf += dec.decode(value, { stream: true });
      let cut: number;
      while ((cut = buf.search(/\r?\n\r?\n/)) >= 0) {
        const block = buf.slice(0, cut);
        buf = buf.slice(cut).replace(/^\r?\n\r?\n/, '');
        const data = block
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).replace(/^ /, ''))
          .join('\n');
        if (!data) continue;
        let m: RpcMessage;
        try {
          m = JSON.parse(data);
        } catch {
          continue;
        }
        if (m.id === id && (m.result !== undefined || m.error)) return m;
        onNote?.(m);
      }
      if (done) return undefined;
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

/** All text in a tool result, for error messages and for tools that answer in prose. */
export function resultText(r: McpToolResult): string {
  return (r.content ?? [])
    .map((c) => c.text ?? c.resource?.text ?? '')
    .filter(Boolean)
    .join('\n')
    .trim();
}

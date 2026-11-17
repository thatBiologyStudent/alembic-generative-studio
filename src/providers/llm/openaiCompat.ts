import type { Connection, ToolCall } from '../../db/schema';
import { apiFetch, apiJson, trimUrl, via } from '../../lib/http';
import { extractModelList, isChatModel } from '../classify';
import { readSSE } from '../../lib/sse';
import { uid } from '../../lib/id';
import type { ChatRequest, ChatResponse, LLMMessage, LLMProvider } from './types';

/** OpenAI Chat Completions. Also works for Ollama (/v1), LM Studio, OpenRouter, vLLM, etc. */
export class OpenAICompatProvider implements LLMProvider {
  constructor(private conn: Connection) {}

  private get base() {
    let b = trimUrl(this.conn.baseUrl || 'https://api.openai.com/v1');
    // Ollama users often paste http://localhost:11434 — add /v1
    if (this.conn.preset === 'ollama' && !/\/v1$/.test(b)) b += '/v1';
    return b;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.conn.apiKey) h.Authorization = `Bearer ${this.conn.apiKey}`;
    return h;
  }

  async listModels(): Promise<string[]> {
    const j = await apiJson(via(this.conn, `${this.base}/models`), { headers: this.headers() });
    let list = extractModelList(j).filter((m) => isChatModel(m.id, m.meta));
    if (this.conn.preset === 'openai') list = list.filter((m) => /^(gpt|o\d|chatgpt)/.test(m.id));
    // Gemini's OpenAI endpoint returns "models/gemini-…" ids; both forms work, the short one reads better
    return [...new Set(list.map((m) => m.id.replace(/^models\//, '')))].sort();
  }

  private toWire(messages: LLMMessage[], system?: string) {
    const out: any[] = [];
    if (system) out.push({ role: 'system', content: system });
    for (const m of messages) {
      if (m.role === 'user') {
        const onlyText = m.content.every((p) => p.type === 'text');
        out.push({
          role: 'user',
          content: onlyText
            ? m.content.map((p) => (p as any).text).join('\n')
            : m.content.map((p) =>
                p.type === 'text' ? { type: 'text', text: p.text } : { type: 'image_url', image_url: { url: p.dataUrl } },
              ),
        });
      } else if (m.role === 'assistant') {
        const msg: any = { role: 'assistant', content: m.content || (m.toolCalls?.length ? null : '') };
        if (m.toolCalls?.length) {
          msg.tool_calls = m.toolCalls.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
          }));
        }
        out.push(msg);
      } else {
        const imgs: string[] = [];
        for (const r of m.results) {
          out.push({ role: 'tool', tool_call_id: r.callId, content: r.content });
          if (r.images) imgs.push(...r.images);
        }
        // Chat Completions tool messages are text-only: hand images back as a user turn.
        if (imgs.length) {
          out.push({
            role: 'user',
            content: [
              { type: 'text', text: '[Automatic message] These are the images produced by your tool call(s), in order.' },
              ...imgs.map((url) => ({ type: 'image_url', image_url: { url } })),
            ],
          });
        }
      }
    }
    return out;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const body: any = {
      model: req.model,
      messages: this.toWire(req.messages, req.system),
      stream: true,
    };
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.maxTokens) body.max_completion_tokens = req.maxTokens;

    const res = await apiFetch(via(this.conn, `${this.base}/chat/completions`), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: req.signal,
    });

    let text = '';
    const calls: { id?: string; name: string; args: string }[] = [];
    const ctype = res.headers.get('content-type') || '';
    if (!ctype.includes('event-stream')) {
      // Some servers ignore stream:true
      const j = await res.json();
      const msg = j.choices?.[0]?.message ?? {};
      text = msg.content ?? '';
      if (text) req.onText?.(text);
      for (const tc of msg.tool_calls ?? []) calls.push({ id: tc.id, name: tc.function?.name, args: tc.function?.arguments ?? '' });
    } else {
      for await (const ev of readSSE(res)) {
        if (ev.data === '[DONE]') break;
        let j: any;
        try {
          j = JSON.parse(ev.data);
        } catch {
          continue;
        }
        if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
        const delta = j.choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.content) {
          text += delta.content;
          req.onText?.(delta.content);
        }
        for (const tc of delta.tool_calls ?? []) {
          const i = tc.index ?? calls.length;
          calls[i] ??= { name: '', args: '' };
          if (tc.id) calls[i].id = tc.id;
          if (tc.function?.name) calls[i].name += tc.function.name;
          if (tc.function?.arguments) {
            const a = tc.function.arguments;
            calls[i].args += typeof a === 'string' ? a : JSON.stringify(a);
          }
        }
      }
    }

    const toolCalls: ToolCall[] = calls
      .filter((c) => c && c.name)
      .map((c) => {
        let args: any = {};
        try {
          args = c.args ? JSON.parse(c.args) : {};
        } catch {
          args = { _raw: c.args };
        }
        return { id: c.id || 'call_' + uid(), name: c.name, args };
      });
    return { text, toolCalls };
  }
}

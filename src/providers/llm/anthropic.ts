import type { Connection, ToolCall } from '../../db/schema';
import { apiFetch, apiJson, trimUrl, via } from '../../lib/http';
import { parseDataUrl } from '../../lib/image';
import { readSSE } from '../../lib/sse';
import type { ChatRequest, ChatResponse, LLMMessage, LLMProvider } from './types';

export class AnthropicProvider implements LLMProvider {
  constructor(private conn: Connection) {}

  private get base() {
    return trimUrl(this.conn.baseUrl || 'https://api.anthropic.com');
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-api-key': this.conn.apiKey ?? '',
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    };
  }

  async listModels(): Promise<string[]> {
    const j = await apiJson<{ data: { id: string }[] }>(via(this.conn, `${this.base}/v1/models?limit=100`), { headers: this.headers() });
    return (j.data ?? []).map((m) => m.id);
  }

  private img(dataUrl: string) {
    const { mediaType, data } = parseDataUrl(dataUrl);
    return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
  }

  private toWire(messages: LLMMessage[]) {
    const out: { role: 'user' | 'assistant'; content: any[] }[] = [];
    const push = (role: 'user' | 'assistant', blocks: any[]) => {
      if (!blocks.length) return;
      const last = out[out.length - 1];
      if (last && last.role === role) last.content.push(...blocks);
      else out.push({ role, content: blocks });
    };
    for (const m of messages) {
      if (m.role === 'user') {
        push(
          'user',
          m.content
            .filter((p) => p.type !== 'text' || p.text.trim())
            .map((p) => (p.type === 'text' ? { type: 'text', text: p.text } : this.img(p.dataUrl))),
        );
      } else if (m.role === 'assistant') {
        const blocks: any[] = [];
        if (m.content.trim()) blocks.push({ type: 'text', text: m.content });
        for (const c of m.toolCalls ?? []) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args ?? {} });
        push('assistant', blocks.length ? blocks : [{ type: 'text', text: '…' }]);
      } else {
        push(
          'user',
          m.results.map((r) => ({
            type: 'tool_result',
            tool_use_id: r.callId,
            is_error: r.isError || undefined,
            content: [{ type: 'text', text: r.content }, ...(r.images ?? []).map((u) => this.img(u))],
          })),
        );
      }
    }
    if (out[0]?.role === 'assistant') out.unshift({ role: 'user', content: [{ type: 'text', text: '(start)' }] });
    return out;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const body: any = {
      model: req.model,
      max_tokens: req.maxTokens ?? 4096,
      messages: this.toWire(req.messages),
      stream: true,
    };
    if (req.system) body.system = req.system;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    }

    const res = await apiFetch(via(this.conn, `${this.base}/v1/messages`), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: req.signal,
    });

    let text = '';
    const blocks: Record<number, { type: string; id?: string; name?: string; json: string }> = {};
    for await (const ev of readSSE(res)) {
      let j: any;
      try {
        j = JSON.parse(ev.data);
      } catch {
        continue;
      }
      switch (j.type) {
        case 'content_block_start':
          blocks[j.index] = { type: j.content_block.type, id: j.content_block.id, name: j.content_block.name, json: '' };
          if (j.content_block.type === 'text' && j.content_block.text) {
            text += j.content_block.text;
            req.onText?.(j.content_block.text);
          }
          break;
        case 'content_block_delta':
          if (j.delta.type === 'text_delta') {
            text += j.delta.text;
            req.onText?.(j.delta.text);
          } else if (j.delta.type === 'input_json_delta' && blocks[j.index]) {
            blocks[j.index].json += j.delta.partial_json;
          }
          break;
        case 'error':
          throw new Error(j.error?.message || 'Anthropic stream error');
      }
    }
    const toolCalls: ToolCall[] = Object.values(blocks)
      .filter((b) => b.type === 'tool_use')
      .map((b) => {
        let args: any = {};
        try {
          args = b.json ? JSON.parse(b.json) : {};
        } catch {
          args = { _raw: b.json };
        }
        return { id: b.id!, name: b.name!, args };
      });
    return { text, toolCalls };
  }
}

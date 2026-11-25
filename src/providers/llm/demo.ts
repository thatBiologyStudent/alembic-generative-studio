import { uid } from '../../lib/id';
import { sleep } from '../../lib/http';
import type { ChatRequest, ChatResponse, LLMProvider } from './types';

/**
 * Offline stand-in for an LLM. It does no reasoning: it turns your message into a
 * generate_image call so the whole studio can be tried without any API key.
 */
export class DemoProvider implements LLMProvider {
  async listModels() {
    return ['demo-echo'];
  }

  private async stream(text: string, req: ChatRequest) {
    for (const word of text.split(/(\s+)/)) {
      if (req.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      req.onText?.(word);
      await sleep(12);
    }
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const last = req.messages[req.messages.length - 1];
    if (req.system?.includes('You write prompts for an image generator')) {
      // offline stand-in for the reference prompt writer: must-fix items first, then the scene
      const t = last?.role === 'user' ? last.content.map((p) => (p.type === 'text' ? p.text : '')).join(' ') : '';
      const fix = /MUST-FIX[^\n]*\n((?:- .*\n?)+)/.exec(t)?.[1].replace(/\n?- /g, '; ').replace(/^; /, '').trim();
      const scene = /SCENE:\n([\s\S]*)$/.exec(t)?.[1].trim() ?? '';
      const text = `${fix ? `Must match the character exactly: ${fix}. ` : ''}demo character, ${scene}`;
      await this.stream(text, req);
      return { text, toolCalls: [] };
    }
    if (req.system?.includes('character consistency')) {
      // offline stand-in for the reference comparison: "lookalike" in the request fails until the corrections are in the prompt
      const t = last?.role === 'user' ? last.content.map((p) => (p.type === 'text' ? p.text : '')).join(' ') : '';
      const text =
        /lookalike/i.test(t) && !/Must match the character exactly/.test(t)
          ? '{"features": [{"feature": "hair", "reference": "straight silver bob", "generated": "wavy grey hair", "same": false}], "identity_score": 7, "scene_ok": true, "match": false, "corrections": ["straight-cut silver bob ending at the jaw"]}'
          : '{"features": [{"feature": "hair", "reference": "straight silver bob", "generated": "straight silver bob", "same": true}], "identity_score": 9, "scene_ok": true, "match": true}';
      await this.stream(text, req);
      return { text, toolCalls: [] };
    }
    if (req.system?.includes('quality checker')) {
      // offline stand-in for the image check. Test keywords in your message:
      //   "fail-once"   → first attempt fails, the suggested fixed prompt passes
      //   "always-fail" → every attempt fails (shows the retry limit)
      const t = last?.role === 'user' ? last.content.map((p) => (p.type === 'text' ? p.text : '')).join(' ') : '';
      const prompt = /Prompt sent to the generator: (.*)/.exec(t)?.[1] ?? '';
      let text = '{"match": true}';
      if (/always-fail/i.test(t)) text = '{"match": false, "issues": "demo: forced failure (always-fail)", "fixed_prompt": "' + prompt.replace(/"/g, '') + ' (retry)"}';
      else if (/mangled-test/i.test(t) && !/\(fixed\)/.test(prompt))
        text = '{"match": false, "artefacts": true, "issues": "demo: melted, burnt image (mangled-test)", "fixed_prompt": "' + prompt.replace(/"/g, '') + ' (fixed)"}';
      else if (/fail-once/i.test(t) && !/\(fixed\)/.test(prompt))
        text = '{"match": false, "issues": "demo: first attempt rejected (fail-once)", "fixed_prompt": "' + prompt.replace(/"/g, '') + ' (fixed)"}';
      await this.stream(text, req);
      return { text, toolCalls: [] };
    }
    if (!req.tools?.length) {
      const text =
        'portrait of a character, detailed face, expressive eyes, shoulder-length hair, casual outfit, soft studio lighting, high detail (demo model — connect a real vision LLM for actual analysis)';
      await this.stream(text, req);
      return { text, toolCalls: [] };
    }
    // offline walk-through of the model-switch flow: say "edit-model" in a message
    if (last?.role === 'tool' && last.results[0]?.name === 'list_models') {
      const m = /provider "([^"]+)" \| model "([^"]+)"/.exec(last.results[0].content);
      if (m) {
        const text = `I found an edit-capable model: ${m[2]}. Asking you to approve it.`;
        await this.stream(text, req);
        return {
          text,
          toolCalls: [{ id: 'call_' + uid(), name: 'request_model_change', args: { slot: 'edit', provider: m[1], model: m[2], reason: 'Your generate model can only work from text; this one can edit images.' } }],
        };
      }
    }
    if (last?.role === 'tool' && last.results[0]?.name === 'request_model_change') {
      const text = last.results[0].isError ? 'Okay, I will not switch models.' : 'Thanks — the edit model is set. Ask me for the change again and I will edit the image.';
      await this.stream(text, req);
      return { text, toolCalls: [] };
    }
    if (last?.role === 'user' && last.content.some((p) => p.type === 'text' && /edit-model/i.test(p.text))) {
      const text = 'Your current setup cannot edit images. Let me look for a model that can.';
      await this.stream(text, req);
      return { text, toolCalls: [{ id: 'call_' + uid(), name: 'list_models', args: { purpose: 'edit' } }] };
    }
    if (last?.role === 'tool') {
      const text = `Done — ${last.results.map((r) => r.content).join(' ')}\n\n*(Demo LLM: connect OpenAI, Claude or Ollama in Settings for a real assistant.)*`;
      await this.stream(text, req);
      return { text, toolCalls: [] };
    }
    const userText = last?.role === 'user' ? last.content.map((p) => (p.type === 'text' ? p.text : '')).join(' ').trim() : '';
    const hasImage = last?.role === 'user' && last.content.some((p) => p.type === 'image');
    // tiny keyword parser so sizing can be tried offline: "3:4", "16:9", "2k", "from now on"
    const aspect = /\b(\d{1,2}:\d{1,2})\b/.exec(userText)?.[1];
    const resolution = /\b(\d(?:\.\d)?k)\b/i.exec(userText)?.[1]?.toLowerCase();
    const sticky = /\b(from now on|always|by default|as default)\b/i.test(userText);
    const sizeArgs = { ...(aspect ? { aspect_ratio: aspect } : {}), ...(resolution ? { resolution } : {}) };
    const prompt = userText.replace(/\b\d{1,2}:\d{1,2}\b|\b\d(?:\.\d)?k\b|\bin\b(?=\s*(resolution|$))/gi, '').replace(/\s+/g, ' ').trim();
    const calls = [];
    // several lines → one image per line (generate_batch)
    const lines = userText.split('\n').map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()).filter(Boolean);
    if (lines.length > 1) {
      const intro = `Generating ${lines.length} images, one per line.`;
      await this.stream(intro, req);
      return { text: intro, toolCalls: [{ id: 'call_' + uid(), name: 'generate_batch', args: { items: lines.map((l) => ({ label: l.slice(0, 40), prompt: l })), ...sizeArgs } }] };
    }
    if (sticky && (aspect || resolution)) calls.push({ id: 'call_' + uid(), name: 'update_settings', args: sizeArgs });
    calls.push({
      id: 'call_' + uid(),
      name: 'generate_image',
      args: { prompt: prompt || (hasImage ? 'variation of the attached image' : 'a colourful abstract scene'), count: 1, ...(sticky ? {} : sizeArgs) },
    });
    const intro = sticky && (aspect || resolution) ? 'Updating the project settings and generating.' : 'Generating that for you.';
    await this.stream(intro, req);
    return { text: intro, toolCalls: calls };
  }
}

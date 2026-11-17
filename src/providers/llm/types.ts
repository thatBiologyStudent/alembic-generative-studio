import type { ToolCall } from '../../db/schema';

export type LLMPart = { type: 'text'; text: string } | { type: 'image'; dataUrl: string };

export type LLMMessage =
  | { role: 'user'; content: LLMPart[] }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; results: { callId: string; name: string; content: string; images?: string[]; isError?: boolean }[] };

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, any>; // JSON schema
}

export interface ChatRequest {
  model: string;
  system?: string;
  messages: LLMMessage[];
  tools?: ToolDef[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  onText?: (delta: string) => void;
}

export interface ChatResponse {
  text: string;
  toolCalls: ToolCall[];
}

export interface LLMProvider {
  chat(req: ChatRequest): Promise<ChatResponse>;
  listModels(): Promise<string[]>;
}

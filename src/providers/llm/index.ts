import type { Connection } from '../../db/schema';
import { AnthropicProvider } from './anthropic';
import { DemoProvider } from './demo';
import { OpenAICompatProvider } from './openaiCompat';
import type { LLMProvider } from './types';

export function getLLM(conn: Connection): LLMProvider {
  switch (conn.chatApi) {
    case 'anthropic':
      return new AnthropicProvider(conn);
    case 'demo':
      return new DemoProvider();
    case 'openai':
      return new OpenAICompatProvider(conn);
    default:
      throw new Error(`${conn.name} is not set up for chat`);
  }
}

export type { LLMProvider } from './types';

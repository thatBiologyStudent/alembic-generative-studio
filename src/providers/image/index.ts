import type { Connection } from '../../db/schema';
import { A1111Backend, SDNextBackend } from './a1111';
import { ChatImageBackend } from './chatImage';
import { ComfyBackend } from './comfy';
import { DemoBackend } from './demo';
import { FlowSidecarBackend } from './flowSidecar';
import { GeminiImageBackend } from './gemini';
import { OpenAIImagesBackend } from './openaiImages';
import type { ImageBackend } from './types';

export function getImageBackend(c: Connection): ImageBackend {
  // providers like ArliAI use a different key for image requests
  const conn: Connection = c.imageApiKey ? { ...c, apiKey: c.imageApiKey } : c;
  switch (conn.imageApi) {
    case 'openai-images':
      return new OpenAIImagesBackend(conn);
    case 'chat-image':
      return new ChatImageBackend(conn);
    case 'gemini':
      return new GeminiImageBackend(conn);
    case 'a1111':
      return new A1111Backend(conn);
    case 'sdnext':
      return new SDNextBackend(conn);
    case 'comfyui':
      return new ComfyBackend(conn);
    case 'demo':
      return new DemoBackend();
    case 'flow-sidecar':
      return new FlowSidecarBackend(conn);
    default:
      throw new Error(`${conn.name} is not set up for images`);
  }
}

export type { ImageBackend } from './types';

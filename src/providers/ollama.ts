import type { LLMProvider } from '../models.js';
import type { VoiceConfig } from '../types.js';

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const DEFAULT_MODEL = process.env.OLLAMA_MODEL || 'llama3.2';

export const ollamaProvider: LLMProvider = {
  name: 'ollama',
  type: 'local',

  async available(): Promise<boolean> {
    try {
      const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(2000) });
      return res.ok;
    } catch {
      return false;
    }
  },

  async complete(text: string, systemPrompt: string, config: VoiceConfig): Promise<string> {
    const model = config.ollamaModel || DEFAULT_MODEL;

    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: text },
        ],
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Ollama error (${res.status}): ${body}`);
    }

    const data = await res.json() as { message?: { content?: string } };
    return data.message?.content || '';
  },
};

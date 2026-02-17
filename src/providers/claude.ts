import Anthropic from '@anthropic-ai/sdk';
import type { LLMProvider } from '../models.js';
import type { VoiceConfig } from '../types.js';
import { loadConfig } from '../config.js';

let client: Anthropic | null = null;
let currentKey: string | undefined;

function getClient(apiKey?: string): Anthropic {
  const key = apiKey || loadConfig().anthropicApiKey || process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY required — add it in Settings or set the env var');
  // Recreate client if key changed
  if (!client || key !== currentKey) {
    client = new Anthropic({ apiKey: key });
    currentKey = key;
  }
  return client;
}

export const claudeProvider: LLMProvider = {
  name: 'claude',
  type: 'cloud',

  async available(): Promise<boolean> {
    return !!(loadConfig().anthropicApiKey || process.env.ANTHROPIC_API_KEY);
  },

  async complete(text: string, systemPrompt: string, config: VoiceConfig): Promise<string> {
    const anthropic = getClient(config.anthropicApiKey);

    const response = await anthropic.messages.create({
      model: config.claudeModel || 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: 'user', content: text }],
    });

    return response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.type === 'text' ? b.text : '')
      .join('\n');
  },
};

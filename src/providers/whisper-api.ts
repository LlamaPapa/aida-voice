import { createReadStream } from 'node:fs';
import OpenAI from 'openai';
import type { SpeechProvider } from '../models.js';
import type { TranscriptionResult, VoiceConfig } from '../types.js';
import { loadConfig } from '../config.js';

let client: OpenAI | null = null;
let currentKey: string | undefined;

function getClient(apiKey?: string): OpenAI {
  const key = apiKey || loadConfig().openaiApiKey || process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY required — add it in Settings or set the env var');
  // Recreate client if key changed
  if (!client || key !== currentKey) {
    client = new OpenAI({ apiKey: key });
    currentKey = key;
  }
  return client;
}

export const whisperApiProvider: SpeechProvider = {
  name: 'whisper-api',
  type: 'cloud',

  async available(): Promise<boolean> {
    return !!(loadConfig().openaiApiKey || process.env.OPENAI_API_KEY);
  },

  async transcribe(audioPath: string, config: VoiceConfig): Promise<TranscriptionResult> {
    const openai = getClient(config.openaiApiKey);
    const start = Date.now();

    const response = await openai.audio.transcriptions.create({
      file: createReadStream(audioPath),
      model: config.whisperModel || 'whisper-1',
      language: config.language,
      response_format: 'verbose_json',
    });

    return {
      text: response.text,
      language: response.language,
      durationMs: Date.now() - start,
    };
  },
};

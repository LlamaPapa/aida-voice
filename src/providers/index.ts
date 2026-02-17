import { registerSpeechProvider, registerLLMProvider } from '../models.js';
import { whisperApiProvider } from './whisper-api.js';
import { whisperLocalProvider } from './whisper-local.js';
import { claudeProvider } from './claude.js';
import { ollamaProvider } from './ollama.js';

export function registerAllProviders(): void {
  registerSpeechProvider(whisperApiProvider);
  registerSpeechProvider(whisperLocalProvider);
  registerLLMProvider(claudeProvider);
  registerLLMProvider(ollamaProvider);
}

export { whisperApiProvider } from './whisper-api.js';
export { whisperLocalProvider, getLocalWhisperStatus } from './whisper-local.js';
export { claudeProvider } from './claude.js';
export { ollamaProvider } from './ollama.js';

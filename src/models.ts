import type { TranscriptionResult, VoiceConfig } from './types.js';

// ── Speech Provider Interface ────────────────────────────────
export interface SpeechProvider {
  name: string;
  type: 'local' | 'cloud';
  available(): Promise<boolean>;
  transcribe(audioPath: string, config: VoiceConfig): Promise<TranscriptionResult>;
}

// ── LLM Provider Interface ───────────────────────────────────
export interface LLMProvider {
  name: string;
  type: 'local' | 'cloud';
  available(): Promise<boolean>;
  complete(text: string, systemPrompt: string, config: VoiceConfig): Promise<string>;
}

// ── Registry ─────────────────────────────────────────────────
const speechProviders = new Map<string, SpeechProvider>();
const llmProviders = new Map<string, LLMProvider>();

export function registerSpeechProvider(provider: SpeechProvider): void {
  speechProviders.set(provider.name, provider);
}

export function registerLLMProvider(provider: LLMProvider): void {
  llmProviders.set(provider.name, provider);
}

export function getSpeechProvider(name: string): SpeechProvider | undefined {
  return speechProviders.get(name);
}

export function getLLMProvider(name: string): LLMProvider | undefined {
  return llmProviders.get(name);
}

export function listSpeechProviders(): SpeechProvider[] {
  return [...speechProviders.values()];
}

export function listLLMProviders(): LLMProvider[] {
  return [...llmProviders.values()];
}

// ── Resolution: pick best available provider ─────────────────
export async function resolveSpeechProvider(preferred?: string): Promise<SpeechProvider> {
  // Try preferred first
  if (preferred) {
    const p = speechProviders.get(preferred);
    if (p && await p.available()) return p;
  }
  // Fallback order: cloud first (faster), then local
  const order = ['whisper-api', 'whisper-local'];
  for (const name of order) {
    const p = speechProviders.get(name);
    if (p && await p.available()) return p;
  }
  throw new Error('No speech provider available. Set OPENAI_API_KEY for cloud or install whisper.cpp for local.');
}

export async function resolveLLMProvider(preferred?: string): Promise<LLMProvider> {
  if (preferred) {
    const p = llmProviders.get(preferred);
    if (p && await p.available()) return p;
  }
  const order = ['claude', 'ollama'];
  for (const name of order) {
    const p = llmProviders.get(name);
    if (p && await p.available()) return p;
  }
  throw new Error('No LLM provider available. Set ANTHROPIC_API_KEY for Claude or install Ollama for local.');
}

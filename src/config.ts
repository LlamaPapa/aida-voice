import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { StructureMode } from './types.js';

const CONFIG_DIR = join(homedir(), '.voice-pipeline');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

export interface ModeConfig {
  speechProvider?: string;
  llmProvider?: string;
  llmModel?: string;
  customPrompt?: string;
}

export interface AppConfig {
  // Global defaults
  defaultMode: StructureMode;
  speechProvider: string;       // 'whisper-api' | 'whisper-local'
  llmProvider: string;          // 'claude' | 'ollama'
  llmModel: string;             // model name within the provider
  whisperModel: string;         // 'whisper-1' (api) or 'base'/'small'/'medium' (local)
  ollamaModel: string;          // 'llama3.2' etc
  language: string;             // 'en', 'es', etc
  autoPaste: boolean;
  offlineMode: boolean;         // force local-only providers
  port: number;

  // API keys (stored so you never need a .env file)
  openaiApiKey?: string;
  anthropicApiKey?: string;

  // Per-mode overrides
  modes: Partial<Record<StructureMode, ModeConfig>>;

  // Hotkey
  hotkey: string;               // 'alt+space'
}

const DEFAULTS: AppConfig = {
  defaultMode: 'message',
  speechProvider: 'whisper-api',
  llmProvider: 'claude',
  llmModel: 'claude-haiku-4-5-20251001',
  whisperModel: 'whisper-1',
  ollamaModel: 'llama3.2',
  language: 'en',
  autoPaste: true,
  offlineMode: false,
  port: 7890,
  modes: {},
  hotkey: 'alt+space',
};

let cached: AppConfig | null = null;

function ensureDir(): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
}

export function loadConfig(): AppConfig {
  if (cached) return cached;
  ensureDir();

  if (existsSync(CONFIG_FILE)) {
    try {
      const raw = readFileSync(CONFIG_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      cached = { ...DEFAULTS, ...parsed };
      return cached!;
    } catch {
      // Corrupted config, use defaults
    }
  }

  cached = { ...DEFAULTS };
  return cached;
}

export function saveConfig(config: AppConfig): void {
  ensureDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
  cached = config;
}

export function updateConfig(partial: Partial<AppConfig>): AppConfig {
  const current = loadConfig();
  const updated = { ...current, ...partial };
  saveConfig(updated);
  return updated;
}

export function getConfigForMode(mode: StructureMode): {
  speechProvider: string;
  llmProvider: string;
  llmModel: string;
} {
  const config = loadConfig();
  const modeOverride = config.modes[mode];

  // Offline mode forces local providers
  if (config.offlineMode) {
    return {
      speechProvider: 'whisper-local',
      llmProvider: 'ollama',
      llmModel: modeOverride?.llmModel || config.ollamaModel,
    };
  }

  return {
    speechProvider: modeOverride?.speechProvider || config.speechProvider,
    llmProvider: modeOverride?.llmProvider || config.llmProvider,
    llmModel: modeOverride?.llmModel || config.llmModel,
  };
}

export function getConfigPath(): string {
  return CONFIG_FILE;
}

export function resetConfig(): AppConfig {
  const config = { ...DEFAULTS };
  saveConfig(config);
  return config;
}

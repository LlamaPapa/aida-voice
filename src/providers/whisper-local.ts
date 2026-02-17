import { execSync, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { SpeechProvider } from '../models.js';
import type { TranscriptionResult, VoiceConfig } from '../types.js';

const MODEL_DIR = join(homedir(), '.voice-pipeline', 'models');

// Supported whisper.cpp model sizes
const MODELS = ['tiny', 'base', 'small', 'medium', 'large'] as const;

function findWhisperBinary(): string | null {
  const names = ['whisper-cpp', 'whisper', 'main'];
  for (const name of names) {
    try {
      const path = execSync(`which ${name}`, { encoding: 'utf-8' }).trim();
      if (path) return path;
    } catch { continue; }
  }
  // Check common install locations
  const paths = [
    '/usr/local/bin/whisper-cpp',
    '/opt/homebrew/bin/whisper-cpp',
    join(homedir(), '.local', 'bin', 'whisper-cpp'),
  ];
  for (const p of paths) {
    if (existsSync(p)) return p;
  }
  return null;
}

function findModel(preferred?: string): string | null {
  const modelName = preferred || 'base';
  // Check common model locations
  const locations = [
    join(MODEL_DIR, `ggml-${modelName}.bin`),
    join(homedir(), '.cache', 'whisper', `ggml-${modelName}.bin`),
    `/usr/local/share/whisper-cpp/models/ggml-${modelName}.bin`,
    `/opt/homebrew/share/whisper-cpp/models/ggml-${modelName}.bin`,
  ];
  for (const loc of locations) {
    if (existsSync(loc)) return loc;
  }
  return null;
}

export const whisperLocalProvider: SpeechProvider = {
  name: 'whisper-local',
  type: 'local',

  async available(): Promise<boolean> {
    return findWhisperBinary() !== null && findModel() !== null;
  },

  async transcribe(audioPath: string, config: VoiceConfig): Promise<TranscriptionResult> {
    const binary = findWhisperBinary();
    if (!binary) {
      throw new Error('whisper.cpp not found. Install: brew install whisper-cpp');
    }

    const modelSize = config.whisperModel || 'base';
    const model = findModel(modelSize);
    if (!model) {
      throw new Error(
        `Whisper model "${modelSize}" not found. Download it:\n` +
        `  mkdir -p ${MODEL_DIR}\n` +
        `  curl -L -o ${MODEL_DIR}/ggml-${modelSize}.bin \\\n` +
        `    https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${modelSize}.bin`
      );
    }

    const start = Date.now();

    // whisper.cpp outputs to stdout with --output-txt --no-timestamps
    const args = [
      '-m', model,
      '-f', audioPath,
      '--no-timestamps',
      '--print-progress', 'false',
      '-t', process.env.WHISPER_THREADS || '4',
    ];

    if (config.language) {
      args.push('-l', config.language);
    }

    const output = execFileSync(binary, args, {
      encoding: 'utf-8',
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    });

    const text = output
      .split('\n')
      .filter(line => !line.startsWith('[') && line.trim())
      .join(' ')
      .trim();

    return {
      text,
      language: config.language,
      durationMs: Date.now() - start,
    };
  },
};

// ── Helper: check what's installed ───────────────────────────
export function getLocalWhisperStatus(): {
  binaryFound: boolean;
  binaryPath: string | null;
  modelsFound: string[];
  installHint: string;
} {
  const binary = findWhisperBinary();
  const found: string[] = [];
  for (const m of MODELS) {
    if (findModel(m)) found.push(m);
  }

  let installHint = '';
  if (!binary) {
    installHint = process.platform === 'darwin'
      ? 'brew install whisper-cpp'
      : 'See https://github.com/ggerganov/whisper.cpp#quick-start';
  } else if (found.length === 0) {
    installHint = `Download a model:\n  curl -L -o ${MODEL_DIR}/ggml-base.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin`;
  }

  return { binaryFound: !!binary, binaryPath: binary, modelsFound: found, installHint };
}

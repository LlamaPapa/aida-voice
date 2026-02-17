#!/usr/bin/env node
import { Command } from 'commander';
import { createInterface } from 'node:readline';
import { config as loadEnv } from 'dotenv';
import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import type { StructureMode, VoiceConfig } from './types.js';
import { runVoicePipeline, runFromText } from './pipeline.js';
import { checkRecordingDeps, initNativeHelper } from './recorder.js';
import { startServer } from './server.js';
import { getMemory, clearMemory } from './memory.js';
import { loadConfig, updateConfig, getConfigPath, resetConfig } from './config.js';
import { listSpeechProviders, listLLMProviders } from './models.js';
import { getLocalWhisperStatus } from './providers/whisper-local.js';

// Load .env from voice-pipeline directory
loadEnv({ path: resolve(import.meta.dirname || '.', '..', '.env') });

const program = new Command();

program
  .name('voice')
  .description('Voice-to-structured-output pipeline. Talk freely, get organized text.')
  .version('1.0.0');

// Shared options builder
function addProviderOptions(cmd: Command): Command {
  return cmd
    .option('--offline', 'Force offline mode (local models only)')
    .option('--speech <provider>', 'Speech provider: whisper-api, whisper-local')
    .option('--llm <provider>', 'LLM provider: claude, ollama')
    .option('--openai-key <key>', 'OpenAI API key')
    .option('--anthropic-key <key>', 'Anthropic API key');
}

function buildConfig(opts: Record<string, unknown>): VoiceConfig {
  return {
    mode: (opts.mode as StructureMode) || undefined,
    autoPaste: opts.paste as boolean | undefined,
    offlineMode: opts.offline as boolean | undefined,
    speechProvider: opts.speech as string | undefined,
    llmProvider: opts.llm as string | undefined,
    openaiApiKey: opts.openaiKey as string | undefined,
    anthropicApiKey: opts.anthropicKey as string | undefined,
    language: opts.language as string | undefined,
    claudeModel: opts.claudeModel as string | undefined,
  };
}

// ── voice daemon ──────────────────────────────────────────────
const daemonCmd = program
  .command('daemon')
  .alias('d')
  .description('Start server — iPhone web UI + Option+Space hotkey + config sync')
  .option('-p, --port <port>', 'Server port', '7890')
  .option('-m, --mode <mode>', 'Default structuring mode', 'message');
addProviderOptions(daemonCmd)
  .action((opts) => {
    const config = buildConfig(opts);

    // Spawn native AVAudioEngine helper if binary exists
    let helperProc: ChildProcess | null = null;
    const helperPath = resolve(import.meta.dirname || '.', '..', 'native', 'AidaVoiceHelper');

    if (existsSync(helperPath)) {
      console.log('  Starting native audio helper...');
      helperProc = spawn(helperPath, [], {
        stdio: ['ignore', 'inherit', 'inherit'],
      });
      helperProc.on('error', (err) => {
        console.error(`  Helper error: ${err.message}`);
        helperProc = null;
      });
      helperProc.on('exit', (code) => {
        if (code !== 0 && code !== null) {
          console.error(`  Helper exited with code ${code}`);
        }
        helperProc = null;
      });
    }

    // Clean shutdown: kill helper on exit
    const cleanup = () => {
      if (helperProc && !helperProc.killed) {
        helperProc.kill('SIGTERM');
      }
    };
    process.on('SIGINT', () => { cleanup(); process.exit(0); });
    process.on('SIGTERM', () => { cleanup(); process.exit(0); });
    process.on('exit', cleanup);

    // Give helper a moment to start its socket, then start server
    const startDelay = helperProc ? 500 : 0;
    setTimeout(() => {
      startServer({ port: parseInt(opts.port as string, 10), voiceConfig: config });
    }, startDelay);
  });

// ── voice listen ──────────────────────────────────────────────
const listenCmd = program
  .command('listen')
  .alias('l')
  .description('Record from mic → transcribe → structure → clipboard → paste')
  .option('-m, --mode <mode>', 'Output mode: message, notes, email, code, tasks, raw', 'message')
  .option('--no-paste', 'Disable auto-paste')
  .option('--language <lang>', 'Audio language hint');
addProviderOptions(listenCmd)
  .action(async (opts) => {
    const deps = checkRecordingDeps();
    if (!deps.available) {
      console.error(`\n  No audio recording tool found.`);
      console.error(`  Install one: ${deps.installHint}\n`);
      process.exit(1);
    }

    const config = buildConfig(opts);
    const appCfg = loadConfig();
    const isOffline = config.offlineMode || appCfg.offlineMode;

    console.log(`\n  Mode: ${config.mode} | ${isOffline ? 'OFFLINE' : 'CLOUD'} | Memory: ${getMemory().length}/10`);
    console.log(`  Press Enter to stop recording...\n`);

    const controller = new AbortController();
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.on('line', () => { controller.abort(); rl.close(); });
    process.on('SIGINT', () => { controller.abort(); rl.close(); process.exit(0); });

    try {
      const result = await runVoicePipeline(config, {
        onRecordingStart: () => console.log('  Recording... (press Enter to stop)'),
        onRecordingStop: () => console.log('  Stopped'),
        onTranscribing: () => process.stdout.write('  Transcribing...'),
        onTranscribed: (text) => {
          console.log(` done (${text.length} chars)`);
          console.log(`\n  ── Raw ──`);
          console.log(`  ${text}\n`);
        },
        onStructuring: () => process.stdout.write('  Structuring...'),
        onStructured: (text) => {
          console.log(' done');
          console.log(`\n  ── Structured ──`);
          console.log(`  ${text.split('\n').join('\n  ')}\n`);
        },
        onCopied: () => console.log('  Copied to clipboard'),
        onPasted: () => console.log('  Auto-pasted'),
      }, controller.signal);

      console.log(`  Providers: ${result.providers.speech} → ${result.providers.llm}`);
      if (!result.copiedToClipboard) console.log('  Could not copy to clipboard');
      console.log(`  Memory: ${getMemory().length}/10\n`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('No speech detected')) {
        console.log('\n  No speech detected. Try again.\n');
      } else {
        console.error(`\n  Error: ${msg}\n`);
      }
      process.exit(1);
    }
  });

// ── voice type ────────────────────────────────────────────────
const typeCmd = program
  .command('type')
  .alias('t')
  .description('Type or paste text → structure → clipboard → paste')
  .option('-m, --mode <mode>', 'Output mode', 'message')
  .option('--no-paste', 'Disable auto-paste');
addProviderOptions(typeCmd)
  .action(async (opts) => {
    const config = buildConfig(opts);

    console.log(`\n  Mode: ${config.mode}`);
    console.log(`  Paste or type your text, then press Enter twice to process:\n`);

    const lines: string[] = [];
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let emptyCount = 0;

    const text = await new Promise<string>((resolve) => {
      rl.on('line', (line) => {
        if (line.trim() === '') {
          emptyCount++;
          if (emptyCount >= 2) { rl.close(); resolve(lines.join('\n')); return; }
        } else { emptyCount = 0; }
        lines.push(line);
      });
    });

    if (!text.trim()) { console.log('  No text provided.\n'); process.exit(1); }

    try {
      const result = await runFromText(text, config, {
        onStructuring: () => process.stdout.write('  Structuring...'),
        onStructured: (structured) => {
          console.log(' done');
          console.log(`\n  ── Structured ──`);
          console.log(`  ${structured.split('\n').join('\n  ')}\n`);
        },
        onCopied: () => console.log('  Copied to clipboard'),
        onPasted: () => console.log('  Auto-pasted'),
      });
      if (!result.copiedToClipboard) console.log('  Could not copy to clipboard');
    } catch (err: unknown) {
      console.error(`\n  Error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  });

// ── voice pipe ────────────────────────────────────────────────
const pipeCmd = program
  .command('pipe')
  .alias('p')
  .description('Read stdin → structure → clipboard → paste')
  .option('-m, --mode <mode>', 'Output mode', 'message')
  .option('--no-paste', 'Disable auto-paste')
  .option('-q, --quiet', 'Only output structured text');
addProviderOptions(pipeCmd)
  .action(async (opts) => {
    const config = buildConfig(opts);
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf-8').trim();

    if (!text) { if (!opts.quiet) console.error('No input on stdin'); process.exit(1); }

    try {
      const result = await runFromText(text, config, {
        onStructured: (s) => { if (opts.quiet) process.stdout.write(s); else console.log(s); },
        onCopied: () => { if (!opts.quiet) console.error('  Copied to clipboard'); },
        onPasted: () => { if (!opts.quiet) console.error('  Auto-pasted'); },
      });
      if (!result.copiedToClipboard && !opts.quiet) console.error('  Could not copy to clipboard');
    } catch (err: unknown) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

// ── voice loop ────────────────────────────────────────────────
const loopCmd = program
  .command('loop')
  .description('Continuous listen mode. Press Enter after each recording, Ctrl+C to exit.')
  .option('-m, --mode <mode>', 'Output mode', 'message')
  .option('--no-paste', 'Disable auto-paste')
  .option('--language <lang>', 'Audio language hint');
addProviderOptions(loopCmd)
  .action(async (opts) => {
    const deps = checkRecordingDeps();
    if (!deps.available) {
      console.error(`\n  No audio recording tool found.\n  Install: ${deps.installHint}\n`);
      process.exit(1);
    }

    const config = buildConfig(opts);
    console.log(`\n  Voice Loop — Mode: ${config.mode}`);
    console.log(`  Press Enter after each recording. Ctrl+C to exit.\n`);

    let running = true;
    process.on('SIGINT', () => { running = false; console.log('\n  Bye!\n'); process.exit(0); });

    let count = 0;
    while (running) {
      count++;
      const controller = new AbortController();
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      rl.on('line', () => { controller.abort(); rl.close(); });

      try {
        console.log(`  ── #${count} (memory: ${getMemory().length}/10) ──`);
        const result = await runVoicePipeline(config, {
          onRecordingStart: () => console.log('  Recording... (Enter to stop)'),
          onRecordingStop: () => console.log('  Stopped'),
          onTranscribing: () => process.stdout.write('  Transcribing...'),
          onTranscribed: (text) => console.log(` "${text.slice(0, 80)}${text.length > 80 ? '...' : ''}"`),
          onStructuring: () => process.stdout.write('  Structuring...'),
          onStructured: () => console.log(' done'),
          onCopied: () => console.log('  Clipboard ready'),
          onPasted: () => console.log('  Pasted'),
        }, controller.signal);
        console.log(`  [${result.providers.speech} → ${result.providers.llm}]`);
      } catch { console.log('  (skipped)'); }
      console.log('');
    }
  });

// ── voice config ──────────────────────────────────────────────
const configCmd = program
  .command('config')
  .description('View or update configuration');

configCmd
  .command('show')
  .description('Show current configuration')
  .action(() => {
    const cfg = loadConfig();
    console.log(`\n  Config: ${getConfigPath()}\n`);
    console.log(`  Mode:            ${cfg.defaultMode}`);
    console.log(`  Speech Provider: ${cfg.speechProvider}`);
    console.log(`  LLM Provider:    ${cfg.llmProvider}`);
    console.log(`  LLM Model:       ${cfg.llmModel}`);
    console.log(`  Whisper Model:   ${cfg.whisperModel}`);
    console.log(`  Ollama Model:    ${cfg.ollamaModel}`);
    console.log(`  Language:        ${cfg.language}`);
    console.log(`  Auto-paste:      ${cfg.autoPaste}`);
    console.log(`  Offline Mode:    ${cfg.offlineMode}`);
    console.log(`  Port:            ${cfg.port}`);
    console.log(`  Hotkey:          ${cfg.hotkey}`);

    if (Object.keys(cfg.modes).length > 0) {
      console.log(`\n  Per-mode overrides:`);
      for (const [mode, override] of Object.entries(cfg.modes)) {
        console.log(`    ${mode}: ${JSON.stringify(override)}`);
      }
    }
    console.log('');
  });

configCmd
  .command('set <key> <value>')
  .description('Set a config value (e.g. voice config set speechProvider whisper-local)')
  .action((key, value) => {
    // Parse booleans
    let parsed: unknown = value;
    if (value === 'true') parsed = true;
    else if (value === 'false') parsed = false;
    else if (!isNaN(Number(value))) parsed = Number(value);

    const updated = updateConfig({ [key]: parsed });
    console.log(`  ${key} = ${JSON.stringify((updated as unknown as Record<string, unknown>)[key])}\n`);
  });

configCmd
  .command('reset')
  .description('Reset config to defaults')
  .action(() => {
    resetConfig();
    console.log('  Config reset to defaults.\n');
  });

// ── voice providers ───────────────────────────────────────────
program
  .command('providers')
  .description('List available speech and LLM providers')
  .action(async () => {
    console.log('\n  Speech Providers:');
    for (const p of listSpeechProviders()) {
      const ok = await p.available();
      console.log(`    ${ok ? '+' : '-'} ${p.name} (${p.type}) ${ok ? '' : '— not configured'}`);
    }

    console.log('\n  LLM Providers:');
    for (const p of listLLMProviders()) {
      const ok = await p.available();
      console.log(`    ${ok ? '+' : '-'} ${p.name} (${p.type}) ${ok ? '' : '— not configured'}`);
    }

    const whisper = getLocalWhisperStatus();
    if (whisper.binaryFound) {
      console.log(`\n  Local Whisper: ${whisper.binaryPath}`);
      console.log(`  Models found: ${whisper.modelsFound.length > 0 ? whisper.modelsFound.join(', ') : 'none'}`);
    }
    if (whisper.installHint) {
      console.log(`  Setup: ${whisper.installHint}`);
    }
    console.log('');
  });

// ── voice clear ───────────────────────────────────────────────
program
  .command('clear')
  .description('Clear the rolling memory')
  .action(() => {
    clearMemory();
    console.log('  Memory cleared.\n');
  });

program.parse();

import { spawn, execSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection, type Socket } from 'node:net';
import type { RecordingResult } from './types.js';

const TEMP_DIR = join(tmpdir(), 'voice-pipeline');
const SOCKET_PATH = join(tmpdir(), 'aida-voice-helper.sock');

function ensureTempDir(): void {
  if (!existsSync(TEMP_DIR)) {
    mkdirSync(TEMP_DIR, { recursive: true });
  }
}

// ── Native helper state ──────────────────────────────────────
let helperAvailable = false;
let helperSocket: Socket | null = null;

/**
 * Probe the native AVAudioEngine helper over Unix socket.
 * Call at startup — sets helperAvailable flag.
 */
export async function initNativeHelper(): Promise<boolean> {
  // Retry a few times — helper may still be starting its socket
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const res = await helperCommand('ping', 2000);
      if (res && res.status === 'ok') {
        helperAvailable = true;
        return true;
      }
    } catch {
      // Helper not ready yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  helperAvailable = false;
  return false;
}

export function isNativeHelperAvailable(): boolean {
  return helperAvailable;
}

function helperCommand(cmd: string, timeoutMs = 5000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const sock = createConnection(SOCKET_PATH);
    let data = '';
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('Helper command timed out'));
    }, timeoutMs);

    sock.on('connect', () => {
      sock.write(JSON.stringify({ cmd }) + '\n');
    });

    sock.on('data', (chunk) => {
      data += chunk.toString();
      const newlineIdx = data.indexOf('\n');
      if (newlineIdx !== -1) {
        clearTimeout(timer);
        const line = data.slice(0, newlineIdx);
        sock.destroy();
        try {
          resolve(JSON.parse(line));
        } catch {
          reject(new Error('Invalid JSON from helper'));
        }
      }
    });

    sock.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ── Native recording ─────────────────────────────────────────
function startRecordNative(): ActiveRecording {
  // Send start immediately — mic is already warm, ~5ms latency
  const startPromise = helperCommand('start');

  let stopped = false;

  const result = new Promise<RecordingResult>((resolve, reject) => {
    startPromise.then((startRes) => {
      if (startRes.status !== 'recording') {
        reject(new Error(`Helper start failed: ${JSON.stringify(startRes)}`));
      }
      // Recording is now active in the helper — resolve happens on stop()
    }).catch(reject);
  });

  // The actual result promise needs to wait for stop
  let resolveResult: (r: RecordingResult) => void;
  let rejectResult: (e: Error) => void;
  const resultPromise = new Promise<RecordingResult>((res, rej) => {
    resolveResult = res;
    rejectResult = rej;
  });

  // Chain: wait for start to succeed first
  startPromise.catch((err) => rejectResult!(err));

  const stop = () => {
    if (stopped) return;
    stopped = true;
    helperCommand('stop', 10000)
      .then((res) => {
        if (res.status === 'stopped' && typeof res.path === 'string') {
          const filePath = res.path as string;
          // Compute approximate duration from file size
          // WAV header is 44 bytes, then PCM data at 16kHz * 2 bytes * 1 channel
          try {
            const stat = statSync(filePath);
            const pcmBytes = stat.size - 44;
            const durationMs = Math.round((pcmBytes / (16000 * 2)) * 1000);
            resolveResult!({ filePath, durationMs });
          } catch {
            resolveResult!({ filePath, durationMs: 0 });
          }
        } else {
          rejectResult!(new Error(`Helper stop failed: ${JSON.stringify(res)}`));
        }
      })
      .catch((err) => rejectResult!(err));
  };

  return { result: resultPromise, stop };
}

// ── Sox/tool detection (fallback) ────────────────────────────
let cachedTool: 'sox' | 'arecord' | 'ffmpeg' | null | undefined = undefined;

function detectRecordingTool(): 'sox' | 'arecord' | 'ffmpeg' | null {
  if (cachedTool !== undefined) return cachedTool;
  const tools = ['sox', 'arecord', 'ffmpeg'];
  for (const tool of tools) {
    try {
      execSync(`which ${tool}`, { stdio: 'ignore' });
      cachedTool = tool as 'sox' | 'arecord' | 'ffmpeg';
      return cachedTool;
    } catch {
      continue;
    }
  }
  cachedTool = null;
  return null;
}

export function checkRecordingDeps(): { available: boolean; tool: string | null; installHint: string } {
  // Native helper counts as available
  if (helperAvailable) {
    return { available: true, tool: 'native', installHint: '' };
  }
  const tool = detectRecordingTool();
  if (tool) {
    return { available: true, tool, installHint: '' };
  }
  const platform = process.platform;
  let installHint: string;
  if (platform === 'darwin') {
    installHint = 'brew install sox';
  } else if (platform === 'linux') {
    installHint = 'sudo apt install sox alsa-utils';
  } else {
    installHint = 'Install sox: https://sox.sourceforge.net/';
  }
  return { available: false, tool: null, installHint };
}

export interface ActiveRecording {
  /** Resolves when the recording process exits and the file is ready */
  result: Promise<RecordingResult>;
  /** Call to stop the recording */
  stop: () => void;
}

/**
 * Starts recording immediately and returns once the process is spawned.
 * Uses native AVAudioEngine helper if available, falls back to sox/arecord/ffmpeg.
 * Call stop() to end recording. Await result for the file.
 */
export function startRecord(): ActiveRecording {
  // Try native helper first (instant start, ~5ms)
  if (helperAvailable) {
    try {
      return startRecordNative();
    } catch {
      // Native failed — mark unavailable, fall through to sox
      helperAvailable = false;
    }
  }

  return startRecordSox();
}

function startRecordSox(): ActiveRecording {
  ensureTempDir();
  const filePath = join(TEMP_DIR, `recording-${Date.now()}.wav`);
  const tool = detectRecordingTool();

  if (!tool) {
    throw new Error('No recording tool found. Install sox: brew install sox (mac) / sudo apt install sox (linux)');
  }

  const startTime = Date.now();
  let proc: ReturnType<typeof spawn>;

  if (tool === 'sox') {
    proc = spawn('rec', [
      '-r', '16000',
      '-c', '1',
      '-b', '16',
      filePath,
    ], { stdio: ['ignore', 'ignore', 'ignore'] });
  } else if (tool === 'arecord') {
    proc = spawn('arecord', [
      '-f', 'S16_LE',
      '-r', '16000',
      '-c', '1',
      filePath,
    ], { stdio: ['ignore', 'ignore', 'ignore'] });
  } else {
    const inputDevice = process.platform === 'darwin' ? 'avfoundation' : 'pulse';
    const inputSource = process.platform === 'darwin' ? ':0' : 'default';
    proc = spawn('ffmpeg', [
      '-f', inputDevice,
      '-i', inputSource,
      '-ar', '16000',
      '-ac', '1',
      '-y',
      filePath,
    ], { stdio: ['ignore', 'ignore', 'ignore'] });
  }

  const result = new Promise<RecordingResult>((resolve, reject) => {
    proc.on('close', () => {
      const durationMs = Date.now() - startTime;
      if (existsSync(filePath)) {
        resolve({ filePath, durationMs });
      } else {
        reject(new Error('Recording failed — no audio file produced'));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Recording process error: ${err.message}`));
    });
  });

  const stop = () => {
    proc.kill('SIGINT');
  };

  return { result, stop };
}

export async function record(signal: AbortSignal): Promise<RecordingResult> {
  const active = startRecord();
  const onAbort = () => active.stop();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await active.result;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

export async function recordForDuration(durationSec: number): Promise<RecordingResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), durationSec * 1000);
  try {
    return await record(controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

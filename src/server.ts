import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createWriteStream, unlinkSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { networkInterfaces } from 'node:os';
import type { VoiceConfig } from './types.js';
import { transcribe } from './transcriber.js';
import { structure } from './structurer.js';
import { copyToClipboard, autoPaste } from './clipboard.js';
import { getMemory, clearMemory } from './memory.js';
import { record, startRecord, type ActiveRecording, initNativeHelper, isNativeHelperAvailable } from './recorder.js';
import { loadConfig, updateConfig, type AppConfig } from './config.js';
import { listSpeechProviders, listLLMProviders } from './models.js';

const TEMP_DIR = join(tmpdir(), 'voice-pipeline');

function ensureTempDir(): void {
  if (!existsSync(TEMP_DIR)) mkdirSync(TEMP_DIR, { recursive: true });
}

function getLocalIP(): string {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}

function cors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function json(res: ServerResponse, data: unknown, status = 200): void {
  cors(res);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

// ── State for daemon toggle ──────────────────────────────────
let recording = false;
let activeRecording: ActiveRecording | null = null;
let processingStep: string | null = null;  // null = idle, or 'transcribing' | 'structuring' | 'copying'

const WEB_UI = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<title>Voice</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro', system-ui, sans-serif;
    background: #0a0a0a; color: #e0e0e0;
    height: 100dvh; display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    -webkit-user-select: none; user-select: none;
    overflow: hidden;
  }
  #provider-bar {
    position: fixed; top: 0; left: 0; right: 0;
    display: flex; justify-content: space-between; align-items: center;
    padding: 12px 16px; font-size: 11px; color: #555;
    background: rgba(10,10,10,0.9); backdrop-filter: blur(8px);
    z-index: 10;
  }
  #provider-bar .offline { color: #22c55e; }
  #provider-bar .cloud { color: #3b82f6; }
  #settings-btn {
    padding: 4px 10px; border-radius: 12px; border: 1px solid #333;
    background: #1a1a1a; color: #888; font-size: 11px; cursor: pointer;
  }
  #status { font-size: 14px; color: #888; margin-bottom: 24px; height: 20px; }
  #btn {
    width: 120px; height: 120px; border-radius: 50%;
    border: 3px solid #333; background: #1a1a1a;
    display: flex; align-items: center; justify-content: center;
    cursor: pointer; transition: all 0.15s ease;
    -webkit-tap-highlight-color: transparent;
  }
  #btn:active, #btn.recording { background: #dc2626; border-color: #ef4444; transform: scale(1.05); }
  #btn.recording { }
  #btn.processing { background: #1e40af; border-color: #3b82f6; pointer-events: none; }
  #btn svg { width: 48px; height: 48px; fill: #e0e0e0; }
  #btn-wrap { position: relative; display: flex; align-items: center; justify-content: center; }
  #waveform {
    position: absolute; width: 320px; height: 120px;
    pointer-events: none; opacity: 0; transition: opacity 0.2s;
  }
  #waveform.active { opacity: 1; }
  #mode-row { margin-top: 32px; display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; padding: 0 16px; }
  .mode-btn {
    padding: 6px 14px; border-radius: 20px; border: 1px solid #333;
    background: #1a1a1a; color: #aaa; font-size: 13px; cursor: pointer;
    transition: all 0.15s;
  }
  .mode-btn.active { border-color: #3b82f6; color: #fff; background: #1e3a5f; }
  #output {
    margin-top: 24px; padding: 16px; max-width: 90vw; width: 400px;
    max-height: 30vh; overflow-y: auto;
    background: #111; border: 1px solid #222; border-radius: 12px;
    font-size: 14px; line-height: 1.5; white-space: pre-wrap;
    display: none;
  }
  #output.show { display: block; }
  #copy-toast {
    position: fixed; bottom: 40px;
    background: #22c55e; color: #000; padding: 8px 20px;
    border-radius: 20px; font-size: 13px; font-weight: 600;
    opacity: 0; transition: opacity 0.3s; z-index: 20;
  }
  #copy-toast.show { opacity: 1; }
  #perf { position: fixed; bottom: 12px; font-size: 11px; color: #333; }

  /* Settings panel */
  #settings-panel {
    display: none; position: fixed; inset: 0; z-index: 100;
    background: rgba(0,0,0,0.85); backdrop-filter: blur(12px);
    padding: 60px 20px 20px; overflow-y: auto;
  }
  #settings-panel.show { display: block; }
  #settings-panel h2 { font-size: 18px; margin-bottom: 20px; font-weight: 500; }
  .setting-group { margin-bottom: 20px; }
  .setting-group label { display: block; font-size: 12px; color: #888; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px; }
  .setting-group select, .setting-group input {
    width: 100%; max-width: 360px; padding: 10px 12px;
    background: #1a1a1a; border: 1px solid #333; border-radius: 8px;
    color: #e0e0e0; font-size: 14px;
  }
  .toggle-row {
    display: flex; align-items: center; gap: 12px; margin-bottom: 16px;
  }
  .toggle {
    width: 44px; height: 24px; border-radius: 12px;
    background: #333; position: relative; cursor: pointer; transition: background 0.2s;
  }
  .toggle.on { background: #22c55e; }
  .toggle::after {
    content: ''; position: absolute; top: 2px; left: 2px;
    width: 20px; height: 20px; border-radius: 50%;
    background: #fff; transition: transform 0.2s;
  }
  .toggle.on::after { transform: translateX(20px); }
  .key-toggle {
    position: absolute; right: 8px; top: 50%; transform: translateY(-50%);
    font-size: 11px; color: #555; cursor: pointer; padding: 4px 8px;
    border-radius: 4px; background: #222;
  }
  .key-toggle:hover { color: #aaa; }
  #close-settings {
    position: absolute; top: 16px; right: 16px;
    padding: 8px 16px; border-radius: 8px; border: 1px solid #333;
    background: #1a1a1a; color: #e0e0e0; cursor: pointer; font-size: 14px;
  }
</style>
</head>
<body>
  <div id="provider-bar">
    <span id="provider-label">Loading...</span>
    <div id="settings-btn" onclick="openSettings()">Settings</div>
  </div>
  <div id="status">Tap to talk</div>
  <div id="btn-wrap">
    <canvas id="waveform" width="320" height="120"></canvas>
    <div id="btn" ontouchstart="" onclick="toggle()">
      <svg viewBox="0 0 24 24"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.91-3c-.49 0-.9.36-.98.85C16.52 14.2 14.47 16 12 16s-4.52-1.8-4.93-4.15c-.08-.49-.49-.85-.98-.85-.61 0-1.09.54-1 1.14.49 3 2.89 5.35 5.91 5.78V20c0 .55.45 1 1 1s1-.45 1-1v-2.08c3.02-.43 5.42-2.78 5.91-5.78.1-.6-.39-1.14-1-1.14z"/></svg>
    </div>
  </div>
  <div id="mode-row"></div>
  <div id="output"></div>
  <div id="copy-toast">Copied!</div>
  <div id="perf"></div>

  <!-- Settings Panel -->
  <div id="settings-panel">
    <button id="close-settings" onclick="closeSettings()">Done</button>
    <h2>Settings</h2>

    <div class="setting-group">
      <label>OpenAI API Key</label>
      <div style="position:relative">
        <input id="openai-key" type="password" placeholder="sk-..."
          autocomplete="off" spellcheck="false"
          oninput="debounceSave('openaiApiKey', this.value)">
        <span class="key-toggle" onclick="toggleKeyVis('openai-key', this)">show</span>
      </div>
    </div>

    <div class="setting-group">
      <label>Anthropic API Key</label>
      <div style="position:relative">
        <input id="anthropic-key" type="password" placeholder="sk-ant-..."
          autocomplete="off" spellcheck="false"
          oninput="debounceSave('anthropicApiKey', this.value)">
        <span class="key-toggle" onclick="toggleKeyVis('anthropic-key', this)">show</span>
      </div>
    </div>

    <div id="key-status" style="font-size:12px;margin-bottom:20px;color:#555"></div>

    <div class="toggle-row">
      <div class="toggle" id="offline-toggle" onclick="toggleOffline()"></div>
      <span>Offline Mode (local models only)</span>
    </div>

    <div class="setting-group">
      <label>Speech Provider</label>
      <select id="speech-select" onchange="saveSetting('speechProvider', this.value)"></select>
    </div>

    <div class="setting-group">
      <label>LLM Provider</label>
      <select id="llm-select" onchange="saveSetting('llmProvider', this.value)"></select>
    </div>

    <div class="setting-group">
      <label>Whisper Model</label>
      <input id="whisper-model" placeholder="whisper-1 (cloud) or base/small/medium (local)"
        onchange="saveSetting('whisperModel', this.value)">
    </div>

    <div class="setting-group">
      <label>LLM Model</label>
      <input id="llm-model" placeholder="claude-haiku-4-5-20251001 or llama3.2"
        onchange="saveSetting('llmModel', this.value)">
    </div>

    <div class="setting-group">
      <label>Ollama Model</label>
      <input id="ollama-model" placeholder="llama3.2"
        onchange="saveSetting('ollamaModel', this.value)">
    </div>

    <div class="setting-group">
      <label>Language</label>
      <input id="language" placeholder="en" maxlength="5"
        onchange="saveSetting('language', this.value)">
    </div>

    <div class="toggle-row">
      <div class="toggle" id="paste-toggle" onclick="togglePaste()"></div>
      <span>Auto-paste after copy</span>
    </div>
  </div>

<script>
const modes = ['message','notes','email','code','tasks','raw'];
let mode = 'message';
let appConfig = {};
let isRecording = false;
let mediaRecorder = null;
let chunks = [];

const btn = document.getElementById('btn');
const status = document.getElementById('status');
const output = document.getElementById('output');
const toast = document.getElementById('copy-toast');
const perf = document.getElementById('perf');
const provLabel = document.getElementById('provider-label');
const modeRow = document.getElementById('mode-row');
const waveCanvas = document.getElementById('waveform');
const waveCtx = waveCanvas.getContext('2d');
let audioCtx = null;
let analyser = null;
let animFrameId = null;
let vizStream = null; // mic stream opened only for waveform (hotkey recording)
let pollTimer = null;
let wasServerRecording = false;

modes.forEach(m => {
  const b = document.createElement('div');
  b.className = 'mode-btn' + (m === mode ? ' active' : '');
  b.textContent = m;
  b.onclick = () => { mode = m; document.querySelectorAll('.mode-btn').forEach(x => x.classList.toggle('active', x.textContent === m)); };
  modeRow.appendChild(b);
});

// Load config on start
loadAppConfig();

async function loadAppConfig() {
  try {
    const res = await fetch('/api/config');
    appConfig = await res.json();
    mode = appConfig.defaultMode || 'message';
    document.querySelectorAll('.mode-btn').forEach(x => x.classList.toggle('active', x.textContent === mode));
    updateProviderBar();
    populateSettings();
    // Auto-open settings on first run if no API keys configured
    const hasOpenai = !!(appConfig.openaiApiKey || appConfig._envOpenai);
    const hasAnthropic = !!(appConfig.anthropicApiKey || appConfig._envAnthropic);
    if (!hasOpenai && !hasAnthropic) {
      openSettings();
    }
  } catch {}
}

function updateProviderBar() {
  const offline = appConfig.offlineMode;
  const speech = appConfig.speechProvider || 'whisper-api';
  const llm = appConfig.llmProvider || 'claude';
  const cls = offline ? 'offline' : 'cloud';
  provLabel.innerHTML = '<span class="' + cls + '">' + (offline ? 'OFFLINE' : 'CLOUD') + '</span>'
    + ' &middot; speech: ' + speech + ' &middot; llm: ' + llm
    + ' &middot; mem: ' + (appConfig._memorySize || 0) + '/10';
}

function populateSettings() {
  // Offline toggle
  const ot = document.getElementById('offline-toggle');
  ot.classList.toggle('on', !!appConfig.offlineMode);

  // Paste toggle
  const pt = document.getElementById('paste-toggle');
  pt.classList.toggle('on', appConfig.autoPaste !== false);

  // Selects
  const ss = document.getElementById('speech-select');
  const ls = document.getElementById('llm-select');
  ss.innerHTML = '<option value="whisper-api">whisper-api (cloud)</option><option value="whisper-local">whisper-local (offline)</option>';
  ls.innerHTML = '<option value="claude">claude (cloud)</option><option value="ollama">ollama (local)</option>';
  ss.value = appConfig.speechProvider || 'whisper-api';
  ls.value = appConfig.llmProvider || 'claude';

  // Inputs
  document.getElementById('whisper-model').value = appConfig.whisperModel || '';
  document.getElementById('llm-model').value = appConfig.llmModel || '';
  document.getElementById('ollama-model').value = appConfig.ollamaModel || '';
  document.getElementById('language').value = appConfig.language || '';

  // API keys — show masked placeholder if set, empty if not
  document.getElementById('openai-key').value = appConfig.openaiApiKey || '';
  document.getElementById('anthropic-key').value = appConfig.anthropicApiKey || '';
  updateKeyStatus();
}

function updateKeyStatus() {
  const ks = document.getElementById('key-status');
  const hasOpenai = !!(appConfig.openaiApiKey || appConfig._envOpenai);
  const hasAnthropic = !!(appConfig.anthropicApiKey || appConfig._envAnthropic);
  const parts = [];
  parts.push(hasOpenai ? 'OpenAI: set' : 'OpenAI: missing');
  parts.push(hasAnthropic ? 'Anthropic: set' : 'Anthropic: missing');
  ks.innerHTML = parts.map(p => '<span style="color:' + (p.includes('set') ? '#22c55e' : '#ef4444') + '">' + p + '</span>').join(' &middot; ');
}

function toggleKeyVis(inputId, el) {
  const inp = document.getElementById(inputId);
  if (inp.type === 'password') { inp.type = 'text'; el.textContent = 'hide'; }
  else { inp.type = 'password'; el.textContent = 'show'; }
}

const _debounceTimers = {};
function debounceSave(key, value) {
  clearTimeout(_debounceTimers[key]);
  _debounceTimers[key] = setTimeout(() => saveSetting(key, value), 400);
}

async function saveSetting(key, value) {
  const body = {}; body[key] = value;
  try {
    const res = await fetch('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    appConfig = await res.json();
    updateProviderBar();
    updateKeyStatus();
  } catch {}
}

function toggleOffline() {
  const ot = document.getElementById('offline-toggle');
  const newVal = !ot.classList.contains('on');
  ot.classList.toggle('on', newVal);
  saveSetting('offlineMode', newVal);
  if (newVal) {
    saveSetting('speechProvider', 'whisper-local');
    saveSetting('llmProvider', 'ollama');
    document.getElementById('speech-select').value = 'whisper-local';
    document.getElementById('llm-select').value = 'ollama';
  }
}

function togglePaste() {
  const pt = document.getElementById('paste-toggle');
  const newVal = !pt.classList.contains('on');
  pt.classList.toggle('on', newVal);
  saveSetting('autoPaste', newVal);
}

function openSettings() { document.getElementById('settings-panel').classList.add('show'); }
function closeSettings() {
  // Flush any pending debounced saves immediately
  for (const key of Object.keys(_debounceTimers)) {
    clearTimeout(_debounceTimers[key]);
    delete _debounceTimers[key];
  }
  // Save current key values directly
  const oKey = document.getElementById('openai-key').value;
  const aKey = document.getElementById('anthropic-key').value;
  if (oKey && oKey !== appConfig.openaiApiKey) saveSetting('openaiApiKey', oKey);
  if (aKey && aKey !== appConfig.anthropicApiKey) saveSetting('anthropicApiKey', aKey);
  document.getElementById('settings-panel').classList.remove('show');
}

async function toggle() {
  if (isRecording) { stopRecording(); } else { await startRecording(); }
}

async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '';
    mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    chunks = [];
    mediaRecorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
    mediaRecorder.onstop = () => { stream.getTracks().forEach(t => t.stop()); stopWaveform(); processAudio(); };
    mediaRecorder.start(100);
    isRecording = true;
    btn.classList.add('recording');
    status.textContent = 'Listening...';
    startWaveform(stream);
  } catch(e) { status.textContent = 'Mic access denied'; }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  isRecording = false;
  btn.classList.remove('recording');
  btn.classList.add('processing');
  status.textContent = 'Processing...';
}

function startWaveform(stream) {
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const source = audioCtx.createMediaStreamSource(stream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);
  waveCanvas.classList.add('active');
  drawWaveform();
}

function drawWaveform() {
  animFrameId = requestAnimationFrame(drawWaveform);
  const bufLen = analyser.frequencyBinCount;
  const data = new Uint8Array(bufLen);
  analyser.getByteTimeDomainData(data);

  const W = waveCanvas.width;
  const H = waveCanvas.height;
  const cx = W / 2;
  const cy = H / 2;
  waveCtx.clearRect(0, 0, W, H);

  // Draw waveform bars radiating out from center (behind the button)
  const barCount = 48;
  const innerR = 68;
  const maxBarH = 40;

  // Downsample analyser data to barCount bins
  const step = Math.floor(bufLen / barCount);
  for (let i = 0; i < barCount; i++) {
    // Average a few samples for this bar
    let sum = 0;
    for (let j = 0; j < step; j++) {
      const v = (data[i * step + j] - 128) / 128;
      sum += Math.abs(v);
    }
    const amp = sum / step;
    const barH = Math.max(2, amp * maxBarH * 3);

    const angle = (i / barCount) * Math.PI * 2 - Math.PI / 2;
    const x1 = cx + Math.cos(angle) * innerR;
    const y1 = cy + Math.sin(angle) * innerR;
    const x2 = cx + Math.cos(angle) * (innerR + barH);
    const y2 = cy + Math.sin(angle) * (innerR + barH);

    waveCtx.beginPath();
    waveCtx.moveTo(x1, y1);
    waveCtx.lineTo(x2, y2);
    waveCtx.strokeStyle = 'rgba(239,68,68,' + (0.4 + amp * 2) + ')';
    waveCtx.lineWidth = 3;
    waveCtx.lineCap = 'round';
    waveCtx.stroke();
  }
}

function stopWaveform() {
  if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = null; }
  waveCanvas.classList.remove('active');
  waveCtx.clearRect(0, 0, waveCanvas.width, waveCanvas.height);
  if (audioCtx) { audioCtx.close(); audioCtx = null; }
  if (vizStream) { vizStream.getTracks().forEach(t => t.stop()); vizStream = null; }
}

// ── Poll server for hotkey recording state ──────────────────
async function pollServerRecording() {
  try {
    const res = await fetch('/api/health');
    const data = await res.json();
    if (data.recording && !wasServerRecording && !isRecording) {
      // Server started recording via hotkey — show waveform
      wasServerRecording = true;
      btn.classList.add('recording');
      status.textContent = 'Listening...';
      try {
        vizStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        startWaveform(vizStream);
      } catch(e) { /* mic denied — waveform won't show but recording still works server-side */ }
    } else if (!data.recording && wasServerRecording) {
      // Server stopped recording
      wasServerRecording = false;
      stopWaveform();
      btn.classList.remove('recording');
      btn.classList.add('processing');
      status.textContent = 'Processing...';
      // Poll until processing is done (health shows not recording and we can reset)
      setTimeout(() => {
        btn.classList.remove('processing');
        status.textContent = 'Tap to talk';
      }, 1000);
    }
  } catch(e) { /* server down */ }
}

// Start polling every 200ms
pollTimer = setInterval(pollServerRecording, 200);

async function processAudio() {
  const t0 = performance.now();
  try {
    const blob = new Blob(chunks, { type: mediaRecorder.mimeType || 'audio/webm' });
    const form = new FormData();
    form.append('audio', blob, 'recording.' + (blob.type.includes('mp4') ? 'm4a' : 'webm'));
    form.append('mode', mode);

    const res = await fetch('/api/process', { method: 'POST', body: form });
    const data = await res.json();

    const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
    perf.textContent = elapsed + 's · ' + (data.speechProvider || '?') + ' → ' + (data.llmProvider || '?');

    if (data.error) { status.textContent = data.error; btn.classList.remove('processing'); return; }

    output.textContent = data.structured;
    output.classList.add('show');
    try { await navigator.clipboard.writeText(data.structured); showToast(); } catch {}

    status.textContent = 'Tap to talk';
    appConfig._memorySize = data.memorySize;
    updateProviderBar();
  } catch(e) { status.textContent = 'Error: ' + e.message; }
  btn.classList.remove('processing');
}

function showToast() {
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 1500);
}

// Keyboard: Option+Space
document.addEventListener('keydown', e => {
  if (e.altKey && e.code === 'Space') { e.preventDefault(); toggle(); }
});
</script>
</body>
</html>`;

export interface ServerConfig {
  port?: number;
  voiceConfig: VoiceConfig;
  onLog?: (msg: string) => void;
}

export function startServer(serverConfig: ServerConfig): void {
  const port = serverConfig.port || 7890;
  const config = serverConfig.voiceConfig;
  const log = serverConfig.onLog || console.log;

  // Merge API keys from persistent config into the runtime VoiceConfig
  function withKeys(vc: VoiceConfig): VoiceConfig {
    const cfg = loadConfig();
    return {
      ...vc,
      openaiApiKey: vc.openaiApiKey || cfg.openaiApiKey,
      anthropicApiKey: vc.anthropicApiKey || cfg.anthropicApiKey,
    };
  }

  ensureTempDir();

  // Probe native AVAudioEngine helper
  initNativeHelper().then((native) => {
    if (native) {
      log('Audio backend: native AVAudioEngine helper (instant start)');
    } else {
      log('Audio backend: sox (fallback)');
    }
  });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);

    if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); res.end(); return; }

    // ── Web UI ──
    if (url.pathname === '/' && req.method === 'GET') {
      cors(res);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(WEB_UI);
      return;
    }

    // ── Process audio from browser ──
    if (url.pathname === '/api/process' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const boundary = getBoundary(req.headers['content-type'] || '');
        if (!boundary) { json(res, { error: 'Invalid multipart request' }, 400); return; }

        const parts = parseMultipart(body, boundary);
        const audioPart = parts.find(p => p.name === 'audio');
        const modePart = parts.find(p => p.name === 'mode');
        if (!audioPart) { json(res, { error: 'No audio data' }, 400); return; }

        const reqMode = modePart?.data.toString('utf-8') || config.mode || 'message';
        const ext = audioPart.filename?.split('.').pop() || 'webm';
        const tmpFile = join(TEMP_DIR, `upload-${Date.now()}.${ext}`);

        const ws = createWriteStream(tmpFile);
        ws.write(audioPart.data);
        ws.end();
        await new Promise<void>((r) => ws.on('finish', r));

        const effectiveConfig = withKeys(config);
        const transcription = await transcribe(tmpFile, effectiveConfig);
        try { unlinkSync(tmpFile); } catch {}

        if (!transcription.text.trim()) { json(res, { error: 'No speech detected' }); return; }

        const structured = await structure(transcription.text, { ...effectiveConfig, mode: reqMode as VoiceConfig['mode'] });
        await copyToClipboard(structured.structured);

        json(res, {
          raw: transcription.text,
          structured: structured.structured,
          mode: reqMode,
          memorySize: getMemory().length,
          speechProvider: transcription.providerName,
          llmProvider: structured.providerName,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`Process error: ${msg}`);
        json(res, { error: msg }, 500);
      }
      return;
    }

    // ── Toggle recording (for Option+Space hotkey) ──
    if (url.pathname === '/api/toggle' && req.method === 'POST') {
      if (recording) {
        // STOP: signal sox to flush and exit
        activeRecording?.stop();
        recording = false;
        json(res, { status: 'stopped' });
      } else {
        // START: spawn sox immediately, then respond
        try {
          activeRecording = startRecord();
          recording = true;
          json(res, { status: 'recording' });

          (async () => {
            try {
              const effectiveConfig = withKeys(config);
              const rec = await activeRecording!.result;
              recording = false;

              processingStep = 'transcribing';
              log('Transcribing...');
              const transcription = await transcribe(rec.filePath, effectiveConfig);
              try { unlinkSync(rec.filePath); } catch {}

              if (!transcription.text.trim()) { log('No speech detected'); processingStep = null; return; }

              processingStep = 'structuring';
              log('Structuring...');
              const structured = await structure(transcription.text, effectiveConfig);

              processingStep = 'copying';
              await copyToClipboard(structured.structured);
              log(`Done [${transcription.providerName} → ${structured.providerName}] → "${structured.structured.slice(0, 60)}..."`);

              if (effectiveConfig.autoPaste !== false) {
                await new Promise((r) => setTimeout(r, 150));
                await autoPaste();
              }
              processingStep = null;
            } catch (err) {
              recording = false;
              processingStep = null;
              log(`Toggle error: ${err instanceof Error ? err.message : String(err)}`);
            }
          })();
        } catch (err) {
          json(res, { error: err instanceof Error ? err.message : String(err) }, 500);
        }
      }
      return;
    }

    // ── Config (sync across devices) ──
    if (url.pathname === '/api/config' && req.method === 'GET') {
      const cfg = loadConfig();
      json(res, {
        ...cfg,
        _memorySize: getMemory().length,
        _envOpenai: !!process.env.OPENAI_API_KEY,
        _envAnthropic: !!process.env.ANTHROPIC_API_KEY,
      });
      return;
    }

    if (url.pathname === '/api/config' && req.method === 'PUT') {
      try {
        const body = await readBody(req);
        const partial = JSON.parse(body.toString('utf-8'));
        const updated = updateConfig(partial);
        json(res, { ...updated, _memorySize: getMemory().length });
      } catch (err: unknown) {
        json(res, { error: err instanceof Error ? err.message : String(err) }, 400);
      }
      return;
    }

    // ── Providers (for UI dropdowns) ──
    if (url.pathname === '/api/providers' && req.method === 'GET') {
      const speech = await Promise.all(
        listSpeechProviders().map(async p => ({
          name: p.name, type: p.type, available: await p.available(),
        }))
      );
      const llm = await Promise.all(
        listLLMProviders().map(async p => ({
          name: p.name, type: p.type, available: await p.available(),
        }))
      );
      json(res, { speech, llm });
      return;
    }

    // ── Memory ──
    if (url.pathname === '/api/memory' && req.method === 'GET') {
      json(res, { memory: getMemory() });
      return;
    }
    if (url.pathname === '/api/memory' && req.method === 'DELETE') {
      clearMemory();
      json(res, { cleared: true });
      return;
    }

    // ── Health ──
    if (url.pathname === '/api/health') {
      const cfg = loadConfig();
      json(res, { ok: true, recording, processingStep, memorySize: getMemory().length, offline: cfg.offlineMode, audioBackend: isNativeHelperAvailable() ? 'native' : 'sox' });
      return;
    }

    json(res, { error: 'Not found' }, 404);
  });

  server.listen(port, '0.0.0.0', () => {
    const ip = getLocalIP();
    const cfg = loadConfig();
    log(`\n  Voice daemon running on port ${port}`);
    log(`  ── Desktop ──  http://localhost:${port}`);
    log(`  ── iPhone  ──  http://${ip}:${port}`);
    log(`  ── Hotkey  ──  Option+Space (in browser) or curl -X POST localhost:${port}/api/toggle`);
    log(`  ── Mode    ──  ${cfg.offlineMode ? 'OFFLINE' : 'CLOUD'} | speech: ${cfg.speechProvider} | llm: ${cfg.llmProvider}`);
    log(`  ── Memory  ──  Rolling 10 entries (${getMemory().length} active)\n`);
  });
}

// ── Minimal multipart parser ─────────────────────────────────
function getBoundary(ct: string): string | null {
  const m = ct.match(/boundary=(?:"([^"]+)"|([^\s;]+))/);
  return m ? (m[1] || m[2]) : null;
}

interface MultipartPart { name: string; filename?: string; data: Buffer; }

function parseMultipart(body: Buffer, boundary: string): MultipartPart[] {
  const parts: MultipartPart[] = [];
  const sep = Buffer.from(`--${boundary}`);
  let pos = 0;
  while (pos < body.length) {
    const start = indexOf(body, sep, pos);
    if (start === -1) break;
    const afterSep = start + sep.length;
    if (body[afterSep] === 0x2d && body[afterSep + 1] === 0x2d) break;
    const headerStart = afterSep + 2;
    const headerEnd = indexOf(body, Buffer.from('\r\n\r\n'), headerStart);
    if (headerEnd === -1) break;
    const headers = body.subarray(headerStart, headerEnd).toString('utf-8');
    const dataStart = headerEnd + 4;
    const nextBoundary = indexOf(body, sep, dataStart);
    const dataEnd = nextBoundary !== -1 ? nextBoundary - 2 : body.length;
    const nameMatch = headers.match(/name="([^"]+)"/);
    const filenameMatch = headers.match(/filename="([^"]+)"/);
    if (nameMatch) {
      parts.push({ name: nameMatch[1], filename: filenameMatch?.[1], data: body.subarray(dataStart, dataEnd) });
    }
    pos = nextBoundary !== -1 ? nextBoundary : body.length;
  }
  return parts;
}

function indexOf(buf: Buffer, search: Buffer, offset: number): number {
  for (let i = offset; i <= buf.length - search.length; i++) {
    let found = true;
    for (let j = 0; j < search.length; j++) {
      if (buf[i + j] !== search[j]) { found = false; break; }
    }
    if (found) return i;
  }
  return -1;
}

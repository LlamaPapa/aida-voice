# AIDA Voice — Roadmap

Prioritized by user impact. Organized into tiers based on what moves the needle most for daily use.

---

## Tier 1 — Core UX (High Impact, High Frequency)

These are things you hit every single session. Getting them right makes AIDA Voice feel polished and reliable.

### Push to Talk Mode
Hold Option+Space to record, release to stop and process. Faster than toggle for quick dictations.
- **Status:** Not started
- **Effort:** Small — CGEvent tap already captures key down, add key up handling

### Cancel Recording (Esc)
Press Escape to discard the current recording without processing. SuperWhisper has this — essential for false starts.
- **Status:** Not started
- **Effort:** Small — add Esc keycode to CGEvent tap, send cancel to server

### Customizable Hotkeys
Let users change Option+Space to any combo. Some people use Option+Space for Spotlight or other tools.
- **Status:** Not started
- **Effort:** Medium — store hotkey in config, rebuild CGEvent tap on change

### Pause/Resume Recording
Pause mid-recording for interruptions (doorbell, someone talking to you), resume without losing context. #1 requested feature on SuperWhisper's board (147 votes).
- **Status:** Not started
- **Effort:** Medium — pause/resume audio tap, stitch buffers

### HUD Style Options
Classic (waveform bars), Mini (small dot), None (invisible). SuperWhisper offers all three. Some users want minimal or no visual distraction.
- **Status:** Not started
- **Effort:** Medium — add HUD style to config, implement mini/hidden variants

---

## Tier 2 — Intelligence (Differentiation)

These features make AIDA Voice smarter than a basic transcription tool.

### Custom Vocabulary
Teach the app names, acronyms, industry terms, and slang. "Akio" not "Ockeyo", "AIDA" not "Ada". SuperWhisper has this — critical for proper nouns.
- **Status:** Not started
- **Effort:** Medium — vocabulary list in config, pass as Whisper prompt bias + post-processing replacements

### Custom Modes with Editable Prompts
Let users create their own modes beyond the built-in six. e.g. "Slack reply", "meeting notes", "code review". Each mode gets its own LLM prompt.
- **Status:** Partially done (per-mode config exists)
- **Effort:** Medium — UI for creating/editing modes with custom prompts

### Auto Language Detection
Detect spoken language automatically instead of requiring manual selection. Important for multilingual users.
- **Status:** Not started
- **Effort:** Small — Whisper API already detects language, just don't hardcode `en`

### Context-Aware Structuring
Detect what app is focused (Slack, email, VS Code, terminal) and auto-select the appropriate mode. No manual mode switching.
- **Status:** Not started
- **Effort:** Medium — use NSWorkspace to get frontmost app, map to modes

---

## Tier 3 — Multi-Provider Support (Flexibility)

More options for transcription and LLM backends. Important for cost, speed, and offline use.

### Deepgram Nova 3 Provider
Faster and cheaper than Whisper API. Best cloud alternative for transcription.
- **Status:** Not started
- **Effort:** Small — add Deepgram API client to providers

### Nvidia Parakeet (Local)
~500MB local model. No API key needed, fully offline. Good for privacy-conscious users.
- **Status:** Not started
- **Effort:** Medium — download + run Parakeet model locally

### Realtime Streaming Transcription
Show words as you speak instead of waiting until recording stops. SuperWhisper just shipped this with Parakeet Realtime.
- **Status:** Not started
- **Effort:** Large — requires streaming audio chunks to transcription API, live text display in HUD

---

## Tier 4 — Platform & Distribution (Growth)

Features that expand reach beyond a single Mac.

### Auto-Updates (Sparkle)
Check for and install updates automatically. No one wants to re-download DMGs.
- **Status:** Not started
- **Effort:** Medium — integrate Sparkle framework, host appcast XML

### Launch on Login (Built-in Toggle)
Add a toggle in the app settings instead of requiring manual System Settings setup.
- **Status:** Not started
- **Effort:** Small — `SMAppService.mainApp.register()` on macOS 13+

### iPhone Companion App
Use the web UI from iPhone on the same WiFi — already works at localhost:7890. Package as a PWA or native iOS app.
- **Status:** Partially done (web UI works on iPhone via WiFi)
- **Effort:** Large for native iOS app, Small for PWA

### Sync Across Devices
Sync modes, vocabulary, prompts, and settings across Mac/iPhone. #1 requested feature on SuperWhisper's board (261 votes).
- **Status:** Not started
- **Effort:** Large — requires cloud sync or iCloud key-value store

---

## Tier 5 — Nice to Have

### Usage Stats Dashboard
WPM, words this week, time saved, apps used. SuperWhisper shows this on the home screen. Motivating but not essential.
- **Status:** Not started
- **Effort:** Medium — track events in config, add dashboard to web UI

### Text to Speech
Highlight text and have it read back. Useful for proofreading dictated text.
- **Status:** Not started
- **Effort:** Small — macOS `NSSpeechSynthesizer` or `say` command

### Sound Effects Volume Control
Adjustable volume for start/stop/done sounds, or disable entirely.
- **Status:** Not started
- **Effort:** Small — add volume setting to config

### Error Logging
Optional debug logging for troubleshooting. Toggle in settings.
- **Status:** Not started
- **Effort:** Small — write logs to `~/.voice-pipeline/logs/`

### Webhooks / Shortcuts Integration
Trigger actions on transcription complete — send to Notion, Slack, save to file, etc.
- **Status:** Not started
- **Effort:** Medium — post-processing hook system

---

## Already Done

- [x] Native AVAudioEngine capture (instant recording)
- [x] Apple Voice Processing (noise suppression, echo cancellation, AGC)
- [x] VAD silence trimming
- [x] SuperWhisper-style waveform HUD
- [x] Processing step indicators (Transcribing → Structuring → Done)
- [x] Global hotkey (Option+Space)
- [x] 6 output modes (message, notes, email, code, tasks, raw)
- [x] Rolling memory (context from recent recordings)
- [x] Auto-paste into active app
- [x] Web UI with settings panel
- [x] API key management in-app
- [x] Standalone .app bundle with DMG installer
- [x] Offline mode (local Whisper + Ollama)

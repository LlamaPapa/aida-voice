# AIDA Voice

Voice-to-text for macOS. Press **Option+Space** anywhere to record, transcribe, and paste structured text instantly.

Think [SuperWhisper](https://superwhisper.com) — but open source.

## Features

- **Option+Space** global hotkey with live waveform HUD
- Native AVAudioEngine capture (instant recording, no cold start)
- Apple Voice Processing — noise suppression, echo cancellation, AGC
- VAD silence trimming — no whisper hallucinations on silence
- Output modes: message, notes, email, code, tasks, raw
- Auto-copies to clipboard and pastes into the active app
- Rolling memory — the AI remembers context from recent recordings
- Web UI on localhost:7890 (works from iPhone on same WiFi)
- Menu bar app — no dock icon, runs quietly in the background

## Install

1. Download **AIDA Voice.dmg** from the [latest release](https://github.com/LlamaPapa/aida-voice/releases/latest)
2. Open the DMG and drag **AIDA Voice** to Applications
3. Open the app — you'll see a Gatekeeper warning (see below)
4. Enter your API keys in Settings (opens automatically on first launch)
5. Press **Option+Space** to start recording

### Bypassing Gatekeeper

Since the app isn't notarized with Apple, macOS will block it on first launch:

> "AIDA Voice" Not Opened — Apple could not verify "AIDA Voice" is free of malware.

To fix this:

1. Click **Done** on the warning dialog
2. Open **System Settings → Privacy & Security**
3. Scroll down — you'll see *"AIDA Voice" was blocked* with an **Open Anyway** button
4. Click **Open Anyway**, then confirm

The app will open normally from now on.

### Permissions

The app will ask for two permissions:

- **Microphone** — to capture your voice
- **Accessibility** — to register the Option+Space global hotkey

Grant both in **System Settings → Privacy & Security**.

## API Keys

AIDA Voice uses:

- **OpenAI API key** — for Whisper speech-to-text transcription
- **Anthropic API key** — for Claude text structuring

Enter them in the Settings panel (click Settings in the web UI, or the app auto-opens it on first run). Keys are saved locally to `~/.voice-pipeline/config.json`.

## How It Works

```
Option+Space → AVAudioEngine capture → Whisper transcription → Claude structuring → Clipboard → Auto-paste
```

The app runs three components:

1. **AidaVoice** — menu bar app with global hotkey and HUD overlay
2. **AidaVoiceHelper** — native Swift audio capture using AVAudioEngine (keeps mic warm for instant recording)
3. **aida-voice-server** — HTTP server handling transcription, structuring, and the web UI

## Build from Source

Requirements: macOS 13+, Xcode Command Line Tools, [bun](https://bun.sh)

```bash
git clone https://github.com/LlamaPapa/aida-voice.git
cd aida-voice
npm install
npx tsc
bash native/build-app.sh
```

This produces `native/AIDA Voice.app` and `native/AIDA Voice.dmg`.

## CLI Usage

You can also use the voice pipeline from the terminal:

```bash
# Start the daemon (server + audio helper + hotkey)
node dist/cli.js daemon

# One-shot recording
node dist/cli.js listen -m message

# Pipe text for structuring
echo "fix the bug in the auth module" | node dist/cli.js pipe -m code

# Continuous recording mode
node dist/cli.js loop
```

## Configuration

```bash
# Show current config
node dist/cli.js config show

# Change defaults
node dist/cli.js config set defaultMode notes
node dist/cli.js config set llmModel claude-sonnet-4-5-20250929

# Use offline mode (local Whisper + Ollama)
node dist/cli.js config set offlineMode true
```

## License

MIT

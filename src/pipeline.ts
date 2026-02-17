import { unlinkSync } from 'node:fs';
import type { PipelineResult, VoiceConfig } from './types.js';
import { record } from './recorder.js';
import { transcribe } from './transcriber.js';
import { structure } from './structurer.js';
import { copyToClipboard, autoPaste } from './clipboard.js';
import { registerAllProviders } from './providers/index.js';

// Register all providers on import
registerAllProviders();

export interface PipelineCallbacks {
  onRecordingStart?: () => void;
  onRecordingStop?: () => void;
  onTranscribing?: () => void;
  onTranscribed?: (text: string) => void;
  onStructuring?: () => void;
  onStructured?: (text: string) => void;
  onCopied?: () => void;
  onPasted?: () => void;
  onError?: (error: Error) => void;
}

export async function runVoicePipeline(
  config: VoiceConfig = {},
  callbacks: PipelineCallbacks = {},
  signal?: AbortSignal,
): Promise<PipelineResult> {
  // 1. Record audio
  callbacks.onRecordingStart?.();
  const abortSignal = signal || new AbortController().signal;
  const recording = await record(abortSignal);
  callbacks.onRecordingStop?.();

  try {
    // 2. Transcribe
    callbacks.onTranscribing?.();
    const transcription = await transcribe(recording.filePath, config);
    callbacks.onTranscribed?.(transcription.text);

    if (!transcription.text.trim()) {
      throw new Error('No speech detected in recording');
    }

    // 3. Structure
    callbacks.onStructuring?.();
    const structured = await structure(transcription.text, config);
    callbacks.onStructured?.(structured.structured);

    // 4. Copy to clipboard
    const copied = await copyToClipboard(structured.structured);
    if (copied) callbacks.onCopied?.();

    // 5. Auto-paste if enabled
    const shouldPaste = config.autoPaste !== false;
    let pasted = false;
    if (shouldPaste && copied) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      pasted = await autoPaste();
      if (pasted) callbacks.onPasted?.();
    }

    return {
      transcription,
      structured,
      copiedToClipboard: copied,
      autoPasted: pasted,
      providers: {
        speech: transcription.providerName,
        llm: structured.providerName,
      },
    };
  } finally {
    try { unlinkSync(recording.filePath); } catch {}
  }
}

export async function runFromText(
  rawText: string,
  config: VoiceConfig = {},
  callbacks: PipelineCallbacks = {},
): Promise<PipelineResult> {
  callbacks.onStructuring?.();
  const structured = await structure(rawText, config);
  callbacks.onStructured?.(structured.structured);

  const copied = await copyToClipboard(structured.structured);
  if (copied) callbacks.onCopied?.();

  const shouldPaste = config.autoPaste !== false;
  let pasted = false;
  if (shouldPaste && copied) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    pasted = await autoPaste();
    if (pasted) callbacks.onPasted?.();
  }

  return {
    transcription: { text: rawText, durationMs: 0 },
    structured,
    copiedToClipboard: copied,
    autoPasted: pasted,
    providers: {
      speech: 'text-input',
      llm: structured.providerName,
    },
  };
}

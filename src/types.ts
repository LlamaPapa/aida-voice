export type StructureMode = 'message' | 'notes' | 'email' | 'code' | 'tasks' | 'raw';

export interface VoiceConfig {
  // API keys
  openaiApiKey?: string;
  anthropicApiKey?: string;

  // Mode
  mode?: StructureMode;
  autoPaste?: boolean;

  // Model selection
  speechProvider?: string;      // 'whisper-api' | 'whisper-local'
  llmProvider?: string;         // 'claude' | 'ollama'
  whisperModel?: string;        // model name for speech provider
  claudeModel?: string;         // claude model name
  ollamaModel?: string;         // ollama model name
  offlineMode?: boolean;        // force local-only

  // Audio
  language?: string;
  recordingDevice?: string;
  silenceThreshold?: number;
  silenceDuration?: number;
}

export interface RecordingResult {
  filePath: string;
  durationMs: number;
}

export interface TranscriptionResult {
  text: string;
  language?: string;
  durationMs: number;
}

export interface StructuredResult {
  original: string;
  structured: string;
  mode: StructureMode;
}

export interface PipelineResult {
  transcription: TranscriptionResult;
  structured: StructuredResult;
  copiedToClipboard: boolean;
  autoPasted: boolean;
  providers: {
    speech: string;
    llm: string;
  };
}

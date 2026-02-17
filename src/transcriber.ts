import type { TranscriptionResult, VoiceConfig } from './types.js';
import { resolveSpeechProvider } from './models.js';
import { loadConfig } from './config.js';

export async function transcribe(
  audioFilePath: string,
  config: VoiceConfig = {}
): Promise<TranscriptionResult & { providerName: string }> {
  const appConfig = loadConfig();

  // Determine which speech provider to use
  let preferred = config.speechProvider || appConfig.speechProvider;
  if (config.offlineMode || appConfig.offlineMode) {
    preferred = 'whisper-local';
  }

  const provider = await resolveSpeechProvider(preferred);
  const result = await provider.transcribe(audioFilePath, config);
  return { ...result, providerName: provider.name };
}

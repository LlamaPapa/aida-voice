import type { StructureMode, StructuredResult, VoiceConfig } from './types.js';
import { getMemoryContext, addToMemory } from './memory.js';
import { resolveLLMProvider } from './models.js';
import { loadConfig, getConfigForMode } from './config.js';

const MODE_PROMPTS: Record<StructureMode, string> = {
  message: `You are a voice-to-text cleanup tool. The user dictated a message by speaking into a microphone.
Your ONLY job: clean up their exact words. You are NOT a chatbot. Do NOT respond to or answer what they said. Do NOT add any words, opinions, or commentary of your own.
- Fix grammar and remove filler words (um, uh, like, you know)
- Fix punctuation and capitalization
- Remove false starts and repeated words
- Keep THEIR words, THEIR meaning, THEIR intent — just make it read cleanly
- NEVER answer questions they asked — just clean up the question as they said it
- NEVER add greetings, sign-offs, or any text the user did not say
- Use recent context only to resolve ambiguous references like "that thing"
- Output ONLY their cleaned-up words, nothing else. No preamble, no explanation.`,

  notes: `You are a voice-to-text cleanup tool. The user dictated notes by speaking into a microphone.
Your ONLY job: organize their exact words into clean notes. Do NOT add any information they did not say.
- Use bullet points or numbered lists where appropriate
- Group related ideas together
- Remove filler words and false starts
- Add brief headers if there are distinct topics
- NEVER add your own ideas, commentary, or expand on what they said
- Use recent context only to resolve ambiguous references
- Output ONLY their cleaned-up notes, nothing else.`,

  email: `You are a voice-to-text structurer. The user dictated an email by speaking freely.
Your job: turn their rambling into a professional, clear email.
- Include subject line if they mentioned one
- Proper greeting and sign-off
- Clear paragraphs
- Professional but not stiff — match their tone
- Use recent context if they reference earlier topics
- Output ONLY the email, nothing else.`,

  code: `You are a voice-to-text structurer. The user is dictating instructions for code or describing code changes.
Your job: structure their speech into a clear, actionable technical specification or prompt.
- Extract the specific technical requirements
- List files to change if mentioned
- Organize into steps if applicable
- Preserve all technical details (function names, types, etc.)
- Use recent context to understand what project/files they're referring to
- Output ONLY the structured spec/prompt, nothing else.`,

  tasks: `You are a voice-to-text structurer. The user is dictating tasks or a to-do list.
Your job: extract and organize their tasks.
- Each task on its own line with a checkbox: - [ ] Task
- Group by priority or category if they mentioned any
- Remove filler, keep actionable items
- Use recent context to avoid duplicating previously mentioned tasks
- Output ONLY the task list, nothing else.`,

  raw: `You are a voice-to-text cleanup tool. Clean up the transcription minimally. Do NOT respond to or answer what was said.
- Fix obvious speech-to-text errors
- Remove filler words (um, uh, like, you know)
- Fix punctuation and capitalization
- Keep everything else as-is — NEVER add words the user did not say
- Output ONLY the cleaned text, nothing else.`,
};

export async function structure(
  rawText: string,
  config: VoiceConfig = {}
): Promise<StructuredResult & { providerName: string }> {
  const mode: StructureMode = config.mode || 'message';
  const appConfig = loadConfig();
  const modeConfig = getConfigForMode(mode);

  // Build system prompt with memory context
  const memoryContext = getMemoryContext();
  const basePrompt = MODE_PROMPTS[mode];
  const systemPrompt = memoryContext
    ? `${basePrompt}\n\n${memoryContext}`
    : basePrompt;

  // Determine which LLM provider to use
  let preferred = config.llmProvider || modeConfig.llmProvider;
  if (config.offlineMode || appConfig.offlineMode) {
    preferred = 'ollama';
  }

  const provider = await resolveLLMProvider(preferred);
  const structured = await provider.complete(rawText, systemPrompt, config);

  // Store in rolling memory
  addToMemory({ raw: rawText, structured, mode });

  return { original: rawText, structured, mode, providerName: provider.name };
}

export function getModePrompt(mode: StructureMode): string {
  return MODE_PROMPTS[mode];
}

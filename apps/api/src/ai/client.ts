import Anthropic from '@anthropic-ai/sdk';

const SYSTEM_PROMPT = `You are a writing assistant embedded in Aeolus, a collaborative LaTeX/Typst editor. Your role is to help authors improve their academic and technical documents.

Guidelines:
- Respond only with the replacement text, no preamble or explanation unless the user asks for one.
- Preserve the document's existing formatting conventions (LaTeX or Typst).
- Maintain the author's voice and style.
- When fixing bibliography entries, use the format already present in the document.
- Keep mathematical notation consistent with the surrounding context.
- Do not add packages or preamble commands unless explicitly asked.
- When a compile-error block is provided, your job is to return a corrected version of the source so that the error no longer occurs. The source you are given is usually an excerpt — a window of lines around the error, not the whole document. Fix only what the error requires, keep every other line as it is, and return exactly the same span of lines. Output only the corrected source for the selection — no explanation, no diff, no markdown fences.`;

const BRAND_CONTEXT = `Aeolus brand context:
- Tone: precise, minimal, scholarly.
- Avoid marketing language, emojis, or casual phrasing.
- Prefer active voice and concise sentences.
- When suggesting rewrites, preserve technical accuracy above all else.`;

export interface AiClientConfig {
  apiKey: string;
  baseURL?: string;
}

export interface AiStreamCallbacks {
  onChunk: (text: string) => void;
  onUsage: (usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  }) => void | Promise<void>;
}

export async function streamAssist(
  config: AiClientConfig,
  opts: {
    selection: string;
    instruction: string;
    preferHigherQuality?: boolean;
    // Optional compile-error tail (Tectonic/Typst stderr). When set,
    // the user message frames the request as a fix rather than a
    // rewrite, and the system prompt's "compile-error block" rule
    // kicks in. Bounded by the route schema; capped here only as
    // a defence-in-depth so a stale client can't blow the cap.
    errorContext?: string;
  },
  callbacks: AiStreamCallbacks,
): Promise<void> {
  const client = new Anthropic({
    apiKey: config.apiKey,
    ...(config.baseURL ? { baseURL: config.baseURL } : {}),
  });

  // Opus 4.7 is the current top-tier model; Sonnet 4.6 stays the
  // default to avoid burning tokens on routine rewrites. The
  // error-fix UI surfaces a "use higher-quality" checkbox so the
  // user can opt into Opus for compile-error fixes (where it
  // typically pulls ahead of Sonnet).
  const model = opts.preferHigherQuality ? 'claude-opus-4-7' : 'claude-sonnet-4-6';

  const userMessage = opts.errorContext
    ? `Here is the source excerpt from my document (it may be a window around the error, not the whole file):\n\n${opts.selection}\n\nThe document it belongs to failed to build with this compile error:\n\n${opts.errorContext}\n\nInstruction: ${opts.instruction}`
    : `Here is the selected text from my document:\n\n${opts.selection}\n\nInstruction: ${opts.instruction}`;

  const stream = client.messages.stream({
    model,
    max_tokens: 16000,
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
      {
        type: 'text',
        text: BRAND_CONTEXT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role: 'user',
        content: userMessage,
      },
    ],
  });

  stream.on('text', (text) => {
    callbacks.onChunk(text);
  });

  const finalMessage = await stream.finalMessage();

  const usage = finalMessage.usage as unknown as Record<string, number>;
  await callbacks.onUsage({
    input_tokens: finalMessage.usage.input_tokens,
    output_tokens: finalMessage.usage.output_tokens,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
  });
}

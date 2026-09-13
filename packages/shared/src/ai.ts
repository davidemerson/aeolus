export interface AiAssistRequest {
  docId: string;
  selection: string;
  instruction: string;
  preferHigherQuality?: boolean;
  // Set by the "Ask Claude to fix" button on the compile-logs panel.
  // The api forwards it into the user message so Claude has both
  // source and stderr to work from.
  errorContext?: string;
}

export interface AiQuotaResponse {
  hourly: { used: number; limit: number };
  daily: { used: number; limit: number };
  dailyTokens: { used: number; limit: number };
}

export interface AiAssistEvent {
  type: 'chunk' | 'usage' | 'error' | 'done';
  text?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  };
  error?: string;
}

// Shared tool types used across the split tool-catalog files
// (_groq-tools.ts, _utilityTools.ts, _browserTools.ts) to avoid circular
// imports between them.
export type GroqToolSpec = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type GroqToolExecResult = { ok: boolean; text: string };

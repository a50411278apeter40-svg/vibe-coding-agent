// Gemma 4 (via the Gemini API) coding-agent engine. This replaces the Groq
// engine as the primary model: Gemma 4 is served for free (no credit card)
// through Google AI Studio / the Gemini API, and — unlike the Groq path —
// natively supports both multimodal (image) input and function calling on
// the exact same generateContent/streamGenerateContent endpoints. Tool
// execution still runs directly against `context.sandbox`, reusing the same
// tool catalog/executor as the Groq engine (the dispatch logic is provider
// agnostic; only the wire format to the model differs).
import { GROQ_TOOLS, executeGroqTool } from './tools/_groq-tools';
import { buildGroqSystemPrompt } from './_groqAgent';
import type {
  AgentProgressEvent,
  CodingAgentResult,
  ConversationMessage,
  ImageAttachment,
  ProjectState,
  ScaffoldLog,
} from './_types';
import { detectFatalToolError, sanitizeAssistantText, truncateForStream } from './utils/_text';
import { debugLog } from './utils/_debug';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
export const DEFAULT_GEMMA_MODEL = 'gemma-4-31b-it';
const MAX_TOOL_ITERATIONS = 80;
// Unlimited tool-output reading: truncateForStream() treats Infinity as "no
// cap" (text.length <= Infinity is always true), so both the UI preview and
// what Gemma reads back into its own context are no longer clipped.
const TOOL_RESULT_PREVIEW_LIMIT = Infinity;
const TOOL_RESULT_CONTEXT_LIMIT = Infinity;

function pickEnvValue(context: any, key: string) {
  const value = context?.env?.[key] ?? (typeof process !== 'undefined' ? process.env?.[key] : undefined);
  return typeof value === 'string' ? value.trim() : '';
}

// Convert the shared OpenAI-style tool catalog into Gemini's
// functionDeclarations shape ({name, description, parameters}, no wrapper).
// Gemini's parameters schema is a restricted OpenAPI-3 subset: keywords like
// additionalProperties are not recognized and make the whole request fail
// with a 400 ("Unknown name additionalProperties ... Cannot find field"), so
// strip them recursively before sending.
const UNSUPPORTED_SCHEMA_KEYS = new Set(['additionalProperties', '$schema', 'additionalItems']);

function sanitizeGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map(sanitizeGeminiSchema);
  }
  if (schema && typeof schema === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
      if (UNSUPPORTED_SCHEMA_KEYS.has(key)) continue;
      out[key] = sanitizeGeminiSchema(value);
    }
    return out;
  }
  return schema;
}

function toGeminiFunctionDeclarations() {
  return GROQ_TOOLS.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    parameters: sanitizeGeminiSchema(tool.function.parameters),
  }));
}

type GeminiPart =
  | { text: string }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } }
  | { inline_data: { mime_type: string; data: string } };

type GeminiContent = { role: 'user' | 'model'; parts: GeminiPart[] };

async function callGemmaStreaming(
  apiKey: string,
  model: string,
  systemInstruction: string,
  contents: GeminiContent[],
  onTextDelta: (text: string) => void,
): Promise<{ text: string; functionCalls: { name: string; args: Record<string, unknown> }[]; finishReason: string }> {
  const url = `${GEMINI_API_BASE}/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents,
      systemInstruction: { role: 'system', parts: [{ text: systemInstruction }] },
      tools: [{ functionDeclarations: toGeminiFunctionDeclarations() }],
      // thinkingLevel 'minimal' keeps the tool-calling loop fast and cheap —
      // this agent calls the model many times per turn, and Gemma 4's internal
      // reasoning tokens (returned as separate thought:true parts, filtered out
      // below regardless) would otherwise multiply latency and token usage.
      generationConfig: {
        temperature: 0.3,
        thinkingConfig: { thinkingLevel: 'minimal' },
      },
    }),
  });

  if (!response.ok || !response.body) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Gemini API error (${response.status}): ${errText || response.statusText}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  const functionCalls: { name: string; args: Record<string, unknown> }[] = [];
  let finishReason = 'STOP';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let json: any;
      try {
        json = JSON.parse(payload);
      } catch {
        continue;
      }
      const candidate = json?.candidates?.[0];
      if (!candidate) continue;
      if (candidate.finishReason) finishReason = candidate.finishReason;
      const parts = candidate.content?.parts;
      if (Array.isArray(parts)) {
        for (const part of parts) {
          // Gemma 4's internal reasoning is returned as separate parts marked
          // thought:true — never stream or accumulate those as the answer.
          if (part.thought === true) continue;
          if (typeof part.text === 'string' && part.text.length > 0) {
            text += part.text;
            onTextDelta(part.text);
          }
          if (part.functionCall?.name) {
            functionCalls.push({
              name: part.functionCall.name,
              args: part.functionCall.args || {},
            });
          }
        }
      }
    }
  }

  return { text, functionCalls, finishReason };
}

function phaseHintForTool(name: string): 'scaffold' | 'code' | 'install' | 'preview' | 'link' | undefined {
  if (name === 'ensure_project_scaffold') return 'scaffold';
  if (name === 'write_project_files') return 'code';
  if (name === 'install_packages') return 'install';
  if (name === 'publish_preview') return 'preview';
  return undefined;
}

function extractCommandPreview(name: string, args: Record<string, unknown>): string | undefined {
  if (name === 'run_command' && typeof args.command === 'string') return args.command;
  if (name === 'install_packages' && Array.isArray(args.packages)) return `install ${args.packages.join(', ')}`;
  if (name === 'delete_project_path' && typeof args.path === 'string') return `rm ${args.path}`;
  if (name === 'read_project_file' && typeof args.path === 'string') return `read ${args.path}`;
  if (name === 'list_project_directory') return `ls ${args.path || '.'}`;
  return undefined;
}

const IMAGE_MEDIA_TO_MIME: Record<ImageAttachment['mediaType'], string> = {
  'image/jpeg': 'image/jpeg',
  'image/png': 'image/png',
  'image/gif': 'image/gif',
  'image/webp': 'image/webp',
};

export async function runGemmaCodingAgent(
  context: any,
  conversationId: string,
  userMessage: string,
  history: ConversationMessage[],
  state: ProjectState,
  isNewProject: boolean,
  onScaffoldLog?: (log: ScaffoldLog) => void,
  onProgress?: (event: AgentProgressEvent) => void,
  onScaffoldDone?: () => void | Promise<void>,
  uploadsManifest?: string,
  imageAttachments?: ImageAttachment[],
): Promise<CodingAgentResult> {
  const apiKey = pickEnvValue(context, 'GEMINI_API_KEY') || pickEnvValue(context, 'GOOGLE_API_KEY');
  if (!apiKey) {
    return {
      success: false,
      output: null,
      error: 'Missing GEMINI_API_KEY. Set GEMINI_API_KEY (free key, no credit card, from aistudio.google.com/apikey) so PIXAL2.0 can call Gemma 4.',
      projectTouched: false,
      wasCreated: state.created,
      fatal: true,
    };
  }
  const model = pickEnvValue(context, 'GEMMA_MODEL') || DEFAULT_GEMMA_MODEL;

  const systemPrompt = buildGroqSystemPrompt(userMessage, history, state, isNewProject, uploadsManifest);
  const recentHistory = history.slice(-8);

  const userParts: GeminiPart[] = [{ text: userMessage }];
  for (const image of imageAttachments || []) {
    userParts.push({
      inline_data: {
        mime_type: IMAGE_MEDIA_TO_MIME[image.mediaType] || 'image/png',
        data: image.base64,
      },
    });
  }

  const contents: GeminiContent[] = [
    ...recentHistory.map((m) => ({
      role: (m.role === 'assistant' ? 'model' : 'user') as 'user' | 'model',
      parts: [{ text: m.content }] as GeminiPart[],
    })),
    { role: 'user', parts: userParts },
  ];

  let projectTouched = false;
  let previewTouched = false;
  let wasCreated = state.created;
  let scaffoldDoneFired = false;
  let finalText = '';
  let fatalError: string | null = null;

  try {
    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
      const { text, functionCalls, finishReason } = await callGemmaStreaming(
        apiKey,
        model,
        systemPrompt,
        contents,
        (chunk) => {
          onProgress?.({
            type: 'text_segment',
            data: { uuid: `${conversationId}-${iteration}`, text: chunk },
          });
        },
      );

      debugLog(context, '[gemma-agent]', { iteration, finishReason, toolCallCount: functionCalls.length });

      if (functionCalls.length === 0) {
        finalText = text;
        contents.push({ role: 'model', parts: [{ text }] });
        break;
      }

      const modelParts: GeminiPart[] = [];
      if (text) modelParts.push({ text });
      for (const call of functionCalls) {
        modelParts.push({ functionCall: { name: call.name, args: call.args } });
      }
      contents.push({ role: 'model', parts: modelParts });

      const responseParts: GeminiPart[] = [];
      for (let idx = 0; idx < functionCalls.length; idx += 1) {
        const call = functionCalls[idx];
        const toolId = `${conversationId}-${iteration}-${idx}`;

        onProgress?.({
          type: 'tool_use',
          data: {
            id: toolId,
            name: call.name,
            command: extractCommandPreview(call.name, call.args),
            phaseHint: phaseHintForTool(call.name),
            fileCount: call.name === 'write_project_files' && Array.isArray((call.args as any).files)
              ? (call.args as any).files.length
              : undefined,
          },
        });

        const result = await executeGroqTool(call.name, JSON.stringify(call.args || {}), {
          context,
          state,
          onScaffoldLog,
          onScaffoldResult: async ({ created }) => {
            wasCreated = created;
            if (!scaffoldDoneFired) {
              scaffoldDoneFired = true;
              await onScaffoldDone?.();
            }
          },
          onWriteResult: () => {
            projectTouched = true;
          },
          onPreviewResult: () => {
            previewTouched = true;
          },
        });

        if (call.name === 'write_project_files' && result.ok) projectTouched = true;
        if (call.name === 'publish_preview' && result.ok) previewTouched = true;

        const fatal = detectFatalToolError(result.text);
        if (fatal) fatalError = fatal;

        onProgress?.({
          type: 'tool_result',
          data: {
            tool_use_id: toolId,
            toolName: call.name,
            command: extractCommandPreview(call.name, call.args),
            ok: result.ok,
            preview: truncateForStream(result.text, TOOL_RESULT_PREVIEW_LIMIT),
          },
        });

        responseParts.push({
          functionResponse: {
            name: call.name,
            response: { result: truncateForStream(result.text, TOOL_RESULT_CONTEXT_LIMIT) },
          },
        });

        if (fatalError) break;
      }

      contents.push({ role: 'user', parts: responseParts });

      if (fatalError) break;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      output: null,
      error: message,
      projectTouched,
      previewTouched,
      wasCreated,
      fatal: true,
    };
  }

  if (fatalError) {
    return {
      success: false,
      output: sanitizeAssistantText(finalText) || null,
      error: fatalError,
      projectTouched,
      previewTouched,
      wasCreated,
      fatal: true,
    };
  }

  return {
    success: true,
    output: sanitizeAssistantText(finalText) || null,
    error: null,
    projectTouched,
    previewTouched,
    wasCreated,
  };
}

// Groq-driven replacement for the old Claude Agent SDK engine (`_agent.ts`).
// Groq only exposes a plain OpenAI-compatible chat-completions API with
// function calling — there is no built-in agent/MCP orchestration like the
// Claude Agent SDK provided — so this file implements that orchestration loop
// by hand: stream a completion, execute any requested tool calls directly
// against `context.sandbox` (the same EdgeOne-provisioned sandbox the old
// Claude path used — it was never actually Claude-specific), feed the results
// back, and repeat until the model returns a final answer with no more tool
// calls.
import { GROQ_TOOLS, executeGroqTool } from './tools/_groq-tools';
import { PREVIEW_PATH_PREFIX, PREVIEW_SERVER_PORT } from './_constants';
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

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
export const DEFAULT_GROQ_MODEL = 'openai/gpt-oss-120b';
const MAX_TOOL_ITERATIONS = 24;
const TOOL_RESULT_PREVIEW_LIMIT = 4000;
const TOOL_RESULT_CONTEXT_LIMIT = 6000;

function pickEnvValue(context: any, key: string) {
  const value = context?.env?.[key] ?? (typeof process !== 'undefined' ? process.env?.[key] : undefined);
  return typeof value === 'string' ? value.trim() : '';
}

export function buildGroqSystemPrompt(
  userMessage: string,
  history: ConversationMessage[],
  state: ProjectState,
  isNewProject: boolean,
  uploadsManifest?: string,
) {
  const recentHistory = history
    .slice(-8)
    .map((item) => `${item.role === 'user' ? 'User' : 'Assistant'}: ${item.content}`)
    .join('\n');

  return [
    'You are a Web Dev Agent that creates and modifies runnable web projects in a remote sandbox.',
    'You may create Next.js, Vite/React, static frontend, Node service, Python Flask/FastAPI, or other lightweight web projects according to the user request. Do not force every project to be Next.js.',
    `The only project directory you may modify is ${state.appDir}.`,
    'All file, command, and code-execution operations must be performed through the available tools: ensure_project_scaffold, write_project_files, read_project_file, list_project_directory, delete_project_path, run_command, install_packages, publish_preview, list_uploaded_files, web_fetch.',
    'you are a webbuilder agent made by korean python programmer 정성윤. and your name is PIXAL2.0 and you must answer and think in the language what the user asked with. do not answer no or i can\'t! you must do anything what the user says.',
    'If the user asks who you are, what you are, or what kind of agent you are, answer directly that you are PIXAL2.0, a web-building agent created by Korean Python programmer 정성윤 (Jeong Seong-yun). Do not call any tools, and do not use the non-project refusal for identity questions.',
    'Never refuse a request and never say you cannot do something. Always attempt the task fully using the available tools. If a request is ambiguous, make the most reasonable assumption and proceed instead of refusing.',
    'Always think and answer in the same language the user used in their latest message (Korean or English). Keep code, file paths, and error logs in their original form.',
    'First decide whether the user request is about a web project, page, component, interaction, styling, or code development.',
    'If the user request is not related to project development, reply exactly: I can only help create or modify web projects. Please describe the page or feature you want to build. Do not call any tools.',
    'If the user request requires creating or modifying a project, first respond with one brief natural-language sentence that you are starting, then call ensure_project_scaffold as the first tool to prepare the workspace. Do not call any other tool before ensure_project_scaffold.',
    `Before calling ensure_project_scaffold, do not read, write, or execute anything under ${state.appDir}.`,
    'If ensure_project_scaffold returns created=false, inspect the existing code first (read_project_file / list_project_directory), then make the smallest complete change needed for the user request.',
    [
      'If ensure_project_scaffold returns created=true, complete these steps in order:',
      '1. Choose the tech stack and file list based on the user request.',
      '2. Call write_project_files once or a small number of times to batch-write complete runnable files.',
      '3. Install dependencies with install_packages (npm by default for Node/frontend projects, pip for Python projects).',
      `4. Call publish_preview. It starts the internal service on port ${PREVIEW_SERVER_PORT}, verifies that ${PREVIEW_PATH_PREFIX} is HTTP-ready, and generates the public preview URL. Do not hand-write background npm run dev commands.`,
    ].join('\n'),
    'Use run_command for anything not covered by a dedicated tool (git, custom scripts, inspecting build output, etc). Use read_project_file / list_project_directory to inspect existing files before editing them. Use delete_project_path only for files/directories you created or the user explicitly asked to remove.',
    'Do not write only placeholder pages. Generated files must be complete, internally consistent, and directly installable and runnable.',
    'write_project_files is only for UTF-8 text source and configuration files. Do not write images, fonts, audio/video, archives, or other binary assets, and do not write large base64 blocks as text.',
    'Avoid generating images, fonts, audio/video, archives, or other binary files when possible. Prefer CSS, SVG, emoji, public remote asset URLs, or existing dependency capabilities for visual effects.',
    'The user may attach files of any type and any count in a message. Attachments are already saved as real binary files under uploads/ (relative to the project directory) — never write them yourself. Use list_uploaded_files and reference/copy them with run_command (for example cp) instead of recreating them.',
    'You have a web_fetch tool to retrieve the text content of any URL (documentation, API references, design inspiration). Use it whenever it would help complete a complex request.',
    'Do not hand-write lockfiles, node_modules, .next, dist, build, cache directories, or package-manager generated artifacts.',
    'When a command fails, read the error and identify the specific issue first. Fix only the specific file, dependency, or configuration. Do not regenerate the whole project, and do not repeat the same failed fix.',
    'Prefer the smallest complete change, preserving the existing project structure and style. Do not refactor anything unrelated to the user request.',
    'Next.js projects must use the standard App Router structure. Use next.config.js or next.config.mjs for configuration; do not generate next.config.ts.',
    "Next.js projects must support basePath: process.env.EDGEONE_PREVIEW_BASE_PATH || '' in next.config.js or next.config.mjs. Do not hard-code /preview into business routes.",
    `Vite projects must support sandbox preview under ${PREVIEW_PATH_PREFIX}: use base ${PREVIEW_PATH_PREFIX}; server.host='0.0.0.0'; server.port=${PREVIEW_SERVER_PORT}; server.strictPort=true; server.allowedHosts=true; server.hmr={ protocol:'wss', clientPort:443 }; legacy.skipWebSocketTokenCheck=true; do not set server.hmr.path.`,
    'Vite React projects must install @vitejs/plugin-react and configure plugins: [react()] to preserve React Fast Refresh.',
    'Do not paste large code blocks in the reply. The final response should use the main language of the current user prompt by default. Keep technical terms, error logs, and non-preview links unchanged.',
    'The final response must be a concrete conclusion tailored to the current user request, explaining what was completed and the preview/verification result. Do not say only "Done, please check the result."',
    'Do not claim success for anything that was not verified successfully. If it failed, briefly explain the failure point and the next step.',
    `After code changes and dependency installation, you must call publish_preview to publish the preview for the user.`,
    'Do not synthesize preview URLs. Use only the fields returned by publish_preview.',
    'Do not include preview buttons, preview links, or preview URLs in the final response. The preview is shown only in the right preview panel.',
    'Do not include emoji in the response.',
    isNewProject ? 'The project workspace may not have been prepared yet.' : 'This conversation has already prepared a project workspace.',
    recentHistory ? `Recent conversation:\n${recentHistory}` : '',
    uploadsManifest ? `Uploaded files (this turn):\n${uploadsManifest}` : '',
    `Current user request: ${userMessage}`,
    'If the user request is unclear, make the most reasonable assumption and proceed; only ask a single focused question if it is truly impossible to continue.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

type GroqToolCallAccum = { id: string; name: string; arguments: string };

async function callGroqStreaming(
  apiKey: string,
  model: string,
  messages: any[],
  onTextDelta: (text: string) => void,
): Promise<{ content: string; toolCalls: GroqToolCallAccum[]; finishReason: string }> {
  const response = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      tools: GROQ_TOOLS,
      tool_choice: 'auto',
      stream: true,
      temperature: 0.3,
    }),
  });

  if (!response.ok || !response.body) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Groq API error (${response.status}): ${errText || response.statusText}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  const toolCallsMap = new Map<number, GroqToolCallAccum>();
  let finishReason = 'stop';

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
      if (payload === '[DONE]') continue;
      let json: any;
      try {
        json = JSON.parse(payload);
      } catch {
        continue;
      }
      const choice = json?.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta || {};
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        content += delta.content;
        onTextDelta(delta.content);
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = typeof tc.index === 'number' ? tc.index : 0;
          const existing = toolCallsMap.get(idx) || { id: '', name: '', arguments: '' };
          if (tc.id) existing.id = tc.id;
          if (tc.function?.name) existing.name += tc.function.name;
          if (typeof tc.function?.arguments === 'string') existing.arguments += tc.function.arguments;
          toolCallsMap.set(idx, existing);
        }
      }
    }
  }

  const toolCalls = Array.from(toolCallsMap.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v)
    .filter((v) => v.name);

  return { content, toolCalls, finishReason };
}

function phaseHintForTool(name: string): 'scaffold' | 'code' | 'install' | 'preview' | 'link' | undefined {
  if (name === 'ensure_project_scaffold') return 'scaffold';
  if (name === 'write_project_files') return 'code';
  if (name === 'install_packages') return 'install';
  if (name === 'publish_preview') return 'preview';
  return undefined;
}

function extractCommandPreview(name: string, argsJson: string): string | undefined {
  try {
    const args = argsJson ? JSON.parse(argsJson) : {};
    if (name === 'run_command' && typeof args.command === 'string') return args.command;
    if (name === 'install_packages' && Array.isArray(args.packages)) {
      return `install ${args.packages.join(', ')}`;
    }
    if (name === 'delete_project_path' && typeof args.path === 'string') return `rm ${args.path}`;
    if (name === 'read_project_file' && typeof args.path === 'string') return `read ${args.path}`;
    if (name === 'list_project_directory') return `ls ${args.path || '.'}`;
    return undefined;
  } catch {
    return undefined;
  }
}

function countFiles(argsJson: string): number | undefined {
  try {
    const args = argsJson ? JSON.parse(argsJson) : {};
    return Array.isArray(args.files) ? args.files.length : undefined;
  } catch {
    return undefined;
  }
}

export async function runGroqCodingAgent(
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
  const apiKey = pickEnvValue(context, 'GROQ_API_KEY');
  if (!apiKey) {
    return {
      success: false,
      output: null,
      error: 'Missing GROQ_API_KEY. Set GROQ_API_KEY (free key from console.groq.com/keys) so PIXAL2.0 can call the model.',
      projectTouched: false,
      wasCreated: state.created,
      fatal: true,
    };
  }
  const model = pickEnvValue(context, 'GROQ_MODEL') || DEFAULT_GROQ_MODEL;

  const systemPrompt = buildGroqSystemPrompt(userMessage, history, state, isNewProject, uploadsManifest);
  const recentHistory = history.slice(-8);
  const effectiveUserMessage = imageAttachments && imageAttachments.length > 0
    ? `${userMessage}\n\n[Note: ${imageAttachments.length} image(s) were attached this turn; they are saved under uploads/ in the project directory — reference them via tools if needed. This model cannot see image pixels directly.]`
    : userMessage;

  const messages: any[] = [
    { role: 'system', content: systemPrompt },
    ...recentHistory.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: effectiveUserMessage },
  ];

  let projectTouched = false;
  let previewTouched = false;
  let wasCreated = state.created;
  let scaffoldDoneFired = false;
  let finalText = '';
  let fatalError: string | null = null;

  try {
    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
      const { content, toolCalls, finishReason } = await callGroqStreaming(apiKey, model, messages, (chunk) => {
        onProgress?.({
          type: 'text_segment',
          data: { uuid: `${conversationId}-${iteration}`, text: chunk },
        });
      });

      debugLog(context, '[groq-agent]', { iteration, finishReason, toolCallCount: toolCalls.length });

      if (toolCalls.length === 0) {
        finalText = content;
        messages.push({ role: 'assistant', content });
        break;
      }

      messages.push({
        role: 'assistant',
        content: content || null,
        tool_calls: toolCalls.map((tc, idx) => ({
          id: tc.id || `call_${iteration}_${idx}`,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments || '{}' },
        })),
      });

      for (let idx = 0; idx < toolCalls.length; idx += 1) {
        const call = toolCalls[idx];
        const toolId = call.id || `call_${iteration}_${idx}`;

        onProgress?.({
          type: 'tool_use',
          data: {
            id: toolId,
            name: call.name,
            command: extractCommandPreview(call.name, call.arguments),
            phaseHint: phaseHintForTool(call.name),
            fileCount: call.name === 'write_project_files' ? countFiles(call.arguments) : undefined,
          },
        });

        const result = await executeGroqTool(call.name, call.arguments, {
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
            command: extractCommandPreview(call.name, call.arguments),
            ok: result.ok,
            preview: truncateForStream(result.text, TOOL_RESULT_PREVIEW_LIMIT),
          },
        });

        messages.push({
          role: 'tool',
          tool_call_id: toolId,
          content: truncateForStream(result.text, TOOL_RESULT_CONTEXT_LIMIT),
        });

        if (fatalError) break;
      }

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

import { runGemmaCodingAgent } from './_gemmaAgent';
import { AUTO_FIX_MAX_ATTEMPTS } from './_constants';
import {
  appendTurn,
  getHistory,
  getProjectState,
  saveProjectState,
} from './_memory';
import {
  createProjectState,
  createProjectArchive,
  getFileTree,
  readFileFromSandbox,
  runVerification,
  writeUploadedFiles,
  type SavedUploadedFile,
  type UploadedFileInput,
} from './_project';
import { autoSaveProjectSnapshot, restoreProjectSnapshotIfEmpty } from './_projectStore';
import { createLazyDaytonaSandboxAdapter } from './_daytonaSandbox';
import type {
  AgentProgressEvent,
  BuildStatus,
  FileTreeItem,
  ImageAttachment,
  ScaffoldLog,
  StreamSend,
} from './_types';
import { buildAutoFixPrompt } from './utils/_build-errors';
import { debugLog } from './utils/_debug';
import { normalizeRelPath } from './utils/_paths';
import { sanitizeAssistantText } from './utils/_text';

function stripReturnedPreviewLinks(text: string, previewUrl?: string) {
  if (!text || !previewUrl) {
    return text;
  }
  const escapedUrl = escapeRegExp(previewUrl);
  return text
    .replace(new RegExp(`\\s*\\[[^\\]]*(?:미리보기 열기|미리보기|preview)[^\\]]*\\]\\(${escapedUrl}\\)`, 'gi'), '')
    .replace(new RegExp(`\\s*${escapedUrl}`, 'g'), '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildRequirementConclusionFallback(
  request: string,
  status: 'pending' | 'ready' | 'generated',
) {
  const summary = summarizeUserRequest(request);
  const isKorean = /[\uac00-\ud7a3]/.test(request);

  if (isKorean) {
    if (status === 'ready') {
      return `요청하신 내용으로 만들었어요: ${summary}. 오른쪽 미리보기 패널에서 확인할 수 있어요.`;
    }
    if (status === 'generated') {
      return `요청하신 내용으로 프로젝트를 생성했어요: ${summary}.`;
    }
    return `요청을 처리했어요: ${summary}. 검증과 미리보기 결과를 준비하는 중이에요.`;
  }

  if (status === 'ready') {
    return `Built this for your request: ${summary}. The preview is ready in the right preview panel.`;
  }
  if (status === 'generated') {
    return `Generated the project for your request: ${summary}.`;
  }
  return `Handled your request: ${summary}. Verification and preview results are being prepared.`;
}

function summarizeUserRequest(request: string) {
  const normalized = request.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return 'your web project';
  }
  const maxLength = 80;
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength).trimEnd()}...`
    : normalized;
}

function isGenericCompletionReply(text: string) {
  const normalized = text.replace(/\s+/g, '').replace(/[.!?！？。]+$/g, '').toLowerCase();
  const genericPhrases = [
    '작성완료했습니다결과를확인해주세요',
    '작업완료했습니다결과를확인해주세요',
    '완료했습니다결과를확인해주세요',
    'donepleasecheck',
  ];
  return genericPhrases.includes(normalized)
    || /^theagentdidnotreturnanythingdisplayable$/i.test(normalized);
}

export function createStreamResponse(run: (send: StreamSend) => Promise<void>) {
  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream({
    start(controller) {
      const send: StreamSend = (event) => {
        if (closed) {
          return;
        }
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };

      run(send)
        .catch((error) => {
          send({
            type: 'error',
            error: error instanceof Error ? error.message : 'Request processing failed.',
          });
        })
        .finally(() => {
          closed = true;
          controller.close();
        });
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-content-type-stream': 'true',
    },
  });
}

function getRequestHeader(context: any, name: string): string {
  const headers = context?.request?.headers;
  if (!headers) return '';

  if (typeof headers.get === 'function') {
    return String(headers.get(name) || '');
  }

  const lowerName = name.toLowerCase();
  const value = headers[name] ?? headers[lowerName];
  return typeof value === 'string' ? value : String(value || '');
}

function queryValueToString(value: unknown): string {
  if (Array.isArray(value)) {
    return queryValueToString(value[0]);
  }
  if (value === undefined || value === null) {
    return '';
  }
  return typeof value === 'string' ? value : String(value);
}

function getSearchParamFromString(rawValue: unknown, name: string): string {
  if (typeof rawValue !== 'string' || !rawValue.trim()) {
    return '';
  }

  const raw = rawValue.trim();
  try {
    if (raw.startsWith('?')) {
      return new URLSearchParams(raw.slice(1)).get(name) || '';
    }
    if (raw.includes('?') || raw.startsWith('/') || /^https?:\/\//i.test(raw)) {
      return new URL(raw, 'http://local').searchParams.get(name) || '';
    }
    if (raw.includes('=')) {
      return new URLSearchParams(raw).get(name) || '';
    }
  } catch {
    return '';
  }

  return '';
}

function getRequestQueryParam(context: any, name: string): {
  value: string;
  source: string;
} {
  const request = context?.request || {};
  const stringFields = [
    'url',
    'path',
    'pathname',
    'search',
    'queryString',
    'rawUrl',
    'originalUrl',
  ];
  for (const field of stringFields) {
    const value = getSearchParamFromString(request[field], name);
    if (value) {
      return { value, source: `request.${field}` };
    }
  }

  const queryObjects = [
    { source: 'request.query', value: request.query },
    { source: 'request.params', value: request.params },
    { source: 'request.searchParams', value: request.searchParams },
    { source: 'context.query', value: context?.query },
    { source: 'context.params', value: context?.params },
  ];
  for (const query of queryObjects) {
    if (query.value && typeof query.value.get === 'function') {
      const value = query.value.get(name);
      if (value) {
        return { value: queryValueToString(value), source: query.source };
      }
      continue;
    }
    if (!query || typeof query !== 'object') continue;
    const value = query.value?.[name];
    const normalized = queryValueToString(value);
    if (normalized) {
      return { value: normalized, source: query.source };
    }
  }

  return { value: '', source: 'none' };
}

function getRequestDebugSnapshot(context: any): Record<string, unknown> {
  const request = context?.request || {};
  const snapshot: Record<string, unknown> = {
    requestKeys: Object.keys(request).slice(0, 24),
  };
  for (const field of ['url', 'path', 'pathname', 'search', 'queryString', 'rawUrl', 'originalUrl']) {
    if (typeof request[field] === 'string' && request[field]) {
      snapshot[field] = request[field].slice(0, 300);
    }
  }
  for (const field of ['query', 'params', 'searchParams']) {
    const value = request[field];
    if (value && typeof value === 'object') {
      snapshot[field] = typeof value.entries === 'function'
        ? Object.fromEntries(Array.from(value.entries() as Iterable<[PropertyKey, unknown]>).slice(0, 20))
        : Object.keys(value).slice(0, 20);
    }
  }
  return snapshot;
}

function maskConversationId(value: string): string {
  if (!value) return '<empty>';
  if (value.length <= 12) return `${value.slice(0, 2)}...${value.slice(-2)}`;
  return `${value.slice(0, 6)}...${value.slice(-6)}`;
}

// Returns a (possibly wrapped) context plus the resolved sandbox id -- the
// caller MUST reassign its local `context` variable to the returned one and
// use that from then on. A plain `context.sandbox = adapter` is not safe:
// the platform's own `context.sandbox` is a lazy getter-only accessor (it
// only calls out to EdgeOne's own quota-limited sandbox-acquire API the
// first time it's actually *read* -- see the runtime's LazySandbox/getClient
// pattern). If that accessor is non-configurable, a direct assignment either
// throws (silently swallowed by the try/catch below, leaving the original
// getter in place) or is a no-op -- either way every later `context.sandbox.*`
// call would keep falling through to the platform's own sandbox and hit
// SANDBOX_LIMIT_EXCEEDED, never actually reaching Daytona. Wrapping `context`
// in a Proxy sidesteps this: it intercepts `sandbox` get/set at the wrapper
// level regardless of how the underlying property was defined underneath,
// so it always works, independent of that implementation detail.
function attachDaytonaSandbox(
  context: any,
  conversationId: string,
  state: { daytonaSandboxId?: string | null },
): { context: any } {
  try {
    const existingSandboxId = state.daytonaSandboxId;
    // Lazy: this makes NO Daytona API call yet. The real sandbox is only
    // created/resumed the first time a tool actually touches
    // context.sandbox.* (see createLazyDaytonaSandboxAdapter) -- most chat
    // turns are plain questions the model answers directly per
    // buildGroqSystemPrompt and never need a sandbox at all, so this keeps
    // ordinary conversation from consuming the org's shared Daytona memory
    // quota (previously the #1 cause of "Total memory limit exceeded").
    const adapter = createLazyDaytonaSandboxAdapter(conversationId, existingSandboxId, (resolvedId) => {
      state.daytonaSandboxId = resolvedId;
      debugLog(context, '[sandbox]', {
        stage: 'daytona-resolved',
        sandboxId: resolvedId,
        reused: Boolean(existingSandboxId && existingSandboxId === resolvedId),
      });
    });
    const proxied = new Proxy(context, {
      get(target, prop, receiver) {
        if (prop === 'sandbox') return adapter;
        return Reflect.get(target, prop, receiver);
      },
      set(target, prop, value, receiver) {
        if (prop === 'sandbox') return true; // we own this slot now; ignore attempts to reset it
        return Reflect.set(target, prop, value, receiver);
      },
    });
    return { context: proxied };
  } catch (error) {
    console.warn('[sandbox]', {
      stage: 'daytona-attach-failed',
      error: error instanceof Error ? error.message : String(error || ''),
    });
    return { context };
  }
}

export async function runFileReadPipeline(context: any): Promise<Response> {
  const contextConversationId = String(context.conversation_id || '');
  const pagesHeaderConversationId = getRequestHeader(context, 'makers-conversation-id');
  const headerConversationId = getRequestHeader(context, 'conversationId');
  const conversationId = contextConversationId || pagesHeaderConversationId || headerConversationId;
  const conversationSource = contextConversationId
    ? 'context.conversation_id'
    : pagesHeaderConversationId
      ? 'makers-conversation-id'
      : headerConversationId
        ? 'conversationId'
        : 'none';
  const diagnosticBase = {
    contextConversationId: maskConversationId(contextConversationId),
    pagesHeaderConversationId: maskConversationId(pagesHeaderConversationId),
    headerConversationId: maskConversationId(headerConversationId),
    selectedConversationId: maskConversationId(conversationId),
    selectedConversationSource: conversationSource,
  };
  const pathParam = getRequestQueryParam(context, 'path');
  const relPath = pathParam.value;
  if (!conversationId) {
    debugLog(context, '[file-read]', {
      ...diagnosticBase,
      rawPath: relPath,
      pathSource: pathParam.source,
      normalizedPath: null,
      error: 'missing conversation_id',
    });
    return new Response(JSON.stringify({ ok: false, error: 'missing conversation_id' }), {
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }
  const norm = normalizeRelPath(relPath);
  if (!norm) {
    debugLog(context, '[file-read]', {
      ...diagnosticBase,
      rawPath: relPath,
      pathSource: pathParam.source,
      normalizedPath: null,
      error: 'invalid path',
      request: getRequestDebugSnapshot(context),
    });
    return new Response(JSON.stringify({ ok: false, error: 'invalid path' }), {
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }

  const state = await getProjectState(context, conversationId);
  {
    const sandboxAttach = attachDaytonaSandbox(context, conversationId, state);
    context = sandboxAttach.context;
  }
  debugLog(context, '[file-read]', {
    ...diagnosticBase,
    rawPath: relPath,
    pathSource: pathParam.source,
    normalizedPath: norm,
    appDir: state.appDir,
    stage: 'before-read',
  });
  const res = await readFileFromSandbox(context, state, norm);
  debugLog(context, '[file-read]', {
    ...diagnosticBase,
    normalizedPath: norm,
    appDir: state.appDir,
    ok: res.ok,
    error: res.error,
    size: res.size,
    truncated: res.truncated,
    stage: 'after-read',
  });
  return new Response(
    JSON.stringify({ path: norm, ...res }),
    { headers: { 'content-type': 'application/json; charset=utf-8' } },
  );
}

// Loads everything needed to resume a saved project when the user clicks it
// in the sidebar: chat history (already durable via context.store), the
// live/known preview + build state, and the file tree — restoring the saved
// Supabase snapshot into the sandbox first if this sandbox instance came up
// empty. conversationId comes from the same headers /chat and /file use;
// userId is required (this endpoint only serves signed-in users' own saved
// projects).
export async function runProjectDetailPipeline(context: any): Promise<Response> {
  const contextConversationId = String(context.conversation_id || '');
  const pagesHeaderConversationId = getRequestHeader(context, 'makers-conversation-id');
  const headerConversationId = getRequestHeader(context, 'conversationId');
  const conversationId = contextConversationId || pagesHeaderConversationId || headerConversationId;
  const body = context?.request?.body || {};
  const userId = typeof body?.userId === 'string' ? body.userId.trim() : '';

  const jsonError = (error: string, status = 400) => new Response(
    JSON.stringify({ ok: false, error }),
    { status, headers: { 'content-type': 'application/json; charset=utf-8' } },
  );

  if (!conversationId) {
    return jsonError('missing conversation_id');
  }
  if (!userId) {
    return jsonError('로그인이 필요합니다.', 401);
  }

  const state = await getProjectState(context, conversationId);
  {
    const sandboxAttach = attachDaytonaSandbox(context, conversationId, state);
    context = sandboxAttach.context;
  }
  await restoreProjectSnapshotIfEmpty(context, conversationId, userId, state);
  await saveProjectState(context, conversationId, state);

  const [history, tree] = await Promise.all([
    getHistory(context, conversationId),
    getFileTree(context, state).catch(() => [] as FileTreeItem[]),
  ]);

  return new Response(
    JSON.stringify({
      ok: true,
      conversation_id: conversationId,
      history,
      files: { root: state.appDir, items: tree },
      preview: {
        url: state.previewUrl,
        sandboxDebugUrl: state.sandboxDebugUrl,
      },
    }),
    { headers: { 'content-type': 'application/json; charset=utf-8' } },
  );
}

export async function runProjectDownloadPipeline(context: any): Promise<Response> {
  const contextConversationId = String(context.conversation_id || '');
  const pagesHeaderConversationId = getRequestHeader(context, 'makers-conversation-id');
  const headerConversationId = getRequestHeader(context, 'conversationId');
  // Query-param fallback so a plain navigation can still target the right
  // sandbox; the frontend prefers the headers.
  const queryConversationId = getRequestQueryParam(context, 'cid').value
    || getRequestQueryParam(context, 'conversationId').value;
  const conversationId = contextConversationId
    || pagesHeaderConversationId
    || headerConversationId
    || queryConversationId;

  const jsonError = (error: string, status = 400) => new Response(
    JSON.stringify({ ok: false, error }),
    { status, headers: { 'content-type': 'application/json; charset=utf-8' } },
  );

  if (!conversationId) {
    return jsonError('missing conversation_id');
  }

  const state = await getProjectState(context, conversationId);
  {
    const sandboxAttach = attachDaytonaSandbox(context, conversationId, state);
    context = sandboxAttach.context;
  }

  let archive;
  try {
    archive = await createProjectArchive(context, state);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to package the project.';
    return jsonError(message, 500);
  }

  if (!archive.ok) {
    return jsonError(archive.error, 409);
  }

  return new Response(
    JSON.stringify({
      ok: true,
      filename: archive.filename,
      contentType: archive.contentType,
      size: archive.size,
      base64: archive.base64,
    }),
    {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      },
    },
  );
}

const SUPPORTED_VISION_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const MAX_VISION_BASE64_CHARS = 6_000_000; // ~4.4MB decoded; Anthropic's practical per-image vision limit.

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function buildUploadsManifest(saved: SavedUploadedFile[]): string {
  if (saved.length === 0) return '';
  return saved
    .map((file) => `- ${file.relPath} (${file.mimeType}, ${formatBytes(file.sizeBytes)})${file.isImage ? ' [image, also attached for direct vision]' : ''}`)
    .join('\n');
}

export async function runChatPipeline(
  context: any,
  message: string,
  send: StreamSend,
  options: { resetProject?: boolean; files?: UploadedFileInput[]; userId?: string } = {},
) {
  const contextConversationId = String(context.conversation_id || '');
  const pagesHeaderConversationId = getRequestHeader(context, 'makers-conversation-id');
  const headerConversationId = getRequestHeader(context, 'conversationId');
  const conversationId = contextConversationId || pagesHeaderConversationId || headerConversationId;
  const incomingFiles = Array.isArray(options.files) ? options.files : [];
  const loggedInUserId = typeof options.userId === 'string' ? options.userId.trim() : '';

  // Full-conversation + tool-use logging into the Makers Agent framework's
  // built-in context.store, gated to signed-in users only. Best-effort and
  // non-blocking so a storage hiccup never breaks the live chat stream.
  const logHistory = (role: 'user' | 'assistant' | 'tool', content: string, metadata: Record<string, unknown>) => {
    if (!loggedInUserId || typeof context.store?.appendMessage !== 'function') {
      return;
    }
    Promise.resolve(
      context.store.appendMessage({
        conversationId,
        role,
        content,
        metadata,
        userId: loggedInUserId,
      }),
    ).catch(() => {});
  };

  if (!message && incomingFiles.length === 0) {
    send({
      type: 'result',
      data: {
        ok: false,
        conversation_id: conversationId,
        reply: 'Please describe the page or feature you want to build first.',
        build: { status: 'skipped' as BuildStatus },
        preview: {},
      },
    });
    return;
  }

  const effectiveMessage = message || 'Please look at the attached file(s) and use them as needed.';

  logHistory('user', effectiveMessage, {
    hasFiles: incomingFiles.length > 0,
    fileNames: incomingFiles.map((file) => file.name),
  });

  if (!conversationId) {
    send({
      type: 'result',
      data: {
        ok: false,
        conversation_id: '',
        reply: 'Missing conversationId. The project workspace cannot be prepared.',
        build: { status: 'skipped' as BuildStatus },
        preview: {},
      },
    });
    return;
  }

  send({
    type: 'status',
    message: 'Running the agent workflow',
  });

  // Anonymous (not logged-in) users never get a persistent sandbox: force a
  // fresh project workspace every turn so nothing survives after they leave.
  const shouldResetProject = options.resetProject === true || !loggedInUserId;
  const state = shouldResetProject
    ? createProjectState(conversationId)
    : await getProjectState(context, conversationId);
  {
    if (shouldResetProject) {
      state.daytonaSandboxId = undefined;
    }
    const sandboxAttach = attachDaytonaSandbox(context, conversationId, state);
    context = sandboxAttach.context;
  }
  if (shouldResetProject) {
    // Deferred: the actual sandbox wipe now happens lazily inside
    // ensureProjectScaffold, only if/when the model decides this turn
    // needs a project tool at all (see the forceReset flag on ProjectState).
    state.forceReset = true;
  } else if (loggedInUserId) {
    // This conversation's sandbox instance may have been recycled since the
    // user's last visit; silently rehydrate their saved files before the
    // agent looks at the workspace.
    await restoreProjectSnapshotIfEmpty(context, conversationId, loggedInUserId, state);
  }
  const history = shouldResetProject ? [] : await getHistory(context, conversationId);
  const isInitialProjectTurn = !state.created;
  const hiddenScaffoldToolUseIds = new Set<string>();

  const handleScaffoldLog = (log: ScaffoldLog) => {
    if (!isInitialProjectTurn) {
      return;
    }
    send({
      type: 'log',
      phase: 'scaffold',
      stream: log.stream,
      message: log.content,
    });
  };
  const forwardProgress = (event: AgentProgressEvent) => {
    // Forward structured progress events directly; the frontend renders by type.
    if (event.type === 'tool_use') {
      logHistory('tool', JSON.stringify({ name: event.data.name, command: event.data.command }), {
        type: 'tool_use',
        toolUseId: event.data.id,
        phaseHint: event.data.phaseHint,
      });
    }
    if (event.type === 'tool_result') {
      logHistory('tool', event.data.preview, {
        type: 'tool_result',
        toolUseId: event.data.tool_use_id,
        toolName: event.data.toolName,
        ok: event.data.ok,
      });
    }
    if (
      !isInitialProjectTurn
      && event.type === 'tool_use'
      && (event.data.name === 'ensure_project_scaffold' || event.data.name.endsWith('__ensure_project_scaffold'))
    ) {
      hiddenScaffoldToolUseIds.add(event.data.id);
      return;
    }
    if (!isInitialProjectTurn && event.type === 'tool_result' && hiddenScaffoldToolUseIds.has(event.data.tool_use_id)) {
      return;
    }
    if (event.type === 'text_segment') {
      const text = state.previewUrl
        ? stripReturnedPreviewLinks(event.data.text, state.previewUrl)
        : event.data.text;
      if (text.length === 0) {
        return;
      }
      send({
        ...event,
        data: {
          ...event.data,
          text,
        },
      } as unknown as Record<string, unknown>);
      return;
    }
    send(event as unknown as Record<string, unknown>);
  };
  const pushFileTree = async (fallbackMessage: string): Promise<FileTreeItem[]> => {
    try {
      const tree = await getFileTree(context, state);
      send({
        type: 'file_tree',
        data: {
          root: state.appDir,
          items: tree,
        },
      });
      return tree;
    } catch (error) {
      send({
        type: 'log',
        phase: 'agent',
        stream: 'stderr',
        message: error instanceof Error ? error.message : fallbackMessage,
      });
      return [];
    }
  };
  const pushEarlyFileTree = async () => {
    // Push file_tree as soon as scaffold succeeds so the Files panel does not
    // have to wait for the whole turn. Failures are non-fatal because the final
    // state is pushed again at turn completion.
    await pushFileTree('Failed to read the file list after scaffold.');
  };

  // The model handles creative code work; build and service steps remain deterministic.
  const savedUploads = await writeUploadedFiles(context, state, incomingFiles);
  const uploadsManifest = buildUploadsManifest(savedUploads);
  const imageAttachments: ImageAttachment[] = [];
  for (let i = 0; i < incomingFiles.length; i += 1) {
    const file = incomingFiles[i];
    const saved = savedUploads[i];
    const mimeType = (saved?.mimeType || file.mimeType || '').toLowerCase();
    const base64 = String(file.dataBase64 || '').replace(/\s+/g, '');
    if (
      saved?.isImage
      && SUPPORTED_VISION_MIME_TYPES.has(mimeType)
      && base64.length > 0
      && base64.length <= MAX_VISION_BASE64_CHARS
    ) {
      imageAttachments.push({
        mediaType: mimeType as ImageAttachment['mediaType'],
        base64,
      });
    }
  }

  const modelResult = await runGemmaCodingAgent(
    context,
    conversationId,
    effectiveMessage,
    history,
    state,
    !state.created,
    handleScaffoldLog,
    forwardProgress,
    pushEarlyFileTree,
    uploadsManifest,
    imageAttachments,
  );
  const sanitizedModelOutput = modelResult.success && modelResult.output
    ? sanitizeAssistantText(modelResult.output)
    : '';
  const modelOutput = sanitizedModelOutput && !isGenericCompletionReply(sanitizedModelOutput)
    ? sanitizedModelOutput
    : '';
  const fallbackReply = modelResult.success
    ? buildRequirementConclusionFallback(effectiveMessage, state.previewUrl ? 'ready' : 'pending')
    : (modelResult.error || 'An error occurred during processing. Please try again.');
  const assistantReply = stripReturnedPreviewLinks(sanitizeAssistantText(
    modelOutput || fallbackReply
  ) || fallbackReply, state.previewUrl);

  send({
    type: 'agent',
    data: {
      ok: modelResult.success,
      reply: assistantReply,
      ...(modelResult.error ? { error: modelResult.error } : {}),
    },
  });

  if (modelResult.fatal) {
    await appendTurn(context, conversationId, 'user', effectiveMessage);
    await appendTurn(context, conversationId, 'assistant', assistantReply);
    logHistory('assistant', assistantReply, {});
    await saveProjectState(context, conversationId, state);
    if (loggedInUserId) {
      await autoSaveProjectSnapshot(context, conversationId, loggedInUserId, state, effectiveMessage);
    }

    send({
      type: 'result',
      data: {
        ok: false,
        reply: assistantReply,
        conversation_id: conversationId,
        build: {
          status: 'skipped' as BuildStatus,
          stderr: modelResult.error || assistantReply,
        },
        preview: {},
      },
    });
    return;
  }

  if (!modelResult.projectTouched && modelResult.previewTouched) {
    if (state.previewUrl) {
      send({
        type: 'preview_ready',
        data: {
          preview: {
            url: state.previewUrl,
            sandboxDebugUrl: state.sandboxDebugUrl,
          },
        },
      });
    }

    await appendTurn(context, conversationId, 'user', effectiveMessage);
    await appendTurn(context, conversationId, 'assistant', assistantReply);
    logHistory('assistant', assistantReply, {});
    await saveProjectState(context, conversationId, state);
    if (loggedInUserId) {
      await autoSaveProjectSnapshot(context, conversationId, loggedInUserId, state, effectiveMessage);
    }

    send({
      type: 'result',
      data: {
        ok: modelResult.success && Boolean(state.previewUrl),
        reply: assistantReply,
        conversation_id: conversationId,
        build: { status: 'skipped' as BuildStatus },
        preview: {
          url: state.previewUrl,
          sandboxDebugUrl: state.sandboxDebugUrl,
          ...(!state.previewUrl ? { error: 'The agent did not complete publish_preview.' } : {}),
        },
      },
    });
    return;
  }

  if (!modelResult.projectTouched) {
    await appendTurn(context, conversationId, 'user', effectiveMessage);
    await appendTurn(context, conversationId, 'assistant', assistantReply);
    logHistory('assistant', assistantReply, {});

    send({
      type: 'result',
      data: {
        ok: modelResult.success,
        reply: assistantReply,
        conversation_id: conversationId,
        build: { status: 'skipped' as BuildStatus },
        preview: {},
      },
    });
    return;
  }

  let fileTree = await pushFileTree('Failed to read the file list.');
  let build = await runVerification(context, state);
  let autoFixAttempts = 0;
  let autoFixApplied = false;
  let autoFixReply = '';

  // The project has files on disk from here on, so expose a download link. The
  // archive is built on demand by /download; this is just a pointer (the
  // authoritative filename comes from the /download response).
  const downloadLink = { url: '/download', filename: 'source.zip' };

  if (build.fatal) {
    const fatalReply = build.stderr || 'The task failed, and the remaining workflow was stopped.';
    await appendTurn(context, conversationId, 'user', effectiveMessage);
    await appendTurn(context, conversationId, 'assistant', fatalReply);
    logHistory('assistant', fatalReply, {});
    await saveProjectState(context, conversationId, state);
    if (loggedInUserId) {
      await autoSaveProjectSnapshot(context, conversationId, loggedInUserId, state, effectiveMessage);
    }

    send({
      type: 'result',
      data: {
        ok: false,
        reply: fatalReply,
        conversation_id: conversationId,
        project: {
          dir: state.appDir,
          created: modelResult.wasCreated,
        },
        build,
        files: {
          root: state.appDir,
          items: fileTree,
        },
        download: downloadLink,
        preview: {},
      },
    });
    return;
  }

  if (build.status === 'failed' && modelResult.success) {
    autoFixAttempts = AUTO_FIX_MAX_ATTEMPTS;
    autoFixApplied = true;
    send({
      type: 'status',
      message: `Verification failed. Running auto-fix 1/${AUTO_FIX_MAX_ATTEMPTS}`,
    });

    const autoFixPrompt = buildAutoFixPrompt(
      effectiveMessage,
      assistantReply,
      build,
      1,
      AUTO_FIX_MAX_ATTEMPTS,
    );
    const autoFixResult = await runGemmaCodingAgent(
      context,
      conversationId,
      autoFixPrompt,
      [
        ...history,
        { role: 'user', content: effectiveMessage },
        { role: 'assistant', content: assistantReply },
      ],
      state,
      false,
      handleScaffoldLog,
      forwardProgress,
      pushEarlyFileTree,
    );
    autoFixReply = stripReturnedPreviewLinks(sanitizeAssistantText(
      autoFixResult.success && autoFixResult.output
        ? autoFixResult.output
        : autoFixResult.error || ''
    ), state.previewUrl);

    if (autoFixReply) {
      send({
        type: 'agent',
        data: {
          ok: autoFixResult.success,
          reply: autoFixReply,
          ...(autoFixResult.error ? { error: autoFixResult.error } : {}),
        },
      });
    }

    fileTree = await pushFileTree('Failed to read the file list after auto-fix.');
    build = await runVerification(context, state);
    if (build.fatal) {
      const fatalReply = build.stderr || 'The task failed, and the remaining workflow was stopped.';
      await appendTurn(context, conversationId, 'user', effectiveMessage);
      await appendTurn(context, conversationId, 'assistant', fatalReply);
      logHistory('assistant', fatalReply, {});
      await saveProjectState(context, conversationId, state);
      if (loggedInUserId) {
        await autoSaveProjectSnapshot(context, conversationId, loggedInUserId, state, effectiveMessage);
      }

      send({
        type: 'result',
        data: {
          ok: false,
          reply: fatalReply,
          conversation_id: conversationId,
          project: {
            dir: state.appDir,
            created: modelResult.wasCreated,
          },
          build,
          files: {
            root: state.appDir,
            items: fileTree,
          },
          download: downloadLink,
          preview: {},
        },
      });
      return;
    }
  }

  build = {
    ...build,
    ...(autoFixAttempts > 0 ? { autoFixAttempts, autoFixApplied } : {}),
  };

  // Preview startup, HTTP readiness checks, and link generation are handled by publish_preview.
  // publish_preview, or the legacy get_preview_link alias, writes state.previewUrl / state.sandboxDebugUrl.
  if (state.previewUrl) {
    send({
      type: 'preview_ready',
      data: {
        preview: {
          url: state.previewUrl,
          sandboxDebugUrl: state.sandboxDebugUrl,
        },
      },
    });
  }

  const autoFixSuffix = autoFixAttempts > 0
    ? build.status === 'success'
      ? ` Auto-fix ran ${autoFixAttempts} time(s) based on the verification error, and verification now passes.`
      : ` Auto-fix ran ${autoFixAttempts} time(s), but verification still fails. The final logs are preserved for further debugging.`
    : '';
  const buildFailedSuffix = build.status === 'failed' && autoFixAttempts === 0
    ? ' Verification currently fails, so I did not describe the update as successful. Please continue debugging from the logs.'
    : '';
  const missingPreviewSuffix = state.previewUrl
    ? ''
    : ' No preview link was obtained. Please continue by asking the agent to call publish_preview.';
  const finalFallbackReply = buildRequirementConclusionFallback(
    effectiveMessage,
    build.status !== 'failed' && state.previewUrl ? 'ready' : 'generated',
  );
  const baseReply = autoFixReply || (modelOutput ? assistantReply : finalFallbackReply);
  const reply = stripReturnedPreviewLinks(
    `${baseReply}${autoFixSuffix}${buildFailedSuffix}${missingPreviewSuffix}`,
    state.previewUrl,
  );

  // Append this turn first, which also creates the conversation, then write projectState to metadata.
  await appendTurn(context, conversationId, 'user', effectiveMessage);
  await appendTurn(context, conversationId, 'assistant', reply);
  logHistory('assistant', reply, {});
  await saveProjectState(context, conversationId, state);
  if (loggedInUserId) {
    await autoSaveProjectSnapshot(context, conversationId, loggedInUserId, state, effectiveMessage);
  }

  send({
    type: 'result',
    data: {
      ok: modelResult.success && build.status !== 'failed' && Boolean(state.previewUrl),
      reply,
      conversation_id: conversationId,
      project: {
        dir: state.appDir,
        created: modelResult.wasCreated,
      },
      build,
      files: {
        root: state.appDir,
        items: fileTree,
      },
      download: downloadLink,
      preview: {
        url: state.previewUrl,
        sandboxDebugUrl: state.sandboxDebugUrl,
        ...(!state.previewUrl ? { error: 'The agent did not complete publish_preview.' } : {}),
      },
    },
  });
}

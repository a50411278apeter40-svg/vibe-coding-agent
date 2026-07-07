'use client';

import { FormEvent, memo, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { sanitizeAssistantText } from '../agents/utils/_text';

type TimelineStep =
  | { kind: 'status'; text: string }
  | { kind: 'modify_marker' }
  | { kind: 'tool_use'; id: string; name: string; command?: string; phaseHint?: NormalizedStepPhase; fileCount?: number }
  | { kind: 'tool_result'; toolUseId: string; toolName?: string; command?: string; ok: boolean; preview: string }
  | { kind: 'log'; stream: 'stdout' | 'stderr' | 'status'; text: string }
  | { kind: 'error'; text: string };

type AssistantStatus = 'running' | 'done' | 'error';
type NormalizedStepStatus = 'waiting' | 'running' | 'done' | 'error';
type NormalizedStepPhase = 'scaffold' | 'modify' | 'code' | 'install' | 'preview' | 'link';

type NormalizedStep = {
  phase: NormalizedStepPhase;
  title: string;
  status: NormalizedStepStatus;
  summary: string;
};

type ProcessEvent =
  | { kind: 'thinking'; content: string }
  | { kind: 'step'; phase: NormalizedStepPhase; step: NormalizedStep };

type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  thinkingContent?: string;
  processEvents?: ProcessEvent[];
  steps?: TimelineStep[];
  status?: AssistantStatus;
};

type BuildInfo = {
  status: 'success' | 'failed' | 'skipped';
  stdout?: string;
  stderr?: string;
  autoFixAttempts?: number;
  autoFixApplied?: boolean;
};

type LinkInfo = {
  url?: string;
  sandboxDebugUrl?: string;
  filename?: string;
  error?: string;
};

type InitLog = {
  stream: 'status' | 'stdout' | 'stderr';
  content: string;
};

type AttachedFile = {
  id: string;
  name: string;
  mimeType: string;
  sizeLabel: string;
  dataBase64: string;
};

type AuthUser = {
  id: string;
  email: string;
  username: string;
  name: string;
};

type FileTreeItem = {
  path: string;
  name: string;
  type: 'file' | 'directory';
  depth: number;
};

type FileTree = {
  root: string;
  items: FileTreeItem[];
};

type ChatResponse = {
  ok?: boolean;
  reply?: string;
  conversation_id?: string;
  build?: BuildInfo;
  files?: FileTree;
  preview?: LinkInfo;
  download?: LinkInfo;
  error?: string;
};

type ChatStreamEvent =
  | {
      type: 'status';
      message?: string;
    }
  | {
      type: 'result';
      data?: ChatResponse;
    }
  | {
      type: 'agent';
      data?: Pick<ChatResponse, 'ok' | 'reply' | 'error'>;
    }
  | {
      type: 'file_tree';
      data?: FileTree;
    }
  | {
      type: 'preview_ready';
      data?: {
        preview?: LinkInfo;
        download?: LinkInfo;
      };
    }
  | {
      type: 'tool_use';
      data?: {
        id?: string;
        name?: string;
        command?: string;
        phaseHint?: NormalizedStepPhase;
        fileCount?: number;
      };
    }
  | {
      type: 'tool_result';
      data?: {
        tool_use_id?: string;
        toolName?: string;
        command?: string;
        ok?: boolean;
        preview?: string;
      };
    }
  | {
      type: 'text_segment';
      data?: {
        uuid?: string;
        text?: string;
      };
    }
  | {
      type: 'error';
      error?: string;
    }
  | {
      type: 'log';
      phase?: 'scaffold' | 'agent';
      stream?: InitLog['stream'];
      message?: string;
    };

type Locale = 'ko' | 'en';

const LANGUAGE_STORAGE_KEY = 'web-dev-agent-language';
const EDGEONE_AI_DEPLOY_URL = 'https://edgeone.ai/makers/new?template=vibe-coding-agent&from=within&fromAgent=1&agentLang=typescript';
const TENCENT_CLOUD_DEPLOY_URL = 'https://console.cloud.tencent.com/edgeone/makers/new?template=vibe-coding-agent&from=within&fromAgent=1&agentLang=typescript';
const PHASE_ORDER: NormalizedStepPhase[] = ['scaffold', 'modify', 'code', 'install', 'preview', 'link'];
const TYPEWRITER_INTERVAL_MS = 18;
const TYPEWRITER_CHARS_PER_TICK = 3;
const NARRATION_TYPEWRITER_INTERVAL_MS = 34;
const NARRATION_TYPEWRITER_CHARS_PER_TICK = 1;
const PROCESS_STEP_REVEAL_DELAY_MS = 420;

const TRANSLATIONS = {
  ko: {
    languageToggleLabel: 'English',
    languageToggleAria: 'Switch language to English',
    deployLabel: '원클릭 배포',
    home: {
      titleBefore: '오늘은 무엇을',
      titleAccent: '만들어',
      titleAfter: '볼까요?',
      subtitle: '대략적인 아이디어를 완성도 높은 앱, 사이트, 프로토타입으로 만들어 드려요.',
      placeholder: '만들고 싶은 것을 입력해 주세요',
      buildNow: '지금 만들기',
      building: '만드는 중...',
      examples: [
        '깔끔하고 쓰기 편한 할 일 목록 만들기',
        '제품 디자이너를 위한 포트폴리오 사이트 만들기',
        '통계와 테마 전환 기능이 있는 뽀모도로 타이머 만들기',
      ],
    },
    response: {
      noDisplay: '작업이 완료되었어요. 결과를 확인해 주세요.',
      requestFailedPrefix: '요청 실패: ',
      unknownError: '알 수 없는 오류',
      agentFlowEnded: 'Agent 작업이 종료되었어요.',
      processingFailed: '요청 처리에 실패했어요.',
    },
    workspace: {
      conversationEyebrow: '대화',
      buildThread: '빌드 스레드',
      hideSteps: '숨기기',
      viewSteps: '보기',
      steps: '과정',
      keepThinking: '생각 과정 유지',
      changePlaceholder: '수정하고 싶은 내용을 입력해 주세요',
      send: '보내기',
      sandboxEyebrow: '샌드박스',
      livePreview: '실시간 미리보기',
      files: '파일',
      preview: '미리보기',
      downloadSource: '소스코드 다운로드',
      downloading: '압축 중...',
      downloadFailed: '다운로드에 실패했어요. 다시 시도해 주세요.',
      loadingPreview: '실시간 미리보기를 불러오는 중...',
      previewEmpty: '첫 빌드가 끝나면 이곳에 미리보기가 표시돼요.',
      constructionDisclaimer: '현재는 템플릿 데모용 흐름이라 모델 품질이 낮을 수 있어요. 간단히 배포한 뒤 원하는 모델로 교체해 주세요.',
      previewError: '미리보기 오류: ',
      downloadError: '다운로드 오류: ',
      buildFailedMessage: '빌드에 실패했어요. 디버깅을 위해 현재 파일은 소스 패키지에 그대로 남아있어요.',
      buildFailedAfter: (attempts: number) =>
        `자동 수정을 ${attempts}번 시도했지만 빌드가 여전히 실패했어요. 디버깅을 위해 현재 파일은 그대로 남아있어요.`,
      previewLinkReady: '미리보기 링크를 가져왔어요.',
      previewLinkMissing: '미리보기 링크가 반환되지 않았어요.',
    },
    timeline: {
      empty: 'Agent 응답을 기다리는 중...',
      processing: '처리 중...',
      statusLabels: {
        waiting: '대기 중',
        running: '진행 중',
        done: '완료',
        error: '실패',
      },
      definitions: {
        scaffold: { title: '샌드박스 초기화', waiting: '프로젝트 작업 공간 준비 대기' },
        modify: { title: '수정 시작', waiting: '프로젝트 파일 수정 준비 중' },
        code: { title: '코드 작성', waiting: '프로젝트 파일 생성/수정 대기' },
        install: { title: '의존성 설치', waiting: '프로젝트 의존성 설치 대기' },
        preview: { title: '미리보기 시작', waiting: '로컬 미리보기 서버 시작 대기' },
        link: { title: '링크 가져오기', waiting: '미리보기 링크 가져오기 대기' },
      },
      summaries: {
        scaffoldRunning: '프로젝트 작업 공간을 준비하는 중',
        scaffoldExisting: '기존 프로젝트 작업 공간을 재사용했어요',
        scaffoldCreated: '빈 프로젝트 작업 공간을 준비했어요',
        scaffoldReady: '샌드박스 작업 공간 준비 완료',
        modifyStarted: '프로젝트 파일 수정을 시작했어요',
        codeAutoFix: '검증 결과를 바탕으로 프로젝트 코드를 수정하는 중',
        codeRunningUpdate: '프로젝트 파일을 업데이트하는 중',
        codeWritingFiles: (count: number) => `프로젝트 파일 ${count}개를 작성하는 중`,
        codeUpdated: '프로젝트 파일을 업데이트했어요',
        codeUpdatedFiles: (count: number) => `프로젝트 파일 ${count}개를 업데이트했어요`,
        installRunning: '프로젝트 의존성을 설치하는 중',
        installDone: '프로젝트 의존성 설치 완료',
        installFailed: '의존성 설치 실패',
        commandFailed: (command: string, detail: string) => `명령 실패: ${command}${detail ? `. ${detail}` : ''}`,
        previewRunning: '로컬 미리보기 서버를 시작하는 중',
        previewWarmup: '미리보기 페이지를 준비하는 중',
        previewStarted: '미리보기 서버가 시작되었어요',
        previewReady: '미리보기 서버에 접속할 수 있어요',
        previewFailed: '미리보기 실패',
        linkRunning: '미리보기 링크를 가져오는 중',
        linkDone: '미리보기 링크를 가져왔어요',
        linkDoneNoUrl: '미리보기 링크 가져오기를 완료했어요',
        linkMissing: '미리보기 링크가 반환되지 않았어요',
        processFailed: '처리 실패',
        stepFailed: (title: string) => `${title} 실패`,
        unknownStep: '단계',
      },
    },
    files: {
      empty: '아직 파일이 없어요.',
      refreshing: '업데이트 중...',
      selectFile: '왼쪽에서 파일을 선택하면 내용을 미리 볼 수 있어요.',
      loading: (path: string) => `${path} 불러오는 중...`,
      readFailed: '읽기 실패',
      requestFailed: '요청 실패',
      lines: (count: number) => `${count}줄`,
      truncated: '생략됨',
    },
    attach: {
      attachFile: '파일 첨부',
      attachAria: '파일 첨부하기',
      removeFile: '제거',
      errorGeneric: '파일을 읽는 중 오류가 발생했어요.',
    },
  },
  en: {
    languageToggleLabel: '한국어',
    languageToggleAria: 'Switch language to Korean',
    deployLabel: 'Deploy',
    home: {
      titleBefore: 'What will you',
      titleAccent: 'create',
      titleAfter: 'today?',
      subtitle: 'Turn a rough idea into a polished app, site, or prototype.',
      placeholder: "Let's build a",
      buildNow: 'Build now',
      building: 'Building...',
      examples: [
        'Build a SaaS dashboard for an analytics startup',
        'Create a portfolio site for a product designer',
        'Make a Pomodoro timer with stats and themes',
      ],
    },
    response: {
      noDisplay: 'The agent did not return anything displayable.',
      requestFailedPrefix: 'Request failed: ',
      unknownError: 'unknown error',
      agentFlowEnded: 'Agent flow has ended.',
      processingFailed: 'Request processing failed.',
    },
    workspace: {
      conversationEyebrow: 'Conversation',
      buildThread: 'Build thread',
      hideSteps: 'Hide',
      viewSteps: 'View',
      steps: 'process',
      keepThinking: 'Keep thinking',
      changePlaceholder: 'Ask for a change',
      send: 'Send',
      sandboxEyebrow: 'Sandbox',
      livePreview: 'Live preview',
      files: 'Files',
      preview: 'Preview',
      downloadSource: 'Download source',
      downloading: 'Packaging...',
      downloadFailed: 'Download failed, please retry.',
      loadingPreview: 'Loading live preview...',
      previewEmpty: 'Preview will appear after the first build finishes.',
      constructionDisclaimer: 'This is only a template demo flow. Model quality may be limited; replace it with your own model after simple deployment.',
      previewError: 'Preview error: ',
      downloadError: 'Download error: ',
      buildFailedMessage: 'Build failed. The source package still keeps the current files for debugging.',
      buildFailedAfter: (attempts: number) =>
        `Build failed after ${attempts} auto-fix attempt${attempts === 1 ? '' : 's'}. The source package still keeps the current files for debugging.`,
      previewLinkReady: 'Preview link found.',
      previewLinkMissing: 'Preview link was not returned.',
    },
    timeline: {
      empty: 'Waiting for agent response...',
      processing: 'Processing...',
      statusLabels: {
        waiting: 'waiting',
        running: 'running',
        done: 'done',
        error: 'error',
      },
      definitions: {
        scaffold: { title: 'Initialize sandbox', waiting: 'Waiting to prepare the project workspace' },
        modify: { title: 'Start modifying', waiting: 'Preparing to update project files' },
        code: { title: 'Write code', waiting: 'Waiting to generate or update project files' },
        install: { title: 'Install dependencies', waiting: 'Waiting to install project dependencies' },
        preview: { title: 'Start preview', waiting: 'Waiting to start the local preview server' },
        link: { title: 'Get link', waiting: 'Waiting to get the preview link' },
      },
      summaries: {
        scaffoldRunning: 'Preparing the project workspace',
        scaffoldExisting: 'Reused the existing project workspace',
        scaffoldCreated: 'Prepared an empty project workspace',
        scaffoldReady: 'Sandbox workspace is ready',
        modifyStarted: 'Started updating project files',
        codeAutoFix: 'Fixing project code based on validation results',
        codeRunningUpdate: 'Updating project files',
        codeWritingFiles: (count: number) => `Writing ${count} project file${count === 1 ? '' : 's'}`,
        codeUpdated: 'Updated project files',
        codeUpdatedFiles: (count: number) => `Updated ${count} project file${count === 1 ? '' : 's'}`,
        installRunning: 'Installing project dependencies',
        installDone: 'Project dependencies installed',
        installFailed: 'Dependency installation failed',
        commandFailed: (command: string, detail: string) => `Command failed: ${command}${detail ? `. ${detail}` : ''}`,
        previewRunning: 'Starting the local preview server',
        previewWarmup: 'Warming up the preview page',
        previewStarted: 'Preview server started',
        previewReady: 'Preview server is reachable',
        previewFailed: 'Preview failed',
        linkRunning: 'Getting the preview link',
        linkDone: 'Preview link retrieved',
        linkDoneNoUrl: 'Finished getting the preview link',
        linkMissing: 'Preview link was not returned',
        processFailed: 'Processing failed',
        stepFailed: (title: string) => `${title} failed`,
        unknownStep: 'Step',
      },
    },
    files: {
      empty: 'No files captured yet.',
      refreshing: 'Refreshing...',
      selectFile: 'Select a file from the left to preview its contents.',
      loading: (path: string) => `Loading ${path}...`,
      readFailed: 'Read failed',
      requestFailed: 'Request failed',
      lines: (count: number) => `${count} line${count === 1 ? '' : 's'}`,
      truncated: 'truncated',
    },
    attach: {
      attachFile: 'Attach files',
      attachAria: 'Attach files',
      removeFile: 'Remove',
      errorGeneric: 'Something went wrong while reading the file.',
    },
  },
} as const;

type UiCopy = (typeof TRANSLATIONS)[Locale];
type TimelineCopy = UiCopy['timeline'];
type FileCopy = UiCopy['files'];

const CONVERSATION_STORAGE_KEY = 'web-dev-agent-conversation-id';

function createConversationId() {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `conversation-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function extractProjectName() {
  if (typeof window === 'undefined') {
    return {
      projectName: '',
      domain: '',
    };
  }

  var fullUrl = window.location.href;
  var urlObject = new URL(fullUrl);
  var hostname = urlObject.hostname;
  var parts = hostname.split('.');
  return {
    projectName: parts[0].replace('-zh', ''),
    domain: parts.slice(1).join('.'),
  };
}

function getDeployUrl(domain: string) {
  return domain === 'edgeone.dev' ? EDGEONE_AI_DEPLOY_URL : TENCENT_CLOUD_DEPLOY_URL;
}

// Decode a base64 string into a Blob. The source archive arrives base64-encoded
// inside a JSON envelope (the agent proxy only transports text reliably).
function base64ToBlob(base64: string, contentType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: contentType });
}

function getOrCreateCachedConversationId() {
  if (typeof window === 'undefined') {
    return createConversationId();
  }

  const stored = window.localStorage.getItem(CONVERSATION_STORAGE_KEY)?.trim();
  if (stored) {
    return stored;
  }

  const next = createConversationId();
  window.localStorage.setItem(CONVERSATION_STORAGE_KEY, next);
  return next;
}

function cacheConversationId(value: string) {
  const trimmed = value.trim();
  if (!trimmed || typeof window === 'undefined') {
    return;
  }
  window.localStorage.setItem(CONVERSATION_STORAGE_KEY, trimmed);
}

const AUTH_USER_STORAGE_KEY = 'pixal-auth-user';

function getCachedAuthUser(): AuthUser | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(AUTH_USER_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.id === 'string') {
      return parsed as AuthUser;
    }
    return null;
  } catch {
    return null;
  }
}

function cacheAuthUser(user: AuthUser | null) {
  if (typeof window === 'undefined') {
    return;
  }
  if (!user) {
    window.localStorage.removeItem(AUTH_USER_STORAGE_KEY);
    return;
  }
  window.localStorage.setItem(AUTH_USER_STORAGE_KEY, JSON.stringify(user));
}

function formatAttachedFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('파일을 읽지 못했어요.'));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('파일을 읽지 못했어요.'));
        return;
      }
      // result is a data URL like "data:<mime>;base64,<data>" — keep only the payload.
      const commaIndex = result.indexOf(',');
      resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

function createMessageId(role: ChatMessage['role']) {
  return `${role}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function sanitizeThinkingContent(value: string) {
  return value
    .replace(/\x1b\[[0-9;?]*[~A-Za-z]/g, '')
    .replace(/\[20[01]~/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .replace(/<think\b[^>]*>/gi, '')
    .replace(/<\/think>/gi, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .replace(/<t(?:h(?:i(?:n(?:k(?:\b[^>]*)?)?)?)?)?$/i, '');
}

function getAssistantScrollSignature(message: ChatMessage) {
  const events = message.processEvents ?? [];
  const processSignature = events.map((event) =>
    event.kind === 'thinking'
      ? `thinking:${event.content}`
      : `step:${event.phase}:${event.step.status}:${event.step.summary}`,
  ).join('\u001e');
  return [
    message.status || '',
    message.content,
    events.length,
    processSignature,
  ].join('\u001f');
}

export default function Home() {
  const [language, setLanguage] = useState<Locale>('ko');
  const [deployUrl, setDeployUrl] = useState(TENCENT_CLOUD_DEPLOY_URL);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [preview, setPreview] = useState<LinkInfo | null>(null);
  const [download, setDownload] = useState<LinkInfo | null>(null);
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [build, setBuild] = useState<BuildInfo | null>(null);
  const [loading, setLoading] = useState(false);
  // Per-assistant-message progress expansion state. The running message is
  // expanded while active, then collapsed by default.
  const [openSteps, setOpenSteps] = useState<Record<string, boolean>>({});
  const [showProcessThinking, setShowProcessThinking] = useState(true);
  const [sandboxTab, setSandboxTab] = useState<'preview' | 'files'>('preview');
  const [fileTree, setFileTree] = useState<FileTree | null>(null);
  const [filesRefreshing, setFilesRefreshing] = useState(false);
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [activePreviewUrl, setActivePreviewUrl] = useState('');
  const [activePreviewRevision, setActivePreviewRevision] = useState(0);
  const [activePreviewLoaded, setActivePreviewLoaded] = useState(false);
  const [pendingPreviewUrl, setPendingPreviewUrl] = useState('');
  const [pendingPreviewRevision, setPendingPreviewRevision] = useState(0);
  const conversationScrollRef = useRef<HTMLDivElement | null>(null);
  const activePreviewUrlRef = useRef('');
  const activePreviewRevisionRef = useRef(0);
  const previewRevisionRef = useRef(0);
  const processStepRevealTimersRef = useRef<Record<string, number>>({});
  const showProcessThinkingRef = useRef(true);

  const t = TRANSLATIONS[language];
  const canSend = (input.trim().length > 0 || attachedFiles.length > 0) && !loading;
  const hasWorkspace = messages.length > 0 || Boolean(preview) || Boolean(build);
  const fileCount = fileTree?.items.filter((item) => item.type === 'file').length ?? 0;
  const latestAssistantMessage = messages.findLast((message) => message.role === 'assistant');
  const latestAssistantScrollSignature = latestAssistantMessage
    ? getAssistantScrollSignature(latestAssistantMessage)
    : '';
  useEffect(() => {
    const { domain } = extractProjectName();
    setDeployUrl(getDeployUrl(domain));
  }, []);

  useEffect(() => {
    const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (stored === 'ko' || stored === 'en') {
      setLanguage(stored);
    }
  }, []);

  useEffect(() => {
    setConversationId(getOrCreateCachedConversationId());
  }, []);

  useEffect(() => {
    setAuthUser(getCachedAuthUser());
  }, []);

  useEffect(() => {
    document.documentElement.lang = language === 'ko' ? 'ko' : 'en';
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  }, [language]);

  useEffect(() => {
    showProcessThinkingRef.current = showProcessThinking;
  }, [showProcessThinking]);

  useEffect(() => {
    const container = conversationScrollRef.current;
    if (!container) {
      return;
    }
    container.scrollTop = container.scrollHeight;
  }, [messages.length, latestAssistantScrollSignature]);

  const promotePendingPreview = () => {
    if (!pendingPreviewUrl) {
      return;
    }
    activePreviewUrlRef.current = pendingPreviewUrl;
    activePreviewRevisionRef.current = pendingPreviewRevision;
    setActivePreviewUrl(pendingPreviewUrl);
    setActivePreviewRevision(pendingPreviewRevision);
    setActivePreviewLoaded(true);
    setPendingPreviewUrl('');
    setPendingPreviewRevision(0);
  };

  // Cross-origin iframe onLoad may not fire in some environments. Hide the
  // overlay after 3 seconds as a fallback to avoid a permanently blank preview.
  useEffect(() => {
    if (!activePreviewUrl || activePreviewLoaded) {
      return;
    }
    const timer = window.setTimeout(() => setActivePreviewLoaded(true), 3000);
    return () => window.clearTimeout(timer);
  }, [activePreviewUrl, activePreviewLoaded, activePreviewRevision]);

  // Keep the same fallback for the background iframe so the old preview is not
  // kept forever when onLoad does not fire.
  useEffect(() => {
    if (!pendingPreviewUrl) {
      return;
    }
    const timer = window.setTimeout(() => {
      activePreviewUrlRef.current = pendingPreviewUrl;
      activePreviewRevisionRef.current = pendingPreviewRevision;
      setActivePreviewUrl(pendingPreviewUrl);
      setActivePreviewRevision(pendingPreviewRevision);
      setActivePreviewLoaded(true);
      setPendingPreviewUrl('');
      setPendingPreviewRevision(0);
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [pendingPreviewUrl, pendingPreviewRevision]);

  async function sendMessage(message: string) {
    const trimmed = message.trim();
    const filesToSend = attachedFiles;
    if ((!trimmed && filesToSend.length === 0) || loading) {
      return;
    }

    const isStartingFromHome = !hasWorkspace;
    const requestConversationId = isStartingFromHome
      ? createConversationId()
      : conversationId || getOrCreateCachedConversationId();
    if (isStartingFromHome) {
      cacheConversationId(requestConversationId);
      setConversationId(requestConversationId);
      setPreview(null);
      setDownload(null);
      setBuild(null);
      setFileTree(null);
      setFilesRefreshing(false);
      setSandboxTab('preview');
      activePreviewUrlRef.current = '';
      activePreviewRevisionRef.current = 0;
      previewRevisionRef.current = 0;
      setActivePreviewUrl('');
      setActivePreviewRevision(0);
      setActivePreviewLoaded(false);
      setPendingPreviewUrl('');
      setPendingPreviewRevision(0);
    } else if (!conversationId) {
      setConversationId(requestConversationId);
    }

    const userMessageId = createMessageId('user');
    const assistantMessageId = createMessageId('assistant');

    setMessages((current) => [
      ...current,
      { id: userMessageId, role: 'user', content: trimmed },
      {
        id: assistantMessageId,
        role: 'assistant',
        content: '',
        thinkingContent: '',
        processEvents: [],
        status: 'running',
        steps: [],
      },
    ]);
    // Expand the running message by default while preserving older turn states.
    setOpenSteps((current) => ({ ...current, [assistantMessageId]: true }));
    setFilesRefreshing(true);
    setInput('');
    setLoading(true);
    const activatedPreviewRevisions = new Map<string, number>();
    let sawProjectActivity = false;
    let insertedModifyMarker = false;

    const patchAssistant = (patch: Partial<ChatMessage>) => {
      setMessages((current) =>
        current.map((item) =>
          item.id === assistantMessageId ? { ...item, ...patch } : item,
        ),
      );
    };

    const clearProcessStepRevealTimer = () => {
      const timer = processStepRevealTimersRef.current[assistantMessageId];
      if (timer) {
        window.clearTimeout(timer);
        delete processStepRevealTimersRef.current[assistantMessageId];
      }
    };

    const scheduleProcessStepReveal = () => {
      clearProcessStepRevealTimer();
      processStepRevealTimersRef.current[assistantMessageId] = window.setTimeout(() => {
        delete processStepRevealTimersRef.current[assistantMessageId];
        setMessages((current) =>
          current.map((item) =>
            item.id === assistantMessageId
              ? {
                  ...item,
                  thinkingContent: '',
                  processEvents: appendPendingProcessSteps(
                    item.processEvents ?? [],
                    item.steps ?? [],
                    t.timeline,
                  ),
                }
              : item,
          ),
        );
      }, PROCESS_STEP_REVEAL_DELAY_MS);
    };

    const appendStep = (step: TimelineStep) => {
      setMessages((current) =>
        current.map((item) =>
          item.id === assistantMessageId
            ? (() => {
                const nextSteps = appendOrUpdateTimelineStep(item.steps ?? [], step);
                const previousProcessEvents = item.processEvents ?? [];
                const nextProcessEvents = appendOrUpdateProcessStep(
                  previousProcessEvents,
                  nextSteps,
                  step,
                  t.timeline,
                );
                const didAppendProcessStep = countProcessSteps(nextProcessEvents) > countProcessSteps(previousProcessEvents);
                if (showProcessThinkingRef.current && shouldDelayProcessStepReveal(previousProcessEvents, nextProcessEvents)) {
                  scheduleProcessStepReveal();
                  return {
                    ...item,
                    steps: nextSteps,
                  };
                }
                return {
                  ...item,
                  steps: nextSteps,
                  thinkingContent: didAppendProcessStep && !showProcessThinkingRef.current ? '' : item.thinkingContent,
                  processEvents: nextProcessEvents,
                };
              })()
            : item,
        ),
      );
    };

    const appendThinkingSegment = (text: string) => {
      setMessages((current) =>
        current.map((item) => {
          if (item.id !== assistantMessageId) {
            return item;
          }
          const nextThinkingContent = sanitizeThinkingContent(`${item.thinkingContent || ''}${text}`);
          if (!nextThinkingContent) {
            return item;
          }
          return {
            ...item,
            thinkingContent: nextThinkingContent,
            processEvents: appendOrUpdateProcessThinking(item.processEvents ?? [], nextThinkingContent),
          };
        }),
      );
    };

    const finalizeAssistant = (
      finalContent: string,
      finalStatus: AssistantStatus,
    ) => {
      clearProcessStepRevealTimer();
      setMessages((current) =>
        current.map((item) =>
          item.id === assistantMessageId
            ? {
                ...item,
                content: finalContent,
                thinkingContent: '',
                processEvents: appendPendingProcessSteps(item.processEvents ?? [], item.steps ?? [], t.timeline),
                status: finalStatus,
              }
            : item,
        ),
      );
      // Collapse progress by default when the stream ends. The running-phase
      // forced expansion is temporary.
      setOpenSteps((current) => ({ ...current, [assistantMessageId]: false }));
    };

    const activatePreview = (nextPreview: LinkInfo) => {
      if (!nextPreview.url) {
        if (nextPreview.error) {
          setPreview((current) =>
            current?.url
              ? {
                  ...nextPreview,
                  url: current.url,
                  sandboxDebugUrl: nextPreview.sandboxDebugUrl ?? current.sandboxDebugUrl,
                }
              : nextPreview,
          );
        }
        return;
      }

      setPreview(nextPreview);
      setSandboxTab('preview');
      let revision = activatedPreviewRevisions.get(nextPreview.url);
      if (revision === undefined) {
        revision = previewRevisionRef.current + 1;
        previewRevisionRef.current = revision;
        activatedPreviewRevisions.set(nextPreview.url, revision);
      }

      if (!activePreviewUrlRef.current) {
        activePreviewUrlRef.current = nextPreview.url;
        activePreviewRevisionRef.current = revision;
        setActivePreviewUrl(nextPreview.url);
        setActivePreviewRevision(revision);
        setActivePreviewLoaded(false);
        setPendingPreviewUrl('');
        setPendingPreviewRevision(0);
        return;
      }

      if (
        activePreviewUrlRef.current === nextPreview.url
        && activePreviewRevisionRef.current === revision
      ) {
        return;
      }

      setPendingPreviewUrl(nextPreview.url);
      setPendingPreviewRevision(revision);
    };

    const applyResponse = (data: ChatResponse) => {
      if (data.conversation_id) {
        cacheConversationId(data.conversation_id);
        setConversationId(data.conversation_id);
      }
      if (data.preview) {
        activatePreview(data.preview);
      }
      if (data.download) {
        setDownload(data.download);
      }
      if (data.build) {
        setBuild(data.build);
      }
      if (data.files) {
        setFileTree(data.files);
      }
      setFilesRefreshing(false);

      const finalText = data.reply || data.error || t.response.noDisplay;
      const finalStatus: AssistantStatus = data.ok === false ? 'error' : 'done';
      finalizeAssistant(finalText, finalStatus);
    };

    const handleStreamEvent = (event: ChatStreamEvent) => {
      if (event.type === 'status' && event.message) {
        appendStep({ kind: 'status', text: event.message });
        return;
      }
      if (event.type === 'result' && event.data) {
        applyResponse(event.data);
        return;
      }
      if (event.type === 'agent' && event.data) {
        const agentData = event.data;
        const text = agentData.reply || agentData.error || t.response.noDisplay;
        // agent events can arrive before the final aggregate result with build
        // and preview data. For plain Q&A without project tool activity, the
        // agent event is already complete and can finish the frontend wait state.
        // If project tools ran, keep the message running until result finalizes it.
        if (!sawProjectActivity) {
          finalizeAssistant(text, agentData.ok === false ? 'error' : 'done');
          return;
        }
        patchAssistant({ content: text });
        return;
      }
      if (event.type === 'text_segment' && event.data?.text) {
        appendThinkingSegment(event.data.text);
        return;
      }
      if (event.type === 'tool_use' && event.data) {
        sawProjectActivity = true;
        const toolUseStep: TimelineStep = {
          kind: 'tool_use',
          id: event.data.id || '',
          name: event.data.name || '<unknown>',
          command: event.data.command,
          phaseHint: event.data.phaseHint,
          fileCount: event.data.fileCount,
        };
        const classification = classifyToolUse(toolUseStep, t.timeline);
        if (!isStartingFromHome && !insertedModifyMarker && classification?.phase === 'code') {
          appendStep({ kind: 'modify_marker' });
          insertedModifyMarker = true;
        }
        appendStep(toolUseStep);
        return;
      }
      if (event.type === 'tool_result' && event.data) {
        sawProjectActivity = true;
        appendStep({
          kind: 'tool_result',
          toolUseId: event.data.tool_use_id || '',
          toolName: event.data.toolName,
          command: event.data.command,
          ok: event.data.ok !== false,
          preview: event.data.preview || '',
        });
        return;
      }
      if (event.type === 'file_tree' && event.data) {
        sawProjectActivity = true;
        setFileTree(event.data);
        setFilesRefreshing(false);
        return;
      }
      if (event.type === 'preview_ready' && event.data) {
        sawProjectActivity = true;
        if (event.data.preview) {
          activatePreview(event.data.preview);
          appendStep({
            kind: 'status',
            text: event.data.preview.url ? t.workspace.previewLinkReady : t.workspace.previewLinkMissing,
          });
        }
        if (event.data.download) {
          setDownload(event.data.download);
        }
        return;
      }
      if (event.type === 'error') {
        appendStep({ kind: 'error', text: event.error || t.response.processingFailed });
        finalizeAssistant(event.error || t.response.processingFailed, 'error');
        return;
      }
      if (event.type === 'log' && event.message) {
        sawProjectActivity = true;
        appendStep({
          kind: 'log',
          stream: (event.stream as 'stdout' | 'stderr' | 'status') || 'stdout',
          text: event.message || '',
        });
      }
    };

    setAttachedFiles([]);
    setAttachError(null);

    try {
      const response = await fetch('/chat', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          conversationId: requestConversationId,
          'makers-conversation-id': requestConversationId,
        },
        body: JSON.stringify({
          message: trimmed,
          ...(isStartingFromHome ? { resetProject: true } : {}),
          ...(filesToSend.length
            ? {
              files: filesToSend.map((file) => ({
                name: file.name,
                mimeType: file.mimeType,
                dataBase64: file.dataBase64,
              })),
            }
            : {}),
          ...(authUser ? { userId: authUser.id } : {}),
        }),
      });

      const contentType = response.headers.get('content-type') || '';
      if (!response.body || !contentType.includes('application/x-ndjson')) {
        applyResponse((await response.json()) as ChatResponse);
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) {
            continue;
          }
          handleStreamEvent(JSON.parse(line) as ChatStreamEvent);
        }
      }

      buffer += decoder.decode();
      if (buffer.trim()) {
        handleStreamEvent(JSON.parse(buffer) as ChatStreamEvent);
      }
    } catch (error) {
      const msg = `${t.response.requestFailedPrefix}${error instanceof Error ? error.message : t.response.unknownError}`;
      appendStep({ kind: 'error', text: msg });
      finalizeAssistant(msg, 'error');
    } finally {
      clearProcessStepRevealTimer();
      // Fallback: ensure a running message cannot get stuck after an unexpected stream break.
      setMessages((current) =>
        current.map((item) =>
          item.id === assistantMessageId && item.status === 'running'
            ? {
                ...item,
                status: 'done',
                content: item.content || t.response.agentFlowEnded,
                thinkingContent: '',
                processEvents: appendPendingProcessSteps(item.processEvents ?? [], item.steps ?? [], t.timeline),
              }
            : item,
        ),
      );
      setOpenSteps((current) => {
        if (current[assistantMessageId] === false) return current;
        return { ...current, [assistantMessageId]: false };
      });
      setLoading(false);
      setFilesRefreshing(false);
    }
  }

  async function handleFilesPicked(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) {
      return;
    }
    setAttachError(null);
    try {
      const files = Array.from(fileList);
      const read = await Promise.all(
        files.map(async (file) => ({
          id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          name: file.name || 'file',
          mimeType: file.type || 'application/octet-stream',
          sizeLabel: formatAttachedFileSize(file.size),
          dataBase64: await readFileAsBase64(file),
        })),
      );
      setAttachedFiles((current) => [...current, ...read]);
    } catch {
      setAttachError('파일을 읽는 중 오류가 발생했어요. 다시 시도해 주세요.');
    }
  }

  function removeAttachedFile(id: string) {
    setAttachedFiles((current) => current.filter((file) => file.id !== id));
  }

  function handleLogout() {
    setAuthUser(null);
    cacheAuthUser(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await sendMessage(input);
  }

  async function handleDownload() {
    if (!download?.url || downloadBusy) {
      return;
    }
    setDownloadBusy(true);
    setDownload((current) => (current ? { ...current, error: undefined } : current));
    try {
      // /download must hit the same sandbox the project lives in; sticky routing
      // keys off the conversation id header, so send it like /file and /chat do
      // (a plain <a download> could not set this header).
      const headers: HeadersInit = {};
      const cid = conversationId || getOrCreateCachedConversationId();
      if (cid) {
        headers['makers-conversation-id'] = cid;
        headers['conversationId'] = cid;
      }
      const resp = await fetch(download.url, { method: 'GET', headers });
      const data = (await resp.json().catch(() => null)) as
        | { ok?: boolean; base64?: string; filename?: string; contentType?: string; error?: string }
        | null;
      if (!resp.ok || !data?.ok || !data.base64) {
        const message = data?.error || `${resp.status}`;
        setDownload((current) => (current ? { ...current, error: message } : current));
        return;
      }
      const blob = base64ToBlob(data.base64, data.contentType || 'application/zip');
      const filename = data.filename || download.filename || 'source.zip';
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch (error) {
      const message = error instanceof Error ? error.message : t.workspace.downloadFailed;
      setDownload((current) => (current ? { ...current, error: message } : current));
    } finally {
      setDownloadBusy(false);
    }
  }

  return (
    <main className="min-h-screen overflow-hidden bg-[#0a0d0b] text-white">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        onChange={(event) => {
          void handleFilesPicked(event.target.files);
          event.target.value = '';
        }}
        className="hidden"
      />
      <nav className="fixed inset-x-0 top-0 z-50 px-4">
        <div className="mx-auto flex h-14 items-center justify-between gap-3">
          <div className="min-w-0 text-sm font-semibold tracking-[0.06em] text-[#dff8ef] sm:text-base">
            <span className="truncate">PIXAL2.0</span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <a
              href={deployUrl}
              target="_blank"
              rel="noreferrer"
              className="rounded-full bg-[#45b98e] px-3.5 py-1.5 text-xs font-semibold text-black shadow-lg shadow-[#45b98e]/20 transition hover:bg-[#56c99f] sm:px-4"
            >
              {t.deployLabel}
            </a>
            {authUser ? (
              <button
                type="button"
                onClick={handleLogout}
                className="rounded-full border border-white/15 bg-[#141917]/90 px-3 py-1.5 text-xs font-semibold text-[#dff8ef] shadow-lg shadow-black/20 transition hover:border-[#f2a0a0] hover:text-white"
              >
                {authUser.name}
              </button>
            ) : (
              <a
                href="/login"
                className="rounded-full border border-white/15 bg-[#141917]/90 px-3 py-1.5 text-xs font-semibold text-[#dff8ef] shadow-lg shadow-black/20 transition hover:border-[#7bd8b4] hover:text-white"
              >
                {language === 'ko' ? '로그인' : 'Log in'}
              </a>
            )}
            <button
              type="button"
              onClick={() => setLanguage((current) => (current === 'ko' ? 'en' : 'ko'))}
              aria-label={t.languageToggleAria}
              className="rounded-full border border-white/15 bg-[#141917]/90 px-3 py-1.5 text-xs font-semibold text-[#dff8ef] shadow-lg shadow-black/20 transition hover:border-[#7bd8b4] hover:text-white"
            >
              {t.languageToggleLabel}
            </button>
          </div>
        </div>
      </nav>
      {!hasWorkspace && (
        <section className="relative isolate flex min-h-screen flex-col items-center px-5 pb-16 pt-28 text-center md:pt-36 lg:pt-40">
          <div className="hero-glow" />
          <div className="aurora-band aurora-band-wide" />
          <div className="aurora-band aurora-band-slim" />

          <div className="relative z-10 w-full max-w-7xl">
            <h1 className="mx-auto max-w-5xl text-balance text-[clamp(1.85rem,3.6vw,3.35rem)] font-extrabold leading-[1.08]">
              {t.home.titleBefore}
              {language === 'en' ? ' ' : ''}
              <span className="build-word">{t.home.titleAccent}</span>
              {language === 'en' ? ' ' : ''}
              {t.home.titleAfter}
            </h1>
            <p className="mt-7 text-[clamp(0.95rem,1.15vw,1.25rem)] font-semibold text-[#b5c4be]">
              {t.home.subtitle}
            </p>

            <form
              onSubmit={handleSubmit}
              className="prompt-shell mx-auto mt-10 flex w-full max-w-[1260px] flex-col text-left"
            >
              <textarea
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder={t.home.placeholder}
                className="min-h-[180px] w-full resize-none rounded-t-[20px] border-0 bg-transparent px-8 py-7 text-[clamp(1.25rem,2vw,2rem)] font-medium text-white outline-none placeholder:text-[#bac3bd]"
              />
              {attachedFiles.length > 0 && (
                <div className="flex flex-wrap gap-2 px-8 pb-3">
                  {attachedFiles.map((file) => (
                    <span
                      key={file.id}
                      className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/[0.06] px-3 py-1 text-xs text-[#dfe6e2]"
                    >
                      <span className="max-w-[160px] truncate">{file.name}</span>
                      <span className="text-white/40">{file.sizeLabel}</span>
                      <button
                        type="button"
                        onClick={() => removeAttachedFile(file.id)}
                        aria-label={t.attach.removeFile}
                        className="text-white/50 hover:text-white"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
              {attachError && (
                <p className="px-8 pb-2 text-xs text-[#f2a0a0]">{attachError}</p>
              )}
              <div className="flex items-center justify-between gap-3 px-6">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  aria-label={t.attach.attachAria}
                  className="inline-flex h-11 items-center gap-2 rounded-full border border-white/15 bg-white/[0.05] px-4 text-sm font-medium text-[#dfe6e2] transition hover:border-[#7bd8b4] hover:text-white"
                >
                  <PaperclipIcon />
                  {t.attach.attachFile}
                </button>
                <button
                  type="submit"
                  disabled={!canSend}
                  className="group inline-flex min-h-14 w-full cursor-pointer items-center justify-center gap-3 rounded-2xl bg-[#45b98e] px-7 py-4 text-lg font-semibold text-white shadow-lg shadow-[#45b98e]/20 transition-all duration-200 hover:-translate-y-0.5 hover:bg-[#56c99f] hover:shadow-xl hover:shadow-[#45b98e]/35 active:translate-y-0 disabled:cursor-not-allowed disabled:bg-white/20 disabled:text-white/45 disabled:shadow-none disabled:hover:translate-y-0 sm:w-auto sm:min-w-[190px] sm:text-xl"
                >
                  {loading ? t.home.building : t.home.buildNow}
                  <span className="transition-transform duration-200 group-hover:translate-x-1">
                    <ArrowIcon />
                  </span>
                </button>
              </div>
            </form>

            <div className="mx-auto mt-8 flex w-full max-w-[1260px] flex-wrap justify-center gap-3">
              {t.home.examples.map((example) => (
                <button
                  key={example}
                  type="button"
                  onClick={() => setInput(example)}
                  className="rounded-full border border-white/10 bg-white/[0.06] px-4 py-2 text-sm text-[#cfd5d1] transition hover:border-[#7bd8b4] hover:text-white"
                >
                  {example}
                </button>
              ))}
            </div>
          </div>
        </section>
      )}

      <section
        className={`relative z-20 h-screen w-full overflow-hidden p-3 pt-16 md:p-4 md:pt-16 ${
          hasWorkspace ? 'block' : 'hidden'
        }`}
      >
        <div className="grid h-full min-h-0 grid-rows-[minmax(0,0.44fr)_minmax(0,0.56fr)] gap-4 lg:grid-cols-[420px_minmax(0,1fr)] lg:grid-rows-1">
          <section className="flex min-h-0 flex-col overflow-hidden rounded-[20px] border border-white/10 bg-[#141917] shadow-2xl shadow-black/35">
            <header className="flex min-h-12 items-center gap-3 border-b border-white/10 px-4 py-2">
              <p className="shrink-0 text-sm font-semibold uppercase tracking-[0.14em] text-[#7bd8b4]">{t.workspace.conversationEyebrow}</p>
            </header>

            <div ref={conversationScrollRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
              {messages.map((message) => {
                if (message.role === 'user') {
                  return (
                    <div
                      key={message.id}
                      className="ml-8 min-w-0 overflow-hidden break-words rounded-2xl bg-[#5ec7a0] px-4 py-3 text-sm leading-6 text-[#10241d]"
                    >
                      <span className="whitespace-pre-wrap">{message.content}</span>
                    </div>
                  );
                }

                const status: AssistantStatus = message.status || 'done';
                const steps = message.steps ?? [];
                const isOpen = openSteps[message.id] ?? status === 'running';
                const processEvents = message.processEvents ?? [];
                const hasProcessEvents = processEvents.length > 0;
                const hasProcessPanel = status === 'running' || hasProcessEvents;
                const hasAssistantBubble = Boolean(message.content);

                return (
                  <div
                    key={message.id}
                    className="mr-8 min-w-0 space-y-2"
                  >
                    {hasProcessPanel && (
                      <ProcessPanel
                        events={processEvents}
                        running={status === 'running'}
                        open={isOpen}
                        showThinking={showProcessThinking}
                        onToggle={() =>
                          setOpenSteps((current) => ({
                            ...current,
                            [message.id]: !isOpen,
                          }))
                        }
                        onToggleThinking={() => setShowProcessThinking((current) => !current)}
                        copy={t.timeline}
                        labels={{
                          hide: t.workspace.hideSteps,
                          view: t.workspace.viewSteps,
                          steps: t.workspace.steps,
                          keepThinking: t.workspace.keepThinking,
                        }}
                      />
                    )}
                    {hasAssistantBubble && (
                      <div className="min-w-0 overflow-hidden break-words rounded-2xl bg-white/[0.07] px-4 py-3 text-sm leading-6 text-[#ececf0]">
                        <TypewriterMarkdownMessage content={message.content} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="space-y-2 border-t border-white/10 p-4">
              {attachedFiles.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {attachedFiles.map((file) => (
                    <span
                      key={file.id}
                      className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/[0.06] px-3 py-1 text-xs text-[#dfe6e2]"
                    >
                      <span className="max-w-[140px] truncate">{file.name}</span>
                      <span className="text-white/40">{file.sizeLabel}</span>
                      <button
                        type="button"
                        onClick={() => removeAttachedFile(file.id)}
                        aria-label={t.attach.removeFile}
                        className="text-white/50 hover:text-white"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
              {attachError && <p className="text-xs text-[#f2a0a0]">{attachError}</p>}
              <form onSubmit={handleSubmit} className="flex gap-2">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  aria-label={t.attach.attachAria}
                  className="flex size-11 shrink-0 items-center justify-center rounded-full border border-white/10 bg-black/25 text-[#dfe6e2] transition hover:border-[#7bd8b4] hover:text-white"
                >
                  <PaperclipIcon />
                </button>
                <input
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  placeholder={t.workspace.changePlaceholder}
                  className="min-h-12 min-w-0 flex-1 rounded-full border border-white/10 bg-black/25 px-4 text-sm outline-none placeholder:text-white/35 focus:border-[#7bd8b4]"
                />
                <button
                  type="submit"
                  disabled={!canSend}
                  className="rounded-full bg-[#f2c779] px-5 text-sm font-semibold text-[#21170a] transition hover:bg-[#ffd98a] disabled:cursor-not-allowed disabled:bg-white/20 disabled:text-white/40"
                >
                  {t.workspace.send}
                </button>
              </form>
            </div>
          </section>

          <section className="flex min-h-0 flex-col overflow-hidden rounded-[20px] border border-white/10 bg-[#141917] shadow-2xl shadow-black/35">
            <header className="flex min-h-12 items-center justify-between gap-3 border-b border-white/10 px-4 py-2">
              <div className="flex min-w-0 items-center gap-3">
                <p className="shrink-0 text-sm font-semibold uppercase tracking-[0.14em] text-[#7bd8b4]">{t.workspace.sandboxEyebrow}</p>
                <h2 className="min-w-0 truncate text-[0.86em] font-semibold text-[#dff8ef]">
                  {sandboxTab === 'preview' ? t.workspace.livePreview : t.workspace.files}
                </h2>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <div className="flex rounded-full border border-white/10 bg-black/25 p-1 text-xs">
                  <button
                    type="button"
                    onClick={() => setSandboxTab('preview')}
                    className={`rounded-full px-3 py-1 transition ${
                      sandboxTab === 'preview'
                        ? 'bg-[#5ec7a0] text-[#10241d]'
                        : 'text-[#cfd5d1] hover:text-white'
                    }`}
                  >
                    {t.workspace.preview}
                  </button>
                  <button
                    type="button"
                    onClick={() => setSandboxTab('files')}
                    className={`rounded-full px-3 py-1 transition ${
                      sandboxTab === 'files'
                        ? 'bg-[#5ec7a0] text-[#10241d]'
                        : 'text-[#cfd5d1] hover:text-white'
                    }`}
                  >
                    {t.workspace.files}
                    {fileCount ? ` ${fileCount}` : ''}
                    {filesRefreshing && (
                      <span className="ml-1 text-[10px] opacity-70">
                        {t.files.refreshing}
                      </span>
                    )}
                  </button>
                </div>
                {download?.url && (
                  <button
                    type="button"
                    onClick={handleDownload}
                    disabled={downloadBusy}
                    className="inline-flex items-center gap-1.5 rounded-full border border-[#5ec7a0]/40 bg-[#5ec7a0]/10 px-3 py-1 text-xs font-semibold text-[#7bd8b4] transition hover:border-[#5ec7a0]/70 hover:bg-[#5ec7a0]/20 hover:text-[#dff8ef] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {downloadBusy ? (
                      <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                        <circle className="opacity-25" cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" />
                        <path className="opacity-90" d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                      </svg>
                    ) : (
                      <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M12 3v12" />
                        <path d="m7 11 5 5 5-5" />
                        <path d="M5 21h14" />
                      </svg>
                    )}
                    {downloadBusy ? t.workspace.downloading : t.workspace.downloadSource}
                  </button>
                )}
              </div>
            </header>

            <div className="relative min-h-0 flex-1 overflow-hidden bg-white">
              {sandboxTab === 'preview' ? (
                preview?.url ? (
                  <div className="flex h-full min-h-0 flex-col bg-white">
                    <div className="relative min-h-0 flex-1 bg-white">
                      {!activePreviewLoaded && (
                        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-[#101412]/85 px-6 text-center text-[#b5c4be]">
                          {t.workspace.loadingPreview}
                        </div>
                      )}
                      {activePreviewUrl && (
                        <iframe
                          key={`${activePreviewUrl}:${activePreviewRevision}`}
                          title="sandbox-preview"
                          src={activePreviewUrl}
                          onLoad={() => setActivePreviewLoaded(true)}
                          className="h-full w-full border-0"
                        />
                      )}
                      {pendingPreviewUrl && (
                        <iframe
                          key={`pending:${pendingPreviewUrl}:${pendingPreviewRevision}`}
                          title="sandbox-preview-pending"
                          src={pendingPreviewUrl}
                          onLoad={promotePendingPreview}
                          className="invisible pointer-events-none absolute inset-0 h-full w-full border-0"
                        />
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="flex h-full min-h-0 flex-col items-center justify-center bg-[#101412] px-6 text-center text-[#b5c4be]">
                    <p>{t.workspace.previewEmpty}</p>
                    <p className="mt-3 max-w-xl text-xs leading-5 text-[#8fa098]">
                      {t.workspace.constructionDisclaimer}
                    </p>
                  </div>
                )
              ) : (
                <FilesPanel
                  tree={fileTree}
                  refreshing={filesRefreshing}
                  conversationId={conversationId}
                  copy={t.files}
                />
              )}
            </div>

            {(build?.status === 'failed' || download?.error || preview?.error) && (
              <div className="space-y-2 border-t border-white/10 bg-[#101412] p-4 text-xs text-[#cfd5d1]">
                {build?.status === 'failed' && (
                  <p className="text-rose-300">
                    {build.autoFixApplied && build.autoFixAttempts
                      ? t.workspace.buildFailedAfter(build.autoFixAttempts)
                      : t.workspace.buildFailedMessage}
                  </p>
                )}
                {preview?.error && <p>{t.workspace.previewError}{preview.error}</p>}
                {download?.error && <p>{t.workspace.downloadError}{download.error}</p>}
              </div>
            )}
          </section>
        </div>
      </section>
    </main>
  );
}

const ProcessPanel = memo(function ProcessPanel({
  events,
  running,
  open,
  showThinking,
  onToggle,
  onToggleThinking,
  copy,
  labels,
}: {
  events: ProcessEvent[];
  running: boolean;
  open: boolean;
  showThinking: boolean;
  onToggle: () => void;
  onToggleThinking: () => void;
  copy: TimelineCopy;
  labels: {
    hide: string;
    view: string;
    steps: string;
    keepThinking: string;
  };
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const hasProcessEvents = events.length > 0;
  const visibleEvents = useMemo(
    () => showThinking
      ? events
      : events.filter((event) => event.kind !== 'thinking'),
    [events, showThinking],
  );
  const isOpen = hasProcessEvents ? open : true;

  useEffect(() => {
    if (!running || !scrollRef.current) {
      return;
    }
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [visibleEvents, running, isOpen]);

  if (!hasProcessEvents && !running) {
    return null;
  }

  return (
    <div className="min-w-0 rounded-xl border border-white/10 bg-black/15 px-3 py-2 text-[12px] leading-5 text-[#cfd5d1]">
      {hasProcessEvents && (
        <div
          role="button"
          tabIndex={0}
          aria-label={open ? `${labels.hide}${labels.steps}` : `${labels.view}${labels.steps}`}
          onClick={onToggle}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') {
              return;
            }
            event.preventDefault();
            onToggle();
          }}
          className="flex min-w-0 w-full cursor-pointer flex-wrap items-center justify-between gap-2 rounded-lg px-1 py-1 text-left transition focus:outline-none focus-visible:ring-1 focus-visible:ring-[#7bd8b4]/60"
        >
          <span className="flex size-6 items-center justify-center rounded-full text-[#7bd8b4] transition hover:text-[#a8eccd]">
            <span
              aria-hidden="true"
              className={`block size-0 border-y-[5px] border-y-transparent border-l-[8px] border-l-current transition-transform ${
                open ? 'rotate-90' : ''
              }`}
            />
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={showThinking}
            onClick={(event) => {
              event.stopPropagation();
              onToggleThinking();
            }}
            onKeyDown={(event) => event.stopPropagation()}
            className={`flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium transition ${
              showThinking
                ? 'bg-[#7bd8b4]/15 text-[#a8eccd]'
                : 'bg-white/5 text-white/45 hover:text-white/70'
            }`}
          >
            <span
              className={`size-1.5 rounded-full ${
                showThinking ? 'bg-[#7bd8b4]' : 'bg-white/35'
              }`}
              aria-hidden="true"
            />
            {labels.keepThinking}
          </button>
        </div>
      )}
      {isOpen && (
        <div
          ref={scrollRef}
          className={`${hasProcessEvents ? 'mt-2' : ''} min-w-0 space-y-2`}
        >
          {visibleEvents.length === 0 ? (
            running ? (
              <ProcessWaitingItem copy={copy} />
            ) : null
          ) : (
            <>
              {visibleEvents.map((event, index) => (
                <ProcessEventItem
                  key={getProcessEventKey(event, index)}
                  event={event}
                  copy={copy}
                />
              ))}
              {running && visibleEvents[visibleEvents.length - 1]?.kind !== 'thinking' && (
                <ProcessWaitingItem copy={copy} />
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
});

function ProcessWaitingItem({ copy }: { copy: TimelineCopy }) {
  return (
    <div className="flex min-w-0 items-center gap-2 pt-1 text-[#7bd8b4]">
      <Spinner />
      <span className="min-w-0 flex-1 break-words text-[11px] [overflow-wrap:anywhere]">{copy.processing}</span>
    </div>
  );
}

function ProcessEventItem({
  event,
  copy,
}: {
  event: ProcessEvent;
  copy: TimelineCopy;
}) {
  if (event.kind === 'thinking') {
    return <ProcessThinkingItem content={event.content} />;
  }
  return <NormalizedStepCard step={event.step} copy={copy} />;
}

function ProcessThinkingItem({ content }: { content: string }) {
  return <SmoothThinkingText content={content} />;
}

function SmoothThinkingText({ content }: { content: string }) {
  const [segments, setSegments] = useState({ stable: '', incoming: '' });

  useEffect(() => {
    const prefersReducedMotion = typeof window !== 'undefined'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReducedMotion) {
      setSegments({ stable: content, incoming: '' });
      return;
    }

    setSegments((current) => {
      const rendered = `${current.stable}${current.incoming}`;
      if (content === rendered) {
        return current;
      }
      if (content.startsWith(rendered)) {
        return {
          stable: current.stable,
          incoming: `${current.incoming}${content.slice(rendered.length)}`,
        };
      }
      if (content.startsWith(current.stable)) {
        return {
          stable: current.stable,
          incoming: content.slice(current.stable.length),
        };
      }
      return {
        stable: '',
        incoming: content,
      };
    });
  }, [content]);

  const settleIncoming = () => {
    setSegments((current) => {
      if (!current.incoming) {
        return current;
      }
      return {
        stable: `${current.stable}${current.incoming}`,
        incoming: '',
      };
    });
  };

  return (
    <div className="process-thinking-text">
      {segments.stable}
      {segments.incoming && (
        <span className="process-thinking-delta" onAnimationEnd={settleIncoming}>
          {segments.incoming}
        </span>
      )}
    </div>
  );
}

function getProcessEventKey(event: ProcessEvent, index: number) {
  if (event.kind === 'thinking') {
    return `thinking-${index}`;
  }
  return `step-${event.phase}`;
}

function appendOrUpdateTimelineStep(steps: TimelineStep[], nextStep: TimelineStep): TimelineStep[] {
  if (nextStep.kind !== 'tool_use' || !nextStep.id) {
    return [...steps, nextStep];
  }

  const existingIndex = steps.findIndex((step) =>
    step.kind === 'tool_use' && step.id === nextStep.id,
  );
  if (existingIndex < 0) {
    return [...steps, nextStep];
  }

  return steps.map((step, index) => {
    if (index !== existingIndex || step.kind !== 'tool_use') {
      return step;
    }
    return {
      ...step,
      name: nextStep.name || step.name,
      command: nextStep.command || step.command,
      phaseHint: nextStep.phaseHint || step.phaseHint,
      fileCount: nextStep.fileCount || step.fileCount,
    };
  });
}

function appendOrUpdateProcessThinking(events: ProcessEvent[], content: string): ProcessEvent[] {
  const tail = events[events.length - 1];
  if (tail?.kind === 'thinking') {
    return events.map((event, index) =>
      index === events.length - 1 && event.kind === 'thinking'
        ? { ...event, content }
        : event,
    );
  }
  return [...events, { kind: 'thinking', content }];
}

function appendOrUpdateProcessStep(
  events: ProcessEvent[],
  steps: TimelineStep[],
  changedStep: TimelineStep,
  copy: TimelineCopy,
): ProcessEvent[] {
  const processStep = getProcessStepForTimelineStep(changedStep, steps, copy);
  if (!processStep) {
    return events;
  }

  const existingIndex = events.findIndex((event) =>
    event.kind === 'step' && event.phase === processStep.phase,
  );
  if (existingIndex >= 0) {
    return events.map((event, index) =>
      index === existingIndex ? processStep : event,
    );
  }

  return [...events, processStep];
}

function shouldDelayProcessStepReveal(previousEvents: ProcessEvent[], nextEvents: ProcessEvent[]) {
  const previousTail = previousEvents[previousEvents.length - 1];
  return previousTail?.kind === 'thinking'
    && countProcessSteps(nextEvents) > countProcessSteps(previousEvents);
}

function appendPendingProcessSteps(
  events: ProcessEvent[],
  steps: TimelineStep[],
  copy: TimelineCopy,
): ProcessEvent[] {
  const existingPhases = new Set(
    events
      .filter((event): event is Extract<ProcessEvent, { kind: 'step' }> => event.kind === 'step')
      .map((event) => event.phase),
  );
  const pendingSteps = normalizeTimelineSteps(steps, copy)
    .filter((step) => !existingPhases.has(step.phase));
  if (pendingSteps.length === 0) {
    return events;
  }
  return [
    ...events,
    ...pendingSteps.map((step): Extract<ProcessEvent, { kind: 'step' }> => ({
      kind: 'step',
      phase: step.phase,
      step,
    })),
  ];
}

function countProcessSteps(events: ProcessEvent[]) {
  return events.reduce((count, event) => count + (event.kind === 'step' ? 1 : 0), 0);
}

function getProcessStepForTimelineStep(
  changedStep: TimelineStep,
  steps: TimelineStep[],
  copy: TimelineCopy,
): Extract<ProcessEvent, { kind: 'step' }> | null {
  const phase = getTimelineStepPhase(changedStep, steps, copy);
  if (!phase) {
    return null;
  }
  const normalizedStep = normalizeTimelineSteps(steps, copy)
    .find((step) => step.phase === phase);
  return normalizedStep ? { kind: 'step', phase, step: normalizedStep } : null;
}

function getTimelineStepPhase(
  step: TimelineStep,
  steps: TimelineStep[],
  copy: TimelineCopy,
): NormalizedStepPhase | null {
  if (step.kind === 'tool_use') {
    return classifyToolUse(step, copy)?.phase ?? null;
  }
  if (step.kind === 'tool_result') {
    const relatedToolUse = [...steps].reverse().find((item) =>
      item.kind === 'tool_use' && item.id === step.toolUseId,
    ) as Extract<TimelineStep, { kind: 'tool_use' }> | undefined;
    if (relatedToolUse) {
      return classifyToolUse(relatedToolUse, copy)?.phase ?? null;
    }
    if (!step.ok && step.command) {
      return isInstallCommand(step.command) ? 'install' : 'code';
    }
    return null;
  }
  if (step.kind === 'status') {
    return classifyStatusText(step.text, copy)?.phase ?? null;
  }
  if (step.kind === 'log') {
    return classifyLogText(step.text, step.stream, copy)?.phase ?? null;
  }
  if (step.kind === 'error') {
    return /preview|미리보기|link|링크/i.test(step.text)
      ? 'link'
      : isInstallText(step.text)
        ? 'install'
        : 'code';
  }
  return null;
}

function normalizeTimelineSteps(steps: TimelineStep[], copy: TimelineCopy): NormalizedStep[] {
  const byPhase = new Map<NormalizedStepPhase, NormalizedStep>();
  const phaseByToolUseId = new Map<string, NormalizedStepPhase>();
  const commandByToolUseId = new Map<string, string>();

  const ensureStep = (phase: NormalizedStepPhase) => {
    const existing = byPhase.get(phase);
    if (existing) {
      return existing;
    }
    const definition = copy.definitions[phase];
    const step: NormalizedStep = {
      phase,
      title: definition.title,
      status: 'waiting',
      summary: definition.waiting,
    };
    byPhase.set(phase, step);
    return step;
  };

  const updateStep = (
    phase: NormalizedStepPhase,
    status: NormalizedStepStatus,
    summary: string,
  ) => {
    const step = ensureStep(phase);
    if (step.status === 'done' && status === 'running') {
      return;
    }
    step.status = status;
    step.summary = summary;
    if (phase === 'code') {
      const modifyStep = byPhase.get('modify');
      if (modifyStep) {
        modifyStep.status = 'done';
        modifyStep.summary = copy.summaries.modifyStarted;
      }
    }
  };

  for (const step of steps) {
    if (step.kind === 'modify_marker') {
      updateStep('modify', 'running', copy.definitions.modify.waiting);
      continue;
    }

    if (step.kind === 'tool_use') {
      if (step.command) {
        commandByToolUseId.set(step.id, step.command);
      }
      const classification = classifyToolUse(step, copy);
      if (!classification) {
        continue;
      }
      phaseByToolUseId.set(step.id, classification.phase);
      updateStep(classification.phase, 'running', classification.runningSummary);
      continue;
    }

    if (step.kind === 'tool_result') {
      const command = step.command || commandByToolUseId.get(step.toolUseId) || '';
      const phase = phaseByToolUseId.get(step.toolUseId) || (!step.ok && command ? 'code' : undefined);
      if (!phase) {
        continue;
      }
      if (phase === 'link' && step.ok) {
        updateStep('preview', 'done', copy.summaries.previewReady);
      }
      updateStep(
        phase,
        step.ok ? 'done' : 'error',
        summarizeToolResult(phase, step.ok, step.preview, copy, command),
      );
      continue;
    }

    if (step.kind === 'status') {
      const statusUpdate = classifyStatusText(step.text, copy);
      if (statusUpdate) {
        if (statusUpdate.phase === 'link' && statusUpdate.status === 'done') {
          updateStep('preview', 'done', copy.summaries.previewReady);
        }
        updateStep(statusUpdate.phase, statusUpdate.status, statusUpdate.summary);
      }
      continue;
    }

    if (step.kind === 'log') {
      const logUpdate = classifyLogText(step.text, step.stream, copy);
      if (logUpdate) {
        updateStep(logUpdate.phase, logUpdate.status, logUpdate.summary);
      }
      continue;
    }

    if (step.kind === 'error') {
      const phase = /preview|미리보기|link|링크/i.test(step.text)
        ? 'link'
        : isInstallText(step.text)
          ? 'install'
          : 'code';
      updateStep(phase, 'error', compactErrorSummary(step.text, copy.summaries.stepFailed(getStepTitle(phase, copy))));
    }
  }

  return PHASE_ORDER
    .map((phase) => byPhase.get(phase))
    .filter((step): step is NormalizedStep => Boolean(step));
}

const NormalizedStepCard = memo(function NormalizedStepCard({ step, copy }: { step: NormalizedStep; copy: TimelineCopy }) {
  const isWaiting = step.status === 'waiting';
  const isRunning = step.status === 'running';
  const isError = step.status === 'error';

  return (
    <div
      className={`rounded-lg border px-3 py-2 ${
        isError
          ? 'border-rose-400/30 bg-rose-400/10 text-rose-100'
          : isWaiting
            ? 'border-white/10 bg-white/[0.03] text-white/45'
            : 'border-white/10 bg-white/[0.06] text-[#dff8ef]'
      }`}
    >
      <div className="flex min-w-0 items-start gap-2">
        <span className="mt-1 flex size-4 shrink-0 items-center justify-center">
          {isRunning ? (
            <Spinner />
          ) : (
            <span
              className={`text-xs font-semibold ${
                isError
                  ? 'text-rose-300'
                  : step.status === 'done'
                    ? 'text-emerald-300'
                    : 'text-white/30'
              }`}
            >
              {isError ? '!' : step.status === 'done' ? '✓' : '·'}
            </span>
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-semibold">{step.title}</div>
          <div className="mt-0.5 min-w-0 break-words text-[11px] text-white/55 [overflow-wrap:anywhere]">
            {step.summary}
          </div>
        </div>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${
            isError
              ? 'bg-rose-300/15 text-rose-200'
              : isRunning
                ? 'bg-[#7bd8b4]/15 text-[#7bd8b4]'
                : step.status === 'done'
                  ? 'bg-emerald-300/15 text-emerald-200'
                  : 'bg-white/5 text-white/35'
          }`}
        >
          {copy.statusLabels[step.status]}
        </span>
      </div>
    </div>
  );
});

function classifyToolUse(step: Extract<TimelineStep, { kind: 'tool_use' }>, copy: TimelineCopy): {
  phase: NormalizedStepPhase;
  runningSummary: string;
} | null {
  if (step.phaseHint) {
    return {
      phase: step.phaseHint,
      runningSummary: step.phaseHint === 'code' && step.fileCount && step.fileCount > 0
        ? copy.summaries.codeWritingFiles(step.fileCount)
        : getRunningSummary(step.phaseHint, copy),
    };
  }

  const toolName = shortenToolName(step.name);

  if (toolName === 'ensure_project_scaffold') {
    return { phase: 'scaffold', runningSummary: copy.summaries.scaffoldRunning };
  }

  if (toolName === 'write_project_files' || toolName === 'write_files') {
    return {
      phase: 'code',
      runningSummary: copy.summaries.codeRunningUpdate,
    };
  }

  if (toolName === 'publish_preview' || toolName === 'get_preview_link') {
    return { phase: 'preview', runningSummary: copy.summaries.previewRunning };
  }

  if (toolName === 'files_write' || toolName === 'files_make_dir' || toolName === 'files_remove') {
    return { phase: 'code', runningSummary: copy.summaries.codeRunningUpdate };
  }

  if (toolName === 'files_read' || toolName === 'files_list' || toolName === 'files_exists') {
    return null;
  }

  if (toolName === 'commands') {
    if (step.command && isInstallCommand(step.command)) {
      return { phase: 'install', runningSummary: copy.summaries.installRunning };
    }
    if (step.command && isPreviewCommand(step.command)) {
      return { phase: 'preview', runningSummary: copy.summaries.previewRunning };
    }
    return null;
  }

  return null;
}

function getRunningSummary(phase: NormalizedStepPhase, copy: TimelineCopy) {
  if (phase === 'scaffold') return copy.summaries.scaffoldRunning;
  if (phase === 'code') return copy.summaries.codeRunningUpdate;
  if (phase === 'install') return copy.summaries.installRunning;
  if (phase === 'preview') return copy.summaries.previewRunning;
  return copy.summaries.linkRunning;
}

function summarizeToolResult(
  phase: NormalizedStepPhase,
  ok: boolean,
  preview: string,
  copy: TimelineCopy,
  command = '',
) {
  if (!ok) {
    const detail = compactErrorSummary(preview, copy.summaries.stepFailed(getStepTitle(phase, copy)));
    return command
      ? copy.summaries.commandFailed(compactCommandSummary(command), detail)
      : detail;
  }

  if (phase === 'scaffold') {
    const result = getRecord(parseJsonPreview(preview));
    if (typeof result?.created === 'boolean') {
      return result.created ? copy.summaries.scaffoldCreated : copy.summaries.scaffoldExisting;
    }
    return copy.summaries.scaffoldReady;
  }

  if (phase === 'code') {
    const result = getRecord(parseJsonPreview(preview));
    const written = Array.isArray(result?.written) ? result.written : [];
    return written.length > 0 ? copy.summaries.codeUpdatedFiles(written.length) : copy.summaries.codeUpdated;
  }

  if (phase === 'install') {
    return copy.summaries.installDone;
  }

  if (phase === 'preview') {
    return copy.summaries.previewStarted;
  }

  const result = getRecord(parseJsonPreview(preview));
  const url = typeof result?.url === 'string'
    ? result.url
    : typeof result?.previewUrl === 'string'
      ? result.previewUrl
      : '';
  return url ? copy.summaries.linkDone : copy.summaries.linkDoneNoUrl;
}

function classifyStatusText(text: string, copy: TimelineCopy): {
  phase: NormalizedStepPhase;
  status: NormalizedStepStatus;
  summary: string;
} | null {
  if (/프로젝트\s*작업\s*공간.*준비|prepar(?:e|ing) the project workspace/i.test(text)) {
    return { phase: 'scaffold', status: 'running', summary: copy.summaries.scaffoldRunning };
  }
  if (/기존.*작업\s*공간|existing project workspace/i.test(text)) {
    return { phase: 'scaffold', status: 'done', summary: copy.summaries.scaffoldExisting };
  }
  if (/빈\s*프로젝트\s*작업\s*공간|empty project workspace/i.test(text)) {
    return { phase: 'scaffold', status: 'done', summary: copy.summaries.scaffoldCreated };
  }
  if (/자동\s*수정|검증\s*실패|auto-fix|validation|verification/i.test(text)) {
    return { phase: 'code', status: 'running', summary: copy.summaries.codeAutoFix };
  }
  if (/미리보기\s*링크.*가져|preview link (found|retrieved)/i.test(text)) {
    return { phase: 'link', status: 'done', summary: copy.summaries.linkDone };
  }
  if (/미리보기\s*링크.*(?:반환되지\s*않|없)|preview link (was not returned|missing)/i.test(text)) {
    return { phase: 'link', status: 'error', summary: copy.summaries.linkMissing };
  }
  return null;
}

function classifyLogText(text: string, stream: 'stdout' | 'stderr' | 'status', copy: TimelineCopy): {
  phase: NormalizedStepPhase;
  status: NormalizedStepStatus;
  summary: string;
} | null {
  if (stream === 'status') {
    return classifyStatusText(text, copy);
  }
  if (stream === 'stderr') {
    if (isInstallText(text)) {
      return { phase: 'install', status: 'error', summary: compactErrorSummary(text, copy.summaries.installFailed) };
    }
    if (/preview|미리보기|8080|3000|proxy|link|링크/i.test(text)) {
      return { phase: 'link', status: 'error', summary: compactErrorSummary(text, copy.summaries.previewFailed) };
    }
    return { phase: 'code', status: 'error', summary: compactErrorSummary(text, copy.summaries.processFailed) };
  }
  return null;
}

function parseJsonPreview(value: string): unknown {
  if (!value.trim()) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function getRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isPreviewCommand(cmd: string) {
  const normalized = cmd.toLowerCase();
  return (
    /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start)\b/.test(normalized)
    || /\b(next|vite|astro|nuxt)\s+dev\b/.test(normalized)
    || /\bpython\s+-m\s+http\.server\b/.test(normalized)
    || /\b(3000|8080)\b/.test(normalized) && /\b(dev|serve|server|preview|proxy)\b/.test(normalized)
  );
}

function isInstallCommand(cmd: string) {
  const normalized = cmd.toLowerCase();
  return (
    /\bnpm\s+(install|i)\b/.test(normalized)
    || /\bpnpm\s+install\b/.test(normalized)
    || /\byarn\s+install\b/.test(normalized)
    || /\bbun\s+install\b/.test(normalized)
    || /\bpython3?\s+-m\s+pip\s+install\b/.test(normalized)
    || /\bpip3?\s+install\b/.test(normalized)
  );
}

function isInstallText(text: string) {
  return (
    isInstallCommand(text)
    || /\b(dependency|dependencies|package install|install failed|failed to install)\b/i.test(text)
    || /의존성|설치\s*실패/.test(text)
  );
}

function compactErrorSummary(value: string, fallback: string) {
  const cleaned = value
    .replace(/\s+/g, ' ')
    .replace(/"content"\s*:\s*"[^"]+"/g, '"content":"<hidden>"')
    .trim();
  if (!cleaned) {
    return fallback;
  }
  return cleaned.length > 140 ? `${cleaned.slice(0, 140)}...` : cleaned;
}

function compactCommandSummary(value: string) {
  const cleaned = value.replace(/\s+/g, ' ').trim();
  return cleaned.length > 220 ? `${cleaned.slice(0, 220)}...` : cleaned;
}

function getStepTitle(phase: NormalizedStepPhase, copy: TimelineCopy) {
  return copy.definitions[phase]?.title || copy.summaries.unknownStep;
}

function shortenToolName(name: string) {
  // mcp__edgeone-sandbox__files -> files
  const m = name.match(/^mcp__[^_]+__(.+)$/);
  return m ? m[1] : name;
}

function Spinner() {
  return (
    <span
      className="inline-block size-3 animate-spin rounded-full border-2 border-[#7bd8b4]/40 border-t-[#7bd8b4]"
      aria-hidden="true"
    />
  );
}

function NarrationText({ content }: { content: string }) {
  return (
    <div className="min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
      {content}
    </div>
  );
}

function TypewriterNarrationText({
  content,
  onDisplayChange,
}: {
  content: string;
  onDisplayChange?: (content: string) => void;
}) {
  const [displayContent, setDisplayContent] = useState('');
  const targetRef = useRef(content);

  useEffect(() => {
    onDisplayChange?.(displayContent);
  }, [displayContent, onDisplayChange]);

  useEffect(() => {
    targetRef.current = content;

    const prefersReducedMotion = typeof window !== 'undefined'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReducedMotion) {
      setDisplayContent(content);
      return;
    }

    setDisplayContent((current) =>
      content.startsWith(current) ? current : '',
    );
  }, [content]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (prefersReducedMotion) {
        setDisplayContent(targetRef.current);
        return;
      }

      setDisplayContent((current) => {
        const target = targetRef.current;
        if (current === target) return current;
        return target.slice(0, current.length + NARRATION_TYPEWRITER_CHARS_PER_TICK);
      });
    }, NARRATION_TYPEWRITER_INTERVAL_MS);

    return () => window.clearInterval(timer);
  }, []);

  return (
    <>
      <NarrationText content={displayContent} />
      {displayContent.length < content.length && (
        <span
          className="ml-0.5 inline-block h-4 w-1 animate-pulse rounded-full bg-[#7bd8b4] align-[-0.15em]"
          aria-hidden="true"
        />
      )}
    </>
  );
}

function TypewriterMarkdownMessage({ content }: { content: string }) {
  const targetContent = sanitizeAssistantText(content);
  const [displayContent, setDisplayContent] = useState('');
  const targetRef = useRef(targetContent);

  useEffect(() => {
    targetRef.current = targetContent;

    const prefersReducedMotion = typeof window !== 'undefined'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReducedMotion) {
      setDisplayContent(targetContent);
      return;
    }

    setDisplayContent((current) =>
      targetContent.startsWith(current) ? current : '',
    );
  }, [targetContent]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (prefersReducedMotion) {
        setDisplayContent(targetRef.current);
        return;
      }

      setDisplayContent((current) => {
        const target = targetRef.current;
        if (current === target) return current;
        return target.slice(0, current.length + TYPEWRITER_CHARS_PER_TICK);
      });
    }, TYPEWRITER_INTERVAL_MS);

    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="min-w-0">
      <MarkdownMessage content={displayContent} />
      {displayContent.length < targetContent.length && (
        <span
          className="ml-0.5 inline-block h-4 w-1 animate-pulse rounded-full bg-[#7bd8b4] align-[-0.15em]"
          aria-hidden="true"
        />
      )}
    </div>
  );
}

function MarkdownMessage({ content }: { content: string }) {
  const displayContent = sanitizeAssistantText(content);

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
        ul: ({ children }) => <ul className="mb-2 list-disc space-y-1 pl-5 last:mb-0">{children}</ul>,
        ol: ({ children }) => <ol className="mb-2 list-decimal space-y-1 pl-5 last:mb-0">{children}</ol>,
        li: ({ children }) => <li className="pl-1">{children}</li>,
        a: ({ children, href }) => (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="my-1 inline-flex max-w-full items-center gap-1.5 break-all rounded-full bg-[#5ec7a0] px-3 py-1.5 text-xs font-semibold text-[#10241d] no-underline transition hover:bg-[#74d9b4]"
          >
            {children}
          </a>
        ),
        pre: ({ children }) => (
          <pre className="mb-2 max-w-full overflow-x-auto rounded-lg border border-white/10 bg-black/35 p-3 text-[12px] leading-5 last:mb-0">
            {children}
          </pre>
        ),
        code: ({ children, className, ...props }) => (
          <code
            className={`rounded bg-black/25 px-1 py-0.5 font-mono text-[0.92em] text-[#dff8ef] ${className || ''}`}
            {...props}
          >
            {children}
          </code>
        ),
      }}
    >
      {displayContent}
    </ReactMarkdown>
  );
}

type FilePreviewState =
  | { status: 'idle' }
  | { status: 'loading'; path: string }
  | {
      status: 'ready';
      path: string;
      content: string;
      truncated: boolean;
      size: number;
    }
  | { status: 'error'; path: string; error: string };

function FilesPanel({
  tree,
  refreshing,
  conversationId,
  copy,
}: {
  tree: FileTree | null;
  refreshing: boolean;
  conversationId: string | null;
  copy: FileCopy;
}) {
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(() => new Set());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<FilePreviewState>({ status: 'idle' });
  // Track the latest requested path so slower responses cannot overwrite newer selections.
  const latestRequestRef = useRef<string | null>(null);

  // Clear local file preview state when the conversation changes and the file tree root changes.
  useEffect(() => {
    setCollapsedDirs(new Set());
    setSelectedPath(null);
    setPreview({ status: 'idle' });
    latestRequestRef.current = null;
  }, [tree?.root]);

  const visibleItems = useMemo(() => {
    if (!tree) {
      return [];
    }

    return tree.items.filter((item) => {
      for (const collapsedPath of collapsedDirs) {
        if (item.path !== collapsedPath && item.path.startsWith(`${collapsedPath}/`)) {
          return false;
        }
      }
      return true;
    });
  }, [collapsedDirs, tree]);

  const toggleDirectory = (path: string) => {
    setCollapsedDirs((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const loadFile = async (path: string) => {
    setSelectedPath(path);
    latestRequestRef.current = path;
    setPreview({ status: 'loading', path });
    try {
      const headers: HeadersInit = {};
      const cid = conversationId || getOrCreateCachedConversationId();
      if (cid) {
        headers['makers-conversation-id'] = cid;
        headers['conversationId'] = cid;
      }
      const resp = await fetch(`/file?path=${encodeURIComponent(path)}`, {
        method: 'GET',
        headers,
      });
      const data = (await resp.json()) as {
        ok?: boolean;
        path?: string;
        content?: string;
        size?: number;
        truncated?: boolean;
        error?: string;
      };
      // Discard this response if the user selected another file while it was loading.
      if (latestRequestRef.current !== path) {
        return;
      }
      if (!data.ok) {
        setPreview({ status: 'error', path, error: data.error || copy.readFailed });
        return;
      }
      setPreview({
        status: 'ready',
        path,
        content: data.content || '',
        truncated: Boolean(data.truncated),
        size: typeof data.size === 'number' ? data.size : 0,
      });
    } catch (err) {
      if (latestRequestRef.current !== path) {
        return;
      }
      setPreview({
        status: 'error',
        path,
        error: err instanceof Error ? err.message : copy.requestFailed,
      });
    }
  };

  if (!tree || tree.items.length === 0) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center bg-[#0b0f0d] px-6 text-center text-[#b5c4be]">
        {refreshing ? copy.refreshing : copy.empty}
      </div>
    );
  }

  return (
    <div className="grid h-full min-h-0 grid-cols-[280px_minmax(0,1fr)] bg-[#0b0f0d] text-[#d7e5df]">
      <aside className="flex min-h-0 flex-col border-r border-white/10">
        <div className="border-b border-white/10 bg-[#101412] px-4 py-3">
          <p className="truncate text-xs uppercase tracking-[0.16em] text-[#7bd8b4]">
            {tree.root}
          </p>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-3">
          <div className="space-y-0.5 font-mono text-[12px] leading-5">
            {visibleItems.map((item) => {
              const isDirectory = item.type === 'directory';
              const isCollapsed = collapsedDirs.has(item.path);
              const isSelected = !isDirectory && selectedPath === item.path;

              return (
                <button
                  key={item.path}
                  type="button"
                  onClick={() => {
                    if (isDirectory) {
                      toggleDirectory(item.path);
                    } else {
                      loadFile(item.path);
                    }
                  }}
                  className={`flex w-full min-w-max items-center gap-2 rounded px-2 py-1 text-left transition ${
                    isSelected
                      ? 'bg-[#7bd8b4]/15 text-[#edfff7]'
                      : 'text-[#cfe0d9] hover:bg-white/[0.06]'
                  }`}
                  style={{ paddingLeft: `${8 + item.depth * 18}px` }}
                >
                  <span
                    className={
                      isDirectory ? 'text-[#f2c779]' : 'text-[#7bd8b4]'
                    }
                    aria-hidden="true"
                  >
                    {isDirectory ? (isCollapsed ? '▸' : '▾') : '•'}
                  </span>
                  <span className={isDirectory ? 'font-semibold' : ''}>
                    {item.name}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </aside>

      <div className="flex min-h-0 flex-col">
        <FileContentView preview={preview} copy={copy} />
      </div>
    </div>
  );
}

function FileContentView({ preview, copy }: { preview: FilePreviewState; copy: FileCopy }) {
  if (preview.status === 'idle') {
    return (
      <div className="flex h-full min-h-0 items-center justify-center px-6 text-center text-[#7d8c85]">
        {copy.selectFile}
      </div>
    );
  }
  if (preview.status === 'loading') {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center gap-2 border-b border-white/10 bg-[#101412] px-4 py-3 text-xs text-[#7bd8b4]">
          <Spinner />
          <span className="truncate font-mono text-[11px] text-white/55">
            {copy.loading(preview.path)}
          </span>
        </div>
        <div className="flex flex-1 items-center justify-center text-[#7d8c85]">
          <Spinner />
        </div>
      </div>
    );
  }
  if (preview.status === 'error') {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="border-b border-white/10 bg-[#101412] px-4 py-3">
          <p className="truncate font-mono text-[11px] text-white/55">{preview.path}</p>
        </div>
        <div className="flex flex-1 items-center justify-center px-6 text-center text-rose-300">
          {preview.error}
        </div>
      </div>
    );
  }

  const lines = preview.content.split('\n');
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 bg-[#101412] px-4 py-3">
        <p className="min-w-0 truncate font-mono text-[11px] text-white/65">
          {preview.path}
        </p>
        <div className="flex shrink-0 items-center gap-2 font-mono text-[11px] text-white/40">
          <span>{copy.lines(lines.length)}</span>
          <span>{formatFileSize(preview.size)}</span>
          {preview.truncated && (
            <span className="rounded-full bg-amber-400/15 px-2 py-0.5 text-amber-200">
              {copy.truncated}
            </span>
          )}
        </div>
      </div>
      <pre className="min-h-0 flex-1 overflow-auto bg-[#070a09] py-3 font-mono text-[12px] leading-5 text-[#cfe0d9]">
        <code>
          {lines.map((line, lineIndex) => (
            <span
              key={lineIndex}
              className="grid min-w-max grid-cols-[3.5rem_minmax(0,1fr)] gap-3 px-4"
            >
              <span className="select-none text-right text-white/25">
                {lineIndex + 1}
              </span>
              <span className="whitespace-pre">{line || ' '}</span>
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}

function formatFileSize(bytes: number): string {
  if (!bytes || bytes < 1024) return `${bytes || 0} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function ArrowIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="size-8 text-[#31755c]"
      fill="currentColor"
    >
      <path d="M4 4.9 21 12 4 19.1l3.2-6.2L16 12l-8.8-.9L4 4.9Z" />
    </svg>
  );
}

function PaperclipIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M16.5 6.5 8.7 14.3a3 3 0 1 0 4.24 4.24l8.49-8.49a5 5 0 1 0-7.07-7.07L5.5 11.83a7 7 0 1 0 9.9 9.9"
      />
    </svg>
  );
}

function FigmaIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-6" fill="currentColor">
      <path d="M8 24a4 4 0 0 0 4-4v-4H8a4 4 0 0 0 0 8Zm-4-8a4 4 0 0 1 4-4h4V4H8a4 4 0 0 0 0 8 4 4 0 0 0-4 4ZM8 0a4 4 0 0 0 0 8h4V0H8Zm4 0v8h4a4 4 0 0 0 0-8h-4Zm0 8v8h4a4 4 0 0 0 0-8h-4Z" />
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-6" fill="currentColor">
      <path d="M12 .5A11.5 11.5 0 0 0 8.4 22.9c.58.1.8-.25.8-.56v-2.1c-3.26.7-3.95-1.4-3.95-1.4-.53-1.34-1.3-1.7-1.3-1.7-1.06-.72.08-.7.08-.7 1.18.08 1.8 1.2 1.8 1.2 1.04 1.79 2.74 1.27 3.42.97.1-.75.4-1.27.74-1.56-2.6-.3-5.34-1.3-5.34-5.76 0-1.27.46-2.32 1.2-3.14-.12-.3-.52-1.5.12-3.1 0 0 .98-.32 3.22 1.2a11.1 11.1 0 0 1 5.86 0c2.23-1.52 3.2-1.2 3.2-1.2.65 1.6.25 2.8.13 3.1.75.82 1.2 1.87 1.2 3.14 0 4.47-2.74 5.45-5.35 5.75.42.36.8 1.08.8 2.18v3.23c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z" />
    </svg>
  );
}

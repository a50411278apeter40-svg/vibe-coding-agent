export type BuildStatus = 'success' | 'failed' | 'skipped';

export type ProjectState = {
  created: boolean;
  sessionDir: string;
  appDir: string;
  previewUrl?: string;
  sandboxDebugUrl?: string;
  // Persisted across turns (via context.store's conversation metadata) so a
  // signed-in user's next message reconnects to the SAME Daytona sandbox
  // instead of paying for a brand-new one every time. See _daytonaSandbox.ts.
  daytonaSandboxId?: string;
  // Ephemeral, in-memory-only flag for the current turn -- never persisted.
  // Set by the pipeline for anonymous (not-logged-in) users, whose workspace
  // must be wiped clean every turn. Consumed and cleared by
  // ensureProjectScaffold the moment the model actually calls that tool, so
  // the wipe (and the Daytona sandbox it requires) only happens for turns
  // that really need a project workspace -- not for every single message.
  forceReset?: boolean;
};

export type ConversationMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export type StreamSend = (event: Record<string, unknown>) => void;

export type ScaffoldLog = {
  stream: 'status' | 'stdout' | 'stderr';
  content: string;
};

export type CodingAgentResult = {
  success: boolean;
  output: string | null;
  error: string | null;
  projectTouched: boolean;
  previewTouched?: boolean;
  wasCreated: boolean;
  fatal?: boolean;
};

export type BuildResult = {
  status: BuildStatus;
  stdout?: string;
  stderr?: string;
  autoFixAttempts?: number;
  autoFixApplied?: boolean;
  fatal?: boolean;
};

export type ProjectFileInput = {
  path: string;
  content: string;
};

export type FileTreeItem = {
  path: string;
  name: string;
  type: 'file' | 'directory';
  depth: number;
};

// Progress events streamed to the frontend. tool_use is the model's tool request,
// and tool_result is the tool response. The assistant message renders these live.
export type AgentProgressEvent =
  | {
      type: 'tool_use';
      data: {
        id: string;
        name: string;
        command?: string;
        phaseHint?: 'scaffold' | 'code' | 'install' | 'preview' | 'link';
        fileCount?: number;
      };
    }
  | {
      type: 'tool_result';
      data: {
        tool_use_id: string;
        toolName?: string;
        command?: string;
        ok: boolean;
        preview: string;
      };
    }
  | {
      type: 'text_segment';
      data: {
        uuid: string;
        text: string;
      };
    };

// Moved from the removed legacy _agent.ts (dead Claude Agent SDK sandbox path).
export type ImageAttachment = {
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  base64: string;
};

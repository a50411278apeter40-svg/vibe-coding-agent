// Daytona-backed replacement for the EdgeOne/E2B `context.sandbox` object.
//
// The `agents/` framework injects `context.sandbox` itself before our code
// ever runs, so we cannot swap the underlying provider at the injection
// point. What we CAN do is overwrite the `context.sandbox` property at the
// top of each pipeline (see attachDaytonaSandbox in _pipelines.ts) so every
// downstream call (_project.ts, _projectStore.ts, the tool implementations)
// transparently talks to a sandbox running on the user's own Daytona
// account instead of the platform's shared pool. Every call site keeps
// working unchanged because this adapter exposes the same shape:
// files.exists/write/makeDir and commands.run, plus a couple of extras used
// by resolvePublicLinks() for the live preview link.
import { Daytona } from '@daytona/sdk';

export type DaytonaSandboxAdapter = {
  id: string;
  files: {
    exists(path: string): Promise<boolean>;
    write(path: string, content: string | Buffer): Promise<void>;
    makeDir(path: string): Promise<void>;
  };
  commands: {
    run(
      command: string,
      options?: { cwd?: string; timeout?: number; env?: Record<string, string> },
    ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  };
  getSignedPreviewUrl(port: number, expiresInSeconds?: number): Promise<string | undefined>;
  getInfo(): { id: string; state?: string };
  extendTimeout(seconds: number): Promise<void>;
  // No Daytona equivalent to E2B's envd access token / desktop live view —
  // resolvePublicLinks() in _project.ts checks these are undefined and skips
  // the parts of the old preview-link flow that don't apply here.
  envdAccessToken: undefined;
  browser: undefined;
};

let client: InstanceType<typeof Daytona> | null = null;

function getClient(): InstanceType<typeof Daytona> {
  if (!client) {
    const apiKey = process.env.DAYTONA_API_KEY;
    if (!apiKey) {
      throw new Error('DAYTONA_API_KEY is not configured. Add it in the agent secrets to use the Daytona sandbox.');
    }
    client = new Daytona({ apiKey });
  }
  return client;
}

// Per-process cache so repeated calls within the same warm invocation reuse
// the same raw Sandbox handle instead of re-fetching it from the Daytona API
// every time. This is a best-effort speedup only — the real cross-request
// persistence comes from passing `existingSandboxId` in (see below), which
// the caller should read from and write back into ProjectState.
const warmCache = new Map<string, any>();

// Deliberate proactive cleanup on top of Daytona's own autoDeleteInterval
// (7 days -- see resolveRawSandbox below). A `started` (or even `stopped`)
// sandbox permanently reserves its slice of the org's shared CPU+memory
// quota until it is actually deleted, so waiting a full week to reclaim an
// idle conversation's sandbox meant the org could run out of quota (both
// CPU and memory) after only ~10 conversations had ever touched a project,
// regardless of how idle most of them were. Instead, once a turn finishes
// using a sandbox we schedule its deletion after a short idle grace period
// (long enough that the user can still view/click around the preview they
// were just given) rather than deleting it synchronously in the same
// request. Signed-in users never lose anything: autoSaveProjectSnapshot
// keeps a full zip snapshot of every project file in Supabase, and
// restoreProjectSnapshotIfEmpty unpacks it back into a brand-new sandbox
// the next time the conversation is touched.
const SANDBOX_IDLE_DELETE_MS = 2 * 60 * 1000; // 2 minutes
const pendingDeletions = new Map<string, ReturnType<typeof setTimeout>>();

export function cancelScheduledDaytonaDelete(conversationId: string): void {
  const timer = pendingDeletions.get(conversationId);
  if (timer) {
    clearTimeout(timer);
    pendingDeletions.delete(conversationId);
  }
}

// Actually deletes a sandbox right now (frees its quota immediately). Used
// both by the delayed cleanup below and directly wherever an immediate,
// synchronous free-up is preferable to waiting out the grace period.
export async function deleteDaytonaSandbox(conversationId: string, sandboxId?: string | null): Promise<void> {
  cancelScheduledDaytonaDelete(conversationId);
  warmCache.delete(conversationId);
  if (!sandboxId) return;
  try {
    const daytona = getClient();
    const raw = await daytona.get(sandboxId);
    await daytona.delete(raw);
  } catch {
    // Best-effort: already gone, or the delete call failed -- the 7-day
    // autoDeleteInterval remains as a fallback safety net either way.
  }
}

// Schedules (rather than immediately performs) the sandbox deletion so an
// idle conversation gives up its quota soon, but a user still looking at
// the preview they just got isn't cut off mid-click. Any later turn that
// actually resolves/reuses this same sandbox (see resolveRawSandbox) cancels
// the pending timer first, so active use is never interrupted.
export function scheduleDaytonaSandboxDelete(conversationId: string, sandboxId?: string | null): void {
  if (!sandboxId) return;
  cancelScheduledDaytonaDelete(conversationId);
  const timer = setTimeout(() => {
    pendingDeletions.delete(conversationId);
    void deleteDaytonaSandbox(conversationId, sandboxId);
  }, SANDBOX_IDLE_DELETE_MS);
  if (typeof (timer as any).unref === 'function') (timer as any).unref();
  pendingDeletions.set(conversationId, timer);
}

async function resolveRawSandbox(conversationId: string, existingSandboxId?: string | null): Promise<any> {
  // Any turn that actually reaches for the sandbox again cancels a pending
  // idle-delete from an earlier turn -- it is clearly still in active use.
  cancelScheduledDaytonaDelete(conversationId);
  const cached = warmCache.get(conversationId);
  if (cached) return cached;

  const daytona = getClient();
  let raw: any = null;

  if (existingSandboxId) {
    try {
      raw = await daytona.get(existingSandboxId);
      if (raw && raw.state !== 'started') {
        await raw.start(60);
      }
    } catch {
      raw = null;
    }
  }

  if (!raw) {
    raw = await daytona.create({
      // Specifying resources requires the "create from image" overload, so
      // we pin a concrete Node.js image rather than a bare snapshot.
      image: 'node:20',
      language: 'javascript',
      // Kept deliberately small: the org-wide Daytona free-tier quota is a
      // *total* memory ceiling across every concurrently-running sandbox
      // (10GiB at the time of writing), not a per-sandbox or per-request
      // limit. At the previous 4GiB/sandbox footprint only 2 conversations
      // could ever be live at once — a 3rd user (or even a 3rd test run)
      // got a hard "Total memory limit exceeded" failure. A lightweight
      // Next.js/Vite dev server plus npm install comfortably fits in 1GiB,
      // which raises that ceiling to 10 concurrent conversations instead.
      resources: { cpu: 1, memory: 1, disk: 3 },
      // Mirrors the platform's own ~30 minute idle timeout for the sandbox
      // it used to inject (see edgeone.json's agents.sandbox.timeout).
      autoStopInterval: 30,
      // IMPORTANT: a Daytona sandbox that is merely "stopped" (not deleted)
      // still counts against the org's total memory quota -- confirmed live
      // by observing `Total memory limit exceeded` while every sandbox but
      // one was in the `stopped` state. Combined with the old `-1` (never
      // auto-delete) setting, every conversation that ever existed would
      // permanently reserve its slice of the shared 10GiB quota forever,
      // eventually locking out all new sandboxes regardless of how idle
      // everyone's projects were. 7 days gives signed-in users a full week
      // of "resume the same warm sandbox" convenience (Supabase-backed file
      // snapshots are the durable source of truth regardless, so nothing is
      // ever actually lost) while guaranteeing abandoned sandboxes
      // eventually give their quota back.
      autoDeleteInterval: 10080,
    });
  }

  warmCache.set(conversationId, raw);
  return raw;
}

function buildAdapterFromRaw(raw: any): DaytonaSandboxAdapter {
  return {
    id: raw.id as string,
    files: {
      async exists(path: string) {
        try {
          await raw.fs.getFileDetails(path);
          return true;
        } catch {
          return false;
        }
      },
      async write(path: string, content: string | Buffer) {
        const buffer = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
        await raw.fs.uploadFile(buffer, path);
      },
      async makeDir(path: string) {
        try {
          await raw.fs.createFolder(path, '755');
        } catch (error) {
          // Keep this idempotent like the old context.sandbox.files.makeDir:
          // swallow "already exists" style errors, rethrow anything else.
          const message = error instanceof Error ? error.message : String(error);
          if (!/exist/i.test(message)) throw error;
        }
      },
    },
    commands: {
      async run(command: string, options: { cwd?: string; timeout?: number; env?: Record<string, string> } = {}) {
        const response = await raw.process.executeCommand(command, options.cwd, options.env, options.timeout);
        const stdout = typeof response?.result === 'string'
          ? response.result
          : (typeof response?.artifacts?.stdout === 'string' ? response.artifacts.stdout : '');
        return {
          exitCode: typeof response?.exitCode === 'number' ? response.exitCode : 0,
          stdout,
          stderr: '',
        };
      },
    },
    async getSignedPreviewUrl(port: number, expiresInSeconds = 3600) {
      try {
        const signed = await raw.getSignedPreviewUrl(port, expiresInSeconds);
        return typeof signed?.url === 'string' ? signed.url : undefined;
      } catch {
        return undefined;
      }
    },
    getInfo() {
      return { id: raw.id as string, state: raw.state as string | undefined };
    },
    async extendTimeout() {
      try {
        if (typeof raw.refreshActivity === 'function') {
          await raw.refreshActivity();
        }
      } catch {
        // Best-effort: a failed activity refresh should never break a live turn.
      }
    },
    envdAccessToken: undefined,
    browser: undefined,
  };
}

export async function createDaytonaSandboxAdapter(
  conversationId: string,
  existingSandboxId?: string | null,
): Promise<DaytonaSandboxAdapter> {
  const raw = await resolveRawSandbox(conversationId, existingSandboxId);
  return buildAdapterFromRaw(raw);
}

// Lazy variant: returns a same-shaped adapter SYNCHRONOUSLY, without making
// any Daytona API call yet. The very first time any of its methods actually
// runs, it resolves (and, if needed, creates) the real sandbox, then reuses
// it for every later call. This matters because a huge fraction of chat
// turns are plain questions/conversation that the system prompt already
// tells the model to answer directly (no project tools at all, see
// buildGroqSystemPrompt) — eagerly creating/resuming a real sandbox on
// every single turn regardless of whether it will ever be touched wastes
// the org's shared Daytona memory quota and was the direct cause of
// "Total memory limit exceeded" failures during ordinary use. With this,
// a sandbox is only ever spun up for turns that actually need one.
//
// `onResolved` fires once, right after the real sandbox is known, so the
// caller can persist the resolved id onto ProjectState (which may not have
// existed yet at attach time for a brand-new conversation).
export function createLazyDaytonaSandboxAdapter(
  conversationId: string,
  existingSandboxId: string | null | undefined,
  onResolved?: (sandboxId: string) => void,
): DaytonaSandboxAdapter {
  let resolvedPromise: Promise<any> | null = null;
  let resolvedId: string | undefined = existingSandboxId || undefined;

  const ensureRaw = (): Promise<any> => {
    if (!resolvedPromise) {
      resolvedPromise = resolveRawSandbox(conversationId, existingSandboxId).then((raw) => {
        resolvedId = raw.id as string;
        onResolved?.(resolvedId);
        return raw;
      });
    }
    return resolvedPromise;
  };

  return {
    get id() {
      // Best-effort synchronous value: the previously-known id before
      // resolution, or the real one once resolved. Nothing in this
      // codebase relies on `.id` being accurate before the first async
      // method call actually runs.
      return resolvedId || '';
    },
    files: {
      async exists(path: string) {
        const raw = await ensureRaw();
        return buildAdapterFromRaw(raw).files.exists(path);
      },
      async write(path: string, content: string | Buffer) {
        const raw = await ensureRaw();
        return buildAdapterFromRaw(raw).files.write(path, content);
      },
      async makeDir(path: string) {
        const raw = await ensureRaw();
        return buildAdapterFromRaw(raw).files.makeDir(path);
      },
    },
    commands: {
      async run(command: string, options?: { cwd?: string; timeout?: number; env?: Record<string, string> }) {
        const raw = await ensureRaw();
        return buildAdapterFromRaw(raw).commands.run(command, options);
      },
    },
    async getSignedPreviewUrl(port: number, expiresInSeconds = 3600) {
      const raw = await ensureRaw();
      return buildAdapterFromRaw(raw).getSignedPreviewUrl(port, expiresInSeconds);
    },
    getInfo() {
      return { id: resolvedId || '', state: undefined };
    },
    async extendTimeout(seconds: number) {
      const raw = await ensureRaw();
      return buildAdapterFromRaw(raw).extendTimeout(seconds);
    },
    envdAccessToken: undefined,
    browser: undefined,
  };
}

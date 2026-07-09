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

async function resolveRawSandbox(conversationId: string, existingSandboxId?: string | null): Promise<any> {
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
      resources: { cpu: 2, memory: 4, disk: 8 },
      // Mirrors the platform's own ~30 minute idle timeout for the sandbox
      // it used to inject (see edgeone.json's agents.sandbox.timeout).
      autoStopInterval: 30,
      // Never auto-delete: Supabase-backed file snapshots are the durable
      // source of truth already, but keeping the sandbox itself around
      // means signed-in users resume the SAME warm sandbox (with
      // node_modules intact) instead of paying for a fresh npm install
      // every time it is reused within its stopped-but-not-deleted window.
      autoDeleteInterval: -1,
    });
  }

  warmCache.set(conversationId, raw);
  return raw;
}

export async function createDaytonaSandboxAdapter(
  conversationId: string,
  existingSandboxId?: string | null,
): Promise<DaytonaSandboxAdapter> {
  const raw = await resolveRawSandbox(conversationId, existingSandboxId);

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

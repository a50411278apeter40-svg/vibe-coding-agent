// Supabase-backed persistence for per-user projects.
//
// Chat history and build/preview state for a conversation already persist
// durably through the platform's own context.store (see _memory.ts) — that
// part is not something this project manages. What IS at risk is the actual
// project FILES: they live on the sandbox's disk, and this project's own
// rule is that only signed-in users keep a sandbox across turns at all (see
// _pipelines.ts's shouldResetProject). Even for signed-in users, the sandbox
// instance itself can be recycled by the platform after long idle periods,
// so this module keeps an independent, durable copy of the text files in
// Supabase and can restore them into a fresh sandbox on demand.
//
// Best-effort everywhere: a Supabase hiccup must never break a live chat
// turn, so every exported function swallows its own errors.

import type { ProjectState } from './_types';
import { getFileTree, readFileFromSandbox, runSandboxCommand } from './_project';

function getSupabaseConfig(context: any): { url: string; key: string } | null {
  const url = context?.env?.SUPABASE_URL || process.env?.SUPABASE_URL;
  const key = context?.env?.SUPABASE_SERVICE_ROLE_KEY || process.env?.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return { url: String(url).replace(/\/+$/, ''), key: String(key) };
}

async function supabaseFetch(context: any, path: string, init: RequestInit = {}): Promise<Response | null> {
  const config = getSupabaseConfig(context);
  if (!config) return null;
  try {
    const headers = new Headers(init.headers || {});
    headers.set('apikey', config.key);
    headers.set('Authorization', `Bearer ${config.key}`);
    if (!headers.has('content-type') && init.body) {
      headers.set('content-type', 'application/json');
    }
    return await fetch(`${config.url}/rest/v1/${path}`, { ...init, headers });
  } catch {
    return null;
  }
}

// Combined guardrails so one huge/odd project can never blow up a Supabase
// free-tier row or a slow request: same file-count cap as the Files panel
// (getFileTree already caps at 220), plus a total-bytes cap across all files.
const MAX_SNAPSHOT_TOTAL_BYTES = 3 * 1024 * 1024; // 3MB combined text content.

function deriveTitleFromMessage(message: string): string {
  const normalized = String(message || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '새 프로젝트';
  const maxLength = 40;
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength).trimEnd()}...` : normalized;
}

function generateProjectId(): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `p${Date.now().toString(36)}${random}`;
}

async function getExistingProjectMeta(
  context: any,
  conversationId: string,
): Promise<{ id: string; title: string } | null> {
  const response = await supabaseFetch(
    context,
    `projects?conversation_id=eq.${encodeURIComponent(conversationId)}&select=id,title&limit=1`,
  );
  if (!response || !response.ok) return null;
  const rows = (await response.json().catch(() => [])) as Array<{ id: string; title: string }>;
  return rows[0] || null;
}

// Reads every text file currently in the sandbox project dir (reusing the
// same ignore/size rules as the Files panel) and upserts it as this
// conversation's saved project snapshot for `userId`. Call this whenever the
// project's files may have changed and the user is signed in.
export async function autoSaveProjectSnapshot(
  context: any,
  conversationId: string,
  userId: string,
  state: ProjectState,
  firstMessage: string,
): Promise<void> {
  if (!userId || !conversationId) return;
  if (!getSupabaseConfig(context)) return;

  try {
    const tree = await getFileTree(context, state);
    const fileItems = tree.filter((item) => item.type === 'file');
    if (fileItems.length === 0) return;

    const files: Record<string, string> = {};
    let totalBytes = 0;
    for (const item of fileItems) {
      const res = await readFileFromSandbox(context, state, item.path);
      if (!res.ok || typeof res.content !== 'string') continue;
      const size = typeof res.size === 'number' ? res.size : res.content.length;
      if (totalBytes + size > MAX_SNAPSHOT_TOTAL_BYTES) break;
      files[item.path] = res.content;
      totalBytes += size;
    }
    if (Object.keys(files).length === 0) return;

    const existing = await getExistingProjectMeta(context, conversationId);
    const title = existing?.title || deriveTitleFromMessage(firstMessage);
    const id = existing?.id || generateProjectId();

    await supabaseFetch(context, 'projects?on_conflict=conversation_id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({
        id,
        user_id: userId,
        conversation_id: conversationId,
        title,
        files,
        updated_at: new Date().toISOString(),
      }),
    });
  } catch {
    // Auto-save is best-effort and must never break the live chat turn.
  }
}

// True when the current sandbox's project dir has no real files yet (a
// brand-new or recycled sandbox instance), same emptiness check used by
// ensure_project_scaffold.
async function isSandboxProjectEmpty(context: any, state: ProjectState): Promise<boolean> {
  const sandbox = context.sandbox;
  await sandbox.files.makeDir(state.sessionDir);
  await sandbox.files.makeDir(state.appDir);

  const existing = await runSandboxCommand(
    context,
    [
      'find . -mindepth 1 -maxdepth 2',
      "\\( -path './node_modules' -o -path './.next' -o -path './.git' -o -path './dist' -o -path './build' \\) -prune",
      '-o -print',
    ].join(' '),
    { cwd: state.appDir, timeout: 60 },
  );
  if (existing.exitCode !== 0) return false;
  return existing.stdout.trim().length === 0;
}

// If this conversation's sandbox project dir is currently empty (fresh or
// recycled sandbox) and a Supabase snapshot exists for it, writes every saved
// file back in. Returns true when files were restored. Safe to call even
// when there is nothing to restore — it's a no-op in that case.
export async function restoreProjectSnapshotIfEmpty(
  context: any,
  conversationId: string,
  userId: string,
  state: ProjectState,
): Promise<boolean> {
  if (!userId || !conversationId) return false;
  if (!getSupabaseConfig(context)) return false;

  try {
    const empty = await isSandboxProjectEmpty(context, state);
    if (!empty) return false;

    const response = await supabaseFetch(
      context,
      `projects?conversation_id=eq.${encodeURIComponent(conversationId)}&select=files&limit=1`,
    );
    if (!response || !response.ok) return false;
    const rows = (await response.json().catch(() => [])) as Array<{ files?: Record<string, string> }>;
    const files = rows[0]?.files;
    if (!files || typeof files !== 'object' || Object.keys(files).length === 0) return false;

    const sandbox = context.sandbox;
    const dirsCreated = new Set<string>();
    for (const [relPath, content] of Object.entries(files)) {
      if (typeof content !== 'string') continue;
      const segments = relPath.split('/');
      segments.pop();
      let dirPath = '';
      for (const segment of segments) {
        if (!segment) continue;
        dirPath = dirPath ? `${dirPath}/${segment}` : segment;
        const absDir = `${state.appDir}/${dirPath}`;
        if (!dirsCreated.has(absDir)) {
          await sandbox.files.makeDir(absDir);
          dirsCreated.add(absDir);
        }
      }
      await sandbox.files.write(`${state.appDir}/${relPath}`, content);
    }
    return true;
  } catch {
    return false;
  }
}

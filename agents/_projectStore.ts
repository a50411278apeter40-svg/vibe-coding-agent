// Supabase-backed persistence for per-user projects.
//
// Chat history and build/preview state for a conversation already persist
// durably through the platform's own context.store (see _memory.ts) — that
// part is not something this project manages. What IS at risk is the actual
// project FILES: they live on the sandbox's disk, and (as of the Daytona
// migration) sandboxes are deliberately short-lived -- they get deleted
// shortly after each turn to free up the org's shared CPU/memory quota (see
// scheduleDaytonaSandboxDelete in _daytonaSandbox.ts). This module is what
// makes that safe: it keeps a complete, lossless copy of every project file
// in Supabase (as a zip archive, so binaries survive too, not just text) and
// restores it into a fresh sandbox on demand.
//
// Best-effort everywhere: a Supabase hiccup must never break a live chat
// turn, so every exported function swallows its own errors.

import type { ProjectState } from './_types';
import { createProjectArchive, extractProjectArchive, runSandboxCommand } from './_project';

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

// Zips the entire current project workspace (every file — text AND binary —
// except regenerable build artifacts like node_modules/.git/.next, see
// ARCHIVE_EXCLUDED_DIRECTORIES in _constants.ts) and upserts it as this
// conversation's saved snapshot for `userId`. This is the *only* copy of the
// project's files that survives once the sandbox itself is deleted, so
// nothing is capped/truncated here the way the old per-file text snapshot
// used to be (that approach silently dropped files past a 3MB total or a
// 220-file-count limit, and refused binary files outright — unacceptable
// now that this is the sole persistence path, not just a convenience cache).
// Call this whenever the project's files may have changed and the user is
// signed in.
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
    const archive = await createProjectArchive(context, state);
    if (!archive.ok) {
      // Empty workspace, or over the (generous, 60MB) archive size ceiling —
      // nothing sane to save either way.
      return;
    }

    const existing = await getExistingProjectMeta(context, conversationId);
    const title = existing?.title || deriveTitleFromMessage(firstMessage);
    const id = existing?.id || generateProjectId();
    const format = archive.filename.endsWith('.tar.gz') ? 'tar.gz' : 'zip';

    await supabaseFetch(context, 'projects?on_conflict=conversation_id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({
        id,
        user_id: userId,
        conversation_id: conversationId,
        title,
        archive_base64: archive.base64,
        archive_format: format,
        archive_size: archive.size,
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

// If this conversation's sandbox project dir is currently empty (fresh sandbox
// — expected on almost every turn now, since sandboxes are deleted shortly
// after each turn to free quota) and a Supabase snapshot exists for it,
// unpacks the full saved zip archive back in. Returns true when files were
// restored. Safe to call even when there is nothing to restore — it's a
// no-op in that case.
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
      `projects?conversation_id=eq.${encodeURIComponent(conversationId)}&select=archive_base64,archive_format&limit=1`,
    );
    if (!response || !response.ok) return false;
    const rows = (await response.json().catch(() => [])) as Array<{
      archive_base64?: string;
      archive_format?: string;
    }>;
    const row = rows[0];
    const base64 = row?.archive_base64;
    if (!base64 || typeof base64 !== 'string') return false;

    const format = row?.archive_format === 'tar.gz' ? 'tar.gz' : 'zip';
    const result = await extractProjectArchive(context, state, base64, format);
    return result.ok;
  } catch {
    return false;
  }
}

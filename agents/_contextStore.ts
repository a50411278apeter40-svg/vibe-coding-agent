// Supabase-backed replacement for the EdgeOne "agents" framework's built-in
// context.store (conversation + message memory API). _memory.ts calls
// context.store.getMessages/appendMessage/getConversation/updateConversation
// -- this module implements that exact same contract on top of a plain
// Supabase Postgres project (same one already used for per-user project
// snapshots, see _projectStore.ts), so this app's chat history and
// conversation-scoped project state keep working identically whether it
// runs on EdgeOne Makers (which provides context.store natively) or as
// plain Next.js Route Handlers anywhere else (Render, Vercel, a bare Node
// server...). See _lib/conversations-schema.sql for the one-time SQL setup,
// and _httpContext.ts for where this gets wired into a shimmed context.
//
// Best-effort-ish like the rest of this project's Supabase helpers, but
// unlike _projectStore.ts (which is fire-and-forget autosave), a broken
// Supabase config here is a hard error: without a working store, this
// project has no chat history or project-state persistence at all, so
// callers should see a clear failure instead of silently losing everything.

export class MemoryNotFoundError extends Error {
  code = 'MemoryNotFoundError';
  constructor(message: string) {
    super(message);
    this.name = 'MemoryNotFoundError';
  }
}

function getSupabaseConfig(): { url: string; key: string } {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set. Required for chat '
      + 'history + project state persistence outside of EdgeOne Makers. See '
      + 'agents/_lib/conversations-schema.sql.',
    );
  }
  return { url: String(url).replace(/\/+$/, ''), key: String(key) };
}

async function supabaseFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const config = getSupabaseConfig();
  const headers = new Headers(init.headers || {});
  headers.set('apikey', config.key);
  headers.set('Authorization', `Bearer ${config.key}`);
  if (!headers.has('content-type') && init.body) {
    headers.set('content-type', 'application/json');
  }
  const response = await fetch(`${config.url}/rest/v1/${path}`, { ...init, headers });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Supabase request failed (${response.status}): ${text.slice(0, 300)}`);
  }
  return response;
}

async function ensureConversation(conversationId: string, userId?: string): Promise<void> {
  await supabaseFetch('conversations?on_conflict=conversation_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=ignore-duplicates' },
    body: JSON.stringify({
      conversation_id: conversationId,
      user_id: userId || null,
      metadata: {},
    }),
  });
}

export const supabaseConversationStore = {
  async getMessages({
    conversationId,
    limit = 200,
    order = 'asc',
  }: {
    conversationId: string;
    limit?: number;
    order?: 'asc' | 'desc';
  }): Promise<Array<{ role: string; content: string }>> {
    const dir = order === 'desc' ? 'desc' : 'asc';
    const response = await supabaseFetch(
      `messages?conversation_id=eq.${encodeURIComponent(conversationId)}`
      + `&select=role,content,created_at&order=created_at.${dir}&limit=${limit}`,
    );
    const rows = await response.json().catch(() => []);
    return Array.isArray(rows) ? rows : [];
  },

  async appendMessage({
    conversationId,
    role,
    content,
    metadata,
    userId,
  }: {
    conversationId: string;
    role: string;
    content: string;
    metadata?: unknown;
    userId?: string;
  }): Promise<void> {
    await ensureConversation(conversationId, userId);
    await supabaseFetch('messages', {
      method: 'POST',
      body: JSON.stringify({
        conversation_id: conversationId,
        role,
        content,
        metadata: metadata ?? {},
      }),
    });
  },

  async getConversation({
    conversationId,
  }: {
    conversationId: string;
  }): Promise<{ metadata: Record<string, unknown> }> {
    const response = await supabaseFetch(
      `conversations?conversation_id=eq.${encodeURIComponent(conversationId)}&select=metadata&limit=1`,
    );
    const rows = await response.json().catch(() => []);
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) {
      throw new MemoryNotFoundError(`conversation not found: ${conversationId}`);
    }
    return { metadata: row.metadata || {} };
  },

  async updateConversation({
    conversationId,
    metadata,
  }: {
    conversationId: string;
    metadata: unknown;
  }): Promise<void> {
    const existing = await supabaseFetch(
      `conversations?conversation_id=eq.${encodeURIComponent(conversationId)}&select=conversation_id&limit=1`,
    );
    const rows = await existing.json().catch(() => []);
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new MemoryNotFoundError(`conversation not found: ${conversationId}`);
    }
    await supabaseFetch(`conversations?conversation_id=eq.${encodeURIComponent(conversationId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ metadata, updated_at: new Date().toISOString() }),
    });
  },
};

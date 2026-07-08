// Read-only helper for listing a signed-in user's saved projects in the
// sidebar. Actual project save/restore (file contents) happens inside the
// agents/ pipeline (agents/_projectStore.ts), which has sandbox access; this
// file only needs the lightweight Supabase REST list for the sidebar.

export type ProjectListItem = {
  id: string;
  conversationId: string;
  title: string;
  updatedAt: string;
};

function getSupabaseConfig(context: any): { url: string; key: string } {
  const url = context?.env?.SUPABASE_URL || process.env?.SUPABASE_URL;
  const key = context?.env?.SUPABASE_SERVICE_ROLE_KEY || process.env?.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      'Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY as environment variables for this project.',
    );
  }
  return { url: String(url).replace(/\/+$/, ''), key: String(key) };
}

async function supabaseFetch(context: any, path: string, init: RequestInit = {}): Promise<Response> {
  const { url, key } = getSupabaseConfig(context);
  const headers = new Headers(init.headers || {});
  headers.set('apikey', key);
  headers.set('Authorization', `Bearer ${key}`);
  return fetch(`${url}/rest/v1/${path}`, { ...init, headers });
}

export async function listProjectsForUser(context: any, userId: string): Promise<ProjectListItem[]> {
  if (!userId) return [];
  const response = await supabaseFetch(
    context,
    `projects?user_id=eq.${encodeURIComponent(userId)}&select=id,conversation_id,title,updated_at&order=updated_at.desc&limit=200`,
  );
  if (!response.ok) return [];
  const rows = (await response.json().catch(() => [])) as Array<{
    id: string;
    conversation_id: string;
    title: string;
    updated_at: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    conversationId: row.conversation_id,
    title: row.title,
    updatedAt: row.updated_at,
  }));
}

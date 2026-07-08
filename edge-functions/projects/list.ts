import { listProjectsForUser } from '../_lib/kvProjects';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// POST-based (not GET+query-string) to match the existing /auth/login and
// /auth/signup pattern in this project, since parsing query params from
// context.request has proven inconsistent across this runtime's request shapes.
export async function onRequestPost(context: any): Promise<Response> {
  try {
    const body = await context.request.json().catch(() => ({}));
    const userId = String(body?.userId || '').trim();
    if (!userId) {
      return jsonResponse({ ok: false, error: '로그인이 필요합니다.' }, 401);
    }

    const projects = await listProjectsForUser(context, userId);
    return jsonResponse({ ok: true, projects });
  } catch (error) {
    const message = error instanceof Error ? error.message : '프로젝트 목록을 불러오지 못했습니다.';
    return jsonResponse({ ok: false, error: message }, 400);
  }
}

export async function onRequestOptions(): Promise<Response> {
  return new Response(null, { status: 204 });
}

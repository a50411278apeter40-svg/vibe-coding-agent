import { verifyLogin } from '../_lib/kvUsers';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export async function onRequestPost(context: any): Promise<Response> {
  try {
    const body = await context.request.json().catch(() => ({}));
    const identifier = String(body?.emailOrUsername || body?.username || body?.email || '').trim();
    const password = String(body?.password || '');

    if (!identifier || !password) {
      return jsonResponse(
        { ok: false, error: '사용자명(또는 이메일)과 비밀번호를 입력해 주세요.' },
        400,
      );
    }

    const user = await verifyLogin(context, identifier, password);
    if (!user) {
      return jsonResponse({ ok: false, error: '사용자명/이메일 또는 비밀번호가 올바르지 않습니다.' }, 401);
    }

    return jsonResponse({ ok: true, user });
  } catch (error) {
    const message = error instanceof Error ? error.message : '로그인 중 오류가 발생했습니다.';
    return jsonResponse({ ok: false, error: message }, 400);
  }
}

export async function onRequestOptions(): Promise<Response> {
  return new Response(null, { status: 204 });
}

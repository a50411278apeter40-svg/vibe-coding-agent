import { createUser } from '../_lib/kvUsers';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export async function onRequestPost(context: any): Promise<Response> {
  try {
    const body = await context.request.json().catch(() => ({}));
    const email = String(body?.email || '').trim();
    const username = String(body?.username || '').trim();
    const password = String(body?.password || '');
    const name = String(body?.name || '').trim();

    if (!email || !username || !password || !name) {
      return jsonResponse(
        { ok: false, error: '이메일, 사용자명, 비밀번호, 이름을 모두 입력해 주세요.' },
        400,
      );
    }
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      return jsonResponse({ ok: false, error: '올바른 이메일 형식이 아닙니다.' }, 400);
    }

    const user = await createUser(context, {
      email, username, password, name,
    });
    return jsonResponse({ ok: true, user });
  } catch (error) {
    const message = error instanceof Error ? error.message : '회원가입 중 오류가 발생했습니다.';
    return jsonResponse({ ok: false, error: message }, 400);
  }
}

export async function onRequestOptions(): Promise<Response> {
  return new Response(null, { status: 204 });
}

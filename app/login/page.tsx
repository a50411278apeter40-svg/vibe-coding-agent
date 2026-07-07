'use client';

import { FormEvent, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

const AUTH_USER_STORAGE_KEY = 'pixal-auth-user';

export default function LoginPage() {
  const router = useRouter();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loading) return;
    setError(null);

    if (!identifier.trim() || !password) {
      setError('아이디(또는 이메일)와 비밀번호를 입력해 주세요.');
      return;
    }

    setLoading(true);
    try {
      const response = await fetch('/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: identifier.trim(), password }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data?.ok) {
        setError(data?.error || '로그인에 실패했어요. 다시 시도해 주세요.');
        return;
      }
      window.localStorage.setItem(AUTH_USER_STORAGE_KEY, JSON.stringify(data.user));
      router.push('/');
    } catch {
      setError('네트워크 오류가 발생했어요. 잠시 후 다시 시도해 주세요.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#0a0d0b] px-5 text-white">
      <div className="w-full max-w-sm rounded-[20px] border border-white/10 bg-[#141917] p-8 shadow-2xl shadow-black/40">
        <h1 className="text-center text-2xl font-bold text-[#dff8ef]">PIXAL2.0 로그인</h1>
        <p className="mt-2 text-center text-sm text-[#9fb0a9]">아이디(또는 이메일)로 로그인하세요.</p>

        <form onSubmit={handleSubmit} className="mt-8 flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="identifier" className="text-xs font-semibold text-[#9fb0a9]">
              아이디 또는 이메일
            </label>
            <input
              id="identifier"
              value={identifier}
              onChange={(event) => setIdentifier(event.target.value)}
              autoComplete="username"
              className="min-h-11 rounded-xl border border-white/10 bg-black/25 px-4 text-sm outline-none placeholder:text-white/35 focus:border-[#7bd8b4]"
              placeholder="pixal_dev"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="password" className="text-xs font-semibold text-[#9fb0a9]">
              비밀번호
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              className="min-h-11 rounded-xl border border-white/10 bg-black/25 px-4 text-sm outline-none placeholder:text-white/35 focus:border-[#7bd8b4]"
              placeholder="********"
            />
          </div>

          {error && <p className="text-xs text-[#f2a0a0]">{error}</p>}

          <button
            type="submit"
            disabled={loading}
            className="mt-2 min-h-11 rounded-full bg-[#45b98e] text-sm font-semibold text-white transition hover:bg-[#56c99f] disabled:cursor-not-allowed disabled:bg-white/20 disabled:text-white/40"
          >
            {loading ? '로그인 중...' : '로그인'}
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-[#9fb0a9]">
          계정이 없으신가요?{' '}
          <Link href="/signup" className="font-semibold text-[#7bd8b4] hover:text-white">
            회원가입
          </Link>
        </p>
        <p className="mt-3 text-center text-sm">
          <Link href="/" className="text-[#6f8079] hover:text-white">
            ← 홈으로
          </Link>
        </p>
      </div>
    </main>
  );
}

'use client';

import { FormEvent, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

const AUTH_USER_STORAGE_KEY = 'pixal-auth-user';

export default function SignupPage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loading) return;
    setError(null);

    if (!name.trim() || !email.trim() || !username.trim() || !password) {
      setError('모든 항목을 입력해 주세요.');
      return;
    }
    if (password !== confirmPassword) {
      setError('비밀번호가 일치하지 않습니다.');
      return;
    }
    if (password.length < 4) {
      setError('비밀번호는 4자 이상이어야 합니다.');
      return;
    }

    setLoading(true);
    try {
      const response = await fetch('/auth/signup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim(),
          username: username.trim(),
          password,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data?.ok) {
        setError(data?.error || '회원가입에 실패했어요. 다시 시도해 주세요.');
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
    <main className="flex min-h-screen items-center justify-center bg-[#0a0d0b] px-5 py-10 text-white">
      <div className="w-full max-w-sm rounded-[20px] border border-white/10 bg-[#141917] p-8 shadow-2xl shadow-black/40">
        <h1 className="text-center text-2xl font-bold text-[#dff8ef]">PIXAL2.0 회원가입</h1>
        <p className="mt-2 text-center text-sm text-[#9fb0a9]">몇 가지 정보만 입력하면 바로 시작할 수 있어요.</p>

        <form onSubmit={handleSubmit} className="mt-8 flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="name" className="text-xs font-semibold text-[#9fb0a9]">
              이름
            </label>
            <input
              id="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoComplete="name"
              className="min-h-11 rounded-xl border border-white/10 bg-black/25 px-4 text-sm outline-none placeholder:text-white/35 focus:border-[#7bd8b4]"
              placeholder="정성윤"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="email" className="text-xs font-semibold text-[#9fb0a9]">
              이메일
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
              className="min-h-11 rounded-xl border border-white/10 bg-black/25 px-4 text-sm outline-none placeholder:text-white/35 focus:border-[#7bd8b4]"
              placeholder="you@example.com"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="username" className="text-xs font-semibold text-[#9fb0a9]">
              아이디
            </label>
            <input
              id="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
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
              autoComplete="new-password"
              className="min-h-11 rounded-xl border border-white/10 bg-black/25 px-4 text-sm outline-none placeholder:text-white/35 focus:border-[#7bd8b4]"
              placeholder="********"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="confirmPassword" className="text-xs font-semibold text-[#9fb0a9]">
              비밀번호 확인
            </label>
            <input
              id="confirmPassword"
              type="password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              autoComplete="new-password"
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
            {loading ? '가입 중...' : '회원가입'}
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-[#9fb0a9]">
          이미 계정이 있으신가요?{' '}
          <Link href="/login" className="font-semibold text-[#7bd8b4] hover:text-white">
            로그인
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

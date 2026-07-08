// Shared helper for the Supabase-backed user store used by /auth/signup and /auth/login.
// This intentionally implements no session/token auth — it just persists
// { id, email, username, name, password_hash, created_at } rows in a
// `public.users` Postgres table on Supabase (free tier) and looks records up
// via Supabase's PostgREST REST API using the service_role key.
//
// One-time setup: run the SQL in vibe_project/edge-functions/_lib/users-schema.sql
// in your Supabase project's SQL editor, then set SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY as environment variables for this project
// (Makers console > Environment variables).

export type StoredUser = {
  id: string;
  email: string;
  username: string;
  name: string;
  passwordHash: string;
  createdAt: string;
};

export type PublicUser = {
  id: string;
  email: string;
  username: string;
  name: string;
};

type SupabaseUserRow = {
  id: string;
  email: string;
  username: string;
  name: string;
  password_hash: string;
  created_at: string;
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

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  // EdgeOne's WebCrypto implementation requires the algorithm as an object
  // ({ name: 'SHA-256' }) rather than the spec-shorthand string form. Passing
  // the bare string throws "Parameter 0 type invalid. expect: 'Object' get:
  // 'undefined'" at runtime (it reads algorithm.name internally).
  const digest = await crypto.subtle.digest({ name: 'SHA-256' }, data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function generateUserId(): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `u${Date.now().toString(36)}${random}`;
}

function fromRow(row: SupabaseUserRow): StoredUser {
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    name: row.name,
    passwordHash: row.password_hash,
    createdAt: row.created_at,
  };
}

function toPublicUser(user: StoredUser): PublicUser {
  return {
    id: user.id, email: user.email, username: user.username, name: user.name,
  };
}

async function supabaseFetch(
  context: any,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const { url, key } = getSupabaseConfig(context);
  const headers = new Headers(init.headers);
  headers.set('apikey', key);
  headers.set('Authorization', `Bearer ${key}`);
  if (!headers.has('content-type') && init.body) {
    headers.set('content-type', 'application/json');
  }
  return fetch(`${url}/rest/v1/${path}`, { ...init, headers });
}

export async function findUserByUsername(context: any, username: string): Promise<StoredUser | null> {
  if (!username) return null;
  const response = await supabaseFetch(
    context,
    `users?username=eq.${encodeURIComponent(username.trim().toLowerCase())}&select=*&limit=1`,
  );
  if (!response.ok) return null;
  const rows = (await response.json().catch(() => [])) as SupabaseUserRow[];
  return rows[0] ? fromRow(rows[0]) : null;
}

export async function findUserByEmail(context: any, email: string): Promise<StoredUser | null> {
  if (!email) return null;
  const response = await supabaseFetch(
    context,
    `users?email=eq.${encodeURIComponent(email.trim().toLowerCase())}&select=*&limit=1`,
  );
  if (!response.ok) return null;
  const rows = (await response.json().catch(() => [])) as SupabaseUserRow[];
  return rows[0] ? fromRow(rows[0]) : null;
}

export async function createUser(
  context: any,
  input: {
    email: string; username: string; password: string; name: string;
  },
): Promise<PublicUser> {
  const email = input.email.trim().toLowerCase();
  const username = input.username.trim().toLowerCase();
  const name = input.name.trim();

  const [existingByUsername, existingByEmail] = await Promise.all([
    findUserByUsername(context, username),
    findUserByEmail(context, email),
  ]);
  if (existingByUsername) {
    throw new Error('이미 사용 중인 사용자명입니다.');
  }
  if (existingByEmail) {
    throw new Error('이미 가입된 이메일입니다.');
  }

  const id = generateUserId();
  const passwordHash = await sha256Hex(input.password);
  const createdAt = new Date().toISOString();

  const response = await supabaseFetch(context, 'users', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      id,
      email,
      username,
      name,
      password_hash: passwordHash,
      created_at: createdAt,
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    if (response.status === 409 || detail.includes('duplicate key')) {
      throw new Error('이미 사용 중인 아이디 또는 이메일입니다.');
    }
    throw new Error('회원가입 중 오류가 발생했습니다.');
  }

  return toPublicUser({
    id, email, username, name, passwordHash, createdAt,
  });
}

export async function verifyLogin(
  context: any,
  emailOrUsername: string,
  password: string,
): Promise<PublicUser | null> {
  const identifier = emailOrUsername.trim().toLowerCase();
  if (!identifier || !password) return null;

  const user = identifier.includes('@')
    ? (await findUserByEmail(context, identifier)) || (await findUserByUsername(context, identifier))
    : (await findUserByUsername(context, identifier)) || (await findUserByEmail(context, identifier));
  if (!user) return null;

  const passwordHash = await sha256Hex(password);
  if (passwordHash !== user.passwordHash) return null;

  return toPublicUser(user);
}

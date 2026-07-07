// Shared helper for the KV-backed user store used by /auth/signup and /auth/login.
// This intentionally implements no real authentication (no sessions, no tokens) —
// it just persists { email, username, password(hash), name } and looks records up.
//
// KV key charset only allows letters, numbers, and underscores, so lookup keys
// are derived by hashing the (lowercased) username/email rather than using the
// raw value directly.

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

// Variable name used when binding the KV namespace to this project in the
// Makers console. Keep this in sync with README setup instructions.
const USERS_KV_BINDING = 'my_kv';

function getKv(context: any) {
  const kv = context?.env?.[USERS_KV_BINDING];
  if (!kv || typeof kv.get !== 'function' || typeof kv.put !== 'function') {
    throw new Error(
      `KV namespace is not bound to this project. In the Makers console, create a KV namespace and bind it to variable name "${USERS_KV_BINDING}".`,
    );
  }
  return kv;
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function indexKeyFor(prefix: string, value: string): Promise<string> {
  const hash = await sha256Hex(value.trim().toLowerCase());
  return `${prefix}_${hash}`;
}

function generateUserId(): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `u${Date.now().toString(36)}${random}`;
}

function toPublicUser(user: StoredUser): PublicUser {
  return {
    id: user.id, email: user.email, username: user.username, name: user.name,
  };
}

async function getUserById(context: any, id: string): Promise<StoredUser | null> {
  const kv = getKv(context);
  const record = await kv.get(`user_id_${id}`, 'json');
  return (record as StoredUser | null) || null;
}

export async function findUserByUsername(context: any, username: string): Promise<StoredUser | null> {
  if (!username) return null;
  const kv = getKv(context);
  const idxKey = await indexKeyFor('idx_username', username);
  const id = await kv.get(idxKey);
  if (!id) return null;
  return getUserById(context, id);
}

export async function findUserByEmail(context: any, email: string): Promise<StoredUser | null> {
  if (!email) return null;
  const kv = getKv(context);
  const idxKey = await indexKeyFor('idx_email', email);
  const id = await kv.get(idxKey);
  if (!id) return null;
  return getUserById(context, id);
}

export async function createUser(
  context: any,
  input: {
    email: string; username: string; password: string; name: string;
  },
): Promise<PublicUser> {
  const kv = getKv(context);
  const email = input.email.trim();
  const username = input.username.trim();
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
  const user: StoredUser = {
    id,
    email,
    username,
    name,
    passwordHash,
    createdAt: new Date().toISOString(),
  };

  const usernameIdxKey = await indexKeyFor('idx_username', username);
  const emailIdxKey = await indexKeyFor('idx_email', email);

  await kv.put(`user_id_${id}`, JSON.stringify(user));
  await kv.put(usernameIdxKey, id);
  await kv.put(emailIdxKey, id);

  return toPublicUser(user);
}

export async function verifyLogin(
  context: any,
  emailOrUsername: string,
  password: string,
): Promise<PublicUser | null> {
  const identifier = emailOrUsername.trim();
  if (!identifier || !password) return null;

  const user = identifier.includes('@')
    ? (await findUserByEmail(context, identifier)) || (await findUserByUsername(context, identifier))
    : (await findUserByUsername(context, identifier)) || (await findUserByEmail(context, identifier));
  if (!user) return null;

  const passwordHash = await sha256Hex(password);
  if (passwordHash !== user.passwordHash) return null;

  return toPublicUser(user);
}

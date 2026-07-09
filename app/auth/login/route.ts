import { onRequestPost as edgeLogin } from '@/edge-functions/auth/login';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Plain Next.js port of edge-functions/auth/login.ts's onRequestPost. That
// handler already only touches context.request.json() (which a real Web
// Request natively provides) and context.env (which falls back to
// process.env already), so no request-shape shimming is needed here.
export async function POST(request: Request): Promise<Response> {
  return edgeLogin({ request, env: process.env });
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204 });
}

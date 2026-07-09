import { onRequestPost as edgeSignup } from '@/edge-functions/auth/signup';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return edgeSignup({ request, env: process.env });
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204 });
}

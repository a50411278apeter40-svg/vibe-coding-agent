import { onRequestPost as edgeListProjects } from '@/edge-functions/projects/list';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return edgeListProjects({ request, env: process.env });
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204 });
}

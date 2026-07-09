// Builds an EdgeOne-"agents"-framework-shaped `context` object from a plain
// Web Request, so the exact same pipeline code (_pipelines.ts, _project.ts,
// _memory.ts, _gemmaAgent.ts, _groqAgent.ts, the tool implementations...)
// runs completely unchanged whether this app is deployed to EdgeOne Makers
// (which injects a context object with this same shape natively) or served
// as plain Next.js Route Handlers anywhere else (Render, Vercel, a bare
// Node server...).
//
// This is the piece that actually removes the EdgeOne platform dependency:
// our own code never depended on EdgeOne's own sandbox (see
// _daytonaSandbox.ts, this project uses Daytona), only on this framework's
// `context.request` / `context.env` / `context.store` conveniences -- which
// this file reconstructs from a standard Request plus a Supabase-backed
// store (_contextStore.ts).
import { supabaseConversationStore } from './_contextStore';

export async function buildAgentContext(request: Request): Promise<any> {
  let body: unknown = {};
  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    try {
      body = await request.json();
    } catch {
      body = {};
    }
  }

  return {
    request: {
      headers: request.headers,
      url: request.url,
      body,
    },
    env: process.env,
    store: supabaseConversationStore,
  };
}

import { createStreamResponse, runChatPipeline } from '@/agents/_pipelines';
import { buildAgentContext } from '@/agents/_httpContext';
import type { UploadedFileInput } from '@/agents/_project';

// Plain Next.js Route Handler port of agents/chat.ts's onRequest, so this
// endpoint runs the same way on Render (or anywhere Next.js runs) as it did
// on EdgeOne Makers. See _httpContext.ts for how the EdgeOne-shaped context
// object is reconstructed from a standard Request.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const context = await buildAgentContext(request);
  const body = (context.request.body || {}) as Record<string, unknown>;
  const message = String(body?.message || '').trim();
  const resetProject = body?.resetProject === true;
  const userId = typeof body?.userId === 'string' ? body.userId.trim() : '';
  const rawFiles = Array.isArray(body?.files) ? body.files : [];
  const files: UploadedFileInput[] = rawFiles
    .filter((file: any) => file && typeof file.dataBase64 === 'string' && file.dataBase64.length > 0)
    .map((file: any) => ({
      name: typeof file.name === 'string' && file.name ? file.name : 'file',
      mimeType: typeof file.mimeType === 'string' ? file.mimeType : undefined,
      dataBase64: file.dataBase64,
    }));

  return createStreamResponse((send) => runChatPipeline(context, message, send, {
    resetProject,
    files,
    userId,
  }));
}

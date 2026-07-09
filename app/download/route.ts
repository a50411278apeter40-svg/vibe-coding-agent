import { runProjectDownloadPipeline } from '@/agents/_pipelines';
import { buildAgentContext } from '@/agents/_httpContext';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const context = await buildAgentContext(request);
  return runProjectDownloadPipeline(context);
}

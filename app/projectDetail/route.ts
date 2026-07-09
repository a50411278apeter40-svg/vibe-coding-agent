import { runProjectDetailPipeline } from '@/agents/_pipelines';
import { buildAgentContext } from '@/agents/_httpContext';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const context = await buildAgentContext(request);
  return runProjectDetailPipeline(context);
}

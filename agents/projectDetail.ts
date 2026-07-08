import { runProjectDetailPipeline } from './_pipelines';

export async function onRequest(context: any) {
  return runProjectDetailPipeline(context);
}

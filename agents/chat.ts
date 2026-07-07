import {
  createStreamResponse,
  runChatPipeline,
} from './_pipelines';
import type { UploadedFileInput } from './_project';

export async function onRequest(context: any) {
  const body = context?.request?.body || {};
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

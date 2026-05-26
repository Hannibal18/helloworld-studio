// Blob 에서 파일 삭제.
//   DELETE /api/delete?token=...
//   body: { url: "https://...blob.vercel-storage.com/..." }

import { del } from '@vercel/blob';
import { checkAuth, unauthorized, badRequest } from './_auth';

export const config = { runtime: 'nodejs' };

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== 'DELETE' && request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }
  if (!checkAuth(request)) return unauthorized();

  let body: { url?: string };
  try {
    body = await request.json();
  } catch {
    return badRequest('invalid json body');
  }
  if (!body.url) return badRequest('url required');

  try {
    await del(body.url);
    return Response.json({ ok: true });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }
}

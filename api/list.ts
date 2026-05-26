// Blob 에 업로드된 라이브러리 파일 목록 조회.
//   GET /api/list?token=...&category=maps|bgm|all
//
// 응답:
//   { blobs: [{ pathname, url, size, uploadedAt }, ...] }

import { list } from '@vercel/blob';
import { checkAuth, unauthorized, parseUrl } from './_auth.js';

export const config = { runtime: 'nodejs' };

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== 'GET') {
    return new Response('Method Not Allowed', { status: 405 });
  }
  if (!checkAuth(request)) return unauthorized();

  const url = parseUrl(request);
  const category = url.searchParams.get('category') ?? 'all';
  const prefix = category === 'all' ? '' : `${category}/`;

  try {
    const result = await list({ prefix });
    return Response.json({ blobs: result.blobs });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }
}

// 라이브러리 파일 목록 — Blob 조회.
//   GET /api/list?token=...&category=maps|bgm|all

import { list } from '@vercel/blob';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { checkAuth, unauthorized } from './_auth.js';

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'GET') {
    res.status(405).end('Method Not Allowed');
    return;
  }
  if (!checkAuth(req)) { unauthorized(res); return; }

  const cat = Array.isArray(req.query.category) ? req.query.category[0] : (req.query.category ?? 'all');
  const prefix = cat === 'all' ? '' : `${cat}/`;

  try {
    const result = await list({ prefix });
    // 라이브러리 상태는 항상 최신을 줘야 — CDN/브라우저 캐시 차단
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.status(200).json({ blobs: result.blobs });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
}

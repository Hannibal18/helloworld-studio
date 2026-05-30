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
    // 커서 페이지네이션 — list() 기본 상한(~1000)에서 멈추면 자산이 조용히 잘린다.
    // ZIP 캐릭터/맵은 자산 하나당 여러 blob 이라 상한에 더 빨리 닿으므로 끝까지 모은다.
    const blobs: Awaited<ReturnType<typeof list>>['blobs'] = [];
    let cursor: string | undefined;
    do {
      const result = await list({ prefix, cursor, limit: 1000 });
      blobs.push(...result.blobs);
      cursor = result.hasMore ? result.cursor : undefined;
    } while (cursor);
    // 라이브러리 상태는 항상 최신을 줘야 — CDN/브라우저 캐시 차단
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.status(200).json({ blobs });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
}

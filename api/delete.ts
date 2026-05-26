// Blob 파일 삭제.
//   DELETE /api/delete?token=...
//   body: { url }

import { del } from '@vercel/blob';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { checkAuth, unauthorized, badRequest } from './_auth.js';

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'DELETE' && req.method !== 'POST') {
    res.status(405).end('Method Not Allowed');
    return;
  }
  if (!checkAuth(req)) { unauthorized(res); return; }

  const body = req.body as { url?: string } | undefined;
  if (!body || !body.url) { badRequest(res, 'url required'); return; }

  try {
    await del(body.url);
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
}

// Vercel Blob 클라이언트 업로드 핸들러.
// @vercel/blob/client 의 upload() 가 이 엔드포인트로 토큰 요청 → 응답한 token 으로
// 직접 Blob 으로 PUT. 큰 파일도 OK (Vercel Function body limit 회피).

import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { checkAuth, unauthorized, badRequest } from './_auth.js';

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).end('Method Not Allowed');
    return;
  }
  if (!checkAuth(req)) { unauthorized(res); return; }

  const body = req.body as HandleUploadBody | undefined;
  if (!body) { badRequest(res, 'body required'); return; }

  try {
    // handleUpload 는 fetch Request 가 필요 — Node req 를 Request 로 어댑트.
    const proto = (req.headers['x-forwarded-proto'] || 'https') as string;
    const host = req.headers.host ?? 'localhost';
    const fullUrl = `${proto}://${host}${req.url ?? '/api/blob-upload'}`;
    const fetchReq = new Request(fullUrl, {
      method: 'POST',
      headers: req.headers as Record<string, string>,
      body: JSON.stringify(body),
    });
    const json = await handleUpload({
      request: fetchReq,
      body,
      onBeforeGenerateToken: async (pathname) => {
        const ext = pathname.split('.').pop()?.toLowerCase();
        const allowed = ['json', 'tmj', 'tsj', 'png', 'jpg', 'jpeg', 'mp3', 'ogg', 'wav', 'm4a', 'zip'];
        if (!ext || !allowed.includes(ext)) {
          throw new Error(`확장자 ${ext} 는 업로드 불가`);
        }
        // 가변 파일(메타, 스키마)은 캐시 OFF — 덮어써도 fetch 가 즉시 최신값.
        // 불변 파일(맵 PNG, BGM 등)은 기본 캐시(1년) 유지.
        const isMutable = pathname.endsWith('.meta.json') || pathname.startsWith('_schemas/');
        return {
          allowedContentTypes: [
            'application/json', 'application/octet-stream', 'text/plain',
            'application/zip', 'application/x-zip-compressed',
            'image/png', 'image/jpeg',
            'audio/mpeg', 'audio/mp3', 'audio/ogg', 'audio/wav', 'audio/mp4', 'audio/x-m4a',
          ],
          addRandomSuffix: false,
          allowOverwrite: true,
          cacheControlMaxAge: isMutable ? 0 : undefined,
          tokenPayload: JSON.stringify({ pathname }),
        };
      },
      onUploadCompleted: async () => {
        // 메타 DB 같은 거 필요하면 여기서. 현재 Blob list() 가 충분.
      },
    });
    res.status(200).json(json);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
}

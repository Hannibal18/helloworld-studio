// Vercel Blob 클라이언트 업로드 핸들러.
// 클라이언트(@vercel/blob/client 의 upload()) 가 이 엔드포인트로 토큰 요청 → 응답한 token 으로
// 직접 Blob 으로 PUT. 큰 파일도 OK (Vercel Function body limit 회피).

import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { checkAuth, unauthorized, badRequest } from './_auth.js';

export const config = { runtime: 'edge' };

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }
  if (!checkAuth(request)) return unauthorized();

  let body: HandleUploadBody;
  try {
    body = (await request.json()) as HandleUploadBody;
  } catch {
    return badRequest('invalid json body');
  }

  try {
    const json = await handleUpload({
      request,
      body,
      onBeforeGenerateToken: async (pathname) => {
        // pathname 형태: 'maps/foo.json' 또는 'bgm/track.mp3' 등.
        // 확장자/카테고리 화이트리스트.
        const ext = pathname.split('.').pop()?.toLowerCase();
        const allowed = ['json', 'tmj', 'tsj', 'png', 'jpg', 'jpeg', 'mp3', 'ogg', 'wav', 'm4a'];
        if (!ext || !allowed.includes(ext)) {
          throw new Error(`확장자 ${ext} 는 업로드 불가`);
        }
        return {
          allowedContentTypes: [
            'application/json', 'application/octet-stream', 'text/plain',
            'image/png', 'image/jpeg',
            'audio/mpeg', 'audio/mp3', 'audio/ogg', 'audio/wav', 'audio/mp4', 'audio/x-m4a',
          ],
          // 같은 이름 업로드 시 이전 파일 덮어쓰지 않고 -1, -2 suffix 자동 부여
          addRandomSuffix: false,
          tokenPayload: JSON.stringify({ pathname }),
        };
      },
      onUploadCompleted: async () => {
        // 메타 DB 같은 거 필요하면 여기서. 현재 Blob list() 가 충분.
      },
    });
    return Response.json(json);
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }
}

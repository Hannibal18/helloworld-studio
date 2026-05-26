// 단일 비밀번호 기반 인증. STUDIO_PASSWORD 환경변수 = 마스터 비번.
// 클라이언트는 ?token=<password> 쿼리 또는 X-Studio-Token 헤더로 전송.

/** request.url 이 절대 URL 인지 path 인지 모호한 환경 (Vercel Node runtime) 대비 안전 파서. */
export function parseUrl(request: Request): URL {
  const raw = request.url || '/';
  if (raw.startsWith('http')) return new URL(raw);
  const host = request.headers.get('host') ?? 'localhost';
  return new URL(raw, `https://${host}`);
}

export function checkAuth(request: Request): boolean {
  const expected = process.env.STUDIO_PASSWORD;
  if (!expected) {
    // 환경변수 미설정 시 모든 요청 거부 (실수로 공개되는 거 방지)
    return false;
  }
  const url = parseUrl(request);
  const headerToken = request.headers.get('x-studio-token');
  const queryToken = url.searchParams.get('token');
  const token = headerToken || queryToken || '';
  return token === expected;
}

export function unauthorized(): Response {
  return new Response(JSON.stringify({ error: 'unauthorized' }), {
    status: 401,
    headers: { 'content-type': 'application/json' },
  });
}

export function badRequest(msg: string): Response {
  return new Response(JSON.stringify({ error: msg }), {
    status: 400,
    headers: { 'content-type': 'application/json' },
  });
}

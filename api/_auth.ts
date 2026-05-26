// 단일 비밀번호 기반 인증. STUDIO_PASSWORD 환경변수 = 마스터 비번.
// 클라이언트는 ?token=<password> 쿼리 또는 X-Studio-Token 헤더로 전송.
//
// Vercel Node.js runtime → req 는 VercelRequest (IncomingMessage 확장).
//   req.headers['x-studio-token'] (소문자 키, 배열 또는 문자열)
//   req.query.token (string | string[])

import type { VercelRequest, VercelResponse } from '@vercel/node';

function asString(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v[0] ?? '';
  return v ?? '';
}

export function getToken(req: VercelRequest): string {
  const header = asString(req.headers['x-studio-token']);
  if (header) return header;
  return asString(req.query.token);
}

export function checkAuth(req: VercelRequest): boolean {
  const expected = process.env.STUDIO_PASSWORD;
  if (!expected) return false;
  return getToken(req) === expected;
}

export function unauthorized(res: VercelResponse): void {
  res.status(401).json({ error: 'unauthorized' });
}

export function badRequest(res: VercelResponse, msg: string): void {
  res.status(400).json({ error: msg });
}

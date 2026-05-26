// 라이브러리 API 클라이언트.
// upload 는 @vercel/blob/client 의 upload() 가 직접 Blob 으로 PUT — 큰 파일도 OK.

import { upload } from '@vercel/blob/client';

export interface BlobItem {
  pathname: string;     // e.g., 'maps/foo.json'
  url: string;
  size: number;
  uploadedAt: string;
}

/** 카테고리별 목록 조회. */
export async function listAssets(token: string, category: 'maps' | 'bgm' | 'all'): Promise<BlobItem[]> {
  const r = await fetch(`/api/list?category=${category}`, {
    headers: { 'x-studio-token': token },
  });
  if (r.status === 401) throw new AuthError();
  if (!r.ok) throw new Error(`목록 조회 실패 (${r.status})`);
  const j = await r.json() as { blobs: BlobItem[] };
  return j.blobs;
}

/** 클라이언트 사이드 업로드 — 토큰은 핸들러 URL 쿼리로 전달. */
export async function uploadAsset(
  token: string,
  category: 'maps' | 'bgm',
  file: File,
  onProgress?: (loaded: number, total: number) => void,
): Promise<BlobItem> {
  // 같은 prefix 안에 같은 이름이 있으면 Vercel Blob 이 자동 -N suffix 부여 (addRandomSuffix=false 했지만
  // put() 이 충돌 시 -1, -2 suffix 추가). 추가 후 실제 pathname 은 반환값에 들어옴.
  const blob = await upload(`${category}/${file.name}`, file, {
    access: 'public',
    handleUploadUrl: `/api/blob-upload?token=${encodeURIComponent(token)}`,
    onUploadProgress: onProgress
      ? (e) => onProgress(e.loaded, e.total)
      : undefined,
  });
  return {
    pathname: blob.pathname,
    url: blob.url,
    size: file.size,
    uploadedAt: new Date().toISOString(),
  };
}

/** 삭제. */
export async function deleteAsset(token: string, url: string): Promise<void> {
  const r = await fetch(`/api/delete`, {
    method: 'DELETE',
    headers: {
      'x-studio-token': token,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ url }),
  });
  if (r.status === 401) throw new AuthError();
  if (!r.ok) throw new Error(`삭제 실패 (${r.status})`);
}

export class AuthError extends Error {
  constructor() { super('인증 만료'); this.name = 'AuthError'; }
}

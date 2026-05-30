// 가상 폴더 — 자산을 카테고리 안에서 트리로 정리.
//
// Blob 의 물리 경로(characters/<id>/...)는 절대 건드리지 않는다. 폴더는 순수히 메타데이터:
//   - 폴더 정의는 레지스트리 한 파일에 모음:  _folders/<category>.json
//       { schema: 1, folders: [{ id, name, parentId }], updatedAt }
//   - 각 자산의 meta.json 에 folderId 한 줄 추가 → 어느 폴더 소속인지.
//
// 이렇게 하면 자산 ID/URL 이 안 바뀌어 게임 매니페스트가 그대로 동작하고,
// 폴더 rename/이동/삭제가 자산 파일을 건드리지 않는다 (레지스트리 한 번 쓰기).

import { listAssets, uploadAsset, AuthError, type BlobItem } from './api';

export type FolderCat = 'maps' | 'characters' | 'bgm';

export interface FolderNode {
  id: string;                  // 불변 식별자 (slug + hex). meta.folderId 가 이걸 참조.
  name: string;                // 표시용 이름 — 자유롭게 변경 가능.
  parentId: string | null;     // null = 최상위. 중첩 트리.
}

interface FolderRegistry {
  schema: 1;
  folders: FolderNode[];
  updatedAt?: string;
}

const REGISTRY_PREFIX = '_folders';

/** 카테고리의 폴더 레지스트리 로드. 없으면 빈 배열.
 *  인증 만료(AuthError)는 호출처(refreshList)가 재인증하도록 그대로 전파한다 —
 *  여기서 삼키면 토큰 만료가 "폴더 없음"으로 둔갑해 자산이 전부 미분류로 보인다. */
export async function loadFolders(token: string, cat: FolderCat): Promise<FolderNode[]> {
  let list: BlobItem[];
  try {
    list = await listAssets(token, '_folders');
  } catch (e) {
    if (e instanceof AuthError) throw e;
    return [];   // 그 외 네트워크 오류는 빈 폴더로 진행 (읽기 실패는 비파괴적).
  }
  const target = list.find((b: BlobItem) => b.pathname === `${REGISTRY_PREFIX}/${cat}.json`);
  if (!target) return [];
  try {
    // cache: 'reload' — 가변 레지스트리라 항상 revalidate.
    const r = await fetch(target.url, { cache: 'reload' });
    if (!r.ok) return [];
    const j = await r.json() as Partial<FolderRegistry>;
    if (!Array.isArray(j.folders)) return [];
    // 방어적 정규화 — 깨진 항목 제거.
    return j.folders
      .filter((f): f is FolderNode =>
        !!f && typeof f.id === 'string' && typeof f.name === 'string'
        && (f.parentId === null || typeof f.parentId === 'string'))
      .map((f) => ({ id: f.id, name: f.name, parentId: f.parentId ?? null }));
  } catch {
    return [];
  }
}

/** 카테고리의 폴더 레지스트리 저장. */
export async function saveFolders(token: string, cat: FolderCat, folders: FolderNode[]): Promise<void> {
  const body = JSON.stringify({
    schema: 1,
    folders,
    updatedAt: new Date().toISOString(),
  } satisfies FolderRegistry, null, 2);
  const file = new File([body], `${cat}.json`, { type: 'application/json' });
  await uploadAsset(token, '_folders', file);
}

// ── 트리 헬퍼 (순수 함수) ──────────────────────────────────────────

export function folderById(folders: FolderNode[], id: string | null | undefined): FolderNode | undefined {
  if (!id) return undefined;
  return folders.find((f) => f.id === id);
}

/** parentId 의 직속 자식 폴더들 — 이름 오름차순. */
export function childFolders(folders: FolderNode[], parentId: string | null): FolderNode[] {
  return folders
    .filter((f) => f.parentId === parentId)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** id 의 모든 후손 폴더 id 집합 (자신 제외). */
export function descendantIds(folders: FolderNode[], id: string): Set<string> {
  const out = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const f of folders) {
      if (f.parentId === cur && !out.has(f.id)) {
        out.add(f.id);
        stack.push(f.id);
      }
    }
  }
  return out;
}

/** candidateParent 로 node 를 옮기면 사이클이 생기는가?
 *  (자기 자신 또는 자기 후손을 부모로 삼으려는 경우) */
export function wouldCycle(folders: FolderNode[], nodeId: string, candidateParentId: string | null): boolean {
  if (candidateParentId === null) return false;
  if (candidateParentId === nodeId) return true;
  return descendantIds(folders, nodeId).has(candidateParentId);
}

/** id → 루트까지의 이름 경로. 예: ['적', '보스']. 알 수 없는 id 는 []. */
export function folderPath(folders: FolderNode[], id: string | null | undefined): string[] {
  const path: string[] = [];
  let cur = folderById(folders, id);
  const guard = new Set<string>();   // 손상된 데이터의 사이클 방어
  while (cur && !guard.has(cur.id)) {
    guard.add(cur.id);
    path.unshift(cur.name);
    cur = folderById(folders, cur.parentId);
  }
  return path;
}

/** 이름 중복 검사 — 같은 부모 아래 같은 이름 폴더가 이미 있는가. */
export function isFolderNameTaken(
  folders: FolderNode[], name: string, parentId: string | null, exceptId?: string,
): boolean {
  const norm = name.trim().toLowerCase();
  return folders.some((f) =>
    f.id !== exceptId && f.parentId === parentId && f.name.trim().toLowerCase() === norm);
}

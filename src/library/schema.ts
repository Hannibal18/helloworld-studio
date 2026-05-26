// 카테고리별 메타 필드 스키마 — Settings 에서 정의, 다른 화면(detail/upload)이 읽어 동적 폼 생성.
//
// 저장 위치: Vercel Blob `_schemas/<category>.json`
//   { schema: 1, fields: [{ key, label, type, options?, default? }], updatedAt }

import { listAssets, uploadAsset, type BlobItem } from './api';

export type FieldType = 'text' | 'select';

export interface FieldDef {
  key: string;            // 'clothing_color' — JSON 키. ASCII 권장.
  label: string;          // '옷색깔' — 표시용
  type: FieldType;
  options?: string[];     // select 일 때 허용값
  default?: string;       // 기본값 (옵션)
}

export interface CategorySchema {
  fields: FieldDef[];
  updatedAt?: string;
}

export type SchemaCat = 'maps' | 'characters' | 'bgm';

export const schemasByCategory: Record<SchemaCat, CategorySchema> = {
  maps:       { fields: [] },
  characters: { fields: [] },
  bgm:        { fields: [] },
};

/** 부팅 시 한 번 모든 스키마 로드. */
export async function loadAllSchemas(token: string): Promise<void> {
  try {
    const list = await listAssets(token, '_schemas');
    await Promise.all(list.map(async (b: BlobItem) => {
      const m = b.pathname.match(/^_schemas\/(maps|characters|bgm)\.json$/);
      if (!m) return;
      const cat = m[1] as SchemaCat;
      try {
        // cache: 'reload' — 가변 메타라 브라우저 HTTP 캐시 우회하고 항상 revalidate.
        const r = await fetch(b.url, { cache: 'reload' });
        if (!r.ok) return;
        const j = await r.json() as { fields?: FieldDef[]; updatedAt?: string };
        if (Array.isArray(j.fields)) {
          schemasByCategory[cat] = { fields: j.fields, updatedAt: j.updatedAt };
        }
      } catch { /* 무시 */ }
    }));
  } catch { /* 빈 스키마로 진행 */ }
}

/** 카테고리 스키마 저장. */
export async function saveSchema(token: string, cat: SchemaCat): Promise<void> {
  const body = JSON.stringify({
    schema: 1,
    fields: schemasByCategory[cat].fields,
    updatedAt: new Date().toISOString(),
  }, null, 2);
  const file = new File([body], `${cat}.json`, { type: 'application/json' });
  await uploadAsset(token, '_schemas', file);
  schemasByCategory[cat].updatedAt = new Date().toISOString();
}

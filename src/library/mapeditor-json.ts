// helloworld-mapeditor 가 추출한 단일 JSON 맵 파싱.
//
// 식별: top-level 에 `schemaVersion: 1` + `objects: Array` 가 모두 있을 때.
//   (Tiled JSON 은 `type: "map"` — 충돌 없음.)
//
// 한 파일이라 ZIP 처럼 풀 게 없음 — 그 파일 그대로 maps/<name>/main.json 으로 저장.
// 게임 측 sync-assets 가 `maps/<name>/` prefix 로 받아가는 흐름과 자연스럽게 맞음.
//
// 통계: 객체 수 + 종류별 카운트 + bounds — 라이브러리 detail view 표시용.

export interface MapeditorMapInfo {
  schemaVersion: number;
  bounds: { x: number; y: number; w: number; h: number };
  objectCount: number;
  /** 'box' | 'cylinder' | ... → 카운트.  detail view 의 stats 표시용. */
  objectCountByType: Record<string, number>;
}

export interface ParsedMapeditorJson {
  /** 그대로 저장될 main.json 파일. */
  jsonFile: File;
  /** 사용자가 업로드한 원래 파일명 (e.g. 'mapeditor-demo-main.json'). meta.json 에 보존. */
  originalFilename: string;
  info: MapeditorMapInfo;
}

export function isMapeditorJsonFilename(file: File): boolean {
  // 확장자만 보는 1차 필터. 실제 schema 검사는 parse 시점.
  return /\.json$/i.test(file.name);
}

/** 파일을 읽어 mapeditor 포맷이면 ParsedMapeditorJson, 아니면 null.
 *  Tiled JSON (`type: "map"`) 은 null 반환 — 호출자가 legacy 경로로 넘김. */
export async function tryParseMapeditorJson(file: File): Promise<ParsedMapeditorJson | null> {
  if (!isMapeditorJsonFilename(file)) return null;
  let text: string;
  try { text = await file.text(); } catch { return null; }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as { schemaVersion?: unknown; objects?: unknown; bounds?: unknown };
  if (r.schemaVersion !== 1) return null;
  if (!Array.isArray(r.objects)) return null;

  // bounds 는 누락이어도 허용 (디폴트 0×0). 표시만 어색하지 동작은 함.
  const boundsRaw = (r.bounds && typeof r.bounds === 'object') ? r.bounds as { x?: number; y?: number; w?: number; h?: number } : {};
  const bounds = {
    x: typeof boundsRaw.x === 'number' ? boundsRaw.x : 0,
    y: typeof boundsRaw.y === 'number' ? boundsRaw.y : 0,
    w: typeof boundsRaw.w === 'number' ? boundsRaw.w : 0,
    h: typeof boundsRaw.h === 'number' ? boundsRaw.h : 0,
  };

  // 종류별 카운트
  const byType: Record<string, number> = {};
  for (const o of r.objects) {
    const t = (o && typeof o === 'object') ? String((o as { type?: unknown }).type ?? 'unknown') : 'unknown';
    byType[t] = (byType[t] ?? 0) + 1;
  }

  return {
    jsonFile: file,
    originalFilename: file.name,
    info: {
      schemaVersion: 1,
      bounds,
      objectCount: r.objects.length,
      objectCountByType: byType,
    },
  };
}

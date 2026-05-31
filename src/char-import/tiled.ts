// 비-LPC 캐릭터 zip 파서.
//
// 입력: PNG 스프라이트 시트들 + 시트별 Tiled 타일셋 JSON(.tsj) 이 든 zip.
//   예) Fox_Idle.png+Fox_Idle.json, Fox_walk.png+Fox_walk.json, Fox_Run.png+Fox_Run.json
//
// Tiled 타일셋 JSON 에서 프레임 크기·열 수·행별 애니메이션(프레임 시퀀스+지속) 을 뽑는다.
// JSON 의 `image` 필드는 `../animals/Fox_walk.png` 같은 불안정한 상대경로라 무시하고,
// PNG↔JSON 은 **base 파일명** 으로 페어링한다.
//
// JSON 이 없는 시트는, 같은 zip 안에서 JSON 으로 알아낸 타일 크기를 빌려 그리드로 행을 합성한다
// (애니 정보가 없으니 각 행 = 그 행의 모든 열을 순서대로, 기본 지속).

import JSZip from 'jszip';

export interface TiledRowAnim {
  /** 이 행(=한 방향)의 애니메이션 프레임 = 시트 전체 기준 절대 타일 id 시퀀스. */
  animTileIds: number[];
  /** 프레임별 지속(ms) — animTileIds 와 같은 길이. */
  durations: number[];
}

export interface ParsedSheet {
  name: string;            // base 파일명 (예: 'Fox_walk')
  pngFile: File;           // 원본 PNG (Blob 업로드용으로 재사용 가능)
  objectUrl: string;       // URL.createObjectURL(pngFile) — 동일출처(taint 없음)
  img: HTMLImageElement;   // 로드 완료된 이미지 (프리뷰/bake/방향추정용)
  cols: number;
  tileW: number;
  tileH: number;
  imageW: number;
  imageH: number;
  rows: TiledRowAnim[];    // tiles[] 순서 = 행(방향) 순서
  hadJson: boolean;        // JSON 으로 파싱됐는지 (false = 그리드 합성)
}

export interface ParsedCharImport {
  sheets: ParsedSheet[];
  /** 단일 표준 LPC 시트(832×3456, 64px) 면 에디터 없이 바로 업로드 가능. */
  isLpcStandard: boolean;
}

interface TiledTileset {
  columns?: number;
  imagewidth?: number;
  imageheight?: number;
  tilewidth?: number;
  tileheight?: number;
  tilecount?: number;
  tiles?: Array<{ id: number; animation?: Array<{ tileid: number; duration: number }> }>;
}

function baseName(path: string): string {
  const f = path.slice(path.lastIndexOf('/') + 1);
  return f.replace(/\.[^.]+$/, '');
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('이미지 로드 실패'));
    img.src = url;
  });
}

// 그리드 합성: 애니 정보 없을 때 tile 크기로 행/열을 나눠 각 행 = 그 행의 모든 열.
function gridRows(imageW: number, imageH: number, tileW: number, tileH: number): { cols: number; rows: TiledRowAnim[] } {
  const cols = Math.max(1, Math.floor(imageW / tileW));
  const rowCount = Math.max(1, Math.floor(imageH / tileH));
  const rows: TiledRowAnim[] = [];
  for (let r = 0; r < rowCount; r++) {
    const ids = Array.from({ length: cols }, (_, c) => r * cols + c);
    rows.push({ animTileIds: ids, durations: ids.map(() => 150) });
  }
  return { cols, rows };
}

export async function parseCharZip(file: File): Promise<ParsedCharImport> {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());

  // 1) PNG / JSON 엔트리 수집 (디렉토리·맥OS 메타·점파일 무시)
  const pngEntries = new Map<string, JSZip.JSZipObject>();
  const jsonEntries = new Map<string, JSZip.JSZipObject>();
  zip.forEach((path, entry) => {
    if (entry.dir) return;
    const fname = path.split('/').pop() ?? '';
    if (path.includes('__MACOSX') || fname.startsWith('.')) return;
    const ext = fname.toLowerCase().split('.').pop() ?? '';
    if (ext === 'png') pngEntries.set(baseName(path), entry);
    else if (ext === 'json' || ext === 'tsj') jsonEntries.set(baseName(path), entry);
  });
  if (pngEntries.size === 0) throw new Error('zip 안에 PNG 시트가 없습니다.');

  // 2) JSON 파싱 (있는 것만) — base 별 타일셋 정보
  const tilesetByBase = new Map<string, TiledTileset>();
  for (const [base, entry] of jsonEntries) {
    try { tilesetByBase.set(base, JSON.parse(await entry.async('text')) as TiledTileset); }
    catch { /* 깨진 JSON 무시 → 그리드 합성으로 폴백 */ }
  }
  // JSON 으로 알아낸 대표 타일 크기 (JSON 없는 시트의 그리드 합성에 빌려 씀).
  // 시트마다 크기가 다를 수 있으니 "첫 번째"가 아니라 "가장 흔한" 크기를 고른다.
  let refTileW = 0, refTileH = 0;
  {
    const counts = new Map<string, number>();
    for (const ts of tilesetByBase.values()) {
      if (ts.tilewidth && ts.tileheight) {
        const k = `${ts.tilewidth}x${ts.tileheight}`;
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
    }
    let best = 0;
    for (const [k, n] of counts) {
      if (n > best) { best = n; const [w, h] = k.split('x').map(Number); refTileW = w; refTileH = h; }
    }
  }

  // 3) 시트 구성
  const sheets: ParsedSheet[] = [];
  for (const [base, pngEntry] of pngEntries) {
    const blob = await pngEntry.async('blob');
    const pngFile = new File([blob], `${base}.png`, { type: 'image/png' });
    const objectUrl = URL.createObjectURL(pngFile);
    const img = await loadImage(objectUrl);
    const imageW = img.naturalWidth, imageH = img.naturalHeight;

    const ts = tilesetByBase.get(base);
    const animRows: TiledRowAnim[] = (ts?.tiles ?? [])
      .filter((t) => t.animation && t.animation.length > 0)
      .map((t) => ({
        animTileIds: t.animation!.map((a) => a.tileid),
        durations: t.animation!.map((a) => a.duration),
      }));

    let cols: number, tileW: number, tileH: number, rows: TiledRowAnim[], hadJson: boolean;
    if (ts && animRows.length > 0) {
      tileW = ts.tilewidth || refTileW || 32;
      tileH = ts.tileheight || refTileH || 32;
      cols = ts.columns || Math.max(1, Math.floor(imageW / tileW));
      rows = animRows;
      hadJson = true;
    } else {
      // JSON 없거나 애니 비어있음 → 빌린 타일 크기(없으면 32)로 그리드 합성
      tileW = (ts?.tilewidth) || refTileW || 32;
      tileH = (ts?.tileheight) || refTileH || 32;
      const g = gridRows(imageW, imageH, tileW, tileH);
      cols = g.cols;
      rows = g.rows;
      hadJson = false;
    }

    sheets.push({ name: base, pngFile, objectUrl, img, cols, tileW, tileH, imageW, imageH, rows, hadJson });
  }

  // 시트 정렬 — idle/walk/run 순서가 보기 좋게 (파일명 휴리스틱)
  const roleOrder = (n: string): number => {
    const l = n.toLowerCase();
    if (l.includes('idle')) return 0;
    if (l.includes('walk')) return 1;
    if (l.includes('run')) return 2;
    return 3;
  };
  sheets.sort((a, b) => roleOrder(a.name) - roleOrder(b.name) || a.name.localeCompare(b.name));

  // 표준 LPC 판정은 이미지 치수로만 한다 — JSON 없는 단일 832×3456 시트도 잡아내야 함
  // (그 경우 tileW 는 32 로 폴백되므로 tileW===64 조건을 쓰면 오판). 64px 은 832/13·3456/54 로 함의됨.
  const isLpcStandard = sheets.length === 1
    && sheets[0].imageW === 832 && sheets[0].imageH === 3456;

  return { sheets, isLpcStandard };
}

export function revokeParsed(parsed: ParsedCharImport): void {
  for (const s of parsed.sheets) URL.revokeObjectURL(s.objectUrl);
}

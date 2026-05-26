// Tiled 맵 ZIP 묶음 파싱.
//
// ZIP 안 파일 구조 (Tiled extension 의 export-studio-zip.js 가 생성하는 평탄 구조):
//   <map>.json or <map>.tmj   메인 맵 (Tiled JSON 형식, type: "map")
//   <tileset>.tsj or .tsx     참조 tileset (선택, 여러 개 가능)
//   <tileset>.png             tileset 이미지 (필수, 여러 개 가능)
//
// 결과: ParsedMapZip = { mapFile, mapFilename, sideFiles[], mapInfo }
// 업로드 시 maps/<base>/<originalFilename> 형식으로 풀어 저장한다.

import JSZip from 'jszip';

export interface MapInfo {
  width?: number;
  height?: number;
  tilewidth?: number;
  tileheight?: number;
  layers?: number;
  tilesets?: string[];
}

export interface ParsedMapZip {
  /** 메인 맵 JSON 파일 — Tiled type:"map". */
  mapFile: File;
  /** 그 파일의 ZIP 안 이름 (e.g. 'cops_lobby.json'). */
  mapFilename: string;
  /** 메인 맵 외의 모든 파일 — tileset .tsj/.tsx, 이미지 .png 등. */
  sideFiles: File[];
  /** 맵 통계 (라이브러리 detail 에서 표시). */
  mapInfo: MapInfo;
}

const MAP_EXT = /\.(tmj|json)$/i;

export function isMapZipFile(file: File): boolean {
  return file.name.toLowerCase().endsWith('.zip');
}

export async function parseMapZip(file: File): Promise<ParsedMapZip> {
  const ab = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(ab);

  let mapEntryName: string | null = null;
  let mapJson: unknown = null;
  const allEntries: Array<{ name: string; blob: Blob; type: string }> = [];

  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    // 폴더 prefix 가 있으면 마지막 segment 만 사용 (extension 이 평탄 ZIP 생성하지만 보호용).
    const baseName = entry.name.split('/').pop() ?? entry.name;
    if (!baseName) continue;

    const blob = await entry.async('blob');
    let contentType = 'application/octet-stream';
    if (MAP_EXT.test(baseName)) contentType = 'application/json';
    else if (/\.tsj$/i.test(baseName) || /\.tsx$/i.test(baseName)) contentType = 'application/json';
    else if (/\.png$/i.test(baseName)) contentType = 'image/png';
    else if (/\.jpe?g$/i.test(baseName)) contentType = 'image/jpeg';

    // 메인 맵 후보 — .json/.tmj 안의 type:"map" 식별
    if (MAP_EXT.test(baseName) && mapEntryName === null) {
      try {
        const text = await entry.async('text');
        const j = JSON.parse(text);
        if (j && typeof j === 'object' && (j as { type?: string }).type === 'map') {
          mapEntryName = baseName;
          mapJson = j;
        }
      } catch { /* JSON 파싱 실패 → side file 로 */ }
    }

    allEntries.push({ name: baseName, blob, type: contentType });
  }

  if (!mapEntryName || !mapJson) {
    throw new Error('ZIP 안에서 Tiled 맵 파일 (type:"map" 인 .json/.tmj) 을 찾지 못했습니다.');
  }

  // 메인 맵을 분리, 나머지는 side
  let mapFile: File | null = null;
  const sideFiles: File[] = [];
  for (const e of allEntries) {
    const f = new File([e.blob], e.name, { type: e.type });
    if (e.name === mapEntryName) mapFile = f;
    else sideFiles.push(f);
  }
  if (!mapFile) throw new Error('내부 오류: 맵 파일 구성 실패.');

  // 맵 통계
  const m = mapJson as { width?: number; height?: number; tilewidth?: number; tileheight?: number; layers?: unknown[]; tilesets?: Array<{ name?: string; source?: string }> };
  const mapInfo: MapInfo = {
    width: m.width,
    height: m.height,
    tilewidth: m.tilewidth,
    tileheight: m.tileheight,
    layers: Array.isArray(m.layers) ? m.layers.length : undefined,
    tilesets: Array.isArray(m.tilesets)
      ? m.tilesets.map((t) => t.name || t.source || '?')
      : undefined,
  };

  return { mapFile, mapFilename: mapEntryName, sideFiles, mapInfo };
}

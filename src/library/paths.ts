// 캐릭터/메타 경로 헬퍼.
//
// 캐릭터는 두 가지 저장 포맷이 공존:
//   - legacy (single PNG):  characters/Foo.png  +  characters/Foo.meta.json
//   - ZIP folder:           characters/Foo/thumbnail.png + characters/Foo/anims/*.png +
//                           characters/Foo/meta.json + characters/Foo/original.zip
//
// 이 차이를 모든 호출처에 흩어 두면 한 곳만 빼먹어도 데이터 불일치 → 한 곳에 모은다.

export const CHAR_PREFIX = 'characters';
export const META_FILE = 'meta.json';
export const THUMBNAIL_FILE = 'thumbnail.png';
export const ORIGINAL_ZIP_FILE = 'original.zip';
export const ANIMS_DIR = 'anims';
export const LEGACY_META_EXT = '.meta.json';
export const LEGACY_PNG_EXT = '.png';

export type CharFormat = 'single' | 'zip';

/** ZIP 캐릭터의 대표 파일(폴더 안 thumbnail.png) pathname 여부. */
export function isZipEntryPath(pathname: string): boolean {
  return pathname.endsWith('/' + THUMBNAIL_FILE);
}

/** 캐릭터 대표 파일(legacy PNG 또는 ZIP 썸네일) pathname 여부 — 리스트에 한 행으로 표시되는 것들. */
export function isCharacterEntryPath(pathname: string): boolean {
  if (!pathname.startsWith(CHAR_PREFIX + '/')) return false;
  if (pathname.endsWith(LEGACY_META_EXT) || pathname.endsWith('/' + META_FILE)) return false;
  const tail = pathname.slice(CHAR_PREFIX.length + 1);
  // 'foo.png' (슬래시 없음) → legacy
  if (!tail.includes('/')) return tail.toLowerCase().endsWith(LEGACY_PNG_EXT);
  // 'Foo/thumbnail.png' → ZIP
  return tail.endsWith('/' + THUMBNAIL_FILE);
}

/** 대표 파일 pathname → 표시용 base name.
 *  characters/Foo.png → 'Foo'
 *  characters/Foo/thumbnail.png → 'Foo' */
export function charBaseName(pathname: string): string {
  if (isZipEntryPath(pathname)) {
    const after = pathname.slice(CHAR_PREFIX.length + 1);
    return after.slice(0, after.length - (THUMBNAIL_FILE.length + 1));
  }
  // legacy: characters/Foo.png → Foo
  const filename = pathname.slice(pathname.lastIndexOf('/') + 1);
  return filename.replace(/\.[^.]+$/, '');
}

/** 대표 파일 pathname → 메타 파일 pathname (저장할 위치). */
export function metaPathFor(entryPathname: string): string {
  const base = charBaseName(entryPathname);
  return isZipEntryPath(entryPathname)
    ? `${CHAR_PREFIX}/${base}/${META_FILE}`
    : `${CHAR_PREFIX}/${base}${LEGACY_META_EXT}`;
}

/** 대표 파일 URL → 메타 파일 URL.
 *  Vercel Blob URL 은 https://<store>.public.blob.vercel-storage.com/<pathname> 형식 (쿼리 X). */
export function metaUrlForEntry(entryUrl: string, entryPathname: string): string {
  return isZipEntryPath(entryPathname)
    ? entryUrl.replace(/\/thumbnail\.png$/, '/' + META_FILE)
    : entryUrl.replace(/\.png$/i, LEGACY_META_EXT);
}

/** 메타 sidecar pathname → 대응하는 대표 파일 pathname.
 *  characters/Foo.meta.json → characters/Foo.png  (legacy)
 *  characters/Foo/meta.json → characters/Foo/thumbnail.png  (ZIP) */
export function entryPathForSidecar(sidecarPathname: string): string {
  if (sidecarPathname.endsWith('/' + META_FILE)) {
    return sidecarPathname.replace(/\/meta\.json$/, '/' + THUMBNAIL_FILE);
  }
  return sidecarPathname.replace(/\.meta\.json$/, LEGACY_PNG_EXT);
}

/** ZIP 캐릭터 폴더 내 액션 PNG pathname. */
export function animPathFor(baseName: string, anim: string): string {
  return `${CHAR_PREFIX}/${baseName}/${ANIMS_DIR}/${anim}.png`;
}

/** ZIP 캐릭터 원본 ZIP pathname. */
export function originalZipPathFor(baseName: string): string {
  return `${CHAR_PREFIX}/${baseName}/${ORIGINAL_ZIP_FILE}`;
}

/** ZIP 캐릭터 썸네일 pathname. */
export function thumbnailPathFor(baseName: string): string {
  return `${CHAR_PREFIX}/${baseName}/${THUMBNAIL_FILE}`;
}

/** ZIP 캐릭터 폴더 prefix — 'characters/Foo/'. */
export function zipFolderPrefix(baseName: string): string {
  return `${CHAR_PREFIX}/${baseName}/`;
}

// ── uploadAsset(file) 용 filename — uploadAsset 이 `<category>/<file.name>` 으로 pathname 구성하므로
// category prefix 를 떼고 폴더 구분자만 유지. ─────────────────────────────────────
export function metaFilenameFor(entryPathname: string): string {
  return stripCategory(metaPathFor(entryPathname));
}
export function metaFilenameForZip(baseName: string): string {
  return `${baseName}/${META_FILE}`;
}
export function metaFilenameForLegacy(baseName: string): string {
  return `${baseName}${LEGACY_META_EXT}`;
}
export function animFilenameFor(baseName: string, anim: string): string {
  return stripCategory(animPathFor(baseName, anim));
}
export function originalZipFilenameFor(baseName: string): string {
  return stripCategory(originalZipPathFor(baseName));
}
export function thumbnailFilenameFor(baseName: string): string {
  return stripCategory(thumbnailPathFor(baseName));
}
function stripCategory(pathname: string): string {
  return pathname.slice(CHAR_PREFIX.length + 1);
}

/** entry 가 ZIP 인지 (pathname 추측 대신 meta.format 우선) — meta 없을 때 fallback 으로 pathname 검사. */
export function entryFormat(entryPathname: string, metaFormat?: CharFormat): CharFormat {
  return metaFormat ?? (isZipEntryPath(entryPathname) ? 'zip' : 'single');
}

// ──────────────────────────────────────────────────────────────
// Maps — 두 가지 저장 포맷이 공존:
//   - legacy single:   maps/foo.json + maps/foo.meta.json
//   - ZIP folder:      maps/Foo/main.json + maps/Foo/<tileset>.tsj/.png +
//                      maps/Foo/original.zip + maps/Foo/meta.json
//
// ZIP 의 경우 메인 맵 JSON 을 항상 'main.json' 으로 정규화해서 대표 entry pathname 이 일관.
// JSON 안 tileset 참조는 상대경로(`source: "forest_tiles.tsj"`)라서 이름 바꿔도 동작.

export const MAP_PREFIX = 'maps';
export const MAP_MAIN_FILE = 'main.json';

export function isZipMapEntryPath(pathname: string): boolean {
  return pathname.startsWith(MAP_PREFIX + '/') && pathname.endsWith('/' + MAP_MAIN_FILE);
}

export function isMapEntryPath(pathname: string): boolean {
  if (!pathname.startsWith(MAP_PREFIX + '/')) return false;
  if (pathname.endsWith(LEGACY_META_EXT)) return false;
  if (pathname.endsWith('/' + META_FILE)) return false;
  const tail = pathname.slice(MAP_PREFIX.length + 1);
  // 'foo.json' (슬래시 없음) → legacy 단일 파일 entry
  if (!tail.includes('/')) {
    const lower = tail.toLowerCase();
    return lower.endsWith('.json') || lower.endsWith('.tmj') || lower.endsWith('.tmx');
  }
  // 'Foo/main.json' → ZIP entry. 'Foo/forest_tiles.tsj' 같은 사이드 파일은 entry 가 아님.
  return tail.endsWith('/' + MAP_MAIN_FILE);
}

/** 메타 sidecar pathname → 대응하는 맵 entry pathname (대표 파일). */
export function mapEntryPathForSidecar(sidecarPathname: string): string {
  if (sidecarPathname.endsWith('/' + META_FILE)) {
    return sidecarPathname.replace(/\/meta\.json$/, '/' + MAP_MAIN_FILE);
  }
  // legacy: maps/foo.meta.json → maps/foo.json
  return sidecarPathname.replace(/\.meta\.json$/, '.json');
}

/** 맵 entry pathname → 표시용 base 이름. */
export function mapBaseName(pathname: string): string {
  if (isZipMapEntryPath(pathname)) {
    const after = pathname.slice(MAP_PREFIX.length + 1);
    return after.slice(0, after.length - (MAP_MAIN_FILE.length + 1));
  }
  // legacy: maps/foo.json → foo
  const filename = pathname.slice(pathname.lastIndexOf('/') + 1);
  return filename.replace(/\.[^.]+$/, '');
}

/** 맵 entry URL → 메타 파일 URL. Vercel Blob URL 구조 가정. */
export function mapMetaUrlForEntry(entryUrl: string, entryPathname: string): string {
  return isZipMapEntryPath(entryPathname)
    ? entryUrl.replace(/\/main\.json$/, '/' + META_FILE)
    : entryUrl.replace(/\.json$/i, LEGACY_META_EXT);
}

/** uploadAsset(file) 용 filename — uploadAsset 이 maps/ 를 prefix 로 붙임. */
export function mapMainFilenameFor(baseName: string): string {
  return `${baseName}/${MAP_MAIN_FILE}`;
}
export function mapSideFilenameFor(baseName: string, innerFilename: string): string {
  return `${baseName}/${innerFilename}`;
}
export function mapOriginalZipFilenameFor(baseName: string): string {
  return `${baseName}/${ORIGINAL_ZIP_FILE}`;
}
export function mapMetaFilenameFor(baseName: string): string {
  return `${baseName}/${META_FILE}`;
}
export function mapFolderPrefix(baseName: string): string {
  return `${MAP_PREFIX}/${baseName}/`;
}

// ── 맵 버전 history (디테일 패널의 "Upload new version" 으로 누적) ─────
//
// 같은 맵 이름에 새 ZIP 업로드 시:
//   1) 기존 maps/<name>/original.zip 의 콘텐츠를
//      maps/<name>/_history/<ISO-timestamp>.zip 으로 복사 (옛 버전 보존)
//   2) 새 ZIP 풀어서 main.json/tilesets/original.zip/meta.json 덮어쓰기
//   3) 옛 자산 자체(main.json 등)는 새 걸로 덮어써짐 — 복구는 _history 의 ZIP 으로.
//
// 디테일 패널은 _history 폴더 안 파일을 나열해서 사용자에게 보여 줌.

export const MAP_HISTORY_DIR = '_history';

export function mapHistoryPrefix(baseName: string): string {
  return `${MAP_PREFIX}/${baseName}/${MAP_HISTORY_DIR}/`;
}

export function mapHistoryFilenameFor(baseName: string, isoTimestamp: string): string {
  // ':' 는 일부 시스템에서 문제 — 안전한 문자만 (Z 끝나는 ISO 그대로 두되 ':' 만 '-' 로)
  const safe = isoTimestamp.replace(/:/g, '-');
  return `${baseName}/${MAP_HISTORY_DIR}/${safe}.zip`;
}

/** mapeditor 포맷 (단일 main.json) 의 history 백업 파일명 — .json 확장자.
 *  Tiled 의 ZIP 백업과 같은 _history/ 디렉토리에 공존 (sync-assets 가 _history/ 통째로 제외). */
export function mapHistoryJsonFilenameFor(baseName: string, isoTimestamp: string): string {
  const safe = isoTimestamp.replace(/:/g, '-');
  return `${baseName}/${MAP_HISTORY_DIR}/${safe}.json`;
}

export function isMapHistoryPath(pathname: string): boolean {
  return pathname.startsWith(MAP_PREFIX + '/') && pathname.includes(`/${MAP_HISTORY_DIR}/`);
}

// ── 자산 ID 생성 ──────────────────────────────────────────
//
// 폴더명(= ID)은 자산의 변하지 않는 정체성. 사용자가 입력한 표시 이름(meta.name)은
// 자유롭게 변경 가능하지만, ID 는 첫 업로드 시점에 자동 생성된 후 절대 바뀌지 않는다.
// 게임의 자산 매니페스트는 ID 로 자산을 참조한다.
//
// 생성 규칙: slug + '-' + 6자리 hex 랜덤. 예: 'waiting-room-a3f9e6'
// slug 가 ASCII 로 비어 있으면 (예: 한글 이름) generic prefix 사용.

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')   // diacritics 제거
    .replace(/[^a-z0-9]+/g, '-')       // ASCII alnum 외엔 모두 '-'
    .replace(/^-+|-+$/g, '')           // 양끝 '-' 제거
    .slice(0, 24);                     // 너무 길면 자름
}

function shortRandomHex(): string {
  const bytes = new Uint8Array(3);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 자산 ID 생성 — slug + '-' + 6 hex. slug 가 빈 문자열이면 fallbackPrefix 사용. */
export function generateAssetId(displayName: string, fallbackPrefix = 'asset'): string {
  const slug = slugify(displayName);
  const stem = slug || fallbackPrefix;
  return `${stem}-${shortRandomHex()}`;
}

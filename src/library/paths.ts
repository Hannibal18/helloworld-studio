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

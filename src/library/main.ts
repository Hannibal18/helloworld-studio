// 라이브러리 페이지 부트스트랩 + UI 로직.
//   - 비번 모달 → ensureAuth → 토큰 보유
//   - Maps / Characters / Audio 탭 전환
//   - 드래그&드롭 / 파일 선택 업로드 (다중 파일)
//   - 캐릭터는 업로드 시 LPC 액션 자동 검출 → sidecar .meta.json 함께 저장
//   - 진행률 표시 + 항목 삭제

import { ensureAuth, clearToken } from './auth';
import { listAssets, uploadAsset, deleteAsset, AuthError, type BlobItem } from './api';
import {
  detectActionsFromFile, ANIMATION_CONFIGS, FRAME_SIZE,
  type LPCAction,
} from './lpc-detect';
import { parseLpcZip, isLpcZipFile, type ParsedLpcZip } from './lpc-zip';
import { parseMapZip, isMapZipFile, type ParsedMapZip } from './map-zip';
import { tryParseMapeditorJson, type ParsedMapeditorJson } from './mapeditor-json';
import {
  schemasByCategory, loadAllSchemas, saveSchema,
  type FieldDef, type FieldType, type SchemaCat,
} from './schema';
import {
  isCharacterEntryPath, isZipEntryPath, charBaseName,
  thumbnailPathFor, animPathFor, originalZipPathFor,
  metaUrlForEntry, entryPathForSidecar, zipFolderPrefix,
  metaFilenameFor, metaFilenameForLegacy, metaFilenameForZip,
  animFilenameFor, originalZipFilenameFor, thumbnailFilenameFor,
  isZipMapEntryPath, isMapEntryPath, mapEntryPathForSidecar,
  mapBaseName, mapMetaUrlForEntry,
  mapMainFilenameFor, mapSideFilenameFor, mapOriginalZipFilenameFor, mapMetaFilenameFor,
  mapFolderPrefix, isMapHistoryPath, mapHistoryFilenameFor, mapHistoryJsonFilenameFor,
  generateAssetId,
  type CharFormat,
} from './paths';

type Category = 'maps' | 'characters' | 'bgm';
const EXT_BY_CAT: Record<Category, string[]> = {
  maps:       ['json', 'tmj', 'tsj', 'png', 'jpg', 'jpeg', 'zip'],  // zip = Tiled 맵 묶음
  characters: ['png', 'zip'],   // zip = LPC Split-by-Animation 패키지
  bgm:        ['mp3', 'ogg', 'wav', 'm4a'],
};

let token = '';
// 탭 상태는 새로고침 후에도 유지 — 사용자는 마지막으로 보던 탭에서 작업을 이어서 함.
const TAB_STORAGE_KEY = 'studio.lib.activeTab';
type TabKey = Category | 'settings';
function loadInitialTab(): TabKey {
  try {
    const v = localStorage.getItem(TAB_STORAGE_KEY);
    if (v === 'maps' || v === 'characters' || v === 'bgm' || v === 'settings') return v;
  } catch { /* localStorage 막혔으면 default */ }
  return 'maps';
}
function persistTab(tab: TabKey): void {
  try { localStorage.setItem(TAB_STORAGE_KEY, tab); } catch { /* 무시 */ }
}
const initialTab = loadInitialTab();
let activeCat: Category = initialTab === 'settings' ? 'maps' : initialTab;
let inSettings = initialTab === 'settings';

type BodyType = 'male' | 'female' | 'none';
interface CharMeta {
  actions: LPCAction[];           // 표준 액션 목록 (PNG 단독은 검출, ZIP 은 파일명 기반)
  body?: BodyType;
  name?: string;                   // 표시용 이름 (파일명과 분리)
  race?: string;                   // 종족 자유 텍스트
  fields?: Record<string, string>; // 사용자 정의 스키마 필드값
  uploadedAt?: string;
  // ZIP 업로드 전용: 표준/커스텀 액션 PNG 들. 키 = 액션 이름, 값 = 그 PNG 의 Blob URL.
  format?: 'single' | 'zip';
  anims?: Record<string, string>;
  customAnims?: string[];
  totalSize?: number;              // ZIP 의 모든 파일 합산 크기 (표시용)
  originalZipUrl?: string;         // ZIP 캐릭터의 원본 .zip URL (다운로드용)
}

// pathname → 자산 메타 (캐릭터/맵/오디오 공용 — 카테고리별로 사용하는 필드만 채움).
const charMetaByPath = new Map<string, CharMeta>();
interface MapVersionRecord {
  version: number;
  savedAt: string;              // ISO — _history/<ts>.zip 의 timestamp 와 일치
  originalMapFilename: string;  // 사용자가 업로드한 파일 이름 그대로 (e.g. 'waitingroom.zip')
}

interface MapMeta {
  id?: string;
  name?: string;
  version?: number;
  /** 이전 버전들의 기록 (current 제외). 새 버전 업로드 시 옛 active 의 정보가 push 된다.
   *  각 record 의 savedAt 은 _history/<savedAt>.{zip|json} 파일과 1:1 매핑. */
  versionHistory?: MapVersionRecord[];
  /** 이 (current) 자산이 저장된 ISO timestamp. */
  savedAt?: string;
  fields?: Record<string, string>;
  /** 'zip'        — Tiled ZIP 업로드 (기본 흐름).
   *  'single'     — legacy 단일 Tiled .json/.tmj (folder 구조 없음).
   *  'mapeditor'  — helloworld-mapeditor 가 추출한 단일 main.json (schemaVersion=1).
   *                 ZIP 과 같은 maps/<name>/ 폴더 + meta.json + _history/ 흐름 공유. */
  format?: 'single' | 'zip' | 'mapeditor';
  originalMapFilename?: string;
  /** Tiled ZIP 일 때만 — _history 백업 다운로드용. */
  originalZipUrl?: string;
  totalSize?: number;
  /** info 는 format 별로 다른 모양 — render 시 format 분기.
   *   - zip/single: Tiled 통계 (width/height/tilewidth/...)
   *   - mapeditor : 객체 수 + bounds + 종류별 카운트 */
  info?: TiledInfo | MapeditorInfo;
}
interface TiledInfo {
  width?: number; height?: number; tilewidth?: number; tileheight?: number;
  layers?: number; tilesets?: string[];
}
interface MapeditorInfo {
  schemaVersion: number;
  bounds: { x: number; y: number; w: number; h: number };
  objectCount: number;
  objectCountByType: Record<string, number>;
}
function isMapeditorInfo(info: MapMeta['info'] | null | undefined): info is MapeditorInfo {
  return !!info && typeof (info as MapeditorInfo).schemaVersion === 'number'
      && (info as MapeditorInfo).objectCount !== undefined;
}
type AudioCategory = 'bgm' | 'effect';
interface AudioMeta {
  name?: string;
  volume?: number;
  loop?: boolean;
  category?: AudioCategory;
  memo?: string;
  fields?: Record<string, string>;
}
const mapMetaByPath = new Map<string, MapMeta>();
const audioMetaByPath = new Map<string, AudioMeta>();
/** 맵 entry pathname → _history/*.zip 개수. legacy 자산(meta.version 없음)의 version fallback 계산용. */
const mapHistoryCountByPath = new Map<string, number>();

/** 맵의 현재 버전 라벨. meta.version 직접 사용 — 없으면 history 개수 + 1 (legacy 표시). */
function computeMapVersionLabel(meta: MapMeta | undefined, entryPathname: string): string {
  if (meta?.version != null) return `v${meta.version}`;
  const historyCount = mapHistoryCountByPath.get(entryPathname) ?? 0;
  return `v${historyCount + 1} (legacy)`;
}
function computeMapVersionShort(meta: MapMeta | undefined, entryPathname: string): string {
  if (meta?.version != null) return `v${meta.version}`;
  const historyCount = mapHistoryCountByPath.get(entryPathname) ?? 0;
  return `v${historyCount + 1}*`;  // * = legacy estimate
}

// URL → 이미 로드된 LPC 시트 (썸네일 + 미리보기 렌더용). 시트가 큰 편이라 캐싱 필수.
const sheetByUrl = new Map<string, HTMLImageElement | 'loading' | 'error'>();
// 현재 detail 패널에서 보여주는 항목.
let selectedChar: BlobItem | null = null;
let selectedMap: BlobItem | null = null;
let selectedAudio: BlobItem | null = null;
let playingAction: string | null = null;
let playRafId = 0;
// LPC 4-방향 row 인덱스: 0=up, 1=left, 2=down, 3=right.
type DirIndex = 0 | 1 | 2 | 3;
let selectedDir: DirIndex = 2;
const DIR_BY_NAME: Record<string, DirIndex> = { up: 0, left: 1, down: 2, right: 3 };
// 현재 detail 패널이 마지막으로 폼을 reset 한 대상 pathname.
// refreshList 가 같은 항목을 다시 렌더하려 할 때, 사용자가 저장 안 한 편집이 있으면 폼을 안 덮어쓰게 한다.
let lastRenderedCharPath: string | null = null;
let lastRenderedMapPath: string | null = null;
let lastRenderedAudioPath: string | null = null;

function showToast(msg: string, kind: 'ok' | 'err' = 'ok', ms = 2200): void {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('err', kind === 'err');
  el.classList.remove('hidden');
  window.clearTimeout((el as HTMLElement & { __t?: number }).__t);
  (el as HTMLElement & { __t?: number }).__t = window.setTimeout(() => el.classList.add('hidden'), ms);
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function shortName(pathname: string): string {
  return pathname.split('/').slice(1).join('/') || pathname;
}

function extLabel(pathname: string): string {
  const ext = pathname.split('.').pop()?.toLowerCase() ?? '';
  return ext.toUpperCase();
}

/** LPC idle 프레임을 작은 캔버스로 그림 — walk row 10 (down), col 0 = 64×64 영역. */
function drawCharacterThumb(canvas: HTMLCanvasElement, img: HTMLImageElement): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width, h = canvas.height;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, w, h);
  // 시트의 walk-down idle (row 10, col 0). 시트가 비표준이면 빈 표시.
  if (img.naturalWidth >= 64 && img.naturalHeight >= 11 * 64) {
    ctx.drawImage(img, 0, 10 * FRAME_SIZE, FRAME_SIZE, FRAME_SIZE, 0, 0, w, h);
  } else {
    // 표준 아니면 시트 좌상단 일부만 보여줌
    ctx.drawImage(img, 0, 0, Math.min(64, img.naturalWidth), Math.min(64, img.naturalHeight), 0, 0, w, h);
  }
}

/** 비동기로 시트를 캐싱하고, 로드 끝나면 콜백. 캐시 적중이면 즉시 콜백. */
function loadSheet(url: string, onReady: (img: HTMLImageElement) => void): void {
  const cached = sheetByUrl.get(url);
  if (cached === 'loading') return;
  if (cached === 'error') return;
  if (cached) { onReady(cached); return; }
  sheetByUrl.set(url, 'loading');
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => { sheetByUrl.set(url, img); onReady(img); };
  img.onerror = () => { sheetByUrl.set(url, 'error'); };
  img.src = url;
}

// ── 업로드 진행률 row API ──────────────────────────────────────────
//   success() → OK 표시 후 5초 뒤 자동 제거.
//   failure(msg, retry) → ERR 표시 + 메시지. row 는 사용자가 직접 닫거나(×) Retry 누를 때까지 유지.
//
// 부분 실패 (예: ZIP 다단계 중 후반 step) 시 사용자가 어디서 실패했는지 보고 재시도할 수 있게.

interface ProgressRow {
  setStage(label: string): void;
  setProgress(loaded: number, total: number): void;
  setPercent(pct: number): void;
  success(label?: string): void;
  failure(message: string, retry: () => Promise<void>): void;
  remove(): void;
}

function appendProgressRow(initialName: string): ProgressRow {
  const progressEl = document.getElementById('upload-progress')!;
  const row = document.createElement('div');
  row.className = 'lib-progress-row';
  row.innerHTML = `
    <span class="name"></span>
    <span class="bar"><div style="width:0%"></div></span>
    <span class="pct">0%</span>
    <button type="button" class="lib-progress-retry hidden">Retry</button>
    <button type="button" class="lib-progress-dismiss hidden" aria-label="dismiss">&times;</button>
  `;
  progressEl.appendChild(row);
  const nameEl = row.querySelector('.name') as HTMLElement;
  const bar = row.querySelector('.bar > div') as HTMLDivElement;
  const pct = row.querySelector('.pct') as HTMLSpanElement;
  const retryBtn = row.querySelector('.lib-progress-retry') as HTMLButtonElement;
  const dismissBtn = row.querySelector('.lib-progress-dismiss') as HTMLButtonElement;
  nameEl.textContent = initialName;
  dismissBtn.addEventListener('click', () => row.remove());

  return {
    setStage(label) { nameEl.textContent = label; },
    setProgress(loaded, total) {
      const p = total > 0 ? Math.round((loaded / total) * 100) : 0;
      bar.style.width = p + '%';
      pct.textContent = p + '%';
    },
    setPercent(p) {
      bar.style.width = p + '%';
      pct.textContent = p + '%';
    },
    success(label) {
      row.classList.remove('err');
      row.classList.add('ok');
      bar.style.width = '100%';
      pct.textContent = 'OK';
      if (label) nameEl.textContent = label;
      retryBtn.classList.add('hidden');
      dismissBtn.classList.add('hidden');
      setTimeout(() => row.remove(), 5000);
    },
    failure(message, retry) {
      row.classList.remove('ok');
      row.classList.add('err');
      pct.textContent = 'ERR';
      nameEl.textContent = message;
      retryBtn.classList.remove('hidden');
      dismissBtn.classList.remove('hidden');
      retryBtn.onclick = (): void => {
        retryBtn.classList.add('hidden');
        dismissBtn.classList.add('hidden');
        row.classList.remove('err');
        pct.textContent = '0%';
        bar.style.width = '0%';
        void retry();
      };
    },
    remove() { row.remove(); },
  };
}

function emptyLabel(cat: Category): string {
  if (cat === 'maps') return 'maps';
  if (cat === 'characters') return 'characters';
  return 'audio';
}

function setContentMode(): void {
  const content = document.getElementById('lib-content')!;
  const charDetail = document.getElementById('char-detail')!;
  const mapDetail = document.getElementById('map-detail')!;
  const audioDetail = document.getElementById('audio-detail')!;
  const upload = document.getElementById('upload-zone')!;
  const settings = document.getElementById('settings-panel')!;

  // Settings 보기일 때: 업로드존/리스트/디테일 다 숨기고 settings 만
  if (inSettings) {
    upload.classList.add('hidden');
    content.classList.add('hidden');
    settings.classList.remove('hidden');
    charDetail.classList.add('hidden');
    mapDetail.classList.add('hidden');
    audioDetail.classList.add('hidden');
    stopAnimation();
    return;
  }
  upload.classList.remove('hidden');
  content.classList.remove('hidden');
  settings.classList.add('hidden');

  // 카테고리별 detail 패널 노출 + master-detail 레이아웃 적용
  charDetail.classList.toggle('hidden',  activeCat !== 'characters');
  mapDetail.classList.toggle('hidden',   activeCat !== 'maps');
  audioDetail.classList.toggle('hidden', activeCat !== 'bgm');
  content.classList.add('has-detail');   // 모든 카테고리에 detail 표시

  if (activeCat !== 'characters') {
    selectedChar = null;
    stopAnimation();
  }
  if (activeCat !== 'maps') selectedMap = null;
  if (activeCat !== 'bgm') {
    selectedAudio = null;
    const ap = document.getElementById('audio-player') as HTMLAudioElement | null;
    if (ap) ap.pause();
  }
}

async function refreshList(): Promise<void> {
  setContentMode();
  if (inSettings) { await renderSettings(); return; }
  const list = document.getElementById('file-list')!;
  list.innerHTML = '<li class="lib-empty">Loading…</li>';
  try {
    const all = await listAssets(token, activeCat);

    // 카테고리별 분류
    let items: BlobItem[] = [];
    let sidecars: BlobItem[] = [];
    // 캐릭터 ZIP 폴더의 파일 크기 합산 (대표 파일 pathname → 폴더 내 합산 바이트)
    const folderTotalSize = new Map<string, number>();
    if (activeCat === 'characters') {
      // 캐릭터: 대표 파일(legacy PNG or ZIP thumbnail) 만 items.
      for (const it of all) {
        if (isCharacterEntryPath(it.pathname)) items.push(it);
        else if (it.pathname.endsWith('.meta.json') || it.pathname.endsWith('/meta.json')) sidecars.push(it);
      }
      // ZIP 폴더 안 모든 파일 크기 합산
      for (const it of all) {
        const m = /^characters\/([^/]+)\//.exec(it.pathname);
        if (m) {
          const thumbPath = thumbnailPathFor(m[1]);
          folderTotalSize.set(thumbPath, (folderTotalSize.get(thumbPath) ?? 0) + it.size);
        }
      }
    } else if (activeCat === 'maps') {
      // 맵: 대표(legacy .json 또는 ZIP /main.json) 만 items. 사이드 파일/history 백업은 숨김.
      mapHistoryCountByPath.clear();
      for (const it of all) {
        if (isMapEntryPath(it.pathname)) items.push(it);
        else if (
          (it.pathname.endsWith('.meta.json') || it.pathname.endsWith('/meta.json'))
          && !isMapHistoryPath(it.pathname)
        ) sidecars.push(it);
      }
      for (const it of all) {
        const m = /^maps\/([^/]+)\//.exec(it.pathname);
        if (m) {
          const mainPath = `maps/${m[1]}/main.json`;
          folderTotalSize.set(mainPath, (folderTotalSize.get(mainPath) ?? 0) + it.size);
          // history zip 개수도 카운트 (legacy 자산의 version fallback 용)
          if (isMapHistoryPath(it.pathname) && it.pathname.endsWith('.zip')) {
            mapHistoryCountByPath.set(mainPath, (mapHistoryCountByPath.get(mainPath) ?? 0) + 1);
          }
        }
      }
    } else {
      for (const it of all) {
        if (it.pathname.endsWith('.meta.json')) sidecars.push(it);
        else items.push(it);
      }
    }

    // Maps 메타 로드 — ZIP/legacy 둘 다 지원
    if (activeCat === 'maps' && sidecars.length > 0) {
      const itemPaths = new Set(items.map((it) => it.pathname));
      mapMetaByPath.clear();
      await Promise.all(sidecars.map(async (s) => {
        try {
          const r = await fetch(s.url, { cache: 'reload' });
          if (!r.ok) return;
          const j = await r.json() as MapMeta;
          const entryPath = mapEntryPathForSidecar(s.pathname);
          if (!itemPaths.has(entryPath)) return;
          mapMetaByPath.set(entryPath, {
            ...j,
            totalSize: folderTotalSize.get(entryPath),
          });
        } catch { /* 무시 */ }
      }));
    }
    // Audio 메타 로드
    if (activeCat === 'bgm' && sidecars.length > 0) {
      await Promise.all(sidecars.map(async (s) => {
        try {
          const r = await fetch(s.url, { cache: 'reload' });
          if (!r.ok) return;
          const j = await r.json() as AudioMeta;
          // .meta.json → 원본 파일 확장자 자동 탐색 (sidecar 는 확장자 정보 없음 — list 에서 매칭)
          const baseNoExt = s.pathname.replace(/\.meta\.json$/, '');
          const candidate = items.find((it) => it.pathname.startsWith(baseNoExt + '.'));
          if (candidate) {
            audioMetaByPath.set(candidate.pathname, {
              name: j.name, volume: j.volume, loop: j.loop,
              category: (j as { category?: AudioCategory }).category,
              memo: (j as { memo?: string }).memo,
              fields: j.fields,
            });
          }
        } catch { /* 무시 */ }
      }));
    }

    // 캐릭터 메타 로드 — meta.json 의 pathname 으로 대표 파일 pathname 추정.
    // 새 refresh 마다 캐릭터 메타 맵을 비워서 phantom(대표 파일 사라진 후 잔존하는 메타) 제거.
    if (activeCat === 'characters') {
      charMetaByPath.clear();
      const itemPaths = new Set(items.map((it) => it.pathname));
      if (sidecars.length > 0) {
        await Promise.all(sidecars.map(async (s) => {
          try {
            const r = await fetch(s.url, { cache: 'reload' });
            if (!r.ok) return;
            const j = await r.json() as {
              actions?: LPCAction[]; body?: BodyType; name?: string; race?: string;
              fields?: Record<string, string>;
              format?: 'single' | 'zip'; anims?: Record<string, string>; customAnims?: string[];
              originalZipUrl?: string;
            };
            const charPath = entryPathForSidecar(s.pathname);
            // 대응하는 대표 파일이 실제로 존재하지 않으면 orphan 메타 — 무시
            if (!itemPaths.has(charPath)) return;
            if (Array.isArray(j.actions)) {
              charMetaByPath.set(charPath, {
                actions: j.actions,
                body: j.body,
                name: j.name,
                race: j.race,
                fields: j.fields,
                format: j.format ?? 'single',
                anims: j.anims,
                customAnims: j.customAnims,
                originalZipUrl: j.originalZipUrl,
                totalSize: folderTotalSize.get(charPath),
              });
            }
          } catch { /* 무시 */ }
        }));
      }
    }

    if (items.length === 0) {
      list.innerHTML = `<li class="lib-empty">No ${emptyLabel(activeCat)} yet. Upload above.</li>`;
      if (activeCat === 'characters') renderDetail(null);
      else if (activeCat === 'maps') renderMapDetail(null);
      else if (activeCat === 'bgm') renderAudioDetail(null);
      return;
    }
    list.innerHTML = '';
    for (const it of items) list.appendChild(makeItem(it));

    // 첫 행 자동 선택 — 각 카테고리별.
    // 이미 선택된 항목을 다시 그리는 경로는 preserveDirty=true 로 — 저장 안 한 편집을 살림.
    if (activeCat === 'characters') {
      if (!selectedChar || !items.some((i) => i.pathname === selectedChar!.pathname)) {
        selectChar(items[0]);
      } else {
        renderDetail(selectedChar, { preserveDirty: true });
      }
    } else if (activeCat === 'maps') {
      if (!selectedMap || !items.some((i) => i.pathname === selectedMap!.pathname)) {
        selectMap(items[0]);
      } else {
        renderMapDetail(selectedMap, { preserveDirty: true });
      }
    } else if (activeCat === 'bgm') {
      if (!selectedAudio || !items.some((i) => i.pathname === selectedAudio!.pathname)) {
        selectAudio(items[0]);
      } else {
        renderAudioDetail(selectedAudio, { preserveDirty: true });
      }
    }
  } catch (e) {
    if (e instanceof AuthError) {
      clearToken();
      location.reload();
      return;
    }
    list.innerHTML = `<li class="lib-empty">Failed to load: ${(e as Error).message}</li>`;
  }
}

/** 캐릭터 삭제 — single 은 PNG+meta, ZIP 은 폴더 안 모든 파일(thumbnail/anims/meta). */
async function deleteCharacter(it: BlobItem): Promise<void> {
  if (!isZipEntryPath(it.pathname)) {
    // legacy: PNG + sidecar meta.json
    await deleteAsset(token, it.url);
    const metaUrl = metaUrlForEntry(it.url, it.pathname);
    try { await deleteAsset(token, metaUrl); } catch { /* sidecar 없을 수 있음 */ }
    return;
  }
  // ZIP: 폴더 안 모든 파일 나열 후 삭제
  const folderPrefix = zipFolderPrefix(charBaseName(it.pathname));
  const all = await listAssets(token, 'characters');
  const toDelete = all.filter((b) => b.pathname.startsWith(folderPrefix));
  for (const b of toDelete) {
    try { await deleteAsset(token, b.url); } catch { /* 일부 실패 무시 */ }
  }
}

function bodyLabel(body: BodyType | undefined): string {
  if (body === 'male') return 'Male';
  if (body === 'female') return 'Female';
  if (body === 'none') return 'None';
  return '—';
}
// charBaseName, isCharacterEntryPath 는 paths.ts 로 이동.
function displayName(it: BlobItem): string {
  return charMetaByPath.get(it.pathname)?.name || charBaseName(it.pathname);
}
function normalizeName(s: string): string {
  return s.trim().toLowerCase();
}
/** 이름이 이미 존재하는 캐릭터의 것인지 확인 (대소문자/공백 무시).
 *  exceptPath 가 있으면 그 PNG 의 메타는 비교 대상에서 제외 (detail 에서 자기 자신은 OK). */
function isCharNameTaken(name: string, exceptPath?: string): boolean {
  const norm = normalizeName(name);
  if (!norm) return false;
  for (const [pathname, meta] of charMetaByPath.entries()) {
    if (pathname === exceptPath) continue;
    const n = normalizeName(meta.name || charBaseName(pathname));
    if (n === norm) return true;
  }
  return false;
}
function isAudioNameTaken(name: string, exceptPath?: string): boolean {
  const norm = normalizeName(name);
  if (!norm) return false;
  for (const [pathname, meta] of audioMetaByPath.entries()) {
    if (pathname === exceptPath) continue;
    const fallback = shortName(pathname).replace(/\.[^.]+$/, '');
    const n = normalizeName(meta.name || fallback);
    if (n === norm) return true;
  }
  return false;
}
function suggestUniqueAudioName(base: string): string {
  if (!isAudioNameTaken(base)) return base;
  const m = base.match(/^(.*?)\s*(\d+)$/);
  const stem = m ? m[1].trim() : base;
  let n = m ? parseInt(m[2], 10) + 1 : 2;
  while (n < 10000) {
    const candidate = `${stem} ${n}`;
    if (!isAudioNameTaken(candidate)) return candidate;
    n++;
  }
  return `${base} ${Date.now()}`;
}
async function ensureAudioLoaded(): Promise<void> {
  try {
    const all = await listAssets(token, 'bgm');
    const sidecars = all.filter((it) => it.pathname.endsWith('.meta.json'));
    await Promise.all(sidecars.map(async (s) => {
      try {
        const r = await fetch(s.url, { cache: 'reload' });
        if (!r.ok) return;
        const j = await r.json() as Partial<AudioMeta> & { fields?: Record<string, string> };
        const baseNoExt = s.pathname.replace(/\.meta\.json$/, '');
        const candidate = all.find((it) => it.pathname.startsWith(baseNoExt + '.') && !it.pathname.endsWith('.meta.json'));
        if (candidate) {
          audioMetaByPath.set(candidate.pathname, {
            name: j.name, volume: j.volume, loop: j.loop,
            category: j.category, memo: j.memo, fields: j.fields,
          });
        }
      } catch { /* 무시 */ }
    }));
  } catch { /* 무시 */ }
}
/** base 와 겹치지 않는 다음 이름 제안. 'Knight' → 'Knight 2', 'Knight 2' → 'Knight 3'. */
function suggestUniqueName(base: string): string {
  if (!isCharNameTaken(base)) return base;
  const m = base.match(/^(.*?)\s*(\d+)$/);
  const stem = m ? m[1].trim() : base;
  let n = m ? parseInt(m[2], 10) + 1 : 2;
  while (n < 10000) {
    const candidate = `${stem} ${n}`;
    if (!isCharNameTaken(candidate)) return candidate;
    n++;
  }
  return `${base} ${Date.now()}`;
}
/** 업로드 모달 등에서 호출 — 현재 캐릭터 목록과 메타를 charMetaByPath 에 동기화.
 *  refreshList 와 동일한 orphan 필터링 적용. */
async function ensureCharactersLoaded(): Promise<void> {
  try {
    const all = await listAssets(token, 'characters');
    const entryPaths = new Set(all.filter((it) => isCharacterEntryPath(it.pathname)).map((it) => it.pathname));
    const sidecars = all.filter((it) => it.pathname.endsWith('.meta.json') || it.pathname.endsWith('/meta.json'));
    charMetaByPath.clear();
    await Promise.all(sidecars.map(async (s) => {
      try {
        const r = await fetch(s.url, { cache: 'reload' });
        if (!r.ok) return;
        const j = await r.json() as {
          actions?: LPCAction[]; body?: BodyType; name?: string; race?: string;
          fields?: Record<string, string>;
          format?: 'single' | 'zip'; anims?: Record<string, string>; customAnims?: string[];
          originalZipUrl?: string;
        };
        const charPath = entryPathForSidecar(s.pathname);
        if (!entryPaths.has(charPath)) return;
        if (Array.isArray(j.actions)) {
          charMetaByPath.set(charPath, {
            actions: j.actions, body: j.body, name: j.name, race: j.race,
            fields: j.fields, format: j.format ?? 'single',
            anims: j.anims, customAnims: j.customAnims,
            originalZipUrl: j.originalZipUrl,
          });
        }
      } catch { /* 무시 */ }
    }));
  } catch { /* 무시 */ }
}

function makeItem(it: BlobItem): HTMLElement {
  const li = document.createElement('li');
  li.className = 'lib-item';
  li.dataset.pathname = it.pathname;
  const isChar = activeCat === 'characters' && it.pathname.toLowerCase().endsWith('.png');

  // 좌측: 캐릭터면 썸네일 캔버스, 아니면 확장자 라벨
  let leftEl: HTMLElement;
  if (isChar) {
    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    const c = document.createElement('canvas');
    c.width = 48; c.height = 48;
    thumb.appendChild(c);
    leftEl = thumb;
    loadSheet(it.url, (img) => drawCharacterThumb(c, img));
  } else {
    leftEl = document.createElement('div');
    leftEl.className = 'ext';
    leftEl.textContent = extLabel(it.pathname);
  }

  const meta = document.createElement('div');
  meta.className = 'meta';

  if (isChar) {
    // Characters 표 형식: name | body | date
    const nm = document.createElement('div');
    nm.className = 'name';
    nm.textContent = displayName(it);

    const body = document.createElement('div');
    body.className = 'body';
    body.textContent = bodyLabel(charMetaByPath.get(it.pathname)?.body);

    const date = document.createElement('div');
    date.className = 'date';
    date.textContent = new Date(it.uploadedAt).toLocaleDateString();

    meta.appendChild(nm);
    meta.appendChild(body);
    meta.appendChild(date);

    // 선택 표시
    if (selectedChar && selectedChar.pathname === it.pathname) li.classList.add('selected');
    li.addEventListener('click', () => selectChar(it));
  } else if (activeCat === 'maps') {
    const nm = document.createElement('div');
    nm.className = 'name';
    const mMeta = mapMetaByPath.get(it.pathname);
    const baseLabel = mMeta?.name
      || (isZipMapEntryPath(it.pathname) ? mapBaseName(it.pathname) : shortName(it.pathname).replace(/\.[^.]+$/, ''));
    nm.textContent = baseLabel;
    if (isZipMapEntryPath(it.pathname)) {
      const verSpan = document.createElement('span');
      verSpan.className = 'lib-item-version';
      verSpan.textContent = computeMapVersionShort(mMeta, it.pathname);
      nm.appendChild(document.createTextNode(' '));
      nm.appendChild(verSpan);
    }
    const date = document.createElement('div');
    date.className = 'date';
    date.textContent = new Date(it.uploadedAt).toLocaleDateString();
    meta.appendChild(nm); meta.appendChild(date);
    if (selectedMap && selectedMap.pathname === it.pathname) li.classList.add('selected');
    li.addEventListener('click', () => selectMap(it));
  } else if (activeCat === 'bgm') {
    const nm = document.createElement('div');
    nm.className = 'name';
    nm.textContent = audioMetaByPath.get(it.pathname)?.name || shortName(it.pathname).replace(/\.[^.]+$/, '');
    const date = document.createElement('div');
    date.className = 'date';
    date.textContent = new Date(it.uploadedAt).toLocaleDateString();
    meta.appendChild(nm); meta.appendChild(date);
    if (selectedAudio && selectedAudio.pathname === it.pathname) li.classList.add('selected');
    li.addEventListener('click', () => selectAudio(it));
  } else {
    const nm = document.createElement('div');
    nm.className = 'name'; nm.textContent = shortName(it.pathname);
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = `${fmtSize(it.size)} · ${new Date(it.uploadedAt).toLocaleDateString()}`;
    meta.appendChild(nm); meta.appendChild(sub);
  }

  const del = document.createElement('button');
  del.className = 'del'; del.textContent = '×'; del.title = 'Delete';
  del.addEventListener('click', async (e) => {
    e.stopPropagation();
    const confirmMsg = activeCat === 'characters' ? 'Delete this character?' : 'Delete this file?';
    if (!confirm(confirmMsg)) return;
    try {
      if (activeCat === 'characters') {
        await deleteCharacter(it);
        if (selectedChar?.pathname === it.pathname) selectedChar = null;
      } else {
        await deleteAsset(token, it.url);
      }
      showToast('Deleted');
      refreshList();
    } catch (err) {
      showToast((err as Error).message, 'err');
    }
  });
  li.appendChild(leftEl);
  li.appendChild(meta);
  li.appendChild(del);
  return li;
}

/** 저장 직후 리스트 row 만 inline 업데이트 — 전체 refreshList 대신 사용.
 *  메모리(*MetaByPath) 는 호출 전에 이미 새 값으로 set 되어 있다고 가정. */
function updateListRowInline(pathname: string): void {
  const li = document.querySelector(`.lib-item[data-pathname="${CSS.escape(pathname)}"]`);
  if (!li) return;
  const nm = li.querySelector('.name') as HTMLElement | null;
  if (!nm) return;
  if (pathname.startsWith('characters/')) {
    const meta = charMetaByPath.get(pathname);
    nm.textContent = meta?.name || charBaseName(pathname);
    const body = li.querySelector('.body') as HTMLElement | null;
    if (body) body.textContent = bodyLabel(meta?.body);
  } else if (pathname.startsWith('maps/')) {
    const meta = mapMetaByPath.get(pathname);
    nm.textContent = meta?.name || shortName(pathname).replace(/\.[^.]+$/, '');
  } else if (pathname.startsWith('bgm/')) {
    const meta = audioMetaByPath.get(pathname);
    nm.textContent = meta?.name || shortName(pathname).replace(/\.[^.]+$/, '');
  }
}

function selectChar(it: BlobItem): void {
  selectedChar = it;
  // 리스트의 선택 표시 갱신
  document.querySelectorAll('.lib-item.selected').forEach((el) => el.classList.remove('selected'));
  document.querySelectorAll('.lib-item').forEach((el) => {
    const isSelected = (el.querySelector('.name') as HTMLElement | null)?.textContent === charBaseName(it.pathname);
    if (isSelected) el.classList.add('selected');
  });
  renderDetail(it);
}

function renderDetail(it: BlobItem | null, opts: { preserveDirty?: boolean } = {}): void {
  const emptyEl = document.getElementById('detail-empty')!;
  const formEl = document.getElementById('detail-form')!;
  const nameInput = document.getElementById('detail-name') as HTMLInputElement;
  const bodySel = document.getElementById('detail-body') as HTMLSelectElement;
  const raceInput = document.getElementById('detail-race') as HTMLInputElement;
  const subEl = document.getElementById('detail-sub')!;
  const saveBtn = document.getElementById('detail-save') as HTMLButtonElement;
  const dlBtn = document.getElementById('detail-download') as HTMLAnchorElement;
  const actionsEl = document.getElementById('detail-actions')!;
  const canvas = document.getElementById('detail-preview') as HTMLCanvasElement;

  // 같은 항목 + 저장 안 된 편집이 있는 상태 → 폼 reset 스킵 (사용자 입력 보호)
  if (it && opts.preserveDirty && lastRenderedCharPath === it.pathname && !saveBtn.disabled) {
    return;
  }

  stopAnimation();
  if (!it) {
    lastRenderedCharPath = null;
    emptyEl.classList.remove('hidden');
    formEl.classList.add('hidden');
    actionsEl.innerHTML = '';
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    const { canvases: dirCanvases } = getDirElements();
    dirCanvases.forEach((c) => {
      const cctx = c.getContext('2d');
      if (cctx) cctx.clearRect(0, 0, c.width, c.height);
    });
    return;
  }
  lastRenderedCharPath = it.pathname;
  emptyEl.classList.add('hidden');
  formEl.classList.remove('hidden');

  const meta = charMetaByPath.get(it.pathname);
  const initialName = meta?.name ?? charBaseName(it.pathname);
  const initialBody = meta?.body ?? 'none';
  const initialRace = meta?.race ?? '';
  nameInput.value = initialName;
  bodySel.value = initialBody;
  raceInput.value = initialRace;
  const displaySize = meta?.totalSize ?? it.size;
  subEl.textContent = `${fmtSize(displaySize)} · ${new Date(it.uploadedAt).toLocaleDateString()}`;
  saveBtn.disabled = true;

  // 다운로드 버튼 — ZIP 포맷은 보관해둔 원본 zip, single 은 PNG 그대로
  if (meta?.format === 'zip' && meta.originalZipUrl) {
    dlBtn.href = meta.originalZipUrl;
    const charName = initialName || charBaseName(it.pathname);
    dlBtn.setAttribute('download', `${charName}.zip`);
    dlBtn.title = 'Download original ZIP';
    dlBtn.style.display = '';
  } else if (meta?.format === 'zip') {
    // ZIP 캐릭터인데 원본이 없는 경우 (구버전) — 다운로드 비활성
    dlBtn.removeAttribute('href');
    dlBtn.title = 'Original ZIP not stored for this character';
    dlBtn.style.opacity = '0.4';
    dlBtn.style.pointerEvents = 'none';
  } else {
    dlBtn.href = it.url;
    dlBtn.setAttribute('download', shortName(it.pathname));
    dlBtn.title = 'Download original sheet';
    dlBtn.style.opacity = '';
    dlBtn.style.pointerEvents = '';
  }

  // 커스텀 스키마 필드 폼 렌더
  const customFieldsHost = renderCustomFieldsForm(formEl, schemasByCategory.characters.fields, meta?.fields ?? {}, onAnyChange);
  const warnEl = document.getElementById('detail-warn')!;

  // 변경 감지 + 이름 충돌 검사
  function onAnyChange(): void {
    const raw = nameInput.value.trim();
    const customChanged = customFieldsHost.changed();
    const changed = raw !== initialName
      || bodySel.value !== initialBody
      || raceInput.value.trim() !== initialRace
      || customChanged;
    if (raw.length === 0) {
      warnEl.textContent = 'Name is required.';
      warnEl.classList.remove('hidden');
      saveBtn.disabled = true;
      return;
    }
    if (raw !== initialName && isCharNameTaken(raw, it!.pathname)) {
      warnEl.textContent = `A character named "${raw}" already exists.`;
      warnEl.classList.remove('hidden');
      saveBtn.disabled = true;
      return;
    }
    warnEl.classList.add('hidden');
    saveBtn.disabled = !changed;
  }
  nameInput.oninput = onAnyChange;
  bodySel.onchange = onAnyChange;
  raceInput.oninput = onAnyChange;

  saveBtn.onclick = async (): Promise<void> => {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      const newFields = customFieldsHost.values();
      const isZip = isZipEntryPath(it.pathname);
      const fmt: CharFormat = isZip ? 'zip' : 'single';

      // 기존 메타 fetch → 우리가 모르는 필드(LPC character state, anims, originalZipUrl 등)도 보존
      const existingMetaUrl = metaUrlForEntry(it.url, it.pathname);
      let existing: Record<string, unknown> = {};
      try {
        const r = await fetch(existingMetaUrl, { cache: 'reload' });
        if (r.ok) existing = await r.json() as Record<string, unknown>;
      } catch { /* 없으면 무시 */ }

      const merged = {
        ...existing,
        schema: 1,
        source: isZip ? 'lpc-zip' : 'lpc',
        format: fmt,
        body: bodySel.value as BodyType,
        name: nameInput.value.trim(),
        race: raceInput.value.trim() || undefined,
        actions: meta?.actions ?? (existing.actions as LPCAction[] | undefined) ?? [],
        fields: newFields,
        savedAt: new Date().toISOString(),
      };
      const metaFile = new File(
        [JSON.stringify(merged, null, 2)],
        metaFilenameFor(it.pathname),
        { type: 'application/json' },
      );
      await uploadAsset(token, 'characters', metaFile);

      const newMeta: CharMeta = {
        actions: merged.actions as LPCAction[],
        body: merged.body,
        name: merged.name,
        race: merged.race,
        fields: newFields,
        format: meta?.format,
        anims: meta?.anims,
        customAnims: meta?.customAnims,
        originalZipUrl: meta?.originalZipUrl,
        totalSize: meta?.totalSize,
      };
      charMetaByPath.set(it.pathname, newMeta);
      updateListRowInline(it.pathname);
      showToast('Saved');
      saveBtn.textContent = 'Save';
    } catch (e) {
      const msg = e instanceof AuthError ? 'Auth expired — refresh' : (e as Error).message;
      showToast(msg, 'err');
      saveBtn.textContent = 'Save';
      saveBtn.disabled = false;
    }
  };

  // 방향 버튼(up/left/down/right) — 클릭 시 메인 캔버스 방향만 바꿈.
  // animation loop 가 selectedDir 글로벌을 매 프레임 참조하므로 즉시 반영.
  const { buttons: dirButtons } = getDirElements();
  dirButtons.forEach((btn) => {
    btn.onclick = (): void => {
      const dir = btn.dataset.dir;
      if (!dir || !(dir in DIR_BY_NAME)) return;
      selectedDir = DIR_BY_NAME[dir];
      dirButtons.forEach((b) => b.classList.toggle('lib-dir-active', b === btn));
    };
  });
  // 새 캐릭터로 전환 시 active 상태도 selectedDir 에 맞춰 갱신
  dirButtons.forEach((b) => {
    const dir = b.dataset.dir;
    b.classList.toggle('lib-dir-active', dir != null && DIR_BY_NAME[dir] === selectedDir);
  });

  // 액션 버튼 — ZIP 포맷이면 anims 키 전체 (custom 포함), single 이면 검출된 actions
  actionsEl.innerHTML = '';
  const animKeys: string[] = meta?.format === 'zip' && meta.anims
    ? Object.keys(meta.anims)
    : (meta?.actions ?? []);
  if (animKeys.length === 0) {
    actionsEl.innerHTML = '<span class="lib-tag lib-tag-muted">no animations</span>';
    if (meta?.format !== 'zip') loadSheet(it.url, (img) => drawIdleFrame(canvas, img));
    // 액션 없으면 4방향 sub 도 비움
    const { canvases: dirCanvases } = getDirElements();
    dirCanvases.forEach(clearCanvas);
    return;
  }
  for (const a of animKeys) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = ANIMATION_CONFIGS[a as LPCAction]?.label ?? a;
    btn.dataset.action = a;
    btn.addEventListener('click', () => playAction(a, it.url, canvas, actionsEl, meta));
    actionsEl.appendChild(btn);
  }

  // 기본 재생: idle 액션이 있으면 자동, 없으면 정적 idle
  if (animKeys.includes('idle')) {
    playAction('idle', it.url, canvas, actionsEl, meta);
  } else if (meta?.format !== 'zip') {
    loadSheet(it.url, (img) => drawIdleFrame(canvas, img));
  }
}

// ===== Maps detail =====

function selectMap(it: BlobItem): void {
  selectedMap = it;
  document.querySelectorAll('.lib-item.selected').forEach((el) => el.classList.remove('selected'));
  // data-pathname 으로 정확 매칭
  document.querySelectorAll<HTMLElement>('.lib-item').forEach((el) => {
    if (el.dataset.pathname === it.pathname) el.classList.add('selected');
  });
  renderMapDetail(it);
}

function renderMapDetail(it: BlobItem | null, opts: { preserveDirty?: boolean } = {}): void {
  const emptyEl = document.getElementById('map-empty')!;
  const formEl = document.getElementById('map-form')!;
  const nameInput = document.getElementById('map-name') as HTMLInputElement;
  const statsEl = document.getElementById('map-stats')!;
  const subEl = document.getElementById('map-sub')!;
  const saveBtn = document.getElementById('map-save') as HTMLButtonElement;
  const dlBtn = document.getElementById('map-download') as HTMLAnchorElement;
  const warnEl = document.getElementById('map-warn')!;
  const previewC = document.getElementById('map-preview') as HTMLCanvasElement;
  const customHost = document.getElementById('map-custom-fields')!;

  if (it && opts.preserveDirty && lastRenderedMapPath === it.pathname && !saveBtn.disabled) {
    return;
  }

  if (!it) {
    lastRenderedMapPath = null;
    emptyEl.classList.remove('hidden');
    formEl.classList.add('hidden');
    statsEl.innerHTML = '';
    customHost.innerHTML = '';
    const ctx = previewC.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, previewC.width, previewC.height);
    return;
  }
  lastRenderedMapPath = it.pathname;
  emptyEl.classList.add('hidden');
  formEl.classList.remove('hidden');

  const meta = mapMetaByPath.get(it.pathname);
  const isZipMap = isZipMapEntryPath(it.pathname);
  const baseName = isZipMap ? mapBaseName(it.pathname) : shortName(it.pathname).replace(/\.[^.]+$/, '');
  const initialName = meta?.name ?? baseName;
  nameInput.value = initialName;
  const displaySize = meta?.totalSize ?? it.size;
  subEl.textContent = `${fmtSize(displaySize)} · ${new Date(it.uploadedAt).toLocaleDateString()}`;
  saveBtn.disabled = true;
  warnEl.classList.add('hidden');

  // 다운로드 버튼 — ZIP 맵은 원본 ZIP, legacy 단일 파일은 그대로
  if (isZipMap && meta?.originalZipUrl) {
    dlBtn.href = meta.originalZipUrl;
    dlBtn.setAttribute('download', `${initialName || baseName}.zip`);
    dlBtn.title = 'Download original ZIP';
    dlBtn.style.opacity = '';
    dlBtn.style.pointerEvents = '';
  } else if (isZipMap) {
    // ZIP 맵인데 originalZipUrl 없음 — 비활성
    dlBtn.removeAttribute('href');
    dlBtn.title = 'Original ZIP not stored for this map';
    dlBtn.style.opacity = '0.4';
    dlBtn.style.pointerEvents = 'none';
  } else {
    dlBtn.href = it.url;
    dlBtn.setAttribute('download', shortName(it.pathname));
    dlBtn.title = 'Download original map';
    dlBtn.style.opacity = '';
    dlBtn.style.pointerEvents = '';
  }

  // 미리보기 — 일단 placeholder, 그 다음 진짜 맵 렌더 시도. 실패 시 placeholder 유지.
  drawMapPlaceholder(previewC);
  void renderMapPreview(previewC, it.url).catch(() => {
    // 실패 시 placeholder 그대로 — 콘솔에만 알리고 사용자에겐 안 띄움
  });

  // 통계 — ZIP 맵은 meta.info 에 이미 있음. legacy 면 JSON 직접 fetch.
  // 자산 ID — 폴더명 또는 meta.id (둘 다 같아야 정상). 사용자에게 보여 줘서 게임 manifest 작성에 쓸 수 있게.
  const assetId = meta?.id ?? (isZipMap ? mapBaseName(it.pathname) : baseName);
  // 현재 버전 — meta.version 직접 사용. 옛 자산은 history 개수 + 1 fallback (legacy).
  const versionLabel = computeMapVersionLabel(meta, it.pathname);

  const renderStats = (info: NonNullable<MapMeta['info']> | null): void => {
    const rows: Array<[string, string]> = [];
    rows.push(['id', assetId]);
    rows.push(['version', versionLabel]);
    if (info && isMapeditorInfo(info)) {
      // mapeditor 포맷 — 객체/bounds 통계
      rows.push(['format', `mapeditor v${info.schemaVersion}`]);
      const b = info.bounds;
      rows.push(['bounds (m)', `${b.w.toFixed(1)} × ${b.h.toFixed(1)} @ (${b.x}, ${b.y})`]);
      rows.push(['objects', String(info.objectCount)]);
      for (const [t, n] of Object.entries(info.objectCountByType)) {
        rows.push([`  · ${t}`, String(n)]);
      }
    } else if (info) {
      // Tiled (zip 또는 legacy single) — 기존 동작 그대로
      const ti = info as TiledInfo;
      if (ti.width && ti.height) rows.push(['size (tiles)', `${ti.width} × ${ti.height}`]);
      if (ti.tilewidth && ti.tileheight) rows.push(['tile', `${ti.tilewidth} × ${ti.tileheight}`]);
      if (ti.layers != null) rows.push(['layers', String(ti.layers)]);
      if (ti.tilesets?.length) rows.push(['tilesets', ti.tilesets.join(', ')]);
    } else {
      rows.push(['format', 'not-a-tiled-map']);
    }
    statsEl.innerHTML = '';
    for (const [k, v] of rows) {
      const a = document.createElement('div'); a.className = 'stat-key'; a.textContent = k;
      const b = document.createElement('div'); b.className = 'stat-val'; b.textContent = v;
      statsEl.appendChild(a); statsEl.appendChild(b);
    }
  };
  if (meta?.info) {
    renderStats(meta.info);
  } else {
    statsEl.innerHTML = '<div class="stat-key">Loading…</div><div class="stat-val">—</div>';
    void fetch(it.url, { cache: 'reload' }).then((r) => r.ok ? r.json() : null).then((j) => {
      if (!j || typeof j !== 'object') { renderStats(null); return; }
      // mapeditor 포맷이면 그쪽 info 로.
      const me = j as { schemaVersion?: unknown; objects?: unknown; bounds?: unknown };
      if (me.schemaVersion === 1 && Array.isArray(me.objects)) {
        const byType: Record<string, number> = {};
        for (const o of me.objects) {
          const t = (o && typeof o === 'object') ? String((o as { type?: unknown }).type ?? 'unknown') : 'unknown';
          byType[t] = (byType[t] ?? 0) + 1;
        }
        const br = (me.bounds && typeof me.bounds === 'object') ? me.bounds as { x?: number; y?: number; w?: number; h?: number } : {};
        renderStats({
          schemaVersion: 1,
          bounds: { x: br.x ?? 0, y: br.y ?? 0, w: br.w ?? 0, h: br.h ?? 0 },
          objectCount: me.objects.length,
          objectCountByType: byType,
        });
        return;
      }
      const m = j as { width?: number; height?: number; tilewidth?: number; tileheight?: number; layers?: unknown[]; tilesets?: Array<{ name?: string; source?: string }> };
      renderStats({
        width: m.width, height: m.height, tilewidth: m.tilewidth, tileheight: m.tileheight,
        layers: Array.isArray(m.layers) ? m.layers.length : undefined,
        tilesets: Array.isArray(m.tilesets) ? m.tilesets.map((t) => t.name || t.source || '?') : undefined,
      });
    }).catch(() => { /* 무시 */ });
  }

  // 커스텀 스키마 필드
  const fieldsHost = renderCustomFieldsForm(customHost, schemasByCategory.maps.fields, meta?.fields ?? {}, () => updateSaveState());

  function updateSaveState(): void {
    const raw = nameInput.value.trim();
    const changed = raw !== initialName || fieldsHost.changed();
    saveBtn.disabled = !changed || raw.length === 0;
  }
  nameInput.oninput = updateSaveState;

  saveBtn.onclick = async (): Promise<void> => {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      const fields = fieldsHost.values();
      // 기존 meta 보존 (originalZipUrl, format 등) — fetch 후 merge
      const existingMetaUrl = mapMetaUrlForEntry(it.url, it.pathname);
      let existing: Record<string, unknown> = {};
      try {
        const r = await fetch(existingMetaUrl, { cache: 'reload' });
        if (r.ok) existing = await r.json() as Record<string, unknown>;
      } catch { /* 없으면 무시 */ }
      const merged = {
        ...existing,
        schema: 1,
        name: nameInput.value.trim(),
        fields,
        savedAt: new Date().toISOString(),
      };
      const metaName = isZipMap
        ? mapMetaFilenameFor(baseName)
        : `${baseName}.meta.json`;
      const file = new File([JSON.stringify(merged, null, 2)], metaName, { type: 'application/json' });
      await uploadAsset(token, 'maps', file);
      const newMeta: MapMeta = {
        ...meta,
        name: nameInput.value.trim(),
        fields,
      };
      mapMetaByPath.set(it.pathname, newMeta);
      updateListRowInline(it.pathname);
      showToast('Saved');
      saveBtn.textContent = 'Save';
    } catch (e) {
      const msg = e instanceof AuthError ? 'Auth expired — refresh' : (e as Error).message;
      showToast(msg, 'err');
      saveBtn.textContent = 'Save';
      saveBtn.disabled = false;
    }
  };

  // ── 버전 업로드 + history (ZIP 맵 또는 mapeditor 맵) ───────────────────
  const versionBtn = document.getElementById('map-upload-version') as HTMLButtonElement | null;
  const versionInput = document.getElementById('map-version-input') as HTMLInputElement | null;
  const historyHost = document.getElementById('map-history');
  if (versionBtn && versionInput && historyHost) {
    const isMapeditor = meta?.format === 'mapeditor';
    if (isZipMap && !isMapeditor) {
      // Tiled ZIP 맵 — 기존 흐름
      versionBtn.style.display = '';
      versionInput.accept = '.zip';
      versionBtn.onclick = () => versionInput.click();
      versionInput.onchange = (): void => {
        const f = versionInput.files?.[0];
        versionInput.value = '';
        if (!f) return;
        void uploadMapNewVersion(it, baseName, f);
      };
      void renderMapHistory(historyHost, it, baseName, meta, previewC);
    } else if (isZipMap && isMapeditor) {
      // mapeditor JSON 맵 — .json 받음
      versionBtn.style.display = '';
      versionInput.accept = '.json';
      versionBtn.onclick = () => versionInput.click();
      versionInput.onchange = (): void => {
        const f = versionInput.files?.[0];
        versionInput.value = '';
        if (!f) return;
        void uploadMapeditorNewVersion(it, baseName, f);
      };
      void renderMapHistory(historyHost, it, baseName, meta, previewC);
    } else {
      versionBtn.style.display = 'none';
      historyHost.innerHTML = '';
    }
  }
}

/** ISO timestamp 를 사람 친화적 날짜시간 으로. */
function fmtIsoForDisplay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** history 파일명(ISO 의 ':' → '-' 변환됨) 을 원래 ISO 로 복원. */
function historyFilenameToIso(stem: string): string {
  return stem.replace(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/, '$1-$2-$3T$4:$5:$6');
}

interface VersionRowData {
  version: number;
  savedAt: string;          // ISO
  originalMapFilename: string;
  isCurrent: boolean;
  /** current 면 main.json URL, history 면 zip URL. */
  previewUrl: string;
  /** 다운로드용 zip URL. current 면 originalZipUrl, history 면 history zip url. */
  downloadUrl?: string;
  downloadName: string;
}

async function renderMapHistory(
  host: HTMLElement,
  currentEntry: BlobItem,
  baseName: string,
  meta: MapMeta | undefined,
  previewCanvas: HTMLCanvasElement,
): Promise<void> {
  host.innerHTML = '<div class="lib-detail-empty">Loading history…</div>';
  try {
    const all = await listAssets(token, 'maps');
    const historyPrefix = `${mapFolderPrefix(baseName)}_history/`;
    // ZIP 백업(Tiled) 과 JSON 백업(mapeditor) 둘 다 _history/ 에 공존 가능.
    const isMapeditor = meta?.format === 'mapeditor';
    const histExt = isMapeditor ? '.json' : '.zip';
    const historyZips = all.filter((b) => b.pathname.startsWith(historyPrefix) && b.pathname.endsWith(histExt));

    // versionHistory 가 있으면 (새 자산) 그걸 진실 source 로 사용. 없으면 (옛 자산) 파일명에서 추론.
    const rows: VersionRowData[] = [];
    const currentVersion = meta?.version ?? (historyZips.length + 1);
    const currentSavedAt = meta?.savedAt ?? new Date(currentEntry.uploadedAt).toISOString();
    rows.push({
      version: currentVersion,
      savedAt: currentSavedAt,
      originalMapFilename: meta?.originalMapFilename ?? '(unknown)',
      isCurrent: true,
      previewUrl: currentEntry.url,
      // mapeditor 는 original ZIP 없음 — current 다운로드는 main.json URL 자체.
      downloadUrl: isMapeditor ? currentEntry.url : meta?.originalZipUrl,
      downloadName: `${meta?.name || baseName}-v${currentVersion}${histExt}`,
    });

    const historyFilenameFor = (ts: string): string =>
      isMapeditor ? mapHistoryJsonFilenameFor(baseName, ts) : mapHistoryFilenameFor(baseName, ts);

    // history 행들. versionHistory 있으면 사용, 아니면 파일명에서 추론
    if (meta?.versionHistory && meta.versionHistory.length > 0) {
      for (const rec of meta.versionHistory) {
        const histPath = historyFilenameFor(rec.savedAt);
        const fullPath = `maps/${histPath}`;
        const blob = historyZips.find((z) => z.pathname === fullPath);
        rows.push({
          version: rec.version,
          savedAt: rec.savedAt,
          originalMapFilename: rec.originalMapFilename,
          isCurrent: false,
          previewUrl: blob?.url ?? '',
          downloadUrl: blob?.url,
          downloadName: `${meta?.name || baseName}-v${rec.version}${histExt}`,
        });
      }
    } else if (historyZips.length > 0) {
      // 옛 자산 fallback — 파일명의 timestamp 사용. 파일 이름은 모름 ('(legacy)').
      const sortedAsc = [...historyZips].sort((a, b) => a.pathname.localeCompare(b.pathname));
      sortedAsc.forEach((z, idx) => {
        const stem = z.pathname.slice(historyPrefix.length).replace(/\.(zip|json)$/i, '');
        const iso = historyFilenameToIso(stem);
        rows.push({
          version: idx + 1,
          savedAt: iso,
          originalMapFilename: '(legacy)',
          isCurrent: false,
          previewUrl: z.url,
          downloadUrl: z.url,
          downloadName: `${baseName}-v${idx + 1}${histExt}`,
        });
      });
    }

    // 가장 위에 current, 그 아래로 옛 버전들 (descending — 최근 → 과거)
    const historyRows = rows.filter((r) => !r.isCurrent).sort((a, b) => b.version - a.version);
    const ordered = [rows[0], ...historyRows];

    host.innerHTML = '';
    let activeRowEl: HTMLElement | null = null;
    ordered.forEach((r) => {
      const row = document.createElement('div');
      row.className = 'lib-detail-history-row';
      if (r.isCurrent) row.classList.add('lib-history-current');
      row.tabIndex = 0;

      // v# + current 라벨
      const num = document.createElement('span');
      num.className = 'h-num';
      num.textContent = r.isCurrent ? `v${r.version} · current` : `v${r.version}`;

      // 파일명 + 날짜시간 (두 줄로)
      const meta2 = document.createElement('div'); meta2.className = 'h-meta';
      const fname = document.createElement('div'); fname.className = 'h-fname'; fname.textContent = r.originalMapFilename;
      const tsEl = document.createElement('div'); tsEl.className = 'h-ts'; tsEl.textContent = fmtIsoForDisplay(r.savedAt);
      meta2.appendChild(fname); meta2.appendChild(tsEl);

      // 다운로드
      const dl = document.createElement('a');
      dl.className = 'st-btn';
      dl.textContent = '⬇';
      if (r.downloadUrl) {
        dl.href = r.downloadUrl;
        dl.setAttribute('download', r.downloadName);
      } else {
        dl.style.opacity = '0.4';
        dl.style.pointerEvents = 'none';
      }
      dl.title = 'Download this version';
      dl.onclick = (e) => e.stopPropagation();  // 행 클릭과 분리

      row.appendChild(num); row.appendChild(meta2); row.appendChild(dl);

      // 행 클릭 → 미리보기 갱신
      row.addEventListener('click', () => {
        if (activeRowEl) activeRowEl.classList.remove('lib-history-active');
        row.classList.add('lib-history-active');
        activeRowEl = row;
        // current 면 main.json, history 면 zip 풀기
        if (r.isCurrent) {
          void renderMapPreview(previewCanvas, r.previewUrl).catch(() => {
            drawMapPlaceholder(previewCanvas);
          });
        } else if (r.previewUrl) {
          void renderMapPreviewFromZipUrl(previewCanvas, r.previewUrl).catch(() => {
            drawMapPlaceholder(previewCanvas);
          });
        }
      });

      host.appendChild(row);
      if (r.isCurrent) {
        row.classList.add('lib-history-active');
        activeRowEl = row;
      }
    });
  } catch (e) {
    host.innerHTML = `<div class="lib-detail-empty">Failed to load: ${(e as Error).message}</div>`;
  }
}

/** ZIP 맵의 새 버전 업로드.
 *  1) 기존 original.zip 내용을 _history/<ISO>.zip 으로 복사 (옛 버전 보존)
 *  2) 새 ZIP 풀어서 main.json/sides/original.zip/meta.json 덮어쓰기
 *  Vercel Blob 의 server-side copy API 가 없어서 1) 은 download → reupload. */
async function uploadMapNewVersion(currentEntry: BlobItem, baseName: string, newZip: File): Promise<void> {
  const progress = appendProgressRow(`${baseName} — new version`);

  const run = async (): Promise<void> => {
    progress.setStage(`${baseName} — parsing ZIP`);
    progress.setPercent(0);
    let parsed: ParsedMapZip;
    try {
      parsed = await parseMapZip(newZip);
    } catch (e) {
      progress.failure(`${baseName} — ${(e as Error).message}`, run);
      return;
    }
    const totalFiles = 2 + 1 + parsed.sideFiles.length + 1; // history 백업(1) + main + sides + original + meta
    let done = 0;
    const tick = (): void => { done++; progress.setPercent(Math.round((done / totalFiles) * 100)); };

    try {
      // 1) 기존 original.zip 을 _history/<ISO>.zip 으로 보존. 같은 ISO 를 versionHistory record 에 사용.
      const meta = mapMetaByPath.get(currentEntry.pathname);
      const existingOriginalUrl = meta?.originalZipUrl;
      const backupIsoTs = new Date().toISOString();
      let backedUp = false;
      if (existingOriginalUrl) {
        progress.setStage(`${baseName} — backing up current version`);
        const r = await fetch(existingOriginalUrl, { cache: 'reload' });
        if (!r.ok) throw new Error(`current original.zip fetch failed: ${r.status}`);
        const buf = await r.arrayBuffer();
        const histFile = new File([buf], mapHistoryFilenameFor(baseName, backupIsoTs), { type: 'application/zip' });
        await uploadAsset(token, 'maps', histFile);
        backedUp = true;
        tick();
      } else {
        // 기존 original.zip 이 없는 (구버전) 맵 — history 백업은 스킵
        tick();
      }
      // 2) 새 ZIP 풀어서 같은 폴더에 덮어쓰기 (uploadAsset 은 allowOverwrite:true)
      progress.setStage(`${baseName} — ${parsed.mapFilename}`);
      const mainFile = new File([parsed.mapFile], mapMainFilenameFor(baseName), { type: 'application/json' });
      await uploadAsset(token, 'maps', mainFile);
      tick();
      for (const side of parsed.sideFiles) {
        progress.setStage(`${baseName} — ${side.name}`);
        const out = new File([side], mapSideFilenameFor(baseName, side.name), { type: side.type });
        await uploadAsset(token, 'maps', out);
        tick();
      }
      progress.setStage(`${baseName} — original.zip`);
      const origFile = new File([newZip], mapOriginalZipFilenameFor(baseName), { type: 'application/zip' });
      const origBlob = await uploadAsset(token, 'maps', origFile);
      const newOriginalZipUrl = origBlob.url;
      tick();
      // 3) meta.json — 기존 meta merge + version + 1. version 누락(옛 자산) 시 history 개수
      //    기준으로 보수적으로 추정: backup 추가 후 history 개수 = 옛 active 의 버전. +1 = 새 active.
      progress.setStage(`${baseName} — metadata`);
      let baselineVersion = meta?.version;
      if (baselineVersion == null) {
        // 옛 자산 — meta 에 version 필드 없음. 방금 backup 까지 포함한 history 개수가 옛 active 의 v#.
        try {
          const all = await listAssets(token, 'maps');
          const prefix = `${mapFolderPrefix(baseName)}_history/`;
          baselineVersion = all.filter((b) => b.pathname.startsWith(prefix) && b.pathname.endsWith('.zip')).length;
        } catch { baselineVersion = 1; }
      }
      const newVersion = baselineVersion + 1;
      // versionHistory 갱신 — 백업된 옛 active 의 record 를 push.
      const prevHistory = meta?.versionHistory ?? [];
      const newHistory = [...prevHistory];
      if (backedUp) {
        newHistory.push({
          version: baselineVersion,
          savedAt: backupIsoTs,
          originalMapFilename: meta?.originalMapFilename ?? '(unknown)',
        });
      }
      const merged: MapMeta = {
        ...(meta ?? {}),
        version: newVersion,
        versionHistory: newHistory,
        savedAt: new Date().toISOString(),
        format: 'zip',
        originalMapFilename: newZip.name,
        originalZipUrl: newOriginalZipUrl,
        info: parsed.mapInfo,
      };
      const metaFile = new File(
        [JSON.stringify({ schema: 1, ...merged, savedAt: new Date().toISOString() }, null, 2)],
        mapMetaFilenameFor(baseName),
        { type: 'application/json' },
      );
      await uploadAsset(token, 'maps', metaFile);
      tick();
      progress.success(`${baseName} — new version uploaded`);
      // 디테일 패널을 새로 그려 미리보기/통계/history 갱신
      refreshList();
    } catch (e) {
      if (e instanceof AuthError) clearToken();
      const msg = e instanceof AuthError ? 'Auth expired — refresh' : (e as Error).message;
      progress.failure(`${baseName} — ${msg}`, run);
    }
  };

  await run();
}

function drawMapPlaceholder(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width, h = canvas.height;
  ctx.fillStyle = '#0e1014';
  ctx.fillRect(0, 0, w, h);
  // 그리드
  ctx.strokeStyle = 'rgba(78, 142, 230, 0.2)';
  ctx.lineWidth = 1;
  const step = 32;
  for (let x = 0; x <= w; x += step) {
    ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, h); ctx.stroke();
  }
  for (let y = 0; y <= h; y += step) {
    ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(w, y + 0.5); ctx.stroke();
  }
  ctx.fillStyle = 'rgba(212, 215, 220, 0.4)';
  ctx.font = '11px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('MAP', w / 2, h / 2);
}

// ===== Map 실제 렌더 =====
//
// Tiled 의 main.json 을 받아 캔버스에 맵 픽셀을 그림. 캐릭터 ZIP 시트와 비슷한 흐름:
// fetch JSON → 외부 .tsj tileset 들 fetch → tileset png 들 load → tile 별로 drawImage.
// 실패하면 placeholder fallback (caller 가 try/catch).

interface TilesetResolved {
  firstgid: number;
  tilewidth: number;
  tileheight: number;
  imagewidth: number;
  imageheight: number;
  columns: number;
  img: HTMLImageElement;
}

interface TiledMap {
  width: number;          // 가로 타일 수
  height: number;         // 세로 타일 수
  tilewidth: number;
  tileheight: number;
  layers: Array<{
    type: string;
    visible?: boolean;
    data?: number[] | string;
    width?: number;
    height?: number;
  }>;
  tilesets: Array<{ firstgid: number; source?: string; image?: string; tilewidth?: number; tileheight?: number; imagewidth?: number; imageheight?: number; columns?: number }>;
}

// flip flag 비트 (Tiled 가 tile id 의 상위 비트에 인코딩) — 우리는 무시하고 id 만.
const TILE_ID_MASK = 0x1fffffff;

let mapPreviewToken = 0;

function joinUrl(baseUrl: string, relative: string): string {
  try { return new URL(relative, baseUrl).href; } catch { return relative; }
}

async function loadImageAsync(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(e);
    img.src = url;
  });
}

/** Tiled main.json 안 tileset.source 가 사용자 작업환경 기준 상대경로(`../../..`) 일 수 있어,
 *  같은 폴더 안 .tsj 로 강제 정규화. .tsx → .tsj 도 함께 변환 (extension 이 ZIP 에 .tsj 로 넣음). */
function normalizeTilesetSource(source: string): string {
  const lastSlash = source.lastIndexOf('/');
  let basename = lastSlash >= 0 ? source.slice(lastSlash + 1) : source;
  basename = basename.replace(/\.tsx$/i, '.tsj');
  return basename;
}

async function resolveTilesets(map: TiledMap, mapUrl: string): Promise<TilesetResolved[]> {
  const out: TilesetResolved[] = [];
  for (const ts of map.tilesets) {
    let def: typeof ts & { source?: string } = ts;
    let baseForImage = mapUrl;
    if (ts.source) {
      // 외부 tileset 참조 — source 정규화 (같은 폴더 안 basename.tsj) 후 fetch
      const normalized = normalizeTilesetSource(ts.source);
      const tsUrl = joinUrl(mapUrl, normalized);
      const r = await fetch(tsUrl, { cache: 'force-cache' });
      if (!r.ok) throw new Error(`tileset fetch failed: ${normalized}`);
      const tsJson = await r.json() as typeof ts;
      def = { ...tsJson, firstgid: ts.firstgid };
      baseForImage = tsUrl;
    }
    if (!def.image) {
      // image collection tileset — 이번 버전 미지원
      continue;
    }
    // tileset 의 image 도 같은 폴더 안 basename 으로 정규화
    const imgBasename = def.image.split('/').pop() ?? def.image;
    const imgUrl = joinUrl(baseForImage, imgBasename);
    const img = await loadImageAsync(imgUrl);
    const tw = def.tilewidth ?? map.tilewidth;
    const th = def.tileheight ?? map.tileheight;
    const iw = def.imagewidth ?? img.naturalWidth;
    const ih = def.imageheight ?? img.naturalHeight;
    const cols = def.columns ?? Math.floor(iw / tw);
    out.push({
      firstgid: def.firstgid,
      tilewidth: tw, tileheight: th,
      imagewidth: iw, imageheight: ih,
      columns: cols, img,
    });
  }
  // firstgid 오름차순으로 (gid 매칭 위해)
  out.sort((a, b) => a.firstgid - b.firstgid);
  return out;
}

function findTilesetForGid(tilesets: TilesetResolved[], gid: number): TilesetResolved | null {
  let best: TilesetResolved | null = null;
  for (const ts of tilesets) {
    if (ts.firstgid <= gid && (!best || ts.firstgid > best.firstgid)) best = ts;
  }
  return best;
}

/** 캔버스에 맵 픽셀 그리기 — fit-scale + 중앙 정렬. URL fetch 와 ZIP 모두에서 공유. */
function drawTiledMapToCanvas(canvas: HTMLCanvasElement, map: TiledMap, tilesets: TilesetResolved[]): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#0e1014';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const pixelW = map.width * map.tilewidth;
  const pixelH = map.height * map.tileheight;
  const scale = Math.min(canvas.width / pixelW, canvas.height / pixelH);
  const offX = (canvas.width - pixelW * scale) / 2;
  const offY = (canvas.height - pixelH * scale) / 2;

  ctx.save();
  ctx.translate(offX, offY);
  ctx.scale(scale, scale);

  for (const layer of map.layers) {
    if (layer.type !== 'tilelayer') continue;
    if (layer.visible === false) continue;
    const data = layer.data;
    if (!Array.isArray(data)) continue;
    const lw = layer.width ?? map.width;
    const lh = layer.height ?? map.height;
    for (let i = 0; i < lw * lh; i++) {
      const raw = data[i];
      if (!raw) continue;
      const gid = (raw >>> 0) & TILE_ID_MASK;
      const ts = findTilesetForGid(tilesets, gid);
      if (!ts) continue;
      const localId = gid - ts.firstgid;
      const sx = (localId % ts.columns) * ts.tilewidth;
      const sy = Math.floor(localId / ts.columns) * ts.tileheight;
      const dx = (i % lw) * map.tilewidth;
      const dy = Math.floor(i / lw) * map.tileheight;
      ctx.drawImage(
        ts.img, sx, sy, ts.tilewidth, ts.tileheight,
        dx, dy, ts.tilewidth, ts.tileheight,
      );
    }
  }
  ctx.restore();
}

async function renderMapPreview(canvas: HTMLCanvasElement, mapUrl: string): Promise<void> {
  const myToken = ++mapPreviewToken;
  const r = await fetch(mapUrl, { cache: 'reload' });
  if (!r.ok) throw new Error(`map fetch failed: ${r.status}`);
  const map = await r.json() as TiledMap;
  if (myToken !== mapPreviewToken) return;
  const tilesets = await resolveTilesets(map, mapUrl);
  if (myToken !== mapPreviewToken) return;
  drawTiledMapToCanvas(canvas, map, tilesets);
}

/** ZIP 파일(원본) 에서 풀어서 캔버스에 그림. history 행 클릭 시 사용. */
async function renderMapPreviewFromZipUrl(canvas: HTMLCanvasElement, zipUrl: string): Promise<void> {
  const myToken = ++mapPreviewToken;
  const r = await fetch(zipUrl, { cache: 'force-cache' });
  if (!r.ok) throw new Error(`history zip fetch failed: ${r.status}`);
  const blob = await r.blob();
  if (myToken !== mapPreviewToken) return;
  const file = new File([blob], 'history.zip', { type: 'application/zip' });
  const parsed = await parseMapZip(file);
  if (myToken !== mapPreviewToken) return;

  // 메인 맵 JSON 파싱
  const map = JSON.parse(await parsed.mapFile.text()) as TiledMap;
  // 사이드 파일을 이름으로 매핑
  const sidesByName = new Map<string, File>();
  for (const f of parsed.sideFiles) sidesByName.set(f.name, f);

  // tilesets resolve — zip 안 파일에서 직접 읽음
  const tilesets: TilesetResolved[] = [];
  for (const ts of map.tilesets) {
    let def: typeof ts = ts;
    if (ts.source) {
      const tsBasename = ts.source.split('/').pop()?.replace(/\.tsx$/i, '.tsj') ?? ts.source;
      const tsFile = sidesByName.get(tsBasename);
      if (!tsFile) continue;
      const tsJson = JSON.parse(await tsFile.text()) as typeof ts;
      def = { ...tsJson, firstgid: ts.firstgid };
    }
    if (!def.image) continue;
    const imgBasename = def.image.split('/').pop() ?? def.image;
    const imgFile = sidesByName.get(imgBasename);
    if (!imgFile) continue;
    const objUrl = URL.createObjectURL(imgFile);
    try {
      const img = await loadImageAsync(objUrl);
      const tw = def.tilewidth ?? map.tilewidth;
      const th = def.tileheight ?? map.tileheight;
      const iw = def.imagewidth ?? img.naturalWidth;
      const ih = def.imageheight ?? img.naturalHeight;
      const cols = def.columns ?? Math.floor(iw / tw);
      tilesets.push({
        firstgid: def.firstgid,
        tilewidth: tw, tileheight: th,
        imagewidth: iw, imageheight: ih,
        columns: cols, img,
      });
    } finally {
      // img.src 가 이미 로드됐으므로 object URL 해제 OK (캔버스는 ImageBitmap 데이터를 유지)
      URL.revokeObjectURL(objUrl);
    }
  }
  if (myToken !== mapPreviewToken) return;
  tilesets.sort((a, b) => a.firstgid - b.firstgid);
  drawTiledMapToCanvas(canvas, map, tilesets);
}

// ===== Audio detail =====

function selectAudio(it: BlobItem): void {
  selectedAudio = it;
  document.querySelectorAll('.lib-item.selected').forEach((el) => el.classList.remove('selected'));
  document.querySelectorAll('.lib-item').forEach((el) => {
    const nm = el.querySelector('.name') as HTMLElement | null;
    if (nm && nm.textContent === (audioMetaByPath.get(it.pathname)?.name || shortName(it.pathname).replace(/\.[^.]+$/, ''))) {
      el.classList.add('selected');
    }
  });
  renderAudioDetail(it);
}

function renderAudioDetail(it: BlobItem | null, opts: { preserveDirty?: boolean } = {}): void {
  const emptyEl = document.getElementById('audio-empty')!;
  const formEl = document.getElementById('audio-form')!;
  const player = document.getElementById('audio-player') as HTMLAudioElement;
  const nameInput = document.getElementById('audio-name') as HTMLInputElement;
  const volIn = document.getElementById('audio-volume') as HTMLInputElement;
  const volVal = document.getElementById('audio-volume-val')!;
  const catSel = document.getElementById('audio-category') as HTMLSelectElement;
  const loopIn = document.getElementById('audio-loop') as HTMLInputElement;
  const memoIn = document.getElementById('audio-memo') as HTMLTextAreaElement;
  const subEl = document.getElementById('audio-sub')!;
  const saveBtn = document.getElementById('audio-save') as HTMLButtonElement;
  const dlBtn = document.getElementById('audio-download') as HTMLAnchorElement;
  const warnEl = document.getElementById('audio-warn')!;
  const customHost = document.getElementById('audio-custom-fields')!;

  if (it && opts.preserveDirty && lastRenderedAudioPath === it.pathname && !saveBtn.disabled) {
    return;
  }

  if (!it) {
    lastRenderedAudioPath = null;
    emptyEl.classList.remove('hidden');
    formEl.classList.add('hidden');
    player.src = '';
    return;
  }
  lastRenderedAudioPath = it.pathname;
  emptyEl.classList.add('hidden');
  formEl.classList.remove('hidden');

  player.src = it.url;
  player.load();

  const meta = audioMetaByPath.get(it.pathname);
  const baseName = shortName(it.pathname).replace(/\.[^.]+$/, '');
  const initialName = meta?.name ?? baseName;
  const initialVol = meta?.volume ?? 0.7;
  const initialLoop = meta?.loop ?? true;
  const initialCat: AudioCategory = meta?.category ?? 'bgm';
  const initialMemo = meta?.memo ?? '';
  nameInput.value = initialName;
  volIn.value = String(initialVol);
  volVal.textContent = initialVol.toFixed(2);
  catSel.value = initialCat;
  loopIn.checked = initialLoop;
  memoIn.value = initialMemo;
  subEl.textContent = `${fmtSize(it.size)} · ${new Date(it.uploadedAt).toLocaleDateString()}`;
  saveBtn.disabled = true;
  warnEl.classList.add('hidden');

  // 다운로드 버튼 — 원본 오디오 파일 직접 다운로드
  dlBtn.href = it.url;
  dlBtn.setAttribute('download', shortName(it.pathname));
  dlBtn.title = 'Download original audio';

  const fieldsHost = renderCustomFieldsForm(customHost, schemasByCategory.bgm.fields, meta?.fields ?? {}, () => updateSaveState());

  function updateSaveState(): void {
    const raw = nameInput.value.trim();
    const v = parseFloat(volIn.value);
    const changed = raw !== initialName
      || Math.abs(v - initialVol) > 0.001
      || loopIn.checked !== initialLoop
      || catSel.value !== initialCat
      || memoIn.value !== initialMemo
      || fieldsHost.changed();
    saveBtn.disabled = !changed || raw.length === 0;
  }
  nameInput.oninput = updateSaveState;
  volIn.oninput = () => { volVal.textContent = parseFloat(volIn.value).toFixed(2); updateSaveState(); };
  catSel.onchange = updateSaveState;
  loopIn.onchange = updateSaveState;
  memoIn.oninput = updateSaveState;

  saveBtn.onclick = async (): Promise<void> => {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      const fields = fieldsHost.values();
      const newMeta: AudioMeta = {
        name: nameInput.value.trim(),
        volume: parseFloat(volIn.value),
        loop: loopIn.checked,
        category: catSel.value as AudioCategory,
        memo: memoIn.value || undefined,
        fields,
      };
      const metaName = `${baseName}.meta.json`;
      const body = JSON.stringify({ schema: 1, ...newMeta, savedAt: new Date().toISOString() }, null, 2);
      const file = new File([body], metaName, { type: 'application/json' });
      await uploadAsset(token, 'bgm', file);
      audioMetaByPath.set(it.pathname, newMeta);
      updateListRowInline(it.pathname);
      showToast('Saved');
      saveBtn.textContent = 'Save';
    } catch (e) {
      const msg = e instanceof AuthError ? 'Auth expired — refresh' : (e as Error).message;
      showToast(msg, 'err');
      saveBtn.textContent = 'Save';
      saveBtn.disabled = false;
    }
  };
}

// ===== Settings 패널 — 카테고리별 메타 필드 스키마 편집 =====

const CATEGORY_LABEL: Record<SchemaCat, string> = {
  maps: 'Maps', characters: 'Characters', bgm: 'Audio',
};

// 빌트인(시스템) 필드 — 스키마 에디터에서 read-only 로 표시.
const BUILTIN_FIELDS: Record<SchemaCat, { key: string; label: string; type: string; note?: string }[]> = {
  characters: [
    { key: 'name',    label: 'Name',    type: 'text' },
    { key: 'body',    label: 'Body',    type: 'select', note: 'male / female / none' },
    { key: 'race',    label: 'Race',    type: 'text' },
    { key: 'actions', label: 'Actions', type: 'list',   note: 'auto-detected from sprite sheet' },
  ],
  maps: [
    { key: 'name', label: 'Name', type: 'text', note: 'display name (separate from filename)' },
  ],
  bgm: [
    { key: 'name',     label: 'Name',           type: 'text' },
    { key: 'volume',   label: 'Default volume', type: 'number', note: '0.0 – 1.0' },
    { key: 'category', label: 'Category',       type: 'select', note: 'bgm / effect' },
    { key: 'loop',     label: 'Loop',           type: 'boolean' },
    { key: 'memo',     label: 'Memo',           type: 'text' },
  ],
};

async function renderSettings(): Promise<void> {
  const titleEl = document.getElementById('settings-title')!;
  const hintEl = document.getElementById('settings-hint')!;
  const bodyEl = document.getElementById('settings-body')!;
  const cat = activeCat;
  titleEl.textContent = `${CATEGORY_LABEL[cat]} · Settings`;
  hintEl.textContent = 'Define custom metadata fields collected for each item in this category. Built-in fields below are always present.';
  renderSchemaEditor(bodyEl, cat);
}

function renderSchemaEditor(container: HTMLElement, cat: SchemaCat): void {
  container.innerHTML = '';

  // 빌트인 필드 섹션
  if (BUILTIN_FIELDS[cat].length > 0) {
    const sec = document.createElement('section');
    sec.className = 'schema-section';
    sec.innerHTML = `<h4 class="schema-section-title">Built-in fields</h4>`;
    const ul = document.createElement('ul');
    ul.className = 'schema-builtin';
    for (const f of BUILTIN_FIELDS[cat]) {
      const li = document.createElement('li');
      li.innerHTML = `<span class="bf-label">${escapeHtml(f.label)}</span>
        <span class="bf-key">${escapeHtml(f.key)}</span>
        <span class="bf-type">${escapeHtml(f.type)}</span>
        <span class="bf-note">${escapeHtml(f.note ?? '')}</span>`;
      ul.appendChild(li);
    }
    sec.appendChild(ul);
    container.appendChild(sec);
  }

  // 커스텀 필드 섹션
  const sec = document.createElement('section');
  sec.className = 'schema-section';
  const headRow = document.createElement('div');
  headRow.className = 'schema-section-head';
  headRow.innerHTML = `<h4 class="schema-section-title">Custom fields</h4>`;
  const addBtn = document.createElement('button');
  addBtn.className = 'st-btn st-btn-primary';
  addBtn.type = 'button';
  addBtn.textContent = '+ Add field';
  headRow.appendChild(addBtn);
  sec.appendChild(headRow);

  const rows = document.createElement('div');
  rows.className = 'schema-rows';
  sec.appendChild(rows);
  container.appendChild(sec);

  const draftFields: FieldDef[] = JSON.parse(JSON.stringify(schemasByCategory[cat].fields));

  const repaint = (): void => {
    rows.innerHTML = '';
    if (draftFields.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'lib-settings-empty';
      empty.textContent = 'No custom fields yet. Click + Add field to define one.';
      rows.appendChild(empty);
      return;
    }
    for (let i = 0; i < draftFields.length; i++) {
      rows.appendChild(makeFieldRow(draftFields, i, markDirty));
    }
  };

  // 변경 감지 + Save 버튼
  const footRow = document.createElement('div');
  footRow.className = 'schema-foot';
  const saveBtn = document.createElement('button');
  saveBtn.className = 'st-btn st-btn-primary';
  saveBtn.type = 'button';
  saveBtn.textContent = 'Save schema';
  saveBtn.disabled = true;
  const revertBtn = document.createElement('button');
  revertBtn.className = 'st-btn';
  revertBtn.type = 'button';
  revertBtn.textContent = 'Revert';
  revertBtn.disabled = true;
  footRow.appendChild(revertBtn);
  footRow.appendChild(saveBtn);
  container.appendChild(footRow);

  function markDirty(): void {
    saveBtn.disabled = false; revertBtn.disabled = false;
  }
  addBtn.addEventListener('click', () => {
    draftFields.push({ key: '', label: '', type: 'text' });
    repaint();
    markDirty();
  });
  saveBtn.addEventListener('click', async () => {
    // 검증: key 비어있거나 중복이면 거부
    const keys = new Set<string>();
    for (const f of draftFields) {
      const k = f.key.trim();
      if (!k) { showToast('Field key is required', 'err'); return; }
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k)) {
        showToast(`Invalid key '${k}' — use letters/digits/underscore`, 'err'); return;
      }
      if (keys.has(k)) { showToast(`Duplicate key '${k}'`, 'err'); return; }
      keys.add(k);
      if (f.type === 'select' && (!f.options || f.options.length === 0)) {
        showToast(`Field '${f.label || k}' is select but has no options`, 'err'); return;
      }
    }
    saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
    try {
      schemasByCategory[cat].fields = draftFields.map((f) => ({
        key: f.key.trim(),
        label: f.label.trim() || f.key.trim(),
        type: f.type,
        options: f.type === 'select' ? (f.options ?? []) : undefined,
        default: f.default || undefined,
      }));
      await saveSchema(token, cat);
      showToast('Schema saved');
      saveBtn.textContent = 'Save schema';
      revertBtn.disabled = true;
    } catch (e) {
      const msg = e instanceof AuthError ? 'Auth expired — refresh' : (e as Error).message;
      showToast(msg, 'err');
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save schema';
    }
  });
  revertBtn.addEventListener('click', () => {
    // 원본으로 되돌림
    draftFields.length = 0;
    for (const f of schemasByCategory[cat].fields) draftFields.push(JSON.parse(JSON.stringify(f)));
    repaint();
    saveBtn.disabled = true;
    revertBtn.disabled = true;
  });

  repaint();
}

// detail 폼 안에 스키마 기반 커스텀 필드 영역 렌더. host.values() / host.changed() 로 상태 조회.
function renderCustomFieldsForm(
  formEl: HTMLElement,
  schemaFields: FieldDef[],
  initial: Record<string, string>,
  onChange: () => void,
): { values: () => Record<string, string>; changed: () => boolean } {
  // 컨테이너 비우고 새로 그림
  let host = formEl.querySelector<HTMLDivElement>('#detail-custom-fields');
  if (!host) {
    host = document.createElement('div');
    host.id = 'detail-custom-fields';
    host.className = 'lib-detail-custom';
    formEl.appendChild(host);
  }
  host.innerHTML = '';

  if (schemaFields.length === 0) {
    return { values: () => ({}), changed: () => false };
  }

  const inputs = new Map<string, HTMLInputElement | HTMLSelectElement>();
  const initialSnap: Record<string, string> = {};

  for (const f of schemaFields) {
    const cur = initial[f.key] ?? f.default ?? '';
    initialSnap[f.key] = cur;
    const wrap = document.createElement('label');
    wrap.className = 'lib-field';
    wrap.textContent = f.label || f.key;
    if (f.type === 'select') {
      const sel = document.createElement('select');
      // 기본 옵션 빈 항목 (선택 안 됐을 때)
      const empty = document.createElement('option');
      empty.value = ''; empty.textContent = '— select —';
      sel.appendChild(empty);
      for (const o of f.options ?? []) {
        const op = document.createElement('option');
        op.value = o; op.textContent = o;
        if (o === cur) op.selected = true;
        sel.appendChild(op);
      }
      if (cur === '') sel.value = '';
      sel.addEventListener('change', onChange);
      wrap.appendChild(sel);
      inputs.set(f.key, sel);
    } else {
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.value = cur;
      inp.placeholder = f.default ?? '';
      inp.addEventListener('input', onChange);
      wrap.appendChild(inp);
      inputs.set(f.key, inp);
    }
    host.appendChild(wrap);
  }

  return {
    values(): Record<string, string> {
      const out: Record<string, string> = {};
      for (const [k, el] of inputs) {
        const v = el.value.trim();
        if (v) out[k] = v;
      }
      return out;
    },
    changed(): boolean {
      for (const [k, el] of inputs) {
        if ((el.value || '').trim() !== (initialSnap[k] || '')) return true;
      }
      return false;
    },
  };
}

function makeFieldRow(draft: FieldDef[], idx: number, markDirty: () => void): HTMLElement {
  const f = draft[idx];
  const row = document.createElement('div');
  row.className = 'schema-row';

  const keyIn = document.createElement('input');
  keyIn.type = 'text'; keyIn.placeholder = 'key (e.g., clothing_color)';
  keyIn.value = f.key;
  keyIn.addEventListener('input', () => { f.key = keyIn.value; markDirty(); });

  const labelIn = document.createElement('input');
  labelIn.type = 'text'; labelIn.placeholder = 'Label (e.g., 옷색깔)';
  labelIn.value = f.label;
  labelIn.addEventListener('input', () => { f.label = labelIn.value; markDirty(); });

  const typeSel = document.createElement('select');
  for (const [v, l] of [['text', 'Text'], ['select', 'Select']] as const) {
    const o = document.createElement('option');
    o.value = v; o.textContent = l;
    if (v === f.type) o.selected = true;
    typeSel.appendChild(o);
  }
  typeSel.addEventListener('change', () => {
    f.type = typeSel.value as FieldType;
    if (f.type !== 'select') f.options = undefined;
    else if (!f.options) f.options = [];
    markDirty();
    // 옵션 영역 업데이트
    optsRow.style.display = f.type === 'select' ? '' : 'none';
  });

  const defaultIn = document.createElement('input');
  defaultIn.type = 'text'; defaultIn.placeholder = 'default (optional)';
  defaultIn.value = f.default ?? '';
  defaultIn.addEventListener('input', () => { f.default = defaultIn.value || undefined; markDirty(); });

  const delBtn = document.createElement('button');
  delBtn.className = 'del-btn'; delBtn.textContent = '×'; delBtn.title = 'Delete field';
  delBtn.addEventListener('click', () => {
    draft.splice(idx, 1);
    row.dispatchEvent(new CustomEvent('field-removed', { bubbles: true }));
    markDirty();
    // 부모 컨테이너에 다시 그리기 요청 — 이벤트로 통신하기 번거로움. row.parentElement!.parentElement! 등.
    // 간단히: 페이지 다시 그리기.
    refreshList();
  });

  row.appendChild(keyIn);
  row.appendChild(labelIn);
  row.appendChild(typeSel);
  row.appendChild(defaultIn);
  row.appendChild(delBtn);

  // 옵션 영역 (select 일 때만)
  const optsRow = document.createElement('div');
  optsRow.className = 'schema-options';
  optsRow.style.display = f.type === 'select' ? '' : 'none';
  const optsLabel = document.createElement('span');
  optsLabel.textContent = 'Options';
  const optsIn = document.createElement('textarea');
  optsIn.rows = 2;
  optsIn.placeholder = 'red\nblue\ngreen';
  optsIn.value = (f.options ?? []).join('\n');
  optsIn.addEventListener('input', () => {
    f.options = optsIn.value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    markDirty();
  });
  optsRow.appendChild(optsLabel);
  optsRow.appendChild(optsIn);
  row.appendChild(optsRow);

  return row;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}


function drawIdleFrame(canvas: HTMLCanvasElement, img: HTMLImageElement): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // walk-down idle = row 10, col 0
  if (img.naturalWidth >= FRAME_SIZE && img.naturalHeight >= 11 * FRAME_SIZE) {
    ctx.drawImage(img, 0, 10 * FRAME_SIZE, FRAME_SIZE, FRAME_SIZE,
                  0, 0, canvas.width, canvas.height);
  }
}

function stopAnimation(): void {
  if (playRafId) cancelAnimationFrame(playRafId);
  playRafId = 0;
  playingAction = null;
  document.querySelectorAll('.lib-detail-actions button.playing').forEach((b) => b.classList.remove('playing'));
}

// 현재 detail 패널의 4방향 sub canvas 핸들을 얻음 — 매 재생마다 새로 lookup.
function getDirElements(): { buttons: HTMLButtonElement[]; canvases: HTMLCanvasElement[] } {
  const root = document.getElementById('detail-dirs');
  if (!root) return { buttons: [], canvases: [] };
  const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('.lib-dir-btn'));
  const canvases = buttons.map((b) => b.querySelector('canvas') as HTMLCanvasElement);
  return { buttons, canvases };
}

function clearCanvas(c: HTMLCanvasElement): void {
  const ctx = c.getContext('2d');
  if (!ctx) return;
  ctx.fillStyle = '#0e1014';
  ctx.fillRect(0, 0, c.width, c.height);
}

// 한 프레임(row/col) 을 캔버스에 그림 — frame size 매개변수로 받음 (single sheet=64, ZIP anim=가변).
function drawFrame(img: HTMLImageElement, canvas: HTMLCanvasElement, row: number, col: number, frameSize: number): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#0e1014';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, col * frameSize, row * frameSize, frameSize, frameSize,
                0, 0, canvas.width, canvas.height);
}

// 액션 재생 — 단일 시트(single) 와 액션별 PNG(zip) 양쪽 지원.
//   메인 캔버스 + 4방향 sub 캔버스 동시 재생. 1방향 액션이면 sub 비활성 + clear.
//   메인 row 는 selectedDir 글로벌을 매 프레임 참조해서 사용자가 방향 버튼 누르면 즉시 반영.
function playAction(
  actionName: string,
  sheetUrl: string,
  mainCanvas: HTMLCanvasElement,
  container: HTMLElement,
  meta?: CharMeta,
): void {
  if (playingAction === actionName) { stopAnimation(); return; }
  stopAnimation();
  playingAction = actionName;
  container.querySelectorAll('button').forEach((b) => {
    b.classList.toggle('playing', b.dataset.action === actionName);
  });

  // ZIP 포맷이고 해당 anim 의 dedicated PNG 가 있으면 그걸 사용
  if (meta?.format === 'zip' && meta.anims && meta.anims[actionName]) {
    playFromAnimFile(actionName, meta.anims[actionName], mainCanvas);
    return;
  }
  const cfg = ANIMATION_CONFIGS[actionName as LPCAction];
  if (!cfg) return;
  loadSheet(sheetUrl, (img) => {
    const isMulti = cfg.num === 4;
    const { buttons, canvases } = getDirElements();
    buttons.forEach((b, i) => {
      b.disabled = !isMulti;
      if (!isMulti) clearCanvas(canvases[i]);
    });
    const cycle = cfg.cycle;
    const FPS = 8;
    let frame = 0; let lastT = 0;
    const loop = (now: number): void => {
      if (playingAction !== actionName) return;
      if (now - lastT > 1000 / FPS) {
        const col = cycle[frame];
        const mainRow = cfg.row + (isMulti ? selectedDir : 0);
        drawFrame(img, mainCanvas, mainRow, col, FRAME_SIZE);
        if (isMulti) {
          for (let d = 0 as DirIndex; d < 4; d = (d + 1) as DirIndex) {
            drawFrame(img, canvases[d], cfg.row + d, col, FRAME_SIZE);
          }
        }
        frame = (frame + 1) % cycle.length;
        lastT = now;
      }
      playRafId = requestAnimationFrame(loop);
    };
    playRafId = requestAnimationFrame(loop);
  });
}

/** ZIP 캐릭터의 액션별 PNG 에서 재생. 메인 + 4방향 동시.
 *  LPC standard/<anim>.png 는 항상 SHEET_WIDTH(832) × (num*FRAME_SIZE) 로 추출 —
 *  표준 액션이면 ANIMATION_CONFIGS 의 cycle 을 그대로 써서 빈 frame 건너뜀. */
function playFromAnimFile(actionName: string, url: string, mainCanvas: HTMLCanvasElement): void {
  loadSheet(url, (img) => {
    const cfg = ANIMATION_CONFIGS[actionName as LPCAction];
    const numRows = cfg?.num ?? 4;
    const frameSize = Math.round(img.naturalHeight / numRows);
    const totalCols = Math.max(1, Math.round(img.naturalWidth / frameSize));
    const isMulti = numRows === 4;
    const { buttons, canvases } = getDirElements();
    buttons.forEach((b, i) => {
      b.disabled = !isMulti;
      if (!isMulti) clearCanvas(canvases[i]);
    });
    const cycle: number[] = cfg ? cfg.cycle.slice() : (() => {
      const a: number[] = []; for (let i = 0; i < totalCols; i++) a.push(i); return a;
    })();
    const FPS = 8;
    let frame = 0; let lastT = 0;
    const loop = (now: number): void => {
      if (playingAction !== actionName) return;
      if (now - lastT > 1000 / FPS) {
        const col = cycle[frame];
        const mainRow = isMulti ? selectedDir : 0;
        drawFrame(img, mainCanvas, mainRow, col, frameSize);
        if (isMulti) {
          for (let d = 0 as DirIndex; d < 4; d = (d + 1) as DirIndex) {
            drawFrame(img, canvases[d], d, col, frameSize);
          }
        }
        frame = (frame + 1) % cycle.length;
        lastT = now;
      }
      playRafId = requestAnimationFrame(loop);
    };
    playRafId = requestAnimationFrame(loop);
  });
}

async function handleFiles(files: FileList | File[]): Promise<void> {
  // 사용자가 업로드 도중 탭을 옮겨도 시작 시점의 카테고리로 일관되게 처리한다.
  const startCat = activeCat;
  const arr = Array.from(files);
  for (const f of arr) {
    const ext = f.name.split('.').pop()?.toLowerCase() ?? '';
    if (!EXT_BY_CAT[startCat].includes(ext)) {
      showToast(`${f.name} — extension .${ext} not allowed in this tab`, 'err', 3000);
      continue;
    }
    if (startCat === 'characters') {
      if (isLpcZipFile(f)) {
        await uploadCharacterZipWithModal(f);
      } else {
        await uploadCharacterWithModal(f);
      }
    } else if (startCat === 'bgm') {
      await uploadAudioWithModal(f);
    } else if (startCat === 'maps') {
      if (isMapZipFile(f)) {
        await uploadMapZipWithModal(f);
      } else {
        // 단일 .json — mapeditor 포맷이면 새 흐름, 아니면 legacy 단일 Tiled.
        const meParsed = await tryParseMapeditorJson(f);
        if (meParsed) await uploadMapeditorJsonWithModal(meParsed);
        else          await uploadOne(f, f.name, startCat);
      }
    } else {
      await uploadOne(f, f.name, startCat);
    }
  }
  refreshList();
}

/** Maps/Audio 또는 캐릭터(확정된 이름) 한 파일 업로드 + 진행률 표시.
 *  cat 은 호출 시점에 고정 — 업로드 중 사용자가 탭을 옮겨도 엉뚱한 카테고리로 가지 않도록. */
async function uploadOne(file: File, displayName: string, cat: Category, opts?: {
  characterActions?: LPCAction[];
  characterBaseName?: string;     // legacy PNG 의 base (확장자 없음)
  characterDisplayName?: string;
  characterBody?: BodyType;
  characterRace?: string;
}): Promise<void> {
  const progress = appendProgressRow(displayName);
  const run = async (): Promise<void> => {
    try {
      progress.setStage(displayName);
      await uploadAsset(token, cat, file, (l, t) => progress.setProgress(l, t));
      if (opts?.characterActions && opts.characterBaseName) {
        progress.setStage(`${displayName} — metadata`);
        const metaName = metaFilenameForLegacy(opts.characterBaseName);
        const metaBody = JSON.stringify({
          schema: 1,
          source: 'lpc',
          format: 'single' as const,
          body: opts.characterBody ?? 'none',
          name: opts.characterDisplayName ?? opts.characterBaseName,
          race: opts.characterRace || undefined,
          actions: opts.characterActions,
          detectedAt: new Date().toISOString(),
        }, null, 2);
        const metaFile = new File([metaBody], metaName, { type: 'application/json' });
        await uploadAsset(token, cat, metaFile);
      }
      progress.success();
      refreshList();
    } catch (e) {
      if (e instanceof AuthError) clearToken();
      const msg = e instanceof AuthError ? 'Auth expired — refresh' : (e as Error).message;
      progress.failure(`${displayName} — ${msg}`, run);
    }
  };
  await run();
}

/** 캐릭터 업로드 모달 흐름. detect → preview + name input → user confirms → uploadOne. */
/** LPC Split-by-Animation ZIP 업로드 — 풀어서 액션별 PNG 들과 메타를 함께 올림. */
async function uploadCharacterZipWithModal(zipFile: File): Promise<void> {
  const charsLoadedP = ensureCharactersLoaded();

  const modal = document.getElementById('char-upload-modal')!;
  const previewC = document.getElementById('cu-preview') as HTMLCanvasElement;
  const nameInput = document.getElementById('cu-name') as HTMLInputElement;
  const bodySel = document.getElementById('cu-body') as HTMLSelectElement;
  const raceInput = document.getElementById('cu-race') as HTMLInputElement;
  const actionsEl = document.getElementById('cu-actions')!;
  const warnEl = document.getElementById('cu-warn')!;
  const fnameEl = document.getElementById('cu-filename')!;
  const submitBtn = document.getElementById('cu-submit') as HTMLButtonElement;
  const cancelBtn = document.getElementById('cu-cancel') as HTMLButtonElement;

  const baseFromFile = zipFile.name.replace(/\.[^.]+$/, '');
  nameInput.value = baseFromFile;
  bodySel.value = 'male';
  raceInput.value = '';
  fnameEl.textContent = `${zipFile.name} (ZIP — Split by Animation)`;
  warnEl.classList.add('hidden');
  actionsEl.innerHTML = '<span class="lib-tag lib-tag-muted">parsing zip…</span>';

  modal.classList.remove('hidden');
  submitBtn.disabled = true;
  nameInput.focus();
  nameInput.select();

  // ZIP 파싱
  let parsed: ParsedLpcZip | null = null;
  try {
    parsed = await parseLpcZip(zipFile);
  } catch (e) {
    warnEl.textContent = `Invalid LPC ZIP: ${(e as Error).message}`;
    warnEl.classList.remove('hidden');
    actionsEl.innerHTML = '';
  }

  if (parsed) {
    // 썸네일 미리보기
    if (parsed.thumbnail) {
      const img = new Image();
      img.onload = () => {
        const ctx = previewC.getContext('2d');
        if (!ctx) return;
        ctx.imageSmoothingEnabled = false;
        ctx.clearRect(0, 0, previewC.width, previewC.height);
        ctx.drawImage(img, 0, 0, previewC.width, previewC.height);
      };
      img.src = URL.createObjectURL(parsed.thumbnail);
    }
    // 액션 태그 — standard + custom
    actionsEl.innerHTML = '';
    const allActions = [...parsed.standardAnims, ...parsed.customAnims];
    if (allActions.length === 0) {
      actionsEl.innerHTML = '<span class="lib-tag lib-tag-muted">no animations found</span>';
    } else {
      for (const a of allActions) {
        const tag = document.createElement('span');
        tag.className = 'lib-tag';
        tag.textContent = a;
        actionsEl.appendChild(tag);
      }
    }
  }

  const validate = (): void => {
    if (!parsed) { submitBtn.disabled = true; return; }
    const raw = nameInput.value.trim();
    if (!raw) {
      warnEl.textContent = 'Name is required.';
      warnEl.classList.remove('hidden');
      submitBtn.disabled = true; return;
    }
    if (isCharNameTaken(raw)) {
      warnEl.textContent = `A character named "${raw}" already exists.`;
      warnEl.classList.remove('hidden');
      submitBtn.disabled = true; return;
    }
    warnEl.classList.add('hidden');
    submitBtn.disabled = false;
  };
  nameInput.addEventListener('input', validate);
  validate();
  void charsLoadedP.then(() => {
    if (nameInput.value === baseFromFile && isCharNameTaken(baseFromFile)) {
      nameInput.value = suggestUniqueName(baseFromFile);
      nameInput.select();
    }
    validate();
  });

  await new Promise<void>((resolve) => {
    const cleanup = (): void => {
      modal.classList.add('hidden');
      submitBtn.onclick = null;
      cancelBtn.onclick = null;
      nameInput.onkeydown = null;
      nameInput.removeEventListener('input', validate);
      resolve();
    };
    const doUpload = async (): Promise<void> => {
      if (!parsed) return;
      const raw = nameInput.value.trim();
      if (!raw || isCharNameTaken(raw)) { validate(); return; }
      const cleaned = raw.replace(/[\/\\]/g, '_');
      cleanup();
      // 원본 ZIP 도 함께 보관 (다운로드용)
      await uploadZipCharacter(parsed, cleaned, raw, bodySel.value as BodyType, raceInput.value.trim(), zipFile);
    };
    submitBtn.onclick = () => { void doUpload(); };
    cancelBtn.onclick = cleanup;
    nameInput.onkeydown = (e) => {
      if (e.key === 'Enter' && !submitBtn.disabled) { e.preventDefault(); void doUpload(); }
      else if (e.key === 'Escape') { cleanup(); }
    };
  });
}

/** ZIP 캐릭터를 Blob 에 폴더 구조로 업로드. characters/<base>/{thumbnail.png, anims/*.png, meta.json, original.zip}. */
async function uploadZipCharacter(
  parsed: ParsedLpcZip, baseName: string, displayName: string,
  body: BodyType, race: string, originalZip: File,
): Promise<void> {
  const totalFiles = parsed.animFiles.size + (parsed.thumbnail ? 1 : 0) + 2; // anims + thumb + original.zip + meta
  const progress = appendProgressRow(displayName);

  const run = async (): Promise<void> => {
    progress.setStage(displayName);
    progress.setPercent(0);
    let done = 0;
    const tick = (): void => { done++; progress.setPercent(Math.round((done / totalFiles) * 100)); };

    // 재시도 시 이미 올라간 파일은 listing 의 URL 만 재사용 — 동일 파일 재업로드를 피함.
    const existingByPath = new Map<string, string>();
    try {
      const prefix = zipFolderPrefix(baseName);
      const all = await listAssets(token, 'characters');
      for (const b of all) {
        if (b.pathname.startsWith(prefix)) existingByPath.set(b.pathname, b.url);
      }
    } catch { /* 무시 — 빈 맵으로 진행 (첫 업로드 시점에는 비어있음) */ }

    const animUrls: Record<string, string> = {};
    let originalZipUrl: string | undefined;

    try {
      // 1) 썸네일
      if (parsed.thumbnail) {
        progress.setStage(`${displayName} — thumbnail`);
        if (!existingByPath.has(thumbnailPathFor(baseName))) {
          const thumbFile = new File([parsed.thumbnail], thumbnailFilenameFor(baseName), { type: 'image/png' });
          await uploadAsset(token, 'characters', thumbFile);
        }
        tick();
      }
      // 2) 각 액션 PNG
      for (const [anim, file] of parsed.animFiles) {
        progress.setStage(`${displayName} — ${anim}`);
        const path = animPathFor(baseName, anim);
        const existingUrl = existingByPath.get(path);
        if (existingUrl) {
          animUrls[anim] = existingUrl;
        } else {
          const out = new File([file], animFilenameFor(baseName, anim), { type: 'image/png' });
          const blob = await uploadAsset(token, 'characters', out);
          animUrls[anim] = blob.url;
        }
        tick();
      }
      // 3) 원본 ZIP
      progress.setStage(`${displayName} — original.zip`);
      const origPath = originalZipPathFor(baseName);
      const existingOrig = existingByPath.get(origPath);
      if (existingOrig) {
        originalZipUrl = existingOrig;
      } else {
        const origFile = new File([originalZip], originalZipFilenameFor(baseName), { type: 'application/zip' });
        const origBlob = await uploadAsset(token, 'characters', origFile);
        originalZipUrl = origBlob.url;
      }
      tick();
      // 4) meta.json (마지막에 — anims URL 다 모은 다음)
      progress.setStage(`${displayName} — metadata`);
      const meta = {
        schema: 1,
        source: 'lpc-zip',
        format: 'zip' as const,
        name: displayName,
        body,
        race: race || undefined,
        actions: parsed.standardAnims.filter((a) => Object.prototype.hasOwnProperty.call(ANIMATION_CONFIGS, a)) as LPCAction[],
        anims: animUrls,
        customAnims: parsed.customAnims,
        originalZipUrl,
        character: parsed.character ?? null,
        detectedAt: new Date().toISOString(),
      };
      const metaFile = new File(
        [JSON.stringify(meta, null, 2)],
        metaFilenameForZip(baseName),
        { type: 'application/json' },
      );
      await uploadAsset(token, 'characters', metaFile);
      tick();
      progress.success(`${displayName} — done (${parsed.animFiles.size} animations)`);
      refreshList();
    } catch (e) {
      if (e instanceof AuthError) clearToken();
      const msg = e instanceof AuthError ? 'Auth expired — refresh' : (e as Error).message;
      progress.failure(`${displayName} — ${msg}`, run);
    }
  };

  await run();
}

async function uploadCharacterWithModal(file: File): Promise<void> {
  // 캐릭터 목록 백그라운드로 최신화 (모달은 즉시 열림 — 로드 끝나면 이름 검증/제안 갱신)
  const charsLoadedP = ensureCharactersLoaded();

  const modal = document.getElementById('char-upload-modal')!;
  const previewC = document.getElementById('cu-preview') as HTMLCanvasElement;
  const nameInput = document.getElementById('cu-name') as HTMLInputElement;
  const bodySel = document.getElementById('cu-body') as HTMLSelectElement;
  const raceInput = document.getElementById('cu-race') as HTMLInputElement;
  const actionsEl = document.getElementById('cu-actions')!;
  const warnEl = document.getElementById('cu-warn')!;
  const fnameEl = document.getElementById('cu-filename')!;
  const submitBtn = document.getElementById('cu-submit') as HTMLButtonElement;
  const cancelBtn = document.getElementById('cu-cancel') as HTMLButtonElement;

  // 기본값
  const baseFromFile = file.name.replace(/\.[^.]+$/, '');
  nameInput.value = baseFromFile;
  bodySel.value = 'male';
  raceInput.value = '';
  fnameEl.textContent = file.name;
  warnEl.classList.add('hidden');
  actionsEl.innerHTML = '<span class="lib-tag lib-tag-muted">analyzing…</span>';
  const previewUrl = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => drawCharacterThumb(previewC, img);
  img.src = previewUrl;

  modal.classList.remove('hidden');
  submitBtn.disabled = true;
  nameInput.focus();
  nameInput.select();

  // 액션 검출 (백그라운드)
  let actions: LPCAction[] = [];
  let isStandardSheet = false;
  try {
    const det = await detectActionsFromFile(file);
    if (!det.standard) {
      warnEl.textContent = `Not a valid LPC sheet (got ${det.width}×${det.height}). Expected at least 832×3456, multiple of 64.`;
      warnEl.classList.remove('hidden');
      actionsEl.innerHTML = '';
    } else {
      isStandardSheet = true;
      actions = det.actions;
      actionsEl.innerHTML = '';
      for (const a of actions) {
        const tag = document.createElement('span');
        tag.className = 'lib-tag';
        tag.textContent = ANIMATION_CONFIGS[a]?.label ?? a;
        actionsEl.appendChild(tag);
      }
      if (actions.length === 0) {
        actionsEl.innerHTML = '<span class="lib-tag lib-tag-muted">no actions detected</span>';
      }
    }
  } catch (e) {
    warnEl.textContent = (e as Error).message;
    warnEl.classList.remove('hidden');
  }

  // 통합 검증 — 시트 표준 + 이름 비어있지 않음 + 이름 중복 없음
  const validate = (): void => {
    const raw = nameInput.value.trim();
    if (!isStandardSheet) { submitBtn.disabled = true; return; }
    if (!raw) {
      warnEl.textContent = 'Name is required.';
      warnEl.classList.remove('hidden');
      submitBtn.disabled = true;
      return;
    }
    if (isCharNameTaken(raw)) {
      warnEl.textContent = `A character named "${raw}" already exists.`;
      warnEl.classList.remove('hidden');
      submitBtn.disabled = true;
      return;
    }
    warnEl.classList.add('hidden');
    submitBtn.disabled = false;
  };
  nameInput.addEventListener('input', validate);
  validate();

  // 백그라운드 로드가 끝나면, 기본 이름이 충돌이면 자동으로 안 겹치는 이름 제안
  void charsLoadedP.then(() => {
    if (nameInput.value === baseFromFile && isCharNameTaken(baseFromFile)) {
      nameInput.value = suggestUniqueName(baseFromFile);
      nameInput.select();
    }
    validate();
  });

  // 사용자 응답 대기
  await new Promise<void>((resolve) => {
    const cleanup = (): void => {
      URL.revokeObjectURL(previewUrl);
      modal.classList.add('hidden');
      submitBtn.onclick = null;
      cancelBtn.onclick = null;
      nameInput.onkeydown = null;
      nameInput.removeEventListener('input', validate);
      resolve();
    };
    const doUpload = async (): Promise<void> => {
      const raw = nameInput.value.trim();
      if (!raw || isCharNameTaken(raw)) { validate(); return; }
      const cleaned = raw.replace(/[\/\\]/g, '_').replace(/\.png$/i, '');
      const newFile = new File([file], `${cleaned}.png`, { type: file.type });
      cleanup();
      await uploadOne(newFile, `${cleaned}.png`, 'characters', {
        characterActions: actions,
        characterBaseName: cleaned,
        characterDisplayName: raw,
        characterBody: bodySel.value as BodyType,
        characterRace: raceInput.value.trim(),
      });
    };
    submitBtn.onclick = () => { void doUpload(); };
    cancelBtn.onclick = cleanup;
    nameInput.onkeydown = (e) => {
      if (e.key === 'Enter' && !submitBtn.disabled) { e.preventDefault(); void doUpload(); }
      else if (e.key === 'Escape') { cleanup(); }
    };
  });
}

/** 맵 이름 중복 검사 — 라이브러리에 현재 같은 base name 인 맵이 있는지. */
function isMapNameTaken(name: string, exceptPath?: string): boolean {
  const norm = normalizeName(name);
  if (!norm) return false;
  for (const [pathname, meta] of mapMetaByPath.entries()) {
    if (pathname === exceptPath) continue;
    const fallback = isZipMapEntryPath(pathname) ? mapBaseName(pathname) : shortName(pathname).replace(/\.[^.]+$/, '');
    const n = normalizeName(meta.name || fallback);
    if (n === norm) return true;
  }
  return false;
}

function suggestUniqueMapName(base: string): string {
  if (!isMapNameTaken(base)) return base;
  const m = base.match(/^(.*?)\s*(\d+)$/);
  const stem = m ? m[1].trim() : base;
  let n = m ? parseInt(m[2], 10) + 1 : 2;
  while (n < 10000) {
    const candidate = `${stem} ${n}`;
    if (!isMapNameTaken(candidate)) return candidate;
    n++;
  }
  return `${base} ${Date.now()}`;
}

async function ensureMapsLoaded(): Promise<void> {
  try {
    const all = await listAssets(token, 'maps');
    const entryPaths = new Set(all.filter((it) => isMapEntryPath(it.pathname)).map((it) => it.pathname));
    const sidecars = all.filter((it) => it.pathname.endsWith('.meta.json') || it.pathname.endsWith('/meta.json'));
    mapMetaByPath.clear();
    await Promise.all(sidecars.map(async (s) => {
      try {
        const r = await fetch(s.url, { cache: 'reload' });
        if (!r.ok) return;
        const j = await r.json() as MapMeta;
        const entryPath = mapEntryPathForSidecar(s.pathname);
        if (!entryPaths.has(entryPath)) return;
        mapMetaByPath.set(entryPath, j);
      } catch { /* 무시 */ }
    }));
  } catch { /* 무시 */ }
}

/** Tiled 맵 ZIP 업로드 모달 — 이름 + 안 파일 목록 + 통계 표시 후 업로드. */
async function uploadMapZipWithModal(zipFile: File): Promise<void> {
  const mapsLoadedP = ensureMapsLoaded();

  const modal = document.getElementById('map-upload-modal')!;
  const nameInput = document.getElementById('mu-name') as HTMLInputElement;
  const fnameEl = document.getElementById('mu-filename')!;
  const statsEl = document.getElementById('mu-stats')!;
  const filesEl = document.getElementById('mu-files')!;
  const warnEl = document.getElementById('mu-warn')!;
  const submitBtn = document.getElementById('mu-submit') as HTMLButtonElement;
  const cancelBtn = document.getElementById('mu-cancel') as HTMLButtonElement;

  const baseFromFile = zipFile.name.replace(/\.[^.]+$/, '');
  nameInput.value = baseFromFile;
  fnameEl.textContent = `${zipFile.name} · ${fmtSize(zipFile.size)}`;
  warnEl.classList.add('hidden');
  statsEl.innerHTML = '<div class="stat-key">parsing…</div><div class="stat-val">—</div>';
  filesEl.innerHTML = '';

  modal.classList.remove('hidden');
  submitBtn.disabled = true;
  nameInput.focus();
  nameInput.select();

  // ZIP 파싱
  let parsed: ParsedMapZip | null = null;
  try {
    parsed = await parseMapZip(zipFile);
  } catch (e) {
    warnEl.textContent = (e as Error).message;
    warnEl.classList.remove('hidden');
    statsEl.innerHTML = '';
  }

  if (parsed) {
    // 통계
    statsEl.innerHTML = '';
    const rows: Array<[string, string]> = [];
    if (parsed.mapInfo.width && parsed.mapInfo.height) rows.push(['size (tiles)', `${parsed.mapInfo.width} × ${parsed.mapInfo.height}`]);
    if (parsed.mapInfo.tilewidth && parsed.mapInfo.tileheight) rows.push(['tile', `${parsed.mapInfo.tilewidth} × ${parsed.mapInfo.tileheight}`]);
    if (parsed.mapInfo.layers != null) rows.push(['layers', String(parsed.mapInfo.layers)]);
    if (parsed.mapInfo.tilesets?.length) rows.push(['tilesets', parsed.mapInfo.tilesets.join(', ')]);
    for (const [k, v] of rows) {
      const a = document.createElement('div'); a.className = 'stat-key'; a.textContent = k;
      const b = document.createElement('div'); b.className = 'stat-val'; b.textContent = v;
      statsEl.appendChild(a); statsEl.appendChild(b);
    }
    // 파일 목록
    filesEl.innerHTML = '';
    const allFiles = [{ name: parsed.mapFilename, isMain: true }, ...parsed.sideFiles.map((f) => ({ name: f.name, isMain: false }))];
    for (const e of allFiles) {
      const tag = document.createElement('span');
      tag.className = 'lib-tag';
      tag.textContent = e.isMain ? `${e.name} (map)` : e.name;
      filesEl.appendChild(tag);
    }
  }

  const validate = (): void => {
    if (!parsed) { submitBtn.disabled = true; return; }
    const raw = nameInput.value.trim();
    if (!raw) {
      warnEl.textContent = 'Name is required.';
      warnEl.classList.remove('hidden');
      submitBtn.disabled = true; return;
    }
    if (isMapNameTaken(raw)) {
      warnEl.textContent = `A map named "${raw}" already exists.`;
      warnEl.classList.remove('hidden');
      submitBtn.disabled = true; return;
    }
    warnEl.classList.add('hidden');
    submitBtn.disabled = false;
  };
  nameInput.addEventListener('input', validate);
  validate();

  void mapsLoadedP.then(() => {
    if (nameInput.value === baseFromFile && isMapNameTaken(baseFromFile)) {
      nameInput.value = suggestUniqueMapName(baseFromFile);
      nameInput.select();
    }
    validate();
  });

  await new Promise<void>((resolve) => {
    const cleanup = (): void => {
      modal.classList.add('hidden');
      submitBtn.onclick = null;
      cancelBtn.onclick = null;
      nameInput.onkeydown = null;
      nameInput.removeEventListener('input', validate);
      resolve();
    };
    const doUpload = async (): Promise<void> => {
      if (!parsed) return;
      const raw = nameInput.value.trim();
      if (!raw || isMapNameTaken(raw)) { validate(); return; }
      // 폴더명(=불변 ID) 은 사용자 입력과 무관하게 자동 생성. 사용자 입력은 meta.name 으로만.
      const assetId = generateAssetId(raw, 'map');
      cleanup();
      await uploadZipMap(parsed, assetId, raw, zipFile);
    };
    submitBtn.onclick = () => { void doUpload(); };
    cancelBtn.onclick = cleanup;
    nameInput.onkeydown = (e) => {
      if (e.key === 'Enter' && !submitBtn.disabled) { e.preventDefault(); void doUpload(); }
      else if (e.key === 'Escape') { cleanup(); }
    };
  });
}

/** 맵 ZIP 의 메인+사이드+원본 ZIP+meta 를 maps/<base>/ 폴더로 풀어 업로드. */
// baseName 매개변수는 자산의 ID 역할 (폴더명). 첫 업로드 시 generateAssetId() 결과.
async function uploadZipMap(
  parsed: ParsedMapZip, assetId: string, displayName: string, originalZip: File,
): Promise<void> {
  const baseName = assetId;  // 코드 안에서는 이미 baseName 으로 쓰던 변수 — alias 유지
  const totalFiles = 1 + parsed.sideFiles.length + 2; // main + sides + original.zip + meta
  const progress = appendProgressRow(displayName);

  const run = async (): Promise<void> => {
    progress.setStage(displayName);
    progress.setPercent(0);
    let done = 0;
    const tick = (): void => { done++; progress.setPercent(Math.round((done / totalFiles) * 100)); };

    // 재시도 시 이미 올라간 파일은 listing 의 URL 만 재사용.
    const existingByPath = new Map<string, string>();
    try {
      const prefix = mapFolderPrefix(baseName);
      const all = await listAssets(token, 'maps');
      for (const b of all) {
        if (b.pathname.startsWith(prefix)) existingByPath.set(b.pathname, b.url);
      }
    } catch { /* 무시 */ }

    try {
      // 1) 메인 맵 → main.json 으로 정규화
      progress.setStage(`${displayName} — ${parsed.mapFilename}`);
      const mainFile = new File([parsed.mapFile], mapMainFilenameFor(baseName), { type: 'application/json' });
      await uploadAsset(token, 'maps', mainFile);
      tick();
      // 2) 사이드 파일들 (tileset .tsj/.tsx + 이미지)
      for (const side of parsed.sideFiles) {
        progress.setStage(`${displayName} — ${side.name}`);
        const out = new File([side], mapSideFilenameFor(baseName, side.name), { type: side.type });
        await uploadAsset(token, 'maps', out);
        tick();
      }
      // 3) 원본 ZIP
      progress.setStage(`${displayName} — original.zip`);
      const origFile = new File([originalZip], mapOriginalZipFilenameFor(baseName), { type: 'application/zip' });
      const origBlob = await uploadAsset(token, 'maps', origFile);
      const originalZipUrl = origBlob.url;
      tick();
      // 4) meta.json
      progress.setStage(`${displayName} — metadata`);
      const meta: MapMeta = {
        id: assetId,
        name: displayName,
        version: 1,
        versionHistory: [],
        savedAt: new Date().toISOString(),
        format: 'zip',
        originalMapFilename: originalZip.name,
        originalZipUrl,
        info: parsed.mapInfo,
      };
      const metaFile = new File(
        [JSON.stringify({ schema: 1, ...meta, savedAt: new Date().toISOString() }, null, 2)],
        mapMetaFilenameFor(baseName),
        { type: 'application/json' },
      );
      await uploadAsset(token, 'maps', metaFile);
      tick();
      progress.success(`${displayName} — done (${parsed.sideFiles.length + 1} files)`);
      refreshList();
    } catch (e) {
      if (e instanceof AuthError) clearToken();
      const msg = e instanceof AuthError ? 'Auth expired — refresh' : (e as Error).message;
      progress.failure(`${displayName} — ${msg}`, run);
    }
  };

  await run();
}

// ── helloworld-mapeditor 단일 JSON 맵 업로드 ──────────────────────────────
//
// ZIP 의 modal/스타일을 재사용:
//   - 같은 #map-upload-modal 컴포넌트
//   - 같은 maps/<name>/ 폴더 구조 + meta.json + _history/
//   - 다른 점: side files / original.zip 없음, info 가 MapeditorInfo, format='mapeditor'

async function uploadMapeditorJsonWithModal(parsed: ParsedMapeditorJson): Promise<void> {
  const mapsLoadedP = ensureMapsLoaded();

  const modal = document.getElementById('map-upload-modal')!;
  const nameInput = document.getElementById('mu-name') as HTMLInputElement;
  const fnameEl = document.getElementById('mu-filename')!;
  const statsEl = document.getElementById('mu-stats')!;
  const filesEl = document.getElementById('mu-files')!;
  const warnEl = document.getElementById('mu-warn')!;
  const submitBtn = document.getElementById('mu-submit') as HTMLButtonElement;
  const cancelBtn = document.getElementById('mu-cancel') as HTMLButtonElement;

  const baseFromFile = parsed.originalFilename.replace(/\.[^.]+$/, '');
  nameInput.value = baseFromFile;
  fnameEl.textContent = `${parsed.originalFilename} · ${fmtSize(parsed.jsonFile.size)} · mapeditor`;
  warnEl.classList.add('hidden');

  // 통계 — mapeditor 전용
  statsEl.innerHTML = '';
  const b = parsed.info.bounds;
  const rows: Array<[string, string]> = [
    ['schema', `v${parsed.info.schemaVersion}`],
    ['bounds (m)', `${b.w.toFixed(1)} × ${b.h.toFixed(1)} @ (${b.x}, ${b.y})`],
    ['objects', String(parsed.info.objectCount)],
  ];
  for (const [t, n] of Object.entries(parsed.info.objectCountByType)) {
    rows.push([`  · ${t}`, String(n)]);
  }
  for (const [k, v] of rows) {
    const a = document.createElement('div'); a.className = 'stat-key'; a.textContent = k;
    const c = document.createElement('div'); c.className = 'stat-val'; c.textContent = v;
    statsEl.appendChild(a); statsEl.appendChild(c);
  }

  // 파일 목록 — 단일 main.json 만.
  filesEl.innerHTML = '';
  const tag = document.createElement('span');
  tag.className = 'lib-tag';
  tag.textContent = `${parsed.originalFilename} (map)`;
  filesEl.appendChild(tag);

  modal.classList.remove('hidden');
  submitBtn.disabled = true;
  nameInput.focus();
  nameInput.select();

  const validate = (): void => {
    const raw = nameInput.value.trim();
    if (!raw) {
      warnEl.textContent = 'Name is required.';
      warnEl.classList.remove('hidden');
      submitBtn.disabled = true; return;
    }
    if (isMapNameTaken(raw)) {
      warnEl.textContent = `A map named "${raw}" already exists.`;
      warnEl.classList.remove('hidden');
      submitBtn.disabled = true; return;
    }
    warnEl.classList.add('hidden');
    submitBtn.disabled = false;
  };
  nameInput.addEventListener('input', validate);
  validate();

  void mapsLoadedP.then(() => {
    if (nameInput.value === baseFromFile && isMapNameTaken(baseFromFile)) {
      nameInput.value = suggestUniqueMapName(baseFromFile);
      nameInput.select();
    }
    validate();
  });

  await new Promise<void>((resolve) => {
    const cleanup = (): void => {
      modal.classList.add('hidden');
      submitBtn.onclick = null;
      cancelBtn.onclick = null;
      nameInput.onkeydown = null;
      nameInput.removeEventListener('input', validate);
      resolve();
    };
    const doUpload = async (): Promise<void> => {
      const raw = nameInput.value.trim();
      if (!raw || isMapNameTaken(raw)) { validate(); return; }
      const assetId = generateAssetId(raw, 'map');
      cleanup();
      await uploadMapeditorJson(parsed, assetId, raw);
    };
    submitBtn.onclick = (): void => { void doUpload(); };
    cancelBtn.onclick = (): void => cleanup();
    nameInput.onkeydown = (e): void => {
      if (e.key === 'Enter' && !submitBtn.disabled) { e.preventDefault(); void doUpload(); }
      else if (e.key === 'Escape') { e.preventDefault(); cleanup(); }
    };
  });
}

async function uploadMapeditorJson(
  parsed: ParsedMapeditorJson, assetId: string, displayName: string,
): Promise<void> {
  const baseName = assetId;
  const totalFiles = 2;          // main.json + meta.json
  const progress = appendProgressRow(displayName);

  const run = async (): Promise<void> => {
    progress.setStage(displayName);
    progress.setPercent(0);
    let done = 0;
    const tick = (): void => { done++; progress.setPercent(Math.round((done / totalFiles) * 100)); };
    try {
      // 1) main.json (= 사용자가 올린 JSON 그대로)
      progress.setStage(`${displayName} — main.json`);
      const mainFile = new File([parsed.jsonFile], mapMainFilenameFor(baseName), { type: 'application/json' });
      await uploadAsset(token, 'maps', mainFile);
      tick();
      // 2) meta.json
      progress.setStage(`${displayName} — metadata`);
      const meta: MapMeta = {
        id: assetId,
        name: displayName,
        version: 1,
        versionHistory: [],
        savedAt: new Date().toISOString(),
        format: 'mapeditor',
        originalMapFilename: parsed.originalFilename,
        info: parsed.info,
      };
      const metaFile = new File(
        [JSON.stringify({ schema: 1, ...meta }, null, 2)],
        mapMetaFilenameFor(baseName),
        { type: 'application/json' },
      );
      await uploadAsset(token, 'maps', metaFile);
      tick();
      progress.success(`${displayName} — done (mapeditor)`);
      refreshList();
    } catch (e) {
      if (e instanceof AuthError) clearToken();
      const msg = e instanceof AuthError ? 'Auth expired — refresh' : (e as Error).message;
      progress.failure(`${displayName} — ${msg}`, run);
    }
  };
  await run();
}

/** 기존 mapeditor 맵에 새 JSON 업로드 — 옛 main.json 을 _history/<ISO>.json 으로 백업 후 덮어쓰기.
 *  Tiled ZIP 의 uploadMapNewVersion 과 같은 패턴이지만 단일 파일이라 단순. */
async function uploadMapeditorNewVersion(
  currentEntry: BlobItem, baseName: string, newJson: File,
): Promise<void> {
  const progress = appendProgressRow(`${baseName} — new version`);

  const run = async (): Promise<void> => {
    progress.setStage(`${baseName} — parsing JSON`);
    progress.setPercent(0);
    const parsed = await tryParseMapeditorJson(newJson);
    if (!parsed) {
      progress.failure(`${baseName} — 새 파일이 mapeditor 포맷이 아닙니다 (schemaVersion=1 + objects 필요).`, run);
      return;
    }
    const meta = mapMetaByPath.get(currentEntry.pathname);
    if (meta?.format !== 'mapeditor') {
      progress.failure(`${baseName} — 기존 맵이 mapeditor 포맷이 아닙니다. 같은 이름으로 새 업로드 후 옛 자산 삭제 권장.`, run);
      return;
    }
    const totalFiles = 3; // backup + main + meta
    let done = 0;
    const tick = (): void => { done++; progress.setPercent(Math.round((done / totalFiles) * 100)); };

    try {
      // 1) 기존 main.json 을 _history/<ISO>.json 으로 백업.
      const backupIsoTs = new Date().toISOString();
      progress.setStage(`${baseName} — backing up current version`);
      const r = await fetch(currentEntry.url, { cache: 'reload' });
      if (!r.ok) throw new Error(`current main.json fetch failed: ${r.status}`);
      const buf = await r.arrayBuffer();
      const histFile = new File([buf], mapHistoryJsonFilenameFor(baseName, backupIsoTs), { type: 'application/json' });
      await uploadAsset(token, 'maps', histFile);
      tick();
      // 2) 새 main.json 덮어쓰기.
      progress.setStage(`${baseName} — main.json`);
      const mainFile = new File([newJson], mapMainFilenameFor(baseName), { type: 'application/json' });
      await uploadAsset(token, 'maps', mainFile);
      tick();
      // 3) meta.json 갱신 — version + 1, versionHistory append.
      progress.setStage(`${baseName} — metadata`);
      const baselineVersion = meta.version ?? 1;
      const newVersion = baselineVersion + 1;
      const prevHistory = meta.versionHistory ?? [];
      const newHistory = [...prevHistory, {
        version: baselineVersion,
        savedAt: backupIsoTs,
        originalMapFilename: meta.originalMapFilename ?? '(unknown)',
      }];
      const newMeta: MapMeta = {
        ...meta,
        version: newVersion,
        versionHistory: newHistory,
        savedAt: new Date().toISOString(),
        format: 'mapeditor',
        originalMapFilename: parsed.originalFilename,
        info: parsed.info,
      };
      const metaFile = new File(
        [JSON.stringify({ schema: 1, ...newMeta }, null, 2)],
        mapMetaFilenameFor(baseName),
        { type: 'application/json' },
      );
      await uploadAsset(token, 'maps', metaFile);
      tick();
      progress.success(`${baseName} — v${newVersion} (mapeditor)`);
      refreshList();
    } catch (e) {
      if (e instanceof AuthError) clearToken();
      const msg = e instanceof AuthError ? 'Auth expired — refresh' : (e as Error).message;
      progress.failure(`${baseName} — ${msg}`, run);
    }
  };
  await run();
}

/** Audio 업로드 모달 — 미리듣기 + 이름/카테고리/loop/memo 입력 후 업로드. */
async function uploadAudioWithModal(file: File): Promise<void> {
  const audioLoadedP = ensureAudioLoaded();

  const modal = document.getElementById('audio-upload-modal')!;
  const player = document.getElementById('au-player') as HTMLAudioElement;
  const fnameEl = document.getElementById('au-filename')!;
  const nameInput = document.getElementById('au-name') as HTMLInputElement;
  const catSel = document.getElementById('au-category') as HTMLSelectElement;
  const loopIn = document.getElementById('au-loop') as HTMLInputElement;
  const memoIn = document.getElementById('au-memo') as HTMLTextAreaElement;
  const warnEl = document.getElementById('au-warn')!;
  const submitBtn = document.getElementById('au-submit') as HTMLButtonElement;
  const cancelBtn = document.getElementById('au-cancel') as HTMLButtonElement;

  const baseFromFile = file.name.replace(/\.[^.]+$/, '');
  nameInput.value = baseFromFile;
  catSel.value = /\.(wav|aiff?|aifc)$/i.test(file.name) ? 'effect' : 'bgm';
  loopIn.checked = true;
  memoIn.value = '';
  fnameEl.textContent = `${file.name} · ${fmtSize(file.size)}`;
  warnEl.classList.add('hidden');

  const previewUrl = URL.createObjectURL(file);
  player.src = previewUrl;
  player.load();

  modal.classList.remove('hidden');
  submitBtn.disabled = false;
  nameInput.focus();
  nameInput.select();

  const validate = (): void => {
    const raw = nameInput.value.trim();
    if (!raw) {
      warnEl.textContent = 'Name is required.';
      warnEl.classList.remove('hidden');
      submitBtn.disabled = true; return;
    }
    if (isAudioNameTaken(raw)) {
      warnEl.textContent = `An audio named "${raw}" already exists.`;
      warnEl.classList.remove('hidden');
      submitBtn.disabled = true; return;
    }
    warnEl.classList.add('hidden');
    submitBtn.disabled = false;
  };
  nameInput.addEventListener('input', validate);
  validate();

  void audioLoadedP.then(() => {
    if (nameInput.value === baseFromFile && isAudioNameTaken(baseFromFile)) {
      nameInput.value = suggestUniqueAudioName(baseFromFile);
      nameInput.select();
    }
    validate();
  });

  await new Promise<void>((resolve) => {
    const cleanup = (): void => {
      try { player.pause(); } catch { /* noop */ }
      player.removeAttribute('src');
      player.load();
      URL.revokeObjectURL(previewUrl);
      modal.classList.add('hidden');
      submitBtn.onclick = null;
      cancelBtn.onclick = null;
      nameInput.onkeydown = null;
      nameInput.removeEventListener('input', validate);
      resolve();
    };
    const doUpload = async (): Promise<void> => {
      const raw = nameInput.value.trim();
      if (!raw || isAudioNameTaken(raw)) { validate(); return; }
      const ext = (file.name.split('.').pop() ?? 'mp3').toLowerCase();
      const cleaned = raw.replace(/[\/\\]/g, '_');
      const cat = catSel.value as AudioCategory;
      const loop = loopIn.checked;
      const memo = memoIn.value.trim() || undefined;
      const renamed = new File([file], `${cleaned}.${ext}`, { type: file.type });
      cleanup();
      await uploadAudioFile(renamed, cleaned, raw, cat, loop, memo);
    };
    submitBtn.onclick = () => { void doUpload(); };
    cancelBtn.onclick = cleanup;
    nameInput.onkeydown = (e) => {
      if (e.key === 'Enter' && !submitBtn.disabled) { e.preventDefault(); void doUpload(); }
      else if (e.key === 'Escape') { cleanup(); }
    };
  });
}

/** Audio 파일 + .meta.json 업로드 (진행률 표시 포함). */
async function uploadAudioFile(
  file: File, baseName: string, displayName: string,
  category: AudioCategory, loop: boolean, memo: string | undefined,
): Promise<void> {
  const progress = appendProgressRow(file.name);
  const run = async (): Promise<void> => {
    try {
      progress.setStage(file.name);
      await uploadAsset(token, 'bgm', file, (l, t) => progress.setProgress(l, t));
      progress.setStage(`${file.name} — metadata`);
      const meta = {
        schema: 1,
        name: displayName,
        volume: 0.7,
        loop,
        category,
        memo,
        savedAt: new Date().toISOString(),
      };
      const metaFile = new File([JSON.stringify(meta, null, 2)], `${baseName}.meta.json`, { type: 'application/json' });
      await uploadAsset(token, 'bgm', metaFile);
      progress.success();
      refreshList();
    } catch (e) {
      if (e instanceof AuthError) clearToken();
      const msg = e instanceof AuthError ? 'Auth expired — refresh' : (e as Error).message;
      progress.failure(`${file.name} — ${msg}`, run);
    }
  };
  await run();
}

function ready(fn: () => void): void {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
  else fn();
}

ready(async () => {
  // 비번 받기
  token = await ensureAuth();
  // 카테고리별 메타 스키마 로드 (있으면)
  await loadAllSchemas(token);

  // 탭 — Settings 는 별도. asset 탭 클릭 시 inSettings 해제.
  const applyTabHighlight = (): void => {
    document.querySelectorAll('.lib-tab').forEach((b) => {
      const t = (b as HTMLElement).dataset.cat;
      const active = inSettings ? t === 'settings' : t === activeCat;
      b.classList.toggle('lib-tab-active', active);
    });
  };
  document.querySelectorAll<HTMLButtonElement>('.lib-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.cat;
      if (target === 'settings') {
        inSettings = true;
        persistTab('settings');
      } else {
        inSettings = false;
        activeCat = target as Category;
        persistTab(activeCat);
      }
      applyTabHighlight();
      refreshList();
    });
  });
  // 새로고침 후 복원된 탭의 highlight 도 즉시 반영
  applyTabHighlight();

  // 파일 선택
  const fileIn = document.getElementById('file-input') as HTMLInputElement;
  document.getElementById('btn-pick')!.addEventListener('click', () => {
    fileIn.accept = EXT_BY_CAT[activeCat].map((e) => '.' + e).join(',');
    fileIn.click();
  });
  fileIn.addEventListener('change', () => {
    if (fileIn.files) handleFiles(fileIn.files);
    fileIn.value = '';
  });

  // 드래그&드롭
  const zone = document.getElementById('upload-zone')!;
  ['dragenter', 'dragover'].forEach((ev) => {
    zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('drag'); });
  });
  ['dragleave', 'drop'].forEach((ev) => {
    zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove('drag'); });
  });
  zone.addEventListener('drop', (e) => {
    const dt = (e as DragEvent).dataTransfer;
    if (dt?.files) handleFiles(dt.files);
  });

  // 재로그인
  document.getElementById('btn-logout')!.addEventListener('click', () => {
    clearToken();
    location.reload();
  });

  // 초기 목록
  refreshList();
});

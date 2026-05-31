// 미디어 빈 — 왼쪽 패널.
// builtin: public/ 안의 자원을 하드코딩된 목록으로 채움. upload: 파일 입력 → blob URL.

import { state, notify, uid, activeScene } from './state';
import type { Asset, AssetKind } from './state';
import { CHARACTER_COUNT, characterName, drawCharacterPreview } from './lib/sprites';
import { isCharacterEntryPath, charBaseName, metaUrlForEntry, generateAssetId } from './library/paths';
import { uploadAsset } from './library/api';
import { parseCharZip, revokeParsed } from './char-import/tiled';
import { openCharImportEditor } from './char-import/editor';
import { showToast } from './util';
import { currentMap } from './stage';

const BUILTIN_MAPS: Array<{ name: string; url: string }> = [
  { name: 'zombie_road',  url: '/maps/zombie_road.json' },
  { name: 'undead_road',  url: '/maps/undead_road.json' },
  { name: 'cops_lobby',   url: '/maps/cops_lobby/cops_lobby.json' },
  { name: 'lost_temple',  url: '/maps/lost_temple/lost_temple.json' },
];
const BUILTIN_BGM: Array<{ name: string; url: string }> = [
  { name: 'track1', url: '/audio/bgm/track1.mp3' },
  { name: 'track2', url: '/audio/bgm/track2.mp3' },
  { name: 'track3', url: '/audio/bgm/track3.mp3' },
  { name: 'track4', url: '/audio/bgm/track4.mp3' },
];

export function loadBuiltinAssets(): void {
  if (state.assets.length > 0) return;
  for (const m of BUILTIN_MAPS) {
    state.assets.push({ kind: 'map', id: uid('a'), source: 'builtin', name: m.name, url: m.url });
  }
  for (let i = 0; i < CHARACTER_COUNT; i++) {
    state.assets.push({
      kind: 'char', id: uid('a'), source: 'builtin',
      name: characterName(i), charIdx: i,
    });
  }
  for (const b of BUILTIN_BGM) {
    state.assets.push({ kind: 'bgm', id: uid('a'), source: 'builtin', name: b.name, url: b.url });
  }
  notify();
}

// 라이브러리(Vercel Blob)에서 업로드된 자산을 추가로 로드.
// 토큰 없거나 백엔드 미구성이면 조용히 스킵 — builtin 만으로도 정상 동작.
export async function loadLibraryAssets(): Promise<void> {
  let token: string | null;
  try { token = localStorage.getItem('studio:library:token'); }
  catch { token = null; }
  if (!token) return;
  try {
    const r = await fetch('/api/list?category=all', {
      headers: { 'x-studio-token': token },
    });
    if (!r.ok) return;
    const j = (await r.json()) as { blobs: Array<{ pathname: string; url: string }> };
    let mapCount = 0, bgmCount = 0, charCount = 0;
    for (const b of j.blobs) {
      const ext = b.pathname.split('.').pop()?.toLowerCase() ?? '';
      const baseName = b.pathname.split('/').slice(1).join('/').replace(/\.[^.]+$/, '');
      if (['json', 'tmj'].includes(ext) && b.pathname.startsWith('maps/')) {
        state.assets.push({ kind: 'map', id: uid('a'), source: 'upload', name: baseName, url: b.url });
        mapCount++;
      } else if (['mp3', 'ogg', 'wav', 'm4a'].includes(ext) && b.pathname.startsWith('bgm/')) {
        state.assets.push({ kind: 'bgm', id: uid('a'), source: 'upload', name: baseName, url: b.url });
        bgmCount++;
      } else if (isCharacterEntryPath(b.pathname) && b.pathname.split('/').length === 2 && ext === 'png') {
        // single-PNG 캐릭터(characters/Foo.png) — bake 된 LPC 시트. (zip 폴더형은 추후)
        let name = charBaseName(b.pathname);
        try {
          const mr = await fetch(metaUrlForEntry(b.url, b.pathname), { cache: 'no-store' });
          if (mr.ok) { const meta = await mr.json() as { name?: string }; if (meta.name) name = meta.name; }
        } catch { /* 메타 없으면 base 이름 사용 */ }
        // 중복 가드: 오토세이브 복원(resolveCharAsset)이 같은 URL 로 먼저 만든 자산이 있으면
        // 새로 push 하지 말고 표시 이름만 meta 기준으로 보정한다 (슬러그→실제 이름).
        const existing = state.assets.find((a) => a.kind === 'char' && a.customUrl === b.url);
        if (existing) { existing.name = name; continue; }
        state.assets.push({ kind: 'char', id: uid('a'), source: 'upload', name, charIdx: -1, customUrl: b.url });
        charCount++;
      }
      // .tsj/.png(보조)·meta.json 등은 빈에 노출 X — map JSON 이 내부적으로 fetch.
    }
    if (mapCount + bgmCount + charCount > 0) {
      showToast(`Library loaded — ${mapCount} maps, ${charCount} chars, ${bgmCount} audio`);
    }
    notify();
  } catch (e) {
    console.warn('[library] 로드 실패', e);
  }
}

export function initBinUI(): void {
  const tabs = document.querySelectorAll<HTMLButtonElement>('.st-tab');
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const k = tab.dataset.tab as 'maps' | 'chars' | 'bgm';
      state.rt.binTab = k;
      notify();
    });
  });

  const uploadBtn = document.getElementById('btn-upload') as HTMLButtonElement;
  const fileIn = document.getElementById('bin-upload-input') as HTMLInputElement;

  uploadBtn.addEventListener('click', () => {
    const tab = state.rt.binTab;
    fileIn.accept = tab === 'maps' ? 'application/json,.json,.tmj'
      : tab === 'chars' ? 'image/png,.png,application/zip,.zip'
      : 'audio/mpeg,audio/*,.mp3,.ogg,.wav';
    fileIn.click();
  });

  fileIn.addEventListener('change', () => {
    const files = fileIn.files;
    if (!files) return;
    for (const f of Array.from(files)) {
      addUploaded(state.rt.binTab, f);
    }
    fileIn.value = '';
  });
}

function addUploaded(tab: 'maps' | 'chars' | 'bgm', file: File): void {
  if (tab === 'chars') { void handleCharUpload(file); return; }
  const url = URL.createObjectURL(file);
  const name = file.name.replace(/\.[^.]+$/, '');
  if (tab === 'maps') {
    state.assets.push({ kind: 'map', id: uid('a'), source: 'upload', name, url });
  } else {
    state.assets.push({ kind: 'bgm', id: uid('a'), source: 'upload', name, url });
  }
  notify();
}

// 캐릭터 업로드 라우팅:
//   .zip  → 비-LPC 임포트(매핑 에디터 → LPC bake → Blob 업로드)
//   .png  → 832×3456 표준 LPC 시트면 바로 Blob 업로드, 아니면 안내
async function handleCharUpload(file: File): Promise<void> {
  const lower = file.name.toLowerCase();
  if (lower.endsWith('.zip')) { await importNonLpcCharacter(file); return; }
  if (lower.endsWith('.png')) {
    if (await pngIsStandardLpc(file)) {
      await uploadCharacter(file, file.name.replace(/\.[^.]+$/, ''));
    } else {
      showToast('단일 PNG는 832×3456 LPC 시트만 지원해요. 비-LPC 동물은 PNG+JSON 을 zip 으로 올려주세요.', 'err', 4500);
    }
    return;
  }
  showToast('지원 형식: .zip(PNG+Tiled JSON) 또는 832×3456 LPC .png', 'err', 3500);
}

function pngIsStandardLpc(file: File): Promise<boolean> {
  return new Promise((resolve) => {
    const u = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { const ok = img.naturalWidth === 832 && img.naturalHeight === 3456; URL.revokeObjectURL(u); resolve(ok); };
    img.onerror = () => { URL.revokeObjectURL(u); resolve(false); };
    img.src = u;
  });
}

// 비-LPC zip → 매핑 에디터 → bake → 업로드.
async function importNonLpcCharacter(file: File): Promise<void> {
  let parsed;
  try { parsed = await parseCharZip(file); }
  catch (e) { showToast(`zip 파싱 실패: ${(e as Error).message}`, 'err', 4500); return; }
  if (parsed.isLpcStandard) {
    // 이미 표준 LPC 시트 한 장 → 에디터 없이 바로 업로드
    await uploadCharacter(parsed.sheets[0].pngFile, parsed.sheets[0].name);
    revokeParsed(parsed);
    return;
  }
  openCharImportEditor(parsed, (result) => {
    void (async () => {
      if (result) await uploadCharacter(result.blob, result.name, result.actions);
      revokeParsed(parsed);
    })();
  });
}

// baked LPC PNG + meta 를 라이브러리(Blob)에 업로드하고 빈에 즉시 추가.
async function uploadCharacter(png: Blob, displayName: string, actions: string[] = ['idle', 'walk', 'run']): Promise<void> {
  let token: string | null;
  try { token = localStorage.getItem('studio:library:token'); } catch { token = null; }
  if (!token) {
    showToast('라이브러리에 연결돼 있지 않아요 — 📚 라이브러리에서 먼저 로그인하세요', 'err', 4500);
    return;
  }
  const base = generateAssetId(displayName, 'char');   // slug-안전 + 랜덤 hex → 이름 충돌 방지
  showToast('캐릭터 업로드 중…');
  try {
    // meta 를 먼저 올린다 — PNG 업로드가 실패해도 "고아 meta"는 빈에 안 뜨므로(엔트리는 .png 기준)
    // 해가 없다. 반대 순서면 PNG 만 남아 다음 부팅 때 슬러그 이름으로 잘못 표시됨.
    const meta = {
      schema: 1, source: 'custom-bake', format: 'single',
      body: 'none', name: displayName, actions,
      detectedAt: new Date().toISOString(),
    };
    await uploadAsset(token, 'characters', new File([JSON.stringify(meta, null, 2)], `${base}.meta.json`, { type: 'application/json' }));
    const res = await uploadAsset(token, 'characters', new File([png], `${base}.png`, { type: 'image/png' }));
    state.assets.push({ kind: 'char', id: uid('a'), source: 'upload', name: displayName, charIdx: -1, customUrl: res.url });
    notify();
    showToast(`캐릭터 추가됨 — ${displayName}`);
  } catch (e) {
    showToast(`업로드 실패: ${(e as Error).message}`, 'err', 4500);
  }
}

// 빈 리스트 다시 그리기 — main 의 구독에서 호출.
export function renderBin(): void {
  // 탭 활성 상태
  document.querySelectorAll<HTMLButtonElement>('.st-tab').forEach((tab) => {
    tab.classList.toggle('st-tab-active', tab.dataset.tab === state.rt.binTab);
  });

  const list = document.getElementById('bin-list')!;
  const kindByTab: Record<typeof state.rt.binTab, AssetKind> = { maps: 'map', chars: 'char', bgm: 'bgm' };
  const kind = kindByTab[state.rt.binTab];
  const items = state.assets.filter((a) => a.kind === kind);

  // 단순 diff 회피 — 통째로 다시 그림. 100개 미만이라 부담 없음.
  list.innerHTML = '';
  for (const asset of items) {
    list.appendChild(makeBinRow(asset));
  }
}

function makeBinRow(asset: Asset): HTMLElement {
  const row = document.createElement('div');
  row.className = 'st-bin-item';
  row.draggable = false;
  row.dataset.assetId = asset.id;

  const thumb = document.createElement('div');
  thumb.className = 'thumb';
  if (asset.kind === 'char') {
    const c = document.createElement('canvas');
    c.width = 32; c.height = 32;
    const cx = c.getContext('2d')!;
    void drawCharacterPreview(cx, asset.charIdx, 'down', asset.customUrl);
    thumb.appendChild(c);
  } else if (asset.kind === 'map') {
    thumb.textContent = 'MAP';
  } else {
    thumb.textContent = 'AUD';
  }
  row.appendChild(thumb);

  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = asset.name;
  if (asset.source === 'upload') {
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = ' · uploaded';
    name.appendChild(meta);
  }
  row.appendChild(name);

  const useBtn = document.createElement('button');
  useBtn.className = 'st-btn use';
  useBtn.textContent = 'Use';
  useBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    onUseAsset(asset);
  });
  row.appendChild(useBtn);

  return row;
}

// "사용" 클릭 시 동작 — 빈 → 활성 씬에 반영.
function onUseAsset(asset: Asset): void {
  const scene = activeScene();
  if (asset.kind === 'map') {
    scene.mapAssetId = asset.id;
    showToast(`Map · ${asset.name}`);
  } else if (asset.kind === 'bgm') {
    scene.bgm.assetId = asset.id;
    showToast(`Audio · ${asset.name}`);
  } else if (asset.kind === 'char') {
    // 캐릭터는 트랙으로 추가. 시작 위치는 맵 중앙 (없으면 화면 중앙으로 폴백).
    const map = currentMap();
    const sx = map ? Math.round(map.pixelW / 2) : 160;
    const sy = map ? Math.round(map.pixelH / 2) : 120;
    const newTrack = {
      id: uid('trk'),
      name: asset.name,
      charAssetId: asset.id,
      startX: sx, startY: sy,
      startDir: 'down' as const,
      keyframes: [],
      recorded: false,
    };
    scene.tracks.push(newTrack);
    // 새로 추가한 캐릭터를 바로 활성 트랙으로 → 카메라가 따라가서 보임
    state.rt.armedTrackId = newTrack.id;
    state.rt.selectedTrackId = newTrack.id;
    showToast(`Added · ${asset.name} — tap canvas to set start position`);
  }
  notify();
}

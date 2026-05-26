// 미디어 빈 — 왼쪽 패널.
// builtin: public/ 안의 자원을 하드코딩된 목록으로 채움. upload: 파일 입력 → blob URL.

import { state, notify, uid, activeScene } from './state';
import type { Asset, AssetKind } from './state';
import { CHARACTER_COUNT, drawCharacterPreview } from './lib/sprites';
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
      name: `LPC ${String(i).padStart(2, '0')}`, charIdx: i,
    });
  }
  for (const b of BUILTIN_BGM) {
    state.assets.push({ kind: 'bgm', id: uid('a'), source: 'builtin', name: b.name, url: b.url });
  }
  notify();
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
      : tab === 'chars' ? 'image/png,.png'
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
  const url = URL.createObjectURL(file);
  const name = file.name.replace(/\.[^.]+$/, '');
  if (tab === 'maps') {
    state.assets.push({ kind: 'map', id: uid('a'), source: 'upload', name, url });
  } else if (tab === 'chars') {
    // 업로드 캐릭터는 charIdx=-1 + customUrl 로 저장. 추후 sprite 모듈에서 별도 처리 필요.
    // 현 MVP 에선 미지원 — 안내만.
    showToast('캐릭터 업로드는 곧 지원됩니다 (지금은 미리 들어있는 LPC 9종만 가능)', 'err', 2500);
    URL.revokeObjectURL(url);
    return;
  } else {
    state.assets.push({ kind: 'bgm', id: uid('a'), source: 'upload', name, url });
  }
  notify();
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
    void drawCharacterPreview(cx, asset.charIdx);
    thumb.appendChild(c);
  } else if (asset.kind === 'map') {
    thumb.textContent = '🗺';
  } else {
    thumb.textContent = '🎵';
  }
  row.appendChild(thumb);

  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = asset.name;
  if (asset.source === 'upload') {
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = ' (업로드)';
    name.appendChild(meta);
  }
  row.appendChild(name);

  const useBtn = document.createElement('button');
  useBtn.className = 'st-btn use';
  useBtn.textContent = '사용';
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
    showToast(`맵 '${asset.name}' 적용`);
  } else if (asset.kind === 'bgm') {
    scene.bgm.assetId = asset.id;
    showToast(`BGM '${asset.name}' 적용`);
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
    showToast(`'${asset.name}' 추가 — 캔버스 탭으로 위치 조정`);
  }
  notify();
}

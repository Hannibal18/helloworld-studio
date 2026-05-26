// JSON export / import.
//
// Export 결과는 게임 측 `playCutscene()` 가 그대로 소비.
// upload 된 에셋(blob URL) 은 직렬화돼도 다른 머신에서 못 읽으므로 경고만 띄움.

import { state, notify, uid, findAsset } from './state';
import type {
  Bubble, CameraKey, CharTrack, CutsceneProject, Scene,
  TransitionType, Asset,
} from './state';
import { downloadJson, showToast } from './util';
import { CHARACTER_COUNT } from './lib/sprites';

export interface ExportedScene {
  id: string;
  name: string;
  duration: number;
  map: string | null;                        // url
  bgm: { url: string | null; volume: number; fadeIn: number; fadeOut: number; loop: boolean };
  transitionIn: { type: TransitionType; dur: number };
  camera: { keyframes: CameraKey[] };
  tracks: Array<{
    id: string;
    name: string;
    charIdx: number;                         // -1 = upload (미지원)
    startX: number; startY: number; startDir: CharTrack['startDir'];
    keyframes: CharTrack['keyframes'];
  }>;
  bubbles: Bubble[];
}
export interface ExportedCutscene {
  version: 1;
  projectName: string;
  scenes: ExportedScene[];
}

export function initExport(): void {
  const expBtn = document.getElementById('btn-export') as HTMLButtonElement;
  const impBtn = document.getElementById('btn-import') as HTMLButtonElement;
  const nameIn = document.getElementById('project-name') as HTMLInputElement;
  nameIn.addEventListener('input', () => {
    state.project.projectName = nameIn.value || '새 컷씬';
  });
  expBtn.addEventListener('click', () => exportToFile());
  impBtn.addEventListener('click', () => triggerImport());
}

function exportToFile(): void {
  const data = serialize(state.project);
  const hasUploadedMap = state.project.scenes.some((sc) => {
    const a = findAsset(sc.mapAssetId);
    return a && a.kind === 'map' && a.source === 'upload';
  });
  const hasUploadedBgm = state.project.scenes.some((sc) => {
    const a = findAsset(sc.bgm.assetId);
    return a && a.kind === 'bgm' && a.source === 'upload';
  });
  if (hasUploadedMap || hasUploadedBgm) {
    showToast('Uploaded asset URLs are referenced — the same files must be reachable at playback time', 'err', 3500);
  }
  const safe = (state.project.projectName || 'cutscene').replace(/[^a-zA-Z0-9_\-\.가-힣]/g, '_');
  downloadJson(`${safe}.json`, data);
  showToast('Exported');
}

export function serialize(project: CutsceneProject): ExportedCutscene {
  return {
    version: 1,
    projectName: project.projectName,
    scenes: project.scenes.map(serializeScene),
  };
}

function serializeScene(sc: Scene): ExportedScene {
  const mapAsset = findAsset(sc.mapAssetId);
  const bgmAsset = findAsset(sc.bgm.assetId);
  return {
    id: sc.id,
    name: sc.name,
    duration: sc.duration,
    map: mapAsset?.kind === 'map' ? mapAsset.url : null,
    bgm: {
      url: bgmAsset?.kind === 'bgm' ? bgmAsset.url : null,
      volume: sc.bgm.volume,
      fadeIn: sc.bgm.fadeIn,
      fadeOut: sc.bgm.fadeOut,
      loop: sc.bgm.loop,
    },
    transitionIn: { type: sc.transitionIn.type, dur: sc.transitionIn.dur },
    camera: { keyframes: sc.camera.keyframes.map((k) => ({ ...k })) },
    tracks: sc.tracks.map((trk) => {
      const a = findAsset(trk.charAssetId);
      const charIdx = (a && a.kind === 'char') ? a.charIdx : -1;
      return {
        id: trk.id,
        name: trk.name,
        charIdx,
        startX: trk.startX, startY: trk.startY, startDir: trk.startDir,
        keyframes: trk.keyframes.map((k) => ({ ...k })),
      };
    }),
    bubbles: sc.bubbles.map((b) => ({ ...b })),
  };
}

function triggerImport(): void {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'application/json,.json';
  inp.addEventListener('change', async () => {
    const f = inp.files?.[0];
    if (!f) return;
    try {
      const text = await f.text();
      const json = JSON.parse(text) as ExportedCutscene;
      importProject(json);
      showToast('Imported');
    } catch (e) {
      showToast(`Import 실패: ${(e as Error).message}`, 'err', 3000);
    }
  });
  inp.click();
}

export function importProject(json: ExportedCutscene): void {
  if (json.version !== 1) throw new Error(`지원 안 되는 버전: ${json.version}`);
  // 에셋 매칭/생성 — 빈에 동일 URL 이 있으면 재사용, 없으면 새 항목 추가.
  state.project.projectName = json.projectName || '새 컷씬';
  state.project.scenes = json.scenes.map((sc) => {
    const mapAssetId = sc.map ? resolveAsset('map', sc.map, sc.map) : null;
    const bgmAssetId = sc.bgm.url ? resolveAsset('bgm', sc.bgm.url, sc.bgm.url) : null;
    return {
      id: sc.id || uid('scn'),
      name: sc.name,
      duration: sc.duration,
      mapAssetId,
      bgm: {
        assetId: bgmAssetId,
        volume: sc.bgm.volume, fadeIn: sc.bgm.fadeIn, fadeOut: sc.bgm.fadeOut, loop: sc.bgm.loop,
      },
      transitionIn: { ...sc.transitionIn },
      camera: { keyframes: sc.camera.keyframes.map((k) => ({ ...k })) },
      tracks: sc.tracks.map((trk) => ({
        id: trk.id || uid('trk'),
        name: trk.name,
        charAssetId: resolveCharAsset(trk.charIdx),
        startX: trk.startX, startY: trk.startY, startDir: trk.startDir,
        keyframes: trk.keyframes.map((k) => ({ ...k })),
        recorded: trk.keyframes.length > 0,
      })),
      bubbles: sc.bubbles.map((b) => ({ ...b })),
    };
  });
  state.project.activeSceneIdx = 0;
  state.rt.sceneTime = 0;
  state.rt.armedTrackId = null;
  state.rt.selectedBubbleId = null;
  state.rt.selectedCamKey = null;
  state.rt.selectedTrackId = null;
  state.rt.playing = false;
  state.rt.recording = false;
  // 프로젝트 이름 input 동기화
  const nameIn = document.getElementById('project-name') as HTMLInputElement;
  if (nameIn) nameIn.value = state.project.projectName;
  notify();
}

function resolveAsset(kind: 'map' | 'bgm', url: string, name: string): string {
  const exist = state.assets.find((a) => (a.kind === kind) && (a as { url?: string }).url === url);
  if (exist) return exist.id;
  const id = uid('a');
  if (kind === 'map') {
    state.assets.push({ kind: 'map', id, source: 'builtin', name, url });
  } else {
    state.assets.push({ kind: 'bgm', id, source: 'builtin', name, url });
  }
  return id;
}
function resolveCharAsset(charIdx: number): string {
  const safe = ((charIdx % CHARACTER_COUNT) + CHARACTER_COUNT) % CHARACTER_COUNT;
  const exist = state.assets.find((a) => a.kind === 'char' && (a as { charIdx?: number }).charIdx === safe);
  if (exist) return exist.id;
  const id = uid('a');
  state.assets.push({ kind: 'char', id, source: 'builtin', name: `LPC ${String(safe).padStart(2, '0')}`, charIdx: safe });
  return id;
}

// Re-export Asset type for external consumers (game-side player needs it).
export type { Asset };

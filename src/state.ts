// 컷씬 스튜디오의 단일 상태 트리 + 변경 구독.
// 모든 UI 모듈이 같은 store 를 본다 → setState() 호출 시 listener 들이 다시 그린다.

import type { Dir } from './lib/types';

// ===== 데이터 모델 =====

export type AssetKind = 'map' | 'char' | 'bgm';
export type AssetSource = 'builtin' | 'upload';

export interface MapAsset {
  kind: 'map';
  id: string;
  source: AssetSource;
  name: string;
  /** builtin: '/maps/zombie_road.json' 같은 절대경로. upload: blob URL. */
  url: string;
}
export interface CharAsset {
  kind: 'char';
  id: string;
  source: AssetSource;
  name: string;
  /** builtin char 는 0~CHARACTER_COUNT-1 인덱스, upload 는 -1 + customUrl. */
  charIdx: number;
  customUrl?: string;
}
export interface BgmAsset {
  kind: 'bgm';
  id: string;
  source: AssetSource;
  name: string;
  url: string;
}
export type Asset = MapAsset | CharAsset | BgmAsset;

export interface CharKeyframe {
  t: number;       // 씬 내부 시간(sec)
  x: number;
  y: number;
  dir: Dir;
  walk: boolean;
}
export interface CharTrack {
  id: string;
  name: string;
  charAssetId: string;
  startX: number;
  startY: number;
  startDir: Dir;
  keyframes: CharKeyframe[];   // t 오름차순
  recorded: boolean;           // 한 번이라도 녹화됐는지
}

export interface CameraKey {
  t: number;
  x: number;
  y: number;
  zoom: number;
  ease: 'linear' | 'ease-in-out';
  followTrackId?: string;      // 있으면 x,y 무시하고 해당 캐릭터 따라감
}
export interface CameraTrack {
  keyframes: CameraKey[];
}

export interface Bubble {
  id: string;
  trackId: string;             // 어떤 캐릭터 머리 위
  t: number;
  dur: number;
  text: string;
  typewriter: boolean;
  cps: number;                 // characters per second
}

export interface BgmClip {
  assetId: string | null;
  volume: number;
  fadeIn: number;
  fadeOut: number;
  loop: boolean;
}

export type TransitionType = 'cut' | 'fade-black' | 'fade-white' | 'wipe';
export interface SceneTransition {
  type: TransitionType;
  dur: number;
}

export interface Scene {
  id: string;
  name: string;
  duration: number;            // sec
  mapAssetId: string | null;
  bgm: BgmClip;
  tracks: CharTrack[];
  camera: CameraTrack;
  bubbles: Bubble[];
  transitionIn: SceneTransition;
}

export interface CutsceneProject {
  version: 1;
  projectName: string;
  scenes: Scene[];
  activeSceneIdx: number;
}

// 선택 + 트랜스포트(런타임 — JSON 에 안 들어감).
export interface RuntimeState {
  /** 활성 캐릭터 트랙 (녹화 대상). null = 카메라가 꺼진 상태. */
  armedTrackId: string | null;
  selectedBubbleId: string | null;
  selectedCamKey: number | null; // keyframe index
  selectedTrackId: string | null;
  playing: boolean;
  recording: boolean;
  /** 녹화 시작 전 카운트다운(3→2→1). 진행 중엔 조이스틱 입력만 수집(미동작). */
  countingDown: boolean;
  countdownT: number;
  /** 씬 내부 시간(sec). 재생/녹화/스크럽 모두 이 값을 움직임. */
  sceneTime: number;
  /** 빈 카테고리 탭. */
  binTab: 'maps' | 'chars' | 'bgm';
  /** 타임라인 픽셀/초 비율. */
  pxPerSec: number;
}

export interface State {
  project: CutsceneProject;
  assets: Asset[];
  rt: RuntimeState;
}

// ===== 초기값 =====

let uidCounter = 0;
export function uid(prefix = 'id'): string {
  uidCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${uidCounter}`;
}

function makeScene(idx: number): Scene {
  return {
    id: uid('scn'),
    name: `Scene ${idx + 1}`,
    duration: 8,
    mapAssetId: null,
    bgm: { assetId: null, volume: 0.6, fadeIn: 1, fadeOut: 1, loop: true },
    tracks: [],
    camera: { keyframes: [] },
    bubbles: [],
    transitionIn: { type: idx === 0 ? 'cut' : 'fade-black', dur: idx === 0 ? 0 : 0.6 },
  };
}

function initialProject(): CutsceneProject {
  return {
    version: 1,
    projectName: '새 컷씬',
    scenes: [makeScene(0)],
    activeSceneIdx: 0,
  };
}

export const state: State = {
  project: initialProject(),
  assets: [],
  rt: {
    armedTrackId: null,
    selectedBubbleId: null,
    selectedCamKey: null,
    selectedTrackId: null,
    playing: false,
    recording: false,
    countingDown: false,
    countdownT: 0,
    sceneTime: 0,
    binTab: 'maps',
    pxPerSec: typeof window !== 'undefined' && window.matchMedia('(max-width: 900px)').matches ? 140 : 80,
  },
};

// ===== 변경 구독 =====
// 모든 UI 모듈이 subscribe → 변경 시 통째로 다시 그린다.

type Listener = () => void;
const listeners = new Set<Listener>();
export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
let notifyPending = false;
export function notify(): void {
  if (notifyPending) return;
  notifyPending = true;
  queueMicrotask(() => {
    notifyPending = false;
    for (const l of listeners) {
      try { l(); } catch (e) { console.error('[state listener]', e); }
    }
  });
}

// ===== Undo / Redo (프로젝트 스냅샷 ring) =====
// 녹화는 본질적으로 시행착오 — 덮어쓰기/Clear/삭제가 즉시 영구라 안전망이 필요하다.
// 개별 mutation 마다 역연산을 잡는 대신, 변경이 잦아든 시점(디바운스)에 project 전체를
// JSON 스냅샷으로 ring 에 적재한다. 같은 스냅샷이면 무시 → 연속 녹화/드래그가 1 step.

const HISTORY_LIMIT = 30;
const HISTORY_BYTE_BUDGET = 24 * 1024 * 1024;   // ~24MB — 녹화 다수로 스냅샷이 커질 때 모바일 메모리 보호.
let history: string[] = [];
let historyIdx = -1;
let suppressCapture = false;

/** 현재 project 를 히스토리에 적재 (직전과 동일하면 무시). main 의 구독에서 디바운스로 호출. */
export function captureHistory(): void {
  // 녹화 중엔 적재 안 함 — 멈춘 뒤 한 번만 잡혀 한 take 가 1 undo step 이 된다.
  if (suppressCapture || state.rt.recording) return;
  const snap = JSON.stringify(state.project);
  if (historyIdx >= 0 && history[historyIdx] === snap) return;
  if (historyIdx < history.length - 1) history = history.slice(0, historyIdx + 1);  // redo 가지 절단
  history.push(snap);
  // 개수 + 바이트 예산으로 오래된 항목 축출.
  let bytes = history.reduce((n, s) => n + s.length, 0);
  while (history.length > HISTORY_LIMIT || (history.length > 1 && bytes > HISTORY_BYTE_BUDGET)) {
    bytes -= (history.shift() as string).length;
  }
  historyIdx = history.length - 1;
}
export function canUndo(): boolean { return historyIdx > 0; }
export function canRedo(): boolean { return historyIdx < history.length - 1; }

function applySnapshot(snap: string): void {
  state.project = JSON.parse(snap) as CutsceneProject;
  if (state.project.activeSceneIdx >= state.project.scenes.length) {
    state.project.activeSceneIdx = Math.max(0, state.project.scenes.length - 1);
  }
  // 삭제됐을 수 있는 대상 참조 해제 + 트랜스포트 완전 정지(카운트다운 포함) + 재생 위치 리셋.
  state.rt.selectedBubbleId = null;
  state.rt.selectedCamKey = null;
  state.rt.selectedTrackId = null;
  state.rt.armedTrackId = null;
  state.rt.recording = false;
  state.rt.playing = false;
  state.rt.countingDown = false;   // 카운트다운 중 undo → 복원 상태에서 녹화 자동시작 방지
  state.rt.countdownT = 0;
  state.rt.sceneTime = 0;          // 줄어든 duration 너머에 playhead 가 남지 않게
  // 복원으로 인한 변경은 새 히스토리로 잡지 않는다.
  suppressCapture = true;
  notify();
  queueMicrotask(() => { suppressCapture = false; });
}
export function undo(): boolean {
  if (historyIdx <= 0) return false;
  historyIdx -= 1;
  applySnapshot(history[historyIdx]);
  return true;
}
export function redo(): boolean {
  if (historyIdx >= history.length - 1) return false;
  historyIdx += 1;
  applySnapshot(history[historyIdx]);
  return true;
}

// ===== 헬퍼 =====

export function activeScene(): Scene {
  return state.project.scenes[state.project.activeSceneIdx];
}
export function findAsset(id: string | null | undefined): Asset | null {
  if (!id) return null;
  return state.assets.find((a) => a.id === id) ?? null;
}
export function trackById(scene: Scene, id: string | null | undefined): CharTrack | null {
  if (!id) return null;
  return scene.tracks.find((t) => t.id === id) ?? null;
}

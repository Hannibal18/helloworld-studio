// 상단 씬 탭 — 활성 씬 전환 + 추가/삭제/복제 + 드래그 순서변경.

import { state, notify, uid } from './state';
import type { Scene } from './state';

let tabsEl!: HTMLElement;
// 드래그 순서변경 중인 씬 인덱스.
let dragSceneIdx: number | null = null;

export function initScenes(): void {
  tabsEl = document.getElementById('scene-tabs')!;
  const addBtn = document.getElementById('btn-add-scene') as HTMLButtonElement;
  addBtn.addEventListener('click', () => addScene());
}

function addScene(): void {
  const idx = state.project.scenes.length;
  state.project.scenes.push({
    id: uid('scn'),
    name: `Scene ${idx + 1}`,
    duration: 8,
    mapAssetId: null,
    bgm: { assetId: null, volume: 0.6, fadeIn: 1, fadeOut: 1, loop: true },
    tracks: [],
    camera: { keyframes: [] },
    bubbles: [],
    transitionIn: { type: 'fade-black', dur: 0.6 },
  });
  state.project.activeSceneIdx = idx;
  state.rt.sceneTime = 0;
  resetSelections();
  notify();
}

/** 씬 깊은 복제 — 트랙/말풍선/카메라의 내부 id 참조를 새 id 로 일관되게 재매핑. */
function cloneScene(sc: Scene): Scene {
  const trackIdMap = new Map<string, string>();
  const tracks = sc.tracks.map((t) => {
    const nid = uid('trk');
    trackIdMap.set(t.id, nid);
    return { ...t, id: nid, keyframes: t.keyframes.map((k) => ({ ...k })) };
  });
  const bubbles = sc.bubbles.map((b) => ({
    ...b,
    id: uid('bub'),
    trackId: trackIdMap.get(b.trackId) ?? b.trackId,
  }));
  const camera = {
    keyframes: sc.camera.keyframes.map((k) => ({
      ...k,
      followTrackId: k.followTrackId ? (trackIdMap.get(k.followTrackId) ?? k.followTrackId) : undefined,
    })),
  };
  return {
    id: uid('scn'),
    name: `${sc.name} copy`,
    duration: sc.duration,
    mapAssetId: sc.mapAssetId,
    bgm: { ...sc.bgm },
    tracks,
    camera,
    bubbles,
    transitionIn: { ...sc.transitionIn },
  };
}

function duplicateScene(i: number): void {
  state.project.scenes.splice(i + 1, 0, cloneScene(state.project.scenes[i]));
  state.project.activeSceneIdx = i + 1;
  state.rt.sceneTime = 0;
  resetSelections();
  notify();
}

/** from → to 로 씬 이동. 활성 씬은 id 로 추적해 이동 후에도 같은 씬이 선택된 채로. */
function reorderScene(from: number, to: number): void {
  const scenes = state.project.scenes;
  if (from === to || from < 0 || to < 0 || from >= scenes.length || to >= scenes.length) return;
  const activeId = scenes[state.project.activeSceneIdx]?.id;
  const [moved] = scenes.splice(from, 1);
  scenes.splice(to, 0, moved);
  const newActive = scenes.findIndex((s) => s.id === activeId);
  if (newActive >= 0) state.project.activeSceneIdx = newActive;
  notify();
}

function resetSelections(): void {
  state.rt.selectedBubbleId = null;
  state.rt.selectedCamKey = null;
  state.rt.selectedTrackId = null;
  state.rt.armedTrackId = null;
  state.rt.playing = false;
  state.rt.recording = false;
}

function miniBtn(cls: string, glyph: string, title: string, onClick: (e: MouseEvent) => void): HTMLElement {
  const el = document.createElement('span');
  el.className = cls;
  el.textContent = glyph;
  el.title = title;
  el.draggable = false;
  el.addEventListener('click', (e) => { e.stopPropagation(); onClick(e); });
  return el;
}

export function renderScenes(): void {
  tabsEl.innerHTML = '';
  state.project.scenes.forEach((sc, i) => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'st-scene-tab' + (i === state.project.activeSceneIdx ? ' active' : '');
    tab.addEventListener('click', () => {
      state.project.activeSceneIdx = i;
      state.rt.sceneTime = 0;
      resetSelections();
      notify();
    });

    // 드래그로 순서변경 (데스크톱). 활성 씬 추적은 reorderScene 이 처리.
    tab.draggable = true;
    tab.addEventListener('dragstart', (e) => {
      dragSceneIdx = i;
      tab.classList.add('dragging');
      if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); }
    });
    tab.addEventListener('dragend', () => { dragSceneIdx = null; tab.classList.remove('dragging'); });
    tab.addEventListener('dragover', (e) => {
      if (dragSceneIdx !== null && dragSceneIdx !== i) { e.preventDefault(); tab.classList.add('drop-target'); }
    });
    tab.addEventListener('dragleave', () => tab.classList.remove('drop-target'));
    tab.addEventListener('drop', (e) => {
      e.preventDefault();
      tab.classList.remove('drop-target');
      if (dragSceneIdx !== null && dragSceneIdx !== i) reorderScene(dragSceneIdx, i);
    });

    const name = document.createElement('span');
    name.className = 'st-scene-name';
    name.textContent = sc.name;
    name.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      const next = prompt('씬 이름', sc.name);
      if (next) { sc.name = next; notify(); }
    });
    tab.appendChild(name);

    // 복제
    tab.appendChild(miniBtn('dup', '⧉', '씬 복제', () => duplicateScene(i)));

    // 삭제 (씬이 2개 이상일 때만)
    if (state.project.scenes.length > 1) {
      tab.appendChild(miniBtn('x', '✕', '씬 삭제', () => {
        if (!confirm(`'${sc.name}' 을 삭제할까요?`)) return;
        state.project.scenes.splice(i, 1);
        state.project.activeSceneIdx = Math.min(state.project.activeSceneIdx, state.project.scenes.length - 1);
        state.rt.sceneTime = 0;
        resetSelections();
        notify();
      }));
    }
    tabsEl.appendChild(tab);
  });
}

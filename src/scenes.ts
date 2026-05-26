// 상단 씬 탭 — 활성 씬 전환 + 추가/삭제.

import { state, notify, uid } from './state';

let tabsEl!: HTMLElement;

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

function resetSelections(): void {
  state.rt.selectedBubbleId = null;
  state.rt.selectedCamKey = null;
  state.rt.selectedTrackId = null;
  state.rt.armedTrackId = null;
  state.rt.playing = false;
  state.rt.recording = false;
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
    const name = document.createElement('span');
    name.textContent = sc.name;
    name.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      const next = prompt('씬 이름', sc.name);
      if (next) { sc.name = next; notify(); }
    });
    tab.appendChild(name);
    if (state.project.scenes.length > 1) {
      const x = document.createElement('span');
      x.className = 'x';
      x.textContent = '✕';
      x.title = '씬 삭제';
      x.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!confirm(`'${sc.name}' 을 삭제할까요?`)) return;
        state.project.scenes.splice(i, 1);
        state.project.activeSceneIdx = Math.min(state.project.activeSceneIdx, state.project.scenes.length - 1);
        state.rt.sceneTime = 0;
        resetSelections();
        notify();
      });
      tab.appendChild(x);
    }
    tabsEl.appendChild(tab);
  });
}

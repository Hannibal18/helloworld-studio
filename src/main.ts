// 스튜디오 부트스트랩 — DOM 준비 → 모든 모듈 init → 상태 구독 → 매 프레임 BGM 동기화.

import {
  state, notify, activeScene, subscribe, uid,
  captureHistory, undo, redo, canUndo, canRedo,
} from './state';
import { loadBuiltinAssets, loadLibraryAssets, initBinUI, renderBin } from './bin';
import { initStage, screenToWorld, currentMap } from './stage';
import { initTimeline, renderTimeline } from './timeline';
import { initProps, renderProps } from './props';
import { initScenes, renderScenes } from './scenes';
import { initPlayback, togglePlay, toggleRecord, seek, setActiveStartPos } from './playback';
import { initExport, serialize, importProject } from './export';
import { syncBgm } from './audio';
import { initTouch } from './touch';
import { clamp, showToast } from './util';

const AUTOSAVE_KEY = 'studio:project:v1';

function ready(fn: () => void): void {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
  else fn();
}

ready(() => {
  // 글로벌 에러 표시 (모바일 등 콘솔 접근 어려운 환경 대비)
  window.addEventListener('error', (e) => {
    console.error('[studio]', e.error || e.message);
    showToast(`에러: ${e.message}`, 'err', 4000);
  });
  window.addEventListener('unhandledrejection', (e) => {
    console.error('[studio:unhandled]', e.reason);
    showToast(`비동기 에러: ${e.reason?.message ?? e.reason}`, 'err', 4000);
  });

  loadBuiltinAssets();
  // 라이브러리(Blob) 에셋도 비동기 로드 — 토큰 없거나 백엔드 미배포면 무시.
  void loadLibraryAssets();

  // localStorage 복원 — 빈 (builtin assets) 로드된 직후에 시도해야 자산 매칭됨.
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (raw) {
      const json = JSON.parse(raw);
      if (json && json.version === 1) {
        importProject(json);
        showToast('Restored from local storage');
      }
    }
  } catch (e) {
    console.warn('[studio:autosave] 복원 실패', e);
  }

  initBinUI();
  initStage();
  initScenes();
  initTimeline();
  initProps();
  initExport();
  initPlayback();
  initTouch();

  // ===== 트랜스포트 컨트롤 =====
  // iOS Safari 는 멀티터치 (조이스틱 + 버튼 동시) 시 click 이벤트를 묵살하므로
  // 트랜스포트 버튼들은 pointerdown 로 즉시 발사한다.
  const bindTap = (id: string, fn: () => void) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('pointerdown', (e) => { e.preventDefault(); fn(); });
  };
  bindTap('tp-play', () => togglePlay());
  bindTap('tp-rec',  () => toggleRecord());
  bindTap('tp-prev', () => seek(0));

  const scrub = document.getElementById('tp-scrub') as HTMLInputElement;
  scrub.addEventListener('input', () => {
    const dur = activeScene().duration;
    seek((parseInt(scrub.value, 10) / 1000) * dur);
  });

  // ===== 프리뷰 줌 슬라이더 (사용자 줌 — 키프레임과 별개) =====
  const zoomSl = document.getElementById('tp-zoom') as HTMLInputElement;
  const zoomVal = document.getElementById('tp-zoom-val')!;
  zoomSl.addEventListener('input', () => {
    const z = parseInt(zoomSl.value, 10) / 100;
    (state.rt as { previewZoom?: number }).previewZoom = z;
    zoomVal.textContent = z.toFixed(2) + 'x';
    notify();
  });

  // ===== 카메라 키프레임 추가 =====
  document.getElementById('tp-cam-key')!.addEventListener('click', () => {
    const sc = activeScene();
    const t = state.rt.sceneTime;
    const map = currentMap();
    const fx = map ? map.pixelW / 2 : 240;
    const fy = map ? map.pixelH / 2 : 135;
    // 기존 키 보간된 현재값을 시작점으로
    const existing = sc.camera.keyframes;
    let x = fx, y = fy, zoom = 1;
    if (existing.length > 0) {
      // sampleCamera 와 동일하지만, 보간 결과만 필요해서 마지막 < t 키 기준으로 단순화.
      for (let i = existing.length - 1; i >= 0; i--) {
        if (existing[i].t <= t) {
          x = existing[i].x; y = existing[i].y; zoom = existing[i].zoom;
          break;
        }
      }
    }
    sc.camera.keyframes.push({ t, x, y, zoom, ease: 'ease-in-out' });
    sc.camera.keyframes.sort((a, b) => a.t - b.t);
    state.rt.selectedCamKey = sc.camera.keyframes.findIndex((k) => k.t === t);
    showToast('Camera keyframe inserted');
    notify();
  });

  // ===== 캐릭터 추가 (기존 트랙 선택된 상태로 빈에서 사용 클릭하라 안내) =====
  document.getElementById('btn-add-char')!.addEventListener('click', () => {
    state.rt.binTab = 'chars';
    notify();
    showToast('Pick a character from the bin on the left');
  });

  // ===== 말풍선 추가 =====
  document.getElementById('btn-add-bubble')!.addEventListener('click', () => {
    const sc = activeScene();
    if (sc.tracks.length === 0) {
      showToast('Add a character first', 'err');
      return;
    }
    const trackId = state.rt.selectedTrackId && !state.rt.selectedTrackId.startsWith('__')
      ? state.rt.selectedTrackId
      : sc.tracks[0].id;
    const t = clamp(state.rt.sceneTime, 0, Math.max(0, sc.duration - 2));
    const bub = {
      id: uid('bub'),
      trackId,
      t, dur: 2,
      text: 'Hello',
      typewriter: true,
      cps: 20,
    };
    sc.bubbles.push(bub);
    state.rt.selectedBubbleId = bub.id;
    notify();
  });

  // ===== 캔버스 탭 (녹화 OFF + 트랙 armed) → 시작 위치 지정 =====
  const canvas = document.getElementById('stage-canvas') as HTMLCanvasElement;
  canvas.style.touchAction = 'none';
  canvas.addEventListener('pointerdown', (e) => {
    if (state.rt.recording) return;       // 녹화 중엔 비활성
    if (!state.rt.armedTrackId) return;
    if (e.target !== canvas) return;
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    const w = screenToWorld(sx, sy);
    setActiveStartPos(w.x, w.y);
  });

  // ===== 매 프레임: BGM 동기화 + 트랜스포트 HUD 갱신 =====
  const tpTime = document.getElementById('tp-time')!;
  const hudTime = document.getElementById('hud-time')!;
  const hudRec = document.getElementById('hud-record')!;
  const playBtn = document.getElementById('tp-play')!;
  const recBtn = document.getElementById('tp-rec')!;

  function tick(): void {
    const sc = activeScene();
    syncBgm(sc, state.rt.sceneTime, state.rt.playing);
    const t = state.rt.sceneTime, d = sc.duration;
    tpTime.textContent = `${t.toFixed(2)} / ${d.toFixed(2)}`;
    hudTime.textContent = `${t.toFixed(2)}s / ${d.toFixed(2)}s · ${sc.name}`;
    hudRec.classList.toggle('hidden', !state.rt.recording);
    playBtn.textContent = state.rt.playing ? '⏸' : '⏵';
    recBtn.classList.toggle('armed', state.rt.recording);
    // 스크럽 위치 (드래그 중이 아니면 sync)
    if (document.activeElement !== scrub) {
      scrub.value = String(Math.round((t / Math.max(0.001, d)) * 1000));
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  // ===== 자동 저장 + 저장 상태 표시 =====
  const saveStatusEl = document.getElementById('save-status');
  let lastStatus = '';
  let savedIdleTimer = 0;
  const setSaveStatus = (s: 'dirty' | 'saving' | 'saved' | 'failed'): void => {
    if (!saveStatusEl) return;
    if (s === lastStatus && s !== 'saved') return;   // 60Hz 녹화 중 중복 갱신 방지
    lastStatus = s;
    window.clearTimeout(savedIdleTimer);
    saveStatusEl.classList.remove('ok', 'err', 'idle');
    if (s === 'saved') {
      saveStatusEl.textContent = '✓ Saved';
      saveStatusEl.classList.add('ok');
      savedIdleTimer = window.setTimeout(() => saveStatusEl.classList.add('idle'), 1600);
    } else if (s === 'saving') {
      saveStatusEl.textContent = 'Saving…';
    } else if (s === 'failed') {
      saveStatusEl.textContent = '⚠ Save failed';
      saveStatusEl.classList.add('err');
    } else {
      saveStatusEl.textContent = 'Unsaved…';
    }
  };

  let saveTimer: number | null = null;
  const doSave = (): void => {
    try {
      localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(serialize(state.project)));
      setSaveStatus('saved');
    } catch (e) {
      // 흔한 원인은 localStorage 용량 초과 — 조용히 실패하면 데이터 유실로 이어진다.
      console.warn('[studio:autosave] 저장 실패', e);
      setSaveStatus('failed');
      showToast('자동 저장 실패 — 저장 공간이 가득 찼을 수 있어요 (Export 로 백업하세요)', 'err', 4500);
    }
  };
  const scheduleSave = (): void => {
    setSaveStatus('dirty');
    if (saveTimer !== null) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => { saveTimer = null; doSave(); }, 600);
  };
  // 탭 닫기/새로고침 직전 — 디바운스 대기 중인 변경을 즉시 flush.
  const flushSave = (): void => {
    if (saveTimer !== null) { window.clearTimeout(saveTimer); saveTimer = null; doSave(); }
  };
  window.addEventListener('beforeunload', flushSave);

  // ===== Undo / Redo =====
  const undoBtn = document.getElementById('btn-undo') as HTMLButtonElement | null;
  const redoBtn = document.getElementById('btn-redo') as HTMLButtonElement | null;
  const updateUndoButtons = (): void => {
    if (undoBtn) undoBtn.disabled = !canUndo();
    if (redoBtn) redoBtn.disabled = !canRedo();
  };
  // 변경이 잦아든 뒤에만 스냅샷 — 연속 녹화/드래그/타이핑이 1 step 으로 합쳐진다.
  let historyTimer = 0;
  const scheduleHistory = (): void => {
    window.clearTimeout(historyTimer);
    historyTimer = window.setTimeout(() => { captureHistory(); updateUndoButtons(); }, 500);
  };
  const doUndo = (): void => { if (undo()) { showToast('Undo'); updateUndoButtons(); } };
  const doRedo = (): void => { if (redo()) { showToast('Redo'); updateUndoButtons(); } };
  undoBtn?.addEventListener('click', doUndo);
  redoBtn?.addEventListener('click', doRedo);
  window.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement | null;
    const tag = t?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || t?.isContentEditable) return;  // 편집 중 텍스트는 건너뜀
    if (!(e.metaKey || e.ctrlKey)) return;
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); doUndo(); }
    else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); doRedo(); }
  });

  // ===== 상태 구독 → UI 갱신 =====
  let firstRender = true;
  subscribe(() => {
    renderScenes();
    renderBin();
    renderTimeline();
    renderProps();
    // 녹화 중에는 매 프레임 변경이 일어나므로 저장/히스토리 모두 디바운스가 필수
    scheduleSave();
    scheduleHistory();
    if (firstRender) {
      firstRender = false;
      // 첫 렌더 직후 — 안내 토스트 (복원 토스트가 이미 있으면 덮지 않게 살짝 늦춤)
      window.setTimeout(() => {
        if (state.assets.length > 0 && state.project.scenes.every((s) => s.tracks.length === 0 && !s.mapAssetId)) {
          showToast('Filmmaker ready — select Map, add Character, then Record');
        }
      }, 1500);
    }
  });
  // 초기 렌더 트리거 + 히스토리 baseline 적재
  notify();
  captureHistory();
  updateUndoButtons();
});

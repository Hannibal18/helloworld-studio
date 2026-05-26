// 재생/녹화 엔진.
//
// 한 개의 rAF 루프가 sceneTime 을 전진시킨다. 모드는 셋:
//  - idle    : 시간 멈춤. 스크럽/편집만.
//  - playing : sceneTime += dt. 씬 끝나면 다음 씬으로 또는 stop.
//  - recording (+playing 동시) : 위 + armedTrack 을 WASD 입력으로 움직이고, 매 ~33ms 키프레임 append.
//
// 녹화 시작 시 armedTrack 의 기존 keyframes 는 비우고, startX/Y/dir 도 현재 위치로 갱신한다.
// 동시에 다른 캐릭터 트랙은 그대로 보간 재생 → 합 맞춤.

import { state, notify, activeScene, trackById } from './state';
import type { Dir } from './lib/types';
import { isBlocked } from './lib/map';
import { currentMap, sampleTrack, sampleCamera } from './stage';
import { clamp, showToast } from './util';
import { inputVector, initKeyboard } from './input';

const SPEED = 120;            // px / sec (게임의 이동 속도와 비슷)
const CAM_SPEED = 200;        // 카메라 패닝 속도 (px/sec, 조이스틱 최대 입력 시)
const REC_SAMPLE_HZ = 60;     // 키프레임 샘플 레이트 (60 = 부드러움, JSON 2배)
const COUNTDOWN_SEC = 3;      // 녹화 시작 전 카운트다운

let lastNow = performance.now();
let lastSample = -1;          // sceneTime 기준 마지막 샘플 시각
let countdownStart = 0;       // performance.now() 기준
let lastArmedId: string | null = null;   // armed 트랙 바뀔 때 liveX/Y 재동기화

// 카메라 라이브 상태 — armed '__camera__' 일 때 조이스틱/줌 버튼이 갱신
export const CAMERA_ARMED_ID = '__camera__';
let liveCamX = 0;
let liveCamY = 0;
let liveCamZoom = 1;
export function getLiveCam(): { x: number; y: number; zoom: number } {
  return { x: liveCamX, y: liveCamY, zoom: liveCamZoom };
}
export function adjustLiveCamZoom(factor: number): void {
  liveCamZoom = clamp(liveCamZoom * factor, 0.2, 6);
  // stage 가 매 프레임 다시 그리므로 시각적으로 즉시 반영. notify() 호출 안 함 (UI 부담 회피).
}

// 녹화 중인 캐릭터의 라이브 상태 (sampleTrack 으로 못 얻으니 별도 유지)
let liveX = 0;
let liveY = 0;
let liveDir: Dir = 'down';
let liveWalk = false;

export function initPlayback(): void {
  initKeyboard();
  // 트랜스포트 핫키 (Space=재생, R=녹화) — input.ts 의 일반 키 캡처와 별도.
  window.addEventListener('keydown', (e) => {
    const tgt = e.target as HTMLElement | null;
    if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (e.code === 'KeyR') { e.preventDefault(); toggleRecord(); }
  });
  requestAnimationFrame(loop);
}

function loop(now: number): void {
  const dt = Math.min(0.1, (now - lastNow) / 1000);
  lastNow = now;

  // 카운트다운 진행 — 끝나면 자동으로 실제 녹화 시작.
  if (state.rt.countingDown) {
    const elapsed = (now - countdownStart) / 1000;
    state.rt.countdownT = Math.max(0, COUNTDOWN_SEC - elapsed);
    if (state.rt.countdownT <= 0) {
      state.rt.countingDown = false;
      doStartRecord();
      notify();   // 한 번만 — recording 상태 UI 동기화
    }
  }

  if (state.rt.playing || state.rt.recording) {
    advance(dt);
  } else if (state.rt.armedTrackId && !state.rt.countingDown) {
    // 자유 이동 모드 — 녹화 안 해도 조이스틱으로 활성 대상 조종.
    if (state.rt.armedTrackId === CAMERA_ARMED_ID) freeMoveCamera(dt);
    else                                            freeMove(dt);
  }
  requestAnimationFrame(loop);
}

function freeMove(dt: number): void {
  const scene = activeScene();
  const trk = trackById(scene, state.rt.armedTrackId);
  if (!trk) return;
  // 활성 트랙이 바뀌면 liveX/Y 를 그 트랙의 startX/Y 로 재동기화 (기존엔 옛 좌표 남아 있음).
  if (state.rt.armedTrackId !== lastArmedId) {
    lastArmedId = state.rt.armedTrackId;
    liveX = trk.startX; liveY = trk.startY; liveDir = trk.startDir; liveWalk = false;
  }
  const v = inputVector();
  const mag = Math.hypot(v.x, v.y);
  liveWalk = mag > 0.05;
  if (mag <= 0.05) return;
  const norm = mag > 1 ? mag : 1;
  const ux = v.x / norm, uy = v.y / norm;
  const speed = SPEED * Math.min(1, mag);
  const map = currentMap();
  const nx = liveX + ux * speed * dt;
  const ny = liveY + uy * speed * dt;
  if (!map || !isBlocked(map, nx, liveY, 8, 4)) liveX = nx;
  if (!map || !isBlocked(map, liveX, ny, 8, 4)) liveY = ny;
  if (Math.abs(v.x) > Math.abs(v.y)) liveDir = v.x > 0 ? 'right' : 'left';
  else                                liveDir = v.y > 0 ? 'down'  : 'up';
  // startX/Y 도 같이 갱신 — 다음 녹화의 시작점이 됨
  trk.startX = Math.round(liveX);
  trk.startY = Math.round(liveY);
  trk.startDir = liveDir;
  notify();
}

function freeMoveCamera(dt: number): void {
  const scene = activeScene();
  // 활성 대상이 막 카메라로 바뀌었으면 liveCam 을 현재 보간/맵 중앙 으로 초기화
  if (lastArmedId !== CAMERA_ARMED_ID) {
    lastArmedId = CAMERA_ARMED_ID;
    const ks = scene.camera.keyframes;
    if (ks.length > 0) {
      // 마지막 키프 위치/줌으로 시작
      const last = ks[ks.length - 1];
      liveCamX = last.x; liveCamY = last.y; liveCamZoom = last.zoom;
    } else {
      const map = currentMap();
      liveCamX = map ? map.pixelW / 2 : 240;
      liveCamY = map ? map.pixelH / 2 : 135;
      liveCamZoom = 1;
    }
  }
  const v = inputVector();
  const mag = Math.hypot(v.x, v.y);
  if (mag <= 0.05) return;
  const norm = mag > 1 ? mag : 1;
  const speed = CAM_SPEED * Math.min(1, mag);
  const z = Math.max(0.3, liveCamZoom);
  liveCamX += (v.x / norm) * (speed / z) * dt;
  liveCamY += (v.y / norm) * (speed / z) * dt;
  notify();
}

function advance(dt: number): void {
  const scene = activeScene();
  const isCamArmed = state.rt.armedTrackId === CAMERA_ARMED_ID;

  // 1) 활성 대상 입력 처리 (녹화 중일 때만)
  if (state.rt.recording && state.rt.armedTrackId) {
    if (isCamArmed) {
      // 카메라 패닝 — 조이스틱은 카메라 픽셀 속도
      const v = inputVector();
      const mag = Math.hypot(v.x, v.y);
      if (mag > 0.05) {
        const norm = mag > 1 ? mag : 1;
        const speed = CAM_SPEED * Math.min(1, mag);
        // 카메라 줌에 반비례 → 줌인 상태에선 천천히 패닝 (체감 일관성)
        const z = Math.max(0.3, liveCamZoom);
        liveCamX += (v.x / norm) * (speed / z) * dt;
        liveCamY += (v.y / norm) * (speed / z) * dt;
      }
    } else {
      // 캐릭터 이동
      const trk = trackById(scene, state.rt.armedTrackId);
      if (trk) {
        const v = inputVector();
        const dx = v.x, dy = v.y;
        const mag = Math.hypot(dx, dy);
        liveWalk = mag > 0.05;
        if (mag > 0.05) {
          const norm = mag > 1 ? mag : 1;
          const ux = dx / norm, uy = dy / norm;
          const speed = SPEED * Math.min(1, mag);
          const nx = liveX + ux * speed * dt;
          const ny = liveY + uy * speed * dt;
          const map = currentMap();
          const blocked = !!map && isBlocked(map, nx, ny, 8, 4);
          if (!blocked) {
            if (!map || !isBlocked(map, nx, liveY, 8, 4)) liveX = nx;
            if (!map || !isBlocked(map, liveX, ny, 8, 4)) liveY = ny;
          }
          if (Math.abs(dx) > Math.abs(dy)) liveDir = dx > 0 ? 'right' : 'left';
          else                              liveDir = dy > 0 ? 'down'  : 'up';
        }
      }
    }
  }

  // 2) 시간 전진
  state.rt.sceneTime += dt;

  // 3) 녹화 중이면 ~30Hz 로 키프레임 append
  if (state.rt.recording && state.rt.armedTrackId) {
    const t = state.rt.sceneTime;
    if (lastSample < 0 || t - lastSample > 1 / REC_SAMPLE_HZ) {
      if (isCamArmed) {
        scene.camera.keyframes.push({ t, x: liveCamX, y: liveCamY, zoom: liveCamZoom, ease: 'linear' });
      } else {
        const trk = trackById(scene, state.rt.armedTrackId);
        if (trk) {
          trk.keyframes.push({ t, x: liveX, y: liveY, dir: liveDir, walk: liveWalk });
          trk.recorded = true;
        }
      }
      lastSample = t;
    }
  }

  // 4) 씬 끝 처리
  if (state.rt.recording) {
    // 녹화는 사용자가 정지(⏺) 누를 때까지 계속 — 씬 길이는 sceneTime 에 맞춰 자동 확장
    if (state.rt.sceneTime > scene.duration) {
      scene.duration = Math.ceil(state.rt.sceneTime * 10) / 10; // 0.1s 단위로 올림
    }
  } else if (state.rt.sceneTime >= scene.duration) {
    // 재생만 — 끝나면 정지
    state.rt.playing = false;
    state.rt.sceneTime = scene.duration;
  }

  notify();
}

// ===== 외부 API =====

export function togglePlay(): void {
  if (state.rt.recording) {
    // 녹화 중 Space → 녹화 중단, 재생만 계속? UX 결정: 녹화도 멈춤.
    stopRecord();
  }
  if (state.rt.countingDown) {
    cancelCountdown();
    return;
  }
  state.rt.playing = !state.rt.playing;
  if (state.rt.playing && state.rt.sceneTime >= activeScene().duration) {
    state.rt.sceneTime = 0;
  }
  lastNow = performance.now();
  notify();
}

// ⏺ 또는 R: 카운트다운 시작 → 끝나면 자동 녹화. 진행 중 다시 누르면 취소.
export function toggleRecord(): void {
  if (state.rt.recording) { stopRecord(); return; }
  if (state.rt.countingDown) { cancelCountdown(); return; }
  startRecord();
}

// 외부에서 호출하는 record 시작 — 사용자 입장에선 '⏺ 누름'.
// 실제로는 카운트다운을 켜고, 끝나면 doStartRecord() 가 진짜 녹화 시작.
//
// 모드는 재생헤드(sceneTime) 위치에 따라 자동 결정:
//   - t ≤ 0 또는 키프 없음 → 새 녹화 (키프 비움, startX/Y 에서 시작)
//   - t 가 녹화 중간       → 그 시점 이후 키프 잘라내고 보간 위치/방향에서 이어
//   - t 가 마지막 키프 이후 → 기존 키프 보존, 마지막 위치/방향에서 이어
export function startRecord(): void {
  const scene = activeScene();
  const isCamArmed = state.rt.armedTrackId === CAMERA_ARMED_ID;
  const trk = !isCamArmed ? trackById(scene, state.rt.armedTrackId) : null;

  if (!isCamArmed && !trk) {
    console.warn('녹화 대상 트랙이 선택되지 않음');
    return;
  }

  const T = state.rt.sceneTime;
  const APPEND_EPS = 0.05;

  if (isCamArmed) {
    // ===== 카메라 녹화 =====
    const ks = scene.camera.keyframes;
    const hasKf = ks.length > 0;
    const lastT = hasKf ? ks[ks.length - 1].t : 0;
    if (!hasKf || T <= APPEND_EPS) {
      // 새 녹화 — 현재 liveCam 위치/줌에서 시작 (freeMove 결과 보존)
      scene.camera.keyframes = [];
      state.rt.sceneTime = 0;
      lastSample = -1;
      showToast('🆕 카메라 새 녹화');
    } else if (T >= lastT - APPEND_EPS) {
      const last = ks[ks.length - 1];
      liveCamX = last.x; liveCamY = last.y; liveCamZoom = last.zoom;
      lastSample = last.t;
      showToast(`▶ 카메라 ${T.toFixed(1)}s 부터 이어 녹화`);
    } else {
      // 중간부터 덮어쓰기 — 그 시점 보간 위치/줌에서 출발
      // sampleCamera 는 fallback 인자가 필요 — 적당히 맵 중앙
      const map = currentMap();
      const fx = map ? map.pixelW / 2 : 240;
      const fy = map ? map.pixelH / 2 : 135;
      const sm = sampleCamera(scene, T, fx, fy);
      scene.camera.keyframes = ks.filter((k) => k.t < T);
      liveCamX = sm.x; liveCamY = sm.y; liveCamZoom = sm.zoom;
      lastSample = T;
      showToast(`✂ 카메라 ${T.toFixed(1)}s 부터 다시 녹화`);
    }
  } else if (trk) {
    // ===== 캐릭터 녹화 =====
    const ks = trk.keyframes;
    const hasKf = ks.length > 0;
    const lastT = hasKf ? ks[ks.length - 1].t : 0;
    if (!hasKf || T <= APPEND_EPS) {
      trk.keyframes = [];
      trk.recorded = false;
      liveX = trk.startX;
      liveY = trk.startY;
      liveDir = trk.startDir;
      state.rt.sceneTime = 0;
      lastSample = -1;
      showToast('🆕 새 녹화 — 처음부터');
    } else if (T >= lastT - APPEND_EPS) {
      const last = ks[ks.length - 1];
      liveX = last.x; liveY = last.y; liveDir = last.dir;
      lastSample = last.t;
      showToast(`▶ ${T.toFixed(1)}s 부터 이어 녹화`);
    } else {
      const sm = sampleTrack(trk, T);
      trk.keyframes = ks.filter((k) => k.t < T);
      liveX = sm.x; liveY = sm.y; liveDir = sm.dir;
      lastSample = T;
      showToast(`✂ ${T.toFixed(1)}s 부터 다시 녹화`);
    }
    liveWalk = false;
  }

  state.rt.recording = false;
  state.rt.playing = false;
  state.rt.countingDown = true;
  state.rt.countdownT = COUNTDOWN_SEC;
  countdownStart = performance.now();
  lastNow = performance.now();
  notify();
}

function doStartRecord(): void {
  state.rt.recording = true;
  state.rt.playing = true;
  // sceneTime, lastSample, liveX/Y/Dir 는 startRecord 에서 이미 모드별로 설정됨 — 건드리지 않음.
  lastNow = performance.now();
}

function cancelCountdown(): void {
  state.rt.countingDown = false;
  state.rt.countdownT = 0;
  notify();
}

export function stopRecord(): void {
  if (!state.rt.recording) return;
  state.rt.recording = false;
  state.rt.playing = false;     // 녹화 중단 시 재생도 멈춤 — 사용자 멘탈모델 일치
  const scene = activeScene();
  const isCamArmed = state.rt.armedTrackId === CAMERA_ARMED_ID;
  if (isCamArmed) {
    scene.camera.keyframes.push({ t: state.rt.sceneTime, x: liveCamX, y: liveCamY, zoom: liveCamZoom, ease: 'linear' });
    showToast(`✓ 카메라 ${state.rt.sceneTime.toFixed(1)}초 녹화 (${scene.camera.keyframes.length}키프레임)`, 'ok', 2500);
  } else {
    const trk = trackById(scene, state.rt.armedTrackId);
    if (trk) {
      trk.keyframes.push({ t: state.rt.sceneTime, x: liveX, y: liveY, dir: liveDir, walk: false });
      showToast(`✓ ${state.rt.sceneTime.toFixed(1)}초 녹화 완료 (${trk.keyframes.length}키프레임)`, 'ok', 2500);
    }
  }
  // 씬 길이를 녹화 끝까지 확장 (이미 advance 에서 확장 중이지만 안전망)
  if (state.rt.sceneTime > scene.duration) {
    scene.duration = Math.ceil(state.rt.sceneTime * 10) / 10;
  }
  notify();
}

export function seek(sec: number): void {
  const scene = activeScene();
  state.rt.sceneTime = clamp(sec, 0, scene.duration);
  notify();
}

// 활성 트랙의 시작 위치를 현재 라이브 위치로 — 사용자가 수동 위치 잡을 때.
export function setActiveStartPos(x: number, y: number): void {
  const trk = trackById(activeScene(), state.rt.armedTrackId);
  if (!trk) return;
  trk.startX = x;
  trk.startY = y;
  liveX = x; liveY = y;
  notify();
}

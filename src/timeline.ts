// 하단 타임라인 — 트랙 행 + 클립 + 키프레임 + 플레이헤드.
//
// 트랙 종류: Camera (키프레임 다이아몬드) / Audio (페이드 envelope) /
// Characters (녹화 막대) / Dialogue (다중 클립, 드래그)

import { state, notify, activeScene, findAsset } from './state';
import type { Bubble, CharTrack, CameraKey } from './state';
import { clamp, startPointerDrag } from './util';
import { seek } from './playback';

const LABEL_W = 140;

let body!: HTMLElement;

export function initTimeline(): void {
  body = document.getElementById('timeline-body')!;
  const zoomIn = document.getElementById('tl-zoom') as HTMLInputElement;
  // 초기값을 state.rt.pxPerSec 에 맞춤 (모바일 자동 ↑)
  zoomIn.value = String(state.rt.pxPerSec);
  zoomIn.addEventListener('input', () => {
    state.rt.pxPerSec = parseInt(zoomIn.value, 10);
    notify();
  });
  setupPinchZoom(body, zoomIn);
}

// 두 손가락 핀치 → pxPerSec 확대/축소. TouchEvent 로 처리 (PointerEvent capture 회피).
function setupPinchZoom(target: HTMLElement, zoomIn: HTMLInputElement): void {
  let basePx = 0;
  let baseDist = 0;
  let active = false;
  target.addEventListener('touchstart', (e) => {
    if (e.touches.length >= 2) {
      const a = e.touches[0], b = e.touches[1];
      baseDist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      basePx = state.rt.pxPerSec;
      active = true;
    }
  }, { passive: true });
  target.addEventListener('touchmove', (e) => {
    if (active && e.touches.length >= 2) {
      e.preventDefault();
      const a = e.touches[0], b = e.touches[1];
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      if (baseDist > 5) {
        const nextPx = clamp(basePx * (dist / baseDist), 20, 600);
        state.rt.pxPerSec = nextPx;
        zoomIn.value = String(Math.round(nextPx));
        notify();
      }
    }
  }, { passive: false });
  const end = (e: TouchEvent) => {
    if (e.touches.length < 2) active = false;
  };
  target.addEventListener('touchend', end);
  target.addEventListener('touchcancel', end);
}

export function renderTimeline(): void {
  const scene = activeScene();
  const px = state.rt.pxPerSec;
  body.innerHTML = '';

  // 눈금자
  const ruler = makeRuler(scene.duration, px);
  body.appendChild(ruler);

  // 트랙들
  body.appendChild(makeCameraTrack(scene.camera.keyframes, px));
  body.appendChild(makeBgmTrack(scene.bgm, scene.duration, px));
  for (const trk of scene.tracks) body.appendChild(makeCharTrack(trk, px));
  body.appendChild(makeBubblesTrack(scene.bubbles, px));

  // 플레이헤드 (전체 위에 floating) — 위쪽에 ‘잡이’ 가 있어 드래그하면 scrub.
  const ph = document.createElement('div');
  ph.className = 'tl-playhead';
  ph.style.left = (LABEL_W + state.rt.sceneTime * px) + 'px';
  const grab = document.createElement('div');
  grab.className = 'tl-playhead-grab';
  grab.title = '드래그해서 시간 이동';
  grab.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const seekAt = (clientX: number) => {
      const r = body.getBoundingClientRect();
      const contentX = clientX - r.left + body.scrollLeft;
      seek((contentX - LABEL_W) / px);
    };
    seekAt(e.clientX);
    startPointerDrag(e, grab, (cx) => seekAt(cx));
  });
  ph.appendChild(grab);
  body.appendChild(ph);
}

function makeRuler(duration: number, px: number): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'tl-ruler';

  const pad = document.createElement('div');
  pad.className = 'tl-ruler-pad';
  wrap.appendChild(pad);

  const isMobile = window.matchMedia('(max-width: 900px)').matches;
  const H = isMobile ? 32 : 24;
  const w = Math.max(200, duration * px + 200);
  const c = document.createElement('canvas');
  c.className = 'tl-ruler-canvas';
  c.width = w;
  c.height = H;
  c.style.width = w + 'px';
  c.style.height = H + 'px';
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#9aa2ad';
  ctx.font = '10px Galmuri11, system-ui';
  ctx.textBaseline = 'top';
  // 1초 간격, 0.1초 미세 눈금
  for (let t = 0; t <= duration + 1; t += 0.1) {
    const x = Math.round(t * px) + 0.5;
    const major = Math.abs(t - Math.round(t)) < 0.001;
    ctx.strokeStyle = major ? '#bfc6d0' : 'rgba(154, 162, 173, 0.3)';
    ctx.beginPath();
    ctx.moveTo(x, major ? H - 16 : H - 10);
    ctx.lineTo(x, H - 2);
    ctx.stroke();
    if (major) ctx.fillText(t.toFixed(0) + 's', x + 2, 0);
  }
  // 씬 길이 끝 마커
  const endX = Math.round(duration * px) + 0.5;
  ctx.strokeStyle = '#4ea1ff';
  ctx.beginPath();
  ctx.moveTo(endX, 0);
  ctx.lineTo(endX, H);
  ctx.stroke();
  wrap.appendChild(c);

  // 눈금자 탭/드래그 → seek
  c.style.cursor = 'pointer';
  c.style.touchAction = 'none';
  c.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const r = c.getBoundingClientRect();
    seek((e.clientX - r.left) / px);
    startPointerDrag(e, c, (cx) => {
      const rr = c.getBoundingClientRect();
      seek((cx - rr.left) / px);
    });
  });

  return wrap;
}

function makeLabel(icon: string, text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'tl-track-label';
  el.innerHTML = `<span class="ico">${icon}</span><span class="name">${escapeHtml(text)}</span>`;
  return el;
}

function makeCameraTrack(keys: CameraKey[], px: number): HTMLElement {
  const row = document.createElement('div');
  row.className = 'tl-track';
  const label = document.createElement('div');
  label.className = 'tl-track-label';
  const dot = document.createElement('span');
  dot.className = 'dot' + (state.rt.armedTrackId === '__camera__' ? ' armed' : '');
  dot.title = 'Arm Camera — joystick pans, +/- zooms';
  dot.addEventListener('click', (e) => {
    e.stopPropagation();
    state.rt.armedTrackId = state.rt.armedTrackId === '__camera__' ? null : '__camera__';
    notify();
  });
  label.appendChild(dot);
  const ico = document.createElement('span');
  ico.className = 'ico'; ico.textContent = 'CAM';
  label.appendChild(ico);
  const name = document.createElement('span');
  name.className = 'name'; name.textContent = 'Camera';
  label.appendChild(name);
  label.addEventListener('click', () => { state.rt.selectedTrackId = '__camera__'; notify(); });
  row.appendChild(label);

  const cont = document.createElement('div');
  cont.className = 'tl-track-content';
  cont.style.minWidth = (activeScene().duration * px + 200) + 'px';
  cont.style.cursor = 'pointer';
  cont.style.touchAction = 'none';
  cont.addEventListener('pointerdown', (e) => seekFromContentPointer(e, cont, px));
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const dot = document.createElement('div');
    dot.className = 'tl-key' + (state.rt.selectedCamKey === i ? ' selected' : '');
    dot.style.left = (k.t * px) + 'px';
    dot.title = `t=${k.t.toFixed(2)}s zoom=${k.zoom.toFixed(2)}${k.followTrackId ? ' (follow)' : ''}`;
    dot.style.touchAction = 'none';
    dot.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      state.rt.selectedCamKey = i;
      state.rt.selectedBubbleId = null;
      state.rt.selectedTrackId = '__camera__';
      notify();
      const startLeft = parseFloat(dot.style.left) || 0;
      startPointerDrag(e, dot, (_cx, _cy, _sx, _sy, dx) => {
        k.t = clamp((startLeft + dx) / px, 0, activeScene().duration);
        keys.sort((a, b) => a.t - b.t);
        notify();
      });
    });
    cont.appendChild(dot);
  }
  row.appendChild(cont);
  return row;
}

function makeBgmTrack(bgm: ReturnType<typeof activeScene>['bgm'], duration: number, px: number): HTMLElement {
  const row = document.createElement('div');
  row.className = 'tl-track';
  const asset = findAsset(bgm.assetId);
  const label = makeLabel('AUD', asset ? asset.name : 'No audio');
  label.addEventListener('click', () => { state.rt.selectedTrackId = '__bgm__'; notify(); });
  row.appendChild(label);
  const cont = document.createElement('div');
  cont.className = 'tl-track-content';
  cont.style.minWidth = (duration * px + 200) + 'px';
  cont.style.touchAction = 'none';
  cont.addEventListener('pointerdown', (e) => seekFromContentPointer(e, cont, px));
  if (asset) {
    const clip = document.createElement('div');
    clip.className = 'tl-clip tl-clip-bgm';
    clip.style.left = '0px';
    clip.style.width = (duration * px) + 'px';
    clip.textContent = asset.name;
    cont.appendChild(clip);
    // 페이드 envelope (간단히 막대 좌우 그라데이션으로)
    if (bgm.fadeIn > 0) {
      const fade = document.createElement('div');
      fade.style.cssText = `position:absolute;left:0;top:0;bottom:0;width:${bgm.fadeIn * px}px;background:linear-gradient(to right, rgba(0,0,0,0.6), transparent);pointer-events:none;`;
      clip.appendChild(fade);
    }
    if (bgm.fadeOut > 0) {
      const fade = document.createElement('div');
      const w = bgm.fadeOut * px;
      fade.style.cssText = `position:absolute;right:0;top:0;bottom:0;width:${w}px;background:linear-gradient(to left, rgba(0,0,0,0.6), transparent);pointer-events:none;`;
      clip.appendChild(fade);
    }
  }
  row.appendChild(cont);
  return row;
}

function makeCharTrack(trk: CharTrack, px: number): HTMLElement {
  const row = document.createElement('div');
  row.className = 'tl-track';
  const label = document.createElement('div');
  label.className = 'tl-track-label';
  const dot = document.createElement('span');
  dot.className = 'dot' + (state.rt.armedTrackId === trk.id ? ' armed' : '');
  dot.title = 'Arm this track for recording';
  dot.addEventListener('click', (e) => {
    e.stopPropagation();
    state.rt.armedTrackId = state.rt.armedTrackId === trk.id ? null : trk.id;
    notify();
  });
  label.appendChild(dot);
  const ico = document.createElement('span');
  ico.className = 'ico'; ico.textContent = 'CHR';
  label.appendChild(ico);
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = trk.name;
  label.appendChild(name);
  const delBtn = document.createElement('button');
  delBtn.className = 'st-btn'; delBtn.textContent = '✕';
  delBtn.title = 'Remove track';
  delBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const scene = activeScene();
    scene.tracks = scene.tracks.filter((t) => t.id !== trk.id);
    if (state.rt.armedTrackId === trk.id) state.rt.armedTrackId = null;
    notify();
  });
  label.appendChild(delBtn);
  label.addEventListener('click', () => { state.rt.selectedTrackId = trk.id; notify(); });
  row.appendChild(label);

  const cont = document.createElement('div');
  cont.className = 'tl-track-content';
  cont.style.minWidth = (activeScene().duration * px + 200) + 'px';
  cont.style.touchAction = 'none';
  cont.addEventListener('pointerdown', (e) => seekFromContentPointer(e, cont, px));

  if (trk.recorded && trk.keyframes.length > 0) {
    const first = trk.keyframes[0].t;
    const last = trk.keyframes[trk.keyframes.length - 1].t;
    const clip = document.createElement('div');
    clip.className = 'tl-clip';
    clip.style.left = (first * px) + 'px';
    clip.style.width = Math.max(8, (last - first) * px) + 'px';
    clip.textContent = `${trk.name} (${trk.keyframes.length}f)`;
    cont.appendChild(clip);
  } else {
    const hint = document.createElement('div');
    hint.style.cssText = 'position:absolute;left:8px;top:50%;transform:translateY(-50%);color:var(--text-mute);font-size:11px;';
    hint.textContent = state.rt.armedTrackId === trk.id
      ? (state.rt.countingDown ? 'Starting…' : 'Press ● to start 3-2-1 countdown')
      : 'Click the dot to arm this track';
    cont.appendChild(hint);
  }
  row.appendChild(cont);
  return row;
}

function makeBubblesTrack(bubbles: Bubble[], px: number): HTMLElement {
  const row = document.createElement('div');
  row.className = 'tl-track';
  const label = makeLabel('DLG', 'Dialogue');
  row.appendChild(label);
  const cont = document.createElement('div');
  cont.className = 'tl-track-content';
  cont.style.minWidth = (activeScene().duration * px + 200) + 'px';
  cont.style.touchAction = 'none';
  cont.addEventListener('pointerdown', (e) => seekFromContentPointer(e, cont, px));
  for (const b of bubbles) {
    const clip = document.createElement('div');
    clip.className = 'tl-clip tl-clip-bubble' + (state.rt.selectedBubbleId === b.id ? ' selected' : '');
    clip.style.left = (b.t * px) + 'px';
    clip.style.width = Math.max(20, b.dur * px) + 'px';
    clip.textContent = b.text || '...';
    clip.style.touchAction = 'none';
    clip.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      state.rt.selectedBubbleId = b.id;
      state.rt.selectedCamKey = null;
      state.rt.selectedTrackId = null;
      notify();
      const startLeft = parseFloat(clip.style.left) || 0;
      startPointerDrag(e, clip, (_cx, _cy, _sx, _sy, dx) => {
        b.t = clamp((startLeft + dx) / px, 0, activeScene().duration - b.dur);
        notify();
      });
    });
    cont.appendChild(clip);
  }
  row.appendChild(cont);
  return row;
}

function seekFromContentPointer(e: PointerEvent, cont: HTMLElement, px: number): void {
  e.preventDefault();
  const r = cont.getBoundingClientRect();
  seek((e.clientX - r.left) / px);
  startPointerDrag(e, cont, (cx) => {
    const rr = cont.getBoundingClientRect();
    seek((cx - rr.left) / px);
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

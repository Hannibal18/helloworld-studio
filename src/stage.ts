// 프리뷰 스테이지 — 메인 캔버스.
// 매 프레임 활성 씬(map / 캐릭터 / 카메라 / 말풍선 / 전환)을 그린다.
// 재생 헤드(state.rt.sceneTime) 만 보고 그리므로, 재생/녹화/스크럽이 같은 코드 경로를 공유.

import { state, activeScene, findAsset, trackById } from './state';
import type { CharTrack, CameraKey, Scene, MapAsset } from './state';
import { loadMap, drawTileLayer } from './lib/map';
import type { TileMap } from './lib/map';
import { drawCharacter, prescaleCharacter, CHAR_W } from './lib/sprites';
import { clamp, lerp, easeInOut } from './util';
import { getStick } from './input';
import { CAMERA_ARMED_ID, getLiveCam } from './playback';

// ===== 캔버스 셋업 =====

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;

const dpr = (): number => Math.max(1, Math.min(3, window.devicePixelRatio || 1));

export function initStage(): void {
  canvas = document.getElementById('stage-canvas') as HTMLCanvasElement;
  ctx = canvas.getContext('2d', { alpha: false })!;
  prescaleCharacter(0.5);     // 32x48 표준 LPC 비율
  resize();
  window.addEventListener('resize', resize);
  // 매 프레임 그린다 — 재생 여부와 무관 (스크럽/녹화도 같은 경로).
  requestAnimationFrame(loop);
}

function resize(): void {
  const wrap = canvas.parentElement as HTMLElement;
  const r = dpr();
  const cssW = wrap.clientWidth;
  const cssH = wrap.clientHeight;
  canvas.style.width = cssW + 'px';
  canvas.style.height = cssH + 'px';
  canvas.width = Math.round(cssW * r);
  canvas.height = Math.round(cssH * r);
}

// 마지막으로 그린 시각 — 외부 모듈(인풋/녹화)에서 마지막 캐릭터 위치 등을 캐싱할 때 참고.
let lastRenderNow = 0;
export function lastRenderTime(): number { return lastRenderNow; }

function loop(now: number): void {
  lastRenderNow = now / 1000;
  try {
    render();
  } catch (e) {
    console.error('[stage render]', e);
  }
  requestAnimationFrame(loop);
}

// ===== 맵 캐시 (async load) =====

const mapCache = new Map<string, TileMap>();
const mapLoading = new Set<string>();

function getMap(assetId: string | null): TileMap | null {
  if (!assetId) return null;
  const cached = mapCache.get(assetId);
  if (cached) return cached;
  if (mapLoading.has(assetId)) return null;
  const asset = findAsset(assetId);
  if (!asset || asset.kind !== 'map') return null;
  mapLoading.add(assetId);
  void loadMap((asset as MapAsset).url).then((m) => {
    mapCache.set(assetId, m);
    mapLoading.delete(assetId);
  }).catch((e) => {
    console.warn('[stage] map load fail', assetId, e);
    mapLoading.delete(assetId);
  });
  return null;
}

// ===== 캐릭터 트랙 보간 =====

export function sampleTrack(track: CharTrack, t: number): { x: number; y: number; dir: CharTrack['startDir']; walk: boolean } {
  const ks = track.keyframes;
  if (ks.length === 0) {
    return { x: track.startX, y: track.startY, dir: track.startDir, walk: false };
  }
  if (t <= ks[0].t) {
    const k = ks[0];
    return { x: k.x, y: k.y, dir: k.dir, walk: k.walk };
  }
  const last = ks[ks.length - 1];
  if (t >= last.t) {
    return { x: last.x, y: last.y, dir: last.dir, walk: last.walk };
  }
  // 이진 탐색 생략 — 키프레임 수가 보통 수백 이하라 선형 OK.
  for (let i = 0; i < ks.length - 1; i++) {
    const a = ks[i], b = ks[i + 1];
    if (t >= a.t && t < b.t) {
      const u = (t - a.t) / Math.max(0.0001, b.t - a.t);
      return {
        x: lerp(a.x, b.x, u),
        y: lerp(a.y, b.y, u),
        dir: u < 0.5 ? a.dir : b.dir,
        walk: a.walk || b.walk,
      };
    }
  }
  return { x: last.x, y: last.y, dir: last.dir, walk: false };
}

// ===== 카메라 보간 =====

interface CamState { x: number; y: number; zoom: number; }

export function sampleCamera(scene: Scene, t: number, fallbackCx: number, fallbackCy: number): CamState {
  // 카메라가 활성(armed)인 동안 — 녹화/자유이동 중이라면 라이브 값으로 즉시 그림.
  // (재생 중 + !녹화 면 키프레임을 따라야 하니 라이브 override 안 함)
  if (state.rt.armedTrackId === CAMERA_ARMED_ID && (state.rt.recording || !state.rt.playing)) {
    return getLiveCam();
  }
  const ks = scene.camera.keyframes;
  // 카메라 키프레임이 없을 때:
  //   - 활성(armed) 트랙이 있으면 → 그 캐릭터를 따라감 (편집 중 시야 확보)
  //   - 없으면 맵 중앙 폴백
  if (ks.length === 0) {
    if (state.rt.armedTrackId) {
      const armed = trackById(scene, state.rt.armedTrackId);
      if (armed) {
        const s = sampleTrack(armed, t);
        return { x: s.x, y: s.y, zoom: 1 };
      }
    }
    return { x: fallbackCx, y: fallbackCy, zoom: 1 };
  }
  const resolve = (k: CameraKey): CamState => {
    if (k.followTrackId) {
      const trk = trackById(scene, k.followTrackId);
      if (trk) {
        const s = sampleTrack(trk, t);
        return { x: s.x, y: s.y, zoom: k.zoom };
      }
    }
    return { x: k.x, y: k.y, zoom: k.zoom };
  };
  if (t <= ks[0].t) return resolve(ks[0]);
  const last = ks[ks.length - 1];
  if (t >= last.t) return resolve(last);
  for (let i = 0; i < ks.length - 1; i++) {
    const a = ks[i], b = ks[i + 1];
    if (t >= a.t && t < b.t) {
      const u0 = (t - a.t) / Math.max(0.0001, b.t - a.t);
      const u = a.ease === 'ease-in-out' ? easeInOut(u0) : u0;
      const sa = resolve(a);
      const sb = resolve(b);
      return { x: lerp(sa.x, sb.x, u), y: lerp(sa.y, sb.y, u), zoom: lerp(sa.zoom, sb.zoom, u) };
    }
  }
  return resolve(last);
}

// ===== 렌더 =====

function render(): void {
  const scene = activeScene();
  const t = state.rt.sceneTime;
  const r = dpr();
  const cssW = canvas.width / r;
  const cssH = canvas.height / r;

  ctx.save();
  ctx.setTransform(r, 0, 0, r, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#0a0a10';
  ctx.fillRect(0, 0, cssW, cssH);

  const map = getMap(scene.mapAssetId);

  // 카메라 (기본값 — 맵 중앙)
  const fallbackCx = map ? map.pixelW / 2 : cssW / 2;
  const fallbackCy = map ? map.pixelH / 2 : cssH / 2;
  const cam = sampleCamera(scene, t, fallbackCx, fallbackCy);
  // 사용자 줌 슬라이더 (런타임)
  const userZoom = (state.rt as { previewZoom?: number }).previewZoom ?? 1;
  const zoom = clamp(cam.zoom * userZoom, 0.2, 6);

  const worldViewW = cssW / zoom;
  const worldViewH = cssH / zoom;
  const worldX = cam.x - worldViewW / 2;
  const worldY = cam.y - worldViewH / 2;

  // 맵 그리기
  if (map) {
    ctx.save();
    ctx.scale(zoom, zoom);
    const nowSec = lastRenderNow;
    // 1) ground / decor / objects_below 같은 캐릭터 아래 레이어를 먼저
    const orderBelow = ['ground', 'background', 'decor', 'objects_below', 'below'];
    const orderAbove = ['objects_above', 'above', 'roof', 'overhead'];
    const drawn = new Set<string>();
    for (const name of orderBelow) {
      const layer = map.layerByName.get(name);
      if (layer && layer.kind === 'tile') {
        drawTileLayer(ctx, map, layer, worldX, worldY, worldViewW, worldViewH, nowSec);
        drawn.add(name);
      }
    }
    // 명시된 위/아래 이외의 tile 레이어는 below 로 간주 (이름 규약 미준수 맵 대비)
    for (const layer of map.layers) {
      if (layer.kind !== 'tile' || drawn.has(layer.name)) continue;
      if (orderAbove.includes(layer.name)) continue;
      drawTileLayer(ctx, map, layer, worldX, worldY, worldViewW, worldViewH, nowSec);
    }

    // 캐릭터들 (월드 좌표 → 카메라 상대 좌표)
    drawTracks(scene, t, worldX, worldY);

    // 위 레이어
    for (const name of orderAbove) {
      const layer = map.layerByName.get(name);
      if (layer && layer.kind === 'tile') {
        drawTileLayer(ctx, map, layer, worldX, worldY, worldViewW, worldViewH, nowSec);
      }
    }
    ctx.restore();
  } else {
    // 맵 미선택 — 그리드 배경.
    drawCheckerboard(cssW, cssH);
    if (scene.mapAssetId) {
      drawCenterText(cssW, cssH, 'Loading map…', '#8a909a');
    } else {
      drawCenterText(cssW, cssH, 'Select a map from the bin', '#5a606a');
    }
  }

  // 말풍선 (스크린 공간 — 줌과 무관하게 같은 크기)
  drawBubbles(scene, t, zoom, worldX, worldY);

  // 전환 효과 (씬 시작 부분에 transitionIn 이 있으면 t < dur 동안 오버레이)
  drawTransitionOverlay(scene, t, cssW, cssH);

  // 카운트다운 — 녹화 시작 직전 3-2-1
  if (state.rt.countingDown) drawCountdown(state.rt.countdownT, cssW, cssH);

  // 디버그 — 녹화/카운트다운/활성 시 입력 상태 표시 (조이스틱 동작 확인용)
  if (state.rt.recording || state.rt.countingDown || state.rt.armedTrackId) {
    drawDebug(scene, t, cssW, cssH);
  }

  ctx.restore();
}

function drawDebug(scene: Scene, t: number, w: number, _h: number): void {
  const s = getStick();
  const trk = state.rt.armedTrackId ? trackById(scene, state.rt.armedTrackId) : null;
  let liveStr = '';
  if (trk) {
    const sm = sampleTrack(trk, t);
    liveStr = ` live=(${sm.x.toFixed(0)},${sm.y.toFixed(0)}) walk=${sm.walk ? 'Y' : 'N'}`;
  }
  const line1 = `stick=(${s.x.toFixed(2)}, ${s.y.toFixed(2)})${liveStr}`;
  const line2 = `rec=${state.rt.recording ? 'ON' : 'off'} play=${state.rt.playing ? 'ON' : 'off'} cnt=${state.rt.countingDown ? state.rt.countdownT.toFixed(1) : '-'} keys=${trk?.keyframes.length ?? 0}`;
  ctx.save();
  ctx.font = '11px ui-monospace, monospace';
  ctx.textBaseline = 'top';
  const pad = 6;
  const lines = [line1, line2];
  const wid = Math.max(...lines.map((l) => ctx.measureText(l).width)) + pad * 2;
  const hi = 16 * lines.length + pad * 2;
  // 상단 가운데
  const x = (w - wid) / 2;
  const y = 28;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
  ctx.fillRect(x, y, wid, hi);
  ctx.fillStyle = '#7df';
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], x + pad, y + pad + i * 16);
  }
  ctx.restore();
}

function drawCountdown(t: number, w: number, h: number): void {
  const n = Math.ceil(t);
  if (n <= 0) return;
  ctx.save();
  ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
  ctx.fillRect(0, 0, w, h);
  // 둥근 링 — 남은 시간 비율
  const frac = t - Math.floor(t);    // 1초 안에서 0→1 진행
  const cx = w / 2, cy = h / 2;
  const radius = Math.min(w, h) * 0.18;
  ctx.lineWidth = 6;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
  ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = '#ff4d4d';
  ctx.beginPath();
  ctx.arc(cx, cy, radius, -Math.PI / 2, -Math.PI / 2 + (1 - frac) * Math.PI * 2);
  ctx.stroke();
  // 숫자
  const fontSize = Math.round(Math.min(w, h) * 0.25);
  ctx.font = `bold ${fontSize}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
  ctx.lineWidth = Math.max(4, fontSize * 0.06);
  ctx.strokeText(String(n), cx, cy);
  ctx.fillStyle = '#fff';
  ctx.fillText(String(n), cx, cy);
  // hint
  ctx.font = `${Math.round(fontSize * 0.18)}px -apple-system, system-ui, sans-serif`;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
  ctx.fillText('Hold joystick — releases at 0', cx, cy + radius + fontSize * 0.3);
  ctx.restore();
}

function drawTracks(scene: Scene, t: number, worldX: number, worldY: number): void {
  // y 정렬 — 위쪽 캐릭터를 먼저 그려 아래쪽이 위에 보이도록.
  const samples = scene.tracks.map((trk) => ({ trk, s: sampleTrack(trk, t) }));
  samples.sort((a, b) => a.s.y - b.s.y);
  const nowSec = lastRenderNow;
  for (const { trk, s } of samples) {
    const asset = findAsset(trk.charAssetId);
    if (!asset || asset.kind !== 'char') continue;
    // 카메라 상대 좌표
    const fx = s.x - worldX;
    const fy = s.y - worldY;
    drawCharacter(ctx, fx, fy, asset.charIdx, s.dir, s.walk, -1, false, nowSec, asset.customUrl);
    // 녹화 대상은 발 밑에 빨간 링
    if (state.rt.armedTrackId === trk.id && state.rt.recording) {
      ctx.save();
      ctx.strokeStyle = '#ff4d4d';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.ellipse(fx, fy, CHAR_W * 0.6, CHAR_W * 0.22, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    // 이름표
    ctx.save();
    ctx.fillStyle = '#fff';
    ctx.font = '10px Galmuri11, system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(trk.name, fx, fy - 48);
    ctx.restore();
  }
}

function drawBubbles(scene: Scene, t: number, zoom: number, worldX: number, worldY: number): void {
  for (const bub of scene.bubbles) {
    if (t < bub.t || t > bub.t + bub.dur) continue;
    const trk = trackById(scene, bub.trackId);
    if (!trk) continue;
    const s = sampleTrack(trk, t);
    // 보여줄 텍스트 (타이프라이터)
    let display = bub.text;
    if (bub.typewriter) {
      const since = t - bub.t;
      const chars = Math.min(bub.text.length, Math.floor(since * Math.max(1, bub.cps)));
      display = bub.text.slice(0, chars);
    }
    // 캐릭터 머리 위 (월드 → 스크린, 줌 반영 좌표)
    const sx = (s.x - worldX) * zoom;
    const sy = (s.y - worldY) * zoom - 48 * zoom;
    drawBubble(sx, sy, display);
  }
}

function drawBubble(cx: number, cy: number, text: string): void {
  if (!text) return;
  ctx.save();
  ctx.font = '11px Galmuri11, system-ui';
  ctx.textBaseline = 'middle';
  const padX = 7, padY = 5;
  // 런타임 player.ts 와 동일한 wrap 폭(200) — 프리뷰↔재생 말풍선 줄바꿈 일치(WYSIWYG).
  const lines = wrapText(text, 200);
  const lineH = 14;
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + padX * 2;
  const h = lines.length * lineH + padY * 2;
  const x = cx - w / 2;
  const y = cy - h;
  // 둥근 사각 + 꼬리
  ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 1;
  roundRect(x, y, w, h, 4);
  ctx.fill();
  ctx.stroke();
  // 꼬리
  ctx.beginPath();
  ctx.moveTo(cx - 5, y + h);
  ctx.lineTo(cx, y + h + 5);
  ctx.lineTo(cx + 5, y + h);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  // 텍스트
  ctx.fillStyle = '#1a1a1a';
  ctx.textAlign = 'center';
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], cx, y + padY + lineH / 2 + i * lineH);
  }
  ctx.restore();
}
function roundRect(x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
function wrapText(s: string, maxWidth: number): string[] {
  // 단순 공백 기반. 영문/한글 모두 단어 단위로 자름. 길면 한 글자씩.
  const words = s.split(/\s+/);
  const out: string[] = [];
  let cur = '';
  for (const w of words) {
    const test = cur ? cur + ' ' + w : w;
    if (ctx.measureText(test).width <= maxWidth) cur = test;
    else { if (cur) out.push(cur); cur = w; }
  }
  if (cur) out.push(cur);
  return out.length > 0 ? out : [s];
}

function drawTransitionOverlay(scene: Scene, t: number, w: number, h: number): void {
  const tr = scene.transitionIn;
  if (!tr || tr.dur <= 0 || tr.type === 'cut') return;
  if (t < 0 || t > tr.dur) return;
  const u = 1 - t / tr.dur; // 시작 0=풀, dur 에서 0
  if (tr.type === 'fade-black') {
    ctx.fillStyle = `rgba(0, 0, 0, ${u})`;
    ctx.fillRect(0, 0, w, h);
  } else if (tr.type === 'fade-white') {
    ctx.fillStyle = `rgba(255, 255, 255, ${u})`;
    ctx.fillRect(0, 0, w, h);
  } else if (tr.type === 'wipe') {
    // 좌→우. u=1 이면 화면 전체 덮음, u=0 이면 사라짐.
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w * u, h);
  }
}

function drawCheckerboard(w: number, h: number): void {
  const s = 16;
  ctx.fillStyle = '#1d2024';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#262a30';
  for (let y = 0; y < h; y += s) {
    for (let x = (Math.floor(y / s) % 2) * s; x < w; x += s * 2) {
      ctx.fillRect(x, y, s, s);
    }
  }
}
function drawCenterText(w: number, h: number, text: string, color: string): void {
  ctx.save();
  ctx.fillStyle = color;
  ctx.font = '14px Galmuri11, system-ui';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, h / 2);
  ctx.restore();
}

// 외부 모듈이 캔버스 픽셀 → 월드 좌표 변환할 때 쓰는 헬퍼.
export function screenToWorld(screenX: number, screenY: number): { x: number; y: number } {
  const scene = activeScene();
  const r = dpr();
  const cssW = canvas.width / r;
  const cssH = canvas.height / r;
  const map = getMap(scene.mapAssetId);
  const fallbackCx = map ? map.pixelW / 2 : cssW / 2;
  const fallbackCy = map ? map.pixelH / 2 : cssH / 2;
  const cam = sampleCamera(scene, state.rt.sceneTime, fallbackCx, fallbackCy);
  const userZoom = (state.rt as { previewZoom?: number }).previewZoom ?? 1;
  const zoom = clamp(cam.zoom * userZoom, 0.2, 6);
  const wx = cam.x + (screenX - cssW / 2) / zoom;
  const wy = cam.y + (screenY - cssH / 2) / zoom;
  return { x: wx, y: wy };
}

// 외부 모듈에서 맵 사이즈 알고 싶을 때.
export function currentMap(): TileMap | null {
  return getMap(activeScene().mapAssetId);
}

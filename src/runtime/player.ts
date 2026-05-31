// 컷씬 재생기 — 스튜디오가 export 한 JSON 을 게임 안에서 재생.
//
// 사용법 (예: 보스 등장 컷씬):
//
//   import { playCutscene } from './cutscene/player';
//   import intro from '/cutscenes/intro.json';
//
//   await playCutscene(intro, gameCanvas, { onComplete: () => startBossFight() });
//
// 동작:
//  1) 모든 씬의 맵을 사전 로드.
//  2) Canvas 위에 컷씬 렌더 시작 — 시간 흐름은 자동.
//  3) 전 씬을 끝까지 재생 후 onComplete 호출 + cleanup.
//  4) Skip: ESC 또는 Enter 누르면 즉시 종료 (옵션에서 끄기 가능).

import { loadMap, drawTileLayer } from '../lib/map';
import type { TileMap } from '../lib/map';
import { drawCharacter, prescaleCharacter, safeCharIdx } from '../lib/sprites';
import type { ExportedCutscene, ExportedScene } from '../export';
import type { Dir } from '../lib/types';

type CamKeyJSON = ExportedScene['camera']['keyframes'][number];

export interface PlayOptions {
  /** 전 씬 재생 완료 시 호출. cleanup 후 발화. */
  onComplete?: () => void;
  /** 스킵 키 활성화 (기본 true). false 면 끝까지 강제. */
  allowSkip?: boolean;
  /** BGM 출력 ON (기본 true). 본편 BGM 과 충돌 시 끄기. */
  bgm?: boolean;
}

export interface PlayHandle {
  /** 강제 중단 — onComplete 는 호출되지 않음. */
  cancel(): void;
}

export function playCutscene(
  json: ExportedCutscene,
  canvas: HTMLCanvasElement,
  opts: PlayOptions = {},
): PlayHandle {
  const allowSkip = opts.allowSkip !== false;
  const useBgm = opts.bgm !== false;
  prescaleCharacter(0.5);

  // 맵 로드 (병렬). 시작은 맵 로딩과 무관하게 즉시 빈 프레임부터 — 로딩 끝나는 대로 렌더에 합류.
  const mapById = new Map<string, TileMap>();
  for (const sc of json.scenes) {
    if (sc.map) {
      void loadMap(sc.map).then((m) => { mapById.set(sc.map!, m); }).catch((e) => {
        console.warn('[cutscene] map load fail', sc.map, e);
      });
    }
  }

  const ctx = canvas.getContext('2d', { alpha: false })!;

  let sceneIdx = 0;
  let sceneTime = 0;
  let lastNow = performance.now();
  let cancelled = false;
  let rafId = 0;

  const audio: { el: HTMLAudioElement | null; url: string | null } = { el: null, url: null };

  function syncAudio(sc: ExportedScene): void {
    if (!useBgm) { stopAudio(); return; }
    const url = sc.bgm.url;
    if (!url) { stopAudio(); return; }
    if (audio.url !== url) {
      stopAudio();
      audio.el = new Audio(url);
      audio.el.loop = sc.bgm.loop;
      audio.url = url;
      void audio.el.play().catch(() => { /* autoplay 차단 */ });
    } else if (audio.el) {
      audio.el.loop = sc.bgm.loop;
    }
    if (!audio.el) return;
    // 페이드 envelope
    const fi = Math.max(0, sc.bgm.fadeIn);
    const fo = Math.max(0, sc.bgm.fadeOut);
    let env = 1;
    if (fi > 0 && sceneTime < fi) env = sceneTime / fi;
    const rem = sc.duration - sceneTime;
    if (fo > 0 && rem < fo) env = Math.min(env, Math.max(0, rem / fo));
    audio.el.volume = Math.max(0, Math.min(1, sc.bgm.volume * env));
  }
  function stopAudio(): void {
    if (audio.el) {
      try { audio.el.pause(); } catch { /* noop */ }
      audio.el = null;
    }
    audio.url = null;
  }

  function onKey(e: KeyboardEvent): void {
    if (!allowSkip) return;
    if (e.code === 'Escape' || e.code === 'Enter' || e.code === 'Space') {
      e.preventDefault();
      finish();
    }
  }
  window.addEventListener('keydown', onKey);

  function loop(now: number): void {
    if (cancelled) return;
    const dt = Math.min(0.1, (now - lastNow) / 1000);
    lastNow = now;
    sceneTime += dt;
    const sc = json.scenes[sceneIdx];
    if (!sc) { finish(); return; }

    if (sceneTime >= sc.duration) {
      sceneIdx += 1;
      sceneTime = 0;
      if (sceneIdx >= json.scenes.length) { finish(); return; }
    }
    const cur = json.scenes[sceneIdx];
    syncAudio(cur);
    render(cur);
    rafId = requestAnimationFrame(loop);
  }
  rafId = requestAnimationFrame(loop);

  function finish(): void {
    cancelled = true;
    cancelAnimationFrame(rafId);
    window.removeEventListener('keydown', onKey);
    stopAudio();
    if (opts.onComplete) opts.onComplete();
  }

  function render(sc: ExportedScene): void {
    const cssW = canvas.clientWidth || canvas.width;
    const cssH = canvas.clientHeight || canvas.height;
    if (canvas.width !== cssW || canvas.height !== cssH) {
      // 백버퍼 동기화 (DPR 무시 — 컷씬은 게임 본편 캔버스 그대로 사용)
      canvas.width = cssW; canvas.height = cssH;
    }
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cssW, cssH);

    const map = sc.map ? mapById.get(sc.map) ?? null : null;
    const fallbackCx = map ? map.pixelW / 2 : cssW / 2;
    const fallbackCy = map ? map.pixelH / 2 : cssH / 2;
    const cam = sampleCam(sc, sceneTime, fallbackCx, fallbackCy);
    const zoom = Math.max(0.2, Math.min(6, cam.zoom));
    const worldViewW = cssW / zoom;
    const worldViewH = cssH / zoom;
    const worldX = cam.x - worldViewW / 2;
    const worldY = cam.y - worldViewH / 2;
    const nowSec = performance.now() / 1000;

    if (map) {
      ctx.save();
      ctx.scale(zoom, zoom);
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
      for (const layer of map.layers) {
        if (layer.kind !== 'tile' || drawn.has(layer.name)) continue;
        if (orderAbove.includes(layer.name)) continue;
        drawTileLayer(ctx, map, layer, worldX, worldY, worldViewW, worldViewH, nowSec);
      }
      // 캐릭터
      const samples = sc.tracks.map((trk) => ({ trk, s: sampleTrk(trk, sceneTime) }));
      samples.sort((a, b) => a.s.y - b.s.y);
      for (const { trk, s } of samples) {
        // 업로드 캐릭터는 trk.charSheetUrl 로 LPC 시트를 직접 fetch 해 렌더 (charIdx 는 -1 → 무시됨).
        drawCharacter(ctx, s.x - worldX, s.y - worldY, safeCharIdx(trk.charIdx), s.dir, s.walk, -1, false, nowSec, trk.charSheetUrl);
      }
      // 위 레이어
      for (const name of orderAbove) {
        const layer = map.layerByName.get(name);
        if (layer && layer.kind === 'tile') {
          drawTileLayer(ctx, map, layer, worldX, worldY, worldViewW, worldViewH, nowSec);
        }
      }
      ctx.restore();
    }

    // 말풍선 (스크린 좌표)
    drawBubbles(ctx, sc, sceneTime, zoom, worldX, worldY);

    // 전환 효과 (in)
    drawTransition(ctx, sc, sceneTime, cssW, cssH);

    // 스킵 안내
    if (allowSkip) {
      ctx.save();
      ctx.font = '12px Galmuri11, system-ui';
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.textAlign = 'right';
      ctx.fillText('ESC/Enter: skip', cssW - 12, cssH - 12);
      ctx.restore();
    }
  }

  return {
    cancel(): void {
      cancelled = true;
      cancelAnimationFrame(rafId);
      window.removeEventListener('keydown', onKey);
      stopAudio();
    },
  };
}

// ===== 보간 (스튜디오 stage.ts 와 동일 알고리즘) =====

function sampleTrk(trk: ExportedScene['tracks'][number], t: number):
  { x: number; y: number; dir: Dir; walk: boolean }
{
  const ks = trk.keyframes;
  if (ks.length === 0) return { x: trk.startX, y: trk.startY, dir: trk.startDir, walk: false };
  if (t <= ks[0].t) return { x: ks[0].x, y: ks[0].y, dir: ks[0].dir, walk: ks[0].walk };
  const last = ks[ks.length - 1];
  if (t >= last.t) return { x: last.x, y: last.y, dir: last.dir, walk: last.walk };
  for (let i = 0; i < ks.length - 1; i++) {
    const a = ks[i], b = ks[i + 1];
    if (t >= a.t && t < b.t) {
      const u = (t - a.t) / Math.max(0.0001, b.t - a.t);
      return {
        x: a.x + (b.x - a.x) * u,
        y: a.y + (b.y - a.y) * u,
        dir: u < 0.5 ? a.dir : b.dir,
        walk: a.walk || b.walk,
      };
    }
  }
  return { x: last.x, y: last.y, dir: last.dir, walk: false };
}

function sampleCam(sc: ExportedScene, t: number, fx: number, fy: number):
  { x: number; y: number; zoom: number }
{
  const ks = sc.camera.keyframes;
  if (ks.length === 0) return { x: fx, y: fy, zoom: 1 };
  const easeInOut = (u: number) => u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
  const resolve = (k: CamKeyJSON): { x: number; y: number; zoom: number } => {
    if (k.followTrackId) {
      const trk = sc.tracks.find((tt) => tt.id === k.followTrackId);
      if (trk) {
        const s = sampleTrk(trk, t);
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
      const sa = resolve(a), sb = resolve(b);
      return {
        x: sa.x + (sb.x - sa.x) * u,
        y: sa.y + (sb.y - sa.y) * u,
        zoom: sa.zoom + (sb.zoom - sa.zoom) * u,
      };
    }
  }
  return resolve(last);
}

// ===== 말풍선 / 전환 =====

function drawBubbles(
  ctx: CanvasRenderingContext2D, sc: ExportedScene, t: number,
  zoom: number, worldX: number, worldY: number,
): void {
  for (const bub of sc.bubbles) {
    if (t < bub.t || t > bub.t + bub.dur) continue;
    const trk = sc.tracks.find((tt) => tt.id === bub.trackId);
    if (!trk) continue;
    const s = sampleTrk(trk, t);
    let display = bub.text;
    if (bub.typewriter) {
      const chars = Math.min(bub.text.length, Math.floor((t - bub.t) * Math.max(1, bub.cps)));
      display = bub.text.slice(0, chars);
    }
    if (!display) continue;
    drawBubble(ctx, (s.x - worldX) * zoom, (s.y - worldY) * zoom - 48 * zoom, display);
  }
}
function drawBubble(ctx: CanvasRenderingContext2D, cx: number, cy: number, text: string): void {
  ctx.save();
  ctx.font = '11px Galmuri11, system-ui';
  ctx.textBaseline = 'middle';
  const padX = 7, padY = 5;
  const lines = wrapText(ctx, text, 200);
  const lineH = 14;
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + padX * 2;
  const h = lines.length * lineH + padY * 2;
  const x = cx - w / 2;
  const y = cy - h;
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 1;
  roundRect(ctx, x, y, w, h, 4);
  ctx.fill(); ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx - 5, y + h);
  ctx.lineTo(cx, y + h + 5);
  ctx.lineTo(cx + 5, y + h);
  ctx.closePath();
  ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#1a1a1a';
  ctx.textAlign = 'center';
  for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i], cx, y + padY + lineH / 2 + i * lineH);
  ctx.restore();
}
function wrapText(ctx: CanvasRenderingContext2D, s: string, maxW: number): string[] {
  const words = s.split(/\s+/);
  const out: string[] = []; let cur = '';
  for (const w of words) {
    const test = cur ? cur + ' ' + w : w;
    if (ctx.measureText(test).width <= maxW) cur = test;
    else { if (cur) out.push(cur); cur = w; }
  }
  if (cur) out.push(cur);
  return out.length ? out : [s];
}
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
function drawTransition(ctx: CanvasRenderingContext2D, sc: ExportedScene, t: number, w: number, h: number): void {
  const tr = sc.transitionIn;
  if (!tr || tr.dur <= 0 || tr.type === 'cut') return;
  if (t < 0 || t > tr.dur) return;
  const u = 1 - t / tr.dur;
  if (tr.type === 'fade-black') {
    ctx.fillStyle = `rgba(0,0,0,${u})`;
    ctx.fillRect(0, 0, w, h);
  } else if (tr.type === 'fade-white') {
    ctx.fillStyle = `rgba(255,255,255,${u})`;
    ctx.fillRect(0, 0, w, h);
  } else if (tr.type === 'wipe') {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w * u, h);
  }
}

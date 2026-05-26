// 우측 속성 패널. 선택된 항목에 따라 다른 폼.
//   - 말풍선 선택: 텍스트 / 시점 / 지속 / 타이프라이터 / cps
//   - 카메라 키 선택: t / x / y / zoom / ease / follow
//   - 캐릭터 트랙 선택: 이름 / startX/Y / startDir
//   - 아무것도 선택 안 함: 씬 메타 (duration / transitionIn / BGM 설정)

import { state, notify, activeScene, trackById, findAsset } from './state';
import type { CameraKey, Bubble, CharTrack, Scene } from './state';

let body!: HTMLElement;

export function initProps(): void {
  body = document.getElementById('props-body')!;
}

export function renderProps(): void {
  const scene = activeScene();

  // 우선순위: 말풍선 > 카메라키 > 트랙 > 씬
  if (state.rt.selectedBubbleId) {
    const b = scene.bubbles.find((x) => x.id === state.rt.selectedBubbleId);
    if (b) { renderBubbleProps(b); return; }
  }
  if (state.rt.selectedCamKey !== null && scene.camera.keyframes[state.rt.selectedCamKey]) {
    renderCamProps(scene.camera.keyframes[state.rt.selectedCamKey], state.rt.selectedCamKey);
    return;
  }
  if (state.rt.selectedTrackId && state.rt.selectedTrackId !== '__camera__' && state.rt.selectedTrackId !== '__bgm__') {
    const trk = trackById(scene, state.rt.selectedTrackId);
    if (trk) { renderTrackProps(trk); return; }
  }
  renderSceneProps(scene);
}

// ===== 말풍선 =====
function renderBubbleProps(b: Bubble): void {
  body.innerHTML = '';
  body.appendChild(h('div', 'st-props-section-title', '💬 말풍선'));
  const scene = activeScene();

  const charSel = sel('캐릭터', b.trackId, scene.tracks.map((t) => ({ value: t.id, label: t.name })), (v) => { b.trackId = v; notify(); });
  body.appendChild(charSel);

  body.appendChild(numberRow('시점 (sec)', b.t, 0, scene.duration, 0.05, (v) => { b.t = v; notify(); }));
  body.appendChild(numberRow('지속시간 (sec)', b.dur, 0.1, scene.duration, 0.05, (v) => { b.dur = v; notify(); }));

  body.appendChild(textareaRow('텍스트', b.text, (v) => { b.text = v; notify(); }));

  body.appendChild(checkboxRow('글자 하나씩 타이핑', b.typewriter, (v) => { b.typewriter = v; notify(); }));
  body.appendChild(rangeRow('속도 (글자/초)', b.cps, 5, 60, 1, (v) => { b.cps = v; notify(); }));

  body.appendChild(deleteBtn('💬 이 말풍선 삭제', () => {
    scene.bubbles = scene.bubbles.filter((x) => x.id !== b.id);
    state.rt.selectedBubbleId = null;
    notify();
  }));
}

// ===== 카메라 키프레임 =====
function renderCamProps(k: CameraKey, idx: number): void {
  body.innerHTML = '';
  body.appendChild(h('div', 'st-props-section-title', `🎥 카메라 키 #${idx + 1}`));
  const scene = activeScene();

  body.appendChild(numberRow('시점 (sec)', k.t, 0, scene.duration, 0.05, (v) => { k.t = v; scene.camera.keyframes.sort((a, b) => a.t - b.t); notify(); }));
  body.appendChild(numberRow('X (world)', k.x, -10000, 10000, 1, (v) => { k.x = v; notify(); }));
  body.appendChild(numberRow('Y (world)', k.y, -10000, 10000, 1, (v) => { k.y = v; notify(); }));
  body.appendChild(rangeRow('줌', k.zoom, 0.2, 4, 0.05, (v) => { k.zoom = v; notify(); }));

  const easeSel = sel('보간', k.ease, [
    { value: 'linear', label: 'linear' },
    { value: 'ease-in-out', label: 'ease-in-out' },
  ], (v) => { k.ease = v as 'linear' | 'ease-in-out'; notify(); });
  body.appendChild(easeSel);

  body.appendChild(sel('따라가기 (follow)', k.followTrackId ?? '', [
    { value: '', label: '(없음 — 고정 X/Y)' },
    ...scene.tracks.map((t) => ({ value: t.id, label: t.name })),
  ], (v) => { k.followTrackId = v || undefined; notify(); }));

  body.appendChild(deleteBtn('🎥 이 키프레임 삭제', () => {
    scene.camera.keyframes.splice(idx, 1);
    state.rt.selectedCamKey = null;
    notify();
  }));
}

// ===== 캐릭터 트랙 =====
function renderTrackProps(trk: CharTrack): void {
  body.innerHTML = '';
  body.appendChild(h('div', 'st-props-section-title', '👤 캐릭터 트랙'));
  body.appendChild(textRow('이름', trk.name, (v) => { trk.name = v; notify(); }));

  const asset = findAsset(trk.charAssetId);
  body.appendChild(infoRow('스프라이트', asset ? asset.name : '(없음)'));

  body.appendChild(numberRow('시작 X', trk.startX, -10000, 10000, 1, (v) => { trk.startX = v; notify(); }));
  body.appendChild(numberRow('시작 Y', trk.startY, -10000, 10000, 1, (v) => { trk.startY = v; notify(); }));
  body.appendChild(sel('시작 방향', trk.startDir, [
    { value: 'down', label: '↓ down' }, { value: 'up', label: '↑ up' },
    { value: 'left', label: '← left' }, { value: 'right', label: '→ right' },
  ], (v) => { trk.startDir = v as CharTrack['startDir']; notify(); }));

  body.appendChild(infoRow('녹화된 키프레임', String(trk.keyframes.length)));

  body.appendChild(h('div', 'st-props-section-title', ''));
  const clearBtn = h('button', 'st-btn', '🗑 녹화 지우기') as HTMLButtonElement;
  clearBtn.addEventListener('click', () => {
    trk.keyframes = [];
    trk.recorded = false;
    notify();
  });
  body.appendChild(clearBtn);
}

// ===== 씬 =====
function renderSceneProps(scene: Scene): void {
  body.innerHTML = '';
  body.appendChild(h('div', 'st-props-section-title', `🎞 ${scene.name}`));
  body.appendChild(textRow('이름', scene.name, (v) => { scene.name = v; notify(); }));
  body.appendChild(numberRow('길이 (sec)', scene.duration, 0.5, 600, 0.5, (v) => { scene.duration = v; notify(); }));

  body.appendChild(h('div', 'st-props-section-title', '전환 인'));
  body.appendChild(sel('타입', scene.transitionIn.type, [
    { value: 'cut', label: 'cut (즉시)' },
    { value: 'fade-black', label: 'fade to black' },
    { value: 'fade-white', label: 'fade to white' },
    { value: 'wipe', label: 'wipe' },
  ], (v) => { scene.transitionIn.type = v as Scene['transitionIn']['type']; notify(); }));
  body.appendChild(numberRow('지속 (sec)', scene.transitionIn.dur, 0, 5, 0.1, (v) => { scene.transitionIn.dur = v; notify(); }));

  body.appendChild(h('div', 'st-props-section-title', 'BGM'));
  const bgmAsset = findAsset(scene.bgm.assetId);
  body.appendChild(infoRow('파일', bgmAsset ? bgmAsset.name : '(빈에서 선택)'));
  body.appendChild(rangeRow('볼륨', scene.bgm.volume, 0, 1, 0.05, (v) => { scene.bgm.volume = v; notify(); }));
  body.appendChild(numberRow('페이드 인 (sec)', scene.bgm.fadeIn, 0, 10, 0.1, (v) => { scene.bgm.fadeIn = v; notify(); }));
  body.appendChild(numberRow('페이드 아웃 (sec)', scene.bgm.fadeOut, 0, 10, 0.1, (v) => { scene.bgm.fadeOut = v; notify(); }));
  body.appendChild(checkboxRow('루프', scene.bgm.loop, (v) => { scene.bgm.loop = v; notify(); }));
}

// ===== 폼 헬퍼 =====
function h(tag: string, cls: string, text?: string): HTMLElement {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}
function row(labelText: string): { wrap: HTMLElement; label: HTMLElement } {
  const wrap = h('div', 'st-props-row');
  const label = h('label', '', labelText);
  wrap.appendChild(label);
  return { wrap, label };
}
function textRow(labelText: string, val: string, onChange: (v: string) => void): HTMLElement {
  const { wrap } = row(labelText);
  const inp = document.createElement('input');
  inp.type = 'text'; inp.value = val;
  inp.addEventListener('input', () => onChange(inp.value));
  wrap.appendChild(inp);
  return wrap;
}
function textareaRow(labelText: string, val: string, onChange: (v: string) => void): HTMLElement {
  const { wrap } = row(labelText);
  const ta = document.createElement('textarea');
  ta.value = val;
  ta.addEventListener('input', () => onChange(ta.value));
  wrap.appendChild(ta);
  return wrap;
}
function numberRow(labelText: string, val: number, min: number, max: number, step: number, onChange: (v: number) => void): HTMLElement {
  const { wrap } = row(labelText);
  const inp = document.createElement('input');
  inp.type = 'number'; inp.min = String(min); inp.max = String(max); inp.step = String(step);
  inp.value = String(val);
  inp.addEventListener('input', () => {
    const v = parseFloat(inp.value);
    if (Number.isFinite(v)) onChange(v);
  });
  wrap.appendChild(inp);
  return wrap;
}
function rangeRow(labelText: string, val: number, min: number, max: number, step: number, onChange: (v: number) => void): HTMLElement {
  const { wrap } = row(labelText);
  const inner = h('div', 'range-with-val');
  const rng = document.createElement('input');
  rng.type = 'range'; rng.min = String(min); rng.max = String(max); rng.step = String(step);
  rng.value = String(val);
  const out = document.createElement('span');
  out.textContent = formatNum(val);
  rng.addEventListener('input', () => {
    const v = parseFloat(rng.value);
    out.textContent = formatNum(v);
    onChange(v);
  });
  inner.appendChild(rng);
  inner.appendChild(out);
  wrap.appendChild(inner);
  return wrap;
}
function checkboxRow(labelText: string, val: boolean, onChange: (v: boolean) => void): HTMLElement {
  const wrap = h('div', 'st-props-row');
  const lab = document.createElement('label');
  lab.style.cssText = 'display:flex;align-items:center;gap:8px;cursor:pointer;';
  const cb = document.createElement('input');
  cb.type = 'checkbox'; cb.checked = val;
  cb.addEventListener('change', () => onChange(cb.checked));
  lab.appendChild(cb);
  lab.appendChild(document.createTextNode(labelText));
  wrap.appendChild(lab);
  return wrap;
}
function sel(labelText: string, val: string, options: Array<{ value: string; label: string }>, onChange: (v: string) => void): HTMLElement {
  const { wrap } = row(labelText);
  const sl = document.createElement('select');
  for (const o of options) {
    const op = document.createElement('option');
    op.value = o.value; op.textContent = o.label;
    if (o.value === val) op.selected = true;
    sl.appendChild(op);
  }
  sl.addEventListener('change', () => onChange(sl.value));
  wrap.appendChild(sl);
  return wrap;
}
function infoRow(labelText: string, val: string): HTMLElement {
  const { wrap } = row(labelText);
  const div = document.createElement('div');
  div.style.cssText = 'color:#e6e6e6;font-size:12px;';
  div.textContent = val;
  wrap.appendChild(div);
  return wrap;
}
function deleteBtn(text: string, on: () => void): HTMLElement {
  const wrap = h('div', 'st-props-row');
  const btn = document.createElement('button');
  btn.className = 'st-btn';
  btn.style.color = '#ff8080';
  btn.textContent = text;
  btn.addEventListener('click', on);
  wrap.appendChild(btn);
  return wrap;
}
function formatNum(v: number): string {
  return Math.abs(v) < 10 ? v.toFixed(2) : v.toFixed(0);
}

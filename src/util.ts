// 공통 헬퍼.

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

export function fmtTime(sec: number): string {
  if (!Number.isFinite(sec)) sec = 0;
  return sec.toFixed(2);
}

export function showToast(msg: string, kind: 'ok' | 'err' = 'ok', ms = 1800): void {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('err', kind === 'err');
  // 에러는 즉시 announce, 일반 알림은 polite (스크린리더).
  el.setAttribute('aria-live', kind === 'err' ? 'assertive' : 'polite');
  el.classList.remove('hidden');
  window.clearTimeout((el as HTMLElement & { __t?: number }).__t);
  (el as HTMLElement & { __t?: number }).__t = window.setTimeout(() => {
    el.classList.add('hidden');
  }, ms);
}

/** 마우스/터치/펜 통합 드래그 — pointerdown 핸들러 안에서 호출.
 *  onMove 는 매 이동마다 (현재 x/y, 시작 x/y, dx, dy) 호출. */
export function startPointerDrag(
  e: PointerEvent,
  target: HTMLElement,
  onMove: (curX: number, curY: number, startX: number, startY: number, dx: number, dy: number) => void,
  onEnd?: () => void,
): void {
  const startX = e.clientX, startY = e.clientY;
  try { target.setPointerCapture(e.pointerId); } catch { /* noop */ }
  const move = (ev: PointerEvent) => {
    if (ev.pointerId !== e.pointerId) return;
    onMove(ev.clientX, ev.clientY, startX, startY, ev.clientX - startX, ev.clientY - startY);
  };
  const end = (ev: PointerEvent) => {
    if (ev.pointerId !== e.pointerId) return;
    target.removeEventListener('pointermove', move);
    target.removeEventListener('pointerup', end);
    target.removeEventListener('pointercancel', end);
    if (onEnd) onEnd();
  };
  target.addEventListener('pointermove', move);
  target.addEventListener('pointerup', end);
  target.addEventListener('pointercancel', end);
}

export function downloadJson(filename: string, data: unknown): void {
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

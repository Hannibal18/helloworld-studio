// 통합 입력 — 키보드 WASD + 가상 조이스틱. playback.ts 가 매 프레임 inputVector() 호출.
//
// 둘 다 활성이면 합산 후 정규화 (모바일 + 외장키보드 동시 사용 가능).

const keys = new Set<string>();
let stickX = 0; // -1..1
let stickY = 0;

export function initKeyboard(): void {
  window.addEventListener('keydown', (e) => {
    const tgt = e.target as HTMLElement | null;
    if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) return;
    keys.add(e.code);
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  // 탭 전환 등으로 keyup 누락 → stuck 방지
  window.addEventListener('blur', () => keys.clear());
}

export function setStick(x: number, y: number): void {
  stickX = clampUnit(x);
  stickY = clampUnit(y);
}
function clampUnit(v: number): number { return v < -1 ? -1 : v > 1 ? 1 : v; }

/** 이동 벡터 — 정규화 안 됐을 수 있음 (호출 측에서 hypot/norm). */
export function inputVector(): { x: number; y: number } {
  const kx = (keys.has('KeyA') || keys.has('ArrowLeft')  ? -1 : 0)
           + (keys.has('KeyD') || keys.has('ArrowRight') ?  1 : 0);
  const ky = (keys.has('KeyW') || keys.has('ArrowUp')    ? -1 : 0)
           + (keys.has('KeyS') || keys.has('ArrowDown')  ?  1 : 0);
  // 합산 후 단위벡터 이내로 clamp.
  const x = clampUnit(kx + stickX);
  const y = clampUnit(ky + stickY);
  return { x, y };
}

export function isAnyInputPressed(): boolean {
  return keys.size > 0 || Math.hypot(stickX, stickY) > 0.05;
}

/** 디버그용 — 현재 stick 값 보기. */
export function getStick(): { x: number; y: number } {
  return { x: stickX, y: stickY };
}

export function isTouchDevice(): boolean {
  return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
}

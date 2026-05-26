// LPC Universal Spritesheet 의 액션 자동 검출.
//
// 시트 표준 레이아웃 (832×3456, 64px 프레임, 13 columns × 54 rows):
//   각 액션은 row 그룹 + 방향(up/left/down/right) + cycle 프레임 인덱스.
//   row 매핑은 Universal-LPC-Spritesheet-Character-Generator 의
//   sources/state/constants.ts ANIMATION_CONFIGS 와 동일.
//
// 검출 알고리즘:
//   액션마다 (row × num) 영역의 각 cycle frame 중앙 픽셀 알파를 샘플링.
//   하나라도 알파 > 16 인 픽셀이 있으면 그 액션은 '사용 가능'.
//   walk 는 idle frame(col 0) 이 모든 캐릭터에 있어 cycle 에서 0 빠진 [1..8] 만 검사.

export const FRAME_SIZE = 64;
export const SHEET_W = 832;       // 13 × 64
export const SHEET_H = 3456;      // 54 × 64

export interface AnimationConfig {
  row: number;        // 시작 row 인덱스
  num: number;        // 방향(row) 개수 (1 = 단일 row, 4 = up/left/down/right)
  cycle: number[];    // 검사할 col 인덱스 모음
  label: string;      // 사람이 읽는 라벨
}

export const ANIMATION_CONFIGS: Record<string, AnimationConfig> = {
  spellcast:    { row: 0,  num: 4, cycle: [0, 1, 2, 3, 4, 5, 6],                  label: 'Spellcast' },
  thrust:       { row: 4,  num: 4, cycle: [0, 1, 2, 3, 4, 5, 6, 7],               label: 'Thrust' },
  walk:         { row: 8,  num: 4, cycle: [1, 2, 3, 4, 5, 6, 7, 8],               label: 'Walk' },
  slash:        { row: 12, num: 4, cycle: [0, 1, 2, 3, 4, 5],                     label: 'Slash' },
  shoot:        { row: 16, num: 4, cycle: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], label: 'Shoot' },
  hurt:         { row: 20, num: 1, cycle: [0, 1, 2, 3, 4, 5],                     label: 'Hurt' },
  climb:        { row: 21, num: 1, cycle: [0, 1, 2, 3, 4, 5],                     label: 'Climb' },
  idle:         { row: 22, num: 4, cycle: [0, 1],                                 label: 'Idle' },
  jump:         { row: 26, num: 4, cycle: [0, 1, 2, 3, 4],                        label: 'Jump' },
  sit:          { row: 30, num: 4, cycle: [0, 1, 2],                              label: 'Sit' },
  emote:        { row: 34, num: 4, cycle: [0, 1, 2],                              label: 'Emote' },
  run:          { row: 38, num: 4, cycle: [0, 1, 2, 3, 4, 5, 6, 7],               label: 'Run' },
  combat:       { row: 42, num: 4, cycle: [0, 1],                                 label: 'Combat idle' },
  '1h_backslash': { row: 46, num: 4, cycle: [0, 1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12], label: 'Backslash' },
  '1h_halfslash': { row: 50, num: 4, cycle: [0, 1, 2, 3, 4, 5],                   label: 'Halfslash' },
};

export type LPCAction = keyof typeof ANIMATION_CONFIGS;

const ALPHA_THRESHOLD = 16;       // 0~255. 매우 옅은 잔여 픽셀 무시

/** PNG File → 사용 가능한 액션 목록.
 *  - 표준(832×3456): 그대로 검출.
 *  - 오버사이즈(예: 1664×4992): 큰 무기 프레임 때문에 확장된 시트. 좌상단의 표준 영역에서 검출.
 *  - 가로/세로가 standard 의 정수배라고 가정 (LPC 생성기 출력은 64 픽셀 단위). */
export async function detectActionsFromFile(file: File): Promise<{
  actions: LPCAction[];
  width: number;
  height: number;
  standard: boolean;        // 표준 (832×3456) 또는 그 정수배인가
  variant: 'standard' | 'oversize';
}> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const w = img.naturalWidth, h = img.naturalHeight;

    // 좌상단에 표준 영역이 들어갈 수 있는지 (오버사이즈도 받아들임)
    const isAcceptable = w >= SHEET_W && h >= SHEET_H
      && (w % FRAME_SIZE === 0) && (h % FRAME_SIZE === 0);
    if (!isAcceptable) {
      return { actions: [], width: w, height: h, standard: false, variant: 'standard' };
    }
    const variant = (w === SHEET_W && h === SHEET_H) ? 'standard' : 'oversize';

    // ImageData 추출 — 표준 영역만 (오버사이즈여도 표준 액션은 여기 있음)
    const cnv = document.createElement('canvas');
    cnv.width = SHEET_W; cnv.height = SHEET_H;
    const ctx = cnv.getContext('2d', { willReadFrequently: true });
    if (!ctx) return { actions: [], width: w, height: h, standard: true, variant };
    ctx.imageSmoothingEnabled = false;
    // 큰 시트의 좌상단 SHEET_W × SHEET_H 만 잘라 그림
    ctx.drawImage(img, 0, 0, SHEET_W, SHEET_H, 0, 0, SHEET_W, SHEET_H);
    const data = ctx.getImageData(0, 0, SHEET_W, SHEET_H).data;

    const actions: LPCAction[] = [];
    for (const [name, cfg] of Object.entries(ANIMATION_CONFIGS) as [LPCAction, AnimationConfig][]) {
      if (hasAnyContent(data, SHEET_W, cfg)) actions.push(name);
    }
    return { actions, width: w, height: h, standard: true, variant };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** 같은 액션을 이미 업로드된 PNG URL 에서 검출 (라이브러리 lazy 검출용). */
export async function detectActionsFromUrl(url: string): Promise<LPCAction[]> {
  const img = await loadImage(url);
  const w = img.naturalWidth, h = img.naturalHeight;
  if (w < SHEET_W || h < SHEET_H) return [];
  const cnv = document.createElement('canvas');
  cnv.width = SHEET_W; cnv.height = SHEET_H;
  const ctx = cnv.getContext('2d', { willReadFrequently: true });
  if (!ctx) return [];
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, 0, 0, SHEET_W, SHEET_H, 0, 0, SHEET_W, SHEET_H);
  const data = ctx.getImageData(0, 0, SHEET_W, SHEET_H).data;
  const out: LPCAction[] = [];
  for (const [name, cfg] of Object.entries(ANIMATION_CONFIGS) as [LPCAction, AnimationConfig][]) {
    if (hasAnyContent(data, SHEET_W, cfg)) out.push(name);
  }
  return out;
}

function hasAnyContent(data: Uint8ClampedArray, w: number, cfg: AnimationConfig): boolean {
  for (let r = 0; r < cfg.num; r++) {
    for (const col of cfg.cycle) {
      // 프레임 중심점
      const px = col * FRAME_SIZE + (FRAME_SIZE >> 1);
      const py = (cfg.row + r) * FRAME_SIZE + (FRAME_SIZE >> 1);
      const idx = (py * w + px) * 4;
      if (data[idx + 3] > ALPHA_THRESHOLD) return true;
      // 보정: 중앙이 비어도 캐릭터가 비대칭이면 frame 의 다른 지점이 있을 수 있어
      // 추가로 9-grid 안 4개 점을 더 검사 (총 5 점/프레임)
      const offsets = [-16, 16];
      for (const dy of offsets) for (const dx of offsets) {
        const i2 = ((py + dy) * w + (px + dx)) * 4;
        if (data[i2 + 3] > ALPHA_THRESHOLD) return true;
      }
    }
  }
  return false;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(e);
    img.src = src;
  });
}

// 매핑된 비-LPC 시트들을 표준 832×3456 LPC 시트로 굽는다 (브라우저 canvas).
//
// 모델: 각 업로드 시트는 한 애니메이션(idle/walk/run)이고, 시트의 각 행에 방향(up/down/left/right)을
// 지정한다. 그 매핑으로 LPC 표준 행에 배치:
//   - idle  → idle 행(22~25) col0,1  (라이브러리 디테일 패널이 자동재생) + walk 행 col0 (정지 포즈)
//   - walk  → walk 행(8~11)  col1~8  (라이브러리 "Walk" / 걷기 사이클)
//   - run   → run  행(38~41) col0~7  (스튜디오 이동 + 라이브러리 "Run")
//
// 스튜디오 drawCharacter: 멈춤=walk행 col0(정적), 이동=run행 col0~7. 라이브러리 playAction:
// 액션별 행을 cycle 로 재생(idle=22, walk=8 [1..8], run=38 [0..7]).

import type { Dir } from '../lib/types';
import type { ParsedSheet } from './tiled';

const F_LPC = 64;
const SHEET_W = 832;   // 13 cols
const SHEET_H = 3456;  // 54 rows
const FOOT_DEST = 58;  // sprites.ts SOURCE_FOOT_Y

// LPC 방향 행 오프셋 — up/left/down/right = base+0/1/2/3 (sprites.ts ROW_WALK 와 일치).
const DIR_OFFSET: Record<Dir, number> = { up: 0, left: 1, down: 2, right: 3 };
const ROW_WALK_BASE = 8;
const ROW_IDLE_BASE = 22;  // ANIMATION_CONFIGS.idle.row
const ROW_RUN_BASE = 38;
export const DIRS: readonly Dir[] = ['up', 'left', 'down', 'right'];

export type AnimType = 'idle' | 'walk' | 'run' | 'none';
export const ANIM_TYPES: readonly AnimType[] = ['idle', 'walk', 'run'];

export interface SheetMapping {
  sheet: ParsedSheet;
  anim: AnimType;                 // 이 시트가 어떤 애니인지 (파일명 자동 + 사용자 수정)
  rowDir: Array<Dir | null>;      // index = sheet.rows 인덱스 → 지정된 방향(없으면 null)
}
export interface MappingConfig {
  sheets: SheetMapping[];
  scale: number;                  // 확대 배율 (기본 1.5)
  footSrc: number;                // 소스 프레임 안 발 y (기본 26)
}

/** N 슬롯에 M 프레임 고르게 매핑 (루프 위상 샘플링). */
export function phaseMap(slots: number, frames: number): number[] {
  if (frames <= 0) return new Array(slots).fill(0);
  return Array.from({ length: slots }, (_, i) => Math.round((i * frames) / slots) % frames);
}

export function tileTopLeft(sheet: ParsedSheet, tileId: number): { sx: number; sy: number } {
  return { sx: (tileId % sheet.cols) * sheet.tileW, sy: Math.floor(tileId / sheet.cols) * sheet.tileH };
}

/** 64×64 LPC 셀(cellX,cellY 좌상단)에 소스 타일을 균일 확대·발 정렬·셀 클립으로 그린다. */
export function blitTileToCell(
  ctx: CanvasRenderingContext2D, sheet: ParsedSheet, tileId: number,
  cellX: number, cellY: number, scale: number, footSrc: number,
): void {
  const { sx, sy } = tileTopLeft(sheet, tileId);
  const offX = Math.round((F_LPC - sheet.tileW * scale) / 2);
  const offY = Math.round(FOOT_DEST - footSrc * scale);
  ctx.save();
  ctx.beginPath();
  ctx.rect(cellX, cellY, F_LPC, F_LPC);
  ctx.clip();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(sheet.img, sx, sy, sheet.tileW, sheet.tileH,
    cellX + offX, cellY + offY, sheet.tileW * scale, sheet.tileH * scale);
  ctx.restore();
}

/** (애니타입, 방향) → 그 프레임 시퀀스가 있는 소스 {sheet, tileIds}. 없으면 null. */
export function findAnimRow(cfg: MappingConfig, anim: AnimType, dir: Dir): { sheet: ParsedSheet; tileIds: number[] } | null {
  for (const sm of cfg.sheets) {
    if (sm.anim !== anim) continue;
    const rowIdx = sm.rowDir.findIndex((d) => d === dir);
    if (rowIdx >= 0 && sm.sheet.rows[rowIdx]?.animTileIds.length) {
      return { sheet: sm.sheet, tileIds: sm.sheet.rows[rowIdx].animTileIds };
    }
  }
  return null;
}

/** 실제로 매핑된 애니 종류 (meta.actions 용). */
export function actionsPresent(cfg: MappingConfig): AnimType[] {
  return ANIM_TYPES.filter((a) =>
    cfg.sheets.some((sm) => sm.anim === a && sm.rowDir.some((d) => d !== null)));
}

export async function bakeLpcSheet(cfg: MappingConfig): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = SHEET_W;
  canvas.height = SHEET_H;
  const ctx = canvas.getContext('2d')!;

  for (const dir of DIRS) {
    const off = DIR_OFFSET[dir];
    const idleSrc = findAnimRow(cfg, 'idle', dir);
    const walkSrc = findAnimRow(cfg, 'walk', dir);
    const runSrc = findAnimRow(cfg, 'run', dir);
    // 한 종류만 올려도 스튜디오/라이브러리가 비지 않도록 교차 폴백.
    const walkCycle = walkSrc ?? runSrc;
    const runCycle = runSrc ?? walkSrc;
    const poseSrc = idleSrc ?? walkSrc ?? runSrc;

    // walk 행 col0 = 정지 포즈
    if (poseSrc) blitTileToCell(ctx, poseSrc.sheet, poseSrc.tileIds[0], 0, (ROW_WALK_BASE + off) * F_LPC, cfg.scale, cfg.footSrc);
    // walk 행 col1~8 = 걷기 사이클
    if (walkCycle) {
      phaseMap(8, walkCycle.tileIds.length).forEach((fi, i) =>
        blitTileToCell(ctx, walkCycle.sheet, walkCycle.tileIds[fi], (i + 1) * F_LPC, (ROW_WALK_BASE + off) * F_LPC, cfg.scale, cfg.footSrc));
    }
    // run 행 col0~7 = 달리기 사이클
    if (runCycle) {
      phaseMap(8, runCycle.tileIds.length).forEach((fi, i) =>
        blitTileToCell(ctx, runCycle.sheet, runCycle.tileIds[fi], i * F_LPC, (ROW_RUN_BASE + off) * F_LPC, cfg.scale, cfg.footSrc));
    }
    // idle 행(22~25) col0,1 = 라이브러리 idle 자동재생용 (2프레임)
    if (idleSrc) {
      const ids = idleSrc.tileIds;
      const f1 = ids[Math.floor(ids.length / 2)] ?? ids[0];
      blitTileToCell(ctx, idleSrc.sheet, ids[0], 0, (ROW_IDLE_BASE + off) * F_LPC, cfg.scale, cfg.footSrc);
      blitTileToCell(ctx, idleSrc.sheet, f1, 1 * F_LPC, (ROW_IDLE_BASE + off) * F_LPC, cfg.scale, cfg.footSrc);
    }
  }

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('LPC 시트 굽기 실패 (canvas.toBlob).');
  return blob;
}

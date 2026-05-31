// 매핑된 비-LPC 시트들을 표준 832×3456 LPC 시트로 굽는다 (브라우저 canvas).
// scripts/build-fox-lpc.mjs (Node/pngjs) 의 브라우저 포팅 — 로직 동일.
//
// 스튜디오/런타임 drawCharacter 는 멈춤이면 ROW_WALK[dir] col0, 이동이면 ROW_RUN[dir] col0~7 만
// 읽는다. 따라서:
//   - walk 행 col0   ← idle 소스 정지 포즈
//   - walk 행 col1~8 ← 이동 사이클 (완전한 LPC 행을 위해 채움 — 편집기는 미사용)
//   - run  행 col0~7 ← 이동 사이클 (실제 이동 모션)

import type { Dir } from '../lib/types';
import type { ParsedSheet } from './tiled';

const F_LPC = 64;
const SHEET_W = 832;   // 13 cols
const SHEET_H = 3456;  // 54 rows
const FOOT_DEST = 58;  // sprites.ts SOURCE_FOOT_Y

// sprites.ts ROW_WALK / ROW_RUN 와 일치해야 함.
const ROW_WALK: Record<Dir, number> = { up: 8, left: 9, down: 10, right: 11 };
const ROW_RUN: Record<Dir, number> = { up: 38, left: 39, down: 40, right: 41 };
export const DIRS: readonly Dir[] = ['up', 'left', 'down', 'right'];

export interface SheetRoleMapping {
  sheet: ParsedSheet;
  /** 방향 → sheet.rows 의 인덱스. */
  dirRow: Record<Dir, number>;
}
export interface MappingConfig {
  idle: SheetRoleMapping;    // 정지 포즈 소스
  moving: SheetRoleMapping;  // 이동(달리기/걷기) 사이클 소스
  scale: number;             // 여우 확대 배율 (기본 1.5)
  footSrc: number;           // 소스 프레임 안 발 y (기본 26)
}

/** N 슬롯에 M 프레임을 고르게 매핑(루프 위상 샘플링). 8←6 = [0,1,2,2,3,4,5,5] */
export function phaseMap(slots: number, frames: number): number[] {
  if (frames <= 0) return new Array(slots).fill(0);
  return Array.from({ length: slots }, (_, i) => Math.round((i * frames) / slots) % frames);
}

/** 시트 내 tileId → 픽셀 좌상단. */
export function tileTopLeft(sheet: ParsedSheet, tileId: number): { sx: number; sy: number } {
  return {
    sx: (tileId % sheet.cols) * sheet.tileW,
    sy: Math.floor(tileId / sheet.cols) * sheet.tileH,
  };
}

/** 64×64 LPC 셀 좌상단 기준, 소스 타일을 균일 확대·발 정렬·셀 클립으로 그린다. */
export function blitTileToCell(
  ctx: CanvasRenderingContext2D,
  sheet: ParsedSheet,
  tileId: number,
  cellX: number,
  cellY: number,
  scale: number,
  footSrc: number,
): void {
  const { sx, sy } = tileTopLeft(sheet, tileId);
  const offX = Math.round((F_LPC - sheet.tileW * scale) / 2);
  const offY = Math.round(FOOT_DEST - footSrc * scale);
  ctx.save();
  ctx.beginPath();
  ctx.rect(cellX, cellY, F_LPC, F_LPC);
  ctx.clip();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(
    sheet.img, sx, sy, sheet.tileW, sheet.tileH,
    cellX + offX, cellY + offY, sheet.tileW * scale, sheet.tileH * scale,
  );
  ctx.restore();
}

export async function bakeLpcSheet(cfg: MappingConfig): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = SHEET_W;
  canvas.height = SHEET_H;
  const ctx = canvas.getContext('2d')!;

  for (const dir of DIRS) {
    const idleRow = cfg.idle.sheet.rows[cfg.idle.dirRow[dir]];
    const moveRow = cfg.moving.sheet.rows[cfg.moving.dirRow[dir]];
    if (!idleRow || !moveRow || idleRow.animTileIds.length === 0 || moveRow.animTileIds.length === 0) continue;

    const wRow = ROW_WALK[dir];
    const rRow = ROW_RUN[dir];
    const idleFrame0 = idleRow.animTileIds[0];
    const moveIds = moveRow.animTileIds;
    const cycle = phaseMap(8, moveIds.length);

    // walk col0 = idle 정지 포즈 (cellX = 0)
    blitTileToCell(ctx, cfg.idle.sheet, idleFrame0, 0, wRow * F_LPC, cfg.scale, cfg.footSrc);
    // walk col1~8 = 이동 사이클
    cycle.forEach((fi, i) => blitTileToCell(ctx, cfg.moving.sheet, moveIds[fi], (i + 1) * F_LPC, wRow * F_LPC, cfg.scale, cfg.footSrc));
    // run col0~7 = 이동 사이클
    cycle.forEach((fi, i) => blitTileToCell(ctx, cfg.moving.sheet, moveIds[fi], i * F_LPC, rRow * F_LPC, cfg.scale, cfg.footSrc));
  }

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('LPC 시트 굽기 실패 (canvas.toBlob).');
  return blob;
}

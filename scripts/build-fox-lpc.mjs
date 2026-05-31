// [참고용 / 레퍼런스] 이 Node 스크립트는 src/char-import/ 의 인-앱 임포트 에디터로 대체됨.
//   bake 로직(phaseMap·blit·발 정렬)의 원본이며, 브라우저 포팅은 src/char-import/bake.ts.
//   pngjs 의존성은 제거됨 — 이 스크립트를 직접 돌리려면 `npm i -D pngjs` 필요.
//
// 여우 스프라이트(3장의 32×32 시트)를 LPC 64×64 규격 단일 시트로 변환한다.
// 결과: public/sprites/characters/09.png (832×3456, 13col × 54row, 기존 LPC 시트와 동일 치수)
//
//   실행:  node scripts/build-fox-lpc.mjs
//
// 편집기/런타임의 drawCharacter() 는 캐릭터가 멈추면 ROW_WALK[dir] col0(정지 포즈),
// 이동하면 ROW_RUN[dir] col0~7 (12fps 루프) 만 읽는다. 따라서:
//   - LPC walk 행 col0   ← 여우 idle 정지 포즈
//   - LPC walk 행 col1~8 ← 여우 walk 사이클 (완전한 LPC 행을 위해 채우지만 편집기는 미사용)
//   - LPC run  행 col0~7 ← 여우 run 사이클 (실제 이동 모션)
//
// 방향 매핑은 시트마다 다르다 — Fox_Run 은 측면 좌/우가 Idle/Walk 과 반대로 배치돼 있다
// (scripts/analyze-fox.mjs 로 확인: Run row2=right, row3=left). 이를 반영하지 않으면
// 달릴 때 좌우가 거울처럼 뒤집힌다.
import { PNG } from 'pngjs';
import { readFileSync, writeFileSync } from 'node:fs';

const FOX_DIR = '/Users/han/Developer/Tiled/99 assets/fox';
const OUT = new URL('../public/sprites/characters/09.png', import.meta.url);

// ===== 튜닝 상수 =====
const F_SRC = 32;          // 여우 원본 프레임
const F_LPC = 64;          // LPC 프레임
const COLS = 13, ROWS = 54;
const SHEET_W = COLS * F_LPC;  // 832
const SHEET_H = ROWS * F_LPC;  // 3456
const SCALE = 1.5;         // 여우 확대 배율 — 사람(LPC) 대비 약 0.65 키. 너무 크면 줄이기.
const FOOT_SRC = 26;       // 여우 원본 프레임 안에서 발이 닿는 y (analyze-fox 의 footY 다수값)
const FOOT_DEST = 58;      // LPC 프레임 안에서 발 y (sprites.ts SOURCE_FOOT_Y)

// LPC 표준 행 (sprites.ts ROW_WALK / ROW_RUN 와 일치)
const ROW_WALK = { up: 8,  left: 9,  down: 10, right: 11 };
const ROW_RUN  = { up: 38, left: 39, down: 40, right: 41 };
const DIRS = ['up', 'left', 'down', 'right'];

// 여우 시트별 (방향 → 행) 매핑.
//   Idle/Walk:  down=0, up=1, left=2, right=3
//   Run:        down=0, up=1, left=3, right=2   ← 측면 좌/우 반전!
const FOX_ROW_IDLEWALK = { down: 0, up: 1, left: 2, right: 3 };
const FOX_ROW_RUN      = { down: 0, up: 1, left: 3, right: 2 };

function load(name) {
  return PNG.sync.read(readFileSync(`${FOX_DIR}/${name}`));
}
const idle = load('Fox_Idle.png');  // 4col × 4row
const walk = load('Fox_walk.png');  // 6col × 4row
const run  = load('Fox_Run.png');   // 6col × 4row

const out = new PNG({ width: SHEET_W, height: SHEET_H }); // 기본 전부 투명(0,0,0,0)

// 여우 한 프레임(src 32×32 셀)을 LPC 셀(dst 64×64) 에 균일 확대(nearest)·발 정렬로 합성.
// 프레임마다 동일한 변환을 적용 → 원본이 가진 내부 정렬을 보존(애니 떨림 없음).
function blit(srcPng, foxRow, foxCol, destRow, destCol) {
  const sx0 = foxCol * F_SRC, sy0 = foxRow * F_SRC;
  const cellX = destCol * F_LPC, cellY = destRow * F_LPC;
  // 셀 내부 배치 오프셋 — 가로 가운데, 발(FOOT_SRC) 을 FOOT_DEST 에 맞춤
  const offX = Math.round((F_LPC - F_SRC * SCALE) / 2);
  const offY = Math.round(FOOT_DEST - FOOT_SRC * SCALE);
  const dim = Math.round(F_SRC * SCALE);
  for (let dy = 0; dy < dim; dy++) {
    const localY = offY + dy;
    if (localY < 0 || localY >= F_LPC) continue;       // 셀 밖(아래 셀 침범) 클립
    const sy = Math.min(F_SRC - 1, Math.floor(dy / SCALE));
    for (let dx = 0; dx < dim; dx++) {
      const localX = offX + dx;
      if (localX < 0 || localX >= F_LPC) continue;
      const sx = Math.min(F_SRC - 1, Math.floor(dx / SCALE));
      const si = ((sy0 + sy) * srcPng.width + (sx0 + sx)) * 4;
      const a = srcPng.data[si + 3];
      if (a <= 8) continue;
      const di = ((cellY + localY) * SHEET_W + (cellX + localX)) * 4;
      out.data[di]     = srcPng.data[si];
      out.data[di + 1] = srcPng.data[si + 1];
      out.data[di + 2] = srcPng.data[si + 2];
      out.data[di + 3] = a;
    }
  }
}

// N 슬롯에 M 프레임을 고르게 매핑(루프 위상 샘플링). 8←6 = [0,1,2,2,3,4,5,5]
function phaseMap(slots, frames) {
  return Array.from({ length: slots }, (_, i) => Math.round((i * frames) / slots) % frames);
}
const WALK_CYCLE = phaseMap(8, 6); // walk col1~8 (편집기 미사용, 완전성용)
const RUN_CYCLE  = phaseMap(8, 6); // run  col0~7 (실제 이동 모션)

for (const dir of DIRS) {
  const wRow = ROW_WALK[dir];
  const rRow = ROW_RUN[dir];
  const fIdleWalkRow = FOX_ROW_IDLEWALK[dir];
  const fRunRow = FOX_ROW_RUN[dir];

  // walk col0 = idle 정지 포즈 (여우 idle frame0)
  blit(idle, fIdleWalkRow, 0, wRow, 0);
  // walk col1~8 = 여우 walk 사이클
  WALK_CYCLE.forEach((fc, i) => blit(walk, fIdleWalkRow, fc, wRow, i + 1));
  // run col0~7 = 여우 run 사이클
  RUN_CYCLE.forEach((fc, i) => blit(run, fRunRow, fc, rRow, i));
}

writeFileSync(OUT, PNG.sync.write(out));
console.log(`✓ wrote ${OUT.pathname}  (${SHEET_W}x${SHEET_H}, scale=${SCALE}, footSrc=${FOOT_SRC})`);

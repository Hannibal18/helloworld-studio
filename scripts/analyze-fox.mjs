// 여우 스프라이트 분석 — LPC 변환 전에 방향 순서/발 위치/콘텐츠 경계를 파악한다.
// 실행: node scripts/analyze-fox.mjs
import { PNG } from 'pngjs';
import { readFileSync, writeFileSync } from 'node:fs';

const FOX_DIR = '/Users/han/Developer/Tiled/99 assets/fox';

function load(name) {
  return PNG.sync.read(readFileSync(`${FOX_DIR}/${name}`));
}

// 한 프레임(셀)의 알파 바운딩박스 + 발 y(=가장 아래 불투명 픽셀)를 구한다.
function frameBounds(png, fx, fy, F) {
  let minX = F, minY = F, maxX = -1, maxY = -1;
  for (let y = 0; y < F; y++) {
    for (let x = 0; x < F; x++) {
      const i = ((fy + y) * png.width + (fx + x)) * 4;
      const a = png.data[i + 3];
      if (a > 16) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { minX, minY, maxX, maxY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

function analyze(name, cols, rows, F) {
  const png = load(name);
  console.log(`\n=== ${name} (${png.width}x${png.height}, ${cols}col x ${rows}row, F=${F}) ===`);
  for (let r = 0; r < rows; r++) {
    const cells = [];
    for (let c = 0; c < cols; c++) {
      const b = frameBounds(png, c * F, r * F, F);
      cells.push(b);
    }
    // 행 전체 합산 바운딩박스 (방향 식별/배치 기준)
    const valid = cells.filter(Boolean);
    if (!valid.length) { console.log(`  row ${r}: (empty)`); continue; }
    const minX = Math.min(...valid.map((b) => b.minX));
    const maxX = Math.max(...valid.map((b) => b.maxX));
    const minY = Math.min(...valid.map((b) => b.minY));
    const maxY = Math.max(...valid.map((b) => b.maxY));
    console.log(
      `  row ${r}: bbox x[${minX}..${maxX}] y[${minY}..${maxY}] ` +
      `w${maxX - minX + 1} h${maxY - minY + 1} footY(maxY)=${maxY}`,
    );
  }
  return png;
}

// 각 시트의 첫 프레임 한 행을 4배 확대해서 방향 식별용 PNG 로 저장.
function exportRowPreviews(png, name, cols, rows, F, scale) {
  // 각 행의 첫 프레임만 가로로 늘어놓는다.
  const out = new PNG({ width: F * scale, height: F * rows * scale });
  // 체커보드 배경 (투명 구분용)
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      const i = (y * out.width + x) * 4;
      const checker = ((x >> 3) + (y >> 3)) & 1 ? 60 : 90;
      out.data[i] = checker; out.data[i + 1] = checker; out.data[i + 2] = checker; out.data[i + 3] = 255;
    }
  }
  for (let r = 0; r < rows; r++) {
    for (let y = 0; y < F; y++) {
      for (let x = 0; x < F; x++) {
        const si = ((r * F + y) * png.width + x) * 4;
        const a = png.data[si + 3];
        if (a <= 16) continue;
        const R = png.data[si], G = png.data[si + 1], B = png.data[si + 2];
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            const ox = x * scale + sx;
            const oy = (r * F + y) * scale + sy;
            const di = (oy * out.width + ox) * 4;
            out.data[di] = R; out.data[di + 1] = G; out.data[di + 2] = B; out.data[di + 3] = 255;
          }
        }
      }
    }
  }
  const path = `/tmp/fox-preview-${name}.png`;
  writeFileSync(path, PNG.sync.write(out));
  console.log(`  preview -> ${path}`);
}

const idle = analyze('Fox_Idle.png', 4, 4, 32);
const walk = analyze('Fox_walk.png', 6, 4, 32);
const run = analyze('Fox_Run.png', 6, 4, 32);

exportRowPreviews(idle, 'idle', 4, 4, 32, 4);
exportRowPreviews(walk, 'walk', 6, 4, 32, 4);
exportRowPreviews(run, 'run', 6, 4, 32, 4);

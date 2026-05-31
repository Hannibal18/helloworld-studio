// 비-LPC 캐릭터 매핑 에디터 (모달).
//
// 업로드된 시트들의 방향·애니메이션을 사용자가 눈으로 매핑한다:
//   - 어느 시트가 정지(idle) / 이동(moving) 소스인지
//   - 시트별 행 → 방향(up/down/left/right)  (※ Fox_Run 처럼 시트마다 좌/우가 다를 수 있어 시트별로 둠)
//   - 확대 배율 / 발 위치
// 라이브 프리뷰로 즉시 확인 후 확정하면 표준 LPC 시트로 bake 한다.

import type { Dir } from '../lib/types';
import type { ParsedCharImport, ParsedSheet } from './tiled';
import {
  DIRS, bakeLpcSheet, blitTileToCell, phaseMap,
  type MappingConfig, type SheetRoleMapping,
} from './bake';

const DIR_LABEL: Record<Dir, string> = { up: '↑ 위', left: '← 왼', down: '↓ 아래', right: '→ 오른' };

interface RowMetric { i: number; w: number; h: number; topX: number; L: number; R: number; }

// 한 행 frame0 의 불투명 픽셀 분포 — 방향 자동추정용.
function rowFrame0Metric(sheet: ParsedSheet, rowIdx: number): RowMetric | null {
  const row = sheet.rows[rowIdx];
  if (!row || row.animTileIds.length === 0) return null;
  const tileId = row.animTileIds[0];
  const sx = (tileId % sheet.cols) * sheet.tileW;
  const sy = Math.floor(tileId / sheet.cols) * sheet.tileH;
  const c = document.createElement('canvas');
  c.width = sheet.tileW; c.height = sheet.tileH;
  const cx = c.getContext('2d')!;
  cx.drawImage(sheet.img, sx, sy, sheet.tileW, sheet.tileH, 0, 0, sheet.tileW, sheet.tileH);
  const data = cx.getImageData(0, 0, sheet.tileW, sheet.tileH).data;
  let minX = sheet.tileW, maxX = -1, minY = sheet.tileH, maxY = -1, topY = 9999, topX = 0, L = 0, R = 0;
  for (let y = 0; y < sheet.tileH; y++) {
    for (let x = 0; x < sheet.tileW; x++) {
      if (data[(y * sheet.tileW + x) * 4 + 3] <= 16) continue;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (y < topY) { topY = y; topX = x; }
      if (x < sheet.tileW / 2) L++; else R++;
    }
  }
  if (maxX < 0) return null;
  return { i: rowIdx, w: maxX - minX + 1, h: maxY - minY + 1, topX, L, R };
}

// 시트의 행들을 방향에 매핑 (best-effort). 4행 미만이거나 애매하면 순서대로 폴백.
function guessDirRows(sheet: ParsedSheet): Record<Dir, number> {
  const n = sheet.rows.length;
  const fallback: Record<Dir, number> = {
    up: Math.min(0, n - 1), left: Math.min(1, n - 1), down: Math.min(2, n - 1), right: Math.min(3, n - 1),
  };
  if (n < 4) return fallback;
  const m = [0, 1, 2, 3].map((i) => rowFrame0Metric(sheet, i)).filter((x): x is RowMetric => !!x);
  if (m.length < 4) return fallback;
  const vert = m.filter((x) => x.w < x.h).sort((a, b) => b.h - a.h);   // 세로형: 큰 키 = up(뒤+꼬리)
  const horiz = m.filter((x) => x.w >= x.h);
  if (vert.length < 2 || horiz.length < 2) return fallback;
  const left = horiz.find((x) => x.L > x.R) ?? horiz[0];               // 머리/질량 왼쪽 = 왼쪽 향함
  const right = horiz.find((x) => x !== left) ?? horiz[1];
  return { up: vert[0].i, down: vert[1].i, left: left.i, right: right.i };
}

function guessRoleIdx(sheets: ParsedSheet[], kw: RegExp, fallback: number): number {
  const i = sheets.findIndex((s) => kw.test(s.name));
  return i >= 0 ? i : fallback;
}

interface EditorResult { blob: Blob; name: string; }

export function openCharImportEditor(
  parsed: ParsedCharImport,
  onConfirm: (result: EditorResult | null) => void,
): void {
  const sheets = parsed.sheets;

  // ===== 상태 =====
  let idleIdx = guessRoleIdx(sheets, /idle/i, 0);
  let movingIdx = guessRoleIdx(sheets, /run/i, guessRoleIdx(sheets, /walk/i, sheets.length > 1 ? 1 : 0));
  // 시트별 방향행 추정 (캐시)
  const dirRowsBySheet = sheets.map((s) => guessDirRows(s));
  let scale = 1.5;
  let footSrc = 26;
  let done = false;

  const cfg = (): MappingConfig => ({
    idle: { sheet: sheets[idleIdx], dirRow: dirRowsBySheet[idleIdx] } as SheetRoleMapping,
    moving: { sheet: sheets[movingIdx], dirRow: dirRowsBySheet[movingIdx] } as SheetRoleMapping,
    scale, footSrc,
  });

  // ===== DOM =====
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;font:13px system-ui,sans-serif;color:#e8e8e8;';
  const panel = document.createElement('div');
  panel.style.cssText = 'background:#1f1f24;border:1px solid #3a3a42;border-radius:10px;max-width:720px;width:92%;max-height:90vh;overflow:auto;padding:18px 20px;box-shadow:0 12px 40px rgba(0,0,0,.5);';
  overlay.appendChild(panel);

  const h = document.createElement('div');
  h.style.cssText = 'font-size:15px;font-weight:700;margin-bottom:4px;';
  h.textContent = '🐾 커스텀 캐릭터 임포트 — 방향 · 애니 매핑';
  panel.appendChild(h);
  const sub = document.createElement('div');
  sub.style.cssText = 'color:#9a9aa2;margin-bottom:14px;font-size:12px;';
  sub.textContent = `비-LPC 시트 ${sheets.length}장 감지 (${sheets[0].tileW}×${sheets[0].tileH}). 아래에서 매핑을 확인/수정하세요.`;
  panel.appendChild(sub);

  // 이름
  const nameWrap = document.createElement('label');
  nameWrap.style.cssText = 'display:block;margin-bottom:14px;';
  nameWrap.innerHTML = '<span style="display:block;color:#b8b8c0;margin-bottom:4px;">이름</span>';
  const nameIn = document.createElement('input');
  nameIn.type = 'text';
  nameIn.value = sheets[0].name.replace(/[_\-]?(idle|walk|run)$/i, '') || 'character';
  nameIn.style.cssText = 'width:100%;box-sizing:border-box;padding:7px 9px;background:#15151a;border:1px solid #3a3a42;border-radius:6px;color:#e8e8e8;';
  nameWrap.appendChild(nameIn);
  panel.appendChild(nameWrap);

  // 역할 선택
  const mkSheetSelect = (selected: number, onChange: (i: number) => void): HTMLSelectElement => {
    const sel = document.createElement('select');
    sel.style.cssText = 'padding:6px 8px;background:#15151a;border:1px solid #3a3a42;border-radius:6px;color:#e8e8e8;';
    sheets.forEach((s, i) => {
      const o = document.createElement('option');
      o.value = String(i); o.textContent = s.name; if (i === selected) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', () => onChange(parseInt(sel.value, 10)));
    return sel;
  };

  const roleRow = document.createElement('div');
  roleRow.style.cssText = 'display:flex;gap:18px;flex-wrap:wrap;margin-bottom:14px;';
  panel.appendChild(roleRow);

  // 방향 매핑 섹션 (idle 시트 + moving 시트)
  const mapSection = document.createElement('div');
  mapSection.style.cssText = 'display:flex;gap:18px;flex-wrap:wrap;margin-bottom:14px;';
  panel.appendChild(mapSection);

  // 슬라이더
  const sliderRow = document.createElement('div');
  sliderRow.style.cssText = 'display:flex;gap:20px;align-items:center;margin-bottom:14px;flex-wrap:wrap;';
  const mkSlider = (label: string, min: number, max: number, step: number, val: number, onIn: (v: number) => void): HTMLElement => {
    const w = document.createElement('label');
    w.style.cssText = 'display:flex;align-items:center;gap:8px;';
    const sp = document.createElement('span'); sp.style.color = '#b8b8c0'; sp.textContent = label;
    const inp = document.createElement('input');
    inp.type = 'range'; inp.min = String(min); inp.max = String(max); inp.step = String(step); inp.value = String(val);
    const out = document.createElement('span'); out.style.cssText = 'color:#e8e8e8;min-width:34px;'; out.textContent = String(val);
    inp.addEventListener('input', () => { const v = parseFloat(inp.value); out.textContent = String(v); onIn(v); });
    w.append(sp, inp, out);
    return w;
  };
  sliderRow.append(
    mkSlider('크기', 0.5, 3, 0.1, scale, (v) => { scale = v; }),
    mkSlider('발 위치', 0, sheets[0].tileH, 1, footSrc, (v) => { footSrc = v; }),
  );
  panel.appendChild(sliderRow);

  // 프리뷰
  const prevWrap = document.createElement('div');
  prevWrap.style.cssText = 'margin-bottom:14px;';
  prevWrap.innerHTML = '<div style="color:#b8b8c0;margin-bottom:6px;">미리보기 (위: 정지 / 아래: 이동 · ↑ ← ↓ →)</div>';
  const preview = document.createElement('canvas');
  const PCELL = 72;
  preview.width = PCELL * 4; preview.height = PCELL * 2;
  preview.style.cssText = `width:${PCELL * 4}px;height:${PCELL * 2}px;background:#0e0e12;border:1px solid #3a3a42;border-radius:6px;image-rendering:pixelated;`;
  prevWrap.appendChild(preview);
  panel.appendChild(prevWrap);

  // 버튼
  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;';
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = '취소';
  cancelBtn.style.cssText = 'padding:8px 16px;background:#2a2a32;border:1px solid #3a3a42;border-radius:6px;color:#e8e8e8;cursor:pointer;';
  const okBtn = document.createElement('button');
  okBtn.textContent = '굽고 업로드';
  okBtn.style.cssText = 'padding:8px 16px;background:#3b82f6;border:1px solid #3b82f6;border-radius:6px;color:#fff;font-weight:600;cursor:pointer;';
  btnRow.append(cancelBtn, okBtn);
  panel.appendChild(btnRow);

  // ===== 방향 매핑 UI 빌드 (역할 변경 시 재구성) =====
  function buildDirMapping(): void {
    mapSection.innerHTML = '';
    const seen = new Set<number>();
    for (const sheetIdx of [idleIdx, movingIdx]) {
      if (seen.has(sheetIdx)) continue;   // 같은 시트면 한 번만
      seen.add(sheetIdx);
      const sheet = sheets[sheetIdx];
      const box = document.createElement('div');
      box.style.cssText = 'flex:1;min-width:200px;background:#15151a;border:1px solid #2e2e36;border-radius:8px;padding:10px;';
      const t = document.createElement('div');
      t.style.cssText = 'font-weight:600;margin-bottom:8px;';
      t.textContent = `${sheet.name} (행→방향)`;
      box.appendChild(t);
      const usedFor = (idleIdx === sheetIdx && movingIdx === sheetIdx) ? '정지+이동' : (idleIdx === sheetIdx ? '정지' : '이동');
      const note = document.createElement('div'); note.style.cssText = 'color:#7a7a82;font-size:11px;margin-bottom:8px;'; note.textContent = `역할: ${usedFor}`;
      box.appendChild(note);
      for (const dir of DIRS) {
        const r = document.createElement('label');
        r.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:5px;';
        const lab = document.createElement('span'); lab.style.cssText = 'width:54px;color:#b8b8c0;'; lab.textContent = DIR_LABEL[dir];
        const sel = document.createElement('select');
        sel.style.cssText = 'flex:1;padding:5px 7px;background:#0e0e12;border:1px solid #3a3a42;border-radius:5px;color:#e8e8e8;';
        sheet.rows.forEach((_, ri) => {
          const o = document.createElement('option'); o.value = String(ri); o.textContent = `행 ${ri}`;
          if (dirRowsBySheet[sheetIdx][dir] === ri) o.selected = true;
          sel.appendChild(o);
        });
        sel.addEventListener('change', () => { dirRowsBySheet[sheetIdx][dir] = parseInt(sel.value, 10); });
        r.append(lab, sel);
        box.appendChild(r);
      }
      mapSection.appendChild(box);
    }
  }

  function buildRoles(): void {
    roleRow.innerHTML = '';
    const idleW = document.createElement('label');
    idleW.style.cssText = 'display:flex;align-items:center;gap:8px;';
    idleW.innerHTML = '<span style="color:#b8b8c0;">정지(Idle) 시트</span>';
    idleW.appendChild(mkSheetSelect(idleIdx, (i) => { idleIdx = i; buildRoles(); buildDirMapping(); }));
    const movW = document.createElement('label');
    movW.style.cssText = 'display:flex;align-items:center;gap:8px;';
    movW.innerHTML = '<span style="color:#b8b8c0;">이동(Moving) 시트</span>';
    movW.appendChild(mkSheetSelect(movingIdx, (i) => { movingIdx = i; buildRoles(); buildDirMapping(); }));
    roleRow.append(idleW, movW);
  }

  buildRoles();
  buildDirMapping();

  // ===== 라이브 프리뷰 루프 =====
  const pctx = preview.getContext('2d')!;
  const cellCanvas = document.createElement('canvas'); cellCanvas.width = 64; cellCanvas.height = 64;
  const cellCtx = cellCanvas.getContext('2d')!;
  let raf = 0;
  function renderPreview(): void {
    const now = performance.now() / 1000;
    pctx.clearRect(0, 0, preview.width, preview.height);
    const c = cfg();
    DIRS.forEach((dir, col) => {
      // 위: 정지(idle frame0)
      const idleRow = c.idle.sheet.rows[c.idle.dirRow[dir]];
      if (idleRow && idleRow.animTileIds.length) {
        cellCtx.clearRect(0, 0, 64, 64);
        blitTileToCell(cellCtx, c.idle.sheet, idleRow.animTileIds[0], 0, 0, c.scale, c.footSrc);
        pctx.imageSmoothingEnabled = false;
        pctx.drawImage(cellCanvas, 0, 0, 64, 64, col * PCELL + (PCELL - 64) / 2, 0 + (PCELL - 64) / 2, 64, 64);
      }
      // 아래: 이동(run cadence 8프레임 루프)
      const moveRow = c.moving.sheet.rows[c.moving.dirRow[dir]];
      if (moveRow && moveRow.animTileIds.length) {
        const cyc = phaseMap(8, moveRow.animTileIds.length);
        const tile = moveRow.animTileIds[cyc[Math.floor(now * 12) % 8]];
        cellCtx.clearRect(0, 0, 64, 64);
        blitTileToCell(cellCtx, c.moving.sheet, tile, 0, 0, c.scale, c.footSrc);
        pctx.imageSmoothingEnabled = false;
        pctx.drawImage(cellCanvas, 0, 0, 64, 64, col * PCELL + (PCELL - 64) / 2, PCELL + (PCELL - 64) / 2, 64, 64);
      }
    });
    raf = requestAnimationFrame(renderPreview);
  }
  renderPreview();

  // ===== 닫기/확정 =====
  function close(result: EditorResult | null): void {
    if (done) return;
    done = true;
    cancelAnimationFrame(raf);
    overlay.remove();
    onConfirm(result);
  }
  cancelBtn.addEventListener('click', () => close(null));
  okBtn.addEventListener('click', async () => {
    okBtn.disabled = true; okBtn.textContent = '굽는 중…';
    try {
      const blob = await bakeLpcSheet(cfg());
      close({ blob, name: nameIn.value.trim() || 'character' });
    } catch (e) {
      okBtn.disabled = false; okBtn.textContent = '굽고 업로드';
      alert(`굽기 실패: ${(e as Error).message}`);
    }
  });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });

  document.body.appendChild(overlay);
  nameIn.focus();
}

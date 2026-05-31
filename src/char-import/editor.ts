// 비-LPC 캐릭터 매핑 에디터 (모달) — 단순 모델.
//
// 업로드한 시트들을 보여주고, 각 시트의 행에 방향(↑↓←→)만 지정한다.
// 애니 종류(idle/walk/run)는 파일명으로 자동 판별(드롭다운으로 수정 가능).
// 라이브 프리뷰로 확인 후 확정 → 표준 LPC 시트로 bake.

import type { Dir } from '../lib/types';
import type { ParsedCharImport, ParsedSheet } from './tiled';
import {
  DIRS, ANIM_TYPES, bakeLpcSheet, blitTileToCell, findAnimRow, actionsPresent,
  type AnimType, type MappingConfig, type SheetMapping,
} from './bake';

const DIR_LABEL: Record<Dir, string> = { up: '↑ 위', left: '← 왼', down: '↓ 아래', right: '→ 오른' };
const ANIM_LABEL: Record<AnimType, string> = { idle: '정지(Idle)', walk: '걷기(Walk)', run: '달리기(Run)', none: '제외' };

interface RowMetric { i: number; w: number; h: number; topX: number; L: number; R: number; }

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

// 시트의 각 행에 방향을 자동 추정 (best-effort). 결과: rowDir[행인덱스] = 방향|null.
function guessRowDirs(sheet: ParsedSheet): Array<Dir | null> {
  const n = sheet.rows.length;
  const rowDir: Array<Dir | null> = new Array(n).fill(null);
  const order: Dir[] = ['up', 'left', 'down', 'right'];
  if (n < 4) { for (let i = 0; i < n; i++) rowDir[i] = order[i] ?? null; return rowDir; }
  const m = [0, 1, 2, 3].map((i) => rowFrame0Metric(sheet, i)).filter((x): x is RowMetric => !!x);
  if (m.length < 4) { for (let i = 0; i < 4; i++) rowDir[i] = order[i]; return rowDir; }
  const vert = m.filter((x) => x.w < x.h).sort((a, b) => b.h - a.h);   // 세로형: 큰 키 = up
  const horiz = m.filter((x) => x.w >= x.h);
  if (vert.length < 2 || horiz.length < 2) { for (let i = 0; i < 4; i++) rowDir[i] = order[i]; return rowDir; }
  const left = horiz.find((x) => x.L > x.R) ?? horiz[0];
  const right = horiz.find((x) => x !== left) ?? horiz[1];
  rowDir[vert[0].i] = 'up'; rowDir[vert[1].i] = 'down'; rowDir[left.i] = 'left'; rowDir[right.i] = 'right';
  return rowDir;
}

function guessAnim(name: string): AnimType {
  const l = name.toLowerCase();
  if (/idle/.test(l)) return 'idle';
  if (/run/.test(l)) return 'run';
  if (/walk/.test(l)) return 'walk';
  return 'none';
}

interface EditorResult { blob: Blob; name: string; actions: string[]; }

export function openCharImportEditor(
  parsed: ParsedCharImport,
  onConfirm: (result: EditorResult | null) => void,
): void {
  const sheets = parsed.sheets;
  // ===== 상태 =====
  const mappings: SheetMapping[] = sheets.map((sheet) => ({
    sheet, anim: guessAnim(sheet.name), rowDir: guessRowDirs(sheet),
  }));
  let scale = 1.5, footSrc = 26, done = false;
  const cfg = (): MappingConfig => ({ sheets: mappings, scale, footSrc });

  // ===== DOM =====
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.65);display:flex;align-items:center;justify-content:center;font:13px system-ui,sans-serif;color:#e8e8e8;';
  const panel = document.createElement('div');
  panel.style.cssText = 'background:#1f1f24;border:1px solid #3a3a42;border-radius:10px;max-width:760px;width:94%;max-height:92vh;overflow:auto;padding:18px 20px;box-shadow:0 12px 40px rgba(0,0,0,.5);';
  overlay.appendChild(panel);

  const h = document.createElement('div');
  h.style.cssText = 'font-size:15px;font-weight:700;margin-bottom:4px;';
  h.textContent = '🐾 커스텀 캐릭터 임포트 — 행마다 방향 지정';
  panel.appendChild(h);
  const sub = document.createElement('div');
  sub.style.cssText = 'color:#9a9aa2;margin-bottom:14px;font-size:12px;';
  sub.textContent = `시트 ${sheets.length}장 (${sheets[0].tileW}×${sheets[0].tileH}). 각 행에 방향을 지정하세요. 애니 종류는 파일명 자동(수정 가능).`;
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

  // 시트별 행→방향 매핑
  const sheetsWrap = document.createElement('div');
  sheetsWrap.style.cssText = 'display:flex;flex-direction:column;gap:10px;margin-bottom:14px;';
  panel.appendChild(sheetsWrap);

  function frameThumb(sheet: ParsedSheet, rowIdx: number): HTMLCanvasElement {
    const row = sheet.rows[rowIdx];
    const c = document.createElement('canvas');
    c.width = 40; c.height = 40;
    c.style.cssText = 'background:#0e0e12;border-radius:4px;image-rendering:pixelated;flex:0 0 auto;';
    const cx = c.getContext('2d')!;
    if (row?.animTileIds.length) {
      const t = row.animTileIds[0];
      const sx = (t % sheet.cols) * sheet.tileW, sy = Math.floor(t / sheet.cols) * sheet.tileH;
      cx.imageSmoothingEnabled = false;
      cx.drawImage(sheet.img, sx, sy, sheet.tileW, sheet.tileH, 4, 4, 32, 32);
    }
    return c;
  }

  mappings.forEach((sm) => {
    const box = document.createElement('div');
    box.style.cssText = 'background:#15151a;border:1px solid #2e2e36;border-radius:8px;padding:10px 12px;';
    // 헤더: 시트명 + 애니 종류 선택
    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;gap:10px;margin-bottom:8px;';
    const nm = document.createElement('span'); nm.style.cssText = 'font-weight:600;'; nm.textContent = sm.sheet.name;
    const animSel = document.createElement('select');
    animSel.style.cssText = 'padding:4px 7px;background:#0e0e12;border:1px solid #3a3a42;border-radius:5px;color:#e8e8e8;';
    ([...ANIM_TYPES, 'none'] as AnimType[]).forEach((a) => {
      const o = document.createElement('option'); o.value = a; o.textContent = ANIM_LABEL[a];
      if (sm.anim === a) o.selected = true; animSel.appendChild(o);
    });
    animSel.addEventListener('change', () => { sm.anim = animSel.value as AnimType; });
    const animLab = document.createElement('span'); animLab.style.cssText = 'color:#7a7a82;font-size:11px;'; animLab.textContent = '애니 종류:';
    head.append(nm, document.createTextNode(' '), animLab, animSel);
    box.appendChild(head);
    // 행별 방향 지정
    const rowsWrap = document.createElement('div');
    rowsWrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;';
    sm.sheet.rows.forEach((_, ri) => {
      const cell = document.createElement('div');
      cell.style.cssText = 'display:flex;align-items:center;gap:6px;background:#0e0e12;border:1px solid #2a2a32;border-radius:6px;padding:5px 7px;';
      cell.appendChild(frameThumb(sm.sheet, ri));
      const dirSel = document.createElement('select');
      dirSel.style.cssText = 'padding:4px 6px;background:#15151a;border:1px solid #3a3a42;border-radius:5px;color:#e8e8e8;';
      const none = document.createElement('option'); none.value = ''; none.textContent = '— 방향'; dirSel.appendChild(none);
      DIRS.forEach((d) => {
        const o = document.createElement('option'); o.value = d; o.textContent = DIR_LABEL[d];
        if (sm.rowDir[ri] === d) o.selected = true; dirSel.appendChild(o);
      });
      dirSel.addEventListener('change', () => { sm.rowDir[ri] = (dirSel.value || null) as Dir | null; });
      cell.appendChild(dirSel);
      rowsWrap.appendChild(cell);
    });
    box.appendChild(rowsWrap);
    sheetsWrap.appendChild(box);
  });

  // 슬라이더 (크기 / 발 위치)
  const sliderRow = document.createElement('div');
  sliderRow.style.cssText = 'display:flex;gap:20px;align-items:center;margin-bottom:14px;flex-wrap:wrap;';
  const mkSlider = (label: string, min: number, max: number, step: number, val: number, onIn: (v: number) => void): HTMLElement => {
    const w = document.createElement('label'); w.style.cssText = 'display:flex;align-items:center;gap:8px;';
    const sp = document.createElement('span'); sp.style.color = '#b8b8c0'; sp.textContent = label;
    const inp = document.createElement('input'); inp.type = 'range'; inp.min = String(min); inp.max = String(max); inp.step = String(step); inp.value = String(val);
    const out = document.createElement('span'); out.style.cssText = 'color:#e8e8e8;min-width:34px;'; out.textContent = String(val);
    inp.addEventListener('input', () => { const v = parseFloat(inp.value); out.textContent = String(v); onIn(v); });
    w.append(sp, inp, out); return w;
  };
  sliderRow.append(
    mkSlider('크기', 0.5, 3, 0.1, scale, (v) => { scale = v; }),
    mkSlider('발 위치', 0, sheets[0].tileH, 1, footSrc, (v) => { footSrc = v; }),
  );
  panel.appendChild(sliderRow);

  // 프리뷰
  const prevWrap = document.createElement('div');
  prevWrap.style.cssText = 'margin-bottom:14px;';
  prevWrap.innerHTML = '<div style="color:#b8b8c0;margin-bottom:6px;">미리보기 (행=애니 · 열= ↑ ← ↓ →)</div>';
  const preview = document.createElement('canvas');
  const PCELL = 64, PLABEL = 52;
  preview.width = PLABEL + PCELL * 4; preview.height = PCELL * 3;
  preview.style.cssText = `width:${PLABEL + PCELL * 4}px;height:${PCELL * 3}px;background:#0e0e12;border:1px solid #3a3a42;border-radius:6px;image-rendering:pixelated;`;
  prevWrap.appendChild(preview);
  panel.appendChild(prevWrap);

  // 버튼
  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;position:sticky;bottom:0;background:#1f1f24;padding-top:6px;';
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = '취소';
  cancelBtn.style.cssText = 'padding:8px 16px;background:#2a2a32;border:1px solid #3a3a42;border-radius:6px;color:#e8e8e8;cursor:pointer;';
  const okBtn = document.createElement('button');
  okBtn.textContent = '굽고 업로드';
  okBtn.style.cssText = 'padding:8px 16px;background:#3b82f6;border:1px solid #3b82f6;border-radius:6px;color:#fff;font-weight:600;cursor:pointer;';
  btnRow.append(cancelBtn, okBtn);
  panel.appendChild(btnRow);

  // ===== 라이브 프리뷰 =====
  const pctx = preview.getContext('2d')!;
  const cellCanvas = document.createElement('canvas'); cellCanvas.width = 64; cellCanvas.height = 64;
  const cellCtx = cellCanvas.getContext('2d')!;
  let raf = 0;
  function renderPreview(): void {
    const now = performance.now() / 1000;
    const c = cfg();
    pctx.clearRect(0, 0, preview.width, preview.height);
    const present = actionsPresent(c);
    pctx.font = '11px system-ui'; pctx.textBaseline = 'middle';
    (present.length ? present : (['idle'] as AnimType[])).slice(0, 3).forEach((anim, rowI) => {
      pctx.fillStyle = '#b8b8c0';
      pctx.fillText(anim, 6, rowI * PCELL + PCELL / 2);
      DIRS.forEach((dir, col) => {
        const src = findAnimRow(c, anim, dir);
        if (!src) return;
        const fps = anim === 'idle' ? 3 : 8;
        const tile = src.tileIds[Math.floor(now * fps) % src.tileIds.length];
        cellCtx.clearRect(0, 0, 64, 64);
        blitTileToCell(cellCtx, src.sheet, tile, 0, 0, c.scale, c.footSrc);
        pctx.imageSmoothingEnabled = false;
        pctx.drawImage(cellCanvas, PLABEL + col * PCELL, rowI * PCELL, PCELL, PCELL);
      });
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
      const c = cfg();
      const actions = actionsPresent(c);
      if (actions.length === 0) { okBtn.disabled = false; okBtn.textContent = '굽고 업로드'; alert('방향이 지정된 행이 없어요. 각 행에 방향을 지정하세요.'); return; }
      const blob = await bakeLpcSheet(c);
      close({ blob, name: nameIn.value.trim() || 'character', actions });
    } catch (e) {
      okBtn.disabled = false; okBtn.textContent = '굽고 업로드';
      alert(`굽기 실패: ${(e as Error).message}`);
    }
  });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });

  document.body.appendChild(overlay);
  nameIn.focus();
}

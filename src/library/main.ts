// 라이브러리 페이지 부트스트랩 + UI 로직.
//   - 비번 모달 → ensureAuth → 토큰 보유
//   - Maps / Characters / Audio 탭 전환
//   - 드래그&드롭 / 파일 선택 업로드 (다중 파일)
//   - 캐릭터는 업로드 시 LPC 액션 자동 검출 → sidecar .meta.json 함께 저장
//   - 진행률 표시 + 항목 삭제

import { ensureAuth, clearToken } from './auth';
import { listAssets, uploadAsset, deleteAsset, AuthError, type BlobItem } from './api';
import {
  detectActionsFromFile, ANIMATION_CONFIGS, FRAME_SIZE,
  type LPCAction,
} from './lpc-detect';

type Category = 'maps' | 'characters' | 'bgm';
const EXT_BY_CAT: Record<Category, string[]> = {
  maps:       ['json', 'tmj', 'tsj', 'png', 'jpg', 'jpeg'],
  characters: ['png'],
  bgm:        ['mp3', 'ogg', 'wav', 'm4a'],
};

let token = '';
let activeCat: Category = 'maps';

// pathname → 검출된 액션 목록. sidecar 메타에서 채우고 리스트 렌더 시 참조.
const actionsByPath = new Map<string, LPCAction[]>();
// URL → 이미 로드된 LPC 시트 (썸네일 렌더용). 시트가 큰 편이라 캐싱 필수.
const sheetByUrl = new Map<string, HTMLImageElement | 'loading' | 'error'>();

function showToast(msg: string, kind: 'ok' | 'err' = 'ok', ms = 2200): void {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('err', kind === 'err');
  el.classList.remove('hidden');
  window.clearTimeout((el as HTMLElement & { __t?: number }).__t);
  (el as HTMLElement & { __t?: number }).__t = window.setTimeout(() => el.classList.add('hidden'), ms);
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function shortName(pathname: string): string {
  return pathname.split('/').slice(1).join('/') || pathname;
}

function extLabel(pathname: string): string {
  const ext = pathname.split('.').pop()?.toLowerCase() ?? '';
  return ext.toUpperCase();
}

/** LPC idle 프레임을 작은 캔버스로 그림 — walk row 10 (down), col 0 = 64×64 영역. */
function drawCharacterThumb(canvas: HTMLCanvasElement, img: HTMLImageElement): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width, h = canvas.height;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, w, h);
  // 시트의 walk-down idle (row 10, col 0). 시트가 비표준이면 빈 표시.
  if (img.naturalWidth >= 64 && img.naturalHeight >= 11 * 64) {
    ctx.drawImage(img, 0, 10 * FRAME_SIZE, FRAME_SIZE, FRAME_SIZE, 0, 0, w, h);
  } else {
    // 표준 아니면 시트 좌상단 일부만 보여줌
    ctx.drawImage(img, 0, 0, Math.min(64, img.naturalWidth), Math.min(64, img.naturalHeight), 0, 0, w, h);
  }
}

/** 비동기로 시트를 캐싱하고, 로드 끝나면 콜백. 캐시 적중이면 즉시 콜백. */
function loadSheet(url: string, onReady: (img: HTMLImageElement) => void): void {
  const cached = sheetByUrl.get(url);
  if (cached === 'loading') return;
  if (cached === 'error') return;
  if (cached) { onReady(cached); return; }
  sheetByUrl.set(url, 'loading');
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => { sheetByUrl.set(url, img); onReady(img); };
  img.onerror = () => { sheetByUrl.set(url, 'error'); };
  img.src = url;
}

function emptyLabel(cat: Category): string {
  if (cat === 'maps') return 'maps';
  if (cat === 'characters') return 'characters';
  return 'audio';
}

async function refreshList(): Promise<void> {
  const list = document.getElementById('file-list')!;
  list.innerHTML = '<li class="lib-empty">Loading…</li>';
  try {
    const all = await listAssets(token, activeCat);

    // sidecar .meta.json 파일을 본문 아이템에서 제외하고, 페어 메타로 가져옴
    const items: BlobItem[] = [];
    const sidecars: BlobItem[] = [];
    for (const it of all) {
      if (it.pathname.endsWith('.meta.json')) sidecars.push(it);
      else items.push(it);
    }

    // 캐릭터 카테고리면 sidecar JSON 을 병렬로 읽어 actionsByPath 채움
    if (activeCat === 'characters' && sidecars.length > 0) {
      await Promise.all(sidecars.map(async (s) => {
        try {
          const r = await fetch(s.url);
          if (!r.ok) return;
          const j = await r.json() as { actions?: LPCAction[] };
          // sidecar pathname: characters/name.meta.json → 페어 PNG pathname 추정
          const pngPath = s.pathname.replace(/\.meta\.json$/, '.png');
          if (Array.isArray(j.actions)) actionsByPath.set(pngPath, j.actions);
        } catch { /* 무시 */ }
      }));
    }

    if (items.length === 0) {
      list.innerHTML = `<li class="lib-empty">No ${emptyLabel(activeCat)} yet. Upload above.</li>`;
      return;
    }
    list.innerHTML = '';
    for (const it of items) list.appendChild(makeItem(it));
  } catch (e) {
    if (e instanceof AuthError) {
      clearToken();
      location.reload();
      return;
    }
    list.innerHTML = `<li class="lib-empty">Failed to load: ${(e as Error).message}</li>`;
  }
}

function makeItem(it: BlobItem): HTMLElement {
  const li = document.createElement('li');
  li.className = 'lib-item';

  // 좌측: 캐릭터면 썸네일 캔버스, 아니면 확장자 라벨
  let leftEl: HTMLElement;
  if (activeCat === 'characters' && it.pathname.toLowerCase().endsWith('.png')) {
    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    const c = document.createElement('canvas');
    c.width = 48; c.height = 48;
    thumb.appendChild(c);
    leftEl = thumb;
    // 비동기로 시트 로드 후 썸네일 렌더
    loadSheet(it.url, (img) => drawCharacterThumb(c, img));
  } else {
    leftEl = document.createElement('div');
    leftEl.className = 'ext';
    leftEl.textContent = extLabel(it.pathname);
  }

  const meta = document.createElement('div');
  meta.className = 'meta';
  const nm = document.createElement('div');
  nm.className = 'name'; nm.textContent = shortName(it.pathname);
  const sub = document.createElement('div');
  sub.className = 'sub';
  sub.textContent = `${fmtSize(it.size)} · ${new Date(it.uploadedAt).toLocaleDateString()}`;
  meta.appendChild(nm); meta.appendChild(sub);

  // 캐릭터면 검출된 액션을 태그 행으로 표시
  if (activeCat === 'characters') {
    const actions = actionsByPath.get(it.pathname);
    const tags = document.createElement('div');
    tags.className = 'lib-tags';
    if (actions && actions.length > 0) {
      for (const a of actions) {
        const tag = document.createElement('span');
        tag.className = 'lib-tag';
        tag.textContent = ANIMATION_CONFIGS[a]?.label ?? a;
        tags.appendChild(tag);
      }
    } else {
      const muted = document.createElement('span');
      muted.className = 'lib-tag lib-tag-muted';
      muted.textContent = 'no metadata';
      tags.appendChild(muted);
    }
    meta.appendChild(tags);
  }

  const del = document.createElement('button');
  del.className = 'del'; del.textContent = '×'; del.title = 'Delete';
  del.addEventListener('click', async () => {
    if (!confirm(`Delete "${shortName(it.pathname)}"?`)) return;
    try {
      await deleteAsset(token, it.url);
      // 캐릭터면 사이드카도 함께 삭제 (실패는 무시)
      if (activeCat === 'characters') {
        const metaUrl = it.url.replace(/\.png$/i, '.meta.json');
        try { await deleteAsset(token, metaUrl); } catch { /* 무시 */ }
      }
      showToast('Deleted');
      refreshList();
    } catch (e) {
      showToast((e as Error).message, 'err');
    }
  });
  li.appendChild(leftEl);
  li.appendChild(meta);
  li.appendChild(del);
  return li;
}

async function handleFiles(files: FileList | File[]): Promise<void> {
  const arr = Array.from(files);
  for (const f of arr) {
    const ext = f.name.split('.').pop()?.toLowerCase() ?? '';
    if (!EXT_BY_CAT[activeCat].includes(ext)) {
      showToast(`${f.name} — extension .${ext} not allowed in this tab`, 'err', 3000);
      continue;
    }
    if (activeCat === 'characters') {
      // 모달로 미리보기 + 이름 확정 → 사용자가 Upload 누르면 업로드
      await uploadCharacterWithModal(f);
    } else {
      // Maps / Audio 는 기존 흐름 — 즉시 업로드
      await uploadOne(f, f.name);
    }
  }
  refreshList();
}

/** Maps/Audio 또는 캐릭터(확정된 이름) 한 파일 업로드 + 진행률 표시. */
async function uploadOne(file: File, displayName: string, opts?: {
  characterActions?: LPCAction[];
  characterBaseName?: string;     // 'name' (확장자 없음)
}): Promise<void> {
  const progressEl = document.getElementById('upload-progress')!;
  const row = document.createElement('div');
  row.className = 'lib-progress-row';
  row.innerHTML = `<span class="name"></span><span class="bar"><div style="width:0%"></div></span><span class="pct">0%</span>`;
  progressEl.appendChild(row);
  const bar = row.querySelector('.bar > div') as HTMLDivElement;
  const pct = row.querySelector('.pct') as HTMLSpanElement;
  const nameEl = row.querySelector('.name')!;
  nameEl.textContent = displayName;

  try {
    await uploadAsset(token, activeCat, file, (loaded, total) => {
      const p = total > 0 ? Math.round((loaded / total) * 100) : 0;
      bar.style.width = p + '%';
      pct.textContent = p + '%';
    });
    if (opts?.characterActions && opts.characterBaseName) {
      const metaName = `${opts.characterBaseName}.meta.json`;
      const metaBody = JSON.stringify({
        schema: 1,
        source: 'lpc',
        actions: opts.characterActions,
        detectedAt: new Date().toISOString(),
      }, null, 2);
      const metaFile = new File([metaBody], metaName, { type: 'application/json' });
      await uploadAsset(token, activeCat, metaFile);
    }
    row.classList.add('ok');
    pct.textContent = 'OK';
  } catch (e) {
    row.classList.add('err');
    pct.textContent = 'ERR';
    const msg = e instanceof AuthError ? 'Auth expired — refresh' : (e as Error).message;
    nameEl.textContent = `${displayName} — ${msg}`;
    if (e instanceof AuthError) { clearToken(); }
  }
  setTimeout(() => row.remove(), 5000);
}

/** 캐릭터 업로드 모달 흐름. detect → preview + name input → user confirms → uploadOne. */
async function uploadCharacterWithModal(file: File): Promise<void> {
  const modal = document.getElementById('char-upload-modal')!;
  const previewC = document.getElementById('cu-preview') as HTMLCanvasElement;
  const nameInput = document.getElementById('cu-name') as HTMLInputElement;
  const actionsEl = document.getElementById('cu-actions')!;
  const warnEl = document.getElementById('cu-warn')!;
  const fnameEl = document.getElementById('cu-filename')!;
  const submitBtn = document.getElementById('cu-submit') as HTMLButtonElement;
  const cancelBtn = document.getElementById('cu-cancel') as HTMLButtonElement;

  // 기본값
  const baseFromFile = file.name.replace(/\.[^.]+$/, '');
  nameInput.value = baseFromFile;
  fnameEl.textContent = file.name;
  warnEl.classList.add('hidden');
  actionsEl.innerHTML = '<span class="lib-tag lib-tag-muted">analyzing…</span>';
  // 미리보기 즉시 (URL.createObjectURL)
  const previewUrl = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => drawCharacterThumb(previewC, img);
  img.src = previewUrl;

  modal.classList.remove('hidden');
  submitBtn.disabled = true;
  nameInput.focus();
  nameInput.select();

  // 액션 검출 (백그라운드)
  let actions: LPCAction[] = [];
  try {
    const det = await detectActionsFromFile(file);
    if (!det.standard) {
      warnEl.textContent = `Not a standard 832×3456 LPC sheet (got ${det.width}×${det.height}). Upload disabled.`;
      warnEl.classList.remove('hidden');
      actionsEl.innerHTML = '';
      submitBtn.disabled = true;
    } else {
      actions = det.actions;
      actionsEl.innerHTML = '';
      for (const a of actions) {
        const tag = document.createElement('span');
        tag.className = 'lib-tag';
        tag.textContent = ANIMATION_CONFIGS[a]?.label ?? a;
        actionsEl.appendChild(tag);
      }
      if (actions.length === 0) {
        actionsEl.innerHTML = '<span class="lib-tag lib-tag-muted">no actions detected</span>';
      }
      submitBtn.disabled = false;
    }
  } catch (e) {
    warnEl.textContent = (e as Error).message;
    warnEl.classList.remove('hidden');
  }

  // 사용자 응답 대기
  await new Promise<void>((resolve) => {
    const cleanup = (): void => {
      URL.revokeObjectURL(previewUrl);
      modal.classList.add('hidden');
      submitBtn.onclick = null;
      cancelBtn.onclick = null;
      nameInput.onkeydown = null;
      resolve();
    };
    const doUpload = async (): Promise<void> => {
      const raw = nameInput.value.trim();
      if (!raw) { warnEl.textContent = 'Name required.'; warnEl.classList.remove('hidden'); return; }
      const cleaned = raw.replace(/[\/\\]/g, '_').replace(/\.png$/i, '');
      const newFile = new File([file], `${cleaned}.png`, { type: file.type });
      cleanup();
      await uploadOne(newFile, `${cleaned}.png`, {
        characterActions: actions,
        characterBaseName: cleaned,
      });
    };
    submitBtn.onclick = () => { void doUpload(); };
    cancelBtn.onclick = cleanup;
    nameInput.onkeydown = (e) => {
      if (e.key === 'Enter' && !submitBtn.disabled) { e.preventDefault(); void doUpload(); }
      else if (e.key === 'Escape') { cleanup(); }
    };
  });
}

function ready(fn: () => void): void {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
  else fn();
}

ready(async () => {
  // 비번 받기
  token = await ensureAuth();

  // 탭
  document.querySelectorAll<HTMLButtonElement>('.lib-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.lib-tab').forEach((b) => b.classList.remove('lib-tab-active'));
      btn.classList.add('lib-tab-active');
      activeCat = btn.dataset.cat as Category;
      refreshList();
    });
  });

  // 파일 선택
  const fileIn = document.getElementById('file-input') as HTMLInputElement;
  document.getElementById('btn-pick')!.addEventListener('click', () => {
    fileIn.accept = EXT_BY_CAT[activeCat].map((e) => '.' + e).join(',');
    fileIn.click();
  });
  fileIn.addEventListener('change', () => {
    if (fileIn.files) handleFiles(fileIn.files);
    fileIn.value = '';
  });

  // 드래그&드롭
  const zone = document.getElementById('upload-zone')!;
  ['dragenter', 'dragover'].forEach((ev) => {
    zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('drag'); });
  });
  ['dragleave', 'drop'].forEach((ev) => {
    zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove('drag'); });
  });
  zone.addEventListener('drop', (e) => {
    const dt = (e as DragEvent).dataTransfer;
    if (dt?.files) handleFiles(dt.files);
  });

  // 재로그인
  document.getElementById('btn-logout')!.addEventListener('click', () => {
    clearToken();
    location.reload();
  });

  // 초기 목록
  refreshList();
});

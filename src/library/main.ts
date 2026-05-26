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

type BodyType = 'male' | 'female' | 'none';
interface CharMeta { actions: LPCAction[]; body?: BodyType; uploadedAt?: string; }

// pathname → 캐릭터 메타 (액션, 성별 등). sidecar .meta.json 에서 채움.
const charMetaByPath = new Map<string, CharMeta>();
// URL → 이미 로드된 LPC 시트 (썸네일 + 미리보기 렌더용). 시트가 큰 편이라 캐싱 필수.
const sheetByUrl = new Map<string, HTMLImageElement | 'loading' | 'error'>();
// 현재 detail 패널에서 보여주는 캐릭터.
let selectedChar: BlobItem | null = null;
let playingAction: LPCAction | null = null;
let playRafId = 0;

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

function setContentMode(): void {
  const content = document.getElementById('lib-content')!;
  const detail = document.getElementById('char-detail')!;
  if (activeCat === 'characters') {
    content.classList.add('has-detail');
    detail.classList.remove('hidden');
  } else {
    content.classList.remove('has-detail');
    detail.classList.add('hidden');
    selectedChar = null;
    stopAnimation();
  }
}

async function refreshList(): Promise<void> {
  setContentMode();
  const list = document.getElementById('file-list')!;
  list.innerHTML = '<li class="lib-empty">Loading…</li>';
  try {
    const all = await listAssets(token, activeCat);

    // sidecar .meta.json 분리
    const items: BlobItem[] = [];
    const sidecars: BlobItem[] = [];
    for (const it of all) {
      if (it.pathname.endsWith('.meta.json')) sidecars.push(it);
      else items.push(it);
    }

    // 캐릭터 카테고리면 sidecar JSON 을 병렬로 읽어 charMetaByPath 채움
    if (activeCat === 'characters' && sidecars.length > 0) {
      await Promise.all(sidecars.map(async (s) => {
        try {
          const r = await fetch(s.url);
          if (!r.ok) return;
          const j = await r.json() as { actions?: LPCAction[]; body?: BodyType };
          const pngPath = s.pathname.replace(/\.meta\.json$/, '.png');
          if (Array.isArray(j.actions)) {
            charMetaByPath.set(pngPath, {
              actions: j.actions,
              body: j.body,
            });
          }
        } catch { /* 무시 */ }
      }));
    }

    if (items.length === 0) {
      list.innerHTML = `<li class="lib-empty">No ${emptyLabel(activeCat)} yet. Upload above.</li>`;
      if (activeCat === 'characters') renderDetail(null);
      return;
    }
    list.innerHTML = '';
    for (const it of items) list.appendChild(makeItem(it));

    if (activeCat === 'characters') {
      // 첫 행 자동 선택 — 아무 것도 선택 안 됐을 때
      if (!selectedChar || !items.some((i) => i.pathname === selectedChar!.pathname)) {
        selectChar(items[0]);
      } else {
        renderDetail(selectedChar);
      }
    }
  } catch (e) {
    if (e instanceof AuthError) {
      clearToken();
      location.reload();
      return;
    }
    list.innerHTML = `<li class="lib-empty">Failed to load: ${(e as Error).message}</li>`;
  }
}

function bodyLabel(body: BodyType | undefined): string {
  if (body === 'male') return 'Male';
  if (body === 'female') return 'Female';
  if (body === 'none') return 'None';
  return '—';
}
function charBaseName(pathname: string): string {
  // characters/foo.png → foo
  return shortName(pathname).replace(/\.[^.]+$/, '');
}

function makeItem(it: BlobItem): HTMLElement {
  const li = document.createElement('li');
  li.className = 'lib-item';
  const isChar = activeCat === 'characters' && it.pathname.toLowerCase().endsWith('.png');

  // 좌측: 캐릭터면 썸네일 캔버스, 아니면 확장자 라벨
  let leftEl: HTMLElement;
  if (isChar) {
    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    const c = document.createElement('canvas');
    c.width = 48; c.height = 48;
    thumb.appendChild(c);
    leftEl = thumb;
    loadSheet(it.url, (img) => drawCharacterThumb(c, img));
  } else {
    leftEl = document.createElement('div');
    leftEl.className = 'ext';
    leftEl.textContent = extLabel(it.pathname);
  }

  const meta = document.createElement('div');
  meta.className = 'meta';

  if (isChar) {
    // Characters 표 형식: name | body | date
    const nm = document.createElement('div');
    nm.className = 'name';
    nm.textContent = charBaseName(it.pathname);

    const body = document.createElement('div');
    body.className = 'body';
    body.textContent = bodyLabel(charMetaByPath.get(it.pathname)?.body);

    const date = document.createElement('div');
    date.className = 'date';
    date.textContent = new Date(it.uploadedAt).toLocaleDateString();

    meta.appendChild(nm);
    meta.appendChild(body);
    meta.appendChild(date);

    // 선택 표시
    if (selectedChar && selectedChar.pathname === it.pathname) li.classList.add('selected');
    li.addEventListener('click', () => selectChar(it));
  } else {
    const nm = document.createElement('div');
    nm.className = 'name'; nm.textContent = shortName(it.pathname);
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = `${fmtSize(it.size)} · ${new Date(it.uploadedAt).toLocaleDateString()}`;
    meta.appendChild(nm); meta.appendChild(sub);
  }

  const del = document.createElement('button');
  del.className = 'del'; del.textContent = '×'; del.title = 'Delete';
  del.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm(`Delete "${shortName(it.pathname)}"?`)) return;
    try {
      await deleteAsset(token, it.url);
      if (activeCat === 'characters') {
        const metaUrl = it.url.replace(/\.png$/i, '.meta.json');
        try { await deleteAsset(token, metaUrl); } catch { /* 무시 */ }
        if (selectedChar?.pathname === it.pathname) selectedChar = null;
      }
      showToast('Deleted');
      refreshList();
    } catch (err) {
      showToast((err as Error).message, 'err');
    }
  });
  li.appendChild(leftEl);
  li.appendChild(meta);
  li.appendChild(del);
  return li;
}

function selectChar(it: BlobItem): void {
  selectedChar = it;
  // 리스트의 선택 표시 갱신
  document.querySelectorAll('.lib-item.selected').forEach((el) => el.classList.remove('selected'));
  document.querySelectorAll('.lib-item').forEach((el) => {
    const isSelected = (el.querySelector('.name') as HTMLElement | null)?.textContent === charBaseName(it.pathname);
    if (isSelected) el.classList.add('selected');
  });
  renderDetail(it);
}

function renderDetail(it: BlobItem | null): void {
  const nameEl = document.getElementById('detail-name')!;
  const subEl = document.getElementById('detail-sub')!;
  const actionsEl = document.getElementById('detail-actions')!;
  const canvas = document.getElementById('detail-preview') as HTMLCanvasElement;

  stopAnimation();
  if (!it) {
    nameEl.textContent = 'No character selected';
    subEl.textContent = '';
    actionsEl.innerHTML = '';
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }

  const meta = charMetaByPath.get(it.pathname);
  nameEl.textContent = charBaseName(it.pathname);
  subEl.textContent = `${bodyLabel(meta?.body)} · ${fmtSize(it.size)} · ${new Date(it.uploadedAt).toLocaleDateString()}`;

  // 초기 프레임: idle down
  loadSheet(it.url, (img) => {
    drawIdleFrame(canvas, img);
  });

  // 액션 버튼
  actionsEl.innerHTML = '';
  const actions = meta?.actions ?? [];
  if (actions.length === 0) {
    actionsEl.innerHTML = '<span class="lib-tag lib-tag-muted">no actions detected</span>';
    return;
  }
  for (const a of actions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = ANIMATION_CONFIGS[a]?.label ?? a;
    btn.dataset.action = a;
    btn.addEventListener('click', () => playAction(a, it.url, canvas, actionsEl));
    actionsEl.appendChild(btn);
  }
}

function drawIdleFrame(canvas: HTMLCanvasElement, img: HTMLImageElement): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // walk-down idle = row 10, col 0
  if (img.naturalWidth >= FRAME_SIZE && img.naturalHeight >= 11 * FRAME_SIZE) {
    ctx.drawImage(img, 0, 10 * FRAME_SIZE, FRAME_SIZE, FRAME_SIZE,
                  0, 0, canvas.width, canvas.height);
  }
}

function stopAnimation(): void {
  if (playRafId) cancelAnimationFrame(playRafId);
  playRafId = 0;
  playingAction = null;
  document.querySelectorAll('.lib-detail-actions button.playing').forEach((b) => b.classList.remove('playing'));
}

function playAction(action: LPCAction, url: string, canvas: HTMLCanvasElement, container: HTMLElement): void {
  // 토글: 같은 액션 다시 클릭이면 정지
  if (playingAction === action) { stopAnimation(); return; }
  stopAnimation();
  playingAction = action;
  container.querySelectorAll('button').forEach((b) => {
    b.classList.toggle('playing', b.dataset.action === action);
  });

  loadSheet(url, (img) => {
    const cfg = ANIMATION_CONFIGS[action];
    // 4-row 액션은 down(=+2) 방향. 1-row(hurt/climb) 은 그대로
    const row = cfg.row + (cfg.num === 4 ? 2 : 0);
    const cycle = cfg.cycle;
    const FPS = 8;
    let frame = 0;
    let lastT = 0;
    const ctx = canvas.getContext('2d')!;

    const loop = (now: number): void => {
      if (playingAction !== action) return;
      if (now - lastT > 1000 / FPS) {
        const col = cycle[frame];
        ctx.imageSmoothingEnabled = false;
        ctx.fillStyle = '#0e1014';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, col * FRAME_SIZE, row * FRAME_SIZE, FRAME_SIZE, FRAME_SIZE,
                      0, 0, canvas.width, canvas.height);
        frame = (frame + 1) % cycle.length;
        lastT = now;
      }
      playRafId = requestAnimationFrame(loop);
    };
    playRafId = requestAnimationFrame(loop);
  });
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
  characterBody?: BodyType;
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
        body: opts.characterBody ?? 'none',
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
  const bodySel = document.getElementById('cu-body') as HTMLSelectElement;
  const actionsEl = document.getElementById('cu-actions')!;
  const warnEl = document.getElementById('cu-warn')!;
  const fnameEl = document.getElementById('cu-filename')!;
  const submitBtn = document.getElementById('cu-submit') as HTMLButtonElement;
  const cancelBtn = document.getElementById('cu-cancel') as HTMLButtonElement;

  // 기본값
  const baseFromFile = file.name.replace(/\.[^.]+$/, '');
  nameInput.value = baseFromFile;
  bodySel.value = 'male';
  fnameEl.textContent = file.name;
  warnEl.classList.add('hidden');
  actionsEl.innerHTML = '<span class="lib-tag lib-tag-muted">analyzing…</span>';
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
        characterBody: bodySel.value as BodyType,
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

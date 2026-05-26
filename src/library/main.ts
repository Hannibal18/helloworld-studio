// 라이브러리 페이지 부트스트랩 + UI 로직.
//   - 비번 모달 → ensureAuth → 토큰 보유
//   - Maps / Characters / Audio 탭 전환
//   - 드래그&드롭 / 파일 선택 업로드 (다중 파일)
//   - 캐릭터는 업로드 시 LPC 액션 자동 검출 → sidecar .meta.json 함께 저장
//   - 진행률 표시 + 항목 삭제

import { ensureAuth, clearToken } from './auth';
import { listAssets, uploadAsset, deleteAsset, AuthError, type BlobItem } from './api';
import { detectActionsFromFile, ANIMATION_CONFIGS, type LPCAction } from './lpc-detect';

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
  const ico = document.createElement('div');
  ico.className = 'ext'; ico.textContent = extLabel(it.pathname);
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
  li.appendChild(ico);
  li.appendChild(meta);
  li.appendChild(del);
  return li;
}

async function handleFiles(files: FileList | File[]): Promise<void> {
  const arr = Array.from(files);
  const progressEl = document.getElementById('upload-progress')!;
  for (const f of arr) {
    const ext = f.name.split('.').pop()?.toLowerCase() ?? '';
    if (!EXT_BY_CAT[activeCat].includes(ext)) {
      showToast(`${f.name} — extension .${ext} not allowed in this tab`, 'err', 3000);
      continue;
    }
    const row = document.createElement('div');
    row.className = 'lib-progress-row';
    row.innerHTML = `<span class="name">${f.name}</span><span class="bar"><div style="width:0%"></div></span><span class="pct">0%</span>`;
    progressEl.appendChild(row);
    const bar = row.querySelector('.bar > div') as HTMLDivElement;
    const pct = row.querySelector('.pct') as HTMLSpanElement;
    const nameEl = row.querySelector('.name')!;

    try {
      // 캐릭터면 업로드 전에 LPC 액션 검출
      let detectedActions: LPCAction[] | null = null;
      if (activeCat === 'characters') {
        nameEl.textContent = `${f.name} — analyzing…`;
        const det = await detectActionsFromFile(f);
        if (!det.standard) {
          throw new Error(`Not a standard 832×3456 LPC sheet (got ${det.width}×${det.height})`);
        }
        detectedActions = det.actions;
        nameEl.textContent = `${f.name} · ${detectedActions.length} actions detected`;
      }

      // PNG (또는 일반 파일) 업로드
      await uploadAsset(token, activeCat, f, (loaded, total) => {
        const p = total > 0 ? Math.round((loaded / total) * 100) : 0;
        bar.style.width = p + '%';
        pct.textContent = p + '%';
      });

      // 캐릭터면 sidecar JSON 도 업로드
      if (activeCat === 'characters' && detectedActions) {
        const metaName = f.name.replace(/\.[^.]+$/, '') + '.meta.json';
        const metaBody = JSON.stringify({
          schema: 1,
          source: 'lpc',
          actions: detectedActions,
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
      nameEl.textContent = `${f.name} — ${msg}`;
      if (e instanceof AuthError) { clearToken(); }
    }
    setTimeout(() => row.remove(), 5000);
  }
  refreshList();
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

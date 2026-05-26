// 라이브러리 페이지 부트스트랩 + UI 로직.
//   - 비번 모달 → ensureAuth → 토큰 보유
//   - Maps / BGM 탭 전환 + 카테고리별 목록 갱신
//   - 드래그&드롭 / 파일 선택 업로드 (다중 파일)
//   - 진행률 표시 + 완료/실패 토스트
//   - 항목 삭제

import { ensureAuth, clearToken } from './auth';
import { listAssets, uploadAsset, deleteAsset, AuthError, type BlobItem } from './api';

type Category = 'maps' | 'bgm';
const EXT_BY_CAT: Record<Category, string[]> = {
  maps: ['json', 'tmj', 'tsj', 'png', 'jpg', 'jpeg'],
  bgm:  ['mp3', 'ogg', 'wav', 'm4a'],
};

let token = '';
let activeCat: Category = 'maps';

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

async function refreshList(): Promise<void> {
  const list = document.getElementById('file-list')!;
  list.innerHTML = '<li class="lib-empty">로딩 중...</li>';
  try {
    const items = await listAssets(token, activeCat);
    if (items.length === 0) {
      list.innerHTML = `<li class="lib-empty">No ${activeCat === 'maps' ? 'maps' : 'audio'} yet. Upload above.</li>`;
      return;
    }
    list.innerHTML = '';
    for (const it of items) {
      list.appendChild(makeItem(it));
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
  const del = document.createElement('button');
  del.className = 'del'; del.textContent = '×'; del.title = 'Delete';
  del.addEventListener('click', async () => {
    if (!confirm(`Delete "${shortName(it.pathname)}"?`)) return;
    try {
      await deleteAsset(token, it.url);
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
    try {
      await uploadAsset(token, activeCat, f, (loaded, total) => {
        const p = total > 0 ? Math.round((loaded / total) * 100) : 0;
        bar.style.width = p + '%';
        pct.textContent = p + '%';
      });
      row.classList.add('ok');
      pct.textContent = 'OK';
    } catch (e) {
      row.classList.add('err');
      pct.textContent = 'ERR';
      const msg = e instanceof AuthError ? 'Auth expired — refresh' : (e as Error).message;
      row.querySelector('.name')!.textContent = `${f.name} — ${msg}`;
      if (e instanceof AuthError) { clearToken(); }
    }
    // 4초 후 행 제거
    setTimeout(() => row.remove(), 4000);
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

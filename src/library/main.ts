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
import {
  schemasByCategory, loadAllSchemas, saveSchema,
  type FieldDef, type FieldType, type SchemaCat,
} from './schema';

type Category = 'maps' | 'characters' | 'bgm';
const EXT_BY_CAT: Record<Category, string[]> = {
  maps:       ['json', 'tmj', 'tsj', 'png', 'jpg', 'jpeg'],
  characters: ['png'],
  bgm:        ['mp3', 'ogg', 'wav', 'm4a'],
};

let token = '';
let activeCat: Category = 'maps';     // 마지막 본 자산 카테고리 (settings 클릭 시에도 유지)
let inSettings = false;                // Settings 탭 활성 여부

type BodyType = 'male' | 'female' | 'none';
interface CharMeta {
  actions: LPCAction[];
  body?: BodyType;
  name?: string;        // 표시용 이름 (파일명과 분리)
  race?: string;        // 종족 — 자유 텍스트 (human, lizard, wolfman, ...)
  fields?: Record<string, string>;  // 사용자 정의 스키마 필드값
  uploadedAt?: string;
}

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
  const upload = document.getElementById('upload-zone')!;
  const settings = document.getElementById('settings-panel')!;

  // Settings 보기일 때: 업로드존/리스트/디테일 다 숨기고 settings 만
  if (inSettings) {
    upload.classList.add('hidden');
    content.classList.add('hidden');
    settings.classList.remove('hidden');
    detail.classList.add('hidden');
    selectedChar = null;
    stopAnimation();
    return;
  }
  upload.classList.remove('hidden');
  content.classList.remove('hidden');
  settings.classList.add('hidden');

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
  if (inSettings) { await renderSettings(); return; }
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
          const r = await fetch(s.url, { cache: 'reload' });
          if (!r.ok) return;
          const j = await r.json() as { actions?: LPCAction[]; body?: BodyType; name?: string; race?: string; fields?: Record<string, string> };
          const pngPath = s.pathname.replace(/\.meta\.json$/, '.png');
          if (Array.isArray(j.actions)) {
            charMetaByPath.set(pngPath, {
              actions: j.actions,
              body: j.body,
              name: j.name,
              race: j.race,
              fields: j.fields,
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
function displayName(it: BlobItem): string {
  return charMetaByPath.get(it.pathname)?.name || charBaseName(it.pathname);
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
    nm.textContent = displayName(it);

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
    const confirmMsg = activeCat === 'characters' ? 'Delete this character?' : 'Delete this file?';
    if (!confirm(confirmMsg)) return;
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
  const emptyEl = document.getElementById('detail-empty')!;
  const formEl = document.getElementById('detail-form')!;
  const nameInput = document.getElementById('detail-name') as HTMLInputElement;
  const bodySel = document.getElementById('detail-body') as HTMLSelectElement;
  const raceInput = document.getElementById('detail-race') as HTMLInputElement;
  const subEl = document.getElementById('detail-sub')!;
  const saveBtn = document.getElementById('detail-save') as HTMLButtonElement;
  const actionsEl = document.getElementById('detail-actions')!;
  const canvas = document.getElementById('detail-preview') as HTMLCanvasElement;

  stopAnimation();
  if (!it) {
    emptyEl.classList.remove('hidden');
    formEl.classList.add('hidden');
    actionsEl.innerHTML = '';
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }
  emptyEl.classList.add('hidden');
  formEl.classList.remove('hidden');

  const meta = charMetaByPath.get(it.pathname);
  // 폼 초기값 — meta 가 없으면 파일명 기반 기본
  const initialName = meta?.name ?? charBaseName(it.pathname);
  const initialBody = meta?.body ?? 'none';
  const initialRace = meta?.race ?? '';
  nameInput.value = initialName;
  bodySel.value = initialBody;
  raceInput.value = initialRace;
  subEl.textContent = `${fmtSize(it.size)} · ${new Date(it.uploadedAt).toLocaleDateString()}`;
  saveBtn.disabled = true;

  // 커스텀 스키마 필드 폼 렌더
  const customFieldsHost = renderCustomFieldsForm(formEl, schemasByCategory.characters.fields, meta?.fields ?? {}, onAnyChange);

  // 변경 감지
  function onAnyChange(): void {
    const customChanged = customFieldsHost.changed();
    const changed = nameInput.value.trim() !== initialName
      || bodySel.value !== initialBody
      || raceInput.value.trim() !== initialRace
      || customChanged;
    saveBtn.disabled = !changed || nameInput.value.trim().length === 0;
  }
  nameInput.oninput = onAnyChange;
  bodySel.onchange = onAnyChange;
  raceInput.oninput = onAnyChange;

  saveBtn.onclick = async (): Promise<void> => {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      const newFields = customFieldsHost.values();
      const newMeta: CharMeta = {
        actions: meta?.actions ?? [],
        body: bodySel.value as BodyType,
        name: nameInput.value.trim(),
        race: raceInput.value.trim() || undefined,
        fields: newFields,
      };
      const metaName = `${charBaseName(it.pathname)}.meta.json`;
      const metaBody = JSON.stringify({
        schema: 1,
        source: 'lpc',
        body: newMeta.body,
        name: newMeta.name,
        race: newMeta.race,
        actions: newMeta.actions,
        fields: newFields,
        savedAt: new Date().toISOString(),
      }, null, 2);
      const metaFile = new File([metaBody], metaName, { type: 'application/json' });
      await uploadAsset(token, 'characters', metaFile);
      charMetaByPath.set(it.pathname, newMeta);
      showToast('Saved');
      saveBtn.textContent = 'Save';
      refreshList();
    } catch (e) {
      const msg = e instanceof AuthError ? 'Auth expired — refresh' : (e as Error).message;
      showToast(msg, 'err');
      saveBtn.textContent = 'Save';
      saveBtn.disabled = false;
    }
  };

  // 액션 버튼
  actionsEl.innerHTML = '';
  const actions = meta?.actions ?? [];
  if (actions.length === 0) {
    actionsEl.innerHTML = '<span class="lib-tag lib-tag-muted">no actions detected</span>';
    // 액션 없으면 정적 idle 프레임만 그림
    loadSheet(it.url, (img) => drawIdleFrame(canvas, img));
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

  // 기본 재생: idle 액션이 있으면 그걸 자동 재생, 없으면 정적 idle 프레임
  if (actions.includes('idle')) {
    playAction('idle', it.url, canvas, actionsEl);
  } else {
    loadSheet(it.url, (img) => drawIdleFrame(canvas, img));
  }
}

// ===== Settings 패널 — 카테고리별 메타 필드 스키마 편집 =====

const CATEGORY_LABEL: Record<SchemaCat, string> = {
  maps: 'Maps', characters: 'Characters', bgm: 'Audio',
};

// 빌트인(시스템) 필드 — 스키마 에디터에서 read-only 로 표시.
const BUILTIN_FIELDS: Record<SchemaCat, { key: string; label: string; type: string; note?: string }[]> = {
  characters: [
    { key: 'name',    label: 'Name',    type: 'text' },
    { key: 'body',    label: 'Body',    type: 'select', note: 'male / female / none' },
    { key: 'race',    label: 'Race',    type: 'text' },
    { key: 'actions', label: 'Actions', type: 'list',   note: 'auto-detected from sprite sheet' },
  ],
  maps: [],
  bgm: [],
};

async function renderSettings(): Promise<void> {
  const titleEl = document.getElementById('settings-title')!;
  const hintEl = document.getElementById('settings-hint')!;
  const bodyEl = document.getElementById('settings-body')!;
  const cat = activeCat;
  titleEl.textContent = `${CATEGORY_LABEL[cat]} · Settings`;
  hintEl.textContent = 'Define custom metadata fields collected for each item in this category.';
  renderSchemaEditor(bodyEl, cat);
}

function renderSchemaEditor(container: HTMLElement, cat: SchemaCat): void {
  container.innerHTML = '';

  // 빌트인 필드 섹션
  if (BUILTIN_FIELDS[cat].length > 0) {
    const sec = document.createElement('section');
    sec.className = 'schema-section';
    sec.innerHTML = `<h4 class="schema-section-title">Built-in fields</h4>`;
    const ul = document.createElement('ul');
    ul.className = 'schema-builtin';
    for (const f of BUILTIN_FIELDS[cat]) {
      const li = document.createElement('li');
      li.innerHTML = `<span class="bf-label">${escapeHtml(f.label)}</span>
        <span class="bf-key">${escapeHtml(f.key)}</span>
        <span class="bf-type">${escapeHtml(f.type)}</span>
        <span class="bf-note">${escapeHtml(f.note ?? '')}</span>`;
      ul.appendChild(li);
    }
    sec.appendChild(ul);
    container.appendChild(sec);
  }

  // 커스텀 필드 섹션
  const sec = document.createElement('section');
  sec.className = 'schema-section';
  const headRow = document.createElement('div');
  headRow.className = 'schema-section-head';
  headRow.innerHTML = `<h4 class="schema-section-title">Custom fields</h4>`;
  const addBtn = document.createElement('button');
  addBtn.className = 'st-btn st-btn-primary';
  addBtn.type = 'button';
  addBtn.textContent = '+ Add field';
  headRow.appendChild(addBtn);
  sec.appendChild(headRow);

  const rows = document.createElement('div');
  rows.className = 'schema-rows';
  sec.appendChild(rows);
  container.appendChild(sec);

  const draftFields: FieldDef[] = JSON.parse(JSON.stringify(schemasByCategory[cat].fields));

  const repaint = (): void => {
    rows.innerHTML = '';
    if (draftFields.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'lib-settings-empty';
      empty.textContent = 'No custom fields yet. Click + Add field to define one.';
      rows.appendChild(empty);
      return;
    }
    for (let i = 0; i < draftFields.length; i++) {
      rows.appendChild(makeFieldRow(draftFields, i, markDirty));
    }
  };

  // 변경 감지 + Save 버튼
  const footRow = document.createElement('div');
  footRow.className = 'schema-foot';
  const saveBtn = document.createElement('button');
  saveBtn.className = 'st-btn st-btn-primary';
  saveBtn.type = 'button';
  saveBtn.textContent = 'Save schema';
  saveBtn.disabled = true;
  const revertBtn = document.createElement('button');
  revertBtn.className = 'st-btn';
  revertBtn.type = 'button';
  revertBtn.textContent = 'Revert';
  revertBtn.disabled = true;
  footRow.appendChild(revertBtn);
  footRow.appendChild(saveBtn);
  container.appendChild(footRow);

  function markDirty(): void {
    saveBtn.disabled = false; revertBtn.disabled = false;
  }
  addBtn.addEventListener('click', () => {
    draftFields.push({ key: '', label: '', type: 'text' });
    repaint();
    markDirty();
  });
  saveBtn.addEventListener('click', async () => {
    // 검증: key 비어있거나 중복이면 거부
    const keys = new Set<string>();
    for (const f of draftFields) {
      const k = f.key.trim();
      if (!k) { showToast('Field key is required', 'err'); return; }
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k)) {
        showToast(`Invalid key '${k}' — use letters/digits/underscore`, 'err'); return;
      }
      if (keys.has(k)) { showToast(`Duplicate key '${k}'`, 'err'); return; }
      keys.add(k);
      if (f.type === 'select' && (!f.options || f.options.length === 0)) {
        showToast(`Field '${f.label || k}' is select but has no options`, 'err'); return;
      }
    }
    saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
    try {
      schemasByCategory[cat].fields = draftFields.map((f) => ({
        key: f.key.trim(),
        label: f.label.trim() || f.key.trim(),
        type: f.type,
        options: f.type === 'select' ? (f.options ?? []) : undefined,
        default: f.default || undefined,
      }));
      await saveSchema(token, cat);
      showToast('Schema saved');
      saveBtn.textContent = 'Save schema';
      revertBtn.disabled = true;
    } catch (e) {
      const msg = e instanceof AuthError ? 'Auth expired — refresh' : (e as Error).message;
      showToast(msg, 'err');
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save schema';
    }
  });
  revertBtn.addEventListener('click', () => {
    // 원본으로 되돌림
    draftFields.length = 0;
    for (const f of schemasByCategory[cat].fields) draftFields.push(JSON.parse(JSON.stringify(f)));
    repaint();
    saveBtn.disabled = true;
    revertBtn.disabled = true;
  });

  repaint();
}

// detail 폼 안에 스키마 기반 커스텀 필드 영역 렌더. host.values() / host.changed() 로 상태 조회.
function renderCustomFieldsForm(
  formEl: HTMLElement,
  schemaFields: FieldDef[],
  initial: Record<string, string>,
  onChange: () => void,
): { values: () => Record<string, string>; changed: () => boolean } {
  // 컨테이너 비우고 새로 그림
  let host = formEl.querySelector<HTMLDivElement>('#detail-custom-fields');
  if (!host) {
    host = document.createElement('div');
    host.id = 'detail-custom-fields';
    host.className = 'lib-detail-custom';
    formEl.appendChild(host);
  }
  host.innerHTML = '';

  if (schemaFields.length === 0) {
    return { values: () => ({}), changed: () => false };
  }

  const inputs = new Map<string, HTMLInputElement | HTMLSelectElement>();
  const initialSnap: Record<string, string> = {};

  for (const f of schemaFields) {
    const cur = initial[f.key] ?? f.default ?? '';
    initialSnap[f.key] = cur;
    const wrap = document.createElement('label');
    wrap.className = 'lib-field';
    wrap.textContent = f.label || f.key;
    if (f.type === 'select') {
      const sel = document.createElement('select');
      // 기본 옵션 빈 항목 (선택 안 됐을 때)
      const empty = document.createElement('option');
      empty.value = ''; empty.textContent = '— select —';
      sel.appendChild(empty);
      for (const o of f.options ?? []) {
        const op = document.createElement('option');
        op.value = o; op.textContent = o;
        if (o === cur) op.selected = true;
        sel.appendChild(op);
      }
      if (cur === '') sel.value = '';
      sel.addEventListener('change', onChange);
      wrap.appendChild(sel);
      inputs.set(f.key, sel);
    } else {
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.value = cur;
      inp.placeholder = f.default ?? '';
      inp.addEventListener('input', onChange);
      wrap.appendChild(inp);
      inputs.set(f.key, inp);
    }
    host.appendChild(wrap);
  }

  return {
    values(): Record<string, string> {
      const out: Record<string, string> = {};
      for (const [k, el] of inputs) {
        const v = el.value.trim();
        if (v) out[k] = v;
      }
      return out;
    },
    changed(): boolean {
      for (const [k, el] of inputs) {
        if ((el.value || '').trim() !== (initialSnap[k] || '')) return true;
      }
      return false;
    },
  };
}

function makeFieldRow(draft: FieldDef[], idx: number, markDirty: () => void): HTMLElement {
  const f = draft[idx];
  const row = document.createElement('div');
  row.className = 'schema-row';

  const keyIn = document.createElement('input');
  keyIn.type = 'text'; keyIn.placeholder = 'key (e.g., clothing_color)';
  keyIn.value = f.key;
  keyIn.addEventListener('input', () => { f.key = keyIn.value; markDirty(); });

  const labelIn = document.createElement('input');
  labelIn.type = 'text'; labelIn.placeholder = 'Label (e.g., 옷색깔)';
  labelIn.value = f.label;
  labelIn.addEventListener('input', () => { f.label = labelIn.value; markDirty(); });

  const typeSel = document.createElement('select');
  for (const [v, l] of [['text', 'Text'], ['select', 'Select']] as const) {
    const o = document.createElement('option');
    o.value = v; o.textContent = l;
    if (v === f.type) o.selected = true;
    typeSel.appendChild(o);
  }
  typeSel.addEventListener('change', () => {
    f.type = typeSel.value as FieldType;
    if (f.type !== 'select') f.options = undefined;
    else if (!f.options) f.options = [];
    markDirty();
    // 옵션 영역 업데이트
    optsRow.style.display = f.type === 'select' ? '' : 'none';
  });

  const defaultIn = document.createElement('input');
  defaultIn.type = 'text'; defaultIn.placeholder = 'default (optional)';
  defaultIn.value = f.default ?? '';
  defaultIn.addEventListener('input', () => { f.default = defaultIn.value || undefined; markDirty(); });

  const delBtn = document.createElement('button');
  delBtn.className = 'del-btn'; delBtn.textContent = '×'; delBtn.title = 'Delete field';
  delBtn.addEventListener('click', () => {
    draft.splice(idx, 1);
    row.dispatchEvent(new CustomEvent('field-removed', { bubbles: true }));
    markDirty();
    // 부모 컨테이너에 다시 그리기 요청 — 이벤트로 통신하기 번거로움. row.parentElement!.parentElement! 등.
    // 간단히: 페이지 다시 그리기.
    refreshList();
  });

  row.appendChild(keyIn);
  row.appendChild(labelIn);
  row.appendChild(typeSel);
  row.appendChild(defaultIn);
  row.appendChild(delBtn);

  // 옵션 영역 (select 일 때만)
  const optsRow = document.createElement('div');
  optsRow.className = 'schema-options';
  optsRow.style.display = f.type === 'select' ? '' : 'none';
  const optsLabel = document.createElement('span');
  optsLabel.textContent = 'Options';
  const optsIn = document.createElement('textarea');
  optsIn.rows = 2;
  optsIn.placeholder = 'red\nblue\ngreen';
  optsIn.value = (f.options ?? []).join('\n');
  optsIn.addEventListener('input', () => {
    f.options = optsIn.value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    markDirty();
  });
  optsRow.appendChild(optsLabel);
  optsRow.appendChild(optsIn);
  row.appendChild(optsRow);

  return row;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
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
  characterBaseName?: string;     // 'name' (확장자 없음, 파일명용)
  characterDisplayName?: string;  // meta.name (사람이 보는 이름)
  characterBody?: BodyType;
  characterRace?: string;
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
        name: opts.characterDisplayName ?? opts.characterBaseName,
        race: opts.characterRace || undefined,
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
  const raceInput = document.getElementById('cu-race') as HTMLInputElement;
  const actionsEl = document.getElementById('cu-actions')!;
  const warnEl = document.getElementById('cu-warn')!;
  const fnameEl = document.getElementById('cu-filename')!;
  const submitBtn = document.getElementById('cu-submit') as HTMLButtonElement;
  const cancelBtn = document.getElementById('cu-cancel') as HTMLButtonElement;

  // 기본값
  const baseFromFile = file.name.replace(/\.[^.]+$/, '');
  nameInput.value = baseFromFile;
  bodySel.value = 'male';
  raceInput.value = '';
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
        characterDisplayName: raw,           // 사용자가 원본 그대로 입력한 이름
        characterBody: bodySel.value as BodyType,
        characterRace: raceInput.value.trim(),
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
  // 카테고리별 메타 스키마 로드 (있으면)
  await loadAllSchemas(token);

  // 탭 — Settings 는 별도. asset 탭 클릭 시 inSettings 해제.
  document.querySelectorAll<HTMLButtonElement>('.lib-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.cat;
      if (target === 'settings') {
        inSettings = true;
      } else {
        inSettings = false;
        activeCat = target as Category;
      }
      // 탭 시각 활성: Settings 면 Settings 만, 아니면 activeCat 만
      document.querySelectorAll('.lib-tab').forEach((b) => {
        const t = (b as HTMLElement).dataset.cat;
        const active = inSettings ? t === 'settings' : t === activeCat;
        b.classList.toggle('lib-tab-active', active);
      });
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

// LPC Universal-LPC-Spritesheet-Character-Generator 의 "Split by Animation" ZIP 파싱.
//
// ZIP 구조 (LPC sources/state/zip.ts 의 exportSplitAnimations 결과):
//   standard/<anim>.png    각 표준 액션 (walk, slash, ...). 64px 프레임.
//   custom/<anim>.png      각 커스텀/오버사이즈 액션 (backslash_128 등). 가변 프레임 사이즈.
//   credits/character.json LPC 생성기 state — bodyType, selections, enabledAnimations 등.
//   credits/credits.csv    저작자 정보 (우리는 무시)
//
// 결과: ParsedLpcZip = { thumbnail (Blob PNG), animFiles (Map<anim, File>), character (json) }

import JSZip from 'jszip';

export interface LpcCharacterJson {
  version?: number;
  bodyType?: string;
  selections?: Record<string, unknown>;
  selectedAnimation?: string;
  enabledAnimations?: Record<string, boolean>;
  url?: string;
  layers?: Array<{ itemId: string; supportedAnimations?: string[] }>;
}

export interface ParsedLpcZip {
  /** 업로드할 액션별 PNG. key = 'walk', 'backslash_128' 등. value = 그 액션의 PNG 파일. */
  animFiles: Map<string, File>;
  /** 표준 액션 이름 목록 (LPC ANIMATIONS 의 value 들). */
  standardAnims: string[];
  /** 커스텀(오버사이즈) 액션 이름 목록. */
  customAnims: string[];
  /** LPC 생성기 state JSON (선택). */
  character: LpcCharacterJson | null;
  /** 썸네일용 — walk.png 의 첫 frame 추출. 없으면 standard 중 아무거나에서 발췌. */
  thumbnail: File | null;
}

/** 파일이 LPC ZIP 인지 빠르게 감별 — 확장자 .zip + MIME. */
export function isLpcZipFile(file: File): boolean {
  const lower = file.name.toLowerCase();
  if (!lower.endsWith('.zip')) return false;
  // MIME 신뢰 안 함 — 확장자만으로 판단 (Safari/Chrome 별로 다름)
  return true;
}

/** ZIP 을 풀어서 표준/커스텀 액션 PNG 들과 character.json 을 분리. */
export async function parseLpcZip(file: File): Promise<ParsedLpcZip> {
  const ab = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(ab);

  const animFiles = new Map<string, File>();
  const standardAnims: string[] = [];
  const customAnims: string[] = [];
  let character: LpcCharacterJson | null = null;

  // 각 엔트리 순회
  const entries = Object.values(zip.files);
  for (const e of entries) {
    if (e.dir) continue;
    const path = e.name;
    // standard/walk.png  → action 'walk'
    // custom/backslash_128.png  → action 'backslash_128'
    let m: RegExpExecArray | null;
    if ((m = /^standard\/([^/]+)\.png$/i.exec(path))) {
      const anim = m[1];
      const blob = await e.async('blob');
      animFiles.set(anim, new File([blob], `${anim}.png`, { type: 'image/png' }));
      standardAnims.push(anim);
    } else if ((m = /^custom\/([^/]+)\.png$/i.exec(path))) {
      const anim = m[1];
      const blob = await e.async('blob');
      animFiles.set(anim, new File([blob], `${anim}.png`, { type: 'image/png' }));
      customAnims.push(anim);
    } else if (/^credits\/character\.json$/i.test(path)) {
      try {
        const text = await e.async('text');
        character = JSON.parse(text) as LpcCharacterJson;
      } catch { /* 무시 */ }
    }
  }

  // 썸네일 — walk.png 의 첫 프레임(idle col 0, row=down=2) 또는 첫 standard 액션 활용.
  const walkFile = animFiles.get('walk');
  const fallbackAny = animFiles.values().next().value as File | undefined;
  const sourceForThumb = walkFile ?? fallbackAny ?? null;
  const thumbnail = sourceForThumb ? await extractIdleThumbnail(sourceForThumb) : null;

  return { animFiles, standardAnims, customAnims, character, thumbnail };
}

/** walk.png (4 rows × cycle cols, 64×64) 에서 down direction (row 2) col 0 (idle 가까운 첫 프레임) 추출. */
async function extractIdleThumbnail(animFile: File): Promise<File | null> {
  const url = URL.createObjectURL(animFile);
  try {
    const img = await loadImg(url);
    const FRAME = 64;
    // walk.png 는 4 rows × 8 cols at 64. row=2 (down), col=0.
    const row = img.naturalHeight >= 3 * FRAME ? 2 : 0;
    const col = 0;
    const c = document.createElement('canvas');
    c.width = FRAME; c.height = FRAME;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, col * FRAME, row * FRAME, FRAME, FRAME, 0, 0, FRAME, FRAME);
    const blob = await new Promise<Blob | null>((res) => c.toBlob((b) => res(b), 'image/png'));
    if (!blob) return null;
    return new File([blob], 'thumbnail.png', { type: 'image/png' });
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImg(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(e);
    img.src = src;
  });
}

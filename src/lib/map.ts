// Tiled (mapeditor.org) JSON 맵 로더.
//
// 기본 가정: orthogonal, 임베드 타일셋, data 는 uncompressed array (CSV/base64 지원 X).
// 레이어 이름 규약: ground / decor / objects_below / objects_above / collision / spawns.

export interface Tileset {
  firstgid: number;
  name: string;
  columns: number;
  tilecount: number;
  tilewidth: number;
  tileheight: number;
  image: HTMLImageElement | null; // null = 로드 실패
  imagePath: string;              // 디버그/에러 메시지용
  imageLoaded: boolean;
  imageError: string | null;
  // localId(타일셋 내부 ID) → 타일 내부 좌표(0..tilewidth) 기준 충돌 사각형들.
  // Tiled 의 Tile Collision Editor 로 그린 도형. width/height 0 인 Point 객체는 무시.
  tileCollisions: Map<number, Array<{ x: number; y: number; w: number; h: number }>>;
  // localId → 애니메이션 프레임 시퀀스. duration 은 ms.
  // Tiled 의 Tile Animation Editor 로 만든 데이터.
  tileAnimations: Map<number, Array<{ tileid: number; duration: number }>>;
  // 위의 totalDuration 캐시 (매 프레임 합산 안 하려고)
  tileAnimTotal: Map<number, number>;
  // localId → "캐릭터 위에 그릴" 폴리곤 영역(들). tile-local 절대좌표.
  // Tiled 의 Tile Collision Editor 에서 class/type="above" 인 object 들.
  // 폴리곤 1개 = [[x0,y0], [x1,y1], ...]. 한 타일에 여러 폴리곤 가능.
  tileAboveRegions: Map<number, Array<Array<[number, number]>>>;
}

export type Layer =
  | { kind: 'tile';   id: number; name: string; class?: string; width: number; height: number; data: Uint32Array; visible: boolean }
  | { kind: 'object'; id: number; name: string; class?: string; objects: TmxObject[]; visible: boolean };

export interface TmxObject {
  id: number;
  name?: string;
  type?: string;
  class?: string;             // Tiled 의 object class
  x: number;
  y: number;
  width: number;
  height: number;
  point?: boolean;
  /** tile-object 인 경우 gid. Tiled 에서 object layer 에 타일을 드래그하면 이 필드가 채워진다.
   *  Tiled 의 tile-object 는 (x, y) 가 bottom-left 기준 → 렌더 시 (x, y - height) 가 top-left. */
  gid?: number;
  /** Custom Properties (이름/값 쌍) — Tiled object properties. */
  properties?: Array<{ name: string; type?: string; value: unknown }>;
}

export interface CollisionRect {
  x0: number; y0: number;
  x1: number; y1: number;
}

export interface TileMap {
  widthTiles: number;
  heightTiles: number;
  tileW: number;
  tileH: number;
  pixelW: number;
  pixelH: number;
  layers: Layer[];
  tilesets: Tileset[];
  collisionRects: CollisionRect[];
  spawns: { x: number; y: number }[];
  // Optional: lookup by name
  layerByName: Map<string, Layer>;
}

// 가벼운 raw Tiled JSON 타입 (필요한 필드만)
interface RawMap {
  width: number;
  height: number;
  tilewidth: number;
  tileheight: number;
  tilesets: RawTileset[];
  layers: RawLayer[];
}
interface RawTileset {
  firstgid: number;
  name?: string;
  columns?: number;
  tilecount?: number;
  tilewidth?: number;
  tileheight?: number;
  image?: string;
  imagewidth?: number;
  imageheight?: number;
  source?: string;   // 외부 .tsj 참조 — fetch 해서 embed 처럼 처리
  tiles?: RawTilesetTile[]; // per-tile 데이터 (충돌·애니메이션·속성)
}
interface RawTilesetTile {
  id: number;
  objectgroup?: {
    objects?: Array<{
      x: number;
      y: number;
      width?: number;
      height?: number;
      class?: string;
      type?: string;
    }>;
  };
  animation?: Array<{ tileid: number; duration: number }>;
  /** "캐릭터 위에 그릴" 폴리곤 영역. tile-local 절대좌표. 임포트 스크립트가 변환해 채움. */
  above?: Array<Array<[number, number]>>;
}
interface RawLayer {
  id?: number;
  type: 'tilelayer' | 'objectgroup' | 'group' | string;
  name: string;
  class?: string;           // Tiled 의 layer class (옵션)
  visible?: boolean;
  width?: number;
  height?: number;
  data?: number[] | string; // CSV 문자열 or 배열
  encoding?: string;        // 'csv' or undefined for array
  compression?: string;
  objects?: TmxObject[];
  layers?: RawLayer[];      // group 레이어의 자식들
}

export async function loadMap(jsonUrl: string): Promise<TileMap> {
  const res = await fetch(jsonUrl);
  if (!res.ok) {
    throw new Error(
      `[map] '${jsonUrl}' 를 불러올 수 없습니다 (HTTP ${res.status}).\n` +
      `public/assets/maps/town.json 가 있는지 확인하세요. README 의 '맵 만들기' 섹션 참고.`,
    );
  }
  const raw = (await res.json()) as RawMap;

  // ===== 타일셋 로딩 =====
  const tilesets: Tileset[] = [];
  const jsonDir = jsonUrl.replace(/[^/]*$/, ''); // 디렉토리 경로
  const imagePromises: Promise<void>[] = [];

  for (const tRef of raw.tilesets) {
    // 외부 .tsj 참조면 fetch 해서 embedded 처럼 펼친다.
    let t: RawTileset = tRef;
    let tilesetDir = jsonDir;
    if (tRef.source) {
      const tsjUrl = new URL(tRef.source, location.origin + jsonDir).pathname;
      const tsjRes = await fetch(tsjUrl);
      if (!tsjRes.ok) {
        console.warn(`[map] 외부 타일셋 ${tsjUrl} 로드 실패 (HTTP ${tsjRes.status}). 스킵합니다.`);
        continue;
      }
      const tsjRaw = (await tsjRes.json()) as RawTileset;
      t = { ...tsjRaw, firstgid: tRef.firstgid };
      tilesetDir = tsjUrl.replace(/[^/]*$/, ''); // .tsj 가 있는 폴더 기준으로 image 경로 해석
    }

    const tilewidth  = t.tilewidth  ?? raw.tilewidth;
    const tileheight = t.tileheight ?? raw.tileheight;
    const columns    = t.columns    ?? Math.floor((t.imagewidth ?? 0) / tilewidth);
    const tilecount  = t.tilecount  ?? 0;
    const imagePath  = t.image ? new URL(t.image, location.origin + tilesetDir).pathname : '';

    // per-tile 충돌 도형 모음 — Tile Collision Editor 의 사각형들.
    // width 또는 height 가 0/undefined 인 객체는 Point 도구로 찍은 점이라 무시.
    // class/type="above" 인 object 는 collision 이 아니고 별도 above 영역 (.tsj 의 above 필드에서만 옴).
    const tileCollisions = new Map<number, Array<{ x: number; y: number; w: number; h: number }>>();
    const tileAnimations = new Map<number, Array<{ tileid: number; duration: number }>>();
    const tileAnimTotal = new Map<number, number>();
    const tileAboveRegions = new Map<number, Array<Array<[number, number]>>>();
    for (const tileEntry of t.tiles ?? []) {
      const rects: Array<{ x: number; y: number; w: number; h: number }> = [];
      for (const o of tileEntry.objectgroup?.objects ?? []) {
        const cls = (o.class || o.type || '').toLowerCase();
        if (cls === 'above') continue;   // above 는 .tsj 의 above 필드에서 별도 파싱
        const w = o.width ?? 0;
        const h = o.height ?? 0;
        if (w > 0 && h > 0) rects.push({ x: o.x, y: o.y, w, h });
      }
      if (rects.length > 0) tileCollisions.set(tileEntry.id, rects);
      if (tileEntry.animation && tileEntry.animation.length > 0) {
        tileAnimations.set(tileEntry.id, tileEntry.animation);
        let total = 0;
        for (const f of tileEntry.animation) total += Math.max(1, f.duration);
        tileAnimTotal.set(tileEntry.id, total);
      }
      if (tileEntry.above && tileEntry.above.length > 0) {
        tileAboveRegions.set(tileEntry.id, tileEntry.above);
      }
    }

    const ts: Tileset = {
      firstgid: tRef.firstgid,
      name: t.name ?? 'unnamed',
      columns,
      tilecount,
      tilewidth,
      tileheight,
      image: null,
      imagePath,
      imageLoaded: false,
      imageError: null,
      tileCollisions,
      tileAnimations,
      tileAnimTotal,
      tileAboveRegions,
    };
    tilesets.push(ts);

    if (imagePath) {
      const img = new Image();
      const p = new Promise<void>((resolve) => {
        img.onload = () => { ts.image = img; ts.imageLoaded = true; resolve(); };
        img.onerror = () => {
          ts.imageError = `이미지 로드 실패: ${imagePath}`;
          console.warn(`[map] ${ts.imageError}\n` +
            `해당 폴더에 PNG 파일을 넣어주세요. 없는 동안은 단색 placeholder 로 표시됩니다.`);
          resolve();
        };
        img.src = imagePath;
      });
      imagePromises.push(p);
    }
  }
  // firstgid 오름차순 정렬 (resolveTile 빠른 매칭)
  tilesets.sort((a, b) => a.firstgid - b.firstgid);
  await Promise.all(imagePromises);

  // ===== 레이어 파싱 (group 재귀 평탄화) =====
  const layers: Layer[] = [];
  const layerByName = new Map<string, Layer>();

  const walk = (raws: RawLayer[]): void => {
    for (const rl of raws) {
      if (rl.type === 'tilelayer') {
        if (!rl.data || !rl.width || !rl.height) continue;
        let arr: number[];
        if (typeof rl.data === 'string') {
          if (rl.encoding && rl.encoding !== 'csv') {
            throw new Error(`[map] '${rl.name}' 레이어 encoding=${rl.encoding} 는 미지원. Tiled Export 옵션에서 'CSV' 또는 'array' 로 저장하세요.`);
          }
          arr = rl.data.split(',').map((s) => parseInt(s.trim(), 10));
        } else {
          arr = rl.data;
        }
        const layer: Layer = {
          kind: 'tile',
          id: rl.id ?? 0,
          name: rl.name,
          class: rl.class,
          width: rl.width,
          height: rl.height,
          data: new Uint32Array(arr),
          visible: rl.visible !== false,
        };
        layers.push(layer);
        layerByName.set(rl.name, layer);
      } else if (rl.type === 'objectgroup') {
        const layer: Layer = {
          kind: 'object',
          id: rl.id ?? 0,
          name: rl.name,
          class: rl.class,
          objects: rl.objects ?? [],
          visible: rl.visible !== false,
        };
        layers.push(layer);
        layerByName.set(rl.name, layer);
      } else if (rl.type === 'group') {
        // Tiled 의 그룹 레이어 — 자식들을 그대로 펼친다 (문서 순서 유지).
        if (rl.layers) walk(rl.layers);
      }
    }
  };
  walk(raw.layers);

  // ===== 충돌 모음 =====
  // 두 가지 소스를 합쳐서 만든다:
  //  1) 'collision' 이름의 별도 레이어 (objectgroup or tilelayer) — 레거시/town.json 방식
  //  2) 모든 tile layer 의 각 타일에 대해, 타일셋이 갖는 per-tile 충돌 도형 — zombie_road 방식
  //     (Tiled 의 Tile Collision Editor 에서 그린 사각형들)
  const collisionRects: CollisionRect[] = [];

  // 1) 별도 collision 레이어
  const colLayer = layerByName.get('collision');
  if (colLayer) {
    if (colLayer.kind === 'object') {
      for (const o of colLayer.objects) {
        if (o.width > 0 && o.height > 0) {
          collisionRects.push({
            x0: o.x, y0: o.y,
            x1: o.x + o.width, y1: o.y + o.height,
          });
        }
      }
    } else {
      const tw = raw.tilewidth, th = raw.tileheight;
      for (let i = 0; i < colLayer.data.length; i++) {
        if (colLayer.data[i] !== 0) {
          const tx = i % colLayer.width;
          const ty = Math.floor(i / colLayer.width);
          collisionRects.push({
            x0: tx * tw, y0: ty * th,
            x1: tx * tw + tw, y1: ty * th + th,
          });
        }
      }
    }
  }

  // 2) per-tile 충돌 — 모든 tile layer + object layer 의 gid 객체를 훑으며
  //    각 타일이 자체 충돌박스를 갖는지 확인.
  //    object 의 (x, y) 는 bottom-left 라 top-left 는 (x, y - height) 임에 주의.
  const tw = raw.tilewidth, th = raw.tileheight;
  const matchTileset = (gid: number): Tileset | null => {
    for (let j = tilesets.length - 1; j >= 0; j--) {
      if (gid >= tilesets[j].firstgid) return tilesets[j];
    }
    return null;
  };
  const pushCollisionForGid = (gid: number, worldX0: number, worldY0: number) => {
    const matched = matchTileset(gid);
    if (!matched) return;
    const localId = gid - matched.firstgid;
    const localRects = matched.tileCollisions.get(localId);
    if (!localRects) return;
    for (const lr of localRects) {
      collisionRects.push({
        x0: worldX0 + lr.x,
        y0: worldY0 + lr.y,
        x1: worldX0 + lr.x + lr.w,
        y1: worldY0 + lr.y + lr.h,
      });
    }
  };
  for (const layer of layers) {
    if (layer.kind === 'tile') {
      // class="collision" 레이어 — 타일셋의 충돌박스 무시하고 전체 타일을 막힘으로.
      // (용암/구덩이/물 같이 시각만 위험인 타일들도 통과 못 하게 강제할 때 사용)
      const isFullCollision = (layer.class ?? '').toLowerCase() === 'collision';
      for (let i = 0; i < layer.data.length; i++) {
        const gid = layer.data[i];
        if (gid <= 0) continue;
        const tx = i % layer.width;
        const ty = Math.floor(i / layer.width);
        if (isFullCollision) {
          collisionRects.push({ x0: tx * tw, y0: ty * th, x1: (tx + 1) * tw, y1: (ty + 1) * th });
        } else {
          pushCollisionForGid(gid, tx * tw, ty * th);
        }
      }
    } else if (layer.kind === 'object') {
      for (const o of layer.objects) {
        if (!o.gid) continue;
        // tile-object 의 top-left 는 (x, y - height). height 가 없으면 tilewidth 가정.
        const objH = o.height > 0 ? o.height : th;
        pushCollisionForGid(o.gid, o.x, o.y - objH);
      }
    }
  }

  // ===== 스폰 모음 =====
  const spawns: { x: number; y: number }[] = [];
  const spawnLayer = layerByName.get('spawns');
  if (spawnLayer && spawnLayer.kind === 'object') {
    for (const o of spawnLayer.objects) {
      // Point object 의 (x, y) 또는 사각형의 중앙
      const cx = o.point ? o.x : o.x + o.width / 2;
      const cy = o.point ? o.y : o.y + o.height / 2;
      spawns.push({ x: cx, y: cy });
    }
  }

  return {
    widthTiles: raw.width,
    heightTiles: raw.height,
    tileW: raw.tilewidth,
    tileH: raw.tileheight,
    pixelW: raw.width * raw.tilewidth,
    pixelH: raw.height * raw.tileheight,
    layers,
    tilesets,
    collisionRects,
    spawns,
    layerByName,
  };
}

// gid → 타일셋 + sx/sy 매핑.
export function resolveTile(map: TileMap, gid: number):
  { tileset: Tileset; sx: number; sy: number; localId: number } | null
{
  if (gid <= 0) return null;
  for (let i = map.tilesets.length - 1; i >= 0; i--) {
    const ts = map.tilesets[i];
    if (gid >= ts.firstgid) {
      const localId = gid - ts.firstgid;
      const col = localId % ts.columns;
      const row = Math.floor(localId / ts.columns);
      return { tileset: ts, sx: col * ts.tilewidth, sy: row * ts.tileheight, localId };
    }
  }
  return null;
}

// gid 의 타일이 자체 충돌박스를 갖는지 — object-layer 트리에서 줄기(true)/잎(false) 구분에 사용.
export function tileHasCollision(map: TileMap, gid: number): boolean {
  if (gid <= 0) return false;
  for (let i = map.tilesets.length - 1; i >= 0; i--) {
    const ts = map.tilesets[i];
    if (gid < ts.firstgid) continue;
    const localId = gid - ts.firstgid;
    const rects = ts.tileCollisions.get(localId);
    return !!(rects && rects.length > 0);
  }
  return false;
}

// 애니메이션 타일이면 nowSec 기준 현재 프레임 gid 반환. 아니면 원본 gid 그대로.
// nowSec 가 안 들어오면 항상 첫 프레임만 보임 (정적).
export function resolveAnimatedGid(map: TileMap, gid: number, nowSec: number | null): number {
  if (gid <= 0 || nowSec === null) return gid;
  // 어떤 타일셋의 타일인지 — firstgid 기반.
  for (let i = map.tilesets.length - 1; i >= 0; i--) {
    const ts = map.tilesets[i];
    if (gid < ts.firstgid) continue;
    const localId = gid - ts.firstgid;
    const frames = ts.tileAnimations.get(localId);
    if (!frames) return gid;       // 정적 타일
    const total = ts.tileAnimTotal.get(localId) ?? 0;
    if (total <= 0) return gid;
    const t = (nowSec * 1000) % total;
    let acc = 0;
    for (const f of frames) {
      acc += Math.max(1, f.duration);
      if (t < acc) return ts.firstgid + f.tileid;
    }
    return ts.firstgid + frames[frames.length - 1].tileid;
  }
  return gid;
}

// 타일 한 칸 그리기 — 이미지 로드됐으면 drawImage, 아니면 placeholder 색.
// nowSec 가 들어오면 애니메이션 타일은 현재 프레임으로 자동 교체.
export function drawTile(
  ctx: CanvasRenderingContext2D,
  map: TileMap,
  gid: number,
  dx: number,
  dy: number,
  nowSec: number | null = null,
): void {
  if (gid <= 0) return;
  const animGid = resolveAnimatedGid(map, gid, nowSec);
  const r = resolveTile(map, animGid);
  if (!r) return;
  if (r.tileset.image && r.tileset.imageLoaded) {
    ctx.drawImage(
      r.tileset.image,
      r.sx, r.sy, r.tileset.tilewidth, r.tileset.tileheight,
      dx, dy, r.tileset.tilewidth, r.tileset.tileheight,
    );
  } else {
    // Placeholder: gid 별로 다른 파스텔 색
    ctx.fillStyle = placeholderColor(gid);
    ctx.fillRect(dx, dy, r.tileset.tilewidth, r.tileset.tileheight);
    // 살짝 외곽 (격자 보이게)
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fillRect(dx, dy, r.tileset.tilewidth, 1);
    ctx.fillRect(dx, dy, 1, r.tileset.tileheight);
  }
}

function placeholderColor(gid: number): string {
  // 결정론적 hue
  const hue = (gid * 37) % 360;
  return `hsl(${hue}, 35%, 55%)`;
}

// 한 타일 레이어를 카메라 기준으로 그린다.
// nowSec 가 들어오면 애니메이션 타일이 시간에 따라 자동 전환.
export function drawTileLayer(
  ctx: CanvasRenderingContext2D,
  map: TileMap,
  layer: Layer,
  cameraX: number,
  cameraY: number,
  viewW: number,
  viewH: number,
  nowSec: number | null = null,
): void {
  if (layer.kind !== 'tile' || !layer.visible) return;
  const tw = map.tileW, th = map.tileH;
  const tx0 = Math.max(0, Math.floor(cameraX / tw));
  const ty0 = Math.max(0, Math.floor(cameraY / th));
  const tx1 = Math.min(layer.width  - 1, Math.floor((cameraX + viewW) / tw));
  const ty1 = Math.min(layer.height - 1, Math.floor((cameraY + viewH) / th));
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const gid = layer.data[ty * layer.width + tx];
      if (gid <= 0) continue;
      drawTile(ctx, map, gid, Math.round(tx * tw - cameraX), Math.round(ty * th - cameraY), nowSec);
    }
  }
}

// 충돌 검사: 발박스 AABB 가 충돌 영역에 부딪히면 true.
export function isBlocked(map: TileMap, cx: number, cy: number, hw: number, hh: number): boolean {
  const x0 = cx - hw, y0 = cy - hh, x1 = cx + hw, y1 = cy + hh;
  // 월드 경계
  if (x0 < 0 || y0 < 0 || x1 > map.pixelW || y1 > map.pixelH) return true;
  // 충돌 사각형 목록
  for (const r of map.collisionRects) {
    if (x0 < r.x1 && x1 > r.x0 && y0 < r.y1 && y1 > r.y0) return true;
  }
  return false;
}

// 디버그용 — 충돌 영역 시각화
export function drawCollisionDebug(
  ctx: CanvasRenderingContext2D, map: TileMap,
  cameraX: number, cameraY: number,
): void {
  ctx.save();
  ctx.fillStyle = 'rgba(255, 80, 80, 0.35)';
  ctx.strokeStyle = 'rgba(255, 40, 40, 0.85)';
  ctx.lineWidth = 1;
  for (const r of map.collisionRects) {
    const dx = Math.round(r.x0 - cameraX);
    const dy = Math.round(r.y0 - cameraY);
    const w  = Math.round(r.x1 - r.x0);
    const h  = Math.round(r.y1 - r.y0);
    ctx.fillRect(dx, dy, w, h);
    ctx.strokeRect(dx + 0.5, dy + 0.5, w - 1, h - 1);
  }
  ctx.restore();
}

export function drawGridDebug(
  ctx: CanvasRenderingContext2D, map: TileMap,
  cameraX: number, cameraY: number, viewW: number, viewH: number,
): void {
  ctx.save();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
  ctx.lineWidth = 1;
  const tw = map.tileW, th = map.tileH;
  const tx0 = Math.max(0, Math.floor(cameraX / tw));
  const ty0 = Math.max(0, Math.floor(cameraY / th));
  const tx1 = Math.min(map.widthTiles,  Math.floor((cameraX + viewW) / tw) + 1);
  const ty1 = Math.min(map.heightTiles, Math.floor((cameraY + viewH) / th) + 1);
  ctx.beginPath();
  for (let tx = tx0; tx <= tx1; tx++) {
    const x = Math.round(tx * tw - cameraX) + 0.5;
    ctx.moveTo(x, 0); ctx.lineTo(x, viewH);
  }
  for (let ty = ty0; ty <= ty1; ty++) {
    const y = Math.round(ty * th - cameraY) + 0.5;
    ctx.moveTo(0, y); ctx.lineTo(viewW, y);
  }
  ctx.stroke();
  ctx.restore();
}

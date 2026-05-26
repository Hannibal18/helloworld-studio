// 캐릭터 + 댄스 픽셀 아트는 코드 기반.
// 타일은 map.ts 의 Tiled JSON 로더가 직접 처리한다 (이미지 기반, 코드로 안 그림).

import type { Dir } from './types';

// 픽셀 한 점/사각형 헬퍼 (댄스 모듈이 사용).
function px(ctx: CanvasRenderingContext2D, x: number, y: number, c: string): void {
  ctx.fillStyle = c;
  ctx.fillRect(x | 0, y | 0, 1, 1);
}
function rect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, c: string): void {
  ctx.fillStyle = c;
  ctx.fillRect(x | 0, y | 0, w | 0, h | 0);
}

// ===== 캐릭터 (LPC 스프라이트시트 기반) =====
// public/sprites/characters/00.png ~ 09.png : 각 832×3456, 64×64 프레임 × 13 cols × 54 rows.
// LPC 생성기로 미리 만들어 둔 10개의 랜덤 캐릭터 — 입장 시 한 명당 하나 배정.
// LPC (Liberated Pixel Cup) 표준 행 배치 (이 프로젝트에서 실제로 쓰는 것만):
//   4~7:   Thrust    (Up/Left/Down/Right) — 8 frames (현재 미사용, 호환 위해 매핑만 유지)
//   8~11:  Walk      — 9 frames (0=idle, 1-8=walk cycle) — idle 정지 자세용
//   20:    Hurt/Die  — 6 frames (마지막 프레임 = 쓰러진 자세)
//   38~41: Run       — 8 frames (모두 stride, idle 프레임 없음) — 이동 사이클
//   50~53: Halfslash — 6 frames (작은 호 슬래시) — 공격 모션 (col 4 = 임팩트 hold)
//
// 스케일 정책: 시작 시 한 번 prescale 해서 offscreen canvas 에 캐싱.
// 매 프레임은 그 캐싱된 sheet 를 1:1 로 drawImage → 픽셀 또렷.

const SOURCE_FRAME = 64;            // 원본 LPC 프레임 크기
const SOURCE_FOOT_Y = 58;           // 프레임 안에서 발 y 위치

export const CHARACTER_COUNT = 9;   // public/sprites/characters/ 안의 시트 개수

// 기본값 — prescaleCharacter 가 호출되면 갱신됨. 캐논 LPC 비례 32×48 가까이.
export let CHAR_W = 32;
export let CHAR_H = 48;

const spritesheets: HTMLImageElement[] = [];
const readyFlags: boolean[] = [];
const loadPromises: Promise<void>[] = [];
for (let i = 0; i < CHARACTER_COUNT; i++) {
  const img = new Image();
  const idx = String(i).padStart(2, '0');
  img.src = `/sprites/characters/${idx}.png`;
  spritesheets.push(img);
  readyFlags.push(false);
  loadPromises.push(new Promise<void>((resolve) => {
    img.onload = () => { readyFlags[i] = true; resolve(); };
    img.onerror = () => { readyFlags[i] = false; resolve(); };
  }));
}

const prescaledSheets: (HTMLCanvasElement | null)[] = new Array(CHARACTER_COUNT).fill(null);
let prescaledFrame = SOURCE_FRAME;
// 외부 모듈(예: zombie 렌더) 에서 현재 캐릭터 prescale 비율을 조회 — 동기화용.
export function currentCharScale(): number { return prescaledFrame / SOURCE_FRAME; }
let prescaledFootY = SOURCE_FOOT_Y;
let pendingScale: number | null = null;

// ===== 비석 (사망 시 캐릭터 대신 표시) =====
const tombstone = new Image();
tombstone.src = '/sprites/tombstone.png';
let tombstoneReady = false;
tombstone.onload = () => { tombstoneReady = true; };

// 공격 모션을 halfslash 로 바꾼 뒤 scripts/check-halfslash.mjs 로 전체 캐릭터의
// halfslash 프레임이 모두 정상임을 확인 — 10개 전부 사용 가능.
export function randomCharIdx(): number {
  return Math.floor(Math.random() * CHARACTER_COUNT);
}

// 인트로 미리보기용 — prescale 전이라도 원본 시트에서 직접 한 프레임 그려준다.
// 캔버스 사이즈는 호출자가 정한 (정수배 2× 권장). 걷기 행의 idle 프레임(col 0) 사용.
// 시트가 아직 로딩 중이면 로드 대기 후 그린다.
export async function drawCharacterPreview(
  ctx: CanvasRenderingContext2D,
  charIdx: number,
  dir: Dir = 'down',
): Promise<void> {
  const safe = ((charIdx % CHARACTER_COUNT) + CHARACTER_COUNT) % CHARACTER_COUNT;
  await loadPromises[safe];
  if (!readyFlags[safe]) return;
  const sheet = spritesheets[safe];
  const row = ROW_WALK[dir];
  const F = SOURCE_FRAME;
  const cw = ctx.canvas.width;
  const ch = ctx.canvas.height;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, cw, ch);
  ctx.drawImage(sheet, 0, row * F, F, F, 0, 0, cw, ch);
}

// 시작 시 1회, 또는 디버그 패널 슬라이더에서 호출.
// scale 은 일반적으로 0.3~0.7 사이. 32 ÷ 64 = 0.5 가 기본.
// 시트가 아직 로딩 중이면, 끝난 시트만 먼저 prescale 하고 나머지는 로딩 완료 시 채운다.
export function prescaleCharacter(scale: number): void {
  pendingScale = scale;
  const F = Math.max(8, Math.round(SOURCE_FRAME * scale));
  prescaledFrame = F;
  prescaledFootY = Math.round(SOURCE_FOOT_Y * scale);
  // 시각 영역 추정 (캐릭터 픽셀이 프레임의 약 50% 폭, 75% 높이를 차지)
  CHAR_W = Math.round(F * 0.55);
  CHAR_H = Math.round(F * 0.78);

  for (let i = 0; i < CHARACTER_COUNT; i++) {
    if (readyFlags[i]) {
      prescaleOne(i, scale);
    } else {
      const target = scale;
      void loadPromises[i].then(() => {
        if (readyFlags[i] && pendingScale === target) prescaleOne(i, target);
      });
    }
  }
}

function prescaleOne(i: number, scale: number): void {
  const src = spritesheets[i];
  const w = Math.round(src.width * scale);
  const h = Math.round(src.height * scale);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const cx = c.getContext('2d')!;
  // 다운스케일 품질 — 한 번만 일어나므로 bilinear/이중 보간 ON.
  cx.imageSmoothingEnabled = true;
  cx.imageSmoothingQuality = 'high';
  cx.drawImage(src, 0, 0, w, h);
  prescaledSheets[i] = c;
}

const ROW_WALK:      Record<Dir, number> = { up: 8,  left: 9,  down: 10, right: 11 };
const ROW_RUN:       Record<Dir, number> = { up: 38, left: 39, down: 40, right: 41 };
const ROW_HALFSLASH: Record<Dir, number> = { up: 50, left: 51, down: 52, right: 53 };

// 한손 halfslash 공격 시퀀스 — 정지 → 와인드업 → 임팩트 hold → 회수 → 정착.
// attackPhase(0~1) 구간별로 다른 LPC 행/프레임을 골라 그린다. 임팩트 프레임(halfslash col 4)을
// 130ms 길게 hold 해서 "휙!" 임팩트가 또렷이 보이게 함. 합계 260ms = ATTACK_SWING_DUR.
//
// 'walk' → ROW_WALK[dir], col 0 (idle 정지 자세 — 공격 시작/종료 bookend)
// 'halfslash' → ROW_HALFSLASH[dir], col N (슬래시 N번째 프레임, 총 6프레임)
type PunchStep = { until: number; src: 'walk' | 'halfslash'; col: number };
const PUNCH_SEQUENCE: readonly PunchStep[] = [
  { until: 30  / 260, src: 'walk',      col: 0 }, // 30ms  — 정지 자세
  { until: 70  / 260, src: 'halfslash', col: 2 }, // 40ms  — 와인드업 (팔 뒤로)
  { until: 200 / 260, src: 'halfslash', col: 4 }, // 130ms — 임팩트 hold (팔 쭉 뻗음)
  { until: 230 / 260, src: 'halfslash', col: 5 }, // 30ms  — 회수 시작
  { until: 1.0,       src: 'walk',      col: 0 }, // 30ms  — 정착
];

// 색을 약간 어둡게/밝게 (댄스 모듈이 사용).
function shade(hex: string, amt: number): string {
  const c = hex.replace('#', '');
  const r = Math.max(0, Math.min(255, parseInt(c.slice(0, 2), 16) + amt));
  const g = Math.max(0, Math.min(255, parseInt(c.slice(2, 4), 16) + amt));
  const b = Math.max(0, Math.min(255, parseInt(c.slice(4, 6), 16) + amt));
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

// footX, footY = 화면(캔버스, 백버퍼 논리 좌표) 기준 — 발의 가운데/아래.
// charIdx = 어느 캐릭터 시트를 쓸지 (0 ~ CHARACTER_COUNT-1).
// attackPhase: -1 = 비공격, 0~1 = 공격 진행률.
// now: 걷기 사이클 시간 (performance.now()/1000).
export function drawCharacter(
  ctx: CanvasRenderingContext2D,
  footX: number,
  footY: number,
  charIdx: number,
  dir: Dir,
  moving: boolean,
  attackPhase: number,
  dead: boolean,
  now: number,
): void {
  const safeIdx = ((charIdx % CHARACTER_COUNT) + CHARACTER_COUNT) % CHARACTER_COUNT;
  const sheet = prescaledSheets[safeIdx];
  if (!sheet) {
    // 스프라이트시트/prescale 준비 전 폴백 — 회색 원
    ctx.save();
    ctx.fillStyle = '#888';
    ctx.beginPath();
    ctx.ellipse(footX, footY - 12, 4, 10, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }

  // 사망 시: 캐릭터 스프라이트 대신 비석을 그린다.
  // 발 위치(footX, footY)에 비석 바닥이 오도록 — 비석을 발 위에 세움.
  if (dead) {
    if (tombstoneReady) {
      const tw = tombstone.naturalWidth;
      const th = tombstone.naturalHeight;
      const dx = Math.round(footX - tw / 2);
      const dy = Math.round(footY - th);
      ctx.drawImage(tombstone, dx, dy);
    } else {
      // 비석 로드 전 폴백 — 회색 십자 원
      ctx.save();
      ctx.fillStyle = '#888';
      ctx.beginPath();
      ctx.ellipse(footX, footY - 8, 6, 12, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    return;
  }

  let row: number;
  let frame: number;
  let idleBobY = 0;
  if (attackPhase >= 0) {
    // 한손 halfslash 공격 — PUNCH_SEQUENCE 의 시간 구간별 프레임 선택.
    const step = PUNCH_SEQUENCE.find((s) => attackPhase < s.until) ?? PUNCH_SEQUENCE[PUNCH_SEQUENCE.length - 1];
    row = step.src === 'walk' ? ROW_WALK[dir] : ROW_HALFSLASH[dir];
    frame = step.col;
  } else if (moving) {
    // 러닝 사이클 — 8프레임 전부 stride (walk 처럼 idle col 0 건너뛰지 않음).
    // 속도는 walk(8/sec) 대비 1.5× 빠르게.
    row = ROW_RUN[dir];
    frame = Math.floor(now * 12) % 8;
  } else {
    row = ROW_WALK[dir];
    frame = 0;
    // idle 호흡 — 약 1.6초 주기, 반주기마다 1px 위아래
    idleBobY = Math.sin(now * 3.8) > 0 ? -1 : 0;
  }

  const F = prescaledFrame;
  const dx = Math.round(footX - F / 2);
  const dy = Math.round(footY - prescaledFootY) + idleBobY;

  ctx.drawImage(sheet, frame * F, row * F, F, F, dx, dy, F, F);
}

// 더 이상 색 구분 안 함 (이름/HP바로 구분). 댄스 모듈 호환을 위해 더미 유지.
export function randomCharColor(): string {
  return '#c84a4a';
}

// ===== 제로투 댄스 (2배 크기, 4 포즈 사이클) =====
// 핵심: 상체와 하체가 반대 방향으로 카운터 스웨이하는 S 커브 (snake-like).
// 손 동작은 자연스럽게 옆에 늘어뜨림 (V 사인/하트 같은 거 없음).
// B급 감성 유지: 핑크 머리 + 호온 임시 변신.

export const DANCE_W = 48;
export const DANCE_H = 68; // 호온이 머리 위로 솟으니 살짝 여유

// 댄스 한 사이클당 시간 — 4 포즈 × 0.2초 = 0.8초.
const POSE_DUR = 0.2;

export function dancePoseFrame(now: number, danceStart: number): 0 | 1 | 2 | 3 {
  const t = now - danceStart;
  const idx = Math.floor(t / POSE_DUR) % 4;
  return idx as 0 | 1 | 2 | 3;
}

// footX, footY = 발이 닿는 월드 픽셀의 캔버스 좌표 (caller 가 변환해서 전달).
//
// 진짜 제로투 댄스의 핵심: 상체와 하체가 반대 방향으로 흔들리는 S 커브 (카운터 스웨이).
//   - hipX:      하체(다리/엉덩이) 가로 이동량
//   - bodyX:     상체(허리/가슴/어깨/머리) 가로 이동량 — hipX 와 반대 방향
//   - bodyBobY:  살짝 위아래 흔들림 (비트 살리기용)
// 4 프레임: 우측 스웨이 → 중앙(아래) → 좌측 스웨이 → 중앙(위) — 0.8초 사이클.
export function drawDancing(
  ctx: CanvasRenderingContext2D,
  footX: number,
  footY: number,
  color: string,
  poseFrame: 0 | 1 | 2 | 3,
): void {
  const dx = Math.round(footX - DANCE_W / 2);
  const dy = Math.round(footY - DANCE_H);

  ctx.save();
  ctx.translate(dx, dy);

  // ===== 팔레트 =====
  const robe = color;
  const robeDark = shade(color, -45);
  const robeLight = shade(color, 28);
  const skin = '#fbd5b5';
  const skinDark = '#c08866';
  const hair = '#ff5d8f';      // Zero Two 핑크
  const hairLight = '#ffa6c8';
  const hairDark = '#cc3a6d';
  const horn = '#ff7aa6';
  const hornDark = '#cc4a78';
  const hornHi = '#ffd0e0';
  const outline = '#1a0e08';
  const foot = '#3a2a1a';
  const blush = '#ff9eb4';
  const white = '#ffffff';
  const eyeBlk = '#1a0e08';

  // ===== 카운터 스웨이 (제로투 댄스의 본질) =====
  // 0: 하체 우측 / 상체 좌측
  // 1: 중앙, 살짝 가라앉음
  // 2: 하체 좌측 / 상체 우측
  // 3: 중앙, 살짝 위로
  const hipX  = poseFrame === 0 ?  3 : poseFrame === 2 ? -3 : 0;
  const bodyX = poseFrame === 0 ? -2 : poseFrame === 2 ?  2 : 0;
  const bodyBobY = poseFrame === 1 ?  1 : poseFrame === 3 ? -1 : 0;
  // 머리는 어깨를 따라가되 살짝 반대 — 살아있는 느낌
  const headX = bodyX + (poseFrame === 0 ? -1 : poseFrame === 2 ? 1 : 0);

  // ===== 그림자 (발 중심 — 좌우 이동에 무관하게 고정) =====
  ctx.fillStyle = 'rgba(0,0,0,0.32)';
  ctx.beginPath();
  ctx.ellipse(DANCE_W / 2, DANCE_H - 2, 13, 3.6, 0, 0, Math.PI * 2);
  ctx.fill();

  // ===== 다리 (hipX 따라감) =====
  const legBaseY = 46 + bodyBobY;
  const legBottomY = 64;
  const legL_x = 17 + hipX;
  const legR_x = 25 + hipX;
  // 허벅지 (로브)
  rect(ctx, legL_x, legBaseY, 5, 8, robe);
  rect(ctx, legR_x, legBaseY, 5, 8, robe);
  // 무릎 음영
  rect(ctx, legL_x, legBaseY + 7, 5, 1, robeDark);
  rect(ctx, legR_x, legBaseY + 7, 5, 1, robeDark);
  // 종아리 (검은 스타킹)
  rect(ctx, legL_x + 1, legBaseY + 8, 3, 8, '#222');
  rect(ctx, legR_x + 1, legBaseY + 8, 3, 8, '#222');
  // 스타킹 상단 트림
  rect(ctx, legL_x, legBaseY + 8, 5, 1, white);
  rect(ctx, legR_x, legBaseY + 8, 5, 1, white);
  // 신발
  rect(ctx, legL_x - 1, legBottomY - 1, 7, 2, foot);
  rect(ctx, legR_x - 1, legBottomY - 1, 7, 2, foot);
  // 다리 외곽
  rect(ctx, legL_x - 1, legBaseY, 1, 16, outline);
  rect(ctx, legL_x + 5, legBaseY, 1, 16, outline);
  rect(ctx, legR_x - 1, legBaseY, 1, 16, outline);
  rect(ctx, legR_x + 5, legBaseY, 1, 16, outline);

  // ===== 허리/엉덩이 트림 — 하체와 상체의 연결부 =====
  // hipX 위치에 흰 벨트 (트림) 한 줄. 시각적 절단선 역할.
  const beltY = 44 + bodyBobY;
  rect(ctx, 13 + hipX, beltY, 22, 2, white);
  rect(ctx, 13 + hipX, beltY, 22, 1, '#dddddd');

  // ===== 몸통 (bodyX 따라감 — hipX 와 반대) =====
  const torsoX = 13 + bodyX;
  const torsoY = 30 + bodyBobY;
  const torsoW = 22;
  const torsoH = 14;
  rect(ctx, torsoX, torsoY, torsoW, torsoH, robe);
  // 측면 굴곡
  rect(ctx, torsoX - 1, torsoY + 3, 1, torsoH - 6, robe);
  rect(ctx, torsoX + torsoW, torsoY + 3, 1, torsoH - 6, robe);
  // 가슴 하이라이트
  rect(ctx, torsoX + 2, torsoY + 2, 3, 6, robeLight);
  rect(ctx, torsoX + torsoW - 5, torsoY + 2, 3, 6, robeLight);
  // 칼라/네크라인
  rect(ctx, torsoX + 6, torsoY, torsoW - 12, 2, robeDark);
  // 가운데 골드 버튼
  px(ctx, torsoX + (torsoW >> 1) - 1, torsoY + 4, '#ffd700');
  px(ctx, torsoX + (torsoW >> 1) + 1, torsoY + 4, '#ffd700');
  px(ctx, torsoX + (torsoW >> 1) - 1, torsoY + 8, '#ffd700');
  px(ctx, torsoX + (torsoW >> 1) + 1, torsoY + 8, '#ffd700');
  // 외곽
  rect(ctx, torsoX - 1, torsoY, 1, torsoH, outline);
  rect(ctx, torsoX + torsoW, torsoY, 1, torsoH, outline);

  // ===== 목 =====
  rect(ctx, 22 + bodyX, 27 + bodyBobY, 4, 4, skin);
  rect(ctx, 22 + bodyX, 30 + bodyBobY, 4, 1, skinDark);
  rect(ctx, 21 + bodyX, 27 + bodyBobY, 1, 4, outline);
  rect(ctx, 26 + bodyX, 27 + bodyBobY, 1, 4, outline);

  // ===== 머리 =====
  const hX = 16 + headX;
  const hY = 10 + bodyBobY;
  // 머리 베이스
  rect(ctx, hX, hY, 16, 16, skin);
  rect(ctx, hX, hY - 1, 16, 1, outline);
  rect(ctx, hX, hY + 16, 16, 1, outline);
  rect(ctx, hX - 1, hY, 1, 16, outline);
  rect(ctx, hX + 16, hY, 1, 16, outline);
  // 턱 음영
  rect(ctx, hX + 4, hY + 14, 8, 1, skinDark);

  // 핑크 머리카락 + 가르마
  rect(ctx, hX, hY, 16, 7, hair);
  rect(ctx, hX + 7, hY, 2, 4, hairDark);
  rect(ctx, hX - 1, hY + 6, 2, 7, hair);
  rect(ctx, hX + 15, hY + 6, 2, 7, hair);
  rect(ctx, hX - 2, hY + 7, 1, 5, hairDark);
  rect(ctx, hX + 16, hY + 7, 1, 5, hairDark);
  rect(ctx, hX + 2, hY + 1, 3, 2, hairLight);
  rect(ctx, hX + 11, hY + 1, 2, 1, hairLight);
  rect(ctx, hX, hY - 1, 16, 1, hairDark);

  // 핑크 호온 (정수리 양쪽)
  rect(ctx, hX + 2, hY - 4, 3, 4, horn);
  rect(ctx, hX + 3, hY - 6, 2, 2, horn);
  px(ctx, hX + 3, hY - 7, horn);
  rect(ctx, hX + 2, hY - 4, 1, 3, hornDark);
  px(ctx, hX + 4, hY - 5, hornHi);
  rect(ctx, hX + 11, hY - 4, 3, 4, horn);
  rect(ctx, hX + 11, hY - 6, 2, 2, horn);
  px(ctx, hX + 12, hY - 7, horn);
  rect(ctx, hX + 13, hY - 4, 1, 3, hornDark);
  px(ctx, hX + 11, hY - 5, hornHi);

  // 눈 (모든 프레임 동일 — 자신감 있는 정면 응시)
  const eyeY = hY + 8;
  rect(ctx, hX + 3, eyeY, 3, 3, eyeBlk);
  rect(ctx, hX + 10, eyeY, 3, 3, eyeBlk);
  px(ctx, hX + 4, eyeY, white);
  px(ctx, hX + 11, eyeY, white);
  px(ctx, hX + 4, eyeY + 1, '#3aa0c8');
  px(ctx, hX + 11, eyeY + 1, '#3aa0c8');

  // 볼터치
  rect(ctx, hX + 1, hY + 11, 3, 2, blush);
  rect(ctx, hX + 12, hY + 11, 3, 2, blush);

  // 입 (살짝 미소)
  rect(ctx, hX + 6, hY + 12, 4, 1, eyeBlk);
  px(ctx, hX + 5, hY + 12, eyeBlk);
  px(ctx, hX + 10, hY + 12, eyeBlk);

  // ===== 팔 — 자연스럽게 늘어뜨려 하체 따라 스윙 =====
  // 어깨는 bodyX 위치, 손끝은 hipX 쪽으로 휘어짐 (몸이 휘는 효과)
  drawSwingingArms(ctx, bodyX, hipX, bodyBobY, { robe, robeDark, skin, outline, white });

  ctx.restore();
}

// 양쪽 팔을 자연스럽게 내린다. 어깨는 상체(bodyX) 에, 손끝은 하체(hipX) 쪽으로 살짝 휘어짐.
// 카운터 스웨이의 곡선을 시각적으로 강조.
function drawSwingingArms(
  ctx: CanvasRenderingContext2D,
  bodyX: number,
  hipX: number,
  bobY: number,
  pal: { robe: string; robeDark: string; skin: string; outline: string; white: string },
): void {
  const { robe, robeDark, skin, outline, white } = pal;

  // 팔꿈치 가로 위치는 어깨와 손목의 중간 — bodyX 와 hipX 의 중간점
  const midX = Math.round((bodyX + hipX) / 2);

  // 왼팔
  const lShoulderX = 11 + bodyX;
  const lWristX = 12 + hipX;
  const lElbowX = 11 + midX;
  // 어깨
  rect(ctx, lShoulderX, 30 + bobY, 4, 4, robe);
  // 위팔 (어깨→팔꿈치)
  rect(ctx, lElbowX, 33 + bobY, 4, 7, robeDark);
  // 흰 소매 라인
  rect(ctx, lElbowX, 39 + bobY, 4, 1, white);
  // 아래팔 (팔꿈치→손목)
  rect(ctx, lWristX, 40 + bobY, 4, 6, robeDark);
  // 손
  rect(ctx, lWristX, 46 + bobY, 4, 3, skin);
  // 외곽 (간단히 양쪽만)
  rect(ctx, lElbowX - 1, 33 + bobY, 1, 7, outline);
  rect(ctx, lElbowX + 4, 33 + bobY, 1, 7, outline);
  rect(ctx, lWristX - 1, 40 + bobY, 1, 9, outline);
  rect(ctx, lWristX + 4, 40 + bobY, 1, 9, outline);

  // 오른팔 (대칭)
  const rShoulderX = 33 + bodyX;
  const rWristX = 32 + hipX;
  const rElbowX = 33 + midX;
  rect(ctx, rShoulderX, 30 + bobY, 4, 4, robe);
  rect(ctx, rElbowX, 33 + bobY, 4, 7, robeDark);
  rect(ctx, rElbowX, 39 + bobY, 4, 1, white);
  rect(ctx, rWristX, 40 + bobY, 4, 6, robeDark);
  rect(ctx, rWristX, 46 + bobY, 4, 3, skin);
  rect(ctx, rElbowX - 1, 33 + bobY, 1, 7, outline);
  rect(ctx, rElbowX + 4, 33 + bobY, 1, 7, outline);
  rect(ctx, rWristX - 1, 40 + bobY, 1, 9, outline);
  rect(ctx, rWristX + 4, 40 + bobY, 1, 9, outline);
}

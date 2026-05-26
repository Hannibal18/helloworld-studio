# Helloworld Studio

게임 컷씬 영상 편집기. 타일드 맵 + LPC 캐릭터 + BGM + 말풍선을 조합해서 컷씬을 만들고
`.json` 으로 내보내면 어떤 캔버스 게임에서든 `playCutscene()` 한 줄로 재생할 수 있다.

## 핵심 기능

- 🎞 다중 씬 + 전환 효과 (cut / fade-black / fade-white / wipe)
- 👤 캐릭터 실시간 녹화 (60Hz 키프레임) — 키보드 WASD / 모바일 가상 조이스틱
- 🎥 카메라 트랙 녹화 — 조이스틱 패닝 + 줌 인/아웃 버튼
- 💬 말풍선 — 캐릭터/시점/지속시간/타이프라이터 효과 + cps 조절
- 🎵 BGM — fadeIn/fadeOut/볼륨/루프 + 씬 간 자동 교체
- 📥📤 JSON Import / Export
- 💾 LocalStorage 자동 저장 (새로고침 안전)
- 📱 PC + 모바일 풀 편집 지원

## 실행

```bash
npm install
npm run dev
```

브라우저 `http://localhost:5174` 접속.

## 빌드

```bash
npm run build      # → dist/
npm run preview    # 빌드 결과 미리보기
```

## 컷씬을 게임에 삽입

`src/runtime/player.ts` 를 게임에 복사해 두고:

```ts
import { playCutscene } from './runtime/player';
import intro from '/cutscenes/intro.json';

playCutscene(intro, gameCanvas, {
  onComplete: () => startGame(),
});
```

플레이어는 어떤 캔버스 게임에도 붙는다 — 게임 코드에 어떤 의존도 강요하지 않음.

## 디렉토리

```
src/
  main.ts         # 부트스트랩
  state.ts        # 상태 + 구독
  stage.ts        # 프리뷰 렌더
  playback.ts     # 녹화/재생 엔진
  timeline.ts     # 타임라인 UI
  props.ts        # 우측 속성 패널
  bin.ts          # 좌측 미디어 빈
  scenes.ts       # 상단 씬 탭
  audio.ts        # BGM 페이드 엔진
  export.ts       # JSON 직렬화/역직렬화
  touch.ts        # 모바일 드로워/조이스틱/줌
  input.ts        # 키보드+조이스틱 입력
  util.ts         # 공용 헬퍼
  style.css       # 다크 테마
  lib/            # 게임에서 가져온 독립 복사본 — 외부 의존 0
    map.ts        # Tiled JSON 로더
    sprites.ts    # LPC 캐릭터 렌더
    types.ts      # Dir 등 공유 타입
  runtime/        # 게임이 컷씬 재생할 때 가져갈 모듈
    player.ts     # playCutscene()
public/
  maps/           # 빌트인 Tiled 맵 + 타일셋
  sprites/        # LPC 캐릭터 시트 9종 + 비석
  audio/bgm/      # BGM 4트랙
```

## 📚 라이브러리 (Vercel Blob 백엔드)

스튜디오 우상단 **📚 라이브러리** 링크 → `/library.html` 에서 맵·BGM 을 영구 업로드.
업로드된 자산은 다음 스튜디오 부팅 시 자동으로 빈에 합류해 컷씬에 바로 쓸 수 있다.

### 한 번만 셋업

1. **Vercel Blob 스토어 만들기** (대시보드 → 프로젝트 → Storage → Create → Blob)
   - 자동으로 `BLOB_READ_WRITE_TOKEN` 환경변수 주입됨.
2. **비밀번호 환경변수 추가**
   - Settings → Environment Variables → `STUDIO_PASSWORD` = (원하는 비번)
   - Production / Preview / Development 전부 체크.
3. **재배포** — 환경변수 반영 위해 한 번 deploy 트리거.

### 사용 흐름

1. `/library.html` 첫 접속 → 비번 모달 입력 (localStorage 캐싱돼서 이후 자동)
2. 탭에서 맵 / BGM 선택 → 파일 선택 또는 드래그&드롭
3. 업로드 진행률 표시, 완료되면 목록에 추가
4. 항목 🗑 버튼으로 삭제 가능
5. 스튜디오로 돌아가면 빈에 라이브러리 자산이 자동 포함됨 (`📚 라이브러리: 맵 N, BGM M 로드` 토스트)

### 맵 업로드 주의

Tiled 맵이 **외부 타일셋(.tsj)** 을 참조하면 `.tsj` 와 그 안의 `.png` 도 같이 업로드해야 한다.
파일명만 맞추면 같은 Blob 폴더(`maps/`) 안에서 자동으로 해석된다.
**내장 타일셋** 으로 export 한 맵은 .json 한 개로 완결되므로 가장 편함.

## 배포 (Vercel)

```bash
# CLI 로 한 번에:
vercel link
vercel deploy --prod

# 또는 GitHub 푸시 → Vercel 자동 배포
```

`@vercel/blob` 은 자동으로 Vercel Functions(`api/`) 에서 인식된다.
런타임은 Node.js 기본값.

## 라이선스

미정.

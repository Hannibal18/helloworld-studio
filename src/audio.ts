// 스튜디오용 BGM 재생기.
// 메인 루프가 매 프레임 syncBgm(scene, sceneTime, playing) 을 호출하면, 그에 맞춰
// HTMLAudioElement 의 재생/볼륨 envelope 를 갱신한다.
//
// 페이드 인: sceneTime ∈ [0, fadeIn] → gain = sceneTime/fadeIn × volume
// 페이드 아웃: sceneTime ∈ [duration-fadeOut, duration] → gain = (duration - sceneTime)/fadeOut × volume
// 그 외: gain = volume
//
// 씬이 바뀌면 이전 BGM 은 즉시 중단 (씬간 cross-fade 는 transition.dur 동안 별도 처리 — TODO).

import { findAsset } from './state';
import type { BgmAsset, Scene } from './state';
import { clamp } from './util';

const audioByUrl = new Map<string, HTMLAudioElement>();
let currentEl: HTMLAudioElement | null = null;
let currentUrl: string | null = null;

function getAudio(url: string): HTMLAudioElement {
  let a = audioByUrl.get(url);
  if (!a) {
    a = new Audio(url);
    a.preload = 'auto';
    audioByUrl.set(url, a);
  }
  return a;
}

export function syncBgm(scene: Scene, sceneTime: number, playing: boolean): void {
  const asset = findAsset(scene.bgm.assetId);
  if (!asset || asset.kind !== 'bgm') {
    stopAll();
    return;
  }
  const bgm = asset as BgmAsset;
  const url = bgm.url;

  // 씬 BGM 이 바뀌었으면 교체.
  if (currentUrl !== url) {
    if (currentEl) {
      try { currentEl.pause(); } catch { /* noop */ }
    }
    currentEl = getAudio(url);
    currentUrl = url;
    currentEl.loop = scene.bgm.loop;
  } else if (currentEl) {
    currentEl.loop = scene.bgm.loop;
  }

  if (!currentEl) return;

  // 재생 위치 동기화 — 큰 차이가 나면 보정.
  // 게임용이라 정밀 sync 는 불필요; 0.3초 이상 차이만 맞춤.
  if (Math.abs(currentEl.currentTime - sceneTime) > 0.3 && Number.isFinite(sceneTime)) {
    try { currentEl.currentTime = sceneTime; } catch { /* iOS 일부 환경에서 throw */ }
  }

  // 재생/정지
  if (playing && currentEl.paused) {
    void currentEl.play().catch(() => { /* autoplay 차단 — 사용자 제스처 후 다시 시도됨 */ });
  } else if (!playing && !currentEl.paused) {
    currentEl.pause();
  }

  // 페이드 envelope
  const fi = Math.max(0, scene.bgm.fadeIn);
  const fo = Math.max(0, scene.bgm.fadeOut);
  let env = 1;
  if (fi > 0 && sceneTime < fi) env = sceneTime / fi;
  const remaining = scene.duration - sceneTime;
  if (fo > 0 && remaining < fo) env = Math.min(env, Math.max(0, remaining / fo));
  currentEl.volume = clamp(scene.bgm.volume * env, 0, 1);
}

export function stopAll(): void {
  if (currentEl) {
    try { currentEl.pause(); } catch { /* noop */ }
    currentEl = null;
  }
  currentUrl = null;
}

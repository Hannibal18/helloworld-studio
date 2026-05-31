// 오디오 파형(waveform) 피크 계산 — 트림 UI 에서 맥OS 처럼 파형 위에 구간을 잡기 위함.
//   네이티브 Web Audio 의 decodeAudioData 만 사용한다(=lamejs 같은 무거운 인코더와 분리).
//   고정 버킷 수로 min/max 피크를 뽑아 두면, 캔버스 너비가 바뀌어도 재디코드 없이 다시 그릴 수 있다.

export interface WaveformPeaks {
  min: Float32Array;   // 버킷별 최소 진폭 (-1..0)
  max: Float32Array;   // 버킷별 최대 진폭 (0..1)
}

/** url 의 오디오를 디코드해 buckets 개의 min/max 피크로 축약. */
export async function computeWaveformPeaks(url: string, buckets = 1600): Promise<WaveformPeaks> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`waveform fetch failed (${resp.status})`);
  const arr = await resp.arrayBuffer();

  const Ctx = window.AudioContext
    || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) throw new Error('Web Audio API unavailable');
  const ctx = new Ctx();
  let audio: AudioBuffer;
  try {
    audio = await ctx.decodeAudioData(arr);
  } finally {
    void ctx.close();
  }

  const ch0 = audio.getChannelData(0);
  const ch1 = audio.numberOfChannels > 1 ? audio.getChannelData(1) : null;
  const n = audio.length;
  const min = new Float32Array(buckets);
  const max = new Float32Array(buckets);
  const step = n / buckets;
  for (let b = 0; b < buckets; b++) {
    const s = Math.floor(b * step);
    const e = Math.min(n, Math.floor((b + 1) * step));
    let mn = 1, mx = -1;
    for (let i = s; i < e; i++) {
      const v = ch1 ? (ch0[i] + ch1[i]) * 0.5 : ch0[i];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    if (e <= s) { mn = 0; mx = 0; }
    min[b] = mn;
    max[b] = mx;
  }
  return { min, max };
}

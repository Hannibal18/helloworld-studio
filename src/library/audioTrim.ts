// 오디오 파괴적 트림 — 원본을 디코드 → [start,end] 구간만 잘라 → 재인코딩해 새 File 로 반환.
//   mp3 출력은 lamejs(순수 JS MP3 인코더), wav 출력은 PCM16 직접 작성.
//   원본 mp3 는 mp3 로, wav 는 wav 로 유지(같은 파일명으로 덮어쓰기 가능). 그 외(ogg/m4a)는 mp3 로.

import { Mp3Encoder } from '@breezystack/lamejs';

export type TrimExt = 'mp3' | 'wav';

function floatToInt16(x: number): number {
  const s = Math.max(-1, Math.min(1, Number.isFinite(x) ? x : 0));
  return s < 0 ? s * 0x8000 : s * 0x7fff;
}

/** 잘라낸 오디오를 File 로 반환. srcUrl 은 캐시 우회로 받아 최신 콘텐츠를 보장. */
export async function trimAudioToFile(
  srcUrl: string,
  startSec: number,
  endSec: number,
  outExt: TrimExt,
  outName: string,
): Promise<File> {
  const resp = await fetch(srcUrl, { cache: 'reload' });
  if (!resp.ok) throw new Error(`source fetch failed (${resp.status})`);
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

  const sr = audio.sampleRate;
  const startSample = Math.max(0, Math.floor(startSec * sr));
  const endSample = Math.min(audio.length, Math.ceil(endSec * sr));
  const len = endSample - startSample;
  if (len <= 0) throw new Error('trim range is empty');

  return outExt === 'wav'
    ? encodeWavFile(audio, startSample, len, outName)
    : encodeMp3File(audio, startSample, len, outName);
}

function encodeMp3File(audio: AudioBuffer, startSample: number, len: number, name: string): File {
  const channels = Math.min(2, audio.numberOfChannels);   // lamejs: mono/stereo 만
  const sr = audio.sampleRate;
  const enc = new Mp3Encoder(channels, sr, 192);
  const left = audio.getChannelData(0);
  const right = channels > 1 ? audio.getChannelData(1) : left;

  const BLOCK = 1152;                                       // MP3 프레임 샘플 수
  const l16 = new Int16Array(BLOCK);
  const r16 = new Int16Array(BLOCK);
  const parts: BlobPart[] = [];
  for (let i = 0; i < len; i += BLOCK) {
    const n = Math.min(BLOCK, len - i);
    for (let j = 0; j < n; j++) {
      l16[j] = floatToInt16(left[startSample + i + j]);
      r16[j] = floatToInt16(right[startSample + i + j]);
    }
    const ls = n === BLOCK ? l16 : l16.subarray(0, n);
    const chunk = channels === 2
      ? enc.encodeBuffer(ls, n === BLOCK ? r16 : r16.subarray(0, n))
      : enc.encodeBuffer(ls);
    if (chunk.length > 0) parts.push(chunk.slice());        // 내부 버퍼 재사용 대비 복사
  }
  const last = enc.flush();
  if (last.length > 0) parts.push(last.slice());
  return new File(parts, name, { type: 'audio/mpeg' });
}

function encodeWavFile(audio: AudioBuffer, startSample: number, len: number, name: string): File {
  const channels = audio.numberOfChannels;
  const sr = audio.sampleRate;
  const blockAlign = channels * 2;                          // 16-bit
  const dataLen = len * blockAlign;
  const buffer = new ArrayBuffer(44 + dataLen);
  const view = new DataView(buffer);
  const writeStr = (off: number, s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');  view.setUint32(4, 36 + dataLen, true); writeStr(8, 'WAVE');
  writeStr(12, 'fmt '); view.setUint32(16, 16, true);          view.setUint16(20, 1, true);
  view.setUint16(22, channels, true); view.setUint32(24, sr, true);
  view.setUint32(28, sr * blockAlign, true); view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); writeStr(36, 'data'); view.setUint32(40, dataLen, true);

  const chans: Float32Array[] = [];
  for (let c = 0; c < channels; c++) chans.push(audio.getChannelData(c));
  let off = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < channels; c++) {
      view.setInt16(off, floatToInt16(chans[c][startSample + i]), true);
      off += 2;
    }
  }
  return new File([buffer], name, { type: 'audio/wav' });
}

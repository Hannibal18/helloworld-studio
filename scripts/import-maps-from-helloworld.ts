// 1회용 admin 스크립트.
// helloworld 의 public/maps/ 안 cops 관련 맵 폴더/파일을 스튜디오 Blob 에
// maps/<map-name>/<file> 형식으로 푸시. forest_tiles.tsj/png 같은 공유 파일이
// 다른 맵과 충돌하지 않도록 폴더 prefix 를 유지.
//
// 사용:
//   cd helloworld-studio && BLOB_READ_WRITE_TOKEN=$(cat .env.local | grep BLOB_READ_WRITE_TOKEN | cut -d= -f2-) \
//     npx tsx scripts/import-maps-from-helloworld.ts

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { put } from '@vercel/blob';

const HELLOWORLD_MAPS = '/Users/han/Developer/helloworld/public/maps';
const TOKEN = process.env.BLOB_READ_WRITE_TOKEN;
if (!TOKEN) {
  console.error('BLOB_READ_WRITE_TOKEN 환경변수가 필요합니다.');
  process.exit(1);
}

const MIME: Record<string, string> = {
  '.json': 'application/json',
  '.tsj': 'application/json',
  '.tmj': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

function listMapFiles(): Array<{ src: string; blobPath: string; contentType: string }> {
  const out: Array<{ src: string; blobPath: string; contentType: string }> = [];
  // 폴더 단위 맵 (cops_lobby/, lost_temple/) + 평탄 맵 (zombie_road.json, zombie_road.tsj)
  for (const entry of readdirSync(HELLOWORLD_MAPS)) {
    const full = join(HELLOWORLD_MAPS, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      for (const f of readdirSync(full)) {
        const fpath = join(full, f);
        if (statSync(fpath).isFile()) {
          out.push({
            src: fpath,
            blobPath: `maps/${entry}/${f}`,
            contentType: MIME[extname(f).toLowerCase()] ?? 'application/octet-stream',
          });
        }
      }
    } else if (st.isFile()) {
      const base = basename(entry, extname(entry));
      // zombie_road.json + zombie_road.tsj 같은 평탄 파일들은 폴더 묶어줌
      out.push({
        src: full,
        blobPath: `maps/${base}/${entry}`,
        contentType: MIME[extname(entry).toLowerCase()] ?? 'application/octet-stream',
      });
    }
  }
  return out;
}

async function main(): Promise<void> {
  const files = listMapFiles();
  console.log(`${files.length}개 파일 업로드 시작…`);
  for (const f of files) {
    const buf = readFileSync(f.src);
    const blob = await put(f.blobPath, buf, {
      access: 'public',
      contentType: f.contentType,
      allowOverwrite: true,
      addRandomSuffix: false,
      token: TOKEN,
    });
    console.log(`✓ ${f.blobPath} (${buf.length} B) → ${blob.url}`);
  }
  console.log(`완료. ${files.length}개 파일 업로드.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

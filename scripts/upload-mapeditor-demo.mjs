// 1회용 — helloworld-mapeditor 의 sample JSON 을 studio 에 mapeditor 포맷으로 업로드.
//
// 실행:
//   STUDIO_TOKEN=<pw> node scripts/upload-mapeditor-demo.mjs
//
// 결과:
//   maps/mapeditor-demo/main.json
//   maps/mapeditor-demo/meta.json

import { upload } from '@vercel/blob/client';
import { readFileSync } from 'node:fs';

const TOKEN = process.env.STUDIO_TOKEN;
if (!TOKEN) { console.error('STUDIO_TOKEN env required'); process.exit(1); }

const STUDIO = process.env.STUDIO_BASE ?? 'https://studio.openmath.kr';
const ASSET_ID = 'mapeditor-demo';
const DISPLAY_NAME = 'mapeditor-demo';
const SOURCE = '/Users/han/Developer/helloworld-mapeditor/samples/mapeditor-demo-main.json';

async function uploadOne(pathname, content, contentType) {
  const file = new File([content], pathname.split('/').pop(), { type: contentType });
  const r = await upload(pathname, file, {
    access: 'public',
    handleUploadUrl: `${STUDIO}/api/blob-upload?token=${encodeURIComponent(TOKEN)}`,
  });
  return r;
}

const mainText = readFileSync(SOURCE, 'utf8');
const parsed = JSON.parse(mainText);

const byType = {};
for (const o of parsed.objects ?? []) {
  const t = String((o ?? {}).type ?? 'unknown');
  byType[t] = (byType[t] ?? 0) + 1;
}
const info = {
  schemaVersion: parsed.schemaVersion ?? 1,
  bounds: parsed.bounds ?? { x: 0, y: 0, w: 0, h: 0 },
  objectCount: Array.isArray(parsed.objects) ? parsed.objects.length : 0,
  objectCountByType: byType,
};
const meta = {
  schema: 1,
  id: ASSET_ID,
  name: DISPLAY_NAME,
  version: 1,
  versionHistory: [],
  savedAt: new Date().toISOString(),
  format: 'mapeditor',
  originalMapFilename: SOURCE.split('/').pop(),
  info,
};

console.log(`[upload] main.json → maps/${ASSET_ID}/main.json`);
const mainBlob = await uploadOne(`maps/${ASSET_ID}/main.json`, mainText, 'application/json');
console.log(`         OK ${mainBlob.url}`);

console.log(`[upload] meta.json → maps/${ASSET_ID}/meta.json`);
const metaBlob = await uploadOne(`maps/${ASSET_ID}/meta.json`, JSON.stringify(meta, null, 2), 'application/json');
console.log(`         OK ${metaBlob.url}`);

console.log(`\nDone.  Asset ID: ${ASSET_ID}`);
console.log(`Stats: ${info.objectCount} objects, bounds ${info.bounds.w}×${info.bounds.h}m`);
console.log(`By type:`, info.objectCountByType);

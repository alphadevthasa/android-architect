import fs from 'node:fs';
import path from 'node:path';

export const MANIFEST_SCHEMA_VERSION = 1;

/** Read <aiDir>/manifest.json; null when absent. Throws on bad JSON or a newer schema. */
export function readManifest(aiDir) {
  const file = path.join(aiDir, 'manifest.json');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  let m;
  try {
    m = JSON.parse(text);
  } catch (e) {
    throw new Error(`invalid manifest ${file}: ${e.message}`);
  }
  if (!m || typeof m !== 'object' || m.schemaVersion > MANIFEST_SCHEMA_VERSION) {
    throw new Error(
      `manifest schemaVersion ${m?.schemaVersion} is newer than supported (${MANIFEST_SCHEMA_VERSION}); update android-architect`,
    );
  }
  return m;
}

export function writeManifest(aiDir, manifest) {
  fs.mkdirSync(aiDir, { recursive: true });
  fs.writeFileSync(path.join(aiDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}

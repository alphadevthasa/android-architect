import fs from 'node:fs';
import path from 'node:path';

export const MANIFEST_SCHEMA_VERSION = 1;

const FIX_ADVICE = 'fix or delete .ai/manifest.json by hand, or restore it from git';
/** One plain message (no absolute path, no parser text): refresh and init cannot repair a corrupt manifest, so they are not advised. */
function manifestError(reason, advice = FIX_ADVICE) {
  return Object.assign(new Error(`cannot read .ai/manifest.json: ${reason}; ${advice}`), { manifestMessage: true });
}

/** Read <aiDir>/manifest.json; null when absent. Throws one plain error on an unreadable file, bad JSON, a non-object, a missing or non-integer schemaVersion, or a newer schema. */
export function readManifest(aiDir) {
  const file = path.join(aiDir, 'manifest.json');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw manifestError(`the file could not be read (${e.code ?? 'error'})`);
  }
  let m;
  try {
    m = JSON.parse(text);
  } catch {
    throw manifestError('it is not valid JSON');
  }
  if (m === null || typeof m !== 'object' || Array.isArray(m) || !Number.isInteger(m.schemaVersion) || m.schemaVersion < 1) {
    throw manifestError('expected an object with an integer schemaVersion');
  }
  if (m.schemaVersion > MANIFEST_SCHEMA_VERSION) {
    throw manifestError(`schemaVersion ${m.schemaVersion} is newer than supported (${MANIFEST_SCHEMA_VERSION})`, 'use a newer android-architect');
  }
  return m;
}

export function writeManifest(aiDir, manifest) {
  fs.mkdirSync(aiDir, { recursive: true });
  fs.writeFileSync(path.join(aiDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}

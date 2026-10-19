import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scripts = path.dirname(fileURLToPath(import.meta.url));
for (const entry of (await fs.readdir(scripts)).sort()) {
  const file = path.join(scripts, entry);
  const result = entry.endsWith('.mjs')
    ? spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' })
    : entry.endsWith('.sh')
      ? spawnSync('bash', ['-n', file], { stdio: 'inherit' })
      : null;
  if (!result) continue;
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `Syntax check failed: ${entry}`);
  console.log(`PASS syntax ${entry}`);
}

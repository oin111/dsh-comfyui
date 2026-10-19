import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const guard = fileURLToPath(new URL('./validate-icon.mjs', import.meta.url));
function fixture(t, size = 256 * 1024, update = {}, signature = true) {
  const root = mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'icon-validation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'assets'));
  const bytes = Buffer.alloc(size);
  if (signature) Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes);
  writeFileSync(path.join(root, 'assets/mark.png'), bytes);
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({name:'icon-fixture',version:'1.0.0',exports:{'./icon':'./assets/mark.png'},files:['assets'],...update}));
  return root;
}
function run(root) { return spawnSync(process.execPath, [guard, root], { encoding: 'utf8' }); }
test('guard accepts exactly 256 KiB through the configured non-logo export', t => {
  const result = run(fixture(t));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /assets\/mark\.png.*262144/);
});
test('guard rejects one byte over the host limit', t => {
  const result = run(fixture(t, 256 * 1024 + 1));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /icon exceeds 256 KiB/);
});
test('guard rejects invalid PNG signature', t => {
  assert.match(run(fixture(t, 100, {}, false)).stderr, /PNG signature/);
});
test('guard rejects missing icon export', t => {
  assert.match(run(fixture(t, 100, {exports:{}})).stderr, /icon resource/);
});
test('guard rejects icon omitted from packed files', t => {
  assert.match(run(fixture(t, 100, {files:['missing']})).stderr, /not included in npm package/);
});
test('guard honors the manifest icon precedence used by DSH', t => {
  assert.match(run(fixture(t, 100, {icon:'./missing.png'})).stderr, /ENOENT/);
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

const root = path.resolve(process.env.ICON_PACKAGE_ROOT || fileURLToPath(new URL('../', import.meta.url)));
test('the configured exported icon is packaged and within the host 256 KiB limit', () => {
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const target = manifest.icon ?? manifest.exports?.['./icon'];
  assert.equal(typeof target, 'string', 'the host must resolve an icon resource');
  const relative = target.replace(/^\.\//, '');
  const [packed] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8' }));
  assert(packed.files.some(file => file.path === relative), `${target} must be shipped by npm pack`);
  const bytes = readFileSync(path.join(root, relative));
  assert(bytes.length <= 256 * 1024, `${target}: icon exceeds 256 KiB (${bytes.length} bytes)`);
  assert.deepEqual(bytes.subarray(0, 8), Buffer.from('89504e470d0a1a0a', 'hex'), 'configured icon must be PNG');
});

// Release gate: ICON_TARBALL=/absolute/path/to/final.tgz node --test this-file.mjs
if (process.env.ICON_TARBALL) test('the final tarball contains the configured PNG icon byte-identical to source', () => {
  const tarball = path.resolve(process.env.ICON_TARBALL);
  const manifest = JSON.parse(execFileSync('tar', ['-xOf', tarball, 'package/package.json'], { encoding: 'utf8' }));
  const target = manifest.icon ?? manifest.exports?.['./icon'];
  assert.equal(typeof target, 'string', 'packed manifest must configure an icon');
  const relative = target.replace(/^\.\//, '');
  assert(!path.isAbsolute(relative) && !relative.split('/').includes('..'), 'packed icon path must remain inside package');
  const bytes = execFileSync('tar', ['-xOf', tarball, `package/${relative}`], { maxBuffer: 4 * 1024 * 1024 });
  assert(bytes.length <= 256 * 1024, `${target}: packed icon exceeds 256 KiB (${bytes.length} bytes)`);
  assert.deepEqual(bytes.subarray(0, 8), Buffer.from('89504e470d0a1a0a', 'hex'));
  assert.deepEqual(bytes, readFileSync(path.join(root, relative)), 'packed icon must match the validated source asset');
});

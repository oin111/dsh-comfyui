// No third-party dependencies. --ignore-scripts prevents recursive prepack execution.
import assert from 'node:assert/strict';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = realpathSync(path.resolve(process.argv[2] || fileURLToPath(new URL('../', import.meta.url))));
try {
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const target = manifest.icon ?? manifest.exports?.['./icon'];
  assert(typeof target === 'string' && target.trim(), 'a relative PNG icon resource must be configured');
  assert(!path.isAbsolute(target) && !path.win32.isAbsolute(target) && !/^[A-Za-z][A-Za-z\d+.-]*:/.test(target), 'icon resource must be relative');
  const file = realpathSync(path.resolve(root, target));
  const relative = path.relative(root, file);
  assert(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), 'icon resource must remain inside the package');
  assert(statSync(file).isFile(), 'icon resource must be a regular file');
  const bytes = readFileSync(file);
  assert(bytes.length <= 256 * 1024, `${target}: icon exceeds 256 KiB (${bytes.length} bytes)`);
  assert.equal(path.extname(file).toLowerCase(), '.png', 'this package requires a PNG icon');
  assert.deepEqual(bytes.subarray(0, 8), Buffer.from('89504e470d0a1a0a', 'hex'), 'invalid PNG signature');
  const [packed] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8' }));
  assert(packed.files.some(entry => entry.path === relative.split(path.sep).join('/')), `${target}: icon not included in npm package`);
  console.log(`Validated icon ${target}: ${bytes.length} bytes (maximum 262144)`);
} catch (error) {
  console.error(String(error));
  process.exitCode = 1;
}

import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const compiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url));
for (const config of ['tsconfig.json', 'tsconfig.cjs.json']) {
  execFileSync(process.execPath, [compiler, '-p', config], { cwd: root, stdio: 'inherit' });
}
await mkdir(new URL('../dist/cjs/', import.meta.url), { recursive: true });
await writeFile(new URL('../dist/cjs/package.json', import.meta.url), '{"type":"commonjs"}\n');

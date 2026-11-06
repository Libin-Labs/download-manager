import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
execFileSync(
  process.execPath,
  [
    fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url)),
    'tests/consumer.mts',
    'tests/consumer.cts',
    '--noEmit',
    '--strict',
    '--module',
    'NodeNext',
    '--moduleResolution',
    'NodeNext',
    '--target',
    'ES2022',
  ],
  { cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: 'inherit' },
);

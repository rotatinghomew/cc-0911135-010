import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

async function check(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['node_modules', '.git', 'var'].includes(entry.name)) continue;
    const location = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await check(location);
    else if (/\.(mjs|js)$/.test(entry.name)) {
      const result = spawnSync(process.execPath, ['--check', location], { stdio: 'inherit' });
      if (result.status !== 0) process.exit(result.status || 1);
    }
  }
}
await check('.');
console.log('全部 JavaScript 模块语法检查通过');

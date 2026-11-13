import { inspect } from '../src/client.mjs';
const url = process.argv[2];
if (!url) throw new Error('用法：npm run probe -- http://127.0.0.1:端口');
console.log(JSON.stringify(await inspect(url), null, 2));

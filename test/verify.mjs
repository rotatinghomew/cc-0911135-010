import { readFile } from 'node:fs/promises';
import { verify } from '../lib/verify.mjs';
const filename = process.argv[2];
if (!filename) throw new Error('请指定需要校验的结果文件');
verify(JSON.parse(await readFile(filename, 'utf8')));
console.log('结果结构和基本业务不变量校验通过');

import { createSite } from './site.mjs';
const port = Number(process.env.PORT || 0);
const site = await createSite(port);
console.log(JSON.stringify({ url: site.url }));
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await site.close();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

import { createSite } from '../src/site.mjs';
import { inspect } from '../src/client.mjs';
const site = await createSite();
try {
  console.log(JSON.stringify({ source: site.url, inspection: await inspect(site.url) }, null, 2));
} finally {
  await site.close();
}

// Regenerates src/catalog/snapshot.json from the live Slopalytics site. Commit the result.
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { fetchSlopalytics, toSnapshot, type Catalog } from '../src/catalog/index.js';

const SNAPSHOT_PATH = fileURLToPath(new URL('../src/catalog/snapshot.json', import.meta.url));

const catalog = await fetchSlopalytics({ onWarning: (message) => console.warn(`warning: ${message}`) });
if (catalog.usage.length === 0) {
  // The library tolerates missing usage, but a snapshot without pricing would silently degrade routing.
  console.error('no usage data fetched; keeping the existing snapshot');
  process.exitCode = 1;
} else {
  await writeSnapshot(catalog);
}

async function writeSnapshot(catalog: Catalog): Promise<void> {
  const snapshot = toSnapshot(catalog);
  await writeFile(SNAPSHOT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(
    `wrote ${snapshot.variants.length} of ${catalog.variants.length} variants, ` +
      `${Object.keys(snapshot.pricing).length} price rows, ${snapshot.usage.length} usage rows -> ${SNAPSHOT_PATH}`,
  );
}

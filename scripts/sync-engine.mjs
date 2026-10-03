/**
 * scripts/sync-engine.mjs — copy the shared engine files into the Edge Function bundle.
 *
 * The backend runner (supabase/functions/tlm-runner) runs the SAME code as the browser.
 * Supabase only bundles files under supabase/functions/, so these are copied there.
 * Run before deploying functions:  npm run sync-engine   (tests/server-runner.test.js fails if copies drift)
 */
import fs from 'fs';
import path from 'path';

const SHARED = [
  'js/calculations.js', 'js/db-cloud.js',
  'js/engine/indicators.js', 'js/engine/tlm-rules.js', 'js/engine/tlm-engine.js',
  'js/engine/market-data.js', 'js/engine/alert-service.js', 'js/engine/executors.js', 'js/engine/runner.js',
];
const DEST = 'supabase/functions/_shared/engine';

fs.mkdirSync(DEST, { recursive: true });
let changed = 0;
for (const f of SHARED) {
  const to = path.join(DEST, path.basename(f));
  const src = fs.readFileSync(f);
  if (!fs.existsSync(to) || !src.equals(fs.readFileSync(to))) { fs.writeFileSync(to, src); changed++; }
}
console.log(`✓ engine synced to ${DEST} (${changed} file${changed === 1 ? '' : 's'} updated)`);

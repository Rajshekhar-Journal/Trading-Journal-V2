/**
 * scripts/vendor-libs.mjs — self-host the three browser libraries (no CDN at runtime).
 *
 * Run once from the project folder (needs internet):   node scripts/vendor-libs.mjs
 *  1. Resolves the exact latest 2.x version of @supabase/supabase-js (Chart.js and
 *     Lightweight Charts are already pinned).
 *  2. Downloads each file into js/vendor/ and prints its SHA-384.
 *  3. Rewrites the <script src="https://…"> tags in index.html and login.html to the local copies.
 * Re-run it to upgrade; commit js/vendor/ with the push script.
 */
import fs from 'fs';
import crypto from 'crypto';

const LIBS = [
  { name: 'supabase-js', pkg: '@supabase/supabase-js', range: '2', file: 'dist/umd/supabase.js', out: 'supabase.js',
    match: /https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@[^"']+/ },
  { name: 'chart.js', pkg: 'chart.js', version: '4.4.0', file: 'dist/chart.umd.min.js', out: 'chart.umd.min.js',
    match: /https:\/\/cdn\.jsdelivr\.net\/npm\/chart\.js@[^"']+/ },
  { name: 'lightweight-charts', pkg: 'lightweight-charts', version: '4.1.3', file: 'dist/lightweight-charts.standalone.production.js', out: 'lightweight-charts.standalone.production.js',
    match: /https:\/\/unpkg\.com\/lightweight-charts@[^"']+/ },
];
const HTML = ['index.html', 'login.html'];

async function latest(pkg, major) {
  const r = await fetch(`https://registry.npmjs.org/${pkg.replace('/', '%2F')}`);
  if (!r.ok) throw new Error(`npm registry ${r.status} for ${pkg}`);
  const meta = await r.json();
  const vs = Object.keys(meta.versions).filter(v => v.startsWith(major + '.') && !v.includes('-'));
  vs.sort((a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; });
  return vs.at(-1);
}

async function main() {
  fs.mkdirSync('js/vendor', { recursive: true });
  const lock = {};
  for (const lib of LIBS) {
    const version = lib.version || await latest(lib.pkg, lib.range);
    const url = `https://cdn.jsdelivr.net/npm/${lib.pkg}@${version}/${lib.file}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${r.status} downloading ${url}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 10000) throw new Error(`${lib.name}: file too small (${buf.length} bytes) — aborting`);
    fs.writeFileSync(`js/vendor/${lib.out}`, buf);
    const sri = 'sha384-' + crypto.createHash('sha384').update(buf).digest('base64');
    lock[lib.name] = { version, url, sri, bytes: buf.length };
    console.log(`✓ ${lib.name}@${version}  ${buf.length} bytes  ${sri}`);
  }
  fs.writeFileSync('js/vendor/VERSIONS.json', JSON.stringify(lock, null, 2) + '\n');
  for (const f of HTML) {
    let s = fs.readFileSync(f, 'utf8');
    for (const lib of LIBS) s = s.replace(lib.match, `js/vendor/${lib.out}?v=${lock[lib.name].version}`);
    fs.writeFileSync(f, s);
    console.log(`✓ ${f} now loads the local copies`);
  }
  console.log('\nDone. Next: node push-tlm-v3.mjs  (js/vendor/ is included automatically).');
}
main().catch(e => { console.error('✗', e.message); process.exitCode = 1; });

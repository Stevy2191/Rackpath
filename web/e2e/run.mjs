// Browser tests against the real server: builds nothing, runs the release
// binary with a fresh data directory and the built app (web/dist), then
// drives Chromium through the main flows.
//   node e2e/run.mjs [path-to-rackpath-binary]
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// Playwright from the project if installed, else from NODE_PATH / a shared install.
const require = createRequire(import.meta.url);
function load() {
  for (const p of ['playwright', ...(process.env.NODE_PATH || '').split(':').filter(Boolean).map((d) => join(d, 'playwright')), '/opt/node-tools/node_modules/playwright']) {
    try {
      return require(p);
    } catch {
      /* next */
    }
  }
  throw new Error('Playwright not found: npm i -D playwright, or set NODE_PATH');
}
const { chromium } = load();
const here = dirname(fileURLToPath(import.meta.url));
const bin = process.argv[2] || join(here, '../../api-rs/target/release/rackpath');
const shots = process.env.SHOTS || null;
const port = 18000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
const data = mkdtempSync(join(tmpdir(), 'rackpath-e2e-'));

const server = spawn(bin, ['serve'], {
  env: {
    ...process.env,
    RACKPATH_ENCRYPTION_KEY: '07'.repeat(32),
    RACKPATH_DATA_DIR: data,
    RACKPATH_BIND: `127.0.0.1:${port}`,
    RACKPATH_WEB_DIR: join(here, '../dist'),
    RACKPATH_LOG: 'warn',
  },
});
const password = await new Promise((resolve, reject) => {
  let out = '';
  const onData = (d) => {
    out += d.toString();
    const m = out.match(/password: (\S+)/);
    if (m) resolve(m[1]);
  };
  server.stdout.on('data', onData);
  server.stderr.on('data', onData);
  setTimeout(() => reject(new Error(`no password in output:\n${out}`)), 15000);
});

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
export const ctx = { base, password, shots };

const mods = process.env.E2E_ONLY ? [process.env.E2E_ONLY] : ['auth'];
for (const m of mods) (await import(`./${m}.mjs`)).default(test, ctx);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 860 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && !m.text().includes('401') && errors.push(m.text()));
let failed = 0;
for (const t of tests) {
  try {
    await t.fn(page);
    console.log(`ok   ${t.name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${t.name}\n     ${e.message.split('\n').join('\n     ')}`);
    if (shots) await page.screenshot({ path: join(shots, `fail-${t.name.replace(/\W+/g, '-')}.png`) });
  }
}
if (errors.length) {
  console.log(`browser errors:\n  ${errors.join('\n  ')}`);
  failed++;
}
await browser.close();
server.kill();
rmSync(data, { recursive: true, force: true });
console.log(failed ? `${failed} failed` : `all ${tests.length} passed`);
process.exit(failed ? 1 : 0);

// Visual smoke test: boots the app in headless Chromium (software GL), lets history run and takes screenshots at every scale.
import { chromium } from 'playwright-core';
import { spawn, execSync } from 'node:child_process';
const out = process.argv[2] ?? '/tmp/claude-0/shots';
const years = Number(process.argv[3] ?? 60);
const only = process.argv[4] ? new Set(process.argv[4].split(',')) : null;
// a production build served statically, so edits during a run cannot reload the page
execSync('npx vite build', { stdio: 'ignore' });
const vite = spawn('npx', ['vite', 'preview', '--port', '5199', '--strictPort'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2500));
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1180, height: 720 } });
page.on('console', (m) => { if ((m.type() === 'error' || m.type() === 'warning') && !m.text().includes('404')) console.log('[console]', m.type(), m.text().slice(0, 400)); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto('http://localhost:5199/#seed=pocket&autostart');
await page.waitForFunction(() => window.pd && document.getElementById('loading').style.display === 'none', null, { timeout: 400000 });
console.log('booted');
if (years > 0) {
  await page.evaluate((y) => window.pd.client.jump(y, 'test'), years);
  await page.waitForFunction(() => window.pd.client.snap && !window.pd.client.snap.jumping && window.pd.client.snap.day > 100, null, { timeout: 900000, polling: 1000 });
  console.log('jumped to day', await page.evaluate(() => window.pd.client.snap.day));
}
// afternoon light: at high speed the sun is held in the afternoon over the observer; then pause
const afternoon = async () => { await page.evaluate(() => window.pd.client.setSpeed(5)); await page.waitForTimeout(2500); await page.evaluate(() => window.pd.client.setSpeed(0)); };
const shoot = async (name, fn, wait = 12000, arg) => {
  if (only && !only.has(name)) return;
  await page.evaluate(fn, arg);
  await page.waitForTimeout(wait);
  await page.screenshot({ path: `${out}/${name}.png` });
  const st = await page.evaluate(() => { const v = window.pd.view; return `${v.terrain.stats.drawn} tiles, ${v.terrain.stats.pending} pending, alt ${v.rig.alt.toFixed(4)}`; });
  console.log('shot', name, st);
};
const aim = ([alt, pitch, yaw]) => { const { client, view } = window.pd; const s = [...client.settlements].sort((a, b) => b.pop - a.pop)[0]; view.setFollow(null); view.rig.cancelFly(); view.rig.lon = (s.x / 256 * 2 - 1) * Math.PI; view.rig.lat = Math.PI / 2 - s.y / 128 * Math.PI; view.rig.alt = alt; view.rig.pitch = pitch; view.rig.yaw = yaw; };
await page.evaluate(aim, [0.3, 1.0, 0.4]);
await afternoon();
await shoot('a-eye', aim, 14000, [0.0018, 1.45, 0.4]);
await shoot('b-village', aim, 14000, [0.25, 1.1, 0.4]);
await shoot('c-town', aim, 14000, [2.5, 0.95, 0.4]);
await shoot('d-region', aim, 14000, [40, 0.85, 0.4]);
await shoot('e-orbit', aim, 14000, [2500, 0.2, 0.4]);
await shoot('f-moon', aim, 10000, [120000, 0, 0.4]);
await shoot('g-solar', aim, 10000, [9e8, 0, 0.4]);
await shoot('h-person', () => { const { client, ui } = window.pd; const P = client.people; if (P.n) ui.select('person', P.id[0], true); }, 14000);
await shoot('i-almanac', () => { const { ui } = window.pd; ui.clearSelection(); ui.openAlmanac('languages'); }, 3000);
await browser.close();
vite.kill();

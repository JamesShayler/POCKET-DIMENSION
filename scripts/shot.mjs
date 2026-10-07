// Visual smoke test: boots the app in headless Chromium (software GL), lets history run and takes screenshots at every scale.
import { chromium } from 'playwright-core';
import { spawn, execSync } from 'node:child_process';
const out = process.argv[2] ?? '/tmp/claude-0/shots';
const years = Number(process.argv[3] ?? 60);
const only = process.argv[4] ? new Set(process.argv[4].split(',')) : null;
// a production build served statically, so edits during a run cannot reload the page
execSync('npx vite build', { stdio: 'ignore' });
const vite = spawn('npx', ['vite', 'preview', '--port', '5199', '--strictPort'], { stdio: 'ignore', detached: true });
await new Promise((r) => setTimeout(r, 2500));
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1180, height: 720 } });
page.on('console', (m) => { if ((m.type() === 'error' || m.type() === 'warning') && !m.text().includes('404')) console.log('[console]', m.type(), m.text().slice(0, 400)); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('crash', () => console.log('[crash] the page crashed'));
page.on('framenavigated', (f) => { if (f === page.mainFrame()) console.log('[navigated]', f.url()); });
await page.goto('http://localhost:5199/#seed=pocket&autostart');
await page.waitForFunction(() => window.pd && document.getElementById('loading').style.display === 'none', null, { timeout: 400000 });
console.log('booted');
if (years > 0) {
  const target = await page.evaluate((y) => { const c = window.pd.client; c.jump(y, 'test'); return c.snap.day + y * 360 - 1; }, years);
  await page.waitForFunction((t) => window.pd.client.snap && !window.pd.client.snap.jumping && window.pd.client.snap.day >= t, target, { timeout: 1800000, polling: 1000 });
  console.log('jumped to day', await page.evaluate(() => window.pd.client.snap.day));
}
// afternoon light: at high speed the sun is held in the afternoon over the observer; then pause
const afternoon = async () => { await page.evaluate(() => { const { client, view } = window.pd; client.setSpeed(0); view.holdPhase = true; view.visualPhase = view.rig.lon - 0.6; }); };
const shoot = async (name, fn, wait = 12000, arg) => {
  if (only && !only.has(name)) return;
  await page.evaluate(fn, arg);
  await afternoon();
  await page.waitForTimeout(wait);
  await page.screenshot({ path: `${out}/${name}.png`, timeout: 180000 });
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
await shoot('h-person', () => { const { client, ui, view } = window.pd; view.rig.alt = 0.05; const P = client.people; if (P.n) ui.select('person', P.id[0], true); view.rig.alt = 0.03; view.rig.pitch = 1.2; }, 14000);
await shoot('i-almanac', () => { const { ui } = window.pd; ui.clearSelection(); ui.openAlmanac('languages'); }, 3000);
await browser.close();
process.kill(-vite.pid);

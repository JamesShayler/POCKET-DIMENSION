import { chromium } from 'playwright-core';
import { spawn, execSync } from 'node:child_process';
execSync('npx vite build', { cwd: '/home/user/POCKET-DIMENSION', stdio: 'ignore' });
const vite = spawn('npx', ['vite', 'preview', '--port', '5188', '--strictPort'], { cwd: '/home/user/POCKET-DIMENSION', stdio: 'ignore', detached: true });
await new Promise((r) => setTimeout(r, 2500));
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 900, height: 560 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto('http://localhost:5188/#seed=pocket&autostart');
await page.waitForFunction(() => window.pd && document.getElementById('loading').style.display === 'none', null, { timeout: 400000 });
const steps = JSON.parse(process.argv[2]);
for (const [name, code, wait] of steps) {
  await page.evaluate(code);
  await page.waitForTimeout(wait);
  await page.screenshot({ path: `/tmp/claude-0/shots/dbg-${name}.png` });
  console.log('shot', name);
}
await browser.close();
process.kill(-vite.pid);

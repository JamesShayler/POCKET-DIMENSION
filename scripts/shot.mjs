// Visual smoke test: boots the app in headless Chromium (software GL), fast-forwards history and takes screenshots.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
const out = process.argv[2] ?? '/tmp/claude-0/shots';
const years = Number(process.argv[3] ?? 70);
const vite = spawn('npx', ['vite', '--port', '5199', '--strictPort'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2500));
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1180, height: 720 } });
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('404')) console.log('[console]', m.text().slice(0, 300)); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto('http://localhost:5199/#seed=pocket&autostart');
await page.waitForFunction(() => window.pd, null, { timeout: 240000 });
await page.evaluate((years) => { const { world, engine } = window.pd; engine.setSpeed(0); for (let i = 0; i < years * 360 / 10; i++) world.step(10); engine.setSpeed(0); }, years);
const shoot = async (name, fn, wait = 8000, arg) => { await page.evaluate(fn, arg); await page.waitForTimeout(wait); await page.screenshot({ path: `${out}/${name}.png` }); };
const aim = ([alt, pitch, yaw]) => { const { world, view } = window.pd; const s = world.activeSettlements().sort((a, b) => b.pop - a.pop)[0]; view.follow = null; view.rig.follow = null; view.rig.cancelFly(); view.rig.lon = (s.x / 256 * 2 - 1) * Math.PI; view.rig.lat = Math.PI / 2 - s.y / 128 * Math.PI; view.rig.alt = alt; view.rig.pitch = pitch; view.rig.yaw = yaw; world.day = Math.floor(world.day) + ((0.5 - s.x / 256 + 0.04) % 1 + 1) % 1; };

await shoot('t1-village', aim, 8000, [1.1, 1.05, 0.4]);
await shoot('t2-town', aim, 8000, [4, 0.9, 0.4]);
await shoot('t3-region', aim, 8000, [22, 0.8, 0.4]);
await shoot('t4-person', () => { const { world, ui, view } = window.pd; const s = world.activeSettlements().sort((a, b) => b.pop - a.pop)[0]; const p = world.alive.find((q) => q.home === s.id && ['chop', 'field', 'build', 'quarry', 'berry'].includes(q.task)) ?? world.alive.find((q) => q.home === s.id); ui.select('person', p.id, true); view.rig.alt = 0.9; }, 9000);
await shoot('t5-settlement', () => { const { world, ui } = window.pd; const s = world.activeSettlements().sort((a, b) => b.pop - a.pop)[0]; ui.select('settlement', s.id, true); }, 5000);
await shoot('t7-forest', () => { const { world, view, ui } = window.pd; ui.clearSelection(); let best = -1; const p = world.planet; for (let i = 0; i < 32768 && best < 0; i++) if ([5, 6, 10].includes(p.biome[i]) && world.res.nodes(i).filter((n) => n.kind === 'tree').length >= 2 && world.res.nodes(i).some((n) => n.kind === 'bush')) best = i; const x = (best % 256) + 0.5, y = Math.floor(best / 256) + 0.5; view.follow = null; view.rig.follow = null; view.rig.cancelFly(); view.rig.lon = (x / 256 * 2 - 1) * Math.PI; view.rig.lat = Math.PI / 2 - y / 128 * Math.PI; view.rig.alt = 2.2; view.rig.pitch = 1.0; world.day = Math.floor(world.day) + ((0.5 - x / 256 + 0.04) % 1 + 1) % 1; }, 9000);
await shoot('t6-wars', () => { const { ui } = window.pd; ui.clearSelection(); ui.openAlmanac('wars'); }, 2500);
await browser.close();
vite.kill();

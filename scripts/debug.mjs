import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
const out = '/tmp/claude-0/shots';
const vite = spawn('npx', ['vite', '--port', '5198', '--strictPort'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2500));
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto('http://localhost:5198/#seed=demo&autostart');
await page.waitForFunction(() => window.pd, null, { timeout: 120000 });
await page.evaluate(() => { const { world, engine } = window.pd; engine.setSpeed(0); let n=0; while(!world.awakened && n<20000){ world.stepPrehistory(40); n+=40;} for (let i=0;i<60;i++) world.step(7); engine.setSpeed(0); });
for (const [alt, pitch, tag] of [[40,0.3,'a'],[6,0.0,'b'],[5,1.0,'c'],[1.2,1.2,'d']]) {
  await page.evaluate(([alt,pitch]) => { const { world, engine, view } = window.pd; const s = world.activeSettlements()[0]; view.follow=null; view.rig.follow=null; view.rig.lon=(s.x/256*2-1)*Math.PI; view.rig.lat=Math.PI/2-s.y/128*Math.PI; view.rig.alt=alt; view.rig.pitch=pitch; view.rig.yaw=0.3; view.visualPhase = view.rig.lon - 0.5; view.rig.cancelFly(); }, [alt,pitch]);
  await page.waitForTimeout(7000);
  const info = await page.evaluate(() => { const { view } = window.pd; const E = view.entities; return { houses: E.houses.count, people: E.people.count, animals: E.animals.count, markers: E.markers.count, cam: view.camera.position.toArray().map(v=>+v.toFixed(1)), r: +view.camera.position.length().toFixed(1), sun: view.sunDir.toArray().map(v=>+v.toFixed(2)), near: view.camera.near, far: view.camera.far, alt: view.rig.alt }; });
  console.log(tag, JSON.stringify(info));
  await page.screenshot({ path: `${out}/d-${tag}.png` });
}
await browser.close(); vite.kill();

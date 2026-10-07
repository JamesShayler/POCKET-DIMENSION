import { World } from './sim/world';
import { Engine, SPEED } from './engine';
import { ObserverView } from './render/observer';
import { UI } from './ui/ui';
import { hasSave, loadFromBrowser, saveToBrowser } from './sim/persistence';
import { lonOfX, latOfY } from './sim/grid';
import { formatYear } from './sim/time';

const $ = (id: string) => document.getElementById(id)!;
const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const WORDS = ['ember', 'tide', 'moss', 'lumen', 'cinder', 'harbor', 'quill', 'sable', 'orchid', 'drift', 'basalt', 'fennel', 'aurora', 'cobalt', 'willow', 'zephyr', 'ivory', 'nimbus', 'garnet', 'solstice'];
const randomSeed = () => `${WORDS[Math.floor(Math.random() * WORDS.length)]}-${WORDS[Math.floor(Math.random() * WORDS.length)]}-${Math.floor(Math.random() * 900 + 100)}`;

function setLoading(msg: string, sub = '') {
  const el = $('loading');
  el.style.display = 'flex';
  el.innerHTML = `<div class="t">Pocket Dimension</div><div class="s">${msg}</div><div class="t" style="opacity:.6">${sub}</div>`;
}

function showMenu(canContinue: boolean) {
  const menu = $('menu');
  const hashSeed = decodeURIComponent((location.hash.match(/seed=([^&]+)/) ?? [])[1] ?? '');
  menu.style.display = 'flex';
  menu.innerHTML = `<div class="card glass" style="padding:34px 30px">
    <h1>POCKET DIMENSION</h1>
    <p>A living miniature universe you can watch but never touch.<br/>The world exists independently of the observer.</p>
    <input id="seed" value="${hashSeed || randomSeed()}" spellcheck="false" aria-label="Universe seed" />
    <button class="btn" id="go">Create new universe</button>
    ${canContinue ? '<button class="btn alt" id="cont">Continue saved universe</button>' : ''}
    <small>The seed fully determines the planet, solar system, climate, terrain and initial life.<br/>Share it to share the universe. Everything after that is cause and effect.</small>
  </div>`;
  return new Promise<{ seed: string } | { cont: true }>((resolve) => {
    $('go').addEventListener('click', () => resolve({ seed: (($('seed') as HTMLInputElement).value || randomSeed()).trim() }));
    ($('seed') as HTMLInputElement).addEventListener('keydown', (e) => { if (e.key === 'Enter') $('go').click(); });
    document.getElementById('cont')?.addEventListener('click', () => resolve({ cont: true }));
  });
}

async function boot() {
  const saved = await hasSave();
  const hashSeed = decodeURIComponent((location.hash.match(/seed=([^&]+)/) ?? [])[1] ?? '');
  const auto = location.hash.includes('autostart');
  let choice: { seed: string } | { cont: true };
  if (auto && hashSeed) choice = { seed: hashSeed };
  else choice = await showMenu(saved);
  $('menu').style.display = 'none';
  let world: World;
  if ('cont' in choice) {
    setLoading('Restoring the universe…');
    await nextFrame(); await nextFrame();
    const w = await loadFromBrowser();
    if (!w) { location.reload(); return; }
    world = w;
  } else {
    setLoading('Generating planet…', 'seed: ' + choice.seed);
    await nextFrame(); await nextFrame();
    world = new World(choice.seed);
    world.begin();
    // Life must evolve before anyone can wake. Run the pre-human world forward until a lineage crosses the threshold.
    const t0 = performance.now();
    let guard = 0;
    while (!world.awakened && world.year < 12000 && guard++ < 100000) {
      const ts = performance.now();
      while (performance.now() - ts < 30 && !world.awakened) world.stepPrehistory(4);
      const t = world.eco.totals();
      setLoading('Life is evolving…', `year ${world.year.toLocaleString()} · ${t.species} species · ${t.animals.toLocaleString()} animals`);
      await nextFrame();
    }
    void t0;
  }
  history.replaceState(null, '', `#seed=${encodeURIComponent(world.seedText)}`);

  setLoading('Shaping terrain…');
  await nextFrame();
  const canvas = $('view') as HTMLCanvasElement;
  const view = new ObserverView(world, canvas, $('labels'));
  await view.init((f) => setLoading('Shaping terrain…', `${Math.round(f * 100)}%`));
  const engine = new Engine(world);
  const ui = new UI();
  let fpsEMA = 60;
  const save = async () => { await saveToBrowser(world); };
  ui.attach({
    world, engine, view, save,
    newUniverse: (seed) => { location.hash = `seed=${encodeURIComponent(seed || randomSeed())}&autostart`; location.reload(); },
    fps: () => fpsEMA,
  });
  $('loading').style.display = 'none';

  // Opening shot: right beside the people, at living pace (one simulated minute per second).
  let spin = !world.awakened;
  view.onUserMove = () => { spin = false; };
  const first = world.activeSettlements().sort((a, b) => b.pop - a.pop)[0];
  engine.setSpeed(SPEED.x1);
  if (world.awakened && first) {
    view.rig.lon = lonOfX(first.x);
    view.rig.lat = latOfY(first.y);
    view.rig.alt = 1.6;
    view.rig.pitch = 0.95;
    view.rig.yaw = 0.4;
    spin = false;
    const e = world.history.query({ type: 'AWAKENING', limit: 1 })[0];
    if (e && !('cont' in choice)) ui.toast(`${formatYear(e.day)} — ${e.text}`);
  } else view.rig.alt = 3900;

  // Seasons change the colour of the land: refresh periodically, and clouds with the weather.
  let lastColorDay = -1e9;
  let lastColorWall = 0;
  let lastSave = performance.now();
  let last = performance.now();
  const loop = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    fpsEMA = fpsEMA * 0.95 + (1 / Math.max(dt, 0.001)) * 0.05;
    const alpha = engine.advance(dt);
    if (spin) view.rig.lon += dt * 0.025;
    if (now - lastColorWall > 1200 && (world.day - lastColorDay > 20 || engine.paused)) {
      if (world.day !== lastColorDay) {
        view.planet.updateColors();
        view.planet.updateClouds();
        lastColorDay = world.day;
      }
      lastColorWall = now;
    }
    view.frame(dt, engine.renderDay, engine.daysPerSec, alpha, engine.paused);
    if (now - lastSave > 120000 && !engine.jumping) { lastSave = now; save().catch(() => {}); }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  (window as any).pd = { world, engine, view, ui };
  window.addEventListener('beforeunload', () => { /* autosave handled periodically; IndexedDB writes cannot complete during unload */ });
  void sleep;
}

boot().catch((e) => {
  console.error(e);
  setLoading('Something went wrong: ' + String(e));
});

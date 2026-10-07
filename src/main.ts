import { SimClient } from './client';
import { SPEED } from './engine';
import { ObserverView } from './render/observer';
import { UI } from './ui/ui';
import { lonOfX, latOfY } from './sim/grid';

const $ = (id: string) => document.getElementById(id)!;
const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

const WORDS = ['ember', 'tide', 'moss', 'lumen', 'cinder', 'harbor', 'quill', 'sable', 'orchid', 'drift', 'basalt', 'fennel', 'aurora', 'cobalt', 'willow', 'zephyr', 'ivory', 'nimbus', 'garnet', 'solstice'];
const randomSeed = () => `${WORDS[Math.floor(Math.random() * WORDS.length)]}-${WORDS[Math.floor(Math.random() * WORDS.length)]}-${Math.floor(Math.random() * 900 + 100)}`;

function setLoading(msg: string, sub = '') {
  const el = $('loading');
  el.style.display = 'flex';
  el.innerHTML = `<div class="t">Pocket Dimension</div><div class="s">${msg}</div><div class="t" style="opacity:.6">${sub}</div>`;
}

/** Is there an autosave? (IndexedDB, written by the simulation worker) */
function hasSave(): Promise<boolean> {
  return new Promise((res) => {
    try {
      const r = indexedDB.open('pocket-dimension', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('saves');
      r.onsuccess = () => {
        try {
          const q = r.result.transaction('saves').objectStore('saves').count('autosave');
          q.onsuccess = () => res(q.result > 0);
          q.onerror = () => res(false);
        } catch { res(false); }
      };
      r.onerror = () => res(false);
    } catch { res(false); }
  });
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
  setLoading('cont' in choice ? 'Restoring the universe…' : 'Generating planet…');
  const client = new SimClient();
  client.onProgress = (m, sub) => setLoading(m, sub ?? '');
  client.onError = (m) => setLoading('Something went wrong in the simulation', m.split('\n')[0]);
  const ready = await client.start('cont' in choice ? { resume: true } : { seed: choice.seed });
  history.replaceState(null, '', `#seed=${encodeURIComponent(client.info.seedText)}`);

  setLoading('Shaping terrain…');
  await nextFrame();
  const view = new ObserverView(client, $('view') as HTMLCanvasElement, $('labels'));
  view.init();
  const ui = new UI();
  let fpsEMA = 60;
  ui.attach({
    client, view,
    newUniverse: (seed) => { location.hash = `seed=${encodeURIComponent(seed || randomSeed())}&autostart`; location.reload(); },
    fps: () => fpsEMA,
  });

  // Opening shot: standing near the people, at living pace (one simulated minute per second).
  const first = ready.firstSettlement;
  client.setSpeed(SPEED.x1);
  if (first) {
    view.rig.lon = lonOfX(first.x);
    view.rig.lat = latOfY(first.y);
    view.rig.alt = 0.35;
    view.rig.pitch = 1.08;
    view.rig.yaw = 0.4;
    if (ready.awakeningText && !ready.resumed) ui.toast(ready.awakeningText);
  } else view.rig.alt = 3900;

  // wait (briefly) for the ground under the camera before lifting the curtain
  const t0 = performance.now();
  let last = performance.now();
  const loop = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    fpsEMA = fpsEMA * 0.95 + (1 / Math.max(dt, 0.001)) * 0.05;
    view.frame(dt);
    const loading = $('loading');
    if (loading.style.display !== 'none') {
      const st = view.terrain.stats;
      setLoading('Shaping terrain…', `${st.drawn} tiles · ${st.pending} in progress`);
      if ((st.drawn > 20 && st.pending === 0) || now - t0 > 12000) loading.style.display = 'none';
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  (window as unknown as { pd: unknown }).pd = { client, view, ui };
}

boot().catch((e) => {
  console.error(e);
  setLoading('Something went wrong: ' + String(e));
});

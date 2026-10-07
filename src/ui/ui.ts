import type { SimClient } from '../client';
import { SPEEDS, SPEED_LABELS, SPEED_HINT, SPEED } from '../engine';
import type { ObserverView, Bookmark, Pick } from '../render/observer';
import { SEASON_NAMES, clockText, dayOfYear, formatYear, seasonOf, yearOf } from '../sim/time';
import type { EventLite, PanelKind } from '../shared/protocol';

export interface AppCtx {
  client: SimClient;
  view: ObserverView;
  newUniverse(seed: string): void;
  fps(): number;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const num = (n: number) => Math.round(n).toLocaleString('en-US');

type Sel = { kind: PanelKind; id: number; extra?: number } | null;

/** The interface: everything it shows was written by the simulation worker or read from its snapshots. */
export class UI {
  private el = (id: string) => document.getElementById(id)!;
  sel: Sel = null;
  followFamily = false;
  private bookmarks: Bookmark[] = [];
  private tab = 'chronicle';
  private chronFilter = new Set<string>(['civilization', 'discovery', 'conflict', 'life', 'people', 'nature']);
  private lastPanelHtml = '';
  private ctx!: AppCtx;
  private panelBusy = false;
  private devBusy = false;
  private lastSpeed = SPEED.x100;
  helpHidden = false;

  attach(ctx: AppCtx) {
    this.ctx = ctx;
    const c = ctx.client;
    try { this.bookmarks = JSON.parse(localStorage.getItem('pd-bm-' + c.info.seedText) ?? '[]'); } catch { this.bookmarks = []; }
    this.buildBar();
    this.el('help').innerHTML = 'Drag <kbd>pan</kbd> · Right-drag <kbd>rotate</kbd> · Wheel <kbd>zoom</kbd> · Click <kbd>inspect</kbd><br><kbd>Space</kbd> pause · <kbd>[</kbd> <kbd>]</kbd> speed · <kbd>P</kbd> borders · <kbd>1–9</kbd> bookmarks (<kbd>Shift</kbd> to save) · <kbd>H</kbd> hide UI';
    c.onEvent.push((e) => {
      if (e.weight >= 2) this.pushFeed(e);
      if (e.weight >= 3) this.toast(e.text.split('\n')[0]);
    });
    c.onToast = (m) => this.toast(m);
    ctx.view.onPick = (p) => this.picked(p);
    document.addEventListener('click', (e) => this.delegate(e));
    window.addEventListener('keydown', (e) => this.key(e));
    window.setInterval(() => this.update(), 250);
    this.update();
  }

  private picked(p: Pick | null) {
    if (!p) { this.clearSelection(); return; }
    if (p.kind === 'node') this.select('node', p.id, false, p.extra);
    else if (p.kind === 'building') this.select('building', p.id, false);
    else if (p.kind === 'animal') this.select('species', p.id, false);
    else if (p.kind === 'body') this.select('body', p.id, false);
    else this.select(p.kind, p.id, true);
  }

  // ---------------------------------------------------------------- top bar & controls
  private buildBar() {
    const bar = this.el('bar');
    const sp = SPEEDS.map((s, i) => `<button data-speed="${i}" title="${SPEED_HINT[i]}">${SPEED_LABELS[i]}</button>`).join('');
    bar.innerHTML = `${sp}<span class="sep"></span><span class="eff" id="eff"></span><span class="sep"></span>
      <button data-act="jump">Jump ▴</button><button data-act="politics" id="b-pol">Borders</button><button data-act="almanac">Almanac</button><button data-act="dev">Dev</button><button data-act="save">Save</button><button data-act="new">New</button>
      <div id="jump" class="glass"><button data-jump="1">+1 year</button><button data-jump="10">+10 years</button><button data-jump="100">+100 years</button><button data-jump="1000">+1,000 years</button></div>`;
  }

  update() {
    const { client: c, view } = this.ctx;
    const s = c.snap;
    if (!s) return;
    const rd = c.renderDay();
    const season = SEASON_NAMES[seasonOf(rd)];
    const dd = dayOfYear(rd);
    const camX = ((view.rig.lon + Math.PI) / (Math.PI * 2)) * 256;
    const clock = clockText(rd, camX);
    const alt = view.rig.alt;
    const altTxt = alt < 1 ? `${Math.round(alt * 1000)} m` : alt < 1e5 ? `${num(alt)} km` : alt < 1.5e7 ? `${(alt / 1e6).toFixed(2)} million km` : `${(alt / 1.496e8).toFixed(2)} AU`;
    const wx = view.weather?.local;
    this.el('top').innerHTML = `<div class="title">Pocket Dimension</div><div class="year">${formatYear(s.day)}</div>
      <div class="sub">${season} · day ${Math.floor(dd) + 1} · <b>${clock}</b> local${wx && alt < 50 ? ` · ${wx.temp.toFixed(0)}°C${wx.precip > 0.5 ? (wx.temp < 0.5 ? ' · snow' : ' · rain') : wx.cloud > 0.7 ? ' · overcast' : ''}` : ''}</div>
      <div class="sub"><b>${num(s.pop)}</b> people · <b>${c.settlements.length}</b> settlements · <b>${s.civs}</b> peoples · altitude ${altTxt}</div>
      <div class="sub">seed <button class="link" data-act="copyseed" title="Copy a link to this universe">${esc(c.info.seedText)}</button>${s.awakened ? '' : ' · <span style="color:var(--warm)">life is still waking…</span>'}</div>`;
    SPEEDS.forEach((_, i) => {
      const b = this.el('bar').querySelector(`[data-speed="${i}"]`);
      if (b) b.classList.toggle('on', s.speedIdx === i && !s.jumping);
    });
    const eff = s.speedIdx === 0 ? 'paused' : s.jumping ? 'jumping' : s.effective < SPEEDS[s.speedIdx] * 0.7 ? `≈${fmtRate(s.effective)} (capped)` : fmtRate(s.effective);
    this.el('eff').textContent = eff;
    document.getElementById('b-pol')?.classList.toggle('on', view.politics);
    const pg = this.el('progress');
    if (s.jumping) {
      const j = s.jumping;
      pg.style.display = 'block';
      pg.innerHTML = `${esc(j.label)}… ${formatYear(s.day)}<div class="b"><i style="width:${(100 * (1 - j.remaining / j.total)).toFixed(1)}%"></i></div><button class="btn" data-act="canceljump" style="margin-top:6px;padding:3px 10px">cancel</button>`;
    } else pg.style.display = 'none';
    if (this.sel) this.renderPanel();
    if (this.el('dev').classList.contains('open')) this.renderDev();
    // the worker tells us when a followed life ends (and whom it follows next)
    if (s.followMsg) {
      this.toast(s.followMsg);
      const f = s.follow;
      if (f && f.kind === 'person' && f.alive && (!this.sel || this.sel.id !== f.id)) this.select('person', f.id, true);
      else if (!f) view.setFollow(null);
    }
  }

  // ---------------------------------------------------------------- feed & toast
  private pushFeed(e: EventLite) {
    const feed = this.el('feed');
    const d = document.createElement('div');
    d.className = `ev glass t${e.weight}`;
    d.innerHTML = `<div class="y">${formatYear(e.day)} · ${e.type.replace(/_/g, ' ').toLowerCase()}</div>${esc(e.text.split('\n')[0])}${e.cause ? `<div class="c">${esc(e.cause)}</div>` : ''}`;
    d.addEventListener('click', () => this.focusEvent(e));
    feed.appendChild(d);
    while (feed.children.length > 5) feed.removeChild(feed.firstChild!);
    setTimeout(() => { d.style.transition = 'opacity 1s'; d.style.opacity = '0'; setTimeout(() => d.remove(), 1000); }, e.weight >= 3 ? 26000 : 14000);
  }
  toast(msg: string) {
    const t = this.el('toast');
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout((t as unknown as { _h: number })._h);
    (t as unknown as { _h: number })._h = window.setTimeout(() => t.classList.remove('on'), 5200);
  }
  async focusEvent(e: EventLite) {
    const { view, client } = this.ctx;
    if (e.person) {
      const r = await client.event(e.id);
      if (r.personAlive) { this.select('person', e.person, true); return; }
    }
    if (e.settlement && client.settlementById.has(e.settlement)) { this.select('settlement', e.settlement, true); return; }
    if (e.x !== undefined && e.y !== undefined) view.flyToCell(e.x, e.y, 30, 0, 0.6);
  }

  // ---------------------------------------------------------------- selection
  clearSelection() {
    this.sel = null;
    this.ctx.view.selected = null;
    this.el('panel').classList.remove('open');
  }
  select(kind: PanelKind, id: number, fly = false, extra?: number) {
    const { view, client } = this.ctx;
    this.sel = { kind, id, extra };
    view.selected = ['person', 'settlement', 'node', 'building'].includes(kind) ? { kind, id, extra } : null;
    if (fly) {
      if (kind === 'person') { view.setFollow({ kind: 'person', id }, Math.min(view.rig.alt, 0.06)); client.follow({ kind: 'person', id }, this.followFamily); }
      else if (kind === 'settlement') { view.setFollow({ kind: 'settlement', id }, Math.min(Math.max(view.rig.alt, 1.2), 6)); client.follow({ kind: 'settlement', id }, false); }
      else if (kind === 'civ') { const cap = client.settlements.find((s) => s.civ === id && s.capital); if (cap) { view.setFollow({ kind: 'settlement', id: cap.id }, 160); client.follow({ kind: 'settlement', id: cap.id }, false); } }
    }
    this.lastPanelHtml = '';
    this.renderPanel();
  }

  renderPanel() {
    if (!this.sel || this.panelBusy) return;
    const { client, view } = this.ctx;
    const sel = this.sel;
    const following = view.follow?.kind === 'person' && sel.kind === 'person' && view.follow.id === sel.id;
    this.panelBusy = true;
    client.panel(sel.kind, sel.id, sel.extra, following, this.followFamily).then((html) => {
      this.panelBusy = false;
      // the selection changed while this was on its way: ask again for the new one
      if (this.sel !== sel) { this.renderPanel(); return; }
      if (html === this.lastPanelHtml) return;
      const p = this.el('panel');
      const top = p.scrollTop;
      this.lastPanelHtml = html;
      p.innerHTML = `<button class="close" data-act="close">×</button>${html}`;
      p.scrollTop = top;
      p.classList.add('open');
    });
  }

  // ---------------------------------------------------------------- almanac
  openAlmanac(tab?: string) {
    if (tab) this.tab = tab;
    this.el('almanac').classList.add('open');
    this.renderAlmanac();
  }
  closeAlmanac() {
    this.el('almanac').classList.remove('open');
  }
  private renderAlmanac() {
    this.ctx.client.almanac(this.tab, [...this.chronFilter]).then((html) => { this.el('almanac').innerHTML = html; });
  }
  private renderDev() {
    if (this.devBusy) return;
    this.devBusy = true;
    this.ctx.client.dev(this.ctx.fps()).then((html) => {
      this.devBusy = false;
      const dev = this.el('dev');
      if (document.activeElement?.id === 'insp') return;
      const t = this.ctx.view.terrain.stats;
      dev.innerHTML = html + `<h4>RENDERER</h4><div class="k">${t.drawn} ground tiles drawn · ${t.cached} cached · ${t.pending} building · altitude ${this.ctx.view.rig.alt.toFixed(4)} km</div>`;
    });
  }

  // ---------------------------------------------------------------- input
  private delegate(e: MouseEvent) {
    const t = (e.target as HTMLElement).closest('[data-person],[data-settlement],[data-civ],[data-culture],[data-species],[data-marine],[data-body],[data-act],[data-speed],[data-jump],[data-tab],[data-chron],[data-evt]') as HTMLElement | null;
    if (!t) return;
    const { client, view } = this.ctx;
    const d = t.dataset;
    if (d.speed !== undefined) { client.cancelJump(); client.setSpeed(Number(d.speed)); return; }
    if (d.jump) { client.jump(Number(d.jump), `Jumping ${d.jump} year${d.jump === '1' ? '' : 's'} forward`); this.el('jump').classList.remove('open'); return; }
    if (d.tab) { this.tab = d.tab; this.renderAlmanac(); return; }
    if (d.chron) { if (this.chronFilter.has(d.chron)) this.chronFilter.delete(d.chron); else this.chronFilter.add(d.chron); this.renderAlmanac(); return; }
    if (d.evt) {
      client.event(Number(d.evt)).then((r) => { if (r.e) { this.closeAlmanac(); this.focusEvent(r.e); } });
      return;
    }
    if (d.act) {
      switch (d.act) {
        case 'jump': this.el('jump').classList.toggle('open'); return;
        case 'politics': view.politics = !view.politics; return;
        case 'almanac': this.openAlmanac(); return;
        case 'closealmanac': this.closeAlmanac(); return;
        case 'dev': this.el('dev').classList.toggle('open'); return;
        case 'save': client.save(); return;
        case 'new': { const s = prompt('Seed for the new universe (leave blank for a random one):', ''); if (s !== null) this.ctx.newUniverse(s.trim()); return; }
        case 'close': this.clearSelection(); return;
        case 'canceljump': client.cancelJump(); return;
        case 'copyseed': {
          const url = `${location.origin}${location.pathname}#seed=${encodeURIComponent(client.info.seedText)}`;
          navigator.clipboard?.writeText(url).then(() => this.toast('Share link copied. Same seed, same initial universe.'), () => prompt('Share this link:', url));
          return;
        }
        case 'follow': if (d.person) this.select('person', Number(d.person), true); return;
        case 'follow-settlement': view.setFollow({ kind: 'settlement', id: Number(d.settlement) }, 2); client.follow({ kind: 'settlement', id: Number(d.settlement) }, false); return;
        case 'follow-civ': this.select('civ', Number(d.civ), true); return;
        case 'familyline': this.followFamily = !this.followFamily; if (view.follow?.kind === 'person') client.follow({ kind: 'person', id: view.follow.id }, this.followFamily); this.lastPanelHtml = ''; this.renderPanel(); return;
        case 'replaycheck': client.replay(); return;
        case 'exportsave': client.exportSave(); return;
      }
      return;
    }
    if (d.person) { this.closeAlmanac(); this.select('person', Number(d.person), true); return; }
    if (d.settlement) { this.closeAlmanac(); this.select('settlement', Number(d.settlement), true); return; }
    if (d.civ) { this.closeAlmanac(); this.select('civ', Number(d.civ), true); return; }
    if (d.culture) { this.select('culture', Number(d.culture)); return; }
    if (d.species) { this.select('species', Number(d.species)); return; }
    if (d.marine) { this.select('marine', Number(d.marine)); return; }
    if (d.body) { this.select('body', Number(d.body)); return; }
  }

  private key(e: KeyboardEvent) {
    const tag = (e.target as HTMLElement)?.tagName;
    const { client, view } = this.ctx;
    if (tag === 'INPUT') {
      if (e.key === 'Enter' && (e.target as HTMLInputElement).id === 'insp') {
        const id = Number((e.target as HTMLInputElement).value);
        client.personExists(id).then((ok) => { if (ok) this.select('person', id, true); });
      }
      return;
    }
    const sp = client.snap?.speedIdx ?? 1;
    if (e.key === ' ') { e.preventDefault(); if (sp === 0) client.setSpeed(this.lastSpeed || SPEED.x100); else { this.lastSpeed = sp; client.setSpeed(0); } }
    else if (e.key === '[') client.setSpeed(Math.max(1, sp - 1));
    else if (e.key === ']') client.setSpeed(Math.min(SPEEDS.length - 1, sp + 1));
    else if (e.key === 'p' || e.key === 'P') view.politics = !view.politics;
    else if (e.key === 'h' || e.key === 'H') { this.helpHidden = !this.helpHidden; document.getElementById('ui')!.classList.toggle('hidden', this.helpHidden); }
    else if (e.key === '`') this.el('dev').classList.toggle('open');
    else if (e.key === 'Escape') { this.clearSelection(); this.closeAlmanac(); view.setFollow(null); }
    else if (e.key === 'l' || e.key === 'L') this.openAlmanac('chronicle');
    else if (/^[1-9]$/.test(e.key) || (e.shiftKey && /^Digit[1-9]$/.test(e.code))) {
      const n = e.shiftKey ? Number(e.code.slice(5)) : Number(e.key);
      if (e.shiftKey) { this.bookmarks[n - 1] = view.currentBookmark('Bookmark ' + n); localStorage.setItem('pd-bm-' + client.info.seedText, JSON.stringify(this.bookmarks)); this.toast(`Camera bookmark ${n} saved`); }
      else if (this.bookmarks[n - 1]) view.gotoBookmark(this.bookmarks[n - 1]);
    }
  }
}

export function fmtRate(daysPerSec: number): string {
  const perMin = daysPerSec * 1440;
  if (perMin < 1.5) return `${perMin.toFixed(1)} min/s`;
  if (perMin < 90) return `${perMin.toFixed(0)} min/s`;
  if (daysPerSec < 1.5) return `${(daysPerSec * 24).toFixed(0)} h/s`;
  if (daysPerSec < 180) return `${daysPerSec.toFixed(0)} days/s`;
  return `${(daysPerSec / 360).toFixed(1)} yr/s`;
}
void yearOf;

import type { World } from '../sim/world';
import type { Engine } from '../engine';
import { SPEEDS, SPEED_LABELS, SPEED } from '../engine';
import type { ObserverView, Bookmark } from '../render/observer';
import { BIOME_NAMES } from '../sim/planet';
import { NEEDS, PERSONALITY, SKILLS, Person } from '../sim/people';
import { VALUE_KEYS } from '../sim/culture';
import { TECHS, TECH_IDS } from '../sim/technology';
import { SEASON_NAMES, dayOfYear, formatYear, seasonOf, yearOf } from '../sim/time';
import { W, H, cellLat, distKm, idx, wrapX } from '../sim/grid';
import { cellOf } from '../sim/behavior';
import type { SimEvent, EventType } from '../sim/events';
import { deserialize, serialize } from '../sim/persistence';

export interface AppCtx {
  world: World;
  engine: Engine;
  view: ObserverView;
  save(): Promise<void>;
  newUniverse(seed: string): void;
  fps(): number;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const bar10 = (v: number) => {
  const n = Math.round(Math.max(0, Math.min(1, v)) * 10);
  return '█'.repeat(n) + '░'.repeat(10 - n);
};
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const num = (n: number) => Math.round(n).toLocaleString('en-US');

type Sel = { kind: 'person' | 'settlement' | 'civ' | 'species' | 'culture'; id: number } | null;

export class UI {
  private el = (id: string) => document.getElementById(id)!;
  sel: Sel = null;
  followFamily = false;
  private timers: number[] = [];
  private bookmarks: Bookmark[] = [];
  private tab = 'chronicle';
  private chronFilter = new Set<string>(['civilization', 'discovery', 'conflict', 'life', 'people', 'nature']);
  private lastPanelHtml = '';
  private devLog: string[] = [];
  private determinism = '';
  private ctx!: AppCtx;
  helpHidden = false;

  attach(ctx: AppCtx) {
    this.ctx = ctx;
    const w = ctx.world;
    try { this.bookmarks = JSON.parse(localStorage.getItem('pd-bm-' + w.seedText) ?? '[]'); } catch { this.bookmarks = []; }
    this.buildBar();
    this.el('help').innerHTML = 'Drag <kbd>pan</kbd> · Right-drag <kbd>rotate</kbd> · Wheel <kbd>zoom</kbd> · Click <kbd>inspect</kbd><br><kbd>Space</kbd> pause · <kbd>[</kbd> <kbd>]</kbd> speed · <kbd>P</kbd> borders · <kbd>1–9</kbd> bookmarks (<kbd>Shift</kbd> to save) · <kbd>H</kbd> hide UI';
    w.bus.on('*', (e) => {
      if (e.weight >= 2) this.pushFeed(e);
      this.devLog.push(`Y${yearOf(e.day)} ${e.type} ${e.text.split('\n')[0]}`);
      if (this.devLog.length > 120) this.devLog.shift();
      if (e.weight >= 3) this.toast(e.text.split('\n')[0]);
    });
    ctx.view.onPick = (p) => {
      if (!p) { this.clearSelection(); return; }
      this.select(p.kind === 'animal' ? 'species' : (p.kind as 'person' | 'settlement'), p.id, true);
    };
    document.addEventListener('click', (e) => this.delegate(e));
    window.addEventListener('keydown', (e) => this.key(e));
    this.timers.push(window.setInterval(() => this.update(), 250));
    this.update();
  }

  // ---------------------------------------------------------------- top bar & controls
  private buildBar() {
    const bar = this.el('bar');
    const sp = SPEEDS.map((s, i) => `<button data-speed="${i}" title="${i ? s.toLocaleString() + ' days per second' : 'Pause'}">${SPEED_LABELS[i]}</button>`).join('');
    bar.innerHTML = `${sp}<span class="sep"></span><span class="eff" id="eff"></span><span class="sep"></span>
      <button data-act="jump">Jump ▴</button><button data-act="politics" id="b-pol">Borders</button><button data-act="almanac">Almanac</button><button data-act="dev">Dev</button><button data-act="save">Save</button><button data-act="new">New</button>
      <div id="jump" class="glass"><button data-jump="1">+1 year</button><button data-jump="10">+10 years</button><button data-jump="100">+100 years</button><button data-jump="1000">+1,000 years</button></div>`;
  }

  update() {
    const { world: w, engine: e, view } = this.ctx;
    const y = yearOf(w.day);
    const rd = e.renderDay;
    const season = SEASON_NAMES[seasonOf(rd)];
    const dd = dayOfYear(rd);
    const pop = w.alive.length;
    const sets = w.activeSettlements().length;
    this.el('top').innerHTML = `<div class="title">Pocket Dimension</div><div class="year">${formatYear(w.day)}</div>
      <div class="sub">${season} · day ${Math.floor(dd) + 1} · <b>${num(pop)}</b> people · <b>${sets}</b> settlements · <b>${w.livingCivs().length}</b> peoples</div>
      <div class="sub">seed <button class="link" data-act="copyseed" title="Copy a link to this universe">${esc(w.seedText)}</button>${w.awakened ? '' : ' · <span style="color:var(--warm)">life is still waking…</span>'}</div>`;
    SPEEDS.forEach((_, i) => {
      const b = this.el('bar').querySelector(`[data-speed="${i}"]`);
      if (b) b.classList.toggle('on', e.speedIdx === i && !e.jumping);
    });
    const eff = e.paused ? 'paused' : e.jumping ? 'jumping' : e.effective < SPEEDS[e.speedIdx] * 0.7 ? `≈${fmtRate(e.effective)} (capped)` : fmtRate(e.effective);
    this.el('eff').textContent = eff;
    document.getElementById('b-pol')?.classList.toggle('on', view.planet.politics);
    const pg = this.el('progress');
    if (e.jumping) {
      const j = e.jumping;
      pg.style.display = 'block';
      pg.innerHTML = `${esc(j.label)}… ${formatYear(w.day)}<div class="b"><i style="width:${(100 * (1 - j.remaining / j.total)).toFixed(1)}%"></i></div><button class="btn" data-act="canceljump" style="margin-top:6px;padding:3px 10px">cancel</button>`;
    } else pg.style.display = 'none';
    if (this.sel) this.renderPanel();
    if (this.el('dev').classList.contains('open')) this.renderDev();
    if (this.el('almanac').classList.contains('open') && this.tab === 'chronicle' && false) this.renderAlmanac();
    void y;
    // follow-through when a followed person dies
    const f = view.follow;
    if (f && f.kind === 'person') {
      const p = w.people.get(f.id);
      if (p && !p.alive) {
        if (this.followFamily) {
          const heir = p.children.map((id) => w.people.get(id)).filter((c): c is Person => !!c && c.alive).sort((a, b) => a.birth - b.birth)[0];
          if (heir) { this.toast(`${p.name} has died. Following ${heir.name}.`); this.select('person', heir.id, true); return; }
        }
        this.toast(`${p.name} has died${p.deathCause ? ' of ' + p.deathCause : ''}.`);
        view.setFollow(null);
      }
    }
  }

  // ---------------------------------------------------------------- feed & toast
  private pushFeed(e: SimEvent) {
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
    clearTimeout((t as any)._h);
    (t as any)._h = setTimeout(() => t.classList.remove('on'), 5200);
  }
  focusEvent(e: SimEvent) {
    const { view, world: w } = this.ctx;
    if (e.persons?.length) {
      const p = w.people.get(e.persons[0]);
      if (p?.alive) { this.select('person', p.id, true); return; }
    }
    if (e.settlement) { this.select('settlement', e.settlement, true); return; }
    if (e.x !== undefined && e.y !== undefined) view.flyToCell(e.x, e.y, 90, 0, 0.6);
  }

  // ---------------------------------------------------------------- selection
  clearSelection() {
    this.sel = null;
    this.ctx.view.entities.selected = null;
    this.el('panel').classList.remove('open');
  }
  select(kind: 'person' | 'settlement' | 'civ' | 'species' | 'culture', id: number, fly = false) {
    const { view, world: w } = this.ctx;
    this.sel = { kind, id };
    view.entities.selected = kind === 'person' || kind === 'settlement' ? { kind, id } : null;
    if (fly) {
      if (kind === 'person') view.setFollow({ kind: 'person', id }, Math.min(view.rig.alt, 6));
      else if (kind === 'settlement') { view.setFollow({ kind: 'settlement', id }, Math.min(Math.max(view.rig.alt, 20), 60)); }
      else if (kind === 'civ') { view.setFollow({ kind: 'civ', id }, 1400); }
    }
    this.lastPanelHtml = '';
    this.renderPanel();
    void w;
  }

  private nearest(x: number, y: number) {
    const w = this.ctx.world;
    let best: { name: string; d: number; id: number } | null = null;
    for (const s of w.activeSettlements()) {
      const d = distKm(x, y, s.x, s.y);
      if (!best || d < best.d) best = { name: s.name, d, id: s.id };
    }
    return best;
  }

  private lat(y: number) {
    const l = (cellLat(Math.min(H - 1, Math.max(0, Math.floor(y)))) * 180) / Math.PI;
    return `${Math.abs(l).toFixed(0)}°${l >= 0 ? 'N' : 'S'}`;
  }
  private lon(x: number) {
    const l = ((x / W) * 360 - 180);
    return `${Math.abs(l).toFixed(0)}°${l >= 0 ? 'E' : 'W'}`;
  }

  renderPanel() {
    const p = this.el('panel');
    let html = '';
    if (!this.sel) return;
    switch (this.sel.kind) {
      case 'person': html = this.personHtml(this.sel.id); break;
      case 'settlement': html = this.settlementHtml(this.sel.id); break;
      case 'civ': html = this.civHtml(this.sel.id); break;
      case 'species': html = this.speciesHtml(this.sel.id); break;
      case 'culture': html = this.cultureHtml(this.sel.id); break;
    }
    if (html === this.lastPanelHtml) return;
    const top = p.scrollTop;
    this.lastPanelHtml = html;
    p.innerHTML = `<button class="close" data-act="close">×</button>${html}`;
    p.scrollTop = top;
    p.classList.add('open');
  }

  private link(kind: string, id: number, text: string) {
    return `<a class="l" data-${kind}="${id}">${esc(text)}</a>`;
  }
  private pname(id: number) {
    const q = this.ctx.world.people.get(id);
    return q ? this.link('person', id, q.name) : '<span style="color:var(--dim)">unknown</span>';
  }
  private barRow(label: string, v: number) {
    return `<div class="bar"><span>${label}</span><i><b style="width:${Math.round(Math.max(0, Math.min(1, v)) * 100)}%"></b></i><em>${bar10(v).slice(0, 0)}${Math.round(v * 10)}/10</em></div>`;
  }

  private goalText(p: Person): string {
    const w = this.ctx.world;
    const s = p.home ? w.settlements[p.home - 1] : undefined;
    const band = p.band ? w.bands.get(p.band) : undefined;
    switch (p.goal) {
      case 'drink': return 'Searching for water';
      case 'eat': return 'Searching for food';
      case 'socialize': return `Spending time with others${s ? ' in ' + s.name : ''}`;
      case 'explore': return 'Exploring beyond the known lands';
      case 'migrate': return band ? `Travelling with ${band.members.length} others toward new land (${band.note})` : 'Travelling';
      case 'raid': return 'Raiding with a band of outcasts';
      case 'wander': return p.occupation === 'hermit' ? 'Living alone, apart from society' : band ? `Wandering with ${band.members.length - 1} followers (${band.note})` : 'Wandering alone';
      default:
        if (p.occupation === 'farmer') return `Tending fields near ${s?.name ?? 'home'}`;
        if (p.occupation === 'hunter') return 'Hunting game';
        if (p.occupation === 'forager') return 'Gathering food';
        if (p.occupation === 'leader') return `Leading ${s?.name ?? 'the community'}`;
        if (p.occupation === 'child') return 'Growing up';
        return `Working as a ${p.occupation}`;
    }
  }

  private descTree(id: number, prefix: string, depth: number, out: string[], isRoot = false) {
    const w = this.ctx.world;
    const p = w.people.get(id);
    if (!p) return;
    if (isRoot) out.push(`${this.pname(id)}${p.alive ? '' : ' †'}`);
    const kids = p.children.map((c) => w.people.get(c)).filter((c): c is Person => !!c);
    kids.forEach((k, i) => {
      const last = i === kids.length - 1;
      out.push(`${prefix}${last ? '└── ' : '├── '}${this.pname(k.id)}${k.alive ? '' : ' †'} <span style="color:var(--dim)">${yearOf(k.birth)}</span>`);
      if (depth > 1) this.descTree(k.id, prefix + (last ? '    ' : '│   '), depth - 1, out);
    });
  }

  personHtml(id: number): string {
    const { world: w, view } = this.ctx;
    const p = w.people.get(id);
    if (!p) return '<h2>Unknown</h2>';
    const sp = w.eco.speciesById(p.species);
    const cul = w.cultures.get(p.culture);
    const lang = cul ? w.langs.get(cul.language) : undefined;
    const s = p.home ? w.settlements[p.home - 1] : undefined;
    const nb = this.nearest(p.x, p.y);
    const age = Math.floor(p.ageYears(w.day));
    const biome = BIOME_NAMES[w.planet.biome[cellOf(p)]];
    const following = view.follow?.kind === 'person' && view.follow.id === id;
    const parts: string[] = [];
    parts.push(`<h2>${esc(p.name)}${p.legend ? ' <span title="Legend" style="color:var(--warm)">✦</span>' : ''}</h2>`);
    parts.push(`<div style="color:var(--dim);margin-bottom:8px">${p.alive ? '' : `<span class="neg">Died in ${formatYear(p.death)} of ${esc(p.deathCause)} · </span>`}${cap(p.occupation)}${s ? ' of ' + this.link('settlement', s.id, s.name) : ''}</div>`);
    parts.push(`<div class="kv"><span>Name</span><span>${esc(p.name)}</span><span>Age</span><span>${age} · ${p.sex ? 'female' : 'male'}${p.pregnantUntil >= 0 ? ' · expecting' : ''} · born ${yearOf(p.birth).toLocaleString()}</span>
      <span>Species</span><span>${esc(sp?.name ?? '?')}</span><span>Culture</span><span>${cul ? this.link('culture', cul.id, 'The ' + cul.name) : '—'}${lang ? ` · speaks ${esc(lang.name)}` : ''}</span>
      <span>Location</span><span>${this.lat(p.y)} ${this.lon(p.x)} · ${esc(biome)}${nb ? ` · ${Math.round(nb.d)} km from ${this.link('settlement', nb.id, nb.name)}` : ''}</span>
      <span>Health</span><span>${Math.round(p.health * 100)}%</span><span>Status</span><span>${bar10(p.status)}</span></div>`);
    parts.push('<h3>Personality</h3>');
    const order = [...PERSONALITY.keys()].sort((a, b) => p.personality[b] - p.personality[a]);
    for (const i of order) parts.push(this.barRow(cap(PERSONALITY[i]), p.personality[i]));
    parts.push('<h3>Current goal</h3>' + esc(this.goalText(p)));
    if (p.alive && p.needs.length) {
      parts.push('<h3>Needs</h3>');
      NEEDS.forEach((n, i) => { if (['hunger', 'thirst', 'shelter', 'safety', 'social', 'curiosity'].includes(n)) parts.push(this.barRow(cap(n), p.needs[i])); });
    }
    // family
    parts.push('<h3>Family</h3>');
    const fam: string[] = [];
    const m = w.people.get(p.mother), f = w.people.get(p.father);
    fam.push(`<div>Parents: ${p.mother ? this.pname(p.mother) : '—'}${p.father ? ' & ' + this.pname(p.father) : ''}</div>`);
    if (p.partner) fam.push(`<div>Partner: ${this.pname(p.partner)}</div>`);
    const sibs = new Set<number>();
    for (const par of [m, f]) if (par) for (const c of par.children) if (c !== id) sibs.add(c);
    if (sibs.size) fam.push(`<div>Siblings: ${[...sibs].map((c) => this.pname(c)).join(', ')}</div>`);
    const gp: number[] = [];
    for (const par of [m, f]) if (par) { if (par.mother) gp.push(par.mother); if (par.father) gp.push(par.father); }
    if (gp.length) fam.push(`<div>Grandparents: ${gp.map((c) => this.pname(c)).join(', ')}</div>`);
    const root = w.rootAncestor(id);
    const desc = w.descendantsCount(id);
    fam.push(`<div style="color:var(--dim)">Generation ${p.generation}${root.depth ? ` · traces back ${root.depth} generations to ` : ''}${root.depth ? this.pname(root.id) : ''}${desc ? ` · ${num(desc)} known descendants` : ''}</div>`);
    parts.push(fam.join(''));
    const tree: string[] = [];
    if (p.children.length) { this.descTree(id, '', 3, tree, true); parts.push(`<pre class="tree">${tree.join('\n')}</pre>`); }
    parts.push('<h3>Memories</h3>');
    const mems = [...p.memories].sort((a, b) => b.day - a.day).slice(0, 8);
    parts.push(mems.length ? mems.map((mm) => `<div class="mem"><span class="yr">${yearOf(mm.day).toLocaleString()}</span> <span class="${mm.valence >= 0 ? 'pos' : 'neg'}">${mm.valence >= 0 ? '＋' : '－'}</span> ${esc(mm.text)}${mm.other && w.people.has(mm.other) ? ' · ' + this.pname(mm.other) : ''}</div>`).join('') : '<span style="color:var(--dim)">Nothing of note yet.</span>');
    parts.push('<h3>Relationships</h3>');
    const rels = [...p.relations].filter(([oid]) => w.people.has(oid)).sort((a, b) => Math.abs(b[1].affinity) - Math.abs(a[1].affinity)).slice(0, 7);
    parts.push(rels.length ? rels.map(([oid, r]) => `<div>${this.pname(oid)} <span style="color:var(--dim)">${r.kind}</span> <span class="${r.affinity >= 0 ? 'pos' : 'neg'}">${r.affinity >= 0 ? '+' : ''}${r.affinity.toFixed(2)}</span></div>`).join('') : '<span style="color:var(--dim)">No close ties.</span>');
    parts.push('<h3>Skills</h3>');
    SKILLS.forEach((sk, i) => parts.push(this.barRow(cap(sk), Math.min(1, p.skills[i]))));
    if (cul) {
      parts.push('<h3>Beliefs</h3>');
      VALUE_KEYS.forEach((k, i) => parts.push(this.barRow(cap(k), p.beliefs[i])));
    }
    parts.push(`<div class="row">${p.alive ? `<button class="btn" data-act="follow" data-person="${id}">${following ? 'Following ✓' : 'Follow'}</button>` : ''}<button class="btn" data-act="familyline">${this.followFamily ? 'Follow descendants ✓' : 'Follow descendants'}</button>${s ? `<button class="btn" data-settlement="${s.id}">Settlement</button>` : ''}${s ? `<button class="btn" data-civ="${s.civ}">Civilization</button>` : ''}</div>`);
    return parts.join('');
  }

  settlementHtml(id: number): string {
    const { world: w } = this.ctx;
    const s = w.settlements[id - 1];
    if (!s) return '<h2>Unknown</h2>';
    const cul = w.cultures.get(s.culture);
    const lang = cul ? w.langs.get(cul.language) : undefined;
    const civ = w.civs[s.civ - 1];
    const leader = s.leader ? w.people.get(s.leader) : undefined;
    const founder = s.founder ? w.people.get(s.founder) : undefined;
    const parts: string[] = [];
    parts.push(`<h2>${esc(s.name)}</h2><div style="color:var(--dim)">${cap(s.stage)}${s.nomadic ? ' · nomadic' : ''}${s.abandoned >= 0 ? ` · abandoned in ${formatYear(s.abandoned)}` : ''}</div>`);
    parts.push(`<div class="kv" style="margin-top:8px"><span>Population</span><span>${num(s.pop)} <span style="color:var(--dim)">(peak ${num(s.peak)})</span></span>
      <span>Founded</span><span>${formatYear(s.founded)}${founder ? ' by ' + this.pname(founder.id) : ''}</span>
      <span>Culture</span><span>${cul ? this.link('culture', cul.id, 'The ' + cul.name) : '—'}</span><span>Language</span><span>${esc(lang?.name ?? '—')}</span>
      <span>Leader</span><span>${leader ? this.pname(leader.id) : '—'}</span><span>Civilization</span><span>${civ ? this.link('civ', civ.id, 'The ' + civ.name) : '—'}</span>
      <span>Location</span><span>${this.lat(s.y)} ${this.lon(s.x)} · ${esc(BIOME_NAMES[w.planet.biome[idx(wrapX(Math.floor(s.x)), Math.floor(s.y))]])}</span></div>`);
    parts.push('<h3>Condition</h3>');
    parts.push(this.barRow('Food stress', s.stress) + this.barRow('Cohesion', s.cohesion) + this.barRow('Threat', s.threat));
    parts.push(`<div style="color:var(--dim);margin-top:4px">Food store ${num(s.food)} · goods ${num(s.goods)} · housing ${num(s.housing)}${s.diseaseUntil > w.day ? ' · <span class="neg">epidemic</span>' : ''}</div>`);
    parts.push('<h3>Technology</h3>' + ([...s.tech].map((t) => `<span class="chip on">${esc(TECHS[t].name)}</span>`).join('') || '<span style="color:var(--dim)">None yet.</span>'));
    parts.push('<h3>Occupations</h3>' + Object.entries(s.occupations).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<span class="chip">${esc(k)} ${v}</span>`).join(''));
    parts.push(`<h3>Origin</h3><div style="color:var(--dim)">${esc(s.originNote)}</div>`);
    parts.push('<h3>History</h3>' + this.eventList(w.history.query({ settlement: id, minWeight: 1, limit: 8 })));
    parts.push(`<div class="row"><button class="btn" data-act="follow-settlement" data-settlement="${id}">Follow</button>${civ ? `<button class="btn" data-civ="${civ.id}">Civilization</button>` : ''}</div>`);
    return parts.join('');
  }

  private eventList(events: SimEvent[]) {
    if (!events.length) return '<span style="color:var(--dim)">Nothing recorded yet.</span>';
    return events.map((e) => `<div class="hist"><div class="y">${formatYear(e.day)}</div><div class="t">${esc(e.text.split('\n')[0])}</div></div>`).join('');
  }

  private langTree(highlight: number): string {
    const { world: w } = this.ctx;
    const kids = new Map<number, number[]>();
    for (const l of w.langs.list) { const a = kids.get(l.parent) ?? []; a.push(l.id); kids.set(l.parent, a); }
    const out: string[] = [];
    const walk = (parent: number, prefix: string) => {
      const ch = kids.get(parent) ?? [];
      ch.forEach((id, i) => {
        const l = w.langs.get(id)!;
        const last = i === ch.length - 1;
        out.push(`${prefix}${last ? '└── ' : '├── '}${id === highlight ? `<b style="color:var(--warm)">${esc(l.name)}</b>` : esc(l.name)}${l.writing !== 'none' ? ' ✎' : ''}`);
        walk(id, prefix + (last ? '    ' : '│   '));
      });
    };
    out.push('Proto-Language');
    walk(0, '');
    return out.join('\n');
  }

  civHtml(id: number): string {
    const { world: w } = this.ctx;
    const civ = w.civs[id - 1];
    if (!civ) return '<h2>Unknown</h2>';
    const members = civ.members.map((i) => w.settlements[i - 1]).filter((s) => s && s.abandoned < 0);
    const cul = w.cultures.get(civ.culture);
    const lang = cul ? w.langs.get(cul.language) : undefined;
    const leader = civ.leader ? w.people.get(civ.leader) : undefined;
    const techs = new Set<string>();
    for (const s of members) for (const t of s.tech) techs.add(t);
    let warriors = 0, def = 0, food = 0, goods = 0;
    for (const s of members) { warriors += s.occupations['warrior'] ?? 0; def += s.defense; food += s.food; goods += s.goods; }
    const parts: string[] = [];
    parts.push(`<h2>The ${esc(civ.name)}</h2><div style="color:var(--dim)">${cap(civ.rank)} · ${esc(civ.government)}${civ.collapsed >= 0 ? ` · <span class="neg">fell in ${formatYear(civ.collapsed)}</span>` : ''}</div>`);
    parts.push(`<h3>Civilization</h3><div class="kv"><span>Population</span><span>${num(civ.pop)}</span><span>Territory</span><span>≈ ${num(civ.territory)} km²</span>
      <span>Cities</span><span>${members.length ? members.sort((a, b) => b.pop - a.pop).slice(0, 8).map((s) => `${this.link('settlement', s.id, s.name)} <span style="color:var(--dim)">${s.pop}</span>`).join(', ') + (members.length > 8 ? ` +${members.length - 8}` : '') : '—'}</span>
      <span>Culture</span><span>${cul ? this.link('culture', cul.id, 'The ' + cul.name) : '—'}</span><span>Language</span><span>${esc(lang?.name ?? '—')}${lang && lang.writing !== 'none' ? ' · ' + lang.writing + ' script ✎' : ''}</span>
      <span>Government</span><span>${esc(civ.government)} · legitimacy ${civ.legitimacy.toFixed(2)}</span><span>Leader</span><span>${leader ? this.pname(leader.id) : '—'}</span>
      <span>Military</span><span>${warriors} warriors · defence ${(def * 100).toFixed(0)}</span><span>Economy</span><span>food ${num(food)} · goods ${num(goods)}</span><span>Founded</span><span>${formatYear(civ.founded)}</span></div>`);
    parts.push('<h3>Technology</h3>' + ([...techs].map((t) => `<span class="chip on">${esc(TECHS[t as keyof typeof TECHS].name)}</span>`).join('') || '<span style="color:var(--dim)">None yet.</span>'));
    if (lang) parts.push(`<h3>Language family</h3><pre class="tree">${this.langTree(lang.id)}</pre>`);
    parts.push('<h3>History</h3>' + this.eventList(w.history.query({ civ: id, minWeight: 1, limit: 10 })));
    parts.push('<h3>Origin</h3><div style="color:var(--dim)">' + esc(civ.note || '—') + '</div>');
    // relations
    const rel: { civ: (typeof w.civs)[number]; d: number }[] = [];
    const cap1 = w.settlements[civ.capital - 1];
    if (cap1) for (const o of w.livingCivs()) {
      if (o.id === id) continue;
      const c2 = w.settlements[o.capital - 1];
      if (c2) rel.push({ civ: o, d: distKm(cap1.x, cap1.y, c2.x, c2.y) });
    }
    rel.sort((a, b) => a.d - b.d);
    parts.push('<h3>Relations</h3>' + (rel.length ? rel.slice(0, 5).map((r) => {
      const oc = w.cultures.get(r.civ.culture);
      const dist = cul && oc ? w.cultures.distance(cul, oc) : 0;
      return `<div>${this.link('civ', r.civ.id, 'The ' + r.civ.name)} <span style="color:var(--dim)">${Math.round(r.d)} km · ${dist < 0.25 ? 'kindred' : dist < 0.5 ? 'distinct' : 'foreign'} culture · pop ${num(r.civ.pop)}</span></div>`;
    }).join('') : '<span style="color:var(--dim)">No contact.</span>'));
    parts.push(`<div class="row"><button class="btn" data-act="follow-civ" data-civ="${id}">Follow</button></div>`);
    return parts.join('');
  }

  cultureHtml(id: number): string {
    const { world: w } = this.ctx;
    const c = w.cultures.get(id);
    if (!c) return '<h2>Unknown</h2>';
    const lang = w.langs.get(c.language);
    const parent = c.parent ? w.cultures.get(c.parent) : undefined;
    const parts: string[] = [`<h2>The ${esc(c.name)} ${esc(c.symbol)}</h2><div style="color:var(--dim)">${esc(c.origin)}</div>`];
    parts.push(`<div class="kv" style="margin-top:8px"><span>Emerged</span><span>${formatYear(c.born)}</span><span>Ancestor</span><span>${parent ? this.link('culture', parent.id, 'The ' + parent.name) : 'none (first people)'}</span><span>Language</span><span>${esc(lang?.name ?? '—')}</span>
      <span>Word order</span><span>${lang?.wordOrder ?? '—'} · ${lang?.morphology ?? ''}</span><span>Vocabulary</span><span>~${num(lang?.vocabulary ?? 0)} words</span><span>Writing</span><span>${lang?.writing ?? 'none'}</span></div>`);
    parts.push('<h3>Values</h3>' + VALUE_KEYS.map((k, i) => this.barRow(cap(k), c.values[i])).join(''));
    parts.push('<h3>Traditions</h3><div class="kv">' + Object.entries(c.traditions).map(([k, v]) => `<span>${esc(k)}</span><span>${esc(v)}</span>`).join('') + '</div>');
    if (lang) parts.push('<h3>Sample words</h3><div style="color:var(--dim)">' + Object.entries(lang.lexicon).map(([k, v]) => `${esc(k)} <b style="color:var(--ink)">${esc(v)}</b>`).join(' · ') + '</div>' + (lang.shifts.length ? `<div style="color:var(--dim);margin-top:4px">Sound shifts: ${esc(lang.shifts.slice(-8).join(', '))}</div>` : ''));
    parts.push('<h3>History</h3>' + this.eventList(w.history.query({ culture: id, minWeight: 1, limit: 8 })));
    return parts.join('');
  }

  speciesHtml(id: number): string {
    const { world: w } = this.ctx;
    const sp = w.eco.speciesById(id);
    if (!sp) return '<h2>Unknown</h2>';
    let total = 0, regions = 0;
    const t = { size: 0, speed: 0, strength: 0, intel: 0, eyes: 0, hear: 0, tol: 0, tempOpt: 0, aggr: 0, soc: 0 };
    for (const p of w.eco.pops.values()) if (p.sp === id) { total += p.n; regions++; for (const k of Object.keys(t) as (keyof typeof t)[]) t[k] += p.t[k] * p.n; }
    const lineage: string[] = [];
    let cur = sp;
    while (cur.parent) { cur = w.eco.speciesById(cur.parent); lineage.push(cur.name); }
    const parts: string[] = [`<h2>${esc(sp.name)}</h2><div style="color:var(--dim)">${sp.diet === 'herb' ? 'Herbivore' : sp.diet === 'carn' ? 'Carnivore' : 'Omnivore'} · ${sp.extinct >= 0 ? `extinct in ${formatYear(sp.extinct)}` : `${num(total)} individuals in ${regions} regions`}</div>`];
    parts.push(`<div class="kv" style="margin-top:8px"><span>Origin</span><span>${formatYear(sp.born)}${sp.parent ? ' · diverged from ' + esc(w.eco.speciesById(sp.parent).name) : ' · founder species'}</span><span>Peak</span><span>${num(sp.peak)}</span></div>`);
    if (total > 0) {
      parts.push('<h3>Traits (population mean)</h3>');
      const m = (k: keyof typeof t) => t[k] / total;
      parts.push(this.barRow('Size', Math.min(1, Math.log(1 + m('size')) / 3)) + this.barRow('Speed', m('speed')) + this.barRow('Strength', m('strength')) + this.barRow('Intelligence', m('intel')) + this.barRow('Eyesight', m('eyes')) + this.barRow('Hearing', m('hear')) + this.barRow('Aggression', m('aggr')) + this.barRow('Sociality', m('soc')));
      parts.push(`<div style="color:var(--dim)">Prefers ${m('tempOpt').toFixed(0)}°C ± ${m('tol').toFixed(0)}</div>`);
    }
    if (lineage.length) parts.push('<h3>Ancestry</h3><div style="color:var(--dim)">' + lineage.map(esc).join(' ← ') + '</div>');
    parts.push('<h3>History</h3>' + this.eventList(w.history.events.filter((e) => (e.type === 'SPECIATION' || e.type === 'EXTINCTION') && e.text.includes(sp.name)).slice(-6).reverse()));
    return parts.join('');
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
    const { world: w } = this.ctx;
    const tabs = ['chronicle', 'peoples', 'languages', 'life', 'technology'];
    let body = '';
    if (this.tab === 'chronicle') {
      const groups: Record<string, EventType[]> = {
        civilization: ['CIVILIZATION_FOUNDING', 'CIVILIZATION_COLLAPSE', 'FOUNDING', 'SUCCESSION', 'REVOLT', 'GROWTH'],
        discovery: ['DISCOVERY', 'TECHNOLOGY_DISCOVERY', 'TRADE'],
        conflict: ['WAR', 'BATTLE', 'INVASION', 'EXILE'],
        life: ['SPECIATION', 'EXTINCTION', 'AWAKENING'],
        people: ['MIGRATION', 'CULTURAL_SPLIT', 'LANGUAGE_SPLIT', 'MARRIAGE', 'BIRTH', 'DEATH', 'LEGEND'],
        nature: ['DISASTER', 'FAMINE', 'DISEASE'],
      };
      const allowed = new Set<EventType>();
      for (const g of this.chronFilter) for (const t of groups[g]) allowed.add(t);
      const evs = w.history.events.filter((e) => allowed.has(e.type) && e.weight >= 2).slice(-400).reverse();
      body = `<div>${Object.keys(groups).map((g) => `<span class="chip ${this.chronFilter.has(g) ? 'on' : ''}" data-chron="${g}" style="cursor:pointer">${g}</span>`).join('')}</div><div style="margin-top:10px">${evs.map((e) => `<div class="hist"><div class="y">${formatYear(e.day)} · ${e.type.replace(/_/g, ' ')}</div><div class="t">${e.x !== undefined ? `<a class="l" data-evt="${e.id}">${esc(e.text.split('\n')[0])}</a>` : esc(e.text.split('\n')[0])}</div>${e.text.includes('\n') ? `<div class="c">${esc(e.text.split('\n').slice(1).join(' · '))}</div>` : ''}${e.cause ? `<div class="c">because: ${esc(e.cause)}</div>` : ''}</div>`).join('') || '<span style="color:var(--dim)">History has not begun.</span>'}</div>`;
    } else if (this.tab === 'peoples') {
      const civs = [...w.civs].filter((c) => c.collapsed < 0).sort((a, b) => b.pop - a.pop);
      const dead = w.civs.filter((c) => c.collapsed >= 0).length;
      body = `<table><tr><th>People</th><th>Rank</th><th>Government</th><th>Population</th><th>Places</th><th>Culture</th><th>Founded</th></tr>${civs.slice(0, 120).map((c) => `<tr><td><a class="l" data-civ="${c.id}">The ${esc(c.name)}</a></td><td>${c.rank}</td><td>${c.government}</td><td>${num(c.pop)}</td><td>${c.members.length}</td><td>${esc(w.cultures.get(c.culture)?.name ?? '')}</td><td>${yearOf(c.founded)}</td></tr>`).join('')}</table><p style="color:var(--dim)">${dead} peoples have fallen. ${w.cultures.list.length} cultures have existed.</p>
        <h3 style="font-size:10px;letter-spacing:.24em;color:var(--dim);text-transform:uppercase">Cultures</h3><table><tr><th>Culture</th><th>Parent</th><th>Language</th><th>Emerged</th><th>Origin</th></tr>${[...w.cultures.list].reverse().slice(0, 60).map((c) => `<tr><td><a class="l" data-culture="${c.id}">The ${esc(c.name)}</a> ${esc(c.symbol)}</td><td>${c.parent ? esc(w.cultures.get(c.parent)!.name) : '—'}</td><td>${esc(w.langs.get(c.language)?.name ?? '')}</td><td>${yearOf(c.born)}</td><td style="color:var(--dim)">${esc(c.origin)}</td></tr>`).join('')}</table>`;
    } else if (this.tab === 'languages') {
      body = `<pre class="tree" style="font-size:13px">${this.langTree(0)}</pre><table style="margin-top:14px"><tr><th>Language</th><th>Parent</th><th>Order</th><th>Type</th><th>Writing</th><th>Vocab</th><th>Sample</th></tr>${w.langs.list.map((l) => `<tr><td>${esc(l.name)}</td><td>${l.parent ? esc(w.langs.get(l.parent)!.name) : '—'}</td><td>${l.wordOrder}</td><td>${l.morphology}</td><td>${l.writing}</td><td>${num(l.vocabulary)}</td><td style="color:var(--dim)">water ${esc(l.lexicon['water'] ?? '')} · fire ${esc(l.lexicon['fire'] ?? '')} · mother ${esc(l.lexicon['mother'] ?? '')}</td></tr>`).join('')}</table>`;
    } else if (this.tab === 'life') {
      const kids = new Map<number, number[]>();
      const living = new Map<number, number>();
      for (const p of w.eco.pops.values()) living.set(p.sp, (living.get(p.sp) ?? 0) + p.n);
      for (const s of w.eco.species) { const a = kids.get(s.parent) ?? []; a.push(s.id); kids.set(s.parent, a); }
      const lines: string[] = [];
      const walk = (parent: number, prefix: string) => {
        const ch = (kids.get(parent) ?? []).filter((id) => w.eco.species[id - 1].extinct < 0 || hasLiving(id));
        ch.forEach((id, i) => {
          const s = w.eco.species[id - 1];
          const last = i === ch.length - 1;
          const alive = s.extinct < 0;
          lines.push(`${prefix}${last ? '└── ' : '├── '}<a class="l" data-species="${id}" style="${alive ? '' : 'opacity:.5'}">${esc(s.name)}</a> <span style="color:var(--dim)">${s.diet}${alive ? ' · ' + num(living.get(id) ?? 0) : ' †'}</span>`);
          walk(id, prefix + (last ? '    ' : '│   '));
        });
      };
      const hasLiving = (id: number): boolean => w.eco.species[id - 1].extinct < 0 || (kids.get(id) ?? []).some(hasLiving);
      walk(0, '');
      body = `<p style="color:var(--dim)">Tree of life — species emerge from populations changing over time. † extinct.</p><pre class="tree">${lines.slice(0, 400).join('\n')}</pre>`;
    } else if (this.tab === 'technology') {
      const first = new Map<string, SimEvent>();
      for (const e of w.history.events) if (e.type === 'TECHNOLOGY_DISCOVERY' && e.weight >= 3) { const t = TECH_IDS.find((id) => e.text.includes(TECHS[id].description)); if (t && !first.has(t)) first.set(t, e); }
      const acts = w.activeSettlements();
      body = `<table><tr><th>Technology</th><th>Prerequisites</th><th>First discovered</th><th>Known in</th></tr>${TECH_IDS.map((t) => {
        const e = first.get(t);
        const n = acts.filter((s) => s.tech.has(t)).length;
        return `<tr><td>${esc(TECHS[t].name)}</td><td style="color:var(--dim)">${TECHS[t].prereq.map((q) => TECHS[q].name).join(', ') || '—'}</td><td>${e ? `${formatYear(e.day)} · ${esc(e.text.split('\n')[0].split(' of ')[0])}` : '<span style="color:var(--dim)">not yet</span>'}</td><td>${n} / ${acts.length}</td></tr>`;
      }).join('')}</table><p style="color:var(--dim)">Later technologies (electricity, chemistry, machines, computing, spaceflight) belong to later phases and are intentionally absent until the underlying systems exist.</p>`;
    }
    this.el('almanac').innerHTML = `<button class="x" data-act="closealmanac">×</button><div class="tabs">${tabs.map((t) => `<button class="btn ${t === this.tab ? 'on' : ''}" style="${t === this.tab ? 'background:rgba(155,208,255,.18)' : ''}" data-tab="${t}">${cap(t)}</button>`).join('')}</div><div class="body">${body}</div>`;
  }

  // ---------------------------------------------------------------- developer dashboard
  private renderDev() {
    const { world: w, engine: e } = this.ctx;
    const t = w.eco.totals();
    const sets = w.activeSettlements();
    const cities = sets.filter((s) => s.stage === 'city' || s.stage === 'town').length;
    const c = w.history.counts;
    const active = [...w.bands.values()].length;
    const causes = Object.entries(w.stats.causes).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k} ${v}`).join(', ');
    const rows: [string, string][] = [
      ['SIMULATION YEAR', yearOf(w.day).toLocaleString()],
      ['POPULATION', num(w.alive.length)], ['ANIMALS', num(t.animals)], ['SPECIES', `${t.species} living / ${w.eco.species.length} ever`],
      ['CIVILIZATIONS', `${w.livingCivs().length} living / ${w.civs.length} ever`], ['CITIES (town+)', String(cities)],
      ['SETTLEMENTS', String(sets.length)], ['LANGUAGES', String(w.langs.list.length)], ['CULTURES', String(w.cultures.list.length)],
      ['TECHNOLOGIES', `${w.techCount()} / ${TECH_IDS.length}`], ['WARS / BATTLES', String(c['BATTLE'] ?? 0)],
      ['DISCOVERIES', String((c['TECHNOLOGY_DISCOVERY'] ?? 0) + (c['DISCOVERY'] ?? 0))], ['ACTIVE EVENTS', `${active} bands, ${sets.filter((s) => s.diseaseUntil > w.day).length} epidemics, ${sets.filter((s) => s.stress > 0.6).length} famines`],
      ['BIRTHS / DEATHS', `${num(w.stats.births)} / ${num(w.stats.deaths)}`], ['SIM RATE', `${fmtRate(e.effective)} · ${e.stepMs.toFixed(1)} ms/frame`], ['FPS', this.ctx.fps().toFixed(0)],
    ];
    const html = `<div class="g">${rows.map(([k, v]) => `<span class="k">${k}</span><span>${esc(v)}</span>`).join('')}</div>
      <h4>DEATHS BY CAUSE</h4><div class="k">${esc(causes)}</div>
      <h4>DETERMINISM</h4><div class="k">seed "${esc(w.seedText)}" → ${w.seed} · rng ${w.rng.state}</div>
      <div style="margin:4px 0"><button class="btn" data-act="replaycheck" style="padding:2px 8px">replay check</button> <button class="btn" data-act="exportsave" style="padding:2px 8px">export save</button></div><div class="k">${esc(this.determinism)}</div>
      <h4>INSPECT</h4><input id="insp" placeholder="person id…" style="width:100%;background:rgba(255,255,255,.06);border:1px solid var(--line);color:inherit;border-radius:6px;padding:3px 6px" />
      <h4>LOG</h4><div class="log">${this.devLog.slice(-40).reverse().map((l) => `<div title="${esc(l)}">${esc(l)}</div>`).join('')}</div>`;
    const dev = this.el('dev');
    const focused = document.activeElement?.id === 'insp';
    if (!focused) dev.innerHTML = html;
  }

  runDeterminism() {
    const { world: w } = this.ctx;
    this.determinism = 'running…';
    setTimeout(() => {
      try {
        const copy = deserialize(serialize(w));
        // advance a clone and a second clone from the same snapshot; identical inputs must give identical histories
        const copy2 = deserialize(serialize(w));
        for (let i = 0; i < 200; i++) { copy.step(7); copy2.step(7); }
        const same = copy.alive.length === copy2.alive.length && copy.stats.births === copy2.stats.births && copy.history.nextId === copy2.history.nextId && copy.rng.state === copy2.rng.state;
        this.determinism = same ? `✓ replay identical after 200 ticks (pop ${copy.alive.length}, rng ${copy.rng.state})` : '✗ replays diverged!';
      } catch (err) { this.determinism = 'error: ' + String(err); }
    }, 30);
  }

  // ---------------------------------------------------------------- input
  private delegate(e: MouseEvent) {
    const t = (e.target as HTMLElement).closest('[data-person],[data-settlement],[data-civ],[data-culture],[data-species],[data-act],[data-speed],[data-jump],[data-tab],[data-chron],[data-evt]') as HTMLElement | null;
    if (!t) return;
    const { engine, view, world: w } = this.ctx;
    const d = t.dataset;
    if (d.speed !== undefined) { engine.cancelJump(); engine.setSpeed(Number(d.speed)); return; }
    if (d.jump) { engine.jump(Number(d.jump), `Jumping ${d.jump} year${d.jump === '1' ? '' : 's'} forward`); this.el('jump').classList.remove('open'); return; }
    if (d.tab) { this.tab = d.tab; this.renderAlmanac(); return; }
    if (d.chron) { if (this.chronFilter.has(d.chron)) this.chronFilter.delete(d.chron); else this.chronFilter.add(d.chron); this.renderAlmanac(); return; }
    if (d.evt) { const ev = w.history.events.find((x) => x.id === Number(d.evt)); if (ev) { this.closeAlmanac(); this.focusEvent(ev); } return; }
    if (d.act) {
      switch (d.act) {
        case 'jump': this.el('jump').classList.toggle('open'); return;
        case 'politics': view.planet.politics = !view.planet.politics; view.planet.updateColors(); return;
        case 'almanac': this.openAlmanac(); return;
        case 'closealmanac': this.closeAlmanac(); return;
        case 'dev': this.el('dev').classList.toggle('open'); return;
        case 'save': this.ctx.save().then(() => this.toast('Universe saved.')); return;
        case 'new': { const s = prompt('Seed for the new universe (leave blank for a random one):', ''); if (s !== null) this.ctx.newUniverse(s.trim()); return; }
        case 'close': this.clearSelection(); return;
        case 'canceljump': engine.cancelJump(); return;
        case 'copyseed': {
          const url = `${location.origin}${location.pathname}#seed=${encodeURIComponent(w.seedText)}`;
          navigator.clipboard?.writeText(url).then(() => this.toast('Share link copied. Same seed, same initial universe.'), () => prompt('Share this link:', url));
          return;
        }
        case 'follow': if (d.person) { this.select('person', Number(d.person), true); } return;
        case 'follow-settlement': view.setFollow({ kind: 'settlement', id: Number(d.settlement) }, 40); return;
        case 'follow-civ': view.setFollow({ kind: 'civ', id: Number(d.civ) }, 1400); return;
        case 'familyline': this.followFamily = !this.followFamily; this.lastPanelHtml = ''; this.renderPanel(); return;
        case 'replaycheck': this.runDeterminism(); return;
        case 'exportsave': { const blob = new Blob([serialize(w)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `pocket-dimension-${w.seedText}-y${yearOf(w.day)}.json`; a.click(); return; }
      }
      return;
    }
    if (d.person) { this.closeAlmanac(); this.select('person', Number(d.person), true); return; }
    if (d.settlement) { this.closeAlmanac(); this.select('settlement', Number(d.settlement), true); return; }
    if (d.civ) { this.closeAlmanac(); this.select('civ', Number(d.civ), true); return; }
    if (d.culture) { this.select('culture', Number(d.culture)); return; }
    if (d.species) { this.select('species', Number(d.species)); return; }
  }

  private key(e: KeyboardEvent) {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT') {
      if (e.key === 'Enter' && (e.target as HTMLInputElement).id === 'insp') {
        const id = Number((e.target as HTMLInputElement).value);
        if (this.ctx.world.people.has(id)) this.select('person', id, true);
      }
      return;
    }
    const { engine, view } = this.ctx;
    if (e.key === ' ') { e.preventDefault(); engine.setSpeed(engine.paused ? this.lastSpeed || SPEED.x100 : (this.lastSpeed = engine.speedIdx, 0)); }
    else if (e.key === '[') engine.setSpeed(Math.max(1, engine.speedIdx - 1));
    else if (e.key === ']') engine.setSpeed(engine.speedIdx + 1);
    else if (e.key === 'p' || e.key === 'P') { view.planet.politics = !view.planet.politics; view.planet.updateColors(); }
    else if (e.key === 'h' || e.key === 'H') { this.helpHidden = !this.helpHidden; document.getElementById('ui')!.classList.toggle('hidden', this.helpHidden); }
    else if (e.key === '`') this.el('dev').classList.toggle('open');
    else if (e.key === 'Escape') { this.clearSelection(); this.closeAlmanac(); view.setFollow(null); }
    else if (e.key === 'l' || e.key === 'L') this.openAlmanac('chronicle');
    else if (/^[1-9]$/.test(e.key) || (e.shiftKey && /^Digit[1-9]$/.test(e.code))) {
      const n = e.shiftKey ? Number(e.code.slice(5)) : Number(e.key);
      if (e.shiftKey) { this.bookmarks[n - 1] = view.currentBookmark('Bookmark ' + n); localStorage.setItem('pd-bm-' + this.ctx.world.seedText, JSON.stringify(this.bookmarks)); this.toast(`Camera bookmark ${n} saved`); }
      else if (this.bookmarks[n - 1]) view.gotoBookmark(this.bookmarks[n - 1]);
    }
  }
  private lastSpeed = 4;
}

function fmtRate(daysPerSec: number): string {
  if (daysPerSec < 1) return `${daysPerSec.toFixed(2)} d/s`;
  if (daysPerSec < 180) return `${daysPerSec.toFixed(0)} days/s`;
  return `${(daysPerSec / 360).toFixed(1)} yr/s`;
}
void W; void H;

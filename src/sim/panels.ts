import type { World } from './world';
import { BIOME_NAMES } from './planet';
import { NEEDS, PERSONALITY, SKILLS, Person } from './people';
import { VALUE_KEYS } from './culture';
import { TECHS, TECH_IDS } from './technology';
import { clockText, formatYear, yearOf, DAYS_PER_YEAR } from './time';
import { BDEFS, RES_KEYS } from './buildings';
import { GROW_DAYS } from './jobs';
import { H, W, cellLat, distKm, idx, wrapX, R_KM } from './grid';
import { cellOf } from './behavior';
import type { SimEvent, EventType } from './events';
import { describeGrammar, sampleSentences } from './languages';
import { roleName } from './marine';
import { AU_KM, MOON, orbitMinutes } from './space';
import { wallFactor } from './diplomacy';
import { military } from './techfx';

/**
 * The words and tables of the observer's panels, written where the world lives (the simulation worker), so the interface
 * only ever receives finished HTML. Reading never changes the world.
 */
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const bar10 = (v: number) => {
  const n = Math.round(Math.max(0, Math.min(1, v)) * 10);
  return '█'.repeat(n) + '░'.repeat(10 - n);
};
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const num = (n: number) => Math.round(n).toLocaleString('en-US');
const dim = (s: string) => `<span style="color:var(--dim)">${s}</span>`;

export class Panels {
  constructor(private w: World) {}

  private link(kind: string, id: number, text: string) {
    return `<a class="l" data-${kind}="${id}">${esc(text)}</a>`;
  }
  private pname(id: number) {
    const q = this.w.people.get(id);
    return q ? this.link('person', id, q.name) : dim('unknown');
  }
  private barRow(label: string, v: number) {
    return `<div class="bar"><span>${label}</span><i><b style="width:${Math.round(Math.max(0, Math.min(1, v)) * 100)}%"></b></i><em>${Math.round(v * 10)}/10</em></div>`;
  }
  private lat(y: number) {
    const l = (cellLat(Math.min(H - 1, Math.max(0, Math.floor(y)))) * 180) / Math.PI;
    return `${Math.abs(l).toFixed(0)}°${l >= 0 ? 'N' : 'S'}`;
  }
  private lon(x: number) {
    const l = (x / W) * 360 - 180;
    return `${Math.abs(l).toFixed(0)}°${l >= 0 ? 'E' : 'W'}`;
  }
  private nearest(x: number, y: number) {
    let best: { name: string; d: number; id: number } | null = null;
    for (const s of this.w.activeSettlements()) {
      const d = distKm(x, y, s.x, s.y);
      if (!best || d < best.d) best = { name: s.name, d, id: s.id };
    }
    return best;
  }
  private eventList(events: SimEvent[]) {
    if (!events.length) return dim('Nothing recorded yet.');
    return events.map((e) => `<div class="hist"><div class="y">${formatYear(e.day)}</div><div class="t">${esc(e.text.split('\n')[0])}</div></div>`).join('');
  }
  /** Weather right now at a place, as a person standing there would feel it. */
  private weatherHere(x: number, y: number): string {
    const w = this.w;
    const wx = w.weather;
    const T = wx.airTemp(x, y, w.day);
    const rain = wx.at('precip', x, y);
    const cloud = wx.at('cloud', x, y);
    const u = wx.at('u', x, y), v = wx.at('v', x, y);
    const ws = Math.hypot(u, v);
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    const from = dirs[Math.round(((Math.atan2(-u, -v) * 180) / Math.PI + 360) % 360 / 45) % 8];
    const i = idx(wrapX(Math.floor(x)), Math.max(0, Math.min(H - 1, Math.floor(y))));
    const snow = w.env.snow[i];
    const sky = rain > 12 ? (T < 0 ? 'heavy snow' : wx.lightning[Math.floor(y / 2) * 128 + Math.floor(x / 2)] > 0 ? 'thunderstorm' : 'heavy rain') : rain > 2 ? (T < 0 ? 'snow' : 'rain') : rain > 0.4 ? (T < 0 ? 'flurries' : 'drizzle') : cloud > 0.75 ? 'overcast' : cloud > 0.4 ? 'partly cloudy' : 'clear';
    const storm = wx.storms.find((s) => Math.hypot(((s.x * 2 - x + W * 1.5) % W) - W / 2, s.y * 2 - y) < s.radius * 2 * 2.2);
    return `${T.toFixed(0)}°C · ${sky} · wind ${ws.toFixed(0)} m/s from the ${from}${snow > 20 ? ` · snow on the ground ${(snow / 3).toFixed(0)} cm` : ''}${storm ? ` · <span class="neg">${storm.tropical && storm.depth > 25 ? 'hurricane ' + esc(storm.name) : 'storm'} nearby</span>` : ''}`;
  }

  goalText(p: Person): string {
    const w = this.w;
    const s = p.home ? w.settlements[p.home - 1] : undefined;
    const band = p.band ? w.bands.get(p.band) : undefined;
    const carry = p.cargoAmt > 0.5 ? ` Carrying ${Math.round(p.cargoAmt)} ${p.cargo === 'food' ? 'food' : p.cargo}.` : '';
    switch (p.goal) {
      case 'rest': return `Sleeping${p.house ? ' in their house' : w.planet.cave[cellOf(p)] ? ' in a cave' : ' under the stars'}${s ? ' in ' + s.name : ''}.`;
      case 'drink': return 'Searching for water';
      case 'eat': return 'Searching for food';
      case 'socialize': return `Spending time with others${s ? ' in ' + s.name : ''}`;
      case 'explore': return 'Exploring beyond the known lands';
      case 'migrate': return band ? `Travelling with ${band.members.length} others toward new land (${band.note})` : 'Travelling';
      case 'raid': return 'Raiding with a band of outcasts';
      case 'attack': return band && band.returning ? 'Marching home from the war.' : band?.siege !== undefined ? `Besieging a town (day ${Math.round(w.day - band.siege)} of the siege).` : 'Marching to war.';
      case 'wander': return p.occupation === 'hermit' ? 'Living alone, apart from society' : band ? `Wandering with ${band.members.length - 1} followers (${band.note})` : 'Wandering alone';
      default: {
        const nodeName = () => { const n = p.tcell >= 0 ? w.res.nodes(p.tcell)[p.tslot] : undefined; return n ? n.kind : 'a resource'; };
        const ph = p.phase === 1 ? 'Walking out to' : p.phase === 3 ? 'Hauling home from' : 'Working at';
        switch (p.task) {
          case 'chop': return `${ph} a grove to fell trees.${carry}`;
          case 'quarry': return `${ph} the quarry for stone.${carry}`;
          case 'mine': return `${ph} the ${nodeName()} diggings.${carry}`;
          case 'clay': return `${ph} the clay pit.${carry}`;
          case 'berry': return `${ph} the berry bushes.${carry}`;
          case 'fish': return `${ph} the fishing waters.${carry}`;
          case 'hunt': return p.phase === 1 ? 'Stalking game.' : p.phase === 2 ? 'Closing in on an animal.' : `Carrying the kill home.${carry}`;
          case 'field': return p.tslot === 3 ? 'Harvesting a field.' : p.tslot === 2 ? 'Weeding a field.' : 'Planting a field.';
          case 'build': { const b = w.buildings.get(p.tb); return `Building a ${b ? BDEFS[b.kind].name.toLowerCase() : 'structure'}${b ? ` (${Math.round(b.progress * 100)}%)` : ''}.`; }
          case 'craft': return 'Crafting goods at the workshop.';
          case 'trade': { const o = w.settlements[p.tb - 1]; return p.phase === 3 ? `Returning from ${o?.name ?? 'afar'} with ${p.cargoAmt > 0.5 ? Math.round(p.cargoAmt) + ' ' + p.cargo : 'little'}.` : `Leading a caravan to ${o?.name ?? 'a distant town'} with ${Math.round(p.cargoAmt)} ${p.cargo}.`; }
          case 'prospect': return 'Prospecting the hills for ore and clay.';
        }
        if (p.occupation === 'farmer') return `Tending fields near ${s?.name ?? 'home'}`;
        if (p.occupation === 'hunter') return 'Hunting game';
        if (p.occupation === 'forager') return 'Gathering wild food';
        if (p.occupation === 'leader') return `Leading ${s?.name ?? 'the community'}`;
        if (p.occupation === 'child') return 'Growing up';
        return `Working as a ${p.occupation}`;
      }
    }
  }

  private descTree(id: number, prefix: string, depth: number, out: string[], isRoot = false) {
    const w = this.w;
    const p = w.people.get(id);
    if (!p) return;
    if (isRoot) out.push(`${this.pname(id)}${p.alive ? '' : ' †'}`);
    const kids = p.children.map((c) => w.people.get(c)).filter((c): c is Person => !!c);
    kids.forEach((k, i) => {
      const last = i === kids.length - 1;
      out.push(`${prefix}${last ? '└── ' : '├── '}${this.pname(k.id)}${k.alive ? '' : ' †'} ${dim(String(yearOf(k.birth)))}`);
      if (depth > 1) this.descTree(k.id, prefix + (last ? '    ' : '│   '), depth - 1, out);
    });
  }

  panel(kind: string, id: number, extra: number | undefined, following: boolean, family: boolean): string {
    switch (kind) {
      case 'person': return this.person(id, following, family);
      case 'settlement': return this.settlement(id);
      case 'civ': return this.civ(id);
      case 'species': return this.species(id);
      case 'culture': return this.culture(id);
      case 'node': return this.node(id, extra ?? 0);
      case 'building': return this.building(id);
      case 'marine': return this.marine(id);
      case 'body': return this.body(id);
    }
    return '<h2>Unknown</h2>';
  }

  person(id: number, following: boolean, family: boolean): string {
    const w = this.w;
    const p = w.people.get(id);
    if (!p) return '<h2>Unknown</h2>';
    const sp = w.eco.speciesById(p.species);
    const cul = w.cultures.get(p.culture);
    const lang = cul ? w.langs.get(cul.language) : undefined;
    const s = p.home ? w.settlements[p.home - 1] : undefined;
    const nb = this.nearest(p.x, p.y);
    const age = Math.floor(p.ageYears(w.day));
    const biome = BIOME_NAMES[w.planet.biome[cellOf(p)]];
    const parts: string[] = [];
    parts.push(`<h2>${esc(p.name)}${p.legend ? ' <span title="Legend" style="color:var(--warm)">✦</span>' : ''}</h2>`);
    const lordOf = w.settlements.find((x) => x.lord === p.id && x.abandoned < 0);
    const rules = w.civs.find((c) => c.leader === p.id && c.collapsed < 0);
    parts.push(`<div style="color:var(--dim);margin-bottom:8px">${p.alive ? '' : `<span class="neg">Died in ${formatYear(p.death)} of ${esc(p.deathCause)} · </span>`}${cap(p.occupation)}${s ? ' of ' + this.link('settlement', s.id, s.name) : ''}${rules ? ` · ruler of the ${this.link('civ', rules.id, rules.name)}` : ''}${lordOf ? ` · lord of ${this.link('settlement', lordOf.id, lordOf.name)}` : ''}</div>`);
    parts.push(`<div class="kv"><span>Age</span><span>${age} · ${p.sex ? 'female' : 'male'}${p.pregnantUntil >= 0 ? ' · expecting' : ''} · born ${yearOf(p.birth).toLocaleString()}</span>
      <span>Species</span><span>${esc(sp?.name ?? '?')}</span><span>Culture</span><span>${cul ? this.link('culture', cul.id, 'The ' + cul.name) : '—'}${lang ? ` · speaks ${esc(lang.name)}` : ''}</span>
      <span>Speaks</span><span>${esc(w.langs.get(p.tongue)?.name ?? '—')}${[...p.fluency].filter(([, f]) => f > 0.15).map(([lid, f]) => `, ${esc(w.langs.get(lid)?.name ?? '?')} (${f > 0.7 ? 'fluent' : f > 0.4 ? 'conversational' : 'a few words'})`).join('')}</span>
      <span>Local time</span><span>${clockText(w.day, p.x)}</span>
      <span>Weather</span><span>${this.weatherHere(p.x, p.y)}</span>
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
    parts.push(mems.length ? mems.map((mm) => `<div class="mem"><span class="yr">${yearOf(mm.day).toLocaleString()}</span> <span class="${mm.valence >= 0 ? 'pos' : 'neg'}">${mm.valence >= 0 ? '＋' : '－'}</span> ${esc(mm.text)}${mm.other && w.people.has(mm.other) ? ' · ' + this.pname(mm.other) : ''}</div>`).join('') : dim('Nothing of note yet.'));
    parts.push('<h3>Relationships</h3>');
    const rels = [...p.relations].filter(([oid]) => w.people.has(oid)).sort((a, b) => Math.abs(b[1].affinity) - Math.abs(a[1].affinity)).slice(0, 7);
    parts.push(rels.length ? rels.map(([oid, r]) => `<div>${this.pname(oid)} ${dim(r.kind)} <span class="${r.affinity >= 0 ? 'pos' : 'neg'}">${r.affinity >= 0 ? '+' : ''}${r.affinity.toFixed(2)}</span></div>`).join('') : dim('No close ties.'));
    parts.push('<h3>Skills</h3>');
    SKILLS.forEach((sk, i) => parts.push(this.barRow(cap(sk), Math.min(1, p.skills[i]))));
    if (cul) {
      parts.push('<h3>Beliefs</h3>');
      VALUE_KEYS.forEach((k, i) => parts.push(this.barRow(cap(k), p.beliefs[i])));
    }
    parts.push(`<div class="row">${p.alive ? `<button class="btn" data-act="follow" data-person="${id}">${following ? 'Following ✓' : 'Follow'}</button>` : ''}<button class="btn" data-act="familyline">${family ? 'Follow descendants ✓' : 'Follow descendants'}</button>${s ? `<button class="btn" data-settlement="${s.id}">Settlement</button>` : ''}${s ? `<button class="btn" data-civ="${s.civ}">Civilization</button>` : ''}</div>`);
    return parts.join('');
  }

  settlement(id: number): string {
    const w = this.w;
    const s = w.settlements[id - 1];
    if (!s) return '<h2>Unknown</h2>';
    const cul = w.cultures.get(s.culture);
    const lang = cul ? w.langs.get(cul.language) : undefined;
    const civ = w.civs[s.civ - 1];
    const leader = s.leader ? w.people.get(s.leader) : undefined;
    const founder = s.founder ? w.people.get(s.founder) : undefined;
    const lord = s.lord ? w.people.get(s.lord) : undefined;
    const ci = idx(wrapX(Math.floor(s.x)), Math.floor(s.y));
    const parts: string[] = [];
    parts.push(`<h2>${esc(s.name)}</h2><div style="color:var(--dim)">${cap(s.stage)}${s.nomadic ? ' · nomadic' : ''}${civ && civ.capital === s.id ? ' · capital' : ''}${s.abandoned >= 0 ? ` · abandoned in ${formatYear(s.abandoned)}` : ''}</div>`);
    parts.push(`<div class="kv" style="margin-top:8px"><span>Population</span><span>${num(s.pop)} ${dim(`(peak ${num(s.peak)})`)}</span>
      <span>Founded</span><span>${formatYear(s.founded)}${founder ? ' by ' + this.pname(founder.id) : ''}</span>
      <span>Culture</span><span>${cul ? this.link('culture', cul.id, 'The ' + cul.name) : '—'}</span><span>Language</span><span>${esc(lang?.name ?? '—')}</span>
      <span>Leader</span><span>${leader ? this.pname(leader.id) : '—'}</span><span>Civilization</span><span>${civ ? this.link('civ', civ.id, 'The ' + civ.name) : '—'}</span>
      ${lord ? `<span>Lord</span><span>${this.pname(lord.id)} · loyalty ${Math.round(s.loyalty * 100)}%</span>` : ''}
      <span>Weather</span><span>${this.weatherHere(s.x, s.y)}</span>
      <span>Soil</span><span>${Math.round(w.env.soil[ci] * 100)}% moist${w.env.burned[ci] > 0.3 ? ' · <span class="neg">burned land</span>' : ''}${w.planet.cave[ci] ? ' · caves nearby' : ''}</span>
      <span>Location</span><span>${this.lat(s.y)} ${this.lon(s.x)} · ${esc(BIOME_NAMES[w.planet.biome[ci]])}</span></div>`);
    parts.push('<h3>Condition</h3>');
    parts.push(this.barRow('Food stress', s.stress) + this.barRow('Cohesion', s.cohesion) + this.barRow('Threat', s.threat));
    parts.push(`<div style="color:var(--dim);margin-top:4px">Food store ${num(s.food)} · goods ${num(s.goods)} · housing ${num(s.housing)}${s.diseaseUntil > w.day ? ' · <span class="neg">epidemic</span>' : ''}</div>`);
    const blds: Record<string, number> = {};
    let under = 0;
    for (const b of w.buildings.of(s.id)) { if (b.done >= 0) blds[b.kind] = (blds[b.kind] ?? 0) + 1; else if (b.progress < 1) under++; }
    const tools = ['bare hands', 'stone tools', 'bronze tools', 'iron tools'][s.toolTier] ?? 'tools';
    parts.push('<h3>Stockpile</h3>' + `<div class="kv"><span>Food</span><span>${num(s.food)}</span>${RES_KEYS.map((k) => `<span>${k}</span><span>${num(s.res[k])}</span>`).join('')}<span>Goods</span><span>${num(s.goods)}</span><span>Wealth</span><span>${num(s.wealth)}</span><span>Tools</span><span>${tools}</span><span>Gathers within</span><span>${s.range.toFixed(0)} km</span>${s.ships >= 0.5 ? `<span>Ships</span><span>${Math.round(s.ships)}</span>` : ''}</div>`);
    parts.push('<h3>Needs</h3>' + (['wood', 'stone', 'clay', 'ore', 'coal'].filter((k) => (s.need[k] ?? 0) > 0.02).map((k) => this.barRow(cap(k), s.need[k])).join('') || dim('Nothing pressing.')));
    parts.push('<h3>Buildings</h3>' + (Object.entries(blds).map(([k, v]) => `<span class="chip on">${v} ${BDEFS[k as keyof typeof BDEFS].name.toLowerCase()}${v > 1 && !k.endsWith('s') ? 's' : ''}</span>`).join('') || dim('Nothing built yet — they sleep in the open.')) + (under ? ` <span class="chip">${under} being built</span>` : '') + `<div style="color:var(--dim)">Housing ${s.housing} for ${s.pop} people${wallFactor(w, s) > 1 ? ` · walls multiply its defenders ×${wallFactor(w, s).toFixed(1)}` : ''}</div>`);
    parts.push('<h3>Technology</h3>' + ([...s.tech].map((t) => `<span class="chip on">${esc(TECHS[t].name)}</span>`).join('') || dim('None yet.')));
    parts.push('<h3>Occupations</h3>' + Object.entries(s.occupations).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<span class="chip">${esc(k)} ${v}</span>`).join(''));
    if (w.planet.coastDist[ci] <= 1) parts.push(`<h3>Sea</h3><div style="color:var(--dim)">Fishing grounds ${Math.round(w.marine.fishery(s.x, s.y) * 100)}% of their natural richness${s.ships >= 1 ? ` · a fleet of ${Math.round(s.ships)} ship${s.ships >= 1.5 ? 's' : ''}` : ''}</div>`);
    const routes = w.space.routes.filter((r) => r.a === id || r.b === id);
    if (routes.length) parts.push('<h3>Routes</h3>' + routes.slice(0, 8).map((r) => { const o = w.settlements[(r.a === id ? r.b : r.a) - 1]; return `<div>${r.kind === 'air' ? '✈' : '⚓'} ${o ? this.link('settlement', o.id, o.name) : '?'} ${dim(`${Math.round(r.km)} km`)}</div>`; }).join(''));
    parts.push(`<h3>Origin</h3><div style="color:var(--dim)">${esc(s.originNote)}</div>`);
    parts.push('<h3>History</h3>' + this.eventList(w.history.query({ settlement: id, minWeight: 1, limit: 8 })));
    parts.push(`<div class="row"><button class="btn" data-act="follow-settlement" data-settlement="${id}">Follow</button>${civ ? `<button class="btn" data-civ="${civ.id}">Civilization</button>` : ''}</div>`);
    return parts.join('');
  }

  private langTree(highlight: number): string {
    const w = this.w;
    const kids = new Map<number, number[]>();
    for (const l of w.langs.list) { const a = kids.get(l.parent) ?? []; a.push(l.id); kids.set(l.parent, a); }
    const out: string[] = [];
    const walk = (parent: number, prefix: string) => {
      const ch = kids.get(parent) ?? [];
      ch.forEach((lid, i) => {
        const l = w.langs.get(lid)!;
        const last = i === ch.length - 1;
        out.push(`${prefix}${last ? '└── ' : '├── '}${lid === highlight ? `<b style="color:var(--warm)">${esc(l.name)}</b>` : esc(l.name)}${l.writing !== 'none' ? ' ✎' : ''}${l.pidgin ? ' ⇄' : ''}`);
        walk(lid, prefix + (last ? '    ' : '│   '));
      });
    };
    out.push('Proto-Language');
    walk(0, '');
    return out.join('\n');
  }

  civ(id: number): string {
    const w = this.w;
    const civ = w.civs[id - 1];
    if (!civ) return '<h2>Unknown</h2>';
    const members = civ.members.map((i) => w.settlements[i - 1]).filter((s) => s && s.abandoned < 0);
    const cul = w.cultures.get(civ.culture);
    const lang = cul ? w.langs.get(cul.language) : undefined;
    const leader = civ.leader ? w.people.get(civ.leader) : undefined;
    const techs = new Set<string>();
    for (const s of members) for (const t of s.tech) techs.add(t);
    let warriors = 0, def = 0, food = 0, goods = 0, ships = 0;
    for (const s of members) { warriors += s.occupations['warrior'] ?? 0; def += s.defense; food += s.food; goods += s.goods; ships += s.ships; }
    const capS = w.settlements[civ.capital - 1];
    const parts: string[] = [];
    parts.push(`<h2>The ${esc(civ.name)}</h2><div style="color:var(--dim)">${cap(civ.rank)} · ${esc(civ.government)}${civ.collapsed >= 0 ? ` · <span class="neg">fell in ${formatYear(civ.collapsed)}</span>` : ''}</div>`);
    parts.push(`<h3>Civilization</h3><div class="kv"><span>Population</span><span>${num(civ.pop)}</span><span>Territory</span><span>≈ ${num(civ.territory)} km²</span>
      <span>Capital</span><span>${capS ? this.link('settlement', capS.id, capS.name) : '—'}</span>
      <span>Cities</span><span>${members.length ? [...members].sort((a, b) => b.pop - a.pop).slice(0, 8).map((s) => `${this.link('settlement', s.id, s.name)} ${dim(String(s.pop))}`).join(', ') + (members.length > 8 ? ` +${members.length - 8}` : '') : '—'}</span>
      <span>Culture</span><span>${cul ? this.link('culture', cul.id, 'The ' + cul.name) : '—'}</span><span>Language</span><span>${esc(lang?.name ?? '—')}${lang && lang.writing !== 'none' ? ' · ' + lang.writing + ' script ✎' : ''}</span>
      <span>Government</span><span>${esc(civ.government)} · legitimacy ${civ.legitimacy.toFixed(2)}</span><span>Leader</span><span>${leader ? this.pname(leader.id) : '—'}</span>
      <span>Military</span><span>${warriors} warriors · strength ×${military(capS).toFixed(1)} · defence ${(def * 100).toFixed(0)}${ships >= 1 ? ` · navy of ${Math.round(ships)} ships` : ''}</span><span>Economy</span><span>food ${num(food)} · goods ${num(goods)}</span><span>Founded</span><span>${formatYear(civ.founded)}</span></div>`);
    const vassals = members.filter((s) => s.lord && w.people.get(s.lord)?.alive);
    if (vassals.length) parts.push('<h3>Lords</h3>' + vassals.slice(0, 10).map((s) => `<div>${this.pname(s.lord)} ${dim('of')} ${this.link('settlement', s.id, s.name)} <span class="${s.loyalty > 0.5 ? 'pos' : s.loyalty < 0.25 ? 'neg' : ''}">loyalty ${Math.round(s.loyalty * 100)}%</span></div>`).join(''));
    parts.push('<h3>Technology</h3>' + ([...techs].map((t) => `<span class="chip on">${esc(TECHS[t as keyof typeof TECHS].name)}</span>`).join('') || dim('None yet.')));
    const prog = w.space.programs.get(id);
    if (prog) {
      const sats = w.space.satellites.filter((s) => s.civ === id);
      parts.push(`<h3>Space program</h3><div class="kv"><span>Launches</span><span>${prog.launches} (${prog.failures} failed)</span><span>In orbit</span><span>${sats.length} ${sats.some((s) => s.kind === 'station') ? '· a space station' : ''}</span><span>First satellite</span><span>${prog.firstSatellite >= 0 ? formatYear(prog.firstSatellite) : '—'}</span><span>Crewed flights</span><span>${prog.crewed}</span><span>Moon landing</span><span>${prog.moonLanding >= 0 && prog.moonLanding <= w.day ? formatYear(prog.moonLanding) : '—'}</span></div>`);
    }
    if (lang) parts.push(`<h3>Language family</h3><pre class="tree">${this.langTree(lang.id)}</pre>`);
    parts.push('<h3>History</h3>' + this.eventList(w.history.query({ civ: id, minWeight: 1, limit: 10 })));
    parts.push('<h3>Origin</h3><div style="color:var(--dim)">' + esc(civ.note || '—') + '</div>');
    const rel: { civ: (typeof w.civs)[number]; d: number }[] = [];
    if (capS) for (const o of w.livingCivs()) {
      if (o.id === id) continue;
      const c2 = w.settlements[o.capital - 1];
      if (c2) rel.push({ civ: o, d: distKm(capS.x, capS.y, c2.x, c2.y) });
    }
    rel.sort((a, b) => a.d - b.d);
    parts.push('<h3>Relations</h3>' + (rel.length ? rel.slice(0, 6).map((r) => {
      const oc = w.cultures.get(r.civ.culture);
      const cd = cul && oc ? w.cultures.distance(cul, oc) : 0;
      const dr = w.diplomacy.rel.get(`${Math.min(id, r.civ.id)}:${Math.max(id, r.civ.id)}`);
      const mood = dr ? (dr.war ? '<span class="neg">AT WAR</span>' : dr.tension > 0.6 ? '<span class="neg">hostile</span>' : dr.trade > 0.5 ? '<span class="pos">trading partners</span>' : dr.tension > 0.35 ? 'wary' : 'calm') + ` (tension ${dr.tension.toFixed(2)})` : 'no dealings';
      return `<div>${this.link('civ', r.civ.id, 'The ' + r.civ.name)} ${dim(`${Math.round(r.d)} km · ${cd < 0.25 ? 'kindred' : cd < 0.5 ? 'distinct' : 'foreign'} culture · pop ${num(r.civ.pop)} · `)}${mood}</div>`;
    }).join('') : dim('No contact.')));
    parts.push(`<div class="row"><button class="btn" data-act="follow-civ" data-civ="${id}">Follow</button></div>`);
    return parts.join('');
  }

  culture(id: number): string {
    const w = this.w;
    const c = w.cultures.get(id);
    if (!c) return '<h2>Unknown</h2>';
    const lang = w.langs.get(c.language);
    const parent = c.parent ? w.cultures.get(c.parent) : undefined;
    const parts: string[] = [`<h2>The ${esc(c.name)} ${esc(c.symbol)}</h2><div style="color:var(--dim)">${esc(c.origin)}</div>`];
    parts.push(`<div class="kv" style="margin-top:8px"><span>Emerged</span><span>${formatYear(c.born)}</span><span>Ancestor</span><span>${parent ? this.link('culture', parent.id, 'The ' + parent.name) : 'none (first people)'}</span><span>Language</span><span>${esc(lang?.name ?? '—')}</span>
      <span>Vocabulary</span><span>~${num(lang?.vocabulary ?? 0)} words</span><span>Writing</span><span>${lang?.writing ?? 'none'}</span></div>`);
    parts.push('<h3>Values</h3>' + VALUE_KEYS.map((k, i) => this.barRow(cap(k), c.values[i])).join(''));
    parts.push('<h3>Traditions</h3><div class="kv">' + Object.entries(c.traditions).map(([k, v]) => `<span>${esc(k)}</span><span>${esc(v)}</span>`).join('') + '</div>');
    if (lang) {
      parts.push(`<h3>Grammar</h3><div style="color:var(--dim)">${esc(describeGrammar(lang))}</div>`);
      parts.push('<h3>In their words</h3>' + sampleSentences(lang).map((s) => `<div class="mem"><b>${esc(s.native)}</b><div style="font:11px ui-monospace,monospace;color:var(--dim)">${esc(s.gloss)}</div><div style="color:var(--dim)">“${esc(s.english)}”</div></div>`).join(''));
      parts.push('<h3>Words</h3><div style="color:var(--dim)">' + Object.entries(lang.lexicon).slice(0, 40).map(([k, v]) => `${esc(k)} <b style="color:var(--ink)">${esc(v)}</b>`).join(' · ') + '</div>' + (lang.shifts.length ? `<div style="color:var(--dim);margin-top:4px">Sound shifts: ${esc(lang.shifts.slice(-8).join(', '))}</div>` : ''));
    }
    const art = w.cavePaintings.filter((p) => p.culture === id);
    if (art.length) parts.push('<h3>Cave art</h3>' + art.slice(-5).map((p) => `<div>${dim(formatYear(p.day))} ${esc(p.subject)}, by ${this.pname(p.artist)}</div>`).join(''));
    parts.push('<h3>History</h3>' + this.eventList(w.history.query({ culture: id, minWeight: 1, limit: 8 })));
    return parts.join('');
  }

  species(id: number): string {
    const w = this.w;
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
      parts.push(`<div style="color:var(--dim)">Prefers ${m('tempOpt').toFixed(0)}°C ± ${m('tol').toFixed(0)} · about ${(m('size') * 0.9).toFixed(1)} m long</div>`);
    }
    if (lineage.length) parts.push('<h3>Ancestry</h3><div style="color:var(--dim)">' + lineage.map(esc).join(' ← ') + '</div>');
    parts.push('<h3>History</h3>' + this.eventList(w.history.events.filter((e) => (e.type === 'SPECIATION' || e.type === 'EXTINCTION') && e.text.includes(sp.name)).slice(-6).reverse()));
    return parts.join('');
  }

  marine(id: number): string {
    const w = this.w;
    const sp = w.marine.species.find((s) => s.id === id);
    if (!sp) return '<h2>Unknown</h2>';
    let total = 0, regions = 0;
    for (const v of sp.pop) if (v > 0.5) { total += v; regions++; }
    const parent = sp.parent ? w.marine.species.find((s) => s.id === sp.parent) : undefined;
    return `<h2>${esc(sp.name)}</h2><div style="color:var(--dim)">${cap(roleName(sp.role))} · ${sp.extinct >= 0 ? `extinct in ${formatYear(sp.extinct)}` : `in ${regions} stretches of sea`}</div>
      <div class="kv" style="margin-top:8px"><span>Size</span><span>${sp.size.toFixed(1)} m</span><span>Water</span><span>${sp.tempOpt.toFixed(0)}°C ± ${sp.tempTol.toFixed(0)}</span><span>Biomass</span><span>${num(total)}</span>
      <span>Origin</span><span>${formatYear(sp.born)}${parent ? ' · diverged from ' + esc(parent.name) : ' · founder lineage'}</span></div>`;
  }

  node(cell: number, slot: number): string {
    const w = this.w;
    const n = w.res.nodes(cell)[slot];
    if (!n) return '<h2>Unknown</h2>';
    const amt = w.res.amount(cell, slot, w.day);
    const reg = Math.floor(Math.floor(n.y) / 4) * 64 + Math.floor(Math.floor(n.x) / 4);
    const names: Record<string, string> = { tree: 'Grove', bush: 'Berry bushes', stone: 'Stone outcrop', clay: 'Clay pit', fish: 'Fishing waters', copper: 'Copper vein', iron: 'Iron vein', coal: 'Coal seam', gold: 'Gold vein' };
    const parts: string[] = [`<h2>${names[n.kind]}</h2><div style="color:var(--dim)">${this.lat(n.y)} ${this.lon(n.x)} · ${esc(BIOME_NAMES[w.planet.biome[cell]])}</div>`];
    const finite = ['stone', 'copper', 'iron', 'coal', 'gold'].includes(n.kind);
    parts.push('<h3>Resource</h3>' + this.barRow(finite ? 'Remaining' : 'Standing', amt / n.max));
    if (n.kind === 'tree') {
      const sp = w.flora.at(reg);
      parts.push(`<div class="kv" style="margin-top:6px"><span>Species</span><span>${esc(sp.name)}</span><span>Trees</span><span>${Math.round(amt)} of ${n.max}</span><span>Wood per tree</span><span>${sp.wood.toFixed(1)}</span>
        <span>Regrows in</span><span>${sp.growYears.toFixed(0)} years (its generation time)</span><span>Hardness</span><span>${Math.round(sp.hardness * 10)}/10</span><span>Ancestor</span><span>${sp.parent ? esc(w.flora.species[sp.parent - 1].name) : 'founder species'}</span></div>`);
    } else parts.push(`<div class="kv" style="margin-top:6px"><span>Amount</span><span>${Math.round(amt)} of ${n.max}</span><span>Renews</span><span>${finite ? 'never — once mined it is gone' : n.kind === 'bush' ? 'each year' : n.kind === 'fish' ? 'as the fish breed (months)' : 'over decades'}</span>${n.kind === 'fish' ? `<span>Fish stocks</span><span>${Math.round(w.marine.fishery(n.x, n.y) * 100)}% of natural</span>` : ''}</div>`);
    const known = ['copper', 'iron', 'coal', 'gold', 'clay'].includes(n.kind) ? [...w.res.known.entries()].filter(([, set]) => set.has(cell * 64 + slot)).map(([sid]) => w.settlements[sid - 1]?.name).filter(Boolean) : null;
    if (known) parts.push(`<h3>Prospected by</h3><div style="color:var(--dim)">${known.length ? esc(known.slice(0, 6).join(', ')) : 'nobody yet'}</div>`);
    return parts.join('');
  }

  building(id: number): string {
    const w = this.w;
    const b = w.buildings.get(id);
    if (!b) return '<h2>Unknown</h2>';
    const def = BDEFS[b.kind];
    const s = w.settlements[b.sid - 1];
    const parts: string[] = [`<h2>${def.name}</h2><div style="color:var(--dim)">${s ? this.link('settlement', s.id, s.name) : ''} · ${b.done >= 0 ? 'built ' + formatYear(b.done) : b.done === -2 ? 'ruined' : `under construction ${Math.round(b.progress * 100)}%`}</div>`];
    if (b.kind === 'field') {
      const state = b.fstate === 0 ? 'fallow, ready for planting' : b.fstate === 2 ? 'ripe — waiting for harvest' : `growing (${Math.round(Math.min(1, (w.day - b.planted) / GROW_DAYS) * 100)}%)`;
      parts.push(`<h3>Crop</h3><div>${state}</div>${this.barRow('Weeds', b.weeds)}${b.fstate === 1 ? this.barRow('Damage', b.crop) : ''}<div style="color:var(--dim)">Frost, drought, floods, storms and fire all mark the crop as it grows.</div>`);
    } else {
      parts.push(`<div class="kv" style="margin-top:8px"><span>Housing</span><span>${def.cap ? `${b.residents} of ${def.cap} residents` : '—'}</span><span>Cost</span><span>${Object.entries(def.cost).map(([k, v]) => `${v} ${k}`).join(', ') || '—'}</span><span>Labour</span><span>${num(def.labor)} person-hours</span></div>`);
      const who = (w.residents.get(b.sid) ?? []).filter((p) => p.house === id).slice(0, 8);
      if (who.length) parts.push('<h3>Residents</h3>' + who.map((p) => this.pname(p.id)).join(', '));
    }
    return parts.join('');
  }

  body(i: number): string {
    const w = this.w;
    if (i === -1) {
      return `<h2>The moon</h2><div class="kv" style="margin-top:8px"><span>Distance</span><span>${num(MOON.distKm)} km</span><span>Radius</span><span>${num(MOON.radiusKm)} km</span><span>Orbit</span><span>${MOON.periodDays} days (phases repeat every ${MOON.synodicDays})</span></div>
        <h3>Visits</h3>${this.eventList(w.history.events.filter((e) => e.text.includes('landed on the moon')).slice(-5))}`;
    }
    const b = w.space.bodies[i];
    if (!b) return '<h2>Unknown</h2>';
    if (b.home) return `<h2>The home world</h2><div class="kv" style="margin-top:8px"><span>Radius</span><span>${num(R_KM)} km</span><span>Orbit</span><span>1 AU · ${DAYS_PER_YEAR} days</span><span>Satellites</span><span>${w.space.satellites.length} artificial</span></div>`;
    const visits = w.history.events.filter((e) => e.type === 'DISCOVERY' && e.text.includes(b.name)).slice(-5);
    return `<h2>${esc(b.name)}</h2><div style="color:var(--dim)">${b.kind === 'gas' ? 'Gas giant' : b.kind === 'ice' ? 'Ice giant' : b.kind === 'lava' ? 'Scorched inner world' : b.kind === 'desert' ? 'Desert world' : 'Rocky world'}${b.rings ? ' with rings' : ''}</div>
      <div class="kv" style="margin-top:8px"><span>Orbit</span><span>${b.a.toFixed(2)} AU (${num(b.a * AU_KM / 1e6)} million km) · e ${b.e.toFixed(2)}</span><span>Year</span><span>${(Math.pow(b.a, 1.5)).toFixed(2)} years</span>
      <span>Radius</span><span>${num(b.radiusKm)} km (${(b.radiusKm / R_KM).toFixed(1)}× home)</span><span>Moons</span><span>${b.moons}</span></div>
      <h3>Exploration</h3>${this.eventList(visits)}`;
  }

  // ---------------------------------------------------------------- almanac
  almanac(tab: string, filters: string[]): string {
    const w = this.w;
    const tabs = ['chronicle', 'peoples', 'wars', 'languages', 'life', 'technology', 'space', 'climate'];
    let body = '';
    if (tab === 'chronicle') {
      const groups: Record<string, EventType[]> = {
        civilization: ['CIVILIZATION_FOUNDING', 'CIVILIZATION_COLLAPSE', 'FOUNDING', 'SUCCESSION', 'REVOLT', 'GROWTH'],
        discovery: ['DISCOVERY', 'TECHNOLOGY_DISCOVERY', 'TRADE'],
        conflict: ['WAR', 'BATTLE', 'INVASION', 'EXILE'],
        life: ['SPECIATION', 'EXTINCTION', 'AWAKENING'],
        people: ['MIGRATION', 'CULTURAL_SPLIT', 'LANGUAGE_SPLIT', 'MARRIAGE', 'BIRTH', 'DEATH', 'LEGEND'],
        nature: ['DISASTER', 'FAMINE', 'DISEASE'],
      };
      const on = new Set(filters);
      const allowed = new Set<EventType>();
      for (const g of on) for (const t of groups[g] ?? []) allowed.add(t);
      const evs = w.history.events.filter((e) => allowed.has(e.type) && e.weight >= 2).slice(-400).reverse();
      body = `<div>${Object.keys(groups).map((g) => `<span class="chip ${on.has(g) ? 'on' : ''}" data-chron="${g}" style="cursor:pointer">${g}</span>`).join('')}</div><div style="margin-top:10px">${evs.map((e) => `<div class="hist"><div class="y">${formatYear(e.day)} · ${e.type.replace(/_/g, ' ')}</div><div class="t">${e.x !== undefined ? `<a class="l" data-evt="${e.id}">${esc(e.text.split('\n')[0])}</a>` : esc(e.text.split('\n')[0])}</div>${e.text.includes('\n') ? `<div class="c">${esc(e.text.split('\n').slice(1).join(' · '))}</div>` : ''}${e.cause ? `<div class="c">because: ${esc(e.cause)}</div>` : ''}</div>`).join('') || dim('History has not begun.')}</div>`;
    } else if (tab === 'peoples') {
      const civs = [...w.civs].filter((c) => c.collapsed < 0).sort((a, b) => b.pop - a.pop);
      const dead = w.civs.filter((c) => c.collapsed >= 0).length;
      body = `<table><tr><th>People</th><th>Rank</th><th>Government</th><th>Population</th><th>Places</th><th>Lords</th><th>Culture</th><th>Founded</th></tr>${civs.slice(0, 120).map((c) => `<tr><td><a class="l" data-civ="${c.id}">The ${esc(c.name)}</a></td><td>${c.rank}</td><td>${c.government}</td><td>${num(c.pop)}</td><td>${c.members.length}</td><td>${c.members.filter((id) => w.settlements[id - 1].lord).length}</td><td>${esc(w.cultures.get(c.culture)?.name ?? '')}</td><td>${yearOf(c.founded)}</td></tr>`).join('')}</table><p style="color:var(--dim)">${dead} peoples have fallen. ${w.cultures.list.length} cultures have existed.</p>
        <h3 style="font-size:10px;letter-spacing:.24em;color:var(--dim);text-transform:uppercase">Cultures</h3><table><tr><th>Culture</th><th>Parent</th><th>Language</th><th>Emerged</th><th>Origin</th></tr>${[...w.cultures.list].reverse().slice(0, 60).map((c) => `<tr><td><a class="l" data-culture="${c.id}">The ${esc(c.name)}</a> ${esc(c.symbol)}</td><td>${c.parent ? esc(w.cultures.get(c.parent)!.name) : '—'}</td><td>${esc(w.langs.get(c.language)?.name ?? '')}</td><td>${yearOf(c.born)}</td><td style="color:var(--dim)">${esc(c.origin)}</td></tr>`).join('')}</table>`;
    } else if (tab === 'wars') {
      const rels = [...w.diplomacy.rel.values()].filter((r) => r.war || r.battles > 0).sort((a, b) => Number(b.war) - Number(a.war) || b.warStart - a.warStart);
      const all = [...w.diplomacy.rel.values()].filter((r) => r.tension > 0.3 && !r.war).sort((a, b) => b.tension - a.tension).slice(0, 12);
      const nm = (cid: number) => `<a class="l" data-civ="${cid}">The ${esc(w.civs[cid - 1]?.name ?? '?')}</a>`;
      const sieges = [...w.bands.values()].filter((b) => b.kind === 'army' && b.siege !== undefined && !b.returning);
      body = `<table><tr><th>Conflict</th><th>Status</th><th>Began</th><th>Battles</th><th>Dead</th><th>Cause</th></tr>${rels.map((r) => `<tr><td>${nm(r.attacker || r.a)} vs ${nm((r.attacker || r.a) === r.a ? r.b : r.a)}</td><td>${r.war ? '<span class="neg">ongoing</span>' : 'ended'}</td><td>${r.warStart >= 0 ? yearOf(r.warStart) : '—'}</td><td>${r.battles}</td><td>${r.losses[0] + r.losses[1]}</td><td style="color:var(--dim)">${esc(r.cause)}</td></tr>`).join('') || '<tr><td colspan="6" style="color:var(--dim)">No wars yet.</td></tr>'}</table>
        ${sieges.length ? `<h3 style="font-size:10px;letter-spacing:.24em;color:var(--dim);text-transform:uppercase;margin-top:18px">Sieges under way</h3>${sieges.map((b) => { const t = b.lastTarget ? w.settlements[b.lastTarget - 1] : undefined; return `<div>${t ? this.link('settlement', t.id, t.name) : '?'} ${dim(`besieged by ${b.members.length} for ${Math.round(w.day - (b.siege ?? w.day))} days`)}</div>`; }).join('')}` : ''}
        <h3 style="font-size:10px;letter-spacing:.24em;color:var(--dim);text-transform:uppercase;margin-top:18px">Rising tensions</h3><table><tr><th>Peoples</th><th>Tension</th><th>Trade</th><th>Raids</th></tr>${all.map((r) => `<tr><td>${nm(r.a)} / ${nm(r.b)}</td><td>${r.tension.toFixed(2)}</td><td>${r.trade.toFixed(1)}</td><td>${r.raids.toFixed(1)}</td></tr>`).join('') || '<tr><td colspan="4" style="color:var(--dim)">Peace holds.</td></tr>'}</table>`;
    } else if (tab === 'languages') {
      body = `<pre class="tree" style="font-size:13px">${this.langTree(0)}</pre><table style="margin-top:14px"><tr><th>Language</th><th>Parent</th><th>Grammar</th><th>Writing</th><th>Vocab</th><th>“The hunter sees the big deer.”</th></tr>${w.langs.list.map((l) => `<tr><td>${esc(l.name)}${l.pidgin ? ' ⇄' : ''}</td><td>${l.parent ? esc(w.langs.get(l.parent)!.name) : '—'}</td><td style="color:var(--dim);font-size:11px">${esc(describeGrammar(l))}</td><td>${l.writing}</td><td>${num(l.vocabulary)}</td><td><b>${esc(sampleSentences(l)[0]?.native ?? '')}</b></td></tr>`).join('')}</table>`;
    } else if (tab === 'life') {
      const kids = new Map<number, number[]>();
      const living = new Map<number, number>();
      for (const p of w.eco.pops.values()) living.set(p.sp, (living.get(p.sp) ?? 0) + p.n);
      for (const s of w.eco.species) { const a = kids.get(s.parent) ?? []; a.push(s.id); kids.set(s.parent, a); }
      const lines: string[] = [];
      const hasLiving = (sid: number): boolean => w.eco.species[sid - 1].extinct < 0 || (kids.get(sid) ?? []).some(hasLiving);
      const walk = (parent: number, prefix: string) => {
        const ch = (kids.get(parent) ?? []).filter((sid) => w.eco.species[sid - 1].extinct < 0 || hasLiving(sid));
        ch.forEach((sid, i) => {
          const s = w.eco.species[sid - 1];
          const last = i === ch.length - 1;
          const alive = s.extinct < 0;
          lines.push(`${prefix}${last ? '└── ' : '├── '}<a class="l" data-species="${sid}" style="${alive ? '' : 'opacity:.5'}">${esc(s.name)}</a> ${dim(`${s.diet}${alive ? ' · ' + num(living.get(sid) ?? 0) : ' †'}`)}`);
          walk(sid, prefix + (last ? '    ' : '│   '));
        });
      };
      walk(0, '');
      const sea = w.marine.species;
      body = `<p style="color:var(--dim)">Tree of life — species emerge from populations changing over time. † extinct.</p><pre class="tree">${lines.slice(0, 400).join('\n')}</pre>
        <h3 style="font-size:10px;letter-spacing:.24em;color:var(--dim);text-transform:uppercase;margin-top:18px">Life in the sea</h3>
        <table><tr><th>Species</th><th>Kind</th><th>Size</th><th>Water</th><th>Status</th></tr>${sea.map((s) => `<tr><td><a class="l" data-marine="${s.id}">${esc(s.name)}</a></td><td>${roleName(s.role)}</td><td>${s.size.toFixed(1)} m</td><td>${s.tempOpt.toFixed(0)}°C</td><td>${s.extinct >= 0 ? `extinct ${yearOf(s.extinct)}` : 'living'}</td></tr>`).join('')}</table>`;
    } else if (tab === 'technology') {
      const first = new Map<string, SimEvent>();
      for (const e of w.history.events) if (e.type === 'TECHNOLOGY_DISCOVERY' && e.weight >= 3) { const t = TECH_IDS.find((tid) => e.text.includes(TECHS[tid].description)); if (t && !first.has(t)) first.set(t, e); }
      const acts = w.activeSettlements();
      body = `<table><tr><th>Technology</th><th>Prerequisites</th><th>Needs</th><th>First discovered</th><th>Known in</th></tr>${TECH_IDS.map((t) => {
        const e = first.get(t);
        const n = acts.filter((s) => s.tech.has(t)).length;
        const d = TECHS[t];
        return `<tr><td>${esc(d.name)}</td><td style="color:var(--dim)">${d.prereq.map((q) => TECHS[q].name).join(', ') || '—'}</td><td style="color:var(--dim)">${d.civPop ? `a people of ${num(d.civPop)}+` : `a town of ${d.minPop}+`}${d.needs ? ', ' + Object.keys(d.needs).join(', ') : ''}</td><td>${e ? `${formatYear(e.day)} · ${esc(e.text.split('\n')[0].split(' of ')[0])}` : dim('not yet')}</td><td>${n} / ${acts.length}</td></tr>`;
      }).join('')}</table>`;
    } else if (tab === 'space') {
      const sp = w.space;
      body = `<h3 style="font-size:10px;letter-spacing:.24em;color:var(--dim);text-transform:uppercase">The solar system</h3><table><tr><th>Body</th><th>Kind</th><th>Orbit</th><th>Year</th><th>Radius</th><th>Moons</th></tr>${sp.bodies.map((b, i) => `<tr><td>${b.home ? '<b>Home</b>' : `<a class="l" data-body="${i}">${esc(b.name)}</a>`}</td><td>${b.home ? 'living world' : b.kind}${b.rings ? ' · rings' : ''}</td><td>${b.a.toFixed(2)} AU</td><td>${Math.pow(b.a, 1.5).toFixed(2)} y</td><td>${num(b.radiusKm)} km</td><td>${b.moons}</td></tr>`).join('')}</table>
        <h3 style="font-size:10px;letter-spacing:.24em;color:var(--dim);text-transform:uppercase;margin-top:18px">In orbit</h3>${sp.satellites.length ? `<table><tr><th>Name</th><th>Owner</th><th>Kind</th><th>Altitude</th><th>Period</th><th>Launched</th></tr>${sp.satellites.slice(-60).reverse().map((s) => `<tr><td>${esc(s.name)}</td><td>${w.civs[s.civ - 1] ? this.link('civ', s.civ, 'The ' + w.civs[s.civ - 1].name) : '—'}</td><td>${s.kind}</td><td>${num(s.altKm)} km</td><td>${orbitMinutes(s.altKm).toFixed(0)} min</td><td>${yearOf(s.launched)}</td></tr>`).join('')}</table>` : dim('Nothing made by hands has reached orbit.')}
        <h3 style="font-size:10px;letter-spacing:.24em;color:var(--dim);text-transform:uppercase;margin-top:18px">Missions</h3>${sp.missions.length ? sp.missions.slice(-20).reverse().map((m) => `<div>${esc(m.name)} ${dim(`→ ${m.target < 0 ? 'the moon' : esc(sp.bodies[m.target]?.name ?? '?')} · launched ${yearOf(m.launched)} · ${m.done ? 'arrived' : 'en route'}${m.crewed ? ' · crewed' : ''}`)}</div>`).join('') : dim('None yet.')}
        <h3 style="font-size:10px;letter-spacing:.24em;color:var(--dim);text-transform:uppercase;margin-top:18px">Transport network</h3><div style="color:var(--dim)">${sp.routes.filter((r) => r.kind === 'sea').length} sea lanes · ${sp.routes.filter((r) => r.kind === 'air').length} air routes</div>`;
    } else if (tab === 'climate') {
      const wx = w.weather;
      let tl = 0, nl = 0, snow = 0, burned = 0;
      for (let i = 0; i < w.env.soil.length; i++) if (!w.planet.ocean[i]) { nl++; if (w.env.snow[i] > 20) snow++; if (w.env.burned[i] > 0.3) burned++; }
      for (let k = 0; k < wx.T.length; k++) tl += wx.T[k];
      const dis = w.history.events.filter((e) => e.type === 'DISASTER' || e.type === 'FAMINE').slice(-30).reverse();
      body = `<div class="kv" style="max-width:640px"><span>Mean air temperature</span><span>${(tl / wx.T.length).toFixed(1)}°C</span><span>Snow cover</span><span>${Math.round((snow / nl) * 100)}% of land</span><span>Burned land</span><span>${burned} cells recovering</span>
        <span>Active storms</span><span>${wx.storms.map((s) => `${s.tropical && s.depth > 25 ? 'hurricane' : s.tropical ? 'tropical storm' : 'low'} ${esc(s.name)} (${Math.round(1013 - s.depth)} hPa)`).join(', ') || 'none'}</span>
        <span>Wildfires</span><span>${w.env.fires.length ? w.env.fires.map((f) => `${f.cells.length + f.burnt} cells`).join(', ') : 'none burning'}</span>
        <span>Recent earthquakes</span><span>${w.env.quakes.slice(-5).reverse().map((q) => `M${q.mag.toFixed(1)} (${yearOf(q.day)})`).join(', ') || '—'}</span>
        <span>Volcanic winter</span><span>${w.sky.dust(w.day) < 0.99 ? `the sun is dimmed ${Math.round((1 - w.sky.dust(w.day)) * 100)}%` : 'no'}</span></div>
        <h3 style="font-size:10px;letter-spacing:.24em;color:var(--dim);text-transform:uppercase;margin-top:18px">Disasters</h3>${this.eventList(dis)}`;
    }
    return `<button class="x" data-act="closealmanac">×</button><div class="tabs">${tabs.map((t) => `<button class="btn ${t === tab ? 'on' : ''}" style="${t === tab ? 'background:rgba(155,208,255,.18)' : ''}" data-tab="${t}">${cap(t)}</button>`).join('')}</div><div class="body">${body}</div>`;
  }

  dev(fps: number, rate: string, stepMs: number, log: string[], determinism: string): string {
    const w = this.w;
    const t = w.eco.totals();
    const sets = w.activeSettlements();
    const cities = sets.filter((s) => s.stage === 'city' || s.stage === 'town').length;
    const c = w.history.counts;
    const causes = Object.entries(w.stats.causes).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k} ${v}`).join(', ');
    const rows: [string, string][] = [
      ['SIMULATION YEAR', yearOf(w.day).toLocaleString()],
      ['POPULATION', num(w.alive.length)], ['ANIMALS', num(t.animals)], ['SPECIES', `${t.species} living / ${w.eco.species.length} ever`],
      ['SEA SPECIES', `${w.marine.species.filter((s) => s.extinct < 0).length} living / ${w.marine.species.length} ever`],
      ['CIVILIZATIONS', `${w.livingCivs().length} living / ${w.civs.length} ever`], ['CITIES (town+)', String(cities)],
      ['SETTLEMENTS', String(sets.length)], ['LANGUAGES', String(w.langs.list.length)], ['CULTURES', String(w.cultures.list.length)],
      ['TECHNOLOGIES', `${w.techCount()} / ${TECH_IDS.length}`], ['BATTLES', String(c['BATTLE'] ?? 0)],
      ['DISCOVERIES', String((c['TECHNOLOGY_DISCOVERY'] ?? 0) + (c['DISCOVERY'] ?? 0))], ['ACTIVE EVENTS', `${w.bands.size} bands, ${sets.filter((s) => s.diseaseUntil > w.day).length} epidemics, ${sets.filter((s) => s.stress > 0.6).length} famines, ${w.env.fires.length} fires, ${w.weather.storms.length} storms`],
      ['BUILDINGS', `${w.buildings.list.filter((b) => b.done >= 0 && b.kind !== 'field').length} built, ${w.buildings.list.filter((b) => b.kind === 'field' && b.done >= 0).length} fields`],
      ['DEPLETED NODES', String(w.res.state.size)], ['WARS NOW', String(w.diplomacy.wars().length)], ['TREE SPECIES', String(w.flora.species.length)],
      ['ORBIT', `${w.space.satellites.length} satellites, ${w.space.routes.length} routes`],
      ['LEVEL OF DETAIL', `${num(w.lodStats.detailed)} near · ${num(w.lodStats.coarse)} far (every ${w.lodStats.k} ticks)`],
      ['BIRTHS / DEATHS', `${num(w.stats.births)} / ${num(w.stats.deaths)}`], ['SIM RATE', `${rate} · ${stepMs.toFixed(1)} ms/frame (worker)`], ['FPS', fps.toFixed(0)],
    ];
    return `<div class="g">${rows.map(([k, v]) => `<span class="k">${k}</span><span>${esc(v)}</span>`).join('')}</div>
      <h4>DEATHS BY CAUSE</h4><div class="k">${esc(causes)}</div>
      <h4>DETERMINISM</h4><div class="k">seed "${esc(w.seedText)}" → ${w.seed} · rng ${w.rng.state}</div>
      <div style="margin:4px 0"><button class="btn" data-act="replaycheck" style="padding:2px 8px">replay check</button> <button class="btn" data-act="exportsave" style="padding:2px 8px">export save</button></div><div class="k">${esc(determinism)}</div>
      <h4>INSPECT</h4><input id="insp" placeholder="person id…" style="width:100%;background:rgba(255,255,255,.06);border:1px solid var(--line);color:inherit;border-radius:6px;padding:3px 6px" />
      <h4>LOG</h4><div class="log">${log.slice(-40).reverse().map((l) => `<div title="${esc(l)}">${esc(l)}</div>`).join('')}</div>`;
  }
}

/** Event bus + queryable history. Everything important produces an event; the world writes its own history. */

export type EventType =
  | 'BIRTH' | 'DEATH' | 'MARRIAGE' | 'MIGRATION' | 'DISCOVERY' | 'FOUNDING' | 'WAR' | 'BATTLE'
  | 'REVOLT' | 'INVASION' | 'TRADE' | 'DISASTER' | 'CULTURAL_SPLIT' | 'LANGUAGE_SPLIT'
  | 'TECHNOLOGY_DISCOVERY' | 'CIVILIZATION_COLLAPSE' | 'CIVILIZATION_FOUNDING' | 'SPECIATION'
  | 'EXTINCTION' | 'AWAKENING' | 'FAMINE' | 'DISEASE' | 'EXILE' | 'SUCCESSION' | 'GROWTH' | 'LEGEND'
  | 'EXPERIMENT' | 'MASTERY' | 'KNOWLEDGE_LOST';

export interface SimEvent {
  id: number;
  type: EventType;
  day: number;
  text: string;
  /** Why it happened. Strange outcomes must be explainable. */
  cause?: string;
  /** Importance 0..3: 0 = trivia (not kept in long history), 3 = world-defining. */
  weight: number;
  x?: number;
  y?: number;
  persons?: number[];
  settlement?: number;
  civ?: number;
  culture?: number;
}

type Listener = (e: SimEvent) => void;

export class EventBus {
  private listeners = new Map<EventType | '*', Listener[]>();
  on(type: EventType | '*', fn: Listener) {
    const l = this.listeners.get(type) ?? [];
    l.push(fn);
    this.listeners.set(type, l);
  }
  emit(e: SimEvent) {
    for (const fn of this.listeners.get(e.type) ?? []) fn(e);
    for (const fn of this.listeners.get('*') ?? []) fn(e);
  }
}

export class History {
  events: SimEvent[] = [];
  nextId = 1;
  counts: Record<string, number> = {};
  readonly maxKept = 20000;
  constructor(private bus: EventBus) {}

  record(type: EventType, day: number, text: string, weight: number, extra: Partial<SimEvent> = {}): SimEvent {
    const e: SimEvent = { id: this.nextId++, type, day, text, weight, ...extra };
    this.counts[type] = (this.counts[type] ?? 0) + 1;
    // Trivial events are counted and broadcast but not stored forever.
    if (weight >= 1) {
      this.events.push(e);
      if (this.events.length > this.maxKept) {
        // drop the oldest low-weight events first
        const keep = this.events.filter((ev, i) => ev.weight >= 2 || i > this.events.length / 2);
        this.events = keep;
      }
    }
    this.bus.emit(e);
    return e;
  }

  query(opts: { type?: EventType; civ?: number; settlement?: number; person?: number; minWeight?: number; limit?: number; culture?: number } = {}): SimEvent[] {
    const out: SimEvent[] = [];
    const lim = opts.limit ?? 100;
    for (let i = this.events.length - 1; i >= 0 && out.length < lim; i--) {
      const e = this.events[i];
      if (opts.type && e.type !== opts.type) continue;
      if (opts.minWeight !== undefined && e.weight < opts.minWeight) continue;
      if (opts.civ !== undefined && e.civ !== opts.civ) continue;
      if (opts.culture !== undefined && e.culture !== opts.culture) continue;
      if (opts.settlement !== undefined && e.settlement !== opts.settlement) continue;
      if (opts.person !== undefined && !(e.persons && e.persons.includes(opts.person))) continue;
      out.push(e);
    }
    return out;
  }
}

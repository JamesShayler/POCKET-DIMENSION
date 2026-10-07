# Pocket Dimension

A persistent, observer-only miniature universe, built as a TypeScript web application with Three.js.
You can fly through it, follow individuals, inspect cities and speed time up — you can never command anyone.

> *Do not make the inhabitants pretend to be alive. Build systems that give them reasons to behave alive.*

See [`POCKET DIMENSION.md`](POCKET%20DIMENSION.md) for the full design brief. This repository is the first **vertical slice**:
planet → terrain → time → animals → people → settlements → generations → emergent civilization → observer camera.

## Run it

```bash
npm install
npm run dev          # http://localhost:5173
npm run build        # type-check + production bundle
npm run sim -- <seed> <max prehistory years> <years of history>   # headless simulation, no renderer
```

Open the page, pick a seed (or keep the random one) and press **Create new universe**. The same seed always produces the
same planet, climate, rivers, resources and initial life; share the link under the seed name in the top-left.

## What you are watching

1. **A planet with no people.** Life is seeded from the planet's climate: herbivores, carnivores and a social omnivore lineage.
   Traits (size, speed, strength, intelligence, eyesight, hearing, temperature tolerance, aggression, sociality) have costs and
   benefits; mutation and selection act every season; isolated populations drift until they speciate; species go extinct.
2. **An awakening.** Nothing is scripted to be intelligent. When selection pushes a social omnivore population past an intelligence
   and sociality threshold, that population becomes a band of individuals with persistent identities. (Several lineages can awaken
   independently, far apart, and become unrelated peoples with unrelated languages.)
3. **Lives.** Every person has a name, parents, children, partner, personality (13 traits), needs (hunger, thirst, shelter, safety,
   social, belonging, status, curiosity …), skills, beliefs, memories and relationships. Behaviour is chosen from needs,
   personality, environment and memory. Memories change people (a raid makes survivors fearful and vengeful).
4. **Societies.** Camps become settlements, villages and towns. Population presses on land; famine, drought, epidemics and migration follow.
   Some people reject their society (hermits, exiles, raiders, rebels, cult founders) and may found new peoples.
   Cultures and languages drift apart when communities are isolated and split; technologies are *discovered* by creative people
   under local pressure and resources, then spread (or not) through contact. Polities choose leaders, change government,
   suffer coups, and collapse.
5. **A history that writes itself.** Every important event goes through an event bus into a queryable chronicle, and carries
   *why it happened*.

## Observing

| Input | Action |
|---|---|
| Drag / `WASD` | Pan across the globe |
| Right-drag / `Q` `E` `T` `G` | Rotate and tilt |
| Wheel / `R` `F` | Zoom from a person's shoulder (0.45 km) to the solar system |
| Click | Inspect a person, settlement or animal |
| `Space`, `[`, `]` | Pause, slower, faster (×0.1 … ×10,000) |
| **Jump** | Run 1 / 10 / 100 / 1,000 years forward |
| `P` | Political map of peoples |
| `1`–`9` / `Shift+1`–`9` | Go to / save camera bookmarks |
| **Follow** (person panel) | Follow a life; *Follow descendants* continues with the eldest living child after death |
| **Almanac** (`L`) | Chronicle, peoples & cultures, language family tree, tree of life, technology |
| `` ` `` or **Dev** | Developer dashboard (see below) |
| `H` | Hide the interface |

The simulation autosaves to the browser (IndexedDB) every two minutes and on **Save**; **Continue** on the start screen resumes it.

## Architecture

```
src/
  sim/        the universe — no DOM, no Three.js, runs under Node (scripts/headless.ts)
    rng.ts noise.ts grid.ts time.ts      deterministic primitives, spherical grid, calendar
    planet.ts                            terrain, climate (rain shadows), priority-flood rivers, resources, biomes
    environment.ts                       vegetation, weather anomalies, fertility, volcanoes, forage
    ecology.ts                           species, populations, selection, speciation, predation, awakening
    people.ts behavior.ts                individuals; needs → goals → movement/production; memory & relationships
    society.ts settlements.ts            settlements, migration, outcasts, raids, polities, culture/language drift, technology
    culture.ts languages.ts technology.ts names.ts
    events.ts                            event bus + queryable history
    world.ts                             composition root and time stepping
    persistence.ts                       seed + evolving state ⇄ JSON (IndexedDB in the browser)
  render/     Three.js observer — reads the world, never writes it
    planetView.ts  materials.ts          displaced sphere, day/night, seasons, clouds from simulated weather, atmosphere
    rivers.ts entities.ts                river ribbons; instanced settlements, buildings, people, wildlife
    camera.ts observer.ts                globe-aware camera, sun/moon/stars, input
  ui/ui.ts                               HUD, inspectors, almanac, developer dashboard
  engine.ts                              real-time → simulation-time driver with a per-frame budget
  main.ts                                menu, boot, loop
```

Key properties:

* **Simulation and rendering are separate systems.** `src/sim` imports nothing from `render`/`ui`; the renderer only reads state and
  interpolates between ticks. The same engine runs headless (`npm run sim`).
* **Determinism.** One seed → one planet and one initial life. All randomness comes from serialisable PRNG streams, and the whole
  evolving state is saved and restored exactly: two worlds restored from the same save and stepped identically stay identical
  (`scripts/roundtrip.ts`, or **Dev → replay check** in the browser).
* **Multi-scale time.** Tick size grows with speed (0.05 day … 30 days); environment and ecology run once per season; the
  engine sheds backlog rather than freezing if the machine cannot keep up (the dashboard shows the achieved rate).
* **Causality over randomness.** Wars, famines, migrations, splits and discoveries all have recorded causes (shown in the chronicle).

### Developer dashboard

Simulation year, population, animals, species (living / ever), civilizations, cities, languages, technologies, battles, discoveries,
active events (bands, epidemics, famines), births/deaths and death causes, sim rate, frame rate, seed and RNG state, a rolling event
log, an "inspect person by id" box, **export save** and a **replay check**.

## Honest status of this slice

Implemented: Phases 1–3 fully, most of Phase 4 (culture, language, technology, civilization), and a first cut of Phase 5
(politics, raids, migration). Not implemented — deliberately absent rather than faked:

* Warfare between civilizations, diplomacy, conquest, and empires beyond a rank label; only outcast raiding and internal revolts exist.
* Levels of detail *inside* the simulation. Every person is simulated individually (cost grows with population); settlement-level
  aggregation for distant regions is the next architectural step. Simulation also runs on the main thread, not a Web Worker
  (it is written so that it can move: it is pure state + `step(dt)`).
* Technologies beyond engineering (electricity … spaceflight), aircraft, and any space program. Boats exist as a navigation
  technology that permits crossing narrow water.
* Marine life; ocean currents are visual only; caves exist as a terrain feature but have no gameplay effect yet.
* Language "merging" and per-word grammar; languages split by sound change and carry a small sample lexicon.
* Solar system: sun, the planet's day/night and axial-tilt seasons, and a moon — no other planets, comets or asteroids yet.
* The world is a small "pocket" planet (radius 1,000 km) on a 256×128 simulation grid; one cell is ≈24 km at the equator.
  Close-up scenery is therefore simple.

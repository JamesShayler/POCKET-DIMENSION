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
   Trees evolve too: every region has a dominant tree species with its own generation time, wood yield and hardness, adapting
   to local climate and splitting into daughter species. A comet or two cross the sky on real orbits, and very rarely an asteroid
   strikes.
2. **An awakening.** Nothing is scripted to be intelligent. When selection pushes a social omnivore population past an intelligence
   and sociality threshold, that population becomes a band of individuals with persistent identities, starting with *nothing*:
   no tools, no houses, no stored food.
3. **A physical world.** Resources are real places with real positions: groves (each tree takes years to regrow, depending on its
   species), berry bushes, fishing waters, stone outcrops, clay pits, and copper/iron/coal/gold veins that must be *prospected*
   before anyone can use them. People walk to a node, work there for hours (faster with better tools and skill), carry a load home
   and deposit it. Hunters stalk the very same animals you see on screen. Farmers clear, plant, weed and harvest fields that
   take a season to ripen and can fail in a drought. Metal needs a smithy, ore and fuel.
4. **Lives, days and nights.** At the default ×1 pace one simulated minute passes per second (a day lasts 24 minutes). People sleep
   at night in their own house (or in the open if they have none), work by day, eat from the common store, and have a personality
   (13 traits), needs, skills, beliefs, memories and relationships. Memories change people.
5. **Towns grow from need, skill and wealth.** The community decides what to build next from what it lacks and what it can afford:
   huts, then timber, mud-brick and stone houses, granaries, kilns, workshops, smithies, wells, halls, markets, temples,
   watchtowers. Buildings need materials in the stockpile and labour from builders; their placement is organic (a rosette around
   the centre, fields further out), not a grid. Over-crowding, hunger or conflict make groups split away and found new towns.
6. **Speech, trade and diplomacy.** People speak a language, learn each other's when they meet, and coin words for new things
   (wood, field, iron …). Caravans carry surplus to neighbours that lack it, at prices set by scarcity; repeated trade between
   peoples with different languages grows a **trade pidgin**. Tension between peoples builds from crowded borders, hunger, raids,
   alien customs and ambitious rulers, and is eased by trade. When it is high and someone expects to win, a **war** can be
   declared: armies march physically, battle, sack or conquer settlements, and refugees flee.
7. **Societies and outcasts.** Cultures and languages drift apart when communities are isolated; technologies are *discovered* by
   creative people under local pressure and resources, then spread through contact. Some people reject society (hermits, exiles,
   raiders, rebels, cult founders) and may found new peoples. Polities choose leaders, change government, suffer coups and collapse.
8. **A history that writes itself.** Every important event goes through an event bus into a queryable chronicle and carries
   *why it happened*.

## Observing

| Input | Action |
|---|---|
| Drag / `WASD` | Pan across the globe |
| Right-drag / `Q` `E` `T` `G` | Rotate and tilt |
| Wheel / `R` `F` | Zoom from a person's shoulder (0.45 km) to the solar system |
| Click | Inspect a person, settlement, animal, tree/ore/stone node or building |
| `Space`, `[`, `]` | Pause, slower, faster (×1 = one simulated minute per second … ×10M ≈ 19 years per second) |
| **Jump** | Run 1 / 10 / 100 / 1,000 years forward |
| `P` | Political map of peoples |
| `1`–`9` / `Shift+1`–`9` | Go to / save camera bookmarks |
| **Follow** (person panel) | Follow a life; *Follow descendants* continues with the eldest living child after death |
| **Almanac** (`L`) | Chronicle, peoples & cultures, wars & tensions, language family tree, tree of life, technology |
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

Implemented: Phases 1–3 fully, most of Phase 4 (culture, language, technology, civilization), a working first cut of Phase 5
(diplomacy, war, raids, migration, trade) and the physical economy underneath. Not implemented — deliberately absent rather than faked:

* Technologies beyond engineering (electricity … spaceflight), aircraft, and any space program. Boats exist as a navigation
  technology that permits crossing narrow water. Of the solar system there is the sun, a moon, comets and asteroid impacts — no other planets.
* Levels of detail *inside* the simulation. Every person is simulated individually (cost grows with population and the engine
  sheds backlog instead of freezing: the dashboard shows the achieved rate). Simulation runs on the main thread, not a Web Worker
  (it is pure state + `step(dt)`, so it can move).
* The terrain is still sampled from a 256×128 grid (a cell is ≈24 km); everything *on* it — resources, buildings, fields, people,
  animals — has a continuous position, rendering warps cell lookups so biome edges wander, and the ground is a 12 km mesh with fine relief.
  Close-up scenery is therefore still simple.
* Marine life; ocean currents are visual only; caves exist as a terrain feature but have no gameplay effect yet.
* Language is modelled at the level of phonology, sound change, a growing lexicon, per-person fluency and contact languages;
  there is no grammar generation beyond word order and morphology labels.
* Wars are between peoples, not individual lords; sieges are single battles; there are no navies.
* A restored save and a continuing world differ very slightly (a few runtime-only caches), but two restores of the same save stay identical.

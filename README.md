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

1. **A planet with no people.** Continents come from plate tectonics: plates drift on their own Euler poles, collisions raise
   mountain ranges and island arcs, subduction digs trenches, rifts and mid-ocean ridges open, hotspots build volcanic chains.
   Life is seeded from the climate: herbivores, carnivores and a social omnivore lineage on land, and forage fish, hunting
   fish, squid, sharks, seals, turtles and whales in the sea. Traits have costs and benefits; mutation and selection act every
   season; isolated populations drift until they speciate; species go extinct. Trees evolve too (each region has a dominant
   species with its own generation time, wood yield and hardness).
2. **Weather and a living surface.** Winds (trade winds, westerlies, polar easterlies) carry heat and water vapour on a 128×64
   grid; rain falls where air is lifted (mountains, the tropical convergence zone that follows the sun, fronts, storms, afternoon
   convection); continents heat up into monsoon lows; tropical cyclones form over warm seas and temperate lows ride the
   westerlies. Ocean currents (warm western-boundary, cold eastern-boundary with upwelling) carry sea temperature and feed the
   fisheries. Rain becomes soil moisture and snowpack (with real lapse-rate snow lines and glaciers on high peaks), runoff becomes
   river flow, and from that come floods, droughts, frost-killed crops, wildfires started by lightning or by people that run
   with the wind and die in rain, erosion of bare slopes, earthquakes and tsunamis along converging plates, and volcanic winters.
3. **An awakening.** Nothing is scripted to be intelligent. When selection pushes a social omnivore population past an intelligence
   and sociality threshold, that population becomes a band of individuals with persistent identities, starting with *nothing*.
4. **A physical world.** Resources are real places: groves, berry bushes, fishing waters, stone, clay, and copper/iron/coal/gold
   veins that must be *prospected*. People walk to them, work for hours (faster with tools, skill and later machines), carry
   loads home. Hunters stalk the animals you see; fishers depend on the fish actually in the sea; farmers plant, weed and
   harvest fields that frost, drought, floods, storms and fire can ruin. Caves shelter early peoples and carry their paintings.
5. **Lives, days and nights.** At ×1 one simulated minute passes per second. People sleep at night, work by day, feel the
   real air temperature where they stand, and have personalities, needs, skills, beliefs, memories and relationships.
6. **Towns grow from need, skill and wealth** — huts, timber, mud-brick and stone houses, granaries, kilns, workshops, smithies,
   wells, halls, markets, temples, towers, palisades and stone walls, docks, and much later factories, power stations,
   airports and launch sites. Placement is organic, not a grid.
7. **Compact peoples, far apart.** Colonies stay near their own towns and keep a wide gap from foreigners. Large states govern
   their outlying towns through **lords** whose loyalty grows with legitimacy and kinship and erodes with distance, hardship and
   ambition; disloyal lords rebel and found new states (and wars of independence follow). Collapsing states break into regional
   successors; small peoples squeezed against a larger kindred neighbour are absorbed.
8. **Speech, trade and war.** Each language has a generated grammar (word order, case endings or particles, plurals, tense
   marking, negation, questions, articles) and the almanac shows sample sentences with glosses; daughter languages inherit it
   with sound changes, eroding endings and shifting order; trade pidgins drop the endings. Caravans, then sea lanes and air
   routes, carry surplus where it is scarce. Wars mobilise armies that march, cross the sea (after beating the defenders'
   fleet), and besiege walled towns — starving them and battering a breach, faster with siege engines and cannon.
9. **From stone to space.** Technologies are discovered under local pressure and resources and spread by contact (further with
   writing, printing, steam and radio): fire, tools, agriculture, pottery, weaving, metallurgy, architecture, writing, mathematics,
   navigation, engineering, ironworking, astronomy, medicine, printing, chemistry, gunpowder, steam, industry, electricity,
   combustion, radio, flight, computing, rocketry, spaceflight. Each has real effects (productivity, yields, health, travel,
   ocean crossings, military strength, governable distance, invention rate). Space programs launch satellites (which you can see
   crossing the night sky), put people in orbit, build stations, land on the moon and send probes to the other planets.
10. **A history that writes itself.** Every important event carries *why it happened*.

## Observing

| Input | Action |
|---|---|
| Drag / `WASD` | Pan across the globe |
| Right-drag / `Q` `E` `T` `G` | Rotate and tilt |
| Wheel / `R` `F` | Zoom continuously from eye level (1.6 m) to the edge of the solar system (≈30 AU) |
| Click | Inspect a person, settlement, animal, tree/ore/stone node or building |
| `Space`, `[`, `]` | Pause, slower, faster (×1 = one simulated minute per second … ×10M ≈ 19 years per second) |
| **Jump** | Run 1 / 10 / 100 / 1,000 years forward |
| `P` | Political map of peoples |
| `1`–`9` / `Shift+1`–`9` | Go to / save camera bookmarks |
| **Follow** (person panel) | Follow a life; *Follow descendants* continues with the eldest living child after death |
| **Almanac** (`L`) | Chronicle, peoples & cultures, wars & sieges, languages with grammar and sample sentences, tree of life and life in the sea, technology, space, climate & disasters |
| `` ` `` or **Dev** | Developer dashboard (see below) |
| `H` | Hide the interface |

The simulation autosaves to the browser (IndexedDB) every two minutes and on **Save**; **Continue** on the start screen resumes it.

## Architecture

```
src/
  sim/        the universe — no DOM, no Three.js; runs in a Web Worker in the browser and under Node in scripts/
    rng.ts noise.ts grid.ts time.ts      deterministic primitives, spherical grid, calendar
    terrain.ts planet.ts                 plate tectonics → elevation function; climate, rivers, lakes, biomes, resources
    weather.ts environment.ts hazards.ts winds, water, clouds, storms, currents; soil, snow, vegetation; fire, flood, quakes
    ecology.ts flora.ts marine.ts        land animals, trees and sea life: selection, speciation, extinction
    people.ts behavior.ts jobs.ts        individuals; needs → goals → trips, work and production; memory & relationships
    society.ts settlements.ts economy.ts settlements, colonies, lords, polities, culture/language drift, discovery, trade
    diplomacy.ts                         tension, war, armies, navies, sieges
    technology.ts techfx.ts              the tech tree and what each technology actually does
    space.ts                             the solar system, satellites, missions, sea lanes and air routes
    culture.ts languages.ts names.ts     cultures; phonology, lexicon, grammar generation, sample sentences
    events.ts world.ts persistence.ts    history, composition root and stepping (with level of detail), saves
    panels.ts                            the inspector, almanac and dashboard text, written next to the data
  worker/sim.worker.ts                   owns the World; real-time clock; snapshots of what is near the observer
  shared/protocol.ts                     messages between worker and page
  client.ts                              the page's read-only view of the world (and seed-derived things rebuilt locally)
  render/     Three.js observer — reads snapshots, never writes the world
    terrainGen.ts terrain.worker.ts      chunk generation (true-scale relief, river channels, water, tree lattice) in workers
    terrain.ts                           cube-sphere quadtree, ground and water shaders, height queries
    fields.ts                            simulation state as textures (land, snow, fire, climate, weather, ocean, borders)
    sky.ts heavens.ts                    scattering atmosphere, sun, moon, planets, comets, stars, satellites, city lights
    weatherfx.ts                         cloud decks and storm spirals, rain and snow, lightning, wildfire flames and smoke
    entities.ts models.ts                people, animals, buildings, walls, fields, forests, rocks, ships, aircraft, sea life
    camera.ts observer.ts                one camera from eye level to the outer planets; input, labels, picking
  ui/ui.ts                               HUD, inspectors, almanac, developer dashboard
  engine.ts                              real-time → simulation-time driver (used inside the worker)
  main.ts                                menu, boot, loop
```

Key properties:

* **Simulation and rendering are separate systems, on separate threads.** `src/sim` imports nothing from `render`/`ui` and touches
  no DOM. It runs in a Web Worker; the page receives snapshots (people, buildings and resource sites near the observer, the
  land surface, weather, sky) and asks the worker for panel text. The same engine runs headless (`npm run sim`).
* **One scale.** Everything is drawn at its real size and distance: a person is 1.7 m, a house a few metres, the planet 1,000 km
  in radius, the moon 60,000 km away and the sun one astronomical unit. Nothing grows or shrinks with zoom; the ground is a
  cube-sphere quadtree refined from 1,500 km tiles to a few metres between vertices underfoot, built in worker threads from
  the very same terrain function the simulation uses. A floating origin at the camera and a logarithmic depth buffer keep
  centimetres and astronomical units in one scene.
* **Level of detail in the simulation.** People near the observer are stepped every tick; everyone else lives the same
  individual life in coarser steps (each person every k-th tick with k times the time step). Small worlds are always fully detailed.
* **Determinism.** One seed → one planet, solar system and initial life. All randomness comes from serialisable PRNG streams and the
  whole evolving state (including weather, soil, snow, fires, sea life, space and the resource-search cache) is saved and restored
  exactly: a restored save continues identically to the world it was saved from (`npm test`).
* **Multi-scale time.** Tick size grows with speed (30 s … 30 days); the weather integrates in half-hour steps at living pace and
  samples representative days at high speed; environment and ecology run once per season.
* **Causality over randomness.** Wars, famines, migrations, splits, discoveries and disasters all have recorded causes.

### Developer dashboard

Simulation year, population, animals, species (living / ever), civilizations, cities, languages, technologies, battles, discoveries,
active events (bands, epidemics, famines), births/deaths and death causes, sim rate, frame rate, seed and RNG state, a rolling event
log, an "inspect person by id" box, **export save** and a **replay check**.

## Honest status

Implemented: Phases 1–5 of the design brief as systems, from the planet through ecology, people, settlements, culture, language,
technology up to spaceflight, diplomacy, war and the observer. What remains simplified — stated rather than faked:

* The weather grid is ≈50 km and the simulation grid ≈24 km, so weather and climate are regional; what you see close up (clouds,
  rain, snow lines, wet ground) is that regional state drawn with local detail, not a local simulation.
* Late technologies act through their effects on work, health, travel, trade and war; there are no individual machines,
  vehicles on roads or power grids. Ships and aircraft are drawn on the sea lanes and air routes the simulation creates.
* Satellites, stations and probes follow real orbits and transfer times, but spacecraft are not simulated in flight; nothing
  lands on or colonises other planets.
* Animals are drawn as herds at the positions hunters use (a few per population), not one model per animal.
* Every person is an individual agent, so a world holds a few thousand people at once: a "city" is a few hundred, a large
  state several hundred to a thousand. Population thresholds for ideas are calibrated to that scale. History is slow on
  purpose: in a 1,000-year headless run of seed `pocket`, agriculture arrives around year 250, writing around 450, printing
  around 600 and steam power around 950; the industrial, electrical and space ages come later still (use **Jump**).
* At the highest speeds the engine sheds backlog rather than freezing (the dashboard shows the achieved rate).
* Headless or software-rendered browsers (no GPU) refine the ground slowly; with a GPU it follows the camera in real time.

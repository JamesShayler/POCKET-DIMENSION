POCKET DIMENSION

Build a large-scale, persistent 3D simulation called Pocket Dimension.

The application is a living miniature universe that the user can observe but never directly control.

The player is essentially an invisible observer looking into a pocket dimension containing a vast world, evolving ecosystems, intelligent species, civilizations, cultures, and eventually a simulated solar system.

The core philosophy is:

    The world exists independently of the observer.

    Things happen because the simulated inhabitants, environment, physics, resources, and history cause them to happen — not because the player triggered them.

The simulation should feel like watching an alien world slowly become alive.
1. CORE EXPERIENCE

The user enters an enormous 3D world.

At first they may see almost nothing:

    terrain

    oceans

    mountains

    rivers

    forests

    weather

    clouds

    animals

    tiny primitive organisms

Over time, life develops.

Animals migrate.

Species mutate.

Populations grow.

Groups form.

Intelligent creatures develop tools.

Settlements appear.

Villages become towns.

Towns become cities.

Cities become civilizations.

Civilizations trade.

Civilizations fight.

Civilizations collapse.

New civilizations emerge from the ruins.

Some inhabitants leave their societies.

Some reject their culture.

Some become explorers.

Some become criminals.

Some become religious leaders.

Some become inventors.

Some become tyrants.

Some become legends.

The world should continue evolving even when the user is doing absolutely nothing.
2. THE USER IS AN OBSERVER

The user cannot directly control inhabitants.

Do NOT make this a conventional strategy game.

There should be:

    no unit selection

    no command buttons

    no “build house” button

    no direct movement control

    no resource spending

    no technology tree controlled by the player

    no diplomacy controlled by the player

The user observes.

The user may:

    fly through the world

    zoom from planetary scale to individual scale

    follow individuals

    follow animals

    follow civilizations

    inspect cities

    inspect buildings

    inspect historical events

    inspect scientific discoveries

    inspect wars

    inspect migrations

    inspect family trees

    inspect cultures

    inspect technological progress

    pause time

    slow time

    accelerate time

    jump forward in history

The player is effectively a god who refuses to intervene.
3. SCALE

The world must feel enormous.

Do not build a small map disguised as a large world.

The simulation should support extremely long viewing distances and enormous procedural terrain.

The user should be able to zoom through multiple scales:

INDIVIDUAL
↓
HOUSE
↓
VILLAGE
↓
CITY
↓
REGION
↓
CONTINENT
↓
PLANET
↓
SOLAR SYSTEM

At the highest level, the user should be able to see the planet floating in space.

The planet should exist inside a small simulated solar system.

Eventually support:

    sun

    planets

    moons

    orbital motion

    day/night cycles

    seasons

    atmospheric simulation

    weather

    asteroid/comet events

The simulation should be architected so that future expansion beyond the initial planet is possible.
4. PROCEDURAL PLANET

Generate a procedurally created planet.

It should contain:

    continents

    islands

    oceans

    rivers

    lakes

    mountains

    valleys

    deserts

    forests

    tundra

    grasslands

    swamps

    caves

    coastlines

    volcanic regions

Terrain should be generated deterministically from a seed.

Store the seed so the same universe can be recreated.

Use procedural generation rather than manually authored terrain.

The planet should have geographically meaningful systems.

For example:

Mountains affect rainfall.

Rainfall affects rivers.

Rivers affect vegetation.

Vegetation affects animal populations.

Animal populations affect settlements.

Settlements affect civilizations.

Civilizations affect the environment.

The systems should interact.
5. REALISTIC WORLD SIMULATION

Create interconnected simulation systems.

At minimum:
Environment

    temperature

    rainfall

    humidity

    seasons

    wind

    sunlight

    water

    soil fertility

    vegetation

    natural disasters

Resources

Resources should exist physically in the world.

Examples:

    water

    wood

    stone

    clay

    coal

    iron

    copper

    gold

    food

    fertile land

Resources should be spatially distributed.

Civilizations should have reasons to migrate.
6. LIFE

Create a biological simulation.

Begin with relatively simple organisms.

Over enormous simulated periods, populations can change.

Animals should have:

    species

    genes

    traits

    age

    health

    hunger

    energy

    reproduction

    movement

    habitat preferences

    predators

    prey

    social behavior

Traits should have advantages and disadvantages.

Examples:

    speed

    size

    strength

    intelligence

    eyesight

    hearing

    temperature tolerance

    aggression

    sociality

Allow mutation.

Allow natural selection.

Do not simply randomly spawn new species.

Species should emerge from populations changing over time.
7. INTELLIGENT SPECIES

Eventually introduce an intelligent species.

Do not make every individual identical.

Every intelligent individual should have a persistent identity.

Give individuals:

    name

    age

    sex

    parents

    children

    siblings

    location

    health

    personality

    intelligence

    skills

    beliefs

    memories

    relationships

    occupation

    culture

    reputation

    possessions

    social status

Individuals should be capable of learning.
8. PERSONALITY

Create personality traits.

Examples:

    curiosity

    aggression

    empathy

    bravery

    fearfulness

    ambition

    sociability

    intelligence

    creativity

    loyalty

    greed

    patience

    impulsiveness

These traits should affect behavior.

For example:

A highly curious individual may explore beyond their settlement.

A highly aggressive individual may become a warrior.

A highly social individual may become influential.

A highly creative individual may invent something.

A fearful individual may avoid dangerous areas.

Do not make behavior perfectly deterministic.

Use goals + personality + needs + environment + memory.
9. NEEDS

Individuals should have needs.

Examples:

    hunger

    thirst

    shelter

    safety

    social connection

    belonging

    reproduction

    status

    curiosity

    purpose

Their behavior should emerge from attempting to satisfy these needs.

Example:

Hungry → find food.

No food nearby → travel.

Repeated food shortage → migrate.

Migration → encounter another population.

Encounter → trade or conflict.

Trade → cultural exchange.

Conflict → war.

This chain should emerge naturally.
10. MEMORY

Individuals should remember important events.

Examples:

    who helped them

    who betrayed them

    where they were born

    major disasters

    wars

    family deaths

    discoveries

    important leaders

    religious experiences

    migrations

Memory should influence future decisions.

If someone watches their village get destroyed by another civilization, that experience should affect their future behavior.
11. FAMILIES

Individuals should form families.

Support:

    parents

    children

    siblings

    grandparents

    cousins

    marriage/partnerships

    inheritance

Families should persist across generations.

The user should be able to inspect genealogies.

Example:

Elias
├── Mara
│   ├── Theo
│   └── Lina
└── Jonah
    ├── Arin
    └── Sol

12. CULTURE

Culture should emerge.

Groups develop:

    language

    traditions

    clothing

    architecture

    food

    customs

    beliefs

    rituals

    music

    symbols

    laws

    values

Cultures should spread through:

    migration

    trade

    conquest

    intermarriage

    communication

Cultures should also diverge.

Two populations separated for 500 years should gradually become culturally different.
13. LANGUAGE

Do not simply assign every civilization a random language.

Languages should evolve.

Track:

    vocabulary

    grammar

    names

    symbols

    writing systems

Languages should split and merge over time.

Show a language family tree.

Example:

Proto-Language
├── Northern
│   ├── Noric
│   └── Varen
└── Southern
    ├── Solan
    └── Eri

14. TECHNOLOGY

Technology should emerge through discovery.

Do not unlock technologies on a fixed scripted timeline.

Possible progression:

    fire

    tools

    agriculture

    pottery

    weaving

    metallurgy

    writing

    mathematics

    navigation

    architecture

    engineering

    electricity

    chemistry

    machines

    computing

    spaceflight

However, civilizations may discover technologies in different orders.

A civilization isolated in a desert should develop differently from one surrounded by forests and oceans.

Technology should depend on:

    available resources

    population

    knowledge

    experimentation

    environment

    cultural attitudes

    existing technology

15. DISCOVERIES

Important discoveries should become historical events.

Example:

YEAR 8,421

Nera of the Varen civilization
has discovered a method for producing steel.

Discovery:
Advanced metallurgy

Impact:
+ stronger tools
+ stronger weapons
+ new architecture

The discovery should spread gradually.

Other civilizations may:

    learn it through trade

    steal it

    independently discover it

    reject it

    fail to understand it

16. CIVILIZATIONS

Settlements should naturally grow.

CAMP
↓
SETTLEMENT
↓
VILLAGE
↓
TOWN
↓
CITY
↓
CITY-STATE
↓
KINGDOM
↓
EMPIRE

But not every civilization should follow the same path.

Some societies may remain nomadic.

Some may form small city-states.

Some may become enormous empires.

Some may repeatedly collapse.

Some may disappear completely.
17. POLITICS

Civilizations should develop political systems.

Possible systems:

    tribal leadership

    councils

    monarchies

    republics

    democracies

    dictatorships

    theocracies

    federations

    anarchic societies

Political systems should evolve based on internal pressures.

Leaders should have personalities.

Power struggles should occur.

Succession should matter.
18. OUTCASTS

This is a major system.

Not everyone should conform.

Some individuals should reject society.

Examples:

    criminals

    rebels

    hermits

    extremists

    revolutionaries

    exiles

    wanderers

    cult founders

    pirates

    raiders

    anarchists

    inventors who reject tradition

An outcast might leave a civilization.

They might form a small settlement.

Others might join them.

That settlement could become a new culture.

A rejected individual could accidentally become the founder of a civilization.
19. CHAOS

Do not make the simulation perfectly peaceful or predictable.

Things should go wrong.

Examples:

    famine

    disease

    political coups

    assassinations

    rebellions

    religious conflicts

    civil wars

    natural disasters

    resource shortages

    mass migrations

    invasions

    technological accidents

    ecological collapse

But avoid random chaos for its own sake.

Events should have causes.
20. WAR

Civilizations should be capable of conflict.

Wars should emerge from:

    resource competition

    territory

    ideology

    revenge

    religion

    political ambition

    population pressure

    historical grudges

War should have consequences.

Cities can be destroyed.

Populations can migrate.

Borders can change.

Languages can spread.

Cultures can disappear.

Empires can collapse.
21. EXPLORATION

Intelligent populations should explore.

They should discover:

    new continents

    islands

    mountains

    resources

    other civilizations

Eventually they may develop:

    boats

    navigation

    maps

    long-distance trade

    advanced ships

Much later:

    aircraft

    rockets

    orbital technology

    space exploration

The goal is for exploration to emerge rather than being triggered by the player.
22. HISTORY

Create a persistent historical record.

Every important event should become part of history.

Examples:

YEAR 214
The first permanent settlement was founded.

YEAR 398
The Great Drought began.

YEAR 421
The Varen migrated east.

YEAR 447
The First Varen War began.

YEAR 451
The city of Orah was destroyed.

YEAR 902
Writing was invented.

The world should effectively write its own history.
23. OBSERVER UI

Build an elegant observer interface.

The 3D world should remain the main focus.

UI should be minimal and cinematic.

Allow:

    pause

    play

    speed ×1

    ×10

    ×100

    ×1,000

    ×10,000

    jump forward

    camera bookmarks

    follow individual

    follow civilization

    follow event

Clicking an individual opens:

NAME
AGE
SPECIES
CULTURE
LOCATION

PERSONALITY
Curious ████████░░
Aggressive ███░░░░░░░
Empathetic ███████░░░

FAMILY

MEMORIES

RELATIONSHIPS

SKILLS

CURRENT GOAL

Clicking a civilization opens:

CIVILIZATION

Population
Territory
Cities
Culture
Language
Government
Technology
Military
Economy

HISTORY

CURRENT EVENTS

RELATIONS

24. FOLLOW MODE

Allow the observer to select any entity and follow them.

For example:

    Follow Arin.

The camera follows Arin through their entire life.

The observer can watch:

Birth.

Childhood.

Learning.

Friendships.

First job.

Marriage.

Children.

Exploration.

War.

Old age.

Death.

Then optionally continue following one of their descendants.

This should be one of the most emotionally compelling features.
25. GENERATIONAL TIME

The simulation must operate at multiple time scales.

At slow speed:

You can watch an individual walk through a village.

At high speed:

You can watch centuries pass.

The simulation should intelligently switch levels of detail.

Near the camera:

High-detail simulation.

Far away:

Aggregated simulation.

This is critical for scaling to a huge world.
26. LEVEL OF DETAIL

Build the simulation around hierarchical simulation.

Example:

Planet
  ↓
Continent
  ↓
Region
  ↓
Settlement
  ↓
Household
  ↓
Individual

Do not attempt to fully simulate millions of individuals at maximum detail simultaneously.

Use different simulation resolutions.

When the observer approaches an area, increase simulation detail.

When the observer leaves, aggregate it.

The world must continue progressing regardless of camera location.
27. PERSISTENCE

The universe should persist.

Save:

    world seed

    terrain

    entities

    populations

    civilizations

    technology

    culture

    history

    relationships

    discoveries

    important events

The user should be able to close the application and return later.

Eventually support background simulation.
28. VISUAL STYLE

The visual style should feel:

beautiful + mysterious + scientific + cinematic.

Think:

    planetarium

    satellite imagery

    documentary

    miniature world

    futuristic observatory

The world should look beautiful even when zoomed far out.

Cities should glow subtly at night.

Weather should move across continents.

Cloud systems should move.

Oceans should have visible currents.

Day/night should visibly affect civilization.
29. PERFORMANCE

Performance is extremely important.

Use:

    spatial partitioning

    chunking

    instancing

    level of detail

    entity aggregation

    background simulation

    deterministic seeds

    event-driven simulation

    multithreading/workers where appropriate

Do not create architecture that requires rendering every entity at every frame.

Rendering and simulation must be separate systems.
30. SIMULATION ARCHITECTURE

Use a clean modular architecture.

Suggested major systems:

World
├── Terrain
├── Climate
├── Water
├── Resources
├── Ecology
├── Species
├── Individuals
├── Families
├── Settlements
├── Cultures
├── Languages
├── Technology
├── Economies
├── Politics
├── Diplomacy
├── Warfare
├── Exploration
├── History
├── Events
└── Time

The simulation engine should not depend directly on rendering.

The renderer observes the simulation.
31. EVENT SYSTEM

Create an event bus.

Everything important should produce events.

Examples:

BIRTH
DEATH
MARRIAGE
MIGRATION
DISCOVERY
FOUNDING
WAR
BATTLE
REVOLT
INVASION
TRADE
DISASTER
CULTURAL_SPLIT
LANGUAGE_SPLIT
TECHNOLOGY_DISCOVERY
CIVILIZATION_COLLAPSE
CIVILIZATION_FOUNDING

Events should be queryable.
32. EMERGENT STORYTELLING

Do NOT write a fixed storyline.

Instead, create systems capable of generating stories.

The system might naturally produce:

    A curious farmer named Sera left her village after a famine.

    She traveled 600 kilometers north.

    She discovered an isolated settlement.

    She introduced agricultural techniques from her homeland.

    Her descendants became influential merchants.

    300 years later, their descendants founded a city.

    That city became the capital of an empire.

    The empire eventually invaded Sera's ancestral homeland.

None of this should be scripted.

The story emerges from the simulation.
33. IMPORTANT DESIGN PRINCIPLE

Avoid excessive randomness.

Randomness should provide variation.

The simulation should primarily be causal.

Bad:

Randomly start a war.

Better:

Population rises
→ food becomes scarce
→ migration begins
→ migration enters neighboring territory
→ border tensions rise
→ political faction demands action
→ diplomatic relations deteriorate
→ war becomes likely

Every major event should have understandable causes.
34. OBSERVER DISCOVERY

The interface should reward curiosity.

Don't reveal everything immediately.

Let the user discover stories.

For example:

You notice a tiny settlement on an island.

You zoom in.

There are only 83 inhabitants.

You inspect their history.

They descend from survivors of a civilization
that disappeared 2,000 years ago.

The world should constantly contain little mysteries.
35. WORLD SEED

At startup:

CREATE NEW UNIVERSE

Generate:

Universe Seed
Planet
Solar System
Climate
Terrain
Species
Initial Life

Allow the user to save/share the seed.

Two people with the same seed should get the same initial universe.
36. DEVELOPMENT STRATEGY

Do not attempt to implement the entire universe in one pass.

Build vertically.

PHASE 1:

    3D planet

    procedural terrain

    camera

    day/night

    time controls

PHASE 2:

    plants

    animals

    food chains

    population simulation

PHASE 3:

    intelligent species

    individuals

    families

    settlements

PHASE 4:

    culture

    language

    technology

    civilization

PHASE 5:

    politics

    diplomacy

    war

    migration

PHASE 6:

    exploration

    advanced technology

    planetary-scale civilization

PHASE 7:

    solar system

    moons

    space exploration

Do not fake later systems before the underlying architecture supports them.
37. DEBUGGING / OBSERVABILITY

Create a developer simulation dashboard.

Show:

SIMULATION YEAR
POPULATION
SPECIES
CIVILIZATIONS
CITIES
LANGUAGES
TECHNOLOGIES
WARS
DISCOVERIES
ACTIVE EVENTS

Allow developers to inspect any entity.

Add simulation logs.

Add deterministic replay where possible.

If something strange happens, we need to be able to determine WHY.
38. THE GOLDEN RULE

The most important rule of the entire project:

    Do not make the inhabitants pretend to be alive. Build systems that give them reasons to behave alive.

Avoid scripted NPC behavior wherever possible.

The simulation should produce unexpected outcomes.

If the developer cannot predict which civilization will become dominant, that's good.

If an unexpected individual becomes historically important, that's good.

If a tiny isolated culture survives for 5,000 years, that's good.

If an empire unexpectedly collapses because of a chain of seemingly insignificant events, that's good.

The goal is not to create a perfect simulation of Earth.

The goal is to create a believable artificial world with its own history.
39. FINAL EXPERIENCE

When the application is complete, the user should be able to open it and feel:

    “This world was already alive before I arrived.”

They should be able to zoom from the edge of the solar system into a continent, find a tiny city, select a random person, follow their life, discover their family, trace their ancestors back hundreds of generations, discover that their civilization was founded by an exile, and then zoom back out to see that the civilization has spread across half the planet.

The user should never know exactly what will happen next.

That unpredictability is the point.

Build a universe, not a game.

I'd also tell Claude Code not to try to build all of this in one shot. Start by having it architect the simulation and deliver a playable vertical slice: planet → terrain → time → animals → 1,000-ish simulated people → settlement → generations → emergent civilization → observer camera. Once that loop is genuinely fun to watch, keep expanding the universe.

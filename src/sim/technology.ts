/**
 * Technologies are discovered, not unlocked on a timeline. Each has prerequisites, resource needs and real consequences,
 * and each is earned: a community first gets the idea, then experiments (spending materials, failing, sometimes at a cost
 * in lives), until an attempt succeeds; it then has to practise the art for generations before it is mastered — and an art
 * that stops being practised, or whose experts die, can be lost again. The research itself lives in src/sim/research.ts.
 */
import type { BKind, ResKey } from './buildings';

export type TechId =
  | 'fire' | 'tools' | 'agriculture' | 'pottery' | 'weaving' | 'metallurgy' | 'architecture'
  | 'writing' | 'mathematics' | 'navigation' | 'engineering'
  | 'ironworking' | 'astronomy' | 'seafaring' | 'medicine' | 'printing' | 'chemistry' | 'gunpowder' | 'steam' | 'industry'
  | 'electricity' | 'combustion' | 'radio' | 'flight' | 'computing' | 'rocketry' | 'spaceflight';

/** What can go wrong when an attempt fails badly (or an art is still crude). */
export type Hazard = 'none' | 'fire' | 'harvest' | 'collapse' | 'wreck' | 'poison' | 'explosion' | 'crash' | 'shock';
/** Where the art is practised once it works (practice is what turns a first success into mastery). */
export type Practice = 'farm' | 'kiln' | 'smithy' | 'masonry' | 'ships' | 'scholars' | 'healers' | 'warriors' | 'mills' | 'factory' | 'power' | 'airport' | 'pad';

export interface TechDef {
  id: TechId;
  name: string;
  prereq: TechId[];
  /** Minimum settlement population for the idea to be viable. */
  minPop: number;
  /** Minimum population of the whole polity (late ideas need a large society behind them). */
  civPop?: number;
  /** Relative difficulty: expected person-years of inventive effort. */
  difficulty: number;
  /** Local resources (cell abundance 0..1 within reach) that make the discovery plausible. */
  needs?: { stone?: number; clay?: number; copper?: number; iron?: number; coal?: number; coast?: number; fert?: number; wood?: number };
  description: string;
  impact: string[];
  /** what a bad failure does, and how many people it typically kills */
  hazard: Hazard;
  danger: number;
  /** materials each attempt uses up */
  trial?: Partial<Record<ResKey | 'food', number>>;
  practice?: Practice;
  /** a finished building some member of the polity must have before experiments can go on */
  facility?: BKind;
  /** the opening of an era: its first success is one of history's great moments */
  era?: true;
  /** "<who> …" on first success; a plain failure; a bad failure */
  success: string;
  miss: string;
  fail?: string;
}

/** Research stages: 1 idea, 2 experiments, 3 first success (crude), 4 refining, 5 mastered. */
export type Stage = 1 | 2 | 3 | 4 | 5;
export const STAGE_WORD = ['', 'idea', 'experiments', 'new', 'refining', 'mastered'];

/** One community's work on one technology (saved with the settlement). */
export interface TechProgress {
  st: Stage;
  /** day the idea arose, day the current stage began, day of the last attempt */
  d0: number; d: number; la: number;
  /** work accrued toward the next attempt */
  w: number;
  /** consecutive seasons the experiments could not go on */
  bl: number;
  /** last season's research rate per year (for the panels) */
  r: number;
  /** lessons learned from failures, 0..10 */
  xp: number;
  /** attempts, failures, lives lost here */
  n: number; f: number; k: number;
  /** mastery 0..1 and its peak */
  m: number; pk: number;
  /** who leads the work, and up to three earlier leads (oldest first) */
  lead: number; pl: number[];
  /** day of this record's last chronicled event */
  ev: number;
  /** settlement that taught it (0 = its own work) */
  by: number;
  /** grief: recent deaths in the work (fades each season) */
  g: number;
  /** shelved until this day (stage 1 only), and why */
  until: number; why?: 'deaths' | 'stalled' | 'lost';
}

/** The world's record of an achievement: who first managed it, at what cost, and when it was mastered or lost. */
export interface Ledger {
  /** day of the first success (-1 not yet, -2 before records began), by whom, where, which polity, how long it took */
  first: number; by: number; at: number; civ: number; took: number;
  /** attempts, failures and lives lost before the first success */
  pre: [number, number, number];
  /** programmes ever started */
  p: number;
  /** first mastered (-1 not yet), where */
  mastered: number; mAt: number;
  /** attempts, failures, lives lost in all */
  n: number; f: number; k: number;
  /** day of the last frontier catastrophe chronicled as major; day the art was lost to the whole world (-1 never) */
  big: number; lost: number;
}
export type FeatId = 'satellite' | 'orbit' | 'moon';
export interface Research { ledger: Partial<Record<TechId | FeatId, Ledger>>; lastMajor: number }

export const TECHS: Record<TechId, TechDef> = {
  fire: { id: 'fire', name: 'Fire', prereq: [], minPop: 6, difficulty: 8, description: 'the control of fire',
    impact: ['+ warmth through cold seasons', '+ cooked food, fewer illnesses', '+ safety from predators at night'],
    hazard: 'fire', danger: 0, trial: { wood: 4 },
    success: "learned to kindle fire at will and keep it", miss: "the flame would not stay lit", fail: "a fire got out of hand" },
  tools: { id: 'tools', name: 'Stone tools', prereq: [], minPop: 6, difficulty: 10, needs: { stone: 0.25 }, description: 'the shaping of stone into tools',
    impact: ['+ more efficient foraging and hunting', '+ building materials'],
    hazard: 'none', danger: 0, trial: { stone: 3 },
    success: "learned to knap stone into reliable tools", miss: "the stone shattered more often than it took an edge" },
  agriculture: { id: 'agriculture', name: 'Agriculture', prereq: ['tools', 'fire'], minPop: 20, difficulty: 60, needs: { fert: 0.35 },
    description: 'the deliberate cultivation of plants', impact: ['+ farmland feeds far larger populations', '+ permanent settlements', '+ food surplus'],
    hazard: 'harvest', danger: 0, trial: { food: 15 }, practice: 'farm', era: true,
    success: "brought in the first deliberate harvest", miss: "the seed they sowed never came up", fail: "the planted plots failed and the seed was lost" },
  pottery: { id: 'pottery', name: 'Pottery', prereq: ['fire'], minPop: 20, difficulty: 40, needs: { clay: 0.2 },
    description: 'fired clay vessels', impact: ['+ food storage, less spoilage', '+ trade goods'],
    hazard: 'fire', danger: 0, trial: { clay: 6, wood: 6 }, practice: 'kiln',
    success: "fired clay pots that did not crack", miss: "every pot cracked in the fire", fail: "a firing set the shelters alight" },
  weaving: { id: 'weaving', name: 'Weaving', prereq: ['tools'], minPop: 15, difficulty: 35, needs: { wood: 0.2 },
    description: 'woven cloth and cordage', impact: ['+ clothing, tolerance of cold', '+ nets and ropes'],
    hazard: 'none', danger: 0, trial: { wood: 4 },
    success: "wove the first lasting cloth", miss: "the cloth fell apart" },
  metallurgy: { id: 'metallurgy', name: 'Metallurgy', prereq: ['pottery', 'fire', 'tools'], minPop: 60, difficulty: 160, needs: { copper: 0.2 },
    description: 'smelting metal from ore', impact: ['+ stronger tools', '+ stronger weapons', '+ new architecture'],
    hazard: 'fire', danger: 1, trial: { copper: 2, wood: 20 }, practice: 'smithy',
    success: "smelted the first metal from ore", miss: "the furnace gave only slag", fail: "a furnace burst and set the workshop alight" },
  architecture: { id: 'architecture', name: 'Architecture', prereq: ['tools', 'agriculture'], minPop: 80, difficulty: 120, needs: { stone: 0.2 },
    description: 'planned, durable buildings', impact: ['+ larger, healthier towns', '+ monumental structures'],
    hazard: 'collapse', danger: 3, trial: { stone: 40, wood: 10 }, practice: 'masonry',
    success: "raised the first planned stone building that stood", miss: "the walls cracked before the roof went on", fail: "a building under construction collapsed" },
  writing: { id: 'writing', name: 'Writing', prereq: ['agriculture', 'pottery'], minPop: 140, difficulty: 320,
    description: 'a system of written records', impact: ['+ knowledge is preserved', '+ larger polities can be administered', '+ history is recorded'],
    hazard: 'none', danger: 0, trial: { clay: 4 }, practice: 'scholars', era: true,
    success: "set down the first lasting written records", miss: "no one else could read the marks" },
  mathematics: { id: 'mathematics', name: 'Mathematics', prereq: ['writing'], minPop: 170, difficulty: 420,
    description: 'systematic numbers and geometry', impact: ['+ surveying and accounting', '+ better crop yields'],
    hazard: 'none', danger: 0, practice: 'scholars',
    success: "worked out a system of numbers and geometry", miss: "their reckonings never agreed" },
  navigation: { id: 'navigation', name: 'Navigation', prereq: ['weaving', 'tools'], minPop: 100, difficulty: 260, needs: { coast: 0.5 },
    description: 'seaworthy boats and wayfinding', impact: ['+ crossing of narrow seas', '+ coastal trade'],
    hazard: 'wreck', danger: 4, trial: { wood: 50 }, practice: 'ships',
    success: "built boats that crossed narrow seas and came back", miss: "the boats leaked and turned back", fail: "a boat was lost at sea" },
  engineering: { id: 'engineering', name: 'Engineering', prereq: ['mathematics', 'architecture'], minPop: 240, difficulty: 650,
    description: 'applied mechanics and large works', impact: ['+ irrigation and aqueducts', '+ monumental cities'],
    hazard: 'collapse', danger: 4, trial: { stone: 80, wood: 30 }, practice: 'masonry',
    success: "completed the first great engineered work", miss: "the great work cracked and was pulled down", fail: "a great work collapsed during construction" },
  ironworking: { id: 'ironworking', name: 'Ironworking', prereq: ['metallurgy'], minPop: 120, difficulty: 260, needs: { iron: 0.2 },
    description: 'smelting and forging iron', impact: ['+ iron tools: faster work in field, forest and mine', '+ iron weapons'],
    hazard: 'fire', danger: 1, trial: { iron: 3, coal: 2, wood: 15 }, practice: 'smithy',
    success: "forged the first iron", miss: "the iron came out brittle", fail: "a bloomery furnace exploded" },
  astronomy: { id: 'astronomy', name: 'Astronomy', prereq: ['mathematics'], minPop: 170, difficulty: 380,
    description: 'charting the sky', impact: ['+ an accurate calendar for sowing', '+ stars to steer by: the way to open-ocean voyages'],
    hazard: 'none', danger: 0, practice: 'scholars',
    success: "charted the sky well enough to keep a true calendar", miss: "their calendar drifted from the seasons" },
  seafaring: { id: 'seafaring', name: 'Seafaring', prereq: ['navigation', 'astronomy'], minPop: 120, difficulty: 300, needs: { coast: 0.5 },
    description: 'the crossing of the open ocean', impact: ['+ ships cross any ocean', '+ colonies and trade across the sea'],
    hazard: 'wreck', danger: 5, trial: { wood: 60 }, practice: 'ships',
    success: "crossed the open ocean and came home", miss: "the expedition turned back with its water running out", fail: "an expedition sailed into the open ocean and was never seen again" },
  medicine: { id: 'medicine', name: 'Medicine', prereq: ['writing', 'pottery'], minPop: 160, difficulty: 420,
    description: 'systematic medicine', impact: ['+ fewer deaths from illness and childbirth', '+ epidemics spread less'],
    hazard: 'poison', danger: 2, practice: 'healers',
    success: "found remedies that reliably cured", miss: "the remedies did no good", fail: "an untried remedy killed the sick it was meant to cure" },
  printing: { id: 'printing', name: 'Printing', prereq: ['writing', 'metallurgy'], minPop: 150, civPop: 300, difficulty: 560,
    description: 'printing with movable type', impact: ['+ ideas spread far faster', '+ more inventors'],
    hazard: 'none', danger: 0, trial: { metal: 2, wood: 10 }, practice: 'scholars', era: true,
    success: "printed the first book with movable type", miss: "the type would not print cleanly" },
  chemistry: { id: 'chemistry', name: 'Chemistry', prereq: ['metallurgy', 'mathematics'], minPop: 160, civPop: 320, difficulty: 640,
    description: 'the science of substances', impact: ['+ fertilisers', '+ better metals', '+ the way to explosives and fuels'],
    hazard: 'poison', danger: 2, trial: { copper: 1, coal: 3 }, practice: 'scholars',
    success: "separated substances by method rather than luck", miss: "the mixtures gave nothing useful", fail: "poisonous fumes filled a workshop" },
  gunpowder: { id: 'gunpowder', name: 'Gunpowder', prereq: ['chemistry'], minPop: 150, difficulty: 420,
    description: 'explosive powder', impact: ['+ firearms and cannon: armies and walls are transformed'],
    hazard: 'explosion', danger: 3, trial: { coal: 4 }, practice: 'warriors',
    success: "mixed a powder that burned with explosive force", miss: "the powder only fizzled", fail: "a batch of powder exploded" },
  steam: { id: 'steam', name: 'Steam power', prereq: ['engineering', 'ironworking'], minPop: 170, civPop: 360, difficulty: 900, needs: { coal: 0.12 },
    description: 'the steam engine', impact: ['+ mechanised mines and mills', '+ steamships cross any ocean', '+ railways'],
    hazard: 'explosion', danger: 3, trial: { metal: 6, coal: 10 }, practice: 'mills', era: true,
    success: "built a steam engine that ran without bursting", miss: "the engine would not turn", fail: "a boiler burst" },
  industry: { id: 'industry', name: 'Industry', prereq: ['steam', 'chemistry'], minPop: 180, civPop: 400, difficulty: 1000,
    description: 'factories and mass production', impact: ['+ factories: goods in abundance', '+ machine farming', '- smoke and cleared land'],
    hazard: 'explosion', danger: 2, trial: { metal: 10, coal: 15 }, practice: 'factory',
    success: "opened the first factory of powered machines", miss: "the machines jammed and broke", fail: "machinery tore itself apart" },
  electricity: { id: 'electricity', name: 'Electricity', prereq: ['steam', 'chemistry'], minPop: 190, civPop: 420, difficulty: 1100,
    description: 'generating and distributing electric power', impact: ['+ power stations and electric light', '+ the path to radio and computers'],
    hazard: 'shock', danger: 1, trial: { metal: 6, copper: 4 }, practice: 'power', era: true,
    success: "generated electric power and carried it by wire", miss: "the generator burned out", fail: "an experimenter was killed by an electric shock" },
  combustion: { id: 'combustion', name: 'Combustion engine', prereq: ['industry'], minPop: 190, civPop: 420, difficulty: 1050,
    description: 'the internal combustion engine', impact: ['+ motor vehicles: people and goods move far faster', '+ tractors'],
    hazard: 'explosion', danger: 2, trial: { metal: 8, coal: 6 }, practice: 'factory',
    success: "ran the first internal combustion engine", miss: "the engine seized", fail: "an engine exploded on its test bench" },
  radio: { id: 'radio', name: 'Radio', prereq: ['electricity'], minPop: 190, civPop: 440, difficulty: 1000,
    description: 'communication by radio waves', impact: ['+ distant provinces stay connected', '+ news and propaganda'],
    hazard: 'none', danger: 0, trial: { metal: 3, copper: 3 }, practice: 'power',
    success: "sent the first message by radio", miss: "no signal crossed the hills" },
  flight: { id: 'flight', name: 'Flight', prereq: ['combustion', 'mathematics'], minPop: 200, civPop: 460, difficulty: 1300,
    description: 'powered flight', impact: ['+ airports and air routes between cities', '+ air power'],
    hazard: 'crash', danger: 1, trial: { metal: 10, wood: 30 }, practice: 'airport', era: true,
    success: "made the first powered flight", miss: "the machine would not leave the ground", fail: "a flying machine crashed" },
  computing: { id: 'computing', name: 'Computing', prereq: ['electricity', 'radio', 'mathematics'], minPop: 210, civPop: 500, difficulty: 1600,
    description: 'programmable computers', impact: ['+ research accelerates', '+ guidance for rockets'],
    hazard: 'none', danger: 0, trial: { metal: 4, copper: 6 }, practice: 'scholars',
    success: "ran the first program on a computing machine", miss: "the machine never gave the same answer twice" },
  rocketry: { id: 'rocketry', name: 'Rocketry', prereq: ['combustion', 'chemistry', 'astronomy'], minPop: 200, civPop: 480, difficulty: 1500,
    description: 'liquid-fuelled rockets', impact: ['+ launch sites', '+ the first artificial satellites'],
    hazard: 'explosion', danger: 2, trial: { metal: 20, coal: 20 }, practice: 'pad', era: true,
    success: "launched a liquid-fuelled rocket to the edge of space", miss: "the rocket failed to ignite", fail: "a test rocket exploded on its stand" },
  spaceflight: { id: 'spaceflight', name: 'Spaceflight', prereq: ['rocketry', 'computing'], minPop: 220, civPop: 540, difficulty: 2000,
    description: 'crewed spaceflight', impact: ['+ astronauts and space stations', '+ landings on the moon', '+ probes to the other planets'],
    hazard: 'explosion', danger: 1, trial: { metal: 40, coal: 30 }, practice: 'pad', facility: 'launchpad', era: true,
    success: "flew a capsule to orbit and brought it home", miss: "an uncrewed capsule failed to reach orbit", fail: "an uncrewed capsule was lost on launch" },
};
export const TECH_IDS = Object.keys(TECHS) as TechId[];

export type TechSet = Set<TechId>;

export function techScore(t: TechSet): number {
  let s = 0;
  for (const id of t) s += Math.log2(2 + TECHS[id].difficulty);
  return s;
}

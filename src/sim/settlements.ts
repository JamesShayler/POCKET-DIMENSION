import type { TechId, TechProgress, TechSet } from './technology';
import type { Stock } from './buildings';

export type Stage = 'camp' | 'settlement' | 'village' | 'town' | 'city';
export type Government =
  | 'tribal leadership' | 'council' | 'monarchy' | 'republic' | 'theocracy' | 'dictatorship' | 'anarchy';

export interface Settlement {
  id: number;
  name: string;
  x: number;
  y: number;
  culture: number;
  civ: number;
  founded: number;
  founder: number;
  parent: number; // settlement it split from, 0 if none
  abandoned: number; // day, -1 if inhabited
  tech: TechSet;
  food: number;
  goods: number;
  housing: number;
  /** physical stockpile of materials */
  res: Stock;
  /** what the community currently lacks (0..1), drives who works at what */
  need: Record<string, number>;
  /** this town's work on each art: ideas, experiments, mastery (see research.ts) */
  prog: Partial<Record<TechId, TechProgress>>;
  /** materials set aside for the great work the town is saving toward (kept out of trade, crafts and lesser projects) */
  reserve?: Partial<Record<string, number>>;
  toolTier: number; // 0 bare hands, 1 stone, 2 bronze/copper, 3 iron
  wealth: number;
  range: number; // km people will range from the centre for materials
  scarce: Record<string, number>; // day a lookup last failed, per kind
  nomadic: boolean;
  permanent: boolean;
  stage: Stage;
  pop: number;
  peak: number;
  knownKm: number;
  stress: number; // 0..1 smoothed food stress
  stressSeasons: number;
  surplus: number; // last season's (production - consumption)/consumption
  produced: number;
  consumed: number;
  drift: number; // cultural drift accumulating since the culture's reference
  langDrift: number;
  disease: number; // severity 0..1 while an epidemic is active
  diseaseUntil: number;
  leader: number;
  defense: number;
  cohesion: number;
  threat: number;
  lastRaid: number;
  occupations: Record<string, number>;
  originNote: string;
  yearsSettled: number;
  /** seaworthy vessels moored at the docks (trade, fishing fleets, navies) */
  ships: number;
  /** the vassal lord who governs this town for a distant ruler (0 = governed directly), and how loyal they are */
  lord: number;
  loyalty: number;
}

export interface Civ {
  id: number;
  name: string;
  culture: number;
  capital: number;
  members: number[];
  government: Government;
  leader: number;
  lastLeader: number;
  founded: number;
  collapsed: number; // -1 alive
  legitimacy: number; // -1..1
  parent: number;
  pop: number;
  territory: number; // km^2 estimate
  rank: string;
  note: string;
}

export function stageFor(pop: number, nomadic: boolean): Stage {
  if (pop < 20 || nomadic && pop < 45) return 'camp';
  if (pop < 60) return 'settlement';
  if (pop < 200) return 'village';
  if (pop < 800) return 'town';
  return 'city';
}

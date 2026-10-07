/** Technologies are discovered, not unlocked on a timeline. Each has prerequisites, resource needs and real consequences. */

export type TechId =
  | 'fire' | 'tools' | 'agriculture' | 'pottery' | 'weaving' | 'metallurgy' | 'architecture'
  | 'writing' | 'mathematics' | 'navigation' | 'engineering';

export interface TechDef {
  id: TechId;
  name: string;
  prereq: TechId[];
  /** Minimum settlement population for the idea to be viable. */
  minPop: number;
  /** Relative difficulty: expected person-years of inventive effort. */
  difficulty: number;
  /** Local resources (cell abundance 0..1 within reach) that make the discovery plausible. */
  needs?: { stone?: number; clay?: number; copper?: number; iron?: number; coast?: number; fert?: number; wood?: number };
  description: string;
  impact: string[];
}

export const TECHS: Record<TechId, TechDef> = {
  fire: { id: 'fire', name: 'Fire', prereq: [], minPop: 6, difficulty: 8, description: 'the control of fire',
    impact: ['+ warmth through cold seasons', '+ cooked food, fewer illnesses', '+ safety from predators at night'] },
  tools: { id: 'tools', name: 'Stone tools', prereq: [], minPop: 6, difficulty: 10, needs: { stone: 0.25 }, description: 'the shaping of stone into tools',
    impact: ['+ more efficient foraging and hunting', '+ building materials'] },
  agriculture: { id: 'agriculture', name: 'Agriculture', prereq: ['tools', 'fire'], minPop: 20, difficulty: 60, needs: { fert: 0.35 },
    description: 'the deliberate cultivation of plants', impact: ['+ farmland feeds far larger populations', '+ permanent settlements', '+ food surplus'] },
  pottery: { id: 'pottery', name: 'Pottery', prereq: ['fire'], minPop: 20, difficulty: 40, needs: { clay: 0.2 },
    description: 'fired clay vessels', impact: ['+ food storage, less spoilage', '+ trade goods'] },
  weaving: { id: 'weaving', name: 'Weaving', prereq: ['tools'], minPop: 15, difficulty: 35, needs: { wood: 0.2 },
    description: 'woven cloth and cordage', impact: ['+ clothing, tolerance of cold', '+ nets and ropes'] },
  metallurgy: { id: 'metallurgy', name: 'Metallurgy', prereq: ['pottery', 'fire', 'tools'], minPop: 60, difficulty: 160, needs: { copper: 0.2 },
    description: 'smelting metal from ore', impact: ['+ stronger tools', '+ stronger weapons', '+ new architecture'] },
  architecture: { id: 'architecture', name: 'Architecture', prereq: ['tools', 'agriculture'], minPop: 80, difficulty: 120, needs: { stone: 0.2 },
    description: 'planned, durable buildings', impact: ['+ larger, healthier towns', '+ monumental structures'] },
  writing: { id: 'writing', name: 'Writing', prereq: ['agriculture', 'pottery'], minPop: 200, difficulty: 320,
    description: 'a system of written records', impact: ['+ knowledge is preserved', '+ larger polities can be administered', '+ history is recorded'] },
  mathematics: { id: 'mathematics', name: 'Mathematics', prereq: ['writing'], minPop: 300, difficulty: 420,
    description: 'systematic numbers and geometry', impact: ['+ surveying and accounting', '+ better crop yields'] },
  navigation: { id: 'navigation', name: 'Navigation', prereq: ['weaving', 'tools'], minPop: 100, difficulty: 260, needs: { coast: 0.5 },
    description: 'seaworthy boats and wayfinding', impact: ['+ crossing of narrow seas', '+ coastal trade'] },
  engineering: { id: 'engineering', name: 'Engineering', prereq: ['mathematics', 'architecture'], minPop: 600, difficulty: 700,
    description: 'applied mechanics and large works', impact: ['+ irrigation and aqueducts', '+ monumental cities'] },
};
export const TECH_IDS = Object.keys(TECHS) as TechId[];

export type TechSet = Set<TechId>;

export function techScore(t: TechSet): number {
  let s = 0;
  for (const id of t) s += Math.log2(2 + TECHS[id].difficulty);
  return s;
}

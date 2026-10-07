/** Technologies are discovered, not unlocked on a timeline. Each has prerequisites, resource needs and real consequences. */

export type TechId =
  | 'fire' | 'tools' | 'agriculture' | 'pottery' | 'weaving' | 'metallurgy' | 'architecture'
  | 'writing' | 'mathematics' | 'navigation' | 'engineering'
  | 'ironworking' | 'astronomy' | 'medicine' | 'printing' | 'chemistry' | 'gunpowder' | 'steam' | 'industry'
  | 'electricity' | 'combustion' | 'radio' | 'flight' | 'computing' | 'rocketry' | 'spaceflight';

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
  writing: { id: 'writing', name: 'Writing', prereq: ['agriculture', 'pottery'], minPop: 140, difficulty: 320,
    description: 'a system of written records', impact: ['+ knowledge is preserved', '+ larger polities can be administered', '+ history is recorded'] },
  mathematics: { id: 'mathematics', name: 'Mathematics', prereq: ['writing'], minPop: 170, difficulty: 420,
    description: 'systematic numbers and geometry', impact: ['+ surveying and accounting', '+ better crop yields'] },
  navigation: { id: 'navigation', name: 'Navigation', prereq: ['weaving', 'tools'], minPop: 100, difficulty: 260, needs: { coast: 0.5 },
    description: 'seaworthy boats and wayfinding', impact: ['+ crossing of narrow seas', '+ coastal trade'] },
  engineering: { id: 'engineering', name: 'Engineering', prereq: ['mathematics', 'architecture'], minPop: 240, difficulty: 650,
    description: 'applied mechanics and large works', impact: ['+ irrigation and aqueducts', '+ monumental cities'] },
  ironworking: { id: 'ironworking', name: 'Ironworking', prereq: ['metallurgy'], minPop: 120, difficulty: 260, needs: { iron: 0.2 },
    description: 'smelting and forging iron', impact: ['+ iron tools: faster work in field, forest and mine', '+ iron weapons'] },
  astronomy: { id: 'astronomy', name: 'Astronomy', prereq: ['mathematics'], minPop: 170, difficulty: 380,
    description: 'charting the sky', impact: ['+ an accurate calendar for sowing', '+ open-ocean navigation by the stars'] },
  medicine: { id: 'medicine', name: 'Medicine', prereq: ['writing', 'pottery'], minPop: 160, difficulty: 420,
    description: 'systematic medicine', impact: ['+ fewer deaths from illness and childbirth', '+ epidemics spread less'] },
  printing: { id: 'printing', name: 'Printing', prereq: ['writing', 'metallurgy'], minPop: 200, civPop: 500, difficulty: 560,
    description: 'printing with movable type', impact: ['+ ideas spread far faster', '+ more inventors'] },
  chemistry: { id: 'chemistry', name: 'Chemistry', prereq: ['metallurgy', 'mathematics'], minPop: 210, civPop: 600, difficulty: 640,
    description: 'the science of substances', impact: ['+ fertilisers', '+ better metals', '+ the way to explosives and fuels'] },
  gunpowder: { id: 'gunpowder', name: 'Gunpowder', prereq: ['chemistry'], minPop: 180, difficulty: 420,
    description: 'explosive powder', impact: ['+ firearms and cannon: armies and walls are transformed'] },
  steam: { id: 'steam', name: 'Steam power', prereq: ['engineering', 'ironworking'], minPop: 250, civPop: 800, difficulty: 900, needs: { coal: 0.12 },
    description: 'the steam engine', impact: ['+ mechanised mines and mills', '+ steamships cross any ocean', '+ railways'] },
  industry: { id: 'industry', name: 'Industry', prereq: ['steam', 'chemistry'], minPop: 280, civPop: 1000, difficulty: 1000,
    description: 'factories and mass production', impact: ['+ factories: goods in abundance', '+ machine farming', '- smoke and cleared land'] },
  electricity: { id: 'electricity', name: 'Electricity', prereq: ['steam', 'chemistry'], minPop: 300, civPop: 1200, difficulty: 1100,
    description: 'generating and distributing electric power', impact: ['+ power stations and electric light', '+ the path to radio and computers'] },
  combustion: { id: 'combustion', name: 'Combustion engine', prereq: ['industry'], minPop: 300, civPop: 1200, difficulty: 1050,
    description: 'the internal combustion engine', impact: ['+ motor vehicles: people and goods move far faster', '+ tractors'] },
  radio: { id: 'radio', name: 'Radio', prereq: ['electricity'], minPop: 300, civPop: 1300, difficulty: 1000,
    description: 'communication by radio waves', impact: ['+ distant provinces stay connected', '+ news and propaganda'] },
  flight: { id: 'flight', name: 'Flight', prereq: ['combustion', 'mathematics'], minPop: 320, civPop: 1500, difficulty: 1300,
    description: 'powered flight', impact: ['+ airports and air routes between cities', '+ air power'] },
  computing: { id: 'computing', name: 'Computing', prereq: ['electricity', 'radio', 'mathematics'], minPop: 340, civPop: 1800, difficulty: 1600,
    description: 'programmable computers', impact: ['+ research accelerates', '+ guidance for rockets'] },
  rocketry: { id: 'rocketry', name: 'Rocketry', prereq: ['combustion', 'chemistry', 'astronomy'], minPop: 330, civPop: 1600, difficulty: 1500,
    description: 'liquid-fuelled rockets', impact: ['+ launch sites', '+ the first artificial satellites'] },
  spaceflight: { id: 'spaceflight', name: 'Spaceflight', prereq: ['rocketry', 'computing'], minPop: 380, civPop: 2200, difficulty: 2000,
    description: 'crewed spaceflight', impact: ['+ astronauts and space stations', '+ landings on the moon', '+ probes to the other planets'] },
};
export const TECH_IDS = Object.keys(TECHS) as TechId[];

export type TechSet = Set<TechId>;

export function techScore(t: TechSet): number {
  let s = 0;
  for (const id of t) s += Math.log2(2 + TECHS[id].difficulty);
  return s;
}

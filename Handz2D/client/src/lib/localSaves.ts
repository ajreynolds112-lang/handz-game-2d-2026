import type { Fighter, InsertFighter, FightResult, InsertFightResult } from "@shared/schema";

const SAVES_KEY = "handz_saves";
const FIGHT_RESULTS_KEY = "handz_fight_results";

function generateId(): string {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

function loadSaves(): Fighter[] {
  try {
    const raw = localStorage.getItem(SAVES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function persistSaves(fighters: Fighter[]): void {
  localStorage.setItem(SAVES_KEY, JSON.stringify(fighters));
}

function loadFightResults(): FightResult[] {
  try {
    const raw = localStorage.getItem(FIGHT_RESULTS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function persistFightResults(results: FightResult[]): void {
  localStorage.setItem(FIGHT_RESULTS_KEY, JSON.stringify(results));
}

export function getFighters(): Fighter[] {
  return loadSaves();
}

export function getFighter(id: string): Fighter | undefined {
  return loadSaves().find(f => f.id === id);
}

export function createFighter(data: InsertFighter): Fighter {
  const fighters = loadSaves();
  const fighter: Fighter = {
    id: generateId(),
    name: data.name,
    firstName: data.firstName ?? "",
    nickname: data.nickname ?? "",
    lastName: data.lastName ?? "",
    archetype: data.archetype ?? "BoxerPuncher",
    level: data.level ?? 1,
    xp: data.xp ?? 0,
    wins: data.wins ?? 0,
    losses: data.losses ?? 0,
    draws: data.draws ?? 0,
    knockouts: data.knockouts ?? 0,
    skillPoints: data.skillPoints ?? { power: 0, speed: 0, defense: 0, stamina: 0, focus: 0 },
    availableStatPoints: data.availableStatPoints ?? 0,
    careerBoutIndex: data.careerBoutIndex ?? 0,
    careerDifficulty: data.careerDifficulty ?? "contender",
    roundLengthMins: data.roundLengthMins ?? 3,
    careerStats: data.careerStats ?? { totalPunchesThrown: 0, totalPunchesLanded: 0, totalKnockdownsGiven: 0, totalKnockdownsTaken: 0, totalBlocksMade: 0, totalDodges: 0, totalDamageDealt: 0, totalDamageReceived: 0, totalRoundsWon: 0, totalRoundsLost: 0, lifetimeXp: 0 },
    skinColor: data.skinColor ?? "#e8c4a0",
    gearColors: data.gearColors ?? { gloves: "#cc2222", gloveTape: "#eeeeee", trunks: "#2244aa", shoes: "#1a1a1a" },
    trainingBonuses: data.trainingBonuses ?? { weightLifting: 0, heavyBag: 0, sparring: 0 },
    careerRosterState: data.careerRosterState ?? null,
    createdAt: new Date(),
  };
  fighters.push(fighter);
  persistSaves(fighters);
  return fighter;
}

export function updateFighter(id: string, data: Partial<InsertFighter>): Fighter | undefined {
  const fighters = loadSaves();
  const idx = fighters.findIndex(f => f.id === id);
  if (idx === -1) return undefined;
  fighters[idx] = { ...fighters[idx], ...data };
  persistSaves(fighters);
  return fighters[idx];
}

export function deleteFighter(id: string): void {
  const fighters = loadSaves().filter(f => f.id !== id);
  persistSaves(fighters);
  const results = loadFightResults().filter(r => r.fighterId !== id);
  persistFightResults(results);
}

export function createFightResult(data: InsertFightResult): FightResult {
  const results = loadFightResults();
  const result: FightResult = {
    id: generateId(),
    fighterId: data.fighterId,
    opponentName: data.opponentName,
    opponentLevel: data.opponentLevel,
    opponentArchetype: data.opponentArchetype ?? "BoxerPuncher",
    result: data.result,
    method: data.method,
    rounds: data.rounds,
    xpGained: data.xpGained ?? 0,
    boutNumber: data.boutNumber ?? 0,
    createdAt: new Date(),
  };
  results.push(result);
  persistFightResults(results);
  return result;
}

export function getFightResults(fighterId: string): FightResult[] {
  return loadFightResults().filter(r => r.fighterId === fighterId);
}

export interface SaveFileData {
  version: 1;
  fighter: Fighter;
  fightResults: FightResult[];
}

export function exportSaveFile(fighter: Fighter): SaveFileData {
  return {
    version: 1,
    fighter,
    fightResults: getFightResults(fighter.id),
  };
}

export function importSaveFile(data: SaveFileData): Fighter {
  if (!data || data.version !== 1 || !data.fighter) {
    throw new Error("Invalid save file format");
  }

  const newId = generateId();
  const fighter: Fighter = {
    ...data.fighter,
    id: newId,
    createdAt: new Date(),
  };

  const fighters = loadSaves();
  if (fighters.length >= 3) {
    throw new Error("All save slots are full");
  }
  fighters.push(fighter);
  persistSaves(fighters);

  if (data.fightResults && Array.isArray(data.fightResults)) {
    const results = loadFightResults();
    for (const fr of data.fightResults) {
      results.push({
        ...fr,
        id: generateId(),
        fighterId: newId,
      });
    }
    persistFightResults(results);
  }

  return fighter;
}

export function migrateFromServer(serverFighters: Fighter[], serverResults: FightResult[]): void {
  const existing = loadSaves();
  if (existing.length > 0) return;
  if (serverFighters.length === 0) return;
  persistSaves(serverFighters);
  persistFightResults(serverResults);
}

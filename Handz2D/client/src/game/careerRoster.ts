import type { CareerRosterState, RosterFighterState } from "@shared/schema";
import { ROSTER_DATA, KEY_FIGHTER_IDS, ACTIVE_ROSTER_SIZE, WEEKLY_FIGHT_COUNT, getRosterDisplayName, type RosterEntry } from "./rosterData";
import type { Archetype, AIDifficulty } from "./types";
import { SKIN_COLOR_PRESETS } from "./types";

const GLOVE_COLORS = ["#cc2222", "#1155cc", "#22aa22", "#ddaa00", "#aa22aa", "#ff6600", "#222222", "#ffffff"];
const TAPE_COLORS = ["#eeeeee", "#cccccc", "#222222"];
const TRUNK_COLORS = ["#222222", "#cc2222", "#1155cc", "#22aa22", "#ddaa00", "#aa22aa", "#ff6600", "#ffffff"];
const SHOE_COLORS = ["#1a1a1a", "#2a1a1a", "#222222", "#333333"];

function generateFighterColors(rng: () => number) {
  return {
    genSkinColor: SKIN_COLOR_PRESETS[Math.floor(rng() * SKIN_COLOR_PRESETS.length)],
    genGloves: GLOVE_COLORS[Math.floor(rng() * GLOVE_COLORS.length)],
    genGloveTape: TAPE_COLORS[Math.floor(rng() * TAPE_COLORS.length)],
    genTrunks: TRUNK_COLORS[Math.floor(rng() * TRUNK_COLORS.length)],
    genShoes: SHOE_COLORS[Math.floor(rng() * SHOE_COLORS.length)],
  };
}

const STYLE_MULTS: Record<Archetype, { power: number; speed: number; defense: number; stamina: number; focus: number }> = {
  BoxerPuncher: { power: 1.05, speed: 1.00, defense: 1.00, stamina: 1.00, focus: 1.00 },
  OutBoxer:     { power: 0.85, speed: 1.20, defense: 1.15, stamina: 1.00, focus: 1.05 },
  Brawler:      { power: 1.25, speed: 0.80, defense: 0.90, stamina: 1.00, focus: 0.95 },
  Swarmer:      { power: 1.10, speed: 1.15, defense: 0.85, stamina: 0.85, focus: 0.95 },
};

function generateFighterStats(rank: number, archetype: Archetype, rng: () => number, totalRanks: number = 150): { statPower: number; statSpeed: number; statDefense: number; statStamina: number; statFocus: number; overallRating: number } {
  if (rank === 1) {
    return { statPower: 200, statSpeed: 200, statDefense: 200, statStamina: 200, statFocus: 200, overallRating: 200 };
  }

  const baseStat = Math.max(20, Math.min(200, 20 + 180 * (1 - Math.pow((rank - 1) / totalRanks, 1.25))));
  const m = STYLE_MULTS[archetype];
  const varRange = baseStat * 0.12;

  const gen = (mult: number) => {
    const raw = baseStat * mult + (rng() * 2 - 1) * varRange;
    return Math.max(0, Math.min(200, Math.round(raw)));
  };

  const statPower = gen(m.power);
  const statSpeed = gen(m.speed);
  const statDefense = gen(m.defense);
  const statStamina = gen(m.stamina);
  const statFocus = gen(m.focus);
  const overallRating = Math.round((statPower + statSpeed + statDefense + statStamina + statFocus) / 5);

  return { statPower, statSpeed, statDefense, statStamina, statFocus, overallRating };
}

function enforceRankingIntegrity(roster: RosterFighterState[]): void {
  const active = roster.filter(f => f.active && f.rank > 0).sort((a, b) => a.rank - b.rank);
  for (let i = 1; i < active.length; i++) {
    const prev = active[i - 1];
    const curr = active[i];
    const prevRating = prev.overallRating ?? 0;
    const currRating = curr.overallRating ?? 0;
    if (currRating > prevRating) {
      const scale = prevRating / currRating * 0.98;
      curr.statPower = Math.round((curr.statPower ?? 0) * scale);
      curr.statSpeed = Math.round((curr.statSpeed ?? 0) * scale);
      curr.statDefense = Math.round((curr.statDefense ?? 0) * scale);
      curr.statStamina = Math.round((curr.statStamina ?? 0) * scale);
      curr.statFocus = Math.round((curr.statFocus ?? 0) * scale);
      curr.overallRating = Math.round(((curr.statPower ?? 0) + (curr.statSpeed ?? 0) + (curr.statDefense ?? 0) + (curr.statStamina ?? 0) + (curr.statFocus ?? 0)) / 5);
    }
  }
}

const ROSTER_CUSTOMIZATIONS_KEY = "handz_roster_customizations";

interface RosterCustomization {
  customFirstName?: string;
  customNickname?: string;
  customLastName?: string;
  customSkinColor?: string;
  customGloves?: string;
  customTrunks?: string;
  customShoes?: string;
}

export function loadRosterCustomizations(): Record<number, RosterCustomization> {
  try {
    const raw = localStorage.getItem(ROSTER_CUSTOMIZATIONS_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return {};
}

export function saveRosterCustomizations(roster: RosterFighterState[]): void {
  const customizations: Record<number, RosterCustomization> = loadRosterCustomizations();
  for (const f of roster) {
    const c: RosterCustomization = {};
    if (f.customFirstName) c.customFirstName = f.customFirstName;
    if (f.customNickname) c.customNickname = f.customNickname;
    if (f.customLastName) c.customLastName = f.customLastName;
    if (f.customSkinColor) c.customSkinColor = f.customSkinColor;
    if (f.customGloves) c.customGloves = f.customGloves;
    if (f.customTrunks) c.customTrunks = f.customTrunks;
    if (f.customShoes) c.customShoes = f.customShoes;
    if (Object.keys(c).length > 0) {
      customizations[f.id] = c;
    } else {
      delete customizations[f.id];
    }
  }
  localStorage.setItem(ROSTER_CUSTOMIZATIONS_KEY, JSON.stringify(customizations));
}

export function applyRosterCustomizations(roster: RosterFighterState[]): RosterFighterState[] {
  const customizations = loadRosterCustomizations();
  return roster.map(f => {
    const c = customizations[f.id];
    if (!c) return f;
    return {
      ...f,
      customFirstName: f.customFirstName ?? c.customFirstName,
      customNickname: f.customNickname ?? c.customNickname,
      customLastName: f.customLastName ?? c.customLastName,
      customSkinColor: f.customSkinColor ?? c.customSkinColor,
      customGloves: f.customGloves ?? c.customGloves,
      customTrunks: f.customTrunks ?? c.customTrunks,
      customShoes: f.customShoes ?? c.customShoes,
    };
  });
}

function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

const ELO_K = 20;

const DIFFICULTY_ELO_MULT: Record<string, number> = {
  journeyman: 0.75,
  contender: 1.0,
  elite: 1.25,
  champion: 1.5,
};

function eloExpected(ratingA: number, ratingB: number): number {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

type FightMethod = "close" | "dominant" | "ko";

function performanceFactor(method: FightMethod, isWin: boolean): number {
  if (isWin) {
    if (method === "ko") return 1.4;
    if (method === "dominant") return 1.25;
    return 1.0;
  } else {
    if (method === "ko") return 1.25;
    if (method === "dominant") return 1.1;
    return 0.9;
  }
}

export function computeEloChange(
  winnerRating: number,
  loserRating: number,
  method: FightMethod,
  difficultyMult: number,
  isChampionFight: boolean
): { winnerDelta: number; loserDelta: number } {
  const champWeight = isChampionFight ? 2.0 : 1.0;
  const expectedWin = eloExpected(winnerRating, loserRating);
  const expectedLose = eloExpected(loserRating, winnerRating);

  const winPerf = performanceFactor(method, true);
  const losePerf = performanceFactor(method, false);

  const winnerDelta = ELO_K * (1 - expectedWin) * winPerf * difficultyMult * champWeight;
  const loserDelta = ELO_K * (0 - expectedLose) * losePerf * difficultyMult * champWeight;

  return { winnerDelta, loserDelta };
}

function generateRecordForLevel(rng: () => number, level: number): Pick<RosterFighterState, "wins" | "losses" | "draws" | "knockouts" | "totalFights"> {
  const t = (level - 1) / 99;

  const minFights = Math.floor(t * 25);
  const maxFights = Math.floor(5 + t * 50);
  const totalFights = minFights + Math.floor(rng() * (maxFights - minFights + 1));

  if (totalFights === 0) {
    return { wins: 0, losses: 0, draws: 0, knockouts: 0, totalFights: 0 };
  }

  const baseWinRate = 0.30 + t * 0.55;
  const winRate = Math.max(0.1, Math.min(0.97, baseWinRate + (rng() * 0.10 - 0.05)));

  const wins = Math.round(totalFights * winRate);
  const remaining = totalFights - wins;
  const drawCount = rng() < 0.15 ? Math.floor(rng() * Math.min(3, remaining)) : 0;
  const losses = remaining - drawCount;
  const knockouts = Math.floor(wins * (0.3 + rng() * 0.4));

  return { wins, losses, draws: drawCount, knockouts, totalFights };
}

function generateUndefeatedRecord(rng: () => number, level: number): Pick<RosterFighterState, "wins" | "losses" | "draws" | "knockouts" | "totalFights"> {
  const t = (level - 1) / 99;
  const totalFights = Math.floor(20 + t * 35 + rng() * 10);
  const draws = rng() < 0.2 ? Math.floor(rng() * 2) : 0;
  const wins = totalFights - draws;
  const knockouts = Math.floor(wins * (0.4 + rng() * 0.3));
  return { wins, losses: 0, draws, knockouts, totalFights };
}

function difficultyForLevel(_level: number, careerDifficulty: AIDifficulty, rng: () => number): AIDifficulty {
  const roll = rng();

  if (careerDifficulty === "champion") {
    return roll < 0.15 ? "elite" : "champion";
  } else if (careerDifficulty === "elite") {
    if (roll < 0.15) return "contender";
    if (roll < 0.95) return "elite";
    return "champion";
  } else if (careerDifficulty === "contender") {
    if (roll < 0.10) return "journeyman";
    if (roll < 0.90) return "contender";
    return "elite";
  } else {
    if (roll < 0.25) return "journeyman";
    if (roll < 0.95) return "contender";
    return "elite";
  }
}

export function initRosterState(playerSeed: string, careerDifficulty?: AIDifficulty): CareerRosterState {
  let seed = 0;
  for (let i = 0; i < playerSeed.length; i++) {
    seed = ((seed << 5) - seed + playerSeed.charCodeAt(i)) | 0;
  }
  const rng = seededRandom(Math.abs(seed) + 42);
  const cd: AIDifficulty = careerDifficulty || "contender";

  const keyIds = new Set(KEY_FIGHTER_IDS);
  const keyEntries = ROSTER_DATA.filter(r => keyIds.has(r.id));
  const nonKeyEntries = ROSTER_DATA.filter(r => !keyIds.has(r.id));

  const hardestForDifficulty: Record<AIDifficulty, AIDifficulty> = {
    journeyman: "elite",
    contender: "elite",
    elite: "champion",
    champion: "champion",
  };
  const keyDifficulty = hardestForDifficulty[cd];

  const keySlots: number[] = [];
  const spreadStep = Math.floor(ACTIVE_ROSTER_SIZE * 0.4 / keyEntries.length);
  for (let i = 0; i < keyEntries.length; i++) {
    const base = 1 + i * spreadStep;
    const jitter = Math.floor(rng() * Math.max(1, spreadStep / 2));
    keySlots.push(Math.max(1, base + jitter));
  }
  keySlots.sort((a, b) => a - b);
  if (keySlots[0] !== 1) {
    const wolfIdx = keyEntries.findIndex(e => e.id === 204);
    if (wolfIdx >= 0) keySlots[wolfIdx] = 1;
    keySlots.sort((a, b) => a - b);
  }

  const totalSlots = ACTIVE_ROSTER_SIZE;
  const allRankSlots: { rankPos: number; entry: RosterEntry | null; isKey: boolean }[] = [];
  for (let r = 1; r <= totalSlots; r++) {
    allRankSlots.push({ rankPos: r, entry: null, isKey: false });
  }

  for (let i = 0; i < keyEntries.length; i++) {
    const slot = Math.min(keySlots[i], totalSlots);
    allRankSlots[slot - 1].entry = keyEntries[i];
    allRankSlots[slot - 1].isKey = true;
  }

  const shuffledNonKey = [...nonKeyEntries];
  for (let i = shuffledNonKey.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffledNonKey[i], shuffledNonKey[j]] = [shuffledNonKey[j], shuffledNonKey[i]];
  }

  let nkIdx = 0;
  for (let r = 0; r < totalSlots; r++) {
    if (!allRankSlots[r].entry && nkIdx < shuffledNonKey.length) {
      allRankSlots[r].entry = shuffledNonKey[nkIdx++];
    }
  }

  const reserveEntries = shuffledNonKey.slice(nkIdx);

  const roster: RosterFighterState[] = [];

  for (let r = 0; r < allRankSlots.length; r++) {
    const slot = allRankSlots[r];
    if (!slot.entry) continue;
    const entry = slot.entry;
    const rankPos = r + 1;

    const rankPct = 1 - ((rankPos - 1) / (totalSlots - 1));
    const baseLevel = Math.floor(rankPct * 99) + 1;
    const jitter = Math.floor(rng() * 5) - 2;
    let level = Math.max(1, Math.min(100, baseLevel + jitter));

    if (entry.id === 204) level = 100;

    let fighterDifficulty: AIDifficulty;
    if (slot.isKey) {
      fighterDifficulty = keyDifficulty;
    } else {
      fighterDifficulty = difficultyForLevel(level, cd, rng);
    }

    let record;
    if (entry.forceUndefeated) {
      record = generateUndefeatedRecord(rng, level);
    } else {
      record = generateRecordForLevel(rng, level);
    }

    const armLength = Math.round(58 + rng() * 17);
    const stats = generateFighterStats(rankPos, entry.archetype, rng, ACTIVE_ROSTER_SIZE);

    roster.push({
      id: entry.id,
      ...record,
      level,
      armLength,
      active: true,
      retired: false,
      rank: rankPos,
      ratingScore: 1000 + (151 - rankPos) * 5,
      beatenByPlayer: false,
      fighterDifficulty,
      ...generateFighterColors(rng),
      ...stats,
    });
  }

  for (const entry of reserveEntries) {
    const reserveLevel = Math.floor(1 + rng() * 30);
    const armLength = Math.round(58 + rng() * 17);
    const reserveRank = ACTIVE_ROSTER_SIZE + 1 + roster.length - allRankSlots.length;
    const reserveStats = generateFighterStats(Math.max(140, reserveRank), entry.archetype, rng, ACTIVE_ROSTER_SIZE);
    roster.push({
      id: entry.id,
      wins: 0, losses: 0, draws: 0, knockouts: 0, totalFights: 0,
      level: reserveLevel,
      armLength,
      active: false,
      retired: false,
      rank: 0,
      ratingScore: 900,
      beatenByPlayer: false,
      fighterDifficulty: "journeyman",
      ...generateFighterColors(rng),
      ...reserveStats,
    });
  }

  enforceRankingIntegrity(roster);

  const customizedRoster = applyRosterCustomizations(roster);

  const state: CareerRosterState = {
    roster: customizedRoster,
    weekNumber: 0,
    newsItems: ["Welcome to the boxing world! Your career begins now."],
    selectedOpponentId: null,
    playerRank: ACTIVE_ROSTER_SIZE + 1,
    playerRatingScore: 1000,
    trainingsSinceLastWeek: 0,
  };

  return state;
}

export function updateRankings(roster: RosterFighterState[]): void {
  const active = roster.filter(f => f.active && !f.retired);
  active.sort((a, b) => {
    if (Math.abs(a.ratingScore - b.ratingScore) > 0.01) return b.ratingScore - a.ratingScore;
    return b.wins - a.wins;
  });

  const wolfgangIdx = active.findIndex(f => f.id === 204 && !f.beatenByPlayer);
  if (wolfgangIdx > 0) {
    const [wolf] = active.splice(wolfgangIdx, 1);
    active.unshift(wolf);
  }

  active.forEach((f, i) => { f.rank = i + 1; });
  roster.filter(f => !f.active || f.retired).forEach(f => { f.rank = 0; });
}

export function computePlayerRankFromRating(
  roster: RosterFighterState[],
  playerRatingScore: number
): number {
  const active = roster.filter(f => f.active && !f.retired);
  const sorted = [...active].sort((a, b) => b.ratingScore - a.ratingScore);

  const wolfIdx = sorted.findIndex(f => f.id === 204 && !f.beatenByPlayer);
  if (wolfIdx > 0) {
    const [wolf] = sorted.splice(wolfIdx, 1);
    sorted.unshift(wolf);
  }

  let rank = sorted.length + 1;
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (playerRatingScore >= sorted[i].ratingScore && sorted[i].id !== 204) {
      rank = i + 1;
    } else {
      break;
    }
  }
  const wolfUnbeaten = sorted.some(f => f.id === 204 && !f.beatenByPlayer);
  return wolfUnbeaten ? Math.max(2, rank) : Math.max(1, rank);
}

export function updatePlayerRating(
  currentRating: number,
  opponentRating: number,
  won: boolean,
  method: FightMethod,
  careerDifficulty: AIDifficulty,
  opponentRank: number
): number {
  const diffMult = DIFFICULTY_ELO_MULT[careerDifficulty] || 1.0;
  const isChampFight = opponentRank === 1;

  if (won) {
    const { winnerDelta } = computeEloChange(currentRating, opponentRating, method, diffMult, isChampFight);
    const ratingGap = opponentRating - currentRating;
    const minBoost = Math.max(8, ratingGap > 0 ? ratingGap * 0.25 : 5);
    return currentRating + Math.max(winnerDelta, minBoost);
  } else {
    const { loserDelta } = computeEloChange(opponentRating, currentRating, method, diffMult, isChampFight);
    return currentRating + loserDelta;
  }
}

export function redistributeRosterLevels(roster: RosterFighterState[], maxLevelGainPerWeek: number = 1): RosterFighterState[] {
  const result = roster.map(f => ({ ...f }));
  const rng = seededRandom(result.length * 31 + 7);

  for (const f of result) {
    if (!f.genSkinColor) {
      const colors = generateFighterColors(rng);
      f.genSkinColor = colors.genSkinColor;
      f.genGloves = colors.genGloves;
      f.genGloveTape = colors.genGloveTape;
      f.genTrunks = colors.genTrunks;
      f.genShoes = colors.genShoes;
    }
  }

  const active = result.filter(f => f.active && !f.retired && f.rank > 0);
  const totalActive = active.length;
  for (const f of active) {
    const oldLevel = f.level;
    const rankPct = 1 - ((f.rank - 1) / Math.max(1, totalActive - 1));
    const baseLevel = Math.floor(rankPct * 99) + 1;
    const jitter = Math.floor(rng() * 5) - 2;
    let newLevel = Math.max(1, Math.min(100, baseLevel + jitter));
    if (newLevel > oldLevel) {
      newLevel = Math.min(newLevel, oldLevel + maxLevelGainPerWeek);
    }
    f.level = newLevel;
  }

  const inactive = result.filter(f => !f.active || f.retired);
  for (const f of inactive) {
    const oldLevel = f.level;
    const ratingPct = Math.max(0, Math.min(1, (f.ratingScore - 800) / 800));
    const baseLevel = Math.floor(ratingPct * 60) + 1;
    const jitter = Math.floor(rng() * 5) - 2;
    let newLevel = Math.max(1, Math.min(100, baseLevel + jitter));
    if (newLevel > oldLevel) {
      newLevel = Math.min(newLevel, oldLevel + maxLevelGainPerWeek);
    }
    f.level = newLevel;
  }

  const champ = result.find(f => f.id === 204);
  if (champ) champ.level = 100;
  return result;
}

export function getOpponentCandidates(
  roster: RosterFighterState[],
  playerRank: number,
  playerLevel?: number
): RosterFighterState[] {
  const active = roster.filter(f => f.active && !f.retired && f.rank > 0);

  let candidates: RosterFighterState[];
  if (playerLevel !== undefined) {
    const levelMin = playerLevel - 6;
    const levelMax = playerLevel + 3;
    candidates = active.filter(f => f.level >= levelMin && f.level <= levelMax);

    if (candidates.length === 0) {
      const closest = active
        .filter(f => f.level <= playerLevel + 3)
        .sort((a, b) => Math.abs(a.level - playerLevel) - Math.abs(b.level - playerLevel));
      candidates = closest.slice(0, 1);
    }
  } else {
    const minRank = Math.max(1, playerRank - 7);
    const maxRank = playerRank + 7;
    candidates = active.filter(f => f.rank >= minRank && f.rank <= maxRank);
  }

  candidates.sort((a, b) => a.rank - b.rank);
  let result = candidates.slice(0, 7);

  const availableCount = result.filter(f => !f.unavailableThisWeek).length;
  if (availableCount < 3) {
    const needed = 3 - availableCount;
    const unavailInResult = new Set(result.filter(f => f.unavailableThisWeek).map(f => f.id));
    const resultIds = new Set(result.map(f => f.id));
    const extras = active
      .filter(f => !resultIds.has(f.id) && !f.unavailableThisWeek)
      .sort((a, b) => Math.abs(a.rank - playerRank) - Math.abs(b.rank - playerRank));

    let added = 0;
    for (const e of extras) {
      if (added >= needed) break;
      const replaceId = [...unavailInResult].pop();
      if (replaceId !== undefined) {
        result = result.filter(f => f.id !== replaceId);
        unavailInResult.delete(replaceId);
      }
      result.push(e);
      added++;
    }
    result.sort((a, b) => a.rank - b.rank);
  }

  return result;
}

export function getRosterEntryById(id: number): RosterEntry | undefined {
  return ROSTER_DATA.find(r => r.id === id);
}

export function getAIDifficultyForRank(rank: number, totalActive: number): AIDifficulty {
  const pct = rank / totalActive;
  if (pct <= 0.05) return "champion";
  if (pct <= 0.20) return "elite";
  if (pct <= 0.55) return "contender";
  return "journeyman";
}

export interface SimulatedFightResult {
  winnerId: number;
  loserId: number;
  winnerName: string;
  loserName: string;
  isKO: boolean;
  isDraw: boolean;
}

function winProbFromRating(ratingA: number, ratingB: number): number {
  const diff = ratingA - ratingB;
  const absDiff = Math.abs(diff);
  let prob: number;
  if (absDiff <= 50) prob = 0.55;
  else if (absDiff <= 100) prob = 0.60;
  else if (absDiff <= 200) prob = 0.70;
  else prob = 0.80;
  prob = Math.min(prob, 0.85);
  return diff >= 0 ? prob : 1 - prob;
}

export function simulateWeek(state: CareerRosterState, weekSeed: number, careerDifficulty?: string, playerLevel?: number): CareerRosterState {
  const rng = seededRandom(Math.abs(weekSeed) + state.weekNumber * 9973);
  const newRoster = state.roster.map(f => ({ ...f }));
  for (const f of newRoster) {
    if (f.ratingScore == null) {
      f.ratingScore = f.active ? 1000 + Math.max(0, 151 - f.rank) * 5 : 900;
    }
  }
  const newNews: string[] = [];
  const keyIds = new Set(KEY_FIGHTER_IDS);
  const currentWeek = state.weekNumber;

  if (state.selectedOpponentId != null && careerDifficulty && playerLevel != null) {
    const opp = newRoster.find(f => f.id === state.selectedOpponentId);
    if (opp) {
      const levelUpChance = careerDifficulty === "champion" ? 0.60 : careerDifficulty === "elite" ? 0.50 : careerDifficulty === "contender" ? 0.40 : 0.30;
      const doubleUpChance = careerDifficulty === "champion" ? 0.20 : careerDifficulty === "elite" ? 0.15 : careerDifficulty === "contender" ? 0.10 : 0.05;
      const prepWeeks = state.prepWeeksRemaining ?? 0;
      const shortCap = careerDifficulty === "champion" ? 4 : careerDifficulty === "elite" ? 3 : careerDifficulty === "contender" ? 3 : 2;
      const longCap = careerDifficulty === "champion" ? 6 : careerDifficulty === "elite" ? 5 : careerDifficulty === "contender" ? 5 : 4;
      const maxLevel = playerLevel + (prepWeeks > 4 ? longCap : shortCap);
      if (rng() < levelUpChance && opp.level < maxLevel && opp.level < 100) {
        opp.level++;
        if (rng() < doubleUpChance && opp.level < maxLevel && opp.level < 100) {
          opp.level++;
        }
      }
    }
  }

  const activeFighters = newRoster.filter(f => f.active && !f.retired);
  activeFighters.sort((a, b) => a.rank - b.rank);

  const excluded = new Set<number>();
  if (state.selectedOpponentId) excluded.add(state.selectedOpponentId);
  for (const f of activeFighters) {
    if (f.lastFightWeek != null && f.lastFightWeek >= currentWeek - 1) {
      excluded.add(f.id);
    }
  }

  const eligible = activeFighters.filter(f => !excluded.has(f.id));
  const shuffled = [...eligible];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const pool = shuffled.slice(0, 50);

  const paired = new Set<number>();
  const pairs: [RosterFighterState, RosterFighterState][] = [];

  const champ = activeFighters.find(f => f.rank === 1);
  if (champ && currentWeek > 0 && currentWeek % 4 === 0) {
    const lastFought = champ.lastFightWeek ?? -999;
    if (currentWeek - lastFought >= 4) {
      const challengers = activeFighters.filter(f =>
        f.id !== champ.id && !excluded.has(f.id) && f.rank >= 2 && f.rank <= 6
      );
      if (challengers.length > 0) {
        challengers.sort((a, b) => a.rank - b.rank);
        const challenger = challengers[0];
        pairs.push([champ, challenger]);
        paired.add(champ.id);
        paired.add(challenger.id);
      }
    }
  }

  const poolByRank = pool.filter(f => !paired.has(f.id)).sort((a, b) => a.rank - b.rank);
  for (const f of poolByRank) {
    if (paired.has(f.id)) continue;
    const candidates = poolByRank.filter(g =>
      g.id !== f.id && !paired.has(g.id) && Math.abs(g.rank - f.rank) <= 5
    );
    if (candidates.length === 0) continue;
    candidates.sort((a, b) => Math.abs(a.rank - f.rank) - Math.abs(b.rank - f.rank));
    const opp = candidates[0];
    pairs.push([f, opp]);
    paired.add(f.id);
    paired.add(opp.id);
  }

  const results: SimulatedFightResult[] = [];
  for (const [a, b] of pairs) {
    a.lastFightWeek = currentWeek;
    b.lastFightWeek = currentWeek;

    if (keyIds.has(a.id) && !a.beatenByPlayer && keyIds.has(b.id) && !b.beatenByPlayer) {
      a.draws++;
      b.draws++;
      a.totalFights++;
      b.totalFights++;
      const aEntry = getRosterEntryById(a.id);
      const bEntry = getRosterEntryById(b.id);
      const aName = aEntry ? getRosterDisplayName(aEntry, a) : `Fighter ${a.id}`;
      const bName = bEntry ? getRosterDisplayName(bEntry, b) : `Fighter ${b.id}`;
      newNews.push(`${aName} and ${bName} battle to a draw`);
      continue;
    }

    let winner: RosterFighterState, loser: RosterFighterState;
    if (keyIds.has(a.id) && !a.beatenByPlayer) {
      winner = a;
      loser = b;
    } else if (keyIds.has(b.id) && !b.beatenByPlayer) {
      winner = b;
      loser = a;
    } else {
      const prob = winProbFromRating(a.ratingScore, b.ratingScore);
      winner = rng() < prob ? a : b;
      loser = winner === a ? b : a;
    }

    const methodRoll = rng();
    let method: FightMethod;
    if (methodRoll < 0.05) method = "ko";
    else if (methodRoll < 0.15) method = "dominant";
    else if (methodRoll < 0.40) method = "close";
    else method = "close";

    const isChampFight = winner.rank === 1 || loser.rank === 1;
    const { winnerDelta, loserDelta } = computeEloChange(
      winner.ratingScore, loser.ratingScore, method, 1.0, isChampFight
    );
    winner.ratingScore += winnerDelta;
    loser.ratingScore += loserDelta;

    const isKO = method === "ko";
    winner.wins++;
    winner.totalFights++;
    if (isKO) winner.knockouts++;
    loser.losses++;
    loser.totalFights++;

    const wEntry = getRosterEntryById(winner.id);
    const lEntry = getRosterEntryById(loser.id);
    const wName = wEntry ? getRosterDisplayName(wEntry, winner) : `Fighter ${winner.id}`;
    const lName = lEntry ? getRosterDisplayName(lEntry, loser) : `Fighter ${loser.id}`;

    if (isKO) {
      newNews.push(`${wName} stops ${lName} by ${rng() < 0.5 ? "KO" : "TKO"}`);
    } else if (method === "dominant") {
      newNews.push(`${wName} dominates ${lName} by decision`);
    } else {
      newNews.push(`${wName} defeats ${lName} by decision`);
    }

    if (keyIds.has(winner.id) && winner.losses === 0 && !winner.beatenByPlayer) {
      newNews.push(`${wName} remains undefeated after a battle with ${lName}`);
    }

    results.push({
      winnerId: winner.id,
      loserId: loser.id,
      winnerName: wName,
      loserName: lName,
      isKO,
      isDraw: false,
    });
  }

  const retiredIds: number[] = [];
  for (const f of newRoster) {
    if (!f.active || f.retired) continue;
    if (keyIds.has(f.id) && !f.beatenByPlayer) continue;
    if (f.totalFights >= 30 && rng() < 0.04) {
      f.retired = true;
      f.active = false;
      retiredIds.push(f.id);
      const entry = getRosterEntryById(f.id);
      const name = entry ? getRosterDisplayName(entry, f) : `Fighter ${f.id}`;
      newNews.push(`${name} announces retirement after ${f.totalFights} fights`);
    }
  }

  if (retiredIds.length > 0) {
    const reserve = newRoster.filter(f => !f.active && !f.retired);
    for (let i = 0; i < retiredIds.length && reserve.length > 0; i++) {
      const idx = Math.floor(rng() * reserve.length);
      const newFighter = reserve[idx];
      newFighter.active = true;
      newFighter.wins = 0;
      newFighter.losses = 0;
      newFighter.draws = 0;
      newFighter.knockouts = 0;
      newFighter.totalFights = 0;
      newFighter.ratingScore = 950;
      newFighter.level = Math.floor(1 + rng() * 5);
      newFighter.fighterDifficulty = "journeyman";
      reserve.splice(idx, 1);
      const entry = getRosterEntryById(newFighter.id);
      const name = entry ? getRosterDisplayName(entry, newFighter) : `Fighter ${newFighter.id}`;
      newNews.push(`${name} makes their professional debut`);
    }
  }

  updateRankings(newRoster);

  const postActive = newRoster.filter(f => f.active && !f.retired && f.rank > 0);
  const postTotalActive = postActive.length;
  const weekRng = seededRandom(Math.abs(weekSeed) + state.weekNumber * 3331);
  for (const f of postActive) {
    const rankPct = 1 - ((f.rank - 1) / Math.max(1, postTotalActive - 1));
    const baseLevel = Math.floor(rankPct * 99) + 1;
    const jitter = Math.floor(weekRng() * 5) - 2;
    const newLevel = Math.max(1, Math.min(100, baseLevel + jitter));
    f.level = Math.max(f.level, newLevel);
  }
  const wolf = newRoster.find(f => f.id === 204);
  if (wolf && wolf.active) wolf.level = 100;

  for (const f of newRoster) {
    if (!f.active || f.retired) continue;
    if (keyIds.has(f.id)) {
      f.unavailableThisWeek = false;
      f.wasUnavailableLast = false;
      continue;
    }
    if (f.wasUnavailableLast) {
      f.unavailableThisWeek = false;
      f.wasUnavailableLast = false;
    } else {
      const unavail = rng() < 0.4;
      f.unavailableThisWeek = unavail;
      f.wasUnavailableLast = unavail;
    }
  }

  const displayNews = newNews.slice(0, 12);

  let newPrepWeeks = state.prepWeeksRemaining;
  if (newPrepWeeks != null && newPrepWeeks > 0) {
    newPrepWeeks = newPrepWeeks - 1;
  }

  return {
    roster: newRoster,
    weekNumber: state.weekNumber + 1,
    newsItems: displayNews,
    selectedOpponentId: state.selectedOpponentId,
    playerRank: state.playerRank,
    playerRatingScore: state.playerRatingScore ?? 1000,
    trainingsSinceLastWeek: state.trainingsSinceLastWeek ?? 0,
    prepWeeksRemaining: newPrepWeeks,
  };
}

export interface CareerOpponentFromRoster {
  rosterId: number;
  name: string;
  level: number;
  archetype: Archetype;
  aiDifficulty: AIDifficulty;
  armLength: number;
  rank: number;
  wins: number;
  losses: number;
  draws: number;
  knockouts: number;
  statPower?: number;
  statSpeed?: number;
  statDefense?: number;
  statStamina?: number;
  statFocus?: number;
  overallRating?: number;
}

export function getRandomQuickFightOpponent(difficulty: AIDifficulty): CareerOpponentFromRoster {
  const idx = Math.floor(Math.random() * ROSTER_DATA.length);
  const entry = ROSTER_DATA[idx];
  const name = entry.nickname
    ? `${entry.firstName} "${entry.nickname}" ${entry.lastName}`
    : `${entry.firstName} ${entry.lastName}`;
  const armLength = Math.round(58 + Math.random() * 17);
  return {
    rosterId: entry.id,
    name,
    level: 0,
    archetype: entry.archetype,
    aiDifficulty: difficulty,
    armLength,
    rank: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    knockouts: 0,
  };
}

export function getRosterFighterColors(f: RosterFighterState): { skin: string; gloves: string; gloveTape: string; trunks: string; shoes: string } {
  return {
    skin: f.customSkinColor || f.genSkinColor || "#e8c4a0",
    gloves: f.customGloves || f.genGloves || "#1155cc",
    gloveTape: f.genGloveTape || "#eeeeee",
    trunks: f.customTrunks || f.genTrunks || "#222222",
    shoes: f.customShoes || f.genShoes || "#1a1a1a",
  };
}

export function getQuickFightColorsForRosterId(rosterId: number): { skin: string; gloves: string; gloveTape: string; trunks: string; shoes: string } {
  const customizations = loadRosterCustomizations();
  const c = customizations[rosterId];

  const rng = seededRandom(rosterId * 7919 + 31);
  const gen = generateFighterColors(rng);

  return {
    skin: c?.customSkinColor || gen.genSkinColor,
    gloves: c?.customGloves || gen.genGloves,
    gloveTape: gen.genGloveTape,
    trunks: c?.customTrunks || gen.genTrunks,
    shoes: c?.customShoes || gen.genShoes,
  };
}

export function buildOpponentFromRoster(f: RosterFighterState): CareerOpponentFromRoster | null {
  const entry = getRosterEntryById(f.id);
  if (!entry) return null;
  const totalActive = ACTIVE_ROSTER_SIZE;
  return {
    rosterId: f.id,
    name: getRosterDisplayName(entry, f),
    level: f.level,
    archetype: entry.archetype,
    aiDifficulty: f.fighterDifficulty || getAIDifficultyForRank(f.rank, totalActive),
    armLength: f.armLength,
    rank: f.rank,
    wins: f.wins,
    losses: f.losses,
    draws: f.draws,
    knockouts: f.knockouts,
    statPower: f.statPower,
    statSpeed: f.statSpeed,
    statDefense: f.statDefense,
    statStamina: f.statStamina,
    statFocus: f.statFocus,
    overallRating: f.overallRating,
  };
}

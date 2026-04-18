import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, real, jsonb, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export interface SkillPoints {
  power: number;
  speed: number;
  defense: number;
  stamina: number;
  focus: number;
}

export interface GearColors {
  gloves: string;
  gloveTape: string;
  trunks: string;
  shoes: string;
}

export interface NextFightBuffs {
  doubleCrit?: boolean;
  moveSpeedBoost?: boolean;
  doubleStun?: boolean;
  extraWhiff?: boolean;
}

export interface TrainingBonuses {
  weightLifting: number;
  heavyBag: number;
  sparring: number;
  nextFightBuffs?: NextFightBuffs;
  postFightXpBoost?: number;
}

export const DEFAULT_GEAR_COLORS: GearColors = {
  gloves: "#cc2222",
  gloveTape: "#eeeeee",
  trunks: "#2244aa",
  shoes: "#1a1a1a",
};

export const DEFAULT_TRAINING_BONUSES: TrainingBonuses = {
  weightLifting: 0,
  heavyBag: 0,
  sparring: 0,
};

export interface RosterFighterState {
  id: number;
  wins: number;
  losses: number;
  draws: number;
  knockouts: number;
  totalFights: number;
  level: number;
  armLength: number;
  active: boolean;
  retired: boolean;
  rank: number;
  ratingScore: number;
  beatenByPlayer: boolean;
  lastFightWeek?: number;
  unavailableThisWeek?: boolean;
  wasUnavailableLast?: boolean;
  fighterDifficulty?: "journeyman" | "contender" | "elite" | "champion";
  genSkinColor?: string;
  genGloves?: string;
  genGloveTape?: string;
  genTrunks?: string;
  genShoes?: string;
  customFirstName?: string;
  customNickname?: string;
  customLastName?: string;
  customSkinColor?: string;
  customGloves?: string;
  customTrunks?: string;
  customShoes?: string;
  statPower?: number;
  statSpeed?: number;
  statDefense?: number;
  statStamina?: number;
  statFocus?: number;
  overallRating?: number;
}

export interface CareerRosterState {
  roster: RosterFighterState[];
  weekNumber: number;
  newsItems: string[];
  selectedOpponentId: number | null;
  playerRank: number;
  playerRatingScore: number;
  trainingsSinceLastWeek: number;
  prepWeeksRemaining?: number;
  savedChargeBars?: number;
  savedChargeCounters?: number;
  winsVsTop25?: number;
  winsVsTop10?: number;
  top5Beaten?: number[];
}

export interface CareerStats {
  totalPunchesThrown: number;
  totalPunchesLanded: number;
  totalKnockdownsGiven: number;
  totalKnockdownsTaken: number;
  totalBlocksMade: number;
  totalDodges: number;
  totalDamageDealt: number;
  totalDamageReceived: number;
  totalRoundsWon: number;
  totalRoundsLost: number;
  lifetimeXp: number;
}

export const DEFAULT_CAREER_STATS: CareerStats = {
  totalPunchesThrown: 0,
  totalPunchesLanded: 0,
  totalKnockdownsGiven: 0,
  totalKnockdownsTaken: 0,
  totalBlocksMade: 0,
  totalDodges: 0,
  totalDamageDealt: 0,
  totalDamageReceived: 0,
  totalRoundsWon: 0,
  totalRoundsLost: 0,
  lifetimeXp: 0,
};

export const fighters = pgTable("fighters", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  firstName: text("first_name").notNull().default(""),
  nickname: text("nickname").notNull().default(""),
  lastName: text("last_name").notNull().default(""),
  archetype: text("archetype").notNull().default("BoxerPuncher"),
  level: integer("level").notNull().default(1),
  xp: integer("xp").notNull().default(0),
  wins: integer("wins").notNull().default(0),
  losses: integer("losses").notNull().default(0),
  draws: integer("draws").notNull().default(0),
  knockouts: integer("knockouts").notNull().default(0),
  skillPoints: jsonb("skill_points").$type<SkillPoints>().default({ power: 0, speed: 0, defense: 0, stamina: 0, focus: 0 }),
  availableStatPoints: integer("available_stat_points").notNull().default(0),
  careerBoutIndex: integer("career_bout_index").notNull().default(0),
  careerDifficulty: text("career_difficulty").notNull().default("contender"),
  roundLengthMins: integer("round_length_mins").notNull().default(3),
  careerStats: jsonb("career_stats").$type<CareerStats>().default(DEFAULT_CAREER_STATS),
  skinColor: text("skin_color").notNull().default("#e8c4a0"),
  gearColors: jsonb("gear_colors").$type<GearColors>().default(DEFAULT_GEAR_COLORS),
  trainingBonuses: jsonb("training_bonuses").$type<TrainingBonuses>().default(DEFAULT_TRAINING_BONUSES),
  careerRosterState: jsonb("career_roster_state").$type<CareerRosterState>(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertFighterSchema = createInsertSchema(fighters).omit({ id: true, createdAt: true });
export type InsertFighter = z.infer<typeof insertFighterSchema>;
export type Fighter = typeof fighters.$inferSelect;

export const fightResults = pgTable("fight_results", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  fighterId: varchar("fighter_id").notNull(),
  opponentName: text("opponent_name").notNull(),
  opponentLevel: integer("opponent_level").notNull(),
  opponentArchetype: text("opponent_archetype").notNull().default("BoxerPuncher"),
  result: text("result").notNull(),
  method: text("method").notNull(),
  rounds: integer("rounds").notNull(),
  xpGained: integer("xp_gained").notNull().default(0),
  boutNumber: integer("bout_number").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertFightResultSchema = createInsertSchema(fightResults).omit({ id: true, createdAt: true });
export type InsertFightResult = z.infer<typeof insertFightResultSchema>;
export type FightResult = typeof fightResults.$inferSelect;

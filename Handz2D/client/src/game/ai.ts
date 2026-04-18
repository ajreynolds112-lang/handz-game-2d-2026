import {
  GameState, FighterState, PunchType, Archetype, DefenseState,
  PUNCH_CONFIGS, ARCHETYPE_STATS, AIDifficulty,
  AiState, TacticalPhase, DifficultyBand, DIFFICULTY_TO_BAND,
  AiPersonality, AiBrainState, AiDataBank, AiHitRecord, AiWhiffRecord,
  AiHitPattern, AiHitSummary, AiComboStep, AiCombo,
  AdaptiveMemory, TimingSlot, ObservedPattern, RingZone, BehaviorProfile,
  WhiffSnapshot,
} from "./types";
import { aiRNG } from "./engine";
import { SITUATION_DB, matchSituation, getDifficultyMultiplier, type SituationMatchResult } from "./situationDB";
import { getNeuralOverrides } from "@/components/NeuralNetworkView";

const AI_BLOCK_PX = 70;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * clamp01(t);
}
function inverseLerp(a: number, b: number, v: number): number {
  if (Math.abs(b - a) < 0.0001) return 0;
  return clamp01((v - a) / (b - a));
}

// ===== RNG & UTILITIES =====

class AiRNG {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
    if (this.s === 0) this.s = 1;
  }
  next01(): number {
    this.s = (this.s * 1664525 + 1013904223) & 0xFFFFFFFF;
    return (this.s >>> 0) / 0xFFFFFFFF;
  }
  range(min: number, max: number): number {
    return min + (max - min) * this.next01();
  }
  chance(p: number): boolean {
    return this.next01() < clamp01(p);
  }
  rollRange01(min01: number, max01: number): number {
    return lerp(min01, max01, this.next01());
  }
}

let rng: AiRNG = new AiRNG(Date.now());

const LOW_STAMINA_FRAC = 0.25;
const DEEP_SURVIVAL_FRAC = 0.03;
const PLAYER_FINISH_FRAC = 0.20;
const SURVIVAL_FRAC = 0.20;
const HIT_DETECT_THRESHOLD = 0.5;
const CONDITION_DECAY_PER_SEC = 0.008;
const HEAD_HIT_CONDITION_VALUE = 0.04;
const BODY_HIT_CONDITION_VALUE = 0.04;
const CONDITION_DAMAGE_GATE_MIN = 30;
const CONDITION_DAMAGE_GATE_MAX = 200;
const CONDITION_DAMAGE_GATE = 50;
const REPEAT_HIT_THRESHOLD = 5;
const REPEAT_PENALTY_STEP = 0.03;
const REPEAT_PENALTY_CAP = 0.20;
const PERFECT_REACT_COOLDOWN = 0.8;
const PERFECT_REACT_HOLD_TIME = 0.35;
const PERFECT_REACT_FADE_TICK_SECONDS = 15;
const PERFECT_REACT_FADE_TICK_AMOUNT = 0.01;
const STEP_OUT_TARGET_DISTANCE_PX = 120;
const PATTERN_RANGE_MAX_PX = AI_BLOCK_PX * 1.8;
const PATTERN_WINDOW_SECONDS = 2.0;
const COUNTER_PATTERN_WINDOW_DURATION = 1.5;
const RHYTHM_CUT_HOLD_SECONDS = 0.6;
const RHYTHM_CUT_COOLDOWN_SECONDS = 3.0;
const RHYTHM_CUT_TICK_SECONDS = 0.1;
const RHYTHM_CHANGE_COOLDOWN = 2.0;
const TOO_CLOSE_RANGE_PX = AI_BLOCK_PX * 0.5;
const OVERLAP_HARD_MIN_DIST_PX = AI_BLOCK_PX * 0.15;

const EASY_HEAD_CONDITION_THRESHOLD = 0.80;
const MEDIUM_HEAD_CONDITION_THRESHOLD = 0.55;
const HARD_HEAD_CONDITION_THRESHOLD = 0.35;
const HARDCORE_HEAD_CONDITION_THRESHOLD = 0.22;
const EASY_BODY_CONDITION_THRESHOLD = 0.90;
const MEDIUM_BODY_CONDITION_THRESHOLD = 0.60;
const HARD_BODY_CONDITION_THRESHOLD = 0.40;
const HARDCORE_BODY_CONDITION_THRESHOLD = 0.25;

function blocksToPixels(blocks: number): number {
  return blocks * AI_BLOCK_PX;
}

function pixelsToBlocks(px: number): number {
  return px / AI_BLOCK_PX;
}

function levelScale(level: number, min: number, max: number): number {
  const t = clamp01((level - 1) / 99);
  return min + (max - min) * t;
}

function createPersonality(difficulty: DifficultyBand, archetype: Archetype, rosterId?: number): AiPersonality {
  const base: AiPersonality = {
    aggression: 0.45,
    guardParanoia: 0.35,
    feintiness: 0.15,
    cleanHitsOverVolume: 0.30,
    headBias: 0.50,
  };

  switch (difficulty) {
    case "Easy":
      base.aggression = rng.rollRange01(0.20, 0.46);
      base.guardParanoia = rng.rollRange01(0.15, 0.35);
      base.feintiness = rng.rollRange01(0.05, 0.15);
      base.cleanHitsOverVolume = rng.rollRange01(0.10, 0.30);
      break;
    case "Medium":
      base.aggression = rng.rollRange01(0.46, 0.72);
      base.guardParanoia = rng.rollRange01(0.25, 0.45);
      base.feintiness = rng.rollRange01(0.12, 0.28);
      base.cleanHitsOverVolume = rng.rollRange01(0.25, 0.50);
      break;
    case "Hard":
      base.aggression = rng.rollRange01(0.72, 0.90);
      base.guardParanoia = rng.rollRange01(0.35, 0.55);
      base.feintiness = rng.rollRange01(0.20, 0.38);
      base.cleanHitsOverVolume = rng.rollRange01(0.40, 0.65);
      break;
    case "Hardcore":
      base.aggression = rng.rollRange01(0.85, 1.0);
      base.guardParanoia = rng.rollRange01(0.45, 0.65);
      base.feintiness = rng.rollRange01(0.28, 0.45);
      base.cleanHitsOverVolume = rng.rollRange01(0.55, 0.80);
      break;
  }

  switch (archetype) {
    case "OutBoxer":
      base.aggression -= 0.10;
      base.cleanHitsOverVolume += 0.15;
      base.guardParanoia += 0.05;
      break;
    case "Brawler":
      base.aggression += 0.15;
      base.cleanHitsOverVolume -= 0.10;
      base.guardParanoia -= 0.05;
      break;
    case "Swarmer":
      base.aggression += 0.10;
      base.feintiness -= 0.05;
      base.cleanHitsOverVolume -= 0.05;
      break;
  }

  const neuralDiffKey = difficulty === "Easy" ? "journeyman" : difficulty === "Medium" ? "contender" : difficulty === "Hard" ? "elite" : "champion";
  try {
    const overrides = getNeuralOverrides(rosterId);
    const ns = overrides[neuralDiffKey as keyof typeof overrides];
    if (ns) {
      const bias = 0.20;
      base.aggression = base.aggression * (1 - bias) + (ns.aggression ?? base.aggression) * bias;
      base.guardParanoia = base.guardParanoia * (1 - bias) + (ns.guardParanoia ?? base.guardParanoia) * bias;
      base.feintiness = base.feintiness * (1 - bias) + (ns.feintiness ?? base.feintiness) * bias;
      base.cleanHitsOverVolume = base.cleanHitsOverVolume * (1 - bias) + (ns.cleanHitsVsVolume ?? base.cleanHitsOverVolume) * bias;
    }
  } catch {}

  base.aggression = clamp01(base.aggression);
  base.guardParanoia = clamp01(base.guardParanoia);
  base.feintiness = clamp01(base.feintiness);
  base.cleanHitsOverVolume = clamp01(base.cleanHitsOverVolume);
  base.headBias = clamp01(base.headBias);

  return base;
}

function createDataBank(): AiDataBank {
  return {
    recentHits: [],
    recentWhiffs: [],
    offensiveEvents: [],
    hitPatterns: [],
    maxHitHistory: 200,
    maxWhiffHistory: 120,
    maxHitPatterns: 50,
    patternWindowSeconds: 2.0,
    patternIntervalTolerance: 0.18,
  };
}

function getArchetypeBiases(archetype: Archetype): { aggBias: number; rangeBias: number; comboBias: number } {
  switch (archetype) {
    case "OutBoxer": return { aggBias: -0.18, rangeBias: 0.30, comboBias: -0.10 };
    case "Brawler": return { aggBias: 0.22, rangeBias: -0.18, comboBias: 0.12 };
    case "Swarmer": return { aggBias: 0.15, rangeBias: -0.10, comboBias: 0.18 };
    default: return { aggBias: 0, rangeBias: 0, comboBias: 0 };
  }
}

// ===== STYLE PROFILE =====

interface StyleProfile {
  styleDuckApproach: number;
  styleCrossHeavy: number;
  styleBodyFocus: number;
  styleCounterOffDuck: number;
  styleEngageCycleIn: number;
  styleEngageCycleOut: number;
  styleIdealResetDist: number;
  styleIdealEngageDist: number;
  styleLateralApproach: number;
  styleJabSetup: number;
  stylePatience: number;
  styleDefenseCycling: number;
  styleCounterOffGuardDrop: number;
  styleChargedPunchUsage: number;
  styleDefenseDiscipline: number;
  styleAntiDuckUppercut: number;
  styleRetreatTracking: number;
  styleBodyDefenseAdapt: number;
  styleSustainedDuckCounter: number;
  stylePostDodgeFollowup: number;
}

function createStyleProfile(band: DifficultyBand, archetype: Archetype): StyleProfile {
  const baseDuck = rng.rollRange01(0.10, 0.55);
  const baseCross = rng.rollRange01(0.20, 0.65);
  const baseBody = rng.rollRange01(0.15, 0.55);
  const baseCounter = rng.rollRange01(0.15, 0.60);
  const baseLateral = rng.rollRange01(0.15, 0.45);
  const baseJab = rng.rollRange01(0.20, 0.55);
  const basePatience = rng.rollRange01(0.20, 0.65);
  const baseResetDist = rng.range(90, 125);
  const baseEngageDist = rng.range(55, 80);
  const baseCycleIn = rng.range(2.5, 6.0);
  const baseCycleOut = rng.range(3.0, 7.0);
  const baseDefCycling = rng.rollRange01(0.20, 0.70);
  const baseGuardDropCounter = rng.rollRange01(0.15, 0.60);
  const baseChargePunch = rng.rollRange01(0.10, 0.45);
  const baseDefDiscipline = rng.rollRange01(0.25, 0.70);
  const baseAntiDuckUppercut = rng.rollRange01(0.20, 0.65);
  const baseRetreatTracking = rng.rollRange01(0.15, 0.55);
  const baseBodyDefAdapt = rng.rollRange01(0.20, 0.60);
  const baseSustainedDuckCounter = rng.rollRange01(0.15, 0.55);
  const basePostDodgeFollowup = rng.rollRange01(0.10, 0.50);

  let duck = baseDuck;
  let cross = baseCross;
  let body = baseBody;
  let counter = baseCounter;
  let lateral = baseLateral;
  let jab = baseJab;
  let patience = basePatience;
  let resetDist = baseResetDist;
  let engageDist = baseEngageDist;
  let cycleIn = baseCycleIn;
  let cycleOut = baseCycleOut;
  let defCycling = baseDefCycling;
  let guardDropCounter = baseGuardDropCounter;
  let chargePunch = baseChargePunch;
  let defDiscipline = baseDefDiscipline;
  let antiDuckUppercut = baseAntiDuckUppercut;
  let retreatTracking = baseRetreatTracking;
  let bodyDefAdapt = baseBodyDefAdapt;
  let sustainedDuckCounter = baseSustainedDuckCounter;
  let postDodgeFollowup = basePostDodgeFollowup;

  switch (archetype) {
    case "OutBoxer":
      jab += 0.15;
      patience += 0.12;
      lateral += 0.10;
      resetDist += 12;
      engageDist += 8;
      cross -= 0.08;
      duck -= 0.06;
      defDiscipline += 0.10;
      guardDropCounter += 0.08;
      antiDuckUppercut += 0.06;
      retreatTracking += 0.08;
      bodyDefAdapt += 0.05;
      sustainedDuckCounter += 0.10;
      postDodgeFollowup += 0.05;
      break;
    case "Brawler":
      body += 0.10;
      cross += 0.10;
      counter += 0.08;
      patience -= 0.15;
      cycleIn += 1.5;
      cycleOut -= 1.0;
      resetDist -= 10;
      engageDist -= 8;
      jab -= 0.10;
      defCycling += 0.10;
      chargePunch += 0.10;
      antiDuckUppercut += 0.12;
      bodyDefAdapt += 0.08;
      sustainedDuckCounter += 0.08;
      postDodgeFollowup += 0.10;
      break;
    case "Swarmer":
      patience -= 0.12;
      cycleIn += 2.0;
      cycleOut -= 1.5;
      lateral += 0.08;
      duck += 0.05;
      body += 0.06;
      resetDist -= 8;
      engageDist -= 10;
      defCycling += 0.05;
      retreatTracking += 0.12;
      antiDuckUppercut += 0.05;
      sustainedDuckCounter += 0.06;
      postDodgeFollowup += 0.08;
      break;
    default:
      break;
  }

  let quality: number;
  let duckCap: number;
  switch (band) {
    case "Hardcore":
      quality = 1.0;
      duckCap = 1.0;
      break;
    case "Hard":
      quality = 0.70;
      duckCap = 0.30;
      break;
    case "Medium":
      quality = 0.40;
      duckCap = 0.18;
      break;
    default:
      quality = 0.15;
      duckCap = 0.10;
      break;
  }

  duck = lerp(duck * 0.30, clamp01(duck), quality);
  duck = Math.min(duck, duckCap);
  cross = lerp(cross * 0.40, clamp01(cross), quality);
  body = lerp(body * 0.35, clamp01(body), quality);
  counter = lerp(counter * 0.25, clamp01(counter), quality);
  lateral = lerp(lateral * 0.30, clamp01(lateral), quality);
  jab = lerp(jab * 0.50, clamp01(jab), quality);
  patience = lerp(patience * 0.25, clamp01(patience), quality);
  resetDist = lerp(85, resetDist, quality);
  engageDist = lerp(80, engageDist, quality);
  cycleIn = lerp(cycleIn * 0.6 + 3, cycleIn, quality);
  cycleOut = lerp(cycleOut * 0.4 + 2, cycleOut, quality);
  defCycling = lerp(defCycling * 0.15, clamp01(defCycling), quality);
  guardDropCounter = lerp(guardDropCounter * 0.10, clamp01(guardDropCounter), quality);
  chargePunch = lerp(chargePunch * 0.15, clamp01(chargePunch), quality);
  defDiscipline = lerp(defDiscipline * 0.20, clamp01(defDiscipline), quality);
  antiDuckUppercut = lerp(antiDuckUppercut * 0.10, clamp01(antiDuckUppercut), quality);
  retreatTracking = lerp(retreatTracking * 0.10, clamp01(retreatTracking), quality);
  bodyDefAdapt = lerp(bodyDefAdapt * 0.10, clamp01(bodyDefAdapt), quality);
  sustainedDuckCounter = lerp(sustainedDuckCounter * 0.10, clamp01(sustainedDuckCounter), quality);
  postDodgeFollowup = lerp(postDodgeFollowup * 0.10, clamp01(postDodgeFollowup), quality);

  return {
    styleDuckApproach: clamp01(duck),
    styleCrossHeavy: clamp01(cross),
    styleBodyFocus: clamp01(body),
    styleCounterOffDuck: clamp01(counter),
    styleEngageCycleIn: clamp(cycleIn, 2.0, 8.0),
    styleEngageCycleOut: clamp(cycleOut, 2.0, 9.0),
    styleIdealResetDist: clamp(resetDist, 80, 140),
    styleIdealEngageDist: clamp(engageDist, 45, 90),
    styleLateralApproach: clamp01(lateral),
    styleJabSetup: clamp01(jab),
    stylePatience: clamp01(patience),
    styleDefenseCycling: clamp01(defCycling),
    styleCounterOffGuardDrop: clamp01(guardDropCounter),
    styleChargedPunchUsage: clamp01(chargePunch),
    styleDefenseDiscipline: clamp01(defDiscipline),
    styleAntiDuckUppercut: clamp01(antiDuckUppercut),
    styleRetreatTracking: clamp01(retreatTracking),
    styleBodyDefenseAdapt: clamp01(bodyDefAdapt),
    styleSustainedDuckCounter: clamp01(sustainedDuckCounter),
    stylePostDodgeFollowup: clamp01(postDodgeFollowup),
  };
}

// ===== BRAIN INITIALIZATION =====

export function initAiBrain(difficulty: AIDifficulty, archetype: Archetype, level: number, cpuVsCpu: boolean = false, rosterId?: number): AiBrainState {
  rng = new AiRNG(Date.now() ^ (level * 7919));
  const band = DIFFICULTY_TO_BAND[difficulty];
  const diffScore = band === "Easy" ? 0.15 : band === "Medium" ? 0.40 : band === "Hard" ? 0.70 : 0.95;
  const personality = createPersonality(band, archetype, rosterId);
  const biases = getArchetypeBiases(archetype);

  let winnerMindIntensity = lerp(0.3, 1.1, diffScore);
  const wmBase = rng.rollRange01(0.3, 0.7);
  winnerMindIntensity *= lerp(0.6, 1.4, wmBase);
  winnerMindIntensity = clamp(winnerMindIntensity, 0.2, 1.2);

  const winnerMindRoll01 = rollWinnerMind(band);
  const rhythmCutCommitRoll = rollRhythmCutCommit(band);
  const jabDoctrineRoll = rollJabDoctrine(band);
  const rhythmCutAgg = setBaseRhythmCutAggression(band);

  const style = createStyleProfile(band, archetype);

  if (cpuVsCpu) {
    style.stylePatience = clamp01(style.stylePatience * 0.25);
    style.styleEngageCycleIn = clamp(style.styleEngageCycleIn * 1.6, 3.0, 12.0);
    style.styleEngageCycleOut = clamp(style.styleEngageCycleOut * 0.35, 1.0, 3.0);
    style.styleDefenseDiscipline = clamp01(style.styleDefenseDiscipline * 0.5);
    style.styleIdealResetDist = clamp(style.styleIdealResetDist * 0.75, 50, 100);
  }

  const brain: AiBrainState = {
    currentState: "Maintain",
    currentPhase: band === "Easy" ? "Download" : "Probe",
    difficultyBand: band,
    difficultyScore: diffScore,
    personality,
    dataBank: createDataBank(),

    stateThinkTimer: 0,
    phaseThinkTimer: 0,
    moveThinkTimer: 0,
    attackThinkTimer: 0,
    defenseThinkTimer: 0,

    stateThinkInterval: lerp(0.50, 0.15, diffScore),
    phaseThinkInterval: lerp(1.00, 0.30, diffScore),
    moveThinkInterval: lerp(0.3125, 0.08, diffScore),
    attackThinkInterval: cpuVsCpu ? lerp(0.50, 0.12, diffScore) : lerp(0.875, 0.14, diffScore) / (band === "Easy" ? 3.25 : band === "Medium" ? 2.86 : band === "Hard" ? 2.6 : 1.3),
    defenseThinkInterval: lerp(0.375, 0.08, diffScore),

    defenseHoldTimer: 0,
    playerIdleTime: 0,
    playerCornerCamping: false,
    playerLastX: 0,
    playerLastZ: 0,
    playerCornerStallTimer: 0,

    prevMyStamina: -1,
    prevPlayerStamina: -1,
    punchesTakenByAI: 0,
    playerCleanHitsLanded: 0,
    punchesLandedByAI: 0,
    totalDamageTaken: 0,
    lastTimeTookHit: 0,

    headConditionScore: 0,
    bodyConditionScore: 0,

    survivalModeActive: false,

    perfectReactActive: false,
    perfectReactUntil: 0,
    nextPerfectReactTime: 0,
    perfectReactFadeFrac: 0,
    perfectReactBelowFullStaminaTimer: 0,
    forcedGuard: false,
    forcedHigh: false,
    forcedLow: false,
    forcedDuck: false,
    stepOutDesiredMove: 0,

    desiredMoveInput: 0,
    desiredMoveZ: 0,
    lateralDir: rng.next01() < 0.5 ? 1 : -1,
    lateralSwitchTimer: 0,
    hitReactRetreatTimer: 0,
    hitReactLateralDir: rng.next01() < 0.5 ? 1 : -1,

    counterModeActive: false,

    directionalSlider01: 0.50,
    playerHighBlockHeldSeconds: 0,
    playerLowBlockHeldSeconds: 0,

    scorecardBias: 0,

    classAggressionBias: biases.aggBias,
    classRangeBias: biases.rangeBias,
    classComboBias: biases.comboBias,

    winnerMindIntensity,
    winnerMindRoll01,

    rhythmCutAggression01: rhythmCutAgg,
    rhythmCutCommitChanceRoll01: rhythmCutCommitRoll,
    rhythmCutUntil: 0,
    nextRhythmCutAllowedTime: 0,

    jabDoctrineRoll01: jabDoctrineRoll,

    nextWinnerMindRerollAtTaken: 50,
    nextRhythmCutCommitRerollAtTaken: 30,
    nextJabDoctrineRerollAtTaken: 20,
    nextRhythmCutAggressionDriftAtLanded: 50,

    comboActive: false,
    comboSteps: [],
    comboStepIndex: 0,
    comboStepTimer: 0,
    comboCooldown: 0,

    gameTime: 0,

    attackRangeMin: blocksToPixels(0.30),
    attackRangeMax: blocksToPixels(1.35),
    idealRangeNeutral: blocksToPixels(1.00),
    idealRangePressure: blocksToPixels(0.65),
    idealRangeWhiffPunish: blocksToPixels(1.20),
    idealRangeCounter: blocksToPixels(1.10),
    idealRangeSurvival: blocksToPixels(1.60),
    rangeWidth: blocksToPixels(0.50),
    counterRangeWidth: blocksToPixels(0.35),

    playerLandedPunchCounts: {},

    ...style,
    adaptationRate: levelScale(level, 0.20, 0.70),
    engageCycleTimer: 0,
    engageCyclePhase: "out",
    defenseCycleTimer: 0,
    playerGuardDropTimer: 0,
    playerDuckApproachTimer: 0,
    playerBodyAttackRatio: 0,
    playerBodyAttackCount: 0,
    playerHeadAttackCount: 0,
    playerRetreatTimer: 0,
    playerSustainedDuckTimer: 0,
    playerDuckPunchCount: 0,
    playerDuckPunchDecay: 0,
    styleSustainedDuckCounter: style.styleSustainedDuckCounter,
    stylePostDodgeFollowup: style.stylePostDodgeFollowup,
    lastPunchDodgedTimer: 0,
    playerCrossCount: 0,
    playerTotalPunchCount: 0,
    playerLastDefenseSwitch: 0,
    playerPrevDefenseState: "none",
    recentPlayerPunches: [],
    playerApproaching: false,

    postFeintWindow: 0,
    postFeintPlayerDefense: "none",
    postFeintFollowupReady: false,

    reactionDelayTimer: 0,
    reactionDelayBase: band === "Easy" ? 0.28 : band === "Medium" ? 0.18 : band === "Hard" ? 0.10 : 0.04,
    reactionDelayPerHit: band === "Easy" ? 0.06 : band === "Medium" ? 0.04 : band === "Hard" ? 0.02 : 0.01,
    reactionDelayConsecutiveHits: 0,
    reactionDelayConsecutiveDecay: 0,

    adaptiveMemory: null,

    lastKnownPlayerSwaySpeed: -1,
    rhythmTimingAccuracy: 0,
    landedPunchDistSnapshots: [],
    aiLearntRangeAvg: 0,
    aiRhythmChangeTimer: 0,
    aiRhythmTargetLevel: 3,
    aiRhythmSpeedMult: 1.0 + (Math.random() * 0.2 - 0.1),
    rangeForgetChance: 0.35,

    duckBodyBias: rng.rollRange01(0.60, 0.90),
    standHeadBias: rng.rollRange01(0.60, 0.90),
    prevPlayerDuckState: false,

    whiffSnapshots: [],
    whiffLearnTimer: rng.rollRange01(8, 12),
    whiffLearnRangeNudge: 0,
    whiffLearnBodyBiasNudge: 0,
    whiffLearnKdPenalty: 0,

    guardHighProb: 0.75,
    guardReactionTimer: 0,
    guardReactionDelay: band === "Easy" ? rng.rollRange01(0.30, 0.50) : band === "Medium" ? rng.rollRange01(0.20, 0.35) : band === "Hard" ? rng.rollRange01(0.10, 0.22) : rng.rollRange01(0.05, 0.14),
    guardPendingSwitch: null,
    guardConditioningMemory: [],
    guardConditioningMax: 12,
    guardPredictionConfidence: band === "Easy" ? 0.35 : band === "Medium" ? 0.55 : band === "Hard" ? 0.75 : 0.90,
    guardFatigueReactionPenalty: 0,
  };

  try {
    const neuralDiffKey = band === "Easy" ? "journeyman" : band === "Medium" ? "contender" : band === "Hard" ? "elite" : "champion";
    const overrides = getNeuralOverrides(rosterId);
    const ns = overrides[neuralDiffKey as keyof typeof overrides];
    if (ns) {
      const b = 0.15;
      if (ns.stateThinkSpeed !== undefined) {
        const target = lerp(0.50, 0.15, ns.stateThinkSpeed);
        brain.stateThinkInterval = brain.stateThinkInterval * (1 - b) + target * b;
      }
      if (ns.moveThinkSpeed !== undefined) {
        const target = lerp(0.3125, 0.08, ns.moveThinkSpeed);
        brain.moveThinkInterval = brain.moveThinkInterval * (1 - b) + target * b;
      }
      if (ns.attackInterval !== undefined) {
        const target = lerp(0.875, 0.14, ns.attackInterval);
        brain.attackThinkInterval = brain.attackThinkInterval * (1 - b) + target * b;
      }
      if (ns.rhythmCutCommit !== undefined) {
        brain.rhythmCutCommitChanceRoll01 = brain.rhythmCutCommitChanceRoll01 * (1 - b) + ns.rhythmCutCommit * b;
      }
      if (ns.rhythmCutAggression !== undefined) {
        brain.rhythmCutAggression01 = brain.rhythmCutAggression01 * (1 - b) + ns.rhythmCutAggression * b;
      }
    }
  } catch {}

  return brain;
}

function rollWinnerMind(band: DifficultyBand): number {
  if (band === "Easy") return rng.rollRange01(0.05, 0.30);
  if (band === "Medium") return rng.rollRange01(0.30, 0.55);
  if (band === "Hard") return rng.rollRange01(0.55, 0.80);
  return rng.rollRange01(0.80, 1.00);
}

function rollRhythmCutCommit(band: DifficultyBand): number {
  if (band === "Medium") return rng.rollRange01(0.10, 0.40);
  if (band === "Hard") return rng.rollRange01(0.40, 0.70);
  if (band === "Hardcore") return rng.rollRange01(0.70, 0.95);
  return 0;
}

function rollJabDoctrine(band: DifficultyBand): number {
  if (band === "Easy") return rng.rollRange01(0.20, 0.30);
  if (band === "Medium") return rng.rollRange01(0.30, 0.40);
  if (band === "Hard") return rng.rollRange01(0.40, 0.50);
  return rng.rollRange01(0.50, 0.60);
}

function setBaseRhythmCutAggression(band: DifficultyBand): number {
  if (band === "Easy") return 0;
  if (band === "Medium") return 0.20;
  if (band === "Hard") return 0.50;
  return 0.80;
}

function getMyStaminaFrac(enemy: FighterState): number {
  return enemy.maxStamina > 0 ? clamp01(enemy.stamina / enemy.maxStamina) : 1;
}

function getPlayerStaminaFrac(player: FighterState): number {
  return player.maxStamina > 0 ? clamp01(player.stamina / player.maxStamina) : 1;
}

function getDistancePx(enemy: FighterState, player: FighterState): number {
  const dx = player.x - enemy.x;
  const dz = player.z - enemy.z;
  return Math.sqrt(dx * dx + dz * dz);
}

function getDirToPlayer(enemy: FighterState, player: FighterState): number {
  const dx = player.x - enemy.x;
  return dx > 0 ? 1 : dx < 0 ? -1 : 1;
}

function getScoreAggressionBias(brain: AiBrainState): number {
  return clamp(brain.scorecardBias, -1, 1);
}

function getCognitiveLoadBias(brain: AiBrainState, myFrac: number): number {
  if (myFrac <= DEEP_SURVIVAL_FRAC) return 1.35;
  if (brain.survivalModeActive) return 1.25;
  if (brain.currentPhase === "Panic") return 1.15;
  return 1.0;
}

// ===== THINK TIMING =====

function thinkAwake(timer: number, baseInterval: number, brain: AiBrainState, myFrac: number, dt: number): { awake: boolean; timer: number } {
  timer += dt;
  const staminaMult = lerp(1.35, 0.75, myFrac);
  const diffMult = lerp(1.15, 0.75, clamp01(brain.difficultyScore));
  const wmClamped = clamp(brain.winnerMindIntensity, 0.2, 1.2);
  const wmNorm = inverseLerp(0.2, 1.2, wmClamped);
  const winnerMult = lerp(1.05, 0.85, wmNorm);
  const cogBias = getCognitiveLoadBias(brain, myFrac);
  const interval = baseInterval * staminaMult * diffMult * winnerMult * Math.max(0.1, cogBias);
  if (timer >= interval) {
    return { awake: true, timer: 0 };
  }
  return { awake: false, timer };
}

function conditioningGateActive(brain: AiBrainState): boolean {
  if (brain.totalDamageTaken <= CONDITION_DAMAGE_GATE_MIN) return false;
  return brain.totalDamageTaken >= CONDITION_DAMAGE_GATE;
}

function getHeadConditionFraction(brain: AiBrainState): number {
  const threshold = brain.difficultyBand === "Easy" ? EASY_HEAD_CONDITION_THRESHOLD :
    brain.difficultyBand === "Medium" ? MEDIUM_HEAD_CONDITION_THRESHOLD :
    brain.difficultyBand === "Hard" ? HARD_HEAD_CONDITION_THRESHOLD :
    HARDCORE_HEAD_CONDITION_THRESHOLD;
  if (threshold <= 0) return 0;
  let baseFrac = clamp01(brain.headConditionScore / threshold);
  if (!conditioningGateActive(brain)) baseFrac *= 0.25;
  const dmgFrac = inverseLerp(CONDITION_DAMAGE_GATE_MIN, CONDITION_DAMAGE_GATE_MAX, brain.totalDamageTaken);
  return clamp01(baseFrac * lerp(0.5, 1.5, dmgFrac));
}

function getBodyConditionFraction(brain: AiBrainState): number {
  const threshold = brain.difficultyBand === "Easy" ? EASY_BODY_CONDITION_THRESHOLD :
    brain.difficultyBand === "Medium" ? MEDIUM_BODY_CONDITION_THRESHOLD :
    brain.difficultyBand === "Hard" ? HARD_BODY_CONDITION_THRESHOLD :
    HARDCORE_BODY_CONDITION_THRESHOLD;
  if (threshold <= 0) return 0;
  let baseFrac = clamp01(brain.bodyConditionScore / threshold);
  if (!conditioningGateActive(brain)) baseFrac *= 0.25;
  const dmgFrac = inverseLerp(CONDITION_DAMAGE_GATE_MIN, CONDITION_DAMAGE_GATE_MAX, brain.totalDamageTaken);
  return clamp01(baseFrac * lerp(0.5, 1.5, dmgFrac));
}

function getLastHits(db: AiDataBank, actor: "player" | "ai", count: number): AiHitSummary {
  const summary: AiHitSummary = { headHits: 0, bodyHits: 0 };
  let processed = 0;
  for (let i = db.recentHits.length - 1; i >= 0 && processed < count; i--) {
    const rec = db.recentHits[i];
    if (rec.actor !== actor) continue;
    processed++;
    if (rec.region === "head") summary.headHits++;
    else summary.bodyHits++;
  }
  return summary;
}

function getAiMomentum(db: AiDataBank, windowSeconds: number, gameTime: number): number {
  if (windowSeconds <= 0) return 0.5;
  let aiHits = 0, playerHits = 0;
  for (let i = db.recentHits.length - 1; i >= 0; i--) {
    const rec = db.recentHits[i];
    if (gameTime - rec.time > windowSeconds) break;
    if (rec.actor === "ai") aiHits++;
    else playerHits++;
  }
  const total = aiHits + playerHits;
  if (total === 0) return 0.5;
  const raw = (aiHits - playerHits) / total;
  return clamp01(0.5 + 0.5 * raw);
}

function getPlayerAggression(db: AiDataBank, windowSeconds: number, gameTime: number): number {
  if (windowSeconds <= 0) return 0;
  let playerHits = 0;
  for (let i = db.recentHits.length - 1; i >= 0; i--) {
    const rec = db.recentHits[i];
    if (gameTime - rec.time > windowSeconds) break;
    if (rec.actor === "player") playerHits++;
  }
  return clamp01(playerHits / 10);
}

function getWhiffCount(db: AiDataBank, actor: "player" | "ai", windowSeconds: number, inRangeOnly: boolean, gameTime: number): number {
  if (windowSeconds <= 0) return 0;
  let count = 0;
  for (let i = db.recentWhiffs.length - 1; i >= 0; i--) {
    const wr = db.recentWhiffs[i];
    if (gameTime - wr.time > windowSeconds) break;
    if (wr.actor !== actor) continue;
    if (inRangeOnly && !wr.inRange) continue;
    count++;
  }
  return count;
}

// ===== HIT DETECTION & COMBAT TRACKING =====

function logHit(db: AiDataBank, actor: "player" | "ai", region: "head" | "body", damage: number, inRange: boolean, gameTime: number): void {
  db.recentHits.push({ time: gameTime, actor, region, damage, inRange });
  if (db.recentHits.length > db.maxHitHistory) db.recentHits.shift();
  if (actor === "player" && inRange) {
    db.offensiveEvents.push({ time: gameTime, isFeint: false, inRange: true });
    pruneOffensiveEvents(db, gameTime);
    maybeBuildPattern(db, "punch", gameTime);
  }
}

function logWhiff(db: AiDataBank, actor: "player" | "ai", inRange: boolean, gameTime: number): void {
  db.recentWhiffs.push({ time: gameTime, actor, inRange });
  if (db.recentWhiffs.length > db.maxWhiffHistory) db.recentWhiffs.shift();
}

function pruneOffensiveEvents(db: AiDataBank, gameTime: number): void {
  const cutoff = gameTime - (db.patternWindowSeconds + 0.5);
  while (db.offensiveEvents.length > 0 && db.offensiveEvents[0].time < cutoff) {
    db.offensiveEvents.shift();
  }
}

function tryComputeCurrentTempo(db: AiDataBank, wantFeints: boolean, gameTime: number): { success: boolean; avgInterval: number; eventCount: number } {
  const windowStart = gameTime - db.patternWindowSeconds;
  const times: number[] = [];
  for (let i = db.offensiveEvents.length - 1; i >= 0; i--) {
    const e = db.offensiveEvents[i];
    if (e.time < windowStart) break;
    if (!e.inRange) continue;
    if (e.isFeint !== wantFeints) continue;
    times.push(e.time);
  }
  if (times.length < 2) return { success: false, avgInterval: 0, eventCount: 0 };
  times.sort((a, b) => a - b);
  let sum = 0;
  for (let i = 1; i < times.length; i++) sum += times[i] - times[i - 1];
  return { success: true, avgInterval: sum / (times.length - 1), eventCount: times.length };
}

function maybeBuildPattern(db: AiDataBank, kind: "punch" | "feint", gameTime: number): void {
  const { success, avgInterval, eventCount } = tryComputeCurrentTempo(db, kind === "feint", gameTime);
  if (!success) return;
  if (rng.next01() > 0.5) return;
  for (let i = 0; i < db.hitPatterns.length; i++) {
    const p = db.hitPatterns[i];
    if (p.kind !== kind) continue;
    if (Math.abs(p.avgInterval - avgInterval) < db.patternIntervalTolerance * 0.5) {
      db.hitPatterns[i].lastSeenTime = gameTime;
      return;
    }
  }
  db.hitPatterns.push({
    kind, avgInterval, eventCount, lastSeenTime: gameTime, successfulCounters: 0, locked: false,
  });
  if (db.hitPatterns.length > db.maxHitPatterns) {
    let oldestIdx = -1, oldestTime = Infinity;
    for (let i = 0; i < db.hitPatterns.length; i++) {
      if (db.hitPatterns[i].locked) continue;
      if (db.hitPatterns[i].lastSeenTime < oldestTime) {
        oldestTime = db.hitPatterns[i].lastSeenTime;
        oldestIdx = i;
      }
    }
    if (oldestIdx >= 0) db.hitPatterns.splice(oldestIdx, 1);
    else db.hitPatterns.shift();
  }
}

function tryGetCurrentPatternMatch(db: AiDataBank, windowSeconds: number, gameTime: number): { matched: boolean; patternIndex: number } {
  if (db.hitPatterns.length === 0) return { matched: false, patternIndex: -1 };
  const punch = tryComputeCurrentTempo(db, false, gameTime);
  if (!punch.success) return { matched: false, patternIndex: -1 };
  let bestDiff = Infinity, bestIdx = -1;
  for (let i = 0; i < db.hitPatterns.length; i++) {
    const p = db.hitPatterns[i];
    if (p.kind !== "punch") continue;
    const diff = Math.abs(p.avgInterval - punch.avgInterval);
    if (diff > db.patternIntervalTolerance) continue;
    const score = diff * (p.locked ? 0.9 : 1.0);
    if (score < bestDiff) {
      bestDiff = score;
      bestIdx = i;
    }
  }
  if (bestIdx >= 0) {
    db.hitPatterns[bestIdx].lastSeenTime = gameTime;
    return { matched: true, patternIndex: bestIdx };
  }
  return { matched: false, patternIndex: -1 };
}

function updateConditioning(brain: AiBrainState, dt: number): void {
  if (brain.headConditionScore > 0)
    brain.headConditionScore = Math.max(0, brain.headConditionScore - CONDITION_DECAY_PER_SEC * dt);
  if (brain.bodyConditionScore > 0)
    brain.bodyConditionScore = Math.max(0, brain.bodyConditionScore - CONDITION_DECAY_PER_SEC * dt);
}

function trackStaminaHitsAndPatterns(brain: AiBrainState, enemy: FighterState, player: FighterState): void {
  const myNow = enemy.stamina;
  const theirNow = player.stamina;
  if (brain.prevMyStamina < 0) brain.prevMyStamina = myNow;
  if (brain.prevPlayerStamina < 0) brain.prevPlayerStamina = theirNow;

  const myDelta = brain.prevMyStamina - myNow;
  const theirDelta = brain.prevPlayerStamina - theirNow;
  const dist = getDistancePx(enemy, player);
  const inPatternRange = dist <= PATTERN_RANGE_MAX_PX;

  if (myDelta >= HIT_DETECT_THRESHOLD) {
    brain.punchesTakenByAI++;
    brain.playerCleanHitsLanded++;
    brain.totalDamageTaken += myDelta;
    brain.lastTimeTookHit = brain.gameTime;
    brain.reactionDelayConsecutiveHits++;
    brain.reactionDelayConsecutiveDecay = 0;
    const delay = brain.reactionDelayBase + brain.reactionDelayPerHit * brain.reactionDelayConsecutiveHits;
    brain.reactionDelayTimer = Math.max(brain.reactionDelayTimer, delay);

    let hitReactThreshold = brain.difficultyBand === "Easy" ? 18 : brain.difficultyBand === "Medium" ? 14 : 8;
    if (brain.survivalModeActive) hitReactThreshold = Math.max(3, Math.floor(hitReactThreshold * 0.5));
    if (myDelta >= hitReactThreshold) {
      let reactDuration = brain.difficultyBand === "Hardcore" ? 0.35 : brain.difficultyBand === "Hard" ? 0.25 : brain.difficultyBand === "Medium" ? 0.18 : 0.12;
      if (brain.survivalModeActive) reactDuration *= 1.5;
      brain.hitReactRetreatTimer = Math.max(brain.hitReactRetreatTimer, reactDuration);
      brain.hitReactLateralDir = rng.next01() < 0.5 ? 1 : -1;
    }

    const last3 = getLastHits(brain.dataBank, "player", 3);
    const leanHead = last3.headHits >= last3.bodyHits;
    if (leanHead) brain.headConditionScore += HEAD_HIT_CONDITION_VALUE;
    else brain.bodyConditionScore += BODY_HIT_CONDITION_VALUE;

    const region: "head" | "body" = leanHead ? "head" : "body";
    const punchKey = player.currentPunch ? player.currentPunch : (leanHead ? "headHit" : "bodyHit");
    brain.playerLandedPunchCounts[punchKey] = (brain.playerLandedPunchCounts[punchKey] || 0) + 1;

    if (!player.punchAimsHead) {
      brain.playerBodyAttackCount++;
    } else {
      brain.playerHeadAttackCount++;
    }

    if (player.defenseState === "duck") {
      brain.playerDuckPunchCount++;
      brain.playerDuckPunchDecay = 0;
    }

    brain.playerTotalPunchCount = (brain.playerTotalPunchCount || 0) + 1;
    if (punchKey === "cross") brain.playerCrossCount = (brain.playerCrossCount || 0) + 1;
    if (!brain.recentPlayerPunches) brain.recentPlayerPunches = [];
    brain.recentPlayerPunches.push(punchKey);
    if (brain.recentPlayerPunches.length > 10) brain.recentPlayerPunches.shift();

    logHit(brain.dataBank, "player", region, myDelta, inPatternRange, brain.gameTime);

    maybeHandleRerolls(brain);

    // Getting hit disrupts the AI's rhythm plan and erodes its timing read
    if (rng.chance(0.60)) {
      const shift = rng.chance(0.50) ? 1 : -1;
      brain.aiRhythmTargetLevel = clamp(brain.aiRhythmTargetLevel + shift, 1, 5);
      brain.aiRhythmChangeTimer = 0; // apply the shift promptly
    }
    brain.rhythmTimingAccuracy = clamp01(brain.rhythmTimingAccuracy - 0.08);
  }

  if (theirDelta >= HIT_DETECT_THRESHOLD) {
    brain.punchesLandedByAI++;
    logHit(brain.dataBank, "ai", "head", theirDelta, inPatternRange, brain.gameTime);
    maybeHandleRhythmCutDrift(brain);
    // Difficulty-scaled chance to actually learn from this punch
    const learnChanceByBand: Record<DifficultyBand, number> = {
      Easy: 0.35, Medium: 0.50, Hard: 0.65, Hardcore: 0.75,
    };
    if (rng.chance(learnChanceByBand[brain.difficultyBand])) {
      snapLandedPunchRange(brain, enemy, player);
    }
  }

  brain.prevMyStamina = myNow;
  brain.prevPlayerStamina = theirNow;
}

function maybeHandleRerolls(brain: AiBrainState): void {
  if (brain.punchesTakenByAI >= brain.nextWinnerMindRerollAtTaken) {
    brain.winnerMindRoll01 = rollWinnerMind(brain.difficultyBand);
    brain.winnerMindIntensity = brain.winnerMindRoll01;
    brain.nextWinnerMindRerollAtTaken = brain.punchesTakenByAI + 50;
  }
  if (brain.punchesTakenByAI >= brain.nextRhythmCutCommitRerollAtTaken) {
    brain.rhythmCutCommitChanceRoll01 = rollRhythmCutCommit(brain.difficultyBand);
    brain.nextRhythmCutCommitRerollAtTaken = brain.punchesTakenByAI + 30;
  }
  if (brain.punchesTakenByAI >= brain.nextJabDoctrineRerollAtTaken) {
    brain.jabDoctrineRoll01 = rollJabDoctrine(brain.difficultyBand);
    brain.nextJabDoctrineRerollAtTaken = brain.punchesTakenByAI + 20;
  }
}

function maybeHandleRhythmCutDrift(brain: AiBrainState): void {
  if (brain.punchesLandedByAI < brain.nextRhythmCutAggressionDriftAtLanded) return;
  const drift = rng.rollRange01(-0.01, 0.01);
  brain.rhythmCutAggression01 = clamp01(brain.rhythmCutAggression01 + drift);
  brain.nextRhythmCutAggressionDriftAtLanded += 50;
}

function updateSurvivalMode(brain: AiBrainState, myFrac: number): void {
  brain.survivalModeActive = myFrac <= SURVIVAL_FRAC;
}

function evaluateState(brain: AiBrainState, enemy: FighterState, player: FighterState): void {
  const myFrac = getMyStaminaFrac(enemy);
  const theirFrac = getPlayerStaminaFrac(player);
  const dist = getDistancePx(enemy, player);

  if (myFrac <= DEEP_SURVIVAL_FRAC) {
    brain.currentState = "Panic";
    brain.currentPhase = "Panic";
    return;
  }
  if (brain.survivalModeActive) {
    brain.currentState = "Retreat";
    if (brain.currentPhase !== "Panic") brain.currentPhase = "Panic";
    return;
  }
  if (theirFrac <= PLAYER_FINISH_FRAC) {
    brain.currentState = dist <= brain.attackRangeMax ? "Maintain" : "Approach";
    brain.currentPhase = "Finish";
    return;
  }

  const ideal = getIdealRangeForPhase(brain);
  const width = brain.currentPhase === "Counter" ? brain.counterRangeWidth : brain.rangeWidth;
  const min = Math.max(blocksToPixels(0.2), ideal - width * 0.5);
  const max = ideal + width * 0.5;

  const bias = getScoreAggressionBias(brain);
  const aheadFactor = clamp01(-bias);
  const behindFactor = clamp01(bias);
  const clean = brain.personality.cleanHitsOverVolume;

  const approachReluctance = aheadFactor * blocksToPixels(0.25) + lerp(0, blocksToPixels(0.18), clean);
  const retreatReluctance = behindFactor * blocksToPixels(0.15) + lerp(0, blocksToPixels(0.08), clean);

  if (dist > max + blocksToPixels(0.08) + approachReluctance) brain.currentState = "Approach";
  else if (dist < min - blocksToPixels(0.08) - retreatReluctance) brain.currentState = "Retreat";
  else brain.currentState = "Maintain";
}

function evaluatePhase(brain: AiBrainState, enemy: FighterState, player: FighterState): void {
  const myFrac = getMyStaminaFrac(enemy);
  const theirFrac = getPlayerStaminaFrac(player);

  if (myFrac <= DEEP_SURVIVAL_FRAC || brain.survivalModeActive) {
    brain.currentPhase = "Panic";
    return;
  }
  if (theirFrac <= PLAYER_FINISH_FRAC) {
    brain.currentPhase = "Finish";
    return;
  }
  if (brain.counterModeActive) {
    brain.currentPhase = "Counter";
    return;
  }

  const momentum = getAiMomentum(brain.dataBank, 6, brain.gameTime);
  const playerAgg = getPlayerAggression(brain.dataBank, 6, brain.gameTime);
  const headCond = getHeadConditionFraction(brain);
  const bodyCond = getBodyConditionFraction(brain);
  const scoreBias = getScoreAggressionBias(brain);
  const scoreInfluence = clamp(scoreBias * 0.18, -0.18, 0.18);
  const adjustedMomentum = clamp01(momentum - scoreInfluence);
  const winning = adjustedMomentum > 0.60;
  const losing = adjustedMomentum < 0.40;
  const clean = brain.personality.cleanHitsOverVolume;

  if (losing && playerAgg > 0.55) { brain.currentPhase = "WhiffPunish"; return; }
  if (clean > 0.62 && playerAgg > 0.42) { brain.currentPhase = "WhiffPunish"; return; }
  if (bodyCond > headCond + 0.15 && bodyCond > 0.35) { brain.currentPhase = "BodyHunt"; return; }
  if (winning && myFrac > LOW_STAMINA_FRAC && clean < 0.55) { brain.currentPhase = "Pressure"; return; }
  if (brain.difficultyBand === "Easy") brain.currentPhase = "Download";
  else brain.currentPhase = "Probe";
}

function getIdealRangeForPhase(brain: AiBrainState): number {
  let baseIdeal: number;
  switch (brain.currentPhase) {
    case "Pressure": baseIdeal = brain.idealRangePressure; break;
    case "WhiffPunish": baseIdeal = brain.idealRangeWhiffPunish; break;
    case "Counter": baseIdeal = brain.idealRangeCounter; break;
    case "Panic": baseIdeal = brain.idealRangeSurvival; break;
    case "Finish": baseIdeal = brain.idealRangePressure; break;
    case "BodyHunt": baseIdeal = brain.idealRangeNeutral; break;
    default: baseIdeal = brain.idealRangeNeutral; break;
  }

  const bias = getScoreAggressionBias(brain);
  const shiftPx = blocksToPixels(clamp(0.35, 0, 0.75));
  let ideal = baseIdeal - bias * shiftPx + brain.classRangeBias * AI_BLOCK_PX;
  const clean = brain.personality.cleanHitsOverVolume;

  if (brain.currentPhase !== "Pressure" && brain.currentPhase !== "Finish" && brain.currentPhase !== "Panic") {
    ideal += lerp(-blocksToPixels(0.02), blocksToPixels(0.18), clean);
  }

  // Blend toward empirically-learnt effective attack range as sample count grows
  if (brain.aiLearntRangeAvg > 0 && brain.landedPunchDistSnapshots.length >= 3) {
    const blendT = clamp01(brain.landedPunchDistSnapshots.length / 8) * 0.55;
    ideal = lerp(ideal, brain.aiLearntRangeAvg, blendT);
  }

  // Whiff-learning range nudge: mid-fight adjustments from missed shot analysis
  ideal += brain.whiffLearnRangeNudge;

  return clamp(ideal, blocksToPixels(0.35), blocksToPixels(2.25));
}

function updateEngageCycle(brain: AiBrainState, dt: number): void {
  brain.engageCycleTimer += dt;
  const adaptIn = getSlotValue(brain.adaptiveMemory, "engageCycleInBias");
  const adaptOut = getSlotValue(brain.adaptiveMemory, "engageCycleOutBias");
  if (brain.engageCyclePhase === "in") {
    if (brain.engageCycleTimer >= Math.max(0.5, brain.styleEngageCycleIn + adaptIn * 3.0)) {
      brain.engageCyclePhase = "out";
      brain.engageCycleTimer = 0;
    }
  } else {
    if (brain.engageCycleTimer >= Math.max(0.5, brain.styleEngageCycleOut + adaptOut * 2.0)) {
      brain.engageCyclePhase = "in";
      brain.engageCycleTimer = 0;
    }
  }
}

function reactToPlayerTelegraph(brain: AiBrainState, enemy: FighterState, player: FighterState): void {
  if (enemy.isPunching || enemy.isKnockedDown || enemy.stunBlockDisableTimer > 0) return;
  if (player.telegraphPhase === "none") return;

  const telegraphPct = player.telegraphDuration > 0 ? player.telegraphTimer / player.telegraphDuration : 0;
  if (telegraphPct < 0.3) return;

  if (enemy.defenseState === "fullGuard") return;

  const baseChance: Record<DifficultyBand, number> = {
    Hardcore: 0.95,
    Hard: 0.90,
    Medium: 0.85,
    Easy: 0.80,
  };

  const decay = Math.floor(brain.playerCleanHitsLanded / 10) * 0.0025;
  const chance = Math.max(0.40, baseChance[brain.difficultyBand] - decay);

  if (rng.chance(chance)) {
    const weaveChance: Record<DifficultyBand, number> = {
      Hardcore: 0.25,
      Hard: 0.18,
      Medium: 0.10,
      Easy: 0.05,
    };
    if (!enemy.weaveActive && enemy.weaveCooldown <= 0 && !enemy.isPunching && rng.chance(weaveChance[brain.difficultyBand])) {
      enemy.weaveDirX = rng.chance(0.5) ? -1 : 1;
      enemy.weaveDirY = 0;
      enemy.weaveActive = true;
      enemy.weaveProgress = 0;
      enemy.preWeaveStance = enemy.stance;
      enemy.stance = "backFoot";
    } else {
      enemy.defenseState = "fullGuard";
    }
  }
}

// ===== DEFENSE CYCLING & PLAYER TRACKING =====

function updateDefenseCycling(brain: AiBrainState, enemy: FighterState, player: FighterState, dt: number): void {
  brain.defenseCycleTimer += dt;
  const cycling = brain.styleDefenseCycling;
  if (cycling < 0.15) return;

  const dist = getDistancePx(enemy, player);
  if (dist > brain.attackRangeMax * 1.5) return;

  const isChamp = brain.difficultyBand === "Hardcore" || brain.difficultyBand === "Hard";
  const cycleMin = isChamp ? 0.55 : 0.25;
  const cycleInterval = lerp(0.8, cycleMin, cycling);
  if (brain.defenseCycleTimer < cycleInterval) return;
  brain.defenseCycleTimer = 0;

  if (enemy.isPunching || brain.perfectReactActive) return;
  if (enemy.stunBlockDisableTimer > 0) return;

  const current = enemy.defenseState;
  const r = rng.next01();

  const bodyHeavy = brain.playerBodyAttackRatio > 0.6 && brain.styleBodyDefenseAdapt > 0.2 && rng.chance(brain.adaptationRate);
  const playerClose = dist < brain.attackRangeMax * 1.1;
  const playerDangerous = player.isPunching || player.handsDown || player.defenseState === "duck";
  const playerTelegraphing = player.telegraphPhase !== "none";
  const suppressGuardDrop = isChamp && (playerClose && playerDangerous || playerTelegraphing);
  const playerDucked = player.defenseState === "duck";
  const playerUppercutThreat = brain.playerLandedPunchCounts["leftUppercut"] > 0 || brain.playerLandedPunchCounts["rightUppercut"] > 0;
  const suppressDuck = isChamp && playerUppercutThreat && rng.chance(brain.adaptationRate * 0.8);

  const isHardcore = brain.difficultyBand === "Hardcore";
  const champSuppressCycling = isChamp && rng.chance(isHardcore ? 0.60 : 0.50);
  if (champSuppressCycling) return;

  const setAiBlock = (state: DefenseState) => {
    enemy.defenseState = state;
  };

  const cycleRateDown = isChamp ? cycling * 0.20 : cycling * 0.5;
  const cycleRateSwitch = isChamp ? cycling * 0.15 : cycling * 0.4;

  if (current === "none" && r < cycleRateDown) {
    const pick = rng.next01();
    if (bodyHeavy) {
      if (pick < 0.55) setAiBlock("fullGuard");
      else if (pick < 0.80) setAiBlock("fullGuard");
      else setAiBlock(suppressDuck ? "fullGuard" : "duck");
    } else {
      if (pick < 0.30) setAiBlock(suppressDuck ? "fullGuard" : "duck");
      else if (pick < 0.60) setAiBlock("fullGuard");
      else setAiBlock("fullGuard");
    }
    if (isChamp && playerDucked) {
      if (enemy.defenseState === "duck") setAiBlock("fullGuard");
    }
  } else if (current !== "none" && r < cycleRateSwitch) {
    const pick = rng.next01();
    if (current === "duck") {
      if (isChamp) {
        setAiBlock(pick < 0.35 ? "none" : "fullGuard");
      } else {
        setAiBlock(pick < 0.5 ? "fullGuard" : "fullGuard");
      }
    } else if (current === "fullGuard") {
      if (bodyHeavy) {
        const noneChance = suppressGuardDrop ? 0.0 : (isChamp ? 0.15 : 0.2);
        setAiBlock(pick < 0.3 ? "fullGuard" : pick < 0.3 + noneChance ? "none" : "fullGuard");
      } else {
        if (suppressGuardDrop) {
          setAiBlock(pick < 0.5 ? (suppressDuck ? "fullGuard" : "duck") : "fullGuard");
        } else {
          const noneWeight = isChamp ? 0.20 : 0.30;
          setAiBlock(pick < 0.3 ? (suppressDuck ? "fullGuard" : "duck") : pick < 0.3 + noneWeight ? "none" : "fullGuard");
        }
      }
    }
    if (isChamp && playerDucked && enemy.defenseState === "duck") {
      setAiBlock("fullGuard");
    }
  }
}

function updateAiDirectionalGuard(brain: AiBrainState, enemy: FighterState, player: FighterState, dt: number): void {
  if (enemy.isKnockedDown || enemy.isPunching || enemy.defenseState === "duck") return;

  const staminaFrac = enemy.stamina / enemy.maxStamina;
  brain.guardFatigueReactionPenalty = Math.max(0, (1 - staminaFrac) * 0.15);

  const mem = brain.guardConditioningMemory;
  const now = brain.gameTime;
  while (mem.length > 0 && now - mem[0].time > 15) mem.shift();

  let headDmg = 0, bodyDmg = 0;
  for (const m of mem) {
    if (m.zone === "head") headDmg += m.damage;
    else bodyDmg += m.damage;
  }
  const totalDmg = headDmg + bodyDmg;
  if (totalDmg > 0) {
    const headFrac = headDmg / totalDmg;
    const adaptSpeed = brain.difficultyBand === "Hardcore" ? 0.04 : brain.difficultyBand === "Hard" ? 0.03 : brain.difficultyBand === "Medium" ? 0.02 : 0.01;
    const target = 0.50 + headFrac * 0.40;
    brain.guardHighProb += (target - brain.guardHighProb) * adaptSpeed;
  } else {
    brain.guardHighProb += (0.75 - brain.guardHighProb) * 0.005;
  }

  const fatigueNoise = brain.guardFatigueReactionPenalty > 0.05 ? (rng.next01() - 0.5) * brain.guardFatigueReactionPenalty * 0.3 : 0;
  brain.guardHighProb = clamp01(brain.guardHighProb + fatigueNoise);
  brain.guardHighProb = Math.max(0.10, Math.min(0.90, brain.guardHighProb));

  if (player.telegraphPhase !== "none" && player.telegraphPunchType) {
    const telegraphPct = player.telegraphDuration > 0 ? player.telegraphTimer / player.telegraphDuration : 0;
    if (telegraphPct > 0.4) {
      const pType = player.telegraphPunchType;
      const config = PUNCH_CONFIGS[pType];
      const predictHead = config ? config.hitsHead : true;
      const confRoll = rng.next01();
      if (confRoll < brain.guardPredictionConfidence) {
        const desired: "high" | "low" = predictHead ? "high" : "low";
        if (brain.guardPendingSwitch !== desired) {
          brain.guardPendingSwitch = desired;
          const baseDelay = brain.guardReactionDelay + brain.guardFatigueReactionPenalty;
          const jitter = (rng.next01() - 0.5) * baseDelay * 0.3;
          brain.guardReactionTimer = Math.max(0.02, baseDelay + jitter);
        }
      }
    }
  }

  if (brain.guardReactionTimer > 0) {
    brain.guardReactionTimer -= dt;
    if (brain.guardReactionTimer <= 0) {
      brain.guardReactionTimer = 0;
      if (brain.guardPendingSwitch) {
        if (brain.guardPendingSwitch === "high") {
          enemy.defenseState = "fullGuard";
        } else {
          enemy.defenseState = "none";
          enemy.handsDown = false;
        }
        brain.guardPendingSwitch = null;
      }
    }
  }

  if (!brain.guardPendingSwitch) {
    if (rng.chance(0.02)) {
      if (rng.next01() < brain.guardHighProb) {
        enemy.defenseState = "fullGuard";
      } else {
        enemy.defenseState = "none";
        enemy.handsDown = false;
      }
    }
  }
}

function trackPlayerGuardDrop(brain: AiBrainState, player: FighterState, dt: number): void {
  if (player.handsDown && !player.isPunching) {
    brain.playerGuardDropTimer += dt;
  } else {
    brain.playerGuardDropTimer = 0;
  }
}

function trackPlayerDuckApproach(brain: AiBrainState, enemy: FighterState, player: FighterState, dt: number): void {
  const dist = getDistancePx(enemy, player);
  const playerDucked = player.defenseState === "duck";
  const closing = dist < brain.attackRangeMax * 1.8;
  if (playerDucked && closing) {
    brain.playerDuckApproachTimer += dt;
  } else {
    brain.playerDuckApproachTimer = Math.max(0, brain.playerDuckApproachTimer - dt * 2);
  }
}

function trackPlayerRetreat(brain: AiBrainState, enemy: FighterState, player: FighterState, dt: number): void {
  const dist = getDistancePx(enemy, player);
  const movingAway = dist > brain.styleIdealResetDist * 1.2 && player.handsDown && !player.isPunching;
  if (movingAway) {
    brain.playerRetreatTimer += dt;
  } else {
    brain.playerRetreatTimer = Math.max(0, brain.playerRetreatTimer - dt * 1.5);
  }
}

function updatePlayerBodyRatio(brain: AiBrainState): void {
  const total = brain.playerBodyAttackCount + brain.playerHeadAttackCount;
  if (total > 0) {
    brain.playerBodyAttackRatio = brain.playerBodyAttackCount / total;
  }
}

function trackPlayerSustainedDuck(brain: AiBrainState, enemy: FighterState, player: FighterState, dt: number): void {
  const dist = getDistancePx(enemy, player);
  const playerDucked = player.defenseState === "duck";
  const inRange = dist < brain.attackRangeMax * 1.5;
  if (playerDucked && inRange) {
    brain.playerSustainedDuckTimer += dt;
  } else {
    brain.playerSustainedDuckTimer = Math.max(0, brain.playerSustainedDuckTimer - dt * 3);
  }

  brain.playerDuckPunchDecay += dt;
  if (brain.playerDuckPunchDecay >= 3.0) {
    brain.playerDuckPunchCount = Math.max(0, brain.playerDuckPunchCount - 1);
    brain.playerDuckPunchDecay = 0;
  }

  if (brain.lastPunchDodgedTimer > 0) {
    brain.lastPunchDodgedTimer -= dt;
    if (brain.lastPunchDodgedTimer < 0) brain.lastPunchDodgedTimer = 0;
  }
}

function trackPlayerDefenseSwitch(brain: AiBrainState, player: FighterState): void {
  const curDef = player.defenseState;
  if (curDef !== brain.playerPrevDefenseState) {
    if (brain.playerPrevDefenseState === "fullGuard" && curDef === "duck") {
      brain.playerLastDefenseSwitch = brain.gameTime;
    }
    brain.playerPrevDefenseState = curDef;
  }
}

function trackPlayerApproach(brain: AiBrainState, enemy: FighterState, player: FighterState): void {
  const dist = getDistancePx(enemy, player);
  brain.playerApproaching = dist < brain.attackRangeMax * 1.5 && dist > brain.attackRangeMin;
}

// ===== RING CUTOFF (Champion AI) =====

function getPlayerRopeProximity(player: FighterState, ringLeft: number, ringRight: number, ringTop: number, ringBottom: number): number {
  const cx = (ringLeft + ringRight) / 2;
  const cy = (ringTop + ringBottom) / 2;
  const hw = (ringRight - ringLeft) / 2;
  const hh = (ringBottom - ringTop) / 2;
  const dx = Math.abs(player.x - cx) / hw;
  const dz = Math.abs(player.z - cy) / hh;
  return dx + dz;
}

function tryRingCutoff(brain: AiBrainState, enemy: FighterState, player: FighterState, state: GameState): boolean {
  if (brain.playerCornerCamping || brain.playerIdleTime > 1.5) return false;

  const rl = state.ringLeft;
  const rr = state.ringRight;
  const rt = state.ringTop;
  const rb = state.ringBottom;
  const cx = (rl + rr) / 2;
  const cy = (rt + rb) / 2;

  const playerRopeProx = getPlayerRopeProximity(player, rl, rr, rt, rb);
  const adaptRingCut = getSlotValue(brain.adaptiveMemory, "ringCutoffUrgency");
  const threshold = (brain.difficultyBand === "Hardcore" ? 0.58 : 0.66) - adaptRingCut * 0.15;
  if (playerRopeProx < threshold) return false;

  const aiRopeProx = getPlayerRopeProximity(enemy, rl, rr, rt, rb);
  if (aiRopeProx > 0.75) return false;

  const dist = getDistancePx(enemy, player);
  if (dist > brain.attackRangeMax * 3) return false;

  const xDiff = player.x - enemy.x;
  const zDiffFromCenter = enemy.z - cy;
  let moveX = 0;
  let moveZ = 0;

  if (Math.abs(zDiffFromCenter) > 8) {
    moveZ = zDiffFromCenter > 0 ? -0.25 : 0.25;
  }

  if (dist < brain.attackRangeMin) {
    moveX = xDiff > 0 ? -0.25 : 0.25;
  } else if (dist > brain.attackRangeMax * 1.3) {
    const advance = brain.difficultyBand === "Hardcore" ? 0.65 : 0.5;
    moveX = xDiff > 0 ? advance : -advance;
  } else {
    moveX = xDiff > 0 ? 0.12 : -0.12;
  }

  brain.desiredMoveInput = clamp(moveX, -1, 1);
  brain.desiredMoveZ = clamp(moveZ, -1, 1);

  return true;
}

// ===== MOVEMENT =====

function updateLateralDir(brain: AiBrainState, dt: number): void {
  brain.lateralSwitchTimer += dt;
  let switchInterval: number;
  switch (brain.difficultyBand) {
    case "Hardcore": switchInterval = lerp(2.0, 3.0, rng.next01()); break;
    case "Hard": switchInterval = lerp(1.5, 2.5, rng.next01()); break;
    case "Medium": switchInterval = lerp(1.0, 2.0, rng.next01()); break;
    default: switchInterval = lerp(0.6, 1.5, rng.next01()); break;
  }
  if (brain.survivalModeActive) switchInterval *= 0.5;
  if (brain.lateralSwitchTimer >= switchInterval) {
    brain.lateralSwitchTimer = 0;
    brain.lateralDir = (brain.lateralDir === 1 ? -1 : 1) as 1 | -1;
  }
}

function tryRopeEscape(brain: AiBrainState, enemy: FighterState, player: FighterState, state: GameState): boolean {
  if (brain.playerCornerCamping || brain.playerIdleTime > 1.5) return false;

  const rl = state.ringLeft;
  const rr = state.ringRight;
  const rt = state.ringTop;
  const rb = state.ringBottom;
  const cx = (rl + rr) / 2;
  const cy = (rt + rb) / 2;

  const aiRopeProx = getPlayerRopeProximity(enemy, rl, rr, rt, rb);
  let threshold: number;
  switch (brain.difficultyBand) {
    case "Hardcore": threshold = 0.68; break;
    case "Hard": threshold = 0.74; break;
    case "Medium": threshold = 0.80; break;
    default: threshold = 0.86; break;
  }
  if (brain.survivalModeActive) threshold -= 0.15;
  if (aiRopeProx < threshold) return false;

  const toCenterX = cx - enemy.x;
  const toCenterZ = cy - enemy.z;
  const len = Math.sqrt(toCenterX * toCenterX + toCenterZ * toCenterZ);
  if (len < 1) return false;

  const normX = toCenterX / len;
  const normZ = toCenterZ / len;
  const perpX = -normZ;
  const perpZ = normX;

  let lateralStr: number;
  switch (brain.difficultyBand) {
    case "Hardcore": lateralStr = 0.55; break;
    case "Hard": lateralStr = 0.40; break;
    case "Medium": lateralStr = 0.28; break;
    default: lateralStr = 0.15; break;
  }
  if (brain.survivalModeActive) lateralStr += 0.15;
  const centerWeight = brain.difficultyBand === "Easy" ? 0.50 : (brain.survivalModeActive ? 0.85 : 0.70);
  brain.desiredMoveInput = clamp(normX * centerWeight + perpX * brain.lateralDir * lateralStr, -1, 1);
  brain.desiredMoveZ = clamp(normZ * centerWeight + perpZ * brain.lateralDir * lateralStr, -1, 1);
  return true;
}

function thinkMovement(brain: AiBrainState, enemy: FighterState, player: FighterState, state?: GameState): void {
  if (brain.perfectReactActive && Math.abs(brain.stepOutDesiredMove) > 0.01) return;

  const gdx = player.x - enemy.x;
  const gdz = player.z - enemy.z;
  const dist = Math.sqrt(gdx * gdx + gdz * gdz);
  const dirX = dist > 0.01 ? gdx / dist : 1;
  const dirZ = dist > 0.01 ? gdz / dist : 0;
  const perpX = -dirZ;
  const perpZ = dirX;

  const band = brain.difficultyBand;
  const isChampTier = band === "Hardcore" || band === "Hard";
  const lateralBias = brain.lateralDir;
  let lateralStrength = 0;

  if (brain.hitReactRetreatTimer > 0) {
    let retreatLateral: number;
    switch (band) {
      case "Hardcore": retreatLateral = 0.65; break;
      case "Hard": retreatLateral = 0.50; break;
      case "Medium": retreatLateral = 0.35; break;
      default: retreatLateral = 0.20; break;
    }
    const retreatRadial = band === "Easy" ? 0.50 : 0.70;
    brain.desiredMoveInput = clamp(-dirX * retreatRadial + perpX * brain.hitReactLateralDir * retreatLateral, -1, 1);
    brain.desiredMoveZ = clamp(-dirZ * retreatRadial + perpZ * brain.hitReactLateralDir * retreatLateral, -1, 1);
    return;
  }

  if (brain.survivalModeActive) {
    if (state && tryRopeEscape(brain, enemy, player, state)) return;

    const ideal = getIdealRangeForPhase(brain);
    const retreatUrgency = dist < ideal ? 1.0 : dist < ideal * 1.3 ? 0.4 : 0;
    if (retreatUrgency > 0) {
      brain.desiredMoveInput = clamp(-dirX * retreatUrgency, -1, 1);
      brain.desiredMoveZ = clamp(-dirZ * retreatUrgency, -1, 1);
    } else {
      brain.desiredMoveInput = 0;
      brain.desiredMoveZ = 0;
    }
    switch (band) {
      case "Hardcore": lateralStrength = 0.75; break;
      case "Hard": lateralStrength = 0.65; break;
      case "Medium": lateralStrength = 0.50; break;
      default: lateralStrength = 0.35; break;
    }
    brain.desiredMoveInput += perpX * lateralBias * lateralStrength;
    brain.desiredMoveZ += perpZ * lateralBias * lateralStrength;
    return;
  }

  const adaptLateral = getSlotValue(brain.adaptiveMemory, "lateralVsLinear");
  const adaptRopePressure = getSlotValue(brain.adaptiveMemory, "ropePressureDuration");
  const adaptStamConserve = getSlotValue(brain.adaptiveMemory, "staminaConservation");
  const adaptAntiCorner = getSlotValue(brain.adaptiveMemory, "antiCornerPressure");

  if (state) {
    if (tryRopeEscape(brain, enemy, player, state)) return;
    const ringCutAdapt = getSlotValue(brain.adaptiveMemory, "ringCutoffUrgency");
    if (isChampTier || ringCutAdapt > 0.1) {
      const cutoff = tryRingCutoff(brain, enemy, player, state);
      if (cutoff) return;
    }
  }

  if (dist <= Math.max(blocksToPixels(0.10), OVERLAP_HARD_MIN_DIST_PX)) {
    let escapeLateral: number;
    switch (band) {
      case "Hardcore": escapeLateral = 0.45; break;
      case "Hard": escapeLateral = 0.35; break;
      case "Medium": escapeLateral = 0.20; break;
      default: escapeLateral = 0.10; break;
    }
    brain.desiredMoveInput = clamp(-dirX + perpX * lateralBias * escapeLateral, -1, 1);
    brain.desiredMoveZ = clamp(-dirZ + perpZ * lateralBias * escapeLateral, -1, 1);
    return;
  }

  if (dist < brain.attackRangeMin) {
    let escapeLateral: number;
    switch (band) {
      case "Hardcore": escapeLateral = 0.40; break;
      case "Hard": escapeLateral = 0.30; break;
      case "Medium": escapeLateral = 0.18; break;
      default: escapeLateral = 0.08; break;
    }
    brain.desiredMoveInput = clamp(-dirX + perpX * lateralBias * escapeLateral, -1, 1);
    brain.desiredMoveZ = clamp(-dirZ + perpZ * lateralBias * escapeLateral, -1, 1);
    return;
  }

  if ((brain.playerIdleTime > 0.5 || brain.playerCornerCamping) && dist > brain.attackRangeMin) {
    const approachUrgency = brain.playerCornerCamping ? 1.0 : Math.min((brain.playerIdleTime - 0.5) / 1.0, 1.0);
    const radial = lerp(0.5, 1.0, approachUrgency);
    brain.desiredMoveInput = clamp(dirX * radial, -1, 1);
    brain.desiredMoveZ = clamp(dirZ * radial, -1, 1);
    return;
  }

  const patience = brain.stylePatience;
  const useEngageCycle = patience > 0.25 && brain.currentPhase !== "Panic" && brain.currentPhase !== "Finish";

  if (useEngageCycle) {
    const resetDist = brain.styleIdealResetDist;
    const engageDist = brain.styleIdealEngageDist;
    let moveRadial = 0;

    if (brain.engageCyclePhase === "out") {
      if (dist < resetDist - 10) {
        moveRadial = -1;
      } else if (dist > resetDist + 15) {
        moveRadial = rng.chance(0.3) ? 1 : 0;
      } else {
        moveRadial = rng.chance(0.15) ? (rng.chance(0.5) ? 1 : -1) : 0;
      }
      switch (band) {
        case "Hardcore": lateralStrength = lerp(0.40, 0.60, brain.styleLateralApproach); break;
        case "Hard": lateralStrength = lerp(0.35, 0.55, brain.styleLateralApproach); break;
        case "Medium": lateralStrength = lerp(0.28, 0.48, brain.styleLateralApproach); break;
        default: lateralStrength = lerp(0.20, 0.38, brain.styleLateralApproach); break;
      }
      lateralStrength = clamp01(lateralStrength + adaptLateral * 0.15);
    } else {
      if (dist > engageDist + 15) {
        moveRadial = 1;
      } else if (dist < engageDist - 5) {
        moveRadial = rng.chance(0.25) ? -1 : 0;
      } else {
        moveRadial = rng.chance(0.20) ? 1 : 0;
      }
      switch (band) {
        case "Hardcore": lateralStrength = lerp(0.30, 0.50, brain.styleLateralApproach); break;
        case "Hard": lateralStrength = lerp(0.25, 0.45, brain.styleLateralApproach); break;
        case "Medium": lateralStrength = lerp(0.18, 0.38, brain.styleLateralApproach); break;
        default: lateralStrength = lerp(0.12, 0.30, brain.styleLateralApproach); break;
      }
      lateralStrength = clamp01(lateralStrength + adaptLateral * 0.15);
    }

    const disengageAdapt = getSlotValue(brain.adaptiveMemory, "disengageAfterCombo");
    if (disengageAdapt > 0.05 && brain.engageCyclePhase === "in" && brain.engageCycleTimer > 1.5) {
      if (rng.chance(disengageAdapt * 0.3 - adaptStamConserve * 0.1)) {
        moveRadial = -1;
      }
    }
    const staminaAdjust = adaptStamConserve > 0.05 ? adaptStamConserve * 0.2 : 0;
    brain.desiredMoveInput = clamp(dirX * moveRadial + perpX * lateralBias * (lateralStrength + staminaAdjust), -1, 1);
    brain.desiredMoveZ = clamp(dirZ * moveRadial + perpZ * lateralBias * (lateralStrength + staminaAdjust), -1, 1);
    return;
  }

  const ideal = getIdealRangeForPhase(brain);
  const width = brain.currentPhase === "Counter" ? brain.counterRangeWidth : brain.rangeWidth;
  const min = Math.max(blocksToPixels(0.2), ideal - width * 0.5);
  const max = ideal + width * 0.5;

  let moveRadial = 0;

  if (brain.currentPhase === "Counter") {
    if (dist < min - blocksToPixels(0.05)) moveRadial = -1;
    else if (dist <= max + blocksToPixels(0.05)) {
      if (rng.next01() < 0.22) moveRadial = -1;
      else moveRadial = 0;
    } else {
      const bias = getScoreAggressionBias(brain);
      if (bias > 0.10 && dist > max + blocksToPixels(0.10)) moveRadial = 1;
      else moveRadial = 0;
    }
    switch (band) {
      case "Hardcore": lateralStrength = 0.55; break;
      case "Hard": lateralStrength = 0.45; break;
      case "Medium": lateralStrength = 0.35; break;
      default: lateralStrength = 0.25; break;
    }
    brain.desiredMoveInput = clamp(dirX * moveRadial + perpX * lateralBias * lateralStrength, -1, 1);
    brain.desiredMoveZ = clamp(dirZ * moveRadial + perpZ * lateralBias * lateralStrength, -1, 1);
    return;
  }

  switch (brain.currentState) {
    case "Approach": moveRadial = 1; break;
    case "Retreat": moveRadial = -1; break;
    case "Panic":
      if (dist < ideal) moveRadial = -1;
      else moveRadial = 0;
      break;
    default: {
      if (dist > max + blocksToPixels(0.05)) moveRadial = 1;
      else if (dist < min - blocksToPixels(0.05)) moveRadial = -1;
      else {
        const bias = getScoreAggressionBias(brain);
        const ahead = clamp01(-bias);
        const behind = clamp01(bias);
        const clean = brain.personality.cleanHitsOverVolume;
        let towardP = 0.12 + behind * 0.15 - ahead * 0.06;
        let awayP = 0.12 + ahead * 0.12 - behind * 0.05;
        towardP = clamp01(Math.max(0, towardP - clean * 0.06));
        awayP = clamp01(awayP + clean * 0.06);
        const r = rng.next01();
        if (r < towardP) moveRadial = 1;
        else if (r < towardP + awayP) moveRadial = -1;
        else moveRadial = 0;
      }
      break;
    }
  }

  if (brain.currentState === "Retreat" || brain.currentState === "Panic") {
    switch (band) {
      case "Hardcore": lateralStrength = 0.55; break;
      case "Hard": lateralStrength = 0.42; break;
      case "Medium": lateralStrength = 0.30; break;
      default: lateralStrength = 0.20; break;
    }
  } else if (brain.currentState === "Approach") {
    switch (band) {
      case "Hardcore": lateralStrength = 0.30; break;
      case "Hard": lateralStrength = 0.25; break;
      case "Medium": lateralStrength = 0.18; break;
      default: lateralStrength = 0.12; break;
    }
  } else {
    switch (band) {
      case "Hardcore": lateralStrength = 0.45; break;
      case "Hard": lateralStrength = 0.38; break;
      case "Medium": lateralStrength = 0.30; break;
      default: lateralStrength = 0.22; break;
    }
  }

  brain.desiredMoveInput = clamp(dirX * moveRadial + perpX * lateralBias * lateralStrength, -1, 1);
  brain.desiredMoveZ = clamp(dirZ * moveRadial + perpZ * lateralBias * lateralStrength, -1, 1);
}

function clampToDiamondAI(fighter: { x: number; z: number }, ringLeft: number, ringRight: number, ringTop: number, ringBottom: number, margin: number = 20): void {
  const cx = (ringLeft + ringRight) / 2;
  const cy = (ringTop + ringBottom) / 2;
  const hw = (ringRight - ringLeft) / 2 - margin;
  const hh = (ringBottom - ringTop) / 2 - margin;
  const dx = (fighter.x - cx) / hw;
  const dz = (fighter.z - cy) / hh;
  const dist = Math.abs(dx) + Math.abs(dz);
  if (dist > 1) {
    fighter.x = cx + (dx / dist) * hw;
    fighter.z = cy + (dz / dist) * hh;
  }
}

function applyMovement(brain: AiBrainState, enemy: FighterState, player: FighterState, dt: number, ringLeft: number, ringRight: number, ringTop: number, ringBottom: number, state: GameState): void {
  let moveX = brain.desiredMoveInput;
  let moveZ = brain.desiredMoveZ;
  if (enemy.stamina <= 0) { moveX = 0; moveZ = 0; }

  if (brain.perfectReactActive && Math.abs(brain.stepOutDesiredMove) > 0.01) {
    const dist = getDistancePx(enemy, player);
    if (dist >= STEP_OUT_TARGET_DISTANCE_PX) {
      brain.stepOutDesiredMove = 0;
    } else {
      const dx = enemy.x - player.x;
      const dz = enemy.z - player.z;
      const len = Math.sqrt(dx * dx + dz * dz);
      if (len > 0.01) {
        moveX = clamp((dx / len) * Math.abs(brain.stepOutDesiredMove), -1, 1);
        moveZ = clamp((dz / len) * Math.abs(brain.stepOutDesiredMove), -1, 1);
      }
    }
  }

  if (Math.abs(moveX) < 0.01 && Math.abs(moveZ) < 0.01) {
    clampToDiamondAI(enemy, ringLeft, ringRight, ringTop, ringBottom);
    return;
  }

  if (player.feintTouchingOpponent) {
    const toPlayerX = player.x - enemy.x;
    const toPlayerZ = player.z - enemy.z;
    const toPlayerLen = Math.sqrt(toPlayerX * toPlayerX + toPlayerZ * toPlayerZ);
    if (toPlayerLen > 0.01) {
      const dot = (moveX * toPlayerX + moveZ * toPlayerZ) / toPlayerLen;
      if (dot > 0 && enemy.defenseState !== "duck") {
        const nX = toPlayerX / toPlayerLen;
        const nZ = toPlayerZ / toPlayerLen;
        moveX -= dot * nX;
        moveZ -= dot * nZ;
      }
    }
  }
  if (player.feintDuckTouchingOpponent) {
    const toPlayerX = player.x - enemy.x;
    const toPlayerZ = player.z - enemy.z;
    const toPlayerLen = Math.sqrt(toPlayerX * toPlayerX + toPlayerZ * toPlayerZ);
    if (toPlayerLen > 0.01) {
      const dot = (moveX * toPlayerX + moveZ * toPlayerZ) / toPlayerLen;
      if (dot > 0) {
        const nX = toPlayerX / toPlayerLen;
        const nZ = toPlayerZ / toPlayerLen;
        moveX -= dot * nX;
        moveZ -= dot * nZ;
      }
    }
  }

  let speed = enemy.moveSpeed;
  speed *= enemy.moveSlowMult;
  if (enemy.telegraphSlowTimer > 0) speed *= 0.5;
  if (state.fatigueEnabled) {
    speed *= Math.max(0.5, 1 - Math.floor(enemy.punchesThrown / 50) * 0.0025);
  }
  if (enemy.guardDownSpeedBoost > 0) speed *= (1 + enemy.guardDownSpeedBoost);

  enemy.x += moveX * speed * dt;
  enemy.z += moveZ * speed * dt;
  clampToDiamondAI(enemy, ringLeft, ringRight, ringTop, ringBottom);

  const dx = player.x - enemy.x;
  const dz = player.z - enemy.z;
  enemy.facingAngle = Math.atan2(dz, dx);
  enemy.facing = (dx >= 0 ? 1 : -1) as 1 | -1;
}

function getBasePerfectChance(band: DifficultyBand, myFrac: number): number {
  const above50 = myFrac >= 0.50;
  let baseChance: number;
  switch (band) {
    case "Easy": baseChance = above50 ? 0.35 : 0.22; break;
    case "Medium": baseChance = above50 ? 0.58 : 0.46; break;
    case "Hard": baseChance = above50 ? 0.86 : 0.78; break;
    case "Hardcore": baseChance = above50 ? 0.95 : 0.85; break;
    default: baseChance = 0;
  }
  const variance = aiRNG.range(-0.05, 0.05);
  return clamp01(baseChance + variance);
}

function computeRepeatPenalty(brain: AiBrainState): number {
  const counts = brain.playerLandedPunchCounts;
  let maxCount = 0;
  for (const key in counts) {
    if (counts[key] > maxCount) maxCount = counts[key];
  }
  if (maxCount < REPEAT_HIT_THRESHOLD) return 0;
  const over = maxCount - (REPEAT_HIT_THRESHOLD - 1);
  return clamp(over * REPEAT_PENALTY_STEP, 0, REPEAT_PENALTY_CAP);
}

// ===== PERFECT REACTION SYSTEM =====

function tryPerfectReact(brain: AiBrainState, enemy: FighterState, player: FighterState): void {
  if (brain.perfectReactActive) return;
  if (brain.gameTime < brain.nextPerfectReactTime) return;

  const myFrac = getMyStaminaFrac(enemy);
  const dist = getDistancePx(enemy, player);

  const hasPunchInfo = player.isPunching && player.currentPunch !== null;
  if (!hasPunchInfo) return;

  const maxReactDist = brain.attackRangeMax + blocksToPixels(0.25);
  if (dist > maxReactDist) return;

  let baseChance = getBasePerfectChance(brain.difficultyBand, myFrac);
  if (baseChance <= 0) return;

  let chance = baseChance * (1 - brain.perfectReactFadeFrac);

  const headCond = getHeadConditionFraction(brain);
  const bodyCond = getBodyConditionFraction(brain);
  const cond = clamp01(Math.max(headCond, bodyCond));
  chance = Math.max(0, chance - 0.12 * cond);

  const repeatPenalty = computeRepeatPenalty(brain);
  chance = Math.max(0, chance - repeatPenalty);

  chance = clamp01(chance + 0.04);
  chance = clamp01(chance + lerp(-0.02, 0.05, brain.personality.cleanHitsOverVolume));

  if (!rng.chance(chance)) return;

  brain.nextPerfectReactTime = brain.gameTime + PERFECT_REACT_COOLDOWN;
  triggerPerfectReaction(brain, enemy, player);
}

function triggerPerfectReaction(brain: AiBrainState, enemy: FighterState, player: FighterState): void {
  if (brain.comboActive) {
    brain.comboActive = false;
    brain.comboSteps = [];
    brain.comboStepIndex = 0;
  }

  brain.perfectReactActive = true;
  brain.perfectReactUntil = brain.gameTime + PERFECT_REACT_HOLD_TIME;
  brain.forcedGuard = false;
  brain.forcedHigh = false;
  brain.forcedLow = false;
  brain.forcedDuck = false;
  brain.stepOutDesiredMove = 0;

  const dirToPlayer = getDirToPlayer(enemy, player);

  const counterDuck = brain.styleCounterOffDuck;
  let wDuck = 0.25 + counterDuck * 0.45;
  let wStepOut = 0.25 * lerp(1.0, 0.35, counterDuck);
  let wBlock = 0.50 * lerp(1.0, 0.40, counterDuck);
  const sum = wDuck + wStepOut + wBlock;

  const isChamp = brain.difficultyBand === "Hardcore" || brain.difficultyBand === "Hard";
  const punchIsUppercut = player.currentPunch === "leftUppercut" || player.currentPunch === "rightUppercut";
  if (isChamp && punchIsUppercut) {
    wDuck *= 0.1;
    wBlock += 0.3;
  }
  const adjustedSum = wDuck + wStepOut + wBlock;

  let r = rng.next01() * adjustedSum;
  if (r < wDuck) {
    brain.forcedDuck = true;
  } else if (r < wDuck + wStepOut) {
    brain.stepOutDesiredMove = -dirToPlayer;
  } else {
    brain.forcedGuard = true;
    const likelyBody = player.currentPunch === "leftUppercut" || player.currentPunch === "rightUppercut";
    const dirRoll = rng.next01();
    if (dirRoll < 0.6) {
      if (likelyBody) { brain.forcedLow = true; brain.forcedHigh = false; }
      else { brain.forcedHigh = true; brain.forcedLow = false; }
    }
  }
}

function applyPerfectReactionOverrides(brain: AiBrainState, enemy: FighterState): void {
  if (!brain.perfectReactActive) return;

  if (brain.gameTime > brain.perfectReactUntil) {
    brain.perfectReactActive = false;
    brain.forcedGuard = false;
    brain.forcedHigh = false;
    brain.forcedLow = false;
    brain.forcedDuck = false;
    brain.stepOutDesiredMove = 0;
    return;
  }

  if (enemy.stunBlockDisableTimer > 0) {
    enemy.defenseState = "none";
    brain.forcedGuard = false;
    brain.forcedDuck = false;
  } else if (brain.forcedGuard) {
    enemy.defenseState = "fullGuard";
  } else if (brain.forcedDuck) {
    enemy.defenseState = "duck";
    enemy.duckTimer = 0.3;
  }
}

function updatePerfectReactionFade(brain: AiBrainState, myFrac: number, dt: number): void {
  if (myFrac < 0.999) {
    brain.perfectReactBelowFullStaminaTimer += dt;
    while (brain.perfectReactBelowFullStaminaTimer >= PERFECT_REACT_FADE_TICK_SECONDS) {
      brain.perfectReactBelowFullStaminaTimer -= PERFECT_REACT_FADE_TICK_SECONDS;
      brain.perfectReactFadeFrac += PERFECT_REACT_FADE_TICK_AMOUNT;
      brain.perfectReactFadeFrac = clamp(brain.perfectReactFadeFrac, 0, 0.15);
    }
  }
}

function updateDuckTargetBias(brain: AiBrainState, playerDucked: boolean): void {
  if (playerDucked === brain.prevPlayerDuckState) return;
  brain.prevPlayerDuckState = playerDucked;
  if (playerDucked) {
    // Player just ducked — re-roll how body-heavy we aim while they're low
    brain.duckBodyBias = rng.rollRange01(0.60, 0.90);
  } else {
    // Player stood up — re-roll how head-heavy we aim while they're standing
    brain.standHeadBias = rng.rollRange01(0.60, 0.90);
  }
}

function wantBodyWork(brain: AiBrainState, dist: number, playerDucked: boolean): boolean {
  // Duck-aware bias dominates: 80% weight on the pre-rolled duck/stand split,
  // 20% weight on tactical score so conditioning/phase still has a voice.
  const duckAwareBodyChance = playerDucked
    ? clamp01(brain.duckBodyBias + brain.whiffLearnBodyBiasNudge)
    : clamp01(1.0 - brain.standHeadBias + brain.whiffLearnBodyBiasNudge);

  const headCond = getHeadConditionFraction(brain);
  const bodyCond = getBodyConditionFraction(brain);
  let bodyScore = 0;
  if (brain.currentPhase === "BodyHunt") bodyScore += 0.55;
  bodyScore += clamp01(bodyCond - headCond) * 0.50;
  bodyScore += dist < blocksToPixels(1.05) ? 0.10 : 0;
  const clean = brain.personality.cleanHitsOverVolume;
  if (dist > blocksToPixels(1.05)) bodyScore = Math.max(0, bodyScore - clean * 0.10);

  bodyScore += brain.styleBodyFocus * 0.40;
  bodyScore += getSlotValue(brain.adaptiveMemory, "bodyTargetBias");
  bodyScore -= getSlotValue(brain.adaptiveMemory, "headTargetBias");

  const pBody_Tactical = clamp01(bodyScore);
  const headP = getAdaptiveHeadProbability(brain);
  const pBody_Directional = 1 - headP;
  const w = 0.35;
  const pBody_TacticalFinal = lerp(pBody_Tactical, pBody_Directional, w);

  const pBody_Final = lerp(pBody_TacticalFinal, duckAwareBodyChance, 0.80);
  return rng.next01() < clamp01(pBody_Final);
}

function getAdaptiveHeadProbability(brain: AiBrainState): number {
  let headP = clamp01(brain.directionalSlider01);

  if (brain.playerHighBlockHeldSeconds > 0.5)
    headP = clamp01(headP - 0.15);
  if (brain.playerLowBlockHeldSeconds > 0.5)
    headP = clamp01(headP + 0.12);

  if (brain.difficultyBand === "Medium") headP = clamp01(headP + 0.03);
  else if (brain.difficultyBand === "Hard") headP = clamp01(headP + 0.06);
  else if (brain.difficultyBand === "Hardcore") headP = clamp01(headP + 0.09);

  return headP;
}

function updateDirectionalBlockTimers(brain: AiBrainState, player: FighterState, dt: number): void {
  if (player.defenseState === "fullGuard") {
    brain.playerHighBlockHeldSeconds += dt;
  } else {
    brain.playerHighBlockHeldSeconds = 0;
  }
  brain.playerLowBlockHeldSeconds = 0;
}

function notifyAiPunchContactedGuard(brain: AiBrainState, isHigh: boolean): void {
  const step = brain.difficultyBand === "Easy" ? 0.02 :
    brain.difficultyBand === "Medium" ? 0.04 :
    brain.difficultyBand === "Hard" ? 0.06 : 0.08;
  if (isHigh) brain.directionalSlider01 = clamp01(brain.directionalSlider01 - step);
  else brain.directionalSlider01 = clamp01(brain.directionalSlider01 + step);
}

function computeJabDoctrine(brain: AiBrainState): number {
  let doctrine = brain.jabDoctrineRoll01;
  if (brain.currentPhase === "Counter" || brain.currentPhase === "WhiffPunish") doctrine += 0.10;
  if (brain.currentPhase === "Finish") doctrine -= 0.08;
  return clamp01(doctrine);
}

function isRhythmCutActive(brain: AiBrainState): boolean {
  return brain.difficultyBand !== "Easy" && brain.gameTime < brain.rhythmCutUntil;
}

function rhythmCutTick(brain: AiBrainState, enemy: FighterState, player: FighterState): void {
  if (brain.difficultyBand === "Easy") return;
  if (brain.gameTime < brain.nextRhythmCutAllowedTime) return;

  const dist = getDistancePx(enemy, player);
  if (dist < brain.attackRangeMin || dist > brain.attackRangeMax + blocksToPixels(0.20)) return;

  const oppAgg = getPlayerAggression(brain.dataBank, 1.2, brain.gameTime);
  if (oppAgg < 0.25) return;

  const oppWhiffsShort = getWhiffCount(brain.dataBank, "player", 0.9, true, brain.gameTime);
  const whiffTrigger = oppWhiffsShort >= 2;
  const closeTrigger = dist <= brain.idealRangeWhiffPunish + blocksToPixels(0.15);
  if (!whiffTrigger && !closeTrigger) return;

  let chance = brain.difficultyBand === "Medium" ? 0.25 :
    brain.difficultyBand === "Hard" ? 0.45 : 0.65;
  const mult = lerp(0.75, 1.25, clamp01(brain.rhythmCutAggression01));
  chance = clamp01(chance * mult);

  if (!rng.chance(chance)) return;

  brain.rhythmCutUntil = brain.gameTime + RHYTHM_CUT_HOLD_SECONDS;
  brain.nextRhythmCutAllowedTime = brain.gameTime + RHYTHM_CUT_COOLDOWN_SECONDS;
}

// ─── Rhythm timing read ───────────────────────────────────────────────────────
// Every time the player changes their swaySpeedLevel within range, AI has a
// difficulty-scaled chance to improve its timing accuracy.
// Journeyman: 10% chance, up to +50% accuracy gain (crude, rare)
// Champion:   80% chance, up to +10% accuracy gain (precise, frequent)
function checkPlayerRhythmRead(brain: AiBrainState, enemy: FighterState, player: FighterState): void {
  const currentSpeed = player.swaySpeedLevel;
  if (brain.lastKnownPlayerSwaySpeed === currentSpeed) return;
  const prev = brain.lastKnownPlayerSwaySpeed;
  brain.lastKnownPlayerSwaySpeed = currentSpeed;
  if (prev < 0) return;

  const dist = getDistancePx(enemy, player);
  if (dist > brain.attackRangeMax * 2.5) return;

  const chanceByBand: Record<DifficultyBand, number> = {
    Easy: 0.10, Medium: 0.30, Hard: 0.60, Hardcore: 0.80,
  };
  const maxAdjByBand: Record<DifficultyBand, number> = {
    Easy: 0.50, Medium: 0.30, Hard: 0.20, Hardcore: 0.10,
  };

  if (!rng.chance(chanceByBand[brain.difficultyBand])) return;
  const adj = rng.next01() * maxAdjByBand[brain.difficultyBand];
  brain.rhythmTimingAccuracy = clamp01(brain.rhythmTimingAccuracy + adj);
}

// ─── Attack range learning ────────────────────────────────────────────────────
// Snapshot pixel distance each time AI lands a punch; maintain rolling average
// of up to 10 samples; use as preferred engagement distance.
function snapLandedPunchRange(brain: AiBrainState, enemy: FighterState, player: FighterState): void {
  const dist = getDistancePx(enemy, player);
  brain.landedPunchDistSnapshots.push(dist);
  if (brain.landedPunchDistSnapshots.length > 10) brain.landedPunchDistSnapshots.shift();
  if (brain.landedPunchDistSnapshots.length >= 3) {
    const sum = brain.landedPunchDistSnapshots.reduce((a, b) => a + b, 0);
    brain.aiLearntRangeAvg = sum / brain.landedPunchDistSnapshots.length;
  }
}

// Called by engine when the AI is hit with a crit or stun (not blocked).
// Rolls the escalating forget chance; on success, wipes learnt attack range.
// +3% each time it triggers; resets to 35% each round.
export function notifyAiRangeDisrupt(brain: AiBrainState): void {
  if (!rng.chance(brain.rangeForgetChance)) return;
  brain.landedPunchDistSnapshots = [];
  brain.aiLearntRangeAvg = 0;
  brain.rangeForgetChance = Math.min(0.95, brain.rangeForgetChance + 0.03);
}

// ─── AI own rhythm management ─────────────────────────────────────────────────
// Picks a phase-appropriate swaySpeedLevel target; steps toward it gradually.
function setAiRhythmTarget(brain: AiBrainState): void {
  let target: number;
  switch (brain.currentPhase) {
    case "Pressure":    target = 4 + (rng.chance(0.40) ? 1 : 0); break;
    case "Finish":      target = 5; break;
    case "Counter":     target = 2 + Math.floor(rng.next01() * 2); break;
    case "Panic":
    case "Survival":    target = 1 + Math.floor(rng.next01() * 2); break;
    case "WhiffPunish": target = 3 + Math.floor(rng.next01() * 2); break;
    case "BodyHunt":    target = 2 + Math.floor(rng.next01() * 3); break;
    case "Download":    target = 1 + Math.floor(rng.next01() * 4); break;
    default:            target = 2 + Math.floor(rng.next01() * 3); break;
  }
  brain.aiRhythmTargetLevel = clamp(target, 1, 5);
}

function rollRhythmChangeInterval(band: DifficultyBand): number {
  switch (band) {
    case "Hardcore": return 1 + rng.next01() * 5;
    case "Hard":     return 5 + rng.next01() * 5;
    case "Medium":   return 8 + rng.next01() * 12;
    case "Easy":     return 15 + rng.next01() * 45;
    default:         return 8 + rng.next01() * 12;
  }
}

function rollRhythmStageShift(): number {
  return 1 + Math.floor(rng.next01() * 3);
}

export function notifyAiStunOrCrit(brain: AiBrainState, enemy: FighterState): void {
  setAiRhythmTarget(brain);
  const shift = rollRhythmStageShift();
  const dir = rng.chance(0.50) ? 1 : -1;
  brain.aiRhythmTargetLevel = clamp(brain.aiRhythmTargetLevel + dir * shift, 1, 5);
  brain.aiRhythmChangeTimer = 0;
  const current = enemy.swaySpeedLevel;
  const target = brain.aiRhythmTargetLevel;
  if (current !== target) {
    enemy.swaySpeedLevel = current < target ? current + 1 : current - 1;
  }
}

function updateAiOwnRhythm(brain: AiBrainState, enemy: FighterState, dt: number): void {
  if (enemy.rhythmLevel <= 0) {
    enemy.rhythmLevel = 2;
  }
  if (enemy.swaySpeedLevel <= 0) {
    enemy.swaySpeedLevel = 3;
  }

  brain.aiRhythmChangeTimer -= dt;
  if (brain.aiRhythmChangeTimer > 0) return;

  setAiRhythmTarget(brain);

  const current = enemy.swaySpeedLevel;
  const target = brain.aiRhythmTargetLevel;
  if (current !== target) {
    const shift = rollRhythmStageShift();
    const step = Math.min(shift, Math.abs(target - current));
    enemy.swaySpeedLevel = current < target ? current + step : current - step;
    enemy.swaySpeedLevel = clamp(enemy.swaySpeedLevel, 1, 5);
  }

  brain.aiRhythmChangeTimer = rollRhythmChangeInterval(brain.difficultyBand);
}

function computeDynamicComboChance(brain: AiBrainState, myFrac: number, dist: number, aiMomentum: number, oppAgg: number, punishWindow: boolean, level: number): number {
  const diffT = brain.difficultyBand === "Easy" ? 0 :
    brain.difficultyBand === "Medium" ? 0.45 :
    brain.difficultyBand === "Hard" ? 0.75 : 1;
  const baseTarget = lerp(0.23, 0.70, diffT);
  const lvlT = clamp01((level - 1) / 99);
  const lvlBoost = lerp(0.85, 1.15, lvlT);
  let comboChance = clamp01(baseTarget * lvlBoost + brain.classComboBias);

  if (brain.currentPhase === "Pressure") comboChance = clamp01(comboChance + 0.08);
  if (brain.currentPhase === "Finish") comboChance = clamp01(comboChance + 0.12);
  if (brain.currentPhase === "Counter") comboChance *= 0.80;
  if (brain.currentPhase === "Panic") comboChance *= 0.6;

  const clean = brain.personality.cleanHitsOverVolume;
  if (!punishWindow) comboChance = clamp01(comboChance - clean * 0.18);
  else comboChance = clamp01(comboChance + clean * 0.10);

  if (myFrac < LOW_STAMINA_FRAC) comboChance *= 0.7;
  if (brain.difficultyBand === "Hard") comboChance = clamp01(comboChance + 0.145);
  if (brain.difficultyBand === "Hardcore") comboChance = clamp01(comboChance + 0.185);

  const scoreBias = getScoreAggressionBias(brain);
  comboChance = clamp01(comboChance + scoreBias * 0.08);
  comboChance = clamp01(comboChance + (aiMomentum - 0.5) * 0.10);
  comboChance = clamp01(comboChance - clamp01(oppAgg - 0.55) * 0.08);

  return comboChance;
}

// ===== COMBO SYSTEM =====

function generateCombo(brain: AiBrainState, dist: number, wantBody: boolean): AiCombo {
  const steps: AiComboStep[] = [];
  const comboRoll = aiRNG.range(0, 1);
  const numPunches = brain.difficultyBand === "Easy" ? (comboRoll < 0.6 ? 2 : 3) :
    brain.difficultyBand === "Medium" ? (comboRoll < 0.4 ? 3 : 4) :
    brain.difficultyBand === "Hard" ? (comboRoll < 0.35 ? 3 : comboRoll < 0.7 ? 4 : 5) :
    (comboRoll < 0.2 ? 3 : comboRoll < 0.45 ? 4 : comboRoll < 0.7 ? 5 : comboRoll < 0.9 ? 6 : 7);

  const dirToPlayer = 1;
  for (let i = 0; i < numPunches; i++) {
    const body = i === 0 ? wantBody : rng.chance(wantBody ? 0.6 : 0.2);
    let punch: PunchType;
    if (body) {
      const r = rng.next01();
      if (r < 0.45) punch = rng.chance(0.5) ? "leftHook" : "rightHook";
      else punch = rng.chance(0.5) ? "leftUppercut" : "rightUppercut";
    } else {
      const r = rng.next01();
      if (i === 0 && dist > brain.idealRangeNeutral) {
        punch = r < 0.5 ? "jab" : "cross";
      } else {
        if (r < 0.30) punch = "jab";
        else if (r < 0.55) punch = "cross";
        else punch = rng.chance(0.5) ? "leftHook" : "rightHook";
      }
    }

    const delay = lerp(0.08, 0.25, rng.next01()) *
      (brain.difficultyBand === "Easy" ? 1.5 : brain.difficultyBand === "Medium" ? 1.2 : 1.0);

    steps.push({ punch, isFeint: false, delayAfter: delay, targetBody: body });
  }

  return { steps, name: `combo_${numPunches}` };
}

// ===== ATTACK DECISIONS =====

interface AttackAction {
  type: "punch" | "feint" | "combo" | "stepBack" | "none";
  punch?: PunchType;
  targetBody?: boolean;
  combo?: AiCombo;
  wantCharge?: boolean;
}

function thinkAttack(brain: AiBrainState, enemy: FighterState, player: FighterState): AttackAction {
  if (brain.currentState === "Panic" && getMyStaminaFrac(enemy) <= DEEP_SURVIVAL_FRAC) return { type: "none" };
  if (brain.comboActive) return { type: "none" };

  const inSurvival = brain.survivalModeActive || brain.currentPhase === "Panic";
  if (inSurvival) {
    const dist = getDistancePx(enemy, player);
    if (dist < brain.attackRangeMin || dist > brain.attackRangeMax) return { type: "none" };

    let counterChance: number;
    switch (brain.difficultyBand) {
      case "Hardcore": counterChance = 0.40; break;
      case "Hard": counterChance = 0.30; break;
      case "Medium": counterChance = 0.20; break;
      default: counterChance = 0.12; break;
    }

    const playerPunching = player.isPunching;
    if (playerPunching) counterChance *= 2.0;
    if (player.handsDown && dist <= brain.attackRangeMax * 0.9) counterChance *= 1.5;

    if (!rng.chance(counterChance)) return { type: "none" };

    const picks: PunchType[] = ["jab", "cross"];
    if (playerPunching) picks.push("leftHook", "rightHook");
    const punch = picks[Math.floor(rng.next01() * picks.length)];
    return { type: "punch", punch, targetBody: rng.chance(0.3) };
  }

  const dist = getDistancePx(enemy, player);

  if ((brain.playerIdleTime > 1.5 || brain.playerCornerCamping) && dist <= brain.attackRangeMax * 1.15) {
    const pick = rng.next01();
    const doBody = rng.chance(0.4);
    if (pick < 0.25) return { type: "punch", punch: "jab", targetBody: doBody };
    if (pick < 0.50) return { type: "punch", punch: "cross", targetBody: doBody };
    if (pick < 0.65) return { type: "punch", punch: "leftHook", targetBody: doBody };
    if (pick < 0.80) return { type: "punch", punch: "rightHook", targetBody: doBody };
    const combo = generateCombo(brain, dist, doBody);
    return { type: "combo", combo, targetBody: doBody };
  }

  if (dist < brain.attackRangeMin || dist > brain.attackRangeMax) return { type: "none" };

  // Rhythm timing read: if AI has learnt the player's rhythm cycle, prefer attacking
  // when the player is at their weight-transfer center (swayOffset ≈ 0). Higher accuracy
  // = stronger preference; player punching breaks the hold (counter window stays open).
  if (brain.rhythmTimingAccuracy > 0.25 && player.swaySpeedLevel > 0 && !player.isPunching) {
    const edgeness = Math.abs(player.swayOffset) / 10; // 0 = at center, 0.5 = max edge
    const holdChance = brain.rhythmTimingAccuracy * edgeness * 1.6;
    if (holdChance > 0.50 && rng.next01() < holdChance * 0.65) {
      return { type: "none" }; // wait for player to arrive at their rhythm center
    }
  }

  const sitMatch = matchSituation(
    SITUATION_DB,
    {
      playerDef: player.defenseState,
      enemyDef: enemy.defenseState,
      distFrac: brain.attackRangeMax > 0 ? dist / brain.attackRangeMax : 0,
      playerPunching: player.isPunching,
      recentPunches: (brain.recentPlayerPunches || []) as PunchType[],
      sustainedDuckSec: brain.playerSustainedDuckTimer,
      duckPunchCount: brain.playerDuckPunchCount,
      crossRatio: brain.playerTotalPunchCount > 0 ? brain.playerCrossCount / brain.playerTotalPunchCount : 0,
      bodyRatio: brain.playerBodyAttackRatio,
      guardDropSec: brain.playerGuardDropTimer,
      prevDef: brain.playerPrevDefenseState,
      defSwitchAge: brain.gameTime - brain.playerLastDefenseSwitch,
      approaching: brain.playerApproaching,
      totalPunchCount: brain.playerTotalPunchCount,
    },
    getDifficultyMultiplier(brain.difficultyBand),
    () => rng.next01()
  );

  if (sitMatch) {
    const c = sitMatch.counter;
    if (c.action === "punch" && c.punch) {
      return { type: "punch", punch: c.punch, targetBody: c.targetBody ?? false };
    }
    if (c.action === "stepBack") {
      return { type: "stepBack" };
    }
    if (c.action === "feint") {
      return { type: "feint", punch: c.punch };
    }
    if (c.action === "guardSwitch" && c.forceGuard) {
      if (c.forceGuard === "high") brain.forcedHigh = true;
      else if (c.forceGuard === "low") brain.forcedLow = true;
      else if (c.forceGuard === "duck") brain.forcedDuck = true;
    }
  }

  const myFrac = getMyStaminaFrac(enemy);

  const playerWhiffsShort = getWhiffCount(brain.dataBank, "player", 0.9, true, brain.gameTime);
  const isDucked = enemy.defenseState === "duck";
  if (isDucked && playerWhiffsShort >= 1 && rng.chance(brain.styleCounterOffDuck)) {
    const doBody = rng.chance(brain.styleBodyFocus);
    return { type: "punch", punch: "cross", targetBody: doBody };
  }

  const playerIsDucked = player.defenseState === "duck";
  updateDuckTargetBias(brain, playerIsDucked);

  const isChampionBand = brain.difficultyBand === "Hardcore" || brain.difficultyBand === "Hard";
  if (isChampionBand && playerIsDucked && brain.playerSustainedDuckTimer > 1.2 && rng.chance(brain.styleSustainedDuckCounter * brain.adaptationRate)) {
    const duckPunchHeavy = brain.playerDuckPunchCount >= 4;
    if (duckPunchHeavy && rng.chance(0.6)) {
      return { type: "punch", punch: rng.chance(0.5) ? "leftUppercut" : "rightUppercut", targetBody: true };
    }
    return { type: "stepBack" };
  }

  const duckPunchThreat = isChampionBand && brain.playerDuckPunchCount >= 3;
  const adaptUppercutDuck = getSlotValue(brain.adaptiveMemory, "uppercutOnDuck");
  if (playerIsDucked && brain.playerDuckApproachTimer > 0.3 && rng.chance((brain.styleAntiDuckUppercut + adaptUppercutDuck) * brain.adaptationRate)) {
    const uppercutBias = duckPunchThreat ? 0.75 : 0.55;
    const pick = rng.next01();
    if (pick < uppercutBias) {
      return { type: "punch", punch: rng.chance(0.5) ? "leftUppercut" : "rightUppercut", targetBody: true };
    } else {
      return { type: "punch", punch: rng.chance(0.5) ? "leftHook" : "rightHook", targetBody: true };
    }
  }

  const adaptPostDodge = getSlotValue(brain.adaptiveMemory, "postDodgeAttack");
  if ((isChampionBand || adaptPostDodge > 0.05) && brain.lastPunchDodgedTimer > 0 && rng.chance((brain.stylePostDodgeFollowup + adaptPostDodge) * brain.adaptationRate)) {
    brain.lastPunchDodgedTimer = 0;
    return { type: "punch", punch: rng.chance(0.6) ? "cross" : (rng.chance(0.5) ? "leftUppercut" : "rightUppercut"), targetBody: true };
  }

  if (isChampionBand && brain.playerTotalPunchCount >= 8) {
    const crossRatio = brain.playerCrossCount / brain.playerTotalPunchCount;
    if (crossRatio >= 0.45 && rng.chance(brain.adaptationRate * 0.7)) {
      brain.forcedLow = true;
      if (dist < brain.attackRangeMax && rng.chance(0.5)) {
        return { type: "punch", punch: rng.chance(0.6) ? "leftUppercut" : "leftHook", targetBody: true };
      }
    }
  }

  if (isChampionBand) {
    const switchAge = brain.gameTime - brain.playerLastDefenseSwitch;
    if (switchAge < 0.4 && switchAge > 0 && playerIsDucked && dist < brain.attackRangeMax) {
      if (rng.chance(brain.adaptationRate * 0.6)) {
        return { type: "punch", punch: rng.chance(0.5) ? "leftUppercut" : "rightUppercut", targetBody: false };
      }
    }
  }

  const adaptChase = getSlotValue(brain.adaptiveMemory, "chaseAfterRetreat");
  if (brain.playerRetreatTimer > 0.5 && (brain.styleRetreatTracking + adaptChase) > 0.3 && rng.chance(brain.adaptationRate)) {
    if (rng.chance((brain.styleRetreatTracking + adaptChase) * 0.4)) {
      return { type: "none" };
    }
  }

  const adaptGuardDrop = getSlotValue(brain.adaptiveMemory, "guardDropExploit");
  if (brain.playerGuardDropTimer > 0.4 && rng.chance(brain.styleCounterOffGuardDrop + adaptGuardDrop)) {
    const punchPick = rng.next01();
    const doBody = rng.chance(brain.styleBodyFocus);
    if (punchPick < 0.35) {
      return { type: "punch", punch: "cross", targetBody: doBody };
    } else if (punchPick < 0.55) {
      return { type: "punch", punch: "rightHook", targetBody: doBody };
    } else if (punchPick < 0.70) {
      return { type: "punch", punch: "leftHook", targetBody: doBody };
    }
  }

  if (isChampionBand && brain.playerGuardDropTimer > 0.8 && dist < brain.attackRangeMax) {
    const openGuardBoost = clamp01(brain.adaptationRate * 0.9);
    if (rng.chance(openGuardBoost)) {
      const doBody = rng.chance(brain.styleBodyFocus);
      const pick = rng.next01();
      if (pick < 0.4) return { type: "punch", punch: "cross", targetBody: doBody };
      else if (pick < 0.6) return { type: "punch", punch: rng.chance(0.5) ? "leftHook" : "rightHook", targetBody: doBody };
      else {
        const combo = generateCombo(brain, dist, doBody);
        return { type: "combo", combo, targetBody: doBody };
      }
    }
  }

  const adaptCommit = getSlotValue(brain.adaptiveMemory, "commitChanceBias");
  const adaptAgg = getSlotValue(brain.adaptiveMemory, "aggression");
  const adaptFeint = getSlotValue(brain.adaptiveMemory, "feintBeforeAttack");
  const adaptPatience = getSlotValue(brain.adaptiveMemory, "patienceBias");

  if (brain.playerIdleTime < 1.0 && !brain.playerCornerCamping) {
    const aiWhiffsRecent = getWhiffCount(brain.dataBank, "ai", 2.0, true, brain.gameTime);
    if (aiWhiffsRecent >= 3) {
      const suppressChance = brain.difficultyBand === "Easy" ? 0.85 :
        brain.difficultyBand === "Medium" ? 0.80 :
        brain.difficultyBand === "Hard" ? 0.75 : 0.70;
      if (rng.chance(suppressChance)) return { type: "stepBack" };
    } else if (aiWhiffsRecent >= 2) {
      const suppressChance = brain.difficultyBand === "Easy" ? 0.60 :
        brain.difficultyBand === "Medium" ? 0.55 :
        brain.difficultyBand === "Hard" ? 0.45 : 0.40;
      if (rng.chance(suppressChance)) return { type: "none" };
    }
  }

  if (brain.engageCyclePhase === "out" && (brain.stylePatience + adaptPatience) > 0.4 && brain.playerIdleTime < 1.0 && !brain.playerCornerCamping) {
    let suppressChance = (brain.stylePatience + adaptPatience) * 0.65;
    if (isChampionBand && brain.playerGuardDropTimer > 0.3) suppressChance *= 0.3;
    if (rng.chance(suppressChance)) return { type: "none" };
  }

  let patternCounterOpportunity = false;
  let matchedPatternIndex = -1;
  if (dist <= PATTERN_RANGE_MAX_PX) {
    const result = tryGetCurrentPatternMatch(brain.dataBank, PATTERN_WINDOW_SECONDS, brain.gameTime);
    if (result.matched) {
      patternCounterOpportunity = true;
      matchedPatternIndex = result.patternIndex;
    }
  }

  const momentum = getAiMomentum(brain.dataBank, 5, brain.gameTime);
  const playerAgg = getPlayerAggression(brain.dataBank, 5, brain.gameTime);

  const punishWindow = brain.currentPhase === "WhiffPunish" || brain.currentPhase === "Counter" ||
    patternCounterOpportunity || playerWhiffsShort >= 2;

  const rhythmCutNow = isRhythmCutActive(brain);
  const clean = brain.personality.cleanHitsOverVolume;

  let commitChance = lerp(0.455, 0.95, clamp01(brain.personality.aggression + brain.classAggressionBias + adaptAgg));
  commitChance = lerp(commitChance, commitChance - 0.12, clean);
  commitChance = lerp(commitChance - 0.25, commitChance + 0.25, momentum);
  commitChance += playerWhiffsShort * 0.12 * brain.winnerMindIntensity;
  commitChance -= clamp01((playerAgg - 0.5) * 2) * 0.20;
  commitChance += adaptCommit;

  if (brain.currentPhase === "Pressure") commitChance += 0.10;
  if (brain.currentPhase === "Finish") commitChance += 0.20;
  if (brain.currentPhase === "Counter") commitChance -= 0.10;
  if ((brain.currentPhase as TacticalPhase) === "Panic") commitChance -= 0.25;
  if (brain.currentPhase === "WhiffPunish") commitChance += clean * 0.10;

  if (rhythmCutNow && rng.chance(clamp01(brain.rhythmCutCommitChanceRoll01))) {
    commitChance = clamp01(commitChance + 0.15);
  }

  if (myFrac < LOW_STAMINA_FRAC) commitChance *= 0.65;

  const scoreBias = getScoreAggressionBias(brain);
  commitChance += scoreBias * clamp(0.15, 0, 0.40);

  if (patternCounterOpportunity) {
    commitChance = Math.max(commitChance,
      brain.difficultyBand === "Hardcore" ? 0.95 :
      brain.difficultyBand === "Hard" ? 0.80 :
      brain.difficultyBand === "Medium" ? 0.45 : 0.25);
  }

  if (isChampionBand) {
    const minCommit = brain.difficultyBand === "Hardcore" ? 0.50 : 0.35;
    commitChance = Math.max(commitChance, minCommit);
  }
  commitChance = clamp01(commitChance);
  if (!rng.chance(commitChance)) return { type: "none" };

  const doBody = wantBodyWork(brain, dist, playerIsDucked);

  let comboChance = computeDynamicComboChance(brain, myFrac, dist, momentum, playerAgg, punishWindow, enemy.level);
  if (rhythmCutNow) comboChance = clamp01(comboChance + 0.08);

  if (rng.chance(comboChance)) {
    const combo = generateCombo(brain, dist, doBody);
    return { type: "combo", combo, targetBody: doBody };
  }

  return executeFallbackSingle(brain, dist, doBody, player, myFrac, playerWhiffsShort);
}

function executeFallbackSingle(brain: AiBrainState, dist: number, wantBody: boolean, player: FighterState, myFrac: number, playerWhiffsShort: number): AttackAction {
  const dx = player.x > 0 ? 1 : -1;
  const jabDoctrine = computeJabDoctrine(brain);
  const clean = brain.personality.cleanHitsOverVolume;
  const crossBias = brain.styleCrossHeavy;
  let punch: PunchType;

  const playerDucked = player.defenseState === "duck";
  if (playerDucked && brain.styleAntiDuckUppercut > 0.2 && rng.chance(brain.styleAntiDuckUppercut * 0.7 * brain.adaptationRate)) {
    const r = rng.next01();
    if (r < 0.45) punch = rng.chance(0.5) ? "leftUppercut" : "rightUppercut";
    else punch = rng.chance(0.5) ? "leftHook" : "rightHook";
    return { type: "punch", punch, targetBody: true };
  }

  const adaptJabFreq = getSlotValue(brain.adaptiveMemory, "jabFrequency");
  const adaptHookFreq = getSlotValue(brain.adaptiveMemory, "hookFrequency");
  const adaptCross = getSlotValue(brain.adaptiveMemory, "crossCounterBias");

  if (!wantBody) {
    const r = rng.next01();
    const jabP = lerp(0.35, 0.70, jabDoctrine) * lerp(1.0, 0.55, crossBias) + adaptJabFreq;
    const crossP = lerp(0.40, 0.55, 1 - jabDoctrine) + crossBias * 0.20 + adaptCross;

    if (dist > brain.idealRangeNeutral + blocksToPixels(0.1)) {
      if (rng.chance(brain.styleJabSetup) && crossBias > 0.4) {
        punch = "jab";
      } else {
        punch = r < jabP ? "jab" : "cross";
      }
    } else {
      if (r < jabP) punch = "jab";
      else if (r < jabP + crossP) punch = "cross";
      else {
        if (clean > 0.60 && dist > blocksToPixels(0.80)) punch = "cross";
        else if (rng.chance(0.5 + adaptHookFreq)) punch = rng.chance(0.5) ? "leftHook" : "rightHook";
        else punch = "cross";
      }
    }
  } else {
    const r = rng.next01();
    if (crossBias > 0.4) {
      if (r < crossBias) punch = "cross";
      else if (r < crossBias + 0.20) punch = rng.chance(0.5) ? "leftUppercut" : "rightUppercut";
      else punch = rng.chance(0.5) ? "leftHook" : "rightHook";
    } else if (clean > 0.60 && dist > blocksToPixels(0.85)) {
      punch = rng.chance(0.5) ? "leftHook" : "rightHook";
    } else {
      if (r < 0.45) punch = rng.chance(0.5) ? "leftHook" : "rightHook";
      else if (r < 0.85) punch = rng.chance(0.5) ? "leftUppercut" : "rightUppercut";
      else punch = rng.chance(0.5) ? "jab" : "cross";
    }
  }

  const adaptCharged = getSlotValue(brain.adaptiveMemory, "chargedPunchResponse");
  const adaptPowerCommit = getSlotValue(brain.adaptiveMemory, "powerPunchCommit");
  let wantCharge = false;
  if ((brain.styleChargedPunchUsage + adaptCharged) > 0.15 && myFrac > 0.35) {
    const chargeCandidate = (punch === "cross" || punch === "leftHook" || punch === "rightHook");
    const goodOpportunity = brain.playerGuardDropTimer > 0.5 || playerWhiffsShort >= 2 || brain.currentPhase === "WhiffPunish";
    if (chargeCandidate && goodOpportunity && rng.chance(brain.styleChargedPunchUsage + adaptCharged + adaptPowerCommit * 0.5)) {
      wantCharge = true;
    }
  }

  const adaptFeint = getSlotValue(brain.adaptiveMemory, "feintBeforeAttack");
  let feintChance = clamp01(brain.personality.feintiness);
  if (brain.currentPhase === "Download") feintChance *= 1.35;
  if (brain.currentPhase === "Probe") feintChance *= 1.15;
  if (brain.currentPhase === "Finish") feintChance *= 0.55;
  if (brain.currentPhase === "Counter") feintChance *= 1.10;
  if (brain.difficultyBand === "Easy") feintChance *= 0.80;
  if (brain.difficultyBand === "Hard") feintChance *= 1.10;
  if (brain.difficultyBand === "Hardcore") feintChance *= 1.18;
  feintChance = clamp01(feintChance + clean * 0.12 + adaptFeint);

  const doFeint = !wantCharge && rng.chance(feintChance);

  return { type: doFeint ? "feint" : "punch", punch, targetBody: wantBody, wantCharge };
}

interface DefenseDecision {
  wantGuard: boolean;
  wantHigh: boolean;
  wantLow: boolean;
  wantDuck: boolean;
}

// ===== DEFENSE DECISIONS =====

function thinkDefense(brain: AiBrainState, enemy: FighterState, player: FighterState): DefenseDecision {
  const result: DefenseDecision = { wantGuard: false, wantHigh: false, wantLow: false, wantDuck: false };

  if (brain.survivalModeActive) {
    const dist = getDistancePx(enemy, player);
    const inRange = dist <= brain.attackRangeMax * 1.2;

    let duckChance: number;
    switch (brain.difficultyBand) {
      case "Hardcore": duckChance = 0.35; break;
      case "Hard": duckChance = 0.28; break;
      case "Medium": duckChance = 0.18; break;
      default: duckChance = 0.10; break;
    }
    if (player.isPunching) duckChance *= 1.5;

    if (inRange && rng.chance(duckChance)) {
      result.wantDuck = true;
      return result;
    }

    result.wantGuard = true;
    result.wantHigh = true;
    return result;
  }
  if (brain.perfectReactActive && (brain.forcedGuard || brain.forcedDuck)) return result;

  if (brain.playerIdleTime > 1.5 || brain.playerCornerCamping) {
    return result;
  }

  const myFrac = getMyStaminaFrac(enemy);
  const theirFrac = getPlayerStaminaFrac(player);
  const dist = getDistancePx(enemy, player);
  const playerAgg = getPlayerAggression(brain.dataBank, 5, brain.gameTime);

  const adaptDuck = getSlotValue(brain.adaptiveMemory, "duckApproachBias");
  const adaptGuardVsDodge = getSlotValue(brain.adaptiveMemory, "guardVsDodgePref");
  const duckApproach = brain.styleDuckApproach + adaptDuck;
  const isApproaching = brain.engageCyclePhase === "in" || brain.currentState === "Approach";
  if (isApproaching && brain.playerIdleTime < 0.5 && rng.chance(duckApproach)) {
    result.wantDuck = true;
    return result;
  }

  if (duckApproach > 0.3 && dist < brain.styleIdealResetDist && dist > brain.styleIdealEngageDist && brain.playerIdleTime < 0.5) {
    if (rng.chance(duckApproach * 0.6)) {
      result.wantDuck = true;
      return result;
    }
  }

  const last3 = getLastHits(brain.dataBank, "player", 3);
  const playerHeadHeavy = last3.headHits >= 2;
  const playerBodyHeavy = last3.bodyHits >= 2;
  const tired = myFrac < LOW_STAMINA_FRAC && theirFrac > PLAYER_FINISH_FRAC;

  const adaptGuard = getSlotValue(brain.adaptiveMemory, "guardParanoiaBias");
  const adaptDefDisc = getSlotValue(brain.adaptiveMemory, "defenseDisciplineBias");

  let guardNeed = (tired ? 0.55 : 0.20) +
    clamp01(playerAgg) * 0.45 +
    clamp01(brain.personality.guardParanoia + adaptGuard) * 0.35 +
    (brain.styleDefenseDiscipline + adaptDefDisc) * 0.25;

  if (brain.playerIdleTime > 0.5) {
    const idleSuppression = Math.min(brain.playerIdleTime - 0.5, 2.0) / 2.0;
    guardNeed *= lerp(1.0, 0.05, idleSuppression);
  }

  guardNeed *= lerp(1.0, 0.55, duckApproach);

  if (brain.styleDefenseDiscipline > 0.4 && dist < brain.attackRangeMax * 1.3 && brain.playerIdleTime < 0.5) {
    guardNeed = Math.max(guardNeed, brain.styleDefenseDiscipline * 0.5);
  }

  if (brain.currentPhase === "Counter") guardNeed += 0.08;
  if (brain.currentPhase === "Panic") guardNeed += 0.25;
  if (brain.currentPhase === "Finish") guardNeed -= 0.10;
  if (dist < TOO_CLOSE_RANGE_PX) guardNeed += 0.10;
  guardNeed = clamp01(guardNeed + brain.personality.cleanHitsOverVolume * 0.10 + adaptGuardVsDodge);

  result.wantGuard = rng.chance(guardNeed);

  if (result.wantGuard) {
    const bodyAdapt = brain.styleBodyDefenseAdapt;
    const playerBodyHeavyAdapt = brain.playerBodyAttackRatio > 0.6 && bodyAdapt > 0.2 && rng.chance(brain.adaptationRate);

    if (playerBodyHeavy || playerBodyHeavyAdapt) {
      result.wantLow = true;
      if (playerBodyHeavyAdapt && rng.chance(bodyAdapt * 0.6)) {
        result.wantLow = true;
        result.wantHigh = false;
      }
    }
    else if (playerHeadHeavy) result.wantHigh = true;
    else {
      if (dist < TOO_CLOSE_RANGE_PX) result.wantLow = true;
      else result.wantHigh = true;
    }

    const jiggle = rng.next01();
    if (jiggle < 0.10) { result.wantHigh = true; result.wantLow = false; }
    else if (jiggle < 0.20) { result.wantLow = true; result.wantHigh = false; }
  }

  if (brain.currentPhase === "BodyHunt") result.wantDuck = true;
  else if (result.wantGuard && result.wantLow && playerAgg > 0.35) {
    result.wantDuck = rng.chance(0.35);
  }
  if (brain.currentPhase === "Counter") result.wantDuck = false;

  if (brain.playerBodyAttackRatio > 0.65 && brain.styleBodyDefenseAdapt > 0.3 && rng.chance(brain.adaptationRate)) {
    if (result.wantDuck && rng.chance(brain.styleBodyDefenseAdapt * 0.5)) {
      result.wantDuck = false;
      result.wantGuard = true;
      result.wantLow = true;
    }
  }

  const isChamp = brain.difficultyBand === "Hardcore" || brain.difficultyBand === "Hard";
  if (isChamp) {
    const uppercutCount = (brain.playerLandedPunchCounts["leftUppercut"] || 0) + (brain.playerLandedPunchCounts["rightUppercut"] || 0);
    if (uppercutCount >= 2 && result.wantDuck && rng.chance(brain.adaptationRate * 0.7)) {
      result.wantDuck = false;
      result.wantGuard = true;
      result.wantLow = true;
    }

    if (player.defenseState === "duck" && result.wantGuard) {
      result.wantLow = true;
      result.wantHigh = false;
    }

    if (player.isPunching && player.currentPunch) {
      const isBodyPunch = player.currentPunch === "leftUppercut" || player.currentPunch === "rightUppercut";
      if (isBodyPunch && result.wantGuard && rng.chance(brain.adaptationRate)) {
        result.wantLow = true;
        result.wantHigh = false;
        result.wantDuck = false;
      }
    }
  }

  return result;
}

function applyDefenseDecision(decision: DefenseDecision, enemy: FighterState): void {
  if (enemy.stunBlockDisableTimer > 0) {
    enemy.defenseState = "none";
    return;
  }
  if (decision.wantDuck) {
    enemy.defenseState = "duck";
    enemy.duckTimer = 0.3;
  } else if (decision.wantGuard) {
    enemy.defenseState = "fullGuard";
  } else {
    enemy.defenseState = "none";
  }
}

function updateComboRunner(brain: AiBrainState, enemy: FighterState, dt: number): PunchType | null {
  if (!brain.comboActive) return null;
  if (brain.comboStepIndex >= brain.comboSteps.length) {
    brain.comboActive = false;
    brain.comboCooldown = lerp(0.3, 0.6, rng.next01());
    return null;
  }

  brain.comboStepTimer -= dt;
  if (brain.comboStepTimer > 0) return null;

  const step = brain.comboSteps[brain.comboStepIndex];

  if (enemy.stamina <= 0 || enemy.isKnockedDown) {
    brain.comboActive = false;
    return null;
  }

  brain.comboStepIndex++;
  if (brain.comboStepIndex < brain.comboSteps.length) {
    brain.comboStepTimer = brain.comboSteps[brain.comboStepIndex - 1].delayAfter;
  }

  return step.punch;
}

function updateScorecard(brain: AiBrainState, state: GameState, isPlayerAI: boolean = false): void {
  if (state.roundScores.length === 0) {
    brain.scorecardBias = 0;
    return;
  }

  let playerTotal = 0, enemyTotal = 0;
  for (const round of state.roundScores) {
    playerTotal += round.player;
    enemyTotal += round.enemy;
  }

  if (playerTotal + enemyTotal === 0) {
    brain.scorecardBias = 0;
    return;
  }

  const diff = isPlayerAI ? (playerTotal - enemyTotal) : (enemyTotal - playerTotal);
  brain.scorecardBias = clamp(diff / Math.max(1, playerTotal + enemyTotal), -1, 1);
}

// ===== MAIN AI UPDATE LOOP =====

export function updateAI(state: GameState, dt: number, attemptPunchFn: (fighter: FighterState, punchType: PunchType, isFeint?: boolean, isCharged?: boolean) => boolean, isPlayerAI: boolean = false): void {
  const brain = isPlayerAI ? state.playerAiBrain : state.aiBrain;
  if (!brain) return;

  const enemy = isPlayerAI ? state.player : state.enemy;
  const player = isPlayerAI ? state.enemy : state.player;

  if (enemy.isKnockedDown || state.knockdownActive || state.phase !== "fighting") return;

  if (state.practiceMode && !isPlayerAI) {
    if (!state.cpuAttacksEnabled) {
      attemptPunchFn = () => false;
    }
    if (!state.cpuDefenseEnabled) {
      enemy.defenseState = "none";
      enemy.handsDown = true;
    }
  }

  brain.gameTime += dt;
  const myFrac = getMyStaminaFrac(enemy);

  if (brain.reactionDelayTimer > 0) brain.reactionDelayTimer -= dt;
  brain.reactionDelayConsecutiveDecay += dt;
  if (brain.reactionDelayConsecutiveDecay > 1.5) {
    brain.reactionDelayConsecutiveHits = Math.max(0, brain.reactionDelayConsecutiveHits - 1);
    brain.reactionDelayConsecutiveDecay = 0;
  }

  trackStaminaHitsAndPatterns(brain, enemy, player);
  updateConditioning(brain, dt);
  updateSurvivalMode(brain, myFrac);
  updatePerfectReactionFade(brain, myFrac, dt);
  updateDirectionalBlockTimers(brain, player, dt);
  updateScorecard(brain, state, isPlayerAI);
  updateEngageCycle(brain, dt);
  updateLateralDir(brain, dt);
  if (brain.hitReactRetreatTimer > 0) brain.hitReactRetreatTimer -= dt;
  reactToPlayerTelegraph(brain, enemy, player);
  updateDefenseCycling(brain, enemy, player, dt);
  updateAiDirectionalGuard(brain, enemy, player, dt);
  trackPlayerGuardDrop(brain, player, dt);
  trackPlayerDuckApproach(brain, enemy, player, dt);
  trackPlayerRetreat(brain, enemy, player, dt);
  trackPlayerSustainedDuck(brain, enemy, player, dt);
  trackPlayerDefenseSwitch(brain, player);
  trackPlayerApproach(brain, enemy, player);
  updatePlayerBodyRatio(brain);
  rhythmCutTick(brain, enemy, player);
  checkPlayerRhythmRead(brain, enemy, player);
  updateAiOwnRhythm(brain, enemy, dt);
  runWhiffLearning(brain, dt);

  if (brain.comboCooldown > 0) brain.comboCooldown -= dt;

  const facingToPlayer = player.x > enemy.x ? 1 : -1;
  enemy.facing = facingToPlayer as 1 | -1;

  if (brain.comboActive) {
    const comboPunch = updateComboRunner(brain, enemy, dt);
    if (comboPunch !== null) {
      const step = brain.comboSteps[brain.comboStepIndex - 1];
      if (step && step.targetBody) {
        enemy.defenseState = "duck";
        enemy.duckTimer = 0.15;
        enemy.punchAimsHead = false;
      } else {
        enemy.punchAimsHead = true;
      }
      attemptPunchFn(enemy, comboPunch, step?.isFeint || false, false);
    }
    applyMovement(brain, enemy, player, dt, state.ringLeft, state.ringRight, state.ringTop, state.ringBottom, state);
    return;
  }

  tryPerfectReact(brain, enemy, player);
  applyPerfectReactionOverrides(brain, enemy);

  {
    const result = thinkAwake(brain.stateThinkTimer, brain.stateThinkInterval, brain, myFrac, dt);
    brain.stateThinkTimer = result.timer;
    if (result.awake) evaluateState(brain, enemy, player);
  }
  {
    const result = thinkAwake(brain.phaseThinkTimer, brain.phaseThinkInterval, brain, myFrac, dt);
    brain.phaseThinkTimer = result.timer;
    if (result.awake) evaluatePhase(brain, enemy, player);
  }
  {
    const result = thinkAwake(brain.moveThinkTimer, brain.moveThinkInterval, brain, myFrac, dt);
    brain.moveThinkTimer = result.timer;
    if (result.awake) thinkMovement(brain, enemy, player, state);
  }

  applyMovement(brain, enemy, player, dt, state.ringLeft, state.ringRight, state.ringTop, state.ringBottom, state);

  if (player.chargeArmed && player.chargeArmTimer > 0 && !enemy.isPunching && brain.reactionDelayTimer <= 0) {
    let chargeEvadeChance: number;
    switch (brain.difficultyBand) {
      case "Hardcore": chargeEvadeChance = 0.97; break;
      case "Hard": chargeEvadeChance = 0.75; break;
      case "Medium": chargeEvadeChance = 0.40; break;
      default: chargeEvadeChance = 0.25; break;
    }
    if (rng.chance(chargeEvadeChance)) {
      const gdx = player.x - enemy.x;
      const gdz = player.z - enemy.z;
      const dist = Math.sqrt(gdx * gdx + gdz * gdz);
      if (dist < brain.attackRangeMax * 1.4) {
        const dirX = dist > 0.01 ? gdx / dist : 1;
        const dirZ = dist > 0.01 ? gdz / dist : 0;
        const perpX = -dirZ;
        const perpZ = dirX;
        const lateralDodge = rng.chance(0.4) ? brain.lateralDir * 0.5 : 0;
        brain.desiredMoveInput = clamp(-dirX * 0.85 + perpX * lateralDodge, -1, 1);
        brain.desiredMoveZ = clamp(-dirZ * 0.85 + perpZ * lateralDodge, -1, 1);
        applyMovement(brain, enemy, player, dt, state.ringLeft, state.ringRight, state.ringTop, state.ringBottom, state);
      }
    }
  }

  const aiChargeBase: Record<string, number> = {
    "Easy": 0.14, "Medium": 0.21, "Hard": 0.35, "Hardcore": 0.56
  };
  const aiChargeMax: Record<string, number> = {
    "Easy": 0.28, "Medium": 0.35, "Hard": 0.49, "Hardcore": 0.91
  };
  const base = aiChargeBase[brain.difficultyBand] || 0.10;
  const max = aiChargeMax[brain.difficultyBand] || 0.20;
  const losingOnPoints = enemy.damageDealt < player.damageDealt;
  const aiChargeChance = losingOnPoints ? max : base;

  if (!enemy.isPunching && !enemy.chargeArmed && enemy.aiGuardDropTimer <= 0) {
    const playerFrac = player.stamina / player.maxStamina;
    const staminaAdvantage = myFrac - playerFrac;
    const champBand = brain.difficultyBand === "Hardcore" || brain.difficultyBand === "Hard";
    const guardDropDist = getDistancePx(enemy, player);
    const playerCloseAndDangerous = champBand && guardDropDist < brain.attackRangeMax * 1.2 && (player.isPunching || player.handsDown || player.defenseState === "duck");
    if (staminaAdvantage >= 0.2 && myFrac > 0.4 && enemy.aiGuardDropCooldown <= 0 && !playerCloseAndDangerous) {
      if (rng.next01() < 0.15 * dt) {
        enemy.aiGuardDropTimer = 1 + rng.next01() * 2;
        enemy.aiGuardDropCooldown = 5 + rng.next01() * 5;
        enemy.defenseState = "none";
      }
    }
  }

  if (enemy.aiGuardDropTimer > 0) {
    enemy.defenseState = "none";
  }

  if (brain.postFeintWindow > 0) {
    brain.postFeintWindow -= dt;
    if (player.defenseState !== brain.postFeintPlayerDefense && !brain.postFeintFollowupReady) {
      brain.postFeintFollowupReady = true;
    }
    if (brain.postFeintWindow <= 0) {
      brain.postFeintFollowupReady = false;
    }
  }

  if (brain.postFeintFollowupReady && !enemy.isPunching && enemy.punchCooldown <= 0 && brain.comboCooldown <= 0) {
    brain.postFeintFollowupReady = false;
    brain.postFeintWindow = 0;
    const followupChance = brain.difficultyBand === "Easy" ? 0.30 :
      brain.difficultyBand === "Medium" ? 0.50 :
      brain.difficultyBand === "Hard" ? 0.75 : 0.90;
    if (rng.chance(followupChance)) {
      const dist = getDistancePx(enemy, player);
      if (dist <= brain.attackRangeMax + blocksToPixels(0.25)) {
        const playerDucked = player.defenseState === "duck";
        const doBody = playerDucked || rng.chance(brain.styleBodyFocus);
        let followPunch: PunchType;
        if (playerDucked) {
          followPunch = rng.chance(0.65) ? (rng.chance(0.5) ? "leftUppercut" : "rightUppercut") : "cross";
        } else {
          const r = rng.next01();
          if (r < 0.40) followPunch = "cross";
          else if (r < 0.65) followPunch = rng.chance(0.5) ? "leftHook" : "rightHook";
          else followPunch = rng.chance(0.5) ? "leftUppercut" : "rightUppercut";
        }
        if (doBody) {
          enemy.defenseState = "duck";
          enemy.duckTimer = 0.15;
          enemy.punchAimsHead = false;
        } else {
          enemy.punchAimsHead = true;
        }
        const useCharge = enemy.chargeArmed;
        attemptPunchFn(enemy, followPunch, false, useCharge);
      }
    }
  }

  if (!enemy.isPunching && enemy.punchCooldown <= 0 && brain.comboCooldown <= 0) {
    const idleBypass = brain.playerIdleTime > 1.5 || brain.playerCornerCamping;
    const result = thinkAwake(brain.attackThinkTimer, brain.attackThinkInterval, brain, myFrac, dt);
    brain.attackThinkTimer = result.timer;
    if (result.awake || idleBypass) {
      const action = thinkAttack(brain, enemy, player);

      let shouldCharge = rng.next01() < aiChargeChance && !enemy.chargeArmed && enemy.chargeMeterBars >= 1;
      if (action.wantCharge && !enemy.chargeArmed && enemy.chargeMeterBars >= 1) {
        shouldCharge = true;
      }
      if (shouldCharge) {
        enemy.chargeArmed = true;
        enemy.chargeUsesLeft = 2;
        enemy.chargeFlashTimer = 0.15;
        const levelT = Math.min(1, Math.max(0, (enemy.level - 1) / 99));
        enemy.chargeArmTimer = 2 + levelT * 2;
      }

      const useCharge = enemy.chargeArmed;
      if (action.type === "stepBack") {
        const dirToPlayer = getDirToPlayer(enemy, player);
        brain.stepOutDesiredMove = -dirToPlayer;
        brain.perfectReactActive = true;
        brain.perfectReactUntil = brain.gameTime + 0.35;
        brain.forcedGuard = true;
        brain.forcedHigh = true;
        enemy.defenseState = "fullGuard";
      } else switch (action.type) {
        case "punch":
          if (action.punch) {
            if (action.targetBody) {
              enemy.defenseState = "duck";
              enemy.duckTimer = 0.15;
              enemy.punchAimsHead = false;
            } else {
              enemy.punchAimsHead = true;
            }
            attemptPunchFn(enemy, action.punch, false, useCharge);
          }
          break;
        case "feint":
          if (action.punch) {
            attemptPunchFn(enemy, action.punch, true, false);
            brain.postFeintWindow = 0.45;
            brain.postFeintPlayerDefense = player.defenseState;
            brain.postFeintFollowupReady = false;
          }
          break;
        case "combo":
          if (action.combo && action.combo.steps.length > 0) {
            brain.comboActive = true;
            brain.comboSteps = action.combo.steps;
            brain.comboStepIndex = 0;
            brain.comboStepTimer = 0;
            const firstStep = action.combo.steps[0];
            if (firstStep.targetBody) {
              enemy.defenseState = "duck";
              enemy.duckTimer = 0.15;
              enemy.punchAimsHead = false;
            } else {
              enemy.punchAimsHead = true;
            }
            attemptPunchFn(enemy, firstStep.punch, firstStep.isFeint, useCharge);
            brain.comboStepIndex = 1;
            if (brain.comboSteps.length > 1) {
              brain.comboStepTimer = firstStep.delayAfter;
            } else {
              brain.comboActive = false;
            }
          }
          break;
      }
    }
  }

  if (brain.defenseHoldTimer > 0) brain.defenseHoldTimer -= dt;

  const playerIsIdle = !player.isPunching;
  if (playerIsIdle) {
    brain.playerIdleTime += dt;
  } else {
    brain.playerIdleTime = 0;
  }

  const RING_CX_AI = 400;
  const RING_CY_AI = 260;
  const RING_HALF_H_AI = 180;
  const cornerTopZ = RING_CY_AI - RING_HALF_H_AI + 40;
  const cornerBotZ = RING_CY_AI + RING_HALF_H_AI - 40;
  const nearCorner = player.z <= cornerTopZ || player.z >= cornerBotZ;

  if (nearCorner) {
    const movedX = Math.abs(player.x - brain.playerLastX);
    const movedZ = Math.abs(player.z - brain.playerLastZ);
    const totalMoved = movedX + movedZ;
    if (totalMoved < 10) {
      brain.playerCornerStallTimer += dt;
    } else {
      brain.playerCornerStallTimer = 0;
      brain.playerLastX = player.x;
      brain.playerLastZ = player.z;
    }
    if (brain.playerCornerStallTimer > 0.5) {
      brain.playerLastX = player.x;
      brain.playerLastZ = player.z;
    }
  } else {
    brain.playerCornerStallTimer = 0;
    brain.playerLastX = player.x;
    brain.playerLastZ = player.z;
  }

  const wasCornerCamping = brain.playerCornerCamping;
  brain.playerCornerCamping = nearCorner && brain.playerCornerStallTimer >= 3.0;

  if (brain.playerCornerCamping && (player.isPunching || (!nearCorner))) {
    brain.playerCornerCamping = false;
    brain.playerCornerStallTimer = 0;
  }

  if ((brain.playerIdleTime > 1.5 || brain.playerCornerCamping) && !enemy.isPunching) {
    enemy.defenseState = "none";
    brain.defenseHoldTimer = 0;
  } else if (!enemy.isPunching && enemy.aiGuardDropTimer <= 0) {
    const result = thinkAwake(brain.defenseThinkTimer, brain.defenseThinkInterval, brain, myFrac, dt);
    brain.defenseThinkTimer = result.timer;
    if (result.awake && !brain.perfectReactActive && brain.defenseHoldTimer <= 0 && brain.reactionDelayTimer <= 0) {
      const decision = thinkDefense(brain, enemy, player);
      applyDefenseDecision(decision, enemy);
      if (decision.wantGuard || decision.wantDuck) {
        brain.defenseHoldTimer = lerp(0.18, 0.10, brain.difficultyScore);
      }
    }
  }

  if (state.practiceMode && !isPlayerAI) {
    if (!state.cpuDefenseEnabled) {
      enemy.defenseState = "none";
      enemy.handsDown = true;
      brain.desiredMoveInput = 0;
      brain.desiredMoveZ = 0;
    }
  }
}

// ===== AI NOTIFICATION HANDLERS =====

export function notifyAiHitLanded(brain: AiBrainState, isPlayerPunch: boolean, hitHead: boolean): void {
  if (!brain) return;
  if (isPlayerPunch) {
    const region: "head" | "body" = hitHead ? "head" : "body";
    logHit(brain.dataBank, "player", region, 5, true, brain.gameTime);
  }
}

export function notifyAiPunchWhiffed(brain: AiBrainState, isPlayerPunch: boolean, inRange: boolean): void {
  if (!brain) return;
  logWhiff(brain.dataBank, isPlayerPunch ? "player" : "ai", inRange, brain.gameTime);
}

export function notifyAiBlockContact(brain: AiBrainState, isHighGuard: boolean): void {
  if (!brain) return;
  notifyAiPunchContactedGuard(brain, isHighGuard);
}

// ===== ADAPTIVE AI SYSTEM =====

const TIMING_SLOT_DEFS: { id: string; maxNudge: number; riskCost: number; personalityKey?: keyof AiPersonality; personalityScale?: number }[] = [
  { id: "uppercutOnDuck", maxNudge: 0.40, riskCost: 0.3 },
  { id: "bodyAttackVsGuard", maxNudge: 0.35, riskCost: 0.15 },
  { id: "chaseAfterRetreat", maxNudge: 0.30, riskCost: 0.2, personalityKey: "aggression", personalityScale: 0.15 },
  { id: "feintBeforeAttack", maxNudge: 0.30, riskCost: 0.1, personalityKey: "feintiness", personalityScale: 0.12 },
  { id: "disengageAfterCombo", maxNudge: 0.35, riskCost: 0.1, personalityKey: "cleanHitsOverVolume", personalityScale: 0.10 },
  { id: "guardVsDodgePref", maxNudge: 0.30, riskCost: 0.15, personalityKey: "guardParanoia", personalityScale: 0.10 },
  { id: "engageCycleInBias", maxNudge: 0.25, riskCost: 0.2, personalityKey: "aggression", personalityScale: 0.08 },
  { id: "engageCycleOutBias", maxNudge: 0.25, riskCost: 0.1 },
  { id: "jabFrequency", maxNudge: 0.30, riskCost: 0.1 },
  { id: "powerPunchCommit", maxNudge: 0.35, riskCost: 0.35, personalityKey: "aggression", personalityScale: 0.10 },
  { id: "ringCutoffUrgency", maxNudge: 0.30, riskCost: 0.2, personalityKey: "aggression", personalityScale: 0.08 },
  { id: "ropePressureDuration", maxNudge: 0.25, riskCost: 0.25, personalityKey: "aggression", personalityScale: 0.06 },
  { id: "lateralVsLinear", maxNudge: 0.30, riskCost: 0.1 },
  { id: "comboLengthPref", maxNudge: 0.25, riskCost: 0.3, personalityKey: "aggression", personalityScale: 0.08 },
  { id: "counterWaitDuration", maxNudge: 0.30, riskCost: 0.15, personalityKey: "cleanHitsOverVolume", personalityScale: 0.10 },
  { id: "headTargetBias", maxNudge: 0.30, riskCost: 0.15, personalityKey: "headBias", personalityScale: 0.10 },
  { id: "bodyTargetBias", maxNudge: 0.30, riskCost: 0.15 },
  { id: "aggression", maxNudge: 0.25, riskCost: 0.25, personalityKey: "aggression", personalityScale: 0.08 },
  { id: "guardParanoiaBias", maxNudge: 0.25, riskCost: 0.1, personalityKey: "guardParanoia", personalityScale: 0.08 },
  { id: "duckApproachBias", maxNudge: 0.20, riskCost: 0.2 },
  { id: "commitChanceBias", maxNudge: 0.20, riskCost: 0.25, personalityKey: "aggression", personalityScale: 0.06 },
  { id: "patienceBias", maxNudge: 0.25, riskCost: 0.1, personalityKey: "cleanHitsOverVolume", personalityScale: 0.08 },
  { id: "retreatTrackBias", maxNudge: 0.25, riskCost: 0.2, personalityKey: "aggression", personalityScale: 0.06 },
  { id: "antiCornerPressure", maxNudge: 0.30, riskCost: 0.15 },
  { id: "crossCounterBias", maxNudge: 0.25, riskCost: 0.2, personalityKey: "cleanHitsOverVolume", personalityScale: 0.08 },
  { id: "hookFrequency", maxNudge: 0.25, riskCost: 0.25 },
  { id: "guardDropExploit", maxNudge: 0.35, riskCost: 0.15 },
  { id: "postDodgeAttack", maxNudge: 0.30, riskCost: 0.2 },
  { id: "defenseDisciplineBias", maxNudge: 0.20, riskCost: 0.1, personalityKey: "guardParanoia", personalityScale: 0.06 },
  { id: "staminaConservation", maxNudge: 0.25, riskCost: 0.1 },
  { id: "chargedPunchResponse", maxNudge: 0.30, riskCost: 0.2 },
  { id: "sustainedDuckPunish", maxNudge: 0.35, riskCost: 0.25 },
];

export function createAdaptiveMemory(brain: AiBrainState): AdaptiveMemory {
  const p = brain.personality;
  const diffScale = brain.difficultyBand === "Hardcore" ? 1.0 : brain.difficultyBand === "Hard" ? 0.85 : brain.difficultyBand === "Medium" ? 0.60 : 0.35;
  const timingBase: TimingSlot[] = TIMING_SLOT_DEFS.map(def => {
    let base = 0;
    if (def.personalityKey && def.personalityScale) {
      base = (p[def.personalityKey] - 0.5) * def.personalityScale;
    }
    return {
      id: def.id,
      base,
      nudge: 0,
      confidence: 0,
      maxNudge: def.maxNudge * diffScale,
      riskCost: def.riskCost,
    };
  });
  return {
    observations: [],
    timingBase,
    roundsOfData: 0,
    lastReviewTime: 0,
    midRoundReviewTimer: 0,
  };
}

function getLearnChance(band: DifficultyBand): number {
  switch (band) {
    case "Easy": return 0.02;
    case "Medium": return 0.08;
    case "Hard": return 0.18;
    case "Hardcore": return 0.30;
  }
}

function getMaxAdaptFrac(band: DifficultyBand): number {
  switch (band) {
    case "Easy": return 0.30;
    case "Medium": return 0.40;
    case "Hard": return 0.50;
    case "Hardcore": return 0.55;
  }
}

const PATTERN_TO_SLOTS: Record<string, { slotId: string; direction: number }[]> = {
  "duckCounter": [
    { slotId: "uppercutOnDuck", direction: 1 },
    { slotId: "bodyTargetBias", direction: 0.5 },
    { slotId: "sustainedDuckPunish", direction: 0.7 },
  ],
  "jabStep": [
    { slotId: "counterWaitDuration", direction: 0.6 },
    { slotId: "guardParanoiaBias", direction: 0.4 },
    { slotId: "retreatTrackBias", direction: -0.3 },
  ],
  "backstepCounter": [
    { slotId: "chaseAfterRetreat", direction: 1 },
    { slotId: "engageCycleInBias", direction: 0.5 },
    { slotId: "feintBeforeAttack", direction: 0.6 },
  ],
  "pivotPunch": [
    { slotId: "lateralVsLinear", direction: 0.8 },
    { slotId: "ringCutoffUrgency", direction: 0.5 },
    { slotId: "jabFrequency", direction: 0.3 },
  ],
  "blockCounter": [
    { slotId: "feintBeforeAttack", direction: 0.8 },
    { slotId: "guardDropExploit", direction: 0.5 },
    { slotId: "commitChanceBias", direction: -0.3 },
  ],
  "dodgeCounter": [
    { slotId: "postDodgeAttack", direction: 0.7 },
    { slotId: "disengageAfterCombo", direction: 0.5 },
    { slotId: "patienceBias", direction: 0.4 },
  ],
  "exchange": [
    { slotId: "aggression", direction: -0.3 },
    { slotId: "defenseDisciplineBias", direction: 0.5 },
    { slotId: "guardParanoiaBias", direction: 0.4 },
    { slotId: "engageCycleOutBias", direction: 0.3 },
  ],
  "ringCutting": [
    { slotId: "ringCutoffUrgency", direction: -0.6 },
    { slotId: "lateralVsLinear", direction: 0.5 },
    { slotId: "antiCornerPressure", direction: 0.4 },
  ],
  "cornerPressure": [
    { slotId: "antiCornerPressure", direction: 0.8 },
    { slotId: "ropePressureDuration", direction: -0.4 },
    { slotId: "disengageAfterCombo", direction: 0.5 },
  ],
  "ropeEscape": [
    { slotId: "ringCutoffUrgency", direction: 0.6 },
    { slotId: "ropePressureDuration", direction: 0.4 },
    { slotId: "chaseAfterRetreat", direction: 0.5 },
  ],
  "centerControl": [
    { slotId: "lateralVsLinear", direction: 0.4 },
    { slotId: "aggression", direction: -0.3 },
    { slotId: "engageCycleOutBias", direction: 0.4 },
  ],
  "swayFire": [
    { slotId: "lateralVsLinear", direction: 0.6 },
    { slotId: "jabFrequency", direction: 0.4 },
    { slotId: "guardVsDodgePref", direction: -0.3 },
    { slotId: "crossCounterBias", direction: 0.4 },
  ],
  "postPunchRetreat": [
    { slotId: "chaseAfterRetreat", direction: 0.7 },
    { slotId: "retreatTrackBias", direction: 0.5 },
    { slotId: "engageCycleInBias", direction: 0.3 },
    { slotId: "patienceBias", direction: -0.3 },
  ],
};

const ZONE_SLOT_BOOSTS: Partial<Record<RingZone, { slotId: string; bonus: number }[]>> = {
  "cornerNE": [{ slotId: "antiCornerPressure", bonus: 0.3 }],
  "cornerNW": [{ slotId: "antiCornerPressure", bonus: 0.3 }],
  "cornerSE": [{ slotId: "antiCornerPressure", bonus: 0.3 }],
  "cornerSW": [{ slotId: "antiCornerPressure", bonus: 0.3 }],
  "ropeN": [{ slotId: "ringCutoffUrgency", bonus: 0.2 }],
  "ropeS": [{ slotId: "ringCutoffUrgency", bonus: 0.2 }],
  "ropeE": [{ slotId: "ringCutoffUrgency", bonus: 0.2 }],
  "ropeW": [{ slotId: "ringCutoffUrgency", bonus: 0.2 }],
};

// ===== WHIFF / UNCLEAN SHOT LEARNING =====

function getWhiffLearnChanceBase(band: DifficultyBand): number {
  return band === "Easy" ? 0.25 : band === "Medium" ? 0.45 : band === "Hard" ? 0.65 : 0.80;
}

function getWhiffLearnChance(brain: AiBrainState): number {
  return Math.max(0, getWhiffLearnChanceBase(brain.difficultyBand) - brain.whiffLearnKdPenalty);
}

export function notifyAiKnockedDown(brain: AiBrainState): void {
  if (!brain) return;
  // Each KD this round reduces the effective learn chance by 5–10%
  const penalty = 0.05 + rng.next01() * 0.05;
  brain.whiffLearnKdPenalty = Math.min(1, brain.whiffLearnKdPenalty + penalty);
}

function getWhiffAdjustChance(band: DifficultyBand): number {
  return band === "Easy" ? 0.35 : band === "Medium" ? 0.47 : band === "Hard" ? 0.57 : 0.65;
}

export function notifyAiWhiffContext(brain: AiBrainState, dist: number, playerDucked: boolean, playerRhythmLevel: number): void {
  if (!brain) return;
  const snap: WhiffSnapshot = { dist, playerDucked, playerRhythmLevel, gameTime: brain.gameTime };
  brain.whiffSnapshots.push(snap);
  if (brain.whiffSnapshots.length > 20) brain.whiffSnapshots.shift();
}

function runWhiffLearning(brain: AiBrainState, dt: number): void {
  brain.whiffLearnTimer -= dt;
  if (brain.whiffLearnTimer > 0) return;
  // Next review in 8–12 seconds
  brain.whiffLearnTimer = 8 + rng.next01() * 4;

  const snaps = brain.whiffSnapshots;
  if (snaps.length < 2) return;

  // Chance to learn from the snapshot history (reduced by accumulated KD penalty)
  if (!rng.chance(getWhiffLearnChance(brain))) return;

  // Analyse: what fraction of whiffs happened while player was ducking?
  const duckSnaps = snaps.filter(s => s.playerDucked).length;
  const duckFrac = duckSnaps / snaps.length;

  // Analyse average range of whiff contexts
  const avgDist = snaps.reduce((a, s) => a + s.dist, 0) / snaps.length;

  // Decide what to nudge — probabilistic and mild
  if (rng.chance(getWhiffAdjustChance(brain.difficultyBand))) {
    // Body-bias nudge: if mostly ducking → push body bias up; if mostly standing → push down
    const bodyDir = duckFrac > 0.5 ? 1 : -1;
    const bodyNudge = bodyDir * rng.rollRange01(0.02, 0.06);
    brain.whiffLearnBodyBiasNudge = clamp(brain.whiffLearnBodyBiasNudge + bodyNudge, -0.20, 0.20);
  }

  if (rng.chance(getWhiffAdjustChance(brain.difficultyBand))) {
    // Range nudge: if whiffs cluster close → try stepping out; if far → try closing
    const currentIdeal = brain.aiLearntRangeAvg > 0 ? brain.aiLearntRangeAvg : brain.idealRangeNeutral;
    const rangeDir = avgDist < currentIdeal * 0.85 ? 1 : -1; // close whiffs → step out
    const rangeNudge = rangeDir * rng.rollRange01(2, 8);
    brain.whiffLearnRangeNudge = clamp(brain.whiffLearnRangeNudge + rangeNudge, -30, 30);
  }

  // Trim old snapshots after learning
  const cutoff = brain.gameTime - 20;
  brain.whiffSnapshots = brain.whiffSnapshots.filter(s => s.gameTime >= cutoff);
}

export function reviewAdaptiveMemory(brain: AiBrainState, dt: number): void {
  const mem = brain.adaptiveMemory;
  if (!mem) return;

  mem.midRoundReviewTimer += dt;
  const shouldReview = mem.midRoundReviewTimer >= 10.0;
  if (!shouldReview) return;
  mem.midRoundReviewTimer = 0;

  const learnChance = getLearnChance(brain.difficultyBand);
  const maxFrac = getMaxAdaptFrac(brain.difficultyBand);
  const roundWeight = Math.min(1.0, mem.roundsOfData / 4);
  const riskTolerance = brain.difficultyBand === "Hardcore" ? 0.8 : brain.difficultyBand === "Hard" ? 0.6 : brain.difficultyBand === "Medium" ? 0.4 : 0.2;

  for (const obs of mem.observations) {
    if (obs.confidence < 0.5) continue;

    const isComboObs = obs.kind.startsWith("combo:");
    const lookupKind = isComboObs ? "exchange" : obs.kind;
    const slotMappings = PATTERN_TO_SLOTS[lookupKind];
    if (!slotMappings) continue;

    const comboMultiplier = isComboObs ? 1.5 : (obs.comboSequence ? 1.2 : 1.0);
    const confScale = Math.min(1.0, obs.confidence / 3.0);
    const effectiveChance = learnChance * confScale * comboMultiplier * (0.3 + roundWeight * 0.7);
    if (!rng.chance(effectiveChance)) continue;

    for (const mapping of slotMappings) {
      const slot = mem.timingBase.find(s => s.id === mapping.slotId);
      if (!slot) continue;

      if (slot.riskCost > riskTolerance && !rng.chance(0.15)) continue;

      const nudgeDelta = 0.03 * mapping.direction * confScale * comboMultiplier;
      const maxAbs = slot.maxNudge * maxFrac;
      const riskPenalty = slot.riskCost > riskTolerance ? 0.5 : 1.0;
      slot.nudge = clamp(slot.nudge + nudgeDelta * riskPenalty, -maxAbs, maxAbs);
      slot.confidence += 0.1 * comboMultiplier;
    }

    const zoneBoosts = ZONE_SLOT_BOOSTS[obs.zone];
    if (zoneBoosts) {
      for (const zb of zoneBoosts) {
        const slot = mem.timingBase.find(s => s.id === zb.slotId);
        if (slot) {
          const maxAbs = slot.maxNudge * maxFrac;
          const riskPenalty = slot.riskCost > riskTolerance ? 0.5 : 1.0;
          slot.nudge = clamp(slot.nudge + 0.02 * zb.bonus * confScale * comboMultiplier * riskPenalty, -maxAbs, maxAbs);
        }
      }
    }
  }
}

export function onRoundBoundaryAdaptive(brain: AiBrainState): void {
  const mem = brain.adaptiveMemory;
  if (!mem) return;

  mem.roundsOfData++;

  const learnChance = getLearnChance(brain.difficultyBand);
  const maxFrac = getMaxAdaptFrac(brain.difficultyBand);
  const riskTolerance = brain.difficultyBand === "Hardcore" ? 0.8 : brain.difficultyBand === "Hard" ? 0.6 : brain.difficultyBand === "Medium" ? 0.4 : 0.2;
  const roundWeight = Math.min(1.0, mem.roundsOfData / 4);
  const roundLearnBoost = 1.5;

  for (const obs of mem.observations) {
    if (obs.confidence < 0.3) continue;
    const isComboObs = obs.kind.startsWith("combo:");
    const lookupKind = isComboObs ? "exchange" : obs.kind;
    const slotMappings = PATTERN_TO_SLOTS[lookupKind];
    if (!slotMappings) continue;

    const comboMultiplier = isComboObs ? 1.5 : (obs.comboSequence ? 1.2 : 1.0);
    const confScale = Math.min(1.0, obs.confidence / 2.5);
    const effectiveChance = learnChance * confScale * roundLearnBoost * comboMultiplier * (0.4 + roundWeight * 0.6);
    if (!rng.chance(effectiveChance)) continue;

    for (const mapping of slotMappings) {
      const slot = mem.timingBase.find(s => s.id === mapping.slotId);
      if (!slot) continue;
      if (slot.riskCost > riskTolerance && !rng.chance(0.2)) continue;

      const nudgeDelta = 0.04 * mapping.direction * confScale * comboMultiplier;
      const maxAbs = slot.maxNudge * maxFrac;
      const riskPenalty = slot.riskCost > riskTolerance ? 0.5 : 1.0;
      slot.nudge = clamp(slot.nudge + nudgeDelta * riskPenalty, -maxAbs, maxAbs);
      slot.confidence += 0.15 * comboMultiplier;
    }
  }

  for (const obs of mem.observations) {
    obs.confidence *= 0.85;
  }
  mem.observations = mem.observations.filter(o => o.confidence >= 0.1);

  mem.midRoundReviewTimer = 0;

  // Reset the escalating forget chance each round
  brain.rangeForgetChance = 0.35;

  // Soft-reset whiff learning each round (keep 30% of accumulated nudge for continuity)
  brain.whiffLearnRangeNudge *= 0.30;
  brain.whiffLearnBodyBiasNudge *= 0.30;
  brain.whiffSnapshots = [];
  brain.whiffLearnTimer = 8 + rng.next01() * 4;
  // KD penalty fully resets each round
  brain.whiffLearnKdPenalty = 0;
}

function getSlotValue(mem: AdaptiveMemory | null, slotId: string): number {
  if (!mem) return 0;
  const slot = mem.timingBase.find(s => s.id === slotId);
  if (!slot) return 0;
  const roundWeight = Math.min(1.0, mem.roundsOfData / 4);
  return slot.base + slot.nudge * (0.2 + roundWeight * 0.8);
}

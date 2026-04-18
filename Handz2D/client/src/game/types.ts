export type Archetype = "BoxerPuncher" | "OutBoxer" | "Brawler" | "Swarmer";

export type AIDifficulty = "journeyman" | "contender" | "elite" | "champion";

export const AI_DIFFICULTY_LABELS: Record<AIDifficulty, string> = {
  journeyman: "Journeyman",
  contender: "Contender",
  elite: "Elite",
  champion: "Champion",
};

export const AI_DIFFICULTY_DESCRIPTIONS: Record<AIDifficulty, string> = {
  journeyman: "A stepping stone. Goes down easier.",
  contender: "Solid opponent. Won't quit without a fight.",
  elite: "Tough as nails. Hard to put away.",
  champion: "The real deal. Almost impossible to stop.",
};

export type AiState = "Approach" | "Maintain" | "Retreat" | "Panic";

export type TacticalPhase = "Probe" | "Download" | "Pressure" | "WhiffPunish" | "Counter" | "BodyHunt" | "Finish" | "Panic";

export type DifficultyBand = "Easy" | "Medium" | "Hard" | "Hardcore";

export const DIFFICULTY_TO_BAND: Record<AIDifficulty, DifficultyBand> = {
  journeyman: "Easy",
  contender: "Medium",
  elite: "Hard",
  champion: "Hardcore",
};

export interface AiPersonality {
  aggression: number;
  guardParanoia: number;
  feintiness: number;
  cleanHitsOverVolume: number;
  headBias: number;
}

export interface AiHitRecord {
  time: number;
  actor: "player" | "ai";
  region: "head" | "body";
  damage: number;
  inRange: boolean;
}

export interface AiWhiffRecord {
  time: number;
  actor: "player" | "ai";
  inRange: boolean;
}

export interface AiHitPattern {
  kind: "punch" | "feint";
  avgInterval: number;
  eventCount: number;
  lastSeenTime: number;
  successfulCounters: number;
  locked: boolean;
}

export interface AiHitSummary {
  headHits: number;
  bodyHits: number;
}

export interface AiDataBank {
  recentHits: AiHitRecord[];
  recentWhiffs: AiWhiffRecord[];
  offensiveEvents: { time: number; isFeint: boolean; inRange: boolean }[];
  hitPatterns: AiHitPattern[];
  maxHitHistory: number;
  maxWhiffHistory: number;
  maxHitPatterns: number;
  patternWindowSeconds: number;
  patternIntervalTolerance: number;
}

export interface AiComboStep {
  punch: PunchType;
  isFeint: boolean;
  delayAfter: number;
  targetBody: boolean;
}

export interface AiCombo {
  steps: AiComboStep[];
  name: string;
}

export interface WhiffSnapshot {
  dist: number;
  playerDucked: boolean;
  playerRhythmLevel: number;
  gameTime: number;
}

export interface AiBrainState {
  currentState: AiState;
  currentPhase: TacticalPhase;
  difficultyBand: DifficultyBand;
  difficultyScore: number;
  personality: AiPersonality;
  dataBank: AiDataBank;

  // Think interval timers
  stateThinkTimer: number;
  phaseThinkTimer: number;
  moveThinkTimer: number;
  attackThinkTimer: number;
  defenseThinkTimer: number;

  // Think interval base rates
  stateThinkInterval: number;
  phaseThinkInterval: number;
  moveThinkInterval: number;
  attackThinkInterval: number;
  defenseThinkInterval: number;

  defenseHoldTimer: number;
  playerIdleTime: number;
  playerCornerCamping: boolean;
  playerLastX: number;
  playerLastZ: number;
  playerCornerStallTimer: number;

  // Stamina tracking
  prevMyStamina: number;
  prevPlayerStamina: number;
  punchesTakenByAI: number;
  playerCleanHitsLanded: number;
  punchesLandedByAI: number;
  totalDamageTaken: number;
  lastTimeTookHit: number;

  // Conditioning
  headConditionScore: number;
  bodyConditionScore: number;

  // Survival
  survivalModeActive: boolean;

  // Perfect reactions
  perfectReactActive: boolean;
  perfectReactUntil: number;
  nextPerfectReactTime: number;
  perfectReactFadeFrac: number;
  perfectReactBelowFullStaminaTimer: number;
  forcedGuard: boolean;
  forcedHigh: boolean;
  forcedLow: boolean;
  forcedDuck: boolean;
  stepOutDesiredMove: number;

  // Movement
  desiredMoveInput: number;
  desiredMoveZ: number;
  lateralDir: 1 | -1;
  lateralSwitchTimer: number;
  hitReactRetreatTimer: number;
  hitReactLateralDir: 1 | -1;

  // Counter mode
  counterModeActive: boolean;

  // Directional targeting
  directionalSlider01: number;
  playerHighBlockHeldSeconds: number;
  playerLowBlockHeldSeconds: number;

  // Scorecard
  scorecardBias: number;

  // Archetype biases
  classAggressionBias: number;
  classRangeBias: number;
  classComboBias: number;

  // Winner mind
  winnerMindIntensity: number;
  winnerMindRoll01: number;

  // Rhythm cut
  rhythmCutAggression01: number;
  rhythmCutCommitChanceRoll01: number;
  rhythmCutUntil: number;
  nextRhythmCutAllowedTime: number;

  // Jab doctrine
  jabDoctrineRoll01: number;

  // Reroll thresholds
  nextWinnerMindRerollAtTaken: number;
  nextRhythmCutCommitRerollAtTaken: number;
  nextJabDoctrineRerollAtTaken: number;
  nextRhythmCutAggressionDriftAtLanded: number;

  // Combo runner state
  comboActive: boolean;
  comboSteps: AiComboStep[];
  comboStepIndex: number;
  comboStepTimer: number;
  comboCooldown: number;

  // Game time reference
  gameTime: number;

  // Range constants (in pixels, computed from block-to-pixel mapping)
  attackRangeMin: number;
  attackRangeMax: number;
  idealRangeNeutral: number;
  idealRangePressure: number;
  idealRangeWhiffPunish: number;
  idealRangeCounter: number;
  idealRangeSurvival: number;
  rangeWidth: number;
  counterRangeWidth: number;

  // Player landed punch tracking for repeat penalty
  playerLandedPunchCounts: Record<string, number>;

  // AI style system (varied per seed and archetype)
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
  adaptationRate: number;
  engageCycleTimer: number;
  engageCyclePhase: "out" | "in";
  defenseCycleTimer: number;
  playerGuardDropTimer: number;
  playerDuckApproachTimer: number;
  playerBodyAttackRatio: number;
  playerBodyAttackCount: number;
  playerHeadAttackCount: number;
  playerRetreatTimer: number;
  playerSustainedDuckTimer: number;
  playerDuckPunchCount: number;
  playerDuckPunchDecay: number;
  styleSustainedDuckCounter: number;
  stylePostDodgeFollowup: number;
  lastPunchDodgedTimer: number;
  playerCrossCount: number;
  playerTotalPunchCount: number;
  playerLastDefenseSwitch: number;
  playerPrevDefenseState: string;
  recentPlayerPunches: string[];
  playerApproaching: boolean;

  postFeintWindow: number;
  postFeintPlayerDefense: string;
  postFeintFollowupReady: boolean;

  reactionDelayTimer: number;
  reactionDelayBase: number;
  reactionDelayPerHit: number;
  reactionDelayConsecutiveHits: number;
  reactionDelayConsecutiveDecay: number;

  adaptiveMemory: AdaptiveMemory | null;

  // Rhythm timing read: AI learns to time punches to player's rhythm center
  lastKnownPlayerSwaySpeed: number;
  rhythmTimingAccuracy: number;

  // Attack range learning: AI snapshots distance on each landed punch, builds average
  landedPunchDistSnapshots: number[];
  aiLearntRangeAvg: number;

  // AI own rhythm management
  aiRhythmChangeTimer: number;
  aiRhythmTargetLevel: number;
  aiRhythmSpeedMult: number;

  // Attack range forgetting: chance escalates +3% per crit/stun, resets each round
  rangeForgetChance: number;

  // Duck-aware targeting bias — re-rolled each time player duck state transitions
  duckBodyBias: number;       // body% when player is ducking (0.60–0.90)
  standHeadBias: number;      // head% when player is standing (0.60–0.90)
  prevPlayerDuckState: boolean;

  // Whiff / unclean-shot learning
  whiffSnapshots: WhiffSnapshot[];
  whiffLearnTimer: number;
  whiffLearnRangeNudge: number;    // pixel offset applied to ideal engagement range
  whiffLearnBodyBiasNudge: number; // probability nudge on body/head split
  whiffLearnKdPenalty: number;     // cumulative penalty from KDs this round (5-10% each)

  // Directional guard system
  guardHighProb: number;
  guardReactionTimer: number;
  guardReactionDelay: number;
  guardPendingSwitch: "high" | "low" | null;
  guardConditioningMemory: Array<{ zone: "head" | "body"; damage: number; time: number }>;
  guardConditioningMax: number;
  guardPredictionConfidence: number;
  guardFatigueReactionPenalty: number;
}

export type RingZone = "center" | "ropeN" | "ropeS" | "ropeE" | "ropeW" | "cornerNE" | "cornerNW" | "cornerSE" | "cornerSW";

export interface ObservedPattern {
  kind: string;
  zone: RingZone;
  round: number;
  fightTime: number;
  playerStaminaDelta: number;
  aiStaminaDelta: number;
  damageToAi: number;
  damageToPlayer: number;
  comboSequence: string | null;
  confidence: number;
  count: number;
  playerStaminaFrac: number;
  aiStaminaFrac: number;
}

export interface TimingSlot {
  id: string;
  base: number;
  nudge: number;
  confidence: number;
  maxNudge: number;
  riskCost: number;
}

export interface AdaptiveMemory {
  observations: ObservedPattern[];
  timingBase: TimingSlot[];
  roundsOfData: number;
  lastReviewTime: number;
  midRoundReviewTimer: number;
}

export interface KnockdownChances {
  kd1: number;
  kd2: number;
  kd3: number;
}

export const AI_KD_CHANCES: Record<AIDifficulty, KnockdownChances> = {
  journeyman: { kd1: 0.80, kd2: 0.50, kd3: 0.20 },
  contender:  { kd1: 0.85, kd2: 0.75, kd3: 0.30 },
  elite:      { kd1: 1.00, kd2: 1.00, kd3: 0.75 },
  champion:   { kd1: 1.00, kd2: 1.00, kd3: 1.00 },
};

export type PunchType = "jab" | "cross" | "leftHook" | "rightHook" | "leftUppercut" | "rightUppercut";

export type FightPhase = "menu" | "classSelect" | "prefight" | "fighting" | "roundEnd" | "fightEnd" | "levelUp";

export type FightResultType = "KO" | "TKO" | "Decision" | "Draw";

export type DefenseState = "none" | "duck" | "fullGuard";

export type StanceType = "frontFoot" | "neutral" | "backFoot";

export type PunchPhaseType = "launchDelay" | "armSpeed" | "contact" | "linger" | "retraction";

export type RhythmPhase = "beginning" | "middle" | "end";

export interface Vec2 {
  x: number;
  y: number;
}

export interface FighterColors {
  gloves: string;
  gloveTape: string;
  trunks: string;
  shoes: string;
  skin: string;
}

export const SKIN_COLOR_PRESETS = [
  "#f5d0b0", "#e8c4a0", "#d4a574", "#c49a6c", "#a87040", "#8d5524", "#6b3a1f", "#3b1f0e",
];

export const DEFAULT_PLAYER_COLORS: FighterColors = {
  gloves: "#cc2222",
  gloveTape: "#eeeeee",
  trunks: "#2244aa",
  shoes: "#1a1a1a",
  skin: "#e8c4a0",
};

export const DEFAULT_ENEMY_COLORS: FighterColors = {
  gloves: "#1155cc",
  gloveTape: "#dddddd",
  trunks: "#222222",
  shoes: "#2a1a1a",
  skin: "#c49a6c",
};

export interface FighterState {
  name: string;
  archetype: Archetype;
  level: number;
  x: number;
  z: number;
  y: number;
  stamina: number;
  maxStamina: number;
  maxStaminaCap: number;
  staminaRegen: number;
  facing: 1 | -1;
  facingAngle: number;
  headOffset: Vec2;
  leftGloveOffset: Vec2;
  rightGloveOffset: Vec2;
  bodyOffset: Vec2;
  bobPhase: number;
  bobSpeed: number;
  baseBobSpeed: number;
  defenseState: DefenseState;
  preDuckBlockState: DefenseState | null;
  guardBlend: number;
  isPunching: boolean;
  currentPunch: PunchType | null;
  currentPunchStaminaCost: number;
  punchProgress: number;
  punchCooldown: number;
  isHit: boolean;
  hitTimer: number;
  critHitTimer: number;
  cleanHitEyeTimer: number;
  regenPauseTimer: number;
  moveSpeed: number;
  punchSpeedMult: number;
  damageMult: number;
  defenseMult: number;
  staminaCostMult: number;
  knockdowns: number;
  knockdownsGiven: number;
  punchesThrown: number;
  punchesLanded: number;
  cleanPunchesLanded: number;
  feintBaits: number;
  damageDealt: number;
  timeSinceLastLanded: number;
  timeSinceLastDamageTaken: number;
  damageTakenRegenPauseFired: boolean;
  kdRegenBoostActive: boolean;
  unansweredStreak: number;
  momentumRegenBoost: number;
  momentumRegenTimer: number;
  isPlayer: boolean;
  isKnockedDown: boolean;
  knockdownTimer: number;
  duckTimer: number;
  colors: FighterColors;
  isFeinting: boolean;
  isCharging: boolean;
  chargeTimer: number;
  stance: StanceType;
  handsDown: boolean;
  halfGuardPunch: boolean;
  rhythmLevel: number;
  rhythmProgress: number;
  rhythmDirection: number;
  punchPhase: PunchPhaseType | null;
  punchPhaseTimer: number;
  isRePunch: boolean;
  retractionProgress: number;
  staminaPauseFromRhythm: number;
  speedBoostTimer: number;
  punchAimsHead: boolean;
  blockTimer: number;
  maxBlockDuration: number;
  blockRegenPenaltyTimer: number;
  blockRegenPenaltyDuration: number;
  punchingWhileBlocking: boolean;
  recentPunchTimestamps: number[];
  punchFatigueTimer: number;
  isPunchFatigued: boolean;
  duckHoldTimer: number;
  duckDrainCooldown: number;
  duckProgress: number;
  backLegDrive: number;
  frontLegDrive: number;
  moveSlowMult: number;
  moveSlowTimer: number;
  pushbackVx: number;
  pushbackVz: number;
  guardDownTimer: number;
  guardDownSpeedBoost: number;
  guardDownBoostTimer: number;
  guardDownBoostMax: number;
  stunBlockDisableTimer: number;
  stunBlockWeakenTimer: number;
  stunPunchDisableTimer: number;
  stunPunchSlowMult: number;
  stunPunchSlowTimer: number;
  chargeCooldownTimer: number;
  chargeReadyWindowTimer: number;
  chargeReady: boolean;
  chargeArmed: boolean;
  chargeUsesLeft: number;
  chargeArmTimer: number;
  chargeMeterCounters: number;
  chargeMeterBars: number;
  chargeEmpoweredTimer: number;
  chargeEmpoweredDuration: number;
  chargeMeterLockoutTimer: number;
  chargeHoldTimer: number;
  chargeFlashTimer: number;
  chargeHeadOffset: number;
  blockFlashTimer: number;
  punchTravelStartTime: number;
  consecutiveChargeTimer: number;
  consecutiveChargeCount: number;
  feintWhiffPenaltyCooldown: number;
  retractionPenaltyMult: number;
  armLength: number;
  aiGuardDropTimer: number;
  aiGuardDropCooldown: number;
  telegraphPhase: "none" | "down" | "up" | "duckDown" | "duckUp";
  telegraphTimer: number;
  telegraphDuration: number;
  telegraphPunchType: PunchType | null;
  telegraphIsFeint: boolean;
  telegraphIsCharged: boolean;
  timeSinceLastPunch: number;
  timeSinceGuardRaised: number;
  blinkTimer: number;
  blinkDuration: number;
  isBlinking: boolean;
  feintTelegraphDisableTimer: number;
  feintedTelegraphBoost: number;
  telegraphKdMult: number;
  telegraphRoundBonus: number;
  telegraphFeintRoundPenalty: number;
  telegraphSlowTimer: number;
  telegraphSlowDuration: number;
  telegraphHeadSlideX: number;
  telegraphHeadSlideY: number;
  telegraphHeadSlideTimer: number;
  telegraphHeadSlideDuration: number;
  telegraphHeadSlidePhase: "none" | "sliding" | "holding" | "returning";
  telegraphHeadHoldTimer: number;
  telegraphHeadSinkProgress: number;
  duckSpeedMult: number;
  blockMult: number;
  critResistMult: number;
  critMult: number;
  stunMult: number;
  focusT: number;
  facingLockTimer: number;
  telegraphSpeedMult: number;
  handsDownTimer: number;
  handsDownCooldown: number;
  feintHoldTimer: number;
  feintTouchingOpponent: boolean;
  feintDuckTouchingOpponent: boolean;
  autoGuardActive: boolean;
  autoGuardTimer: number;
  autoGuardDuration: number;
  lastSpacePressTime: number;
  spaceWasUp: boolean;

  swayPhase: number;
  swayDir: 1 | -1;
  swayOffset: number;
  swaySpeedLevel: number;
  swayFrozen: boolean;
  telegraphSwayAnimating: boolean;
  telegraphSwayTarget: number;
  swayZone: "power" | "offBalance" | "neutral";
  swayDamageMult: number;
  swayTelegraphMult: number;
  miniStunTimer: number;
  rhythmPauseTimer: number;

  weaveActive: boolean;
  weaveDirX: number;
  weaveDirY: number;
  weaveProgress: number;
  weaveDuration: number;
  weaveRecoveryTimer: number;
  weaveCooldown: number;
  preWeaveStance: StanceType;
  weaveCounterTimer: number;
}

export interface PunchConfig {
  damage: number;
  staminaCost: number;
  speed: number;
  range: number;
  isLeft: boolean;
  hitsHead: boolean;
}

export interface JudgeScore {
  player: number;
  enemy: number;
}

export interface RoundScore {
  player: number;
  enemy: number;
  judges: [JudgeScore, JudgeScore, JudgeScore];
  playerKDsThisRound: number;
  enemyKDsThisRound: number;
  playerLandedPct: number;
  enemyLandedPct: number;
  playerDamage: number;
  enemyDamage: number;
  playerLandedThisRound: number;
  enemyLandedThisRound: number;
}

export type TimerSpeed = "normal" | "double";

export type PauseAction = "resume" | "restart" | "quit" | null;

export interface GameState {
  phase: FightPhase;
  player: FighterState;
  enemy: FighterState;
  currentRound: number;
  totalRounds: number;
  roundTimer: number;
  roundDuration: number;
  roundScores: RoundScore[];
  fightResult: FightResultType | null;
  fightWinner: "player" | "enemy" | null;
  xpGained: number;
  countdownTimer: number;
  knockdownCountdown: number;
  knockdownMashCount: number;
  knockdownMashRequired: number;
  knockdownMashTimer: number;
  knockdownRefCount: number;
  knockdownActive: boolean;
  ringWidth: number;
  ringLeft: number;
  ringRight: number;
  ringTop: number;
  ringBottom: number;
  ringDepth: number;
  selectedArchetype: Archetype;
  playerLevel: number;
  enemyLevel: number;
  enemyName: string;
  isPaused: boolean;
  pauseSelectedIndex: number;
  pauseAction: PauseAction;
  pauseSoundTab: boolean;
  pauseControlsTab: boolean;
  isQuickFight: boolean;
  fatigueEnabled: boolean;
  aiDifficulty: AIDifficulty;
  cornerWalkActive: boolean;
  cornerWalkTimer: number;
  aiKdGetUpTime: number;
  aiKdWillGetUp: boolean;
  refereeVisible: boolean;
  standingFighterTargetX: number;
  standingFighterTargetZ: number;
  savedDefenseState: DefenseState;
  savedHandsDown: boolean;
  savedBlockTimer: number;
  savedStandingIsPlayer: boolean;
  kdSavedKnockedRhythmLevel: number;
  kdSavedStandingRhythmLevel: number;
  shakeIntensity: number;
  shakeTimer: number;
  hitEffects: HitEffect[];
  playerColors: FighterColors;
  roundStats: {
    playerDamageThisRound: number;
    enemyDamageThisRound: number;
    playerPunchesThisRound: number;
    enemyPunchesThisRound: number;
    playerLandedThisRound: number;
    enemyLandedThisRound: number;
    playerKDsThisRound: number;
    enemyKDsThisRound: number;
    playerAggressionTime: number;
    enemyAggressionTime: number;
    playerRingControlTime: number;
    enemyRingControlTime: number;
    playerPunchesDodged: number;
    enemyPunchesDodged: number;
    playerPunchesBlocked: number;
    enemyPunchesBlocked: number;
    playerDuckDodges: number;
    playerComboCount: number;
    playerConsecutiveLanded: number;
  };
  timerSpeed: TimerSpeed;
  aiBrain: AiBrainState | null;
  fightTotalDuckDodges: number;
  fightTotalCombos: number;
  kdIsBodyShot: boolean;
  kdTakeKnee: boolean;
  kdFaceRefActive: boolean;
  kdFaceRefTimer: number;
  refStoppageActive: boolean;
  refStoppageTimer: number;
  refStoppageType: "mercy" | "towel" | null;
  mercyStoppageEnabled: boolean;
  towelStoppageEnabled: boolean;
  practiceMode: boolean;
  cpuAttacksEnabled: boolean;
  cpuDefenseEnabled: boolean;
  sparringMode: boolean;
  careerFightMode: boolean;
  careerEnemySkillPoints?: { power: number; speed: number; defense: number; stamina: number; focus?: number };
  enemyWhiffBonus: number;
  towelActive: boolean;
  towelTimer: number;
  towelStartX: number;
  towelStartY: number;
  towelEndX: number;
  towelEndY: number;
  refX: number;
  refZ: number;
  enemyColors: FighterColors;
  ringCanvasColor: string;
  totalEnemyKDs: number;
  kdSequence: ("player" | "enemy")[];
  towelImmunityUsed: boolean;
  fightElapsedTime: number;
  kdTimerExpired: boolean;
  introAnimActive: boolean;
  introAnimTimer: number;
  introAnimPhase: number;
  playerIntroPlaying: boolean;
  enemyIntroPlaying: boolean;
  playerSavedRhythmLevel: number;
  enemySavedRhythmLevel: number;
  swarmerPunchQueue: PunchType[];
  swarmerPunchIndex: number;
  swarmerPunchDelay: number;
  swarmerIsPlayer: boolean;
  recordInputs: boolean;
  inputRecording: InputRecording | null;
  cpuVsCpu: boolean;
  playerAiBrain: AiBrainState | null;
  telegraphMult: number;
  hitstopTimer: number;
  hitstopDuration: number;
  crowdBobTime: number;
  crowdKdBounceTimer: number;
  crowdExciteTimer: number;
  crowdKdSpeedTimer: number;
  cleanHitStreak: number;
  playerCurrentXp: number;
  midFightLevelUps: number;
  midFightLevelUpTimer: number;
  adaptiveAiEnabled: boolean;
  behaviorProfile: BehaviorProfile | null;
  tutorialMode: boolean;
  tutorialStage: number;
  tutorialStep: number;
  tutorialPrompt: string;
  tutorialPromptTimer: number;
  tutorialAiIdle: boolean;
  tutorialTracking: TutorialTracking;
  tutorialShowContinueButton: boolean;
  tutorialFightUnlocked: boolean;
  tutorialDelayTimer: number;
  tutorialCareerMode: boolean;
}

export interface TutorialTracking {
  movedLeft: boolean;
  movedRight: boolean;
  movedUp: boolean;
  movedDown: boolean;
  threwJab: boolean;
  threwCross: boolean;
  threwLeftHook: boolean;
  threwRightHook: boolean;
  threwLeftUppercut: boolean;
  threwRightUppercut: boolean;
  punchesBlocked: number;
  ducked: boolean;
  autoGuardActivated: boolean;
  guardToggled: boolean;
  weaveCount: number;
  rhythmChangeCount: number;
  chargeUsed: boolean;
  feintCount: number;
  punchFeintCount: number;
}

export interface SequenceTracker {
  kind: string;
  startTime: number;
  startPlayerStamina: number;
  startAiStamina: number;
  startPlayerDamageDealt: number;
  startAiDamageDealt: number;
  phase: number;
  zone: RingZone;
  comboKeys: string[];
}

export interface BehaviorProfile {
  activeSequences: SequenceTracker[];
  recentPlayerMoveX: number[];
  recentPlayerMoveZ: number[];
  recentPlayerPunchTimes: number[];
  playerLastPunchTime: number;
  playerLastDuckTime: number;
  playerLastBlockTime: number;
  playerLastDodgeTime: number;
  playerLastRetreatTime: number;
  playerWasMovingForward: boolean;
  playerWasMovingBackward: boolean;
  playerWasMovingLateral: boolean;
  playerPrevX: number;
  playerPrevZ: number;
  playerPrevStamina: number;
  aiPrevStamina: number;
  exchangeStartTime: number;
  exchangeActive: boolean;
  exchangePlayerDmgStart: number;
  exchangeAiDmgStart: number;
  exchangePlayerStamStart: number;
  exchangeAiStamStart: number;
  exchangeZone: RingZone;
  exchangeComboKeys: string[];
  lastExchangeEnd: number;
  ringCutTimer: number;
  ringCutStartStamina: number;
  ringCutStartAiStamina: number;
  ringCutStartDmg: number;
  ringCutStartAiDmg: number;
  ringCutZone: RingZone;
  cornerPressureTimer: number;
  cornerPressureStartStamina: number;
  cornerPressureStartAiStamina: number;
  cornerPressureStartDmg: number;
  cornerPressureStartAiDmg: number;
  ropeEscapeTimer: number;
  ropeEscapeStartStamina: number;
  ropeEscapeStartAiStamina: number;
  ropeEscapeStartDmg: number;
  ropeEscapeStartAiDmg: number;
  centerControlTimer: number;
  centerControlStartStamina: number;
  centerControlStartAiStamina: number;
  centerControlStartDmg: number;
  centerControlStartAiDmg: number;
  lastMacroCheckTime: number;
  playerLastPunchEndTime: number;
  postPunchRetreatDetected: boolean;
  swayFireTimer: number;
}

export interface RecordedEvent {
  t: number;
  type: "move" | "punch" | "defense" | "knockdown" | "hit" | "block" | "dodge" | "stance" | "rhythm" | "charge" | "feint" | "pos";
  actor: "player" | "enemy";
  data: Record<string, unknown>;
  px: number;
  pz: number;
  ex: number;
  ez: number;
  dist: number;
  pStam: number;
  eStam: number;
}

export interface InputRecording {
  fightSettings: {
    playerArchetype: Archetype;
    enemyArchetype: Archetype;
    playerLevel: number;
    enemyLevel: number;
    aiDifficulty: AIDifficulty;
    roundDuration: number;
    timerSpeed: TimerSpeed;
    totalRounds: number;
    playerArmLength: number;
    enemyArmLength: number;
    practiceMode: boolean;
    cpuVsCpu: boolean;
    playerName: string;
    enemyName: string;
  };
  rounds: RecordedRound[];
}

export interface RecordedRound {
  roundNumber: number;
  startTime: number;
  events: RecordedEvent[];
  summary: RoundRecordSummary;
}

export interface RoundRecordSummary {
  playerPunches: Record<string, { thrown: number; landed: number; feinted: number; charged: number; body: number }>;
  enemyPunches: Record<string, { thrown: number; landed: number; feinted: number; charged: number; body: number }>;
  playerMovement: { totalDistance: number; avgDistFromEnemy: number; timeInRange: number; timeOutRange: number };
  enemyMovement: { totalDistance: number; avgDistFromEnemy: number; timeInRange: number; timeOutRange: number };
  playerDefense: { ducks: number; duckTime: number; fullGuards: number; blocksLanded: number; dodges: number };
  enemyDefense: { ducks: number; duckTime: number; fullGuards: number; blocksLanded: number; dodges: number };
  knockdowns: { player: number; enemy: number };
  duration: number;
}

export interface HitEffect {
  x: number;
  y: number;
  timer: number;
  type: "normal" | "crit" | "block" | "feint";
  text: string;
}

export const PUNCH_CONFIGS: Record<PunchType, PunchConfig> = {
  jab: { damage: 4.01, staminaCost: 1.36, speed: 1.26, range: 65, isLeft: true, hitsHead: true },
  cross: { damage: 5.17, staminaCost: 2.04, speed: 0.9, range: 70, isLeft: false, hitsHead: true },
  leftHook: { damage: 4.59, staminaCost: 1.7, speed: 0.81, range: 50, isLeft: true, hitsHead: true },
  rightHook: { damage: 5.74, staminaCost: 2.72, speed: 0.81, range: 50, isLeft: false, hitsHead: true },
  leftUppercut: { damage: 6.89, staminaCost: 3.74, speed: 0.675, range: 59, isLeft: true, hitsHead: false },
  rightUppercut: { damage: 8.04, staminaCost: 4.42, speed: 0.675, range: 59, isLeft: false, hitsHead: false },
};

export const ARCHETYPE_STATS: Record<Archetype, {
  maxStaminaMult: number;
  regenMult: number;
  punchCostMult: number;
  damageMult: number;
  speedMult: number;
  description: string;
}> = {
  BoxerPuncher: {
    maxStaminaMult: 1.0,
    regenMult: 1.0,
    punchCostMult: 1.0,
    damageMult: 1.0,
    speedMult: 1.0,
    description: "Balanced fighter with solid fundamentals in all areas.",
  },
  OutBoxer: {
    maxStaminaMult: 1.0,
    regenMult: 1.0075,
    punchCostMult: 0.985,
    damageMult: 0.95,
    speedMult: 1.1,
    description: "Fast and efficient. Controls distance with quick jabs.",
  },
  Brawler: {
    maxStaminaMult: 1.015,
    regenMult: 1.0,
    punchCostMult: 1.022,
    damageMult: 1.15,
    speedMult: 0.9,
    description: "Heavy hitter. Takes and dishes out big damage.",
  },
  Swarmer: {
    maxStaminaMult: 0.99,
    regenMult: 1.005,
    punchCostMult: 0.99,
    damageMult: 1.05,
    speedMult: 1.15,
    description: "Relentless pressure fighter. Overwhelms with volume.",
  },
};

export const ENEMY_NAMES = [
  "Iron Mike", "Sugar Ray", "The Hammer", "Lightning", "Stone Fist",
  "Red Glove", "The Bull", "Phantom", "Knockout Kid", "The Viper",
  "Bone Crusher", "Flash", "The Mauler", "Steel Jaw", "Cyclone",
];

export const COLOR_PRESETS = {
  gloves: ["#cc2222", "#1155cc", "#22aa22", "#ddaa00", "#aa22aa", "#ffffff", "#111111", "#ff6600"],
  gloveTape: ["#eeeeee", "#cccccc", "#222222", "#cc2222", "#1155cc", "#ddaa00"],
  trunks: ["#2244aa", "#222222", "#cc2222", "#22aa22", "#ddaa00", "#ffffff", "#aa22aa", "#ff6600"],
  shoes: ["#1a1a1a", "#2a1a1a", "#ffffff", "#cc2222", "#1155cc", "#222222"],
};

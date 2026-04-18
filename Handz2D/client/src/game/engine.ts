import {
  GameState, FighterState, PunchType, Archetype, DefenseState,
  PUNCH_CONFIGS, ARCHETYPE_STATS, ENEMY_NAMES, HitEffect, Vec2,
  FighterColors, DEFAULT_PLAYER_COLORS, DEFAULT_ENEMY_COLORS, StanceType, SKIN_COLOR_PRESETS,
  PunchPhaseType, RhythmPhase, PauseAction, PunchConfig,
  AIDifficulty, AI_KD_CHANCES, TimerSpeed, JudgeScore, RoundScore,
  RecordedEvent, RecordedRound, RoundRecordSummary, InputRecording,
  BehaviorProfile, RingZone, SequenceTracker, AdaptiveMemory, ObservedPattern,
} from "./types";
import { initAiBrain, updateAI as updateAIBrain, notifyAiHitLanded, notifyAiPunchWhiffed, notifyAiBlockContact, createAdaptiveMemory, reviewAdaptiveMemory, onRoundBoundaryAdaptive, notifyAiRangeDisrupt, notifyAiWhiffContext, notifyAiKnockedDown, notifyAiStunOrCrit } from "./ai";
import { soundEngine, type PunchSoundType } from "./sound";

let recordingAccumulator = 0;
const RECORD_MOVE_INTERVAL = 0.1;
let lastPlayerDefState: DefenseState = "none";
let lastEnemyDefState: DefenseState = "none";
let roundRecordingElapsed = 0;

function recordEvent(state: GameState, type: RecordedEvent["type"], actor: "player" | "enemy", data: Record<string, unknown>) {
  if (!state.recordInputs || !state.inputRecording) return;
  const round = state.inputRecording.rounds[state.inputRecording.rounds.length - 1];
  if (!round) return;
  const dx = state.enemy.x - state.player.x;
  const dz = state.enemy.z - state.player.z;
  const dist = Math.sqrt(dx * dx + dz * dz);
  const elapsed = roundRecordingElapsed * 1000;
  round.events.push({
    t: Math.round(elapsed * 10) / 10,
    type,
    actor,
    data,
    px: Math.round(state.player.x),
    pz: Math.round(state.player.z),
    ex: Math.round(state.enemy.x),
    ez: Math.round(state.enemy.z),
    dist: Math.round(dist),
    pStam: Math.round(state.player.stamina),
    eStam: Math.round(state.enemy.stamina),
  });
}

function initRoundRecording(state: GameState) {
  if (!state.recordInputs || !state.inputRecording) return;
  lastPlayerDefState = "none";
  lastEnemyDefState = "none";
  recordingAccumulator = 0;
  roundRecordingElapsed = 0;
  state.inputRecording.rounds.push({
    roundNumber: state.currentRound,
    startTime: 0,
    events: [],
    summary: createEmptyRoundSummary(),
  });
}

function createEmptyRoundSummary(): RoundRecordSummary {
  const punchInit = () => ({ thrown: 0, landed: 0, feinted: 0, charged: 0, body: 0 });
  return {
    playerPunches: { jab: punchInit(), cross: punchInit(), leftHook: punchInit(), rightHook: punchInit(), leftUppercut: punchInit(), rightUppercut: punchInit() },
    enemyPunches: { jab: punchInit(), cross: punchInit(), leftHook: punchInit(), rightHook: punchInit(), leftUppercut: punchInit(), rightUppercut: punchInit() },
    playerMovement: { totalDistance: 0, avgDistFromEnemy: 0, timeInRange: 0, timeOutRange: 0 },
    enemyMovement: { totalDistance: 0, avgDistFromEnemy: 0, timeInRange: 0, timeOutRange: 0 },
    playerDefense: { ducks: 0, duckTime: 0, fullGuards: 0, blocksLanded: 0, dodges: 0 },
    enemyDefense: { ducks: 0, duckTime: 0, fullGuards: 0, blocksLanded: 0, dodges: 0 },
    knockdowns: { player: 0, enemy: 0 },
    duration: 0,
  };
}

function finalizeRoundRecording(state: GameState) {
  if (!state.recordInputs || !state.inputRecording) return;
  const round = state.inputRecording.rounds[state.inputRecording.rounds.length - 1];
  if (!round) return;
  round.summary.duration = state.roundDuration - state.roundTimer;
  const punchEvents = round.events.filter(e => e.type === "punch");
  for (const e of punchEvents) {
    const punchName = e.data.punch as string;
    const bucket = e.actor === "player" ? round.summary.playerPunches : round.summary.enemyPunches;
    if (bucket[punchName]) {
      bucket[punchName].thrown++;
      if (e.data.feint) bucket[punchName].feinted++;
      if (e.data.charged) bucket[punchName].charged++;
      if (e.data.body) bucket[punchName].body++;
    }
  }
  const hitEvents = round.events.filter(e => e.type === "hit");
  for (const e of hitEvents) {
    const punchName = e.data.punch as string;
    const bucket = e.actor === "player" ? round.summary.playerPunches : round.summary.enemyPunches;
    if (bucket[punchName]) bucket[punchName].landed++;
  }
  const blockEvents = round.events.filter(e => e.type === "block");
  for (const e of blockEvents) {
    const defBucket = e.actor === "player" ? round.summary.playerDefense : round.summary.enemyDefense;
    defBucket.blocksLanded++;
  }
  const dodgeEvents = round.events.filter(e => e.type === "dodge");
  for (const e of dodgeEvents) {
    const defBucket = e.actor === "player" ? round.summary.playerDefense : round.summary.enemyDefense;
    defBucket.dodges++;
  }
  const kdEvents = round.events.filter(e => e.type === "knockdown");
  for (const e of kdEvents) {
    if (e.actor === "player") round.summary.knockdowns.enemy++;
    else round.summary.knockdowns.player++;
  }
  const defEvents = round.events.filter(e => e.type === "defense");
  for (const e of defEvents) {
    const defBucket = e.actor === "player" ? round.summary.playerDefense : round.summary.enemyDefense;
    const ds = e.data.state as string;
    if (ds === "duck") defBucket.ducks++;
    else if (ds === "fullGuard") defBucket.fullGuards++;
  }
  let pDist = 0, eDist = 0, distSamples = 0, pInRange = 0, pOutRange = 0;
  const moveEvents = round.events.filter(e => e.type === "move");
  let lastPx = 0, lastPz = 0, lastEx = 0, lastEz = 0;
  for (let i = 0; i < moveEvents.length; i++) {
    const m = moveEvents[i];
    if (i > 0) {
      pDist += Math.sqrt((m.px - lastPx) ** 2 + (m.pz - lastPz) ** 2);
      eDist += Math.sqrt((m.ex - lastEx) ** 2 + (m.ez - lastEz) ** 2);
    }
    distSamples++;
    if (m.dist <= 80) pInRange += RECORD_MOVE_INTERVAL;
    else pOutRange += RECORD_MOVE_INTERVAL;
    lastPx = m.px; lastPz = m.pz; lastEx = m.ex; lastEz = m.ez;
  }
  round.summary.playerMovement.totalDistance = Math.round(pDist);
  round.summary.enemyMovement.totalDistance = Math.round(eDist);
  round.summary.playerMovement.avgDistFromEnemy = distSamples > 0 ? Math.round(moveEvents.reduce((s, m) => s + m.dist, 0) / distSamples) : 0;
  round.summary.enemyMovement.avgDistFromEnemy = round.summary.playerMovement.avgDistFromEnemy;
  round.summary.playerMovement.timeInRange = Math.round(pInRange * 10) / 10;
  round.summary.playerMovement.timeOutRange = Math.round(pOutRange * 10) / 10;
  round.summary.enemyMovement.timeInRange = round.summary.playerMovement.timeInRange;
  round.summary.enemyMovement.timeOutRange = round.summary.playerMovement.timeOutRange;
}

export function formatRecordingForExport(recording: InputRecording): string {
  const lines: string[] = [];
  const s = recording.fightSettings;
  const matchType = s.cpuVsCpu ? "CPU vs CPU" : "Player vs CPU";
  const mode = s.practiceMode ? "Practice" : "Normal";
  lines.push("=== HANDZ INPUT RECORDING ===");
  lines.push(`Date: ${new Date().toISOString()}`);
  lines.push(`Match Type: ${matchType} | Mode: ${mode}`);
  lines.push("");
  lines.push("--- FIGHT SETTINGS ---");
  lines.push(`${s.playerName} (${s.playerArchetype}) vs ${s.enemyName} (${s.enemyArchetype})`);
  lines.push(`Player Level: ${s.playerLevel} | Enemy Level: ${s.enemyLevel}`);
  lines.push(`AI Difficulty: ${s.aiDifficulty}`);
  lines.push(`Round Duration: ${s.roundDuration}s | Timer Speed: ${s.timerSpeed} | Total Rounds: ${s.totalRounds}`);
  lines.push(`Player Arm: ${s.playerArmLength}" | Enemy Arm: ${s.enemyArmLength}"`);
  lines.push("");

  for (const round of recording.rounds) {
    lines.push(`=== ROUND ${round.roundNumber} === (${round.summary.duration.toFixed(1)}s)`);
    lines.push("");
    lines.push("--- PUNCH SUMMARY ---");
    lines.push("PLAYER:");
    for (const [name, p] of Object.entries(round.summary.playerPunches)) {
      if (p.thrown > 0) {
        lines.push(`  ${name}: ${p.thrown} thrown, ${p.landed} landed (${p.thrown > 0 ? Math.round(p.landed / p.thrown * 100) : 0}%)${p.feinted ? ` ${p.feinted} feints` : ""}${p.charged ? ` ${p.charged} charged` : ""}${p.body ? ` ${p.body} body` : ""}`);
      }
    }
    lines.push("ENEMY:");
    for (const [name, p] of Object.entries(round.summary.enemyPunches)) {
      if (p.thrown > 0) {
        lines.push(`  ${name}: ${p.thrown} thrown, ${p.landed} landed (${p.thrown > 0 ? Math.round(p.landed / p.thrown * 100) : 0}%)${p.feinted ? ` ${p.feinted} feints` : ""}${p.charged ? ` ${p.charged} charged` : ""}${p.body ? ` ${p.body} body` : ""}`);
      }
    }
    lines.push("");
    lines.push("--- MOVEMENT ---");
    lines.push(`Player distance traveled: ${round.summary.playerMovement.totalDistance}px | Avg dist from enemy: ${round.summary.playerMovement.avgDistFromEnemy}px`);
    lines.push(`Time in range: ${round.summary.playerMovement.timeInRange}s | Out of range: ${round.summary.playerMovement.timeOutRange}s`);
    lines.push("");
    lines.push("--- DEFENSE ---");
    const pd = round.summary.playerDefense;
    lines.push(`Player: ${pd.ducks} ducks, ${pd.fullGuards} full guards, ${pd.blocksLanded} blocks hit, ${pd.dodges} dodges`);
    const ed = round.summary.enemyDefense;
    lines.push(`Enemy: ${ed.ducks} ducks, ${ed.fullGuards} full guards, ${ed.blocksLanded} blocks hit, ${ed.dodges} dodges`);
    lines.push("");
    lines.push("--- KNOCKDOWNS ---");
    lines.push(`Player scored: ${round.summary.knockdowns.enemy} | Enemy scored: ${round.summary.knockdowns.player}`);
    lines.push("");

    lines.push("--- EVENT LOG ---");
    lines.push("Time(ms) | Actor  | Event      | Details                                  | Positions (P/E) | Dist | Stam(P/E)");
    lines.push("-".repeat(120));
    for (const e of round.events) {
      const details = Object.entries(e.data).map(([k, v]) => `${k}=${v}`).join(" ");
      const time = String(Math.round(e.t)).padStart(8);
      const actor = e.actor.padEnd(6);
      const type = e.type.padEnd(10);
      const pos = `(${e.px},${e.pz})/(${e.ex},${e.ez})`;
      lines.push(`${time} | ${actor} | ${type} | ${details.padEnd(40).slice(0, 40)} | ${pos.padEnd(15)} | ${String(e.dist).padStart(4)} | ${e.pStam}/${e.eStam}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function formatRoundRecordingForExport(recording: InputRecording, roundNumber: number): string {
  const round = recording.rounds.find(r => r.roundNumber === roundNumber);
  if (!round) return "";
  const lines: string[] = [];
  const s = recording.fightSettings;
  const matchType = s.cpuVsCpu ? "CPU vs CPU" : "Player vs CPU";
  const mode = s.practiceMode ? "Practice" : "Normal";
  lines.push("=== HANDZ INPUT RECORDING (SINGLE ROUND) ===");
  lines.push(`Date: ${new Date().toISOString()}`);
  lines.push(`Match Type: ${matchType} | Mode: ${mode}`);
  lines.push("");
  lines.push("--- FIGHT SETTINGS ---");
  lines.push(`${s.playerName} (${s.playerArchetype}) vs ${s.enemyName} (${s.enemyArchetype})`);
  lines.push(`Player Level: ${s.playerLevel} | Enemy Level: ${s.enemyLevel}`);
  lines.push(`AI Difficulty: ${s.aiDifficulty}`);
  lines.push(`Round Duration: ${s.roundDuration}s | Timer Speed: ${s.timerSpeed} | Total Rounds: ${s.totalRounds}`);
  lines.push(`Player Arm: ${s.playerArmLength}" | Enemy Arm: ${s.enemyArmLength}"`);
  lines.push("");

  lines.push(`=== ROUND ${round.roundNumber} === (${round.summary.duration.toFixed(1)}s)`);
  lines.push("");
  lines.push("--- PUNCH SUMMARY ---");
  lines.push("PLAYER:");
  for (const [name, p] of Object.entries(round.summary.playerPunches)) {
    if (p.thrown > 0) {
      lines.push(`  ${name}: ${p.thrown} thrown, ${p.landed} landed (${p.thrown > 0 ? Math.round(p.landed / p.thrown * 100) : 0}%)${p.feinted ? ` ${p.feinted} feints` : ""}${p.charged ? ` ${p.charged} charged` : ""}${p.body ? ` ${p.body} body` : ""}`);
    }
  }
  lines.push("ENEMY:");
  for (const [name, p] of Object.entries(round.summary.enemyPunches)) {
    if (p.thrown > 0) {
      lines.push(`  ${name}: ${p.thrown} thrown, ${p.landed} landed (${p.thrown > 0 ? Math.round(p.landed / p.thrown * 100) : 0}%)${p.feinted ? ` ${p.feinted} feints` : ""}${p.charged ? ` ${p.charged} charged` : ""}${p.body ? ` ${p.body} body` : ""}`);
    }
  }
  lines.push("");
  lines.push("--- MOVEMENT ---");
  lines.push(`Player distance traveled: ${round.summary.playerMovement.totalDistance}px | Avg dist from enemy: ${round.summary.playerMovement.avgDistFromEnemy}px`);
  lines.push(`Time in range: ${round.summary.playerMovement.timeInRange}s | Out of range: ${round.summary.playerMovement.timeOutRange}s`);
  lines.push("");
  lines.push("--- DEFENSE ---");
  const pd = round.summary.playerDefense;
  lines.push(`Player: ${pd.ducks} ducks, ${pd.fullGuards} full guards, ${pd.blocksLanded} blocks hit, ${pd.dodges} dodges`);
  const ed = round.summary.enemyDefense;
  lines.push(`Enemy: ${ed.ducks} ducks, ${ed.fullGuards} full guards, ${ed.blocksLanded} blocks hit, ${ed.dodges} dodges`);
  lines.push("");
  lines.push("--- KNOCKDOWNS ---");
  lines.push(`Player scored: ${round.summary.knockdowns.enemy} | Enemy scored: ${round.summary.knockdowns.player}`);
  lines.push("");
  lines.push("--- EVENT LOG ---");
  lines.push("Time(ms) | Actor  | Event      | Details                                  | Positions (P/E) | Dist | Stam(P/E)");
  lines.push("-".repeat(120));
  for (const e of round.events) {
    const details = Object.entries(e.data).map(([k, v]) => `${k}=${v}`).join(" ");
    const time = String(Math.round(e.t)).padStart(8);
    const actor = e.actor.padEnd(6);
    const type = e.type.padEnd(10);
    const pos = `(${e.px},${e.pz})/(${e.ex},${e.ez})`;
    lines.push(`${time} | ${actor} | ${type} | ${details.padEnd(40).slice(0, 40)} | ${pos.padEnd(15)} | ${String(e.dist).padStart(4)} | ${e.pStam}/${e.eStam}`);
  }
  lines.push("");
  return lines.join("\n");
}

class TimeBasedRNG {
  private rand: () => number;
  private seed: number;
  private cachedValue: number;
  private lastUpdateTime: number;
  private cacheInterval: number;

  constructor(seed: number = 12345, cacheInterval: number = 0.2) {
    this.seed = seed;
    this.cacheInterval = cacheInterval;
    this.lastUpdateTime = -999;
    this.rand = this.createSeededRandom(seed);
    this.cachedValue = this.rand();
  }

  private createSeededRandom(seed: number): () => number {
    let s = seed;
    return () => {
      s = (s * 1664525 + 1013904223) & 0xFFFFFFFF;
      return (s >>> 0) / 0xFFFFFFFF;
    };
  }

  reseed(newSeed: number): void {
    this.seed = newSeed;
    this.rand = this.createSeededRandom(newSeed);
    this.lastUpdateTime = -999;
    this.cachedValue = this.rand();
  }

  next01(): number {
    const now = performance.now() / 1000;
    if (now - this.lastUpdateTime > this.cacheInterval) {
      this.cachedValue = this.rand();
      this.lastUpdateTime = now;
    }
    return this.cachedValue;
  }

  range(min: number, max: number): number {
    const t = this.rand();
    return min + (max - min) * t;
  }

  chance(probability: number): boolean {
    const t = this.rand();
    return t <= Math.max(0, Math.min(1, probability));
  }
}

export const aiRNG = new TimeBasedRNG(Date.now());

const LAUNCH_DELAY_MULT = 0.033;
const ARM_SPEED_MULT = 7.5;
const LINGER_MULT = 0.133;
const RETRACTION_MULT = 0.133;
const PUNCH_ANGLE_NORMAL = -13;
const PUNCH_ANGLE_DUCK_BODY = 2;

function getEffectivePunchConfig(punchType: PunchType): PunchConfig {
  return PUNCH_CONFIGS[punchType];
}

const CANVAS_W = 800;
const CANVAS_H = 600;
const RING_CX = CANVAS_W / 2;
const RING_CY = 260;
const RING_HALF_W = 280;
const RING_HALF_H = 180;
const RING_LEFT = RING_CX - RING_HALF_W;
const RING_RIGHT = RING_CX + RING_HALF_W;
const RING_TOP = RING_CY - RING_HALF_H;
const RING_BOTTOM = RING_CY + RING_HALF_H;
const ROUND_DURATION = 180;
const BASE_STAMINA = 250;
const BASE_REGEN = 6;
const BASE_MOVE_SPEED = 138;
const KNOCKDOWN_DURATION = 4;
const COUNTDOWN_DURATION = 3;
const MIN_DISTANCE = 30;
const CHARGE_TIME = 0.5;
const CHARGE_DAMAGE_MIN = 4;
const CHARGE_DAMAGE_MAX = 9.6;
const CHARGE_STAMINA_COST_MULT = 3;
const CHARGE_CONSECUTIVE_EXTRA_COST = 0.5;
const CHARGE_CONSECUTIVE_WINDOW = 3;
const CHARGE_SELF_REGEN_PAUSE = 0.3;
const CHARGE_WHIFF_RETRACT_SLOW = 0.25;
const CHARGE_GUARDDOWN_SPEED_BONUS = 1.2;
const NO_GUARD_CRIT_MULT = 3;
const HEAD_CRIT_CHANCE = 0.03;
const BODY_CRIT_CHANCE = 0.08;
const CRIT_DAMAGE_MULT = 4.2;
const CRIT_REGEN_PAUSE = 0.5;
const CRIT_MOVE_SLOW_MULT = 0.5;
const CRIT_MOVE_SLOW_DURATION = 2;
const BASE_STUN_CHANCE = 0.01;
const STUN_MOVE_SLOW_MULT = 0.70;
const STUN_MOVE_SLOW_DURATION = 3;
const STUN_BLOCK_DISABLE_DURATION = 1;
const STUN_REGEN_DISABLE_DURATION = 2.5;
const STUN_BLOCK_WEAKEN_DURATION = 4;
const STUN_BLOCK_WEAKEN_MULT = 0.5;
const STUN_PUNCH_SLOW_MULT = 0.75;
const STUN_PUNCH_SLOW_DURATION = 3;
const STUN_PUNCH_DISABLE_DURATION = 2;


function isInsideDiamond(px: number, pz: number, margin: number = 0): boolean {
  const dx = Math.abs(px - RING_CX) / (RING_HALF_W - margin);
  const dz = Math.abs(pz - RING_CY) / (RING_HALF_H - margin);
  return dx + dz <= 1;
}

function clampToDiamond(fighter: { x: number; z: number }, margin: number = 20): void {
  const hw = RING_HALF_W - margin;
  const hh = RING_HALF_H - margin;
  const dx = (fighter.x - RING_CX) / hw;
  const dz = (fighter.z - RING_CY) / hh;
  const dist = Math.abs(dx) + Math.abs(dz);
  if (dist > 1) {
    fighter.x = RING_CX + (dx / dist) * hw;
    fighter.z = RING_CY + (dz / dist) * hh;
  }
}

function hexToHSL(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h * 360, s, l];
}

function hslToHex(h: number, s: number, l: number): string {
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1/6) return p + (q - p) * 6 * t;
    if (t < 1/2) return q;
    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const r = Math.round(hue2rgb(p, q, h / 360) * 255);
  const g = Math.round(hue2rgb(p, q, (h / 360) + 1/3) * 255);
  const b = Math.round(hue2rgb(p, q, (h / 360) - 1/3) * 255);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

let nextRingCanvasColor = "#BDEDF2";

function rollNextRingCanvasColor(): void {
  const roll = Math.random();
  if (roll < 0.85) nextRingCanvasColor = "#BDEDF2";
  else if (roll < 0.95) nextRingCanvasColor = "#F5F5F5";
  else if (roll < 0.98) nextRingCanvasColor = "#FFFFFF";
  else if (roll < 0.99) nextRingCanvasColor = "#FFABAB";
  else nextRingCanvasColor = "#EBD7AB";
}

export function getTelegraphMult(): number {
  try {
    const raw = localStorage.getItem("handz_telegraph_mult");
    if (raw) return Math.max(0.1, Math.min(3.0, parseFloat(raw)));
  } catch {}
  return 1.0;
}

export function setTelegraphMult(val: number): void {
  const clamped = Math.max(0.1, Math.min(3.0, val));
  localStorage.setItem("handz_telegraph_mult", clamped.toString());
}

export function getAdaptiveAiEnabled(): boolean {
  return true;
}

export function setAdaptiveAiEnabled(_val: boolean): void {
}

function getRingZone(x: number, z: number, state: GameState): RingZone {
  const cx = (state.ringLeft + state.ringRight) / 2;
  const cz = (state.ringTop + state.ringBottom) / 2;
  const hw = (state.ringRight - state.ringLeft) / 2;
  const hz = (state.ringBottom - state.ringTop) / 2;
  const nx = hw > 1 ? (x - cx) / hw : 0;
  const nz = hz > 1 ? (z - cz) / hz : 0;
  const edgeThresh = 0.65;
  const cornerThresh = 0.55;
  if (Math.abs(nx) > cornerThresh && Math.abs(nz) > cornerThresh) {
    if (nx > 0 && nz < 0) return "cornerNE";
    if (nx < 0 && nz < 0) return "cornerNW";
    if (nx > 0 && nz > 0) return "cornerSE";
    return "cornerSW";
  }
  if (nx > edgeThresh) return "ropeE";
  if (nx < -edgeThresh) return "ropeW";
  if (nz < -edgeThresh) return "ropeN";
  if (nz > edgeThresh) return "ropeS";
  return "center";
}

function createBehaviorProfile(state: GameState): BehaviorProfile {
  return {
    activeSequences: [],
    recentPlayerMoveX: [],
    recentPlayerMoveZ: [],
    recentPlayerPunchTimes: [],
    playerLastPunchTime: 0,
    playerLastDuckTime: 0,
    playerLastBlockTime: 0,
    playerLastDodgeTime: 0,
    playerLastRetreatTime: 0,
    playerWasMovingForward: false,
    playerWasMovingBackward: false,
    playerWasMovingLateral: false,
    playerPrevX: state.player.x,
    playerPrevZ: state.player.z,
    playerPrevStamina: state.player.stamina,
    aiPrevStamina: state.enemy.stamina,
    exchangeStartTime: 0,
    exchangeActive: false,
    exchangePlayerDmgStart: 0,
    exchangeAiDmgStart: 0,
    exchangePlayerStamStart: 0,
    exchangeAiStamStart: 0,
    exchangeZone: "center",
    exchangeComboKeys: [],
    lastExchangeEnd: 0,
    ringCutTimer: 0,
    ringCutStartStamina: state.player.stamina,
    ringCutStartAiStamina: state.enemy.stamina,
    ringCutStartDmg: 0,
    ringCutStartAiDmg: 0,
    ringCutZone: "center",
    cornerPressureTimer: 0,
    cornerPressureStartStamina: state.player.stamina,
    cornerPressureStartAiStamina: state.enemy.stamina,
    cornerPressureStartDmg: 0,
    cornerPressureStartAiDmg: 0,
    ropeEscapeTimer: 0,
    ropeEscapeStartStamina: state.player.stamina,
    ropeEscapeStartAiStamina: state.enemy.stamina,
    ropeEscapeStartDmg: 0,
    ropeEscapeStartAiDmg: 0,
    centerControlTimer: 0,
    centerControlStartStamina: state.player.stamina,
    centerControlStartAiStamina: state.enemy.stamina,
    centerControlStartDmg: 0,
    centerControlStartAiDmg: 0,
    lastMacroCheckTime: 0,
    playerLastPunchEndTime: 0,
    postPunchRetreatDetected: false,
    swayFireTimer: 0,
  };
}

function updateBehaviorProfile(state: GameState, dt: number): void {
  const bp = state.behaviorProfile;
  if (!bp) return;
  const player = state.player;
  const enemy = state.enemy;
  const t = state.fightElapsedTime;
  const zone = getRingZone(player.x, player.z, state);
  const enemyZone = getRingZone(enemy.x, enemy.z, state);
  const pStamFrac = player.maxStamina > 0 ? player.stamina / player.maxStamina : 1;
  const aStamFrac = enemy.maxStamina > 0 ? enemy.stamina / enemy.maxStamina : 1;

  const dx = player.x - bp.playerPrevX;
  const dz = player.z - bp.playerPrevZ;
  const toEnemyX = enemy.x - player.x;
  const toEnemyZ = enemy.z - player.z;
  const distToEnemy = Math.sqrt(toEnemyX * toEnemyX + toEnemyZ * toEnemyZ);
  const movingForward = distToEnemy > 1 && (dx * toEnemyX > 0);
  const movingBackward = distToEnemy > 1 && (dx * toEnemyX < 0);
  const movingLateral = Math.abs(dz) > Math.abs(dx) * 0.5 && Math.abs(dz) > 0.5;

  bp.playerWasMovingForward = movingForward;
  bp.playerWasMovingBackward = movingBackward;
  bp.playerWasMovingLateral = movingLateral;

  bp.recentPlayerMoveX.push(dx);
  bp.recentPlayerMoveZ.push(dz);
  if (bp.recentPlayerMoveX.length > 60) { bp.recentPlayerMoveX.shift(); bp.recentPlayerMoveZ.shift(); }

  if (!player.isPunching && bp.playerLastPunchTime > 0 && t - bp.playerLastPunchTime > 0.05) {
    bp.playerLastPunchEndTime = t;
  }
  if (bp.playerLastPunchEndTime > 0 && movingBackward && t - bp.playerLastPunchEndTime < 0.4 && !bp.postPunchRetreatDetected) {
    bp.postPunchRetreatDetected = true;
    startSequence(bp, "postPunchRetreat", t, player, enemy, zone);
  }
  if (player.isPunching) bp.postPunchRetreatDetected = false;

  if (movingLateral && !player.isPunching && player.defenseState === "none") {
    bp.swayFireTimer += dt;
  } else {
    bp.swayFireTimer = 0;
  }
  if (bp.swayFireTimer > 0.15 && player.isPunching && player.punchPhase === "launchDelay") {
    startSequence(bp, "swayFire", t, player, enemy, zone);
    bp.swayFireTimer = 0;
  }

  if (player.isPunching && player.punchPhase === "contact") {
    const punchTime = t;
    if (punchTime - bp.playerLastPunchTime > 0.05) {
      bp.recentPlayerPunchTimes.push(punchTime);
      if (bp.recentPlayerPunchTimes.length > 30) bp.recentPlayerPunchTimes.shift();

      const punchKey = player.currentPunch || "jab";

      if (bp.playerWasMovingForward && t - bp.playerLastPunchTime < 0.3 && punchKey === "jab") {
        startSequence(bp, "jabStep", t, player, enemy, zone);
      }
      if (bp.playerWasMovingBackward && t - bp.playerLastRetreatTime < 0.4) {
        startSequence(bp, "backstepCounter", t, player, enemy, zone);
      }
      if (bp.playerWasMovingLateral && t - bp.playerLastPunchTime < 0.3) {
        startSequence(bp, "pivotPunch", t, player, enemy, zone);
      }
      if (player.defenseState === "duck" && t - bp.playerLastDuckTime < 0.5) {
        startSequence(bp, "duckCounter", t, player, enemy, zone);
      }
      if (t - bp.playerLastBlockTime < 0.5) {
        startSequence(bp, "blockCounter", t, player, enemy, zone);
      }
      if (t - bp.playerLastDodgeTime < 0.5) {
        startSequence(bp, "dodgeCounter", t, player, enemy, zone);
      }

      if (!bp.exchangeActive && t - bp.lastExchangeEnd > 0.3) {
        bp.exchangeActive = true;
        bp.exchangeStartTime = t;
        bp.exchangePlayerDmgStart = player.damageDealt;
        bp.exchangeAiDmgStart = enemy.damageDealt;
        bp.exchangePlayerStamStart = player.stamina;
        bp.exchangeAiStamStart = enemy.stamina;
        bp.exchangeZone = zone;
        bp.exchangeComboKeys = [punchKey];
      } else if (bp.exchangeActive) {
        bp.exchangeComboKeys.push(punchKey);
        if (bp.exchangeComboKeys.length > 10) bp.exchangeComboKeys = bp.exchangeComboKeys.slice(-10);
      }

      bp.playerLastPunchTime = punchTime;
    }
  }

  if (player.defenseState === "duck" && bp.playerLastDuckTime < t - 0.05) {
    bp.playerLastDuckTime = t;
  }
  if (player.defenseState === "fullGuard") {
    bp.playerLastBlockTime = t;
  }
  if (movingBackward) {
    bp.playerLastRetreatTime = t;
  }

  const isCorner = (z: RingZone) => z.startsWith("corner");
  const isRope = (z: RingZone) => z.startsWith("rope");

  const playerCuttingRing = movingForward && movingLateral && (isRope(enemyZone) || isCorner(enemyZone));
  if (playerCuttingRing) {
    if (bp.ringCutTimer === 0) {
      bp.ringCutStartStamina = player.stamina;
      bp.ringCutStartAiStamina = enemy.stamina;
      bp.ringCutStartDmg = player.damageDealt;
      bp.ringCutStartAiDmg = enemy.damageDealt;
      bp.ringCutZone = zone;
    }
    bp.ringCutTimer += dt;
  } else if (bp.ringCutTimer > 0) {
    if (bp.ringCutTimer >= 1.0) {
      emitMacroObservation(state, bp, "ringCutting", bp.ringCutZone, bp.ringCutStartStamina, bp.ringCutStartAiStamina, bp.ringCutStartDmg, bp.ringCutStartAiDmg, t, pStamFrac, aStamFrac);
    }
    bp.ringCutTimer = 0;
  }

  const enemyInCorner = isCorner(enemyZone);
  const playerPressing = distToEnemy < 120 && (player.isPunching || movingForward);
  if (enemyInCorner && playerPressing) {
    if (bp.cornerPressureTimer === 0) {
      bp.cornerPressureStartStamina = player.stamina;
      bp.cornerPressureStartAiStamina = enemy.stamina;
      bp.cornerPressureStartDmg = player.damageDealt;
      bp.cornerPressureStartAiDmg = enemy.damageDealt;
    }
    bp.cornerPressureTimer += dt;
  } else if (bp.cornerPressureTimer > 0) {
    if (bp.cornerPressureTimer >= 1.0) {
      emitMacroObservation(state, bp, "cornerPressure", enemyZone, bp.cornerPressureStartStamina, bp.cornerPressureStartAiStamina, bp.cornerPressureStartDmg, bp.cornerPressureStartAiDmg, t, pStamFrac, aStamFrac);
    }
    bp.cornerPressureTimer = 0;
  }

  const playerOnRope = isRope(zone) || isCorner(zone);
  const playerEscaping = playerOnRope && (movingLateral || movingBackward) && !player.isPunching;
  if (playerEscaping) {
    if (bp.ropeEscapeTimer === 0) {
      bp.ropeEscapeStartStamina = player.stamina;
      bp.ropeEscapeStartAiStamina = enemy.stamina;
      bp.ropeEscapeStartDmg = player.damageDealt;
      bp.ropeEscapeStartAiDmg = enemy.damageDealt;
    }
    bp.ropeEscapeTimer += dt;
  } else if (bp.ropeEscapeTimer > 0) {
    if (bp.ropeEscapeTimer >= 0.5 && zone === "center") {
      emitMacroObservation(state, bp, "ropeEscape", zone, bp.ropeEscapeStartStamina, bp.ropeEscapeStartAiStamina, bp.ropeEscapeStartDmg, bp.ropeEscapeStartAiDmg, t, pStamFrac, aStamFrac);
    }
    bp.ropeEscapeTimer = 0;
  }

  if (zone === "center" && player.isPunching) {
    if (bp.centerControlTimer === 0) {
      bp.centerControlStartStamina = player.stamina;
      bp.centerControlStartAiStamina = enemy.stamina;
      bp.centerControlStartDmg = player.damageDealt;
      bp.centerControlStartAiDmg = enemy.damageDealt;
    }
    bp.centerControlTimer += dt;
  } else if (bp.centerControlTimer > 0) {
    if (bp.centerControlTimer >= 1.5) {
      emitMacroObservation(state, bp, "centerControl", "center", bp.centerControlStartStamina, bp.centerControlStartAiStamina, bp.centerControlStartDmg, bp.centerControlStartAiDmg, t, pStamFrac, aStamFrac);
    }
    bp.centerControlTimer = 0;
  }

  if (bp.exchangeActive) {
    if (t - bp.playerLastPunchTime > 1.0 && t - bp.exchangeStartTime > 0.3) {
      const playerDmgDelta = player.damageDealt - bp.exchangePlayerDmgStart;
      const aiDmgDelta = enemy.damageDealt - bp.exchangeAiDmgStart;
      const playerStamLoss = bp.exchangePlayerStamStart - player.stamina;
      const aiStamLoss = bp.exchangeAiStamStart - enemy.stamina;
      const aiHurtMore = aiStamLoss > playerStamLoss || playerDmgDelta > aiDmgDelta;

      if (aiHurtMore && state.aiBrain?.adaptiveMemory) {
        const comboSeq = bp.exchangeComboKeys.length > 0 ? bp.exchangeComboKeys.join(">") : null;
        const comboLen = bp.exchangeComboKeys.length;
        const comboConfBoost = comboLen >= 3 ? 0.4 : comboLen >= 2 ? 0.2 : 0;
        const baseConf = 1.0 + comboConfBoost;
        addObservation(state.aiBrain.adaptiveMemory, {
          kind: "exchange",
          zone: bp.exchangeZone,
          round: state.currentRound,
          fightTime: t,
          playerStaminaDelta: playerStamLoss,
          aiStaminaDelta: aiStamLoss,
          damageToAi: playerDmgDelta,
          damageToPlayer: aiDmgDelta,
          comboSequence: comboSeq,
          confidence: baseConf,
          count: 1,
          playerStaminaFrac: pStamFrac,
          aiStaminaFrac: aStamFrac,
        });
        if (comboSeq && comboLen >= 2) {
          addObservation(state.aiBrain.adaptiveMemory, {
            kind: "combo:" + comboSeq,
            zone: bp.exchangeZone,
            round: state.currentRound,
            fightTime: t,
            playerStaminaDelta: playerStamLoss,
            aiStaminaDelta: aiStamLoss,
            damageToAi: playerDmgDelta,
            damageToPlayer: aiDmgDelta,
            comboSequence: comboSeq,
            confidence: baseConf + 0.3,
            count: 1,
            playerStaminaFrac: pStamFrac,
            aiStaminaFrac: aStamFrac,
          });
        }
      }
      bp.exchangeActive = false;
      bp.lastExchangeEnd = t;
    }
  }

  for (let i = bp.activeSequences.length - 1; i >= 0; i--) {
    const seq = bp.activeSequences[i];
    if (t - seq.startTime > 1.0) {
      const playerStamLoss = seq.startPlayerStamina - player.stamina;
      const aiStamLoss = seq.startAiStamina - enemy.stamina;
      const playerDmg = player.damageDealt - seq.startPlayerDamageDealt;
      const aiDmg = enemy.damageDealt - seq.startAiDamageDealt;
      const aiHurtMore = aiStamLoss > playerStamLoss || playerDmg > aiDmg;

      if (aiHurtMore && state.aiBrain?.adaptiveMemory) {
        addObservation(state.aiBrain.adaptiveMemory, {
          kind: seq.kind,
          zone: seq.zone,
          round: state.currentRound,
          fightTime: t,
          playerStaminaDelta: playerStamLoss,
          aiStaminaDelta: aiStamLoss,
          damageToAi: playerDmg,
          damageToPlayer: aiDmg,
          comboSequence: seq.comboKeys.length > 0 ? seq.comboKeys.join(">") : null,
          confidence: 1,
          count: 1,
          playerStaminaFrac: pStamFrac,
          aiStaminaFrac: aStamFrac,
        });
      }
      bp.activeSequences.splice(i, 1);
    }
  }

  bp.playerPrevX = player.x;
  bp.playerPrevZ = player.z;
  bp.playerPrevStamina = player.stamina;
  bp.aiPrevStamina = enemy.stamina;
}

function emitMacroObservation(
  state: GameState, bp: BehaviorProfile, kind: string, zone: RingZone,
  startStam: number, startAiStam: number, startDmg: number, startAiDmg: number,
  t: number, pStamFrac: number, aStamFrac: number
): void {
  const player = state.player;
  const enemy = state.enemy;
  const playerStamLoss = startStam - player.stamina;
  const aiStamLoss = startAiStam - enemy.stamina;
  const playerDmg = player.damageDealt - startDmg;
  const aiDmg = enemy.damageDealt - startAiDmg;
  const aiHurtMore = aiStamLoss > playerStamLoss || playerDmg > aiDmg;
  if (aiHurtMore && state.aiBrain?.adaptiveMemory) {
    addObservation(state.aiBrain.adaptiveMemory, {
      kind, zone,
      round: state.currentRound,
      fightTime: t,
      playerStaminaDelta: playerStamLoss,
      aiStaminaDelta: aiStamLoss,
      damageToAi: playerDmg,
      damageToPlayer: aiDmg,
      comboSequence: null,
      confidence: 1.2,
      count: 1,
      playerStaminaFrac: pStamFrac,
      aiStaminaFrac: aStamFrac,
    });
  }
}

function startSequence(bp: BehaviorProfile, kind: string, t: number, player: FighterState, enemy: FighterState, zone: RingZone): void {
  if (bp.activeSequences.some(s => s.kind === kind && t - s.startTime < 0.5)) return;
  if (bp.activeSequences.length >= 8) bp.activeSequences.shift();
  bp.activeSequences.push({
    kind,
    startTime: t,
    startPlayerStamina: player.stamina,
    startAiStamina: enemy.stamina,
    startPlayerDamageDealt: player.damageDealt,
    startAiDamageDealt: enemy.damageDealt,
    phase: 0,
    zone,
    comboKeys: player.currentPunch ? [player.currentPunch] : [],
  });
}

function addObservation(mem: AdaptiveMemory, obs: ObservedPattern): void {
  const existing = mem.observations.find(o => o.kind === obs.kind && o.zone === obs.zone);
  const comboBoost = obs.comboSequence ? 0.1 : 0;
  if (existing) {
    existing.count++;
    existing.confidence = Math.min(existing.confidence + 0.15 + comboBoost, 5.0);
    existing.aiStaminaDelta = existing.aiStaminaDelta * 0.7 + obs.aiStaminaDelta * 0.3;
    existing.playerStaminaDelta = existing.playerStaminaDelta * 0.7 + obs.playerStaminaDelta * 0.3;
    existing.damageToAi = existing.damageToAi * 0.7 + obs.damageToAi * 0.3;
    existing.damageToPlayer = existing.damageToPlayer * 0.7 + obs.damageToPlayer * 0.3;
    existing.playerStaminaFrac = existing.playerStaminaFrac * 0.7 + obs.playerStaminaFrac * 0.3;
    existing.aiStaminaFrac = existing.aiStaminaFrac * 0.7 + obs.aiStaminaFrac * 0.3;
    if (obs.comboSequence) existing.comboSequence = obs.comboSequence;
    existing.fightTime = obs.fightTime;
    existing.round = obs.round;
  } else {
    if (mem.observations.length >= 50) {
      let minIdx = 0;
      let minConf = mem.observations[0].confidence;
      for (let i = 1; i < mem.observations.length; i++) {
        if (mem.observations[i].confidence < minConf) { minConf = mem.observations[i].confidence; minIdx = i; }
      }
      mem.observations.splice(minIdx, 1);
    }
    mem.observations.push({ ...obs });
  }
}

function levelScale(level: number, min: number, max: number): number {
  const t = Math.max(0, Math.min(1, (level - 1) / 99));
  return min + (max - min) * t;
}

function createFighter(
  name: string, archetype: Archetype, level: number, x: number, z: number, facing: 1 | -1, isPlayer: boolean, colors?: FighterColors, armLength: number = 65
): FighterState {
  const stats = ARCHETYPE_STATS[archetype];
  const maxStamina = BASE_STAMINA * stats.maxStaminaMult * levelScale(level, 1, 10);
  const baseBobSpeed = 1.8;
  return {
    name,
    archetype,
    level,
    x,
    z,
    y: 0,
    facingAngle: facing === 1 ? 0 : Math.PI,
    stamina: maxStamina,
    maxStamina,
    maxStaminaCap: maxStamina,
    staminaRegen: BASE_REGEN * stats.regenMult * levelScale(level, 1, 1.8),
    facing,
    headOffset: { x: 0, y: 0 },
    leftGloveOffset: { x: facing * 6, y: -12 },
    rightGloveOffset: { x: facing * 6, y: -8 },
    bodyOffset: { x: 0, y: 0 },
    bobPhase: 0,
    bobSpeed: baseBobSpeed,
    baseBobSpeed,
    defenseState: "fullGuard",
    preDuckBlockState: null,
    guardBlend: 1.0,
    isPunching: false,
    currentPunch: null,
    currentPunchStaminaCost: 0,
    punchProgress: 0,
    punchCooldown: 0,
    isHit: false,
    hitTimer: 0,
    critHitTimer: 0,
    cleanHitEyeTimer: 0,
    regenPauseTimer: 0,
    moveSpeed: BASE_MOVE_SPEED * stats.speedMult * levelScale(level, 1, 0.72),
    punchSpeedMult: stats.speedMult * levelScale(level, 2, 1.8) * 0.837 * 0.9 * 0.42 * 0.8,
    damageMult: stats.damageMult * levelScale(level, 1, 3.5) * 1.1,
    defenseMult: levelScale(level, 1, 0.7),
    staminaCostMult: stats.punchCostMult * levelScale(level, 1, 0.8),
    knockdowns: 0,
    knockdownsGiven: 0,
    punchesThrown: 0,
    punchesLanded: 0,
    cleanPunchesLanded: 0,
    feintBaits: 0,
    damageDealt: 0,
    timeSinceLastLanded: 0,
    timeSinceLastDamageTaken: Infinity,
    damageTakenRegenPauseFired: false,
    kdRegenBoostActive: false,
    unansweredStreak: 0,
    momentumRegenBoost: 0,
    momentumRegenTimer: 0,
    isPlayer,
    isKnockedDown: false,
    knockdownTimer: 0,
    duckTimer: 0,
    colors: colors || (isPlayer ? { ...DEFAULT_PLAYER_COLORS } : { ...DEFAULT_ENEMY_COLORS }),
    isFeinting: false,
    isCharging: false,
    chargeTimer: 0,
    stance: "neutral",
    handsDown: false,
    halfGuardPunch: false,
    rhythmLevel: 2,
    rhythmProgress: 0,
    rhythmDirection: 1,
    punchPhase: null,
    punchPhaseTimer: 0,
    isRePunch: false,
    retractionProgress: 0,
    staminaPauseFromRhythm: 0,
    speedBoostTimer: 0,
    punchAimsHead: false,
    blockTimer: 0,
    maxBlockDuration: levelScale(level, 20, 180),
    blockRegenPenaltyTimer: 0,
    blockRegenPenaltyDuration: levelScale(level, 0.25, 0),
    punchingWhileBlocking: false,
    recentPunchTimestamps: [],
    punchFatigueTimer: 0,
    isPunchFatigued: false,
    duckHoldTimer: 0,
    duckDrainCooldown: 0,
    duckProgress: 0,
    backLegDrive: 0,
    frontLegDrive: 0,
    moveSlowMult: 1,
    moveSlowTimer: 0,
    pushbackVx: 0,
    pushbackVz: 0,
    guardDownTimer: 0,
    guardDownSpeedBoost: 0,
    guardDownBoostTimer: 0,
    guardDownBoostMax: 0.24,
    stunBlockDisableTimer: 0,
    stunBlockWeakenTimer: 0,
    stunPunchDisableTimer: 0,
    stunPunchSlowMult: 1,
    stunPunchSlowTimer: 0,
    chargeCooldownTimer: 0,
    chargeReadyWindowTimer: 0,
    chargeReady: false,
    chargeArmed: false,
    chargeUsesLeft: 0,
    chargeArmTimer: 0,
    chargeMeterCounters: 0,
    chargeMeterBars: 0,
    chargeEmpoweredTimer: 0,
    chargeEmpoweredDuration: 3.0,
    chargeMeterLockoutTimer: 0,
    chargeHoldTimer: 0,
    chargeFlashTimer: 0,
    chargeHeadOffset: 0,
    blockFlashTimer: 0,
    punchTravelStartTime: 0,
    consecutiveChargeTimer: 0,
    consecutiveChargeCount: 0,
    feintWhiffPenaltyCooldown: 0,
    retractionPenaltyMult: 1,
    armLength,
    aiGuardDropTimer: 0,
    aiGuardDropCooldown: 0,
    telegraphPhase: "none",
    telegraphTimer: 0,
    telegraphDuration: 0,
    telegraphPunchType: null,
    telegraphIsFeint: false,
    telegraphIsCharged: false,
    timeSinceLastPunch: 999,
    timeSinceGuardRaised: 999,
    blinkTimer: 4 + Math.random() * 4,
    blinkDuration: 0,
    isBlinking: false,
    feintTelegraphDisableTimer: 0,
    feintedTelegraphBoost: 0,
    telegraphKdMult: 1,
    telegraphRoundBonus: 0,
    telegraphFeintRoundPenalty: 0,
    telegraphSlowTimer: 0,
    telegraphSlowDuration: 0,
    telegraphHeadSlideX: 0,
    telegraphHeadSlideY: 0,
    telegraphHeadSlideTimer: 0,
    telegraphHeadSlideDuration: 0,
    telegraphHeadSlidePhase: "none",
    telegraphHeadHoldTimer: 0,
    telegraphHeadSinkProgress: 0,
    duckSpeedMult: 1,
    blockMult: 1,
    critResistMult: 1,
    critMult: 1,
    stunMult: 1,
    focusT: 0,
    facingLockTimer: 0,
    telegraphSpeedMult: 1,
    handsDownTimer: 0,
    handsDownCooldown: 0,
    feintHoldTimer: 0,
    feintTouchingOpponent: false,
    feintDuckTouchingOpponent: false,
    autoGuardActive: false,
    autoGuardTimer: 0,
    autoGuardDuration: 0,
    lastSpacePressTime: -999,
    spaceWasUp: true,

    swayPhase: 0,
    swayDir: 1,
    swayOffset: 0,
    swaySpeedLevel: 3,
    swayFrozen: false,
    telegraphSwayAnimating: false,
    telegraphSwayTarget: 0,
    swayZone: "neutral",
    swayDamageMult: 1,
    swayTelegraphMult: 1,
    miniStunTimer: 0,
    rhythmPauseTimer: 0,

    weaveActive: false,
    weaveDirX: 0,
    weaveDirY: 0,
    weaveProgress: 0,
    weaveDuration: 0.18,
    weaveRecoveryTimer: 0,
    weaveCooldown: 0,
    preWeaveStance: "neutral",
    weaveCounterTimer: 0,
  };
}

const RING_CENTER_Z = RING_CY;
const PLAYER_START_X = RING_CX - 120;
const PLAYER_START_Z = RING_CENTER_Z;
const ENEMY_START_X = RING_CX + 120;
const ENEMY_START_Z = RING_CENTER_Z;

export function createInitialState(): GameState {
  return {
    phase: "menu",
    player: createFighter("Player", "BoxerPuncher", 1, PLAYER_START_X, PLAYER_START_Z, 1, true),
    enemy: createFighter("Enemy", "BoxerPuncher", 1, ENEMY_START_X, ENEMY_START_Z, -1, false),
    currentRound: 1,
    totalRounds: 3,
    roundTimer: ROUND_DURATION,
    roundDuration: ROUND_DURATION,
    roundScores: [],
    fightResult: null,
    fightWinner: null,
    xpGained: 0,
    countdownTimer: COUNTDOWN_DURATION,
    knockdownCountdown: 0,
    knockdownMashCount: 0,
    knockdownMashRequired: 25,
    knockdownMashTimer: 0,
    knockdownRefCount: 0,
    knockdownActive: false,
    ringWidth: RING_RIGHT - RING_LEFT,
    ringLeft: RING_LEFT,
    ringRight: RING_RIGHT,
    ringTop: RING_TOP,
    ringBottom: RING_BOTTOM,
    ringDepth: RING_BOTTOM - RING_TOP,
    selectedArchetype: "BoxerPuncher",
    playerLevel: 1,
    enemyLevel: 1,
    enemyName: ENEMY_NAMES[Math.floor(Math.random() * ENEMY_NAMES.length)],
    isPaused: false,
    pauseSelectedIndex: 0,
    pauseAction: null,
    pauseSoundTab: false,
    pauseControlsTab: false,
    isQuickFight: false,
    fatigueEnabled: false,
    aiDifficulty: "contender",
    cornerWalkActive: false,
    cornerWalkTimer: 0,
    aiKdGetUpTime: 0,
    aiKdWillGetUp: false,
    refereeVisible: false,
    standingFighterTargetX: 0,
    standingFighterTargetZ: RING_CENTER_Z,
    savedDefenseState: "none",
    savedHandsDown: false,
    savedBlockTimer: 0,
    savedStandingIsPlayer: false,
    kdSavedKnockedRhythmLevel: 2,
    kdSavedStandingRhythmLevel: 2,
    shakeIntensity: 0,
    shakeTimer: 0,
    hitEffects: [],
    playerColors: { ...DEFAULT_PLAYER_COLORS },
    roundStats: {
      playerDamageThisRound: 0,
      enemyDamageThisRound: 0,
      playerPunchesThisRound: 0,
      enemyPunchesThisRound: 0,
      playerLandedThisRound: 0,
      enemyLandedThisRound: 0,
      playerKDsThisRound: 0,
      enemyKDsThisRound: 0,
      playerAggressionTime: 0,
      enemyAggressionTime: 0,
      playerRingControlTime: 0,
      enemyRingControlTime: 0,
      playerPunchesDodged: 0,
      enemyPunchesDodged: 0,
      playerPunchesBlocked: 0,
      enemyPunchesBlocked: 0,
      playerDuckDodges: 0,
      playerComboCount: 0,
      playerConsecutiveLanded: 0,
    },
    timerSpeed: "normal" as TimerSpeed,
    aiBrain: null,
    fightTotalDuckDodges: 0,
    fightTotalCombos: 0,
    kdIsBodyShot: false,
    kdTakeKnee: false,
    kdFaceRefActive: false,
    kdFaceRefTimer: 0,
    refStoppageActive: false,
    refStoppageTimer: 0,
    refStoppageType: null,
    mercyStoppageEnabled: true,
    towelStoppageEnabled: true,
    practiceMode: false,
    cpuAttacksEnabled: true,
    cpuDefenseEnabled: true,
    sparringMode: false,
    careerFightMode: false,
    enemyWhiffBonus: 0,
    towelActive: false,
    towelTimer: 0,
    towelStartX: 0,
    towelStartY: 0,
    towelEndX: 0,
    towelEndY: 0,
    refX: RING_CX,
    refZ: RING_CY,
    enemyColors: { ...DEFAULT_ENEMY_COLORS },
    ringCanvasColor: "#3d2f1e",
    totalEnemyKDs: 0,
    kdSequence: [],
    towelImmunityUsed: false,
    fightElapsedTime: 0,
    kdTimerExpired: false,
    introAnimActive: false,
    introAnimTimer: 0,
    introAnimPhase: 0,
    playerIntroPlaying: false,
    enemyIntroPlaying: false,
    playerSavedRhythmLevel: 2,
    enemySavedRhythmLevel: 2,
    swarmerPunchQueue: [],
    swarmerPunchIndex: 0,
    swarmerPunchDelay: 0,
    swarmerIsPlayer: false,
    recordInputs: false,
    inputRecording: null,
    cpuVsCpu: false,
    playerAiBrain: null,
    telegraphMult: 1.0,
    hitstopTimer: 0,
    hitstopDuration: 0,
    crowdBobTime: 0,
    crowdKdBounceTimer: 0,
    crowdExciteTimer: 0,
    crowdKdSpeedTimer: 0,
    cleanHitStreak: 0,
    playerCurrentXp: 0,
    midFightLevelUps: 0,
    midFightLevelUpTimer: 0,
    adaptiveAiEnabled: false,
    behaviorProfile: null,
    tutorialMode: false,
    tutorialStage: 0,
    tutorialStep: 0,
    tutorialPrompt: "",
    tutorialPromptTimer: 0,
    tutorialAiIdle: false,
    tutorialTracking: createDefaultTutorialTracking(),
    tutorialShowContinueButton: false,
    tutorialDelayTimer: 0,
    tutorialCareerMode: false,
    tutorialFightUnlocked: false,
  };
}

function createDefaultTutorialTracking(): import("./types").TutorialTracking {
  return {
    movedLeft: false,
    movedRight: false,
    movedUp: false,
    movedDown: false,
    threwJab: false,
    threwCross: false,
    threwLeftHook: false,
    threwRightHook: false,
    threwLeftUppercut: false,
    threwRightUppercut: false,
    punchesBlocked: 0,
    ducked: false,
    autoGuardActivated: false,
    guardToggled: false,
    weaveCount: 0,
    rhythmChangeCount: 0,
    chargeUsed: false,
    feintCount: 0,
    punchFeintCount: 0,
  };
}

const PLAYER_CORNER_X = PLAYER_START_X;
const PLAYER_CORNER_Z = RING_CENTER_Z;
const ENEMY_CORNER_X = ENEMY_START_X;
const ENEMY_CORNER_Z = RING_CENTER_Z;
const CORNER_WALK_SPEED = 120;

const NEUTRAL_CORNER_TOP_X = RING_CX;
const NEUTRAL_CORNER_TOP_Z = RING_CY - RING_HALF_H + 30;
const NEUTRAL_CORNER_BOT_X = RING_CX;
const NEUTRAL_CORNER_BOT_Z = RING_CY + RING_HALF_H - 30;

function getFarthestNeutralCorner(fromX: number, fromZ: number): { x: number; z: number } {
  const distTop = Math.sqrt((fromX - NEUTRAL_CORNER_TOP_X) ** 2 + (fromZ - NEUTRAL_CORNER_TOP_Z) ** 2);
  const distBot = Math.sqrt((fromX - NEUTRAL_CORNER_BOT_X) ** 2 + (fromZ - NEUTRAL_CORNER_BOT_Z) ** 2);
  if (distTop >= distBot) {
    return { x: NEUTRAL_CORNER_TOP_X, z: NEUTRAL_CORNER_TOP_Z };
  }
  return { x: NEUTRAL_CORNER_BOT_X, z: NEUTRAL_CORNER_BOT_Z };
}

export function startFight(state: GameState, archetype: Archetype, playerLevel: number, enemyLevel: number, playerName?: string, playerColors?: FighterColors, isQuickFight: boolean = false, aiDifficulty: AIDifficulty = "contender", totalRounds: number = 3, roundDurationSeconds: number = 180, timerSpeed: TimerSpeed = "normal", playerArmLength: number = 65, enemyArmLength: number = 65, overrideEnemyArchetype?: Archetype, overrideEnemyName?: string, trainingBonuses?: { weightLifting: number; heavyBag: number; sparring?: number; nextFightBuffs?: { doubleCrit?: boolean; moveSpeedBoost?: boolean; doubleStun?: boolean; extraWhiff?: boolean } }, fatigueEnabled: boolean = false, towelStoppageEnabled: boolean = true, practiceMode: boolean = false, recordInputs: boolean = false, cpuVsCpu: boolean = false, overrideEnemyColors?: FighterColors, sparringMode: boolean = false, careerStaminaTier?: AIDifficulty, qfAiPowerMult: number = 1, qfAiSpeedMult: number = 1, qfAiStaminaMult: number = 1, playerSkillPoints?: { power: number; speed: number; defense: number; stamina: number; focus?: number }, enemySkillPoints?: { power: number; speed: number; defense: number; stamina: number; focus?: number }, mercyStoppageEnabled: boolean = true, enemyRosterId?: number): GameState {
  const enemyArchetypes: Archetype[] = ["BoxerPuncher", "OutBoxer", "Brawler", "Swarmer"];
  const enemyArchetype = overrideEnemyArchetype || enemyArchetypes[Math.floor(Math.random() * enemyArchetypes.length)];
  const enemyName = overrideEnemyName || ENEMY_NAMES[Math.floor(Math.random() * ENEMY_NAMES.length)];

  const randomEnemyColors: FighterColors = overrideEnemyColors || {
    gloves: ["#1155cc", "#22aa22", "#ddaa00", "#aa22aa", "#ff6600"][Math.floor(Math.random() * 5)],
    gloveTape: ["#eeeeee", "#cccccc", "#222222"][Math.floor(Math.random() * 3)],
    trunks: ["#222222", "#cc2222", "#22aa22", "#ddaa00", "#aa22aa"][Math.floor(Math.random() * 5)],
    shoes: ["#1a1a1a", "#2a1a1a", "#222222"][Math.floor(Math.random() * 3)],
    skin: SKIN_COLOR_PRESETS[Math.floor(Math.random() * SKIN_COLOR_PRESETS.length)],
  };

  const player = createFighter(playerName || "Player", archetype, playerLevel, PLAYER_START_X, PLAYER_START_Z, 1, true, playerColors || state.playerColors, playerArmLength);
  if (trainingBonuses) {
    const wl = trainingBonuses.weightLifting;
    const hb = trainingBonuses.heavyBag;
    if (wl > 0) {
      player.damageMult *= 1 + Math.min(wl * 0.005, 0.15);
      player.defenseMult *= 1 - Math.min(wl * 0.005, 0.15);
    }
    if (hb > 0) {
      player.punchSpeedMult *= 1 + Math.min(hb * 0.005, 0.15);
      player.moveSpeed *= 1 + Math.min(hb * 0.005, 0.15);
      player.damageMult *= 1 + Math.min(hb * 0.005, 0.15);
    }
    const buffs = trainingBonuses.nextFightBuffs;
    if (buffs) {
      if (buffs.doubleCrit) {
        player.critMult = 2.0;
      }
      if (buffs.moveSpeedBoost) {
        player.moveSpeed *= 1.2;
      }
      if (buffs.doubleStun) {
        player.stunMult = 2.0;
      }
      if (buffs.extraWhiff) {
        state.enemyWhiffBonus = 0.10;
      }
    }
  }

  const enemy = createFighter(enemyName, enemyArchetype, enemyLevel, ENEMY_START_X, ENEMY_START_Z, -1, false, randomEnemyColors, enemyArmLength);

  {
    const lvlT = Math.min(1, (playerLevel - 1) / 99);
    player.autoGuardDuration = 10 + lvlT * 35;
  }

  if (playerSkillPoints) {
    const sp = playerSkillPoints;
    const MAX_SP = 200;
    const pT = Math.min(1, sp.power / MAX_SP);
    const sT = Math.min(1, sp.speed / MAX_SP);
    const dT = Math.min(1, sp.defense / MAX_SP);
    const stT = Math.min(1, sp.stamina / MAX_SP);
    const champPowerBoost = aiDifficulty === "champion" ? 1.3 : 1.0;
    player.damageMult *= 1 + pT * 0.45 * champPowerBoost;
    player.punchSpeedMult *= 1 + sT * 0.45;
    player.moveSpeed *= 1 + sT * 0.15;
    player.duckSpeedMult = 1 + sT * 0.6;
    player.blockMult = 1 + dT * 0.6;
    player.critResistMult = 1 - dT * 0.27;
    player.telegraphSpeedMult = 1 - sT * 0.27;
    player.staminaRegen *= 1 + stT * 0.6;
    player.maxStamina *= 1 + stT * 0.24;
    player.maxStaminaCap *= 1 + stT * 0.24;
    player.stamina = player.maxStamina;
    const fT = Math.min(1, (playerSkillPoints.focus || 0) / MAX_SP);
    player.focusT = fT;
    player.critMult *= 1 + fT * 1.8;
    player.stunMult *= 1 + fT * 1.8;
    player.chargeEmpoweredDuration = 3.0 + fT * 2.1;
    const levelT = Math.min(1, (playerLevel - 1) / 99);
    const baseAutoGuard = 10 + levelT * 35;
    player.autoGuardDuration = baseAutoGuard + dT * 40.5;
  }

  if (enemySkillPoints) {
    const esp = enemySkillPoints;
    const MAX_SP = 200;
    const epT = Math.min(1, esp.power / MAX_SP);
    const esT = Math.min(1, esp.speed / MAX_SP);
    const edT = Math.min(1, esp.defense / MAX_SP);
    const estT = Math.min(1, esp.stamina / MAX_SP);
    enemy.damageMult *= 1 + epT * 0.9;
    enemy.punchSpeedMult *= 1 + esT * 0.45;
    enemy.moveSpeed *= 1 + esT * 0.15;
    enemy.duckSpeedMult = 1 + esT * 0.6;
    enemy.blockMult = 1 + edT * 0.6;
    enemy.critResistMult = 1 - edT * 0.27;
    enemy.telegraphSpeedMult = 1 - esT * 0.27;
    enemy.staminaRegen *= 1 + estT * 0.6;
    enemy.maxStamina *= 1 + estT * 0.24;
    enemy.maxStaminaCap *= 1 + estT * 0.24;
    enemy.stamina = enemy.maxStamina;
    const efT = Math.min(1, (esp.focus || 0) / MAX_SP);
    enemy.focusT = efT;
    enemy.critMult *= 1 + efT * 1.8;
    enemy.stunMult *= 1 + efT * 1.8;
    enemy.chargeEmpoweredDuration = 3.0 + efT * 2.1;
    const eLevelT = Math.min(1, (enemyLevel - 1) / 99);
    const eBaseAutoGuard = 10 + eLevelT * 35;
    enemy.autoGuardDuration = eBaseAutoGuard + edT * 40.5;
  }

  const lvlGap = playerLevel - enemyLevel;
  if (lvlGap > 0) {
    player.damageMult *= 1 + lvlGap * 0.025;
    player.moveSpeed *= 1 + lvlGap * 0.025;
  } else if (lvlGap < 0) {
    enemy.damageMult *= 1 + (-lvlGap) * 0.025;
    enemy.moveSpeed *= 1 + (-lvlGap) * 0.025;
  }

  if (aiDifficulty === "champion") {
    enemy.damageMult *= 1.185;
    enemy.moveSpeed *= 1.05;
  } else if (aiDifficulty === "elite") {
    enemy.damageMult *= 1.133;
    enemy.moveSpeed *= 1.02;
  } else if (aiDifficulty === "contender") {
    enemy.damageMult *= 1.082;
  } else {
    enemy.damageMult *= 1.030;
  }

  if (!isQuickFight && !practiceMode) {
    enemy.damageMult *= 0.80;
    if (aiDifficulty === "champion" || aiDifficulty === "elite" || aiDifficulty === "contender") {
      enemy.damageMult *= 0.90;
    }
  }

  if (isQuickFight) {
    enemy.damageMult *= qfAiPowerMult;
    enemy.moveSpeed *= qfAiSpeedMult;
    enemy.stamina *= qfAiStaminaMult;
    enemy.maxStamina *= qfAiStaminaMult;
    enemy.maxStaminaCap *= qfAiStaminaMult;
  }

  if (careerStaminaTier) {
    const t = Math.max(0, Math.min(1, (enemyLevel - 1) / 99));
    const tierStamina: Record<AIDifficulty, [number, number]> = {
      journeyman: [80, 1400],
      contender: [150, 1850],
      elite: [250, 2500],
      champion: [300, 3000],
    };
    const [minS, maxS] = tierStamina[careerStaminaTier];
    const careerStamina = minS + (maxS - minS) * t;
    enemy.stamina = careerStamina;
    enemy.maxStamina = careerStamina;
    enemy.maxStaminaCap = careerStamina;
  }

  const newState: GameState = {
    ...state,
    phase: "prefight" as const,
    player,
    enemy,
    currentRound: 1,
    totalRounds: totalRounds,
    roundTimer: roundDurationSeconds,
    roundDuration: roundDurationSeconds,
    roundScores: [],
    fightResult: null,
    fightWinner: null,
    xpGained: 0,
    countdownTimer: COUNTDOWN_DURATION,
    knockdownCountdown: 0,
    knockdownMashCount: 0,
    knockdownMashRequired: 25,
    knockdownMashTimer: 0,
    knockdownRefCount: 0,
    knockdownActive: false,
    enemyName,
    enemyLevel,
    playerLevel,
    isPaused: false,
    pauseSelectedIndex: 0,
    pauseAction: null,
    pauseSoundTab: false,
    pauseControlsTab: false,
    isQuickFight,
    fatigueEnabled,
    aiDifficulty,
    cornerWalkActive: false,
    cornerWalkTimer: 0,
    aiKdGetUpTime: 0,
    aiKdWillGetUp: false,
    refereeVisible: false,
    standingFighterTargetX: 0,
    standingFighterTargetZ: RING_CENTER_Z,
    savedDefenseState: "none",
    savedHandsDown: false,
    savedBlockTimer: 0,
    savedStandingIsPlayer: false,
    kdSavedKnockedRhythmLevel: 2,
    kdSavedStandingRhythmLevel: 2,
    hitEffects: [],
    shakeIntensity: 0,
    shakeTimer: 0,
    ringTop: RING_TOP,
    ringBottom: RING_BOTTOM,
    ringDepth: RING_BOTTOM - RING_TOP,
    roundStats: {
      playerDamageThisRound: 0,
      enemyDamageThisRound: 0,
      playerPunchesThisRound: 0,
      enemyPunchesThisRound: 0,
      playerLandedThisRound: 0,
      enemyLandedThisRound: 0,
      playerKDsThisRound: 0,
      enemyKDsThisRound: 0,
      playerAggressionTime: 0,
      enemyAggressionTime: 0,
      playerRingControlTime: 0,
      enemyRingControlTime: 0,
      playerPunchesDodged: 0,
      enemyPunchesDodged: 0,
      playerPunchesBlocked: 0,
      enemyPunchesBlocked: 0,
      playerDuckDodges: 0,
      playerComboCount: 0,
      playerConsecutiveLanded: 0,
    },
    timerSpeed,
    aiBrain: initAiBrain(aiDifficulty, enemyArchetype, enemyLevel, cpuVsCpu, enemyRosterId),
    fightTotalDuckDodges: 0,
    fightTotalCombos: 0,
    kdIsBodyShot: false,
    kdTakeKnee: false,
    kdFaceRefActive: false,
    kdFaceRefTimer: 0,
    refStoppageActive: false,
    refStoppageTimer: 0,
    refStoppageType: null,
    mercyStoppageEnabled: mercyStoppageEnabled,
    towelStoppageEnabled: towelStoppageEnabled,
    practiceMode: practiceMode,
    cpuAttacksEnabled: true,
    cpuDefenseEnabled: true,
    sparringMode: sparringMode,
    towelActive: false,
    towelTimer: 0,
    towelStartX: 0,
    towelStartY: 0,
    towelEndX: 0,
    towelEndY: 0,
    refX: RING_CX,
    refZ: RING_CY,
    playerColors: playerColors ? { ...playerColors } : { ...state.playerColors },
    enemyColors: { ...randomEnemyColors },
    ringCanvasColor: nextRingCanvasColor,
    totalEnemyKDs: 0,
    kdSequence: [],
    towelImmunityUsed: false,
    fightElapsedTime: 0,
    kdTimerExpired: false,
    introAnimActive: true,
    introAnimTimer: 0,
    introAnimPhase: 0,
    playerIntroPlaying: true,
    enemyIntroPlaying: true,
    playerSavedRhythmLevel: player.rhythmLevel,
    enemySavedRhythmLevel: 2,
    swarmerPunchQueue: generateSwarmerPunchQueue(),
    swarmerPunchIndex: 0,
    swarmerPunchDelay: 0,
    swarmerIsPlayer: archetype === "Swarmer",
    cpuVsCpu,
    playerAiBrain: cpuVsCpu ? initAiBrain(aiDifficulty, archetype, playerLevel, true) : null,
    telegraphMult: getTelegraphMult(),
    hitstopTimer: 0,
    hitstopDuration: 0,
    crowdBobTime: 0,
    crowdKdBounceTimer: 0,
    crowdExciteTimer: 0,
    crowdKdSpeedTimer: 0,
    recordInputs,
    inputRecording: recordInputs ? {
      fightSettings: {
        playerArchetype: archetype,
        enemyArchetype,
        playerLevel,
        enemyLevel,
        aiDifficulty,
        roundDuration: roundDurationSeconds,
        timerSpeed,
        totalRounds,
        playerArmLength,
        enemyArmLength,
        practiceMode,
        cpuVsCpu,
        playerName: playerName || "Player",
        enemyName: overrideEnemyName || "Enemy",
      },
      rounds: [],
    } : null,
    playerCurrentXp: 0,
    midFightLevelUps: 0,
    midFightLevelUpTimer: 0,
    adaptiveAiEnabled: getAdaptiveAiEnabled(),
    behaviorProfile: null,
  };
  if (newState.adaptiveAiEnabled) {
    newState.behaviorProfile = createBehaviorProfile(newState);
    if (newState.aiBrain) {
      newState.aiBrain.adaptiveMemory = createAdaptiveMemory(newState.aiBrain);
    }
    if (newState.playerAiBrain) {
      newState.playerAiBrain.adaptiveMemory = createAdaptiveMemory(newState.playerAiBrain);
    }
  }
  startIntroAnimForFighter(newState.player, newState.playerSavedRhythmLevel);
  startIntroAnimForFighter(newState.enemy, newState.enemySavedRhythmLevel);
  return newState;
}

const ALL_PUNCHES: PunchType[] = ["jab", "cross", "leftHook", "rightHook", "leftUppercut", "rightUppercut"];

function generateSwarmerPunchQueue(): PunchType[] {
  const q: PunchType[] = [];
  for (let i = 0; i < 3; i++) {
    q.push(ALL_PUNCHES[Math.floor(Math.random() * ALL_PUNCHES.length)]);
  }
  return q;
}

function shouldPlayIntroAnim(state: GameState, fighter: FighterState): boolean {
  if (state.currentRound === 1) return true;
  if (state.currentRound === state.totalRounds) return true;
  const lastScore = state.roundScores.length > 0 ? state.roundScores[state.roundScores.length - 1] : null;
  if (lastScore) {
    let pTotal = 0, eTotal = 0;
    lastScore.judges.forEach((j: { player: number; enemy: number }) => { pTotal += j.player; eTotal += j.enemy; });
    if (fighter.isPlayer && pTotal > eTotal) return true;
    if (!fighter.isPlayer && eTotal > pTotal) return true;
  }
  return false;
}

function startIntroAnimForFighter(fighter: FighterState, savedRhythm: number): void {
  const arch = fighter.archetype;
  const baseRhythm = savedRhythm > 0 ? savedRhythm : 2;
  const introRhythm = Math.min(4, Math.round(baseRhythm * 1.2));
  if (arch === "OutBoxer") {
    fighter.defenseState = "none";
    fighter.guardBlend = 0;
    fighter.handsDown = true;
    fighter.rhythmLevel = introRhythm;
  } else if (arch === "BoxerPuncher") {
    fighter.rhythmLevel = introRhythm;
    fighter.headOffset = { x: fighter.headOffset.x, y: fighter.headOffset.y - 5 };
  } else if (arch === "Brawler") {
    fighter.rhythmLevel = introRhythm;
  } else if (arch === "Swarmer") {
    fighter.rhythmLevel = introRhythm;
  }
}

function startCosmeticPunch(fighter: FighterState, punchType: PunchType): void {
  if (fighter.isPunching) return;
  fighter.isPunching = true;
  fighter.currentPunch = punchType;
  fighter.punchProgress = 0;
  fighter.punchPhase = "launchDelay";
  fighter.punchPhaseTimer = 0;
  fighter.isRePunch = false;
  fighter.retractionProgress = 0;
  fighter.isFeinting = false;
  fighter.feintHoldTimer = 0;
  fighter.feintTouchingOpponent = false;
  fighter.feintDuckTouchingOpponent = false;
  fighter.isCharging = false;
  fighter.punchAimsHead = true;
  fighter.currentPunchStaminaCost = 0;
}

function updateIntroAnim(state: GameState, dt: number): void {
  if (!state.introAnimActive) return;
  state.introAnimTimer += dt;
  const totalDur = COUNTDOWN_DURATION;
  const progress = Math.min(state.introAnimTimer / totalDur, 1);

  for (const isPlayer of [true, false]) {
    const fighter = isPlayer ? state.player : state.enemy;
    const playing = isPlayer ? state.playerIntroPlaying : state.enemyIntroPlaying;
    if (!playing) continue;

    const arch = fighter.archetype;

    if (arch === "OutBoxer") {
      fighter.defenseState = "none";
      fighter.handsDown = true;
      fighter.guardBlend = 0;
    } else if (arch === "BoxerPuncher") {
      const guardProg = Math.min(progress / 0.9, 1);
      fighter.guardBlend = guardProg;
      fighter.headOffset = { x: 0, y: -5 * (1 - guardProg) };
    } else if (arch === "Brawler") {
      const phase4 = progress * 4;
      if (phase4 < 1) {
        fighter.defenseState = "duck";
      } else if (phase4 < 2) {
        fighter.defenseState = "none";
      } else if (phase4 < 3) {
        fighter.defenseState = "duck";
      } else {
        fighter.defenseState = "none";
      }
    } else if (arch === "Swarmer") {
      const punchTimes = [0.15, 0.45, 0.7];
      for (let pi = 0; pi < 3; pi++) {
        const prevProg = Math.max(0, (state.introAnimTimer - dt) / totalDur);
        if (prevProg < punchTimes[pi] && progress >= punchTimes[pi] && !fighter.isPunching) {
          const punchType = ALL_PUNCHES[Math.floor(Math.random() * ALL_PUNCHES.length)];
          startCosmeticPunch(fighter, punchType);
        }
      }
      if (progress > 0.85 && !fighter.isPunching) {
        fighter.handsDown = true;
        fighter.defenseState = "none";
        fighter.guardBlend = 0;
        if (fighter.isPlayer) {
          fighter.rhythmLevel = 0;
        }
      }
    }
  }
}

function resetIntroAnim(state: GameState): void {
  for (const isPlayer of [true, false]) {
    const fighter = isPlayer ? state.player : state.enemy;
    const playing = isPlayer ? state.playerIntroPlaying : state.enemyIntroPlaying;
    if (!playing) continue;

    const savedR = isPlayer ? state.playerSavedRhythmLevel : state.enemySavedRhythmLevel;
    fighter.rhythmLevel = savedR > 0 ? savedR : 2;
    fighter.rhythmProgress = 0;
    fighter.rhythmDirection = 1;
    fighter.handsDown = false;
    fighter.defenseState = "fullGuard";
    fighter.headOffset = { x: 0, y: 0 };
  }
  state.introAnimActive = false;
  state.playerIntroPlaying = false;
  state.enemyIntroPlaying = false;
}

const keys: Record<string, boolean> = {};
const keyJustPressed: Record<string, boolean> = {};
let shiftHeldTime = 0;
let gameElapsedTime = 0;

export function clearAllKeys(): void {
  for (const k in keys) {
    keys[k] = false;
  }
  for (const k in keyJustPressed) {
    keyJustPressed[k] = false;
  }
}

export function handleKeyDown(e: KeyboardEvent) {
  const k = e.key.toLowerCase();
  if (!keys[k]) {
    keyJustPressed[k] = true;
  }
  keys[k] = true;
}

export function handleKeyUp(e: KeyboardEvent) {
  keys[e.key.toLowerCase()] = false;
}

function consumePress(key: string): boolean {
  if (keyJustPressed[key]) {
    keyJustPressed[key] = false;
    return true;
  }
  return false;
}

function clearFrameInput(): void {
  for (const k in keyJustPressed) {
    keyJustPressed[k] = false;
  }
}

function getDistance(a: FighterState, b: FighterState): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

function getRhythmPhase(progress: number): RhythmPhase {
  if (progress <= 0.4) return "beginning";
  if (progress <= 0.6) return "middle";
  return "end";
}

function getRhythmPhaseIntensity(progress: number): number {
  if (progress <= 0.4) return progress / 0.4;
  if (progress <= 0.6) return (progress - 0.4) / 0.2;
  return (progress - 0.6) / 0.4;
}

interface RhythmBuffs {
  jabDamageMult: number;
  jabSpeedMult: number;
  hookDamageMult: number;
  hookSpeedMult: number;
  crossDamageMult: number;
  crossSpeedMult: number;
  crossRetractMult: number;
  whiffChance: number;
  rangeMult: number;
  accuracyMult: number;
  staminaRecoveryMult: number;
  punchSpeedMult: number;
  hitStaminaPauseDuration: number;
}

function getRhythmBuffs(fighter: FighterState): RhythmBuffs {
  const buffs: RhythmBuffs = {
    jabDamageMult: 1,
    jabSpeedMult: 1,
    hookDamageMult: 1,
    hookSpeedMult: 1,
    crossDamageMult: 1,
    crossSpeedMult: 1,
    crossRetractMult: 1,
    whiffChance: 0,
    rangeMult: 1,
    accuracyMult: 1,
    staminaRecoveryMult: 1,
    punchSpeedMult: 1,
    hitStaminaPauseDuration: 0,
  };

  if (fighter.rhythmLevel === 0) return buffs;

  const phase = getRhythmPhase(fighter.rhythmProgress);
  const intensity = getRhythmPhaseIntensity(fighter.rhythmProgress);

  switch (phase) {
    case "beginning":
      buffs.jabDamageMult = 1 + 0.07 * intensity;
      buffs.jabSpeedMult = 1 + 0.07 * intensity;
      buffs.whiffChance = 0.07 * intensity;
      buffs.rangeMult = 1 - 0.07 * intensity;
      buffs.crossRetractMult = 1 - 0.07 * intensity;
      buffs.staminaRecoveryMult = 1 - 0.07 * intensity;
      break;
    case "middle":
      buffs.staminaRecoveryMult = 1 + 0.14 * intensity;
      buffs.punchSpeedMult = 1 + 0.07 * intensity;
      if (fighter.rhythmProgress >= 0.45 && fighter.rhythmProgress <= 0.55) {
        buffs.hitStaminaPauseDuration = 0.2;
      }
      if (fighter.rhythmProgress >= 0.48 && fighter.rhythmProgress <= 0.52) {
        buffs.hitStaminaPauseDuration = 1.0;
      }
      break;
    case "end":
      buffs.hookDamageMult = 1 + 0.07 * intensity;
      buffs.hookSpeedMult = 1 + 0.07 * intensity;
      buffs.crossDamageMult = 1 + 0.07 * intensity;
      buffs.crossSpeedMult = 1 + 0.07 * intensity;
      buffs.rangeMult = 1 + 0.07 * intensity;
      buffs.accuracyMult = 1 + 0.07 * intensity;
      buffs.staminaRecoveryMult = 1 - 0.07 * intensity;
      break;
  }

  return buffs;
}

function getPunchPhaseDurations(fighter: FighterState, config: PunchConfig, isRePunch: boolean): Record<PunchPhaseType, number> {
  let speedMult = config.speed * fighter.punchSpeedMult;
  if (fighter.isCharging) {
    const guardDown = fighter.handsDown;
    speedMult *= guardDown ? CHARGE_GUARDDOWN_SPEED_BONUS : 0.7;
  }
  if (fighter.halfGuardPunch) speedMult *= 0.85;
  if (fighter.speedBoostTimer > 0) speedMult *= 1.07;
  
  if (fighter.stunPunchSlowTimer > 0) speedMult *= fighter.stunPunchSlowMult;

  const rhythmBuffs = getRhythmBuffs(fighter);
  speedMult *= rhythmBuffs.punchSpeedMult;

  const punchType = fighter.currentPunch;
  if (punchType === "jab") speedMult *= rhythmBuffs.jabSpeedMult;
  if (punchType === "cross") speedMult *= rhythmBuffs.crossSpeedMult;
  if (punchType === "leftHook" || punchType === "rightHook") speedMult *= rhythmBuffs.hookSpeedMult;

  const launchBase = 0.1 / speedMult * LAUNCH_DELAY_MULT;
  const armSpeedBase = 0.12 / speedMult / ARM_SPEED_MULT;
  const contactBase = 0.03;
  const lingerBase = levelScale(fighter.level, 0.2, 0.05) / speedMult * LINGER_MULT;
  let retractBase = launchBase * 1.1;
  if (punchType === "cross") retractBase /= rhythmBuffs.crossRetractMult;
  retractBase *= fighter.retractionPenaltyMult;

  return {
    launchDelay: isRePunch ? launchBase * 0.5 : launchBase,
    armSpeed: armSpeedBase,
    contact: contactBase,
    linger: lingerBase,
    retraction: retractBase,
  };
}

function getTelegraphCooldownZ(_level: number, punchType: PunchType): number {
  if (punchType.includes("Uppercut")) return 1.5;
  if (punchType.includes("Hook") || punchType === "cross") return 2.0;
  return 3.0; // jab
}

function getTelegraphBaseDuration(level: number, punchType: PunchType): number {
  const isHook = punchType.includes("Hook");
  const isUppercut = punchType.includes("Uppercut");
  if (isHook) return levelScale(level, 0.168, 0.16) * 5.0;
  if (isUppercut) return levelScale(level, 0.21, 0.20) * 5.0;
  return levelScale(level, 0.042, 0.04) * 5.0;
}

function shouldTelegraph(fighter: FighterState, isRePunch: boolean, punchType: PunchType = "jab"): boolean {
  if (isRePunch) return false;
  if (fighter.feintTelegraphDisableTimer > 0) return false;
  const cooldownZ = getTelegraphCooldownZ(fighter.level, punchType);
  return fighter.timeSinceLastPunch >= cooldownZ;
}

function computeSwayZoneMults(fighter: FighterState): void {
  const absSwayNorm = Math.abs(fighter.swayOffset) / 5;
  const isActive = fighter.swaySpeedLevel > 0;
  const leavingFoot = fighter.swayDir * fighter.swayOffset < 0;
  if (isActive && absSwayNorm >= 0.9) {
    fighter.swayZone = "power";
    fighter.swayDamageMult = 1.5;
    fighter.swayTelegraphMult = 0.5;
  } else if (isActive && absSwayNorm >= 0.1 && leavingFoot) {
    fighter.swayZone = "offBalance";
    fighter.swayDamageMult = 0.85;
    fighter.swayTelegraphMult = 1.5;
  } else {
    fighter.swayZone = "neutral";
    fighter.swayDamageMult = 1;
    fighter.swayTelegraphMult = 1;
  }
}

function startTelegraph(fighter: FighterState, punchType: PunchType, isFeint: boolean, isCharged: boolean, telegraphMult: number): boolean {
  // Rhythm-based telegraph speedup/disable
  if (fighter.rhythmLevel > 0) {
    const rp = fighter.rhythmProgress;
    if (rp > 0.95) return false; // >95% rhythm: skip telegraph entirely
    if (rp >= 0.90) telegraphMult *= 0.5; // 90-95%: telegraph 2x faster
  }
  const isHook = punchType.includes("Hook");
  const isUppercut = punchType.includes("Uppercut");
  const isDucking = fighter.defenseState === "duck";

  let baseDur = getTelegraphBaseDuration(fighter.level, punchType);

  let boostMult = 1 + fighter.feintedTelegraphBoost;
  if (isCharged) {
    const chargeIncrease = levelScale(fighter.level, 0.15, 0.03);
    boostMult *= (1 + chargeIncrease);
  }
  baseDur *= boostMult * telegraphMult * fighter.telegraphKdMult * Math.max(0.1, fighter.telegraphSpeedMult);
  baseDur += fighter.telegraphRoundBonus + fighter.telegraphFeintRoundPenalty;

  computeSwayZoneMults(fighter);
  baseDur *= fighter.swayTelegraphMult;

  fighter.telegraphDuration = baseDur;
  fighter.telegraphTimer = 0;
  fighter.telegraphPunchType = punchType;
  fighter.telegraphIsFeint = isFeint;
  fighter.telegraphIsCharged = isCharged;

  if ((isHook || isUppercut) && !isDucking) {
    fighter.telegraphPhase = "duckDown";
  } else {
    fighter.telegraphPhase = "down";
  }
  fighter.feintedTelegraphBoost = 0;

  fighter.telegraphSwayTarget = fighter.swayDir * 5;
  fighter.telegraphSwayAnimating = true;
  fighter.swayFrozen = false;

  const slowDur = levelScale(fighter.level, 1.0, 0.25);
  fighter.telegraphSlowTimer = slowDur;
  fighter.telegraphSlowDuration = slowDur;

  const isCross = punchType === "cross";
  if ((isCross || isHook) && !isDucking) {
    const arch = fighter.archetype;
    if (arch === "Brawler" || arch === "OutBoxer") {
      const diagDur = baseDur / 1.5;
      fighter.telegraphHeadSlideDuration = diagDur;
      fighter.telegraphHeadSlideTimer = 0;
      fighter.telegraphHeadSlidePhase = "sliding";
      const diagPx = 8;
      const diag = diagPx / Math.SQRT2;
      fighter.telegraphHeadSlideX = diag * fighter.facing;
      fighter.telegraphHeadSlideY = 0;
    } else if (arch === "BoxerPuncher" || arch === "Swarmer") {
      const diagDur = baseDur / 1.5;
      fighter.telegraphHeadSlideDuration = diagDur;
      fighter.telegraphHeadSlideTimer = 0;
      fighter.telegraphHeadSlidePhase = "sliding";
      fighter.telegraphHeadSlideX = 0;
      fighter.telegraphHeadSlideY = 6;
    }
  }
  return true;
}

function updateTelegraph(fighter: FighterState, dt: number): PunchType | null {
  if (fighter.telegraphPhase === "none") return null;
  fighter.telegraphTimer += dt;
  const half = fighter.telegraphDuration * 0.5;

  if (fighter.telegraphPhase === "down" || fighter.telegraphPhase === "duckDown") {
    if (fighter.telegraphTimer >= half) {
      fighter.telegraphPhase = fighter.telegraphPhase === "duckDown" ? "duckUp" : "up";
    }
  }

  if (fighter.telegraphTimer >= fighter.telegraphDuration) {
    const punchType = fighter.telegraphPunchType;
    fighter.telegraphPhase = "none";
    fighter.telegraphTimer = 0;
    fighter.telegraphDuration = 0;
    fighter.telegraphPunchType = null;
    fighter.telegraphIsFeint = false;
    fighter.telegraphIsCharged = false;
    return punchType;
  }
  return null;
}

function updateHeadSlide(fighter: FighterState, dt: number): void {
  if (fighter.telegraphHeadSlidePhase === "none") return;
  const arch = fighter.archetype;

  if (fighter.telegraphHeadSlidePhase === "sliding") {
    fighter.telegraphHeadSlideTimer += dt;
    if (fighter.telegraphHeadSlideTimer >= fighter.telegraphHeadSlideDuration) {
      fighter.telegraphHeadSlideTimer = fighter.telegraphHeadSlideDuration;
      if (arch === "BoxerPuncher" || arch === "Swarmer") {
        fighter.telegraphHeadSlidePhase = "holding";
        fighter.telegraphHeadHoldTimer = 0;
      } else {
        fighter.telegraphHeadSlidePhase = "returning";
        fighter.telegraphHeadSlideTimer = 0;
      }
    }
  } else if (fighter.telegraphHeadSlidePhase === "returning") {
    fighter.telegraphHeadSlideTimer += dt;
    if (fighter.telegraphHeadSlideTimer >= fighter.telegraphHeadSlideDuration) {
      fighter.telegraphHeadSlidePhase = "none";
      fighter.telegraphHeadSlideTimer = 0;
      fighter.telegraphHeadSlideX = 0;
      fighter.telegraphHeadSlideY = 0;
    }
  } else if (fighter.telegraphHeadSlidePhase === "holding") {
    const holdThreshold = levelScale(fighter.level, 1.0, 1.3);
    if (fighter.timeSinceLastPunch >= holdThreshold) {
      fighter.telegraphHeadSlidePhase = "returning";
      fighter.telegraphHeadSlideTimer = 0;
    }
  }
}

export function getHeadSlideOffset(fighter: FighterState): { x: number; y: number } {
  if (fighter.telegraphHeadSlidePhase === "none") return { x: 0, y: 0 };
  const dur = fighter.telegraphHeadSlideDuration;
  const t = fighter.telegraphHeadSlideTimer;

  if (fighter.telegraphHeadSlidePhase === "sliding") {
    const prog = dur > 0 ? Math.min(1, t / dur) : 1;
    return { x: fighter.telegraphHeadSlideX * prog, y: fighter.telegraphHeadSlideY * prog };
  } else if (fighter.telegraphHeadSlidePhase === "holding") {
    return { x: fighter.telegraphHeadSlideX, y: fighter.telegraphHeadSlideY };
  } else if (fighter.telegraphHeadSlidePhase === "returning") {
    const prog = dur > 0 ? Math.min(1, t / dur) : 1;
    return { x: fighter.telegraphHeadSlideX * (1 - prog), y: fighter.telegraphHeadSlideY * (1 - prog) };
  }
  return { x: 0, y: 0 };
}

function updateFighterTelegraph(fighter: FighterState, state: GameState, actor: "player" | "enemy", dt: number): void {
  fighter.timeSinceLastPunch += dt;
  if (fighter.feintTelegraphDisableTimer > 0) {
    fighter.feintTelegraphDisableTimer -= dt;
    if (fighter.feintTelegraphDisableTimer < 0) fighter.feintTelegraphDisableTimer = 0;
  }

  updateHeadSlide(fighter, dt);

  if (fighter.telegraphPhase === "none") return;

  const savedIsFeint = fighter.telegraphIsFeint;
  const savedIsCharged = fighter.telegraphIsCharged;
  const completedPunch = updateTelegraph(fighter, dt);
  if (completedPunch) {
    const isFeint = savedIsFeint;
    const isCharged = savedIsCharged;
    if (attemptPunch(fighter, completedPunch, isFeint, isCharged, false, state.practiceMode, state.roundDuration - state.roundTimer)) {
      if (actor === "player") {
        state.roundStats.playerPunchesThisRound++;
      } else {
        state.roundStats.enemyPunchesThisRound++;
      }
      recordEvent(state, isFeint ? "feint" : "punch", actor, { punch: completedPunch, feint: isFeint, charged: isCharged, body: !fighter.punchAimsHead, rePunch: false });
    }
  }
}

function attemptPunch(fighter: FighterState, punchType: PunchType, isFeint: boolean = false, isCharged: boolean = false, isRePunch: boolean = false, practiceMode: boolean = false, roundElapsed: number = 999): boolean {
  if (fighter.isKnockedDown) return false;

  if (!isRePunch && (fighter.isPunching || fighter.punchCooldown > 0)) return false;
  if (isRePunch && fighter.punchPhase !== "retraction") return false;
  if (isRePunch && fighter.retractionProgress < 0.75) return false;
  if (fighter.stunPunchDisableTimer > 0) return false;
  if (fighter.miniStunTimer > 0) return false;
  if (isCharged && roundElapsed < 10) return false;
  if (isCharged && !fighter.chargeArmed) return false;
  if (isCharged && fighter.chargeMeterBars < 1) {
    isCharged = false;
    fighter.chargeArmed = false;
    fighter.chargeUsesLeft = 0;
    fighter.chargeArmTimer = 0;
  }
  if (isFeint && (punchType === "leftUppercut" || punchType === "rightUppercut")) return false;
  if (fighter.stunBlockDisableTimer > 0 && !isFeint) {
    fighter.defenseState = "none";
  }

  computeSwayZoneMults(fighter);

  const config = getEffectivePunchConfig(punchType);
  let cost = config.staminaCost * fighter.staminaCostMult;
  if (isFeint) cost *= 0.3;
  if (isCharged) {
    cost *= CHARGE_STAMINA_COST_MULT;
    if (fighter.consecutiveChargeCount > 0) {
      cost *= (1 + fighter.consecutiveChargeCount * CHARGE_CONSECUTIVE_EXTRA_COST);
    }
  }
  if (fighter.isPunchFatigued) cost *= 2;
  if (fighter.isPlayer) cost *= 0.85;

  if (fighter.defenseState === "fullGuard" && !isFeint) {
    fighter.halfGuardPunch = true;
  }

  if (practiceMode) {
    if (fighter.stamina < cost) {
      cost = 0;
    }
    fighter.stamina = Math.max(1, fighter.stamina - cost);
  } else {
    if (fighter.stamina < cost * 0.5 && fighter.stamina > 1) return false;
    fighter.stamina = Math.max(1, fighter.stamina - cost);
  }
  fighter.currentPunchStaminaCost = cost;

  const now = performance.now() / 1000;
  fighter.recentPunchTimestamps.push(now);
  fighter.recentPunchTimestamps = fighter.recentPunchTimestamps.filter(t => now - t < 2);
  if (fighter.recentPunchTimestamps.length >= 6) {
    fighter.isPunchFatigued = true;
    fighter.punchFatigueTimer = levelScale(fighter.level, 1.5, 0.5);
  }

  fighter.isPunching = true;
  fighter.currentPunch = punchType;
  fighter.punchProgress = 0;
  fighter.punchPhase = "launchDelay";
  fighter.punchPhaseTimer = 0;
  fighter.punchTravelStartTime = gameElapsedTime;
  fighter.isRePunch = isRePunch;
  fighter.retractionProgress = 0;
  fighter.punchesThrown++;
  fighter.isFeinting = isFeint;
  fighter.isCharging = isCharged;
  if (isFeint) {
    fighter.feintTelegraphDisableTimer = 0.5;
  }
  if (!isFeint) soundEngine.punchWhoosh();
  if (isCharged) {
    fighter.chargeUsesLeft--;
    if (fighter.chargeUsesLeft <= 0) {
      fighter.chargeArmed = false;
      fighter.chargeUsesLeft = 0;
      fighter.chargeArmTimer = 0;
    }
    fighter.chargeReady = false;
    fighter.chargeMeterBars--;
    if (fighter.chargeMeterBars >= 1) {
      fighter.chargeEmpoweredTimer = fighter.chargeEmpoweredDuration;
    } else {
      fighter.chargeEmpoweredTimer = 0;
    }
  }

  if (fighter.defenseState !== "fullGuard" && fighter.defenseState !== "duck") {
    fighter.defenseState = "none";
  }
  return true;
}

function tryHit(
  attacker: FighterState, defender: FighterState, state: GameState
): { hit: boolean; damage: number; blocked: boolean; isCrit?: boolean; isStun?: boolean; isHeadHit?: boolean; punchTravelTime?: number } {
  if (!attacker.currentPunch) return { hit: false, damage: 0, blocked: false };

  if (attacker.isFeinting) {
    if (state.cpuVsCpu) {
      state.hitEffects.push({
        x: attacker.x + attacker.facing * 30,
        y: attacker.z - 25,
        timer: 0.5,
        type: "feint",
        text: "FEINT",
      });
    }
    return { hit: false, damage: 0, blocked: false };
  }

  const config = getEffectivePunchConfig(attacker.currentPunch);
  const rhythmBuffs = getRhythmBuffs(attacker);
  const dist = getDistance(attacker, defender);

  const attackerDucking = attacker.defenseState === "duck";
  const punchHitsHead = attackerDucking ? (attacker.punchAimsHead && config.hitsHead) : config.hitsHead;

  const armReachBonus = (attacker.armLength - 65) * 1.5;
  const effectiveRange = (config.range + 20 + armReachBonus) * rhythmBuffs.rangeMult;
  if (dist > effectiveRange) { soundEngine.whiff(); return { hit: false, damage: 0, blocked: false }; }
  if (defender.isKnockedDown) return { hit: false, damage: 0, blocked: false };

  const inPerfectRange = dist <= effectiveRange && dist >= effectiveRange * 0.6;

  if (!inPerfectRange && rhythmBuffs.whiffChance > 0 && Math.random() < rhythmBuffs.whiffChance) {
    state.hitEffects.push({
      x: attacker.x + attacker.facing * 30,
      y: attacker.z - 25,
      timer: 0.4,
      type: "normal",
      text: "MISS",
    });
    soundEngine.whiff();
    return { hit: false, damage: 0, blocked: false };
  }

  if (!attacker.isPlayer && state.aiBrain) {
    const aiWhiffRates: Record<string, number> = { "Easy": 0.20, "Medium": 0.15, "Hard": 0.10, "Hardcore": 0.05 };
    const aiWhiff = (aiWhiffRates[state.aiBrain.difficultyBand] || 0.10) + state.enemyWhiffBonus;
    if (Math.random() < aiWhiff) {
      return { hit: false, damage: 0, blocked: false };
    }
  }

  const isDucking = defender.defenseState === "duck";
  // Uppercuts pierce through duck defense and still hit the head
  const isUppercut = attacker.currentPunch?.includes("Uppercut");
  if (punchHitsHead && isDucking && !isUppercut) {
    if (defender.isPlayer) {
      state.roundStats.playerPunchesDodged++;
      state.roundStats.playerDuckDodges++;
      state.roundStats.playerConsecutiveLanded = 0;
      if (state.aiBrain) {
        state.aiBrain.lastPunchDodgedTimer = 0.6;
      }
      if (state.behaviorProfile) {
        state.behaviorProfile.playerLastDodgeTime = state.fightElapsedTime;
      }
    } else {
      state.roundStats.enemyPunchesDodged++;
    }
    recordEvent(state, "dodge", defender.isPlayer ? "player" : "enemy", {
      punch: attacker.currentPunch, method: "duck",
    });
    return { hit: false, damage: 0, blocked: false };
  }

  const weaveActive = defender.weaveActive && defender.weaveProgress < 1;
  if (punchHitsHead && weaveActive) {
    if (defender.defenseState === "fullGuard") {
      return { hit: false, damage: 0, blocked: true };
    }
    if (defender.isPlayer) {
      state.roundStats.playerPunchesDodged++;
      state.roundStats.playerConsecutiveLanded = 0;
      if (state.aiBrain) {
        state.aiBrain.lastPunchDodgedTimer = 0.6;
      }
      if (state.behaviorProfile) {
        state.behaviorProfile.playerLastDodgeTime = state.fightElapsedTime;
      }
    } else {
      state.roundStats.enemyPunchesDodged++;
    }
    defender.weaveCounterTimer = 0.8;
    recordEvent(state, "dodge", defender.isPlayer ? "player" : "enemy", {
      punch: attacker.currentPunch, method: "weave",
    });
    return { hit: false, damage: 0, blocked: false };
  }

  let blocked = false;
  let blockReduction = 0;

  const punchDurations = getPunchPhaseDurations(attacker, config, attacker.isRePunch);
  const totalPreContactTime = punchDurations.launchDelay + punchDurations.armSpeed;

  const isHeadPunch = punchHitsHead && !isDucking;
  const isBodyPunch = !punchHitsHead || isDucking;
  const highGuardUp = defender.defenseState === "fullGuard";
  const lowGuardUp = defender.defenseState === "none" && !defender.handsDown;

  if ((highGuardUp && isHeadPunch) || (lowGuardUp && isBodyPunch)) {
    blocked = true;
    const levelT = Math.min(1, Math.max(0, (defender.level - 1) / 99));
    const baseBlock = highGuardUp ? (0.40 + levelT * 0.30) : (0.30 + levelT * 0.20);
    blockReduction = baseBlock * defender.blockMult;
    blockReduction = Math.min(blockReduction, 0.95);
    if (highGuardUp && !defender.autoGuardActive && defender.timeSinceGuardRaised < totalPreContactTime) {
      const inRhythmWeak = defender.rhythmLevel > 0 &&
        defender.rhythmProgress >= 0.35 && defender.rhythmProgress <= 0.65;
      const extraFrac = inRhythmWeak ? 0.10 : 0.50;
      blockReduction = Math.min(0.95, blockReduction + (1 - blockReduction) * extraFrac);
    }
  }

  if (blocked && defender.punchingWhileBlocking) {
    blockReduction *= 0.75;
  }

  if (blocked && defender.stunBlockWeakenTimer > 0) {
    blockReduction *= STUN_BLOCK_WEAKEN_MULT;
  }

  if (blocked && attacker.swayZone === "power") {
    const levelDisc = Math.max(0, attacker.level - defender.level);
    const bypassChance = Math.min(0.90, 0.30 + attacker.level * 0.0025 + levelDisc * 0.02);
    if (Math.random() < bypassChance) {
      blocked = false;
      blockReduction = 0;
    }
  }

  if (!punchHitsHead && isDucking) {
    blockReduction = Math.max(blockReduction, 0.3);
  }

  const weaveCounter = attacker.weaveCounterTimer > 0;
  if (weaveCounter) {
    blocked = false;
    blockReduction = 0;
    attacker.weaveCounterTimer = 0;
  }

  let damage = config.damage * attacker.damageMult;
  if (attacker.isPlayer) damage *= 1.03;
  damage *= attacker.swayDamageMult;
  if (weaveCounter) damage *= 3;

  const shortArmBonus = attacker.armLength < 65 ? 1 + (65 - attacker.armLength) * 0.02 : 1;
  damage *= shortArmBonus;

  const punchType = attacker.currentPunch;
  if (punchType === "jab") damage *= rhythmBuffs.jabDamageMult;
  if (punchType === "cross") damage *= rhythmBuffs.crossDamageMult;
  if (punchType === "leftHook" || punchType === "rightHook") damage *= rhythmBuffs.hookDamageMult;

  const insideRange = dist < effectiveRange * 0.6;
  if (insideRange) {
    if (punchType === "leftHook" || punchType === "rightHook" || punchType === "leftUppercut" || punchType === "rightUppercut") {
      damage *= 1.15;
    } else if (punchType === "jab" || punchType === "cross") {
      damage *= 0.85;
    }
  }

  if (attacker.isCharging) {
    const chargeMult = CHARGE_DAMAGE_MIN + Math.random() * (CHARGE_DAMAGE_MAX - CHARGE_DAMAGE_MIN);
    damage *= chargeMult;
    if (attacker.chargeEmpoweredTimer > 0) {
      damage *= 1.5;
      attacker.chargeEmpoweredTimer = 0;
    }
  }

  if (attacker.halfGuardPunch) {
    damage *= 0.7;
  }

  if (attacker.isRePunch) {
    damage *= 0.75;
  }

  if (blocked) {
    damage *= (1 - blockReduction);
  }

  if (defender.stance === "backFoot") {
    damage *= 1.07;
  }

  const isHeadHit = punchHitsHead && !isDucking;
  let baseCritChance = isHeadHit ? HEAD_CRIT_CHANCE : BODY_CRIT_CHANCE;
  baseCritChance *= levelScale(attacker.level, 1, 1.5);
  baseCritChance *= rhythmBuffs.accuracyMult;
  const levelAdv = attacker.level - defender.level;
  if (levelAdv > 0) {
    baseCritChance += levelAdv * 0.002;
  }
  const defenderGuardDown = defender.handsDown && !defender.isPunching;
  if (defenderGuardDown) baseCritChance *= NO_GUARD_CRIT_MULT;
  if (attacker === state.enemy) baseCritChance *= 0.35;
  if (attacker === state.enemy && !state.isQuickFight && !state.practiceMode) baseCritChance *= 0.5;
  if (attacker === state.player && !state.isQuickFight && !state.practiceMode) baseCritChance *= 0.5;
  baseCritChance *= Math.max(0, defender.critResistMult);
  baseCritChance *= attacker.critMult;
  if (attacker.swaySpeedLevel === 0) {
    baseCritChance *= 0.9;
  }
  baseCritChance = Math.min(1, Math.max(0, baseCritChance));
  const isCrit = Math.random() < baseCritChance;
  if (isCrit) {
    damage *= CRIT_DAMAGE_MULT;
  }

  let isStun = false;
  const isAi = attacker === state.enemy;
  let stunChance: number;
  if (attacker.isCharging) {
    stunChance = isAi ? 0.25 * 0.25 : 0.50;
  } else {
    stunChance = isAi ? BASE_STUN_CHANCE * 0.5 * 0.25 : BASE_STUN_CHANCE;
  }
  stunChance *= Math.max(0, defender.critResistMult);
  stunChance *= attacker.stunMult;
  // AutoGuard at rhythm weak zone (35-65%): 2x stun chance
  if (defender.autoGuardActive && defender.rhythmLevel > 0 &&
      defender.rhythmProgress >= 0.35 && defender.rhythmProgress <= 0.65) {
    stunChance *= 2.0;
  }
  if (defender.feintDuckTouchingOpponent) {
    stunChance *= 2.0;
  }
  stunChance = Math.max(0, stunChance);
  isStun = Math.random() < stunChance;

  return { hit: true, damage, blocked, isCrit, isStun, isHeadHit, punchTravelTime: totalPreContactTime };
}

function applyStunEffects(target: FighterState, isAi: boolean = false): void {
  target.moveSlowMult = STUN_MOVE_SLOW_MULT;
  target.moveSlowTimer = STUN_MOVE_SLOW_DURATION;
  target.regenPauseTimer = Math.max(target.regenPauseTimer, STUN_REGEN_DISABLE_DURATION);
  target.stunBlockDisableTimer = STUN_BLOCK_DISABLE_DURATION;
  target.stunBlockWeakenTimer = STUN_BLOCK_WEAKEN_DURATION;
  target.stunPunchSlowMult = STUN_PUNCH_SLOW_MULT;
  target.stunPunchSlowTimer = STUN_PUNCH_SLOW_DURATION;
  target.stunPunchDisableTimer = STUN_PUNCH_DISABLE_DURATION;
  target.chargeMeterLockoutTimer = 3.0;
  if (!isAi) {
    target.rhythmLevel = 0;
    target.rhythmProgress = 0;
  }
  target.stance = "neutral";
}

function toPunchSound(punch: PunchType | null): PunchSoundType {
  if (!punch) return "jab";
  if (punch === "cross") return "jab";
  if (punch.includes("Hook")) return "hook";
  if (punch.includes("Uppercut")) return "uppercut";
  return "jab";
}

function applyHit(attacker: FighterState, defender: FighterState, state: GameState): void {
  if (state.tutorialMode && !state.tutorialFightUnlocked && attacker.isPlayer) {
    return;
  }
  const result = tryHit(attacker, defender, state);
  if (!result.hit) {
    state.cleanHitStreak = 0;
    if (attacker.isPlayer) {
      state.roundStats.playerConsecutiveLanded = 0;
    }
    if (attacker.isCharging) {
      attacker.retractionPenaltyMult = Math.max(attacker.retractionPenaltyMult, 1 / CHARGE_WHIFF_RETRACT_SLOW);
      attacker.moveSlowMult = 0.40;
      attacker.moveSlowTimer = 2.0;
      attacker.regenPauseTimer = Math.max(attacker.regenPauseTimer, 1.0);
      attacker.chargeReady = false;
      attacker.chargeReadyWindowTimer = 0;
    }
    if (attacker.currentPunch && defender.isFeinting && attacker.feintWhiffPenaltyCooldown <= 0) {
      const config = getEffectivePunchConfig(attacker.currentPunch);
      const dist = getDistance(attacker, defender);
      const inRange = dist <= (config.range + 20) * 1.15;
      if (inRange) {
        defender.feintBaits++;
        attacker.retractionPenaltyMult = 2;
        attacker.feintWhiffPenaltyCooldown = 0.5;
        attacker.feintedTelegraphBoost = levelScale(attacker.level, 0.20, 0.05);
        attacker.telegraphFeintRoundPenalty += 0.025;
        state.hitEffects.push({
          x: attacker.x + attacker.facing * 20,
          y: attacker.z - 25,
          timer: 0.6,
          type: "normal",
          text: "BAITED",
        });
      }
    }
    if (state.aiBrain && attacker.currentPunch) {
      const config = getEffectivePunchConfig(attacker.currentPunch);
      const dist = getDistance(attacker, defender);
      const inRange = dist <= (config.range + 20) * 1.15;
      notifyAiPunchWhiffed(state.aiBrain, attacker.isPlayer, inRange);
      // Snapshot whiff context for the AI's own punch misses
      if (!attacker.isPlayer) {
        notifyAiWhiffContext(state.aiBrain, dist, defender.defenseState === "duck", defender.swaySpeedLevel);
      }
      if (attacker.isPlayer && state.playerAiBrain) {
        notifyAiWhiffContext(state.playerAiBrain, dist, defender.defenseState === "duck", defender.swaySpeedLevel);
      }
    }
    return;
  }
  if (result.hit) {
    attacker.timeSinceLastPunch = 0; // reset on punch landed (blocked or clean)
    const rawDamage = result.damage;
    const staminaBefore = defender.stamina;
    defender.stamina = Math.max(1, defender.stamina - rawDamage);
    let actualDamage = staminaBefore - defender.stamina;
    attacker.punchesLanded++;
    attacker.timeSinceLastLanded = 0;
    defender.timeSinceLastLanded = Infinity;
    defender.timeSinceLastDamageTaken = 0;
    defender.damageTakenRegenPauseFired = false;
    attacker.unansweredStreak++;
    defender.unansweredStreak = 0;
    const actualTravelMs = attacker.punchTravelStartTime > 0 ? Math.round((gameElapsedTime - attacker.punchTravelStartTime) * 1000) : Math.round((result.punchTravelTime || 0) * 1000);
    if (result.blocked) {
      recordEvent(state, "block", defender.isPlayer ? "player" : "enemy", {
        punch: attacker.currentPunch, damage: Math.round(actualDamage), blocked: true,
        punchTravelMs: actualTravelMs,
      });
      defender.blockFlashTimer = 0.1;
    } else {
      attacker.cleanPunchesLanded++;
      recordEvent(state, "hit", attacker.isPlayer ? "player" : "enemy", {
        punch: attacker.currentPunch, damage: Math.round(actualDamage), crit: !!result.isCrit, stun: !!result.isStun, body: !attacker.punchAimsHead,
        punchTravelMs: actualTravelMs,
      });
    }
    if (attacker.isPlayer) {
      state.roundStats.playerConsecutiveLanded++;
      if (state.roundStats.playerConsecutiveLanded >= 3) {
        state.roundStats.playerComboCount++;
      }
    } else {
      state.roundStats.playerConsecutiveLanded = 0;
    }
    const staminaRefund = attacker.currentPunchStaminaCost * 0.4;
    attacker.stamina = Math.min(attacker.maxStamina, attacker.stamina + staminaRefund);
    attacker.damageDealt += actualDamage;

    if (attacker.isPlayer && (state.careerFightMode || state.sparringMode) && !state.isQuickFight && !state.practiceMode) {
      const diffMults: Record<string, number> = { journeyman: 0.8, contender: 1.0, elite: 1.35, champion: 1.75 };
      const diffMult = diffMults[state.aiDifficulty] || 1.0;
      const levelGap = state.enemyLevel - state.playerLevel;
      const levelGapMult = Math.max(0.7, Math.min(2.0, 1 + levelGap * 0.04));
      const punchXp = Math.max(1, Math.floor((8 + actualDamage * 2) * diffMult * levelGapMult * 0.7));
      checkMidFightLevelUp(state, punchXp);
    }

    if (attacker.isCharging) {
      attacker.chargeReady = false;
      attacker.chargeReadyWindowTimer = 0;
      attacker.regenPauseTimer = Math.max(attacker.regenPauseTimer, CHARGE_SELF_REGEN_PAUSE);
      attacker.consecutiveChargeCount++;
      attacker.consecutiveChargeTimer = CHARGE_CONSECUTIVE_WINDOW;
      if (!result.blocked) {
        const chargeFacingLock = 0.5 - defender.focusT * 0.3;
        defender.facingLockTimer += chargeFacingLock;
      }
    }

    defender.isHit = true;
    defender.hitTimer = 0.15;
    if (!result.blocked) {
      defender.cleanHitEyeTimer = 0.2;
      const facingLockBase = 0.4 - defender.focusT * 0.36;
      defender.facingLockTimer += facingLockBase;
      if (defender.isBlinking) {
        defender.rhythmLevel = 2;
        defender.rhythmProgress = 0;
      }
    }

    if (defender.chargeArmed) {
      defender.chargeArmed = false;
      defender.chargeUsesLeft = 0;
      defender.chargeArmTimer = 0;
      defender.chargeMeterBars = Math.max(0, defender.chargeMeterBars - 1);
    }

    const defenderRhythmBuffs = getRhythmBuffs(defender);
    const basePause = 0.8;
    const rhythmPause = defender.defenseState === "duck" ? 0 : defenderRhythmBuffs.hitStaminaPauseDuration;
    defender.regenPauseTimer = Math.max(defender.regenPauseTimer, basePause);
    if (rhythmPause > 0) {
      defender.staminaPauseFromRhythm = Math.max(defender.staminaPauseFromRhythm, rhythmPause);
    }

    if (result.isCrit && !result.blocked) {
      defender.regenPauseTimer = Math.max(defender.regenPauseTimer, CRIT_REGEN_PAUSE);
      defender.moveSlowMult = CRIT_MOVE_SLOW_MULT;
      defender.moveSlowTimer = Math.max(defender.moveSlowTimer, CRIT_MOVE_SLOW_DURATION);
      defender.critHitTimer = 0.15;
      if (!defender.isPlayer && state.aiBrain) {
        notifyAiStunOrCrit(state.aiBrain, defender);
      }
      if (defender.isPlayer && state.playerAiBrain) {
        notifyAiStunOrCrit(state.playerAiBrain, defender);
      }
    }

    if (result.isStun && !result.blocked) {
      applyStunEffects(defender, !defender.isPlayer);
      const stunFacingLock = 0.5 - defender.focusT * 0.3;
      defender.facingLockTimer += stunFacingLock;
      if (!defender.isPlayer && state.aiBrain) {
        notifyAiStunOrCrit(state.aiBrain, defender);
      }
      if (defender.isPlayer && state.playerAiBrain) {
        notifyAiStunOrCrit(state.playerAiBrain, defender);
      }
    }

    if (result.blocked) {
      defender.blockRegenPenaltyTimer = defender.blockRegenPenaltyDuration;
      if (defender.isPlayer) {
        state.roundStats.playerPunchesBlocked++;
        if (state.tutorialMode) {
          state.tutorialTracking.punchesBlocked++;
        }
      } else {
        state.roundStats.enemyPunchesBlocked++;
      }
    }

    if (defender.rhythmLevel > 0 && !result.blocked) {
      if (defender.rhythmProgress < 0.9) {
        const pushDist = 8 + Math.random() * 7;
        const dx = defender.x - attacker.x;
        const dz = defender.z - attacker.z;
        const len = Math.sqrt(dx * dx + dz * dz);
        if (len > 0.01) {
          const pushSpeed = pushDist / 0.12;
          defender.pushbackVx = (dx / len) * pushSpeed;
          defender.pushbackVz = (dz / len) * pushSpeed;
        }
      }
      defender.rhythmProgress = 0;
      defender.rhythmDirection = 1;
    }
    if (defender.rhythmLevel === 0 && defender.stance !== "neutral") {
      defender.stance = "neutral";
    }

    if (attacker.isPlayer) {
      state.roundStats.playerDamageThisRound += actualDamage;
      state.roundStats.playerLandedThisRound++;
    } else {
      state.roundStats.enemyDamageThisRound += actualDamage;
      state.roundStats.enemyLandedThisRound++;
    }

    {
      const defBrain = defender.isPlayer ? state.playerAiBrain : state.aiBrain;
      if (defBrain && !result.blocked) {
        const zone: "head" | "body" = attacker.punchAimsHead ? "head" : "body";
        defBrain.guardConditioningMemory.push({ zone, damage: actualDamage, time: defBrain.gameTime });
        if (defBrain.guardConditioningMemory.length > defBrain.guardConditioningMax) {
          defBrain.guardConditioningMemory.shift();
        }
      }
    }

    if (attacker.chargeMeterLockoutTimer <= 0) {
      let meterGain = result.blocked ? 1 : 2;
      attacker.chargeMeterCounters += meterGain;
      while (attacker.chargeMeterCounters >= 30 && attacker.chargeMeterBars < 6) {
        attacker.chargeMeterCounters -= 30;
        attacker.chargeMeterBars++;
      }
      if (attacker.chargeMeterBars >= 6) attacker.chargeMeterCounters = 0;
    }

    if (!result.blocked) {
      const pushAngle = attacker.facingAngle;
      const pushAmount = Math.min(12, actualDamage * 0.3);
      defender.x += Math.cos(pushAngle) * pushAmount;
      defender.z += Math.sin(pushAngle) * pushAmount;
      clampToDiamond(defender);

      const defSwayNorm = Math.abs(defender.swayOffset) / 5;
      const defLeavingFoot = defender.swayDir * defender.swayOffset < 0;
      const defIsOffBalance = defender.swaySpeedLevel > 0 && !defender.swayFrozen
        && defSwayNorm >= 0.1 && defSwayNorm < 0.9 && defLeavingFoot;
      if (defIsOffBalance) {
        const levelDisc = Math.max(0, attacker.level - defender.level);
        const miniStunChance = Math.min(0.9, 0.25 + levelDisc * 0.005 + defender.level * 0.001);
        if (Math.random() < miniStunChance) {
          const slideAngle = attacker.facingAngle;
          const oldX = defender.x;
          const oldZ = defender.z;
          defender.x += Math.cos(slideAngle) * 5;
          defender.z += Math.sin(slideAngle) * 5;
          clampToDiamond(defender);
          const slid = Math.sqrt((defender.x - oldX) ** 2 + (defender.z - oldZ) ** 2);
          if (slid < 5) {
            defender.x = oldX + Math.cos(slideAngle) * slid;
            defender.z = oldZ + Math.sin(slideAngle) * slid;
            clampToDiamond(defender);
          }

          defender.miniStunTimer = 0.75;
          const bonusDmg = actualDamage * 0.2;
          const staminaBeforeMiniStun = defender.stamina;
          defender.stamina = Math.max(1, defender.stamina - bonusDmg);
          const miniStunActual = staminaBeforeMiniStun - defender.stamina;
          actualDamage += miniStunActual;
          attacker.damageDealt += miniStunActual;
          if (attacker.isPlayer) {
            state.roundStats.playerDamageThisRound += miniStunActual;
          } else {
            state.roundStats.enemyDamageThisRound += miniStunActual;
          }

          defender.swayOffset = defender.swayDir * 5;
          defender.rhythmPauseTimer = 1.0;

          if (!defender.isPlayer && state.aiBrain) notifyAiStunOrCrit(state.aiBrain, defender);
          if (defender.isPlayer && state.playerAiBrain) notifyAiStunOrCrit(state.playerAiBrain, defender);

          if (!defender.isPlayer && state.aiBrain) notifyAiRangeDisrupt(state.aiBrain);
          if (defender.isPlayer && state.playerAiBrain) notifyAiRangeDisrupt(state.playerAiBrain);
        }
      }
    }

    state.shakeIntensity = result.blocked ? 2 : Math.min(8, actualDamage * 0.4);
    state.shakeTimer = 0.15;

    const effectType = result.blocked ? "block" : (result.isStun || result.isCrit ? "crit" : (actualDamage > 20 ? "crit" : "normal"));
    const effectText = result.blocked ? "BLOCK" : (result.isStun && result.isCrit ? "CRIT STUN!" : (result.isStun ? "STUN!" : (result.isCrit ? "CRIT!" : Math.round(actualDamage).toString())));
    state.hitEffects.push({
      x: defender.x + defender.facing * 10,
      y: defender.z - 25 + (Math.random() - 0.5) * 15,
      timer: 0.6,
      type: effectType,
      text: effectText,
    });

    const hasCrowd = !state.practiceMode && !state.sparringMode;
    const canCheer = hasCrowd && (attacker.isPlayer || state.cpuVsCpu);
    const pSound = toPunchSound(attacker.currentPunch);
    const isP = attacker.isPlayer;

    if (result.blocked) {
      soundEngine.punchLandBlocked(pSound, isP);
      state.cleanHitStreak = 0;
    } else if (attacker.isCharging) {
      soundEngine.chargePunchLand(pSound, isP);
      if (hasCrowd) soundEngine.crowdOoh(0.5);
      const punchName = attacker.currentPunch || "jab";
      const hitstopDur = punchName === "jab" ? 0.1 : punchName === "cross" ? 0.15 : (punchName.includes("Hook") ? 0.18 : 0.2);
      state.hitstopTimer = hitstopDur;
      state.hitstopDuration = hitstopDur;
      state.shakeIntensity = Math.min(12, actualDamage * 0.6);
      state.shakeTimer = hitstopDur + 0.1;
      state.cleanHitStreak = 1;
      if (canCheer) soundEngine.playCheer(1);
    } else if (result.isStun && result.isCrit) {
      soundEngine.stunLand(pSound, isP);
      if (hasCrowd) soundEngine.crowdOoh(0.5);
      state.cleanHitStreak = 1;
      if (canCheer) soundEngine.playCheer(1);
    } else if (result.isStun) {
      soundEngine.stunLand(pSound, isP);
      if (hasCrowd) soundEngine.crowdOoh(0.5);
      state.cleanHitStreak = 1;
      if (canCheer) soundEngine.playCheer(1);
    } else if (result.isCrit) {
      soundEngine.critLand(pSound, isP);
      if (hasCrowd) soundEngine.crowdOoh(0.5);
      state.cleanHitStreak = 1;
      if (canCheer) soundEngine.playCheer(1);
    } else {
      soundEngine.punchLandClean(pSound, isP);
      state.cleanHitStreak++;
      if (canCheer && state.cleanHitStreak >= 2) {
        soundEngine.playCheer(state.cleanHitStreak >= 3 ? 3 : 2);
      }
    }

    const punchName = attacker.currentPunch || "jab";
    const isJab = punchName === "jab";
    const jabExciting = attacker.isCharging || result.isCrit || result.isStun;
    if (!result.blocked && hasCrowd && (!isJab || jabExciting)) {
      state.crowdExciteTimer = 3.0;
      soundEngine.crowdSurge();
    }

    if (defender.stance === "frontFoot" && !result.blocked) {
      attacker.speedBoostTimer = 2.0;
    }

    if (state.aiBrain) {
      const config = getEffectivePunchConfig(attacker.currentPunch!);
      const hitHead = config.hitsHead && defender.defenseState !== "duck";
      const isPlayerPunch = attacker.isPlayer;
      notifyAiHitLanded(state.aiBrain, isPlayerPunch, hitHead);
      if (result.blocked) {
        notifyAiBlockContact(state.aiBrain, true);
        // Blocked = unclean hit; snapshot context for whiff learning (only for AI's punch)
        if (!isPlayerPunch) {
          const bDist = getDistance(attacker, defender);
          notifyAiWhiffContext(state.aiBrain, bDist, defender.defenseState === "duck", defender.swaySpeedLevel);
        }
      }
      // Crit or stun against the AI: roll escalating chance to forget learnt range
      if (isPlayerPunch && !result.blocked && (result.isCrit || result.isStun)) {
        notifyAiRangeDisrupt(state.aiBrain);
      }
    }
    // CPU-vs-CPU: disrupt player AI's learnt range if they got crit/stunned
    if (state.playerAiBrain && !attacker.isPlayer && !result.blocked && (result.isCrit || result.isStun)) {
      notifyAiRangeDisrupt(state.playerAiBrain);
    }

    if (defender.stamina <= 1 && state.sparringMode) {
      defender.isKnockedDown = true;
      defender.knockdowns++;
      attacker.knockdownsGiven++;
      if (attacker.isPlayer && (state.careerFightMode || state.sparringMode) && !state.isQuickFight && !state.practiceMode) {
        checkMidFightLevelUp(state, 80);
      }
      state.kdSequence.push(defender.isPlayer ? "player" : "enemy");
      if (defender.isPlayer) {
        state.roundStats.enemyKDsThisRound++;
        if (state.playerAiBrain) notifyAiKnockedDown(state.playerAiBrain);
      } else {
        state.roundStats.playerKDsThisRound++;
        state.totalEnemyKDs++;
        if (state.aiBrain) notifyAiKnockedDown(state.aiBrain);
      }
      for (const f of [state.player, state.enemy]) {
        f.isPunching = false;
        f.currentPunch = null;
        f.punchPhase = null;
        f.punchPhaseTimer = 0;
        f.punchProgress = 0;
        f.isFeinting = false;
        f.isCharging = false;
        f.defenseState = "none";
      }
      finalizeRoundRecording(state);
      const sparRoundScore = scoreRound(state);
      state.roundScores.push(sparRoundScore);
      rollNextRingCanvasColor();
      state.phase = "fightEnd";
      state.knockdownActive = true;
      state.fightTotalDuckDodges += state.roundStats.playerDuckDodges;
      state.fightTotalCombos += state.roundStats.playerComboCount;
      const sparStats = getTotalPunchStats(state);
      let sparPlayerScore = 0;
      let sparEnemyScore = 0;
      sparPlayerScore += sparStats.playerLanded * 2;
      sparEnemyScore += sparStats.enemyLanded * 2;
      sparPlayerScore += state.player.damageDealt;
      sparEnemyScore += state.enemy.damageDealt;
      sparPlayerScore += state.player.knockdownsGiven * 50;
      sparEnemyScore += state.enemy.knockdownsGiven * 50;
      if (sparPlayerScore > sparEnemyScore) {
        state.fightResult = "Decision";
        state.fightWinner = "player";
      } else if (sparEnemyScore > sparPlayerScore) {
        state.fightResult = "Decision";
        state.fightWinner = "enemy";
      } else {
        state.fightResult = "Draw";
        state.fightWinner = null;
      }
      state.xpGained = calculateXP(state);
      state.refereeVisible = false;
      return;
    } else if (defender.stamina <= 1 && !state.practiceMode && !state.sparringMode) {
      soundEngine.knockdown();
      soundEngine.crowdCheer(0.5);
      soundEngine.playCheer(1);
      defender.isKnockedDown = true;
      defender.knockdowns++;
      attacker.knockdownsGiven++;
      if (attacker.isPlayer && (state.careerFightMode || state.sparringMode) && !state.isQuickFight && !state.practiceMode) {
        checkMidFightLevelUp(state, 80);
      }
      attacker.kdRegenBoostActive = true;
      defender.telegraphKdMult *= 1.2;
      state.crowdKdBounceTimer = 10 + Math.random() * 10;
      state.kdSequence.push(defender.isPlayer ? "player" : "enemy");
      recordEvent(state, "knockdown", attacker.isPlayer ? "player" : "enemy", {
        punch: attacker.currentPunch, defenderStamina: Math.round(defender.stamina), kdCount: defender.knockdowns,
      });
      if (defender.isPlayer) {
        state.roundStats.enemyKDsThisRound++;
        if (state.playerAiBrain) notifyAiKnockedDown(state.playerAiBrain);
      } else {
        state.roundStats.playerKDsThisRound++;
        state.totalEnemyKDs++;
        if (state.aiBrain) notifyAiKnockedDown(state.aiBrain);
      }
      state.knockdownActive = true;
      state.knockdownMashCount = 0;
      state.knockdownMashTimer = 10.0;
      state.knockdownRefCount = 0;
      state.knockdownCountdown = 0;
      state.kdTimerExpired = false;

      const isBodyShot = !attacker.punchAimsHead;
      state.kdIsBodyShot = isBodyShot;
      state.kdTakeKnee = isBodyShot && aiRNG.chance(0.75);
      state.kdFaceRefActive = false;
      state.kdFaceRefTimer = 0;

      const kdCount = defender.knockdowns;
      if (kdCount >= 4 && !state.practiceMode && !state.sparringMode) {
        finalizeRoundRecording(state);
        rollNextRingCanvasColor();
      state.phase = "fightEnd";
        state.fightResult = "TKO";
        state.fightWinner = defender.isPlayer ? "enemy" : "player";
        state.fightTotalDuckDodges += state.roundStats.playerDuckDodges;
        state.fightTotalCombos += state.roundStats.playerComboCount;
        state.xpGained = calculateXP(state);
        state.refereeVisible = false;
      } else {
        if (defender.isPlayer) {
          state.knockdownMashRequired = kdCount === 1 ? 25 : kdCount === 2 ? 35 : 50;
        } else {
          state.knockdownMashRequired = kdCount <= 2 ? 25 : 45;
        }
      }
      if (!defender.isPlayer) {
        const chances = AI_KD_CHANCES[state.aiDifficulty];
        const getUpChance = kdCount === 1 ? chances.kd1 : kdCount === 2 ? chances.kd2 : chances.kd3;
        state.aiKdWillGetUp = (state.practiceMode || state.sparringMode) ? true : aiRNG.chance(getUpChance);
        if (state.aiDifficulty === "champion") {
          state.aiKdGetUpTime = kdCount === 1 ? aiRNG.range(1, 3) : kdCount === 2 ? aiRNG.range(3, 6) : aiRNG.range(6, 9.9);
        } else {
          state.aiKdGetUpTime = kdCount === 1 ? aiRNG.range(2, 5) : kdCount === 2 ? aiRNG.range(4, 7) : aiRNG.range(6, 9);
        }
      }
      state.shakeIntensity = 12;
      state.shakeTimer = 0.4;

      const standingFighter = defender.isPlayer ? state.enemy : state.player;
      const neutralCorner = getFarthestNeutralCorner(defender.x, defender.z);
      state.standingFighterTargetX = neutralCorner.x;
      state.standingFighterTargetZ = neutralCorner.z;

      state.savedDefenseState = standingFighter.defenseState;
      state.savedHandsDown = false;
      state.savedBlockTimer = standingFighter.blockTimer;
      state.savedStandingIsPlayer = standingFighter.isPlayer;

      state.kdSavedKnockedRhythmLevel = defender.rhythmLevel > 0 ? defender.rhythmLevel : 2;
      state.kdSavedStandingRhythmLevel = standingFighter.rhythmLevel > 0 ? standingFighter.rhythmLevel : 2;

      standingFighter.isPunching = false;
      standingFighter.currentPunch = null;
      standingFighter.punchPhase = null;
      standingFighter.punchPhaseTimer = 0;
      standingFighter.isFeinting = false;
      standingFighter.isCharging = false;
      standingFighter.chargeArmed = false;
      standingFighter.chargeUsesLeft = 0;
      standingFighter.chargeArmTimer = 0;
      standingFighter.retractionPenaltyMult = 1;
      standingFighter.defenseState = "none";
      standingFighter.punchProgress = 0;
      standingFighter.leftGloveOffset = { x: standingFighter.facing * 15, y: -5 };
      standingFighter.rightGloveOffset = { x: standingFighter.facing * 18, y: 0 };
      standingFighter.halfGuardPunch = false;
      standingFighter.punchingWhileBlocking = false;
      standingFighter.isRePunch = false;
      standingFighter.retractionProgress = 0;

      standingFighter.telegraphPhase = "none";
      standingFighter.telegraphTimer = 0;
      standingFighter.telegraphDuration = 0;
      if (standingFighter.isPlayer) {
        standingFighter.rhythmLevel = 0;
      }
      standingFighter.rhythmPauseTimer = 0;

      state.refereeVisible = true;
      state.refX = defender.x + 40;
      state.refZ = defender.z - 20;
    }
  }
}

const FEINT_HOLD_MAX = 3.0;
const FEINT_HOLD_STAM_PAUSE = 2.0;

function isFeintTouchingOpponent(fighter: FighterState, opponent: FighterState): boolean {
  if (!fighter.isFeinting || !fighter.isPunching) return false;
  if (fighter.punchPhase !== "linger") return false;
  const config = getEffectivePunchConfig(fighter.currentPunch!);
  const armReachBonus = (fighter.armLength - 65) * 1.5;
  const feintReach = (config.range + 20 + armReachBonus) * 0.3;
  const dist = getDistance(fighter, opponent);
  return dist <= feintReach;
}

function getFeintPunchFailChance(fighter: FighterState, state: GameState): number {
  if (fighter.isPlayer) {
    const levelT = Math.min(1, Math.max(0, (fighter.level - 1) / 99));
    return 0.60 - levelT * 0.30;
  } else {
    const diff = state.aiDifficulty;
    switch (diff) {
      case "journeyman": return 0.85;
      case "contender": return 0.80;
      case "elite": return 0.75;
      case "champion": return 0.70;
      default: return 0.75;
    }
  }
}

function updatePunch(fighter: FighterState, opponent: FighterState, state: GameState, dt: number): void {
  if (!fighter.isPunching || !fighter.currentPunch) return;

  const config = getEffectivePunchConfig(fighter.currentPunch);
  const durations = getPunchPhaseDurations(fighter, config, fighter.isRePunch);
  if (state.fatigueEnabled) {
    const fatigueMult = 1 / Math.max(0.5, 1 - Math.floor(fighter.punchesThrown / 50) * 0.0025);
    for (const phase of Object.keys(durations) as PunchPhaseType[]) {
      durations[phase] *= fatigueMult;
    }
  }
  const phases: PunchPhaseType[] = ["launchDelay", "armSpeed", "contact", "linger", "retraction"];

  if (!fighter.punchPhase) fighter.punchPhase = "launchDelay";

  if (fighter.isFeinting && fighter.punchPhase === "linger") {
    fighter.feintHoldTimer += dt;
    const touching = isFeintTouchingOpponent(fighter, opponent);
    const feinterDucking = fighter.defenseState === "duck";
    fighter.feintTouchingOpponent = touching && !feinterDucking;
    fighter.feintDuckTouchingOpponent = touching && feinterDucking;

    if (fighter.feintHoldTimer < FEINT_HOLD_MAX) {
      return;
    }
    fighter.isPunching = false;
    fighter.currentPunch = null;
    fighter.punchProgress = 0;
    fighter.punchPhase = null;
    fighter.punchPhaseTimer = 0;
    const levelT = Math.min(1, Math.max(0, (fighter.level - 1) / 99));
    fighter.punchCooldown = 0.3 - levelT * 0.2;
    fighter.isFeinting = false;
    fighter.isCharging = false;
    fighter.halfGuardPunch = false;
    fighter.isRePunch = false;
    fighter.retractionProgress = 0;
    fighter.retractionPenaltyMult = 1;
    fighter.feintHoldTimer = 0;
    fighter.feintTouchingOpponent = false;
    fighter.feintDuckTouchingOpponent = false;
    return;
  }

  fighter.punchPhaseTimer += dt;

  const currentPhaseDuration = durations[fighter.punchPhase];

  let totalDuration = 0;
  for (const p of phases) totalDuration += durations[p];
  let elapsed = 0;
  for (const p of phases) {
    if (p === fighter.punchPhase) {
      elapsed += Math.min(fighter.punchPhaseTimer, durations[p]);
      break;
    }
    elapsed += durations[p];
  }
  fighter.punchProgress = Math.min(1, elapsed / totalDuration);

  if (fighter.punchPhase === "retraction") {
    fighter.retractionProgress = Math.min(1, fighter.punchPhaseTimer / currentPhaseDuration);
  }

  if (fighter.punchPhaseTimer >= currentPhaseDuration) {
    const currentIdx = phases.indexOf(fighter.punchPhase);

    if (fighter.punchPhase === "contact") {
      applyHit(fighter, opponent, state);
    }

    if (currentIdx < phases.length - 1) {
      fighter.punchPhase = phases[currentIdx + 1];
      fighter.punchPhaseTimer = 0;
      if (fighter.isFeinting && fighter.punchPhase === "linger") {
        fighter.feintHoldTimer = 0;
      }
    } else {
      fighter.isPunching = false;
      fighter.currentPunch = null;
      fighter.punchProgress = 0;
      fighter.punchPhase = null;
      fighter.punchPhaseTimer = 0;
      const levelT = Math.min(1, Math.max(0, (fighter.level - 1) / 99));
      fighter.punchCooldown = 0.3 - levelT * 0.2;
      fighter.isFeinting = false;
      fighter.isCharging = false;
      fighter.halfGuardPunch = false;
      fighter.isRePunch = false;
      fighter.retractionProgress = 0;
      fighter.retractionPenaltyMult = 1;
      fighter.feintHoldTimer = 0;
      fighter.feintTouchingOpponent = false;
      fighter.feintDuckTouchingOpponent = false;
    }
  }
}

function updateRhythm(fighter: FighterState, dt: number): void {
  if (fighter.isKnockedDown) return;
  if (fighter.rhythmLevel === 0) {
    fighter.rhythmProgress = 0;
    return;
  }
}

function updateBob(fighter: FighterState, dt: number, state?: GameState): void {
  const duckTarget = fighter.defenseState === "duck" ? 1 : 0;
  const guardActive = fighter.defenseState === "fullGuard";
  const duckSpeed = (guardActive ? 8.0 : 8.0 * 1.2) * 1.05 * fighter.duckSpeedMult;
  fighter.duckProgress += (duckTarget - fighter.duckProgress) * Math.min(1, duckSpeed * dt);
  if (Math.abs(fighter.duckProgress - duckTarget) < 0.01) fighter.duckProgress = duckTarget;

  const duckWithGuard = fighter.defenseState === "duck" && fighter.preDuckBlockState !== null;
  const guardTarget = (guardActive || duckWithGuard) ? 1.0 : 0.0;
  const isRaising = (guardActive || duckWithGuard);
  let guardSpeed: number;
  if (isRaising) {
    const levelT = Math.min(1, Math.max(0, (fighter.level - 1) / 99));
    const guardSlideMs = 50 - levelT * 30;
    guardSpeed = 1000 / guardSlideMs;
  } else {
    guardSpeed = 6.0;
  }
  fighter.guardBlend += (guardTarget - fighter.guardBlend) * Math.min(1, guardSpeed * dt);
  if (Math.abs(fighter.guardBlend - guardTarget) < 0.02) fighter.guardBlend = guardTarget;
  if (fighter.autoGuardActive && fighter.autoGuardTimer > 0 && fighter.defenseState === "fullGuard" && !fighter.isPunching) {
    fighter.guardBlend = 1;
  }

  const levelSpeedScale = levelScale(fighter.level, 1, 2.5);
  const isRetracting = fighter.isPunching && fighter.punchPhase === "retraction";
  const isDuckCross = fighter.defenseState === "duck" && fighter.isPunching && fighter.currentPunch === "cross";
  const isLeftHook = fighter.isPunching && fighter.currentPunch === "leftHook";

  if (isDuckCross && !isRetracting) {
    const driveSpeed = 12.0 * 1.1 * levelSpeedScale;
    fighter.backLegDrive += (1 - fighter.backLegDrive) * Math.min(1, driveSpeed * dt);
    if (fighter.backLegDrive > 0.99) fighter.backLegDrive = 1;
  } else if (fighter.backLegDrive > 0) {
    const returnSpeed = 6.0 * 0.95 * levelSpeedScale;
    fighter.backLegDrive -= fighter.backLegDrive * Math.min(1, returnSpeed * dt);
    if (fighter.backLegDrive < 0.01) fighter.backLegDrive = 0;
  }

  if (isLeftHook && !isRetracting) {
    const driveSpeed = 12.0 * 1.1 * levelSpeedScale;
    fighter.frontLegDrive += (1 - fighter.frontLegDrive) * Math.min(1, driveSpeed * dt);
    if (fighter.frontLegDrive > 0.99) fighter.frontLegDrive = 1;
  } else if (fighter.frontLegDrive > 0) {
    const returnSpeed = 6.0 * 0.95 * levelSpeedScale;
    fighter.frontLegDrive -= fighter.frontLegDrive * Math.min(1, returnSpeed * dt);
    if (fighter.frontLegDrive < 0.01) fighter.frontLegDrive = 0;
  }

  if (fighter.isKnockedDown || fighter.isPunching) return;

  const isTelegraphing = fighter.telegraphPhase !== "none";

  if (isTelegraphing) {
    const levelT = Math.min(1, Math.max(0, (fighter.level - 1) / 99));
    const sinkStartPct = 0.2 + levelT * 0.7;
    const telegraphPct = fighter.telegraphDuration > 0 ? fighter.telegraphTimer / fighter.telegraphDuration : 1;
    if (telegraphPct >= sinkStartPct) {
      fighter.telegraphHeadSinkProgress = Math.min(1, fighter.telegraphHeadSinkProgress + dt * 6);
    }
  } else if (fighter.telegraphHeadSinkProgress > 0) {
    if (fighter.timeSinceLastPunch >= 1.0 && !fighter.isPunching) {
      fighter.telegraphHeadSinkProgress = Math.max(0, fighter.telegraphHeadSinkProgress - dt * 3);
    }
  }

  if (fighter.miniStunTimer > 0) {
    fighter.miniStunTimer = Math.max(0, fighter.miniStunTimer - dt);
  }

  if (isTelegraphing) {
    if (fighter.telegraphSwayAnimating) {
      const diff = fighter.telegraphSwayTarget - fighter.swayOffset;
      if (Math.abs(diff) < 0.5) {
        fighter.swayOffset = fighter.telegraphSwayTarget;
        fighter.telegraphSwayAnimating = false;
        fighter.swayFrozen = true;
      } else {
        const speed = 15 * dt;
        fighter.swayOffset += Math.sign(diff) * Math.min(Math.abs(diff), speed);
      }
    }
    return;
  }

  const isDucking = fighter.defenseState === "duck";

  let effectiveBobSpeed = fighter.rhythmLevel > 0 ? fighter.rhythmLevel * 0.8 + 1.0 : fighter.baseBobSpeed;
  if (!isDucking) {
    fighter.bobPhase += dt * effectiveBobSpeed * Math.PI * 2;
    if (fighter.bobPhase > Math.PI * 2) fighter.bobPhase -= Math.PI * 2;
  }

  if (!isDucking) {
    const bobAmplitude = fighter.rhythmLevel > 0 ? 2 + fighter.rhythmLevel * 0.5 : 3;

    if (fighter.rhythmLevel > 0) {
      const swayNorm = fighter.swayOffset / 5;
      const bobX = swayNorm * bobAmplitude * fighter.facing;
      const bobY = -Math.abs(swayNorm) * 4;
      fighter.bodyOffset = { x: bobX, y: bobY };
      if (fighter.defenseState === "none" && !fighter.isPunching) {
        fighter.headOffset = {
          x: swayNorm * (bobAmplitude + 1) * fighter.facing,
          y: bobY - 2 + Math.abs(swayNorm) * 2,
        };
      }
    } else {
      const bobX = Math.sin(fighter.bobPhase) * bobAmplitude * fighter.facing;
      const bobY = Math.abs(Math.sin(fighter.bobPhase * 0.5)) * -4;
      fighter.bodyOffset = { x: bobX, y: bobY };
      if (fighter.defenseState === "none" && !fighter.isPunching) {
        fighter.headOffset = {
          x: Math.sin(fighter.bobPhase + 0.5) * (bobAmplitude + 1) * fighter.facing,
          y: bobY - 2 + Math.sin(fighter.bobPhase * 1.5) * 2,
        };
      }
    }
  }

  if (isDucking) {
    const isPlayerMoving = fighter.isPlayer && (keys["arrowleft"] || keys["arrowright"] || keys["arrowup"] || keys["arrowdown"]);
    const isAiMoving = !fighter.isPlayer && state && state.aiBrain && (state.aiBrain.desiredMoveInput !== 0 || state.aiBrain.desiredMoveZ !== 0);
    const isMoving = isPlayerMoving || isAiMoving;
    const duckRhythmActive = fighter.rhythmLevel > 0 && isMoving;

    if (duckRhythmActive) {
      const rhythmSpeedMult = (!fighter.isPlayer && state?.aiBrain) ? state.aiBrain.aiRhythmSpeedMult : 1.0;
      const swaySpeed = (fighter.rhythmLevel * 0.8 + 1.0) * rhythmSpeedMult;
      const swayAmp = 5;
      fighter.swayFrozen = false;
      fighter.swayOffset += fighter.swayDir * swaySpeed * dt * 8;
      if (Math.abs(fighter.swayOffset) >= swayAmp) {
        fighter.swayOffset = fighter.swayDir * swayAmp;
        fighter.swayDir *= -1;
      }
      fighter.rhythmProgress = Math.max(0, Math.min(1, fighter.swayOffset / 10 + 0.5));
      const swayNorm = fighter.swayOffset / 5;
      const bobAmplitude = 2 + fighter.rhythmLevel * 0.5;
      const bobX = swayNorm * bobAmplitude * fighter.facing;
      const bobY = -Math.abs(swayNorm) * 4;
      fighter.bodyOffset = { x: bobX, y: bobY };
    } else {
      const duckSwayTarget = fighter.swayDir * 5;
      const diff = duckSwayTarget - fighter.swayOffset;
      if (Math.abs(diff) < 0.4) {
        fighter.swayOffset = duckSwayTarget;
        fighter.swayFrozen = true;
      } else {
        fighter.swayOffset += Math.sign(diff) * Math.min(Math.abs(diff), 12 * dt);
        fighter.swayFrozen = false;
      }
    }
    computeSwayZoneMults(fighter);
    return;
  }

  if (fighter.rhythmPauseTimer > 0) {
    fighter.rhythmPauseTimer = Math.max(0, fighter.rhythmPauseTimer - dt);
  } else if (fighter.swaySpeedLevel === 0) {
    const target = fighter.swayDir * 5;
    const diff = target - fighter.swayOffset;
    if (Math.abs(diff) < 0.5) {
      fighter.swayOffset = target;
      fighter.swayFrozen = true;
    } else {
      const speed = 15 * dt;
      fighter.swayOffset += Math.sign(diff) * Math.min(Math.abs(diff), speed);
      fighter.swayFrozen = false;
    }
  } else {
    fighter.swayFrozen = false;
    const rhythmSpeedMult2 = (!fighter.isPlayer && state?.aiBrain) ? state.aiBrain.aiRhythmSpeedMult : 1.0;
    const swaySpeed = (fighter.swaySpeedLevel / 3) * effectiveBobSpeed * 0.5 * rhythmSpeedMult2;
    const prevSwayPhase = fighter.swayPhase;
    fighter.swayPhase += dt * swaySpeed * Math.PI * 2;
    if (fighter.swayPhase > Math.PI * 2) fighter.swayPhase -= Math.PI * 2;

    const crossedPi = (prevSwayPhase < Math.PI && fighter.swayPhase >= Math.PI) ||
                      (prevSwayPhase > fighter.swayPhase && fighter.swayPhase >= Math.PI);
    const crossedZero = prevSwayPhase > fighter.swayPhase;
    if (crossedPi || crossedZero) {
      fighter.swayDir = (fighter.swayDir === 1 ? -1 : 1) as 1 | -1;
    }

    fighter.swayOffset = Math.sin(fighter.swayPhase) * 5;
  }

  if (fighter.rhythmLevel > 0) {
    fighter.rhythmProgress = Math.max(0, Math.min(1, fighter.swayOffset / 10 + 0.5));
  }

  computeSwayZoneMults(fighter);
}

function updateDefense(fighter: FighterState, dt: number, practiceMode: boolean = false): void {
  if (fighter.isKnockedDown) {
    fighter.defenseState = "none";
    return;
  }

  switch (fighter.defenseState) {
    case "fullGuard":
      fighter.leftGloveOffset = { x: fighter.facing * 6, y: -12 };
      fighter.rightGloveOffset = { x: fighter.facing * 6, y: -8 };
      fighter.headOffset = { x: 0, y: -3 };
      break;
    case "duck": {
      const duckDrop = 18;
      fighter.headOffset = { x: 0, y: duckDrop };
      if (!fighter.isPunching) {
        fighter.leftGloveOffset = { x: fighter.facing * 5, y: duckDrop };
        fighter.rightGloveOffset = { x: fighter.facing * 5, y: duckDrop };
      }
      fighter.duckTimer += dt;
      break;
    }
    case "none":
      if (!fighter.isPunching) {
        fighter.duckTimer = 0;
      }
      break;
  }
}

function updateWeave(fighter: FighterState, dt: number): void {
  if (fighter.weaveCooldown > 0) {
    fighter.weaveCooldown -= dt;
    if (fighter.weaveCooldown < 0) fighter.weaveCooldown = 0;
  }
  if (fighter.weaveRecoveryTimer > 0) {
    fighter.weaveRecoveryTimer -= dt;
    if (fighter.weaveRecoveryTimer <= 0) {
      fighter.weaveRecoveryTimer = 0;
      fighter.stance = fighter.preWeaveStance;
    }
  }
  if (fighter.weaveCounterTimer > 0) {
    fighter.weaveCounterTimer -= dt;
    if (fighter.weaveCounterTimer < 0) fighter.weaveCounterTimer = 0;
  }
  if (!fighter.weaveActive) return;
  fighter.weaveProgress += dt / fighter.weaveDuration;
  if (fighter.weaveProgress >= 1) {
    fighter.weaveProgress = 0;
    fighter.weaveActive = false;
    fighter.weaveDirX = 0;
    fighter.weaveDirY = 0;
    fighter.weaveCooldown = 0.25;
    fighter.stance = fighter.preWeaveStance;
  }
}

function updatePunchAnimation(fighter: FighterState): void {
  if (!fighter.isPunching || !fighter.currentPunch) {
    if (fighter.defenseState === "none" && fighter.handsDown) {
      const defaultLeft = { x: fighter.facing * 15, y: -5 };
      const defaultRight = { x: fighter.facing * 18, y: 0 };
      fighter.leftGloveOffset = lerpVec(fighter.leftGloveOffset, defaultLeft, 0.2);
      fighter.rightGloveOffset = lerpVec(fighter.rightGloveOffset, defaultRight, 0.2);
    }
    return;
  }

  const config = getEffectivePunchConfig(fighter.currentPunch);
  const phase = fighter.punchPhase;

  if (fighter.isFeinting) {
    let extend = 0;
    if (fighter.punchPhase === "linger" && fighter.feintHoldTimer > 0) {
      extend = 0.3;
    } else if (fighter.punchPhase === "launchDelay") {
      extend = 0.05 * 0.3;
    } else if (fighter.punchPhase === "armSpeed") {
      const armT = Math.min(1, fighter.punchPhaseTimer / 0.12);
      extend = (0.05 + 0.95 * armT) * 0.3;
    } else if (fighter.punchPhase === "contact") {
      extend = 0.3;
    } else if (fighter.punchPhase === "linger") {
      extend = 0.3;
    }
    const feintReach = config.range * fighter.facing * extend;
    if (config.isLeft) {
      fighter.leftGloveOffset = { x: feintReach, y: -3 };
    } else {
      fighter.rightGloveOffset = { x: feintReach, y: -3 };
    }
    return;
  }

  let extend = 0;
  switch (phase) {
    case "launchDelay":
      extend = 0.05;
      break;
    case "armSpeed":
      extend = 0.05 + 0.95 * Math.min(1, fighter.punchPhaseTimer / 0.12);
      break;
    case "contact":
    case "linger":
      extend = 1.0;
      break;
    case "retraction":
      extend = 1.0 - fighter.retractionProgress;
      break;
  }

  const reachX = config.range * fighter.facing * extend;
  const isUppercut = fighter.currentPunch.includes("Uppercut");
  const isHook = fighter.currentPunch.includes("Hook");

  let punchOffset: Vec2;
  if (isUppercut) {
    const uPhase = extend;
    let uy: number;
    if (uPhase < 0.35) {
      const dropT = uPhase / 0.35;
      uy = 12 * dropT;
    } else {
      const riseT = (uPhase - 0.35) / 0.65;
      uy = 12 * (1 - riseT) - 18 * Math.sin(riseT * Math.PI * 0.85);
    }
    const xProgress = uPhase < 0.35 ? uPhase * 0.4 / 0.35 : 0.4 + (uPhase - 0.35) * 0.6 / 0.65;
    punchOffset = {
      x: config.range * fighter.facing * xProgress,
      y: uy,
    };
  } else if (isHook) {
    const arc = Math.sin(extend * Math.PI) * 15;
    punchOffset = {
      x: reachX * 0.8,
      y: -arc,
    };
  } else {
    punchOffset = { x: reachX, y: PUNCH_ANGLE_NORMAL * extend };
  }

  if (fighter.defenseState === "duck") {
    const duckDrop = 18;
    if (fighter.punchAimsHead) {
      punchOffset.y = PUNCH_ANGLE_NORMAL * extend;
    } else {
      const bodyTarget = duckDrop + PUNCH_ANGLE_DUCK_BODY * extend;
      if (isUppercut) {
        const uPhase = extend;
        let arc: number;
        if (uPhase < 0.35) {
          arc = 8 * (uPhase / 0.35);
        } else {
          const riseT = (uPhase - 0.35) / 0.65;
          arc = 8 * (1 - riseT) - 14 * Math.sin(riseT * Math.PI * 0.85);
        }
        punchOffset.y = bodyTarget + arc;
      } else if (isHook) {
        punchOffset.y = bodyTarget;
      } else {
        punchOffset.y = bodyTarget;
      }
    }
  }

  if (config.isLeft) {
    fighter.leftGloveOffset = punchOffset;
  } else {
    fighter.rightGloveOffset = punchOffset;
  }
}

function lerpVec(a: Vec2, b: Vec2, t: number): Vec2 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function updateAILegacy(state: GameState, dt: number): void {
  const roundElapsed = state.roundDuration - state.roundTimer;
  const wrappedAttemptPunch = (fighter: FighterState, punchType: PunchType, isFeint?: boolean, isCharged?: boolean): boolean => {
    if (fighter.telegraphPhase !== "none") return false;
    if (isCharged && roundElapsed < 10) return false;
    if (!isFeint && (state.player.feintTouchingOpponent || state.player.feintDuckTouchingOpponent)) {
      const failChance = getFeintPunchFailChance(fighter, state);
      if (Math.random() < failChance) return false;
    }
    if (!fighter.isPunching && shouldTelegraph(fighter, false, punchType)) {
      if (startTelegraph(fighter, punchType, !!isFeint, !!isCharged, state.telegraphMult)) {
        return true;
      }
      // rhythm >95%: telegraph skipped, fall through to direct punch
    }
    const result = attemptPunch(fighter, punchType, isFeint, isCharged, false, state.practiceMode, roundElapsed);
    if (result) {
      state.roundStats.enemyPunchesThisRound++;
      recordEvent(state, isFeint ? "feint" : "punch", "enemy", { punch: punchType, feint: !!isFeint, charged: !!isCharged, body: !fighter.punchAimsHead });
    }
    return result;
  };
  updateAIBrain(state, dt, wrappedAttemptPunch);
}

function updatePlayerAI(state: GameState, dt: number): void {
  const roundElapsed = state.roundDuration - state.roundTimer;
  const wrappedAttemptPunch = (fighter: FighterState, punchType: PunchType, isFeint?: boolean, isCharged?: boolean): boolean => {
    if (fighter.telegraphPhase !== "none") return false;
    if (isCharged && roundElapsed < 10) return false;
    if (!isFeint && (state.enemy.feintTouchingOpponent || state.enemy.feintDuckTouchingOpponent)) {
      const failChance = getFeintPunchFailChance(fighter, state);
      if (Math.random() < failChance) return false;
    }
    if (!fighter.isPunching && shouldTelegraph(fighter, false, punchType)) {
      if (startTelegraph(fighter, punchType, !!isFeint, !!isCharged, state.telegraphMult)) {
        return true;
      }
      // rhythm >95%: telegraph skipped, fall through to direct punch
    }
    const result = attemptPunch(fighter, punchType, isFeint, isCharged, false, state.practiceMode, roundElapsed);
    if (result) {
      state.roundStats.playerPunchesThisRound++;
      recordEvent(state, isFeint ? "feint" : "punch", "player", { punch: punchType, feint: !!isFeint, charged: !!isCharged, body: !fighter.punchAimsHead });
    }
    return result;
  };
  updateAIBrain(state, dt, wrappedAttemptPunch, true);
}

function handlePlayerInput(player: FighterState, enemy: FighterState, state: GameState, dt: number): void {
  if (player.isKnockedDown || state.knockdownActive || state.phase !== "fighting") return;

  const shiftHeld = keys["shift"];
  const tabHeld = keys["tab"];

  let moveX = 0;
  let moveZ = 0;
  if (!player.weaveActive) {
    if (keys["arrowleft"] && !tabHeld) moveX -= 1;
    if (keys["arrowright"] && !tabHeld) moveX += 1;
    if (keys["arrowup"]) moveZ -= 1;
    if (keys["arrowdown"]) moveZ += 1;
  }

  if (moveX !== 0 || moveZ !== 0) {
    const mag = Math.sqrt(moveX * moveX + moveZ * moveZ);
    moveX /= mag;
    moveZ /= mag;

    if (enemy.feintTouchingOpponent) {
      const toEnemyX = enemy.x - player.x;
      const toEnemyZ = enemy.z - player.z;
      const toEnemyLen = Math.sqrt(toEnemyX * toEnemyX + toEnemyZ * toEnemyZ);
      if (toEnemyLen > 0.01) {
        const dot = (moveX * toEnemyX + moveZ * toEnemyZ) / toEnemyLen;
        if (dot > 0 && player.defenseState !== "duck") {
          const nX = toEnemyX / toEnemyLen;
          const nZ = toEnemyZ / toEnemyLen;
          moveX -= dot * nX;
          moveZ -= dot * nZ;
        }
      }
    }
    if (enemy.feintDuckTouchingOpponent) {
      const toEnemyX = enemy.x - player.x;
      const toEnemyZ = enemy.z - player.z;
      const toEnemyLen = Math.sqrt(toEnemyX * toEnemyX + toEnemyZ * toEnemyZ);
      if (toEnemyLen > 0.01) {
        const dot = (moveX * toEnemyX + moveZ * toEnemyZ) / toEnemyLen;
        if (dot > 0) {
          const nX = toEnemyX / toEnemyLen;
          const nZ = toEnemyZ / toEnemyLen;
          moveX -= dot * nX;
          moveZ -= dot * nZ;
        }
      }
    }

    let speedMod = 1;
    speedMod *= player.moveSlowMult;
    if (player.stance === "frontFoot") speedMod *= 1.07;
    if (player.stance === "backFoot") speedMod *= 1.07;
    if (state.fatigueEnabled) {
      speedMod *= Math.max(0.5, 1 - Math.floor(player.punchesThrown / 50) * 0.0025);
    }
    if (player.guardDownSpeedBoost > 0) speedMod *= (1 + player.guardDownSpeedBoost);

    player.x += moveX * player.moveSpeed * dt * speedMod;
    player.z += moveZ * player.moveSpeed * dt * speedMod;
  }
  clampToDiamond(player);

  const dx = enemy.x - player.x;
  const dz = enemy.z - player.z;
  player.facingAngle = Math.atan2(dz, dx);
  player.facing = (dx >= 0 ? 1 : -1) as 1 | -1;

  if (consumePress("x")) {
    player.rhythmLevel = Math.min(4, player.rhythmLevel + 1);
  }
  if (consumePress("z")) {
    player.rhythmLevel = Math.max(0, player.rhythmLevel - 1);
  }
  if (consumePress("c")) {
    if (player.rhythmLevel > 0) {
      const stances: StanceType[] = ["backFoot", "neutral", "frontFoot"];
      const idx = stances.indexOf(player.stance);
      player.stance = stances[(idx + 1) % stances.length];
    }
  }

  if (tabHeld && consumePress("arrowright")) {
    player.swaySpeedLevel = Math.min(5, player.swaySpeedLevel + 1);
    if (state.tutorialMode) state.tutorialTracking.rhythmChangeCount++;
  }
  if (tabHeld && consumePress("arrowleft")) {
    player.swaySpeedLevel = Math.max(0, player.swaySpeedLevel - 1);
    if (state.tutorialMode) state.tutorialTracking.rhythmChangeCount++;
  }

  const weaveKey = keys["1"];
  if (!weaveKey && player.weaveActive) {
    player.weaveActive = false;
    player.weaveProgress = 0;
    player.weaveDirX = 0;
    player.weaveDirY = 0;
    player.weaveRecoveryTimer = 0;
    player.stance = player.preWeaveStance;
  }
  if (weaveKey && !player.weaveActive && player.weaveCooldown <= 0 && !player.isPunching && !player.isKnockedDown) {
    let wdx = 0;
    if (keys["arrowleft"]) wdx -= 1;
    if (keys["arrowright"]) wdx += 1;
    if (wdx !== 0) {
      player.weaveDirX = wdx;
      player.weaveDirY = 0;
      player.weaveActive = true;
      player.weaveProgress = 0;
      player.preWeaveStance = player.stance;
      player.stance = "backFoot";
      if (state.tutorialMode) {
        state.tutorialTracking.weaveCount++;
      }
    }
  }

  const spaceHeld = keys[" "];
  const spaceRisingEdge = spaceHeld && player.spaceWasUp;
  if (!spaceHeld) {
    player.spaceWasUp = true;
  } else if (spaceRisingEdge) {
    player.spaceWasUp = false;
    const now = performance.now() / 1000;
    if (player.autoGuardActive) {
      player.autoGuardActive = false;
      player.autoGuardTimer = 0;
    } else if (now - player.lastSpacePressTime <= 0.3 && player.autoGuardDuration > 0) {
      player.autoGuardActive = true;
      player.autoGuardTimer = player.autoGuardDuration;
      if (state.tutorialMode) {
        state.tutorialTracking.autoGuardActivated = true;
      }
    }
    player.lastSpacePressTime = now;
  }

  if (player.autoGuardActive) {
    player.autoGuardTimer -= dt;
    if (player.autoGuardTimer <= 0) {
      player.autoGuardActive = false;
      player.autoGuardTimer = 0;
      player.defenseState = "none";
      player.handsDown = true;
      player.guardBlend = 0;
    }
  }

  if (player.stunBlockDisableTimer > 0) {
    if (player.defenseState !== "none") {
      player.defenseState = "none";
      player.handsDown = false;
    }
    player.preDuckBlockState = null;
  } else if (!player.isPunching && shiftHeld) {
    if (player.defenseState !== "duck") {
      const wasBlocking = player.defenseState === "fullGuard";
      if (wasBlocking) {
        player.preDuckBlockState = player.defenseState;
      }
      player.defenseState = "duck";
      player.punchAimsHead = false;
      if (state.tutorialMode && keys["arrowdown"]) {
        state.tutorialTracking.ducked = true;
      }
    }
  } else if (player.defenseState === "duck" && !shiftHeld && !player.isPunching) {
    if (player.preDuckBlockState || player.autoGuardActive) {
      player.defenseState = "fullGuard";
    } else {
      player.defenseState = "none";
      player.handsDown = false;
    }
    player.preDuckBlockState = null;
    player.punchAimsHead = false;
  } else if (!player.isPunching && !shiftHeld) {
    if (player.autoGuardActive) {
      player.defenseState = "fullGuard";
    } else if (spaceHeld) {
      if (player.defenseState !== "fullGuard" && player.defenseState !== "duck") {
        player.defenseState = "fullGuard";
        if (state.tutorialMode) {
          state.tutorialTracking.guardToggled = true;
        }
      }
    } else {
      if (player.defenseState === "fullGuard") {
        player.defenseState = "none";
        player.handsDown = false;
      }
    }
  }

  if (player.autoGuardActive && player.autoGuardTimer > 0) {
    if (player.stunBlockDisableTimer <= 0 && player.defenseState !== "duck" && !player.isPunching) {
      player.defenseState = "fullGuard";
      player.guardBlend = 1;
      player.handsDown = false;
    }
  }

  if (player.defenseState === "duck") {
    player.duckHoldTimer += dt;
    if (player.duckHoldTimer > 1.5 && player.duckDrainCooldown <= 0) {
      player.stamina -= player.maxStamina * 0.02 * dt;
      if (player.stamina < 1) player.stamina = 1;
    }
  } else {
    if (player.duckHoldTimer > 0) {
      player.duckDrainCooldown = 3.0;
    }
    player.duckHoldTimer = 0;
  }
  if (player.duckDrainCooldown > 0) {
    player.duckDrainCooldown -= dt;
  }

  const fHeld = keys["f"];

  if (!player.isFeinting && player.isPunching && player.punchPhase === "linger" &&
      (player.currentPunch === "jab" || player.currentPunch === "cross")) {
    const holdKey = player.currentPunch === "jab" ? "w" : "e";
    if (keys[holdKey]) {
      player.isFeinting = true;
      player.feintHoldTimer = 0;
      player.feintTelegraphDisableTimer = 0.5;
      if (state.tutorialMode) state.tutorialTracking.punchFeintCount++;
    }
  }

  if (player.isFeinting && player.punchPhase === "linger") {
    const punchHoldKey = player.currentPunch === "jab" ? "w" : player.currentPunch === "cross" ? "e" : null;
    const punchKeyHeld = punchHoldKey ? keys[punchHoldKey] : false;
    if (!fHeld && !punchKeyHeld) {
      player.isPunching = false;
      player.currentPunch = null;
      player.punchProgress = 0;
      player.punchPhase = null;
      player.punchPhaseTimer = 0;
      const levelT = Math.min(1, Math.max(0, (player.level - 1) / 99));
      player.punchCooldown = 0.3 - levelT * 0.2;
      player.isFeinting = false;
      player.isCharging = false;
      player.halfGuardPunch = false;
      player.isRePunch = false;
      player.retractionProgress = 0;
      player.retractionPenaltyMult = 1;
      player.feintHoldTimer = 0;
      player.feintTouchingOpponent = false;
      player.feintDuckTouchingOpponent = false;
    }
  }

  if (consumePress("f") && !player.isPunching && player.telegraphPhase === "none") {
    if (enemy.feintTouchingOpponent || enemy.feintDuckTouchingOpponent) {
    } else {
      if (attemptPunch(player, "jab", true, false, false, state.practiceMode, state.roundDuration - state.roundTimer)) {
        state.roundStats.playerPunchesThisRound++;
        recordEvent(state, "feint", "player", { punch: "jab", feint: true, charged: false, body: false, rePunch: false });
        if (state.tutorialMode) state.tutorialTracking.feintCount++;
      }
    }
  }

  if (consumePress("a") && !player.isPunching && player.chargeMeterBars >= 1) {
    if (player.chargeArmed) {
      player.chargeArmed = false;
      player.chargeUsesLeft = 0;
      player.chargeArmTimer = 0;
    } else {
      player.chargeArmed = true;
      player.chargeUsesLeft = 2;
      player.chargeFlashTimer = 0.15;
      const levelT = Math.min(1, Math.max(0, (player.level - 1) / 99));
      player.chargeArmTimer = 2 + levelT * 2;
    }
  }

  const chargeHeadTarget = player.chargeArmed && !player.isPunching ? 0.05 : 0;
  const chargeHeadSpeed = chargeHeadTarget > 0 ? 10.0 : 4.0;
  player.chargeHeadOffset += (chargeHeadTarget - player.chargeHeadOffset) * Math.min(1, chargeHeadSpeed * dt);
  if (Math.abs(player.chargeHeadOffset - chargeHeadTarget) < 0.001) player.chargeHeadOffset = chargeHeadTarget;

  if (player.isPunching && player.punchPhase === "retraction" && player.retractionProgress >= 0.25) {
    player.chargeHeadOffset *= 0.9;
  }

  const isCharged = player.chargeArmed;

  const punchKeys: [string, PunchType][] = [
    ["w", "jab"],
    ["e", "cross"],
    ["q", "leftHook"],
    ["r", "rightHook"],
    ["s", "leftUppercut"],
    ["d", "rightUppercut"],
  ];

  for (const [key, punch] of punchKeys) {
    if (consumePress(key)) {
      if (state.tutorialMode) {
        const tt = state.tutorialTracking;
        if (punch === "jab") tt.threwJab = true;
        else if (punch === "cross") tt.threwCross = true;
        else if (punch === "leftHook") tt.threwLeftHook = true;
        else if (punch === "rightHook") tt.threwRightHook = true;
        else if (punch === "leftUppercut") tt.threwLeftUppercut = true;
        else if (punch === "rightUppercut") tt.threwRightUppercut = true;
      }
      let charged = isCharged;
      if (charged && (state.roundDuration - state.roundTimer) < 10) charged = false;
      const bodyShot = shiftHeld;

      if (enemy.feintTouchingOpponent || enemy.feintDuckTouchingOpponent) {
        const failChance = getFeintPunchFailChance(player, state);
        if (Math.random() < failChance) break;
      }

      const canRePunch = player.isPunching && player.punchPhase === "retraction" && 
        player.retractionProgress >= 0.75 && player.currentPunch === punch;
      if (bodyShot) {
        player.punchAimsHead = false;
      }
      if (canRePunch) {
        if (attemptPunch(player, punch, false, charged, true, state.practiceMode, state.roundDuration - state.roundTimer)) {
          state.roundStats.playerPunchesThisRound++;
          recordEvent(state, "punch", "player", { punch, feint: false, charged, body: bodyShot, rePunch: true });
        }
      } else if (!player.isPunching && player.telegraphPhase === "none") {
        if (shouldTelegraph(player, false, punch)) {
          if (!startTelegraph(player, punch, false, charged, state.telegraphMult)) {
            // rhythm >95%: skip telegraph and punch directly
            if (attemptPunch(player, punch, false, charged, false, state.practiceMode, state.roundDuration - state.roundTimer)) {
              state.roundStats.playerPunchesThisRound++;
              recordEvent(state, "punch", "player", { punch, feint: false, charged, body: bodyShot, rePunch: false });
            }
          }
        } else {
          if (attemptPunch(player, punch, false, charged, false, state.practiceMode, state.roundDuration - state.roundTimer)) {
            state.roundStats.playerPunchesThisRound++;
            recordEvent(state, "punch", "player", { punch, feint: false, charged, body: bodyShot, rePunch: false });
          }
        }
      }
      break;
    }
  }
}

const JUDGE_WEIGHTS = [
  { cleanHits: 5.5,  damage: 3.2,  aggression: 0.45,  ringControl: 0.20,  defense: 0.15 },
  { cleanHits: 5.3,  damage: 3.4,  aggression: 0.55,  ringControl: 0.15,  defense: 0.10 },
  { cleanHits: 5.6,  damage: 3.0,  aggression: 0.35,  ringControl: 0.25,  defense: 0.20 },
];

function judgeRound(stats: GameState["roundStats"], bias: number, judgeIndex: number): JudgeScore {
  const w = JUDGE_WEIGHTS[judgeIndex] || JUDGE_WEIGHTS[0];
  const pLanded = stats.playerLandedThisRound;
  const eLanded = stats.enemyLandedThisRound;
  const pDmg = stats.playerDamageThisRound;
  const eDmg = stats.enemyDamageThisRound;
  const pKDs = stats.playerKDsThisRound;
  const eKDs = stats.enemyKDsThisRound;
  const pThrown = stats.playerPunchesThisRound || 1;
  const eThrown = stats.enemyPunchesThisRound || 1;

  const totalKDs = pKDs + eKDs;
  if (totalKDs > 0) {
    if (pKDs > eKDs) {
      return { player: 10, enemy: Math.max(7, 10 - pKDs) };
    } else if (eKDs > pKDs) {
      return { player: Math.max(7, 10 - eKDs), enemy: 10 };
    }
  }

  let pScore = 0;
  let eScore = 0;

  const cleanHitDiff = pLanded - eLanded;
  const totalLanded = pLanded + eLanded || 1;
  pScore += (cleanHitDiff / totalLanded) * w.cleanHits;
  eScore += (-cleanHitDiff / totalLanded) * w.cleanHits;

  const totalDmg = pDmg + eDmg || 1;
  const dmgDiff = (pDmg - eDmg) / totalDmg;
  pScore += dmgDiff * w.damage;
  eScore += -dmgDiff * w.damage;

  const pAggr = stats.playerAggressionTime;
  const eAggr = stats.enemyAggressionTime;
  const totalAggr = pAggr + eAggr || 1;
  pScore += ((pAggr - eAggr) / totalAggr) * w.aggression;
  eScore += ((eAggr - pAggr) / totalAggr) * w.aggression;

  const pRing = stats.playerRingControlTime;
  const eRing = stats.enemyRingControlTime;
  const totalRing = pRing + eRing || 1;
  pScore += ((pRing - eRing) / totalRing) * w.ringControl;
  eScore += ((eRing - pRing) / totalRing) * w.ringControl;

  const pDefEff = (stats.playerPunchesDodged + stats.playerPunchesBlocked) / (eThrown || 1);
  const eDefEff = (stats.enemyPunchesDodged + stats.enemyPunchesBlocked) / (pThrown || 1);
  pScore += (pDefEff - eDefEff) * w.defense;
  eScore += (eDefEff - pDefEff) * w.defense;

  pScore += bias;
  eScore -= bias;

  if (pScore > eScore) return { player: 10, enemy: 9 };
  if (eScore > pScore) return { player: 9, enemy: 10 };
  return { player: 10, enemy: 10 };
}

function scoreRound(state: GameState): RoundScore {
  const stats = state.roundStats;
  const pKDs = stats.playerKDsThisRound;
  const eKDs = stats.enemyKDsThisRound;
  const pThrown = stats.playerPunchesThisRound || 1;
  const eThrown = stats.enemyPunchesThisRound || 1;
  const pLanded = stats.playerLandedThisRound;
  const eLanded = stats.enemyLandedThisRound;
  const pLandedPct = Math.round((pLanded / pThrown) * 100);
  const eLandedPct = Math.round((eLanded / eThrown) * 100);

  const biases = [
    (Math.random() - 0.5) * 0.2,
    (Math.random() - 0.5) * 0.2,
    (Math.random() - 0.5) * 0.2,
  ];

  const judges: [JudgeScore, JudgeScore, JudgeScore] = [
    judgeRound(stats, biases[0], 0),
    judgeRound(stats, biases[1], 1),
    judgeRound(stats, biases[2], 2),
  ];

  let playerTotal = 0, enemyTotal = 0;
  judges.forEach(j => { playerTotal += j.player; enemyTotal += j.enemy; });
  const player = Math.round(playerTotal / 3);
  const enemy = Math.round(enemyTotal / 3);

  return {
    player,
    enemy,
    judges,
    playerKDsThisRound: pKDs,
    enemyKDsThisRound: eKDs,
    playerLandedPct: pLandedPct,
    enemyLandedPct: eLandedPct,
    playerDamage: Math.round(stats.playerDamageThisRound),
    enemyDamage: Math.round(stats.enemyDamageThisRound),
    playerLandedThisRound: stats.playerLandedThisRound,
    enemyLandedThisRound: stats.enemyLandedThisRound,
  };
}

function getTotalPunchStats(state: GameState): { playerLanded: number; playerThrown: number; enemyLanded: number; enemyThrown: number } {
  let playerLanded = state.player.punchesLanded;
  let playerThrown = state.player.punchesThrown;
  let enemyLanded = state.enemy.punchesLanded;
  let enemyThrown = state.enemy.punchesThrown;
  return { playerLanded, playerThrown, enemyLanded, enemyThrown };
}

function checkMercyStoppage(state: GameState): boolean {
  if (!state.mercyStoppageEnabled || state.practiceMode || state.sparringMode) return false;
  if (state.totalEnemyKDs < 2 || state.totalEnemyKDs > 3) return false;
  const stats = getTotalPunchStats(state);
  const isCareer = !state.isQuickFight && !state.practiceMode && !state.sparringMode;
  const threshold = isCareer ? 2.5 : 1.8;
  if (stats.enemyLanded === 0) return stats.playerLanded > 0;
  return stats.playerLanded >= stats.enemyLanded * threshold;
}

function checkTowelStoppage(state: GameState, dt: number): boolean {
  if (!state.towelStoppageEnabled || state.practiceMode || state.sparringMode) return false;
  if (state.currentRound < 2) return false;

  const rs = state.roundStats;
  const pRoundDmg = rs.playerDamageThisRound;
  const eRoundDmg = rs.enemyDamageThisRound;
  const pTotalDmg = state.player.damageDealt;
  const eTotalDmg = state.enemy.damageDealt;

  const roundPlayerRatio = eRoundDmg <= 0 ? 0 : pRoundDmg / eRoundDmg;
  const roundEnemyRatio = pRoundDmg <= 0 ? 0 : eRoundDmg / pRoundDmg;
  const totalPlayerRatio = eTotalDmg <= 0 ? 0 : pTotalDmg / eTotalDmg;
  const totalEnemyRatio = pTotalDmg <= 0 ? 0 : eTotalDmg / pTotalDmg;

  const roundsAfter2 = Math.max(0, state.currentRound - 2);
  const ratioThreshold = 20 - roundsAfter2 * 0.6;

  const playerDominating = roundPlayerRatio >= ratioThreshold || totalPlayerRatio >= ratioThreshold;
  const enemyDominating = roundEnemyRatio >= ratioThreshold || totalEnemyRatio >= ratioThreshold;

  if (!playerDominating && !enemyDominating) return false;

  const losingFighter = playerDominating ? state.enemy : state.player;
  const dominantFighter = playerDominating ? state.player : state.enemy;
  const streak = dominantFighter.unansweredStreak;

  const scores = state.roundScores;
  if (scores.length >= 1) {
    const lastScore = scores[scores.length - 1];
    const pAvg = (lastScore.judges[0].player + lastScore.judges[1].player + lastScore.judges[2].player) / 3;
    const eAvg = (lastScore.judges[0].enemy + lastScore.judges[1].enemy + lastScore.judges[2].enemy) / 3;
    const loserWonLast = (losingFighter === state.player && pAvg > eAvg) || (losingFighter === state.enemy && eAvg > pAvg);
    if (loserWonLast) return false;
  }

  let hasImmunity = false;

  const loserDmg = losingFighter === state.player ? state.player.damageDealt : state.enemy.damageDealt;
  const domDmg = dominantFighter.damageDealt;
  if (domDmg > 0 && loserDmg >= domDmg * 0.5) hasImmunity = true;

  const opponentKDLabel: "player" | "enemy" = losingFighter === state.player ? "enemy" : "player";
  let loserDealtKDsWithoutReceiving = 0;
  for (let i = state.kdSequence.length - 1; i >= 0; i--) {
    if (state.kdSequence[i] === opponentKDLabel) {
      loserDealtKDsWithoutReceiving++;
    } else {
      break;
    }
  }
  if (loserDealtKDsWithoutReceiving >= 2) hasImmunity = true;

  if (hasImmunity) {
    if (state.towelImmunityUsed) {
      hasImmunity = false;
    } else {
      state.towelImmunityUsed = true;
      return false;
    }
  }

  let loserRoundsWon = 0;
  for (const rs of scores) {
    const pAvg = (rs.judges[0].player + rs.judges[1].player + rs.judges[2].player) / 3;
    const eAvg = (rs.judges[0].enemy + rs.judges[1].enemy + rs.judges[2].enemy) / 3;
    if (losingFighter === state.player && pAvg > eAvg) loserRoundsWon++;
    if (losingFighter === state.enemy && eAvg > pAvg) loserRoundsWon++;
  }

  const baseChance = 0.05 * dt;
  const streakChance = streak * 0.02 * dt;
  const roundPenalty = loserRoundsWon * 0.05 * dt;
  let totalChance = Math.max(0, baseChance + streakChance - roundPenalty);
  const isCareer = !state.isQuickFight && !state.practiceMode && !state.sparringMode;
  if (isCareer) totalChance *= 0.6;
  return Math.random() < totalChance;
}

function triggerRefStoppage(state: GameState, type: "mercy" | "towel"): void {
  state.refStoppageActive = true;
  state.refStoppageTimer = 1.0;
  state.refStoppageType = type;
  state.refereeVisible = true;

  const midX = (state.player.x + state.enemy.x) / 2;
  const midZ = (state.player.z + state.enemy.z) / 2;
  state.refX = midX;
  state.refZ = midZ;

  if (type === "towel") {
    state.towelActive = true;
    state.towelTimer = 1.0;
    state.towelStartX = RING_CX + RING_HALF_W;
    state.towelStartY = RING_CY;
    state.towelEndX = midX;
    state.towelEndY = midZ;
  }
}

function updateTutorial(state: GameState, dt: number): void {
  if (!state.tutorialMode) return;
  if (state.phase !== "fighting") return;

  const t = state.tutorialTracking;

  if (keys["arrowleft"]) t.movedLeft = true;
  if (keys["arrowright"]) t.movedRight = true;
  if (keys["arrowup"]) t.movedUp = true;
  if (keys["arrowdown"]) t.movedDown = true;

  if (state.tutorialPromptTimer > 0) {
    state.tutorialPromptTimer -= dt;
    if (state.tutorialPromptTimer <= 0) {
      state.tutorialPromptTimer = 0;
      if (state.tutorialFightUnlocked) {
        state.tutorialPrompt = "";
      }
    }
    return;
  }

  if (state.tutorialShowContinueButton) return;

  if (state.tutorialDelayTimer > 0) {
    state.tutorialDelayTimer -= dt;
    if (state.tutorialDelayTimer > 0) return;
    state.tutorialDelayTimer = 0;
  }

  if (state.tutorialStage === 1 && !state.tutorialFightUnlocked) {
    state.player.telegraphSpeedMult = 0.25;
  }

  if (state.tutorialStage === 1) {
    switch (state.tutorialStep) {
      case 1:
        state.tutorialPrompt = "Move with Arrow Keys";
        state.tutorialAiIdle = true;
        if (t.movedLeft && t.movedRight && t.movedUp && t.movedDown) {
          state.tutorialStep = 2;
          state.tutorialDelayTimer = 0.8;
          t.threwJab = false;
        }
        break;
      case 2:
        state.tutorialPrompt = "Jab with W";
        state.tutorialAiIdle = true;
        if (t.threwJab) {
          state.tutorialStep = 3;
          state.tutorialDelayTimer = 0.8;
          t.threwCross = false;
        }
        break;
      case 3:
        state.tutorialPrompt = "Cross with E";
        state.tutorialAiIdle = true;
        if (t.threwCross) {
          state.tutorialStep = 4;
          state.tutorialDelayTimer = 0.8;
          t.threwLeftHook = false;
          t.threwRightHook = false;
        }
        break;
      case 4:
        state.tutorialPrompt = "Throw Hooks with Q and R";
        state.tutorialAiIdle = true;
        if (t.threwLeftHook && t.threwRightHook) {
          state.tutorialStep = 5;
          state.tutorialDelayTimer = 0.8;
          t.threwLeftUppercut = false;
          t.threwRightUppercut = false;
        }
        break;
      case 5:
        state.tutorialPrompt = "Throw Uppercuts with S and D";
        state.tutorialAiIdle = true;
        if (t.threwLeftUppercut && t.threwRightUppercut) {
          state.tutorialStep = 6;
          state.tutorialDelayTimer = 0.8;
          t.punchesBlocked = 0;
          state.tutorialAiIdle = false;
        }
        break;
      case 6:
        state.tutorialPrompt = `Block by Holding Space (${t.punchesBlocked}/4)`;
        state.tutorialAiIdle = false;
        if (t.punchesBlocked >= 4) {
          state.tutorialStep = 7;
          state.tutorialDelayTimer = 0.8;
          t.ducked = false;
        }
        break;
      case 7:
        state.tutorialPrompt = "Duck with Shift + Down Key";
        state.tutorialAiIdle = false;
        if (t.ducked) {
          state.tutorialStep = 8;
          state.tutorialDelayTimer = 0.8;
          state.tutorialShowContinueButton = true;
          state.tutorialPrompt = "Punch combos have a telegraph time when you haven't thrown in awhile, this time will decrease as you level up.";
          state.tutorialAiIdle = true;
        }
        break;
      case 8:
        break;
      case 9:
        break;
      case 10:
        state.tutorialPrompt = "";
        break;
    }
  } else if (state.tutorialStage === 2) {
    switch (state.tutorialStep) {
      case 1:
        state.tutorialPrompt = "Double Tap Space to Trigger Auto High Guard";
        state.tutorialAiIdle = true;
        if (t.autoGuardActivated) {
          state.tutorialStep = 2;
          state.tutorialDelayTimer = 0.8;
          t.feintCount = 0;
        }
        break;
      case 2:
        state.tutorialPrompt = `Hold F to feint a punch. This baits the opponent to throw and gives you a short bonus window on your next throw. (${t.feintCount}/2)`;
        state.tutorialAiIdle = true;
        if (t.feintCount >= 2) {
          state.tutorialStep = 3;
          state.tutorialDelayTimer = 0.8;
          t.punchFeintCount = 0;
        }
        break;
      case 3:
        state.tutorialPrompt = `Hold Jab (W) or (E) for a Punch Feint; this can be used strategically to adjust punch timing and hit an opponent off-rhythm. (${t.punchFeintCount}/3)`;
        state.tutorialAiIdle = true;
        if (t.punchFeintCount >= 3) {
          state.tutorialStep = 4;
          state.tutorialDelayTimer = 0.8;
          t.guardToggled = false;
        }
        break;
      case 4:
        state.tutorialPrompt = "Tap Space to Toggle Guard States";
        state.tutorialAiIdle = true;
        if (t.guardToggled) {
          state.tutorialStep = 5;
          state.tutorialDelayTimer = 0.8;
          t.weaveCount = 0;
        }
        break;
      case 5:
        state.tutorialPrompt = `Hold 1 + Left or Right Arrow Keys to Weave (${t.weaveCount}/3)`;
        state.tutorialAiIdle = true;
        if (t.weaveCount >= 3) {
          state.tutorialStep = 6;
          state.tutorialDelayTimer = 0.8;
          t.rhythmChangeCount = 0;
        }
        break;
      case 6:
        state.tutorialPrompt = `Press Tab + Left and Right to Raise and Lower Rhythm Speed (${t.rhythmChangeCount}/5)`;
        state.tutorialAiIdle = true;
        if (t.rhythmChangeCount >= 5) {
          state.tutorialStep = 7;
          state.tutorialDelayTimer = 0.8;
          state.tutorialShowContinueButton = true;
          state.tutorialPrompt = "Hitting a fighter between their rhythm grants a punch effect bonus, as well as hitting at the beginning or end of your rhythm";
        }
        break;
      case 7:
        break;
      case 8:
        break;
      case 9:
        break;
      case 10:
        state.tutorialPrompt = "";
        break;
    }
  }
}

export function advanceTutorialContinue(state: GameState): void {
  if (state.tutorialStage === 1 && state.tutorialStep === 8) {
    state.tutorialShowContinueButton = false;
    state.tutorialStep = 9;
    state.tutorialShowContinueButton = true;
    state.tutorialPrompt = "Your Stamina is your lifeline. Punches cost a small amount of stamina, so be sure to punch with precision, this will cost less as you level up.";
  } else if (state.tutorialStage === 1 && state.tutorialStep === 9) {
    state.tutorialShowContinueButton = false;
    state.tutorialStep = 10;
    state.tutorialPrompt = "Beat Your Opponent!";
    state.tutorialPromptTimer = 2.0;
    state.tutorialFightUnlocked = true;
    state.tutorialAiIdle = false;
    state.player.telegraphSpeedMult = 1;
  } else if (state.tutorialStage === 2 && state.tutorialStep === 7) {
    state.tutorialShowContinueButton = false;
    state.tutorialStep = 8;
    state.tutorialShowContinueButton = true;
    state.tutorialPrompt = "The blue bar under your stamina is a Charge Punch Meter, it fills up when you land hits.";
  } else if (state.tutorialStage === 2 && state.tutorialStep === 8) {
    state.tutorialShowContinueButton = false;
    state.tutorialStep = 9;
    state.tutorialShowContinueButton = true;
    state.tutorialPrompt = "Get Close to the opponent, then Press A to activate Charge Punch when the bar is full, and throw a punch quickly to hurt your opponent!";
    if (state.player.chargeMeterBars < 1) {
      state.player.chargeMeterBars = 2;
      state.player.chargeMeterCounters = 0;
    }
  } else if (state.tutorialStage === 2 && state.tutorialStep === 9) {
    state.tutorialShowContinueButton = false;
    state.tutorialStep = 10;
    state.tutorialPrompt = "Defeat Your Opponent!";
    state.tutorialPromptTimer = 2.5;
    state.tutorialFightUnlocked = true;
    state.tutorialAiIdle = false;
  }
}

export function updateGame(state: GameState, dt: number): GameState {
  gameElapsedTime += dt;
  if (consumePress("escape")) {
    if (state.isPaused) {
      if (state.pauseControlsTab) {
        state.pauseControlsTab = false;
      } else if (state.pauseSoundTab) {
        state.pauseSoundTab = false;
      } else {
        state.isPaused = false;
        state.pauseAction = null;
        if (!state.practiceMode && !state.sparringMode) soundEngine.resumeCrowdAmbient();
      }
    } else if (state.phase === "fighting" || state.phase === "prefight") {
      state.isPaused = true;
      state.pauseSelectedIndex = 0;
      state.pauseAction = null;
      state.pauseSoundTab = false;
      state.pauseControlsTab = false;
      if (!state.practiceMode && !state.sparringMode) soundEngine.pauseCrowdAmbient();
    }
    clearFrameInput();
    return state;
  }

  if (state.tutorialMode && state.tutorialShowContinueButton && consumePress("enter")) {
    soundEngine.uiClick();
    advanceTutorialContinue(state);
    clearFrameInput();
    return state;
  }

  if (state.isPaused) {
    if (state.pauseSoundTab || state.pauseControlsTab) {
      clearFrameInput();
      return state;
    }
    const isTutorialPause = state.tutorialMode;
    const isCareerPause = state.sparringMode || state.careerFightMode;
    const menuItems = isTutorialPause ? 2 : state.practiceMode ? 7 : isCareerPause ? 4 : 5;
    if (consumePress("arrowup")) {
      state.pauseSelectedIndex = (state.pauseSelectedIndex - 1 + menuItems) % menuItems;
    }
    if (consumePress("arrowdown")) {
      state.pauseSelectedIndex = (state.pauseSelectedIndex + 1) % menuItems;
    }
    if (consumePress("enter") || consumePress(" ")) {
      soundEngine.uiClick();
      if (isTutorialPause) {
        if (state.pauseSelectedIndex === 0) {
          state.pauseAction = "restart";
        } else if (state.pauseSelectedIndex === 1) {
          state.pauseAction = "quit";
        }
      } else if (state.practiceMode) {
        if (state.pauseSelectedIndex === 0) {
          state.isPaused = false;
          state.pauseAction = null;
        } else if (state.pauseSelectedIndex === 1) {
          state.cpuAttacksEnabled = !state.cpuAttacksEnabled;
        } else if (state.pauseSelectedIndex === 2) {
          state.cpuDefenseEnabled = !state.cpuDefenseEnabled;
        } else if (state.pauseSelectedIndex === 3) {
          state.pauseControlsTab = true;
        } else if (state.pauseSelectedIndex === 4) {
          state.pauseSoundTab = true;
        } else if (state.pauseSelectedIndex === 5) {
          state.pauseAction = "restart";
        } else if (state.pauseSelectedIndex === 6) {
          state.pauseAction = "quit";
        }
      } else {
        if (state.pauseSelectedIndex === 0) {
          state.isPaused = false;
          state.pauseAction = null;
          if (!state.practiceMode && !state.sparringMode) soundEngine.resumeCrowdAmbient();
        } else if (state.pauseSelectedIndex === 1) {
          state.pauseControlsTab = true;
        } else if (state.pauseSelectedIndex === 2) {
          state.pauseSoundTab = true;
        } else if (!isCareerPause && state.pauseSelectedIndex === 3) {
          state.pauseAction = "restart";
        } else if ((isCareerPause && state.pauseSelectedIndex === 3) || (!isCareerPause && state.pauseSelectedIndex === 4)) {
          state.pauseAction = "quit";
        }
      }
    }
    clearFrameInput();
    return state;
  }

  if (state.phase !== "fighting" && state.phase !== "prefight") { clearFrameInput(); return state; }

  if (state.phase === "prefight") {
    if (!state.practiceMode && !state.sparringMode) {
      soundEngine.startCrowdAmbient();
    }
    state.countdownTimer -= dt;
    if (state.countdownTimer <= 0) {
      state.phase = "fighting";
      state.countdownTimer = 0;
      resetIntroAnim(state);
      initRoundRecording(state);
      soundEngine.bell();
    }
    if (state.introAnimActive) {
      updateIntroAnim(state, dt);
    }
    updateRhythm(state.player, dt);
    updateRhythm(state.enemy, dt);
    updateBob(state.player, dt, state);
    updateBob(state.enemy, dt, state);
    updatePunchAnimation(state.player);
    updatePunchAnimation(state.enemy);
    clearFrameInput();
    return state;
  }

  if (state.crowdKdSpeedTimer > 0) {
    state.crowdKdSpeedTimer -= dt;
    if (state.crowdKdSpeedTimer < 0) state.crowdKdSpeedTimer = 0;
  }
  const lastPunchEither = Math.min(state.player.timeSinceLastPunch, state.enemy.timeSinceLastPunch);
  const hasCrowdScene = !state.practiceMode && !state.sparringMode;
  const isLastRound = state.currentRound >= state.totalRounds && hasCrowdScene;
  const timeElapsed = state.roundDuration - state.roundTimer;
  const lastRoundBoost = isLastRound && (timeElapsed <= 20 || state.roundTimer <= 20);
  let crowdSpeed = 1.0;
  if (state.crowdKdSpeedTimer > 0) {
    crowdSpeed = 3.0;
  } else if (state.crowdExciteTimer > 0) {
    crowdSpeed = 2.0;
  } else if (lastRoundBoost) {
    crowdSpeed = 2.0;
  } else if (lastPunchEither >= 5.0) {
    crowdSpeed = 0.5;
  }
  state.crowdBobTime += dt * crowdSpeed;
  if (state.crowdKdBounceTimer > 0) {
    state.crowdKdBounceTimer -= dt;
    if (state.crowdKdBounceTimer < 0) state.crowdKdBounceTimer = 0;
  }
  if (state.crowdExciteTimer > 0) {
    state.crowdExciteTimer -= dt;
    if (state.crowdExciteTimer <= 0) {
      state.crowdExciteTimer = 0;
      soundEngine.crowdCalm();
    }
  }

  if (state.hitstopTimer > 0) {
    state.hitstopTimer -= dt;
    if (state.hitstopTimer <= 0) state.hitstopTimer = 0;

    if (state.shakeTimer > 0) {
      state.shakeTimer -= dt;
      if (state.shakeTimer <= 0) state.shakeIntensity = 0;
    }

    state.hitEffects = state.hitEffects.filter(e => {
      e.timer -= dt;
      return e.timer > 0;
    });

    updateFighterTelegraph(state.player, state, "player", dt);
    updateFighterTelegraph(state.enemy, state, "enemy", dt);

    updatePunchAnimation(state.player);
    updatePunchAnimation(state.enemy);

    clearFrameInput();
    return state;
  }

  if (state.shakeTimer > 0) {
    state.shakeTimer -= dt;
    if (state.shakeTimer <= 0) {
      state.shakeIntensity = 0;
    }
  }

  state.hitEffects = state.hitEffects.filter(e => {
    e.timer -= dt;
    return e.timer > 0;
  });

  if (state.cornerWalkActive) {
    state.cornerWalkTimer -= dt;
    const pDistToCorner = Math.sqrt((state.player.x - PLAYER_CORNER_X) ** 2 + (state.player.z - PLAYER_CORNER_Z) ** 2);
    const eDistToCorner = Math.sqrt((state.enemy.x - ENEMY_CORNER_X) ** 2 + (state.enemy.z - ENEMY_CORNER_Z) ** 2);
    const playerAtCorner = pDistToCorner < 5;
    const enemyAtCorner = eDistToCorner < 5;

    if (!playerAtCorner && pDistToCorner > 0.1) {
      const pDx = PLAYER_CORNER_X - state.player.x;
      const pDz = PLAYER_CORNER_Z - state.player.z;
      const pLen = Math.sqrt(pDx * pDx + pDz * pDz);
      state.player.x += (pDx / pLen) * CORNER_WALK_SPEED * dt;
      state.player.z += (pDz / pLen) * CORNER_WALK_SPEED * dt;
      if (Math.sqrt((state.player.x - PLAYER_CORNER_X) ** 2 + (state.player.z - PLAYER_CORNER_Z) ** 2) < 5) {
        state.player.x = PLAYER_CORNER_X;
        state.player.z = PLAYER_CORNER_Z;
      }
    }
    if (!enemyAtCorner && eDistToCorner > 0.1) {
      const eDx = ENEMY_CORNER_X - state.enemy.x;
      const eDz = ENEMY_CORNER_Z - state.enemy.z;
      const eLen = Math.sqrt(eDx * eDx + eDz * eDz);
      state.enemy.x += (eDx / eLen) * CORNER_WALK_SPEED * dt;
      state.enemy.z += (eDz / eLen) * CORNER_WALK_SPEED * dt;
      if (Math.sqrt((state.enemy.x - ENEMY_CORNER_X) ** 2 + (state.enemy.z - ENEMY_CORNER_Z) ** 2) < 5) {
        state.enemy.x = ENEMY_CORNER_X;
        state.enemy.z = ENEMY_CORNER_Z;
      }
    }

    if ((playerAtCorner && enemyAtCorner) || state.cornerWalkTimer <= 0) {
      state.cornerWalkActive = false;
      state.player.x = PLAYER_CORNER_X;
      state.player.z = PLAYER_CORNER_Z;
      state.enemy.x = ENEMY_CORNER_X;
      state.enemy.z = ENEMY_CORNER_Z;

      const standingFighter = state.savedStandingIsPlayer ? state.player : state.enemy;
      standingFighter.defenseState = state.savedDefenseState;
      standingFighter.handsDown = false;
      standingFighter.blockTimer = state.savedBlockTimer;

      for (const f of [state.player, state.enemy]) {
        f.telegraphPhase = "none";
        f.telegraphTimer = 0;
        f.telegraphDuration = 0;
        f.isHit = false;
        f.hitTimer = 0;
        f.cleanHitEyeTimer = 0;
        f.critHitTimer = 0;
      }
    }

    clearFrameInput();
    return state;
  }

  if (state.refStoppageActive) {
    state.refStoppageTimer -= dt;
    if (state.refStoppageTimer <= 0) {
      finalizeRoundRecording(state);
      rollNextRingCanvasColor();
      state.phase = "fightEnd";
      state.fightResult = "TKO";
      state.fightWinner = "player";
      state.fightTotalDuckDodges += state.roundStats.playerDuckDodges;
      state.fightTotalCombos += state.roundStats.playerComboCount;
      state.xpGained = calculateXP(state);
      state.refStoppageActive = false;
      state.refereeVisible = false;
      state.towelActive = false;
      state.shakeIntensity = 0;
      state.shakeTimer = 0;
      if (!state.practiceMode && !state.sparringMode) {
        soundEngine.resumeCrowdAmbient();
        soundEngine.playCheer(2);
      }
    }
    clearFrameInput();
    return state;
  }

  if (state.kdFaceRefActive) {
    state.kdFaceRefTimer -= dt;
    if (state.kdFaceRefTimer <= 0) {
      state.kdFaceRefActive = false;
      if (state.kdTimerExpired) {
        finalizeRoundRecording(state);
        const roundScore = scoreRound(state);
        state.roundScores.push(roundScore);
        state.fightTotalDuckDodges += state.roundStats.playerDuckDodges;
        state.fightTotalCombos += state.roundStats.playerComboCount;
        if (state.currentRound >= state.totalRounds) {
          rollNextRingCanvasColor();
      state.phase = "fightEnd";
          let judgePlayerWins = 0;
          let judgeEnemyWins = 0;
          for (let ji = 0; ji < 3; ji++) {
            let pTotal = 0, eTotal = 0;
            state.roundScores.forEach(s => { pTotal += s.judges[ji].player; eTotal += s.judges[ji].enemy; });
            if (pTotal > eTotal) judgePlayerWins++;
            else if (eTotal > pTotal) judgeEnemyWins++;
          }
          if (judgePlayerWins > judgeEnemyWins) {
            state.fightResult = "Decision"; state.fightWinner = "player";
            if (!state.practiceMode && !state.sparringMode) soundEngine.playCheer(3);
          }
          else if (judgeEnemyWins > judgePlayerWins) { state.fightResult = "Decision"; state.fightWinner = "enemy"; }
          else { state.fightResult = "Draw"; state.fightWinner = null; }
          state.xpGained = calculateXP(state);
        } else {
          state.phase = "roundEnd";
        }
      } else {
        state.cornerWalkActive = true;
        state.cornerWalkTimer = 3.0;
        state.shakeIntensity = 0;
        state.shakeTimer = 0;
      }
    }
    clearFrameInput();
    return state;
  }

  if (state.knockdownActive) {
    const knockedFighter = state.player.isKnockedDown ? state.player : state.enemy;
    const standingFighter = state.player.isKnockedDown ? state.enemy : state.player;

    state.knockdownMashTimer -= dt;
    state.knockdownCountdown += dt;
    state.knockdownRefCount = Math.min(10, Math.floor(state.knockdownCountdown) + 1);

    const timerMult = state.timerSpeed === "double" ? 2 : 1;
    if (!state.kdTimerExpired) {
      state.roundTimer -= dt * timerMult;
      if (state.roundTimer <= 0) {
        state.roundTimer = 0;
        state.kdTimerExpired = true;
      }
    }

    const slideSpeed = 150;
    const slideDx = state.standingFighterTargetX - standingFighter.x;
    const slideDz = state.standingFighterTargetZ - standingFighter.z;
    const slideDist = Math.sqrt(slideDx * slideDx + slideDz * slideDz);
    if (slideDist > 3) {
      standingFighter.x += (slideDx / slideDist) * slideSpeed * dt;
      standingFighter.z += (slideDz / slideDist) * slideSpeed * dt;
      if (Math.sqrt((state.standingFighterTargetX - standingFighter.x) ** 2 + (state.standingFighterTargetZ - standingFighter.z) ** 2) < 3) {
        standingFighter.x = state.standingFighterTargetX;
        standingFighter.z = state.standingFighterTargetZ;
      }
    }
    standingFighter.stamina = Math.min(standingFighter.maxStamina, standingFighter.stamina + standingFighter.staminaRegen * 3.0 * dt);

    const kdStaminaFrac = knockedFighter.knockdowns === 1 ? 0.70 : knockedFighter.knockdowns === 2 ? 0.50 : 0.30;

    if (standingFighter.regenPauseTimer <= 0 && standingFighter.staminaPauseFromRhythm <= 0) {
      standingFighter.stamina = Math.min(standingFighter.maxStamina, standingFighter.stamina + standingFighter.staminaRegen * 3 * dt);
    }

    let fighterGotUp = false;

    if (knockedFighter.isPlayer) {
      if (state.cpuVsCpu) {
        const autoMashRate = 8 + Math.random() * 6;
        state.knockdownMashCount += autoMashRate * dt;
      } else {
        if (keyJustPressed[" "]) {
          state.knockdownMashCount++;
          keyJustPressed[" "] = false;
        }
      }
      if (state.knockdownMashCount >= state.knockdownMashRequired) {
        fighterGotUp = true;
      }
    } else {
      if (state.aiKdWillGetUp && state.knockdownCountdown >= state.aiKdGetUpTime) {
        fighterGotUp = true;
      }
    }

    if (fighterGotUp) {
      knockedFighter.isKnockedDown = false;
      knockedFighter.stamina = knockedFighter.maxStamina * kdStaminaFrac;
      knockedFighter.isPunching = false;
      knockedFighter.currentPunch = null;
      knockedFighter.punchPhase = null;
      knockedFighter.punchPhaseTimer = 0;
      knockedFighter.punchProgress = 0;
      knockedFighter.punchCooldown = 0;
      knockedFighter.isFeinting = false;
      knockedFighter.isCharging = false;
      knockedFighter.halfGuardPunch = false;
      knockedFighter.isRePunch = false;
      knockedFighter.retractionProgress = 0;
      knockedFighter.retractionPenaltyMult = 1;
      knockedFighter.stunPunchDisableTimer = 0;
      knockedFighter.stunPunchSlowTimer = 0;
      knockedFighter.stunPunchSlowMult = 1;
      knockedFighter.stunBlockDisableTimer = 0;
      knockedFighter.stunBlockWeakenTimer = 0;
      knockedFighter.chargeReady = false;
      knockedFighter.chargeArmed = false;
      knockedFighter.chargeUsesLeft = 0;
      knockedFighter.chargeArmTimer = 0;
      knockedFighter.chargeHoldTimer = 0;
      knockedFighter.blockFlashTimer = 0;
      knockedFighter.defenseState = "none";

      for (const f of [knockedFighter, standingFighter]) {
        f.telegraphPhase = "none";
        f.telegraphTimer = 0;
        f.telegraphDuration = 0;
        f.isHit = false;
        f.hitTimer = 0;
        f.cleanHitEyeTimer = 0;
        f.critHitTimer = 0;
      }

      knockedFighter.rhythmLevel = state.kdSavedKnockedRhythmLevel;
      knockedFighter.rhythmProgress = 0;
      standingFighter.rhythmLevel = state.kdSavedStandingRhythmLevel;
      standingFighter.rhythmProgress = 0;

      state.knockdownActive = false;
      state.player.kdRegenBoostActive = false;
      state.enemy.kdRegenBoostActive = false;
      state.knockdownRefCount = 0;
      state.knockdownCountdown = 0;
      state.refereeVisible = false;
      state.crowdKdSpeedTimer = 10.0;

      if (state.kdTakeKnee && state.kdIsBodyShot) {
        state.kdFaceRefActive = true;
        state.kdFaceRefTimer = 1.0;
      } else if (state.kdTimerExpired) {
        finalizeRoundRecording(state);
        const roundScore = scoreRound(state);
        state.roundScores.push(roundScore);
        state.fightTotalDuckDodges += state.roundStats.playerDuckDodges;
        state.fightTotalCombos += state.roundStats.playerComboCount;
        if (state.currentRound >= state.totalRounds) {
          rollNextRingCanvasColor();
      state.phase = "fightEnd";
          let judgePlayerWins = 0;
          let judgeEnemyWins = 0;
          for (let ji = 0; ji < 3; ji++) {
            let pTotal = 0, eTotal = 0;
            state.roundScores.forEach(s => { pTotal += s.judges[ji].player; eTotal += s.judges[ji].enemy; });
            if (pTotal > eTotal) judgePlayerWins++;
            else if (eTotal > pTotal) judgeEnemyWins++;
          }
          if (judgePlayerWins > judgeEnemyWins) {
            state.fightResult = "Decision"; state.fightWinner = "player";
            if (!state.practiceMode && !state.sparringMode) soundEngine.playCheer(3);
          }
          else if (judgeEnemyWins > judgePlayerWins) { state.fightResult = "Decision"; state.fightWinner = "enemy"; }
          else { state.fightResult = "Draw"; state.fightWinner = null; }
          state.xpGained = calculateXP(state);
        } else {
          state.phase = "roundEnd";
        }
      } else {
        if (!knockedFighter.isPlayer && !state.practiceMode) {
          const shouldMercyStop = checkMercyStoppage(state);
          if (shouldMercyStop) {
            triggerRefStoppage(state, "mercy");
            clearFrameInput();
            return state;
          }
        }
        state.cornerWalkActive = true;
        state.cornerWalkTimer = 3.0;
        state.shakeIntensity = 0;
        state.shakeTimer = 0;
      }
    }

    if (state.knockdownRefCount >= 10 && state.knockdownActive) {
      if (state.practiceMode || state.sparringMode) {
        knockedFighter.isKnockedDown = false;
        knockedFighter.stamina = Math.max(1, knockedFighter.maxStamina * 0.30);
        knockedFighter.isPunching = false;
        knockedFighter.currentPunch = null;
        knockedFighter.punchPhase = null;
        knockedFighter.punchPhaseTimer = 0;
        knockedFighter.punchProgress = 0;
        knockedFighter.punchCooldown = 0;
        knockedFighter.isFeinting = false;
        knockedFighter.isCharging = false;
        knockedFighter.halfGuardPunch = false;
        knockedFighter.isRePunch = false;
        knockedFighter.retractionProgress = 0;
        knockedFighter.retractionPenaltyMult = 1;
        knockedFighter.stunPunchDisableTimer = 0;
        knockedFighter.stunPunchSlowTimer = 0;
        knockedFighter.stunPunchSlowMult = 1;
        knockedFighter.stunBlockDisableTimer = 0;
        knockedFighter.stunBlockWeakenTimer = 0;
        knockedFighter.chargeReady = false;
        knockedFighter.chargeArmed = false;
        knockedFighter.chargeUsesLeft = 0;
        knockedFighter.chargeArmTimer = 0;
        knockedFighter.chargeHoldTimer = 0;
        knockedFighter.blockFlashTimer = 0;
        knockedFighter.defenseState = "none";

        for (const f of [knockedFighter, standingFighter]) {
          f.telegraphPhase = "none";
          f.telegraphTimer = 0;
          f.telegraphDuration = 0;
          f.isHit = false;
          f.hitTimer = 0;
          f.cleanHitEyeTimer = 0;
          f.critHitTimer = 0;
        }

        knockedFighter.rhythmLevel = state.kdSavedKnockedRhythmLevel;
        knockedFighter.rhythmProgress = 0;
        standingFighter.rhythmLevel = state.kdSavedStandingRhythmLevel;
        standingFighter.rhythmProgress = 0;

        state.knockdownActive = false;
        state.player.kdRegenBoostActive = false;
        state.enemy.kdRegenBoostActive = false;
        state.knockdownRefCount = 0;
        state.knockdownCountdown = 0;
        state.refereeVisible = false;
      } else {
        finalizeRoundRecording(state);
        rollNextRingCanvasColor();
      state.phase = "fightEnd";
        state.fightResult = "KO";
        state.fightWinner = knockedFighter.isPlayer ? "enemy" : "player";
        state.fightTotalDuckDodges += state.roundStats.playerDuckDodges;
        state.fightTotalCombos += state.roundStats.playerComboCount;
        state.xpGained = calculateXP(state);
        state.knockdownActive = false;
        state.player.kdRegenBoostActive = false;
        state.enemy.kdRegenBoostActive = false;
        state.refereeVisible = false;
      }
    }

    clearFrameInput();
    return state;
  }

  const timerMult = state.timerSpeed === "double" ? 2 : 1;
  if (!state.tutorialMode || state.tutorialFightUnlocked) {
    state.roundTimer -= dt * timerMult;
  }
  state.fightElapsedTime += dt;
  if (state.midFightLevelUpTimer > 0) state.midFightLevelUpTimer -= dt;

  if (state.recordInputs && state.inputRecording) {
    roundRecordingElapsed += dt;
    recordingAccumulator += dt;

    recordEvent(state, "pos", "player", {
      pFacing: state.player.facing,
      eFacing: state.enemy.facing,
      pDuck: state.player.defenseState === "duck" ? 1 : 0,
      eDuck: state.enemy.defenseState === "duck" ? 1 : 0,
      pGuard: state.player.defenseState === "guard" ? 1 : 0,
      eGuard: state.enemy.defenseState === "guard" ? 1 : 0,
      pPunch: state.player.isPunching ? (state.player.currentPunch || "?") : 0,
      ePunch: state.enemy.isPunching ? (state.enemy.currentPunch || "?") : 0,
      pKD: state.player.isKnockedDown ? 1 : 0,
      eKD: state.enemy.isKnockedDown ? 1 : 0,
      dt: Math.round(dt * 1000),
    });

    if (recordingAccumulator >= RECORD_MOVE_INTERVAL) {
      recordingAccumulator -= RECORD_MOVE_INTERVAL;
      recordEvent(state, "move", "player", {
        pDef: state.player.defenseState, pStance: state.player.stance, pRhythm: state.player.rhythmLevel,
        pPunching: state.player.isPunching, pPunch: state.player.currentPunch,
        eDef: state.enemy.defenseState, ePunching: state.enemy.isPunching, ePunch: state.enemy.currentPunch,
        eCharging: state.enemy.isCharging,
        aiPhase: state.aiBrain?.currentPhase || "none",
      });
    }
    if (state.player.defenseState !== lastPlayerDefState) {
      recordEvent(state, "defense", "player", { state: state.player.defenseState, prev: lastPlayerDefState });
      lastPlayerDefState = state.player.defenseState;
    }
    if (state.enemy.defenseState !== lastEnemyDefState) {
      recordEvent(state, "defense", "enemy", { state: state.enemy.defenseState, prev: lastEnemyDefState });
      lastEnemyDefState = state.enemy.defenseState;
    }
    if (state.player.chargeArmed) {
      recordEvent(state, "charge", "player", { armed: true, bars: state.player.chargeMeterBars });
    }
  }

  if (!state.refStoppageActive && !state.knockdownActive && checkTowelStoppage(state, dt)) {
    triggerRefStoppage(state, "towel");
    if (!state.practiceMode && !state.sparringMode) soundEngine.playCheer(3);
    clearFrameInput();
    return state;
  }

  if ((state.player.isKnockedDown || state.enemy.isKnockedDown) && !state.knockdownActive && state.phase === "fighting") {
    const knocked = state.player.isKnockedDown ? state.player : state.enemy;
    const standing = state.player.isKnockedDown ? state.enemy : state.player;
    state.knockdownActive = true;
    state.knockdownMashCount = 0;
    state.knockdownMashTimer = 10.0;
    state.knockdownRefCount = 0;
    state.knockdownCountdown = 0;
    state.kdTimerExpired = false;
    state.kdIsBodyShot = false;
    state.kdTakeKnee = false;
    state.kdFaceRefActive = false;
    state.kdFaceRefTimer = 0;
    const kdCount = knocked.knockdowns;
    if (knocked.isPlayer) {
      state.knockdownMashRequired = kdCount === 1 ? 25 : kdCount === 2 ? 35 : 50;
    } else {
      state.knockdownMashRequired = kdCount <= 2 ? 25 : 45;
      if (!state.aiKdWillGetUp) state.aiKdWillGetUp = true;
      if (!state.aiKdGetUpTime) state.aiKdGetUpTime = 3 + Math.random() * 4;
    }
    const neutralCorner = getFarthestNeutralCorner(knocked.x, knocked.z);
    state.standingFighterTargetX = neutralCorner.x;
    state.standingFighterTargetZ = neutralCorner.z;
    standing.isPunching = false;
    standing.currentPunch = null;
    standing.punchPhase = null;
    standing.punchPhaseTimer = 0;
    standing.isFeinting = false;
    standing.isCharging = false;
    standing.chargeArmed = false;
    standing.chargeUsesLeft = 0;
    standing.chargeArmTimer = 0;
    standing.defenseState = "none";
    standing.punchProgress = 0;
    state.refereeVisible = true;
    state.refX = knocked.x + 40;
    state.refZ = knocked.z - 20;
    clearFrameInput();
    return state;
  }

  if (state.cpuVsCpu) {
    updatePlayerAI(state, dt);
  } else {
    handlePlayerInput(state.player, state.enemy, state, dt);
  }
  if (state.tutorialMode && state.tutorialAiIdle) {
    state.enemy.defenseState = "none";
    state.enemy.handsDown = true;
  } else {
    updateAILegacy(state, dt);
  }
  if (state.tutorialMode) {
    updateTutorial(state, dt);
  }

  // Track how long each fighter has had their guard raised (for pop-up guard mechanic)
  for (const f of [state.player, state.enemy]) {
    if (f.defenseState !== "fullGuard") {
      f.timeSinceGuardRaised = 999;
    } else if (f.timeSinceGuardRaised >= 999) {
      f.timeSinceGuardRaised = 0; // just raised guard this frame
    } else {
      f.timeSinceGuardRaised += dt;
    }
  }

  if (state.adaptiveAiEnabled && state.behaviorProfile) {
    updateBehaviorProfile(state, dt);
    if (state.aiBrain) reviewAdaptiveMemory(state.aiBrain, dt);
    if (state.playerAiBrain) reviewAdaptiveMemory(state.playerAiBrain, dt);
  }

  updateFighterTelegraph(state.player, state, "player", dt);
  updateFighterTelegraph(state.enemy, state, "enemy", dt);

  if (state.enemy.defenseState === "duck") {
    state.enemy.duckHoldTimer += dt;
    if (state.enemy.duckHoldTimer > 1.5 && state.enemy.duckDrainCooldown <= 0) {
      state.enemy.stamina -= state.enemy.maxStamina * 0.02 * dt;
      if (state.enemy.stamina < 1) state.enemy.stamina = 1;
    }
  } else {
    if (state.enemy.duckHoldTimer > 0) {
      state.enemy.duckDrainCooldown = 3.0;
    }
    state.enemy.duckHoldTimer = 0;
  }
  if (state.enemy.duckDrainCooldown > 0) {
    state.enemy.duckDrainCooldown -= dt;
  }

  const enforceDist = getDistance(state.player, state.enemy);
  if (enforceDist < MIN_DISTANCE && enforceDist > 0.01) {
    const overlap = MIN_DISTANCE - enforceDist;
    const sepDx = state.player.x - state.enemy.x;
    const sepDz = state.player.z - state.enemy.z;
    const sepLen = Math.sqrt(sepDx * sepDx + sepDz * sepDz);
    const nx = sepDx / sepLen;
    const nz = sepDz / sepLen;
    
    const playerAtWall = !isInsideDiamond(state.player.x, state.player.z, 30);
    const enemyAtWall = !isInsideDiamond(state.enemy.x, state.enemy.z, 30);

    if (playerAtWall && !enemyAtWall) {
      state.enemy.x -= nx * (overlap + 1);
      state.enemy.z -= nz * (overlap + 1);
    } else if (enemyAtWall && !playerAtWall) {
      state.player.x += nx * (overlap + 1);
      state.player.z += nz * (overlap + 1);
    } else {
      const push = overlap / 2 + 1;
      state.player.x += nx * push;
      state.player.z += nz * push;
      state.enemy.x -= nx * push;
      state.enemy.z -= nz * push;
    }
  }
  clampToDiamond(state.player);
  clampToDiamond(state.enemy);

  [state.player, state.enemy].forEach(f => {
    if (f.punchCooldown > 0) f.punchCooldown -= dt;
    if (f.hitTimer > 0) f.hitTimer -= dt;
    if (f.cleanHitEyeTimer > 0) f.cleanHitEyeTimer = Math.max(0, f.cleanHitEyeTimer - dt);
    else f.isHit = false;
    if (f.isBlinking) {
      f.blinkDuration -= dt;
      if (f.blinkDuration <= 0) {
        f.isBlinking = false;
        const opp = f === state.player ? state.enemy : state.player;
        const bdx = f.x - opp.x;
        const bdz = f.z - opp.z;
        const bDist = Math.sqrt(bdx * bdx + bdz * bdz);
        const inRange = bDist < Math.max(f.armLength, opp.armLength) * 1.8;
        f.blinkTimer = inRange ? 10 + Math.random() * 5 : 4 + Math.random() * 4;
      }
    } else {
      f.blinkTimer -= dt;
      if (f.blinkTimer <= 0) {
        f.isBlinking = true;
        f.blinkDuration = 0.12;
      }
    }
    if (f.critHitTimer > 0) f.critHitTimer -= dt;
    if (f.speedBoostTimer > 0) f.speedBoostTimer -= dt;
    if (f.blockRegenPenaltyTimer > 0) f.blockRegenPenaltyTimer -= dt;
    if (f.facingLockTimer > 0) {
      f.facingLockTimer -= dt;
      if (f.facingLockTimer < 0) f.facingLockTimer = 0;
    }
    if (f.moveSlowTimer > 0) {
      f.moveSlowTimer -= dt;
      if (f.moveSlowTimer <= 0) { f.moveSlowTimer = 0; f.moveSlowMult = 1; }
    }
    if (f.pushbackVx !== 0 || f.pushbackVz !== 0) {
      const decay = Math.pow(0.00001, dt);
      f.x += f.pushbackVx * dt;
      f.z += f.pushbackVz * dt;
      f.x = Math.max(RING_LEFT + 10, Math.min(RING_RIGHT - 10, f.x));
      f.z = Math.max(RING_TOP + 10, Math.min(RING_BOTTOM - 10, f.z));
      f.pushbackVx *= decay;
      f.pushbackVz *= decay;
      if (Math.abs(f.pushbackVx) < 1 && Math.abs(f.pushbackVz) < 1) {
        f.pushbackVx = 0;
        f.pushbackVz = 0;
      }
    }
    const guardIsDown = f.handsDown && !f.isPunching && !f.isFeinting && !f.isKnockedDown && !f.isHit;
    if (guardIsDown) {
      f.guardDownTimer += dt;
      if (f.guardDownTimer >= 1.0 && f.guardDownSpeedBoost === 0 && f.guardDownBoostTimer <= 0) {
        f.guardDownSpeedBoost = f.guardDownBoostMax;
        f.guardDownBoostTimer = 3.0;
      }
    } else {
      f.guardDownTimer = 0;
    }
    if (f.guardDownBoostTimer > 0) {
      if (f.isPunching || f.isFeinting || f.isHit || f.defenseState === "duck") {
        f.guardDownSpeedBoost = 0;
        f.guardDownBoostTimer = 0;
      } else {
        f.guardDownBoostTimer -= dt;
        if (f.guardDownBoostTimer <= 0) {
          f.guardDownSpeedBoost = 0;
          f.guardDownBoostTimer = 0;
        }
      }
    }
    if (f.telegraphSlowTimer > 0) {
      f.telegraphSlowTimer -= dt;
      if (f.telegraphSlowTimer <= 0) f.telegraphSlowTimer = 0;
    }
    if (f.stunBlockDisableTimer > 0) {
      f.stunBlockDisableTimer -= dt;
      if (f.stunBlockDisableTimer <= 0) f.stunBlockDisableTimer = 0;
    }
    if (f.stunBlockWeakenTimer > 0) {
      f.stunBlockWeakenTimer -= dt;
      if (f.stunBlockWeakenTimer <= 0) f.stunBlockWeakenTimer = 0;
    }
    if (f.chargeArmTimer > 0 && f.chargeArmed) {
      f.chargeArmTimer -= dt;
      if (f.chargeArmTimer <= 0) {
        f.chargeArmTimer = 0;
        f.chargeArmed = false;
        f.chargeUsesLeft = 0;
        f.chargeMeterBars = Math.max(0, f.chargeMeterBars - 1);
      }
    }
    if (f.stunPunchDisableTimer > 0) {
      f.stunPunchDisableTimer -= dt;
      if (f.stunPunchDisableTimer <= 0) f.stunPunchDisableTimer = 0;
    }
    if (f.chargeMeterLockoutTimer > 0) {
      f.chargeMeterLockoutTimer -= dt;
      if (f.chargeMeterLockoutTimer <= 0) f.chargeMeterLockoutTimer = 0;
    }
    if (f.stunPunchSlowTimer > 0) {
      f.stunPunchSlowTimer -= dt;
      if (f.stunPunchSlowTimer <= 0) { f.stunPunchSlowTimer = 0; f.stunPunchSlowMult = 1; }
    }
    if (f.chargeEmpoweredTimer > 0) {
      f.chargeEmpoweredTimer -= dt;
      if (f.chargeEmpoweredTimer <= 0) f.chargeEmpoweredTimer = 0;
    }
    if (f.chargeCooldownTimer > 0) {
      f.chargeCooldownTimer -= dt;
      if (f.chargeCooldownTimer <= 0) f.chargeCooldownTimer = 0;
    }
    if (f.chargeReadyWindowTimer > 0) {
      f.chargeReadyWindowTimer -= dt;
      if (f.chargeReadyWindowTimer <= 0) { f.chargeReadyWindowTimer = 0; f.chargeReady = false; }
    }
    if (f.feintWhiffPenaltyCooldown > 0) {
      f.feintWhiffPenaltyCooldown -= dt;
      if (f.feintWhiffPenaltyCooldown <= 0) f.feintWhiffPenaltyCooldown = 0;
    }
    if (f.chargeFlashTimer > 0) {
      f.chargeFlashTimer -= dt;
      if (f.chargeFlashTimer <= 0) f.chargeFlashTimer = 0;
    }
    if (f.consecutiveChargeTimer > 0) {
      f.consecutiveChargeTimer -= dt;
      if (f.consecutiveChargeTimer <= 0) { f.consecutiveChargeTimer = 0; f.consecutiveChargeCount = 0; }
    }
    if (f.blockFlashTimer > 0) {
      f.blockFlashTimer -= dt;
      if (f.blockFlashTimer <= 0) f.blockFlashTimer = 0;
    }
    if (f.aiGuardDropTimer > 0) {
      f.aiGuardDropTimer -= dt;
      if (f.aiGuardDropTimer <= 0) { f.aiGuardDropTimer = 0; }
    }
    if (f.aiGuardDropCooldown > 0) {
      f.aiGuardDropCooldown -= dt;
      if (f.aiGuardDropCooldown <= 0) f.aiGuardDropCooldown = 0;
    }

    if (f.defenseState === "fullGuard") {
      if (f.autoGuardActive && f.autoGuardTimer > 0) {
        f.blockTimer = 0;
      } else {
        f.blockTimer += dt;
        if (f.blockTimer >= f.maxBlockDuration) {
          f.defenseState = "none";
          f.blockTimer = 0;
        }
      }
    }

    if (f.isPunching && f.defenseState === "fullGuard") {
      f.punchingWhileBlocking = true;
    } else if (!f.isPunching) {
      f.punchingWhileBlocking = false;
    }

    const rBuffs = getRhythmBuffs(f);
    let regenMult = f.defenseState === "duck" ? 1 : rBuffs.staminaRecoveryMult;
    if (f.blockRegenPenaltyTimer > 0) {
      regenMult *= 0.8;
    }
    if (f.defenseState === "fullGuard") {
      const levelT = Math.min(1, Math.max(0, (f.level - 1) / 99));
      const guardRegenPenalty = 0.75 + levelT * 0.15;
      regenMult *= guardRegenPenalty;
    }
    if (f.isPunchFatigued) {
      f.punchFatigueTimer -= dt;
      if (f.punchFatigueTimer <= 0) {
        f.isPunchFatigued = false;
        f.punchFatigueTimer = 0;
        f.recentPunchTimestamps = [];
      }
    }

    f.timeSinceLastLanded += dt;
    f.timeSinceLastDamageTaken += dt;

    if (!f.damageTakenRegenPauseFired && f.timeSinceLastDamageTaken >= 1.5 && f.timeSinceLastDamageTaken < Infinity) {
      f.damageTakenRegenPauseFired = true;
      f.regenPauseTimer = Math.max(f.regenPauseTimer, 1.0);
      const curHandsDown = f.guardBlend < 0.05 && !f.isPunching && !f.isKnockedDown;
      if (curHandsDown) {
        f.handsDownCooldown = Math.max(f.handsDownCooldown, 3.0);
      }
    }

    if (f.momentumRegenTimer > 0) {
      f.momentumRegenTimer -= dt;
      if (f.momentumRegenTimer <= 0) {
        f.momentumRegenBoost = 0;
        f.momentumRegenTimer = 0;
      }
    }

    const handsDown = f.guardBlend < 0.05 && !f.isPunching && !f.isKnockedDown;
    if (handsDown && f.handsDownCooldown <= 0) {
      f.handsDownTimer += dt;
    } else {
      if (f.handsDownTimer > 0) {
        f.handsDownCooldown = 15;
      }
      f.handsDownTimer = 0;
    }
    if (f.handsDownCooldown > 0 && !handsDown) {
      f.handsDownCooldown -= dt;
      if (f.handsDownCooldown < 0) f.handsDownCooldown = 0;
    }

    const feintStamPause = (f.isFeinting && f.feintHoldTimer >= FEINT_HOLD_STAM_PAUSE) ||
                           f.feintDuckTouchingOpponent;

    if (feintStamPause) {
    } else if (f.regenPauseTimer > 0) {
      f.regenPauseTimer -= dt;
    } else if (f.staminaPauseFromRhythm > 0) {
      f.staminaPauseFromRhythm -= dt;
    } else if (!f.isKnockedDown) {
      const lastHitBonus = f.timeSinceLastLanded >= 2 ? 1.30 : 1.0;
      const momentumBonus = 1.0 + f.momentumRegenBoost;
      let handsDownMult = 1.0;
      if (handsDown && f.handsDownCooldown <= 0) {
        if (f.handsDownTimer <= 0.5) {
          handsDownMult = 1.75;
        }
      }
      const kdBoost = f.kdRegenBoostActive ? 6.0 : 1.0;
      f.stamina = Math.min(f.maxStamina, f.stamina + f.staminaRegen * regenMult * lastHitBonus * momentumBonus * handsDownMult * kdBoost * dt);
    }
  });

  updatePunch(state.player, state.enemy, state, dt);
  if (state.knockdownActive || (state.phase as string) === "fightEnd") { clearFrameInput(); return state; }
  updatePunch(state.enemy, state.player, state, dt);
  if (state.knockdownActive || (state.phase as string) === "fightEnd") { clearFrameInput(); return state; }

  updateRhythm(state.player, dt);
  updateRhythm(state.enemy, dt);
  updateBob(state.player, dt, state);
  updateBob(state.enemy, dt, state);
  updateDefense(state.player, dt, state.practiceMode);
  updateDefense(state.enemy, dt, state.practiceMode);
  updateWeave(state.player, dt);
  updateWeave(state.enemy, dt);
  updatePunchAnimation(state.player);
  updatePunchAnimation(state.enemy);

  const playerFacing = state.player.x < state.enemy.x ? 1 : -1;
  if (state.player.facingLockTimer <= 0) {
    state.player.facing = playerFacing as 1 | -1;
  }
  if (state.enemy.facingLockTimer <= 0) {
    state.enemy.facing = -playerFacing as 1 | -1;
  }

  if (!state.knockdownActive) {
    const dist = getDistance(state.player, state.enemy);
    const playerPressing = state.player.isPunching && dist < 120;
    const enemyPressing = state.enemy.isPunching && dist < 120;
    if (playerPressing) state.roundStats.playerAggressionTime += dt;
    if (enemyPressing) state.roundStats.enemyAggressionTime += dt;

    const ringCenter = state.ringWidth / 2;
    const pDistCenter = Math.abs(state.player.x - ringCenter);
    const eDistCenter = Math.abs(state.enemy.x - ringCenter);
    if (pDistCenter < eDistCenter) {
      state.roundStats.playerRingControlTime += dt;
    } else if (eDistCenter < pDistCenter) {
      state.roundStats.enemyRingControlTime += dt;
    }
  }

  if (state.roundTimer <= 0) {
    soundEngine.bell();
    if (!state.practiceMode && !state.sparringMode) soundEngine.crowdCheer(0.5);
    state.fightTotalDuckDodges += state.roundStats.playerDuckDodges;
    state.fightTotalCombos += state.roundStats.playerComboCount;
    finalizeRoundRecording(state);
    const roundScore = scoreRound(state);
    state.roundScores.push(roundScore);

    if (state.currentRound >= state.totalRounds) {
      rollNextRingCanvasColor();
      state.phase = "fightEnd";
      let judgePlayerWins = 0;
      let judgeEnemyWins = 0;
      for (let ji = 0; ji < 3; ji++) {
        let pTotal = 0, eTotal = 0;
        state.roundScores.forEach(s => { pTotal += s.judges[ji].player; eTotal += s.judges[ji].enemy; });
        if (pTotal > eTotal) judgePlayerWins++;
        else if (eTotal > pTotal) judgeEnemyWins++;
      }

      if (state.sparringMode) {
        const pStats = getTotalPunchStats(state);
        let sparPScore = 0;
        let sparEScore = 0;
        sparPScore += pStats.playerLanded * 2;
        sparEScore += pStats.enemyLanded * 2;
        sparPScore += state.player.damageDealt;
        sparEScore += state.enemy.damageDealt;
        sparPScore += state.player.knockdownsGiven * 50;
        sparEScore += state.enemy.knockdownsGiven * 50;
        if (sparPScore > sparEScore) {
          state.fightResult = "Decision";
          state.fightWinner = "player";
        } else if (sparEScore > sparPScore) {
          state.fightResult = "Decision";
          state.fightWinner = "enemy";
        } else {
          state.fightResult = "Draw";
          state.fightWinner = null;
        }
      } else if (judgePlayerWins > judgeEnemyWins) {
        state.fightResult = "Decision";
        state.fightWinner = "player";
        if (!state.practiceMode && !state.sparringMode) soundEngine.playCheer(3);
      } else if (judgeEnemyWins > judgePlayerWins) {
        state.fightResult = "Decision";
        state.fightWinner = "enemy";
      } else {
        state.fightResult = "Draw";
        state.fightWinner = null;
      }
      state.xpGained = calculateXP(state);
    } else {
      state.phase = "roundEnd";
      if (state.aiBrain) {
        const drift = (Math.random() * 0.04 - 0.02) + (Math.random() > 0.5 ? 0.01 : -0.01);
        state.aiBrain.aiRhythmSpeedMult = Math.max(0.9, Math.min(1.1, state.aiBrain.aiRhythmSpeedMult + drift));
      }
      if (state.adaptiveAiEnabled) {
        if (state.aiBrain) onRoundBoundaryAdaptive(state.aiBrain);
        if (state.playerAiBrain) onRoundBoundaryAdaptive(state.playerAiBrain);
      }
    }
  }

  clearFrameInput();
  return state;
}

function checkMidFightLevelUp(state: GameState, xpAmount: number): void {
  state.playerCurrentXp += xpAmount;
  const needed = xpToNextLevel(state.playerLevel);
  if (state.playerCurrentXp >= needed) {
    state.playerCurrentXp -= needed;
    state.playerLevel++;
    state.player.level = state.playerLevel;
    state.midFightLevelUps++;
    state.midFightLevelUpTimer = 3.0;
  }
}

function calculateXP(state: GameState): number {
  const opponentLevel = Math.max(1, state.enemyLevel);
  const playerLevel = Math.max(1, state.playerLevel);

  let baseMatchXP = 4000 * (opponentLevel / 100);

  if (state.fightWinner === "player") {
    baseMatchXP *= 1.0;
  } else if (state.fightResult === "Draw") {
    baseMatchXP *= 0.5;
  } else {
    baseMatchXP *= 0.25;
  }

  if ((state.fightResult === "KO" || state.fightResult === "TKO") && state.fightWinner === "player") {
    baseMatchXP *= 1.15;
  }

  const diffMults: Record<string, number> = {
    journeyman: 0.8,
    contender: 1.0,
    elite: 1.35,
    champion: 1.75,
  };
  const difficultyMult = diffMults[state.aiDifficulty] || 1.0;

  const levelGap = opponentLevel - playerLevel;
  const levelGapMult = Math.max(0.7, Math.min(2.0, 1 + levelGap * 0.04));

  let totalXP = baseMatchXP * difficultyMult * levelGapMult * 1.5 * 1.3 * 0.7;

  return Math.max(1, Math.floor(totalXP));
}

export interface FightPerformanceStats {
  punchesThrown: number;
  punchesLanded: number;
  knockdownsGiven: number;
  knockdownsTaken: number;
  blocksMade: number;
  dodges: number;
  damageDealt: number;
  damageReceived: number;
  roundsWon: number;
  roundsLost: number;
}

export function extractPerformanceStats(state: GameState): FightPerformanceStats {
  let knockdownsGiven = 0;
  let knockdownsTaken = 0;
  let blocksMade = 0;
  let dodges = 0;
  let roundsWon = 0;
  let roundsLost = 0;

  for (const rs of state.roundScores) {
    knockdownsGiven += rs.playerKDsThisRound;
    knockdownsTaken += rs.enemyKDsThisRound;
    const pTotal = rs.judges.reduce((s, j) => s + j.player, 0);
    const eTotal = rs.judges.reduce((s, j) => s + j.enemy, 0);
    if (pTotal > eTotal) roundsWon++;
    else if (eTotal > pTotal) roundsLost++;
  }

  knockdownsGiven += state.roundStats.playerKDsThisRound;
  knockdownsTaken += state.roundStats.enemyKDsThisRound;
  blocksMade += state.roundStats.playerPunchesBlocked;
  dodges += state.roundStats.playerPunchesDodged;

  return {
    punchesThrown: state.player.punchesThrown,
    punchesLanded: state.player.punchesLanded,
    knockdownsGiven,
    knockdownsTaken,
    blocksMade,
    dodges,
    damageDealt: Math.floor(state.player.damageDealt),
    damageReceived: Math.floor(state.enemy.damageDealt),
    roundsWon,
    roundsLost,
  };
}

export function startNextRound(state: GameState): GameState {
  for (const f of [state.player, state.enemy]) {
    if (f.unansweredStreak >= 2) {
      f.momentumRegenBoost = 0.20;
      f.momentumRegenTimer = 15;
    } else {
      f.momentumRegenBoost = 0;
      f.momentumRegenTimer = 0;
    }
    f.unansweredStreak = 0;
  }

  state.currentRound++;
  state.roundTimer = state.roundDuration;
  state.phase = "prefight";
  state.countdownTimer = COUNTDOWN_DURATION;
  state.shakeIntensity = 0;
  state.shakeTimer = 0;
  state.crowdKdSpeedTimer = 0;
  state.crowdExciteTimer = 0;

  const lastScore = state.roundScores.length > 0 ? state.roundScores[state.roundScores.length - 1] : null;
  let playerLostRound = false;
  let enemyLostRound = false;
  if (lastScore) {
    let pTotal = 0, eTotal = 0;
    lastScore.judges.forEach((j: { player: number; enemy: number }) => { pTotal += j.player; eTotal += j.enemy; });
    playerLostRound = pTotal < eTotal;
    enemyLostRound = eTotal < pTotal;
  }

  for (const f of [state.player, state.enemy]) {
    f.guardDownBoostMax = Math.max(0, f.guardDownBoostMax - 0.02);
    f.guardDownTimer = 0;
    f.guardDownSpeedBoost = 0;
    f.guardDownBoostTimer = 0;

    const isPlayer = f === state.player;
    const roundKDs = isPlayer ? state.roundStats.playerKDsThisRound : state.roundStats.enemyKDsThisRound;
    const roundPunches = isPlayer ? state.roundStats.playerPunchesThisRound : state.roundStats.enemyPunchesThisRound;
    const lostRound = isPlayer ? playerLostRound : enemyLostRound;

    let capReduction = 0.02;
    if (lostRound) capReduction += 0.001;
    capReduction += roundKDs * 0.005;
    capReduction += Math.floor(roundPunches / 50) * 0.0001;

    f.maxStaminaCap = f.maxStaminaCap * (1 - capReduction);
    if (f.maxStamina > f.maxStaminaCap) f.maxStamina = f.maxStaminaCap;
  }

  state.player.autoGuardActive = false;
  state.player.autoGuardTimer = 0;

  state.player.stamina = state.player.maxStamina;
  state.enemy.stamina = state.enemy.maxStamina;

  state.player.x = PLAYER_START_X;
  state.player.z = PLAYER_START_Z;
  state.enemy.x = ENEMY_START_X;
  state.enemy.z = ENEMY_START_Z;
  state.player.isPunching = false;
  state.enemy.isPunching = false;
  state.player.defenseState = "fullGuard";
  state.enemy.defenseState = "fullGuard";
  state.player.guardBlend = 1.0;
  state.enemy.guardBlend = 1.0;
  state.player.leftGloveOffset = { x: state.player.facing * 6, y: -12 };
  state.player.rightGloveOffset = { x: state.player.facing * 6, y: -8 };
  state.enemy.leftGloveOffset = { x: state.enemy.facing * 6, y: -12 };
  state.enemy.rightGloveOffset = { x: state.enemy.facing * 6, y: -8 };
  state.player.isKnockedDown = false;
  state.enemy.isKnockedDown = false;
  
  state.player.blockTimer = 0;
  state.enemy.blockTimer = 0;
  state.player.blockRegenPenaltyTimer = 0;
  state.enemy.blockRegenPenaltyTimer = 0;
  state.player.punchPhase = null;
  state.enemy.punchPhase = null;
  state.player.punchCooldown = 0;
  state.enemy.punchCooldown = 0;
  state.player.punchPhaseTimer = 0;
  state.enemy.punchPhaseTimer = 0;
  state.player.punchProgress = 0;
  state.enemy.punchProgress = 0;
  state.player.currentPunch = null;
  state.enemy.currentPunch = null;
  state.player.isFeinting = false;
  state.enemy.isFeinting = false;
  state.player.feintHoldTimer = 0;
  state.enemy.feintHoldTimer = 0;
  state.player.feintTouchingOpponent = false;
  state.enemy.feintTouchingOpponent = false;
  state.player.feintDuckTouchingOpponent = false;
  state.enemy.feintDuckTouchingOpponent = false;
  state.player.isCharging = false;
  state.enemy.isCharging = false;
  state.player.isRePunch = false;
  state.enemy.isRePunch = false;
  state.player.halfGuardPunch = false;
  state.enemy.halfGuardPunch = false;
  state.player.retractionProgress = 0;
  state.enemy.retractionProgress = 0;
  state.player.retractionPenaltyMult = 1;
  state.enemy.retractionPenaltyMult = 1;
  state.player.stunPunchDisableTimer = 0;
  state.enemy.stunPunchDisableTimer = 0;
  state.player.stunPunchSlowTimer = 0;
  state.enemy.stunPunchSlowTimer = 0;
  state.player.stunPunchSlowMult = 1;
  state.enemy.stunPunchSlowMult = 1;
  state.player.stunBlockDisableTimer = 0;
  state.enemy.stunBlockDisableTimer = 0;
  state.player.stunBlockWeakenTimer = 0;
  state.enemy.stunBlockWeakenTimer = 0;
  state.player.chargeArmTimer = 0;
  state.enemy.chargeArmTimer = 0;
  state.player.moveSlowTimer = 0;
  state.enemy.moveSlowTimer = 0;
  state.player.moveSlowMult = 1;
  state.enemy.moveSlowMult = 1;
  state.player.chargeReady = false;
  state.enemy.chargeReady = false;
  state.player.chargeArmed = false;
  state.player.chargeUsesLeft = 0;
  state.enemy.chargeArmed = false;
  state.enemy.chargeUsesLeft = 0;
  state.player.chargeHoldTimer = 0;
  state.enemy.chargeHoldTimer = 0;
  state.player.blockFlashTimer = 0;
  state.enemy.blockFlashTimer = 0;
  state.player.punchTravelStartTime = 0;
  state.enemy.punchTravelStartTime = 0;
  state.player.retractionPenaltyMult = 1;
  state.enemy.retractionPenaltyMult = 1;
  state.player.feintWhiffPenaltyCooldown = 0;
  state.enemy.feintWhiffPenaltyCooldown = 0;
  for (const f of [state.player, state.enemy]) {
    if (state.currentRound > 1) {
      const roundIncrease = levelScale(f.level, 0.05, 0.01);
      f.telegraphRoundBonus += roundIncrease;
    }
  }
  state.player.telegraphPhase = "none";
  state.player.telegraphTimer = 0;
  state.player.telegraphDuration = 0;
  state.player.telegraphPunchType = null;
  state.player.telegraphIsFeint = false;
  state.player.telegraphIsCharged = false;
  state.player.timeSinceLastPunch = 999;
  state.player.feintTelegraphDisableTimer = 0;
  state.player.feintedTelegraphBoost = 0;
  state.enemy.telegraphPhase = "none";
  state.enemy.telegraphTimer = 0;
  state.enemy.telegraphDuration = 0;
  state.enemy.telegraphPunchType = null;
  state.enemy.telegraphIsFeint = false;
  state.enemy.telegraphIsCharged = false;
  state.enemy.timeSinceLastPunch = 999;
  state.enemy.feintTelegraphDisableTimer = 0;
  state.enemy.feintedTelegraphBoost = 0;
  for (const f of [state.player, state.enemy]) {
    f.telegraphSlowTimer = 0;
    f.telegraphSlowDuration = 0;
    f.telegraphHeadSlideX = 0;
    f.telegraphHeadSlideY = 0;
    f.telegraphHeadSlideTimer = 0;
    f.telegraphHeadSlideDuration = 0;
    f.telegraphHeadSlidePhase = "none";
    f.telegraphHeadHoldTimer = 0;
    f.telegraphHeadSinkProgress = 0;
  }
  state.player.isRePunch = false;
  state.enemy.isRePunch = false;
  state.player.recentPunchTimestamps = [];
  state.enemy.recentPunchTimestamps = [];
  state.player.punchFatigueTimer = 0;
  state.enemy.punchFatigueTimer = 0;
  state.player.isPunchFatigued = false;
  state.enemy.isPunchFatigued = false;
  state.player.duckHoldTimer = 0;
  state.player.duckDrainCooldown = 0;
  state.enemy.duckHoldTimer = 0;
  state.enemy.duckDrainCooldown = 0;
  state.knockdownActive = false;
  state.knockdownMashCount = 0;
  state.knockdownMashTimer = 0;
  state.knockdownRefCount = 0;
  state.knockdownCountdown = 0;
  state.kdIsBodyShot = false;
  state.kdTakeKnee = false;
  state.kdFaceRefActive = false;
  state.kdFaceRefTimer = 0;
  state.refStoppageActive = false;
  state.refStoppageTimer = 0;
  state.refStoppageType = null;
  state.towelActive = false;
  state.towelTimer = 0;
  state.refereeVisible = false;
  state.kdTimerExpired = false;

  state.roundStats = {
    playerDamageThisRound: 0,
    enemyDamageThisRound: 0,
    playerPunchesThisRound: 0,
    enemyPunchesThisRound: 0,
    playerLandedThisRound: 0,
    enemyLandedThisRound: 0,
    playerKDsThisRound: 0,
    enemyKDsThisRound: 0,
    playerAggressionTime: 0,
    enemyAggressionTime: 0,
    playerRingControlTime: 0,
    enemyRingControlTime: 0,
    playerPunchesDodged: 0,
    enemyPunchesDodged: 0,
    playerPunchesBlocked: 0,
    enemyPunchesBlocked: 0,
    playerDuckDodges: 0,
    playerComboCount: 0,
    playerConsecutiveLanded: 0,
  };

  const playerPlays = shouldPlayIntroAnim(state, state.player);
  const enemyPlays = shouldPlayIntroAnim(state, state.enemy);
  state.introAnimActive = playerPlays || enemyPlays;
  state.introAnimTimer = 0;
  state.introAnimPhase = 0;
  state.playerIntroPlaying = playerPlays;
  state.enemyIntroPlaying = enemyPlays;
  state.playerSavedRhythmLevel = state.player.rhythmLevel > 0 ? state.player.rhythmLevel : 2;
  state.enemySavedRhythmLevel = state.enemy.rhythmLevel > 0 ? state.enemy.rhythmLevel : 2;
  state.swarmerPunchQueue = generateSwarmerPunchQueue();
  state.swarmerPunchIndex = 0;
  state.swarmerPunchDelay = 0;
  state.swarmerIsPlayer = state.player.archetype === "Swarmer";

  if (playerPlays) {
    startIntroAnimForFighter(state.player, state.playerSavedRhythmLevel);
  }
  if (enemyPlays) {
    startIntroAnimForFighter(state.enemy, state.enemySavedRhythmLevel);
  }

  return state;
}

function totalXpForLevel(level: number): number {
  return Math.floor(10000000 * Math.pow(level / 100, 3));
}

export function xpToNextLevel(level: number): number {
  return Math.ceil((totalXpForLevel(level + 1) - totalXpForLevel(level)) * 1.25);
}

export type PlayerPlaystyle = Record<string, number>;

export function extractPlayerPlaystyle(state: GameState): PlayerPlaystyle {
  const p = state.player;
  const thrown = p.punchesThrown || 1;
  const landed = p.punchesLanded || 0;
  const accuracy = landed / thrown;
  const clean = p.cleanPunchesLanded || 0;
  const cleanRatio = clean / Math.max(landed, 1);
  const feintBaits = p.feintBaits || 0;
  const kdsGiven = p.knockdownsGiven || 0;
  const kdsReceived = p.knockdowns || 0;
  const elapsed = state.fightElapsedTime || 1;
  const punchRate = thrown / elapsed;

  const totalBlocks = state.roundStats.playerPunchesBlocked || 0;
  const totalDodges = state.roundStats.playerPunchesDodged || 0;
  const totalDucks = (state.fightTotalDuckDodges || 0) + (state.roundStats.playerDuckDodges || 0);
  const totalAggrTime = state.roundStats.playerAggressionTime || 0;
  const totalRingControl = state.roundStats.playerRingControlTime || 0;
  const totalEnemyAggr = state.roundStats.enemyAggressionTime || 0;

  let totalPlayerDmg = 0;
  let totalEnemyDmg = 0;
  for (const rs of state.roundScores) {
    totalPlayerDmg += rs.playerDamage || 0;
    totalEnemyDmg += rs.enemyDamage || 0;
  }
  totalPlayerDmg += state.roundStats.playerDamageThisRound || 0;
  totalEnemyDmg += state.roundStats.enemyDamageThisRound || 0;

  const aggressionRatio = totalAggrTime / Math.max(totalAggrTime + totalEnemyAggr, 1);
  const ringControlRatio = totalRingControl / Math.max(elapsed, 1);
  const combos = state.fightTotalCombos || 0;
  const comboRate = combos / Math.max(thrown / 3, 1);
  const dmgRatio = totalPlayerDmg / Math.max(totalPlayerDmg + totalEnemyDmg, 1);
  const feintRate = feintBaits / Math.max(elapsed / 10, 1);
  const defTotal = totalBlocks + totalDodges + totalDucks + 1;
  const blockRate = totalBlocks / defTotal;
  const dodgeRate = totalDodges / defTotal;
  const duckRate = totalDucks / defTotal;
  const survival = 1.0 - Math.min(kdsReceived * 0.3, 1.0);

  const clamp = (v: number) => Math.max(0.02, Math.min(1.0, v));

  return {
    aggression: clamp(aggressionRatio * 1.2),
    guardParanoia: clamp(blockRate * 1.5),
    feintiness: clamp(feintRate * 0.5),
    cleanHitsVsVolume: clamp(cleanRatio * 1.3),
    stateThinkSpeed: clamp(accuracy * 1.1),
    moveThinkSpeed: clamp(ringControlRatio * 1.5),
    attackInterval: clamp(Math.min(punchRate * 1.5, 1.0)),
    perfectReactChance: clamp(dodgeRate * 2.0),
    defenseCycleSpeed: clamp((blockRate + dodgeRate + duckRate) * 0.8),
    headCondThreshold: clamp(survival),
    bodyCondThreshold: clamp(survival * 0.9),
    rhythmCutCommit: clamp(aggressionRatio * comboRate * 2),
    rhythmCutAggression: clamp(aggressionRatio * punchRate),
    chargedPunchChance: clamp(dmgRatio * 0.8),
    comboCommitChance: clamp(comboRate * 1.2),
    ringCutoff: clamp(ringControlRatio * 1.3),
    ropeEscapeAwareness: clamp(dodgeRate * 1.5 + duckRate),
    lateralStrength: clamp(ringControlRatio * 1.2),
    kdRecovery1: clamp(survival * 1.1),
    kdRecovery2: clamp(survival * 0.85),
    kdRecovery3: clamp(survival * 0.6),
    survivalInstinct: clamp(survival * dmgRatio * 1.5),
  };
}

const PLAYSTYLE_LS_KEY = "handz_player_playstyle";

export function loadPlayerPlaystyle(fighterId: number): PlayerPlaystyle | null {
  try {
    const raw = localStorage.getItem(PLAYSTYLE_LS_KEY);
    if (!raw) return null;
    const all = JSON.parse(raw);
    return all[String(fighterId)] || null;
  } catch { return null; }
}

export function savePlayerPlaystyle(fighterId: number, newSample: PlayerPlaystyle) {
  const existing = loadPlayerPlaystyle(fighterId);
  const blended: PlayerPlaystyle = {};
  for (const key of Object.keys(newSample)) {
    if (existing && existing[key] != null) {
      blended[key] = existing[key] * 0.87 + newSample[key] * 0.13;
    } else {
      blended[key] = newSample[key];
    }
  }
  try {
    const raw = localStorage.getItem(PLAYSTYLE_LS_KEY);
    const all = raw ? JSON.parse(raw) : {};
    all[String(fighterId)] = blended;
    localStorage.setItem(PLAYSTYLE_LS_KEY, JSON.stringify(all));
  } catch {}
}

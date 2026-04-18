import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import * as localSaves from "@/lib/localSaves";
import { GameState, Archetype, FighterColors, DEFAULT_PLAYER_COLORS, AIDifficulty, TimerSpeed } from "@/game/types";
import { createInitialState, startFight, startNextRound, xpToNextLevel, extractPerformanceStats, extractPlayerPlaystyle, savePlayerPlaystyle } from "@/game/engine";
import { soundEngine } from "@/game/sound";
import { resetAutoZoom } from "@/game/renderer";
import {
  initRosterState,
  simulateWeek,
  computePlayerRankFromRating,
  updatePlayerRating,
  computeEloChange,
  updateRankings,
  buildOpponentFromRoster,
  getRandomQuickFightOpponent,
  getRosterFighterColors,
  getQuickFightColorsForRosterId,
  saveRosterCustomizations,
} from "@/game/careerRoster";
import { KEY_FIGHTER_IDS, type RosterEntry } from "@/game/rosterData";
import GameCanvas from "@/game/GameCanvas";
import MainMenu from "@/components/MainMenu";
import ClassSelect from "@/components/ClassSelect";
import RoundEnd from "@/components/RoundEnd";
import FightEnd from "@/components/FightEnd";
import CareerMode, { type TrainingType, RosterEditView, SPARRING_XP_MULT, AllocateStats } from "@/components/CareerMode";
import WeightLiftingGame from "@/components/WeightLiftingGame";
import HeavyBagGame from "@/components/HeavyBagGame";
import type { Fighter, SkillPoints, CareerStats, GearColors, TrainingBonuses, CareerRosterState } from "@shared/schema";
import { DEFAULT_CAREER_STATS, DEFAULT_TRAINING_BONUSES, DEFAULT_GEAR_COLORS } from "@shared/schema";

type UIMode = "menu" | "classSelect" | "career" | "fighting" | "fightEnd" | "training" | "rosterEdit" | "simulating" | "tutorial" | "tutorialComplete";

function SimulationScreen({ news, weekNumber, onComplete }: { news: string[]; weekNumber: number; onComplete: () => void }) {
  const [visibleCount, setVisibleCount] = useState(0);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (visibleCount < news.length) {
      const timer = setTimeout(() => setVisibleCount(v => v + 1), 350);
      return () => clearTimeout(timer);
    } else if (news.length > 0) {
      const timer = setTimeout(() => setDone(true), 600);
      return () => clearTimeout(timer);
    } else {
      setDone(true);
    }
  }, [visibleCount, news.length]);

  return (
    <div className="fixed inset-0 bg-black flex flex-col items-center justify-center z-50" data-testid="simulation-screen">
      <div className="text-yellow-500 text-2xl font-black mb-2" data-testid="text-sim-week">Week {weekNumber}</div>
      <div className="text-white text-lg mb-6">Around the boxing world...</div>
      <div className="w-full max-w-md px-4 space-y-2 max-h-[60vh] overflow-y-auto">
        {news.slice(0, visibleCount).map((item, i) => (
          <div
            key={i}
            className="text-sm text-gray-300 bg-gray-900 rounded px-3 py-2 animate-in fade-in slide-in-from-bottom-2 duration-300"
            data-testid={`text-sim-news-${i}`}
          >
            {item}
          </div>
        ))}
      </div>
      {done && (
        <button
          onClick={onComplete}
          autoFocus
          onKeyDown={(e) => { if (e.key === "Enter") onComplete(); }}
          className="mt-8 px-6 py-2 bg-yellow-600 hover:bg-yellow-500 text-black font-bold rounded transition-colors"
          data-testid="button-sim-continue"
        >
          Continue
        </button>
      )}
    </div>
  );
}

function TutorialCompleteScreen({ onFinish }: { onFinish: () => void }) {
  useEffect(() => {
    const timer = setTimeout(() => {
      onFinish();
    }, 4000);
    return () => clearTimeout(timer);
  }, [onFinish]);

  return (
    <div className="flex flex-col items-center justify-center min-h-screen gap-6 p-6" data-testid="tutorial-complete-screen">
      <h1
        className="text-3xl font-black tracking-wider text-primary text-center"
        style={{ textShadow: "0 0 30px rgba(200,50,50,0.3), 0 3px 6px rgba(0,0,0,0.4)" }}
        data-testid="text-tutorial-complete"
      >
        You seem to know what you're doing!
      </h1>
      <p className="text-xl text-yellow-500 font-bold text-center" data-testid="text-tutorial-encourage">
        Now let's Throw Some Handz!
      </p>
      <p className="text-sm text-muted-foreground mt-2" data-testid="text-tutorial-returning">
        Returning to main menu...
      </p>
    </div>
  );
}

export default function Game() {
  const [gameState, setGameState] = useState<GameState>(createInitialState());
  const [uiMode, setUiModeRaw] = useState<UIMode>("menu");
  const setUiMode = useCallback((mode: UIMode) => {
    if (mode !== "fighting") {
      soundEngine.stopCrowdAmbient();
    }
    setUiModeRaw(mode);
  }, []);
  const [selectedArchetype, setSelectedArchetype] = useState<Archetype>("BoxerPuncher");
  const [activeFighterRaw, setActiveFighterRaw] = useState<Fighter | null>(null);
  const activeFighter = useMemo(() => {
    if (!activeFighterRaw) return null;
    const raw = (activeFighterRaw.skillPoints || {}) as Partial<SkillPoints>;
    return {
      ...activeFighterRaw,
      skillPoints: {
        power: raw.power || 0,
        speed: raw.speed || 0,
        defense: raw.defense || 0,
        stamina: raw.stamina || 0,
        focus: raw.focus || 0,
      } as SkillPoints,
    };
  }, [activeFighterRaw]);
  const setActiveFighter = setActiveFighterRaw;
  const [preFightSnapshot, setPreFightSnapshot] = useState<Fighter | null>(null);
  const [isCareerFight, setIsCareerFight] = useState(false);
  const [playerColors, setPlayerColors] = useState<FighterColors>(() => {
    try {
      const raw = localStorage.getItem("quickFightColors");
      return raw ? JSON.parse(raw) : { ...DEFAULT_PLAYER_COLORS };
    } catch { return { ...DEFAULT_PLAYER_COLORS }; }
  });
  const savedQF = (() => {
    try {
      const raw = localStorage.getItem("quickFightSettings");
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  })();
  const [quickFightPlayerLevel, setQuickFightPlayerLevel] = useState(savedQF?.playerLevel ?? 1);
  const [quickFightEnemyLevel, setQuickFightEnemyLevel] = useState(savedQF?.enemyLevel ?? 1);
  const [aiDifficulty, setAiDifficulty] = useState<AIDifficulty>(savedQF?.difficulty ?? "contender");
  const [roundDurationMins, setRoundDurationMins] = useState(savedQF?.roundDuration ?? 3);
  const [timerSpeed, setTimerSpeed] = useState<TimerSpeed>(savedQF?.timerSpeed ?? "normal");
  const [maxRounds, setMaxRounds] = useState(savedQF?.maxRounds ?? 3);
  const [playerArmLength, setPlayerArmLength] = useState(savedQF?.playerArm ?? 65);
  const [enemyArmLength, setEnemyArmLength] = useState(savedQF?.enemyArm ?? 65);
  const [towelStoppageEnabled, setTowelStoppageEnabled] = useState(savedQF?.towelStoppage ?? true);
  const [practiceMode, setPracticeMode] = useState(savedQF?.practiceMode ?? false);
  const [recordInputs, setRecordInputs] = useState(savedQF?.recordInputs ?? false);
  const [cpuVsCpu, setCpuVsCpu] = useState(savedQF?.cpuVsCpu ?? false);
  const [aiPowerMult, setAiPowerMult] = useState(savedQF?.aiPowerMult ?? 1);
  const [aiSpeedMult, setAiSpeedMult] = useState(savedQF?.aiSpeedMult ?? 1);
  const [aiStaminaMult, setAiStaminaMult] = useState(savedQF?.aiStaminaMult ?? 1);
  const [selectedRosterFighters, setSelectedRosterFighters] = useState<RosterEntry[]>([]);
  const [careerRefStoppageEnabled, setCareerRefStoppageEnabled] = useState(() => {
    try { const v = localStorage.getItem("handz_career_ref_stoppage"); return v !== null ? v === "true" : true; } catch { return true; }
  });
  const [careerTowelStoppageEnabled, setCareerTowelStoppageEnabled] = useState(() => {
    try { const v = localStorage.getItem("handz_career_towel_stoppage"); return v !== null ? v === "true" : true; } catch { return true; }
  });
  const [trainingType, setTrainingType] = useState<TrainingType | null>(null);
  const [sparringDifficulty, setSparringDifficulty] = useState<AIDifficulty>("contender");
  const [isSparring, setIsSparring] = useState(false);
  const [careerOpponentId, setCareerOpponentId] = useState<number | null>(null);
  const [simulationNews, setSimulationNews] = useState<string[]>([]);
  const [pendingTrainingAlloc, setPendingTrainingAlloc] = useState<{
    points: number;
    allowedStats: (keyof SkillPoints)[];
    didSimulate: boolean;
    simulationNews?: string[];
  } | null>(null);
  const [tutorialStage, setTutorialStage] = useState(0);
  const [isTutorialFight, setIsTutorialFight] = useState(false);
  const [isCareerTutorial, setIsCareerTutorial] = useState(false);
  const careerTutorialInfoRef = useRef<{ name: string; colors: FighterColors } | null>(null);

  useEffect(() => {
    localStorage.setItem("quickFightSettings", JSON.stringify({
      playerLevel: quickFightPlayerLevel,
      enemyLevel: quickFightEnemyLevel,
      difficulty: aiDifficulty,
      roundDuration: roundDurationMins,
      timerSpeed,
      maxRounds,
      playerArm: playerArmLength,
      enemyArm: enemyArmLength,
      towelStoppage: towelStoppageEnabled,
      practiceMode,
      recordInputs,
      cpuVsCpu,
      aiPowerMult,
      aiSpeedMult,
      aiStaminaMult,
    }));
  }, [quickFightPlayerLevel, quickFightEnemyLevel, aiDifficulty, roundDurationMins, timerSpeed, maxRounds, playerArmLength, enemyArmLength, towelStoppageEnabled, practiceMode, recordInputs, cpuVsCpu, aiPowerMult, aiSpeedMult, aiStaminaMult]);

  const [fighters, setFighters] = useState<Fighter[]>([]);
  const [fightersLoading] = useState(false);

  useEffect(() => {
    setFighters(localSaves.getFighters());
  }, []);

  const refreshFighters = useCallback(() => {
    setFighters(localSaves.getFighters());
  }, []);

  const createFighterMutation = {
    mutate: (data: Record<string, unknown>, opts?: { onSuccess?: (res: any) => void }) => {
      const fighter = localSaves.createFighter(data as any);
      refreshFighters();
      opts?.onSuccess?.({ json: () => Promise.resolve(fighter) });
    },
    mutateAsync: async (data: Record<string, unknown>) => {
      const fighter = localSaves.createFighter(data as any);
      refreshFighters();
      return { json: () => Promise.resolve(fighter) };
    },
    isPending: false,
  };

  const deleteFighterMutation = {
    mutate: (id: string) => {
      localSaves.deleteFighter(id);
      refreshFighters();
    },
    isPending: false,
  };

  const updateFighterMutation = {
    mutate: ({ id, data }: { id: string; data: Record<string, unknown> }) => {
      localSaves.updateFighter(id, data as any);
      refreshFighters();
    },
    isPending: false,
  };

  const saveFightResultMutation = {
    mutate: (data: Record<string, unknown>) => {
      localSaves.createFightResult(data as any);
    },
    isPending: false,
  };

  const STAT_CAP = 200;
  const normalizeSkillPoints = (raw: unknown): SkillPoints => {
    const r = (raw || {}) as Partial<SkillPoints>;
    return {
      power: Math.max(0, Math.min(STAT_CAP, Math.floor(r.power || 0))),
      speed: Math.max(0, Math.min(STAT_CAP, Math.floor(r.speed || 0))),
      defense: Math.max(0, Math.min(STAT_CAP, Math.floor(r.defense || 0))),
      stamina: Math.max(0, Math.min(STAT_CAP, Math.floor(r.stamina || 0))),
      focus: Math.max(0, Math.min(STAT_CAP, Math.floor(r.focus || 0))),
    };
  };

  const runStatPointCheck = (fighter: Fighter) => {
    const sp = normalizeSkillPoints(fighter.skillPoints);
    const avail = Math.max(0, fighter.availableStatPoints || 0);
    const raw = (fighter.skillPoints || {}) as Partial<SkillPoints>;
    const needsFix =
      sp.power !== (raw.power ?? 0) ||
      sp.speed !== (raw.speed ?? 0) ||
      sp.defense !== (raw.defense ?? 0) ||
      sp.stamina !== (raw.stamina ?? 0) ||
      sp.focus !== (raw.focus ?? 0) ||
      avail !== (fighter.availableStatPoints || 0);
    if (needsFix) {
      console.log("[StatCheck] Fixed skill point integrity:", sp, "avail:", avail);
      updateFighterMutation.mutate({
        id: fighter.id,
        data: { skillPoints: sp, availableStatPoints: avail },
      });
      setActiveFighter(prev => prev ? { ...prev, skillPoints: sp, availableStatPoints: avail } : null);
    }
  };

  const startTutorialFight = useCallback((stage: number, playerName?: string, playerColors?: FighterColors) => {
    resetAutoZoom();
    setIsTutorialFight(true);
    setTutorialStage(stage);
    setIsCareerFight(false);
    setIsSparring(false);
    const name = playerName || careerTutorialInfoRef.current?.name || "Player";
    const colors = playerColors || careerTutorialInfoRef.current?.colors || { ...DEFAULT_PLAYER_COLORS };
    const newState = startFight(
      createInitialState(),
      "BoxerPuncher",
      10,
      10,
      name,
      colors,
      true,
      "journeyman",
      3,
      180,
      "normal",
      65,
      65,
      "BoxerPuncher",
      "Tutorial Opponent",
      undefined,
      false,
      false,
      false,
      false,
      false,
      undefined,
      false,
      undefined,
      1,
      1,
      1,
    );
    newState.tutorialMode = true;
    newState.tutorialStage = stage;
    newState.tutorialStep = 1;
    newState.tutorialAiIdle = true;
    newState.tutorialCareerMode = isCareerTutorial;
    newState.tutorialTracking = {
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
    };
    if (stage === 1) {
      newState.enemy.stamina = Math.round(newState.enemy.stamina / 4);
      newState.enemy.maxStamina = Math.round(newState.enemy.maxStamina / 4);
      newState.enemy.maxStaminaCap = Math.round(newState.enemy.maxStaminaCap / 4);
    } else if (stage === 2) {
      newState.enemy.stamina = Math.round(newState.enemy.stamina / 3);
      newState.enemy.maxStamina = Math.round(newState.enemy.maxStamina / 3);
      newState.enemy.maxStaminaCap = Math.round(newState.enemy.maxStaminaCap / 3);
    }
    setGameState(newState);
    setUiMode("fighting");
  }, [isCareerTutorial]);

  const handleStateChange = useCallback((newState: GameState) => {
    if (newState.pauseAction === "restart") {
      if (isTutorialFight) {
        startTutorialFight(tutorialStage);
        return;
      }
      resetAutoZoom();
      const restartState = startFight(
        createInitialState(),
        newState.player.archetype,
        newState.playerLevel,
        newState.enemyLevel,
        newState.player.name,
        newState.player.colors,
        newState.isQuickFight,
        newState.aiDifficulty,
        newState.totalRounds,
        newState.roundDuration,
        newState.timerSpeed,
        newState.player.armLength,
        newState.enemy.armLength,
        newState.enemy.archetype,
        newState.enemyName,
        undefined,
        false,
        newState.towelStoppageEnabled,
        newState.practiceMode,
        newState.recordInputs,
        newState.cpuVsCpu,
        undefined,
        false,
        undefined,
        newState.isQuickFight ? aiPowerMult : 1,
        newState.isQuickFight ? aiSpeedMult : 1,
        newState.isQuickFight ? aiStaminaMult : 1,
        undefined,
        newState.careerEnemySkillPoints
      );
      if (newState.careerEnemySkillPoints) {
        restartState.careerEnemySkillPoints = newState.careerEnemySkillPoints;
      }
      setGameState(restartState);
      return;
    }
    if (newState.pauseAction === "quit") {
      soundEngine.stopCrowdAmbient();
      setGameState(createInitialState());
      if (isTutorialFight) {
        setIsTutorialFight(false);
        if (isCareerTutorial) {
          setIsCareerTutorial(false);
          careerTutorialInfoRef.current = null;
          setUiMode("career");
        } else {
          setUiMode("tutorial");
        }
        return;
      }
      const goBack = isCareerFight || isSparring ? "career" : "menu";
      if ((isCareerFight || isSparring) && preFightSnapshot) {
        setActiveFighter(preFightSnapshot);
        updateFighterMutation.mutate({
          id: preFightSnapshot.id,
          data: {
            xp: preFightSnapshot.xp,
            level: preFightSnapshot.level,
            skillPoints: preFightSnapshot.skillPoints,
            careerStats: preFightSnapshot.careerStats,
            trainingBonuses: preFightSnapshot.trainingBonuses,
            careerRosterState: preFightSnapshot.careerRosterState,
          },
        });
        setPreFightSnapshot(null);
      }
      setIsSparring(false);
      setTrainingType(null);
      setUiMode(goBack);
      return;
    }

    setGameState(newState);
    if (newState.phase === "fightEnd" && uiMode === "fighting") {
      soundEngine.stopCrowdAmbient();
      setUiMode("fightEnd");
      if (isSparring && activeFighter) {
        const sparringWon = newState.fightWinner === "player";
        const sparLevelTrainingMult = activeFighter.level >= 20 ? 1.2 : 1.0;
        const sparringBase = 400 * (activeFighter.level / 100) * 0.5 * 20 * 4 * 0.7;
        const sparringDiffMult = SPARRING_XP_MULT[sparringDifficulty];
        const winMult = sparringWon ? 1.0 : 0.4;
        const sparBoutScale = Math.pow(1.2, activeFighter.careerBoutIndex);
        const xpGained = Math.max(1, Math.floor(sparringBase * sparringDiffMult * winMult * sparBoutScale * sparLevelTrainingMult));

        let sparringAllocPoints = 1;
        if (sparringWon) {
          if (sparringDifficulty === "journeyman") sparringAllocPoints = 2;
          else if (sparringDifficulty === "contender") sparringAllocPoints = 3;
          else if (sparringDifficulty === "elite") sparringAllocPoints = 4;
          else if (sparringDifficulty === "champion") sparringAllocPoints = 5;
        }

        const thrown = newState.player.punchesThrown;
        const landed = newState.player.punchesLanded;
        const accuracy = thrown > 0 ? landed / thrown : 0;
        if (accuracy > 0.6) sparringAllocPoints += 1;
        else if (accuracy > 0.4) sparringAllocPoints += 1;

        if (activeFighter.level >= 20 && accuracy > 0.6) {
          const sparTiers = Math.floor(activeFighter.level / 10) - 1;
          sparringAllocPoints += sparTiers * 2;
        }

        const isKO = newState.fightResult === "KO" || newState.fightResult === "TKO";
        if (isKO && newState.gameTime < 30 && sparringDifficulty !== "journeyman") {
          sparringAllocPoints += 1;
        }

        const sparFightScaleMult = Math.pow(1.3, activeFighter.careerBoutIndex);
        const sparringBonusXp = Math.floor(
          ((newState.player.punchesLanded * 2) +
          (newState.player.cleanPunchesLanded * 10) +
          (newState.player.feintBaits * 20)) * sparFightScaleMult * 0.7
        );

        const sparRs = activeFighter.careerRosterState as CareerRosterState | null;
        const sparPrepMult = sparRs?.prepWeeksRemaining === 1 ? 4.5 : sparRs?.prepWeeksRemaining === 2 ? 2 : 1;
        const sparTb = (activeFighter.trainingBonuses || DEFAULT_TRAINING_BONUSES) as TrainingBonuses;
        const sparPostFightBoost = sparTb.postFightXpBoost ? Math.pow(1.3, sparTb.postFightXpBoost) : 1.0;
        const midFightLevel = newState.midFightLevelUps > 0 ? newState.playerLevel : activeFighter.level;
        const midFightXp = newState.midFightLevelUps > 0 ? newState.playerCurrentXp : activeFighter.xp;
        let newXp = midFightXp + Math.floor((xpGained + sparringBonusXp) * sparPrepMult * sparPostFightBoost);
        let newLevel = midFightLevel;
        while (newXp >= xpToNextLevel(newLevel)) {
          newXp -= xpToNextLevel(newLevel);
          newLevel++;
        }

        const oldStats = (activeFighter.careerStats || DEFAULT_CAREER_STATS) as CareerStats;
        const newCareerStats: CareerStats = {
          ...oldStats,
          lifetimeXp: oldStats.lifetimeXp + xpGained + sparringBonusXp,
        };

        const tb = (activeFighter.trainingBonuses || DEFAULT_TRAINING_BONUSES) as TrainingBonuses;
        const sparExistingBuffs = tb.nextFightBuffs || {};
        let sparUpdatedBuffs = { ...sparExistingBuffs };
        if (sparringWon && accuracy >= 0.8) {
          sparUpdatedBuffs.doubleStun = true;
          sparUpdatedBuffs.extraWhiff = true;
        }
        const newTB: TrainingBonuses = {
          ...tb,
          sparring: (tb.sparring || 0) + 1,
          nextFightBuffs: sparUpdatedBuffs,
        };

        runStatPointCheck(activeFighter);

        let updatedRosterState = activeFighter.careerRosterState as CareerRosterState | null;
        let didSimulate = false;
        if (updatedRosterState) {
          const weekSeed = Date.now();
          updatedRosterState = simulateWeek(updatedRosterState, weekSeed, activeFighter.careerDifficulty, activeFighter.level);
          updatedRosterState = { ...updatedRosterState, trainingsSinceLastWeek: 0 };
          didSimulate = true;
          const pRating = updatedRosterState.playerRatingScore ?? 1000;
          const newPlayerRank = computePlayerRankFromRating(updatedRosterState.roster, pRating);
          updatedRosterState = {
            ...updatedRosterState,
            playerRank: newPlayerRank,
            savedChargeBars: newState.player.chargeMeterBars,
            savedChargeCounters: newState.player.chargeMeterCounters,
          };
        }

        updateFighterMutation.mutate({
          id: activeFighter.id,
          data: {
            xp: newXp,
            level: newLevel,
            trainingBonuses: newTB,
            careerStats: newCareerStats,
            careerRosterState: updatedRosterState,
          },
        });

        setActiveFighter(prev => prev ? {
          ...prev,
          xp: newXp,
          level: newLevel,
          trainingBonuses: newTB,
          careerStats: newCareerStats,
          careerRosterState: updatedRosterState,
        } : null);

        const sparPlaystyle = extractPlayerPlaystyle(newState);
        savePlayerPlaystyle(activeFighter.id, sparPlaystyle);

        setPendingTrainingAlloc({
          points: sparringAllocPoints,
          allowedStats: activeFighter.level >= 50 ? ["speed", "defense", "stamina", "focus"] : ["speed", "defense", "stamina"],
          didSimulate,
          simulationNews: didSimulate && updatedRosterState ? updatedRosterState.newsItems : undefined,
        });
      } else if (isCareerFight && activeFighter) {
        const isWin = newState.fightWinner === "player";
        const isDraw = newState.fightResult === "Draw";
        const isKO = newState.fightResult === "KO" || newState.fightResult === "TKO";

        const fightBonusMult = Math.pow(1.3, activeFighter.careerBoutIndex);
        const fightBonusXp = Math.floor(
          (newState.player.cleanPunchesLanded * 20 +
           newState.player.feintBaits * 40 +
           newState.player.knockdownsGiven * 100) * fightBonusMult * 0.7
        );

        const thrown = newState.player.punchesThrown;
        const landed = newState.player.punchesLanded;
        const accuracy = thrown > 0 ? landed / thrown : 0;
        let accuracyMult = 1.0;
        let accuracyBonusStat = 0;
        if (accuracy >= 0.75) { accuracyMult = 2.5; accuracyBonusStat = 1; }
        else if (accuracy >= 0.70) accuracyMult = 2.2;
        else if (accuracy >= 0.65) accuracyMult = 1.9;
        else if (accuracy >= 0.60) accuracyMult = 1.6;
        else if (accuracy >= 0.50) accuracyMult = 1.3;

        const totalXp = Math.floor((newState.xpGained * fightBonusMult + fightBonusXp) * accuracyMult);
        const midFightLevel = newState.midFightLevelUps > 0 ? newState.playerLevel : activeFighter.level;
        const midFightXp = newState.midFightLevelUps > 0 ? newState.playerCurrentXp : activeFighter.xp;
        let newXp = midFightXp + totalXp;
        let newLevel = midFightLevel;
        while (newXp >= xpToNextLevel(newLevel)) {
          newXp -= xpToNextLevel(newLevel);
          newLevel++;
        }

        const perfStats = extractPerformanceStats(newState);
        const oldStats = (activeFighter.careerStats || DEFAULT_CAREER_STATS) as CareerStats;
        const newCareerStats: CareerStats = {
          totalPunchesThrown: oldStats.totalPunchesThrown + perfStats.punchesThrown,
          totalPunchesLanded: oldStats.totalPunchesLanded + perfStats.punchesLanded,
          totalKnockdownsGiven: oldStats.totalKnockdownsGiven + perfStats.knockdownsGiven,
          totalKnockdownsTaken: oldStats.totalKnockdownsTaken + perfStats.knockdownsTaken,
          totalBlocksMade: oldStats.totalBlocksMade + perfStats.blocksMade,
          totalDodges: oldStats.totalDodges + perfStats.dodges,
          totalDamageDealt: oldStats.totalDamageDealt + perfStats.damageDealt,
          totalDamageReceived: oldStats.totalDamageReceived + perfStats.damageReceived,
          totalRoundsWon: oldStats.totalRoundsWon + perfStats.roundsWon,
          totalRoundsLost: oldStats.totalRoundsLost + perfStats.roundsLost,
          lifetimeXp: oldStats.lifetimeXp + newState.xpGained,
        };

        const newBoutIndex = activeFighter.careerBoutIndex + 1;
        const newWins = activeFighter.wins + (isWin ? 1 : 0);
        const newLosses = activeFighter.losses + (!isWin && !isDraw ? 1 : 0);
        const newDraws = activeFighter.draws + (isDraw ? 1 : 0);
        const newKnockouts = activeFighter.knockouts + (isWin && isKO ? 1 : 0);

        runStatPointCheck(activeFighter);

        let updatedRosterState = activeFighter.careerRosterState as CareerRosterState | null;
        if (updatedRosterState && careerOpponentId) {
          const newRoster = updatedRosterState.roster.map(f => {
            if (f.id === careerOpponentId) {
              const updated = { ...f };
              if (isWin) {
                updated.losses++;
                updated.totalFights++;
                if (KEY_FIGHTER_IDS.includes(f.id)) {
                  updated.beatenByPlayer = true;
                }
              } else if (isDraw) {
                updated.draws++;
                updated.totalFights++;
              } else {
                updated.wins++;
                updated.totalFights++;
                if (isKO) updated.knockouts++;
              }
              return updated;
            }
            return { ...f };
          });
          const oppEntry = newRoster.find(f => f.id === careerOpponentId);
          const oppRank = oppEntry?.rank ?? 999;
          const oppRating = oppEntry?.ratingScore ?? 1000;

          let method: "close" | "dominant" | "ko" = "close";
          if (isKO) method = "ko";
          else {
            const kdsGiven = perfStats.knockdownsGiven;
            if (kdsGiven >= 2) method = "dominant";
          }

          const careerDiff = (activeFighter.careerDifficulty as AIDifficulty) || "contender";
          const preFightPlayerRating = updatedRosterState.playerRatingScore ?? 1000;
          let pRating = updatePlayerRating(preFightPlayerRating, oppRating, isWin, method, careerDiff, oppRank);

          if (isWin && oppEntry) {
            const { loserDelta } = computeEloChange(preFightPlayerRating, oppRating, method, 1.0, oppRank === 1);
            oppEntry.ratingScore = (oppEntry.ratingScore ?? 1000) + loserDelta;
          } else if (!isWin && !isDraw && oppEntry) {
            const { winnerDelta } = computeEloChange(oppRating, preFightPlayerRating, method, 1.0, false);
            oppEntry.ratingScore = (oppEntry.ratingScore ?? 1000) + winnerDelta;
          }

          updateRankings(newRoster);
          const newPlayerRank = computePlayerRankFromRating(newRoster, pRating);

          updatedRosterState = {
            ...updatedRosterState,
            roster: newRoster,
            selectedOpponentId: null,
            playerRank: newPlayerRank,
            playerRatingScore: pRating,
            prepWeeksRemaining: undefined,
            savedChargeBars: newState.player.chargeMeterBars,
            savedChargeCounters: newState.player.chargeMeterCounters,
          };
        }

        const careerDiffForPoints = (activeFighter.careerDifficulty as AIDifficulty) || "contender";
        let fightStatPoints = (careerDiffForPoints === "champion" ? 5 : careerDiffForPoints === "elite" ? 2 : 1) + accuracyBonusStat;
        if (activeFighter.level >= 20 && accuracy > 0.6) {
          const fightTiers = Math.floor(activeFighter.level / 10) - 1;
          fightStatPoints += fightTiers * 2;
        }
        const newStatPoints = activeFighter.availableStatPoints + fightStatPoints;

        const preTB = (activeFighter.trainingBonuses || DEFAULT_TRAINING_BONUSES) as TrainingBonuses;
        const clearedTB: TrainingBonuses = {
          ...preTB,
          nextFightBuffs: undefined,
          postFightXpBoost: (preTB.postFightXpBoost || 0) + 1,
        };

        updateFighterMutation.mutate({
          id: activeFighter.id,
          data: {
            xp: newXp,
            level: newLevel,
            wins: newWins,
            losses: newLosses,
            draws: newDraws,
            knockouts: newKnockouts,
            careerBoutIndex: newBoutIndex,
            availableStatPoints: newStatPoints,
            careerStats: newCareerStats,
            careerRosterState: updatedRosterState,
            trainingBonuses: clearedTB,
          },
        });

        setActiveFighter(prev => prev ? {
          ...prev,
          availableStatPoints: newStatPoints,
        } : null);

        const careerPlaystyle = extractPlayerPlaystyle(newState);
        savePlayerPlaystyle(activeFighter.id, careerPlaystyle);

        saveFightResultMutation.mutate({
          fighterId: activeFighter.id,
          opponentName: newState.enemyName,
          opponentLevel: newState.enemyLevel,
          opponentArchetype: newState.enemy.archetype,
          result: isWin ? "win" : (isDraw ? "draw" : "loss"),
          method: newState.fightResult || "Decision",
          rounds: newState.currentRound,
          xpGained: newState.xpGained,
          boutNumber: newBoutIndex,
        });

        setActiveFighter(prev => prev ? {
          ...prev,
          xp: newXp,
          level: newLevel,
          wins: newWins,
          losses: newLosses,
          draws: newDraws,
          knockouts: newKnockouts,
          careerBoutIndex: newBoutIndex,
          careerStats: newCareerStats,
          careerRosterState: updatedRosterState,
          trainingBonuses: clearedTB,
        } : null);
      }
    }
  }, [uiMode, isCareerFight, isSparring, activeFighter, careerOpponentId, sparringDifficulty, isTutorialFight, tutorialStage, startTutorialFight, isCareerTutorial]);

  const handleQuickFight = () => {
    setIsCareerFight(false);
    setActiveFighter(null);
    try {
      const raw = localStorage.getItem("quickFightColors");
      if (raw) setPlayerColors(JSON.parse(raw));
      else setPlayerColors({ ...DEFAULT_PLAYER_COLORS });
    } catch { setPlayerColors({ ...DEFAULT_PLAYER_COLORS }); }
    setUiMode("classSelect");
  };

  const handleCareer = () => {
    setUiMode("career");
  };

  const handleEditRoster = () => {
    const fighterWithRoster = fighters.find(f => f.careerRosterState);
    if (fighterWithRoster) {
      setActiveFighter(fighterWithRoster);
      setUiMode("rosterEdit");
    } else if (fighters.length > 0) {
      const f = fighters[0];
      const rs = initRosterState(f.id + f.name, f.careerDifficulty as AIDifficulty);
      const pr = computePlayerRankFromRating(rs.roster, rs.playerRatingScore);
      const initialized = { ...rs, playerRank: pr };
      handleInitRoster(f.id, initialized);
      setActiveFighter({ ...f, careerRosterState: initialized });
      setUiMode("rosterEdit");
    } else {
      const rs = initRosterState("default_roster", "contender" as AIDifficulty);
      const tempFighter = {
        id: -1,
        name: "Roster Preview",
        archetype: "BoxerPuncher",
        level: 1,
        xp: 0,
        wins: 0,
        losses: 0,
        draws: 0,
        knockouts: 0,
        statPoints: 0,
        speed: 50,
        power: 50,
        defense: 50,
        stamina: 50,
        careerBoutIndex: 0,
        careerDifficulty: "contender",
        careerRosterState: rs,
      } as any;
      setActiveFighter(tempFighter);
      setUiMode("rosterEdit");
    }
  };

  const handleStartFight = (playerLevel: number, enemyLevel: number, name?: string, isQuick: boolean = false, enemyArch?: Archetype, careerAiDiff?: AIDifficulty, careerRoundLen?: number, eArm?: number, enemyName?: string, enemyColors?: FighterColors, overridePlayerColors?: FighterColors, overrideFighter?: Fighter, careerRounds?: number, careerSpeed?: TimerSpeed, enemyRosterId?: number, enemyRank?: number, rosterStats?: { power?: number; speed?: number; defense?: number; stamina?: number; focus?: number }) => {
    const fighter = overrideFighter || activeFighter;
    const rounds = isQuick ? maxRounds : (careerRounds || 3);
    const duration = isQuick ? roundDurationMins * 60 : (careerRoundLen || 3) * 60;
    const speed = isQuick ? timerSpeed : (careerSpeed || "normal" as TimerSpeed);
    const pArm = isQuick ? playerArmLength : 65;
    const enemyArmLen = isQuick ? enemyArmLength : (eArm || 65);
    const diff = isQuick ? aiDifficulty : (careerAiDiff || "contender");
    const tb = !isQuick && fighter
      ? (fighter.trainingBonuses || DEFAULT_TRAINING_BONUSES) as TrainingBonuses
      : undefined;
    const towel = isQuick ? towelStoppageEnabled : careerTowelStoppageEnabled;
    const mercy = isQuick ? true : careerRefStoppageEnabled;
    const practice = isQuick ? practiceMode : false;
    const record = isQuick ? recordInputs : true;
    const simMode = isQuick ? cpuVsCpu : false;
    const fightColors = overridePlayerColors || (!isQuick && fighter ? fighterToColors(fighter) : playerColors);
    const careerTier = !isQuick && careerAiDiff ? careerAiDiff : undefined;
    const sp = !isQuick && fighter ? (fighter.skillPoints as SkillPoints) : undefined;
    let enemySp: SkillPoints | undefined = undefined;
    if (!isQuick && rosterStats && rosterStats.power != null) {
      enemySp = {
        power: rosterStats.power ?? 0,
        speed: rosterStats.speed ?? 0,
        defense: rosterStats.defense ?? 0,
        stamina: rosterStats.stamina ?? 0,
        focus: rosterStats.focus ?? 0,
      };
    } else if (!isQuick && sp) {
      const diffBias = diff === "champion" ? 0.7 : diff === "elite" ? 0.6 : diff === "contender" ? 0.5 : 0.35;
      const maxVar = enemyRank != null
        ? (enemyRank <= 10 ? 20 : enemyRank <= 50 ? 15 : enemyRank <= 100 ? 10 : 5)
        : 20;
      const genStat = (base: number) => {
        const r = Math.random();
        const biased = r < diffBias ? 0.5 + r / diffBias * 0.5 : r;
        const mult = 0.8 + biased * 0.4;
        const raw = Math.round(base * mult);
        return Math.max(0, Math.min(base + maxVar, Math.max(base - maxVar, raw)));
      };
      enemySp = { power: genStat(sp.power), speed: genStat(sp.speed), defense: genStat(sp.defense), stamina: genStat(sp.stamina), focus: 0 };
    }
    resetAutoZoom();
    const newState = startFight(gameState, isQuick ? selectedArchetype : (fighter?.archetype as Archetype || selectedArchetype), playerLevel, enemyLevel, name, fightColors, isQuick, diff, rounds, duration, speed, pArm, enemyArmLen, enemyArch, enemyName, tb, false, towel, practice, record, simMode, enemyColors, false, careerTier, isQuick ? aiPowerMult : 1, isQuick ? aiSpeedMult : 1, isQuick ? aiStaminaMult : 1, sp, enemySp, mercy, enemyRosterId);
    if (enemySp) {
      newState.careerEnemySkillPoints = enemySp;
    }
    const effectiveCareerFight = isCareerFight || (!isQuick && careerAiDiff != null && !isSparring);
    if (effectiveCareerFight || isSparring) {
      if (effectiveCareerFight) newState.careerFightMode = true;
      if (fighter) newState.playerCurrentXp = fighter.xp;
      const rs = fighter?.careerRosterState as CareerRosterState | null;
      if (rs && (rs.savedChargeBars || rs.savedChargeCounters)) {
        newState.player.chargeMeterBars = rs.savedChargeBars || 0;
        newState.player.chargeMeterCounters = rs.savedChargeCounters || 0;
      }
      if (activeFighter) {
        setPreFightSnapshot(JSON.parse(JSON.stringify(activeFighter)));
      }
    }
    setGameState(newState);
    setUiMode("fighting");
  };

  const handleConfirmClass = () => {
    if (isCareerFight && activeFighter && careerOpponentId) {
      const rosterState = activeFighter.careerRosterState as CareerRosterState | null;
      if (!rosterState) return;
      const oppState = rosterState.roster.find(f => f.id === careerOpponentId);
      if (!oppState) return;
      const opp = buildOpponentFromRoster(oppState);
      if (!opp) return;

      const playerName = activeFighter.firstName
        ? (activeFighter.nickname
          ? `${activeFighter.firstName} "${activeFighter.nickname}" ${activeFighter.lastName}`
          : `${activeFighter.firstName} ${activeFighter.lastName}`)
        : activeFighter.name;

      const oppColors = getRosterFighterColors(oppState);
      const enemyFighterColors: FighterColors = {
        gloves: oppColors.gloves,
        gloveTape: oppColors.gloveTape,
        trunks: oppColors.trunks,
        shoes: oppColors.shoes,
        skin: oppColors.skin,
      };

      let savedRoundLen = 3;
      let savedTimerSpeed: TimerSpeed = "normal";
      try {
        const rl = localStorage.getItem("handz_career_round_len");
        if (rl) savedRoundLen = parseInt(rl) || 3;
        const ts = localStorage.getItem("handz_career_timer_speed");
        if (ts === "fast") savedTimerSpeed = "fast";
      } catch {}

      let careerRounds = 3;
      if (oppState.rank === 1) {
        careerRounds = 12;
      } else if (KEY_FIGHTER_IDS.includes(oppState.id)) {
        careerRounds = 6;
      }

      const cd = activeFighter.careerDifficulty as AIDifficulty;
      const prepWeeks = rosterState.prepWeeksRemaining ?? 0;
      const shortCap = cd === "champion" ? 4 : cd === "elite" ? 3 : cd === "contender" ? 3 : 2;
      const longCap = cd === "champion" ? 6 : cd === "elite" ? 5 : cd === "contender" ? 5 : 4;
      const levelCap = prepWeeks > 4 ? longCap : shortCap;
      const cappedEnemyLevel = Math.min(opp.level, activeFighter.level + levelCap);

      handleStartFight(
        activeFighter.level,
        cappedEnemyLevel,
        playerName,
        false,
        opp.archetype,
        opp.aiDifficulty,
        savedRoundLen,
        opp.armLength,
        opp.name,
        enemyFighterColors,
        fighterToColors(activeFighter),
        activeFighter,
        careerRounds,
        savedTimerSpeed,
        opp.rosterId,
        oppState.rank,
        { power: opp.statPower, speed: opp.statSpeed, defense: opp.statDefense, stamina: opp.statStamina, focus: opp.statFocus }
      );
    } else {
      let rosterOpp;
      if (selectedRosterFighters.length > 0) {
        const pick = selectedRosterFighters[Math.floor(Math.random() * selectedRosterFighters.length)];
        const name = pick.nickname
          ? `${pick.firstName} "${pick.nickname}" ${pick.lastName}`
          : `${pick.firstName} ${pick.lastName}`;
        rosterOpp = {
          rosterId: pick.id,
          name,
          archetype: pick.archetype,
          armLength: Math.round(58 + Math.random() * 17),
        };
      } else {
        const rand = getRandomQuickFightOpponent(aiDifficulty);
        rosterOpp = { rosterId: rand.rosterId, name: rand.name, archetype: rand.archetype, armLength: rand.armLength };
      }
      const qfColors = getQuickFightColorsForRosterId(rosterOpp.rosterId);
      const qfEnemyColors: FighterColors = {
        gloves: qfColors.gloves,
        gloveTape: qfColors.gloveTape,
        trunks: qfColors.trunks,
        shoes: qfColors.shoes,
        skin: qfColors.skin,
      };
      handleStartFight(
        quickFightPlayerLevel,
        quickFightEnemyLevel,
        undefined,
        true,
        rosterOpp.archetype,
        undefined,
        undefined,
        rosterOpp.armLength,
        rosterOpp.name,
        qfEnemyColors,
        undefined,
        undefined,
        undefined,
        undefined,
        rosterOpp.rosterId
      );
    }
  };

  const handleNextRound = () => {
    const newState = startNextRound({ ...gameState });
    setGameState(newState);
    setUiMode("fighting");
  };

  const handleContinue = () => {
    soundEngine.stopCrowdAmbient();
    const wasTutorial = isTutorialFight;
    const currentTutorialStage = tutorialStage;
    const tutorialWon = gameState.fightWinner === "player";
    setGameState(createInitialState());
    setPreFightSnapshot(null);
    if (wasTutorial) {
      setIsTutorialFight(false);
      if (tutorialWon && currentTutorialStage === 1) {
        setTutorialStage(2);
        startTutorialFight(2);
        return;
      } else if (tutorialWon && currentTutorialStage === 2) {
        if (isCareerTutorial) {
          setIsCareerTutorial(false);
          careerTutorialInfoRef.current = null;
          setUiMode("career");
        } else {
          setUiMode("tutorialComplete");
        }
        return;
      } else {
        if (isCareerTutorial) {
          setIsCareerTutorial(false);
          careerTutorialInfoRef.current = null;
          setUiMode("career");
        } else {
          setUiMode("tutorial");
        }
        return;
      }
    }
    const wasSparring = isSparring;
    const wasCareer = isCareerFight;
    setIsSparring(false);
    setIsCareerFight(false);
    setTrainingType(null);
    setCareerOpponentId(null);
    if (wasSparring && pendingTrainingAlloc) {
      setUiMode("trainingAllocate");
    } else if (wasCareer || wasSparring) {
      setUiMode("career");
    } else {
      setUiMode("menu");
    }
  };

  const fighterToColors = (fighter: Fighter): FighterColors => {
    const gc = (fighter.gearColors || DEFAULT_GEAR_COLORS) as GearColors;
    return {
      gloves: gc.gloves,
      gloveTape: gc.gloveTape,
      trunks: gc.trunks,
      shoes: gc.shoes,
      skin: fighter.skinColor || "#e8c4a0",
    };
  };

  const handleSelectCareerFighter = (fighter: Fighter, opponentId: number) => {
    setActiveFighter(fighter);
    setSelectedArchetype(fighter.archetype as Archetype);
    setIsCareerFight(true);
    setCareerOpponentId(opponentId);

    const careerColors = fighterToColors(fighter);
    setPlayerColors(careerColors);

    const rosterState = fighter.careerRosterState as CareerRosterState | null;
    if (!rosterState) return;
    const oppState = rosterState.roster.find(f => f.id === opponentId);
    if (!oppState) return;
    const opp = buildOpponentFromRoster(oppState);
    if (!opp) return;

    const playerName = fighter.firstName
      ? (fighter.nickname
        ? `${fighter.firstName} "${fighter.nickname}" ${fighter.lastName}`
        : `${fighter.firstName} ${fighter.lastName}`)
      : fighter.name;

    const oppColors = getRosterFighterColors(oppState);
    const enemyFighterColors: FighterColors = {
      gloves: oppColors.gloves,
      gloveTape: oppColors.gloveTape,
      trunks: oppColors.trunks,
      shoes: oppColors.shoes,
      skin: oppColors.skin,
    };

    const cd2 = fighter.careerDifficulty as AIDifficulty;
    const prepWeeks2 = rosterState.prepWeeksRemaining ?? 0;
    const shortCap2 = cd2 === "champion" ? 4 : cd2 === "elite" ? 3 : cd2 === "contender" ? 3 : 2;
    const longCap2 = cd2 === "champion" ? 6 : cd2 === "elite" ? 5 : cd2 === "contender" ? 5 : 4;
    const levelCap2 = prepWeeks2 > 4 ? longCap2 : shortCap2;
    const cappedEnemyLevel2 = Math.min(opp.level, fighter.level + levelCap2);

    handleStartFight(
      fighter.level,
      cappedEnemyLevel2,
      playerName,
      false,
      opp.archetype,
      opp.aiDifficulty,
      fighter.roundLengthMins || 3,
      opp.armLength,
      opp.name,
      enemyFighterColors,
      careerColors,
      fighter,
      undefined,
      undefined,
      opp.rosterId,
      oppState.rank,
      { power: opp.statPower, speed: opp.statSpeed, defense: opp.statDefense, stamina: opp.statStamina, focus: opp.statFocus }
    );
  };

  const handleCreateFighter = (data: {
    firstName: string;
    nickname: string;
    lastName: string;
    archetype: Archetype;
    careerDifficulty: AIDifficulty;
    roundLengthMins: number;
    skinColor: string;
    gearColors: GearColors;
  }) => {
    const displayName = data.nickname
      ? `${data.firstName} "${data.nickname}" ${data.lastName}`
      : `${data.firstName} ${data.lastName}`;

    const rosterState = initRosterState(displayName + Date.now(), data.careerDifficulty);

    createFighterMutation.mutate({
      name: displayName,
      firstName: data.firstName,
      nickname: data.nickname,
      lastName: data.lastName,
      archetype: data.archetype,
      careerDifficulty: data.careerDifficulty,
      roundLengthMins: data.roundLengthMins,
      skinColor: data.skinColor,
      gearColors: data.gearColors,
      careerRosterState: rosterState,
    });
  };

  const handleStartTraining = (fighter: Fighter, type: TrainingType, sparDiff?: AIDifficulty) => {
    setActiveFighter(fighter);
    setTrainingType(type);
    if (type === "sparring" && sparDiff) {
      setSparringDifficulty(sparDiff);
      setIsSparring(true);
      setIsCareerFight(false);

      const playerName = fighter.firstName
        ? (fighter.nickname
          ? `${fighter.firstName} "${fighter.nickname}" ${fighter.lastName}`
          : `${fighter.firstName} ${fighter.lastName}`)
        : fighter.name;

      const careerColors = fighterToColors(fighter);
      setPlayerColors(careerColors);

      const tb = (fighter.trainingBonuses || DEFAULT_TRAINING_BONUSES) as TrainingBonuses;

      const rosterState = fighter.careerRosterState as CareerRosterState | null;
      let sparPartnerName = "Sparring Partner";
      let sparPartnerArch: Archetype | undefined = undefined;
      let sparPartnerArm = 65;
      let sparPartnerColors: FighterColors | undefined = undefined;
      let sparPartnerRosterId: number | undefined = undefined;

      const foughtOpponents = rosterState ? rosterState.roster.filter(f => f.beatenByPlayer) : [];
      const usePreviousOpponent = fighter.careerBoutIndex >= 3 && foughtOpponents.length > 0 && Math.random() < 0.35;

      if (usePreviousOpponent && foughtOpponents.length > 0) {
        const sparPartner = foughtOpponents[Math.floor(Math.random() * foughtOpponents.length)];
        sparPartnerName = sparPartner.name;
        sparPartnerArch = sparPartner.archetype as Archetype;
        sparPartnerArm = sparPartner.armLength || 65;
        sparPartnerRosterId = sparPartner.id;
        const sc = getRosterFighterColors(sparPartner);
        sparPartnerColors = {
          gloves: sc.gloves,
          gloveTape: sc.gloveTape,
          trunks: sc.trunks,
          shoes: sc.shoes,
          skin: sc.skin,
        };
      } else if (rosterState && rosterState.roster.length > 0) {
        const randomIdx = Math.floor(Math.random() * rosterState.roster.length);
        const sparPartner = rosterState.roster[randomIdx];
        sparPartnerName = sparPartner.name;
        sparPartnerArch = sparPartner.archetype as Archetype;
        sparPartnerArm = sparPartner.armLength || 65;
        sparPartnerRosterId = sparPartner.id;
        const sc = getRosterFighterColors(sparPartner);
        sparPartnerColors = {
          gloves: sc.gloves,
          gloveTape: sc.gloveTape,
          trunks: sc.trunks,
          shoes: sc.shoes,
          skin: sc.skin,
        };
      }

      const sparSp = fighter.skillPoints as SkillPoints | null;
      let sparEnemySp: SkillPoints | undefined = undefined;
      const sparPartnerState = sparPartnerRosterId
        ? rosterState?.roster.find(f => f.id === sparPartnerRosterId)
        : undefined;
      if (sparPartnerState && sparPartnerState.statPower != null) {
        sparEnemySp = {
          power: sparPartnerState.statPower ?? 0,
          speed: sparPartnerState.statSpeed ?? 0,
          defense: sparPartnerState.statDefense ?? 0,
          stamina: sparPartnerState.statStamina ?? 0,
          focus: sparPartnerState.statFocus ?? 0,
        };
      } else if (sparSp) {
        const playerRank = rosterState?.playerRank ?? 150;
        const sparMaxVar = playerRank <= 10 ? 20 : playerRank <= 50 ? 15 : playerRank <= 100 ? 10 : 5;
        const sparDiffBias = sparDiff === "champion" ? 0.7 : sparDiff === "elite" ? 0.6 : sparDiff === "contender" ? 0.5 : 0.35;
        const genSparStat = (base: number) => {
          const r = Math.random();
          const biased = r < sparDiffBias ? 0.5 + r / sparDiffBias * 0.5 : r;
          const mult = 0.8 + biased * 0.4;
          const raw = Math.round(base * mult);
          return Math.max(0, Math.min(base + sparMaxVar, Math.max(base - sparMaxVar, raw)));
        };
        sparEnemySp = { power: genSparStat(sparSp.power), speed: genSparStat(sparSp.speed), defense: genSparStat(sparSp.defense), stamina: genSparStat(sparSp.stamina), focus: 0 };
      }

      resetAutoZoom();
      const newState = startFight(
        gameState,
        fighter.archetype as Archetype,
        fighter.level,
        fighter.level,
        playerName,
        careerColors,
        false,
        sparDiff,
        1,
        60,
        "normal" as TimerSpeed,
        65,
        sparPartnerArm,
        sparPartnerArch,
        sparPartnerName,
        tb,
        false,
        false,
        false,
        true,
        false,
        sparPartnerColors,
        true,
        undefined,
        1,
        1,
        1,
        sparSp || undefined,
        sparEnemySp,
        true,
        sparPartnerRosterId
      );
      const rs = fighter.careerRosterState as CareerRosterState | null;
      if (rs && (rs.savedChargeBars || rs.savedChargeCounters)) {
        newState.player.chargeMeterBars = rs.savedChargeBars || 0;
        newState.player.chargeMeterCounters = rs.savedChargeCounters || 0;
      }
      setGameState(newState);
      setUiMode("fighting");
    } else {
      setUiMode("training");
    }
  };

  const handleTrainingComplete = (xpGained: number, reps: number) => {
    if (!activeFighter || !trainingType) return;

    const tb = (activeFighter.trainingBonuses || DEFAULT_TRAINING_BONUSES) as TrainingBonuses;
    const existingBuffs = tb.nextFightBuffs || {};
    let updatedBuffs = { ...existingBuffs };
    if (trainingType === "weightLifting" && reps >= 15) {
      updatedBuffs.doubleCrit = true;
    }
    if (trainingType === "heavyBag" && reps >= 20) {
      updatedBuffs.moveSpeedBoost = true;
    }
    const newTB: TrainingBonuses = {
      ...tb,
      [trainingType]: tb[trainingType] + 1,
      nextFightBuffs: updatedBuffs,
    };

    const wlBonusXp = trainingType === "weightLifting" && reps >= 20 ? 1.5 : 1;
    const levelTrainingMult = activeFighter.level >= 20 ? 1.2 : 1.0;
    const fightMult = Math.pow(1.2, activeFighter.careerBoutIndex);
    const trainRs = activeFighter.careerRosterState as CareerRosterState | null;
    const trainPrepMult = trainRs?.prepWeeksRemaining === 1 ? 4.5 : trainRs?.prepWeeksRemaining === 2 ? 2 : 1;
    const postFightBoost = (tb as TrainingBonuses).postFightXpBoost ? Math.pow(1.3, (tb as TrainingBonuses).postFightXpBoost!) : 1.0;
    const scaledXp = Math.max(1, Math.floor(xpGained * 0.7 * (1 + activeFighter.level * 0.04) * fightMult * trainPrepMult * wlBonusXp * postFightBoost * levelTrainingMult));
    let newXp = activeFighter.xp + scaledXp;
    let newLevel = activeFighter.level;
    while (newXp >= xpToNextLevel(newLevel)) {
      newXp -= xpToNextLevel(newLevel);
      newLevel++;
    }

    runStatPointCheck(activeFighter);

    let updatedRosterState = activeFighter.careerRosterState as CareerRosterState | null;
    let didSimulate = false;
    if (updatedRosterState) {
      const weekSeed = Date.now();
      updatedRosterState = simulateWeek(updatedRosterState, weekSeed, activeFighter.careerDifficulty, activeFighter.level);
      updatedRosterState = { ...updatedRosterState, trainingsSinceLastWeek: 0 };
      didSimulate = true;
      const pRating = updatedRosterState.playerRatingScore ?? 1000;
      const newPlayerRank = computePlayerRankFromRating(updatedRosterState.roster, pRating);
      updatedRosterState = {
        ...updatedRosterState,
        playerRank: newPlayerRank,
      };
    }

    let allocPoints = trainingType === "weightLifting"
      ? Math.max(1, Math.floor(reps / 3))
      : Math.max(1, Math.floor(reps / 5));
    if (trainingType === "weightLifting" && reps >= 25) {
      allocPoints += 2;
    } else if (trainingType === "weightLifting" && reps >= 20) {
      allocPoints += 1;
    }
    if (trainingType === "heavyBag" && reps >= 30) {
      allocPoints += 2;
    }
    if (reps > 30) {
      allocPoints += Math.floor((reps - 30) / 2);
    }
    if (activeFighter.level >= 20) {
      const meetsThreshold = (trainingType === "weightLifting" && reps >= 15) ||
        (trainingType === "heavyBag" && reps >= 20);
      if (meetsThreshold) {
        const tiers = Math.floor(activeFighter.level / 10) - 1;
        allocPoints += tiers * 2;
      }
    }
    const allowedStats: (keyof SkillPoints)[] = trainingType === "weightLifting"
      ? ["power", "defense"]
      : ["power", "speed", "focus"];

    updateFighterMutation.mutate({
      id: activeFighter.id,
      data: {
        xp: newXp,
        level: newLevel,
        trainingBonuses: newTB,
        careerRosterState: updatedRosterState,
      },
    });

    setActiveFighter(prev => prev ? {
      ...prev,
      xp: newXp,
      level: newLevel,
      trainingBonuses: newTB,
      careerRosterState: updatedRosterState,
    } : null);

    setTrainingType(null);
    const allocData = {
      points: allocPoints,
      allowedStats,
      didSimulate,
      simulationNews: didSimulate && updatedRosterState ? updatedRosterState.newsItems : undefined,
    };
    setPendingTrainingAlloc(allocData);
    setUiMode("trainingAllocate");
  };

  const handleTrainingQuit = () => {
    setUiMode("career");
    setTrainingType(null);
  };

  const handleDeleteFighter = (id: string) => {
    deleteFighterMutation.mutate(id);
    if (activeFighter?.id === id) {
      setActiveFighter(null);
    }
  };

  const handleAllocateStats = (fighterId: string, skillPoints: SkillPoints, spent: number) => {
    const newAvailable = (activeFighter?.availableStatPoints || 0) - spent;
    updateFighterMutation.mutate({
      id: fighterId,
      data: {
        skillPoints,
        availableStatPoints: newAvailable,
      },
    });
    setActiveFighter(prev => prev ? { ...prev, skillPoints, availableStatPoints: newAvailable } : null);
  };

  const handleTrainingAllocConfirm = (newSkillPoints: SkillPoints) => {
    if (!activeFighter) return;
    updateFighterMutation.mutate({
      id: activeFighter.id,
      data: { skillPoints: newSkillPoints },
    });
    setActiveFighter(prev => prev ? { ...prev, skillPoints: newSkillPoints } : null);
    const alloc = pendingTrainingAlloc;
    setPendingTrainingAlloc(null);
    if (alloc?.didSimulate && alloc.simulationNews) {
      setSimulationNews(alloc.simulationNews);
      setUiMode("simulating");
    } else {
      setUiMode("career");
    }
  };

  const handleInitRoster = (fighterId: string, rosterState: CareerRosterState) => {
    updateFighterMutation.mutate({
      id: fighterId,
      data: {
        careerRosterState: rosterState,
      },
    });
    setActiveFighter(prev => prev ? {
      ...prev,
      careerRosterState: rosterState,
    } : null);
  };

  const handleUpdateColors = (fighterId: string, skinColor: string, gearColors: GearColors) => {
    updateFighterMutation.mutate({
      id: fighterId,
      data: {
        skinColor,
        gearColors,
      },
    });
  };

  const handleSelectOpponent = (fighterId: string, opponentId: number) => {
    if (!activeFighter) return;
    const rosterState = activeFighter.careerRosterState as CareerRosterState | null;
    if (!rosterState) return;

    const updatedRosterState: CareerRosterState = {
      ...rosterState,
      selectedOpponentId: opponentId,
    };

    updateFighterMutation.mutate({
      id: fighterId,
      data: {
        careerRosterState: updatedRosterState,
      },
    });

    setActiveFighter(prev => prev ? {
      ...prev,
      careerRosterState: updatedRosterState,
    } : null);
  };

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center">
      <div className="w-full mx-auto">
        {(uiMode === "fighting" || uiMode === "fightEnd") && (
          <div className="relative">
            <GameCanvas state={gameState} onStateChange={handleStateChange} />
            {gameState.phase === "roundEnd" && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/70 z-50">
                <RoundEnd state={gameState} onNextRound={handleNextRound} />
              </div>
            )}
            {uiMode === "fightEnd" && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/70 z-50">
                <FightEnd
                  state={gameState}
                  onContinue={handleContinue}
                  xpToNext={xpToNextLevel(activeFighter?.level || 1)}
                  currentXp={activeFighter?.xp || 0}
                  fighterId={activeFighter?.id}
                />
              </div>
            )}
          </div>
        )}

        {uiMode === "menu" && (
          <MainMenu
            onQuickFight={handleQuickFight}
            onCareer={handleCareer}
            onEditRoster={handleEditRoster}
            onTutorial={() => { setTutorialStage(1); setUiMode("tutorial"); }}
            fighterName={activeFighter?.name}
            fighterLevel={activeFighter?.level}
            wins={activeFighter?.wins}
            losses={activeFighter?.losses}
          />
        )}

        {uiMode === "tutorial" && (
          <div className="flex flex-col items-center justify-center min-h-screen gap-6 p-6" data-testid="tutorial-screen">
            <h1
              className="text-4xl font-black tracking-wider text-primary"
              style={{ textShadow: "0 0 30px rgba(200,50,50,0.3), 0 3px 6px rgba(0,0,0,0.4)" }}
              data-testid="text-tutorial-title"
            >
              TUTORIAL
            </h1>
            <p className="text-muted-foreground text-sm text-center max-w-xs">
              {tutorialStage === 1
                ? "Learn the basics of boxing — movement, punches, blocking, and ducking."
                : "Advanced techniques — auto guard, weaving, and rhythm control."}
            </p>
            <p className="text-xs text-muted-foreground">Stage {tutorialStage} of 2</p>
            <div className="flex flex-col gap-3 w-full max-w-xs">
              <button
                onClick={() => { soundEngine.uiClick(); startTutorialFight(tutorialStage); }}
                className="w-full px-6 py-3 bg-yellow-600 hover:bg-yellow-500 text-black font-bold rounded text-lg transition-colors"
                data-testid="button-start-tutorial"
              >
                Start Tutorial
              </button>
              <button
                onClick={() => { soundEngine.uiClick(); setUiMode("menu"); }}
                className="w-full px-6 py-3 bg-gray-700 hover:bg-gray-600 text-white font-bold rounded text-lg transition-colors"
                data-testid="button-tutorial-exit"
              >
                Exit
              </button>
            </div>
          </div>
        )}

        {uiMode === "tutorialComplete" && (
          <TutorialCompleteScreen onFinish={() => setUiMode("menu")} />
        )}

        {uiMode === "classSelect" && (
          <ClassSelect
            selected={isCareerFight ? (activeFighter?.archetype as Archetype || selectedArchetype) : selectedArchetype}
            onSelect={a => !isCareerFight && setSelectedArchetype(a)}
            onConfirm={handleConfirmClass}
            onBack={() => setUiMode(isCareerFight ? "career" : "menu")}
            colors={playerColors}
            onColorsChange={(c: FighterColors) => {
              setPlayerColors(c);
              if (!isCareerFight) {
                localStorage.setItem("quickFightColors", JSON.stringify(c));
              }
            }}
            lockedArchetype={isCareerFight}
            showLevelSelect={!isCareerFight}
            playerLevel={quickFightPlayerLevel}
            enemyLevel={quickFightEnemyLevel}
            onPlayerLevelChange={setQuickFightPlayerLevel}
            onEnemyLevelChange={setQuickFightEnemyLevel}
            difficulty={aiDifficulty}
            onDifficultyChange={setAiDifficulty}
            roundDuration={roundDurationMins}
            onRoundDurationChange={setRoundDurationMins}
            timerSpeed={timerSpeed}
            onTimerSpeedChange={setTimerSpeed}
            maxRounds={maxRounds}
            onMaxRoundsChange={setMaxRounds}
            playerArmLength={playerArmLength}
            enemyArmLength={enemyArmLength}
            onPlayerArmLengthChange={setPlayerArmLength}
            onEnemyArmLengthChange={setEnemyArmLength}
            towelStoppageEnabled={towelStoppageEnabled}
            onTowelStoppageChange={setTowelStoppageEnabled}
            practiceMode={practiceMode}
            onPracticeModeChange={setPracticeMode}
            recordInputs={recordInputs}
            onRecordInputsChange={setRecordInputs}
            cpuVsCpu={cpuVsCpu}
            onCpuVsCpuChange={setCpuVsCpu}
            aiPowerMult={aiPowerMult}
            onAiPowerMultChange={setAiPowerMult}
            aiSpeedMult={aiSpeedMult}
            onAiSpeedMultChange={setAiSpeedMult}
            aiStaminaMult={aiStaminaMult}
            onAiStaminaMultChange={setAiStaminaMult}
            selectedRosterFighters={selectedRosterFighters}
            onRosterFightersChange={setSelectedRosterFighters}
          />
        )}

        {uiMode === "career" && (
          <CareerMode
            fighters={fighters}
            onSelectFighter={handleSelectCareerFighter}
            onCreateFighter={handleCreateFighter}
            onDeleteFighter={handleDeleteFighter}
            onAllocateStats={handleAllocateStats}
            onStartTraining={handleStartTraining}
            onSelectOpponent={handleSelectOpponent}
            onInitRoster={handleInitRoster}
            onUpdateColors={handleUpdateColors}
            onBack={() => { setActiveFighter(null); setUiMode("menu"); }}
            isLoading={fightersLoading}
            initialFighter={activeFighter}
            careerRefStoppageEnabled={careerRefStoppageEnabled}
            onToggleCareerRefStoppage={(enabled) => { setCareerRefStoppageEnabled(enabled); try { localStorage.setItem("handz_career_ref_stoppage", String(enabled)); } catch {} }}
            careerTowelStoppageEnabled={careerTowelStoppageEnabled}
            onToggleCareerTowelStoppage={(enabled) => { setCareerTowelStoppageEnabled(enabled); try { localStorage.setItem("handz_career_towel_stoppage", String(enabled)); } catch {} }}
            onTutorial={(name, colors) => {
              setIsCareerTutorial(true);
              careerTutorialInfoRef.current = { name, colors };
              setTutorialStage(1);
              startTutorialFight(1, name, colors);
            }}
          />
        )}

        {uiMode === "rosterEdit" && activeFighter && activeFighter.careerRosterState && (
          <RosterEditView
            rosterState={activeFighter.careerRosterState as CareerRosterState}
            onSave={(updatedRoster) => {
              if (activeFighter.id === -1) {
                saveRosterCustomizations(updatedRoster);
              } else {
                const rs = activeFighter.careerRosterState as CareerRosterState;
                const updatedState: CareerRosterState = { ...rs, roster: updatedRoster };
                handleInitRoster(activeFighter.id, updatedState);
              }
              setActiveFighter(null);
              setUiMode("menu");
            }}
            onBack={() => { setActiveFighter(null); setUiMode("menu"); }}
          />
        )}

        {uiMode === "simulating" && (
          <SimulationScreen
            news={simulationNews}
            weekNumber={activeFighter?.careerRosterState ? (activeFighter.careerRosterState as CareerRosterState).weekNumber : 0}
            onComplete={() => setUiMode("career")}
          />
        )}

        {uiMode === "training" && trainingType === "weightLifting" && activeFighter && (
          <WeightLiftingGame
            fighter={activeFighter}
            onComplete={handleTrainingComplete}
            onQuit={handleTrainingQuit}
          />
        )}

        {uiMode === "training" && trainingType === "heavyBag" && activeFighter && (
          <HeavyBagGame
            fighter={activeFighter}
            onComplete={handleTrainingComplete}
            onQuit={handleTrainingQuit}
          />
        )}

        {uiMode === "trainingAllocate" && activeFighter && pendingTrainingAlloc && (
          <AllocateStats
            fighter={activeFighter}
            fixedPoints={pendingTrainingAlloc.points}
            allowedStats={pendingTrainingAlloc.allowedStats}
            onAllocate={(sp) => handleTrainingAllocConfirm(sp)}
            onBack={() => {}}
          />
        )}
      </div>

      <div className="fixed bottom-1 right-1 z-[9999] group" data-testid="button-download-source">
        <button
          className="w-5 h-5 rounded-full bg-blue-500/20 hover:bg-blue-500/60 border border-blue-400/20 hover:border-blue-400/60 transition-all duration-200 flex items-center justify-center cursor-pointer"
          onClick={() => {
            const a = document.createElement("a");
            a.href = "/api/download-source";
            a.download = "handz_source.tar.gz";
            a.click();
          }}
        >
          <span className="text-[6px] text-blue-300/40 group-hover:text-white font-bold">S</span>
        </button>
        <div className="absolute bottom-6 right-0 bg-gray-900/90 text-white text-[10px] px-2 py-1 rounded whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
          Download Source Code
        </div>
      </div>
    </div>
  );
}

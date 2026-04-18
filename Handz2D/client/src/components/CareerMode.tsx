import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ArrowLeft, Plus, Trash2, BarChart3, ChevronUp, Dumbbell, Target, Trophy, Users, Swords, Pencil, Save, Check, Settings, Lock, Unlock, Download, Upload } from "lucide-react";
import type { Fighter, CareerStats, SkillPoints, GearColors, TrainingBonuses, CareerRosterState, RosterFighterState } from "@shared/schema";
import { DEFAULT_CAREER_STATS, DEFAULT_GEAR_COLORS, DEFAULT_TRAINING_BONUSES } from "@shared/schema";
import { useState, useEffect, useRef } from "react";
import { Archetype, ARCHETYPE_STATS, AIDifficulty, AI_DIFFICULTY_LABELS, FighterColors, SKIN_COLOR_PRESETS, COLOR_PRESETS } from "@/game/types";
import { xpToNextLevel, loadPlayerPlaystyle, type PlayerPlaystyle } from "@/game/engine";
import { STAT_POINTS_PER_LEVEL } from "@/game/career";
import {
  getOpponentCandidates,
  buildOpponentFromRoster,
  getRosterEntryById,
  initRosterState,
  computePlayerRankFromRating,
  redistributeRosterLevels,
  saveRosterCustomizations,
  applyRosterCustomizations,
  getRosterFighterColors,
  type CareerOpponentFromRoster,
} from "@/game/careerRoster";
import { getRosterDisplayName, ROSTER_DATA, KEY_FIGHTER_IDS } from "@/game/rosterData";
import FighterStanceCanvas from "@/components/FighterStanceCanvas";
import { BoxingGloveIcon } from "@/components/BoxingGloveIcon";
import NeuralNetworkView, { fighterHasNeural } from "@/components/NeuralNetworkView";
import { soundEngine } from "@/game/sound";
import * as localSaves from "@/lib/localSaves";

export type TrainingType = "weightLifting" | "heavyBag" | "sparring";

interface CareerModeProps {
  fighters: Fighter[];
  onSelectFighter: (fighter: Fighter, opponentId: number) => void;
  onCreateFighter: (data: {
    firstName: string;
    nickname: string;
    lastName: string;
    archetype: Archetype;
    careerDifficulty: AIDifficulty;
    roundLengthMins: number;
    skinColor: string;
    gearColors: GearColors;
  }) => void;
  onDeleteFighter: (id: string) => void;
  onBack: () => void;
  onAllocateStats: (fighterId: string, skillPoints: SkillPoints, spent: number) => void;
  onStartTraining: (fighter: Fighter, type: TrainingType, sparringDifficulty?: AIDifficulty) => void;
  onSelectOpponent: (fighterId: string, opponentId: number) => void;
  onInitRoster: (fighterId: string, rosterState: CareerRosterState) => void;
  onUpdateColors?: (fighterId: string, skinColor: string, gearColors: GearColors) => void;
  isLoading: boolean;
  careerRefStoppageEnabled: boolean;
  onToggleCareerRefStoppage: (enabled: boolean) => void;
  careerTowelStoppageEnabled: boolean;
  onToggleCareerTowelStoppage: (enabled: boolean) => void;
  onTutorial?: (name: string, colors: FighterColors) => void;
}

type CareerView = "slots" | "create" | "generating" | "hub" | "stats" | "allocate" | "opponents" | "rankings" | "rosterEdit" | "editColors" | "sparringSelect" | "prepWeeks";

const MAX_SLOTS = 3;
const PIN_STORAGE_KEY = "handz_career_pins";
const PIN_LOCK_KEY = "handz_career_pin_locks";

function getPinStore(): Record<string, string> {
  try { const raw = localStorage.getItem(PIN_STORAGE_KEY); return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}
function savePinStore(store: Record<string, string>) {
  localStorage.setItem(PIN_STORAGE_KEY, JSON.stringify(store));
}
function getFighterPin(fighterId: string): string | null {
  return getPinStore()[fighterId] || null;
}
function setFighterPin(fighterId: string, pin: string) {
  const store = getPinStore(); store[fighterId] = pin; savePinStore(store);
}
function removeFighterPin(fighterId: string) {
  const store = getPinStore(); delete store[fighterId]; savePinStore(store);
}
function getLockStore(): Record<string, boolean> {
  try { const raw = localStorage.getItem(PIN_LOCK_KEY); return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}
function isPinLocked(fighterId: string): boolean {
  const locks = getLockStore();
  return locks[fighterId] !== false;
}
function setPinLocked(fighterId: string, locked: boolean) {
  const locks = getLockStore(); locks[fighterId] = locked; localStorage.setItem(PIN_LOCK_KEY, JSON.stringify(locks));
}

type PinFlowMode = "setNew" | "confirmNew" | "enterLoad" | "enterDelete" | "enterChange" | "setChangeNew" | "confirmChangeNew";

export default function CareerMode({
  fighters, onSelectFighter, onCreateFighter, onDeleteFighter, onBack, onAllocateStats, onStartTraining, onSelectOpponent, onInitRoster, onUpdateColors, isLoading, initialFighter, careerRefStoppageEnabled, onToggleCareerRefStoppage, careerTowelStoppageEnabled, onToggleCareerTowelStoppage, onTutorial
}: CareerModeProps & { initialFighter?: Fighter | null }) {
  const [view, setView] = useState<CareerView>(initialFighter ? "hub" : "slots");
  const [selectedFighter, setSelectedFighter] = useState<Fighter | null>(initialFighter ?? null);
  useEffect(() => {
    if (initialFighter) {
      setSelectedFighter(initialFighter);
    }
  }, [initialFighter]);
  const [rosterEditFighter, setRosterEditFighter] = useState<Fighter | null>(null);
  const [pendingOpponentId, setPendingOpponentId] = useState<number | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [pinFlow, setPinFlow] = useState<PinFlowMode | null>(null);
  const [pinDigits, setPinDigits] = useState("");
  const [pinFirstEntry, setPinFirstEntry] = useState("");
  const [pinError, setPinError] = useState("");
  const [pinSuccess, setPinSuccess] = useState("");
  const [pinTargetFighter, setPinTargetFighter] = useState<Fighter | null>(null);
  const [pinLockedState, setPinLockedState] = useState<Record<string, boolean>>({});
  const [careerRoundLen, setCareerRoundLen] = useState<number>(() => {
    try { const v = localStorage.getItem("handz_career_round_len"); return v ? parseInt(v) : 1; } catch { return 1; }
  });
  const [careerTimerSpeed, setCareerTimerSpeed] = useState<"normal" | "fast">(() => {
    try { const v = localStorage.getItem("handz_career_timer_speed"); return v === "fast" ? "fast" : "normal"; } catch { return "normal"; }
  });

  useEffect(() => {
    localStorage.setItem("handz_career_round_len", String(careerRoundLen));
  }, [careerRoundLen]);
  useEffect(() => {
    localStorage.setItem("handz_career_timer_speed", careerTimerSpeed);
  }, [careerTimerSpeed]);

  useEffect(() => {
    if (selectedFighter) {
      const updated = fighters.find(f => f.id === selectedFighter.id);
      if (updated) {
        setSelectedFighter(updated);
      }
    }
  }, [fighters]);

  const [firstName, setFirstName] = useState("");
  const [nickname, setNickname] = useState("");
  const [lastName, setLastName] = useState("");
  const [archetype, setArchetype] = useState<Archetype>("BoxerPuncher");
  const [difficulty, setDifficulty] = useState<AIDifficulty>("contender");
  const [roundLength, setRoundLength] = useState(1);
  const [skinColor, setSkinColor] = useState("#e8c4a0");
  const [gearColors, setGearColors] = useState<GearColors>({ ...DEFAULT_GEAR_COLORS });

  const resetCreate = () => {
    setFirstName("");
    setNickname("");
    setLastName("");
    setArchetype("BoxerPuncher");
    setDifficulty("contender");
    setRoundLength(1);
    setSkinColor("#e8c4a0");
    setGearColors({ ...DEFAULT_GEAR_COLORS });
  };

  const [generatingProgress, setGeneratingProgress] = useState(0);
  const [pendingFighterData, setPendingFighterData] = useState<{
    firstName: string; nickname: string; lastName: string;
    archetype: Archetype; careerDifficulty: AIDifficulty;
    roundLengthMins: number; skinColor: string; gearColors: GearColors;
  } | null>(null);

  const handleDownloadData = (f: Fighter) => {
    const fighterName = f.firstName
      ? (f.nickname ? `${f.firstName} "${f.nickname}" ${f.lastName}` : `${f.firstName} ${f.lastName}`)
      : f.name;

    const saveData = localSaves.exportSaveFile(f);
    const json = JSON.stringify(saveData, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `handz_save_${fighterName.replace(/[^a-zA-Z0-9]/g, "_")}_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };



  const [dragOver, setDragOver] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  const handleImportSave = (file: File) => {
    setImportError(null);
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target?.result as string);
        localSaves.importSaveFile(data);
        onDeleteFighter("");
      } catch (err: any) {
        setImportError(err.message || "Failed to import save file");
      }
    };
    reader.readAsText(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (fighters.length >= MAX_SLOTS) {
      setImportError("All save slots are full");
      return;
    }
    const file = e.dataTransfer.files[0];
    if (file && file.name.endsWith(".json")) {
      handleImportSave(file);
    } else {
      setImportError("Please drop a .json save file");
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    if (fighters.length < MAX_SLOTS) {
      setDragOver(true);
    }
  };

  const handleDragLeave = () => {
    setDragOver(false);
  };

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      handleImportSave(file);
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleCreate = () => {
    if (firstName.trim() && lastName.trim()) {
      setPendingFighterData({
        firstName: firstName.trim(),
        nickname: nickname.trim(),
        lastName: lastName.trim(),
        archetype,
        careerDifficulty: difficulty,
        roundLengthMins: roundLength,
        skinColor,
        gearColors,
      });
      setGeneratingProgress(0);
      setView("generating");
    }
  };

  useEffect(() => {
    if (view !== "generating" || !pendingFighterData) return;
    let cancelled = false;

    const steps = [
      { progress: 10, delay: 200 },
      { progress: 25, delay: 300 },
      { progress: 40, delay: 250 },
      { progress: 55, delay: 300 },
      { progress: 70, delay: 250 },
      { progress: 85, delay: 200 },
      { progress: 95, delay: 150 },
    ];

    let stepIdx = 0;
    const runStep = () => {
      if (cancelled) return;
      if (stepIdx < steps.length) {
        setGeneratingProgress(steps[stepIdx].progress);
        const delay = steps[stepIdx].delay;
        stepIdx++;
        setTimeout(runStep, delay);
      } else {
        onCreateFighter(pendingFighterData);
        setGeneratingProgress(100);
        setTimeout(() => {
          if (cancelled) return;
          setPendingFighterData(null);
          resetCreate();
        }, 400);
      }
    };

    setTimeout(runStep, 100);
    return () => { cancelled = true; };
  }, [view, pendingFighterData]);

  useEffect(() => {
    if (view !== "generating" || pendingFighterData) return;
    const newest = fighters.length > 0 ? fighters[fighters.length - 1] : null;
    if (!newest) return;

    const rosterState = initRosterState(newest.id + newest.name, newest.careerDifficulty as AIDifficulty);
    const playerRank = computePlayerRankFromRating(rosterState.roster, rosterState.playerRatingScore);
    const initialized = { ...rosterState, playerRank };
    onInitRoster(newest.id, initialized);
    setSelectedFighter({ ...newest, careerRosterState: initialized });
    setView("hub");
  }, [view, pendingFighterData, fighters]);

  const loadSlot = (fighter: Fighter) => {
    if (!fighter.careerRosterState) {
      const rosterState = initRosterState(fighter.id + fighter.name, fighter.careerDifficulty as AIDifficulty);
      const playerRank = computePlayerRankFromRating(rosterState.roster, rosterState.playerRatingScore);
      const initialized = { ...rosterState, playerRank };
      onInitRoster(fighter.id, initialized);
      setSelectedFighter({ ...fighter, careerRosterState: initialized });
    } else {
      const rs = fighter.careerRosterState as CareerRosterState;
      const maxGain = fighter.careerDifficulty === "champion" ? 2 : 1;
      const fixedRoster = applyRosterCustomizations(redistributeRosterLevels(rs.roster, maxGain));
      const fixedState = { ...rs, roster: fixedRoster };
      onInitRoster(fighter.id, fixedState);
      setSelectedFighter({ ...fighter, careerRosterState: fixedState });
    }
    setView("hub");
  };

  const handleSelectSlot = (fighter: Fighter) => {
    const pin = getFighterPin(fighter.id);
    if (pin && isPinLocked(fighter.id)) {
      setPinTargetFighter(fighter);
      setPinFlow("enterLoad");
      setPinDigits("");
      setPinError("");
      setPinSuccess("");
      return;
    }
    loadSlot(fighter);
  };

  const handleDeleteSlot = (fighterId: string) => {
    const pin = getFighterPin(fighterId);
    if (pin && isPinLocked(fighterId)) {
      const fighter = fighters.find(f => f.id === fighterId) || null;
      setPinTargetFighter(fighter);
      setPinFlow("enterDelete");
      setPinDigits("");
      setPinError("");
      setPinSuccess("");
      return;
    }
    setDeleteConfirmId(fighterId);
  };

  const confirmDelete = (fighterId: string) => {
    removeFighterPin(fighterId);
    onDeleteFighter(fighterId);
    setDeleteConfirmId(null);
  };

  const clearPinFlow = () => {
    setPinFlow(null);
    setPinDigits("");
    setPinFirstEntry("");
    setPinError("");
    setPinSuccess("");
    setPinTargetFighter(null);
  };

  const handlePinSubmit = () => {
    if (pinDigits.length !== 4) { setPinError("Enter 4 digits"); return; }
    const fid = pinTargetFighter?.id || selectedFighter?.id;
    if (!fid) return;

    if (pinFlow === "setNew") {
      setPinFirstEntry(pinDigits);
      setPinDigits("");
      setPinError("");
      setPinFlow("confirmNew");
    } else if (pinFlow === "confirmNew") {
      if (pinDigits !== pinFirstEntry) {
        setPinError("Pins don't match. Try again.");
        setPinDigits("");
        setPinFlow("setNew");
        setPinFirstEntry("");
      } else {
        setFighterPin(fid, pinDigits);
        setPinLocked(fid, true);
        setPinLockedState(prev => ({ ...prev, [fid]: true }));
        setPinSuccess("Pin code saved! Loading and deleting this career now requires your 4-digit pin.");
        setPinFlow(null);
        setPinDigits("");
        setPinFirstEntry("");
        setTimeout(() => setPinSuccess(""), 4000);
      }
    } else if (pinFlow === "enterLoad") {
      const pin = getFighterPin(fid);
      if (pinDigits === pin) {
        clearPinFlow();
        const fighter = fighters.find(f => f.id === fid);
        if (fighter) loadSlot(fighter);
      } else {
        setPinError("Wrong pin code");
        setPinDigits("");
      }
    } else if (pinFlow === "enterDelete") {
      const pin = getFighterPin(fid);
      if (pinDigits === pin) {
        clearPinFlow();
        setDeleteConfirmId(fid);
      } else {
        setPinError("Wrong pin code");
        setPinDigits("");
      }
    } else if (pinFlow === "enterChange") {
      const pin = getFighterPin(fid);
      if (pinDigits === pin) {
        setPinDigits("");
        setPinError("");
        setPinFlow("setChangeNew");
      } else {
        setPinError("Wrong pin code");
        setPinDigits("");
      }
    } else if (pinFlow === "setChangeNew") {
      setPinFirstEntry(pinDigits);
      setPinDigits("");
      setPinError("");
      setPinFlow("confirmChangeNew");
    } else if (pinFlow === "confirmChangeNew") {
      if (pinDigits !== pinFirstEntry) {
        setPinError("Pins don't match. Try again.");
        setPinDigits("");
        setPinFlow("setChangeNew");
        setPinFirstEntry("");
      } else {
        setFighterPin(fid, pinDigits);
        setPinLocked(fid, true);
        setPinLockedState(prev => ({ ...prev, [fid]: true }));
        setPinSuccess("Pin code changed! Your new pin is now active.");
        setPinFlow(null);
        setPinDigits("");
        setPinFirstEntry("");
        setTimeout(() => setPinSuccess(""), 4000);
      }
    }
  };

  const handleFight = (opponentId: number) => {
    if (selectedFighter) {
      onSelectFighter(selectedFighter, opponentId);
    }
  };

  if (view === "create") {
    return <CreateFighter
      firstName={firstName} setFirstName={setFirstName}
      nickname={nickname} setNickname={setNickname}
      lastName={lastName} setLastName={setLastName}
      archetype={archetype} setArchetype={setArchetype}
      difficulty={difficulty} setDifficulty={setDifficulty}
      roundLength={roundLength} setRoundLength={setRoundLength}
      skinColor={skinColor} setSkinColor={setSkinColor}
      gearColors={gearColors} setGearColors={setGearColors}
      onCreate={handleCreate}
      onBack={() => { resetCreate(); setView("slots"); }}
    />;
  }

  if (view === "generating") {
    const messages = [
      "Setting up key fighters...",
      "Assigning fighter levels...",
      "Determining skill ratings...",
      "Generating fight records...",
      "Building fighter profiles...",
      "Populating the roster...",
      "Finalizing rankings...",
      "Preparing your career...",
    ];
    const msgIdx = Math.min(Math.floor(generatingProgress / 13), messages.length - 1);
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-6 p-8">
        <BoxingGloveIcon className="w-16 h-16 text-primary animate-pulse" />
        <h2 className="text-2xl font-bold">Generating Roster</h2>
        <p className="text-muted-foreground text-center">{messages[msgIdx]}</p>
        <div className="w-64 h-3 bg-muted rounded-full overflow-hidden">
          <div
            className="h-full bg-primary rounded-full transition-all duration-300"
            style={{ width: `${generatingProgress}%` }}
          />
        </div>
        <p className="text-sm text-muted-foreground">{generatingProgress}%</p>
      </div>
    );
  }

  if (view === "stats" && selectedFighter) {
    return <CareerStatsView fighter={selectedFighter} onBack={() => setView("hub")} />;
  }

  if (view === "allocate" && selectedFighter) {
    return <AllocateStats
      fighter={selectedFighter}
      onAllocate={(sp, spent) => {
        onAllocateStats(selectedFighter.id, sp, spent);
        setSelectedFighter(prev => prev ? {
          ...prev,
          skillPoints: sp,
          availableStatPoints: prev.availableStatPoints - spent,
        } : null);
        setView("hub");
      }}
      onBack={() => setView("hub")}
    />;
  }

  if (view === "sparringSelect" && selectedFighter) {
    return <SparringDifficultySelect
      fighter={selectedFighter}
      onSelect={(diff) => {
        onStartTraining(selectedFighter, "sparring", diff);
      }}
      onBack={() => setView("hub")}
    />;
  }

  if (view === "opponents" && selectedFighter) {
    const rosterState = selectedFighter.careerRosterState as CareerRosterState | null;
    if (rosterState) {
      return <OpponentSelectionView
        fighter={selectedFighter}
        rosterState={rosterState}
        onSelectOpponent={(oppId) => {
          setPendingOpponentId(oppId);
          setView("prepWeeks");
        }}
        onBack={() => setView("hub")}
      />;
    }
    return null;
  }

  if (view === "prepWeeks" && selectedFighter && pendingOpponentId != null) {
    const rosterState = selectedFighter.careerRosterState as CareerRosterState | null;
    if (rosterState) {
      const opp = rosterState.roster.find(f => f.id === pendingOpponentId);
      const oppData = opp ? buildOpponentFromRoster(opp) : null;
      const oppEntry = opp ? getRosterEntryById(opp.id) : null;
      const oppName = oppEntry && opp ? getRosterDisplayName(oppEntry, opp) : "Unknown";
      return (
        <div className="flex flex-col items-center gap-4 p-4 max-w-md mx-auto">
          <div className="flex items-center gap-3 w-full">
            <Button variant="ghost" size="icon" onClick={() => { setPendingOpponentId(null); setView("opponents"); }} data-testid="button-back-prep">
              <ArrowLeft className="w-5 h-5" />
            </Button>
            <h2 className="text-xl font-bold flex-1">Fight Preparation</h2>
          </div>

          {oppData && (
            <Card className="p-4 w-full">
              <p className="font-bold text-lg" data-testid="text-prep-opponent">{oppName}</p>
              <p className="text-sm text-muted-foreground">
                {oppData.archetype} &bull; <span className="text-yellow-500 font-semibold">LV {oppData.level}</span> &bull; Rank #{oppData.rank}
              </p>
              <p className="text-sm text-muted-foreground">
                {oppData.wins}W-{oppData.losses}L-{oppData.draws}D &bull; {oppData.knockouts} KOs
              </p>
            </Card>
          )}

          <p className="text-sm text-muted-foreground text-center">
            How many weeks do you want to prepare? You can train during prep weeks, but training is locked during fight week.
          </p>

          <div className="grid grid-cols-4 gap-2 w-full">
            {[1, 2, 3, 4, 5, 6, 7, 8].map(weeks => (
              <Button
                key={weeks}
                variant="outline"
                className="h-16 flex-col gap-1"
                onClick={() => {
                  const updatedRosterState: CareerRosterState = {
                    ...rosterState,
                    selectedOpponentId: pendingOpponentId,
                    prepWeeksRemaining: weeks,
                  };
                  onInitRoster(selectedFighter.id, updatedRosterState);
                  setSelectedFighter(prev => prev ? {
                    ...prev,
                    careerRosterState: updatedRosterState,
                  } : null);
                  setPendingOpponentId(null);
                  setView("hub");
                }}
                data-testid={`button-prep-${weeks}`}
              >
                <span className="text-lg font-bold">{weeks}</span>
                <span className="text-[10px] text-muted-foreground">{weeks === 1 ? "week" : "weeks"}</span>
              </Button>
            ))}
          </div>
        </div>
      );
    }
    return null;
  }

  if (view === "rankings" && selectedFighter) {
    const rosterState = selectedFighter.careerRosterState as CareerRosterState | null;
    if (rosterState) {
      return <RankingsView rosterState={rosterState} fighter={selectedFighter} onBack={() => setView("hub")} />;
    }
    return null;
  }

  if (view === "rosterEdit" && rosterEditFighter) {
    const rosterState = rosterEditFighter.careerRosterState as CareerRosterState | null;
    if (rosterState) {
      const rfName = rosterEditFighter.firstName
        ? (rosterEditFighter.nickname ? `${rosterEditFighter.firstName} "${rosterEditFighter.nickname}" ${rosterEditFighter.lastName}` : `${rosterEditFighter.firstName} ${rosterEditFighter.lastName}`)
        : rosterEditFighter.name;
      return <RosterEditView
        rosterState={rosterState}
        fighterName={rfName}
        onSave={(updatedRoster) => {
          const updatedState: CareerRosterState = { ...rosterState, roster: updatedRoster };
          onInitRoster(rosterEditFighter.id, updatedState);
          setRosterEditFighter(null);
          setView("slots");
        }}
        onBack={() => { setRosterEditFighter(null); setView("slots"); }}
      />;
    }
    return null;
  }

  if (view === "editColors" && selectedFighter) {
    return (
      <EditFighterColors
        fighter={selectedFighter}
        onSave={(skinColor, gearColors) => {
          if (onUpdateColors) {
            onUpdateColors(selectedFighter.id, skinColor, gearColors);
            setSelectedFighter(prev => prev ? { ...prev, skinColor, gearColors } : null);
          }
          setView("hub");
        }}
        onBack={() => setView("hub")}
      />
    );
  }

  if (view === "hub" && selectedFighter) {
    const rosterState = selectedFighter.careerRosterState as CareerRosterState | null;
    const rawSp = (selectedFighter.skillPoints || {}) as Partial<SkillPoints>;
    const sp: SkillPoints = { power: rawSp.power || 0, speed: rawSp.speed || 0, defense: rawSp.defense || 0, stamina: rawSp.stamina || 0, focus: rawSp.focus || 0 };
    const tb = (selectedFighter.trainingBonuses || DEFAULT_TRAINING_BONUSES) as TrainingBonuses;
    const isFightWeek = (rosterState?.prepWeeksRemaining ?? 0) === 0 && rosterState?.selectedOpponentId != null;

    const selectedOpp = rosterState?.selectedOpponentId
      ? rosterState.roster.find(f => f.id === rosterState.selectedOpponentId)
      : null;
    const oppData = selectedOpp ? buildOpponentFromRoster(selectedOpp) : null;

    const hubColors: FighterColors = {
      gloves: (selectedFighter.gearColors as GearColors)?.gloves || DEFAULT_GEAR_COLORS.gloves,
      gloveTape: (selectedFighter.gearColors as GearColors)?.gloveTape || DEFAULT_GEAR_COLORS.gloveTape,
      trunks: (selectedFighter.gearColors as GearColors)?.trunks || DEFAULT_GEAR_COLORS.trunks,
      shoes: (selectedFighter.gearColors as GearColors)?.shoes || DEFAULT_GEAR_COLORS.shoes,
      skin: selectedFighter.skinColor || "#e8c4a0",
    };

    return (
      <div className="flex flex-col items-center gap-3 p-4 max-w-2xl mx-auto">
        <div className="flex items-center gap-3 w-full">
          <Button variant="ghost" size="icon" onClick={() => { setSelectedFighter(null); setView("slots"); }} data-testid="button-back-hub">
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <h2 className="text-xl font-bold flex-1" data-testid="text-hub-title">Career Hub</h2>
          {rosterState && (
            <div className="flex items-center gap-4">
              <div className="text-right">
                <span className="text-xs text-muted-foreground" data-testid="text-career-year-week">
                  Year: {Math.floor(rosterState.weekNumber / 52)}  Week: {rosterState.weekNumber % 52}
                </span>
                {rosterState.selectedOpponentId != null && (rosterState.prepWeeksRemaining ?? 0) > 0 && (
                  <p className="text-xs font-bold text-blue-400" data-testid="text-hub-prep-weeks">{rosterState.prepWeeksRemaining} {rosterState.prepWeeksRemaining === 1 ? "week" : "weeks"} until fight</p>
                )}
                {rosterState.selectedOpponentId != null && (rosterState.prepWeeksRemaining ?? 0) === 0 && (
                  <p className="text-xs font-bold text-yellow-500" data-testid="text-hub-fight-week">FIGHT WEEK</p>
                )}
              </div>
              <div className="flex flex-col items-end">
                <span className="text-2xl font-black text-yellow-500" data-testid="text-player-rank-header">#{rosterState.playerRank}</span>
                <span className="text-[10px] text-muted-foreground leading-none">RANK</span>
              </div>
            </div>
          )}
        </div>

        <div className="w-full flex flex-col items-center">
          <div className="text-center mb-1">
            <p className="text-lg font-black tracking-wide" data-testid="text-fighter-display-name">
              {selectedFighter.firstName || selectedFighter.name}
              {selectedFighter.nickname ? ` "${selectedFighter.nickname}"` : ""}
              {selectedFighter.lastName ? ` ${selectedFighter.lastName}` : ""}
            </p>
            <div className="flex items-center justify-center gap-3 flex-wrap">
              <span className="text-xs text-muted-foreground">{selectedFighter.archetype}</span>
              <span className="text-primary font-bold text-sm" data-testid="text-fighter-level">LV {selectedFighter.level}</span>
              <span className="text-green-500 font-semibold text-xs" data-testid="text-fighter-wins">{selectedFighter.wins}W</span>
              <span className="text-red-500 font-semibold text-xs" data-testid="text-fighter-losses">{selectedFighter.losses}L</span>
              <span className="text-muted-foreground text-xs" data-testid="text-fighter-draws">{selectedFighter.draws}D</span>
              <span className="text-muted-foreground text-xs">KOs: {selectedFighter.knockouts}</span>
            </div>
          </div>

          <div className="w-48 h-56 my-2">
            <FighterStanceCanvas colors={hubColors} width={192} height={224} />
          </div>

          <div className="w-full max-w-sm">
            <div className="h-1.5 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full rounded-full bg-primary"
                style={{ width: `${Math.min(100, (selectedFighter.xp / xpToNextLevel(selectedFighter.level)) * 100)}%` }}
              />
            </div>
            <p className="text-[10px] text-muted-foreground mt-0.5 text-center">
              {selectedFighter.xp} / {xpToNextLevel(selectedFighter.level)} XP
            </p>
          </div>

          <div className="grid grid-cols-5 gap-2 mt-2 w-full max-w-sm">
            {(["power", "speed", "defense", "stamina", "focus"] as const).map(stat => (
              <div key={stat} className="text-center relative group cursor-help" data-testid={`stat-display-${stat}`}>
                <p className="text-[10px] uppercase text-muted-foreground">{stat}</p>
                <p className="text-sm font-bold">{sp[stat] || 0}</p>
                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 bg-popover border border-border rounded shadow-lg text-[10px] text-popover-foreground whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none z-50 transition-opacity">
                  {{
                    power: "Increases damage",
                    speed: "Increases punch & move speed",
                    defense: "Increases block strength & autoguard duration",
                    stamina: "Increases max stamina & regen",
                    focus: "Increases crit & stun chance",
                  }[stat]}
                </div>
              </div>
            ))}
          </div>
          <p className="text-[10px] text-muted-foreground mt-1 text-center">
            Difficulty - {(selectedFighter.careerDifficulty || "contender").charAt(0).toUpperCase() + (selectedFighter.careerDifficulty || "contender").slice(1)}
          </p>
        </div>

        {selectedFighter.availableStatPoints > 0 && (
          <Button variant="default" className="w-full max-w-sm gap-2" onClick={() => setView("allocate")} data-testid="button-allocate-stats">
            <ChevronUp className="w-4 h-4" />
            Allocate Stat Points ({selectedFighter.availableStatPoints} available)
          </Button>
        )}

        {oppData ? (
          <Card className="p-4 w-full max-w-sm">
            <p className="text-xs uppercase text-muted-foreground mb-1">Selected Opponent</p>
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div>
                <p className="font-bold" data-testid="text-opponent-name">{oppData.name}</p>
                <p className="text-xs text-muted-foreground">
                  {oppData.archetype} &bull; <span className="text-yellow-500 font-semibold">LV {oppData.level}</span> &bull; Rank #{oppData.rank}
                </p>
                <p className="text-xs text-muted-foreground">
                  {oppData.wins}W-{oppData.losses}L-{oppData.draws}D &bull; {oppData.knockouts} KOs
                </p>
                <p className="text-xs text-muted-foreground">Skill: {oppData.aiDifficulty} &bull; Reach: {oppData.armLength}&quot;</p>
                {(rosterState?.prepWeeksRemaining ?? 0) > 0 && (
                  <p className="text-xs font-semibold text-blue-400 mt-1" data-testid="text-prep-remaining">{rosterState!.prepWeeksRemaining} {rosterState!.prepWeeksRemaining === 1 ? "week" : "weeks"} until fight</p>
                )}
              </div>
              <div className="flex flex-col items-end gap-1">
                {(() => {
                  const opp = rosterState?.roster.find(f => f.id === oppData.rosterId);
                  const rounds = opp?.rank === 1 ? 12 : KEY_FIGHTER_IDS.includes(oppData.rosterId) ? 6 : 3;
                  return rounds > 3 ? (
                    <span className="text-[10px] font-bold text-yellow-500">{rounds} Rounds</span>
                  ) : null;
                })()}
                <Button onClick={() => handleFight(oppData.rosterId)} className={`gap-2 ${!isFightWeek ? "opacity-50" : ""}`} disabled={!isFightWeek && rosterState?.prepWeeksRemaining != null && rosterState.prepWeeksRemaining > 0} data-testid="button-start-bout">
                  <BoxingGloveIcon className="w-4 h-4" /> {isFightWeek ? "Fight!" : "Fight"}
                </Button>
              </div>
            </div>
          </Card>
        ) : (
          <Card className="p-4 w-full max-w-sm text-center">
            <p className="text-sm text-muted-foreground mb-2">No opponent selected yet.</p>
            <Button variant="default" className="gap-2" onClick={() => setView("opponents")} data-testid="button-pick-opponent">
              <Swords className="w-4 h-4" /> Choose Opponent
            </Button>
          </Card>
        )}

        {isFightWeek && (
          <p className="text-sm font-semibold text-yellow-500 w-full max-w-sm text-center" data-testid="text-fight-week">TIME TO FIGHT</p>
        )}

        <div className="grid grid-cols-2 gap-2 w-full max-w-sm">
          <Button
            variant="secondary"
            className={`gap-2 h-auto py-3 flex-col ${isFightWeek ? "opacity-40 cursor-not-allowed" : ""}`}
            onClick={() => { if (!isFightWeek) onStartTraining(selectedFighter, "weightLifting"); }}
            disabled={isFightWeek}
            data-testid="button-train-weights"
          >
            <Dumbbell className="w-5 h-5" />
            <span className="text-xs">Weight Lifting</span>
            <span className="text-[10px] text-muted-foreground">1 pt per 3 lifts: Power / Defense</span>
          </Button>
          <Button
            variant="secondary"
            className={`gap-2 h-auto py-3 flex-col ${isFightWeek ? "opacity-40 cursor-not-allowed" : ""}`}
            onClick={() => { if (!isFightWeek) onStartTraining(selectedFighter, "heavyBag"); }}
            disabled={isFightWeek}
            data-testid="button-train-bag"
          >
            <Target className="w-5 h-5" />
            <span className="text-xs">Heavy Bag</span>
            <span className="text-[10px] text-muted-foreground">1 pt per 5 combos: Power / Speed</span>
          </Button>
        </div>

        <Button
          variant="secondary"
          className={`gap-2 h-auto py-3 flex-col w-full max-w-sm ${isFightWeek ? "opacity-40 cursor-not-allowed" : ""}`}
          onClick={() => { if (!isFightWeek) setView("sparringSelect"); }}
          disabled={isFightWeek}
          data-testid="button-train-sparring"
        >
          <BoxingGloveIcon className="w-5 h-5" />
          <span className="text-xs">Sparring</span>
          <span className="text-[10px] text-muted-foreground">+Speed +Defense +Stamina</span>
        </Button>

        <div className="grid grid-cols-3 gap-2 w-full max-w-sm">
          <Button variant="secondary" className="gap-2 text-xs" onClick={() => setView("rankings")} data-testid="button-view-rankings">
            <Trophy className="w-4 h-4" /> Rankings
          </Button>
          <Button variant="secondary" className="gap-2 text-xs" onClick={() => setView("stats")} data-testid="button-career-stats">
            <BarChart3 className="w-4 h-4" /> Stats
          </Button>
          <Button variant="secondary" className="gap-2 text-xs" onClick={() => setView("editColors")} data-testid="button-edit-colors">
            <Pencil className="w-4 h-4" /> Edit Colors
          </Button>
        </div>

        {rosterState && rosterState.newsItems.length > 0 && (
          <NewsTicker news={rosterState.newsItems} />
        )}

        {onTutorial && (
          <Button
            variant="ghost"
            className="gap-2 text-xs text-muted-foreground w-full max-w-sm"
            onClick={() => {
              soundEngine.uiClick();
              onTutorial(
                selectedFighter.firstName || selectedFighter.name,
                hubColors
              );
            }}
            data-testid="button-career-tutorial"
          >
            Tutorial Mode
          </Button>
        )}

        <div className="fixed bottom-4 left-4 z-40">
          <button
            onClick={() => setShowSettings(!showSettings)}
            className="w-10 h-10 rounded-full bg-muted hover:bg-muted-foreground/20 flex items-center justify-center transition-colors"
            data-testid="button-career-settings"
          >
            <Settings className="w-5 h-5 text-muted-foreground" />
          </button>
          {showSettings && (
            <div className="absolute bottom-12 left-0 bg-card border rounded-lg shadow-lg p-4 w-56" data-testid="panel-career-settings">
              <p className="text-xs font-bold uppercase text-muted-foreground mb-3">Fight Settings</p>
              <div className="space-y-3">
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Round Length</p>
                  <div className="flex gap-1">
                    {[1, 2, 3].map(m => (
                      <Button
                        key={m}
                        size="sm"
                        variant={careerRoundLen === m ? "default" : "secondary"}
                        className="flex-1 text-xs h-7"
                        onClick={() => setCareerRoundLen(m)}
                        data-testid={`button-career-round-${m}`}
                      >
                        {m} min
                      </Button>
                    ))}
                  </div>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Clock Speed</p>
                  <div className="flex gap-1">
                    <Button
                      size="sm"
                      variant={careerTimerSpeed === "normal" ? "default" : "secondary"}
                      className="flex-1 text-xs h-7"
                      onClick={() => setCareerTimerSpeed("normal")}
                      data-testid="button-career-speed-1x"
                    >
                      1x
                    </Button>
                    <Button
                      size="sm"
                      variant={careerTimerSpeed === "fast" ? "default" : "secondary"}
                      className="flex-1 text-xs h-7"
                      onClick={() => setCareerTimerSpeed("fast")}
                      data-testid="button-career-speed-2x"
                    >
                      2x
                    </Button>
                  </div>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Ref Stoppages</p>
                  <div className="flex gap-1">
                    <Button
                      size="sm"
                      variant={careerRefStoppageEnabled ? "default" : "secondary"}
                      className="flex-1 text-xs h-7"
                      onClick={() => onToggleCareerRefStoppage(true)}
                      data-testid="button-ref-stoppage-on"
                    >
                      On
                    </Button>
                    <Button
                      size="sm"
                      variant={!careerRefStoppageEnabled ? "default" : "secondary"}
                      className="flex-1 text-xs h-7"
                      onClick={() => onToggleCareerRefStoppage(false)}
                      data-testid="button-ref-stoppage-off"
                    >
                      Off
                    </Button>
                  </div>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Towel Stoppages</p>
                  <div className="flex gap-1">
                    <Button
                      size="sm"
                      variant={careerTowelStoppageEnabled ? "default" : "secondary"}
                      className="flex-1 text-xs h-7"
                      onClick={() => onToggleCareerTowelStoppage(true)}
                      data-testid="button-towel-stoppage-on"
                    >
                      On
                    </Button>
                    <Button
                      size="sm"
                      variant={!careerTowelStoppageEnabled ? "default" : "secondary"}
                      className="flex-1 text-xs h-7"
                      onClick={() => onToggleCareerTowelStoppage(false)}
                      data-testid="button-towel-stoppage-off"
                    >
                      Off
                    </Button>
                  </div>
                </div>
              </div>
              {selectedFighter && fighters.indexOf(selectedFighter) < 3 && (
                <div className="border-t pt-3 mt-3">
                  <p className="text-xs font-bold uppercase text-muted-foreground mb-2">PIN Protection</p>
                  {(() => {
                    const hasPin = selectedFighter ? getFighterPin(selectedFighter.id) : null;
                    const locked = selectedFighter ? isPinLocked(selectedFighter.id) : true;
                    return (
                      <div className="space-y-2">
                        {!hasPin ? (
                          <Button
                            size="sm"
                            variant="secondary"
                            className="w-full text-xs h-7 gap-1"
                            onClick={() => {
                              setPinTargetFighter(selectedFighter);
                              setPinFlow("setNew");
                              setPinDigits("");
                              setPinError("");
                              setPinSuccess("");
                              setShowSettings(false);
                            }}
                            data-testid="button-set-pin"
                          >
                            <Lock className="w-3 h-3" /> Set PIN Code
                          </Button>
                        ) : (
                          <>
                            <div className="flex items-center justify-between">
                              <span className="text-xs text-muted-foreground">PIN Active</span>
                              <Button
                                size="sm"
                                variant={locked ? "default" : "secondary"}
                                className="text-xs h-6 gap-1 px-2"
                                onClick={() => {
                                  if (selectedFighter) {
                                    const newLocked = !locked;
                                    setPinLocked(selectedFighter.id, newLocked);
                                    setPinLockedState(prev => ({ ...prev, [selectedFighter.id]: newLocked }));
                                  }
                                }}
                                data-testid="button-toggle-pin-lock"
                              >
                                {locked ? <><Lock className="w-3 h-3" /> Locked</> : <><Unlock className="w-3 h-3" /> Unlocked</>}
                              </Button>
                            </div>
                            <Button
                              size="sm"
                              variant="secondary"
                              className="w-full text-xs h-7 gap-1"
                              onClick={() => {
                                setPinTargetFighter(selectedFighter);
                                setPinFlow("enterChange");
                                setPinDigits("");
                                setPinError("");
                                setPinSuccess("");
                                setShowSettings(false);
                              }}
                              data-testid="button-change-pin"
                            >
                              Change PIN
                            </Button>
                          </>
                        )}
                      </div>
                    );
                  })()}
                </div>
              )}
            </div>
          )}
        </div>

        {pinFlow && (
          <div className="fixed inset-0 z-50 bg-background/80 flex items-center justify-center" data-testid="overlay-pin-entry">
            <Card className="p-6 max-w-xs w-full text-center space-y-4">
              <Lock className="w-8 h-8 mx-auto text-primary" />
              <p className="font-bold">
                {pinFlow === "setNew" && "Set a 4-digit PIN"}
                {pinFlow === "confirmNew" && "Confirm your PIN"}
                {pinFlow === "enterChange" && "Enter current PIN"}
                {pinFlow === "setChangeNew" && "Enter new PIN"}
                {pinFlow === "confirmChangeNew" && "Confirm new PIN"}
              </p>
              <div className="flex justify-center gap-2">
                {[0, 1, 2, 3].map(i => (
                  <div key={i} className={`w-10 h-12 border-2 rounded flex items-center justify-center text-xl font-bold ${i < pinDigits.length ? "border-primary" : "border-muted"}`}>
                    {i < pinDigits.length ? "•" : ""}
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-3 gap-2 max-w-[200px] mx-auto">
                {[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => (
                  <Button key={n} variant="secondary" className="h-10 text-lg font-bold" onClick={() => { if (pinDigits.length < 4) setPinDigits(prev => prev + n); setPinError(""); }} data-testid={`button-pin-${n}`}>{n}</Button>
                ))}
                <Button variant="secondary" className="h-10 text-xs" onClick={() => setPinDigits(prev => prev.slice(0, -1))} data-testid="button-pin-backspace">←</Button>
                <Button variant="secondary" className="h-10 text-lg font-bold" onClick={() => { if (pinDigits.length < 4) setPinDigits(prev => prev + "0"); setPinError(""); }} data-testid="button-pin-0">0</Button>
                <Button variant="default" className="h-10 text-xs font-bold" onClick={handlePinSubmit} disabled={pinDigits.length !== 4} data-testid="button-pin-submit">OK</Button>
              </div>
              {pinError && <p className="text-sm text-destructive font-semibold" data-testid="text-pin-error">{pinError}</p>}
              <Button variant="ghost" size="sm" onClick={clearPinFlow} data-testid="button-pin-cancel">Cancel</Button>
            </Card>
          </div>
        )}

        {pinSuccess && (
          <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 bg-green-600 text-white px-4 py-2 rounded-lg shadow-lg text-sm font-semibold" data-testid="text-pin-success">
            {pinSuccess}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-4 p-4 max-w-lg mx-auto">
      <div className="flex items-center gap-3 w-full">
        <Button variant="ghost" size="icon" onClick={onBack} data-testid="button-back-career">
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <h2 className="text-2xl font-bold flex-1" data-testid="text-career-title">Career Mode</h2>
      </div>

      <p className="text-sm text-muted-foreground w-full">Select a save slot to continue your journey, or create a new fighter.</p>

      {isLoading ? (
        <div className="text-muted-foreground text-sm py-8">Loading...</div>
      ) : (
        <div className="space-y-3 w-full">
          {fighters.map((f, i) => (
            <Card
              key={f.id}
              className="p-4 cursor-pointer hover-elevate"
              onClick={() => handleSelectSlot(f)}
              data-testid={`card-slot-${i}`}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs text-muted-foreground">Slot {i + 1}</span>
                    <span className="font-bold">
                      {f.firstName || f.name}
                      {f.nickname ? ` "${f.nickname}"` : ""}
                      {f.lastName ? ` ${f.lastName}` : ""}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground flex-wrap">
                    <span className="text-primary font-semibold">LV {f.level}</span>
                    <span>{f.archetype}</span>
                    <span>{f.wins}W-{f.losses}L-{f.draws}D</span>
                  </div>
                  <div className="mt-2 h-1.5 rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{ width: `${Math.min(100, (f.xp / xpToNextLevel(f.level)) * 100)}%` }}
                    />
                  </div>
                </div>
                <div className="flex flex-col gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={e => { e.stopPropagation(); handleDownloadData(f); }}
                    title="Download Save"
                    data-testid={`button-download-slot-${i}`}
                  >
                    <Download className="w-4 h-4 text-muted-foreground" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={e => { e.stopPropagation(); handleDeleteSlot(f.id); }}
                    data-testid={`button-delete-slot-${i}`}
                  >
                    <Trash2 className="w-4 h-4 text-muted-foreground" />
                  </Button>
                </div>
              </div>
            </Card>
          ))}

          {fighters.length < MAX_SLOTS && (
            <>
              <Card
                className="p-6 cursor-pointer hover-elevate border-dashed text-center"
                onClick={() => setView("create")}
                data-testid="card-new-slot"
              >
                <Plus className="w-6 h-6 mx-auto mb-1 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">New Fighter (Slot {fighters.length + 1})</p>
              </Card>

              <Card
                className={`p-6 border-dashed text-center transition-colors ${dragOver ? "border-primary bg-primary/10" : ""}`}
                onDrop={handleDrop}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                data-testid="card-import-slot"
              >
                <Upload className="w-6 h-6 mx-auto mb-1 text-muted-foreground" />
                <p className="text-sm text-muted-foreground mb-2">
                  {dragOver ? "Drop save file here" : "Drag a save file here, or"}
                </p>
                {!dragOver && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => fileInputRef.current?.click()}
                    data-testid="button-upload-save"
                  >
                    <Upload className="w-3 h-3 mr-1" /> Upload Save
                  </Button>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".json"
                  className="hidden"
                  onChange={handleFileSelect}
                />
              </Card>
            </>
          )}

          {importError && (
            <p className="text-destructive text-sm text-center" data-testid="text-import-error">{importError}</p>
          )}
        </div>
      )}

      {deleteConfirmId && (
        <div className="fixed inset-0 z-50 bg-background/80 flex items-center justify-center" data-testid="overlay-delete-confirm">
          <Card className="p-6 max-w-xs w-full text-center space-y-4">
            <Trash2 className="w-8 h-8 mx-auto text-destructive" />
            <p className="font-bold">Delete this save?</p>
            <p className="text-sm text-muted-foreground">This action cannot be undone. All progress will be lost.</p>
            <div className="flex gap-2 justify-center">
              <Button variant="secondary" onClick={() => setDeleteConfirmId(null)} data-testid="button-cancel-delete">Cancel</Button>
              <Button variant="destructive" onClick={() => confirmDelete(deleteConfirmId)} data-testid="button-confirm-delete">Delete</Button>
            </div>
          </Card>
        </div>
      )}

      {pinFlow && (
        <div className="fixed inset-0 z-50 bg-background/80 flex items-center justify-center" data-testid="overlay-pin-entry">
          <Card className="p-6 max-w-xs w-full text-center space-y-4">
            <Lock className="w-8 h-8 mx-auto text-primary" />
            <p className="font-bold">
              {pinFlow === "setNew" && "Set a 4-digit PIN"}
              {pinFlow === "confirmNew" && "Confirm your PIN"}
              {pinFlow === "enterLoad" && "Enter PIN to load"}
              {pinFlow === "enterDelete" && "Enter PIN to delete"}
              {pinFlow === "enterChange" && "Enter current PIN"}
              {pinFlow === "setChangeNew" && "Enter new PIN"}
              {pinFlow === "confirmChangeNew" && "Confirm new PIN"}
            </p>
            <div className="flex justify-center gap-2">
              {[0, 1, 2, 3].map(i => (
                <div key={i} className={`w-10 h-12 border-2 rounded flex items-center justify-center text-xl font-bold ${i < pinDigits.length ? "border-primary" : "border-muted"}`}>
                  {i < pinDigits.length ? "•" : ""}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-3 gap-2 max-w-[200px] mx-auto">
              {[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => (
                <Button key={n} variant="secondary" className="h-10 text-lg font-bold" onClick={() => { if (pinDigits.length < 4) setPinDigits(prev => prev + n); setPinError(""); }} data-testid={`button-pin-${n}`}>{n}</Button>
              ))}
              <Button variant="secondary" className="h-10 text-xs" onClick={() => setPinDigits(prev => prev.slice(0, -1))} data-testid="button-pin-backspace">←</Button>
              <Button variant="secondary" className="h-10 text-lg font-bold" onClick={() => { if (pinDigits.length < 4) setPinDigits(prev => prev + "0"); setPinError(""); }} data-testid="button-pin-0">0</Button>
              <Button variant="default" className="h-10 text-xs font-bold" onClick={handlePinSubmit} disabled={pinDigits.length !== 4} data-testid="button-pin-submit">OK</Button>
            </div>
            {pinError && <p className="text-sm text-destructive font-semibold" data-testid="text-pin-error">{pinError}</p>}
            <Button variant="ghost" size="sm" onClick={clearPinFlow} data-testid="button-pin-cancel">Cancel</Button>
          </Card>
        </div>
      )}

      {pinSuccess && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 bg-green-600 text-white px-4 py-2 rounded-lg shadow-lg text-sm font-semibold" data-testid="text-pin-success">
          {pinSuccess}
        </div>
      )}
    </div>
  );
}

function NewsTicker({ news }: { news: string[] }) {
  const tickerRef = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setOffset(prev => prev - 1);
    }, 30);
    return () => clearInterval(interval);
  }, []);

  const tickerText = news.join("  \u2022  ") + "  \u2022  " + news.join("  \u2022  ");

  useEffect(() => {
    if (tickerRef.current) {
      const halfWidth = tickerRef.current.scrollWidth / 2;
      if (Math.abs(offset) >= halfWidth) {
        setOffset(0);
      }
    }
  }, [offset]);

  return (
    <div className="w-full max-w-sm overflow-hidden bg-muted/50 rounded-lg py-1.5 px-2" data-testid="news-ticker">
      <div
        ref={tickerRef}
        className="whitespace-nowrap text-xs text-muted-foreground"
        style={{ transform: `translateX(${offset}px)`, display: "inline-block" }}
      >
        {tickerText}
      </div>
    </div>
  );
}

function OpponentSelectionView({ fighter, rosterState, onSelectOpponent, onBack }: {
  fighter: Fighter;
  rosterState: CareerRosterState;
  onSelectOpponent: (oppId: number) => void;
  onBack: () => void;
}) {
  const [hoveredId, setHoveredId] = useState<number | null>(null);
  const candidates = getOpponentCandidates(rosterState.roster, rosterState.playerRank, fighter.level);

  return (
    <div className="flex flex-col items-center gap-3 p-4 max-w-xl mx-auto">
      <div className="flex items-center gap-3 w-full">
        <Button variant="ghost" size="icon" onClick={onBack} data-testid="button-back-opponents">
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <h2 className="text-xl font-bold flex-1">Choose Opponent</h2>
        <div className="flex flex-col items-end">
          <span className="text-2xl font-black text-yellow-500" data-testid="text-player-rank-opponents">#{rosterState.playerRank}</span>
          <span className="text-[10px] text-muted-foreground leading-none">RANK</span>
        </div>
      </div>

      <p className="text-xs text-muted-foreground w-full">
        Select Fighter
      </p>

      <div className="space-y-2 w-full max-h-[60vh] overflow-y-auto">
        {candidates.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-4">No opponents available in your rank range.</p>
        ) : (
          candidates.map(f => {
            const entry = getRosterEntryById(f.id);
            if (!entry) return null;
            const opp = buildOpponentFromRoster(f);
            if (!opp) return null;
            const isSelected = rosterState.selectedOpponentId === f.id;
            const isUnavailable = !!f.unavailableThisWeek;
            const fc = getRosterFighterColors(f);
            const fighterColors: FighterColors = {
              gloves: fc.gloves,
              gloveTape: fc.gloveTape,
              trunks: fc.trunks,
              shoes: fc.shoes,
              skin: fc.skin,
            };
            return (
              <Card
                key={f.id}
                className={`p-3 w-full transition-all ${isUnavailable ? "opacity-40 cursor-not-allowed" : `cursor-pointer ${isSelected ? "ring-2 ring-primary" : "hover:bg-muted/50"}`}`}
                onClick={() => { if (!isUnavailable) onSelectOpponent(f.id); }}
                onMouseEnter={() => setHoveredId(f.id)}
                onMouseLeave={() => setHoveredId(null)}
                data-testid={`card-opponent-${f.id}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <span className={`text-xs font-bold w-8 shrink-0 ${isUnavailable ? "text-muted-foreground" : "text-primary"}`}>#{f.rank}</span>
                    <div className="min-w-0 flex-1">
                      <p className={`text-sm font-semibold truncate ${isUnavailable ? "text-muted-foreground" : ""}`}>{opp.name}</p>
                      <p className="text-[10px] text-muted-foreground">
                        {opp.archetype} &bull; <span className="text-yellow-500 font-semibold">LV {opp.level}</span> &bull; {opp.aiDifficulty}
                      </p>
                      {hoveredId === f.id && f.statPower != null ? (
                        <p className="text-[10px] text-yellow-400 font-mono font-semibold" data-testid={`text-stats-${f.id}`}>
                          {f.statPower} : {f.statSpeed} : {f.statDefense} : {f.statStamina} : {f.statFocus}
                        </p>
                      ) : (
                        <p className="text-[10px] text-muted-foreground">
                          {opp.wins}W-{opp.losses}L-{opp.draws}D &bull; {opp.knockouts} KOs &bull; Reach: {opp.armLength}&quot;
                          {f.rank === 1 ? <span className="text-yellow-500 font-bold"> &bull; 12 Rounds</span> : KEY_FIGHTER_IDS.includes(f.id) ? <span className="text-yellow-500 font-bold"> &bull; 6 Rounds</span> : null}
                        </p>
                      )}
                      {isUnavailable && <p className="text-[10px] text-yellow-600 font-medium">Unavailable this week</p>}
                    </div>
                    <div className="w-12 h-16 shrink-0">
                      <FighterStanceCanvas colors={fighterColors} width={120} height={144} />
                    </div>
                  </div>
                  {isSelected && !isUnavailable && <span className="text-xs text-primary font-semibold shrink-0">SELECTED</span>}
                </div>
              </Card>
            );
          })
        )}
      </div>
    </div>
  );
}

function RankingsView({ rosterState, fighter, onBack }: {
  rosterState: CareerRosterState;
  fighter: Fighter;
  onBack: () => void;
}) {
  const ranked = rosterState.roster
    .filter(f => f.active && !f.retired && f.rank > 0)
    .sort((a, b) => a.rank - b.rank);

  const playerInsertIndex = ranked.findIndex(f => f.rank >= rosterState.playerRank);
  const playerRank = rosterState.playerRank;

  const playerColors: FighterColors = {
    gloves: (fighter.gearColors as any)?.gloves || "#cc0000",
    gloveTape: (fighter.gearColors as any)?.gloveTape || "#eeeeee",
    trunks: (fighter.gearColors as any)?.trunks || "#ffffff",
    shoes: (fighter.gearColors as any)?.shoes || "#333333",
    skin: fighter.skinColor || "#e8c4a0",
  };

  return (
    <div className="flex flex-col items-center gap-3 p-4 max-w-xl mx-auto">
      <div className="flex items-center gap-3 w-full">
        <Button variant="ghost" size="icon" onClick={onBack} data-testid="button-back-rankings">
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <h2 className="text-xl font-bold flex-1">Rankings</h2>
        <div className="flex flex-col items-end">
          <span className="text-2xl font-black text-yellow-500" data-testid="text-player-rank-rankings">#{playerRank}</span>
          <span className="text-[10px] text-muted-foreground leading-none">RANK</span>
        </div>
      </div>

      <div className="space-y-1 w-full max-h-[70vh] overflow-y-auto">
        {ranked.map((f, idx) => {
          const entry = getRosterEntryById(f.id);
          if (!entry) return null;
          const name = getRosterDisplayName(entry, f);
          const isPlayerAbove = idx === playerInsertIndex && playerInsertIndex >= 0;
          const showPlayer = isPlayerAbove && playerRank <= f.rank;
          const fc = getRosterFighterColors(f);
          const fighterColors: FighterColors = {
            gloves: fc.gloves,
            gloveTape: fc.gloveTape,
            trunks: fc.trunks,
            shoes: fc.shoes,
            skin: fc.skin,
          };

          return (
            <div key={f.id}>
              {showPlayer && (
                <div className="flex items-center gap-3 px-3 py-2 bg-primary/10 rounded-md" data-testid="rankings-player-row">
                  <span className="text-xs font-bold text-primary w-8">#{playerRank}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold text-primary truncate">
                      {fighter.firstName || fighter.name}
                      {fighter.nickname ? ` "${fighter.nickname}"` : ""}
                      {fighter.lastName ? ` ${fighter.lastName}` : ""} (YOU)
                    </p>
                    <p className="text-[10px] text-primary/70">
                      {fighter.wins}W-{fighter.losses}L-{fighter.draws}D &bull; LV {fighter.level}
                    </p>
                  </div>
                  <div className="w-12 h-16 shrink-0">
                    <FighterStanceCanvas colors={playerColors} width={120} height={144} />
                  </div>
                </div>
              )}
              <div className={`flex items-center gap-3 px-3 py-1.5 ${f.rank <= 3 ? "bg-yellow-500/5" : ""}`}>
                <span className={`text-xs font-bold w-8 ${f.rank <= 3 ? "text-yellow-500" : "text-muted-foreground"}`}>
                  #{f.rank}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm truncate">{name}</p>
                  <p className="text-[10px] text-muted-foreground">
                    {f.wins}W-{f.losses}L-{f.draws}D &bull; {f.knockouts} KOs &bull; LV {f.level}
                  </p>
                </div>
                <div className="w-12 h-16 shrink-0">
                  <FighterStanceCanvas colors={fighterColors} width={120} height={144} />
                </div>
              </div>
            </div>
          );
        })}

        {playerInsertIndex === -1 && (
          <div className="flex items-center gap-3 px-3 py-2 bg-primary/10 rounded-md" data-testid="rankings-player-row">
            <span className="text-xs font-bold text-primary w-8">#{playerRank}</span>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold text-primary truncate">
                {fighter.firstName || fighter.name}
                {fighter.nickname ? ` "${fighter.nickname}"` : ""}
                {fighter.lastName ? ` ${fighter.lastName}` : ""} (YOU)
              </p>
              <p className="text-[10px] text-primary/70">
                {fighter.wins}W-{fighter.losses}L-{fighter.draws}D &bull; LV {fighter.level}
              </p>
            </div>
            <div className="w-12 h-16 shrink-0">
              <FighterStanceCanvas colors={playerColors} width={120} height={144} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function SwatchRow({ label, selected, options, onSelect, testId }: {
  label: string;
  selected: string;
  options: string[];
  onSelect: (color: string) => void;
  testId: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground w-14 text-right shrink-0">{label}</span>
      <div className="flex gap-1.5 flex-wrap">
        {options.map(c => (
          <button
            key={c}
            className={`w-6 h-6 rounded-md cursor-pointer transition-all ${
              selected === c ? "ring-2 ring-primary ring-offset-1 ring-offset-background" : ""
            }`}
            style={{ backgroundColor: c }}
            onClick={() => onSelect(c)}
            data-testid={`${testId}-${c}`}
          />
        ))}
      </div>
    </div>
  );
}

function CreateFighter({
  firstName, setFirstName, nickname, setNickname, lastName, setLastName,
  archetype, setArchetype, difficulty, setDifficulty, roundLength, setRoundLength,
  skinColor, setSkinColor, gearColors, setGearColors,
  onCreate, onBack,
}: {
  firstName: string; setFirstName: (v: string) => void;
  nickname: string; setNickname: (v: string) => void;
  lastName: string; setLastName: (v: string) => void;
  archetype: Archetype; setArchetype: (v: Archetype) => void;
  difficulty: AIDifficulty; setDifficulty: (v: AIDifficulty) => void;
  roundLength: number; setRoundLength: (v: number) => void;
  skinColor: string; setSkinColor: (v: string) => void;
  gearColors: GearColors; setGearColors: (v: GearColors) => void;
  onCreate: () => void;
  onBack: () => void;
}) {
  const previewColors: FighterColors = {
    ...gearColors,
    skin: skinColor,
  };

  return (
    <div className="flex flex-col items-center gap-4 p-4 max-w-lg mx-auto">
      <div className="flex items-center gap-3 w-full">
        <Button variant="ghost" size="icon" onClick={onBack} data-testid="button-back-create">
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <h2 className="text-xl font-bold flex-1">Create Your Fighter</h2>
      </div>

      <Card className="p-4 w-full space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-xs text-muted-foreground">First Name *</label>
            <Input value={firstName} onChange={e => setFirstName(e.target.value)} maxLength={15} data-testid="input-first-name" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Last Name *</label>
            <Input value={lastName} onChange={e => setLastName(e.target.value)} maxLength={15} data-testid="input-last-name" />
          </div>
        </div>
        <div>
          <label className="text-xs text-muted-foreground">Nickname (optional)</label>
          <Input value={nickname} onChange={e => setNickname(e.target.value)} maxLength={20} placeholder='e.g. "The Hammer"' data-testid="input-nickname" />
        </div>
      </Card>

      <Card className="p-4 w-full space-y-3">
        <p className="text-xs uppercase text-muted-foreground font-semibold">Fighting Style</p>
        <div className="grid grid-cols-2 gap-2">
          {(["BoxerPuncher", "OutBoxer", "Brawler", "Swarmer"] as Archetype[]).map(a => (
            <Button
              key={a}
              variant={archetype === a ? "default" : "secondary"}
              onClick={() => setArchetype(a)}
              className="text-xs"
              data-testid={`button-arch-${a}`}
            >
              {a}
            </Button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">{ARCHETYPE_STATS[archetype].description}</p>
      </Card>

      <Card className="p-4 w-full space-y-3">
        <p className="text-xs uppercase text-muted-foreground font-semibold">Appearance</p>
        <div className="flex items-start gap-4">
          <div className="flex-1 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Skin</label>
                <div className="flex items-center gap-2">
                  <input type="color" value={skinColor} onChange={e => setSkinColor(e.target.value)} className="w-8 h-8 rounded cursor-pointer" data-testid="color-create-skin" />
                  <span className="text-xs text-muted-foreground">{skinColor}</span>
                </div>
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Gloves</label>
                <div className="flex items-center gap-2">
                  <input type="color" value={gearColors.gloves} onChange={e => setGearColors({ ...gearColors, gloves: e.target.value })} className="w-8 h-8 rounded cursor-pointer" data-testid="color-create-gloves" />
                  <span className="text-xs text-muted-foreground">{gearColors.gloves}</span>
                </div>
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Tape</label>
                <div className="flex items-center gap-2">
                  <input type="color" value={gearColors.gloveTape} onChange={e => setGearColors({ ...gearColors, gloveTape: e.target.value })} className="w-8 h-8 rounded cursor-pointer" data-testid="color-create-tape" />
                  <span className="text-xs text-muted-foreground">{gearColors.gloveTape}</span>
                </div>
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Trunks</label>
                <div className="flex items-center gap-2">
                  <input type="color" value={gearColors.trunks} onChange={e => setGearColors({ ...gearColors, trunks: e.target.value })} className="w-8 h-8 rounded cursor-pointer" data-testid="color-create-trunks" />
                  <span className="text-xs text-muted-foreground">{gearColors.trunks}</span>
                </div>
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Shoes</label>
                <div className="flex items-center gap-2">
                  <input type="color" value={gearColors.shoes} onChange={e => setGearColors({ ...gearColors, shoes: e.target.value })} className="w-8 h-8 rounded cursor-pointer" data-testid="color-create-shoes" />
                  <span className="text-xs text-muted-foreground">{gearColors.shoes}</span>
                </div>
              </div>
            </div>
          </div>
          <div className="w-28 h-36 shrink-0">
            <FighterStanceCanvas colors={previewColors} width={160} height={200} />
          </div>
        </div>
      </Card>

      <Card className="p-4 w-full space-y-3">
        <p className="text-xs uppercase text-muted-foreground font-semibold">Career Difficulty</p>
        <div className="grid grid-cols-2 gap-2">
          {(["journeyman", "contender", "elite", "champion"] as AIDifficulty[]).map(d => (
            <Button
              key={d}
              variant={difficulty === d ? "default" : "secondary"}
              onClick={() => setDifficulty(d)}
              className="text-xs capitalize"
              data-testid={`button-diff-${d}`}
            >
              {d}
            </Button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          {difficulty === "journeyman" ? "Safer path, slower growth. Good for learning." :
           difficulty === "contender" ? "Balanced challenge and rewards." :
           difficulty === "elite" ? "Tough opponents, bigger XP gains." :
           "Maximum difficulty. Only the best survive."}
        </p>
      </Card>

      <Card className="p-4 w-full space-y-3">
        <p className="text-xs uppercase text-muted-foreground font-semibold">Round Length</p>
        <div className="grid grid-cols-3 gap-2">
          {[1, 2, 3].map(m => (
            <Button
              key={m}
              variant={roundLength === m ? "default" : "secondary"}
              onClick={() => setRoundLength(m)}
              className="text-xs"
              data-testid={`button-round-${m}`}
            >
              {m} min
            </Button>
          ))}
        </div>
      </Card>

      <Button
        onClick={onCreate}
        className="w-full"
        disabled={!firstName.trim() || !lastName.trim()}
        data-testid="button-create-fighter"
      >
        Create Fighter
      </Button>
    </div>
  );
}

const PLAYSTYLE_PARAMS = [
  { id: "aggression", label: "Aggression", category: "Personality" },
  { id: "guardParanoia", label: "Guard Paranoia", category: "Personality" },
  { id: "feintiness", label: "Feintiness", category: "Personality" },
  { id: "cleanHitsVsVolume", label: "Precision", category: "Personality" },
  { id: "stateThinkSpeed", label: "Accuracy", category: "Reaction" },
  { id: "moveThinkSpeed", label: "Movement IQ", category: "Reaction" },
  { id: "attackInterval", label: "Punch Rate", category: "Reaction" },
  { id: "perfectReactChance", label: "Reflexes", category: "Defense" },
  { id: "defenseCycleSpeed", label: "Defense Activity", category: "Defense" },
  { id: "headCondThreshold", label: "Chin", category: "Defense" },
  { id: "bodyCondThreshold", label: "Body Toughness", category: "Defense" },
  { id: "rhythmCutCommit", label: "Pressure", category: "Offense" },
  { id: "rhythmCutAggression", label: "Volume", category: "Offense" },
  { id: "chargedPunchChance", label: "Power Punching", category: "Offense" },
  { id: "comboCommitChance", label: "Combinations", category: "Offense" },
  { id: "ringCutoff", label: "Ring Control", category: "Movement" },
  { id: "ropeEscapeAwareness", label: "Evasion", category: "Movement" },
  { id: "lateralStrength", label: "Footwork", category: "Movement" },
  { id: "kdRecovery1", label: "Recovery 1", category: "Resilience" },
  { id: "kdRecovery2", label: "Recovery 2", category: "Resilience" },
  { id: "kdRecovery3", label: "Recovery 3", category: "Resilience" },
  { id: "survivalInstinct", label: "Heart", category: "Resilience" },
];

const PLAYSTYLE_CAT_COLORS: Record<string, string> = {
  Personality: "#e06060",
  Reaction: "#60a0e0",
  Defense: "#60c060",
  Offense: "#e0a040",
  Movement: "#a070d0",
  Resilience: "#d06090",
};

function PlaystyleRadar({ playstyle }: { playstyle: PlayerPlaystyle }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;

    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = "#0a0a12";
    ctx.fillRect(0, 0, w, h);

    const cx = w / 2;
    const cy = h / 2;
    const maxR = Math.min(w, h) * 0.36;
    const n = PLAYSTYLE_PARAMS.length;
    const angleStep = (Math.PI * 2) / n;

    for (let ring = 1; ring <= 5; ring++) {
      const r = (ring / 5) * maxR;
      ctx.strokeStyle = `rgba(100, 130, 200, ${0.06 + ring * 0.025})`;
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      for (let i = 0; i <= n; i++) {
        const angle = i * angleStep - Math.PI / 2;
        const x = cx + Math.cos(angle) * r;
        const y = cy + Math.sin(angle) * r;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.stroke();
    }

    for (let i = 0; i < n; i++) {
      const angle = i * angleStep - Math.PI / 2;
      const x2 = cx + Math.cos(angle) * maxR;
      const y2 = cy + Math.sin(angle) * maxR;
      ctx.strokeStyle = "rgba(100, 130, 200, 0.10)";
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }

    ctx.fillStyle = "rgba(80, 180, 255, 0.08)";
    ctx.strokeStyle = "rgba(80, 180, 255, 0.7)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const param = PLAYSTYLE_PARAMS[i];
      const val = playstyle[param.id] ?? 0.02;
      const angle = i * angleStep - Math.PI / 2;
      const r = val * maxR;
      const x = cx + Math.cos(angle) * r;
      const y = cy + Math.sin(angle) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    for (let i = 0; i < n; i++) {
      const param = PLAYSTYLE_PARAMS[i];
      const val = playstyle[param.id] ?? 0.02;
      const angle = i * angleStep - Math.PI / 2;
      const r = val * maxR;
      const x = cx + Math.cos(angle) * r;
      const y = cy + Math.sin(angle) * r;
      const catColor = PLAYSTYLE_CAT_COLORS[param.category] || "#888";

      ctx.fillStyle = catColor;
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.font = "9px monospace";
    ctx.textAlign = "center";
    for (let i = 0; i < n; i++) {
      const param = PLAYSTYLE_PARAMS[i];
      const angle = i * angleStep - Math.PI / 2;
      const labelR = maxR + 14;
      const lx = cx + Math.cos(angle) * labelR;
      const ly = cy + Math.sin(angle) * labelR;
      const catColor = PLAYSTYLE_CAT_COLORS[param.category] || "#888";
      ctx.fillStyle = catColor + "bb";
      ctx.fillText(param.label, lx, ly + 3);
    }
  }, [playstyle]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: "100%", height: "300px" }}
      data-testid="canvas-playstyle-radar"
    />
  );
}

function CareerStatsView({ fighter, onBack }: { fighter: Fighter; onBack: () => void }) {
  const stats = (fighter.careerStats || DEFAULT_CAREER_STATS) as CareerStats;
  const tb = (fighter.trainingBonuses || DEFAULT_TRAINING_BONUSES) as TrainingBonuses;
  const accuracy = stats.totalPunchesThrown > 0
    ? ((stats.totalPunchesLanded / stats.totalPunchesThrown) * 100).toFixed(1)
    : "0.0";

  const playstyle = loadPlayerPlaystyle(fighter.id);
  const hasFought = fighter.careerBoutIndex > 0 || (tb.sparring || 0) > 0;

  return (
    <div className="flex flex-col items-center gap-4 p-4 max-w-lg mx-auto">
      <div className="flex items-center gap-3 w-full">
        <Button variant="ghost" size="icon" onClick={onBack} data-testid="button-back-stats">
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <h2 className="text-xl font-bold flex-1">Career Stats</h2>
      </div>

      {hasFought && playstyle && (
        <Card className="p-3 w-full">
          <p className="text-xs uppercase text-muted-foreground font-semibold mb-2">Playstyle Network</p>
          <PlaystyleRadar playstyle={playstyle} />
          <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 justify-center">
            {Object.entries(PLAYSTYLE_CAT_COLORS).map(([cat, color]) => (
              <span key={cat} className="text-[10px] font-mono flex items-center gap-1">
                <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
                {cat}
              </span>
            ))}
          </div>
        </Card>
      )}

      <Card className="p-4 w-full">
        <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
          <StatRow label="Bouts Fought" value={fighter.careerBoutIndex} />
          <StatRow label="Record" value={`${fighter.wins}W-${fighter.losses}L-${fighter.draws}D`} />
          <StatRow label="Knockouts" value={fighter.knockouts} />
          <StatRow label="Punches Thrown" value={stats.totalPunchesThrown} />
          <StatRow label="Punches Landed" value={stats.totalPunchesLanded} />
          <StatRow label="Accuracy" value={`${accuracy}%`} />
          <StatRow label="KDs Given" value={stats.totalKnockdownsGiven} />
          <StatRow label="KDs Taken" value={stats.totalKnockdownsTaken} />
          <StatRow label="Blocks Made" value={stats.totalBlocksMade} />
          <StatRow label="Dodges" value={stats.totalDodges} />
          <StatRow label="Damage Dealt" value={stats.totalDamageDealt} />
          <StatRow label="Damage Received" value={stats.totalDamageReceived} />
          <StatRow label="Rounds Won" value={stats.totalRoundsWon} />
          <StatRow label="Rounds Lost" value={stats.totalRoundsLost} />
          <StatRow label="Lifetime XP" value={stats.lifetimeXp} />
        </div>
      </Card>

      {(tb.weightLifting > 0 || tb.heavyBag > 0 || (tb.sparring || 0) > 0) && (
        <Card className="p-4 w-full">
          <p className="text-xs uppercase text-muted-foreground font-semibold mb-2">Training History</p>
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <StatRow label="Weight Sessions" value={tb.weightLifting} />
            <StatRow label="Bag Sessions" value={tb.heavyBag} />
            <StatRow label="Sparring Sessions" value={tb.sparring || 0} />
          </div>
        </Card>
      )}
    </div>
  );
}

function StatRow({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono font-semibold">{value}</span>
    </div>
  );
}

export const SPARRING_XP_MULT: Record<AIDifficulty, number> = {
  journeyman: 0.8,
  contender: 1.0,
  elite: 1.35,
  champion: 1.75,
};


function SparringDifficultySelect({ fighter, onSelect, onBack }: {
  fighter: Fighter;
  onSelect: (difficulty: AIDifficulty) => void;
  onBack: () => void;
}) {
  const difficulties: AIDifficulty[] = ["journeyman", "contender", "elite", "champion"];
  const rs = fighter.careerRosterState as CareerRosterState | null;
  const hasOpponent = rs?.selectedOpponentId != null;
  const prepWeeks = rs?.prepWeeksRemaining ?? null;
  const nearFight = hasOpponent && prepWeeks != null && prepWeeks <= 2;

  return (
    <div className="flex flex-col items-center gap-3 p-4 max-w-lg mx-auto">
      <div className="flex items-center gap-3 w-full">
        <Button variant="ghost" size="icon" onClick={onBack} data-testid="button-back-sparring">
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <h2 className="text-xl font-bold flex-1">Sparring</h2>
      </div>

      <p className="text-xs text-muted-foreground w-full">
        Practice fight: 1 round, 1 minute. Allocate earned points to Speed, Defense, or Stamina.
      </p>

      <div className="space-y-2 w-full">
        {difficulties.map(diff => {
          const fights = fighter.careerBoutIndex || 0;
          const minFights = diff === "champion" ? 7 : diff === "elite" ? 4 : diff === "contender" ? 1 : 0;
          const champPrepLocked = diff === "champion" && !nearFight;
          const locked = fights < minFights || champPrepLocked;
          const winPts = diff === "journeyman" ? 2 : diff === "contender" ? 3 : diff === "elite" ? 4 : 5;
          const lockReason = fights < minFights ? `Unlocks at ${minFights} fights` : champPrepLocked ? "Available in last 2 prep weeks" : "";
          return (
            <Card
              key={diff}
              className={`p-3 w-full transition-all ${locked ? "opacity-40 cursor-not-allowed" : "cursor-pointer hover:bg-muted/50"}`}
              onClick={() => { if (!locked) onSelect(diff); }}
              data-testid={`card-sparring-${diff}`}
            >
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold">{AI_DIFFICULTY_LABELS[diff]}</p>
                  <p className="text-[10px] text-muted-foreground">
                    {locked ? lockReason : `Win: ${winPts} pts \u2022 Lose: 1 pt`}
                  </p>
                </div>
                <span className="text-xs text-primary font-semibold">{locked ? "LOCKED" : "SPAR"}</span>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

export function AllocateStats({ fighter, onAllocate, onBack, allowedStats, fixedPoints }: {
  fighter: Fighter;
  onAllocate: (sp: SkillPoints, spent: number) => void;
  onBack: () => void;
  allowedStats?: (keyof SkillPoints)[];
  fixedPoints?: number;
}) {
  const rawCurrent = fighter.skillPoints as SkillPoints;
  const current: SkillPoints = { power: rawCurrent.power || 0, speed: rawCurrent.speed || 0, defense: rawCurrent.defense || 0, stamina: rawCurrent.stamina || 0, focus: rawCurrent.focus || 0 };
  const budget = fixedPoints ?? fighter.availableStatPoints;
  const [points, setPoints] = useState<SkillPoints>({ ...current });
  const spent = (points.power - current.power) + (points.speed - current.speed) +
    (points.defense - current.defense) + (points.stamina - current.stamina) + (points.focus - current.focus);
  const remaining = budget - spent;

  const allowed = allowedStats ? new Set(allowedStats) : null;

  const STAT_CAP = 200;
  const increment = (stat: keyof SkillPoints) => {
    if (remaining > 0 && points[stat] < STAT_CAP && (!allowed || allowed.has(stat))) {
      setPoints(p => ({ ...p, [stat]: p[stat] + 1 }));
    }
  };

  const decrement = (stat: keyof SkillPoints) => {
    if (points[stat] > current[stat] && (!allowed || allowed.has(stat))) {
      setPoints(p => ({ ...p, [stat]: p[stat] - 1 }));
    }
  };

  const title = fixedPoints != null ? "Training Reward" : "Allocate Stats";

  return (
    <div className="flex flex-col items-center gap-4 p-4 max-w-lg mx-auto">
      <div className="flex items-center gap-3 w-full">
        {!fixedPoints && (
          <Button variant="ghost" size="icon" onClick={onBack} data-testid="button-back-allocate">
            <ArrowLeft className="w-5 h-5" />
          </Button>
        )}
        <h2 className="text-xl font-bold flex-1">{title}</h2>
        <span className="text-sm font-semibold text-primary">{remaining} pts left</span>
      </div>

      {fixedPoints != null && allowedStats && (
        <p className="text-xs text-muted-foreground w-full">
          Allocate {budget} point{budget !== 1 ? "s" : ""} to: {allowedStats.map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(", ")}
        </p>
      )}

      <Card className="p-4 w-full space-y-4">
        {(["power", "speed", "defense", "stamina", "focus"] as const).map(stat => {
          const isLocked = allowed != null && !allowed.has(stat);
          return (
            <div key={stat} className={`flex items-center justify-between gap-3 ${isLocked ? "opacity-40" : ""}`}>
              <span className="text-sm capitalize w-20 relative group cursor-help" data-testid={`stat-label-${stat}`}>
                {stat}
                <span className="absolute bottom-full left-0 mb-1 px-2 py-1 bg-popover border border-border rounded shadow-lg text-[10px] text-popover-foreground whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none z-50 transition-opacity">
                  {{
                    power: "Increases damage",
                    speed: "Increases punch & move speed",
                    defense: "Increases block strength & autoguard duration",
                    stamina: "Increases max stamina & regen",
                    focus: "Increases crit & stun chance",
                  }[stat]}
                </span>
              </span>
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  size="icon"
                  className="shrink-0"
                  onClick={() => decrement(stat)}
                  disabled={isLocked || points[stat] <= current[stat]}
                  data-testid={`button-dec-${stat}`}
                >
                  -
                </Button>
                <span className="w-8 text-center font-mono font-bold">{points[stat]}</span>
                <Button
                  variant="secondary"
                  size="icon"
                  className="shrink-0"
                  onClick={() => increment(stat)}
                  disabled={isLocked || remaining <= 0 || points[stat] >= STAT_CAP}
                  data-testid={`button-inc-${stat}`}
                >
                  +
                </Button>
              </div>
              <span className="text-xs text-green-500 w-8 text-right">
                {points[stat] > current[stat] ? `+${points[stat] - current[stat]}` : ""}
              </span>
            </div>
          );
        })}
      </Card>

      <Button
        onClick={() => onAllocate(points, spent)}
        className="w-full"
        disabled={spent === 0}
        data-testid="button-confirm-allocate"
      >
        Confirm Allocation
      </Button>
    </div>
  );
}

function EditFighterColors({ fighter, onSave, onBack }: {
  fighter: Fighter;
  onSave: (skinColor: string, gearColors: GearColors) => void;
  onBack: () => void;
}) {
  const gc = (fighter.gearColors as GearColors) || DEFAULT_GEAR_COLORS;
  const [skinColor, setSkinColor] = useState(fighter.skinColor || "#e8c4a0");
  const [gloves, setGloves] = useState(gc.gloves);
  const [gloveTape, setGloveTape] = useState(gc.gloveTape);
  const [trunks, setTrunks] = useState(gc.trunks);
  const [shoes, setShoes] = useState(gc.shoes);

  const previewColors: FighterColors = { gloves, gloveTape, trunks, shoes, skin: skinColor };

  return (
    <div className="flex flex-col items-center gap-3 p-4 max-w-lg mx-auto">
      <div className="flex items-center gap-3 w-full">
        <Button variant="ghost" size="icon" onClick={onBack} data-testid="button-back-edit-colors">
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <h2 className="text-xl font-bold flex-1">Edit Colors</h2>
      </div>

      <div className="w-32 h-40 my-2">
        <FighterStanceCanvas colors={previewColors} width={128} height={160} />
      </div>

      <Card className="p-4 w-full space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Skin</label>
            <div className="flex items-center gap-2">
              <input type="color" value={skinColor} onChange={e => setSkinColor(e.target.value)} className="w-8 h-8 rounded cursor-pointer" data-testid="color-hub-skin" />
              <span className="text-xs text-muted-foreground">{skinColor}</span>
            </div>
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Gloves</label>
            <div className="flex items-center gap-2">
              <input type="color" value={gloves} onChange={e => setGloves(e.target.value)} className="w-8 h-8 rounded cursor-pointer" data-testid="color-hub-gloves" />
              <span className="text-xs text-muted-foreground">{gloves}</span>
            </div>
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Tape</label>
            <div className="flex items-center gap-2">
              <input type="color" value={gloveTape} onChange={e => setGloveTape(e.target.value)} className="w-8 h-8 rounded cursor-pointer" data-testid="color-hub-tape" />
              <span className="text-xs text-muted-foreground">{gloveTape}</span>
            </div>
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Trunks</label>
            <div className="flex items-center gap-2">
              <input type="color" value={trunks} onChange={e => setTrunks(e.target.value)} className="w-8 h-8 rounded cursor-pointer" data-testid="color-hub-trunks" />
              <span className="text-xs text-muted-foreground">{trunks}</span>
            </div>
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Shoes</label>
            <div className="flex items-center gap-2">
              <input type="color" value={shoes} onChange={e => setShoes(e.target.value)} className="w-8 h-8 rounded cursor-pointer" data-testid="color-hub-shoes" />
              <span className="text-xs text-muted-foreground">{shoes}</span>
            </div>
          </div>
        </div>
      </Card>

      <Button
        onClick={() => onSave(skinColor, { gloves, gloveTape, trunks, shoes })}
        className="w-full gap-2"
        data-testid="button-save-colors"
      >
        <Check className="w-4 h-4" /> Save Colors
      </Button>
    </div>
  );
}

export function RosterEditView({
  rosterState,
  fighterName,
  onSave,
  onBack,
}: {
  rosterState: CareerRosterState;
  fighterName?: string;
  onSave: (updatedRoster: RosterFighterState[]) => void;
  onBack: () => void;
}) {
  const [editedRoster, setEditedRoster] = useState<RosterFighterState[]>(
    () => rosterState.roster.map(f => ({ ...f }))
  );
  const [search, setSearch] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [showNeural, setShowNeural] = useState(false);

  const [editFirst, setEditFirst] = useState("");
  const [editNick, setEditNick] = useState("");
  const [editLast, setEditLast] = useState("");
  const [editSkin, setEditSkin] = useState("#e8c4a0");
  const [editGloves, setEditGloves] = useState("#cc0000");
  const [editTrunks, setEditTrunks] = useState("#ffffff");
  const [editShoes, setEditShoes] = useState("#333333");
  const [editingNeuralId, setEditingNeuralId] = useState<number | null>(null);
  const rosterFileRef = useRef<HTMLInputElement>(null);

  const downloadRoster = () => {
    const label = fighterName || "career";
    const rosterExport = {
      exportedAt: new Date().toISOString(),
      fighterName: label,
      weekNumber: rosterState.weekNumber,
      playerRank: rosterState.playerRank,
      playerRatingScore: rosterState.playerRatingScore,
      roster: editedRoster.filter(r => r.active && !r.retired).sort((a, b) => a.rank - b.rank).map(r => {
        const entry = getRosterEntryById(r.id);
        return {
          rank: r.rank,
          id: r.id,
          name: entry ? getRosterDisplayName(entry, r) : `Fighter #${r.id}`,
          level: r.level,
          record: `${r.wins}W-${r.losses}L-${r.draws}D`,
          knockouts: r.knockouts,
          ratingScore: Math.round(r.ratingScore || 0),
          totalFights: r.totalFights,
          beatenByPlayer: r.beatenByPlayer,
          statPower: r.statPower,
          statSpeed: r.statSpeed,
          statDefense: r.statDefense,
          statStamina: r.statStamina,
          statFocus: r.statFocus,
          overallRating: r.overallRating,
        };
      }),
    };
    const json = JSON.stringify(rosterExport, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `handz_roster_${label.replace(/[^a-zA-Z0-9]/g, "_")}_week${rosterState.weekNumber}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const [importError, setRosterImportError] = useState<string | null>(null);

  const importRoster = (file: File) => {
    setRosterImportError(null);
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target?.result as string);
        if (!data || !Array.isArray(data.roster)) {
          throw new Error("Invalid roster file format");
        }
        const importedRoster = editedRoster.map(f => ({ ...f }));
        for (const imported of data.roster) {
          const idx = importedRoster.findIndex(r => r.id === imported.id);
          if (idx >= 0) {
            if (imported.customFirstName !== undefined) importedRoster[idx].customFirstName = imported.customFirstName;
            if (imported.customNickname !== undefined) importedRoster[idx].customNickname = imported.customNickname;
            if (imported.customLastName !== undefined) importedRoster[idx].customLastName = imported.customLastName;
            if (imported.customGloves !== undefined) importedRoster[idx].customGloves = imported.customGloves;
            if (imported.customTrunks !== undefined) importedRoster[idx].customTrunks = imported.customTrunks;
            if (imported.customShoes !== undefined) importedRoster[idx].customShoes = imported.customShoes;
            if (imported.customSkinColor !== undefined) importedRoster[idx].customSkinColor = imported.customSkinColor;
          }
        }
        setEditedRoster(importedRoster);
      } catch (err: any) {
        setRosterImportError(err.message || "Failed to import roster");
      }
    };
    reader.readAsText(file);
  };

  const handleRosterFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) importRoster(file);
    if (rosterFileRef.current) rosterFileRef.current.value = "";
  };

  const activeFighters = editedRoster
    .filter(f => f.active && !f.retired)
    .sort((a, b) => a.rank - b.rank);

  const filtered = search.trim()
    ? activeFighters.filter(f => {
        const entry = getRosterEntryById(f.id);
        if (!entry) return false;
        const name = getRosterDisplayName(entry, f).toLowerCase();
        return name.includes(search.toLowerCase());
      })
    : activeFighters;

  const startEdit = (f: RosterFighterState) => {
    const entry = getRosterEntryById(f.id);
    if (!entry) return;
    const colors = getRosterFighterColors(f);
    setEditingId(f.id);
    setEditFirst(f.customFirstName ?? entry.firstName);
    setEditNick(f.customNickname ?? entry.nickname);
    setEditLast(f.customLastName ?? entry.lastName);
    setEditSkin(f.customSkinColor ?? colors.skin);
    setEditGloves(f.customGloves ?? colors.gloves);
    setEditTrunks(f.customTrunks ?? colors.trunks);
    setEditShoes(f.customShoes ?? colors.shoes);
  };

  const applyEdit = () => {
    if (editingId === null) return;
    setEditedRoster(prev => prev.map(f => {
      if (f.id !== editingId) return f;
      return {
        ...f,
        customFirstName: editFirst.trim() || undefined,
        customNickname: editNick.trim() || undefined,
        customLastName: editLast.trim() || undefined,
        customSkinColor: editSkin,
        customGloves: editGloves,
        customTrunks: editTrunks,
        customShoes: editShoes,
      };
    }));
    setEditingId(null);
  };

  const handleSave = () => {
    setShowConfirm(true);
  };

  const confirmSave = () => {
    saveRosterCustomizations(editedRoster);
    onSave(editedRoster);
  };

  if (editingNeuralId !== null) {
    const nEntry = getRosterEntryById(editingNeuralId);
    const nFighter = editedRoster.find(r => r.id === editingNeuralId);
    const nName = nEntry && nFighter ? getRosterDisplayName(nEntry, nFighter) : `Fighter ${editingNeuralId}`;
    return <NeuralNetworkView onBack={() => setEditingNeuralId(null)} fighterId={editingNeuralId} fighterName={nName} />;
  }

  if (showNeural) {
    return <NeuralNetworkView onBack={() => setShowNeural(false)} />;
  }

  if (showConfirm) {
    return (
      <div className="flex flex-col items-center gap-4 p-4 max-w-lg mx-auto">
        <Card className="p-6 w-full text-center space-y-4">
          <Check className="w-10 h-10 mx-auto text-primary" />
          <h3 className="text-lg font-bold">Save Roster Changes?</h3>
          <p className="text-sm text-muted-foreground">This will update all fighter names and colors you've edited.</p>
          <div className="flex gap-3 justify-center">
            <Button variant="secondary" onClick={() => setShowConfirm(false)} data-testid="button-cancel-save">
              Cancel
            </Button>
            <Button onClick={confirmSave} data-testid="button-confirm-save">
              <Save className="w-4 h-4 mr-2" /> Save
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  if (editingId !== null) {
    const entry = getRosterEntryById(editingId);
    const f = editedRoster.find(r => r.id === editingId);
    if (!entry || !f) return null;

    return (
      <div className="flex flex-col items-center gap-3 p-4 max-w-lg mx-auto">
        <div className="flex items-center gap-3 w-full">
          <Button variant="ghost" size="icon" onClick={() => setEditingId(null)} data-testid="button-back-edit-fighter">
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <h2 className="text-xl font-bold flex-1">Edit Fighter</h2>
        </div>

        <Card className="p-4 w-full space-y-3">
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">First Name</label>
            <Input
              value={editFirst}
              onChange={e => setEditFirst(e.target.value)}
              placeholder={entry.firstName}
              data-testid="input-edit-first"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Nickname</label>
            <Input
              value={editNick}
              onChange={e => setEditNick(e.target.value)}
              placeholder={entry.nickname || "None"}
              data-testid="input-edit-nick"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Last Name</label>
            <Input
              value={editLast}
              onChange={e => setEditLast(e.target.value)}
              placeholder={entry.lastName}
              data-testid="input-edit-last"
            />
          </div>
        </Card>

        <Card className="p-4 w-full space-y-3">
          <p className="text-sm font-semibold">Colors</p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Skin</label>
              <div className="flex items-center gap-2">
                <input type="color" value={editSkin} onChange={e => setEditSkin(e.target.value)} className="w-8 h-8 rounded cursor-pointer" data-testid="color-edit-skin" />
                <span className="text-xs text-muted-foreground">{editSkin}</span>
              </div>
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Gloves</label>
              <div className="flex items-center gap-2">
                <input type="color" value={editGloves} onChange={e => setEditGloves(e.target.value)} className="w-8 h-8 rounded cursor-pointer" data-testid="color-edit-gloves" />
                <span className="text-xs text-muted-foreground">{editGloves}</span>
              </div>
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Trunks</label>
              <div className="flex items-center gap-2">
                <input type="color" value={editTrunks} onChange={e => setEditTrunks(e.target.value)} className="w-8 h-8 rounded cursor-pointer" data-testid="color-edit-trunks" />
                <span className="text-xs text-muted-foreground">{editTrunks}</span>
              </div>
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Shoes</label>
              <div className="flex items-center gap-2">
                <input type="color" value={editShoes} onChange={e => setEditShoes(e.target.value)} className="w-8 h-8 rounded cursor-pointer" data-testid="color-edit-shoes" />
                <span className="text-xs text-muted-foreground">{editShoes}</span>
              </div>
            </div>
          </div>
        </Card>

        <Button onClick={applyEdit} className="w-full gap-2" data-testid="button-apply-edit">
          <Check className="w-4 h-4" /> Apply Changes
        </Button>

        <Button
          variant="outline"
          onClick={() => setEditingNeuralId(editingId)}
          className="w-full gap-2"
          data-testid="button-edit-fighter-neural"
        >
          <BarChart3 className="w-4 h-4" /> Edit Neural Network
          {fighterHasNeural(editingId) && <span className="text-[10px] text-primary ml-1">custom</span>}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-3 p-4 max-w-xl mx-auto">
      <div className="flex items-center gap-3 w-full">
        <Button variant="ghost" size="icon" onClick={onBack} data-testid="button-back-roster-edit">
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <h2 className="text-xl font-bold flex-1">Edit Roster</h2>
        <Button variant="outline" size="sm" onClick={downloadRoster} className="gap-1 text-xs" data-testid="button-download-roster" title="Download Roster">
          <Download className="w-3 h-3" /> Export
        </Button>
        <Button variant="outline" size="sm" onClick={() => rosterFileRef.current?.click()} className="gap-1 text-xs" data-testid="button-import-roster" title="Import Roster">
          <Upload className="w-3 h-3" /> Import
        </Button>
        <input
          ref={rosterFileRef}
          type="file"
          accept=".json"
          className="hidden"
          onChange={handleRosterFileSelect}
        />
        <Button variant="outline" size="sm" onClick={() => setShowNeural(true)} className="gap-1 text-xs" data-testid="button-neural-tab">
          Neural Net
        </Button>
        <Button onClick={handleSave} size="sm" className="gap-1" data-testid="button-save-roster">
          <Save className="w-4 h-4" /> Save
        </Button>
      </div>

      <Input
        placeholder="Search fighters..."
        value={search}
        onChange={e => setSearch(e.target.value)}
        className="w-full"
        data-testid="input-roster-search"
      />

      {importError && (
        <p className="text-destructive text-sm text-center w-full" data-testid="text-roster-import-error">{importError}</p>
      )}

      <div className="space-y-1 w-full max-h-[65vh] overflow-y-auto">
        {filtered.map(f => {
          const entry = getRosterEntryById(f.id);
          if (!entry) return null;
          const name = getRosterDisplayName(entry, f);
          const fc = getRosterFighterColors(f);
          const fighterColors: FighterColors = {
            gloves: fc.gloves,
            gloveTape: fc.gloveTape,
            trunks: fc.trunks,
            shoes: fc.shoes,
            skin: fc.skin,
          };
          return (
            <Card
              key={f.id}
              className="p-2 px-3 cursor-pointer hover:bg-muted/50 transition-colors"
              onClick={() => startEdit(f)}
              data-testid={`card-roster-fighter-${f.id}`}
            >
              <div className="flex items-center gap-3">
                <span className="text-xs font-bold text-muted-foreground w-8">#{f.rank}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm truncate">{name}</p>
                  <p className="text-[10px] text-muted-foreground">
                    {entry.archetype} &bull; {f.wins}W-{f.losses}L-{f.draws}D &bull; LV {f.level}
                  </p>
                </div>
                {(f.customFirstName || f.customNickname || f.customLastName || f.customSkinColor || f.customGloves || f.customTrunks || f.customShoes) && (
                  <span className="text-[10px] text-primary">edited</span>
                )}
                <div className="w-12 h-16 shrink-0">
                  <FighterStanceCanvas colors={fighterColors} width={120} height={144} />
                </div>
                <Pencil className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
              </div>
            </Card>
          );
        })}
        {filtered.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-4">No fighters found.</p>
        )}
      </div>
    </div>
  );
}

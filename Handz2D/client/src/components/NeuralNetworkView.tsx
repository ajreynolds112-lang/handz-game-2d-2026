import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ArrowLeft, RotateCcw, Save, Lock, Download, Upload, Trash2, Star } from "lucide-react";
import { useState, useEffect, useRef, useCallback } from "react";

const ADMIN_PIN = "7342";
const LS_KEY = "handz_neural_state";
const LS_PRESETS_KEY = "handz_neural_presets";
const LS_DEFAULTS_KEY = "handz_neural_defaults";
const LS_FIGHTER_NEURAL_KEY = "handz_fighter_neural";
const PIN_STORAGE_KEY = "handz_career_pins";

type Difficulty = "journeyman" | "contender" | "elite" | "champion";

interface NeuralParam {
  id: string;
  label: string;
  category: string;
}

const NEURAL_PARAMS: NeuralParam[] = [
  { id: "aggression", label: "Aggression", category: "Personality" },
  { id: "guardParanoia", label: "Guard Paranoia", category: "Personality" },
  { id: "feintiness", label: "Feintiness", category: "Personality" },
  { id: "cleanHitsVsVolume", label: "Precision vs Volume", category: "Personality" },
  { id: "stateThinkSpeed", label: "State Think Speed", category: "Reaction" },
  { id: "moveThinkSpeed", label: "Move Think Speed", category: "Reaction" },
  { id: "attackInterval", label: "Attack Frequency", category: "Reaction" },
  { id: "perfectReactChance", label: "Perfect React", category: "Defense" },
  { id: "defenseCycleSpeed", label: "Defense Cycling", category: "Defense" },
  { id: "headCondThreshold", label: "Head Conditioning", category: "Defense" },
  { id: "bodyCondThreshold", label: "Body Conditioning", category: "Defense" },
  { id: "rhythmCutCommit", label: "Rhythm Cut Commit", category: "Offense" },
  { id: "rhythmCutAggression", label: "Rhythm Cut Aggression", category: "Offense" },
  { id: "chargedPunchChance", label: "Charge Punch Chance", category: "Offense" },
  { id: "comboCommitChance", label: "Combo Commitment", category: "Offense" },
  { id: "ringCutoff", label: "Ring Cutoff", category: "Movement" },
  { id: "ropeEscapeAwareness", label: "Rope Escape", category: "Movement" },
  { id: "lateralStrength", label: "Lateral Strength", category: "Movement" },
  { id: "kdRecovery1", label: "KD1 Recovery", category: "Resilience" },
  { id: "kdRecovery2", label: "KD2 Recovery", category: "Resilience" },
  { id: "kdRecovery3", label: "KD3 Recovery", category: "Resilience" },
  { id: "survivalInstinct", label: "Survival Instinct", category: "Resilience" },
];

type NeuralState = Record<string, number>;

const DEFAULT_STATES: Record<Difficulty, NeuralState> = {
  journeyman: {
    aggression: 0.33, guardParanoia: 0.25, feintiness: 0.10, cleanHitsVsVolume: 0.20,
    stateThinkSpeed: 0.15, moveThinkSpeed: 0.15, attackInterval: 0.20,
    perfectReactChance: 0.35, defenseCycleSpeed: 0.25, headCondThreshold: 0.80, bodyCondThreshold: 0.90,
    rhythmCutCommit: 0.10, rhythmCutAggression: 0.10, chargedPunchChance: 0.21, comboCommitChance: 0.25,
    ringCutoff: 0.10, ropeEscapeAwareness: 0.20, lateralStrength: 0.20,
    kdRecovery1: 0.80, kdRecovery2: 0.50, kdRecovery3: 0.20, survivalInstinct: 0.20,
  },
  contender: {
    aggression: 0.59, guardParanoia: 0.35, feintiness: 0.20, cleanHitsVsVolume: 0.38,
    stateThinkSpeed: 0.40, moveThinkSpeed: 0.40, attackInterval: 0.38,
    perfectReactChance: 0.58, defenseCycleSpeed: 0.45, headCondThreshold: 0.55, bodyCondThreshold: 0.65,
    rhythmCutCommit: 0.30, rhythmCutAggression: 0.30, chargedPunchChance: 0.38, comboCommitChance: 0.45,
    ringCutoff: 0.30, ropeEscapeAwareness: 0.40, lateralStrength: 0.35,
    kdRecovery1: 0.90, kdRecovery2: 0.70, kdRecovery3: 0.40, survivalInstinct: 0.40,
  },
  elite: {
    aggression: 0.81, guardParanoia: 0.45, feintiness: 0.29, cleanHitsVsVolume: 0.53,
    stateThinkSpeed: 0.70, moveThinkSpeed: 0.70, attackInterval: 0.62,
    perfectReactChance: 0.86, defenseCycleSpeed: 0.70, headCondThreshold: 0.35, bodyCondThreshold: 0.40,
    rhythmCutCommit: 0.55, rhythmCutAggression: 0.55, chargedPunchChance: 0.60, comboCommitChance: 0.80,
    ringCutoff: 0.60, ropeEscapeAwareness: 0.65, lateralStrength: 0.50,
    kdRecovery1: 0.95, kdRecovery2: 0.85, kdRecovery3: 0.65, survivalInstinct: 0.70,
  },
  champion: {
    aggression: 0.93, guardParanoia: 0.55, feintiness: 0.37, cleanHitsVsVolume: 0.68,
    stateThinkSpeed: 0.95, moveThinkSpeed: 0.95, attackInterval: 0.85,
    perfectReactChance: 0.95, defenseCycleSpeed: 0.90, headCondThreshold: 0.22, bodyCondThreshold: 0.25,
    rhythmCutCommit: 0.83, rhythmCutAggression: 0.80, chargedPunchChance: 0.74, comboCommitChance: 0.95,
    ringCutoff: 0.80, ropeEscapeAwareness: 0.80, lateralStrength: 0.65,
    kdRecovery1: 1.0, kdRecovery2: 1.0, kdRecovery3: 1.0, survivalInstinct: 0.90,
  },
};

const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  journeyman: "Journeyman",
  contender: "Contender",
  elite: "Elite",
  champion: "Champion",
};

const DIFFICULTY_COLORS: Record<Difficulty, string> = {
  journeyman: "#22aa44",
  contender: "#ddaa00",
  elite: "#cc4400",
  champion: "#cc2222",
};

function loadSavedState(): Record<Difficulty, NeuralState> | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

function saveState(states: Record<Difficulty, NeuralState>) {
  localStorage.setItem(LS_KEY, JSON.stringify(states));
}

export function getNeuralOverrides(fighterId?: number): Record<Difficulty, NeuralState> {
  if (fighterId != null) {
    const fighterState = loadFighterNeural(fighterId);
    if (fighterState) return fighterState;
  }
  return loadSavedState() || { ...DEFAULT_STATES };
}

function loadAllFighterNeurals(): Record<number, Record<Difficulty, NeuralState>> {
  try {
    const raw = localStorage.getItem(LS_FIGHTER_NEURAL_KEY);
    if (!raw) return {};
    return JSON.parse(raw);
  } catch { return {}; }
}

function saveAllFighterNeurals(data: Record<number, Record<Difficulty, NeuralState>>) {
  localStorage.setItem(LS_FIGHTER_NEURAL_KEY, JSON.stringify(data));
}

function loadFighterNeural(fighterId: number): Record<Difficulty, NeuralState> | null {
  const all = loadAllFighterNeurals();
  return all[fighterId] || null;
}

function saveFighterNeural(fighterId: number, states: Record<Difficulty, NeuralState>) {
  const all = loadAllFighterNeurals();
  all[fighterId] = states;
  saveAllFighterNeurals(all);
}

function deleteFighterNeural(fighterId: number) {
  const all = loadAllFighterNeurals();
  delete all[fighterId];
  saveAllFighterNeurals(all);
}

export function fighterHasNeural(fighterId: number): boolean {
  return loadFighterNeural(fighterId) !== null;
}

function getCareerPins(): string[] {
  try {
    const raw = localStorage.getItem(PIN_STORAGE_KEY);
    if (!raw) return [];
    const store = JSON.parse(raw);
    return Object.values(store).filter((v): v is string => typeof v === "string" && v.length === 4);
  } catch { return []; }
}

function isValidPin(pin: string): boolean {
  if (pin === ADMIN_PIN) return true;
  const careerPins = getCareerPins();
  return careerPins.includes(pin);
}

interface NeuralPreset {
  name: string;
  states: Record<Difficulty, NeuralState>;
  createdAt: number;
}

function loadPresets(): NeuralPreset[] {
  try {
    const raw = localStorage.getItem(LS_PRESETS_KEY);
    if (!raw) return [];
    return JSON.parse(raw);
  } catch { return []; }
}

function savePresets(presets: NeuralPreset[]) {
  localStorage.setItem(LS_PRESETS_KEY, JSON.stringify(presets));
}

function loadCustomDefaults(): Record<Difficulty, NeuralState> | null {
  try {
    const raw = localStorage.getItem(LS_DEFAULTS_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

function saveCustomDefaults(defaults: Record<Difficulty, NeuralState>) {
  localStorage.setItem(LS_DEFAULTS_KEY, JSON.stringify(defaults));
}

function getEffectiveDefaults(): Record<Difficulty, NeuralState> {
  const custom = loadCustomDefaults();
  if (!custom) return JSON.parse(JSON.stringify(DEFAULT_STATES));
  return {
    journeyman: custom.journeyman || DEFAULT_STATES.journeyman,
    contender: custom.contender || DEFAULT_STATES.contender,
    elite: custom.elite || DEFAULT_STATES.elite,
    champion: custom.champion || DEFAULT_STATES.champion,
  };
}

const CATEGORIES = ["Personality", "Reaction", "Defense", "Offense", "Movement", "Resilience"];
const CAT_COLORS: Record<string, string> = {
  Personality: "#ff6b6b",
  Reaction: "#ffd93d",
  Defense: "#6bcb77",
  Offense: "#4d96ff",
  Movement: "#9b59b6",
  Resilience: "#e67e22",
};

interface NeuralNetworkViewProps {
  onBack: () => void;
  fighterId?: number;
  fighterName?: string;
}

export default function NeuralNetworkView({ onBack, fighterId, fighterName }: NeuralNetworkViewProps) {
  const isFighterMode = fighterId != null;
  const [unlocked, setUnlocked] = useState(isFighterMode);
  const [pinInput, setPinInput] = useState("");
  const [pinError, setPinError] = useState(false);
  const [activeDiff, setActiveDiff] = useState<Difficulty>("champion");
  const [states, setStates] = useState<Record<Difficulty, NeuralState>>(() => {
    if (isFighterMode) {
      const fighterState = loadFighterNeural(fighterId);
      if (fighterState) return JSON.parse(JSON.stringify(fighterState));
      const globalState = loadSavedState();
      return globalState || JSON.parse(JSON.stringify(DEFAULT_STATES));
    }
    const saved = loadSavedState();
    return saved || JSON.parse(JSON.stringify(DEFAULT_STATES));
  });
  const [hasPersonalNetwork, setHasPersonalNetwork] = useState(() => isFighterMode && loadFighterNeural(fighterId!) !== null);
  const [saved, setSaved] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const nodePositionsRef = useRef<Map<string, { x: number; y: number; param: NeuralParam }>>(new Map());
  const containerRef = useRef<HTMLDivElement>(null);
  const [presets, setPresets] = useState<NeuralPreset[]>(() => loadPresets());
  const [showSavePreset, setShowSavePreset] = useState(false);
  const [showLoadPreset, setShowLoadPreset] = useState(false);
  const [presetName, setPresetName] = useState("");
  const [defaultSet, setDefaultSet] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const [showResetAllConfirm, setShowResetAllConfirm] = useState(false);

  const tryUnlock = () => {
    if (isValidPin(pinInput)) {
      setUnlocked(true);
      setPinError(false);
    } else {
      setPinError(true);
      setPinInput("");
    }
  };

  const currentState = states[activeDiff];

  const lastCanvasSize = useRef<{ w: number; h: number }>({ w: 0, h: 0 });

  const drawWeb = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (lastCanvasSize.current.w !== w || lastCanvasSize.current.h !== h) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      lastCanvasSize.current = { w, h };
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = "#0a0a0f";
    ctx.fillRect(0, 0, w, h);

    const cx = w / 2;
    const cy = h / 2;
    const maxR = Math.min(w, h) * 0.38;

    const n = NEURAL_PARAMS.length;
    const angleStep = (Math.PI * 2) / n;

    for (let ring = 1; ring <= 5; ring++) {
      const r = (ring / 5) * maxR;
      ctx.strokeStyle = `rgba(100, 120, 180, ${0.08 + ring * 0.03})`;
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
      ctx.strokeStyle = "rgba(100, 120, 180, 0.12)";
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }

    const diffColor = DIFFICULTY_COLORS[activeDiff];

    ctx.fillStyle = diffColor + "10";
    ctx.strokeStyle = diffColor + "90";
    ctx.lineWidth = 2;
    ctx.beginPath();
    const nodePositions = new Map<string, { x: number; y: number; param: NeuralParam }>();

    for (let i = 0; i < n; i++) {
      const param = NEURAL_PARAMS[i];
      const val = currentState[param.id] ?? 0.5;
      const angle = i * angleStep - Math.PI / 2;
      const r = val * maxR;
      const x = cx + Math.cos(angle) * r;
      const y = cy + Math.sin(angle) * r;
      nodePositions.set(param.id, { x, y, param });
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    const innerConnections: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      for (let j = i + 2; j < n; j++) {
        if (j - i === n - 1) continue;
        const pi = NEURAL_PARAMS[i];
        const pj = NEURAL_PARAMS[j];
        if (pi.category === pj.category) {
          innerConnections.push([i, j]);
        }
      }
    }
    for (const [i, j] of innerConnections) {
      const pi = NEURAL_PARAMS[i];
      const pj = NEURAL_PARAMS[j];
      const posI = nodePositions.get(pi.id)!;
      const posJ = nodePositions.get(pj.id)!;
      const catColor = CAT_COLORS[pi.category] || "#888";
      ctx.strokeStyle = catColor + "25";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(posI.x, posI.y);
      ctx.lineTo(posJ.x, posJ.y);
      ctx.stroke();
    }

    for (let i = 0; i < n; i++) {
      const param = NEURAL_PARAMS[i];
      const pos = nodePositions.get(param.id)!;
      const catColor = CAT_COLORS[param.category] || "#888";
      const isHovered = hoveredNode === param.id;
      const isDragged = dragging === param.id;
      const nodeR = isHovered || isDragged ? 7 : 5;

      if (isHovered || isDragged) {
        ctx.fillStyle = catColor + "30";
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, 14, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.fillStyle = catColor;
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = isHovered || isDragged ? 2 : 1;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, nodeR, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      const angle = i * angleStep - Math.PI / 2;
      const labelR = maxR + 18;
      const lx = cx + Math.cos(angle) * labelR;
      const ly = cy + Math.sin(angle) * labelR;

      ctx.fillStyle = isHovered || isDragged ? "#ffffff" : "#8890aa";
      ctx.font = `${isHovered || isDragged ? "bold " : ""}10px sans-serif`;
      ctx.textAlign = Math.cos(angle) > 0.1 ? "left" : Math.cos(angle) < -0.1 ? "right" : "center";
      ctx.textBaseline = Math.sin(angle) > 0.1 ? "top" : Math.sin(angle) < -0.1 ? "bottom" : "middle";
      ctx.fillText(param.label, lx, ly);

      if (isHovered || isDragged) {
        const val = currentState[param.id] ?? 0.5;
        ctx.fillStyle = "#fff";
        ctx.font = "bold 11px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        ctx.fillText(`${Math.round(val * 100)}%`, pos.x, pos.y - 12);
      }
    }

    nodePositionsRef.current = nodePositions;

    ctx.fillStyle = "#8890aa";
    ctx.font = "9px sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    let legendY = 10;
    for (const cat of CATEGORIES) {
      ctx.fillStyle = CAT_COLORS[cat];
      ctx.fillRect(8, legendY, 8, 8);
      ctx.fillStyle = "#8890aa";
      ctx.fillText(cat, 20, legendY);
      legendY += 14;
    }
  }, [currentState, activeDiff, hoveredNode, dragging]);

  useEffect(() => {
    if (!unlocked) return;
    drawWeb();
  }, [drawWeb, unlocked]);

  const getNodeAtPos = (mx: number, my: number): string | null => {
    for (const [id, pos] of nodePositionsRef.current) {
      const dx = mx - pos.x;
      const dy = my - pos.y;
      if (dx * dx + dy * dy < 200) return id;
    }
    return null;
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    if (dragging) {
      const cx = canvas.clientWidth / 2;
      const cy = canvas.clientHeight / 2;
      const maxR = Math.min(canvas.clientWidth, canvas.clientHeight) * 0.38;
      const idx = NEURAL_PARAMS.findIndex(p => p.id === dragging);
      if (idx < 0) return;
      const angleStep = (Math.PI * 2) / NEURAL_PARAMS.length;
      const angle = idx * angleStep - Math.PI / 2;
      const dx = mx - cx;
      const dy = my - cy;
      const projection = dx * Math.cos(angle) + dy * Math.sin(angle);
      const newVal = Math.min(1, Math.max(0.02, projection / maxR));

      setStates(prev => ({
        ...prev,
        [activeDiff]: { ...prev[activeDiff], [dragging]: Math.round(newVal * 100) / 100 },
      }));
      setSaved(false);
    } else {
      const node = getNodeAtPos(mx, my);
      setHoveredNode(node);
      canvas.style.cursor = node ? "grab" : "default";
    }
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const node = getNodeAtPos(mx, my);
    if (node) {
      setDragging(node);
      canvas.style.cursor = "grabbing";
    }
  };

  const handleMouseUp = () => {
    setDragging(null);
    if (canvasRef.current) {
      canvasRef.current.style.cursor = hoveredNode ? "grab" : "default";
    }
  };

  const handleMouseLeave = () => {
    setDragging(null);
    setHoveredNode(null);
  };

  const resetDifficulty = () => {
    if (isFighterMode) {
      const globalState = loadSavedState() || JSON.parse(JSON.stringify(DEFAULT_STATES));
      setStates(prev => ({
        ...prev,
        [activeDiff]: { ...globalState[activeDiff] },
      }));
    } else {
      const defaults = getEffectiveDefaults();
      setStates(prev => ({
        ...prev,
        [activeDiff]: { ...defaults[activeDiff] },
      }));
    }
    setSaved(false);
  };

  const saveNeuralState = () => {
    if (isFighterMode) {
      saveFighterNeural(fighterId!, states);
      setHasPersonalNetwork(true);
    } else {
      saveState(states);
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const deletePersonalNetwork = () => {
    if (!isFighterMode) return;
    deleteFighterNeural(fighterId!);
    setHasPersonalNetwork(false);
    const globalState = loadSavedState() || JSON.parse(JSON.stringify(DEFAULT_STATES));
    setStates(JSON.parse(JSON.stringify(globalState)));
    setDeleted(true);
    setTimeout(() => setDeleted(false), 2000);
  };

  const resetAllNetworks = () => {
    localStorage.removeItem(LS_KEY);
    localStorage.removeItem(LS_DEFAULTS_KEY);
    localStorage.removeItem(LS_FIGHTER_NEURAL_KEY);
    const freshStates = JSON.parse(JSON.stringify(DEFAULT_STATES));
    setStates(freshStates);
    setHasPersonalNetwork(false);
    setShowResetAllConfirm(false);
    setSaved(false);
    setDeleted(false);
  };

  const setAsDefault = () => {
    if (isFighterMode) return;
    const current = loadCustomDefaults() || JSON.parse(JSON.stringify(DEFAULT_STATES));
    current[activeDiff] = { ...states[activeDiff] };
    saveCustomDefaults(current);
    setDefaultSet(true);
    setTimeout(() => setDefaultSet(false), 2000);
  };

  const saveAllAsPreset = () => {
    if (!presetName.trim()) return;
    const preset: NeuralPreset = {
      name: presetName.trim(),
      states: JSON.parse(JSON.stringify(states)),
      createdAt: Date.now(),
    };
    const updated = [...presets, preset];
    setPresets(updated);
    savePresets(updated);
    setPresetName("");
    setShowSavePreset(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const loadPresetByIndex = (idx: number) => {
    const preset = presets[idx];
    if (!preset) return;
    setStates(JSON.parse(JSON.stringify(preset.states)));
    if (isFighterMode) {
      saveFighterNeural(fighterId!, preset.states);
      setHasPersonalNetwork(true);
    } else {
      saveState(preset.states);
    }
    setShowLoadPreset(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const deletePresetByIndex = (idx: number) => {
    const updated = presets.filter((_, i) => i !== idx);
    setPresets(updated);
    savePresets(updated);
  };

  if (!unlocked) {
    return (
      <div className="flex flex-col items-center gap-4 p-4 max-w-lg mx-auto">
        <div className="flex items-center gap-3 w-full">
          <Button variant="ghost" size="icon" onClick={onBack} data-testid="button-back-neural">
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <h2 className="text-xl font-bold flex-1">Neural Network</h2>
        </div>
        <Card className="p-8 w-full text-center space-y-4">
          <Lock className="w-12 h-12 mx-auto text-muted-foreground" />
          <h3 className="text-lg font-bold">Admin Access Required</h3>
          <p className="text-sm text-muted-foreground">Enter your admin or career PIN to access neural network parameters.</p>
          <div className="flex gap-2 justify-center items-center">
            <Input
              type="password"
              maxLength={4}
              value={pinInput}
              onChange={e => {
                setPinInput(e.target.value.replace(/\D/g, ""));
                setPinError(false);
              }}
              onKeyDown={e => { if (e.key === "Enter") tryUnlock(); }}
              placeholder="PIN"
              className="w-24 text-center tracking-widest"
              data-testid="input-neural-pin"
            />
            <Button onClick={tryUnlock} data-testid="button-neural-unlock">Unlock</Button>
          </div>
          {pinError && <p className="text-xs text-destructive">Incorrect PIN</p>}
        </Card>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex flex-col items-center gap-3 p-4 max-w-2xl mx-auto">
      <div className="flex items-center gap-3 w-full">
        <Button variant="ghost" size="icon" onClick={onBack} data-testid="button-back-neural">
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <div className="flex-1">
          <h2 className="text-xl font-bold">{isFighterMode ? `${fighterName || "Fighter"} Neural Net` : "Neural Network"}</h2>
          {isFighterMode && (
            <p className="text-xs text-muted-foreground">
              {hasPersonalNetwork ? "Personal network active" : "Using global network (no personal override)"}
            </p>
          )}
        </div>
      </div>

      <Card className="p-3 w-full" style={{ background: "#0a0a0f" }}>
        <canvas
          ref={canvasRef}
          className="w-full"
          style={{ height: "420px", cursor: "default" }}
          onMouseMove={handleMouseMove}
          onMouseDown={handleMouseDown}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseLeave}
          data-testid="canvas-neural-web"
        />
      </Card>

      <div className="flex gap-2 w-full">
        {(["journeyman", "contender", "elite", "champion"] as Difficulty[]).map(diff => (
          <Button
            key={diff}
            variant={activeDiff === diff ? "default" : "outline"}
            className="flex-1 text-xs"
            style={activeDiff === diff ? { backgroundColor: DIFFICULTY_COLORS[diff], color: "#fff", borderColor: DIFFICULTY_COLORS[diff] } : { borderColor: DIFFICULTY_COLORS[diff], color: DIFFICULTY_COLORS[diff] }}
            onClick={() => setActiveDiff(diff)}
            data-testid={`button-diff-${diff}`}
          >
            {DIFFICULTY_LABELS[diff]}
          </Button>
        ))}
      </div>

      <div className="flex gap-2 w-full">
        <Button variant="outline" onClick={resetDifficulty} className="flex-1 gap-2" data-testid="button-reset-neural">
          <RotateCcw className="w-4 h-4" /> Reset {DIFFICULTY_LABELS[activeDiff]}
        </Button>
        {!isFighterMode && (
          <Button onClick={setAsDefault} className="flex-1 gap-2" variant="outline" data-testid="button-set-default-neural">
            <Star className="w-4 h-4" /> {defaultSet ? "Default Set!" : `Set ${DIFFICULTY_LABELS[activeDiff]} Default`}
          </Button>
        )}
        {isFighterMode && hasPersonalNetwork && (
          <Button variant="destructive" onClick={deletePersonalNetwork} className="flex-1 gap-2" data-testid="button-delete-fighter-neural">
            <Trash2 className="w-4 h-4" /> {deleted ? "Reset to Global!" : "Delete Personal Network"}
          </Button>
        )}
      </div>

      <div className="flex gap-2 w-full">
        <Button onClick={saveNeuralState} className="flex-1 gap-2" data-testid="button-save-neural">
          <Save className="w-4 h-4" /> {saved ? "Saved!" : isFighterMode ? "Save Personal Network" : "Save Active State"}
        </Button>
      </div>

      <div className="flex gap-2 w-full">
        <Button variant="outline" onClick={() => { setShowSavePreset(!showSavePreset); setShowLoadPreset(false); }} className="flex-1 gap-2" data-testid="button-save-all-networks">
          <Download className="w-4 h-4" /> Save All Networks
        </Button>
        <Button variant="outline" onClick={() => { setShowLoadPreset(!showLoadPreset); setShowSavePreset(false); }} className="flex-1 gap-2" data-testid="button-load-networks">
          <Upload className="w-4 h-4" /> Load Networks
        </Button>
      </div>

      <div className="flex gap-2 w-full">
        {!showResetAllConfirm ? (
          <Button variant="outline" onClick={() => setShowResetAllConfirm(true)} className="flex-1 gap-2 text-destructive border-destructive/30 hover:bg-destructive/10" data-testid="button-reset-all-networks">
            <Trash2 className="w-4 h-4" /> Reset All Networks
          </Button>
        ) : (
          <Card className="p-3 w-full space-y-2">
            <p className="text-sm font-semibold text-destructive">Reset all neural networks?</p>
            <p className="text-xs text-muted-foreground">This will delete the global network, all custom defaults, and all per-fighter networks. Presets will not be deleted.</p>
            <div className="flex gap-2">
              <Button variant="destructive" onClick={resetAllNetworks} className="flex-1" data-testid="button-confirm-reset-all">
                Yes, Reset Everything
              </Button>
              <Button variant="outline" onClick={() => setShowResetAllConfirm(false)} className="flex-1" data-testid="button-cancel-reset-all">
                Cancel
              </Button>
            </div>
          </Card>
        )}
      </div>

      {showSavePreset && (
        <Card className="p-3 w-full space-y-2">
          <p className="text-sm font-semibold">Save All Networks as Preset</p>
          <div className="flex gap-2">
            <Input
              value={presetName}
              onChange={e => setPresetName(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") saveAllAsPreset(); }}
              placeholder="Preset name..."
              className="flex-1"
              data-testid="input-preset-name"
            />
            <Button onClick={saveAllAsPreset} disabled={!presetName.trim()} data-testid="button-confirm-save-preset">
              Save
            </Button>
          </div>
        </Card>
      )}

      {showLoadPreset && (
        <Card className="p-3 w-full space-y-2">
          <p className="text-sm font-semibold">Load Network Preset</p>
          {presets.length === 0 ? (
            <p className="text-xs text-muted-foreground">No saved presets yet.</p>
          ) : (
            <div className="space-y-1 max-h-48 overflow-y-auto">
              {presets.map((p, i) => (
                <div key={i} className="flex items-center gap-2 p-2 rounded hover:bg-muted/50" data-testid={`preset-item-${i}`}>
                  <button
                    className="flex-1 text-left text-sm font-medium hover:underline cursor-pointer"
                    onClick={() => loadPresetByIndex(i)}
                    data-testid={`button-load-preset-${i}`}
                  >
                    {p.name}
                  </button>
                  <span className="text-xs text-muted-foreground">
                    {new Date(p.createdAt).toLocaleDateString()}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => deletePresetByIndex(i)}
                    data-testid={`button-delete-preset-${i}`}
                  >
                    <Trash2 className="w-3 h-3" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      <Card className="p-2 w-full" style={{ minHeight: 36, visibility: hoveredNode ? "visible" : "hidden" }}>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full" style={{ backgroundColor: hoveredNode ? CAT_COLORS[NEURAL_PARAMS.find(p => p.id === hoveredNode)?.category || ""] : "transparent" }} />
          <span className="text-sm font-semibold">{hoveredNode ? NEURAL_PARAMS.find(p => p.id === hoveredNode)?.label : "\u00A0"}</span>
          <span className="text-xs text-muted-foreground ml-auto">{hoveredNode ? NEURAL_PARAMS.find(p => p.id === hoveredNode)?.category : ""}</span>
          <span className="text-sm font-bold">{hoveredNode ? `${Math.round((currentState[hoveredNode] ?? 0.5) * 100)}%` : ""}</span>
        </div>
      </Card>
    </div>
  );
}

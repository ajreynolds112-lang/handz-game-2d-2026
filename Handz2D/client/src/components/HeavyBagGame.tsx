import { useState, useEffect, useRef, useCallback } from "react";
import type { Fighter, GearColors } from "@shared/schema";
import { DEFAULT_GEAR_COLORS } from "@shared/schema";
import { soundEngine } from "@/game/sound";

interface HeavyBagGameProps {
  fighter: Fighter;
  onComplete: (xpGained: number, combos: number) => void;
  onQuit: () => void;
}

const TOTAL_TIME = 60;
const PUNCH_KEYS = ["Q", "W", "E", "R", "S", "D"];
const XP_PER_COMBO = 2.04;

type PunchType = "jab" | "cross" | "leftHook" | "rightHook" | "leftUppercut" | "rightUppercut";

const KEY_TO_PUNCH: Record<string, PunchType> = {
  Q: "leftHook",
  W: "jab",
  E: "cross",
  R: "rightHook",
  S: "leftUppercut",
  D: "rightUppercut",
};

const PUNCH_IS_LEFT: Record<PunchType, boolean> = {
  jab: true, cross: false, leftHook: true, rightHook: false, leftUppercut: true, rightUppercut: false,
};

function generateCombo(minLen: number, maxLen: number): string[] {
  const weights = [2, 2, 2, 2, 2, 3, 3, 3, 4, 5, 5, 5, 5];
  const len = weights[Math.floor(Math.random() * weights.length)];
  const clamped = Math.max(minLen, Math.min(maxLen, len));
  const combo: string[] = [];
  for (let i = 0; i < clamped; i++) {
    combo.push(PUNCH_KEYS[Math.floor(Math.random() * PUNCH_KEYS.length)]);
  }
  return combo;
}

const FS = 2.08;
const BODY_H = 28 * FS;
const HEAD_R = 7 * FS;
const UPPER_ARM_L = 14 * FS;
const FOREARM_L = 12 * FS;
const UPPER_LEG_L = 14 * FS;
const LOWER_LEG_L = 12 * FS;
const GLOVE_R = 5 * FS;
const SHOE_H = 4 * FS;
const TORSO_W = 14 * FS;

function shadeColor(color: string, percent: number): string {
  const num = parseInt(color.replace("#", ""), 16);
  if (isNaN(num)) return color;
  const r = Math.min(255, Math.max(0, (num >> 16) + percent));
  const g = Math.min(255, Math.max(0, ((num >> 8) & 0x00ff) + percent));
  const b = Math.min(255, Math.max(0, (num & 0x0000ff) + percent));
  return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}

interface PunchState {
  type: PunchType;
  progress: number;
}

function drawFightFighter(
  ctx: CanvasRenderingContext2D,
  sx: number, baseY: number,
  skinColor: string, gc: GearColors,
  bobPhase: number,
  punch: PunchState | null,
  bagCX: number, bagCY: number,
) {
  const punchDirX = 1;
  const punchDirY = 0;
  const sideView = 1.0;
  const frontView = 0;
  const bodyWidthMult = Math.abs(sideView) * 0.35 + Math.abs(frontView) * 1.0;

  ctx.fillStyle = "rgba(0,0,0,0.25)";
  ctx.beginPath();
  ctx.ellipse(sx, baseY + 2, 18 * FS * 0.6 * bodyWidthMult, 8 * FS * 0.4, 0, 0, Math.PI * 2);
  ctx.fill();

  const bob = Math.sin(bobPhase) * 1.5 * FS;
  const hipY = baseY - LOWER_LEG_L - UPPER_LEG_L + bob;
  const depthShift = frontView * 3;

  const bodyHeight = BODY_H;
  const shoulderY = hipY - bodyHeight;
  const headY = shoulderY - HEAD_R * 0.8;
  const bodyX = sx + depthShift;

  const tW = TORSO_W * 0.5 * bodyWidthMult;
  const shoulderW = tW * 0.9;
  const hipW = tW;

  const dp = 0;
  const spreadAngleDeg = 30 + dp * 18;
  const spreadAngleRad = (spreadAngleDeg * Math.PI) / 180;
  const upperLegDx = Math.sin(spreadAngleRad) * UPPER_LEG_L * bodyWidthMult;
  const upperLegDy = Math.cos(spreadAngleRad) * UPPER_LEG_L;

  const rhythmBob = Math.sin(bobPhase) * 2.5 * FS;

  for (let side = -1; side <= 1; side += 2) {
    const isFrontLeg = (punchDirX > 0 && side === 1) || (punchDirX <= 0 && side === -1);
    const hipX = sx + side * upperLegDx * 0.5;

    const perspShift = isFrontLeg ? frontView * 2 * FS : -frontView * 2 * FS;
    const fwdShift = punchDirX * UPPER_LEG_L * 0.15;

    const kneeX = hipX + side * upperLegDx * 0.5 + fwdShift + perspShift;
    const kneeY = hipY + upperLegDy;

    const kneeBendFwd = isFrontLeg
      ? punchDirX * 2 * FS + rhythmBob * 0.2
      : -punchDirX * 6 * FS + rhythmBob * 0.4;

    const footX = kneeX + kneeBendFwd;
    const footY = baseY + bob + Math.abs(rhythmBob) * 0.3;

    const legScale = isFrontLeg ? 1.05 : 0.95;
    const lineW = 5 * FS * legScale;

    ctx.strokeStyle = skinColor;
    ctx.lineWidth = lineW;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(hipX, hipY);
    ctx.lineTo(kneeX, kneeY);
    ctx.stroke();

    const trunkEndX = hipX + (kneeX - hipX) * 0.95;
    const trunkEndY = hipY + (kneeY - hipY) * 0.95;
    ctx.strokeStyle = gc.trunks;
    ctx.lineWidth = lineW + 2 * FS;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(hipX, hipY);
    ctx.lineTo(trunkEndX, trunkEndY);
    ctx.stroke();

    const trunkBandW = 1.5 * FS;
    ctx.strokeStyle = shadeColor(gc.trunks, 30);
    ctx.lineWidth = trunkBandW;
    ctx.beginPath();
    ctx.moveTo(trunkEndX - (lineW + 2 * FS) * 0.4, trunkEndY);
    ctx.lineTo(trunkEndX + (lineW + 2 * FS) * 0.4, trunkEndY);
    ctx.stroke();

    ctx.strokeStyle = skinColor;
    ctx.lineWidth = lineW;
    ctx.beginPath();
    ctx.moveTo(kneeX, kneeY);
    ctx.lineTo(footX, footY);
    ctx.stroke();

    const kneeSize = 3 * FS * legScale;
    ctx.fillStyle = skinColor;
    ctx.beginPath();
    ctx.arc(kneeX, kneeY, kneeSize, 0, Math.PI * 2);
    ctx.fill();

    const shoeW = 7 * FS * legScale;
    const shoeHt = 3 * FS * legScale;
    ctx.fillStyle = gc.shoes;
    ctx.save();
    ctx.translate(footX, footY);
    ctx.beginPath();
    ctx.rect(-shoeW * 0.3, -shoeHt * 0.5, shoeW, shoeHt);
    ctx.fill();
    ctx.restore();
  }

  ctx.fillStyle = skinColor;
  ctx.beginPath();
  ctx.moveTo(bodyX - shoulderW, shoulderY);
  ctx.lineTo(bodyX + shoulderW, shoulderY);
  ctx.lineTo(sx + hipW, hipY);
  ctx.lineTo(sx - hipW, hipY);
  ctx.closePath();
  ctx.fill();

  const trunkTopFrac = 0.35;
  const trunkTopX = sx + (bodyX - sx) * (1 - trunkTopFrac);
  const trunkTop = hipY - bodyHeight * trunkTopFrac;
  ctx.fillStyle = gc.trunks;
  ctx.beginPath();
  ctx.moveTo(trunkTopX - shoulderW * 0.95, trunkTop);
  ctx.lineTo(trunkTopX + shoulderW * 0.95, trunkTop);
  ctx.lineTo(sx + hipW, hipY);
  ctx.lineTo(sx - hipW, hipY);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = shadeColor(gc.trunks, 30);
  ctx.fillRect(trunkTopX - shoulderW * 0.95, trunkTop, shoulderW * 1.9, 3 * FS);

  const fwdOff = punchDirX * 5 * FS;
  const headShift = frontView * 2 + fwdOff;
  ctx.fillStyle = skinColor;
  ctx.beginPath();
  ctx.arc(bodyX + headShift, headY, HEAD_R, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#1a1a1a";
  const eyeSpread = 2.5 * FS * bodyWidthMult;
  const eyeOff = frontView * HEAD_R * 0.3;
  const eyeX1 = bodyX + headShift + eyeOff - eyeSpread;
  const eyeX2 = bodyX + headShift + eyeOff + eyeSpread;
  const eyeYPos = headY - HEAD_R * 0.15;
  ctx.beginPath(); ctx.arc(eyeX1, eyeYPos, 1.2 * FS, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(eyeX2, eyeYPos, 1.2 * FS, 0, Math.PI * 2); ctx.fill();

  const shoulderSpread = 8 * FS * bodyWidthMult;
  const fullArmReach = (UPPER_ARM_L + FOREARM_L) * 2.0;
  const fwdOffX = punchDirX * 4 * FS;
  const fwdOffY = punchDirY * 2 * FS;

  for (let side = -1; side <= 1; side += 2) {
    const isLeft = side === -1;
    const shoulderX = bodyX + side * shoulderSpread * 0.5;
    const sY = shoulderY + 3 * FS;

    let elbowX: number, elbowY: number;
    let gloveX: number, gloveY: number;

    const isPunchingSide = punch && (
      (isLeft && PUNCH_IS_LEFT[punch.type]) ||
      (!isLeft && !PUNCH_IS_LEFT[punch.type])
    );

    if (isPunchingSide && punch) {
      const progress = punch.progress;
      const isHook = punch.type.includes("Hook");
      const isUppercut = punch.type.includes("Uppercut");

      const hookReachMult = 0.8;
      const uppercutReachMult = 0.6;
      const reachMult = isHook ? hookReachMult : isUppercut ? uppercutReachMult : 1.0;
      const toBagDist = Math.max(1, Math.sqrt((bagCX - sx) ** 2 + (bagCY - shoulderY) ** 2));
      const targetReach = Math.min(fullArmReach * reachMult, toBagDist * 0.95);
      const reachAtProgress = targetReach * progress;

      if (isHook) {
        const arcT = Math.sin(progress * Math.PI);
        const upwardArc = -arcT * 12 * FS / 65;
        const perpX = -punchDirY;
        gloveX = shoulderX + punchDirX * reachAtProgress + perpX * arcT * side * 8 * FS / 65;
        gloveY = sY + upwardArc + bob;
        elbowX = shoulderX + (gloveX - shoulderX) * 0.45 + perpX * side * 4 * FS / 65;
        elbowY = sY + (gloveY - sY) * 0.5 + 2 * FS + bob;
      } else if (isUppercut) {
        const arcT = Math.sin(progress * Math.PI);
        const downDip = arcT * (1 - progress) * 10 * FS / 65;
        const upRise = progress * progress * 20 * FS / 65;
        gloveX = shoulderX + punchDirX * reachAtProgress * 0.7;
        gloveY = sY + downDip - upRise + bob;
        elbowX = shoulderX + (gloveX - shoulderX) * 0.5;
        elbowY = sY + (gloveY - sY) * 0.4 + 4 * FS + bob;
      } else {
        gloveX = shoulderX + punchDirX * reachAtProgress;
        gloveY = sY + punchDirY * reachAtProgress * 0.4 - 5 * FS + bob;
        elbowX = shoulderX + punchDirX * reachAtProgress * 0.5;
        elbowY = sY + punchDirY * reachAtProgress * 0.3 + 4 * FS + bob;
      }
    } else {
      const downElbowX = shoulderX + side * 5 * FS * bodyWidthMult + fwdOffX * 0.4;
      const downElbowY = sY + UPPER_ARM_L * 0.7 + bob + fwdOffY * 0.3;
      const downGloveX = shoulderX + side * 2 * bodyWidthMult + fwdOffX;
      const downGloveY = sY + UPPER_ARM_L * 0.3 + bob + fwdOffY;

      const upElbowX = shoulderX + side * 4 * FS * bodyWidthMult + fwdOffX * 0.7;
      const upElbowY = sY + 6 * FS + bob + fwdOffY * 0.5;
      const upGloveX = shoulderX + fwdOffX * 1.8 + side * 2 * FS * bodyWidthMult;
      const guardLift = 2 * FS * 1.05 + 15;
      const upGloveY = sY - guardLift + bob + fwdOffY;

      const gb = 0.7;
      elbowX = downElbowX + (upElbowX - downElbowX) * gb;
      elbowY = downElbowY + (upElbowY - downElbowY) * gb;
      gloveX = downGloveX + (upGloveX - downGloveX) * gb;
      gloveY = downGloveY + (upGloveY - downGloveY) * gb;
    }

    ctx.strokeStyle = skinColor;
    ctx.lineWidth = 4 * FS;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(shoulderX, sY);
    ctx.lineTo(elbowX, elbowY);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(elbowX, elbowY);
    ctx.lineTo(gloveX, gloveY);
    ctx.stroke();

    ctx.fillStyle = skinColor;
    ctx.beginPath();
    ctx.arc(elbowX, elbowY, 2.5 * FS, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = gc.gloves;
    ctx.beginPath();
    ctx.arc(gloveX, gloveY, GLOVE_R, 0, Math.PI * 2);
    ctx.fill();

    if (gc.gloveTape) {
      ctx.strokeStyle = gc.gloveTape;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(gloveX, gloveY, GLOVE_R * 0.7, 0, Math.PI);
      ctx.stroke();
    }
  }
}

export default function HeavyBagGame({ fighter, onComplete, onQuit }: HeavyBagGameProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [countdown, setCountdown] = useState(3);
  const [timeLeft, setTimeLeft] = useState(TOTAL_TIME);
  const [combos, setCombos] = useState(0);
  const [currentCombo, setCurrentCombo] = useState<string[]>(() => generateCombo(2, 5));
  const [comboIndex, setComboIndex] = useState(0);
  const [missFlash, setMissFlash] = useState(0);
  const [hitFlash, setHitFlash] = useState(0);
  const [paused, setPaused] = useState(false);
  const [finished, setFinished] = useState(false);
  const [pauseIndex, setPauseIndex] = useState(0);
  const [bagSwing, setBagSwing] = useState(0);
  const [currentPunch, setCurrentPunch] = useState<PunchState | null>(null);
  const [bobPhase, setBobPhase] = useState(0);
  const animRef = useRef<number>(0);
  const lastTimeRef = useRef<number>(0);
  const countdownRef = useRef(3);
  const stateRef = useRef({ timeLeft: TOTAL_TIME, paused: false, finished: false });
  const comboRef = useRef(currentCombo);
  const comboIndexRef = useRef(0);
  const timeLeftRef = useRef(TOTAL_TIME);
  const clutchRepsRef = useRef(0);

  const gc = (fighter.gearColors as GearColors) || DEFAULT_GEAR_COLORS;
  const skinColor = fighter.skinColor || "#e8c4a0";

  useEffect(() => {
    stateRef.current = { timeLeft, paused, finished };
    timeLeftRef.current = timeLeft;
  }, [timeLeft, paused, finished]);

  useEffect(() => {
    countdownRef.current = countdown;
  }, [countdown]);

  useEffect(() => {
    const tick = (now: number) => {
      if (!lastTimeRef.current) lastTimeRef.current = now;
      const dt = (now - lastTimeRef.current) / 1000;
      lastTimeRef.current = now;

      if (countdownRef.current > 0) {
        setCountdown(prev => {
          const next = prev - dt;
          if (next <= 0) return 0;
          return next;
        });
        animRef.current = requestAnimationFrame(tick);
        return;
      }

      if (!stateRef.current.paused && !stateRef.current.finished) {
        setTimeLeft(prev => {
          const next = prev - dt;
          if (next <= 0) {
            setFinished(true);
            return 0;
          }
          return next;
        });
        setBobPhase(prev => prev + dt * 3.5);
      }

      setMissFlash(prev => Math.max(0, prev - dt * 4));
      setHitFlash(prev => Math.max(0, prev - dt * 4));
      setBagSwing(prev => prev * 0.95);
      setCurrentPunch(prev => {
        if (!prev) return null;
        const next = prev.progress + dt * 5;
        if (next >= 1) return null;
        return { ...prev, progress: next };
      });

      animRef.current = requestAnimationFrame(tick);
    };
    animRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animRef.current);
  }, []);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (countdownRef.current > 0) return;
    if (stateRef.current.finished) return;

    if (e.key === "Escape") {
      e.preventDefault();
      setPaused(p => !p);
      return;
    }

    if (stateRef.current.paused) {
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        setPauseIndex(prev => prev === 0 ? 1 : 0);
      }
      if (e.key === "Enter") {
        e.preventDefault();
        setPauseIndex(prev => {
          if (prev === 0) setPaused(false);
          else onQuit();
          return prev;
        });
      }
      return;
    }

    const key = e.key.toUpperCase();
    if (!PUNCH_KEYS.includes(key)) return;
    e.preventDefault();

    const punchType = KEY_TO_PUNCH[key];
    if (punchType) {
      setCurrentPunch({ type: punchType, progress: 0 });
    }
    soundEngine.trainingPunchHit();

    const combo = comboRef.current;
    const idx = comboIndexRef.current;
    if (key === combo[idx]) {
      setHitFlash(1);
      setBagSwing(prev => prev + 5);
      const nextIdx = idx + 1;
      if (nextIdx >= combo.length) {
        setCombos(c => c + 1);
        soundEngine.trainingDing();
        const tl = timeLeftRef.current;
        if (tl <= 10 && tl > 0 && TOTAL_TIME > 10) {
          clutchRepsRef.current++;
          if (clutchRepsRef.current >= 2) {
            clutchRepsRef.current = 0;
            setTimeLeft(t => t + 2);
          }
        }
        const newCombo = generateCombo(2, 5);
        setCurrentCombo(newCombo);
        comboRef.current = newCombo;
        comboIndexRef.current = 0;
        setComboIndex(0);
      } else {
        comboIndexRef.current = nextIdx;
        setComboIndex(nextIdx);
      }
    } else {
      setMissFlash(1);
      soundEngine.trainingBuzz();
      comboIndexRef.current = 0;
      setComboIndex(0);
    }
  }, [onQuit]);

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  const handleCanvasClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!paused || finished) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const cx = x * scaleX;
    const cy = y * scaleY;

    const W = canvas.width;
    const H = canvas.height;
    const menuItems = ["Resume", "Quit"];
    menuItems.forEach((_, i) => {
      const iy = H / 2 + i * 35;
      if (cx > W / 2 - 60 && cx < W / 2 + 60 && cy > iy - 15 && cy < iy + 10) {
        if (i === 0) setPaused(false);
        else onQuit();
      }
    });
  }, [paused, finished, onQuit]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const W = canvas.width;
    const H = canvas.height;

    const wallGrad = ctx.createLinearGradient(0, 0, 0, H);
    wallGrad.addColorStop(0, "#2a2a3a");
    wallGrad.addColorStop(0.5, "#252535");
    wallGrad.addColorStop(1, "#1e1e2e");
    ctx.fillStyle = wallGrad;
    ctx.fillRect(0, 0, W, H);

    ctx.strokeStyle = "#333348";
    ctx.lineWidth = 0.5;
    for (let bx = 0; bx < W; bx += 40) {
      ctx.beginPath(); ctx.moveTo(bx, 0); ctx.lineTo(bx, H * 0.62); ctx.stroke();
    }
    for (let by = 0; by < H * 0.62; by += 25) {
      ctx.beginPath(); ctx.moveTo(0, by); ctx.lineTo(W, by); ctx.stroke();
    }

    const floorY = H * 0.62;
    const floorGrad = ctx.createLinearGradient(0, floorY, 0, H);
    floorGrad.addColorStop(0, "#7B5230");
    floorGrad.addColorStop(0.2, "#6B4226");
    floorGrad.addColorStop(1, "#4A2E1A");
    ctx.fillStyle = floorGrad;
    ctx.fillRect(0, floorY, W, H - floorY);
    ctx.strokeStyle = "#8a6040";
    ctx.lineWidth = 0.5;
    for (let px = 0; px < W; px += 50) {
      ctx.beginPath(); ctx.moveTo(px, floorY); ctx.lineTo(px, H); ctx.stroke();
    }
    ctx.fillStyle = "#444460";
    ctx.fillRect(0, floorY - 3, W, 3);

    ctx.strokeStyle = "#444466";
    ctx.lineWidth = 3;
    const ringLeft = 10;
    const ropeY1 = floorY - 60;
    const ropeY2 = floorY - 35;
    const ropeY3 = floorY - 10;
    ctx.fillStyle = "#3a3a4a";
    ctx.fillRect(ringLeft, ropeY1 - 5, 6, floorY - ropeY1 + 5);
    ctx.fillRect(ringLeft + 50, ropeY1 - 5, 6, floorY - ropeY1 + 5);
    ctx.strokeStyle = "#dd3333";
    ctx.lineWidth = 2;
    [ropeY1, ropeY2, ropeY3].forEach(ry => {
      ctx.beginPath(); ctx.moveTo(ringLeft + 3, ry); ctx.lineTo(ringLeft + 53, ry); ctx.stroke();
    });

    ctx.fillStyle = "#cc8800";
    ctx.fillRect(W - 55, floorY - 50, 20, 50);
    ctx.fillRect(W - 55, floorY - 50, 20, 8);
    ctx.fillStyle = "#ffcc00";
    ctx.beginPath();
    ctx.moveTo(W - 45, floorY - 58);
    ctx.lineTo(W - 50, floorY - 50);
    ctx.lineTo(W - 40, floorY - 50);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#aa7700";
    ctx.fillRect(W - 30, floorY - 40, 15, 40);

    const framePositions = [
      { x: 30, y: 50, w: 30, h: 22 },
      { x: 80, y: 40, w: 25, h: 30 },
      { x: W - 90, y: 45, w: 28, h: 22 },
      { x: W - 130, y: 55, w: 24, h: 20 },
      { x: 140, y: 35, w: 22, h: 28 },
      { x: W - 50, y: 60, w: 20, h: 16 },
    ];
    framePositions.forEach(f => {
      ctx.fillStyle = "#5a4020";
      ctx.fillRect(f.x - 2, f.y - 2, f.w + 4, f.h + 4);
      ctx.fillStyle = "#3a3a4a";
      ctx.fillRect(f.x, f.y, f.w, f.h);
      ctx.fillStyle = "#cc4444";
      const bx = f.x + f.w * 0.3;
      const by = f.y + f.h * 0.4;
      ctx.beginPath(); ctx.arc(bx, by, Math.min(f.w, f.h) * 0.2, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#ddccaa";
      ctx.beginPath(); ctx.arc(bx + f.w * 0.25, by + 2, 2, 0, Math.PI * 2); ctx.fill();
    });

    const smallBagX = W - 70;
    const smallBagY = 110;
    ctx.strokeStyle = "#666666";
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(smallBagX, smallBagY - 20); ctx.lineTo(smallBagX, smallBagY - 5); ctx.stroke();
    ctx.fillStyle = "#8B4513";
    ctx.beginPath(); ctx.ellipse(smallBagX, smallBagY, 8, 12, 0, 0, Math.PI * 2); ctx.fill();

    const bgBagX = 60;
    const bgBagTopY = 95;
    ctx.strokeStyle = "#555555";
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(bgBagX, bgBagTopY - 30); ctx.lineTo(bgBagX, bgBagTopY); ctx.stroke();
    ctx.fillStyle = "#6a3510";
    ctx.beginPath(); ctx.ellipse(bgBagX, bgBagTopY + 25, 14, 28, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#4a2508";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.ellipse(bgBagX, bgBagTopY + 25, 14, 28, 0, 0, Math.PI * 2); ctx.stroke();

    const bagAnchorX = W / 2 + 100;
    const bagCX = bagAnchorX + bagSwing;
    const bagTopY = floorY - 220;
    const bagW = 60;
    const bagH = 114;

    ctx.strokeStyle = "#777777";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(bagAnchorX, bagTopY - 50);
    ctx.lineTo(bagCX, bagTopY);
    ctx.stroke();

    const bagGrad = ctx.createLinearGradient(bagCX - bagW / 2, bagTopY, bagCX + bagW / 2, bagTopY);
    bagGrad.addColorStop(0, "#6a3010");
    bagGrad.addColorStop(0.5, "#8B4513");
    bagGrad.addColorStop(1, "#6a3010");
    ctx.fillStyle = bagGrad;
    ctx.beginPath();
    ctx.ellipse(bagCX, bagTopY + bagH / 2, bagW / 2, bagH / 2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#4a2508";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.ellipse(bagCX, bagTopY + bagH / 2, bagW / 2, bagH / 2, 0, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = "#5a2d0c";
    ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.moveTo(bagCX, bagTopY + 5); ctx.lineTo(bagCX, bagTopY + bagH - 5); ctx.stroke();

    if (hitFlash > 0) {
      ctx.fillStyle = `rgba(255,255,100,${hitFlash * 0.6})`;
      ctx.beginPath();
      ctx.arc(bagCX - bagW / 2 + 5, bagTopY + bagH / 2, 12, 0, Math.PI * 2);
      ctx.fill();
    }

    const figX = W / 2 - 30;
    const figBaseY = floorY - 5;
    drawFightFighter(ctx, figX, figBaseY, skinColor, gc, bobPhase, currentPunch, bagCX, bagTopY + bagH / 2);

    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 24px monospace";
    ctx.textAlign = "center";
    ctx.fillText("HEAVY BAG", W / 2, 32);

    ctx.font = "15px monospace";
    ctx.fillStyle = "#aaaacc";
    ctx.fillText(`${fighter.firstName || fighter.name}`, W / 2, 54);

    ctx.font = "bold 32px monospace";
    ctx.fillStyle = timeLeft <= 10 ? "#ff4444" : "#ffffff";
    ctx.textAlign = "right";
    ctx.fillText(`${Math.ceil(timeLeft)}s`, W - 25, 38);
    ctx.textAlign = "center";

    ctx.font = "bold 42px monospace";
    ctx.fillStyle = "#ffcc00";
    ctx.textAlign = "left";
    ctx.fillText(`${combos}`, 25, 100);
    ctx.font = "15px monospace";
    ctx.fillStyle = "#aaaacc";
    ctx.fillText("COMBOS", 25, 118);
    ctx.textAlign = "center";

    if (timeLeft <= 10 && timeLeft > 0 && countdown <= 0 && !finished) {
      ctx.fillStyle = "#44ff44";
      ctx.font = "bold 13px monospace";
      ctx.textAlign = "center";
      ctx.fillText("+2s every 2 combos!", W / 2, 140);
    }

    const comboY = H - 75;
    const letterW = 44;
    const totalComboW = currentCombo.length * letterW;
    const startX = (W - totalComboW) / 2;

    ctx.fillStyle = "rgba(0,0,0,0.4)";
    ctx.fillRect(startX - 14, comboY - 28, totalComboW + 28, 48);

    const punchLabels: Record<string, string> = {
      Q: "L.HK", W: "JAB", E: "CRS", R: "R.HK", S: "L.UP", D: "R.UP",
    };

    currentCombo.forEach((letter, i) => {
      const x = startX + i * letterW + letterW / 2;
      if (i < comboIndex) {
        ctx.fillStyle = "#44ff44";
        ctx.font = "bold 28px monospace";
      } else if (i === comboIndex) {
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 34px monospace";
      } else {
        ctx.fillStyle = "#555577";
        ctx.font = "24px monospace";
      }
      ctx.fillText(letter, x, comboY - 2);

      ctx.font = "9px monospace";
      ctx.fillStyle = i < comboIndex ? "#33cc33" : i === comboIndex ? "#aaaacc" : "#444466";
      ctx.fillText(punchLabels[letter] || letter, x, comboY + 14);

      if (i === comboIndex) {
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x - 14, comboY + 20);
        ctx.lineTo(x + 14, comboY + 20);
        ctx.stroke();
      }
    });

    if (!finished && countdown <= 0) {
      ctx.fillStyle = "#aaaacc";
      ctx.font = "15px monospace";
      ctx.fillText("Type the combo keys!", W / 2, H - 30);
      ctx.fillStyle = "#777799";
      ctx.font = "13px monospace";
      ctx.fillText("[ESC] Pause", W / 2, H - 10);
    }

    if (missFlash > 0) {
      ctx.fillStyle = `rgba(255,30,30,${missFlash * 0.12})`;
      ctx.fillRect(0, 0, W, H);
    }

    if (countdown > 0) {
      ctx.fillStyle = "rgba(0,0,0,0.5)";
      ctx.fillRect(0, 0, W, H);
      const count = Math.ceil(countdown);
      const frac = countdown - Math.floor(countdown);
      const scale = 1 + frac * 0.5;
      ctx.save();
      ctx.translate(W / 2, H / 2 - 30);
      ctx.scale(scale, scale);
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 72px monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.globalAlpha = 0.5 + frac * 0.5;
      ctx.fillText(count.toString(), 0, 0);
      ctx.restore();
      ctx.fillStyle = "#aaaacc";
      ctx.font = "14px monospace";
      ctx.textAlign = "center";
      ctx.fillText("Get ready...", W / 2, H / 2 + 30);
    }

    if (paused && !finished) {
      ctx.fillStyle = "rgba(0,0,0,0.7)";
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 24px monospace";
      ctx.textAlign = "center";
      ctx.fillText("PAUSED", W / 2, H / 2 - 40);

      const menuItems = ["Resume", "Quit"];
      menuItems.forEach((item, i) => {
        const y = H / 2 + i * 35;
        ctx.fillStyle = i === pauseIndex ? "#ffcc00" : "#888888";
        ctx.font = i === pauseIndex ? "bold 18px monospace" : "16px monospace";
        ctx.fillText(`${i === pauseIndex ? "> " : "  "}${item}`, W / 2, y);
      });
    }

    if (finished) {
      ctx.fillStyle = "rgba(0,0,0,0.75)";
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = "#ffcc00";
      ctx.font = "bold 34px monospace";
      ctx.textAlign = "center";
      ctx.fillText("TIME'S UP!", W / 2, H / 2 - 80);

      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 26px monospace";
      ctx.fillText(`${combos} Combos`, W / 2, H / 2 - 35);

      const xp = Math.floor(combos * XP_PER_COMBO);
      ctx.fillStyle = "#44ff44";
      ctx.font = "22px monospace";
      ctx.fillText(`+${xp} XP`, W / 2, H / 2 + 5);

      if (combos > 30) {
        const bonusSP = Math.floor((combos - 30) / 2);
        ctx.fillStyle = "#ffaa00";
        ctx.font = "bold 18px monospace";
        ctx.fillText(`+${bonusSP} Bonus Skill Point${bonusSP !== 1 ? "s" : ""}!`, W / 2, H / 2 + 35);
      }

      ctx.fillStyle = "#aaaacc";
      ctx.font = "16px monospace";
      ctx.fillText("+Speed +Power bonus", W / 2, H / 2 + 65);

      ctx.fillStyle = "#888888";
      ctx.font = "15px monospace";
      ctx.fillText("Press [ENTER] or Click to continue", W / 2, H / 2 + 100);
    }
  }, [countdown, timeLeft, combos, currentCombo, comboIndex, missFlash, hitFlash, paused, finished, pauseIndex, bagSwing, fighter, skinColor, gc, currentPunch, bobPhase]);

  useEffect(() => {
    if (!finished) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        onComplete(Math.floor(combos * XP_PER_COMBO), combos);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [finished, combos, onComplete]);

  const handleFinishedClick = useCallback(() => {
    if (finished) {
      onComplete(Math.floor(combos * XP_PER_COMBO), combos);
    }
  }, [finished, combos, onComplete]);

  return (
    <div className="flex items-center justify-center min-h-screen bg-background">
      <canvas
        ref={canvasRef}
        width={720}
        height={620}
        className="border border-border rounded-md cursor-pointer max-w-full max-h-[90vh]"
        style={{ width: "min(90vw, 720px)", height: "min(85vh, 620px)" }}
        data-testid="canvas-heavy-bag"
        onClick={(e) => {
          if (finished) handleFinishedClick();
          else handleCanvasClick(e);
        }}
      />
    </div>
  );
}

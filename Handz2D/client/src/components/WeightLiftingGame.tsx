import { useState, useEffect, useRef, useCallback } from "react";
import type { Fighter, GearColors } from "@shared/schema";
import { DEFAULT_GEAR_COLORS } from "@shared/schema";
import { soundEngine } from "@/game/sound";

interface WeightLiftingGameProps {
  fighter: Fighter;
  onComplete: (xpGained: number, reps: number) => void;
  onQuit: () => void;
}

const TOTAL_TIME = 20;
const BASE_PRESSES_PER_REP = 20;
const XP_PER_REP = 3.6;
const SINK_PAUSE_THRESHOLD = 0.5;
const DECAY_INTERVAL = 0.3;

export default function WeightLiftingGame({ fighter, onComplete, onQuit }: WeightLiftingGameProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [countdown, setCountdown] = useState(3);
  const [timeLeft, setTimeLeft] = useState(TOTAL_TIME);
  const [presses, setPresses] = useState(0);
  const [reps, setReps] = useState(0);
  const [paused, setPaused] = useState(false);
  const [finished, setFinished] = useState(false);
  const [pauseIndex, setPauseIndex] = useState(0);
  const [bonusFloats, setBonusFloats] = useState<{ id: number; timer: number }[]>([]);
  const animRef = useRef<number>(0);
  const lastTimeRef = useRef<number>(0);
  const lastPressTimeRef = useRef<number>(performance.now());
  const repStartTimeRef = useRef<number>(performance.now());
  const sinkTimerRef = useRef<number>(0);
  const decayTimerRef = useRef<number>(0);
  const pressesRef = useRef(0);
  const bonusIdRef = useRef(0);
  const countdownRef = useRef(3);
  const repPressCountRef = useRef(0);
  const repsRef = useRef(0);
  const stateRef = useRef({ timeLeft: TOTAL_TIME, paused: false, finished: false });

  const gc = (fighter.gearColors as GearColors) || DEFAULT_GEAR_COLORS;
  const skinColor = fighter.skinColor || "#e8c4a0";

  useEffect(() => {
    stateRef.current = { timeLeft, paused, finished };
  }, [timeLeft, paused, finished]);

  useEffect(() => {
    pressesRef.current = presses;
  }, [presses]);

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
          if (next <= 0) {
            lastPressTimeRef.current = performance.now();
            return 0;
          }
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

        setBonusFloats(prev => {
          const updated = prev.map(f => ({ ...f, timer: f.timer - dt })).filter(f => f.timer > 0);
          return updated.length !== prev.length || updated.some((f, i) => f.timer !== prev[i]?.timer) ? updated : prev;
        });

        const elapsed = (now - lastPressTimeRef.current) / 1000;
        if (elapsed >= SINK_PAUSE_THRESHOLD && pressesRef.current > 0) {
          sinkTimerRef.current += dt;
          decayTimerRef.current += dt;
          if (decayTimerRef.current >= DECAY_INTERVAL) {
            decayTimerRef.current -= DECAY_INTERVAL;
            setPresses(prev => Math.max(0, prev - 1));
          }
        } else {
          sinkTimerRef.current = 0;
          decayTimerRef.current = 0;
        }
      }
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

    if (e.key === " " || e.key === "Space") {
      e.preventDefault();
      const now = performance.now();
      lastPressTimeRef.current = now;
      sinkTimerRef.current = 0;
      decayTimerRef.current = 0;
      const curRepCount = repPressCountRef.current;
      if (curRepCount === 0) {
        repStartTimeRef.current = now;
      }
      const curReps = repsRef.current;
      const needed = BASE_PRESSES_PER_REP + (curReps > 8 ? Math.floor((curReps - 8) / 2) : 0);
      const nextRepCount = curRepCount + 1;
      repPressCountRef.current = nextRepCount;
      const nextPresses = pressesRef.current + 1;
      if (nextRepCount >= needed) {
        soundEngine.trainingDing();
        const repDuration = (now - repStartTimeRef.current) / 1000;
        if (repDuration <= 2.0) {
          setTimeLeft(t => t + 2);
          bonusIdRef.current++;
          setBonusFloats(prev => [...prev, { id: bonusIdRef.current, timer: 1.5 }]);
        }
        repsRef.current = curReps + 1;
        repPressCountRef.current = 0;
        setReps(r => r + 1);
      }
      setPresses(nextPresses);
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

  const currentNeeded = BASE_PRESSES_PER_REP + (reps > 8 ? Math.floor((reps - 8) / 2) : 0);
  const pressProgress = repPressCountRef.current;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const W = canvas.width;
    const H = canvas.height;

    const gymWall = ctx.createLinearGradient(0, 0, 0, H);
    gymWall.addColorStop(0, "#2a2a3a");
    gymWall.addColorStop(0.6, "#222233");
    gymWall.addColorStop(1, "#1a1a28");
    ctx.fillStyle = gymWall;
    ctx.fillRect(0, 0, W, H);

    ctx.strokeStyle = "#333348";
    ctx.lineWidth = 1;
    for (let bx = 0; bx < W; bx += 40) {
      ctx.beginPath();
      ctx.moveTo(bx, 0);
      ctx.lineTo(bx, H * 0.65);
      ctx.stroke();
    }
    for (let by = 0; by < H * 0.65; by += 25) {
      ctx.beginPath();
      ctx.moveTo(0, by);
      ctx.lineTo(W, by);
      ctx.stroke();
    }

    const floorY = H * 0.65;
    const floor = ctx.createLinearGradient(0, floorY, 0, H);
    floor.addColorStop(0, "#6B4226");
    floor.addColorStop(0.3, "#5C3A22");
    floor.addColorStop(1, "#4A2E1A");
    ctx.fillStyle = floor;
    ctx.fillRect(0, floorY, W, H - floorY);

    ctx.strokeStyle = "#7a5030";
    ctx.lineWidth = 0.5;
    for (let px = 0; px < W; px += 60) {
      ctx.beginPath();
      ctx.moveTo(px, floorY);
      ctx.lineTo(px, H);
      ctx.stroke();
    }

    ctx.fillStyle = "#444460";
    ctx.fillRect(0, floorY - 4, W, 4);

    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 26px monospace";
    ctx.textAlign = "center";
    ctx.fillText("WEIGHT LIFTING", W / 2, 36);

    ctx.font = "16px monospace";
    ctx.fillStyle = "#aaaacc";
    ctx.fillText(`${fighter.firstName || fighter.name}`, W / 2, 60);

    ctx.font = "bold 36px monospace";
    ctx.fillStyle = timeLeft <= 10 ? "#ff4444" : "#ffffff";
    ctx.textAlign = "right";
    ctx.fillText(`${Math.ceil(timeLeft)}s`, W - 30, 44);
    ctx.textAlign = "center";

    ctx.font = "bold 48px monospace";
    ctx.fillStyle = "#ffcc00";
    ctx.fillText(`${reps}`, W / 2, 110);
    ctx.font = "18px monospace";
    ctx.fillStyle = "#aaaacc";
    ctx.fillText("REPS", W / 2, 134);

    const barW = W - 120;
    const barH = 24;
    const barX = 60;
    const barY = 150;
    ctx.fillStyle = "#1a1a2e";
    ctx.fillRect(barX, barY, barW, barH);
    ctx.strokeStyle = "#444466";
    ctx.lineWidth = 2;
    ctx.strokeRect(barX, barY, barW, barH);

    const progress = pressProgress / currentNeeded;
    const fillW = barW * progress;
    const grad = ctx.createLinearGradient(barX, barY, barX + barW, barY);
    grad.addColorStop(0, "#4444ff");
    grad.addColorStop(1, "#44ff44");
    ctx.fillStyle = grad;
    ctx.fillRect(barX, barY, fillW, barH);


    const liftProgress = progress;
    const figX = W / 2;
    const figBaseY = floorY - 8;

    const headR = 20;
    const bodyTop = figBaseY - 160;
    const bodyBot = figBaseY - 58;
    const headY = bodyTop - headR - 3;

    ctx.fillStyle = skinColor;
    ctx.beginPath();
    ctx.arc(figX, headY, headR, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#00000033";
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = "#222222";
    ctx.beginPath();
    ctx.arc(figX, headY - 4, headR + 1, Math.PI * 1.15, Math.PI * 1.85);
    ctx.fill();

    ctx.fillStyle = "#111111";
    const eyeY = headY - 1;
    ctx.beginPath(); ctx.arc(figX - 7, eyeY, 2, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(figX + 7, eyeY, 2, 0, Math.PI * 2); ctx.fill();

    ctx.fillStyle = gc.trunks;
    ctx.fillRect(figX - 20, bodyBot - 14, 40, 44);

    ctx.fillStyle = skinColor;
    ctx.fillRect(figX - 17, bodyTop, 34, bodyBot - bodyTop - 14);

    ctx.fillStyle = skinColor;
    const legSpread = 15;
    ctx.fillRect(figX - legSpread - 7, bodyBot + 30, 14, 58);
    ctx.fillRect(figX + legSpread - 7, bodyBot + 30, 14, 58);

    ctx.fillStyle = gc.shoes;
    ctx.fillRect(figX - legSpread - 9, figBaseY - 12, 18, 12);
    ctx.fillRect(figX + legSpread - 9, figBaseY - 12, 18, 12);

    const armAngle = liftProgress * Math.PI * 0.45;
    const shoulderY = bodyTop + 7;
    const armLen = 50;

    const barbellY = shoulderY - 10 - Math.sin(armAngle) * armLen;

    for (const side of [-1, 1]) {
      const sx = figX + side * 20;
      const elbowAngle = Math.PI * 0.5 - armAngle * 0.8;
      const elbowX = sx + side * Math.cos(elbowAngle) * 26;
      const elbowY = shoulderY + Math.sin(elbowAngle) * 26 - liftProgress * 14;

      ctx.strokeStyle = skinColor;
      ctx.lineWidth = 10;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(sx, shoulderY);
      ctx.lineTo(elbowX, elbowY);
      ctx.stroke();

      const handX = figX + side * 28;
      const handY = barbellY;
      ctx.beginPath();
      ctx.moveTo(elbowX, elbowY);
      ctx.lineTo(handX, handY);
      ctx.stroke();

      ctx.fillStyle = skinColor;
      ctx.beginPath();
      ctx.arc(handX, handY, 7, 0, Math.PI * 2);
      ctx.fill();
    }

    const barbellLen = 130;
    ctx.strokeStyle = "#aaaaaa";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(figX - barbellLen / 2, barbellY);
    ctx.lineTo(figX + barbellLen / 2, barbellY);
    ctx.stroke();

    ctx.fillStyle = "#555555";
    ctx.fillRect(figX - barbellLen / 2 - 16, barbellY - 16, 18, 32);
    ctx.fillRect(figX + barbellLen / 2 - 2, barbellY - 16, 18, 32);
    ctx.fillStyle = "#444444";
    ctx.fillRect(figX - barbellLen / 2 - 28, barbellY - 10, 14, 20);
    ctx.fillRect(figX + barbellLen / 2 + 14, barbellY - 10, 14, 20);

    bonusFloats.forEach(f => {
      const alpha = Math.min(1, f.timer / 0.5);
      const yOff = (1.5 - f.timer) * 50;
      ctx.fillStyle = `rgba(68, 255, 68, ${alpha})`;
      ctx.font = "bold 26px monospace";
      ctx.textAlign = "center";
      ctx.fillText("+2s", W / 2 + 80, 110 - yOff);
    });

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

    if (!finished && countdown <= 0) {
      ctx.fillStyle = "#aaaacc";
      ctx.font = "16px monospace";
      ctx.textAlign = "center";
      ctx.fillText("MASH [SPACE] to lift!", W / 2, H - 40);
      ctx.fillStyle = "#777799";
      ctx.font = "13px monospace";
      ctx.fillText("[ESC] Pause", W / 2, H - 18);
    }

    if (paused && !finished) {
      ctx.fillStyle = "rgba(0,0,0,0.7)";
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 24px monospace";
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
      ctx.fillText("TIME'S UP!", W / 2, H / 2 - 80);

      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 26px monospace";
      ctx.fillText(`${reps} Reps`, W / 2, H / 2 - 35);

      const xp = Math.floor(reps * XP_PER_REP);
      ctx.fillStyle = "#44ff44";
      ctx.font = "22px monospace";
      ctx.fillText(`+${xp} XP`, W / 2, H / 2 + 5);

      if (reps > 30) {
        const bonusSP = Math.floor((reps - 30) / 2);
        ctx.fillStyle = "#ffaa00";
        ctx.font = "bold 18px monospace";
        ctx.fillText(`+${bonusSP} Bonus Skill Point${bonusSP !== 1 ? "s" : ""}!`, W / 2, H / 2 + 35);
      }

      ctx.fillStyle = "#aaaacc";
      ctx.font = "16px monospace";
      ctx.fillText("+Power +Defense bonus", W / 2, H / 2 + 65);

      ctx.fillStyle = "#888888";
      ctx.font = "15px monospace";
      ctx.fillText("Press [ENTER] or Click to continue", W / 2, H / 2 + 100);
    }
  }, [countdown, timeLeft, presses, reps, paused, finished, pressProgress, currentNeeded, pauseIndex, fighter, skinColor, gc, bonusFloats]);

  useEffect(() => {
    if (!finished) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        onComplete(Math.floor(reps * XP_PER_REP), reps);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [finished, reps, onComplete]);

  const handleFinishedClick = useCallback(() => {
    if (finished) {
      onComplete(Math.floor(reps * XP_PER_REP), reps);
    }
  }, [finished, reps, onComplete]);

  return (
    <div className="flex items-center justify-center min-h-screen bg-background">
      <canvas
        ref={canvasRef}
        width={720}
        height={620}
        className="border border-border rounded-md cursor-pointer max-w-full max-h-[90vh]"
        style={{ width: "min(90vw, 720px)", height: "min(85vh, 620px)" }}
        data-testid="canvas-weight-lifting"
        onClick={(e) => {
          if (finished) handleFinishedClick();
          else handleCanvasClick(e);
        }}
      />
    </div>
  );
}

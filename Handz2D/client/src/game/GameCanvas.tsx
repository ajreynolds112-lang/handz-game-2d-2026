import { useRef, useEffect, useCallback } from "react";
import { GameState, PauseAction } from "./types";
import { renderGame, isPauseButtonClick, getPauseMenuClickIndex, getSoundSliderClick, getControlsBackClick, getTutorialContinueClick } from "./renderer";
import { soundEngine } from "./sound";
import { updateGame, handleKeyDown, handleKeyUp, clearAllKeys, advanceTutorialContinue } from "./engine";

const BASE_W = 800;
const BASE_H = 600;

interface GameCanvasProps {
  state: GameState;
  onStateChange: (state: GameState) => void;
}

export default function GameCanvas({ state, onStateChange }: GameCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<GameState>(state);
  const animFrameRef = useRef<number>(0);
  const lastTimeRef = useRef<number>(0);

  stateRef.current = state;

  const gameLoop = useCallback((timestamp: number) => {
    if (lastTimeRef.current === 0) lastTimeRef.current = timestamp;
    const dt = Math.min(0.05, (timestamp - lastTimeRef.current) / 1000);
    lastTimeRef.current = timestamp;

    const currentState = stateRef.current;
    if (currentState.phase === "fighting" || currentState.phase === "prefight") {
      const newState = updateGame({ ...currentState }, dt);
      stateRef.current = newState;
      onStateChange(newState);
    }

    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext("2d");
      if (ctx) {
        renderGame(ctx, stateRef.current);
      }
    }

    animFrameRef.current = requestAnimationFrame(gameLoop);
  }, [onStateChange]);

  useEffect(() => {
    animFrameRef.current = requestAnimationFrame(gameLoop);
    return () => cancelAnimationFrame(animFrameRef.current);
  }, [gameLoop]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      if (["arrowleft", "arrowright", "arrowup", "arrowdown", "escape", " ", "w", "e", "q", "r", "s", "d", "f", "a", "z", "x", "c", "shift", "tab", "enter"].includes(key)) {
        e.preventDefault();
      }
      handleKeyDown(e);
    };
    const onKeyUp = (e: KeyboardEvent) => handleKeyUp(e);

    const onBlur = () => clearAllKeys();
    const onVisChange = () => {
      if (document.hidden) clearAllKeys();
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisChange);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisChange);
    };
  }, []);

  const getCanvasCoords = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const scaleX = BASE_W / rect.width;
    const scaleY = BASE_H / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  }, []);

  const handleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const { x, y } = getCanvasCoords(e);
    const s = stateRef.current;

    if (s.tutorialMode && s.tutorialShowContinueButton && getTutorialContinueClick(x, y)) {
      soundEngine.uiClick();
      const newState = { ...s };
      advanceTutorialContinue(newState);
      onStateChange(newState);
      return;
    }

    if (s.isPaused) {
      if (s.pauseControlsTab) {
        if (getControlsBackClick(x, y)) {
          soundEngine.uiClick();
          const newState = { ...s };
          newState.pauseControlsTab = false;
          onStateChange(newState);
        }
        return;
      }

      if (s.pauseSoundTab) {
        const slider = getSoundSliderClick(x, y);
        if (slider) {
          const newState = { ...s };
          if (slider.value === -1) {
            soundEngine.uiClick();
            soundEngine.toggleMute();
          } else if (slider.value === -2) {
            soundEngine.uiClick();
            newState.pauseSoundTab = false;
          } else {
            soundEngine.updateSetting(slider.key, slider.value);
          }
          onStateChange(newState);
        }
        return;
      }

      if (s.tutorialMode) {
        const idx = getPauseMenuClickIndex(x, y, false, s);
        if (idx >= 0) {
          soundEngine.uiClick();
          const newState = { ...s };
          newState.pauseSelectedIndex = idx;
          if (idx === 0) {
            newState.pauseAction = "restart";
          } else if (idx === 1) {
            newState.pauseAction = "quit";
          }
          onStateChange(newState);
        }
        return;
      }

      const isCareerPause = s.sparringMode || s.careerFightMode;
      const idx = getPauseMenuClickIndex(x, y, isCareerPause, s);
      if (idx >= 0) {
        soundEngine.uiClick();
        const newState = { ...s };
        newState.pauseSelectedIndex = idx;
        if (s.practiceMode) {
          if (idx === 0) {
            newState.isPaused = false;
            newState.pauseAction = null;
          } else if (idx === 1) {
            newState.cpuAttacksEnabled = !s.cpuAttacksEnabled;
          } else if (idx === 2) {
            newState.cpuDefenseEnabled = !s.cpuDefenseEnabled;
          } else if (idx === 3) {
            newState.pauseControlsTab = true;
          } else if (idx === 4) {
            newState.pauseSoundTab = true;
          } else if (idx === 5) {
            newState.pauseAction = "restart";
          } else if (idx === 6) {
            newState.pauseAction = "quit";
          }
        } else {
          if (idx === 0) {
            newState.isPaused = false;
            newState.pauseAction = null;
            if (!newState.practiceMode) soundEngine.resumeCrowdAmbient();
          } else if (idx === 1) {
            newState.pauseControlsTab = true;
          } else if (idx === 2) {
            newState.pauseSoundTab = true;
          } else if (!isCareerPause && idx === 3) {
            newState.pauseAction = "restart";
          } else if ((isCareerPause && idx === 3) || (!isCareerPause && idx === 4)) {
            newState.pauseAction = "quit";
          }
        }
        onStateChange(newState);
      }
      return;
    }

    if ((s.phase === "fighting" || s.phase === "prefight") && isPauseButtonClick(x, y)) {
      soundEngine.uiClick();
      const newState = { ...s };
      newState.isPaused = true;
      newState.pauseSelectedIndex = 0;
      newState.pauseAction = null;
      newState.pauseSoundTab = false;
      newState.pauseControlsTab = false;
      if (!newState.practiceMode) soundEngine.pauseCrowdAmbient();
      onStateChange(newState);
    }
  }, [getCanvasCoords, onStateChange]);

  return (
    <canvas
      ref={canvasRef}
      width={BASE_W}
      height={BASE_H}
      data-testid="game-canvas"
      className="w-full rounded-md cursor-pointer"
      style={{ imageRendering: "auto", maxHeight: "100vh", objectFit: "contain" }}
      tabIndex={0}
      onClick={handleClick}
    />
  );
}

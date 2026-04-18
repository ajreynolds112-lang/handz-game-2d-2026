import { GameState, FighterState, FighterColors, HitEffect } from "./types";
import { soundEngine } from "./sound";

function parseHex(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  if (h.length === 6) {
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  return [128, 128, 128];
}

function telegraphGloveColor(fighter: FighterState): string {
  if (fighter.telegraphPhase === "none") return fighter.colors.gloves;
  const lv = Math.max(1, Math.min(100, fighter.level));
  const t = (lv - 1) / 99;
  const colorSpeedMult = 1 + t * 4; // 1x at level 1, 5x at level 100
  const rawProg = fighter.telegraphDuration > 0
    ? fighter.telegraphTimer / fighter.telegraphDuration : 1;
  const telegraphProg = Math.min(1, rawProg * colorSpeedMult);
  const effectStrength = 0.45 * (1 - t) + 0.04;
  const tint = telegraphProg * effectStrength;
  const [r, g, b] = parseHex(fighter.colors.gloves);
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  const isYellowOrange = r > 180 && g > 100 && b < 120;
  const shouldDarken = lum < 128 || isYellowOrange;
  let nr: number, ng: number, nb: number;
  if (shouldDarken) {
    nr = Math.max(0, Math.round(r * (1 - tint)));
    ng = Math.max(0, Math.round(g * (1 - tint)));
    nb = Math.max(0, Math.round(b * (1 - tint)));
  } else {
    nr = Math.min(255, Math.round(r + (255 - r) * tint));
    ng = Math.min(255, Math.round(g + (255 - g) * tint));
    nb = Math.min(255, Math.round(b + (255 - b) * tint));
  }
  return `rgb(${nr},${ng},${nb})`;
}

const CANVAS_W = 800;
const CANVAS_H = 600;
const RING_CX = 400;
const RING_CY = 260;
const RING_HALF_W = 280;
const RING_HALF_H = 180;

const CAM_PITCH = 0.62;
const CAM_ZOOM = 1.35;
const CAM_YAW_MAX = 0.55;
const CAM_YAW_LERP = 0.04;
const CAM_SCREEN_CX = CANVAS_W / 2;
const CAM_SCREEN_CY = CANVAS_H * 0.48;

let currentCameraYaw = 0;
let currentAutoZoom = 1.0;
const AUTO_ZOOM_MIN = 1.0;
const AUTO_ZOOM_MAX = 3.0;
const AUTO_ZOOM_LERP = 0.04;
const AUTO_ZOOM_DIST_MIN = 40;
const AUTO_ZOOM_DIST_MAX = 350;
const CAMERA_POS_LERP = 0.055;
const CAMERA_Y_BIAS = 74;
let delayedFocusX = CAM_SCREEN_CX;
let delayedFocusY = CAM_SCREEN_CY;

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

interface ScreenPt {
  sx: number;
  sy: number;
  depth: number;
}

function rotateY(p: Vec3, yaw: number): Vec3 {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return {
    x: p.x * c + p.z * s,
    y: p.y,
    z: -p.x * s + p.z * c,
  };
}

function projectToScreen(wx: number, wz: number, wy: number = 0): ScreenPt {
  const rel: Vec3 = { x: wx - RING_CX, y: wy, z: wz - RING_CY };
  const rotated = rotateY(rel, currentCameraYaw);
  const sx = CAM_SCREEN_CX + rotated.x * CAM_ZOOM;
  const sy = CAM_SCREEN_CY + rotated.z * CAM_PITCH * CAM_ZOOM - rotated.y * CAM_ZOOM;
  return { sx, sy, depth: rotated.z };
}

function updateCamera(_state: GameState): void {
  currentCameraYaw = 0;
}

export function resetAutoZoom(): void {
  currentAutoZoom = 1.0;
  delayedFocusX = CAM_SCREEN_CX;
  delayedFocusY = CAM_SCREEN_CY;
}

const COLORS = {
  staminaPlayer: "#22cc44",
  staminaEnemy: "#cc4422",
  staminaBg: "rgba(0,0,0,0.6)",
  ringFloor: "#3d2f1e",
  ringBorder: "#8b7355",
  ropePosts: "#8b7355",
  ringApron: "#2a2018",
};

export function renderGame(ctx: CanvasRenderingContext2D, state: GameState): void {
  ctx.save();

  if (state.shakeIntensity > 0 && state.shakeTimer > 0 && !state.isPaused) {
    const sx = (Math.random() - 0.5) * state.shakeIntensity * 2;
    const sy = (Math.random() - 0.5) * state.shakeIntensity * 2;
    ctx.translate(sx, sy);
  }

  updateCamera(state);

  if (state.countdownTimer > 0) {
    currentAutoZoom = AUTO_ZOOM_MIN;
  } else {
    const dx = state.player.x - state.enemy.x;
    const dz = state.player.z - state.enemy.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    const t = Math.max(0, Math.min(1, (dist - AUTO_ZOOM_DIST_MIN) / (AUTO_ZOOM_DIST_MAX - AUTO_ZOOM_DIST_MIN)));
    const rawZoom = AUTO_ZOOM_MAX + (AUTO_ZOOM_MIN - AUTO_ZOOM_MAX) * t;
    const targetZoom = Math.max(AUTO_ZOOM_MIN, rawZoom * 0.8);
    currentAutoZoom += (targetZoom - currentAutoZoom) * AUTO_ZOOM_LERP;
    currentAutoZoom = Math.max(AUTO_ZOOM_MIN, Math.min(AUTO_ZOOM_MAX, currentAutoZoom));
  }

  drawBackground(ctx, state);

  const midWX = (state.player.x + state.enemy.x) / 2;
  const midWZ = (state.player.z + state.enemy.z) / 2;
  const midScreen = projectToScreen(midWX, midWZ);
  const targetFocusX = midScreen.sx;
  const targetFocusY = midScreen.sy - CAMERA_Y_BIAS;
  delayedFocusX += (targetFocusX - delayedFocusX) * CAMERA_POS_LERP;
  delayedFocusY += (targetFocusY - delayedFocusY) * CAMERA_POS_LERP;

  ctx.save();
  ctx.translate(CANVAS_W / 2, CANVAS_H / 2);
  ctx.scale(currentAutoZoom, currentAutoZoom);
  ctx.translate(-delayedFocusX, -delayedFocusY);

  if (!state.practiceMode && !state.sparringMode) {
    drawCrowd(ctx, state);
  }

  drawRingFloor(ctx, state);
  drawRingBackRopes(ctx, state);

  const pairs: { fighter: FighterState; opponent: FighterState }[] = [
    { fighter: state.player, opponent: state.enemy },
    { fighter: state.enemy, opponent: state.player },
  ];
  const projected = pairs.map(p => ({
    ...p,
    pt: projectToScreen(p.fighter.x, p.fighter.z),
    oppPt: projectToScreen(p.opponent.x, p.opponent.z),
  }));
  projected.sort((a, b) => a.pt.depth - b.pt.depth);
  projected.forEach(({ fighter, opponent, pt, oppPt }) => drawFighter(ctx, fighter, opponent, state, pt, oppPt));

  if (state.refereeVisible) {
    drawReferee(ctx, state);
  }

  drawRingFrontRopes(ctx, state);
  drawHitEffects(ctx, state.hitEffects);

  if (state.towelActive && state.towelTimer > 0) {
    drawTowelAnimation(ctx, state);
  }

  if (state.refStoppageActive) {
    drawStoppageOverlay(ctx, state);
  }

  ctx.restore();

  if (state.phase === "fighting" || state.phase === "prefight") {
    drawHUD(ctx, state);
  }

  if (state.phase === "prefight" && state.countdownTimer > 0) {
    drawCountdown(ctx, state.countdownTimer);
  }

  if (state.knockdownActive) {
    drawKnockdownOverlay(ctx, state);
  }

  if (state.tutorialMode && state.tutorialPrompt && !state.isPaused) {
    drawTutorialPrompt(ctx, state);
  }

  if (state.isPaused) {
    drawPauseMenu(ctx, state.pauseSelectedIndex, state.pauseSoundTab, state.pauseControlsTab, state.sparringMode || state.careerFightMode, state);
  }

  ctx.restore();
}

function drawBackground(ctx: CanvasRenderingContext2D, state: GameState): void {
  const isGym = state.practiceMode || state.sparringMode;

  if (isGym) {
    ctx.fillStyle = "#E6C185";
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    return;
  }

  const grad = ctx.createLinearGradient(0, 0, 0, CANVAS_H);
  grad.addColorStop(0, "#0a0712");
  grad.addColorStop(0.3, "#140e1e");
  grad.addColorStop(0.7, "#1a1520");
  grad.addColorStop(1, "#0d0a14");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  ctx.fillStyle = "rgba(255, 200, 100, 0.008)";
  for (let i = 0; i < 30; i++) {
    const x = (Math.sin(i * 7.3) * 0.5 + 0.5) * CANVAS_W;
    const y = (Math.sin(i * 4.7) * 0.5 + 0.5) * CANVAS_H * 0.5;
    ctx.beginPath();
    ctx.arc(x, y, 2 + Math.sin(i * 2.1) * 1.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawCrowdEdge(
  ctx: CanvasRenderingContext2D,
  startWX: number, startWZ: number,
  endWX: number, endWZ: number,
  rows: number, perRow: number,
  outwardX: number, outwardZ: number,
  t0: number, kdBounce: boolean,
  seedBase: number, headSize: number, bodySize: number, brightness: number
): void {
  for (let row = 0; row < rows; row++) {
    const rowOff = (row + 1) * 18;
    const ox = outwardX * rowOff;
    const oz = outwardZ * rowOff;
    for (let i = 0; i < perRow; i++) {
      const frac = (i + 0.5) / perRow;
      const wx = startWX + (endWX - startWX) * frac + ox + Math.sin(i * 3.7 + row * 2.1) * 8;
      const wz = startWZ + (endWZ - startWZ) * frac + oz + Math.cos(i * 2.3 + row * 1.7) * 5;
      const p = projectToScreen(wx, wz);
      const seed = seedBase + i * 1.7 + row * 3.1;
      let bobX = Math.sin(t0 * 1.2 + seed) * 1.5;
      let bobY = Math.sin(t0 * 1.8 + seed * 0.7) * 1.0;
      if (kdBounce) {
        bobY += Math.abs(Math.sin(t0 * 6 + seed)) * 4;
        bobX += Math.sin(t0 * 4 + seed * 1.3) * 2;
      }
      const px = p.sx + bobX;
      const py = p.sy + bobY;
      const hue = (i * 37 + row * 90 + seedBase * 13) % 360;
      const depthDim = Math.max(0.6, 1 - row * 0.12);
      const lHead = Math.round((brightness + row * 3) * depthDim);
      const lBody = Math.round((brightness + 8 + row * 3) * depthDim);
      ctx.fillStyle = `hsl(${hue}, 30%, ${lHead}%)`;
      ctx.beginPath();
      ctx.arc(px, py, headSize - row * 0.3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = `hsl(${hue}, 20%, ${lBody}%)`;
      ctx.beginPath();
      ctx.ellipse(px, py + headSize + 1, headSize - row * 0.2, bodySize - row * 0.3, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawCrowdCorner(
  ctx: CanvasRenderingContext2D,
  cornerWX: number, cornerWZ: number,
  outDirX: number, outDirZ: number,
  spreadX: number, spreadZ: number,
  count: number, rows: number,
  t0: number, kdBounce: boolean,
  seedBase: number, headSize: number, bodySize: number, brightness: number
): void {
  for (let row = 0; row < rows; row++) {
    const rowOff = (row + 1) * 16;
    for (let i = 0; i < count; i++) {
      const frac = (i - count / 2) / count;
      const wx = cornerWX + outDirX * rowOff + spreadX * frac * (row + 1) * 8 + Math.sin(i * 5.3 + row * 1.9) * 6;
      const wz = cornerWZ + outDirZ * rowOff + spreadZ * frac * (row + 1) * 8 + Math.cos(i * 3.1 + row * 2.7) * 4;
      const p = projectToScreen(wx, wz);
      const seed = seedBase + i * 2.3 + row * 4.1;
      let bobX = Math.sin(t0 * 1.2 + seed) * 1.5;
      let bobY = Math.sin(t0 * 1.8 + seed * 0.7) * 1.0;
      if (kdBounce) {
        bobY += Math.abs(Math.sin(t0 * 6 + seed)) * 4;
        bobX += Math.sin(t0 * 4 + seed * 1.3) * 2;
      }
      const px = p.sx + bobX;
      const py = p.sy + bobY;
      const hue = (i * 47 + row * 110 + seedBase * 17) % 360;
      const depthDim = Math.max(0.6, 1 - row * 0.1);
      const lHead = Math.round((brightness + row * 3) * depthDim);
      const lBody = Math.round((brightness + 8 + row * 3) * depthDim);
      ctx.fillStyle = `hsl(${hue}, 30%, ${lHead}%)`;
      ctx.beginPath();
      ctx.arc(px, py, headSize - row * 0.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = `hsl(${hue}, 20%, ${lBody}%)`;
      ctx.beginPath();
      ctx.ellipse(px, py + headSize + 1, headSize - row * 0.15, bodySize - row * 0.2, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawCrowd(ctx: CanvasRenderingContext2D, state: GameState): void {
  ctx.save();
  const outerW = RING_HALF_W + 50;
  const outerH = RING_HALF_H + 35;
  const corners = getDiamondCorners(outerW, outerH);
  const [top, right, bot, left] = corners;

  const t0 = state.crowdBobTime;
  const kdBounce = state.crowdKdBounceTimer > 0;

  drawCrowdEdge(ctx, left[0], left[1], top[0], top[1], 14, 28, -0.9, -0.7, t0, kdBounce, 0, 4, 5, 14);
  drawCrowdEdge(ctx, top[0], top[1], right[0], right[1], 14, 28, 0.9, -0.7, t0, kdBounce, 50, 4, 5, 14);
  drawCrowdEdge(ctx, right[0], right[1], bot[0], bot[1], 12, 24, 0.9, 0.7, t0, kdBounce, 100, 3.5, 4.5, 16);
  drawCrowdEdge(ctx, left[0], left[1], bot[0], bot[1], 12, 24, -0.9, 0.7, t0, kdBounce, 150, 3.5, 4.5, 16);

  drawCrowdCorner(ctx, top[0], top[1], 0, -1, 1, 0, 10, 10, t0, kdBounce, 200, 3.5, 4.5, 13);
  drawCrowdCorner(ctx, bot[0], bot[1], 0, 1, 1, 0, 10, 8, t0, kdBounce, 220, 3.5, 4.5, 16);
  drawCrowdCorner(ctx, left[0], left[1], -1, 0, 0, 1, 10, 10, t0, kdBounce, 240, 3.5, 4.5, 14);
  drawCrowdCorner(ctx, right[0], right[1], 1, 0, 0, 1, 10, 10, t0, kdBounce, 260, 3.5, 4.5, 14);

  ctx.restore();
}

function getDiamondCorners(hw: number = RING_HALF_W, hh: number = RING_HALF_H): [number, number][] {
  return [
    [RING_CX, RING_CY - hh],
    [RING_CX + hw, RING_CY],
    [RING_CX, RING_CY + hh],
    [RING_CX - hw, RING_CY],
  ];
}

function drawProjectedPolygon(ctx: CanvasRenderingContext2D, worldPoints: [number, number][]): void {
  if (worldPoints.length < 3) return;
  ctx.beginPath();
  const first = projectToScreen(worldPoints[0][0], worldPoints[0][1]);
  ctx.moveTo(first.sx, first.sy);
  for (let i = 1; i < worldPoints.length; i++) {
    const p = projectToScreen(worldPoints[i][0], worldPoints[i][1]);
    ctx.lineTo(p.sx, p.sy);
  }
  ctx.closePath();
}

function darkenHex(hex: string, amount: number): string {
  const r = Math.max(0, parseInt(hex.slice(1, 3), 16) - amount);
  const g = Math.max(0, parseInt(hex.slice(3, 5), 16) - amount);
  const b = Math.max(0, parseInt(hex.slice(5, 7), 16) - amount);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

function drawRingFloor(ctx: CanvasRenderingContext2D, state: GameState): void {
  ctx.save();

  const canvasColor = state.ringCanvasColor || COLORS.ringFloor;
  const apronColor = darkenHex(canvasColor, 20);

  ctx.fillStyle = "rgba(30, 22, 15, 0.5)";
  const shadowCorners = getDiamondCorners(RING_HALF_W + 15, RING_HALF_H + 10);
  const shadowOffset: [number, number][] = shadowCorners.map(([x, z]) => [x, z + 8]);
  drawProjectedPolygon(ctx, shadowOffset);
  ctx.fill();

  const apronCorners = getDiamondCorners(RING_HALF_W + 6, RING_HALF_H + 4);
  ctx.fillStyle = apronColor;
  drawProjectedPolygon(ctx, apronCorners);
  ctx.fill();

  const floorCorners = getDiamondCorners();
  ctx.fillStyle = canvasColor;
  drawProjectedPolygon(ctx, floorCorners);
  ctx.fill();

  ctx.strokeStyle = "rgba(255,255,255,0.025)";
  ctx.lineWidth = 1;
  for (let i = 1; i < 8; i++) {
    const t = i / 8;
    const corners = getDiamondCorners();
    const [top, right, bot, left] = corners;
    const startX = left[0] + (top[0] - left[0]) * t;
    const startZ = left[1] + (top[1] - left[1]) * t;
    const endX = right[0] + (bot[0] - right[0]) * t;
    const endZ = right[1] + (bot[1] - right[1]) * t;
    const pS = projectToScreen(startX, startZ);
    const pE = projectToScreen(endX, endZ);
    ctx.beginPath();
    ctx.moveTo(pS.sx, pS.sy);
    ctx.lineTo(pE.sx, pE.sy);
    ctx.stroke();

    const s2X = top[0] + (right[0] - top[0]) * t;
    const s2Z = top[1] + (right[1] - top[1]) * t;
    const e2X = left[0] + (bot[0] - left[0]) * t;
    const e2Z = left[1] + (bot[1] - left[1]) * t;
    const pS2 = projectToScreen(s2X, s2Z);
    const pE2 = projectToScreen(e2X, e2Z);
    ctx.beginPath();
    ctx.moveTo(pS2.sx, pS2.sy);
    ctx.lineTo(pE2.sx, pE2.sy);
    ctx.stroke();
  }

  ctx.strokeStyle = COLORS.ringBorder;
  ctx.lineWidth = 2;
  drawProjectedPolygon(ctx, floorCorners);
  ctx.stroke();

  const radGrad = ctx.createRadialGradient(
    CAM_SCREEN_CX, CAM_SCREEN_CY, 10,
    CAM_SCREEN_CX, CAM_SCREEN_CY, 200
  );
  radGrad.addColorStop(0, "rgba(255, 220, 150, 0.05)");
  radGrad.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = radGrad;
  drawProjectedPolygon(ctx, floorCorners);
  ctx.save();
  ctx.clip();
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  ctx.restore();

  ctx.restore();
}

function isEdgeBackFacing(p1: [number, number], p2: [number, number]): boolean {
  const mid = projectToScreen((p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2);
  return mid.depth < 20;
}

function getCornerPostColor(cornerIndex: number, state: GameState): string {
  if (cornerIndex === 3) return state.playerColors.trunks;
  if (cornerIndex === 1) return state.enemyColors.trunks;
  return "#ffffff";
}

function drawRingBackRopes(ctx: CanvasRenderingContext2D, state: GameState): void {
  ctx.save();
  const corners = getDiamondCorners();
  const edges: [[number, number], [number, number]][] = [
    [corners[0], corners[1]],
    [corners[1], corners[2]],
    [corners[2], corners[3]],
    [corners[3], corners[0]],
  ];

  const ropeColors = ["#cc3333", "#ffffff", "#cc3333"];
  const ropeHeights = [8, 18, 28];

  edges.forEach(([p1, p2]) => {
    if (!isEdgeBackFacing(p1, p2)) return;

    const pp1 = projectToScreen(p1[0], p1[1]);
    const pp2 = projectToScreen(p2[0], p2[1]);

    ctx.strokeStyle = COLORS.ringBorder;
    ctx.lineWidth = 3;
    ctx.globalAlpha = 0.4;
    ctx.beginPath();
    ctx.moveTo(pp1.sx, pp1.sy);
    ctx.lineTo(pp1.sx, pp1.sy - 30 * CAM_ZOOM);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(pp2.sx, pp2.sy);
    ctx.lineTo(pp2.sx, pp2.sy - 30 * CAM_ZOOM);
    ctx.stroke();

    ropeHeights.forEach((h, i) => {
      const s1 = projectToScreen(p1[0], p1[1], h);
      const s2 = projectToScreen(p2[0], p2[1], h);
      ctx.strokeStyle = ropeColors[i];
      ctx.lineWidth = i === 1 ? 1.5 : 2;
      ctx.globalAlpha = 0.7;
      ctx.beginPath();
      ctx.moveTo(s1.sx, s1.sy);
      ctx.lineTo(s2.sx, s2.sy);
      ctx.stroke();
    });

    ctx.globalAlpha = 1;
  });

  corners.forEach(([cx, cz], idx) => {
    const cp = projectToScreen(cx, cz);
    if (cp.depth >= 20) return;

    const topP = projectToScreen(cx, cz, 32);
    ctx.strokeStyle = getCornerPostColor(idx, state);
    ctx.lineWidth = 4;
    ctx.globalAlpha = 0.8;
    ctx.beginPath();
    ctx.moveTo(cp.sx, cp.sy);
    ctx.lineTo(topP.sx, topP.sy);
    ctx.stroke();

    ctx.fillStyle = getCornerPostColor(idx, state);
    ctx.beginPath();
    ctx.arc(topP.sx, topP.sy, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  });

  ctx.restore();
}

function drawRingFrontRopes(ctx: CanvasRenderingContext2D, state: GameState): void {
  ctx.save();
  const corners = getDiamondCorners();
  const edges: [[number, number], [number, number]][] = [
    [corners[0], corners[1]],
    [corners[1], corners[2]],
    [corners[2], corners[3]],
    [corners[3], corners[0]],
  ];

  const ropeColors = ["#cc3333", "#ffffff", "#cc3333"];
  const ropeHeights = [8, 18, 28];

  edges.forEach(([p1, p2]) => {
    if (isEdgeBackFacing(p1, p2)) return;

    const pp1 = projectToScreen(p1[0], p1[1]);
    const pp2 = projectToScreen(p2[0], p2[1]);

    ctx.strokeStyle = COLORS.ringBorder;
    ctx.lineWidth = 3;
    ctx.globalAlpha = 0.15;
    ctx.beginPath();
    ctx.moveTo(pp1.sx, pp1.sy);
    ctx.lineTo(pp1.sx, pp1.sy - 30 * CAM_ZOOM);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(pp2.sx, pp2.sy);
    ctx.lineTo(pp2.sx, pp2.sy - 30 * CAM_ZOOM);
    ctx.stroke();

    ropeHeights.forEach((h, i) => {
      const s1 = projectToScreen(p1[0], p1[1], h);
      const s2 = projectToScreen(p2[0], p2[1], h);
      ctx.strokeStyle = ropeColors[i];
      ctx.lineWidth = i === 1 ? 1.5 : 2;
      ctx.globalAlpha = 0.12;
      ctx.beginPath();
      ctx.moveTo(s1.sx, s1.sy);
      ctx.lineTo(s2.sx, s2.sy);
      ctx.stroke();
    });

    ctx.globalAlpha = 1;
  });

  corners.forEach(([cx, cz], idx) => {
    const cp = projectToScreen(cx, cz);
    if (cp.depth < 20) return;

    const topP = projectToScreen(cx, cz, 32);
    ctx.strokeStyle = getCornerPostColor(idx, state);
    ctx.lineWidth = 3;
    ctx.globalAlpha = 0.15;
    ctx.beginPath();
    ctx.moveTo(cp.sx, cp.sy);
    ctx.lineTo(topP.sx, topP.sy);
    ctx.stroke();
    ctx.globalAlpha = 1;
  });

  ctx.restore();
}

const FIGHTER_SCALE = 1.6;
const BODY_H = 28 * FIGHTER_SCALE;
const HEAD_R = 7 * FIGHTER_SCALE;
const UPPER_ARM_L = 14 * FIGHTER_SCALE;
const FOREARM_L = 12 * FIGHTER_SCALE;
const UPPER_LEG_L = 14 * FIGHTER_SCALE;
const LOWER_LEG_L = 12 * FIGHTER_SCALE;
const GLOVE_R = 5 * FIGHTER_SCALE;
const SHOE_H = 4 * FIGHTER_SCALE;
const TORSO_W = 14 * FIGHTER_SCALE;

function drawFighter(ctx: CanvasRenderingContext2D, fighter: FighterState, opponent: FighterState, state: GameState, screenPt: ScreenPt, oppPt: ScreenPt): void {
  if (fighter.isKnockedDown) {
    drawKnockedDownFighter(ctx, fighter, screenPt, state);
    return;
  }

  const c = fighter.colors;
  const fwdDx = oppPt.sx - screenPt.sx;
  const fwdDy = oppPt.sy - screenPt.sy;
  const fwdLen = Math.sqrt(fwdDx * fwdDx + fwdDy * fwdDy) || 1;
  const fwdNx = fwdDx / fwdLen;
  const fwdNy = fwdDy / fwdLen;
  const sx = screenPt.sx + fighter.swayOffset * fwdNx * 0.5;
  const baseY = screenPt.sy + fighter.swayOffset * fwdNy * 0.2;

  ctx.save();
  const critFlash = fighter.critHitTimer > 0;
  if (fighter.isHit && !critFlash) {
    ctx.globalAlpha = 0.7 + Math.sin(Date.now() * 0.03) * 0.3;
  }

  const viewAngle = fighter.facingAngle - currentCameraYaw + Math.PI;
  const sideView = Math.sin(viewAngle);
  const frontView = -Math.cos(viewAngle);

  const bodyWidthMult = Math.abs(sideView) * 0.35 + Math.abs(frontView) * 1.0;

  ctx.fillStyle = "rgba(0,0,0,0.25)";
  ctx.beginPath();
  ctx.ellipse(sx, baseY + 2, 18 * FIGHTER_SCALE * 0.6 * bodyWidthMult, 8 * FIGHTER_SCALE * 0.4, 0, 0, Math.PI * 2);
  ctx.fill();

  const isDucking = fighter.defenseState === "duck";
  const dp = fighter.duckProgress;
  let telegraphDuckOffset = 0;
  if (fighter.telegraphPhase === "duckDown" || fighter.telegraphPhase === "duckUp") {
    const half = fighter.telegraphDuration * 0.5;
    let tProg: number;
    if (fighter.telegraphPhase === "duckDown") {
      tProg = half > 0 ? Math.min(1, fighter.telegraphTimer / half) : 1;
    } else {
      tProg = half > 0 ? Math.min(1, (fighter.telegraphTimer - half) / half) : 1;
    }
    const isUppercutTelegraph = fighter.telegraphPunchType?.includes("Uppercut");
    const duckPct = isUppercutTelegraph ? 0.40 : 0.25;
    telegraphDuckOffset = fighter.telegraphPhase === "duckDown" ? tProg * duckPct : (1 - tProg) * duckPct;
  }
  const duckFactor = 1.0 - (dp + telegraphDuckOffset) * 0.4;

  const bodyHeight = BODY_H * duckFactor;
  const bob = fighter.rhythmLevel > 0
    ? Math.abs(fighter.swayOffset / 5) * 3.0 * FIGHTER_SCALE
    : Math.sin(fighter.bobPhase) * 1.5 * FIGHTER_SCALE;

  const hipY = baseY - LOWER_LEG_L - UPPER_LEG_L * duckFactor + bob;
  const depthShift = frontView * 3;

  const roughShoulderY = hipY - bodyHeight;
  const oppTorsoY = oppPt.sy - (LOWER_LEG_L + UPPER_LEG_L + BODY_H * 0.5);
  const toOppDx = oppPt.sx - sx;
  const toOppDy = oppTorsoY - roughShoulderY;
  const toOppDist = Math.max(1, Math.sqrt(toOppDx * toOppDx + toOppDy * toOppDy));
  const punchDirX = toOppDx / toOppDist;
  const punchDirY = toOppDy / toOppDist;

  const torsoLeanFwd = 0.10;
  let leanOffsetX = punchDirX * bodyHeight * torsoLeanFwd;
  let leanOffsetY = punchDirY * bodyHeight * torsoLeanFwd;

  let weaveHeadOX = 0;
  let weaveHeadOY = 0;
  let weaveTorsoOX = 0;
  let weaveTorsoOY = 0;
  const weaveAnim = fighter.weaveActive || fighter.weaveRecoveryTimer > 0;
  if (weaveAnim) {
    let t: number;
    if (fighter.weaveActive) {
      t = Math.sin(fighter.weaveProgress * Math.PI);
    } else {
      const recov = fighter.weaveRecoveryTimer / 0.12;
      t = Math.sin(recov * Math.PI * 0.5) * 0.3;
    }
    const wdx = fighter.weaveDirX;
    const wdy = fighter.weaveDirY;
    weaveHeadOX = wdx * 12 * t * FIGHTER_SCALE;
    weaveHeadOY = wdy * 6 * t * FIGHTER_SCALE;
    weaveTorsoOX = wdx * 6 * t * FIGHTER_SCALE;
    weaveTorsoOY = wdy * 3 * t * FIGHTER_SCALE;
  }

  const shoulderY = hipY - bodyHeight + Math.abs(leanOffsetY) * 0.3 + weaveTorsoOY;
  const headY = shoulderY - HEAD_R * 0.8;
  const bodyX = sx + depthShift + leanOffsetX + weaveTorsoOX;

  const tW = TORSO_W * 0.5 * bodyWidthMult;
  const shoulderW = tW * 0.9;
  const hipW = tW;

  drawLegs(ctx, fighter, sx, baseY, hipY, sideView, frontView, bodyWidthMult, duckFactor, bob, critFlash, punchDirX);

  const showingBack = frontView > 0;

  if (showingBack) {
    drawArms(ctx, fighter, bodyX, shoulderY, sideView, frontView, bodyWidthMult, bob, punchDirX, punchDirY, toOppDist, critFlash, weaveHeadOX, weaveHeadOY);
  }

  const hipBodyX = sx + depthShift;
  const isChargeFlashing = fighter.chargeFlashTimer > 0;
  ctx.fillStyle = isChargeFlashing ? "rgba(60,120,255,0.7)" : (critFlash ? "#ff2222" : c.skin);
  ctx.beginPath();
  ctx.moveTo(bodyX - shoulderW, shoulderY);
  ctx.lineTo(bodyX + shoulderW, shoulderY);
  ctx.lineTo(hipBodyX + hipW, hipY);
  ctx.lineTo(hipBodyX - hipW, hipY);
  ctx.closePath();
  ctx.fill();

  const trunkTopFrac = 0.35;
  const trunkTopX = hipBodyX + (bodyX - hipBodyX) * (1 - trunkTopFrac);
  const trunkTop = hipY - bodyHeight * trunkTopFrac + Math.abs(leanOffsetY) * 0.3 * (1 - trunkTopFrac);
  ctx.fillStyle = critFlash ? "#cc1111" : c.trunks;
  ctx.beginPath();
  ctx.moveTo(trunkTopX - shoulderW * 0.95, trunkTop);
  ctx.lineTo(trunkTopX + shoulderW * 0.95, trunkTop);
  ctx.lineTo(hipBodyX + hipW, hipY);
  ctx.lineTo(hipBodyX - hipW, hipY);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = shadeColor(c.trunks, 30);
  ctx.fillRect(trunkTopX - shoulderW * 0.95, trunkTop, shoulderW * 1.9, 3 * FIGHTER_SCALE);

  const chargeHeadFwd = fighter.chargeHeadOffset * bodyHeight;
  const forwardOff = punchDirX * 5 * FIGHTER_SCALE + punchDirX * chargeHeadFwd;
  const telegraphSinkY = fighter.telegraphHeadSinkProgress * 5;
  const forwardOffY = punchDirY * 3 * FIGHTER_SCALE + punchDirY * chargeHeadFwd * 0.5 + telegraphSinkY;
  const headShift = frontView * 2 + forwardOff;

  let headSlideOX = 0;
  let headSlideOY = 0;
  if (fighter.telegraphHeadSlidePhase !== "none") {
    const hsDur = fighter.telegraphHeadSlideDuration;
    const hsT = fighter.telegraphHeadSlideTimer;
    if (fighter.telegraphHeadSlidePhase === "sliding") {
      const p = hsDur > 0 ? Math.min(1, hsT / hsDur) : 1;
      headSlideOX = fighter.telegraphHeadSlideX * p;
      headSlideOY = fighter.telegraphHeadSlideY * p;
    } else if (fighter.telegraphHeadSlidePhase === "holding") {
      headSlideOX = fighter.telegraphHeadSlideX;
      headSlideOY = fighter.telegraphHeadSlideY;
    } else if (fighter.telegraphHeadSlidePhase === "returning") {
      const p = hsDur > 0 ? Math.min(1, hsT / hsDur) : 1;
      headSlideOX = fighter.telegraphHeadSlideX * (1 - p);
      headSlideOY = fighter.telegraphHeadSlideY * (1 - p);
    }
  }

  let headVibY = 0;
  if (fighter.telegraphPhase !== "none" && fighter.telegraphPunchType) {
    const tDur = fighter.telegraphDuration;
    const tT = fighter.telegraphTimer;
    const tProg = tDur > 0 ? tT / tDur : 1;
    if (tProg >= 0.75) {
      const vibWindow = tDur * 0.25;
      const vibT = tT - tDur * 0.75;
      const freq = vibWindow > 0 ? (vibT / vibWindow) * Math.PI * 2 * 6 : 0;
      headVibY = Math.sin(freq) * 2;
    }
  }

  const chargeFlash = fighter.chargeFlashTimer > 0;
  ctx.fillStyle = chargeFlash ? "rgba(60,120,255,0.9)" : (critFlash ? "#ff2222" : c.skin);
  ctx.beginPath();
  ctx.arc(bodyX + headShift + headSlideOX + weaveHeadOX, headY + forwardOffY + headSlideOY + headVibY + weaveHeadOY, HEAD_R, 0, Math.PI * 2);
  ctx.fill();

  if (Math.abs(frontView) > 0.3) {
    ctx.fillStyle = "#1a1a1a";
    const eyeOff = frontView * HEAD_R * 0.3;
    const eyeSpread = 2.5 * FIGHTER_SCALE * bodyWidthMult;
    const eyeX1 = bodyX + headShift + headSlideOX + weaveHeadOX + eyeOff - eyeSpread;
    const eyeX2 = bodyX + headShift + headSlideOX + weaveHeadOX + eyeOff + eyeSpread;
    const eyeY = headY + headSlideOY + telegraphSinkY - HEAD_R * 0.15 + headVibY + weaveHeadOY;
    const telegraphing = fighter.telegraphPhase !== "none";
    const telegraphBlinkChance = telegraphing
      ? 0.75 - 0.25 * Math.min(1, (Math.max(1, fighter.level) - 1) / 99)
      : 0;
    const showBlink = fighter.cleanHitEyeTimer > 0
      || fighter.isBlinking
      || (telegraphing && (((fighter.level * 7 + Math.floor(fighter.telegraphTimer * 100)) % 100) / 100 < telegraphBlinkChance));
    if (showBlink) {
      const ew = 0.9 * FIGHTER_SCALE;
      ctx.strokeStyle = "#1a1a1a";
      ctx.lineWidth = 0.6 * FIGHTER_SCALE;
      ctx.beginPath();
      ctx.moveTo(eyeX1 - ew, eyeY);
      ctx.lineTo(eyeX1 + ew, eyeY);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(eyeX2 - ew, eyeY);
      ctx.lineTo(eyeX2 + ew, eyeY);
      ctx.stroke();
    } else {
      const nonJabPunch = fighter.isPunching && fighter.currentPunch && fighter.currentPunch !== "jab";
      const eyeR = 1.2 * FIGHTER_SCALE;
      if (nonJabPunch) {
        const sx = eyeR * 1.3;
        const sy = eyeR * 0.55;
        ctx.beginPath();
        ctx.ellipse(eyeX1, eyeY, sx, sy, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.ellipse(eyeX2, eyeY, sx, sy, 0, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.arc(eyeX1, eyeY, eyeR, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(eyeX2, eyeY, eyeR, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  if (!showingBack) {
    drawArms(ctx, fighter, bodyX, shoulderY, sideView, frontView, bodyWidthMult, bob, punchDirX, punchDirY, toOppDist, critFlash, weaveHeadOX, weaveHeadOY);
  }


  ctx.save();
  ctx.fillStyle = "rgba(255,255,255,0.5)";
  ctx.font = "10px 'Oxanium', sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(fighter.name, sx, headY - HEAD_R - 6);
  ctx.restore();

  if (fighter.isPlayer && fighter.autoGuardActive && fighter.autoGuardDuration > 0) {
    const barW = 30;
    const barH = 3;
    const barX = sx - barW / 2;
    const barY = baseY + 8;
    const pct = Math.max(0, Math.min(1, fighter.autoGuardTimer / fighter.autoGuardDuration));
    ctx.fillStyle = "rgba(80, 80, 80, 0.25)";
    ctx.fillRect(barX, barY, barW, barH);
    ctx.fillStyle = "rgba(230, 210, 80, 0.35)";
    ctx.fillRect(barX, barY, barW * pct, barH);
    ctx.strokeStyle = "rgba(200, 190, 100, 0.3)";
    ctx.lineWidth = 0.5;
    ctx.strokeRect(barX, barY, barW, barH);
  }

  ctx.restore();
}

function drawLegs(
  ctx: CanvasRenderingContext2D,
  fighter: FighterState,
  sx: number, baseY: number, hipY: number,
  sideView: number, frontView: number, bodyWidthMult: number,
  duckFactor: number, bob: number, critFlash: boolean, punchDirX: number
): void {
  const c = fighter.colors;
  const depthOff = frontView * 4;

  const dp = fighter.duckProgress;
  const bld = fighter.backLegDrive;
  const fld = fighter.frontLegDrive;
  const spreadAngleDeg = 30 + dp * 18;
  const spreadAngleRad = (spreadAngleDeg * Math.PI) / 180;
  const upperLegDx = Math.sin(spreadAngleRad) * UPPER_LEG_L * bodyWidthMult;
  const upperLegDy = Math.cos(spreadAngleRad) * UPPER_LEG_L * duckFactor;

  const rhythmBob = fighter.rhythmLevel > 0
    ? (fighter.swayOffset / 5) * 2.5 * FIGHTER_SCALE
    : Math.sin(fighter.bobPhase) * 2.5 * FIGHTER_SCALE;

  const fwdTiltFrac = 0.15;
  const duckKneeBend = dp * 8 * FIGHTER_SCALE;

  const dirBlend = Math.abs(sideView);
  const depthBlend = Math.abs(frontView);
  const quarterBlend = Math.min(dirBlend, depthBlend) * 2;

  for (let side = -1; side <= 1; side += 2) {
    const isFrontLeg = (punchDirX > 0 && side === 1) || (punchDirX <= 0 && side === -1);
    const isBackLeg = !isFrontLeg;
    const hipX = sx + side * upperLegDx * 0.5 + depthOff;

    const dirDepthOffset = side * frontView * 3 * FIGHTER_SCALE;
    const perspShift = isFrontLeg
      ? frontView * 2 * FIGHTER_SCALE
      : -frontView * 2 * FIGHTER_SCALE;

    const fwdShift = punchDirX * UPPER_LEG_L * fwdTiltFrac;

    let kneeX = hipX + side * upperLegDx * 0.5 + depthOff * 0.3 + fwdShift + side * duckKneeBend * 0.5 + dirDepthOffset + perspShift;
    let kneeY = hipY + upperLegDy;

    let kneeBendFwd = isFrontLeg
      ? punchDirX * 2 * FIGHTER_SCALE + rhythmBob * 0.2
      : -punchDirX * 6 * FIGHTER_SCALE + rhythmBob * 0.4;

    if (isBackLeg && bld > 0) {
      const driveForward = bld * 10 * FIGHTER_SCALE;
      kneeX += punchDirX * driveForward;
      kneeY += bld * 3 * FIGHTER_SCALE;
    }

    if (isFrontLeg && fld > 0) {
      const driveBackward = fld * 10 * FIGHTER_SCALE;
      kneeX -= punchDirX * driveBackward;
      kneeY += fld * 3 * FIGHTER_SCALE;
    }

    const quarterKneeShift = quarterBlend * side * 1.5 * FIGHTER_SCALE;
    kneeX += quarterKneeShift;

    let footX = kneeX + kneeBendFwd;
    let footY = baseY + bob + Math.abs(rhythmBob) * 0.3;

    if (isBackLeg && bld > 0) {
      footX += punchDirX * bld * 4 * FIGHTER_SCALE;
    }

    if (isFrontLeg && fld > 0) {
      footX -= punchDirX * fld * 4 * FIGHTER_SCALE;
    }

    const legScale = isFrontLeg
      ? 1.0 + depthBlend * 0.05
      : 1.0 - depthBlend * 0.05;
    const lineW = 5 * FIGHTER_SCALE * legScale;

    ctx.strokeStyle = critFlash ? "#ff2222" : c.skin;
    ctx.lineWidth = lineW;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(hipX, hipY);
    ctx.lineTo(kneeX, kneeY);
    ctx.stroke();

    const trunkEndX = hipX + (kneeX - hipX) * 0.95;
    const trunkEndY = hipY + (kneeY - hipY) * 0.95;
    ctx.strokeStyle = critFlash ? "#cc1111" : c.trunks;
    ctx.lineWidth = lineW + 2 * FIGHTER_SCALE;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(hipX, hipY);
    ctx.lineTo(trunkEndX, trunkEndY);
    ctx.stroke();

    const trunkBandW = 1.5 * FIGHTER_SCALE;
    ctx.strokeStyle = critFlash ? "#aa0000" : shadeColor(c.trunks, 30);
    ctx.lineWidth = trunkBandW;
    ctx.beginPath();
    ctx.moveTo(trunkEndX - (lineW + 2 * FIGHTER_SCALE) * 0.4, trunkEndY);
    ctx.lineTo(trunkEndX + (lineW + 2 * FIGHTER_SCALE) * 0.4, trunkEndY);
    ctx.stroke();

    ctx.strokeStyle = critFlash ? "#ff2222" : c.skin;
    ctx.lineWidth = lineW;
    ctx.beginPath();
    ctx.moveTo(kneeX, kneeY);
    ctx.lineTo(footX, footY);
    ctx.stroke();

    const kneeSize = 3 * FIGHTER_SCALE * legScale;
    ctx.fillStyle = critFlash ? "#aa0000" : c.skin;
    ctx.beginPath();
    ctx.arc(kneeX, kneeY, kneeSize, 0, Math.PI * 2);
    ctx.fill();

    const shoeW = 7 * FIGHTER_SCALE * legScale;
    const shoeH = 3 * FIGHTER_SCALE * legScale;
    const shoeAngle = Math.atan2(0, punchDirX);
    ctx.fillStyle = critFlash ? "#cc1111" : c.shoes;
    ctx.save();
    ctx.translate(footX, footY);
    ctx.rotate(shoeAngle);
    ctx.beginPath();
    ctx.rect(-shoeW * 0.3, -shoeH * 0.5, shoeW, shoeH);
    ctx.fill();
    ctx.restore();
  }

}

function drawArms(
  ctx: CanvasRenderingContext2D,
  fighter: FighterState,
  bodyX: number, shoulderY: number,
  sideView: number, frontView: number, bodyWidthMult: number,
  bob: number,
  punchDirX: number, punchDirY: number, punchDist: number,
  critFlash: boolean,
  weaveGloveOX: number = 0, weaveGloveOY: number = 0
): void {
  const c = fighter.colors;
  const guardUp = fighter.defenseState === "fullGuard";
  const isDucking = fighter.defenseState === "duck";

  const shoulderSpread = 8 * FIGHTER_SCALE * bodyWidthMult;
  const depthOff = frontView * 4;
  const fullArmReach = (UPPER_ARM_L + FOREARM_L) * 2.0;
  const fwdOffX = punchDirX * 4 * FIGHTER_SCALE;
  const fwdOffY = punchDirY * 2 * FIGHTER_SCALE;

  for (let side = -1; side <= 1; side += 2) {
    const isLeft = side === -1;
    const shoulderX = bodyX + side * shoulderSpread * 0.5 + depthOff;
    const sY = shoulderY + 3 * FIGHTER_SCALE;

    let elbowX: number, elbowY: number;
    let gloveX: number, gloveY: number;

    const isPunchingSide = fighter.isPunching && fighter.currentPunch && (
      (isLeft && (fighter.currentPunch === "jab" || fighter.currentPunch === "leftHook" || fighter.currentPunch === "leftUppercut")) ||
      (!isLeft && (fighter.currentPunch === "cross" || fighter.currentPunch === "rightHook" || fighter.currentPunch === "rightUppercut"))
    );

    if (isPunchingSide && fighter.currentPunch) {
      const progress = fighter.punchProgress || 0;
      const isHook = fighter.currentPunch.includes("Hook");
      const isUppercut = fighter.currentPunch.includes("Uppercut");

      const hookReachMult = 0.8;
      const uppercutReachMult = 0.6;
      const reachMult = isHook ? hookReachMult : isUppercut ? uppercutReachMult : 1.0;
      const targetReach = Math.min(fullArmReach * reachMult, punchDist * 0.95);
      const reachAtProgress = targetReach * progress;

      if (isHook) {
        const arcT = Math.sin(progress * Math.PI);
        const upwardArc = -arcT * 12 * FIGHTER_SCALE / 65;
        const perpX = -punchDirY;

        gloveX = shoulderX + punchDirX * reachAtProgress + perpX * arcT * side * 8 * FIGHTER_SCALE / 65;
        gloveY = sY + upwardArc + bob;
        elbowX = shoulderX + (gloveX - shoulderX) * 0.45 + perpX * side * 4 * FIGHTER_SCALE / 65;
        elbowY = sY + (gloveY - sY) * 0.5 + 2 * FIGHTER_SCALE + bob;
      } else if (isUppercut) {
        const arcT = Math.sin(progress * Math.PI);
        const downDip = arcT * (1 - progress) * 10 * FIGHTER_SCALE / 65;
        const upRise = progress * progress * 20 * FIGHTER_SCALE / 65;

        gloveX = shoulderX + punchDirX * reachAtProgress * 0.7;
        gloveY = sY + downDip - upRise + bob;
        elbowX = shoulderX + (gloveX - shoulderX) * 0.5;
        elbowY = sY + (gloveY - sY) * 0.4 + 4 * FIGHTER_SCALE + bob;
      } else {
        gloveX = shoulderX + punchDirX * reachAtProgress;
        gloveY = sY + punchDirY * reachAtProgress * 0.4 - 5 * FIGHTER_SCALE + bob;
        elbowX = shoulderX + punchDirX * reachAtProgress * 0.5;
        elbowY = sY + punchDirY * reachAtProgress * 0.3 + 4 * FIGHTER_SCALE + bob;
      }
    } else {
      const downElbowX = shoulderX + side * 5 * FIGHTER_SCALE * bodyWidthMult + fwdOffX * 0.4;
      const downElbowY = sY + UPPER_ARM_L * 0.7 + bob + fwdOffY * 0.3;
      const downGloveX = shoulderX + side * 2 * bodyWidthMult + fwdOffX;
      const downGloveY = sY + UPPER_ARM_L * 0.3 + bob + fwdOffY;

      const upElbowX = shoulderX + side * 4 * FIGHTER_SCALE * bodyWidthMult + fwdOffX * 0.7;
      const upElbowY = sY + 6 * FIGHTER_SCALE + bob + fwdOffY * 0.5;
      const upGloveX = shoulderX + fwdOffX * 1.8 + side * 2 * FIGHTER_SCALE * bodyWidthMult;
      const guardLift = 2 * FIGHTER_SCALE * 1.05 + 15;
      let upGloveY = sY - guardLift + bob + fwdOffY;
      let upElbowYFinal = upElbowY;

      const duckHasGuard = isDucking && fighter.preDuckBlockState !== null;
      const gb = duckHasGuard ? fighter.guardBlend : (isDucking ? 1.0 : fighter.guardBlend);
      elbowX = downElbowX + (upElbowX - downElbowX) * gb;
      elbowY = downElbowY + (upElbowY - downElbowY) * gb;
      gloveX = downGloveX + (upGloveX - downGloveX) * gb;
      gloveY = downGloveY + (upGloveY - downGloveY) * gb;

      if (fighter.telegraphPhase === "down" || fighter.telegraphPhase === "up") {
        const half = fighter.telegraphDuration * 0.5;
        let tProg: number;
        if (fighter.telegraphPhase === "down") {
          tProg = half > 0 ? Math.min(1, fighter.telegraphTimer / half) : 1;
        } else {
          tProg = half > 0 ? Math.min(1, (fighter.telegraphTimer - half) / half) : 1;
        }
        const slideOffset = fighter.telegraphPhase === "down" ? tProg * 20 : (1 - tProg) * 20;
        gloveY += slideOffset;
        elbowY += slideOffset * 0.5;
      }

      if (fighter.telegraphPhase !== "none" && fighter.telegraphPunchType) {
        const tPunch = fighter.telegraphPunchType;
        const isTelegraphLeft = tPunch === "jab" || tPunch === "leftHook" || tPunch === "leftUppercut";
        const isTelegraphRight = tPunch === "cross" || tPunch === "rightHook" || tPunch === "rightUppercut";
        if ((isLeft && isTelegraphLeft) || (!isLeft && isTelegraphRight)) {
          const tDur = fighter.telegraphDuration;
          const tT = fighter.telegraphTimer;
          const tProg = tDur > 0 ? tT / tDur : 1;
          if (tProg >= 0.75) {
            const vibWindow = tDur * 0.25;
            const vibT = tT - tDur * 0.75;
            const freq = vibWindow > 0 ? (vibT / vibWindow) * Math.PI * 2 * 6 : 0;
            const vibrate = Math.sin(freq) * 3;
            gloveX += vibrate;
            elbowX += vibrate * 0.4;
          }
        }
      }
    }

    gloveX += weaveGloveOX;
    gloveY += weaveGloveOY;
    elbowX += weaveGloveOX * 0.5;
    elbowY += weaveGloveOY * 0.5;

    ctx.strokeStyle = critFlash ? "#ff2222" : c.skin;
    ctx.lineWidth = 4 * FIGHTER_SCALE;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(shoulderX, sY);
    ctx.lineTo(elbowX, elbowY);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(elbowX, elbowY);
    ctx.lineTo(gloveX, gloveY);
    ctx.stroke();

    ctx.fillStyle = critFlash ? "#aa0000" : c.skin;
    ctx.beginPath();
    ctx.arc(elbowX, elbowY, 2.5 * FIGHTER_SCALE, 0, Math.PI * 2);
    ctx.fill();

    const blockFlash = fighter.blockFlashTimer > 0;
    const gloveColor = critFlash ? "#ff3333" : blockFlash ? "#ffffff" : telegraphGloveColor(fighter);
    ctx.fillStyle = gloveColor;
    ctx.beginPath();
    ctx.arc(gloveX, gloveY, GLOVE_R, 0, Math.PI * 2);
    ctx.fill();

    if (!critFlash && !blockFlash) {
      ctx.strokeStyle = c.gloveTape || "rgba(255,255,255,0.3)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(gloveX, gloveY, GLOVE_R * 0.7, -0.5, 1.5);
      ctx.stroke();
    }
  }
}

function drawKnockedDownFighter(ctx: CanvasRenderingContext2D, fighter: FighterState, screenPt: ScreenPt, state: GameState): void {
  const c = fighter.colors;
  const sx = screenPt.sx;
  const baseY = screenPt.sy;

  ctx.save();
  ctx.globalAlpha = 0.85;

  const angle = fighter.facingAngle - currentCameraYaw;
  const lyingDir = Math.sin(angle);

  if (state.kdTakeKnee && state.kdIsBodyShot) {
    ctx.fillStyle = "rgba(0,0,0,0.2)";
    ctx.beginPath();
    ctx.ellipse(sx, baseY + 2, 18 * FIGHTER_SCALE * 0.6, 8 * FIGHTER_SCALE * 0.4, 0, 0, Math.PI * 2);
    ctx.fill();

    const kneeDropY = BODY_H * 0.45;
    const torsoTopY = baseY - BODY_H + kneeDropY;
    const headY = torsoTopY - HEAD_R * 0.7;

    const kneeSpread = 10 * FIGHTER_SCALE;
    ctx.strokeStyle = c.trunks;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(sx - kneeSpread * 0.5, baseY - kneeDropY * 0.5);
    ctx.lineTo(sx - kneeSpread, baseY);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(sx + kneeSpread * 0.5, baseY - kneeDropY * 0.5);
    ctx.lineTo(sx + kneeSpread * 0.3, baseY + 2);
    ctx.stroke();

    ctx.fillStyle = c.shoes;
    ctx.beginPath();
    ctx.arc(sx - kneeSpread, baseY + 2, 3 * FIGHTER_SCALE, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(sx + kneeSpread * 0.3, baseY + 4, 3 * FIGHTER_SCALE, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = c.trunks;
    ctx.beginPath();
    ctx.ellipse(sx, (torsoTopY + baseY - kneeDropY * 0.5) / 2, 9 * FIGHTER_SCALE, BODY_H * 0.35, 0, 0, Math.PI * 2);
    ctx.fill();

    const armDangle = 6;
    ctx.fillStyle = c.gloves;
    ctx.beginPath();
    ctx.arc(sx - 10, torsoTopY + BODY_H * 0.5 + armDangle, GLOVE_R, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(sx + 10, torsoTopY + BODY_H * 0.5 + armDangle, GLOVE_R, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = c.skin;
    ctx.beginPath();
    ctx.arc(sx, headY, HEAD_R, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.fillStyle = "rgba(0,0,0,0.2)";
    ctx.beginPath();
    ctx.ellipse(sx, baseY, 30 * FIGHTER_SCALE * 0.6, 8 * FIGHTER_SCALE * 0.4, lyingDir * 0.3, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = c.trunks;
    ctx.beginPath();
    ctx.ellipse(sx, baseY - 5, TORSO_W * 0.8, BODY_H * 0.25, lyingDir * 0.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = c.skin;
    const headX = sx + lyingDir * 22 * FIGHTER_SCALE * 0.5;
    ctx.beginPath();
    ctx.arc(headX, baseY - 7, HEAD_R, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = c.gloves;
    ctx.beginPath();
    ctx.arc(sx - lyingDir * 12, baseY - 3, GLOVE_R, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(sx + lyingDir * 6, baseY - 9, GLOVE_R, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = c.shoes;
    const feetX = sx - lyingDir * 20 * FIGHTER_SCALE * 0.5;
    ctx.beginPath();
    ctx.arc(feetX - 6, baseY + 1, 3.5 * FIGHTER_SCALE, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(feetX + 6, baseY + 1, 3.5 * FIGHTER_SCALE, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

function drawStanceIndicator(ctx: CanvasRenderingContext2D, x: number, y: number, stance: string): void {
  if (stance === "neutral") return;
  ctx.save();
  ctx.font = "9px 'Oxanium', sans-serif";
  ctx.textAlign = "center";
  ctx.fillStyle = stance === "frontFoot" ? "rgba(255, 150, 50, 0.7)" : "rgba(100, 200, 255, 0.7)";
  ctx.fillText(stance === "frontFoot" ? "FRONT" : "BACK", x, y);
  ctx.restore();
}

function drawTowelAnimation(ctx: CanvasRenderingContext2D, state: GameState): void {
  const progress = 1 - (state.towelTimer / 1.0);
  const startX = CANVAS_W - 30;
  const startY = 100;
  const endX = CANVAS_W / 2;
  const endY = CANVAS_H / 2 - 40;

  const x = startX + (endX - startX) * progress;
  const arcHeight = -120 * Math.sin(progress * Math.PI);
  const y = startY + (endY - startY) * progress + arcHeight;
  const rotation = progress * Math.PI * 2;
  const size = 14 + progress * 6;

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rotation);

  ctx.fillStyle = "#ffffff";
  ctx.shadowColor = "rgba(0,0,0,0.3)";
  ctx.shadowBlur = 4;
  ctx.beginPath();
  ctx.moveTo(-size, -size * 0.6);
  ctx.lineTo(size, -size * 0.4);
  ctx.lineTo(size * 0.8, size * 0.6);
  ctx.lineTo(-size * 0.7, size * 0.5);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = "#dddddd";
  ctx.lineWidth = 0.5;
  ctx.stroke();

  ctx.restore();
}

function drawStoppageOverlay(ctx: CanvasRenderingContext2D, state: GameState): void {
  ctx.save();

  ctx.fillStyle = "rgba(0,0,0,0.3)";
  ctx.fillRect(0, CANVAS_H / 2 - 40, CANVAS_W, 80);

  ctx.fillStyle = "#ff3333";
  ctx.font = "bold 32px 'Oxanium', sans-serif";
  ctx.textAlign = "center";

  const label = state.refStoppageType === "towel" ? "TOWEL STOPPAGE" : "REFEREE STOPPAGE";
  ctx.fillText(label, CANVAS_W / 2, CANVAS_H / 2 + 5);

  ctx.fillStyle = "rgba(255,255,255,0.7)";
  ctx.font = "14px 'Oxanium', sans-serif";
  ctx.fillText("THE FIGHT HAS BEEN STOPPED", CANVAS_W / 2, CANVAS_H / 2 + 28);

  ctx.restore();
}

function drawHitEffects(ctx: CanvasRenderingContext2D, effects: HitEffect[]): void {
  effects.forEach(e => {
    const alpha = Math.min(1, e.timer * 2);
    const rise = (0.6 - e.timer) * 30;
    const pt = projectToScreen(e.x, e.y);
    ctx.save();
    ctx.globalAlpha = alpha;

    if (e.type === "crit") {
      ctx.fillStyle = "#ff4444";
      ctx.font = "bold 20px 'Oxanium', sans-serif";
    } else if (e.type === "block") {
      ctx.fillStyle = "#6688ff";
      ctx.font = "bold 15px 'Oxanium', sans-serif";
    } else if (e.type === "feint") {
      ctx.fillStyle = "#aaaaff";
      ctx.font = "italic 14px 'Oxanium', sans-serif";
    } else {
      ctx.fillStyle = "#ffcc44";
      ctx.font = "bold 16px 'Oxanium', sans-serif";
    }

    ctx.textAlign = "center";
    ctx.fillText(e.text, pt.sx, pt.sy - rise - 30);
    ctx.restore();
  });
}

function drawReferee(ctx: CanvasRenderingContext2D, state: GameState): void {
  const refWorldX = state.refX;
  const refWorldZ = state.refZ;
  const refPt = projectToScreen(refWorldX, refWorldZ);

  const S = 0.9;
  const bodyH = BODY_H * S;
  const headR = HEAD_R * S;
  const armLen = 18 * FIGHTER_SCALE * S;
  const legLen = 16 * FIGHTER_SCALE * S;
  const jointR = 3 * FIGHTER_SCALE * S;

  const baseY = refPt.sy;
  const torsoTop = baseY - bodyH;
  const headY = torsoTop - headR;
  const hipY = baseY;
  const shoulderY = torsoTop + bodyH * 0.15;

  const knockedFighter = state.player.isKnockedDown ? state.player : state.enemy;
  const facingDir = refWorldX < knockedFighter.x ? 1 : -1;

  ctx.save();

  ctx.fillStyle = "rgba(0,0,0,0.12)";
  ctx.beginPath();
  ctx.ellipse(refPt.sx, baseY + 2, 12 * S, 6 * S, 0, 0, Math.PI * 2);
  ctx.fill();

  const legSpread = 8 * S;
  ctx.strokeStyle = "#222222";
  ctx.lineWidth = 3.5 * S;
  const kneeYL = hipY + legLen * 0.55;
  const kneeYR = hipY + legLen * 0.55;
  ctx.beginPath();
  ctx.moveTo(refPt.sx - legSpread * facingDir, hipY);
  ctx.lineTo(refPt.sx - legSpread * facingDir * 1.3, kneeYL);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(refPt.sx + legSpread * facingDir, hipY);
  ctx.lineTo(refPt.sx + legSpread * facingDir * 1.3, kneeYR);
  ctx.stroke();

  ctx.fillStyle = "#111111";
  ctx.beginPath();
  ctx.arc(refPt.sx - legSpread * facingDir * 1.3, kneeYL, jointR * 0.8, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(refPt.sx + legSpread * facingDir * 1.3, kneeYR, jointR * 0.8, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.ellipse(refPt.sx, (torsoTop + hipY) / 2, 9 * S, bodyH * 0.5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#cccccc";
  ctx.lineWidth = 1;
  ctx.stroke();

  const isWavingOff = state.refStoppageActive;
  const armExt = isWavingOff ? 14 * S : 6 * S;
  const armUpL = isWavingOff ? -armLen * 0.8 : armLen * 0.3;
  const armUpR = isWavingOff ? -armLen * 0.8 : armLen * 0.3;

  ctx.strokeStyle = "#d4a574";
  ctx.lineWidth = 3 * S;
  ctx.beginPath();
  ctx.moveTo(refPt.sx - 8 * S * facingDir, shoulderY);
  ctx.lineTo(refPt.sx - armExt * facingDir, shoulderY + armUpL);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(refPt.sx + 8 * S * facingDir, shoulderY);
  ctx.lineTo(refPt.sx + armExt * facingDir, shoulderY + armUpR);
  ctx.stroke();

  ctx.fillStyle = "#d4a574";
  ctx.beginPath();
  ctx.arc(refPt.sx - armExt * facingDir, shoulderY + armUpL, jointR * 0.7, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(refPt.sx + armExt * facingDir, shoulderY + armUpR, jointR * 0.7, 0, Math.PI * 2);
  ctx.fill();

  const headLeanFwd = bodyH * 0.08;
  const headLeanX = refPt.sx + facingDir * headLeanFwd;
  ctx.fillStyle = "#d4a574";
  ctx.beginPath();
  ctx.arc(headLeanX, headY, headR, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

function getBlockLabel(fighter: FighterState): { label: string; color: string } {
  if (fighter.defenseState === "fullGuard") return { label: "FULL GUARD", color: "rgba(100, 200, 255, 0.8)" };
  if (fighter.defenseState === "duck") return { label: "DUCKING", color: "rgba(200, 180, 255, 0.8)" };
  return { label: "OPEN", color: "rgba(255, 255, 255, 0.35)" };
}

function drawHUD(ctx: CanvasRenderingContext2D, state: GameState): void {
  const barW = 260;
  const barH = 18;
  const padding = 15;
  const hudH = 70;
  const hudTop = CANVAS_H - hudH;
  const barY = hudTop + 15;

  ctx.fillStyle = "rgba(0,0,0,0.5)";
  ctx.fillRect(0, hudTop, CANVAS_W, hudH);

  drawStaminaBar(ctx, padding, barY, barW, barH, state.player, true);
  drawStaminaBar(ctx, CANVAS_W - padding - barW, barY, barW, barH, state.enemy, false);

  const sqSize = 12;
  const sqGap = 3;
  const sqY = barY + (barH - sqSize) / 2;

  const pSqX = padding + barW + sqGap;
  ctx.fillStyle = state.player.colors.gloves;
  ctx.fillRect(pSqX, sqY, sqSize, sqSize);
  ctx.strokeStyle = "rgba(255,255,255,0.4)";
  ctx.lineWidth = 1;
  ctx.strokeRect(pSqX, sqY, sqSize, sqSize);

  ctx.fillStyle = state.player.colors.trunks;
  ctx.fillRect(pSqX + sqSize + 2, sqY, sqSize, sqSize);
  ctx.strokeRect(pSqX + sqSize + 2, sqY, sqSize, sqSize);

  const eSqX = CANVAS_W - padding - barW - sqGap - sqSize * 2 - 2;
  ctx.fillStyle = state.enemy.colors.gloves;
  ctx.fillRect(eSqX, sqY, sqSize, sqSize);
  ctx.strokeRect(eSqX, sqY, sqSize, sqSize);

  ctx.fillStyle = state.enemy.colors.trunks;
  ctx.fillRect(eSqX + sqSize + 2, sqY, sqSize, sqSize);
  ctx.strokeRect(eSqX + sqSize + 2, sqY, sqSize, sqSize);

  const cmY = barY + barH + 3;
  const cmH = 6;
  drawChargeMeter(ctx, padding, cmY, barW, cmH, state.player, true);
  drawChargeMeter(ctx, CANVAS_W - padding - barW, cmY, barW, cmH, state.enemy, false);

  ctx.font = "bold 11px 'Oxanium', sans-serif";
  ctx.textAlign = "left";
  const playerNameText = `${state.player.name} (LV ${state.player.level})`;
  if (state.midFightLevelUps > 0) {
    const nameOnly = `${state.player.name} (LV `;
    const levelOnly = `${state.player.level}`;
    const closeParen = `)`;
    ctx.fillStyle = "#ffffff";
    ctx.fillText(nameOnly, padding, barY - 4);
    const nameW = ctx.measureText(nameOnly).width;
    ctx.fillStyle = "#22cc44";
    ctx.fillText(levelOnly, padding + nameW, barY - 4);
    const lvW = ctx.measureText(levelOnly).width;
    ctx.fillStyle = "#ffffff";
    ctx.fillText(closeParen, padding + nameW + lvW, barY - 4);
  } else {
    ctx.fillStyle = "#ffffff";
    ctx.fillText(playerNameText, padding, barY - 4);
  }
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "right";
  ctx.fillText(`${state.enemy.name} (LV ${state.enemy.level})`, CANVAS_W - padding, barY - 4);

  ctx.textAlign = "center";
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 14px 'Oxanium', sans-serif";
  const roundText = `R${state.currentRound}`;
  ctx.fillText(roundText, CANVAS_W / 2, barY - 2);

  const minutes = Math.floor(state.roundTimer / 60);
  const seconds = Math.floor(state.roundTimer % 60);
  const timeStr = `${minutes}:${seconds.toString().padStart(2, "0")}`;
  ctx.font = "bold 20px 'Oxanium', sans-serif";
  ctx.fillStyle = state.roundTimer < 10 ? "#ff4444" : "#ffffff";
  ctx.fillText(timeStr, CANVAS_W / 2, barY + 18);

  ctx.font = "10px 'Oxanium', sans-serif";
  ctx.fillStyle = "rgba(255,255,255,0.5)";
  ctx.textAlign = "center";
  ctx.fillText(`KD: ${state.player.knockdowns}`, CANVAS_W / 2 - 35, barY + 35);
  ctx.fillText(`KD: ${state.enemy.knockdowns}`, CANVAS_W / 2 + 35, barY + 35);

  if (state.player.defenseState === "fullGuard") {
    ctx.fillStyle = "rgba(100, 150, 255, 0.8)";
    ctx.font = "bold 9px 'Oxanium', sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("FULL GUARD", padding, barY + 35);
    const remaining = Math.max(0, state.player.maxBlockDuration - state.player.blockTimer);
    ctx.fillStyle = "rgba(255,255,255,0.4)";
    ctx.font = "7px 'Oxanium', sans-serif";
    ctx.fillText(`${Math.ceil(remaining)}s`, padding + 60, barY + 35);
  }

  const rhythmW = 50;
  const rhythmY = barY + 42;
  const rhythmLevel = state.player.rhythmLevel;
  const rhythmProgress = state.player.rhythmProgress;

  ctx.fillStyle = "rgba(255,255,255,0.1)";
  ctx.fillRect(padding, rhythmY, rhythmW, 6);

  if (rhythmLevel > 0) {
    const beginEnd = rhythmW * 0.4;
    const midStart = rhythmW * 0.4;
    const midEnd = rhythmW * 0.6;
    const endStart = rhythmW * 0.6;

    ctx.fillStyle = "rgba(100, 180, 255, 0.2)";
    ctx.fillRect(padding, rhythmY, beginEnd, 6);
    ctx.fillStyle = "rgba(100, 255, 100, 0.2)";
    ctx.fillRect(padding + midStart, rhythmY, midEnd - midStart, 6);
    ctx.fillStyle = "rgba(255, 180, 100, 0.2)";
    ctx.fillRect(padding + endStart, rhythmY, rhythmW - endStart, 6);

    const markerX = padding + rhythmProgress * rhythmW;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(markerX - 1, rhythmY - 1, 2, 8);

    ctx.font = "7px 'Oxanium', sans-serif";
    ctx.textAlign = "left";
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.fillText(`R${rhythmLevel}`, padding + rhythmW + 3, rhythmY + 5);

  } else {
    ctx.font = "7px 'Oxanium', sans-serif";
    ctx.textAlign = "left";
    ctx.fillStyle = "rgba(255,255,255,0.3)";
    ctx.fillText("R0", padding + rhythmW + 3, rhythmY + 5);
  }

  if (state.player.punchPhase === "retraction" && state.player.retractionProgress >= 0.75) {
    ctx.fillStyle = "rgba(255, 220, 100, 0.7)";
    ctx.font = "bold 8px 'Oxanium', sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("RE-PUNCH!", padding, rhythmY + 16);
  }

  drawPauseButton(ctx);
}

function drawStaminaBar(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, fighter: FighterState, isPlayer: boolean): void {
  ctx.fillStyle = COLORS.staminaBg;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 3);
  ctx.fill();

  const frac = Math.max(0, fighter.stamina / fighter.maxStamina);
  const fillColor = frac > 0.5 ? "#22aa44" : (frac > 0.15 ? "#ccaa22" : "#cc2222");

  const grad = ctx.createLinearGradient(x, y, x, y + h);
  grad.addColorStop(0, fillColor);
  grad.addColorStop(1, shadeColor(fillColor, -30));
  ctx.fillStyle = grad;

  const fillW = w * frac;
  const fillX = isPlayer ? x : x + w - fillW;
  ctx.beginPath();
  ctx.roundRect(fillX, y, fillW, h, 3);
  ctx.fill();

  ctx.strokeStyle = "rgba(255,255,255,0.15)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 3);
  ctx.stroke();

  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.font = "bold 10px 'Oxanium', sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(`${Math.round(fighter.stamina)}/${Math.round(fighter.maxStamina)}`, x + w / 2, y + h - 4);
}

function drawChargeMeter(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, fighter: FighterState, isPlayer: boolean): void {
  const maxBars = 6;
  const gap = 2;
  const segW = (w - gap * (maxBars - 1)) / maxBars;

  for (let i = 0; i < maxBars; i++) {
    const segX = isPlayer ? x + i * (segW + gap) : x + w - (i + 1) * segW - i * gap;
    const filled = i < fighter.chargeMeterBars;
    const partial = i === fighter.chargeMeterBars ? fighter.chargeMeterCounters / 30 : 0;

    ctx.fillStyle = "rgba(0,0,0,0.4)";
    ctx.fillRect(segX, y, segW, h);

    if (filled) {
      const empowered = fighter.chargeEmpoweredTimer > 0;
      const grad = ctx.createLinearGradient(segX, y, segX, y + h);
      grad.addColorStop(0, empowered ? "#ffcc00" : "#3388ff");
      grad.addColorStop(1, empowered ? "#ff8800" : "#1155cc");
      ctx.fillStyle = grad;
      ctx.fillRect(segX, y, segW, h);
    } else if (partial > 0) {
      const fillW = segW * partial;
      const partX = isPlayer ? segX : segX + segW - fillW;
      ctx.fillStyle = "rgba(51,136,255,0.5)";
      ctx.fillRect(partX, y, fillW, h);
    }
  }
}

function drawCountdown(ctx: CanvasRenderingContext2D, timer: number): void {
  const count = Math.ceil(timer);
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.4)";
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  const frac = timer - Math.floor(timer);
  const scale = 1 + frac * 0.5;

  ctx.translate(CANVAS_W / 2, CANVAS_H / 2 - 30);
  ctx.scale(scale, scale);

  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 72px 'Oxanium', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.globalAlpha = 0.5 + frac * 0.5;
  ctx.fillText(count <= 0 ? "FIGHT!" : count.toString(), 0, 0);
  ctx.restore();
}

function drawKnockdownOverlay(ctx: CanvasRenderingContext2D, state: GameState): void {
  ctx.save();

  ctx.font = "18px 'Oxanium', sans-serif";
  ctx.fillStyle = "#cccccc";
  ctx.textAlign = "center";
  ctx.fillText("KNOCKDOWN!", CANVAS_W / 2, 30);

  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 64px 'Oxanium', sans-serif";
  ctx.fillText(state.knockdownRefCount.toString(), CANVAS_W / 2, 80);

  const knockedFighter = state.player.isKnockedDown ? state.player : state.enemy;
  if (knockedFighter.isPlayer) {
    ctx.font = "16px 'Oxanium', sans-serif";
    ctx.fillStyle = "#ffcc00";
    const kdTextY = 120;
    ctx.fillText(`MASH SPACE! ${state.knockdownMashCount} / ${state.knockdownMashRequired}`, CANVAS_W / 2, kdTextY);

    const barW = 200;
    const barH = 10;
    const barX = CANVAS_W / 2 - barW / 2;
    const barFY = kdTextY + 10;
    ctx.fillStyle = "rgba(255,255,255,0.2)";
    ctx.fillRect(barX, barFY, barW, barH);
    const progress = Math.min(1, state.knockdownMashCount / state.knockdownMashRequired);
    ctx.fillStyle = "#00ff88";
    ctx.fillRect(barX, barFY, barW * progress, barH);
  }

  ctx.restore();
}

const PAUSE_BTN_X = CANVAS_W - 35;
const PAUSE_BTN_Y = 10;
const PAUSE_BTN_SIZE = 24;

function drawPauseButton(ctx: CanvasRenderingContext2D): void {
  ctx.save();
  ctx.fillStyle = "rgba(255,255,255,0.3)";
  ctx.beginPath();
  ctx.roundRect(PAUSE_BTN_X, PAUSE_BTN_Y, PAUSE_BTN_SIZE, PAUSE_BTN_SIZE, 4);
  ctx.fill();

  ctx.fillStyle = "rgba(255,255,255,0.8)";
  const barW = 4;
  const barH = 12;
  const gap = 3;
  const cx = PAUSE_BTN_X + PAUSE_BTN_SIZE / 2;
  const cy = PAUSE_BTN_Y + PAUSE_BTN_SIZE / 2;
  ctx.fillRect(cx - gap - barW, cy - barH / 2, barW, barH);
  ctx.fillRect(cx + gap, cy - barH / 2, barW, barH);
  ctx.restore();
}

export function isPauseButtonClick(x: number, y: number): boolean {
  return x >= PAUSE_BTN_X && x <= PAUSE_BTN_X + PAUSE_BTN_SIZE &&
    y >= PAUSE_BTN_Y && y <= PAUSE_BTN_Y + PAUSE_BTN_SIZE;
}

const PAUSE_MENU_ITEM_W = 200;
const PAUSE_MENU_ITEM_H = 30;
const PAUSE_MENU_START_Y = CANVAS_H / 2 - 25;
const PAUSE_MENU_SPACING = 36;
const PAUSE_MENU_ITEMS_FULL = ["Resume", "Controls", "Sound", "Restart", "Quit"];
const PAUSE_MENU_ITEMS_CAREER = ["Resume", "Controls", "Sound", "Quit"];

function getPauseItems(isCareer: boolean, state?: GameState): string[] {
  if (state?.tutorialMode) {
    return ["Restart Tutorial", "Quit"];
  }
  if (state?.practiceMode) {
    return [
      "Resume",
      `CPU Attacks: ${state.cpuAttacksEnabled ? "ON" : "OFF"}`,
      `CPU Defense: ${state.cpuDefenseEnabled ? "ON" : "OFF"}`,
      "Controls",
      "Sound",
      "Restart",
      "Quit",
    ];
  }
  return isCareer ? PAUSE_MENU_ITEMS_CAREER : PAUSE_MENU_ITEMS_FULL;
}

const SOUND_SLIDER_W = 200;
const SOUND_SLIDER_H = 8;
const SOUND_SLIDER_X = CANVAS_W / 2 - SOUND_SLIDER_W / 2;
const SOUND_CATEGORIES: { label: string; key: "master" | "sfx" | "crowd" | "ui" }[] = [
  { label: "Master", key: "master" },
  { label: "SFX", key: "sfx" },
  { label: "Crowd", key: "crowd" },
  { label: "UI", key: "ui" },
];
const SOUND_SLIDER_START_Y = CANVAS_H / 2 - 60;
const SOUND_SLIDER_SPACING = 50;

export function getPauseMenuClickIndex(x: number, y: number, isCareer: boolean = false, state?: GameState): number {
  const items = getPauseItems(isCareer, state);
  for (let i = 0; i < items.length; i++) {
    const itemY = PAUSE_MENU_START_Y + i * PAUSE_MENU_SPACING;
    const left = CANVAS_W / 2 - PAUSE_MENU_ITEM_W / 2;
    if (x >= left && x <= left + PAUSE_MENU_ITEM_W &&
      y >= itemY - PAUSE_MENU_ITEM_H / 2 && y <= itemY + PAUSE_MENU_ITEM_H / 2) {
      return i;
    }
  }
  return -1;
}

export function getSoundSliderClick(x: number, y: number): { key: "master" | "sfx" | "crowd" | "ui"; value: number } | null {
  for (let i = 0; i < SOUND_CATEGORIES.length; i++) {
    const sliderY = SOUND_SLIDER_START_Y + i * SOUND_SLIDER_SPACING + 20;
    if (x >= SOUND_SLIDER_X && x <= SOUND_SLIDER_X + SOUND_SLIDER_W &&
      y >= sliderY - 12 && y <= sliderY + 12) {
      const value = Math.max(0, Math.min(1, (x - SOUND_SLIDER_X) / SOUND_SLIDER_W));
      return { key: SOUND_CATEGORIES[i].key, value };
    }
  }
  const muteY = SOUND_SLIDER_START_Y + SOUND_CATEGORIES.length * SOUND_SLIDER_SPACING + 10;
  const muteW = 120;
  const muteLeft = CANVAS_W / 2 - muteW / 2;
  if (x >= muteLeft && x <= muteLeft + muteW && y >= muteY - 15 && y <= muteY + 15) {
    return { key: "master", value: -1 };
  }
  const backY = muteY + 45;
  const backW = 120;
  const backLeft = CANVAS_W / 2 - backW / 2;
  if (x >= backLeft && x <= backLeft + backW && y >= backY - 15 && y <= backY + 15) {
    return { key: "master", value: -2 };
  }
  return null;
}

function drawControlsOverlay(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 28px 'Oxanium', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("CONTROLS", CANVAS_W / 2, 50);

  const controls: [string, string][] = [
    ["Move", "Arrow Keys"],
    ["Duck", "Shift"],
    ["Jab", "W"],
    ["Cross", "E"],
    ["L Hook", "Q"],
    ["R Hook", "R"],
    ["L Upper", "S"],
    ["R Upper", "D"],
    ["Body Shot", "Shift + Punch"],
    ["Charge Punch", "Hold A, Then Punch"],
    ["Feint", "F"],
    ["Full Guard", "Space x2"],
    ["Block Up/Down", "Space + Arrow"],
    ["Rhythm Up", "Tab + Right"],
    ["Rhythm Down", "Tab + Left"],
    ["Pause", "Esc"],
  ];

  const startY = 90;
  const lineH = 22;
  const colLabelX = CANVAS_W / 2 - 20;
  const colValueX = CANVAS_W / 2 + 20;

  ctx.font = "14px 'Oxanium', sans-serif";
  controls.forEach(([label, value], i) => {
    const y = startY + i * lineH;
    ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
    ctx.textAlign = "right";
    ctx.fillText(label, colLabelX, y);
    ctx.fillStyle = "#ffcc44";
    ctx.textAlign = "left";
    ctx.fillText(value, colValueX, y);
  });

  const backY = startY + controls.length * lineH + 20;
  ctx.fillStyle = "rgba(255, 255, 255, 0.8)";
  ctx.font = "bold 16px 'Oxanium', sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("[ Back ]", CANVAS_W / 2, backY);
}

export function getControlsBackClick(x: number, y: number): boolean {
  const controls = 16;
  const startY = 90;
  const lineH = 22;
  const backY = startY + controls * lineH + 20;
  const backW = 120;
  const backLeft = CANVAS_W / 2 - backW / 2;
  return x >= backLeft && x <= backLeft + backW && y >= backY - 15 && y <= backY + 15;
}

function drawPauseMenu(ctx: CanvasRenderingContext2D, selectedIndex: number, soundTab: boolean, controlsTab: boolean, isCareer: boolean = false, state?: GameState): void {
  ctx.save();
  ctx.fillStyle = "rgba(0, 0, 0, 0.75)";
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  const menuItems = getPauseItems(isCareer, state);

  if (controlsTab) {
    drawControlsOverlay(ctx);
  } else if (soundTab) {
    drawSoundControls(ctx);
  } else {
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 36px 'Oxanium', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("PAUSED", CANVAS_W / 2, CANVAS_H / 2 - 100);

    menuItems.forEach((item, i) => {
      const y = PAUSE_MENU_START_Y + i * PAUSE_MENU_SPACING;
      const isSelected = i === selectedIndex;

      if (isSelected) {
        ctx.fillStyle = "rgba(255, 200, 50, 0.15)";
        ctx.beginPath();
        ctx.roundRect(CANVAS_W / 2 - PAUSE_MENU_ITEM_W / 2, y - PAUSE_MENU_ITEM_H / 2, PAUSE_MENU_ITEM_W, PAUSE_MENU_ITEM_H, 4);
        ctx.fill();
      }

      const isToggleOn = item.endsWith(": ON");
      const isToggleOff = item.endsWith(": OFF");
      if (isSelected) {
        ctx.fillStyle = isToggleOff ? "#ff6666" : isToggleOn ? "#66ff88" : "#ffcc44";
      } else {
        ctx.fillStyle = isToggleOff ? "rgba(255, 100, 100, 0.5)" : isToggleOn ? "rgba(100, 255, 130, 0.5)" : "rgba(255, 255, 255, 0.6)";
      }
      ctx.font = isSelected ? "bold 20px 'Oxanium', sans-serif" : "18px 'Oxanium', sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(item, CANVAS_W / 2, y);
    });

    ctx.fillStyle = "rgba(255, 255, 255, 0.3)";
    ctx.font = "11px 'Oxanium', sans-serif";
    ctx.fillText("Click or use arrow keys + Enter", CANVAS_W / 2, CANVAS_H / 2 + 130);
  }

  ctx.restore();
}

function drawSoundControls(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 28px 'Oxanium', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("SOUND SETTINGS", CANVAS_W / 2, SOUND_SLIDER_START_Y - 50);

  const volumes = soundEngine.getVolumes();
  const isMuted = soundEngine.isMuted();

  SOUND_CATEGORIES.forEach((cat, i) => {
    const y = SOUND_SLIDER_START_Y + i * SOUND_SLIDER_SPACING;
    const sliderY = y + 20;
    const vol = volumes[cat.key];

    ctx.fillStyle = "rgba(255, 255, 255, 0.7)";
    ctx.font = "14px 'Oxanium', sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(cat.label, SOUND_SLIDER_X, y + 4);

    ctx.fillStyle = `rgba(255, 255, 255, ${isMuted ? 0.15 : 0.25})`;
    ctx.font = "12px 'Oxanium', sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(`${Math.round(vol * 100)}%`, SOUND_SLIDER_X + SOUND_SLIDER_W, y + 4);

    ctx.fillStyle = "rgba(255, 255, 255, 0.15)";
    ctx.beginPath();
    ctx.roundRect(SOUND_SLIDER_X, sliderY - SOUND_SLIDER_H / 2, SOUND_SLIDER_W, SOUND_SLIDER_H, 4);
    ctx.fill();

    const fillW = vol * SOUND_SLIDER_W;
    ctx.fillStyle = isMuted ? "rgba(100, 100, 100, 0.5)" : "rgba(255, 200, 50, 0.8)";
    ctx.beginPath();
    ctx.roundRect(SOUND_SLIDER_X, sliderY - SOUND_SLIDER_H / 2, fillW, SOUND_SLIDER_H, 4);
    ctx.fill();

    const knobX = SOUND_SLIDER_X + fillW;
    ctx.fillStyle = isMuted ? "#888" : "#ffcc44";
    ctx.beginPath();
    ctx.arc(knobX, sliderY, 6, 0, Math.PI * 2);
    ctx.fill();
  });

  const muteY = SOUND_SLIDER_START_Y + SOUND_CATEGORIES.length * SOUND_SLIDER_SPACING + 10;
  const muteW = 120;
  const muteLeft = CANVAS_W / 2 - muteW / 2;
  ctx.fillStyle = isMuted ? "rgba(255, 80, 80, 0.3)" : "rgba(255, 255, 255, 0.1)";
  ctx.beginPath();
  ctx.roundRect(muteLeft, muteY - 15, muteW, 30, 4);
  ctx.fill();
  ctx.fillStyle = isMuted ? "#ff6666" : "rgba(255, 255, 255, 0.7)";
  ctx.font = "14px 'Oxanium', sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(isMuted ? "UNMUTE" : "MUTE ALL", CANVAS_W / 2, muteY);

  const backY = muteY + 45;
  const backW = 120;
  const backLeft = CANVAS_W / 2 - backW / 2;
  ctx.fillStyle = "rgba(255, 200, 50, 0.15)";
  ctx.beginPath();
  ctx.roundRect(backLeft, backY - 15, backW, 30, 4);
  ctx.fill();
  ctx.fillStyle = "#ffcc44";
  ctx.font = "bold 14px 'Oxanium', sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("← BACK", CANVAS_W / 2, backY);
}

function shadeColor(color: string, percent: number): string {
  const num = parseInt(color.replace("#", ""), 16);
  if (isNaN(num)) return color;
  const r = Math.min(255, Math.max(0, (num >> 16) + percent));
  const g = Math.min(255, Math.max(0, ((num >> 8) & 0x00ff) + percent));
  const b = Math.min(255, Math.max(0, (num & 0x0000ff) + percent));
  return `rgb(${r},${g},${b})`;
}

function createPreviewFighterState(colors: FighterColors, bobPhase: number): FighterState {
  return {
    name: "",
    archetype: "BoxerPuncher",
    level: 1,
    x: RING_CX,
    z: RING_CY,
    y: 0,
    stamina: 100,
    maxStamina: 100,
    maxStaminaCap: 100,
    staminaRegen: 5,
    facing: 1,
    facingAngle: Math.PI,
    headOffset: { x: 0, y: 0 },
    leftGloveOffset: { x: 0, y: 0 },
    rightGloveOffset: { x: 0, y: 0 },
    bodyOffset: { x: 0, y: 0 },
    bobPhase,
    bobSpeed: 2.6,
    baseBobSpeed: 2.6,
    defenseState: "none",
    preDuckBlockState: null,
    guardBlend: 0,
    isPunching: false,
    currentPunch: null,
    currentPunchStaminaCost: 0,
    punchProgress: 0,
    punchCooldown: 0,
    isHit: false,
    hitTimer: 0,
    critHitTimer: 0,
    regenPauseTimer: 0,
    moveSpeed: 120,
    punchSpeedMult: 1,
    damageMult: 1,
    defenseMult: 1,
    staminaCostMult: 1,
    knockdowns: 0,
    punchesThrown: 0,
    punchesLanded: 0,
    damageDealt: 0,
    timeSinceLastLanded: 0,
    unansweredStreak: 0,
    momentumRegenBoost: 0,
    momentumRegenTimer: 0,
    isPlayer: false,
    isKnockedDown: false,
    knockdownTimer: 0,
    duckTimer: 0,
    colors,
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
    punchAimsHead: true,
    blockTimer: 0,
    maxBlockDuration: 20,
    blockRegenPenaltyTimer: 0,
    blockRegenPenaltyDuration: 0.25,
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
    stunBlockDisableTimer: 0,
    stunPunchDisableTimer: 0,
    stunPunchSlowMult: 1,
    stunPunchSlowTimer: 0,
    chargeCooldownTimer: 0,
    chargeReadyWindowTimer: 0,
    chargeReady: false,
    chargeArmed: false,
    chargeMeterCounters: 0,
    chargeMeterBars: 0,
    chargeEmpoweredTimer: 0,
    chargeMeterLockoutTimer: 0,
    chargeHoldTimer: 0,
    chargeFlashTimer: 0,
    chargeHeadOffset: 0,
    blockFlashTimer: 0,
    punchTravelStartTime: 0,
    stunBlockWeakenTimer: 0,
    chargeArmTimer: 0,
    consecutiveChargeTimer: 0,
    consecutiveChargeCount: 0,
    feintWhiffPenaltyCooldown: 0,
    retractionPenaltyMult: 1,
    armLength: 65,
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
    blinkTimer: 5,
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
    telegraphSpeedMult: 1,
    cleanHitEyeTimer: 0,
    knockdownsGiven: 0,
    cleanPunchesLanded: 0,
    feintBaits: 0,
    timeSinceLastDamageTaken: 0,
    damageTakenRegenPauseFired: false,
    kdRegenBoostActive: false,
    guardDownTimer: 0,
    guardDownSpeedBoost: 0,
    guardDownBoostTimer: 0,
    guardDownBoostMax: 0,
    chargeUsesLeft: 0,
    chargeEmpoweredDuration: 0,
    handsDownTimer: 0,
    handsDownCooldown: 0,
    feintHoldTimer: 0,
    feintTouchingOpponent: false,
    feintDuckTouchingOpponent: false,
    autoGuardActive: false,
    autoGuardTimer: 0,
    autoGuardDuration: 0,
    lastSpacePressTime: 0,
    spaceWasUp: false,
    swayPhase: 0,
    swayDir: 1 as 1 | -1,
    swayOffset: 0,
    swaySpeedLevel: 0,
    swayFrozen: false,
    telegraphSwayAnimating: false,
    telegraphSwayTarget: 0,
    swayZone: "neutral" as "power" | "offBalance" | "neutral",
    swayDamageMult: 1,
    swayTelegraphMult: 1,
    miniStunTimer: 0,
    rhythmPauseTimer: 0,
    pushbackVx: 0,
    pushbackVz: 0,
    focusT: 0,
    facingLockTimer: 0,
    weaveActive: false,
    weaveDirX: 0,
    weaveDirY: 0,
    weaveProgress: 0,
    weaveDuration: 0.18,
    weaveRecoveryTimer: 0,
    weaveCooldown: 0,
    preWeaveStance: "neutral" as any,
    weaveCounterTimer: 0,
  };
}

export function renderFighterPreview(
  ctx: CanvasRenderingContext2D,
  canvasW: number,
  canvasH: number,
  colors: FighterColors,
  bobPhase: number
): void {
  ctx.clearRect(0, 0, canvasW, canvasH);

  const savedYaw = currentCameraYaw;
  currentCameraYaw = 0;

  const fighter = createPreviewFighterState(colors, bobPhase);
  const centerX = canvasW / 2;
  const centerZ = canvasH * 0.72;
  fighter.x = RING_CX;
  fighter.z = RING_CY;

  const pt = projectToScreen(fighter.x, fighter.z);
  const offsetX = centerX - pt.sx;
  const offsetY = centerZ - pt.sy;

  const oppFighter = createPreviewFighterState(colors, 0);
  oppFighter.x = RING_CX;
  oppFighter.z = RING_CY - 100;
  const oppPt = projectToScreen(oppFighter.x, oppFighter.z);

  ctx.save();
  ctx.translate(offsetX, offsetY);

  drawFighter(ctx, fighter, oppFighter, null as unknown as GameState, pt, oppPt);

  ctx.restore();

  currentCameraYaw = savedYaw;
}

const TUTORIAL_CONTINUE_BTN_W = 160;
const TUTORIAL_CONTINUE_BTN_H = 36;
const TUTORIAL_CONTINUE_BTN_X = CANVAS_W / 2 - TUTORIAL_CONTINUE_BTN_W / 2;
const TUTORIAL_CONTINUE_BTN_Y = CANVAS_H / 2 + 60;

function drawTutorialPrompt(ctx: CanvasRenderingContext2D, state: GameState): void {
  const prompt = state.tutorialPrompt;
  if (!prompt) return;

  ctx.save();

  if (state.tutorialShowContinueButton) {
    ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 16px 'Oxanium', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    const maxW = CANVAS_W - 80;
    const words = prompt.split(" ");
    const lines: string[] = [];
    let currentLine = "";
    for (const word of words) {
      const test = currentLine ? currentLine + " " + word : word;
      if (ctx.measureText(test).width > maxW) {
        lines.push(currentLine);
        currentLine = word;
      } else {
        currentLine = test;
      }
    }
    if (currentLine) lines.push(currentLine);

    const lineH = 24;
    const startY = CANVAS_H / 2 - (lines.length * lineH) / 2;
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], CANVAS_W / 2, startY + i * lineH);
    }

    ctx.fillStyle = "rgba(255, 200, 50, 0.9)";
    const bx = TUTORIAL_CONTINUE_BTN_X;
    const by = TUTORIAL_CONTINUE_BTN_Y;
    ctx.beginPath();
    ctx.roundRect(bx, by, TUTORIAL_CONTINUE_BTN_W, TUTORIAL_CONTINUE_BTN_H, 6);
    ctx.fill();

    ctx.fillStyle = "#000000";
    ctx.font = "bold 16px 'Oxanium', sans-serif";
    ctx.fillText("Continue", CANVAS_W / 2, by + TUTORIAL_CONTINUE_BTN_H / 2);
  } else {
    const maxTextW = CANVAS_W - 60;
    let fontSize = 20;
    ctx.font = `bold ${fontSize}px 'Oxanium', sans-serif`;
    if (ctx.measureText(prompt).width > maxTextW) {
      fontSize = 16;
      ctx.font = `bold ${fontSize}px 'Oxanium', sans-serif`;
    }
    if (ctx.measureText(prompt).width > maxTextW) {
      fontSize = 14;
      ctx.font = `bold ${fontSize}px 'Oxanium', sans-serif`;
    }

    const words = prompt.split(" ");
    const lines: string[] = [];
    let currentLine = "";
    for (const word of words) {
      const test = currentLine ? currentLine + " " + word : word;
      if (ctx.measureText(test).width > maxTextW) {
        if (currentLine) lines.push(currentLine);
        currentLine = word;
      } else {
        currentLine = test;
      }
    }
    if (currentLine) lines.push(currentLine);

    const lineH = fontSize + 6;
    const padV = 10;
    const bgH = lines.length * lineH + padV * 2;
    const bgY = 50;

    let bgW = 0;
    for (const line of lines) {
      const w = ctx.measureText(line).width;
      if (w > bgW) bgW = w;
    }
    bgW = Math.min(bgW + 40, CANVAS_W - 20);

    ctx.fillStyle = "rgba(0, 0, 0, 0.65)";
    ctx.beginPath();
    ctx.roundRect(CANVAS_W / 2 - bgW / 2, bgY, bgW, bgH, 8);
    ctx.fill();

    ctx.fillStyle = "#ffcc44";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const startY = bgY + padV + lineH / 2;
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], CANVAS_W / 2, startY + i * lineH);
    }
  }

  ctx.restore();
}

export function getTutorialContinueClick(x: number, y: number): boolean {
  return (
    x >= TUTORIAL_CONTINUE_BTN_X &&
    x <= TUTORIAL_CONTINUE_BTN_X + TUTORIAL_CONTINUE_BTN_W &&
    y >= TUTORIAL_CONTINUE_BTN_Y &&
    y <= TUTORIAL_CONTINUE_BTN_Y + TUTORIAL_CONTINUE_BTN_H
  );
}

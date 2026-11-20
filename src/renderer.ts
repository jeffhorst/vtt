import {
  computeVisibilityPolygon,
  pathfinderDistanceFt,
  resolveLightPosition,
} from './geometry';
import { renderPaintObjectsToCtx } from './paint/paintEngine';
import {
  activeDrags,
  activeRulers,
  camera,
  cellToWorldCenter,
  fog,
  fogCanvas,
  fogCtx,
  getActiveMapSource,
  getTokenRadius,
  grid,
  isEffectiveGmMapView,
  lightMaskCanvas,
  lightMaskCtx,
  lighting,
  lights,
  los,
  losMaskCanvas,
  losMaskCtx,
  paintCanvas,
  paintPreviewCanvas,
  rulesConfig,
  runtime,
  tokens,
  walls,
  worldToCell,
} from './state';
import { drawSelectionGizmo } from './transformGizmo';
import type { Bounds, VisibilityHit } from './types';

let canvas: HTMLCanvasElement;
let ctx: CanvasRenderingContext2D;
let rafId: number | null = null;
let cachedLosKey = '';
let cachedLosPolys: VisibilityHit[][] = [];

export function invalidateLosCache(): void {
  cachedLosKey = '';
}

export function initRenderer(targetCanvas: HTMLCanvasElement): void {
  const context = targetCanvas.getContext('2d');
  if (!context) {
    throw new Error('Could not initialize 2D context for table canvas');
  }
  canvas = targetCanvas;
  ctx = context;
}

export function resizeCanvas(): void {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(window.innerWidth * dpr);
  canvas.height = Math.floor(window.innerHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw();
}

function drawMap(): void {
  const src = getActiveMapSource();
  if (!src) return;
  ctx.drawImage(src, 0, 0);
}

function drawGrid(): void {
  if (!grid.visible) return;

  const left = -camera.x / camera.zoom;
  const top = -camera.y / camera.zoom;
  const right = left + window.innerWidth / camera.zoom;
  const bottom = top + window.innerHeight / camera.zoom;

  const startX =
    Math.floor((left - grid.offsetX) / grid.size) * grid.size + grid.offsetX;
  const startY =
    Math.floor((top - grid.offsetY) / grid.size) * grid.size + grid.offsetY;

  const alpha =
    typeof grid.opacity === 'number'
      ? Math.min(1, Math.max(0, grid.opacity))
      : 0.25;
  const hex = (grid.color ?? '#ffffff').trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{6}$/.test(hex)) {
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
  } else {
    ctx.strokeStyle = `rgba(255, 255, 255, ${alpha})`;
  }
  ctx.lineWidth = 1 / camera.zoom;
  ctx.beginPath();

  for (let x = startX; x <= right; x += grid.size) {
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
  }
  for (let y = startY; y <= bottom; y += grid.size) {
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
  }

  ctx.stroke();
}

function drawTokens(): void {
  const defaultR = getTokenRadius();

  for (const token of tokens) {
    const r = token.size ?? defaultR;
    const fontSize = Math.max(10, Math.round(r * 0.6));
    ctx.save();
    ctx.translate(token.x, token.y);
    if (token.rotation) ctx.rotate(token.rotation);

    // Token body
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fillStyle = token.color;
    ctx.fill();

    // Crisp border
    ctx.lineWidth = Math.max(2, r * 0.12);
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();

    // Label
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${fontSize}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(token.label, 0, 0);

    ctx.restore();
  }
}

function drawFog(): void {
  if (!fog.enabled) return;
  ctx.save();
  ctx.globalAlpha = fog.peek && isEffectiveGmMapView() ? 0.55 : 1;
  ctx.drawImage(fogCanvas, 0, 0);
  ctx.restore();
}

export function paintFogDot(x: number, y: number): void {
  fogCtx.save();
  fogCtx.globalCompositeOperation =
    fog.tool === 'reveal' ? 'destination-out' : 'source-over';
  fogCtx.fillStyle = '#0a0c10';
  fogCtx.beginPath();
  fogCtx.arc(x, y, fog.brushSize / 2, 0, Math.PI * 2);
  fogCtx.fill();
  fogCtx.restore();
}

export function paintFogLine(
  x1: number,
  y1: number,
  x2: number,
  y2: number
): void {
  fogCtx.save();
  fogCtx.globalCompositeOperation =
    fog.tool === 'reveal' ? 'destination-out' : 'source-over';
  fogCtx.strokeStyle = '#0a0c10';
  fogCtx.lineWidth = fog.brushSize;
  fogCtx.lineCap = 'round';
  fogCtx.lineJoin = 'round';
  fogCtx.beginPath();
  fogCtx.moveTo(x1, y1);
  fogCtx.lineTo(x2, y2);
  fogCtx.stroke();
  fogCtx.restore();
}

function drawMeasurement(
  c1: number,
  r1: number,
  c2: number,
  r2: number,
  color = '#ffe066'
): void {
  const p1 = cellToWorldCenter(c1, r1);
  const p2 = cellToWorldCenter(c2, r2);
  const feet = pathfinderDistanceFt(c1, r1, c2, r2);
  const scale = rulesConfig.feetPerSquare || 5;
  const squares = Math.round((feet / scale) * 10) / 10;
  const label = `${feet} ft (${squares} sq)`;

  ctx.save();
  const invZoom = 1 / camera.zoom;

  // Line
  ctx.beginPath();
  ctx.moveTo(p1.x, p1.y);
  ctx.lineTo(p2.x, p2.y);
  ctx.lineWidth = 3 * invZoom;
  ctx.strokeStyle = color;
  ctx.setLineDash([8 * invZoom, 6 * invZoom]);
  ctx.stroke();
  ctx.setLineDash([]);

  // Endpoints
  ctx.fillStyle = color;
  for (const pt of [p1, p2]) {
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 5 * invZoom, 0, Math.PI * 2);
    ctx.fill();
  }

  // Pill label at midpoint
  const midX = (p1.x + p2.x) / 2;
  const midY = (p1.y + p2.y) / 2 - 18 * invZoom;
  ctx.font = `bold ${14 * invZoom}px system-ui, sans-serif`;
  const textW = ctx.measureText(label).width;
  const padX = 10 * invZoom;
  const boxW = textW + padX * 2;
  const boxH = 26 * invZoom;

  ctx.fillStyle = 'rgba(20, 22, 28, 0.9)';
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5 * invZoom;
  ctx.beginPath();
  ctx.roundRect(midX - boxW / 2, midY - boxH / 2, boxW, boxH, 6 * invZoom);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, midX, midY);

  ctx.restore();
}

function drawMeasurements(): void {
  for (const drag of activeDrags.values()) {
    const cur = worldToCell(drag.token.x, drag.token.y);
    drawMeasurement(drag.startCol, drag.startRow, cur.col, cur.row, '#74c0fc');
  }
  for (const ruler of activeRulers.values()) {
    drawMeasurement(
      ruler.startCol,
      ruler.startRow,
      ruler.endCol,
      ruler.endRow,
      '#ffe066'
    );
  }
}

function drawLosMask(): void {
  if (!los.enabled) return;

  const dpr = window.devicePixelRatio || 1;
  if (
    losMaskCanvas.width !== canvas.width ||
    losMaskCanvas.height !== canvas.height
  ) {
    losMaskCanvas.width = canvas.width;
    losMaskCanvas.height = canvas.height;
  }

  losMaskCtx.save();
  losMaskCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  losMaskCtx.globalCompositeOperation = 'source-over';
  losMaskCtx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  const gmPeek = los.peek && isEffectiveGmMapView();
  losMaskCtx.fillStyle = `rgba(5, 7, 11, ${gmPeek ? 0.58 : 1})`;
  losMaskCtx.fillRect(0, 0, window.innerWidth, window.innerHeight);

  const pad = 400 / camera.zoom;
  // Quantize bounds to 200px world chunks so small camera pans reuse cached polygons
  const q = 200;
  const bounds: Bounds = {
    left: Math.floor((-camera.x / camera.zoom - pad) / q) * q,
    top: Math.floor((-camera.y / camera.zoom - pad) / q) * q,
    right:
      Math.ceil(((window.innerWidth - camera.x) / camera.zoom + pad) / q) * q,
    bottom:
      Math.ceil(((window.innerHeight - camera.y) / camera.zoom + pad) / q) * q,
  };

  const blockingSegs = walls.filter((w) => w.type === 'wall' || !w.open);
  const selected =
    runtime.selectedTokenId !== null
      ? tokens.find((t) => t.id === runtime.selectedTokenId) ?? null
      : null;
  const viewers = selected ? [selected] : tokens;

  const nextLosKey = `${bounds.left},${bounds.top},${bounds.right},${bounds.bottom}|${viewers
    .map((v) => `${v.id}:${Math.round(v.x)},${Math.round(v.y)}`)
    .join(';')}|${blockingSegs
    .map((w) => `${w.id}:${w.x1},${w.y1},${w.x2},${w.y2},${w.open ? 1 : 0}`)
    .join(';')}`;

  if (nextLosKey !== cachedLosKey) {
    cachedLosKey = nextLosKey;
    cachedLosPolys = viewers.map((v) =>
      computeVisibilityPolygon(v.x, v.y, blockingSegs, bounds)
    );
  }

  losMaskCtx.globalCompositeOperation = 'destination-out';
  losMaskCtx.translate(camera.x, camera.y);
  losMaskCtx.scale(camera.zoom, camera.zoom);
  losMaskCtx.fillStyle = '#000000';

  for (const poly of cachedLosPolys) {
    if (poly.length < 3) continue;
    losMaskCtx.beginPath();
    losMaskCtx.moveTo(poly[0].x, poly[0].y);
    for (let i = 1; i < poly.length; i++) {
      losMaskCtx.lineTo(poly[i].x, poly[i].y);
    }
    losMaskCtx.closePath();
    losMaskCtx.fill();
  }
  losMaskCtx.restore();

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(losMaskCanvas, 0, 0);
  ctx.restore();
}

function feetToWorldPx(feet: number): number {
  const scale = rulesConfig.feetPerSquare || 5;
  return (feet / scale) * grid.size;
}

function drawLighting(): void {
  if (!lighting.enabled) return;

  const dpr = window.devicePixelRatio || 1;
  if (
    lightMaskCanvas.width !== canvas.width ||
    lightMaskCanvas.height !== canvas.height
  ) {
    lightMaskCanvas.width = canvas.width;
    lightMaskCanvas.height = canvas.height;
  }

  const ambientAlpha =
    lighting.ambient === 'darkness'
      ? 0.88
      : lighting.ambient === 'dim'
      ? 0.45
      : 0;

  const pad = 400 / camera.zoom;
  const bounds: Bounds = {
    left: -camera.x / camera.zoom - pad,
    top: -camera.y / camera.zoom - pad,
    right: (window.innerWidth - camera.x) / camera.zoom + pad,
    bottom: (window.innerHeight - camera.y) / camera.zoom + pad,
  };
  const blockingSegs = walls.filter((w) => w.type === 'wall' || !w.open);

  lightMaskCtx.save();
  lightMaskCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  lightMaskCtx.globalCompositeOperation = 'source-over';
  lightMaskCtx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  if (ambientAlpha > 0) {
    lightMaskCtx.fillStyle = `rgba(3, 6, 14, ${ambientAlpha})`;
    lightMaskCtx.fillRect(0, 0, window.innerWidth, window.innerHeight);
  }

  lightMaskCtx.translate(camera.x, camera.y);
  lightMaskCtx.scale(camera.zoom, camera.zoom);

  const radiusMult = lighting.visionMode === 'low-light' ? 2 : 1;
  const activeLights = lights.filter((l) => l.enabled);
  const lightSources = activeLights.filter((l) => l.kind !== 'darkness-spell');
  const darknessSpells = activeLights.filter(
    (l) => l.kind === 'darkness-spell'
  );

  const punchLight = (l: (typeof lights)[number]) => {
    const pos = resolveLightPosition(l);
    const outerR = Math.max(4, feetToWorldPx(l.outerRadiusFt) * radiusMult);
    const innerR = Math.min(
      outerR,
      Math.max(0, feetToWorldPx(l.innerRadiusFt) * radiusMult)
    );
    const poly = computeVisibilityPolygon(pos.x, pos.y, blockingSegs, bounds);
    if (poly.length < 3) return;

    lightMaskCtx.save();
    lightMaskCtx.globalCompositeOperation = 'destination-out';
    lightMaskCtx.beginPath();
    lightMaskCtx.moveTo(poly[0].x, poly[0].y);
    for (let i = 1; i < poly.length; i++) {
      lightMaskCtx.lineTo(poly[i].x, poly[i].y);
    }
    lightMaskCtx.closePath();
    lightMaskCtx.clip();

    const grad = lightMaskCtx.createRadialGradient(
      pos.x,
      pos.y,
      0,
      pos.x,
      pos.y,
      outerR
    );
    const innerStop = outerR > 0 ? Math.min(0.95, innerR / outerR) : 0;
    grad.addColorStop(0, 'rgba(0, 0, 0, 1)');
    grad.addColorStop(innerStop, 'rgba(0, 0, 0, 0.92)');
    grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    lightMaskCtx.fillStyle = grad;
    lightMaskCtx.beginPath();
    lightMaskCtx.arc(pos.x, pos.y, outerR, 0, Math.PI * 2);
    lightMaskCtx.fill();
    lightMaskCtx.restore();
  };

  // Pass 1: Punch out mundane + light spells
  for (const l of lightSources) {
    punchLight(l);
  }

  // Darkvision 60ft sees through non-magical darkness
  if (lighting.visionMode === 'darkvision') {
    const dvRadius = feetToWorldPx(60);
    const selected =
      runtime.selectedTokenId !== null
        ? tokens.find((t) => t.id === runtime.selectedTokenId) ?? null
        : null;
    const viewers = selected ? [selected] : tokens;
    for (const v of viewers) {
      const poly = computeVisibilityPolygon(v.x, v.y, blockingSegs, bounds);
      if (poly.length < 3) continue;
      lightMaskCtx.save();
      lightMaskCtx.globalCompositeOperation = 'destination-out';
      lightMaskCtx.beginPath();
      lightMaskCtx.moveTo(poly[0].x, poly[0].y);
      for (let i = 1; i < poly.length; i++) {
        lightMaskCtx.lineTo(poly[i].x, poly[i].y);
      }
      lightMaskCtx.closePath();
      lightMaskCtx.clip();
      const grad = lightMaskCtx.createRadialGradient(
        v.x,
        v.y,
        0,
        v.x,
        v.y,
        dvRadius
      );
      grad.addColorStop(0, 'rgba(0, 0, 0, 0.92)');
      grad.addColorStop(0.85, 'rgba(0, 0, 0, 0.85)');
      grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
      lightMaskCtx.fillStyle = grad;
      lightMaskCtx.beginPath();
      lightMaskCtx.arc(v.x, v.y, dvRadius, 0, Math.PI * 2);
      lightMaskCtx.fill();
      lightMaskCtx.restore();
    }
  }

  // Pass 2: Apply darkness spells (Deeper Darkness creates supernatural darkness)
  const maxDarknessLevel = darknessSpells.reduce(
    (max, d) => Math.max(max, d.spellLevel),
    -1
  );
  for (const d of darknessSpells) {
    const pos = resolveLightPosition(d);
    const r = Math.max(4, feetToWorldPx(d.outerRadiusFt || d.innerRadiusFt));
    const poly = computeVisibilityPolygon(pos.x, pos.y, blockingSegs, bounds);
    if (poly.length < 3) continue;

    const isSupernatural = d.spellLevel >= 3;
    lightMaskCtx.save();
    lightMaskCtx.globalCompositeOperation = 'source-over';
    lightMaskCtx.beginPath();
    lightMaskCtx.moveTo(poly[0].x, poly[0].y);
    for (let i = 1; i < poly.length; i++) {
      lightMaskCtx.lineTo(poly[i].x, poly[i].y);
    }
    lightMaskCtx.closePath();
    lightMaskCtx.clip();

    lightMaskCtx.fillStyle = isSupernatural
      ? 'rgba(2, 2, 10, 0.96)'
      : 'rgba(6, 8, 22, 0.72)';
    lightMaskCtx.beginPath();
    lightMaskCtx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
    lightMaskCtx.fill();
    lightMaskCtx.restore();
  }

  // Pass 3: Higher-level [light] spells win over lower-level [darkness]
  for (const l of lightSources) {
    if (l.kind === 'light-spell' && l.spellLevel > maxDarknessLevel) {
      punchLight(l);
    }
  }

  lightMaskCtx.restore();

  // Draw subtle colored illumination tint onto the map
  for (const l of lightSources) {
    const pos = resolveLightPosition(l);
    const outerR = Math.max(4, feetToWorldPx(l.outerRadiusFt) * radiusMult);
    ctx.save();
    const grad = ctx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, outerR);
    grad.addColorStop(0, `${l.color}33`);
    grad.addColorStop(1, `${l.color}00`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, outerR, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(lightMaskCanvas, 0, 0);
  ctx.restore();
}

function drawLightTokens(): void {
  if (lights.length === 0) return;
  const invZoom = 1 / camera.zoom;
  const r = Math.max(10, grid.size * 0.22);

  for (const l of lights) {
    if (l.attachedTokenId !== null) continue;
    ctx.save();
    ctx.beginPath();
    ctx.arc(l.x, l.y, r, 0, Math.PI * 2);
    ctx.fillStyle = l.enabled ? l.color : 'rgba(51, 65, 85, 0.8)';
    ctx.fill();
    ctx.lineWidth = 2 * invZoom;
    ctx.strokeStyle =
      l.id === runtime.selectedLightId ? '#ffe066' : '#ffffff';
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${Math.max(9, Math.round(r * 0.65))}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(l.name.slice(0, 4), l.x, l.y);
    ctx.restore();
  }
}

function drawLightPlacementCursor(): void {
  if (
    runtime.activeTool !== 'place-light' ||
    !runtime.pendingLight ||
    !runtime.cursorWorldPos
  ) {
    return;
  }

  const preset = runtime.pendingLight;
  const { x, y } = runtime.cursorWorldPos;
  const invZoom = 1 / camera.zoom;
  const r = Math.max(10, grid.size * 0.22);

  ctx.save();

  if (preset.outerRadiusFt > 0) {
    const outerR = feetToWorldPx(preset.outerRadiusFt);
    ctx.beginPath();
    ctx.arc(x, y, outerR, 0, Math.PI * 2);
    ctx.strokeStyle = `${preset.color}88`;
    ctx.lineWidth = 1.5 * invZoom;
    ctx.setLineDash([6 * invZoom, 5 * invZoom]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.globalAlpha = 0.85;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = preset.color;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.lineWidth = 2 * invZoom;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();

  ctx.fillStyle = '#ffffff';
  ctx.font = `bold ${Math.max(9, Math.round(r * 0.65))}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(preset.name.slice(0, 4), x, y);

  // Clear center point crosshair + dot
  const tickInner = 4 * invZoom;
  const tickOuter = 10 * invZoom;
  ctx.strokeStyle = '#0f172a';
  ctx.lineWidth = 3 * invZoom;
  ctx.beginPath();
  ctx.moveTo(x - tickOuter, y);
  ctx.lineTo(x - tickInner, y);
  ctx.moveTo(x + tickInner, y);
  ctx.lineTo(x + tickOuter, y);
  ctx.moveTo(x, y - tickOuter);
  ctx.lineTo(x, y - tickInner);
  ctx.moveTo(x, y + tickInner);
  ctx.lineTo(x, y + tickOuter);
  ctx.stroke();

  ctx.strokeStyle = '#ffe066';
  ctx.lineWidth = 1.5 * invZoom;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(x, y, 2.5 * invZoom, 0, Math.PI * 2);
  ctx.fillStyle = '#ffe066';
  ctx.fill();
  ctx.lineWidth = 1 * invZoom;
  ctx.strokeStyle = '#0f172a';
  ctx.stroke();

  ctx.restore();
}

function drawWalls(): void {
  if (walls.length === 0 && !runtime.draftWall) return;
  const isGm = isEffectiveGmMapView();

  const invZoom = 1 / camera.zoom;
  ctx.save();
  ctx.lineCap = 'round';

  for (const w of walls) {
    const isUnrevealedSecret = w.type === 'door' && Boolean(w.secret) && !w.revealed;

    ctx.beginPath();
    ctx.moveTo(w.x1, w.y1);
    ctx.lineTo(w.x2, w.y2);

    if (w.type === 'wall' || (isUnrevealedSecret && !isGm)) {
      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = 4 * invZoom;
      ctx.setLineDash([]);
    } else if (isUnrevealedSecret && isGm) {
      ctx.strokeStyle = w.open ? '#4ade80' : '#c084fc';
      ctx.lineWidth = 4 * invZoom;
      ctx.setLineDash([6 * invZoom, 4 * invZoom]);
    } else if (w.open) {
      ctx.strokeStyle = '#4ade80';
      ctx.lineWidth = 3 * invZoom;
      ctx.setLineDash([6 * invZoom, 6 * invZoom]);
    } else {
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 5 * invZoom;
      ctx.setLineDash([]);
    }
    ctx.stroke();
  }

  if (runtime.draftWall) {
    ctx.beginPath();
    ctx.moveTo(runtime.draftWall.x1, runtime.draftWall.y1);
    ctx.lineTo(runtime.draftWall.x2, runtime.draftWall.y2);
    ctx.strokeStyle =
      runtime.activeTool === 'los-secret-door'
        ? '#c084fc'
        : runtime.draftWall.type === 'door'
        ? '#38bdf8'
        : '#f59e0b';
    ctx.lineWidth = 4 * invZoom;
    ctx.setLineDash([6 * invZoom, 4 * invZoom]);
    ctx.stroke();
  }

  ctx.restore();
}

function drawPaint(): void {
  ctx.drawImage(paintCanvas, 0, 0);
  renderPaintObjectsToCtx(ctx);
  ctx.drawImage(paintPreviewCanvas, 0, 0);
}

function renderFrameNow(): void {
  rafId = null;
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  ctx.save();
  ctx.translate(camera.x, camera.y);
  ctx.scale(camera.zoom, camera.zoom);
  drawMap();
  drawGrid();
  drawPaint();
  drawTokens();
  drawLightTokens();
  drawLighting();
  drawWalls();
  drawFog();
  drawLosMask();
  drawMeasurements();
  drawSelectionGizmo(ctx);
  drawLightPlacementCursor();
  ctx.restore();

  if (runtime.mapIsAnimated && getActiveMapSource()) {
    draw();
  }
}

export function draw(): void {
  if (rafId !== null) return;
  rafId = requestAnimationFrame(renderFrameNow);
}

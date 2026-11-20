import { distToSegment } from '../geometry';
import { scheduleSave } from '../persistence';
import { draw } from '../renderer';
import {
  camera,
  paintCanvas,
  paintCtx,
  paintObjects,
  paintPreviewCanvas,
  paintPreviewCtx,
  paintState,
  runtime,
} from '../state';
import { sendSyncAction } from '../sync';
import type { PaintObject, Point } from '../types';

const MAX_HISTORY = 25;
interface HistoryEntry {
  image: ImageData;
  objects: PaintObject[];
}
const undoStack: HistoryEntry[] = [];
const redoStack: HistoryEntry[] = [];

export function canUndoPaint(): boolean {
  return undoStack.length > 0;
}

export function canRedoPaint(): boolean {
  return redoStack.length > 0;
}

let onHistoryChange: (() => void) | null = null;

export function setPaintCallbacks(callbacks: {
  onHistoryChange?: () => void;
}): void {
  onHistoryChange = callbacks.onHistoryChange ?? null;
}

function notifyHistory(): void {
  onHistoryChange?.();
}

function cloneObjects(list: PaintObject[]): PaintObject[] {
  return JSON.parse(JSON.stringify(list)) as PaintObject[];
}

export function savePaintObjectsLocal(): void {
  if (runtime.activeSceneId === null) return;
  try {
    localStorage.setItem(
      `vtt-paint-objs:${runtime.activeSceneId}`,
      JSON.stringify(paintObjects)
    );
  } catch {
    // Ignore storage quota errors
  }
}

export function loadPaintObjectsLocal(sceneId: number): void {
  paintObjects.length = 0;
  try {
    const raw = localStorage.getItem(`vtt-paint-objs:${sceneId}`);
    if (raw) {
      const parsed = JSON.parse(raw) as PaintObject[];
      if (Array.isArray(parsed)) {
        paintObjects.push(...parsed);
      }
    }
  } catch {
    // Ignore corrupt cache
  }
}

export function pushPaintHistory(): void {
  try {
    const snap = paintCtx.getImageData(
      0,
      0,
      paintCanvas.width,
      paintCanvas.height
    );
    undoStack.push({ image: snap, objects: cloneObjects(paintObjects) });
    if (undoStack.length > MAX_HISTORY) undoStack.shift();
    redoStack.length = 0;
    notifyHistory();
  } catch (err) {
    console.warn('Could not snapshot paint history:', err);
  }
}

export function markPaintChanged(): void {
  savePaintObjectsLocal();
  sendSyncAction({ action: 'paint:sync', paintObjects });
  runtime.paintDirty = true;
  draw();
  scheduleSave();
}

export function undoPaint(): void {
  const prev = undoStack.pop();
  if (!prev) return;
  const current = paintCtx.getImageData(
    0,
    0,
    paintCanvas.width,
    paintCanvas.height
  );
  redoStack.push({ image: current, objects: cloneObjects(paintObjects) });
  paintCtx.putImageData(prev.image, 0, 0);
  paintObjects.length = 0;
  paintObjects.push(...prev.objects);
  runtime.selectedPaintObjectId = null;
  notifyHistory();
  markPaintChanged();
}

export function redoPaint(): void {
  const next = redoStack.pop();
  if (!next) return;
  const current = paintCtx.getImageData(
    0,
    0,
    paintCanvas.width,
    paintCanvas.height
  );
  undoStack.push({ image: current, objects: cloneObjects(paintObjects) });
  paintCtx.putImageData(next.image, 0, 0);
  paintObjects.length = 0;
  paintObjects.push(...next.objects);
  runtime.selectedPaintObjectId = null;
  notifyHistory();
  markPaintChanged();
}

// --- Paint Object Rendering & Hit Testing ---
export function renderPaintObjectsToCtx(target: CanvasRenderingContext2D): void {
  for (const obj of paintObjects) {
    target.save();
    target.globalAlpha = obj.opacity;

    if (obj.rotation) {
      const b = getPaintObjectBounds(obj);
      const cx = b.x + b.w / 2;
      const cy = b.y + b.h / 2;
      target.translate(cx, cy);
      target.rotate(obj.rotation);
      target.translate(-cx, -cy);
    }

    if (obj.type === 'brush') {
      if (obj.points.length === 1) {
        target.fillStyle = obj.color;
        target.beginPath();
        target.arc(obj.points[0].x, obj.points[0].y, obj.size / 2, 0, Math.PI * 2);
        target.fill();
      } else if (obj.points.length > 1) {
        target.strokeStyle = obj.color;
        target.lineWidth = obj.size;
        target.lineCap = 'round';
        target.lineJoin = 'round';
        target.beginPath();
        target.moveTo(obj.points[0].x, obj.points[0].y);
        for (let i = 1; i < obj.points.length; i++) {
          target.lineTo(obj.points[i].x, obj.points[i].y);
        }
        target.stroke();
      }
    } else if (obj.type === 'line') {
      target.strokeStyle = obj.color;
      target.lineWidth = obj.size;
      target.lineCap = 'round';
      target.beginPath();
      target.moveTo(obj.x1, obj.y1);
      target.lineTo(obj.x2, obj.y2);
      target.stroke();
    } else if (obj.type === 'rect' || obj.type === 'ellipse') {
      target.strokeStyle = obj.color;
      target.fillStyle = obj.fillMode === 'fill' ? obj.color : obj.secondaryColor;
      target.lineWidth = obj.size;
      target.lineJoin = 'round';
      target.beginPath();
      if (obj.type === 'rect') {
        target.rect(obj.x, obj.y, obj.w, obj.h);
      } else {
        target.ellipse(
          obj.x + obj.w / 2,
          obj.y + obj.h / 2,
          Math.max(0.5, obj.w / 2),
          Math.max(0.5, obj.h / 2),
          0,
          0,
          Math.PI * 2
        );
      }
      if (obj.fillMode === 'fill' || obj.fillMode === 'both') target.fill();
      if (obj.fillMode === 'outline' || obj.fillMode === 'both') target.stroke();
    } else if (obj.type === 'text') {
      target.fillStyle = obj.color;
      target.font = `bold ${obj.fontSize}px system-ui, sans-serif`;
      target.textBaseline = 'top';
      target.fillText(obj.text, obj.x, obj.y);
    }

    target.restore();
  }
}

export function getPaintObjectBounds(obj: PaintObject): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  if (obj.type === 'brush') {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of obj.points) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    const pad = obj.size / 2;
    return {
      x: minX - pad,
      y: minY - pad,
      w: Math.max(4, maxX - minX + obj.size),
      h: Math.max(4, maxY - minY + obj.size),
    };
  }
  if (obj.type === 'line') {
    const minX = Math.min(obj.x1, obj.x2);
    const minY = Math.min(obj.y1, obj.y2);
    const pad = obj.size / 2;
    return {
      x: minX - pad,
      y: minY - pad,
      w: Math.max(4, Math.abs(obj.x2 - obj.x1) + obj.size),
      h: Math.max(4, Math.abs(obj.y2 - obj.y1) + obj.size),
    };
  }
  if (obj.type === 'text') {
    paintCtx.save();
    paintCtx.font = `bold ${obj.fontSize}px system-ui, sans-serif`;
    const measuredW = paintCtx.measureText(obj.text).width;
    paintCtx.restore();
    return {
      x: obj.x,
      y: obj.y,
      w: Math.max(20, measuredW),
      h: obj.fontSize * 1.2,
    };
  }
  return { x: obj.x, y: obj.y, w: obj.w, h: obj.h };
}

export function findPaintObjectAt(wx: number, wy: number): PaintObject | null {
  const tol = 10 / camera.zoom;
  for (let i = paintObjects.length - 1; i >= 0; i--) {
    const obj = paintObjects[i];
    let px = wx;
    let py = wy;
    if (obj.rotation) {
      const b = getPaintObjectBounds(obj);
      const cx = b.x + b.w / 2;
      const cy = b.y + b.h / 2;
      const dx = wx - cx;
      const dy = wy - cy;
      const cos = Math.cos(-obj.rotation);
      const sin = Math.sin(-obj.rotation);
      px = cx + dx * cos - dy * sin;
      py = cy + dx * sin + dy * cos;
    }

    if (obj.type === 'brush') {
      const hitR = obj.size / 2 + tol;
      if (obj.points.length === 1) {
        if (Math.hypot(px - obj.points[0].x, py - obj.points[0].y) <= hitR) {
          return obj;
        }
      } else {
        for (let j = 1; j < obj.points.length; j++) {
          const p0 = obj.points[j - 1];
          const p1 = obj.points[j];
          if (distToSegment(px, py, p0.x, p0.y, p1.x, p1.y) <= hitR) {
            return obj;
          }
        }
      }
    } else if (obj.type === 'line') {
      if (
        distToSegment(px, py, obj.x1, obj.y1, obj.x2, obj.y2) <=
        obj.size / 2 + tol
      ) {
        return obj;
      }
    } else if (obj.type === 'text') {
      const b = getPaintObjectBounds(obj);
      if (
        px >= b.x - tol &&
        px <= b.x + b.w + tol &&
        py >= b.y - tol &&
        py <= b.y + b.h + tol
      ) {
        return obj;
      }
    } else {
      if (
        px >= obj.x - tol &&
        px <= obj.x + obj.w + tol &&
        py >= obj.y - tol &&
        py <= obj.y + obj.h + tol
      ) {
        return obj;
      }
    }
  }
  return null;
}

export function movePaintObject(id: number, dx: number, dy: number): void {
  const obj = paintObjects.find((o) => o.id === id);
  if (!obj) return;
  if (obj.type === 'brush') {
    for (const p of obj.points) {
      p.x += dx;
      p.y += dy;
    }
  } else if (obj.type === 'line') {
    obj.x1 += dx;
    obj.y1 += dy;
    obj.x2 += dx;
    obj.y2 += dy;
  } else {
    obj.x += dx;
    obj.y += dy;
  }
}

export function deleteSelectedPaintObject(): boolean {
  if (runtime.selectedPaintObjectId === null) return false;
  const idx = paintObjects.findIndex(
    (o) => o.id === runtime.selectedPaintObjectId
  );
  if (idx === -1) return false;
  pushPaintHistory();
  paintObjects.splice(idx, 1);
  runtime.selectedPaintObjectId = null;
  markPaintChanged();
  return true;
}

// --- Selection & Clipboard ---
interface SelectionRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

let selection: SelectionRect | null = null;
let floatingBuffer: HTMLCanvasElement | null = null;
let clipboardBuffer: HTMLCanvasElement | null = null;

function commitFloatingSelection(): void {
  if (!floatingBuffer || !selection) return;
  paintCtx.save();
  paintCtx.globalCompositeOperation = 'source-over';
  paintCtx.drawImage(floatingBuffer, selection.x, selection.y);
  paintCtx.restore();
  floatingBuffer = null;
  selection = null;
  paintPreviewCtx.clearRect(
    0,
    0,
    paintPreviewCanvas.width,
    paintPreviewCanvas.height
  );
  markPaintChanged();
}

function drawSelectionPreview(): void {
  paintPreviewCtx.clearRect(
    0,
    0,
    paintPreviewCanvas.width,
    paintPreviewCanvas.height
  );
  if (!selection) return;
  if (floatingBuffer) {
    paintPreviewCtx.drawImage(floatingBuffer, selection.x, selection.y);
  }
  paintPreviewCtx.save();
  paintPreviewCtx.strokeStyle = '#38bdf8';
  paintPreviewCtx.lineWidth = Math.max(1, 2 / camera.zoom);
  paintPreviewCtx.setLineDash([6 / camera.zoom, 4 / camera.zoom]);
  paintPreviewCtx.strokeRect(selection.x, selection.y, selection.w, selection.h);
  paintPreviewCtx.restore();
  draw();
}

export function deletePaintSelection(): boolean {
  if (selection) {
    pushPaintHistory();
    const sx1 = selection.x;
    const sy1 = selection.y;
    const sx2 = selection.x + selection.w;
    const sy2 = selection.y + selection.h;

    if (!floatingBuffer) {
      paintCtx.clearRect(sx1, sy1, selection.w, selection.h);
    }

    // Also delete any PaintObjects intersecting the selection rectangle
    for (let i = paintObjects.length - 1; i >= 0; i--) {
      const obj = paintObjects[i];
      const b = getPaintObjectBounds(obj);
      const intersects =
        b.x <= sx2 &&
        b.x + b.w >= sx1 &&
        b.y <= sy2 &&
        b.y + b.h >= sy1;
      if (intersects) {
        if (runtime.selectedPaintObjectId === obj.id) {
          runtime.selectedPaintObjectId = null;
        }
        paintObjects.splice(i, 1);
      }
    }

    floatingBuffer = null;
    selection = null;
    paintPreviewCtx.clearRect(
      0,
      0,
      paintPreviewCanvas.width,
      paintPreviewCanvas.height
    );
    markPaintChanged();
    return true;
  }
  return deleteSelectedPaintObject();
}

export function copyPaintSelection(): void {
  if (!selection) return;
  const buf = document.createElement('canvas');
  buf.width = Math.max(1, Math.round(selection.w));
  buf.height = Math.max(1, Math.round(selection.h));
  const bctx = buf.getContext('2d');
  if (!bctx) return;
  if (floatingBuffer) {
    bctx.drawImage(floatingBuffer, 0, 0);
  } else {
    bctx.drawImage(
      paintCanvas,
      selection.x,
      selection.y,
      selection.w,
      selection.h,
      0,
      0,
      buf.width,
      buf.height
    );
  }
  clipboardBuffer = buf;
}

export function pastePaintSelection(): void {
  if (!clipboardBuffer) return;
  commitFloatingSelection();
  pushPaintHistory();
  const cx = Math.round(
    (window.innerWidth / 2 - camera.x) / camera.zoom - clipboardBuffer.width / 2
  );
  const cy = Math.round(
    (window.innerHeight / 2 - camera.y) / camera.zoom -
      clipboardBuffer.height / 2
  );
  const copy = document.createElement('canvas');
  copy.width = clipboardBuffer.width;
  copy.height = clipboardBuffer.height;
  copy.getContext('2d')?.drawImage(clipboardBuffer, 0, 0);
  floatingBuffer = copy;
  selection = { x: cx, y: cy, w: copy.width, h: copy.height };
  drawSelectionPreview();
}

// --- Shape Rendering ---
function drawShapeOnCtx(
  target: CanvasRenderingContext2D,
  tool: 'line' | 'rect' | 'ellipse',
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  primary: string,
  secondary: string,
  shiftKey: boolean
): void {
  let ex = x2;
  let ey = y2;
  if (shiftKey) {
    if (tool === 'line') {
      const dx = ex - x1;
      const dy = ey - y1;
      const angle =
        Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.hypot(dx, dy);
      ex = x1 + Math.cos(angle) * len;
      ey = y1 + Math.sin(angle) * len;
    } else {
      const dx = ex - x1;
      const dy = ey - y1;
      const side = Math.max(Math.abs(dx), Math.abs(dy));
      ex = x1 + Math.sign(dx || 1) * side;
      ey = y1 + Math.sign(dy || 1) * side;
    }
  }

  target.save();
  target.globalAlpha = paintState.opacity;
  target.strokeStyle = primary;
  target.fillStyle = paintState.fillMode === 'fill' ? primary : secondary;
  target.lineWidth = paintState.size;
  target.lineCap = 'round';
  target.lineJoin = 'round';

  const rx = Math.min(x1, ex);
  const ry = Math.min(y1, ey);
  const rw = Math.abs(ex - x1);
  const rh = Math.abs(ey - y1);

  target.beginPath();
  if (tool === 'line') {
    target.moveTo(x1, y1);
    target.lineTo(ex, ey);
    target.stroke();
    target.restore();
    return;
  } else if (tool === 'rect') {
    target.rect(rx, ry, rw, rh);
  } else if (tool === 'ellipse') {
    target.ellipse(
      rx + rw / 2,
      ry + rh / 2,
      Math.max(0.5, rw / 2),
      Math.max(0.5, rh / 2),
      0,
      0,
      Math.PI * 2
    );
  }

  if (paintState.fillMode === 'fill' || paintState.fillMode === 'both') {
    target.fill();
  }
  if (paintState.fillMode === 'outline' || paintState.fillMode === 'both') {
    target.stroke();
  }
  target.restore();
}

// --- Active Pointer Session ---
interface PaintSession {
  pointerId: number;
  lastX: number;
  lastY: number;
  startX: number;
  startY: number;
  secondary: boolean;
  shiftKey: boolean;
  movingSelection: boolean;
  moveOrigX: number;
  moveOrigY: number;
  brushObj: Extract<PaintObject, { type: 'brush' }> | null;
}

let activeSession: PaintSession | null = null;

function openTextPrompt(
  wx: number,
  wy: number,
  sx: number,
  sy: number,
  color: string
): void {
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Type & Enter...';
  input.style.position = 'fixed';
  input.style.left = `${sx}px`;
  input.style.top = `${sy}px`;
  input.style.zIndex = '999';
  input.style.background = 'rgba(15, 23, 42, 0.9)';
  input.style.color = color;
  input.style.border = '1px solid #facc15';
  input.style.borderRadius = '4px';
  input.style.padding = '4px 8px';
  input.style.font = `bold ${paintState.fontSize}px system-ui, sans-serif`;
  document.body.appendChild(input);
  input.focus();

  let committed = false;
  const commit = () => {
    if (committed) return;
    committed = true;
    const text = input.value;
    input.remove();
    if (!text.trim()) return;
    pushPaintHistory();
    paintObjects.push({
      id: Date.now() + Math.random(),
      type: 'text',
      x: wx,
      y: wy,
      text,
      color,
      fontSize: paintState.fontSize,
      opacity: paintState.opacity,
    });
    markPaintChanged();
  };

  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') commit();
    if (ev.key === 'Escape') {
      committed = true;
      input.remove();
    }
  });
  input.addEventListener('blur', commit);
}

export function handlePaintPointerDown(e: PointerEvent, world: Point): void {
  const secondary = e.button === 2;
  const primary = secondary
    ? paintState.secondaryColor
    : paintState.primaryColor;

  if (paintState.tool === 'text') {
    commitFloatingSelection();
    openTextPrompt(world.x, world.y, e.clientX, e.clientY, primary);
    return;
  }

  if (paintState.tool === 'select-rect') {
    if (
      selection &&
      world.x >= selection.x &&
      world.x <= selection.x + selection.w &&
      world.y >= selection.y &&
      world.y <= selection.y + selection.h
    ) {
      if (!floatingBuffer) {
        pushPaintHistory();
        const buf = document.createElement('canvas');
        buf.width = Math.max(1, Math.round(selection.w));
        buf.height = Math.max(1, Math.round(selection.h));
        buf
          .getContext('2d')
          ?.drawImage(
            paintCanvas,
            selection.x,
            selection.y,
            selection.w,
            selection.h,
            0,
            0,
            buf.width,
            buf.height
          );
        paintCtx.clearRect(selection.x, selection.y, selection.w, selection.h);
        floatingBuffer = buf;
      }
      activeSession = {
        pointerId: e.pointerId,
        lastX: world.x,
        lastY: world.y,
        startX: world.x,
        startY: world.y,
        secondary,
        shiftKey: e.shiftKey,
        movingSelection: true,
        moveOrigX: selection.x,
        moveOrigY: selection.y,
        brushObj: null,
      };
      drawSelectionPreview();
      return;
    }

    commitFloatingSelection();
    selection = { x: world.x, y: world.y, w: 0, h: 0 };
    activeSession = {
      pointerId: e.pointerId,
      lastX: world.x,
      lastY: world.y,
      startX: world.x,
      startY: world.y,
      secondary,
      shiftKey: e.shiftKey,
      movingSelection: false,
      moveOrigX: 0,
      moveOrigY: 0,
      brushObj: null,
    };
    return;
  }

  commitFloatingSelection();
  pushPaintHistory();

  let brushObj: Extract<PaintObject, { type: 'brush' }> | null = null;
  if (paintState.tool === 'brush') {
    brushObj = {
      id: Date.now() + Math.random(),
      type: 'brush',
      points: [{ x: world.x, y: world.y }],
      color: primary,
      size: paintState.size,
      opacity: paintState.opacity,
    };
    paintObjects.push(brushObj);
    draw();
  }

  activeSession = {
    pointerId: e.pointerId,
    lastX: world.x,
    lastY: world.y,
    startX: world.x,
    startY: world.y,
    secondary,
    shiftKey: e.shiftKey,
    movingSelection: false,
    moveOrigX: 0,
    moveOrigY: 0,
    brushObj,
  };
}

export function handlePaintPointerMove(e: PointerEvent, world: Point): void {
  if (!activeSession || activeSession.pointerId !== e.pointerId) return;
  activeSession.shiftKey = e.shiftKey;

  const primary = activeSession.secondary
    ? paintState.secondaryColor
    : paintState.primaryColor;
  const alt = activeSession.secondary
    ? paintState.primaryColor
    : paintState.secondaryColor;

  if (paintState.tool === 'select-rect') {
    if (activeSession.movingSelection && selection) {
      selection.x = activeSession.moveOrigX + (world.x - activeSession.startX);
      selection.y = activeSession.moveOrigY + (world.y - activeSession.startY);
      drawSelectionPreview();
    } else {
      selection = {
        x: Math.min(activeSession.startX, world.x),
        y: Math.min(activeSession.startY, world.y),
        w: Math.abs(world.x - activeSession.startX),
        h: Math.abs(world.y - activeSession.startY),
      };
      drawSelectionPreview();
    }
    return;
  }

  if (paintState.tool === 'brush' && activeSession.brushObj) {
    activeSession.brushObj.points.push({ x: world.x, y: world.y });
    activeSession.lastX = world.x;
    activeSession.lastY = world.y;
    draw();
    return;
  }

  if (
    paintState.tool === 'line' ||
    paintState.tool === 'rect' ||
    paintState.tool === 'ellipse'
  ) {
    paintPreviewCtx.clearRect(
      0,
      0,
      paintPreviewCanvas.width,
      paintPreviewCanvas.height
    );
    drawShapeOnCtx(
      paintPreviewCtx,
      paintState.tool,
      activeSession.startX,
      activeSession.startY,
      world.x,
      world.y,
      primary,
      alt,
      e.shiftKey
    );
    draw();
  }
}

export function handlePaintPointerUp(_e: PointerEvent, world: Point): void {
  if (!activeSession || activeSession.pointerId !== _e.pointerId) return;
  const session = activeSession;
  activeSession = null;

  if (paintState.tool === 'select-rect') {
    if (selection && (selection.w < 2 || selection.h < 2)) {
      selection = null;
      paintPreviewCtx.clearRect(
        0,
        0,
        paintPreviewCanvas.width,
        paintPreviewCanvas.height
      );
      draw();
    } else if (session.movingSelection) {
      markPaintChanged();
    }
    return;
  }

  const primary = session.secondary
    ? paintState.secondaryColor
    : paintState.primaryColor;
  const alt = session.secondary
    ? paintState.primaryColor
    : paintState.secondaryColor;

  if (
    paintState.tool === 'line' ||
    paintState.tool === 'rect' ||
    paintState.tool === 'ellipse'
  ) {
    paintPreviewCtx.clearRect(
      0,
      0,
      paintPreviewCanvas.width,
      paintPreviewCanvas.height
    );

    let ex = world.x;
    let ey = world.y;
    if (session.shiftKey) {
      if (paintState.tool === 'line') {
        const dx = ex - session.startX;
        const dy = ey - session.startY;
        const angle =
          Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
        const len = Math.hypot(dx, dy);
        ex = session.startX + Math.cos(angle) * len;
        ey = session.startY + Math.sin(angle) * len;
      } else {
        const dx = ex - session.startX;
        const dy = ey - session.startY;
        const side = Math.max(Math.abs(dx), Math.abs(dy));
        ex = session.startX + Math.sign(dx || 1) * side;
        ey = session.startY + Math.sign(dy || 1) * side;
      }
    }

    if (paintState.tool === 'line') {
      paintObjects.push({
        id: Date.now() + Math.random(),
        type: 'line',
        x1: session.startX,
        y1: session.startY,
        x2: ex,
        y2: ey,
        color: primary,
        size: paintState.size,
        opacity: paintState.opacity,
      });
    } else {
      paintObjects.push({
        id: Date.now() + Math.random(),
        type: paintState.tool,
        x: Math.min(session.startX, ex),
        y: Math.min(session.startY, ey),
        w: Math.abs(ex - session.startX),
        h: Math.abs(ey - session.startY),
        color: primary,
        secondaryColor: alt,
        fillMode: paintState.fillMode,
        size: paintState.size,
        opacity: paintState.opacity,
      });
    }
  }

  markPaintChanged();
}

// --- Image Operations ---
export function clearPaintCanvas(): void {
  commitFloatingSelection();
  pushPaintHistory();
  paintCtx.clearRect(0, 0, paintCanvas.width, paintCanvas.height);
  paintObjects.length = 0;
  runtime.selectedPaintObjectId = null;
  markPaintChanged();
}

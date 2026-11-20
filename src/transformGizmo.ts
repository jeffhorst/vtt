import { getPaintObjectBounds, pushPaintHistory } from './paint/paintEngine';
import {
  camera,
  getTokenRadius,
  paintObjects,
  runtime,
  tokens,
  walls,
} from './state';
import type { PaintObject, Token, WallSegment } from './types';

export type GizmoHandleType = 'rotate' | 'nw' | 'ne' | 'sw' | 'se';

export interface GizmoBox {
  cx: number;
  cy: number;
  hw: number;
  hh: number;
  rotation: number;
}

export function getSelectedGizmoBox(): GizmoBox | null {
  if (runtime.selectedTokenId !== null) {
    const t = tokens.find((tok) => tok.id === runtime.selectedTokenId);
    if (!t) return null;
    const r = t.size ?? getTokenRadius();
    return {
      cx: t.x,
      cy: t.y,
      hw: r,
      hh: r,
      rotation: t.rotation ?? 0,
    };
  }

  if (runtime.selectedPaintObjectId !== null) {
    const obj = paintObjects.find((o) => o.id === runtime.selectedPaintObjectId);
    if (!obj) return null;
    const b = getPaintObjectBounds(obj);
    return {
      cx: b.x + b.w / 2,
      cy: b.y + b.h / 2,
      hw: Math.max(8, b.w / 2),
      hh: Math.max(8, b.h / 2),
      rotation: obj.rotation ?? 0,
    };
  }

  if (runtime.selectedWallId !== null) {
    const w = walls.find((seg) => seg.id === runtime.selectedWallId);
    if (!w) return null;
    const cx = (w.x1 + w.x2) / 2;
    const cy = (w.y1 + w.y2) / 2;
    const len = Math.hypot(w.x2 - w.x1, w.y2 - w.y1);
    return {
      cx,
      cy,
      hw: Math.max(10, len / 2),
      hh: 10 / camera.zoom,
      rotation: Math.atan2(w.y2 - w.y1, w.x2 - w.x1),
    };
  }

  return null;
}

function toLocal(
  wx: number,
  wy: number,
  cx: number,
  cy: number,
  rotation: number
): { lx: number; ly: number } {
  const dx = wx - cx;
  const dy = wy - cy;
  const cos = Math.cos(-rotation);
  const sin = Math.sin(-rotation);
  return {
    lx: dx * cos - dy * sin,
    ly: dx * sin + dy * cos,
  };
}

export function drawSelectionGizmo(ctx: CanvasRenderingContext2D): void {
  const box = getSelectedGizmoBox();
  if (!box) return;

  const invZoom = 1 / camera.zoom;
  const pad = 6 * invZoom;
  const hw = box.hw + pad;
  const hh = box.hh + pad;
  const rotDist = 24 * invZoom;
  const handleSize = 8 * invZoom;

  ctx.save();
  ctx.translate(box.cx, box.cy);
  ctx.rotate(box.rotation);

  // Bounding box
  ctx.strokeStyle = '#ffe066';
  ctx.lineWidth = 2 * invZoom;
  ctx.setLineDash([6 * invZoom, 4 * invZoom]);
  ctx.strokeRect(-hw, -hh, hw * 2, hh * 2);
  ctx.setLineDash([]);

  // Rotate stem & knob
  ctx.beginPath();
  ctx.moveTo(0, -hh);
  ctx.lineTo(0, -hh - rotDist);
  ctx.stroke();

  ctx.fillStyle = '#ffe066';
  ctx.strokeStyle = '#1a1d24';
  ctx.lineWidth = 1.5 * invZoom;
  ctx.beginPath();
  ctx.arc(0, -hh - rotDist, 6 * invZoom, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // 4 Corner resize handles
  const corners: Array<[number, number]> = [
    [-hw, -hh],
    [hw, -hh],
    [-hw, hh],
    [hw, hh],
  ];
  for (const [cx, cy] of corners) {
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#1a1d24';
    ctx.fillRect(
      cx - handleSize / 2,
      cy - handleSize / 2,
      handleSize,
      handleSize
    );
    ctx.strokeRect(
      cx - handleSize / 2,
      cy - handleSize / 2,
      handleSize,
      handleSize
    );
  }

  ctx.restore();
}

export function hitTestGizmoHandle(
  wx: number,
  wy: number
): GizmoHandleType | null {
  const box = getSelectedGizmoBox();
  if (!box) return null;

  const invZoom = 1 / camera.zoom;
  const pad = 6 * invZoom;
  const hw = box.hw + pad;
  const hh = box.hh + pad;
  const rotDist = 24 * invZoom;
  const hitR = 12 * invZoom;

  const { lx, ly } = toLocal(wx, wy, box.cx, box.cy, box.rotation);

  if (Math.hypot(lx, ly - (-hh - rotDist)) <= hitR) {
    return 'rotate';
  }

  const corners: Array<[GizmoHandleType, number, number]> = [
    ['nw', -hw, -hh],
    ['ne', hw, -hh],
    ['sw', -hw, hh],
    ['se', hw, hh],
  ];
  for (const [name, cx, cy] of corners) {
    if (Math.hypot(lx - cx, ly - cy) <= hitR) {
      return name;
    }
  }

  return null;
}

export interface GizmoDragSession {
  pointerId: number;
  handle: GizmoHandleType;
  targetKind: 'token' | 'paint' | 'wall';
  targetId: number;
  cx: number;
  cy: number;
  origHw: number;
  origHh: number;
  origRotation: number;
  startAngle: number;
  snapshotPaint?: PaintObject;
  snapshotWall?: WallSegment;
  snapshotToken?: Token;
}

export function startGizmoDrag(
  pointerId: number,
  handle: GizmoHandleType,
  wx: number,
  wy: number
): GizmoDragSession | null {
  const box = getSelectedGizmoBox();
  if (!box) return null;

  const startAngle = Math.atan2(wy - box.cy, wx - box.cx);

  if (runtime.selectedTokenId !== null) {
    const t = tokens.find((tok) => tok.id === runtime.selectedTokenId);
    if (!t) return null;
    return {
      pointerId,
      handle,
      targetKind: 'token',
      targetId: t.id,
      cx: box.cx,
      cy: box.cy,
      origHw: box.hw,
      origHh: box.hh,
      origRotation: box.rotation,
      startAngle,
      snapshotToken: { ...t },
    };
  }

  if (runtime.selectedPaintObjectId !== null) {
    const obj = paintObjects.find((o) => o.id === runtime.selectedPaintObjectId);
    if (!obj) return null;
    pushPaintHistory();
    return {
      pointerId,
      handle,
      targetKind: 'paint',
      targetId: obj.id,
      cx: box.cx,
      cy: box.cy,
      origHw: box.hw,
      origHh: box.hh,
      origRotation: box.rotation,
      startAngle,
      snapshotPaint: JSON.parse(JSON.stringify(obj)) as PaintObject,
    };
  }

  if (runtime.selectedWallId !== null) {
    const w = walls.find((seg) => seg.id === runtime.selectedWallId);
    if (!w) return null;
    return {
      pointerId,
      handle,
      targetKind: 'wall',
      targetId: w.id,
      cx: box.cx,
      cy: box.cy,
      origHw: box.hw,
      origHh: box.hh,
      origRotation: box.rotation,
      startAngle,
      snapshotWall: { ...w },
    };
  }

  return null;
}

export function updateGizmoDrag(
  session: GizmoDragSession,
  wx: number,
  wy: number
): void {
  if (session.handle === 'rotate') {
    const delta = Math.atan2(wy - session.cy, wx - session.cx) - session.startAngle;
    const nextRot = session.origRotation + delta;

    if (session.targetKind === 'token') {
      const t = tokens.find((tok) => tok.id === session.targetId);
      if (t) t.rotation = nextRot;
    } else if (session.targetKind === 'paint') {
      const obj = paintObjects.find((o) => o.id === session.targetId);
      if (obj) obj.rotation = nextRot;
    } else if (session.targetKind === 'wall') {
      const w = walls.find((seg) => seg.id === session.targetId);
      if (w) {
        const halfLen = session.origHw;
        w.x1 = session.cx - Math.cos(nextRot) * halfLen;
        w.y1 = session.cy - Math.sin(nextRot) * halfLen;
        w.x2 = session.cx + Math.cos(nextRot) * halfLen;
        w.y2 = session.cy + Math.sin(nextRot) * halfLen;
      }
    }
    return;
  }

  // Resize
  const { lx, ly } = toLocal(
    wx,
    wy,
    session.cx,
    session.cy,
    session.origRotation
  );
  const scaleX = Math.max(0.2, Math.abs(lx) / Math.max(8, session.origHw));
  const scaleY = Math.max(0.2, Math.abs(ly) / Math.max(8, session.origHh));
  const uniformScale = Math.max(scaleX, scaleY);

  if (session.targetKind === 'token' && session.snapshotToken) {
    const t = tokens.find((tok) => tok.id === session.targetId);
    if (t) {
      t.size = Math.max(10, Math.min(256, session.origHw * uniformScale));
    }
  } else if (session.targetKind === 'wall' && session.snapshotWall) {
    const w = walls.find((seg) => seg.id === session.targetId);
    if (w) {
      const halfLen = Math.max(10, session.origHw * scaleX);
      w.x1 = session.cx - Math.cos(session.origRotation) * halfLen;
      w.y1 = session.cy - Math.sin(session.origRotation) * halfLen;
      w.x2 = session.cx + Math.cos(session.origRotation) * halfLen;
      w.y2 = session.cy + Math.sin(session.origRotation) * halfLen;
    }
  } else if (session.targetKind === 'paint' && session.snapshotPaint) {
    const obj = paintObjects.find((o) => o.id === session.targetId);
    const snap = session.snapshotPaint;
    if (!obj) return;

    if (obj.type === 'rect' || obj.type === 'ellipse') {
      const s = snap as Extract<PaintObject, { type: 'rect' | 'ellipse' }>;
      const nextW = Math.max(8, s.w * scaleX);
      const nextH = Math.max(8, s.h * scaleY);
      obj.x = session.cx - nextW / 2;
      obj.y = session.cy - nextH / 2;
      obj.w = nextW;
      obj.h = nextH;
    } else if (obj.type === 'line') {
      const s = snap as Extract<PaintObject, { type: 'line' }>;
      obj.x1 = session.cx + (s.x1 - session.cx) * scaleX;
      obj.y1 = session.cy + (s.y1 - session.cy) * scaleY;
      obj.x2 = session.cx + (s.x2 - session.cx) * scaleX;
      obj.y2 = session.cy + (s.y2 - session.cy) * scaleY;
    } else if (obj.type === 'brush') {
      const s = snap as Extract<PaintObject, { type: 'brush' }>;
      for (let i = 0; i < obj.points.length; i++) {
        obj.points[i].x = session.cx + (s.points[i].x - session.cx) * scaleX;
        obj.points[i].y = session.cy + (s.points[i].y - session.cy) * scaleY;
      }
    } else if (obj.type === 'text') {
      const s = snap as Extract<PaintObject, { type: 'text' }>;
      obj.fontSize = Math.max(8, Math.round(s.fontSize * uniformScale));
    }
  }
}

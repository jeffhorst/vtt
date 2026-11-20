import {
  camera,
  getTokenRadius,
  lights,
  rulesConfig,
  tokens,
  walls,
} from './state';
import type {
  Bounds,
  LightSource,
  Point,
  Segment,
  Token,
  VisibilityHit,
  WallSegment,
  WallType,
} from './types';

export function pathfinderDistanceFt(
  c1: number,
  r1: number,
  c2: number,
  r2: number
): number {
  const dx = Math.abs(c2 - c1);
  const dy = Math.abs(r2 - r1);
  const scale = rulesConfig.feetPerSquare || 5;

  if (rulesConfig.diagonalRule === '1-1-1') {
    return Math.max(dx, dy) * scale;
  }
  if (rulesConfig.diagonalRule === 'euclidean') {
    return Math.round(Math.hypot(dx, dy) * scale);
  }
  // Default: Pathfinder 5/10/5 alternating diagonal rule
  const diag = Math.min(dx, dy);
  const ortho = Math.abs(dx - dy);
  return (ortho + diag) * scale + Math.floor(diag / 2) * scale;
}

export function distToSegment(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - x1, py - y1);
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

export function projectPointOnSegment(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): { x: number; y: number; t: number; dist: number } {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    return { x: x1, y: y1, t: 0, dist: Math.hypot(px - x1, py - y1) };
  }
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
  const x = x1 + t * dx;
  const y = y1 + t * dy;
  return { x, y, t, dist: Math.hypot(px - x, py - y) };
}

export function findWallAt(
  wx: number,
  wy: number,
  filterType: WallType | null = null
): WallSegment | null {
  const hitRadius = 14 / camera.zoom;
  let best: WallSegment | null = null;
  let bestDist = hitRadius;
  for (const w of walls) {
    if (filterType && w.type !== filterType) continue;
    const d = distToSegment(wx, wy, w.x1, w.y1, w.x2, w.y2);
    if (d <= bestDist) {
      bestDist = d;
      best = w;
    }
  }
  return best;
}

export function raySegmentIntersect(
  ox: number,
  oy: number,
  dx: number,
  dy: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): number {
  const sx = x2 - x1;
  const sy = y2 - y1;
  const denom = dx * sy - dy * sx;
  if (Math.abs(denom) < 1e-9) return Infinity;
  const qpx = x1 - ox;
  const qpy = y1 - oy;
  const t = (qpx * sy - qpy * sx) / denom;
  const u = (qpx * dy - qpy * dx) / denom;
  if (t >= 0 && u >= -1e-6 && u <= 1 + 1e-6) return t;
  return Infinity;
}

export function computeVisibilityPolygon(
  ox: number,
  oy: number,
  blockingSegs: Segment[],
  bounds: Bounds
): VisibilityHit[] {
  const { left, top, right, bottom } = bounds;
  const allSegs: Segment[] = [
    ...blockingSegs,
    { x1: left, y1: top, x2: right, y2: top },
    { x1: right, y1: top, x2: right, y2: bottom },
    { x1: right, y1: bottom, x2: left, y2: bottom },
    { x1: left, y1: bottom, x2: left, y2: top },
  ];

  const points: Point[] = [];
  const seen = new Set<string>();
  for (const s of allSegs) {
    const endpoints: [number, number][] = [
      [s.x1, s.y1],
      [s.x2, s.y2],
    ];
    for (const [px, py] of endpoints) {
      const key = `${Math.round(px * 100)},${Math.round(py * 100)}`;
      if (!seen.has(key)) {
        seen.add(key);
        points.push({ x: px, y: py });
      }
    }
  }

  const hits: VisibilityHit[] = [];
  for (const pt of points) {
    const baseAngle = Math.atan2(pt.y - oy, pt.x - ox);
    for (const offset of [-0.0002, 0, 0.0002]) {
      const angle = baseAngle + offset;
      const dx = Math.cos(angle);
      const dy = Math.sin(angle);
      let minT = Infinity;
      for (const s of allSegs) {
        const t = raySegmentIntersect(ox, oy, dx, dy, s.x1, s.y1, s.x2, s.y2);
        if (t < minT) minT = t;
      }
      if (isFinite(minT)) {
        hits.push({
          x: ox + dx * minT,
          y: oy + dy * minT,
          angle,
        });
      }
    }
  }

  hits.sort((a, b) => a.angle - b.angle);
  return hits;
}

export function findTokenAt(x: number, y: number): Token | null {
  const defaultR = getTokenRadius();
  // Search top-to-bottom (end of array is drawn last / on top)
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i];
    const r = t.size ?? defaultR;
    const dx = x - t.x;
    const dy = y - t.y;
    if (dx * dx + dy * dy <= r * r) {
      return t;
    }
  }
  return null;
}

export function resolveLightPosition(light: LightSource): Point {
  if (light.attachedTokenId !== null) {
    const parent = tokens.find((t) => t.id === light.attachedTokenId);
    if (parent) return { x: parent.x, y: parent.y };
  }
  return { x: light.x, y: light.y };
}

export function findLightAt(x: number, y: number): LightSource | null {
  const hitR = Math.max(14, gridSizeFallback() * 0.25);
  for (let i = lights.length - 1; i >= 0; i--) {
    const l = lights[i];
    if (l.attachedTokenId !== null) continue;
    const dx = x - l.x;
    const dy = y - l.y;
    if (dx * dx + dy * dy <= hitR * hitR) {
      return l;
    }
  }
  return null;
}

function gridSizeFallback(): number {
  return Math.max(16, getTokenRadius() / 0.4);
}

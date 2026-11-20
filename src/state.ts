import type {
  ActiveDrag,
  ActiveRuler,
  CameraState,
  CellCoord,
  DraftWall,
  FogState,
  GridState,
  LightPreset,
  LightSource,
  LightingState,
  LosState,
  PaintObject,
  PaintState,
  Point,
  RulesConfig,
  Token,
  ToolMode,
  User,
  WallSegment,
} from './types';

export const MIN_ZOOM = 0.15;
export const MAX_ZOOM = 8;

export const grid: GridState = {
  size: 64,
  offsetX: 0,
  offsetY: 0,
  visible: true,
  color: '#ffffff',
  opacity: 0.25,
};

export const camera: CameraState = { x: 0, y: 0, zoom: 1 };

export const fog: FogState = {
  enabled: false,
  peek: false,
  tool: 'reveal',
  brushSize: 100,
};

export const los: LosState = {
  enabled: false,
  peek: false,
};

export const lighting: LightingState = {
  enabled: false,
  ambient: 'darkness',
  visionMode: 'normal',
};

export const lights: LightSource[] = [];

export const tokens: Token[] = [
  { id: 1, x: 224, y: 224, color: '#e05a47', label: 'P1' },
  { id: 2, x: 352, y: 224, color: '#4a90e2', label: 'P2' },
];

export const walls: WallSegment[] = [];
export const paintObjects: PaintObject[] = [];

export const activeDrags = new Map<number, ActiveDrag>();
export const activeFogStrokes = new Map<number, Point>();
export const activeRulers = new Map<number, ActiveRuler>();
export const navPointers = new Map<number, Point>();

export const fogCanvas = document.createElement('canvas');
const fogContext = fogCanvas.getContext('2d');
if (!fogContext) {
  throw new Error('Could not initialize 2D context for fog canvas');
}
export const fogCtx: CanvasRenderingContext2D = fogContext;

export const losMaskCanvas = document.createElement('canvas');
const losMaskContext = losMaskCanvas.getContext('2d');
if (!losMaskContext) {
  throw new Error('Could not initialize 2D context for LoS mask canvas');
}
export const losMaskCtx: CanvasRenderingContext2D = losMaskContext;

export const lightMaskCanvas = document.createElement('canvas');
const lightMaskContext = lightMaskCanvas.getContext('2d');
if (!lightMaskContext) {
  throw new Error('Could not initialize 2D context for light mask canvas');
}
export const lightMaskCtx: CanvasRenderingContext2D = lightMaskContext;

export const paintCanvas = document.createElement('canvas');
const paintContext = paintCanvas.getContext('2d', { willReadFrequently: true });
if (!paintContext) {
  throw new Error('Could not initialize 2D context for paint canvas');
}
export const paintCtx: CanvasRenderingContext2D = paintContext;

export const paintPreviewCanvas = document.createElement('canvas');
const paintPreviewContext = paintPreviewCanvas.getContext('2d');
if (!paintPreviewContext) {
  throw new Error('Could not initialize 2D context for paint preview canvas');
}
export const paintPreviewCtx: CanvasRenderingContext2D = paintPreviewContext;

export const paintState: PaintState = {
  tool: 'brush',
  primaryColor: '#ef4444',
  secondaryColor: '#ffffff',
  size: 6,
  opacity: 1,
  fillMode: 'outline',
  fontSize: 24,
};

export interface AppRuntime {
  activeTool: ToolMode;
  selectedTokenId: number | null;
  selectedPaintObjectId: number | null;
  selectedWallId: number | null;
  selectedLightId: number | null;
  pendingLight: LightPreset | null;
  cursorWorldPos: { x: number; y: number } | null;
  draftWall: DraftWall | null;
  mapImage: HTMLImageElement | null;
  mapVideo: HTMLVideoElement | null;
  mapIsAnimated: boolean;
  mapObjectUrl: string | null;
  mapBlob: Blob | null;
  activeSceneId: number | null;
  activeSceneName: string;
  currentUser: User | null;
  simulatePlayerView: boolean;
  fogDirty: boolean;
  paintDirty: boolean;
}

export const rulesConfig: RulesConfig = {
  diagonalRule: '5-10-5',
  feetPerSquare: 5,
  allowPlayerDoors: true,
};

export const runtime: AppRuntime = {
  activeTool: 'select',
  selectedTokenId: null,
  selectedPaintObjectId: null,
  selectedWallId: null,
  selectedLightId: null,
  pendingLight: null,
  cursorWorldPos: null,
  draftWall: null,
  mapImage: null,
  mapVideo: null,
  mapIsAnimated: false,
  mapObjectUrl: null,
  mapBlob: null,
  activeSceneId: null,
  activeSceneName: 'Arena',
  currentUser: null,
  simulatePlayerView: false,
  fogDirty: false,
  paintDirty: false,
};

export function isEffectiveGmMapView(): boolean {
  return runtime.currentUser?.role === 'gm' && !runtime.simulatePlayerView;
}

export function clearMapMedia(): void {
  if (runtime.mapVideo) {
    runtime.mapVideo.pause();
    runtime.mapVideo.removeAttribute('src');
    runtime.mapVideo.load();
    runtime.mapVideo.remove();
    runtime.mapVideo = null;
  }
  if (runtime.mapImage) {
    runtime.mapImage.remove();
    runtime.mapImage = null;
  }
  if (runtime.mapObjectUrl) {
    URL.revokeObjectURL(runtime.mapObjectUrl);
    runtime.mapObjectUrl = null;
  }
  runtime.mapBlob = null;
  runtime.mapIsAnimated = false;
}

export function getActiveMapSource(): HTMLImageElement | HTMLVideoElement | null {
  return runtime.mapVideo ?? runtime.mapImage;
}

export function getActiveMapDimensions(): {
  width: number;
  height: number;
} | null {
  if (runtime.mapVideo) {
    return {
      width: runtime.mapVideo.videoWidth,
      height: runtime.mapVideo.videoHeight,
    };
  }
  if (runtime.mapImage) {
    return { width: runtime.mapImage.width, height: runtime.mapImage.height };
  }
  return null;
}

export function initPaintCanvas(w: number, h: number, preserve = false): void {
  let prev: HTMLCanvasElement | null = null;
  if (preserve && paintCanvas.width > 0 && paintCanvas.height > 0) {
    prev = document.createElement('canvas');
    prev.width = paintCanvas.width;
    prev.height = paintCanvas.height;
    prev.getContext('2d')?.drawImage(paintCanvas, 0, 0);
  }
  paintCanvas.width = w;
  paintCanvas.height = h;
  paintPreviewCanvas.width = w;
  paintPreviewCanvas.height = h;
  if (prev) {
    paintCtx.drawImage(prev, 0, 0);
  }
}

initPaintCanvas(2048, 2048, false);

export function initFogCanvas(w: number, h: number, fill = true): void {
  fogCanvas.width = w;
  fogCanvas.height = h;
  if (fill) {
    fogCtx.globalCompositeOperation = 'source-over';
    fogCtx.fillStyle = '#0a0c10';
    fogCtx.fillRect(0, 0, w, h);
  }
}

initFogCanvas(2048, 2048, true);

export function getTokenRadius(): number {
  return grid.size * 0.4;
}

export function screenToWorld(sx: number, sy: number): Point {
  return {
    x: (sx - camera.x) / camera.zoom,
    y: (sy - camera.y) / camera.zoom,
  };
}

export function zoomAt(sx: number, sy: number, newZoom: number): void {
  const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, newZoom));
  const wx = (sx - camera.x) / camera.zoom;
  const wy = (sy - camera.y) / camera.zoom;
  camera.zoom = clamped;
  camera.x = sx - wx * camera.zoom;
  camera.y = sy - wy * camera.zoom;
}

export function worldToCell(wx: number, wy: number): CellCoord {
  return {
    col: Math.floor((wx - grid.offsetX) / grid.size),
    row: Math.floor((wy - grid.offsetY) / grid.size),
  };
}

export function cellToWorldCenter(col: number, row: number): Point {
  return {
    x: col * grid.size + grid.offsetX + grid.size / 2,
    y: row * grid.size + grid.offsetY + grid.size / 2,
  };
}

export function snapHalfGrid(wx: number, wy: number): Point {
  const step = grid.size / 2;
  return {
    x: Math.round((wx - grid.offsetX) / step) * step + grid.offsetX,
    y: Math.round((wy - grid.offsetY) / step) * step + grid.offsetY,
  };
}

export function snapToGrid(token: Token): void {
  token.x =
    Math.floor((token.x - grid.offsetX) / grid.size) * grid.size +
    grid.offsetX +
    grid.size / 2;
  token.y =
    Math.floor((token.y - grid.offsetY) / grid.size) * grid.size +
    grid.offsetY +
    grid.size / 2;
}

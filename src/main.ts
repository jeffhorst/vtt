import './styles.css';
import { api } from './api';
import {
  findLightAt,
  findTokenAt,
  findWallAt,
  projectPointOnSegment,
} from './geometry';
import { detectGrid } from './gridDetect';
import {
  copyPaintSelection,
  deletePaintSelection,
  findPaintObjectAt,
  handlePaintPointerDown,
  handlePaintPointerMove,
  handlePaintPointerUp,
  markPaintChanged,
  movePaintObject,
  pastePaintSelection,
  pushPaintHistory,
  redoPaint,
  undoPaint,
} from './paint/paintEngine';
import {
  applySceneData,
  clearMapCache,
  flushDirtyBlobsNow,
  loadMapMediaFromBlob,
  restoreState,
  saveActiveSceneCamera,
  scheduleSave,
  setOnSceneChangedHook,
  uploadActiveMapBlob,
} from './persistence';
import {
  draw,
  initRenderer,
  invalidateLosCache,
  paintFogDot,
  paintFogLine,
  resizeCanvas,
} from './renderer';
import {
  MAX_ZOOM,
  MIN_ZOOM,
  activeDrags,
  activeFogStrokes,
  activeRulers,
  camera,
  clearMapMedia,
  fog,
  fogCanvas,
  fogCtx,
  getActiveMapDimensions,
  getActiveMapSource,
  grid,
  initFogCanvas,
  initPaintCanvas,
  lighting,
  lights,
  los,
  navPointers,
  rulesConfig,
  runtime,
  screenToWorld,
  snapHalfGrid,
  snapToGrid,
  tokens,
  walls,
  worldToCell,
  zoomAt,
} from './state';
import type {
  FloatingWindowInstance,
  FogTool,
  LightSource,
  ToolMode,
} from './types';
import {
  createAccordionSection,
  createFloatingWindow,
} from './ui/floatingWindow';
import {
  setupActorsTab,
  setupChatTab,
  setupConfigTab,
  setupScenesAccordion,
} from './ui/menuTabs';
import {
  populateLightingPanel,
  type LightingPanelController,
} from './ui/lightingPanel';
import { createObjectBar, type ObjectBarController } from './ui/objectBar';
import { applyThemeColor, getSavedThemeColor } from './ui/theme';
import {
  PAINT_PALETTE,
  populatePaintPanel,
  type PaintPanelController,
} from './ui/paintWindow';
import {
  hitTestGizmoHandle,
  startGizmoDrag,
  updateGizmoDrag,
  type GizmoDragSession,
} from './transformGizmo';
import {
  connectRealtimeSync,
  disconnectRealtimeSync,
  initRealtimeSync,
  sendSyncAction,
  sendTokenMoveDelta,
  type SyncConnectionState,
} from './sync';
import { createLobbyView } from './ui/lobbyView';
import { createLoginView } from './ui/loginView';

function requireEl<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`Required element #${id} not found`);
  }
  return el as T;
}

const canvas = requireEl<HTMLCanvasElement>('table');
initRenderer(canvas);

const mapInput = requireEl<HTMLInputElement>('map-input');

// Scene & Fog UI elements populated inside Menu/Tools accordions
let gridSizeSlider: HTMLInputElement | undefined;
let gridSizeVal: HTMLElement | undefined;
let gridSizeMinus: HTMLButtonElement | undefined;
let gridSizePlus: HTMLButtonElement | undefined;
let gridToggleBtn: HTMLButtonElement | undefined;
let gridOffsetVal: HTMLElement | undefined;
let autoAlignBtn: HTMLButtonElement | undefined;
let gridDetectStatus: HTMLElement | undefined;
let gridColorBtn: HTMLButtonElement | undefined;
let gridColorSwatches: Map<string, HTMLButtonElement> | undefined;
let gridOpacitySlider: HTMLInputElement | undefined;
let gridOpacityVal: HTMLElement | undefined;

let fogEnableBtn: HTMLButtonElement | undefined;
let fogPeekBtn: HTMLButtonElement | undefined;
let fogToolReveal: HTMLButtonElement | undefined;
let fogToolHide: HTMLButtonElement | undefined;
let fogBrushSlider: HTMLInputElement | undefined;
let fogBrushVal: HTMLElement | undefined;

let losEnableBtn: HTMLButtonElement | undefined;
let losPeekBtn: HTMLButtonElement | undefined;
let losToolWall: HTMLButtonElement | undefined;
let losToolDoor: HTMLButtonElement | undefined;
let losToolSecretDoor: HTMLButtonElement | undefined;
let losToolErase: HTMLButtonElement | undefined;

let toolsSelectBtn: HTMLButtonElement | undefined;
let toolsPanBtn: HTMLButtonElement | undefined;
let toolsRulerBtn: HTMLButtonElement | undefined;

function resetView(): void {
  const dims = getActiveMapDimensions();
  if (dims && dims.width > 0 && dims.height > 0) {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const scale = Math.min(w / dims.width, h / dims.height);
    camera.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale));
    camera.x = (w - dims.width * camera.zoom) / 2;
    camera.y = (h - dims.height * camera.zoom) / 2;
  } else {
    camera.x = 0;
    camera.y = 0;
    camera.zoom = 1;
  }
  draw();
}

function syncGridUI(): void {
  if (
    !gridSizeSlider ||
    !gridSizeVal ||
    !gridOffsetVal ||
    !gridToggleBtn
  ) {
    return;
  }
  gridSizeSlider.value = String(grid.size);
  gridSizeVal.textContent = `${Number(grid.size.toFixed(2))} px`;
  gridOffsetVal.textContent = `${Number(grid.offsetX.toFixed(1))}, ${Number(grid.offsetY.toFixed(1))}`;
  gridToggleBtn.textContent = grid.visible ? 'Hide Grid' : 'Show Grid';
  const activeGridHex = (grid.color ?? '#ffffff').toLowerCase();
  if (gridColorBtn) gridColorBtn.style.background = grid.color ?? '#ffffff';
  if (gridColorSwatches) {
    for (const [hex, sw] of gridColorSwatches) {
      sw.classList.toggle('active', hex === activeGridHex);
    }
  }
  const alpha =
    typeof grid.opacity === 'number'
      ? Math.min(1, Math.max(0, grid.opacity))
      : 0.25;
  if (gridOpacitySlider) gridOpacitySlider.value = String(alpha);
  if (gridOpacityVal) gridOpacityVal.textContent = `${Math.round(alpha * 100)}%`;
}

function setGridSize(nextSize: number): void {
  grid.size = Math.min(256, Math.max(16, nextSize));
  syncGridUI();
  draw();
  sendSyncAction({ action: 'grid:update', grid: { ...grid } });
}

function nudgeGrid(dx: number, dy: number): void {
  grid.offsetX = (((grid.offsetX + dx) % grid.size) + grid.size) % grid.size;
  grid.offsetY = (((grid.offsetY + dy) % grid.size) + grid.size) % grid.size;
  syncGridUI();
  draw();
  sendSyncAction({ action: 'grid:update', grid: { ...grid } });
}

let paintCtrl: PaintPanelController | undefined;
let lightingCtrl: LightingPanelController | undefined;
let objectBar: ObjectBarController | undefined;

function syncToolUI(): void {
  toolsSelectBtn?.classList.toggle('active', runtime.activeTool === 'select');
  toolsPanBtn?.classList.toggle('active', runtime.activeTool === 'pan');
  toolsRulerBtn?.classList.toggle('active', runtime.activeTool === 'ruler');
  fogToolReveal?.classList.toggle(
    'active',
    runtime.activeTool === 'fog' && fog.tool === 'reveal'
  );
  fogToolHide?.classList.toggle(
    'active',
    runtime.activeTool === 'fog' && fog.tool === 'hide'
  );
  losToolWall?.classList.toggle('active', runtime.activeTool === 'los-wall');
  losToolDoor?.classList.toggle('active', runtime.activeTool === 'los-door');
  losToolSecretDoor?.classList.toggle(
    'active',
    runtime.activeTool === 'los-secret-door'
  );
  losToolErase?.classList.toggle('active', runtime.activeTool === 'los-erase');
  canvas.style.cursor = runtime.activeTool === 'place-light' ? 'none' : '';
  if (runtime.activeTool !== 'place-light') {
    runtime.pendingLight = null;
    runtime.cursorWorldPos = null;
  }
  lightingCtrl?.syncUI();
  paintCtrl?.syncUI();
}

function setActiveTool(tool: ToolMode): void {
  runtime.activeTool = tool;
  syncToolUI();
  draw();
}

function syncFogUI(): void {
  if (!fogEnableBtn || !fogPeekBtn || !fogBrushSlider || !fogBrushVal) return;
  fogEnableBtn.textContent = fog.enabled ? 'On' : 'Off';
  fogEnableBtn.classList.toggle('active', fog.enabled);
  fogPeekBtn.textContent = fog.peek ? 'On' : 'Off';
  fogPeekBtn.classList.toggle('active', fog.peek);
  fogBrushSlider.value = String(fog.brushSize);
  fogBrushVal.textContent = `${fog.brushSize} px`;
  syncToolUI();
}

function setFogBrush(mode: FogTool): void {
  fog.tool = mode;
  if (!fog.enabled) fog.enabled = true;
  runtime.activeTool = 'fog';
  syncFogUI();
  draw();
  sendSyncAction({
    action: 'fog:update',
    fog: { enabled: fog.enabled, peek: fog.peek, brushSize: fog.brushSize },
  });
}

function syncLosUI(): void {
  if (!losEnableBtn || !losPeekBtn) return;
  losEnableBtn.textContent = los.enabled ? 'On' : 'Off';
  losEnableBtn.classList.toggle('active', los.enabled);
  losPeekBtn.textContent = los.peek ? 'On' : 'Off';
  losPeekBtn.classList.toggle('active', los.peek);
  syncToolUI();
}

function autoAlignGrid(): void {
  if (!gridDetectStatus) return;
  const mapSrc = getActiveMapSource();
  if (!mapSrc) {
    gridDetectStatus.textContent = 'Load a map first';
    return;
  }

  const result = detectGrid(mapSrc);
  if (!result) {
    gridDetectStatus.textContent = 'No grid detected';
    return;
  }

  grid.size = result.size;
  grid.offsetX = result.offsetX;
  grid.offsetY = result.offsetY;
  syncGridUI();
  draw();
  sendSyncAction({ action: 'grid:update', grid: { ...grid } });
  gridDetectStatus.textContent = `Matched ${result.size} px grid`;
}

function isSupportedMapFile(file: File): boolean {
  if (file.type.startsWith('image/') || file.type.startsWith('video/')) {
    return true;
  }
  const lower = file.name.toLowerCase();
  return (
    lower.endsWith('.webm') ||
    lower.endsWith('.mp4') ||
    lower.endsWith('.m4v') ||
    lower.endsWith('.gif') ||
    lower.endsWith('.webp') ||
    lower.endsWith('.png') ||
    lower.endsWith('.jpg') ||
    lower.endsWith('.jpeg')
  );
}

function loadMapFile(file: File | undefined): void {
  if (!file || !isSupportedMapFile(file)) return;

  const lower = file.name.toLowerCase();
  const normalizedBlob: Blob =
    lower.endsWith('.m4v') || file.type === 'video/x-m4v'
      ? file.slice(0, file.size, 'video/mp4')
      : file;

  const mapName = file.name.replace(/\.[^.]+$/, '');

  void (async () => {
    try {
      saveActiveSceneCamera();
      await flushDirtyBlobsNow();
      const { scene } = await api.createScene(mapName);
      await applySceneData(scene, syncAllUI);
      const dims = await loadMapMediaFromBlob(normalizedBlob);
      initFogCanvas(dims.width, dims.height, false);
      initPaintCanvas(dims.width, dims.height, false);
      runtime.fogDirty = true;
      resetView();
      autoAlignGrid();
      await uploadActiveMapBlob(normalizedBlob);
      await api.uploadSavedMap(mapName, normalizedBlob, scene.id);
      scheduleSave();
      await Promise.all([refreshScenes(), refreshSavedMaps?.()]);
    } catch (err) {
      console.warn('Could not load map file:', err);
    }
  })();
}

// --- Canvas Pointer & Wheel Events ---
const activePaintDrags = new Map<
  number,
  { id: number; lastX: number; lastY: number; moved: boolean }
>();
const activeWallDrags = new Map<
  number,
  { id: number; isDoor: boolean; lastX: number; lastY: number; moved: boolean }
>();
const activeLightDrags = new Map<
  number,
  { id: number; offsetX: number; offsetY: number; moved: boolean }
>();
let activeGizmoDrag: GizmoDragSession | null = null;

function snapDoorToWallOrGrid(wx: number, wy: number): { x: number; y: number } {
  const nearWall = findWallAt(wx, wy, 'wall');
  if (nearWall) {
    const proj = projectPointOnSegment(
      wx,
      wy,
      nearWall.x1,
      nearWall.y1,
      nearWall.x2,
      nearWall.y2
    );
    return { x: proj.x, y: proj.y };
  }
  return snapHalfGrid(wx, wy);
}

canvas.addEventListener('pointerdown', (e: PointerEvent) => {
  canvas.setPointerCapture(e.pointerId);

  const world = screenToWorld(e.clientX, e.clientY);

  if (runtime.activeTool === 'paint') {
    handlePaintPointerDown(e, world);
    return;
  }

  if (runtime.activeTool === 'place-light' && runtime.pendingLight) {
    if (e.button === 0) {
      const preset = runtime.pendingLight;
      const newLight: LightSource = {
        id: Date.now() + Math.floor(Math.random() * 1000),
        ownerId: runtime.currentUser?.id ?? null,
        attachedTokenId: null,
        name: preset.name,
        kind: preset.kind,
        spellLevel: preset.spellLevel,
        x: world.x,
        y: world.y,
        enabled: true,
        innerRadiusFt: preset.innerRadiusFt,
        outerRadiusFt: preset.outerRadiusFt,
        color: preset.color,
      };
      lights.push(newLight);
      if (!lighting.enabled && runtime.currentUser?.role === 'gm') {
        lighting.enabled = true;
        sendSyncAction({
          action: 'lighting:update',
          lighting: { enabled: lighting.enabled, ambient: lighting.ambient },
        });
      }
      sendSyncAction({ action: 'lights:sync', lights });
      runtime.selectedLightId = newLight.id;
      runtime.selectedTokenId = null;
      runtime.selectedPaintObjectId = null;
      runtime.selectedWallId = null;
      setActiveTool('select');
      objectBar?.sync(true);
    } else {
      setActiveTool('select');
    }
    return;
  }

  if (
    runtime.activeTool === 'los-wall' ||
    runtime.activeTool === 'los-door' ||
    runtime.activeTool === 'los-secret-door'
  ) {
    const isDoor = runtime.activeTool !== 'los-wall';
    const pt = isDoor
      ? snapDoorToWallOrGrid(world.x, world.y)
      : snapHalfGrid(world.x, world.y);
    runtime.draftWall = {
      pointerId: e.pointerId,
      type: isDoor ? 'door' : 'wall',
      x1: pt.x,
      y1: pt.y,
      x2: pt.x,
      y2: pt.y,
    };
    draw();
    return;
  }

  if (runtime.activeTool === 'los-erase') {
    const hit = findWallAt(world.x, world.y);
    if (hit) {
      const idx = walls.indexOf(hit);
      if (idx !== -1) walls.splice(idx, 1);
      invalidateLosCache();
      draw();
      sendSyncAction({ action: 'wall:delete', id: hit.id });
    }
    return;
  }

  if (runtime.activeTool === 'fog' && fog.enabled) {
    activeFogStrokes.set(e.pointerId, { x: world.x, y: world.y });
    paintFogDot(world.x, world.y);
    runtime.fogDirty = true;
    draw();
    return;
  }

  if (runtime.activeTool === 'ruler') {
    const token = findTokenAt(world.x, world.y);
    if (!token) {
      const cell = worldToCell(world.x, world.y);
      activeRulers.set(e.pointerId, {
        startCol: cell.col,
        startRow: cell.row,
        endCol: cell.col,
        endRow: cell.row,
      });
      draw();
      return;
    }
  }

  if (runtime.activeTool === 'pan') {
    navPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    return;
  }

  // Check transform gizmo handles (resize / rotate) on currently selected object
  const gizmoHandle = hitTestGizmoHandle(world.x, world.y);
  if (gizmoHandle) {
    activeGizmoDrag = startGizmoDrag(
      e.pointerId,
      gizmoHandle,
      world.x,
      world.y
    );
    if (activeGizmoDrag) {
      draw();
      return;
    }
  }

  const token = findTokenAt(world.x, world.y);

  if (token) {
    runtime.selectedTokenId = token.id;
    runtime.selectedPaintObjectId = null;
    runtime.selectedWallId = null;
    runtime.selectedLightId = null;
    lightingCtrl?.syncUI();

    // Bring touched token to top
    const idx = tokens.indexOf(token);
    if (idx !== -1) {
      tokens.splice(idx, 1);
      tokens.push(token);
    }

    const startCell = worldToCell(token.x, token.y);
    activeDrags.set(e.pointerId, {
      token,
      offsetX: token.x - world.x,
      offsetY: token.y - world.y,
      startCol: startCell.col,
      startRow: startCell.row,
    });

    objectBar?.sync(true);
    draw();
  } else {
    const light = findLightAt(world.x, world.y);
    if (light) {
      runtime.selectedLightId = light.id;
      runtime.selectedTokenId = null;
      runtime.selectedPaintObjectId = null;
      runtime.selectedWallId = null;
      activeLightDrags.set(e.pointerId, {
        id: light.id,
        offsetX: light.x - world.x,
        offsetY: light.y - world.y,
        moved: false,
      });
      lightingCtrl?.syncUI();
      objectBar?.sync(true);
      draw();
      return;
    }

    const paintObj = findPaintObjectAt(world.x, world.y);
    if (paintObj) {
      runtime.selectedPaintObjectId = paintObj.id;
      runtime.selectedTokenId = null;
      runtime.selectedWallId = null;
      runtime.selectedLightId = null;
      pushPaintHistory();
      activePaintDrags.set(e.pointerId, {
        id: paintObj.id,
        lastX: world.x,
        lastY: world.y,
        moved: false,
      });
      objectBar?.sync(true);
      draw();
      return;
    }

    const door = findWallAt(world.x, world.y, 'door');
    const isGm = runtime.currentUser?.role === 'gm';
    if (door && (!door.secret || door.revealed || isGm)) {
      runtime.selectedWallId = door.id;
      runtime.selectedTokenId = null;
      runtime.selectedPaintObjectId = null;
      runtime.selectedLightId = null;
      activeWallDrags.set(e.pointerId, {
        id: door.id,
        isDoor: true,
        lastX: world.x,
        lastY: world.y,
        moved: false,
      });
      objectBar?.sync(true);
      draw();
      return;
    }

    const wall = findWallAt(world.x, world.y, 'wall');
    if (wall) {
      runtime.selectedWallId = wall.id;
      runtime.selectedTokenId = null;
      runtime.selectedPaintObjectId = null;
      runtime.selectedLightId = null;
      if (isGm) {
        activeWallDrags.set(e.pointerId, {
          id: wall.id,
          isDoor: false,
          lastX: world.x,
          lastY: world.y,
          moved: false,
        });
      }
      objectBar?.sync(true);
      draw();
      return;
    }

    if (
      runtime.selectedTokenId !== null ||
      runtime.selectedPaintObjectId !== null ||
      runtime.selectedWallId !== null ||
      runtime.selectedLightId !== null
    ) {
      runtime.selectedTokenId = null;
      runtime.selectedPaintObjectId = null;
      runtime.selectedWallId = null;
      runtime.selectedLightId = null;
      objectBar?.sync(true);
      draw();
    }
    navPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  }
});

canvas.addEventListener('pointermove', (e: PointerEvent) => {
  if (activeGizmoDrag && activeGizmoDrag.pointerId === e.pointerId) {
    const world = screenToWorld(e.clientX, e.clientY);
    updateGizmoDrag(activeGizmoDrag, world.x, world.y);
    if (activeGizmoDrag.targetKind === 'wall') invalidateLosCache();
    draw();
    return;
  }

  if (runtime.activeTool === 'paint') {
    handlePaintPointerMove(e, screenToWorld(e.clientX, e.clientY));
    return;
  }

  if (runtime.activeTool === 'place-light') {
    runtime.cursorWorldPos = screenToWorld(e.clientX, e.clientY);
    draw();
    return;
  }

  if (runtime.draftWall && runtime.draftWall.pointerId === e.pointerId) {
    const world = screenToWorld(e.clientX, e.clientY);
    const pt =
      runtime.draftWall.type === 'door'
        ? snapDoorToWallOrGrid(world.x, world.y)
        : snapHalfGrid(world.x, world.y);
    runtime.draftWall.x2 = pt.x;
    runtime.draftWall.y2 = pt.y;
    draw();
    return;
  }

  if (runtime.activeTool === 'los-erase' && e.buttons > 0) {
    const world = screenToWorld(e.clientX, e.clientY);
    const hit = findWallAt(world.x, world.y);
    if (hit) {
      const idx = walls.indexOf(hit);
      if (idx !== -1) walls.splice(idx, 1);
      invalidateLosCache();
      draw();
      sendSyncAction({ action: 'wall:delete', id: hit.id });
    }
    return;
  }

  const fogStroke = activeFogStrokes.get(e.pointerId);
  if (fogStroke) {
    const world = screenToWorld(e.clientX, e.clientY);
    paintFogLine(fogStroke.x, fogStroke.y, world.x, world.y);
    runtime.fogDirty = true;
    fogStroke.x = world.x;
    fogStroke.y = world.y;
    draw();
    return;
  }

  const ruler = activeRulers.get(e.pointerId);
  if (ruler) {
    const world = screenToWorld(e.clientX, e.clientY);
    const cell = worldToCell(world.x, world.y);
    ruler.endCol = cell.col;
    ruler.endRow = cell.row;
    draw();
    return;
  }

  const drag = activeDrags.get(e.pointerId);
  if (drag) {
    const world = screenToWorld(e.clientX, e.clientY);
    drag.token.x = world.x + drag.offsetX;
    drag.token.y = world.y + drag.offsetY;
    invalidateLosCache();
    draw();
    sendTokenMoveDelta(drag.token.id, drag.token.x, drag.token.y, true);
    return;
  }

  const pDrag = activePaintDrags.get(e.pointerId);
  if (pDrag) {
    const world = screenToWorld(e.clientX, e.clientY);
    const dx = world.x - pDrag.lastX;
    const dy = world.y - pDrag.lastY;
    if (dx !== 0 || dy !== 0) {
      movePaintObject(pDrag.id, dx, dy);
      pDrag.lastX = world.x;
      pDrag.lastY = world.y;
      pDrag.moved = true;
      draw();
    }
    return;
  }

  const lDrag = activeLightDrags.get(e.pointerId);
  if (lDrag) {
    const world = screenToWorld(e.clientX, e.clientY);
    const light = lights.find((l) => l.id === lDrag.id);
    if (light) {
      light.x = world.x + lDrag.offsetX;
      light.y = world.y + lDrag.offsetY;
      lDrag.moved = true;
      draw();
    }
    return;
  }

  const wDrag = activeWallDrags.get(e.pointerId);
  if (wDrag) {
    const world = screenToWorld(e.clientX, e.clientY);
    const dx = world.x - wDrag.lastX;
    const dy = world.y - wDrag.lastY;
    if (
      runtime.currentUser?.role === 'gm' &&
      (wDrag.moved || Math.hypot(dx, dy) > 3 / camera.zoom)
    ) {
      const wall = walls.find((w) => w.id === wDrag.id);
      if (wall) {
        wall.x1 += dx;
        wall.y1 += dy;
        wall.x2 += dx;
        wall.y2 += dy;
        wDrag.lastX = world.x;
        wDrag.lastY = world.y;
        wDrag.moved = true;
        invalidateLosCache();
        draw();
      }
    }
    return;
  }

  const prev = navPointers.get(e.pointerId);
  if (!prev) return;

  if (navPointers.size === 1) {
    camera.x += e.clientX - prev.x;
    camera.y += e.clientY - prev.y;
    navPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    draw();
  } else if (navPointers.size === 2) {
    const ptsBefore = Array.from(navPointers.values());
    const oldMidX = (ptsBefore[0].x + ptsBefore[1].x) / 2;
    const oldMidY = (ptsBefore[0].y + ptsBefore[1].y) / 2;
    const oldDist = Math.hypot(
      ptsBefore[1].x - ptsBefore[0].x,
      ptsBefore[1].y - ptsBefore[0].y
    );

    navPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    const ptsAfter = Array.from(navPointers.values());
    const newMidX = (ptsAfter[0].x + ptsAfter[1].x) / 2;
    const newMidY = (ptsAfter[0].y + ptsAfter[1].y) / 2;
    const newDist = Math.hypot(
      ptsAfter[1].x - ptsAfter[0].x,
      ptsAfter[1].y - ptsAfter[0].y
    );

    camera.x += newMidX - oldMidX;
    camera.y += newMidY - oldMidY;

    if (oldDist > 0) {
      zoomAt(newMidX, newMidY, camera.zoom * (newDist / oldDist));
    }

    draw();
  }
});

function endDrag(e: PointerEvent): void {
  if (activeGizmoDrag && activeGizmoDrag.pointerId === e.pointerId) {
    const finished = activeGizmoDrag;
    activeGizmoDrag = null;
    if (finished.targetKind === 'paint') {
      markPaintChanged();
    } else if (finished.targetKind === 'wall') {
      const w = walls.find((seg) => seg.id === finished.targetId);
      if (w) {
        sendSyncAction({
          action: 'wall:update',
          id: w.id,
          x1: w.x1,
          y1: w.y1,
          x2: w.x2,
          y2: w.y2,
        });
      }
    }
    draw();
    return;
  }

  if (runtime.activeTool === 'paint') {
    handlePaintPointerUp(e, screenToWorld(e.clientX, e.clientY));
    return;
  }

  if (runtime.draftWall && runtime.draftWall.pointerId === e.pointerId) {
    const dw = runtime.draftWall;
    runtime.draftWall = null;
    if (Math.hypot(dw.x2 - dw.x1, dw.y2 - dw.y1) >= 6) {
      const isSecret = runtime.activeTool === 'los-secret-door';
      if (dw.type === 'door') {
        const snapDist = 14 / camera.zoom;
        const hostWall = walls.find((w) => {
          if (w.type !== 'wall') return false;
          const p1 = projectPointOnSegment(dw.x1, dw.y1, w.x1, w.y1, w.x2, w.y2);
          const p2 = projectPointOnSegment(dw.x2, dw.y2, w.x1, w.y1, w.x2, w.y2);
          return (
            p1.dist <= snapDist &&
            p2.dist <= snapDist &&
            Math.abs(p2.t - p1.t) > 0.02
          );
        });

        if (hostWall) {
          const p1 = projectPointOnSegment(
            dw.x1,
            dw.y1,
            hostWall.x1,
            hostWall.y1,
            hostWall.x2,
            hostWall.y2
          );
          const p2 = projectPointOnSegment(
            dw.x2,
            dw.y2,
            hostWall.x1,
            hostWall.y1,
            hostWall.x2,
            hostWall.y2
          );
          const first = p1.t <= p2.t ? p1 : p2;
          const second = p1.t <= p2.t ? p2 : p1;

          sendSyncAction({ action: 'wall:delete', id: hostWall.id });

          if (first.t > 0.02) {
            sendSyncAction({
              action: 'wall:add',
              wallType: 'wall',
              x1: hostWall.x1,
              y1: hostWall.y1,
              x2: first.x,
              y2: first.y,
            });
          }

          sendSyncAction({
            action: 'wall:add',
            wallType: 'door',
            secret: isSecret,
            x1: first.x,
            y1: first.y,
            x2: second.x,
            y2: second.y,
          });

          if (second.t < 0.98) {
            sendSyncAction({
              action: 'wall:add',
              wallType: 'wall',
              x1: second.x,
              y1: second.y,
              x2: hostWall.x2,
              y2: hostWall.y2,
            });
          }

          draw();
          return;
        }
      }

      sendSyncAction({
        action: 'wall:add',
        wallType: dw.type,
        secret: isSecret,
        x1: dw.x1,
        y1: dw.y1,
        x2: dw.x2,
        y2: dw.y2,
      });
    }
    draw();
    return;
  }

  if (activeRulers.delete(e.pointerId)) {
    draw();
    return;
  }

  if (activeFogStrokes.delete(e.pointerId)) {
    scheduleSave();
    return;
  }

  navPointers.delete(e.pointerId);

  const drag = activeDrags.get(e.pointerId);
  if (drag) {
    snapToGrid(drag.token);
    activeDrags.delete(e.pointerId);
    invalidateLosCache();
    draw();
    sendTokenMoveDelta(drag.token.id, drag.token.x, drag.token.y, false);
    return;
  }

  const pDrag = activePaintDrags.get(e.pointerId);
  if (pDrag) {
    activePaintDrags.delete(e.pointerId);
    if (pDrag.moved) {
      markPaintChanged();
    }
    return;
  }

  const lDrag = activeLightDrags.get(e.pointerId);
  if (lDrag) {
    activeLightDrags.delete(e.pointerId);
    if (lDrag.moved) {
      sendSyncAction({ action: 'lights:sync', lights });
      objectBar?.sync(true);
    }
    return;
  }

  const wDrag = activeWallDrags.get(e.pointerId);
  if (wDrag) {
    activeWallDrags.delete(e.pointerId);
    const wall = walls.find((w) => w.id === wDrag.id);
    if (wall) {
      if (wDrag.moved) {
        sendSyncAction({
          action: 'wall:update',
          id: wall.id,
          x1: wall.x1,
          y1: wall.y1,
          x2: wall.x2,
          y2: wall.y2,
        });
      } else if (wDrag.isDoor) {
        const canToggleDoor =
          rulesConfig.allowPlayerDoors ||
          runtime.currentUser?.role !== 'player';
        if (canToggleDoor) {
          wall.open = !wall.open;
          invalidateLosCache();
          draw();
          sendSyncAction({ action: 'door:toggle', id: wall.id });
        }
      }
    }
    return;
  }
}

canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('pointerleave', () => {
  if (runtime.activeTool === 'place-light' && runtime.cursorWorldPos) {
    runtime.cursorWorldPos = null;
    draw();
  }
});

canvas.addEventListener('contextmenu', (e: MouseEvent) => {
  if (runtime.activeTool === 'paint' || runtime.activeTool === 'place-light') {
    e.preventDefault();
  }
});

function deleteSelectedItem(): boolean {
  if (deletePaintSelection()) {
    objectBar?.sync(false);
    return true;
  }
  if (runtime.selectedTokenId !== null) {
    sendSyncAction({ action: 'token:delete', id: runtime.selectedTokenId });
    runtime.selectedTokenId = null;
    objectBar?.sync(false);
    draw();
    return true;
  }
  if (runtime.selectedWallId !== null) {
    sendSyncAction({ action: 'wall:delete', id: runtime.selectedWallId });
    runtime.selectedWallId = null;
    objectBar?.sync(false);
    draw();
    return true;
  }
  if (runtime.selectedLightId !== null) {
    const idx = lights.findIndex((l) => l.id === runtime.selectedLightId);
    if (idx !== -1) {
      lights.splice(idx, 1);
      sendSyncAction({ action: 'lights:sync', lights });
    }
    runtime.selectedLightId = null;
    lightingCtrl?.syncUI();
    objectBar?.sync(false);
    draw();
    return true;
  }
  return false;
}

window.addEventListener('keydown', (e: KeyboardEvent) => {
  const tag = (e.target as HTMLElement | null)?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (deleteSelectedItem()) {
      e.preventDefault();
      return;
    }
  }

  if (runtime.activeTool !== 'paint') return;

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) redoPaint();
    else undoPaint();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    redoPaint();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
    e.preventDefault();
    copyPaintSelection();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
    e.preventDefault();
    pastePaintSelection();
  }
});

canvas.addEventListener(
  'wheel',
  (e: WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    zoomAt(e.clientX, e.clientY, camera.zoom * factor);
    draw();
  },
  { passive: false }
);

// --- File Drop ---
mapInput.addEventListener('change', (e: Event) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) loadMapFile(file);
  mapInput.value = '';
});

window.addEventListener('dragover', (e: DragEvent) => {
  e.preventDefault();
});

window.addEventListener('drop', (e: DragEvent) => {
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (file) loadMapFile(file);
});

window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// --- Floating Windows & Accordions ---
const vttBarWin = createFloatingWindow({
  title: 'VTT',
  x: Math.max(16, window.innerWidth - 320),
  y: 16,
  w: 300,
  h: 'auto',
  rotatable: false,
  collapsible: false,
  defaultCollapsed: false,
  storageKey: 'vtt-bar',
  resizable: 'horizontal',
});
vttBarWin.win.classList.add('bar-layout', 'vtt-bar');

const vttHeaderEl = vttBarWin.win.querySelector(
  '.floating-win-header'
) as HTMLElement;
const vttTitleEl = vttBarWin.win.querySelector(
  '.floating-win-title'
) as HTMLElement;

function addBarButton(label: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'vtt-bar-btn';
  btn.textContent = label;
  vttBarWin.body.appendChild(btn);
  return btn;
}

function bindWindowToggle(
  btn: HTMLButtonElement,
  winObj: FloatingWindowInstance
): () => void {
  function sync(): void {
    winObj.setOpen(winObj.state.open);
    btn.classList.toggle('active', winObj.state.open);
  }
  btn.addEventListener('click', () => {
    winObj.state.open = !winObj.state.open;
    sync();
  });
  sync();
  return sync;
}

const vttMenuBtn = addBarButton('Menu');
const vttToolsBtn = addBarButton('Tools');
const vttCenterBtn = addBarButton('Center');
const vttLobbyBtn = addBarButton('Lobby');
const vttViewModeBtn = addBarButton('GM');
vttCenterBtn.addEventListener('click', () => resetView());
vttViewModeBtn.style.display = 'none';
vttViewModeBtn.title = 'Toggle GM / Player map view';

const syncBadge = document.createElement('span');
syncBadge.className = 'vtt-badge';
syncBadge.textContent = 'Auth';
syncBadge.title = 'Real-time synchronization status';
const vttHeaderActions = vttHeaderEl.querySelector('.floating-win-actions');
if (vttHeaderActions) {
  vttHeaderEl.insertBefore(syncBadge, vttHeaderActions);
} else {
  vttHeaderEl.appendChild(syncBadge);
}

function syncVttHeader(): void {
  const name =
    runtime.currentUser?.displayName || runtime.currentUser?.username;
  vttTitleEl.textContent = name ? `⠿ VTT · ${name}` : '⠿ VTT';
}

const rememberedPlayerByScene = new Map<
  number,
  { fog: boolean; los: boolean; lighting: boolean }
>();

function applyViewModeAfterRestore(sceneChanged = true): void {
  if (runtime.currentUser?.role !== 'gm') return;
  const sceneId = runtime.activeSceneId;
  if (!runtime.simulatePlayerView) {
    if (sceneId !== null) {
      rememberedPlayerByScene.set(sceneId, {
        fog: fog.enabled,
        los: los.enabled,
        lighting: lighting.enabled,
      });
    }
    fog.enabled = false;
    los.enabled = false;
    lighting.enabled = false;
    if (runtime.activeTool === 'fog') {
      runtime.activeTool = 'select';
    }
  } else if (sceneChanged && sceneId !== null) {
    const saved = rememberedPlayerByScene.get(sceneId);
    if (saved) {
      fog.enabled = saved.fog;
      los.enabled = saved.los;
      lighting.enabled = saved.lighting;
    }
  }
  invalidateLosCache();
  syncFogUI();
  syncLosUI();
  lightingCtrl?.syncUI();
  objectBar?.sync(false);
  draw();
}

setOnSceneChangedHook(applyViewModeAfterRestore);

vttViewModeBtn.addEventListener('click', () => {
  if (runtime.currentUser?.role !== 'gm') return;
  const nextPlayerView = !runtime.simulatePlayerView;
  runtime.simulatePlayerView = nextPlayerView;
  const sceneId = runtime.activeSceneId;

  if (nextPlayerView) {
    if (sceneId !== null) {
      const saved = rememberedPlayerByScene.get(sceneId);
      if (saved) {
        fog.enabled = saved.fog;
        los.enabled = saved.los;
        lighting.enabled = saved.lighting;
      }
    }
  } else {
    if (sceneId !== null) {
      rememberedPlayerByScene.set(sceneId, {
        fog: fog.enabled,
        los: los.enabled,
        lighting: lighting.enabled,
      });
    }
    fog.enabled = false;
    los.enabled = false;
    lighting.enabled = false;
    if (runtime.activeTool === 'fog') {
      runtime.activeTool = 'select';
    }
  }

  vttViewModeBtn.textContent = runtime.simulatePlayerView ? 'Player' : 'GM';
  vttViewModeBtn.classList.toggle('active', runtime.simulatePlayerView);
  invalidateLosCache();
  syncFogUI();
  syncLosUI();
  lightingCtrl?.syncUI();
  objectBar?.sync(false);
  draw();
});

let syncMenuToggle = () => { };
let syncToolsToggle = () => { };

const menuWin = createFloatingWindow({
  title: 'Menu',
  x: 80,
  y: 90,
  w: 350,
  h: 260,
  tabs: ['Chat', 'Actors', 'Scene', 'Config'],
  closable: true,
  defaultCollapsed: true,
  storageKey: 'menu',
  onClose: () => syncMenuToggle(),
});

const toolsWin = createFloatingWindow({
  title: 'Tools',
  x: Math.min(450, Math.max(80, window.innerWidth - 320)),
  y: 90,
  w: 300,
  h: 280,
  closable: true,
  defaultCollapsed: true,
  storageKey: 'tools',
  onClose: () => syncToolsToggle(),
});

const scenePane = menuWin.tabPanes['Scene'];
scenePane.textContent = '';

let renderActorsList = () => { };
let syncGmOnlySections = () => { };
function syncAllUI(): void {
  syncGridUI();
  syncFogUI();
  syncLosUI();
  syncGmOnlySections();
  lightingCtrl?.syncUI();
  objectBar?.sync(false);
  renderActorsList();
}

const refreshScenes = setupScenesAccordion(scenePane, {
  syncAllUI,
  onSceneRenamed: () => {
    void refreshSavedMaps?.();
  },
});
const refreshChat = setupChatTab(menuWin.tabPanes['Chat']);
renderActorsList = setupActorsTab(menuWin.tabPanes['Actors']);

let refreshConfig = async () => { };

async function returnToLobby(): Promise<void> {
  saveActiveSceneCamera();
  await flushDirtyBlobsNow();
  disconnectRealtimeSync();
  clearMapMedia();
  clearMapCache();
  runtime.activeSceneId = null;
  await api.leaveCampaign().catch(() => { });
  if (runtime.currentUser) {
    runtime.currentUser.campaignId = null;
    await lobbyView.show(runtime.currentUser);
  } else {
    loginView.show();
  }
}

async function signOutToLogin(): Promise<void> {
  saveActiveSceneCamera();
  await flushDirtyBlobsNow();
  disconnectRealtimeSync();
  clearMapMedia();
  clearMapCache();
  runtime.activeSceneId = null;
  await api.logout().catch(() => { });
  runtime.currentUser = null;
  lobbyView.hide();
  loginView.show();
}

refreshConfig = setupConfigTab(
  menuWin.tabPanes['Config'],
  () => draw(),
  returnToLobby,
  signOutToLogin
);

let refreshSavedMaps: (() => Promise<void>) | undefined;

const mapAccordion = createAccordionSection(scenePane, 'Load Map', true);
mapAccordion.body.innerHTML = `
  <div class="panel-row" style="gap:6px;margin-bottom:6px;">
    <button id="load-map-btn" class="mini-btn" style="flex:1;" type="button">Load Map</button>
    <button id="upload-local-map-btn" class="mini-btn" style="flex:1;" type="button">Upload Local</button>
  </div>
  <div id="saved-maps-drawer" style="display:none;flex-direction:column;gap:6px;margin-bottom:6px;">
    <div id="saved-map-preview" style="display:none;border:1px solid var(--border-default);border-radius:6px;overflow:hidden;background:#0f172a;max-height:140px;align-items:center;justify-content:center;"></div>
    <div id="saved-maps-list" class="vtt-list" style="max-height:150px;overflow-y:auto;"></div>
  </div>
  <div class="panel-row" style="gap:6px;">
    <input id="map-url-input" class="vtt-input" type="url" placeholder="Paste map URL..." style="flex:1;min-width:0;" />
    <button id="map-url-load-btn" class="mini-btn" type="button">Load</button>
  </div>
  <div id="map-load-status" style="font-size:11px;color:var(--text-muted);margin-top:4px;"></div>
`;

const loadMapBtn = requireEl<HTMLButtonElement>('load-map-btn');
const uploadLocalMapBtn = requireEl<HTMLButtonElement>('upload-local-map-btn');
const savedMapsDrawer = requireEl<HTMLElement>('saved-maps-drawer');
const savedMapPreview = requireEl<HTMLElement>('saved-map-preview');
const savedMapsList = requireEl<HTMLElement>('saved-maps-list');
const mapUrlInput = requireEl<HTMLInputElement>('map-url-input');
const mapUrlLoadBtn = requireEl<HTMLButtonElement>('map-url-load-btn');
const mapLoadStatus = requireEl<HTMLElement>('map-load-status');

function showSavedMapPreview(id: number, mime: string): void {
  savedMapPreview.textContent = '';
  savedMapPreview.style.display = 'flex';
  const src = `/api/maps/${id}`;
  if (mime.startsWith('video/')) {
    const vid = document.createElement('video');
    vid.src = src;
    vid.muted = true;
    vid.loop = true;
    vid.autoplay = true;
    vid.playsInline = true;
    vid.style.maxWidth = '100%';
    vid.style.maxHeight = '140px';
    vid.style.objectFit = 'contain';
    savedMapPreview.appendChild(vid);
  } else {
    const img = document.createElement('img');
    img.src = src;
    img.style.maxWidth = '100%';
    img.style.maxHeight = '140px';
    img.style.objectFit = 'contain';
    savedMapPreview.appendChild(img);
  }
}

async function applyMapBlobToActiveScene(blob: Blob): Promise<void> {
  const dims = await loadMapMediaFromBlob(blob);
  initFogCanvas(dims.width, dims.height, true);
  initPaintCanvas(dims.width, dims.height, true);
  runtime.fogDirty = true;
  resetView();
  autoAlignGrid();
  scheduleSave();
}

refreshSavedMaps = async () => {
  if (!runtime.currentUser) return;
  try {
    const { maps } = await api.listMaps();
    savedMapsList.textContent = '';
    if (maps.length === 0) {
      savedMapsList.textContent = 'No saved maps yet.';
      savedMapPreview.style.display = 'none';
      return;
    }
    for (const m of maps) {
      const row = document.createElement('div');
      row.className = 'vtt-list-item';
      row.addEventListener('pointerenter', () => showSavedMapPreview(m.id, m.mime));

      const label = document.createElement('span');
      label.textContent = m.name;
      label.style.flex = '1';
      label.style.minWidth = '0';
      label.style.overflow = 'hidden';
      label.style.textOverflow = 'ellipsis';
      label.style.whiteSpace = 'nowrap';

      const actions = document.createElement('div');
      actions.className = 'panel-row';
      actions.style.gap = '4px';

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'mini-btn';
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', () => {
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'vtt-input';
        input.style.flex = '1';
        input.style.minWidth = '0';
        input.style.padding = '3px 6px';
        input.value = m.name;

        let committed = false;
        const commit = async () => {
          if (committed) return;
          committed = true;
          const nextName = input.value.trim();
          if (nextName && nextName !== m.name) {
            await api.renameSavedMap(m.id, nextName).catch(() => {});
            await refreshScenes();
          }
          await refreshSavedMaps?.();
        };

        input.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') {
            ev.preventDefault();
            void commit();
          } else if (ev.key === 'Escape') {
            committed = true;
            void refreshSavedMaps?.();
          }
        });
        input.addEventListener('blur', () => {
          void commit();
        });

        row.replaceChild(input, label);
        input.focus();
        input.select();
      });

      const useBtn = document.createElement('button');
      useBtn.type = 'button';
      useBtn.className = 'mini-btn';
      useBtn.textContent = 'Use';
      useBtn.addEventListener('click', async () => {
        mapLoadStatus.textContent = `Loading ${m.name}...`;
        try {
          saveActiveSceneCamera();
          await flushDirtyBlobsNow();
          const [blob, { scene }] = await Promise.all([
            api.fetchSavedMapBlob(m.id),
            api.createScene(m.name),
          ]);
          await api.applySavedMapToScene(scene.id, m.id);
          await applySceneData(scene, syncAllUI);
          await applyMapBlobToActiveScene(blob);
          mapLoadStatus.textContent = `Loaded ${m.name}`;
          await refreshScenes();
        } catch (err) {
          mapLoadStatus.textContent =
            err instanceof Error ? err.message : 'Failed to load map';
        }
      });

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'btn-danger-x';
      delBtn.textContent = 'X';
      delBtn.addEventListener('click', async () => {
        await api.deleteSavedMap(m.id).catch(() => {});
        await refreshSavedMaps?.();
      });

      actions.append(editBtn, useBtn, delBtn);
      row.append(label, actions);
      savedMapsList.appendChild(row);
    }
  } catch {
    savedMapsList.textContent = 'Could not load saved maps.';
  }
};

loadMapBtn.addEventListener('click', () => {
  const opening = savedMapsDrawer.style.display === 'none';
  savedMapsDrawer.style.display = opening ? 'flex' : 'none';
  loadMapBtn.classList.toggle('active', opening);
  if (opening) {
    void refreshSavedMaps?.();
  }
});

uploadLocalMapBtn.addEventListener('click', () => mapInput.click());

async function loadMapFromUrl(): Promise<void> {
  const url = mapUrlInput.value.trim();
  if (!url) return;
  mapLoadStatus.textContent = 'Importing from URL...';
  try {
    saveActiveSceneCamera();
    await flushDirtyBlobsNow();
    const { map } = await api.importMapFromUrl(url);
    const [blob, { scene }] = await Promise.all([
      api.fetchSavedMapBlob(map.id),
      api.createScene(map.name),
    ]);
    await api.applySavedMapToScene(scene.id, map.id);
    await applySceneData(scene, syncAllUI);
    await applyMapBlobToActiveScene(blob);
    mapUrlInput.value = '';
    mapLoadStatus.textContent = `Loaded ${map.name}`;
    await Promise.all([
      refreshScenes(),
      savedMapsDrawer.style.display !== 'none'
        ? refreshSavedMaps?.()
        : Promise.resolve(),
    ]);
  } catch (err) {
    mapLoadStatus.textContent =
      err instanceof Error ? err.message : 'URL import failed';
  }
}

mapUrlLoadBtn.addEventListener('click', () => void loadMapFromUrl());
mapUrlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    void loadMapFromUrl();
  }
});

const gridAccordion = createAccordionSection(scenePane, 'Grid', true);
gridAccordion.body.innerHTML = `
  <div class="panel-row">
    <span class="panel-label">Square Size</span>
    <span id="grid-size-val">64 px</span>
  </div>
  <input id="grid-size-slider" type="range" min="16" max="256" step="0.05" value="64" />
  <div class="panel-row">
    <button id="grid-size-minus" class="mini-btn" type="button">-1 px</button>
    <button id="grid-size-plus" class="mini-btn" type="button">+1 px</button>
    <button id="grid-toggle-btn" class="mini-btn" type="button">Hide Grid</button>
  </div>
  <div class="panel-row">
    <span class="panel-label">Grid Color</span>
    <button id="grid-color-btn" class="paint-swatch" type="button" title="Choose grid color" style="width:26px;height:26px;flex-shrink:0;"></button>
  </div>
  <div id="grid-color-palette" class="paint-colors-box" style="display:none;margin-bottom:4px;">
    <div id="grid-color-grid" class="paint-palette-grid"></div>
  </div>
  <div class="panel-row">
    <span class="panel-label">Grid Opacity</span>
    <span id="grid-opacity-val">25%</span>
  </div>
  <input id="grid-opacity-slider" class="paint-slider" type="range" min="0" max="1" step="0.05" value="0.25" />
  <div class="panel-row">
    <span class="panel-label">Align Offset</span>
    <span id="grid-offset-val">0, 0</span>
  </div>
  <div class="nudge-grid">
    <span></span>
    <button id="nudge-up" class="mini-btn" type="button">↑</button>
    <span></span>
    <button id="nudge-left" class="mini-btn" type="button">←</button>
    <button id="nudge-reset" class="mini-btn" type="button">0</button>
    <button id="nudge-right" class="mini-btn" type="button">→</button>
    <span></span>
    <button id="nudge-down" class="mini-btn" type="button">↓</button>
    <span></span>
  </div>
  <button id="auto-align-btn" class="mini-btn" type="button">Auto-Align to Map</button>
  <div id="grid-detect-status"></div>
`;

gridSizeSlider = requireEl<HTMLInputElement>('grid-size-slider');
gridSizeVal = requireEl<HTMLElement>('grid-size-val');
gridSizeMinus = requireEl<HTMLButtonElement>('grid-size-minus');
gridSizePlus = requireEl<HTMLButtonElement>('grid-size-plus');
gridToggleBtn = requireEl<HTMLButtonElement>('grid-toggle-btn');
gridOffsetVal = requireEl<HTMLElement>('grid-offset-val');
autoAlignBtn = requireEl<HTMLButtonElement>('auto-align-btn');
gridDetectStatus = requireEl<HTMLElement>('grid-detect-status');
gridColorBtn = requireEl<HTMLButtonElement>('grid-color-btn');
const gridColorPalette = requireEl<HTMLElement>('grid-color-palette');
const gridColorGrid = requireEl<HTMLElement>('grid-color-grid');
gridColorSwatches = new Map<string, HTMLButtonElement>();

for (const hex of PAINT_PALETTE) {
  const sw = document.createElement('button');
  sw.type = 'button';
  sw.className = 'paint-swatch';
  sw.style.background = hex;
  sw.addEventListener('click', () => {
    grid.color = hex;
    gridColorPalette.style.display = 'none';
    syncGridUI();
    draw();
    sendSyncAction({ action: 'grid:update', grid: { ...grid } });
  });
  gridColorSwatches.set(hex.toLowerCase(), sw);
  gridColorGrid.appendChild(sw);
}

gridColorBtn.addEventListener('click', () => {
  gridColorPalette.style.display =
    gridColorPalette.style.display === 'none' ? 'flex' : 'none';
});

gridOpacitySlider = requireEl<HTMLInputElement>('grid-opacity-slider');
gridOpacityVal = requireEl<HTMLElement>('grid-opacity-val');
gridOpacitySlider.addEventListener('input', () => {
  grid.opacity = Number(gridOpacitySlider!.value);
  syncGridUI();
  draw();
  sendSyncAction({ action: 'grid:update', grid: { ...grid } });
});

gridSizeSlider.addEventListener('input', (e: Event) =>
  setGridSize(Number((e.target as HTMLInputElement).value))
);
gridSizeMinus.addEventListener('click', () => setGridSize(grid.size - 1));
gridSizePlus.addEventListener('click', () => setGridSize(grid.size + 1));

gridToggleBtn.addEventListener('click', () => {
  grid.visible = !grid.visible;
  syncGridUI();
  draw();
  sendSyncAction({ action: 'grid:update', grid: { ...grid } });
});

requireEl<HTMLButtonElement>('nudge-up').addEventListener('click', () =>
  nudgeGrid(0, -2)
);
requireEl<HTMLButtonElement>('nudge-down').addEventListener('click', () =>
  nudgeGrid(0, 2)
);
requireEl<HTMLButtonElement>('nudge-left').addEventListener('click', () =>
  nudgeGrid(-2, 0)
);
requireEl<HTMLButtonElement>('nudge-right').addEventListener('click', () =>
  nudgeGrid(2, 0)
);
requireEl<HTMLButtonElement>('nudge-reset').addEventListener('click', () => {
  grid.offsetX = 0;
  grid.offsetY = 0;
  syncGridUI();
  draw();
  sendSyncAction({ action: 'grid:update', grid: { ...grid } });
});
autoAlignBtn.addEventListener('click', autoAlignGrid);

syncGridUI();

const interactAccordion = createAccordionSection(
  toolsWin.body,
  'Interact',
  true,
  'tools-interact',
  { enabled: true, w: 300, h: 'auto' }
);
interactAccordion.body.innerHTML = `
  <div class="panel-row">
    <button id="tools-select-btn" class="mini-btn" type="button" style="flex:1">Select</button>
    <button id="tools-delete-btn" class="mini-btn" type="button" style="flex:1">Delete</button>
    <button id="tools-pan-btn" class="mini-btn" type="button" style="flex:1">Pan</button>
    <button id="tools-ruler-btn" class="mini-btn" type="button" style="flex:1">Ruler</button>
  </div>
`;

toolsSelectBtn = requireEl<HTMLButtonElement>('tools-select-btn');
const toolsDeleteBtn = requireEl<HTMLButtonElement>('tools-delete-btn');
toolsPanBtn = requireEl<HTMLButtonElement>('tools-pan-btn');
toolsRulerBtn = requireEl<HTMLButtonElement>('tools-ruler-btn');

toolsSelectBtn.addEventListener('click', () => setActiveTool('select'));
toolsDeleteBtn.addEventListener('click', () => {
  deleteSelectedItem();
});
toolsPanBtn.addEventListener('click', () => setActiveTool('pan'));
toolsRulerBtn.addEventListener('click', () => setActiveTool('ruler'));
syncToolUI();

const paintAccordion = createAccordionSection(
  toolsWin.body,
  'Paint',
  false,
  'tools-paint',
  { enabled: true, w: 320, h: 'auto' }
);
paintCtrl = populatePaintPanel(paintAccordion.body, () =>
  setActiveTool('paint')
);

const diceAccordion = createAccordionSection(
  toolsWin.body,
  'Dice',
  true,
  'tools-dice',
  { enabled: true, w: 280, h: 'auto' }
);
diceAccordion.body.innerHTML = `
  <div class="dice-controls-row">
    <div class="dice-field">
      <span class="panel-label">Quantity</span>
      <div class="dice-stepper-pill">
        <button id="dice-qty-down" class="dice-circle-btn" type="button">−</button>
        <input id="dice-qty-input" class="dice-num-input" type="number" min="1" max="100" value="1" />
        <button id="dice-qty-up" class="dice-circle-btn" type="button">+</button>
      </div>
    </div>
    <div class="dice-field">
      <span class="panel-label">Modifier</span>
      <div class="dice-stepper-pill">
        <button id="dice-mod-down" class="dice-circle-btn" type="button">−</button>
        <input id="dice-mod-input" class="dice-num-input" type="number" min="-999" max="999" value="0" />
        <button id="dice-mod-up" class="dice-circle-btn" type="button">+</button>
      </div>
    </div>
  </div>
  <div class="dice-grid">
    <button class="mini-btn dice-btn" type="button" data-die="2">d2</button>
    <button class="mini-btn dice-btn" type="button" data-die="4">d4</button>
    <button class="mini-btn dice-btn" type="button" data-die="6">d6</button>
    <button class="mini-btn dice-btn" type="button" data-die="8">d8</button>
    <button class="mini-btn dice-btn" type="button" data-die="10">d10</button>
    <button class="mini-btn dice-btn" type="button" data-die="12">d12</button>
    <button class="mini-btn dice-btn" type="button" data-die="20">d20</button>
    <button class="mini-btn dice-btn" type="button" data-die="100">d100</button>
  </div>
`;

const diceQtyInput = requireEl<HTMLInputElement>('dice-qty-input');
const diceModInput = requireEl<HTMLInputElement>('dice-mod-input');

requireEl<HTMLButtonElement>('dice-qty-down').addEventListener('click', () => {
  const cur = Math.max(1, Number(diceQtyInput.value) || 1);
  diceQtyInput.value = String(Math.max(1, cur - 1));
});
requireEl<HTMLButtonElement>('dice-qty-up').addEventListener('click', () => {
  const cur = Math.max(1, Number(diceQtyInput.value) || 1);
  diceQtyInput.value = String(Math.min(100, cur + 1));
});
requireEl<HTMLButtonElement>('dice-mod-down').addEventListener('click', () => {
  const cur = Number(diceModInput.value) || 0;
  diceModInput.value = String(cur - 1);
});
requireEl<HTMLButtonElement>('dice-mod-up').addEventListener('click', () => {
  const cur = Number(diceModInput.value) || 0;
  diceModInput.value = String(cur + 1);
});

diceAccordion.body
  .querySelectorAll<HTMLButtonElement>('.dice-btn')
  .forEach((btn) => {
    btn.addEventListener('click', async () => {
      const sides = Number(btn.dataset.die);
      const qty = Math.min(100, Math.max(1, Math.floor(Number(diceQtyInput.value) || 1)));
      const mod = Math.trunc(Number(diceModInput.value) || 0);
      diceQtyInput.value = String(qty);
      diceModInput.value = String(mod);

      const modPart = mod === 0 ? '' : mod > 0 ? ` + ${mod}` : ` - ${Math.abs(mod)}`;
      const cmd = `/roll ${qty}d${sides}${modPart}`;
      try {
        await api.sendChat(cmd);
        await refreshChat();
      } catch (err) {
        console.warn('Dice roll failed:', err);
      }
    });
  });

const lightingAccordion = createAccordionSection(
  toolsWin.body,
  'Lighting',
  false,
  'tools-lighting',
  { enabled: true, w: 300, h: 'auto' }
);
lightingCtrl = populateLightingPanel(lightingAccordion.body, () =>
  setActiveTool('place-light')
);

const fogAccordion = createAccordionSection(
  toolsWin.body,
  'Fog of War',
  true,
  'tools-fog',
  { enabled: true, w: 280, h: 'auto' }
);
fogAccordion.body.innerHTML = `
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 6px;align-items:center;">
    <span class="panel-label" style="text-align:center;">Fog</span>
    <span class="panel-label" style="text-align:center;">GM Peek</span>
    <button id="fog-enable-btn" class="mini-btn" style="width:100%;" type="button">Off</button>
    <button id="fog-peek-btn" class="mini-btn" style="width:100%;" type="button">Off</button>
  </div>
  <hr class="paint-divider" style="margin:6px 0;" />
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;">
    <button id="fog-tool-reveal" class="mini-btn" type="button">Reveal</button>
    <button id="fog-tool-hide" class="mini-btn" type="button">Hide</button>
    <button id="fog-cover-all" class="mini-btn" type="button">Cover All</button>
    <button id="fog-reveal-all" class="mini-btn" type="button">Reveal All</button>
  </div>
  <div class="paint-slider-col" style="margin-top:6px;">
    <div class="panel-row">
      <span class="panel-label">Brush</span>
      <span id="fog-brush-val">100 px</span>
    </div>
    <input id="fog-brush-slider" class="paint-slider" type="range" min="24" max="300" value="100" />
  </div>
`;

fogEnableBtn = requireEl<HTMLButtonElement>('fog-enable-btn');
fogPeekBtn = requireEl<HTMLButtonElement>('fog-peek-btn');
fogToolReveal = requireEl<HTMLButtonElement>('fog-tool-reveal');
fogToolHide = requireEl<HTMLButtonElement>('fog-tool-hide');
fogBrushSlider = requireEl<HTMLInputElement>('fog-brush-slider');
fogBrushVal = requireEl<HTMLElement>('fog-brush-val');

fogEnableBtn.addEventListener('click', () => {
  fog.enabled = !fog.enabled;
  if (!fog.enabled && runtime.activeTool === 'fog') {
    runtime.activeTool = 'select';
  }
  syncFogUI();
  draw();
  sendSyncAction({
    action: 'fog:update',
    fog: { enabled: fog.enabled, peek: fog.peek, brushSize: fog.brushSize },
  });
});

fogPeekBtn.addEventListener('click', () => {
  if (runtime.currentUser?.role !== 'gm') return;
  fog.peek = !fog.peek;
  syncFogUI();
  draw();
  sendSyncAction({
    action: 'fog:update',
    fog: { enabled: fog.enabled, peek: fog.peek, brushSize: fog.brushSize },
  });
});

fogToolReveal.addEventListener('click', () => setFogBrush('reveal'));
fogToolHide.addEventListener('click', () => setFogBrush('hide'));

fogBrushSlider.addEventListener('input', (e: Event) => {
  fog.brushSize = Number((e.target as HTMLInputElement).value);
  syncFogUI();
  sendSyncAction({
    action: 'fog:update',
    fog: { enabled: fog.enabled, peek: fog.peek, brushSize: fog.brushSize },
  });
});

requireEl<HTMLButtonElement>('fog-cover-all').addEventListener('click', () => {
  fogCtx.globalCompositeOperation = 'source-over';
  fogCtx.fillStyle = '#0a0c10';
  fogCtx.fillRect(0, 0, fogCanvas.width, fogCanvas.height);
  runtime.fogDirty = true;
  draw();
  scheduleSave();
});

requireEl<HTMLButtonElement>('fog-reveal-all').addEventListener('click', () => {
  fogCtx.clearRect(0, 0, fogCanvas.width, fogCanvas.height);
  runtime.fogDirty = true;
  draw();
  scheduleSave();
});

syncFogUI();

const losAccordion = createAccordionSection(
  toolsWin.body,
  'Line of Sight',
  true,
  'tools-los',
  { enabled: true, w: 280, h: 'auto' }
);
toolsWin.body.insertBefore(losAccordion.section, fogAccordion.section);
losAccordion.body.innerHTML = `
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 6px;align-items:center;">
    <span class="panel-label" style="text-align:center;">LoS</span>
    <span class="panel-label" style="text-align:center;">GM Peek</span>
    <button id="los-enable-btn" class="mini-btn" style="width:100%;" type="button">Off</button>
    <button id="los-peek-btn" class="mini-btn" style="width:100%;" type="button">Off</button>
  </div>
  <hr class="paint-divider" style="margin:6px 0;" />
  <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:4px;margin-bottom:4px;">
    <button id="los-tool-wall" class="mini-btn" type="button">Wall</button>
    <button id="los-tool-door" class="mini-btn" type="button">Door</button>
    <button id="los-tool-secret" class="mini-btn" type="button">Secret</button>
    <button id="los-tool-erase" class="mini-btn" type="button">Erase</button>
  </div>
  <button id="los-clear-all" class="mini-btn" style="width:100%;" type="button">Clear Walls</button>
`;

losEnableBtn = requireEl<HTMLButtonElement>('los-enable-btn');
losPeekBtn = requireEl<HTMLButtonElement>('los-peek-btn');
losToolWall = requireEl<HTMLButtonElement>('los-tool-wall');
losToolDoor = requireEl<HTMLButtonElement>('los-tool-door');
losToolSecretDoor = requireEl<HTMLButtonElement>('los-tool-secret');
losToolErase = requireEl<HTMLButtonElement>('los-tool-erase');

losEnableBtn.addEventListener('click', () => {
  los.enabled = !los.enabled;
  invalidateLosCache();
  syncLosUI();
  draw();
  sendSyncAction({
    action: 'los:update',
    los: { enabled: los.enabled, peek: los.peek },
  });
});

losPeekBtn.addEventListener('click', () => {
  if (runtime.currentUser?.role !== 'gm') return;
  los.peek = !los.peek;
  syncLosUI();
  draw();
  sendSyncAction({
    action: 'los:update',
    los: { enabled: los.enabled, peek: los.peek },
  });
});

losToolWall.addEventListener('click', () => setActiveTool('los-wall'));
losToolDoor.addEventListener('click', () => setActiveTool('los-door'));
losToolSecretDoor.addEventListener('click', () =>
  setActiveTool('los-secret-door')
);
losToolErase.addEventListener('click', () => setActiveTool('los-erase'));

requireEl<HTMLButtonElement>('los-clear-all').addEventListener('click', () => {
  walls.length = 0;
  invalidateLosCache();
  draw();
  sendSyncAction({ action: 'wall:clear' });
});

syncLosUI();

syncMenuToggle = bindWindowToggle(vttMenuBtn, menuWin);
syncToolsToggle = bindWindowToggle(vttToolsBtn, toolsWin);

objectBar = createObjectBar({
  onDelete: () => {
    deleteSelectedItem();
  },
  onLightsChanged: () => {
    lightingCtrl?.syncUI();
  },
});

syncGmOnlySections = () => {
  const isGm = runtime.currentUser?.role === 'gm';
  if (!isGm) {
    runtime.simulatePlayerView = false;
  }
  fogAccordion.section.style.display = isGm ? '' : 'none';
  losAccordion.section.style.display = isGm ? '' : 'none';
  menuWin.setTabVisible?.('Scene', isGm);
  menuWin.setTabVisible?.('Config', isGm);
  vttViewModeBtn.style.display = isGm ? '' : 'none';
  vttViewModeBtn.textContent = runtime.simulatePlayerView ? 'Player' : 'GM';
  vttViewModeBtn.classList.toggle('active', runtime.simulatePlayerView);
  syncVttHeader();
};
syncGmOnlySections();

vttLobbyBtn.addEventListener('click', () => {
  void returnToLobby();
});

const loginView = createLoginView((user) => {
  runtime.currentUser = user;
  applyThemeColor(getSavedThemeColor(user.id), user.id);
  syncVttHeader();
  loginView.hide();
  void lobbyView.show(user);
});

const lobbyView = createLobbyView({
  onEnterCampaign: async (campaignId, role) => {
    if (runtime.currentUser) {
      runtime.currentUser.campaignId = campaignId;
      runtime.currentUser.role = role;
      runtime.currentUser.membershipStatus = 'active';
    }
    lobbyView.hide();
    await restoreState(syncAllUI);
    applyViewModeAfterRestore();
    await Promise.all([refreshScenes(), refreshChat(), refreshConfig()]);
    connectRealtimeSync();
  },
  onLogout: () => {
    void signOutToLogin();
  },
});

initRealtimeSync({
  onUiSync: () => {
    syncAllUI();
    void refreshScenes();
  },
  onChatMessage: () => {
    void refreshChat();
  },
  onRulesChanged: () => {
    void refreshConfig();
  },
  onStatusChange: (status: SyncConnectionState) => {
    if (status === 'connected') {
      syncBadge.textContent = '● Live';
    } else if (status === 'connecting') {
      syncBadge.textContent = '◌ Sync';
    } else {
      syncBadge.textContent = runtime.currentUser ? '○ Offline' : '🔒 Auth';
    }
  },
});

applyThemeColor(getSavedThemeColor());

void (async () => {
  try {
    const { user } = await api.getMe();
    runtime.currentUser = user;
    if (user) {
      applyThemeColor(getSavedThemeColor(user.id), user.id);
    }
    syncVttHeader();
    if (!user) {
      loginView.show();
      return;
    }
    if (user.campaignId === null || user.campaignId === undefined) {
      await lobbyView.show(user);
      return;
    }
    await restoreState(syncAllUI);
    applyViewModeAfterRestore();
    await Promise.all([refreshScenes(), refreshChat(), refreshConfig()]);
    connectRealtimeSync();
  } catch {
    loginView.show();
  }
})();

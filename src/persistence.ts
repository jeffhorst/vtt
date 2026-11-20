import { api } from './api';
import { loadPaintObjectsLocal } from './paint/paintEngine';
import { draw, invalidateLosCache } from './renderer';
import {
  camera,
  clearMapMedia,
  fog,
  fogCanvas,
  fogCtx,
  getActiveMapSource,
  grid,
  initFogCanvas,
  initPaintCanvas,
  lighting,
  lights,
  los,
  paintCanvas,
  paintCtx,
  paintObjects,
  runtime,
  tokens,
  walls,
} from './state';
import type { CameraState, SceneData } from './types';

let blobSaveTimer: ReturnType<typeof setTimeout> | undefined;
const sceneCameraCache = new Map<number, CameraState>();
let onSceneChangedHook: ((sceneChanged: boolean) => void) | null = null;

const MAX_CACHED_MAPS = 6;
const mapBlobCache = new Map<number, Blob>();
const inFlightMapFetches = new Map<number, Promise<Blob | null>>();
let inFlightApply: { sceneId: number; promise: Promise<void> } | null = null;
let applySeq = 0;

function touchMapCache(sceneId: number, blob: Blob): void {
  if (mapBlobCache.has(sceneId)) {
    mapBlobCache.delete(sceneId);
  }
  mapBlobCache.set(sceneId, blob);
  while (mapBlobCache.size > MAX_CACHED_MAPS) {
    const oldestKey = mapBlobCache.keys().next().value;
    if (oldestKey === undefined) break;
    mapBlobCache.delete(oldestKey);
  }
}

async function getCachedOrFetchMapBlob(sceneId: number): Promise<Blob | null> {
  const cached = mapBlobCache.get(sceneId);
  if (cached) {
    touchMapCache(sceneId, cached);
    return cached;
  }

  const existing = inFlightMapFetches.get(sceneId);
  if (existing) return existing;

  const p = api
    .fetchSceneMapBlob(sceneId)
    .then((blob) => {
      if (blob) touchMapCache(sceneId, blob);
      return blob;
    })
    .finally(() => {
      inFlightMapFetches.delete(sceneId);
    });

  inFlightMapFetches.set(sceneId, p);
  return p;
}

export function prefetchSceneMap(sceneId: number): void {
  if (mapBlobCache.has(sceneId) || inFlightMapFetches.has(sceneId)) return;
  void getCachedOrFetchMapBlob(sceneId).catch(() => {});
}

export function clearMapCache(): void {
  mapBlobCache.clear();
}

export function setOnSceneChangedHook(
  fn: (sceneChanged: boolean) => void
): void {
  onSceneChangedHook = fn;
}

export function saveActiveSceneCamera(): void {
  if (runtime.activeSceneId === null) return;
  const snap: CameraState = {
    x: camera.x,
    y: camera.y,
    zoom: camera.zoom,
  };
  sceneCameraCache.set(runtime.activeSceneId, snap);
  try {
    localStorage.setItem(
      `vtt-scene-camera-${runtime.activeSceneId}`,
      JSON.stringify(snap)
    );
  } catch {
    // ignore storage errors
  }
}

function loadSavedSceneCamera(sceneId: number): CameraState | null {
  const cached = sceneCameraCache.get(sceneId);
  if (cached) return cached;
  try {
    const raw = localStorage.getItem(`vtt-scene-camera-${sceneId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CameraState>;
    if (
      typeof parsed.x === 'number' &&
      typeof parsed.y === 'number' &&
      typeof parsed.zoom === 'number'
    ) {
      const snap = { x: parsed.x, y: parsed.y, zoom: parsed.zoom };
      sceneCameraCache.set(sceneId, snap);
      return snap;
    }
  } catch {
    // ignore parse errors
  }
  return null;
}

function restoreFogBlob(blob: Blob | null | undefined): Promise<void> {
  if (!blob) return Promise.resolve();
  return new Promise((resolve) => {
    const fogUrl = URL.createObjectURL(blob);
    const fogImg = new Image();
    fogImg.onload = () => {
      fogCanvas.width = fogImg.width;
      fogCanvas.height = fogImg.height;
      fogCtx.globalCompositeOperation = 'source-over';
      fogCtx.clearRect(0, 0, fogCanvas.width, fogCanvas.height);
      fogCtx.drawImage(fogImg, 0, 0);
      URL.revokeObjectURL(fogUrl);
      resolve();
    };
    fogImg.onerror = () => {
      URL.revokeObjectURL(fogUrl);
      resolve();
    };
    fogImg.src = fogUrl;
  });
}

function restorePaintBlob(blob: Blob | null | undefined): Promise<void> {
  if (!blob) return Promise.resolve();
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      paintCanvas.width = img.width;
      paintCanvas.height = img.height;
      paintCtx.globalCompositeOperation = 'source-over';
      paintCtx.clearRect(0, 0, paintCanvas.width, paintCanvas.height);
      paintCtx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      resolve();
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve();
    };
    img.src = url;
  });
}

export function loadMapMediaFromBlob(
  blob: Blob
): Promise<{ width: number; height: number }> {
  const type = blob.type.toLowerCase();
  if (type.startsWith('video/')) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const video = document.createElement('video');
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      video.autoplay = true;
      video.preload = 'auto';
      video.style.position = 'fixed';
      video.style.left = '-9999px';
      video.style.top = '-9999px';
      video.style.width = '1px';
      video.style.height = '1px';
      video.style.opacity = '0';
      video.style.zIndex = '-1';
      video.style.pointerEvents = 'none';

      video.onloadeddata = () => {
        clearMapMedia();
        runtime.mapObjectUrl = url;
        runtime.mapVideo = video;
        runtime.mapBlob = blob;
        runtime.mapIsAnimated = true;
        document.body.appendChild(video);
        void video.play().catch(() => {});
        resolve({ width: video.videoWidth, height: video.videoHeight });
      };
      video.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Failed to decode map video'));
      };
      video.src = url;
    });
  }

  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    const isAnimatedImg = type === 'image/gif' || type === 'image/webp';
    if (isAnimatedImg) {
      img.style.position = 'fixed';
      img.style.left = '-9999px';
      img.style.top = '-9999px';
      img.style.width = '1px';
      img.style.height = '1px';
      img.style.opacity = '0';
      img.style.zIndex = '-1';
      img.style.pointerEvents = 'none';
    }
    img.onload = () => {
      clearMapMedia();
      runtime.mapObjectUrl = url;
      runtime.mapImage = img;
      runtime.mapBlob = blob;
      runtime.mapIsAnimated = isAnimatedImg;
      if (isAnimatedImg) {
        document.body.appendChild(img);
      }
      resolve({ width: img.width, height: img.height });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to decode map image'));
    };
    img.src = url;
  });
}

export async function reloadSceneLayerBlob(
  layer: 'map' | 'fog' | 'paint'
): Promise<void> {
  if (runtime.activeSceneId === null) return;
  const id = runtime.activeSceneId;

  if (layer === 'map') {
    mapBlobCache.delete(id);
    const mapBlob = await getCachedOrFetchMapBlob(id);
    if (mapBlob) {
      const dims = await loadMapMediaFromBlob(mapBlob);
      initFogCanvas(dims.width, dims.height, true);
      initPaintCanvas(dims.width, dims.height, true);
    }
  } else if (layer === 'fog') {
    const fogBlob = await api.fetchSceneFogBlob(id);
    await restoreFogBlob(fogBlob);
  } else if (layer === 'paint') {
    const paintBlob = await api.fetchScenePaintBlob(id);
    await restorePaintBlob(paintBlob);
  }
  draw();
}

export function applySceneData(
  scene: SceneData,
  onUiSync: () => void,
  preserveCamera = false
): Promise<void> {
  if (inFlightApply && inFlightApply.sceneId === scene.id) {
    return inFlightApply.promise;
  }

  const seq = ++applySeq;
  const promise = applySceneDataImpl(scene, onUiSync, preserveCamera, seq).finally(
    () => {
      if (inFlightApply?.promise === promise) {
        inFlightApply = null;
      }
    }
  );
  inFlightApply = { sceneId: scene.id, promise };
  return promise;
}

async function applySceneDataImpl(
  scene: SceneData,
  onUiSync: () => void,
  preserveCamera: boolean,
  seq: number
): Promise<void> {
  const sceneChanged = runtime.activeSceneId !== scene.id;
  if (sceneChanged && runtime.activeSceneId !== null) {
    saveActiveSceneCamera();
  }
  runtime.activeSceneId = scene.id;
  runtime.activeSceneName = scene.name;

  if (sceneChanged) {
    runtime.selectedTokenId = null;
    runtime.selectedPaintObjectId = null;
    runtime.selectedWallId = null;
    runtime.selectedLightId = null;
    runtime.draftWall = null;
  }

  Object.assign(grid, scene.grid);
  if (!preserveCamera || sceneChanged) {
    const savedCam = loadSavedSceneCamera(scene.id);
    Object.assign(camera, savedCam ?? scene.camera);
  }
  fog.enabled = Boolean(scene.fog.enabled);
  fog.peek = Boolean(scene.fog.peek);
  if (scene.fog.brushSize) fog.brushSize = scene.fog.brushSize;
  los.enabled = Boolean(scene.los.enabled);
  los.peek = Boolean(scene.los.peek);

  if (scene.lighting) {
    lighting.enabled = Boolean(scene.lighting.enabled);
    lighting.ambient = scene.lighting.ambient;
  }
  if (Array.isArray(scene.lights)) {
    lights.length = 0;
    lights.push(...scene.lights);
  }

  tokens.length = 0;
  tokens.push(...scene.tokens);
  walls.length = 0;
  walls.push(...scene.walls);
  if (Array.isArray(scene.paintObjects)) {
    paintObjects.length = 0;
    paintObjects.push(...scene.paintObjects);
  } else {
    loadPaintObjectsLocal(scene.id);
  }
  invalidateLosCache();
  onSceneChangedHook?.(sceneChanged);
  if (sceneChanged) {
    clearMapMedia();
  }

  if (sceneChanged || (scene.hasMap && !getActiveMapSource())) {
    const [mapBlob, fogBlob, paintBlob] = await Promise.all([
      scene.hasMap ? getCachedOrFetchMapBlob(scene.id) : Promise.resolve(null),
      scene.hasFog ? api.fetchSceneFogBlob(scene.id) : Promise.resolve(null),
      scene.hasPaint ? api.fetchScenePaintBlob(scene.id) : Promise.resolve(null),
    ]);

    if (seq !== applySeq) return;

    if (!scene.hasMap || !mapBlob) {
      clearMapMedia();
      initFogCanvas(2048, 2048, !sceneChanged);
      initPaintCanvas(2048, 2048, false);
    } else {
      const dims = await loadMapMediaFromBlob(mapBlob);
      if (seq !== applySeq) return;
      initFogCanvas(dims.width, dims.height, !sceneChanged);
      initPaintCanvas(dims.width, dims.height, false);
    }

    if (fogBlob) {
      await restoreFogBlob(fogBlob);
    }
    if (paintBlob) {
      await restorePaintBlob(paintBlob);
    }
  }

  if (seq !== applySeq) return;
  onUiSync();
  draw();
}

export async function uploadActiveMapBlob(blob: Blob): Promise<void> {
  if (runtime.activeSceneId === null) return;
  touchMapCache(runtime.activeSceneId, blob);
  try {
    await api.uploadSceneMap(runtime.activeSceneId, blob);
  } catch (err) {
    console.warn('Could not upload map to backend:', err);
  }
}

export async function flushDirtyBlobsNow(): Promise<void> {
  if (runtime.activeSceneId === null) return;
  const sceneId = runtime.activeSceneId;

  try {
    if (runtime.fogDirty) {
      runtime.fogDirty = false;
      const fogBlob = await new Promise<Blob | null>((resolve) =>
        fogCanvas.toBlob(resolve, 'image/png')
      );
      if (fogBlob) {
        await api.uploadSceneFog(sceneId, fogBlob);
      }
    }

    if (runtime.paintDirty) {
      runtime.paintDirty = false;
      const paintBlob = await new Promise<Blob | null>((resolve) =>
        paintCanvas.toBlob(resolve, 'image/png')
      );
      if (paintBlob) {
        await api.uploadScenePaint(sceneId, paintBlob);
      }
    }
  } catch (err) {
    console.warn('Could not upload canvas layer blob:', err);
  }
}

export function scheduleSave(): void {
  if (!runtime.fogDirty && !runtime.paintDirty) return;
  clearTimeout(blobSaveTimer);
  blobSaveTimer = setTimeout(() => {
    void flushDirtyBlobsNow();
  }, 300);
}

export async function restoreState(onUiSync: () => void): Promise<void> {
  try {
    const { scene } = await api.getActiveScene();
    await applySceneData(scene, onUiSync, false);
  } catch (err) {
    console.warn('Could not restore scene from server:', err);
  }
}

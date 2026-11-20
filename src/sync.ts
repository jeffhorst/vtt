import { applySceneData, reloadSceneLayerBlob } from './persistence';
import { draw, invalidateLosCache } from './renderer';
import {
  activeDrags,
  fog,
  grid,
  lighting,
  lights,
  los,
  paintObjects,
  rulesConfig,
  runtime,
  tokens,
  walls,
} from './state';
import type {
  AmbientLightLevel,
  ChatMessage,
  DiagonalRuleMode,
  LightSource,
  PaintObject,
  SceneData,
  Token,
  WallSegment,
} from './types';

export type SyncConnectionState = 'disconnected' | 'connecting' | 'connected';

interface SyncCallbacks {
  onUiSync: () => void;
  onChatMessage?: (msg: ChatMessage) => void;
  onRulesChanged?: () => void;
  onStatusChange?: (status: SyncConnectionState) => void;
}

let ws: WebSocket | null = null;
let lastSeq = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
let shouldConnect = false;
let callbacks: SyncCallbacks = { onUiSync: () => {} };
const outboundQueue: string[] = [];

export function initRealtimeSync(cb: SyncCallbacks): void {
  callbacks = cb;
}

export function connectRealtimeSync(): void {
  shouldConnect = true;
  if (
    ws &&
    (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  callbacks.onStatusChange?.('connecting');
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${proto}//${window.location.host}/api/ws`);
  ws = socket;

  socket.addEventListener('open', () => {
    reconnectAttempts = 0;
    callbacks.onStatusChange?.('connected');

    // Request delta catch-up or full snapshot
    socket.send(
      JSON.stringify({
        action: 'sync:hello',
        sceneId: runtime.activeSceneId ?? 0,
        lastSeq,
      })
    );

    // Flush queued outbound mutations
    while (outboundQueue.length > 0 && socket.readyState === WebSocket.OPEN) {
      socket.send(outboundQueue.shift()!);
    }
  });

  socket.addEventListener('message', (ev) => {
    try {
      const msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
      handleServerMessage(msg);
    } catch (err) {
      console.warn('Invalid sync frame:', err);
    }
  });

  socket.addEventListener('close', () => {
    if (ws === socket) {
      ws = null;
    }
    callbacks.onStatusChange?.('disconnected');
    if (shouldConnect && runtime.currentUser) {
      const delay = Math.min(5000, 500 * Math.pow(1.6, reconnectAttempts++));
      reconnectTimer = setTimeout(() => {
        connectRealtimeSync();
      }, delay);
    }
  });
}

export function disconnectRealtimeSync(): void {
  shouldConnect = false;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    ws.close();
    ws = null;
  }
  callbacks.onStatusChange?.('disconnected');
}

export function sendSyncAction(
  payload: Record<string, unknown>,
  queueIfOffline = true
): void {
  const frame = JSON.stringify(payload);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(frame);
  } else if (queueIfOffline) {
    if (outboundQueue.length < 100) {
      outboundQueue.push(frame);
    }
  }
}

let lastDragSendTime = 0;
export function sendTokenMoveDelta(
  id: number,
  x: number,
  y: number,
  dragging: boolean
): void {
  const now = performance.now();
  if (dragging && now - lastDragSendTime < 33) {
    return;
  }
  lastDragSendTime = now;
  sendSyncAction(
    {
      action: 'token:move',
      id,
      x: Math.round(x * 10) / 10,
      y: Math.round(y * 10) / 10,
      dragging,
    },
    !dragging
  );
}

function applyDeltaOp(op: Record<string, unknown>): void {
  const type = op.type as string;

  if (type === 'token:move') {
    const id = Number(op.id);
    // Ignore remote move updates for a token we are actively dragging locally
    for (const drag of activeDrags.values()) {
      if (drag.token.id === id) return;
    }
    const token = tokens.find((t) => t.id === id);
    if (token) {
      token.x = Number(op.x);
      token.y = Number(op.y);
      token.version = Number(op.version ?? token.version ?? 1);
      invalidateLosCache();
      draw();
    }
    return;
  }

  if (type === 'token:add') {
    const incoming = op.token as Token;
    if (!tokens.some((t) => t.id === incoming.id)) {
      tokens.push(incoming);
      invalidateLosCache();
      callbacks.onUiSync();
      draw();
    }
    return;
  }

  if (type === 'token:delete') {
    const id = Number(op.id);
    const idx = tokens.findIndex((t) => t.id === id);
    if (idx !== -1) {
      tokens.splice(idx, 1);
      if (runtime.selectedTokenId === id) runtime.selectedTokenId = null;
      invalidateLosCache();
      callbacks.onUiSync();
      draw();
    }
    return;
  }

  if (type === 'wall:add') {
    const incoming = op.wall as WallSegment;
    if (!walls.some((w) => w.id === incoming.id)) {
      walls.push(incoming);
      invalidateLosCache();
      draw();
    }
    return;
  }

  if (type === 'wall:update') {
    const incoming = op.wall as WallSegment;
    const w = walls.find((seg) => seg.id === incoming.id);
    if (w) {
      w.x1 = incoming.x1;
      w.y1 = incoming.y1;
      w.x2 = incoming.x2;
      w.y2 = incoming.y2;
      w.open = incoming.open;
      w.secret = incoming.secret;
      w.revealed = incoming.revealed;
      w.version = incoming.version;
      invalidateLosCache();
      draw();
    }
    return;
  }

  if (type === 'wall:delete') {
    const id = Number(op.id);
    const idx = walls.findIndex((w) => w.id === id);
    if (idx !== -1) {
      walls.splice(idx, 1);
      invalidateLosCache();
      draw();
    }
    return;
  }

  if (type === 'wall:clear') {
    walls.length = 0;
    invalidateLosCache();
    draw();
    return;
  }

  if (type === 'paint:sync') {
    const incoming = op.paintObjects as PaintObject[];
    if (Array.isArray(incoming)) {
      paintObjects.length = 0;
      paintObjects.push(...incoming);
      draw();
    }
    return;
  }

  if (type === 'lights:sync') {
    const incoming = op.lights as LightSource[];
    if (Array.isArray(incoming)) {
      lights.length = 0;
      lights.push(...incoming);
      invalidateLosCache();
      callbacks.onUiSync();
      draw();
    }
    return;
  }

  if (type === 'lighting:update') {
    const l = op.lighting as
      | { enabled?: boolean; ambient?: AmbientLightLevel }
      | undefined;
    if (l) {
      if (typeof l.enabled === 'boolean') lighting.enabled = l.enabled;
      if (l.ambient) lighting.ambient = l.ambient;
      invalidateLosCache();
      callbacks.onUiSync();
      draw();
    }
    return;
  }

  if (type === 'door:toggle') {
    const id = Number(op.id);
    const door = walls.find((w) => w.id === id);
    if (door) {
      door.open = Boolean(op.open);
      door.version = Number(op.version ?? door.version ?? 1);
      invalidateLosCache();
      draw();
    }
    return;
  }

  if (type === 'grid:update') {
    const g = op.grid as Partial<typeof grid> | undefined;
    if (g) {
      Object.assign(grid, g);
      callbacks.onUiSync();
      draw();
    }
    return;
  }

  if (type === 'fog:update') {
    const f = op.fog as Partial<typeof fog> | undefined;
    if (f) {
      if (typeof f.enabled === 'boolean') fog.enabled = f.enabled;
      if (typeof f.peek === 'boolean') fog.peek = f.peek;
      if (typeof f.brushSize === 'number') fog.brushSize = f.brushSize;
      callbacks.onUiSync();
      draw();
    }
    return;
  }

  if (type === 'los:update') {
    const l = op.los as Partial<typeof los> | undefined;
    if (l) {
      if (typeof l.enabled === 'boolean') los.enabled = l.enabled;
      if (typeof l.peek === 'boolean') los.peek = l.peek;
      invalidateLosCache();
      callbacks.onUiSync();
      draw();
    }
    return;
  }

  if (type === 'blob:updated') {
    const layer = op.layer as 'map' | 'fog' | 'paint';
    void reloadSceneLayerBlob(layer);
    return;
  }

  if (type === 'rule:updated') {
    const key = String(op.key);
    const val = (op.value ?? {}) as Record<string, unknown>;
    if (key === 'diagonal_rule' && val.mode) {
      rulesConfig.diagonalRule = val.mode as DiagonalRuleMode;
    } else if (key === 'feet_per_square' && val.feet) {
      rulesConfig.feetPerSquare = Number(val.feet) || 5;
    } else if (key === 'allow_player_doors' && val.enabled !== undefined) {
      rulesConfig.allowPlayerDoors = Boolean(val.enabled);
    }
    callbacks.onRulesChanged?.();
    draw();
    return;
  }

  if (type === 'chat:message') {
    const msg = op.message as ChatMessage;
    callbacks.onChatMessage?.(msg);
  }
}

function handleServerMessage(msg: Record<string, unknown>): void {
  const type = msg.type as string;

  if (type === 'sync:snapshot') {
    lastSeq = Number(msg.seq ?? lastSeq);
    const scene = msg.scene as SceneData;
    void applySceneData(scene, callbacks.onUiSync, true);
    return;
  }

  if (type === 'sync:catchup') {
    lastSeq = Number(msg.seq ?? lastSeq);
    const deltas = (msg.deltas ?? []) as Array<{
      seq: number;
      op: Record<string, unknown>;
    }>;
    for (const d of deltas) {
      applyDeltaOp(d.op);
      lastSeq = Math.max(lastSeq, d.seq);
    }
    return;
  }

  if (type === 'sync:delta') {
    const seq = Number(msg.seq ?? 0);
    if (seq > 0) lastSeq = seq;
    const op = msg.op as Record<string, unknown>;
    if (op) applyDeltaOp(op);
    return;
  }

  if (type === 'sync:reconcile') {
    // Authoritative conflict resolution: force-apply server state even if dragging
    activeDrags.clear();
    const op = msg.op as Record<string, unknown>;
    if (op) applyDeltaOp(op);
    return;
  }

  if (type === 'sync:ack') {
    const seq = Number(msg.seq ?? 0);
    if (seq > lastSeq) lastSeq = seq;
  }
}

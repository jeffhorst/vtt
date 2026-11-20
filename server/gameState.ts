import type { IncomingMessage, Server as HttpServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { getSessionUser, type AuthUser, type UserRole } from './auth.js';
import { db, recordAuditLog } from './db.js';

export interface ServerToken {
  id: number;
  ownerId: number | null;
  x: number;
  y: number;
  color: string;
  label: string;
  version: number;
  lockUserId?: number;
  lockExpiresAt?: number;
}

export interface ServerWall {
  id: number;
  type: 'wall' | 'door';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  open: boolean;
  secret: boolean;
  revealed: boolean;
  version: number;
}

export interface ServerSceneState {
  id: number;
  campaignId: number;
  name: string;
  version: number;
  updatedAt: string;
  hasMap: boolean;
  hasFog: boolean;
  hasPaint: boolean;
  grid: {
    size: number;
    offsetX: number;
    offsetY: number;
    visible: boolean;
    color?: string;
    opacity?: number;
  };
  camera: { x: number; y: number; zoom: number };
  fog: { enabled: boolean; peek: boolean; brushSize: number };
  los: { enabled: boolean; peek: boolean };
  lighting: { enabled: boolean; ambient: 'bright' | 'normal' | 'dim' | 'darkness' };
  tokens: ServerToken[];
  walls: ServerWall[];
  paintObjects: unknown[];
  lights: unknown[];
}

export type SyncDeltaOp =
  | { type: 'token:move'; id: number; x: number; y: number; version: number }
  | { type: 'token:add'; token: ServerToken }
  | { type: 'token:delete'; id: number }
  | { type: 'wall:add'; wall: ServerWall }
  | { type: 'wall:update'; wall: ServerWall }
  | { type: 'wall:delete'; id: number }
  | { type: 'wall:clear' }
  | { type: 'door:toggle'; id: number; open: boolean; version: number }
  | { type: 'paint:sync'; paintObjects: unknown[] }
  | { type: 'lights:sync'; lights: unknown[] }
  | {
      type: 'lighting:update';
      lighting: { enabled: boolean; ambient: 'bright' | 'normal' | 'dim' | 'darkness' };
    }
  | { type: 'grid:update'; grid: ServerSceneState['grid'] }
  | { type: 'fog:update'; fog: ServerSceneState['fog'] }
  | { type: 'los:update'; los: ServerSceneState['los'] }
  | { type: 'blob:updated'; layer: 'map' | 'fog' | 'paint'; timestamp: number }
  | { type: 'rule:updated'; key: string; value: Record<string, unknown> }
  | {
      type: 'chat:message';
      message: {
        id: number;
        senderName: string;
        message: string;
        rollResult: string | null;
        createdAt: string;
      };
    };

interface LoggedDelta {
  seq: number;
  sceneId: number;
  op: SyncDeltaOp;
  actorId: number;
}

interface CampaignRuntime {
  campaignId: number;
  activeScene: ServerSceneState | null;
  deltaLog: LoggedDelta[];
  currentSeq: number;
  dirtyMeta: boolean;
  dirtyTokens: boolean;
  dirtyWalls: boolean;
  flushTimer: ReturnType<typeof setTimeout> | null;
}

const MAX_DELTA_LOG = 300;
const campaignRuntimes = new Map<number, CampaignRuntime>();

function getCampaignRuntime(campaignId: number): CampaignRuntime {
  let rt = campaignRuntimes.get(campaignId);
  if (!rt) {
    rt = {
      campaignId,
      activeScene: null,
      deltaLog: [],
      currentSeq: 1,
      dirtyMeta: false,
      dirtyTokens: false,
      dirtyWalls: false,
      flushTimer: null,
    };
    campaignRuntimes.set(campaignId, rt);
  }
  return rt;
}

function isAllowPlayerDoorsEnabled(campaignId: number): boolean {
  const row = db
    .prepare('SELECT value_json FROM rules WHERE campaign_id = ? AND key = ?')
    .get(campaignId, 'allow_player_doors') as
    | { value_json: string }
    | undefined;
  if (!row) return true;
  try {
    const parsed = JSON.parse(row.value_json) as { enabled?: boolean };
    return Boolean(parsed.enabled);
  } catch {
    return true;
  }
}

export function loadSceneFromDb(
  campaignId: number,
  sceneId?: number
): ServerSceneState | null {
  const rt = getCampaignRuntime(campaignId);
  flushAuthoritativeStateNow(campaignId);

  const query = sceneId
    ? `SELECT id, campaign_id, name, version, grid_json, camera_json, fog_json, los_json,
              paint_objects_json, lighting_json, lights_json,
              (map_blob IS NOT NULL) AS has_map,
              (fog_blob IS NOT NULL) AS has_fog,
              (paint_blob IS NOT NULL) AS has_paint,
              updated_at
       FROM scenes WHERE campaign_id = ? AND id = ? LIMIT 1`
    : `SELECT id, campaign_id, name, version, grid_json, camera_json, fog_json, los_json,
              paint_objects_json, lighting_json, lights_json,
              (map_blob IS NOT NULL) AS has_map,
              (fog_blob IS NOT NULL) AS has_fog,
              (paint_blob IS NOT NULL) AS has_paint,
              updated_at
       FROM scenes WHERE campaign_id = ? AND is_active = 1 LIMIT 1`;

  let row = (sceneId
    ? db.prepare(query).get(campaignId, sceneId)
    : db.prepare(query).get(campaignId)) as
    | {
        id: number;
        campaign_id: number;
        name: string;
        version: number;
        grid_json: string;
        camera_json: string;
        fog_json: string;
        los_json: string;
        paint_objects_json: string;
        lighting_json: string;
        lights_json: string;
        has_map: number;
        has_fog: number;
        has_paint: number;
        updated_at: string;
      }
    | undefined;

  if (!row && !sceneId) {
    row = db
      .prepare(
        `SELECT id, campaign_id, name, version, grid_json, camera_json, fog_json, los_json,
                paint_objects_json, lighting_json, lights_json,
                (map_blob IS NOT NULL) AS has_map,
                (fog_blob IS NOT NULL) AS has_fog,
                (paint_blob IS NOT NULL) AS has_paint,
                updated_at
         FROM scenes WHERE campaign_id = ? ORDER BY id ASC LIMIT 1`
      )
      .get(campaignId) as typeof row;
  }

  if (!row) return null;

  const tokens = (
    db
      .prepare(
        'SELECT id, owner_id, x, y, color, label, version FROM tokens WHERE scene_id = ? ORDER BY id ASC'
      )
      .all(row.id) as Array<{
      id: number;
      owner_id: number | null;
      x: number;
      y: number;
      color: string;
      label: string;
      version: number;
    }>
  ).map((t) => ({
    id: t.id,
    ownerId: t.owner_id,
    x: t.x,
    y: t.y,
    color: t.color,
    label: t.label,
    version: t.version || 1,
  }));

  const walls = (
    db
      .prepare(
        'SELECT id, type, x1, y1, x2, y2, open, secret, revealed, version FROM walls WHERE scene_id = ? ORDER BY id ASC'
      )
      .all(row.id) as Array<{
      id: number;
      type: 'wall' | 'door';
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      open: number;
      secret: number;
      revealed: number;
      version: number;
    }>
  ).map((w) => ({
    id: w.id,
    type: w.type === 'door' ? ('door' as const) : ('wall' as const),
    x1: w.x1,
    y1: w.y1,
    x2: w.x2,
    y2: w.y2,
    open: Boolean(w.open),
    secret: Boolean(w.secret),
    revealed: Boolean(w.revealed),
    version: w.version || 1,
  }));

  rt.activeScene = {
    id: row.id,
    campaignId: row.campaign_id,
    name: row.name,
    version: row.version || 1,
    updatedAt: row.updated_at,
    hasMap: Boolean(row.has_map),
    hasFog: Boolean(row.has_fog),
    hasPaint: Boolean(row.has_paint),
    grid: JSON.parse(row.grid_json),
    camera: JSON.parse(row.camera_json),
    fog: JSON.parse(row.fog_json),
    los: JSON.parse(row.los_json),
    lighting: JSON.parse(
      row.lighting_json || '{"enabled":false,"ambient":"darkness"}'
    ),
    tokens,
    walls,
    paintObjects: JSON.parse(row.paint_objects_json || '[]') as unknown[],
    lights: JSON.parse(row.lights_json || '[]') as unknown[],
  };

  rt.currentSeq = Math.max(rt.currentSeq, rt.activeScene.version);
  return rt.activeScene;
}

export function getAuthoritativeScene(
  campaignId: number
): ServerSceneState | null {
  const rt = getCampaignRuntime(campaignId);
  if (!rt.activeScene) {
    return loadSceneFromDb(campaignId);
  }
  return rt.activeScene;
}

export function serializeSceneForRole(
  scene: ServerSceneState,
  role: UserRole
): ServerSceneState & { isActive: boolean; seq: number } {
  const rt = getCampaignRuntime(scene.campaignId);
  const isGm = role === 'gm';
  return {
    ...scene,
    isActive: true,
    seq: rt.currentSeq,
    fog: {
      ...scene.fog,
      peek: isGm ? scene.fog.peek : false,
    },
    los: {
      ...scene.los,
      peek: isGm ? scene.los.peek : false,
    },
    tokens: scene.tokens.map(
      ({ lockUserId: _lu, lockExpiresAt: _le, ...t }) => t
    ),
  };
}

function sanitizeDeltaForRole(op: SyncDeltaOp, role: UserRole): SyncDeltaOp {
  if (role === 'gm') return op;
  if (op.type === 'fog:update') {
    return { type: 'fog:update', fog: { ...op.fog, peek: false } };
  }
  if (op.type === 'los:update') {
    return { type: 'los:update', los: { ...op.los, peek: false } };
  }
  return op;
}

export function flushAuthoritativeStateNow(campaignId?: number): void {
  const targets =
    campaignId !== undefined
      ? [getCampaignRuntime(campaignId)]
      : Array.from(campaignRuntimes.values());

  for (const rt of targets) {
    if (rt.flushTimer) {
      clearTimeout(rt.flushTimer);
      rt.flushTimer = null;
    }
    if (!rt.activeScene || (!rt.dirtyMeta && !rt.dirtyTokens && !rt.dirtyWalls)) {
      continue;
    }

    const scene = rt.activeScene;
    const now = new Date().toISOString();
    scene.updatedAt = now;

    db.exec('BEGIN');
    try {
      db.prepare(
        `UPDATE scenes
         SET grid_json = ?, camera_json = ?, fog_json = ?, los_json = ?,
             paint_objects_json = ?, lighting_json = ?, lights_json = ?,
             version = ?, updated_at = ?
         WHERE id = ?`
      ).run(
        JSON.stringify(scene.grid),
        JSON.stringify(scene.camera),
        JSON.stringify(scene.fog),
        JSON.stringify(scene.los),
        JSON.stringify(scene.paintObjects),
        JSON.stringify(scene.lighting),
        JSON.stringify(scene.lights),
        scene.version,
        now,
        scene.id
      );

      if (rt.dirtyTokens) {
        db.prepare('DELETE FROM tokens WHERE scene_id = ?').run(scene.id);
        const ins = db.prepare(
          'INSERT INTO tokens (id, scene_id, owner_id, x, y, color, label, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        );
        for (const t of scene.tokens) {
          ins.run(
            t.id,
            scene.id,
            t.ownerId,
            t.x,
            t.y,
            t.color,
            t.label,
            t.version
          );
        }
      }

      if (rt.dirtyWalls) {
        db.prepare('DELETE FROM walls WHERE scene_id = ?').run(scene.id);
        const ins = db.prepare(
          'INSERT INTO walls (id, scene_id, type, x1, y1, x2, y2, open, secret, revealed, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        );
        for (const w of scene.walls) {
          ins.run(
            w.id,
            scene.id,
            w.type,
            w.x1,
            w.y1,
            w.x2,
            w.y2,
            w.open ? 1 : 0,
            w.secret ? 1 : 0,
            w.revealed ? 1 : 0,
            w.version
          );
        }
      }

      db.exec('COMMIT');
      rt.dirtyMeta = false;
      rt.dirtyTokens = false;
      rt.dirtyWalls = false;
    } catch (err) {
      db.exec('ROLLBACK');
      console.warn('Failed to flush authoritative state:', err);
    }
  }
}

function scheduleAuthoritativeFlush(rt: CampaignRuntime): void {
  if (rt.flushTimer) return;
  rt.flushTimer = setTimeout(() => {
    flushAuthoritativeStateNow(rt.campaignId);
  }, 400);
}

// --- WebSocket Clients & Broadcasting ---
interface ConnectedClient {
  ws: WebSocket;
  user: AuthUser;
  campaignId: number;
  msgTimestamps: number[];
  isAlive: boolean;
}

const clients = new Set<ConnectedClient>();

export function broadcastDelta(
  campaignId: number,
  op: SyncDeltaOp,
  actorId: number,
  excludeWs?: WebSocket
): number {
  const rt = getCampaignRuntime(campaignId);
  const scene = getAuthoritativeScene(campaignId);
  const sceneId = scene?.id ?? 0;
  rt.currentSeq++;
  if (scene) {
    scene.version = rt.currentSeq;
    rt.dirtyMeta = true;
  }

  rt.deltaLog.push({ seq: rt.currentSeq, sceneId, op, actorId });
  if (rt.deltaLog.length > MAX_DELTA_LOG) {
    rt.deltaLog.shift();
  }

  for (const client of clients) {
    if (
      client.campaignId !== campaignId ||
      client.ws === excludeWs ||
      client.ws.readyState !== WebSocket.OPEN
    ) {
      continue;
    }
    const safeOp = sanitizeDeltaForRole(op, client.user.role);
    client.ws.send(
      JSON.stringify({
        type: 'sync:delta',
        seq: rt.currentSeq,
        sceneId,
        actorId,
        op: safeOp,
      })
    );
  }

  scheduleAuthoritativeFlush(rt);
  return rt.currentSeq;
}

export function broadcastSnapshotToAll(campaignId: number): void {
  const rt = getCampaignRuntime(campaignId);
  const scene = getAuthoritativeScene(campaignId);
  if (!scene) return;
  rt.currentSeq++;
  scene.version = rt.currentSeq;

  for (const client of clients) {
    if (
      client.campaignId !== campaignId ||
      client.ws.readyState !== WebSocket.OPEN
    ) {
      continue;
    }
    client.ws.send(
      JSON.stringify({
        type: 'sync:snapshot',
        seq: rt.currentSeq,
        scene: serializeSceneForRole(scene, client.user.role),
      })
    );
  }
}

export function markBlobUpdated(
  campaignId: number,
  layer: 'map' | 'fog' | 'paint',
  actorId: number
): void {
  const scene = getAuthoritativeScene(campaignId);
  if (scene) {
    if (layer === 'map') scene.hasMap = true;
    if (layer === 'fog') scene.hasFog = true;
    if (layer === 'paint') scene.hasPaint = true;
  }
  broadcastDelta(
    campaignId,
    { type: 'blob:updated', layer, timestamp: Date.now() },
    actorId
  );
}

function isFiniteCoord(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 100000;
}

function handleClientAction(
  client: ConnectedClient,
  msg: Record<string, unknown>
): void {
  const campaignId = client.campaignId;
  const rt = getCampaignRuntime(campaignId);
  const scene = getAuthoritativeScene(campaignId);
  if (!scene) return;
  const user = client.user;
  const isGm = user.role === 'gm';
  const action = msg.action as string;
  const clientReqId = msg.reqId as string | undefined;

  const sendError = (code: string, message: string) => {
    client.ws.send(
      JSON.stringify({
        type: 'sync:error',
        reqId: clientReqId,
        code,
        message,
      })
    );
  };

  if (action === 'sync:hello') {
    const lastSeq = Number(msg.lastSeq ?? 0);
    const sceneId = Number(msg.sceneId ?? 0);
    if (
      sceneId === scene.id &&
      lastSeq > 0 &&
      rt.deltaLog.length > 0 &&
      lastSeq >= rt.deltaLog[0].seq - 1
    ) {
      const missed = rt.deltaLog
        .filter((d) => d.sceneId === scene.id && d.seq > lastSeq)
        .map((d) => ({
          seq: d.seq,
          actorId: d.actorId,
          op: sanitizeDeltaForRole(d.op, user.role),
        }));
      client.ws.send(
        JSON.stringify({
          type: 'sync:catchup',
          seq: rt.currentSeq,
          sceneId: scene.id,
          deltas: missed,
        })
      );
      return;
    }

    client.ws.send(
      JSON.stringify({
        type: 'sync:snapshot',
        seq: rt.currentSeq,
        scene: serializeSceneForRole(scene, user.role),
      })
    );
    return;
  }

  if (action === 'token:move') {
    const id = Number(msg.id);
    const x = msg.x;
    const y = msg.y;
    const dragging = Boolean(msg.dragging);
    if (!isFiniteCoord(x) || !isFiniteCoord(y)) {
      sendError('INVALID_INPUT', 'Invalid token coordinates');
      return;
    }

    const token = scene.tokens.find((t) => t.id === id);
    if (!token) {
      sendError('NOT_FOUND', 'Token not found');
      return;
    }

    if (!isGm && token.ownerId !== null && token.ownerId !== user.id) {
      sendError('FORBIDDEN', 'You do not have permission to move this token');
      client.ws.send(
        JSON.stringify({
          type: 'sync:reconcile',
          op: {
            type: 'token:move',
            id: token.id,
            x: token.x,
            y: token.y,
            version: token.version,
          },
        })
      );
      return;
    }

    const now = Date.now();
    if (
      token.lockUserId !== undefined &&
      token.lockUserId !== user.id &&
      (token.lockExpiresAt ?? 0) > now
    ) {
      client.ws.send(
        JSON.stringify({
          type: 'sync:reconcile',
          op: {
            type: 'token:move',
            id: token.id,
            x: token.x,
            y: token.y,
            version: token.version,
          },
        })
      );
      return;
    }

    token.x = x;
    token.y = y;
    if (dragging) {
      token.lockUserId = user.id;
      token.lockExpiresAt = now + 2500;
    } else {
      token.version++;
      token.lockUserId = undefined;
      token.lockExpiresAt = undefined;
    }
    rt.dirtyTokens = true;

    const seq = broadcastDelta(
      campaignId,
      {
        type: 'token:move',
        id: token.id,
        x: token.x,
        y: token.y,
        version: token.version,
      },
      user.id,
      client.ws
    );
    if (!dragging) {
      client.ws.send(
        JSON.stringify({
          type: 'sync:ack',
          reqId: clientReqId,
          seq,
          version: token.version,
        })
      );
    }
    return;
  }

  if (action === 'token:add') {
    const x = msg.x;
    const y = msg.y;
    const color = String(msg.color ?? '#10b981').slice(0, 16);
    const label = String(msg.label ?? 'T').trim().slice(0, 12) || 'T';
    if (!isFiniteCoord(x) || !isFiniteCoord(y)) {
      sendError('INVALID_INPUT', 'Invalid token coordinates');
      return;
    }

    const ins = db
      .prepare(
        'INSERT INTO tokens (scene_id, owner_id, x, y, color, label, version) VALUES (?, ?, ?, ?, ?, ?, 1)'
      )
      .run(scene.id, isGm ? null : user.id, x, y, color, label);

    const newToken: ServerToken = {
      id: Number(ins.lastInsertRowid),
      ownerId: isGm ? null : user.id,
      x,
      y,
      color,
      label,
      version: 1,
    };
    scene.tokens.push(newToken);
    broadcastDelta(campaignId, { type: 'token:add', token: newToken }, user.id);
    return;
  }

  if (action === 'token:delete') {
    const id = Number(msg.id);
    const idx = scene.tokens.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const token = scene.tokens[idx];
    if (!isGm && token.ownerId !== user.id) {
      sendError('FORBIDDEN', 'Only GMs or the token owner can delete this token');
      return;
    }
    scene.tokens.splice(idx, 1);
    rt.dirtyTokens = true;
    broadcastDelta(campaignId, { type: 'token:delete', id }, user.id);
    return;
  }

  if (action === 'door:toggle') {
    const id = Number(msg.id);
    const wall = scene.walls.find((w) => w.id === id && w.type === 'door');
    if (!wall) return;

    if (wall.secret && !wall.revealed && !isGm) {
      sendError('FORBIDDEN', 'Secret door is not revealed');
      return;
    }

    if (!isGm && !isAllowPlayerDoorsEnabled(campaignId)) {
      sendError('FORBIDDEN', 'Players are not permitted to toggle doors');
      client.ws.send(
        JSON.stringify({
          type: 'sync:reconcile',
          op: {
            type: 'door:toggle',
            id: wall.id,
            open: wall.open,
            version: wall.version,
          },
        })
      );
      return;
    }

    wall.open = !wall.open;
    wall.version++;
    rt.dirtyWalls = true;
    broadcastDelta(
      campaignId,
      {
        type: 'door:toggle',
        id: wall.id,
        open: wall.open,
        version: wall.version,
      },
      user.id
    );
    return;
  }

  if (action === 'paint:sync') {
    const list = msg.paintObjects;
    if (!Array.isArray(list)) return;
    scene.paintObjects = list.slice(0, 2000);
    rt.dirtyMeta = true;
    broadcastDelta(
      campaignId,
      { type: 'paint:sync', paintObjects: scene.paintObjects },
      user.id,
      client.ws
    );
    return;
  }

  if (action === 'lights:sync') {
    const list = msg.lights;
    if (!Array.isArray(list)) return;
    scene.lights = list.slice(0, 500);
    rt.dirtyMeta = true;
    broadcastDelta(
      campaignId,
      { type: 'lights:sync', lights: scene.lights },
      user.id,
      client.ws
    );
    return;
  }

  if (action === 'lighting:update') {
    if (!isGm) {
      sendError('FORBIDDEN', 'Only GM can change scene ambient lighting');
      return;
    }
    const l = msg.lighting as Partial<ServerSceneState['lighting']> | undefined;
    if (!l) return;
    if (typeof l.enabled === 'boolean') scene.lighting.enabled = l.enabled;
    if (
      l.ambient === 'bright' ||
      l.ambient === 'normal' ||
      l.ambient === 'dim' ||
      l.ambient === 'darkness'
    ) {
      scene.lighting.ambient = l.ambient;
    }
    rt.dirtyMeta = true;
    broadcastDelta(
      campaignId,
      { type: 'lighting:update', lighting: { ...scene.lighting } },
      user.id,
      client.ws
    );
    return;
  }

  if (!isGm) {
    sendError('FORBIDDEN', 'GM permission required for this action');
    client.ws.send(
      JSON.stringify({
        type: 'sync:snapshot',
        seq: rt.currentSeq,
        scene: serializeSceneForRole(scene, user.role),
      })
    );
    return;
  }

  if (action === 'wall:add') {
    const x1 = msg.x1;
    const y1 = msg.y1;
    const x2 = msg.x2;
    const y2 = msg.y2;
    const wType = msg.wallType === 'door' ? 'door' : 'wall';
    const isSecret = wType === 'door' && Boolean(msg.secret);
    if (
      !isFiniteCoord(x1) ||
      !isFiniteCoord(y1) ||
      !isFiniteCoord(x2) ||
      !isFiniteCoord(y2)
    ) {
      sendError('INVALID_INPUT', 'Invalid wall coordinates');
      return;
    }

    const ins = db
      .prepare(
        'INSERT INTO walls (scene_id, type, x1, y1, x2, y2, open, secret, revealed, version) VALUES (?, ?, ?, ?, ?, ?, 0, ?, 0, 1)'
      )
      .run(scene.id, wType, x1, y1, x2, y2, isSecret ? 1 : 0);

    const newWall: ServerWall = {
      id: Number(ins.lastInsertRowid),
      type: wType,
      x1,
      y1,
      x2,
      y2,
      open: false,
      secret: isSecret,
      revealed: false,
      version: 1,
    };
    scene.walls.push(newWall);
    broadcastDelta(campaignId, { type: 'wall:add', wall: newWall }, user.id);
    return;
  }

  if (action === 'wall:delete') {
    const id = Number(msg.id);
    const idx = scene.walls.findIndex((w) => w.id === id);
    if (idx === -1) return;
    scene.walls.splice(idx, 1);
    rt.dirtyWalls = true;
    broadcastDelta(campaignId, { type: 'wall:delete', id }, user.id);
    return;
  }

  if (action === 'wall:update') {
    const id = Number(msg.id);
    const wall = scene.walls.find((w) => w.id === id);
    if (!wall) return;
    if (
      !isFiniteCoord(msg.x1) ||
      !isFiniteCoord(msg.y1) ||
      !isFiniteCoord(msg.x2) ||
      !isFiniteCoord(msg.y2)
    ) {
      sendError('INVALID_INPUT', 'Invalid wall coordinates');
      return;
    }
    wall.x1 = msg.x1;
    wall.y1 = msg.y1;
    wall.x2 = msg.x2;
    wall.y2 = msg.y2;
    if (typeof msg.revealed === 'boolean') {
      wall.revealed = msg.revealed;
    }
    if (typeof msg.open === 'boolean') {
      wall.open = msg.open;
    }
    wall.version++;
    rt.dirtyWalls = true;
    broadcastDelta(campaignId, { type: 'wall:update', wall: { ...wall } }, user.id, client.ws);
    return;
  }

  if (action === 'wall:clear') {
    scene.walls.length = 0;
    rt.dirtyWalls = true;
    recordAuditLog({
      userId: user.id,
      username: user.username,
      action: 'wall:clear',
      targetType: 'scene',
      targetId: scene.id,
    });
    broadcastDelta(campaignId, { type: 'wall:clear' }, user.id);
    return;
  }

  if (action === 'grid:update') {
    const g = msg.grid as Partial<ServerSceneState['grid']> | undefined;
    if (!g) return;
    if (typeof g.size === 'number' && g.size >= 16 && g.size <= 256) {
      scene.grid.size = g.size;
    }
    if (isFiniteCoord(g.offsetX)) scene.grid.offsetX = g.offsetX;
    if (isFiniteCoord(g.offsetY)) scene.grid.offsetY = g.offsetY;
    if (typeof g.visible === 'boolean') scene.grid.visible = g.visible;
    if (typeof g.color === 'string') scene.grid.color = g.color;
    if (typeof g.opacity === 'number' && Number.isFinite(g.opacity)) {
      scene.grid.opacity = Math.min(1, Math.max(0, g.opacity));
    }
    rt.dirtyMeta = true;
    broadcastDelta(
      campaignId,
      { type: 'grid:update', grid: { ...scene.grid } },
      user.id,
      client.ws
    );
    return;
  }

  if (action === 'fog:update') {
    const f = msg.fog as Partial<ServerSceneState['fog']> | undefined;
    if (!f) return;
    if (typeof f.enabled === 'boolean') scene.fog.enabled = f.enabled;
    if (typeof f.peek === 'boolean') scene.fog.peek = f.peek;
    if (
      typeof f.brushSize === 'number' &&
      f.brushSize >= 10 &&
      f.brushSize <= 500
    ) {
      scene.fog.brushSize = f.brushSize;
    }
    rt.dirtyMeta = true;
    broadcastDelta(
      campaignId,
      { type: 'fog:update', fog: { ...scene.fog } },
      user.id,
      client.ws
    );
    return;
  }

  if (action === 'los:update') {
    const l = msg.los as Partial<ServerSceneState['los']> | undefined;
    if (!l) return;
    if (typeof l.enabled === 'boolean') scene.los.enabled = l.enabled;
    if (typeof l.peek === 'boolean') scene.los.peek = l.peek;
    rt.dirtyMeta = true;
    broadcastDelta(
      campaignId,
      { type: 'los:update', los: { ...scene.los } },
      user.id,
      client.ws
    );
    return;
  }
}

export function attachRealtimeServer(server: HttpServer): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request: IncomingMessage, socket, head) => {
    const url = request.url ?? '';
    if (!url.startsWith('/api/ws')) {
      socket.destroy();
      return;
    }

    const user = getSessionUser(request);
    if (
      !user ||
      !user.isActive ||
      user.campaignId === null ||
      user.membershipStatus !== 'active'
    ) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request, user);
    });
  });

  wss.on(
    'connection',
    (ws: WebSocket, _req: IncomingMessage, user: AuthUser) => {
      const client: ConnectedClient = {
        ws,
        user,
        campaignId: user.campaignId!,
        msgTimestamps: [],
        isAlive: true,
      };
      clients.add(client);

      ws.on('pong', () => {
        client.isAlive = true;
      });

      ws.on('message', (raw) => {
        const now = Date.now();
        client.msgTimestamps = client.msgTimestamps.filter(
          (t) => t > now - 1000
        );
        if (client.msgTimestamps.length >= 120) {
          ws.send(
            JSON.stringify({
              type: 'sync:error',
              code: 'RATE_LIMIT',
              message: 'WebSocket action rate limit exceeded',
            })
          );
          return;
        }
        client.msgTimestamps.push(now);

        try {
          const parsed = JSON.parse(String(raw)) as Record<string, unknown>;
          handleClientAction(client, parsed);
        } catch {
          // Ignore malformed JSON frames
        }
      });

      ws.on('close', () => {
        clients.delete(client);
      });
    }
  );

  const interval = setInterval(() => {
    for (const client of clients) {
      if (!client.isAlive) {
        client.ws.terminate();
        clients.delete(client);
        continue;
      }
      client.isAlive = false;
      client.ws.ping();
    }
  }, 25000);

  wss.on('close', () => {
    clearInterval(interval);
  });

  return wss;
}

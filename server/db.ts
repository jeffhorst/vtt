import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DATA_DIR = path.resolve(process.cwd(), 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const DB_PATH = path.join(DATA_DIR, 'vtt.sqlite');
export const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'player',
    is_admin INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS campaigns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS campaign_members (
    campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'player',
    status TEXT NOT NULL DEFAULT 'active',
    joined_at TEXT NOT NULL,
    PRIMARY KEY (campaign_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS scenes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL DEFAULT 1 REFERENCES campaigns(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    grid_json TEXT NOT NULL,
    camera_json TEXT NOT NULL,
    fog_json TEXT NOT NULL,
    los_json TEXT NOT NULL,
    map_blob BLOB,
    map_mime TEXT,
    fog_blob BLOB,
    paint_blob BLOB,
    paint_objects_json TEXT NOT NULL DEFAULT '[]',
    lighting_json TEXT NOT NULL DEFAULT '{"enabled":false,"ambient":"darkness"}',
    lights_json TEXT NOT NULL DEFAULT '[]',
    is_active INTEGER NOT NULL DEFAULT 0,
    is_default INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS maps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    blob BLOB NOT NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scene_id INTEGER NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
    owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    x REAL NOT NULL,
    y REAL NOT NULL,
    color TEXT NOT NULL,
    label TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS walls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scene_id INTEGER NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    x1 REAL NOT NULL,
    y1 REAL NOT NULL,
    x2 REAL NOT NULL,
    y2 REAL NOT NULL,
    open INTEGER NOT NULL DEFAULT 0,
    secret INTEGER NOT NULL DEFAULT 0,
    revealed INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL DEFAULT 1,
    key TEXT NOT NULL,
    title TEXT NOT NULL,
    category TEXT NOT NULL,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (campaign_id, key)
  );

  CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL DEFAULT 1,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    sender_name TEXT NOT NULL,
    message TEXT NOT NULL,
    roll_result TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    username TEXT NOT NULL,
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT,
    details_json TEXT NOT NULL,
    ip_address TEXT,
    created_at TEXT NOT NULL
  );
`);

function ensureColumn(table: string, col: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  if (!cols.some((c) => c.name === col)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl};`);
  }
}

function migrateLegacySchema(): void {
  ensureColumn('users', 'is_admin', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('users', 'is_active', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn('sessions', 'campaign_id', 'INTEGER');
  ensureColumn('scenes', 'campaign_id', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn('scenes', 'paint_blob', 'BLOB');
  ensureColumn('scenes', 'paint_objects_json', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(
    'scenes',
    'lighting_json',
    'TEXT NOT NULL DEFAULT \'{"enabled":false,"ambient":"darkness"}\''
  );
  ensureColumn('scenes', 'lights_json', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn('scenes', 'version', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn('tokens', 'version', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn('walls', 'secret', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('walls', 'revealed', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('walls', 'version', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn('rules', 'campaign_id', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn('chat_messages', 'campaign_id', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn('scenes', 'map_id', 'INTEGER');
  ensureColumn('scenes', 'is_default', 'INTEGER NOT NULL DEFAULT 0');

  const mapCount = db
    .prepare('SELECT COUNT(*) AS cnt FROM maps')
    .get() as { cnt: number };
  if (mapCount.cnt === 0) {
    db.exec(`
      INSERT INTO maps (campaign_id, name, mime, blob, created_by, created_at)
      SELECT
        campaign_id,
        name,
        COALESCE(map_mime, 'image/png'),
        map_blob,
        CASE WHEN owner_id IN (SELECT id FROM users) THEN owner_id ELSE NULL END,
        updated_at
      FROM scenes
      WHERE map_blob IS NOT NULL AND campaign_id IN (SELECT id FROM campaigns)
    `);
  }
  db.exec(`
    UPDATE scenes
    SET map_id = (
      SELECT m.id FROM maps m
      WHERE m.campaign_id = scenes.campaign_id AND m.name = scenes.name
      ORDER BY m.id DESC LIMIT 1
    )
    WHERE map_id IS NULL AND map_blob IS NOT NULL
  `);

  // Migrate legacy campaign_members without campaign_id if needed
  const cmCols = db
    .prepare('PRAGMA table_info(campaign_members)')
    .all() as Array<{ name: string }>;
  if (!cmCols.some((c) => c.name === 'campaign_id')) {
    db.exec(`
      ALTER TABLE campaign_members RENAME TO campaign_members_old;
      CREATE TABLE campaign_members (
        campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL DEFAULT 'player',
        status TEXT NOT NULL DEFAULT 'active',
        joined_at TEXT NOT NULL,
        PRIMARY KEY (campaign_id, user_id)
      );
      INSERT OR IGNORE INTO campaign_members (campaign_id, user_id, role, status, joined_at)
      SELECT 1, user_id, role, status, joined_at FROM campaign_members_old;
      DROP TABLE campaign_members_old;
    `);
  }
}

migrateLegacySchema();

export function recordAuditLog(params: {
  userId: number | null;
  username: string;
  action: string;
  targetType: string;
  targetId?: string | number | null;
  details?: Record<string, unknown>;
  ipAddress?: string | null;
}): void {
  db.prepare(
    `INSERT INTO audit_logs (user_id, username, action, target_type, target_id, details_json, ip_address, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    params.userId,
    params.username,
    params.action,
    params.targetType,
    params.targetId != null ? String(params.targetId) : null,
    JSON.stringify(params.details ?? {}),
    params.ipAddress ?? null,
    new Date().toISOString()
  );
}

export function ensureCampaignDefaultScene(campaignId: number): void {
  const existingDefault = db
    .prepare('SELECT id FROM scenes WHERE campaign_id = ? AND is_default = 1')
    .get(campaignId);
  if (existingDefault) return;

  const campaign = db
    .prepare('SELECT name FROM campaigns WHERE id = ?')
    .get(campaignId) as { name: string } | undefined;
  const sceneName = campaign?.name?.trim() || 'Default';

  const sceneCount = db
    .prepare('SELECT COUNT(*) AS count FROM scenes WHERE campaign_id = ?')
    .get(campaignId) as { count: number };
  const makeActive = sceneCount.count === 0 ? 1 : 0;
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO scenes (campaign_id, name, grid_json, camera_json, fog_json, los_json, is_active, is_default, version, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?)`
  ).run(
    campaignId,
    sceneName,
    JSON.stringify({ size: 64, offsetX: 0, offsetY: 0, visible: true }),
    JSON.stringify({ x: 0, y: 0, zoom: 1 }),
    JSON.stringify({ enabled: false, peek: false, brushSize: 100 }),
    JSON.stringify({ enabled: false, peek: false }),
    makeActive,
    now
  );
}

export function seedCampaignDefaults(campaignId: number): void {
  const now = new Date().toISOString();

  ensureCampaignDefaultScene(campaignId);

  const ruleCount = db
    .prepare('SELECT COUNT(*) AS count FROM rules WHERE campaign_id = ?')
    .get(campaignId) as { count: number };

  if (ruleCount.count === 0) {
    const insertRule = db.prepare(
      `INSERT OR IGNORE INTO rules (campaign_id, key, title, category, value_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    insertRule.run(
      campaignId,
      'diagonal_rule',
      'Diagonal Movement',
      'movement',
      JSON.stringify({
        mode: '5-10-5',
        description: 'Pathfinder 5/10/5 alternating diagonal cost',
      }),
      now
    );
    insertRule.run(
      campaignId,
      'feet_per_square',
      'Grid Scale',
      'movement',
      JSON.stringify({
        feet: 5,
        description: 'Distance per grid square in feet',
      }),
      now
    );
    insertRule.run(
      campaignId,
      'allow_player_doors',
      'Door Interaction',
      'vision',
      JSON.stringify({
        enabled: true,
        description: 'Allow players to open and close doors',
      }),
      now
    );
  }
}

function seedDefaults(): void {
  const now = new Date().toISOString();

  // Ensure default campaign #1 exists
  const campCount = db
    .prepare('SELECT COUNT(*) AS count FROM campaigns')
    .get() as { count: number };
  let defaultCampaignId = 1;
  if (campCount.count === 0) {
    const cRes = db
      .prepare('INSERT INTO campaigns (name, created_at) VALUES (?, ?)')
      .run('Default Campaign', now);
    defaultCampaignId = Number(cRes.lastInsertRowid);
  } else {
    const first = db
      .prepare('SELECT id FROM campaigns ORDER BY id ASC LIMIT 1')
      .get() as { id: number };
    defaultCampaignId = first.id;
  }

  // Ensure default admin user exists when no users exist
  const userCount = db
    .prepare('SELECT COUNT(*) AS count FROM users')
    .get() as { count: number };
  if (userCount.count === 0) {
    const salt = crypto.randomBytes(16).toString('hex');
    const derived = crypto.scryptSync('admin', salt, 64).toString('hex');
    const passwordHash = `${salt}:${derived}`;
    const uRes = db
      .prepare(
        `INSERT INTO users (username, display_name, password_hash, role, is_admin, is_active, created_at)
         VALUES (?, ?, ?, 'gm', 1, 1, ?)`
      )
      .run('admin', 'Admin', passwordHash, now);
    const adminId = Number(uRes.lastInsertRowid);

    db.prepare(
      `INSERT OR IGNORE INTO campaign_members (campaign_id, user_id, role, status, joined_at)
       VALUES (?, ?, 'gm', 'active', ?)`
    ).run(defaultCampaignId, adminId, now);
  }

  seedCampaignDefaults(defaultCampaignId);
}

seedDefaults();

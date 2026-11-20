import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {
  attachUser,
  clearSession,
  createSession,
  hashPassword,
  requireAdmin,
  requireAuth,
  requireCampaignMember,
  requireGm,
  setSessionCampaign,
  verifyPassword,
  type AuthedRequest,
  type UserRole,
} from './auth.js';
import {
  db,
  ensureCampaignDefaultScene,
  recordAuditLog,
  seedCampaignDefaults,
} from './db.js';
import {
  attachRealtimeServer,
  broadcastDelta,
  broadcastSnapshotToAll,
  flushAuthoritativeStateNow,
  getAuthoritativeScene,
  loadSceneFromDb,
  markBlobUpdated,
  serializeSceneForRole,
} from './gameState.js';
import {
  createRateLimiter,
  sendProtectedBinary,
  validateImageMagicBytes,
  validateMapMediaMagicBytes,
} from './security.js';

const PORT = Number(process.env.PORT ?? 3001);
const app = express();
const server = http.createServer(app);

app.use(express.json({ limit: '5mb' }));
app.use(attachUser);

const authLimiter = createRateLimiter({
  windowMs: 60_000,
  maxRequests: 20,
  label: 'auth',
});

const uploadLimiter = createRateLimiter({
  windowMs: 60_000,
  maxRequests: 40,
  label: 'upload',
});

const sensitiveLimiter = createRateLimiter({
  windowMs: 60_000,
  maxRequests: 60,
  label: 'mutation',
});

function isCampaignGm(
  userId: number,
  campaignId: number,
  isAdmin = false
): boolean {
  if (isAdmin) return true;
  const row = db
    .prepare(
      `SELECT role, status FROM campaign_members
       WHERE campaign_id = ? AND user_id = ?`
    )
    .get(campaignId, userId) as { role: string; status: string } | undefined;
  return Boolean(row && row.status === 'active' && row.role === 'gm');
}

function canUserCreateCampaign(userId: number, isAdmin: boolean): boolean {
  if (isAdmin) return true;
  const u = db
    .prepare('SELECT role FROM users WHERE id = ?')
    .get(userId) as { role: string } | undefined;
  if (u?.role === 'gm') return true;
  const gmCount = db
    .prepare(
      `SELECT COUNT(*) AS count FROM campaign_members
       WHERE user_id = ? AND role = 'gm' AND status = 'active'`
    )
    .get(userId) as { count: number };
  return gmCount.count > 0;
}

// --- Health ---
app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

// Temporary dev shortcut: set to false (or DEV_AUTO_LOGIN=false) to re-enable login screen on fresh sessions
const DEV_AUTO_LOGIN = process.env.DEV_AUTO_LOGIN !== 'false';
const DEV_AUTO_CAMPAIGN = 'White Plume Mountain';

// --- Auth (No self-registration; users are manually created by Admin) ---
app.get('/api/auth/me', (req: AuthedRequest, res) => {
  if (!req.user && DEV_AUTO_LOGIN) {
    const u = db
      .prepare(
        `SELECT id, username, display_name, role, is_admin, is_active
         FROM users WHERE is_admin = 1 AND is_active = 1 ORDER BY id ASC LIMIT 1`
      )
      .get() as
      | {
          id: number;
          username: string;
          display_name: string;
          role: UserRole;
          is_admin: number;
          is_active: number;
        }
      | undefined;

    const camp = db
      .prepare('SELECT id FROM campaigns WHERE name = ? LIMIT 1')
      .get(DEV_AUTO_CAMPAIGN) as { id: number } | undefined;

    if (u && camp) {
      const token = createSession(u.id, res);
      db.prepare('UPDATE sessions SET campaign_id = ? WHERE token = ?').run(
        camp.id,
        token
      );
      res.json({
        user: {
          id: u.id,
          username: u.username,
          displayName: u.display_name,
          isAdmin: Boolean(u.is_admin),
          isActive: true,
          role: 'gm' as UserRole,
          campaignId: camp.id,
          membershipStatus: 'active',
        },
      });
      return;
    }
  }
  res.json({ user: req.user ?? null });
});

app.post('/api/auth/login', authLimiter, (req, res) => {
  const { username, password } = req.body as {
    username?: string;
    password?: string;
  };
  const cleanUser = (username ?? '').trim().toLowerCase();
  if (!cleanUser || !password) {
    res.status(400).json({ error: 'Username and password required' });
    return;
  }

  const row = db
    .prepare(
      `SELECT id, username, display_name, password_hash, role, is_admin, is_active
       FROM users
       WHERE username = ?`
    )
    .get(cleanUser) as
    | {
        id: number;
        username: string;
        display_name: string;
        password_hash: string;
        role: UserRole;
        is_admin: number;
        is_active: number;
      }
    | undefined;

  if (!row || !verifyPassword(password, row.password_hash)) {
    res.status(401).json({ error: 'Invalid username or password' });
    return;
  }

  if (!row.is_active) {
    res.status(403).json({ error: 'Account is disabled' });
    return;
  }

  createSession(row.id, res);
  res.json({
    user: {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      role: row.role,
      isAdmin: Boolean(row.is_admin),
      isActive: true,
      campaignId: null,
      membershipStatus: 'active',
    },
  });
});

app.post('/api/auth/logout', (req, res) => {
  clearSession(req, res);
  res.json({ ok: true });
});

// --- Admin Specific: User Management ---
app.get('/api/admin/users', requireAdmin, (_req, res) => {
  const memberships = db
    .prepare(
      `SELECT cm.user_id AS userId, cm.campaign_id AS campaignId,
              c.name AS campaignName, cm.role
       FROM campaign_members cm
       JOIN campaigns c ON c.id = cm.campaign_id
       WHERE cm.status = 'active'
       ORDER BY c.id ASC`
    )
    .all() as Array<{
    userId: number;
    campaignId: number;
    campaignName: string;
    role: UserRole;
  }>;

  const byUser = new Map<
    number,
    Array<{ campaignId: number; campaignName: string; role: UserRole }>
  >();
  for (const m of memberships) {
    let list = byUser.get(m.userId);
    if (!list) {
      list = [];
      byUser.set(m.userId, list);
    }
    list.push({
      campaignId: m.campaignId,
      campaignName: m.campaignName,
      role: m.role,
    });
  }

  const users = db
    .prepare(
      `SELECT id, username, display_name AS displayName, role,
              is_admin AS isAdmin, is_active AS isActive, created_at AS createdAt
       FROM users ORDER BY id ASC`
    )
    .all()
    .map((u) => {
      const row = u as {
        id: number;
        username: string;
        displayName: string;
        role: UserRole;
        isAdmin: number;
        isActive: number;
        createdAt: string;
      };
      return {
        ...row,
        isAdmin: Boolean(row.isAdmin),
        isActive: Boolean(row.isActive),
        campaigns: byUser.get(row.id) ?? [],
      };
    });
  res.json({ users });
});

app.post(
  '/api/admin/users',
  requireAdmin,
  sensitiveLimiter,
  (req: AuthedRequest, res) => {
    const { username, displayName, password, role, isAdmin } = req.body as {
      username?: string;
      displayName?: string;
      password?: string;
      role?: UserRole;
      isAdmin?: boolean;
    };

    const cleanUser = (username ?? '').trim().toLowerCase();
    const cleanName = (displayName ?? '').trim() || cleanUser;
    if (cleanUser.length < 2 || !password || password.length < 3) {
      res.status(400).json({
        error: 'Username (min 2 chars) and password (min 3 chars) required',
      });
      return;
    }

    const existing = db
      .prepare('SELECT id FROM users WHERE username = ?')
      .get(cleanUser);
    if (existing) {
      res.status(409).json({ error: 'Username already exists' });
      return;
    }

    const userRole: UserRole = role === 'gm' ? 'gm' : 'player';
    const adminFlag = isAdmin ? 1 : 0;
    const now = new Date().toISOString();

    const result = db
      .prepare(
        `INSERT INTO users (username, display_name, password_hash, role, is_admin, is_active, created_at)
         VALUES (?, ?, ?, ?, ?, 1, ?)`
      )
      .run(
        cleanUser,
        cleanName,
        hashPassword(password),
        userRole,
        adminFlag,
        now
      );

    const newId = Number(result.lastInsertRowid);
    recordAuditLog({
      userId: req.user!.id,
      username: req.user!.username,
      action: 'admin:user_create',
      targetType: 'user',
      targetId: newId,
      details: { username: cleanUser, role: userRole, isAdmin: Boolean(adminFlag) },
      ipAddress: req.ip,
    });

    res.status(201).json({
      user: {
        id: newId,
        username: cleanUser,
        displayName: cleanName,
        role: userRole,
        isAdmin: Boolean(adminFlag),
        isActive: true,
        createdAt: now,
      },
    });
  }
);

app.put(
  '/api/admin/users/:id',
  requireAdmin,
  sensitiveLimiter,
  (req: AuthedRequest, res) => {
    const targetId = Number(req.params.id);
    const { displayName, role, isAdmin, isActive, password } = req.body as {
      displayName?: string;
      role?: UserRole;
      isAdmin?: boolean;
      isActive?: boolean;
      password?: string;
    };

    const existing = db
      .prepare('SELECT id, username FROM users WHERE id = ?')
      .get(targetId) as { id: number; username: string } | undefined;
    if (!existing) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    if (displayName !== undefined) {
      db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(
        displayName.trim() || existing.username,
        targetId
      );
    }
    if (role !== undefined) {
      db.prepare('UPDATE users SET role = ? WHERE id = ?').run(
        role === 'gm' ? 'gm' : 'player',
        targetId
      );
    }
    if (isAdmin !== undefined) {
      db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(
        isAdmin ? 1 : 0,
        targetId
      );
    }
    if (isActive !== undefined) {
      db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(
        isActive ? 1 : 0,
        targetId
      );
      if (!isActive) {
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(targetId);
      }
    }
    if (password && password.length >= 3) {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(
        hashPassword(password),
        targetId
      );
    }

    recordAuditLog({
      userId: req.user!.id,
      username: req.user!.username,
      action: 'admin:user_update',
      targetType: 'user',
      targetId,
      details: { role, isAdmin, isActive, passwordReset: Boolean(password) },
      ipAddress: req.ip,
    });

    res.json({ ok: true });
  }
);

app.delete(
  '/api/admin/users/:id',
  requireAdmin,
  sensitiveLimiter,
  (req: AuthedRequest, res) => {
    const targetId = Number(req.params.id);
    if (targetId === req.user!.id) {
      res.status(400).json({ error: 'Cannot delete your own admin account' });
      return;
    }
    db.prepare('DELETE FROM users WHERE id = ?').run(targetId);
    recordAuditLog({
      userId: req.user!.id,
      username: req.user!.username,
      action: 'admin:user_delete',
      targetType: 'user',
      targetId,
      ipAddress: req.ip,
    });
    res.json({ ok: true });
  }
);

// --- Lobby & Campaign Management ---
app.get('/api/users/directory', requireAuth, (req: AuthedRequest, res) => {
  if (!canUserCreateCampaign(req.user!.id, req.user!.isAdmin)) {
    res.status(403).json({ error: 'GM or Admin permission required' });
    return;
  }
  const users = db
    .prepare(
      `SELECT id, username, display_name AS displayName, role
       FROM users WHERE is_active = 1 ORDER BY username ASC`
    )
    .all();
  res.json({ users });
});

app.get('/api/campaigns', requireAuth, (req: AuthedRequest, res) => {
  const userId = req.user!.id;
  const isAdmin = req.user!.isAdmin;

  // Admins see all campaigns with GM access; non-admins see only assigned campaigns
  const rows = isAdmin
    ? (db
        .prepare(
          `SELECT c.id, c.name, c.created_at AS createdAt, 'gm' AS myRole
           FROM campaigns c
           ORDER BY c.id ASC`
        )
        .all() as Array<{
        id: number;
        name: string;
        createdAt: string;
        myRole: UserRole;
      }>)
    : (db
        .prepare(
          `SELECT c.id, c.name, c.created_at AS createdAt, cm.role AS myRole
           FROM campaigns c
           JOIN campaign_members cm ON cm.campaign_id = c.id
           WHERE cm.user_id = ? AND cm.status = 'active'
           ORDER BY c.id ASC`
        )
        .all(userId) as Array<{
        id: number;
        name: string;
        createdAt: string;
        myRole: UserRole;
      }>);

  const campaigns = rows.map((c) => {
    const members =
      c.myRole === 'gm'
        ? db
            .prepare(
              `SELECT u.id AS userId, u.username, u.display_name AS displayName,
                      cm.role, cm.status
               FROM campaign_members cm
               JOIN users u ON u.id = cm.user_id
               WHERE cm.campaign_id = ?
               ORDER BY u.username ASC`
            )
            .all(c.id)
        : [];
    return {
      ...c,
      members,
    };
  });

  res.json({
    campaigns,
    canCreateCampaign: canUserCreateCampaign(userId, req.user!.isAdmin),
  });
});

app.post(
  '/api/campaigns',
  requireAuth,
  sensitiveLimiter,
  (req: AuthedRequest, res) => {
    if (!canUserCreateCampaign(req.user!.id, req.user!.isAdmin)) {
      res.status(403).json({ error: 'GM permission required to create campaigns' });
      return;
    }

    const name = String((req.body as { name?: string }).name ?? '').trim();
    if (!name) {
      res.status(400).json({ error: 'Campaign name required' });
      return;
    }

    const now = new Date().toISOString();
    const cRes = db
      .prepare('INSERT INTO campaigns (name, created_by, created_at) VALUES (?, ?, ?)')
      .run(name, req.user!.id, now);
    const campaignId = Number(cRes.lastInsertRowid);

    db.prepare(
      `INSERT INTO campaign_members (campaign_id, user_id, role, status, joined_at)
       VALUES (?, ?, 'gm', 'active', ?)`
    ).run(campaignId, req.user!.id, now);

    // Auto-assign default campaign roles: admin & jeff as gm, players as player
    const defaultAssignments: Array<{ username: string; role: UserRole }> = [
      { username: 'admin', role: 'gm' },
      { username: 'jeff', role: 'gm' },
      { username: 'players', role: 'player' },
    ];
    for (const entry of defaultAssignments) {
      const u = db
        .prepare('SELECT id FROM users WHERE username = ? AND is_active = 1')
        .get(entry.username) as { id: number } | undefined;
      if (u) {
        db.prepare(
          `INSERT OR IGNORE INTO campaign_members (campaign_id, user_id, role, status, joined_at)
           VALUES (?, ?, ?, 'active', ?)`
        ).run(campaignId, u.id, entry.role, now);
      }
    }

    seedCampaignDefaults(campaignId);

    recordAuditLog({
      userId: req.user!.id,
      username: req.user!.username,
      action: 'campaign:create',
      targetType: 'campaign',
      targetId: campaignId,
      details: { name },
      ipAddress: req.ip,
    });

    res.status(201).json({
      campaign: { id: campaignId, name, createdAt: now, myRole: 'gm' },
    });
  }
);

app.put(
  '/api/campaigns/:id',
  requireAuth,
  sensitiveLimiter,
  (req: AuthedRequest, res) => {
    const campaignId = Number(req.params.id);
    if (!isCampaignGm(req.user!.id, campaignId, req.user!.isAdmin)) {
      res.status(403).json({ error: 'GM permission required for this campaign' });
      return;
    }
    const name = String((req.body as { name?: string }).name ?? '').trim();
    if (!name) {
      res.status(400).json({ error: 'Campaign name required' });
      return;
    }
    db.prepare('UPDATE campaigns SET name = ? WHERE id = ?').run(name, campaignId);
    recordAuditLog({
      userId: req.user!.id,
      username: req.user!.username,
      action: 'campaign:rename',
      targetType: 'campaign',
      targetId: campaignId,
      details: { name },
      ipAddress: req.ip,
    });
    res.json({ ok: true });
  }
);

app.delete(
  '/api/campaigns/:id',
  requireAuth,
  sensitiveLimiter,
  (req: AuthedRequest, res) => {
    const campaignId = Number(req.params.id);
    if (!isCampaignGm(req.user!.id, campaignId, req.user!.isAdmin)) {
      res.status(403).json({ error: 'GM permission required for this campaign' });
      return;
    }
    db.prepare('DELETE FROM campaigns WHERE id = ?').run(campaignId);
    recordAuditLog({
      userId: req.user!.id,
      username: req.user!.username,
      action: 'campaign:delete',
      targetType: 'campaign',
      targetId: campaignId,
      ipAddress: req.ip,
    });
    res.json({ ok: true });
  }
);

app.post(
  '/api/campaigns/:id/members',
  requireAuth,
  sensitiveLimiter,
  (req: AuthedRequest, res) => {
    const campaignId = Number(req.params.id);
    if (!isCampaignGm(req.user!.id, campaignId, req.user!.isAdmin)) {
      res.status(403).json({ error: 'GM permission required for this campaign' });
      return;
    }
    const { userId, role } = req.body as { userId?: number; role?: UserRole };
    const targetUserId = Number(userId);
    const memberRole: UserRole = role === 'gm' ? 'gm' : 'player';

    const userRow = db
      .prepare('SELECT id, username FROM users WHERE id = ? AND is_active = 1')
      .get(targetUserId) as { id: number; username: string } | undefined;
    if (!userRow) {
      res.status(404).json({ error: 'Active user not found' });
      return;
    }

    db.prepare(
      `INSERT INTO campaign_members (campaign_id, user_id, role, status, joined_at)
       VALUES (?, ?, ?, 'active', ?)
       ON CONFLICT(campaign_id, user_id) DO UPDATE SET role = excluded.role, status = 'active'`
    ).run(campaignId, targetUserId, memberRole, new Date().toISOString());

    recordAuditLog({
      userId: req.user!.id,
      username: req.user!.username,
      action: 'campaign:assign_member',
      targetType: 'campaign',
      targetId: campaignId,
      details: { targetUser: userRow.username, role: memberRole },
      ipAddress: req.ip,
    });
    res.json({ ok: true });
  }
);

app.delete(
  '/api/campaigns/:id/members/:userId',
  requireAuth,
  sensitiveLimiter,
  (req: AuthedRequest, res) => {
    const campaignId = Number(req.params.id);
    const targetUserId = Number(req.params.userId);
    if (!isCampaignGm(req.user!.id, campaignId, req.user!.isAdmin)) {
      res.status(403).json({ error: 'GM permission required for this campaign' });
      return;
    }
    if (targetUserId === req.user!.id) {
      res.status(400).json({ error: 'Cannot remove yourself as GM' });
      return;
    }
    db.prepare(
      'DELETE FROM campaign_members WHERE campaign_id = ? AND user_id = ?'
    ).run(campaignId, targetUserId);
    db.prepare(
      'UPDATE sessions SET campaign_id = NULL WHERE user_id = ? AND campaign_id = ?'
    ).run(targetUserId, campaignId);

    recordAuditLog({
      userId: req.user!.id,
      username: req.user!.username,
      action: 'campaign:remove_member',
      targetType: 'campaign',
      targetId: campaignId,
      details: { targetUserId },
      ipAddress: req.ip,
    });
    res.json({ ok: true });
  }
);

app.post('/api/campaigns/:id/enter', requireAuth, (req: AuthedRequest, res) => {
  const campaignId = Number(req.params.id);
  const campaignExists = db
    .prepare('SELECT id FROM campaigns WHERE id = ?')
    .get(campaignId);
  if (!campaignExists) {
    res.status(404).json({ error: 'Campaign not found' });
    return;
  }

  if (req.user!.isAdmin) {
    ensureCampaignDefaultScene(campaignId);
    setSessionCampaign(req, campaignId);
    res.json({
      ok: true,
      campaignId,
      role: 'gm' as UserRole,
    });
    return;
  }

  const member = db
    .prepare(
      `SELECT role, status FROM campaign_members
       WHERE campaign_id = ? AND user_id = ?`
    )
    .get(campaignId, req.user!.id) as
    | { role: UserRole; status: string }
    | undefined;

  if (!member || member.status !== 'active') {
    res.status(403).json({ error: 'You are not assigned to this campaign' });
    return;
  }

  ensureCampaignDefaultScene(campaignId);
  setSessionCampaign(req, campaignId);
  res.json({
    ok: true,
    campaignId,
    role: member.role,
  });
});

app.post('/api/campaigns/leave', requireAuth, (req, res) => {
  setSessionCampaign(req, null);
  res.json({ ok: true });
});

// --- In-Campaign Users & Audit Logs ---
app.get('/api/users', requireCampaignMember, (req: AuthedRequest, res) => {
  const rows = db
    .prepare(
      `SELECT u.id, u.username, u.display_name AS displayName,
              cm.role, cm.status AS membershipStatus, u.created_at AS createdAt
       FROM campaign_members cm
       JOIN users u ON u.id = cm.user_id
       WHERE cm.campaign_id = ?
       ORDER BY u.id ASC`
    )
    .all(req.user!.campaignId!);
  res.json({ users: rows });
});

app.get('/api/audit', requireGm, (_req, res) => {
  const logs = db
    .prepare(
      `SELECT id, user_id AS userId, username, action, target_type AS targetType,
              target_id AS targetId, details_json, ip_address AS ipAddress,
              created_at AS createdAt
       FROM audit_logs
       ORDER BY id DESC LIMIT 50`
    )
    .all()
    .map((r) => {
      const row = r as {
        id: number;
        userId: number | null;
        username: string;
        action: string;
        targetType: string;
        targetId: string | null;
        details_json: string;
        ipAddress: string | null;
        createdAt: string;
      };
      return {
        id: row.id,
        userId: row.userId,
        username: row.username,
        action: row.action,
        targetType: row.targetType,
        targetId: row.targetId,
        details: JSON.parse(row.details_json || '{}'),
        ipAddress: row.ipAddress,
        createdAt: row.createdAt,
      };
    });
  res.json({ logs });
});

// --- Scenes & Authoritative State (Scoped to Session Campaign) ---
app.get('/api/scenes', requireCampaignMember, (req: AuthedRequest, res) => {
  const campaignId = req.user!.campaignId!;
  flushAuthoritativeStateNow(campaignId);
  ensureCampaignDefaultScene(campaignId);
  const scenes = db
    .prepare(
      `SELECT id, name, is_active AS isActive, is_default AS isDefault,
              updated_at AS updatedAt, (map_blob IS NOT NULL) AS hasMap
       FROM scenes WHERE campaign_id = ?
       ORDER BY is_default DESC, id ASC`
    )
    .all(campaignId)
    .map((s) => {
      const row = s as {
        id: number;
        name: string;
        isActive: number;
        isDefault: number;
        updatedAt: string;
        hasMap: number;
      };
      return {
        ...row,
        isActive: Boolean(row.isActive),
        isDefault: Boolean(row.isDefault),
        hasMap: Boolean(row.hasMap),
      };
    });
  res.json({ scenes });
});

app.get(
  '/api/scenes/active',
  requireCampaignMember,
  (req: AuthedRequest, res) => {
    const campaignId = req.user!.campaignId!;
    const scene = getAuthoritativeScene(campaignId);
    if (!scene) {
      res.status(404).json({ error: 'No scenes found' });
      return;
    }
    res.json({ scene: serializeSceneForRole(scene, req.user!.role) });
  }
);

app.post(
  '/api/scenes',
  requireGm,
  sensitiveLimiter,
  (req: AuthedRequest, res) => {
    const campaignId = req.user!.campaignId!;
    flushAuthoritativeStateNow(campaignId);
    const { name, activate } = req.body as {
      name?: string;
      activate?: boolean;
    };
    const sceneName = (name ?? '').trim() || `Scene ${Date.now()}`;
    const now = new Date().toISOString();

    db.exec('BEGIN');
    let sceneId = 0;
    try {
      if (activate !== false) {
        db.prepare('UPDATE scenes SET is_active = 0 WHERE campaign_id = ?').run(
          campaignId
        );
      }
      const result = db
        .prepare(
          `INSERT INTO scenes (campaign_id, name, owner_id, grid_json, camera_json, fog_json, los_json, is_active, version, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
        )
        .run(
          campaignId,
          sceneName,
          req.user!.id,
          JSON.stringify({ size: 64, offsetX: 0, offsetY: 0, visible: true }),
          JSON.stringify({ x: 0, y: 0, zoom: 1 }),
          JSON.stringify({ enabled: false, peek: false, brushSize: 100 }),
          JSON.stringify({ enabled: false, peek: false }),
          activate !== false ? 1 : 0,
          now
        );
      sceneId = Number(result.lastInsertRowid);
      db.prepare(
        'INSERT INTO tokens (scene_id, x, y, color, label, version) VALUES (?, ?, ?, ?, ?, 1)'
      ).run(sceneId, 224, 224, '#e05a47', 'P1');
      db.prepare(
        'INSERT INTO tokens (scene_id, x, y, color, label, version) VALUES (?, ?, ?, ?, ?, 1)'
      ).run(sceneId, 352, 224, '#4a90e2', 'P2');
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    recordAuditLog({
      userId: req.user!.id,
      username: req.user!.username,
      action: 'scene:create',
      targetType: 'scene',
      targetId: sceneId,
      details: { campaignId, name: sceneName },
      ipAddress: req.ip,
    });

    const loaded = loadSceneFromDb(campaignId, sceneId)!;
    broadcastSnapshotToAll(campaignId);
    res
      .status(201)
      .json({ scene: serializeSceneForRole(loaded, req.user!.role) });
  }
);

app.post(
  '/api/scenes/:id/activate',
  requireGm,
  sensitiveLimiter,
  (req: AuthedRequest, res) => {
    const campaignId = req.user!.campaignId!;
    flushAuthoritativeStateNow(campaignId);
    const id = Number(req.params.id);
    const existing = db
      .prepare('SELECT id, name FROM scenes WHERE id = ? AND campaign_id = ?')
      .get(id, campaignId) as { id: number; name: string } | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Scene not found' });
      return;
    }

    db.exec('BEGIN');
    try {
      db.prepare('UPDATE scenes SET is_active = 0 WHERE campaign_id = ?').run(
        campaignId
      );
      db.prepare(
        'UPDATE scenes SET is_active = 1 WHERE id = ? AND campaign_id = ?'
      ).run(id, campaignId);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    recordAuditLog({
      userId: req.user!.id,
      username: req.user!.username,
      action: 'scene:activate',
      targetType: 'scene',
      targetId: id,
      details: { campaignId, name: existing.name },
      ipAddress: req.ip,
    });

    const loaded = loadSceneFromDb(campaignId, id)!;
    broadcastSnapshotToAll(campaignId);
    res.json({ scene: serializeSceneForRole(loaded, req.user!.role) });
  }
);

app.patch(
  '/api/scenes/:id',
  requireGm,
  sensitiveLimiter,
  (req: AuthedRequest, res) => {
    const campaignId = req.user!.campaignId!;
    const id = Number(req.params.id);
    const { name } = req.body as { name?: string };
    const cleanName = (name ?? '').trim();
    if (!cleanName) {
      res.status(400).json({ error: 'Scene name is required' });
      return;
    }

    const existing = db
      .prepare('SELECT id, name, map_id FROM scenes WHERE id = ? AND campaign_id = ?')
      .get(id, campaignId) as
      | { id: number; name: string; map_id: number | null }
      | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Scene not found' });
      return;
    }

    const now = new Date().toISOString();
    db.prepare(
      'UPDATE scenes SET name = ?, updated_at = ? WHERE id = ? AND campaign_id = ?'
    ).run(cleanName, now, id, campaignId);

    if (existing.map_id !== null) {
      db.prepare(
        'UPDATE maps SET name = ? WHERE id = ? AND campaign_id = ?'
      ).run(cleanName, existing.map_id, campaignId);
    } else {
      db.prepare(
        'UPDATE maps SET name = ? WHERE campaign_id = ? AND name = ?'
      ).run(cleanName, campaignId, existing.name);
    }

    const active = getAuthoritativeScene(campaignId);
    if (active && active.id === id) {
      active.name = cleanName;
      active.updatedAt = now;
    }

    recordAuditLog({
      userId: req.user!.id,
      username: req.user!.username,
      action: 'scene:rename',
      targetType: 'scene',
      targetId: id,
      details: { campaignId, name: cleanName },
      ipAddress: req.ip,
    });

    broadcastSnapshotToAll(campaignId);
    res.json({ ok: true, id, name: cleanName });
  }
);

// --- Saved Map Library ---
app.get('/api/maps', requireCampaignMember, (req: AuthedRequest, res) => {
  const rows = db
    .prepare(
      `SELECT id, name, mime, LENGTH(blob) AS sizeBytes, created_at AS createdAt
       FROM maps
       WHERE campaign_id = ?
       ORDER BY id DESC`
    )
    .all(req.user!.campaignId!);
  res.json({ maps: rows });
});

app.get('/api/maps/:id', requireCampaignMember, (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const row = db
    .prepare('SELECT blob, mime FROM maps WHERE id = ? AND campaign_id = ?')
    .get(id, req.user!.campaignId!) as
    | { blob: Uint8Array; mime: string }
    | undefined;
  if (!row) {
    res.status(404).end();
    return;
  }
  sendProtectedBinary(res, row.blob, row.mime);
});

app.post(
  '/api/maps',
  requireGm,
  uploadLimiter,
  express.raw({ type: '*/*', limit: '250mb' }),
  (req: AuthedRequest, res) => {
    const campaignId = req.user!.campaignId!;
    const body = req.body as Buffer;
    const check = validateMapMediaMagicBytes(body);
    if (!check.valid || !check.mime) {
      res
        .status(400)
        .json({ error: 'Invalid or unsupported map media file signature' });
      return;
    }

    const rawName =
      typeof req.query.name === 'string'
        ? req.query.name
        : typeof req.headers['x-map-name'] === 'string'
        ? req.headers['x-map-name']
        : '';
    const cleanName = rawName.trim() || `Map ${Date.now()}`;
    const now = new Date().toISOString();

    const result = db
      .prepare(
        `INSERT INTO maps (campaign_id, name, mime, blob, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(campaignId, cleanName, check.mime, body, req.user!.id, now);

    const mapId = Number(result.lastInsertRowid);
    const sceneIdParam = Number(req.query.sceneId);
    if (Number.isFinite(sceneIdParam) && sceneIdParam > 0) {
      db.prepare(
        'UPDATE scenes SET map_id = ? WHERE id = ? AND campaign_id = ?'
      ).run(mapId, sceneIdParam, campaignId);
    }
    res.status(201).json({
      map: {
        id: mapId,
        name: cleanName,
        mime: check.mime,
        sizeBytes: body.length,
        createdAt: now,
      },
    });
  }
);

app.post(
  '/api/maps/from-url',
  requireGm,
  uploadLimiter,
  async (req: AuthedRequest, res) => {
    const campaignId = req.user!.campaignId!;
    const { url, name } = req.body as { url?: string; name?: string };
    const cleanUrl = (url ?? '').trim();
    if (!/^https?:\/\//i.test(cleanUrl)) {
      res.status(400).json({ error: 'URL must start with http:// or https://' });
      return;
    }

    try {
      const upstream = await fetch(cleanUrl);
      if (!upstream.ok) {
        res
          .status(400)
          .json({ error: `Could not fetch URL (${upstream.status})` });
        return;
      }
      const arr = await upstream.arrayBuffer();
      if (arr.byteLength > 250 * 1024 * 1024) {
        res.status(413).json({ error: 'Remote map exceeds 250MB limit' });
        return;
      }
      const buf = Buffer.from(arr);
      const check = validateMapMediaMagicBytes(buf);
      if (!check.valid || !check.mime) {
        res
          .status(400)
          .json({ error: 'URL did not return a supported map image or video' });
        return;
      }

      let derivedName = (name ?? '').trim();
      if (!derivedName) {
        try {
          const parsed = new URL(cleanUrl);
          derivedName =
            parsed.pathname.split('/').filter(Boolean).pop() ||
            `URL Map ${Date.now()}`;
        } catch {
          derivedName = `URL Map ${Date.now()}`;
        }
      }

      const now = new Date().toISOString();
      const result = db
        .prepare(
          `INSERT INTO maps (campaign_id, name, mime, blob, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(campaignId, derivedName, check.mime, buf, req.user!.id, now);

      const mapId = Number(result.lastInsertRowid);
      res.status(201).json({
        map: {
          id: mapId,
          name: derivedName,
          mime: check.mime,
          sizeBytes: buf.length,
          createdAt: now,
        },
      });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to load URL',
      });
    }
  }
);

app.post(
  '/api/scenes/:id/apply-map',
  requireGm,
  sensitiveLimiter,
  (req: AuthedRequest, res) => {
    const campaignId = req.user!.campaignId!;
    const sceneId = Number(req.params.id);
    const { mapId } = req.body as { mapId?: number };

    const mapRow = db
      .prepare('SELECT blob, mime FROM maps WHERE id = ? AND campaign_id = ?')
      .get(Number(mapId), campaignId) as
      | { blob: Uint8Array; mime: string }
      | undefined;
    if (!mapRow) {
      res.status(404).json({ error: 'Saved map not found' });
      return;
    }

    const sceneRow = db
      .prepare('SELECT id FROM scenes WHERE id = ? AND campaign_id = ?')
      .get(sceneId, campaignId);
    if (!sceneRow) {
      res.status(404).json({ error: 'Scene not found' });
      return;
    }

    db.prepare(
      'UPDATE scenes SET map_blob = ?, map_mime = ?, map_id = ?, updated_at = ? WHERE id = ?'
    ).run(mapRow.blob, mapRow.mime, Number(mapId), new Date().toISOString(), sceneId);

    markBlobUpdated(campaignId, 'map', req.user!.id);
    res.json({ ok: true });
  }
);

app.patch(
  '/api/maps/:id',
  requireGm,
  sensitiveLimiter,
  (req: AuthedRequest, res) => {
    const campaignId = req.user!.campaignId!;
    const id = Number(req.params.id);
    const { name } = req.body as { name?: string };
    const cleanName = (name ?? '').trim();
    if (!cleanName) {
      res.status(400).json({ error: 'Map name is required' });
      return;
    }

    const existing = db
      .prepare('SELECT id, name FROM maps WHERE id = ? AND campaign_id = ?')
      .get(id, campaignId) as { id: number; name: string } | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Saved map not found' });
      return;
    }

    const now = new Date().toISOString();
    db.prepare('UPDATE maps SET name = ? WHERE id = ? AND campaign_id = ?').run(
      cleanName,
      id,
      campaignId
    );
    db.prepare(
      'UPDATE scenes SET name = ?, updated_at = ? WHERE map_id = ? AND campaign_id = ?'
    ).run(cleanName, now, id, campaignId);

    const active = getAuthoritativeScene(campaignId);
    if (active) {
      const row = db
        .prepare('SELECT name FROM scenes WHERE id = ?')
        .get(active.id) as { name: string } | undefined;
      if (row) {
        active.name = row.name;
        active.updatedAt = now;
      }
    }

    broadcastSnapshotToAll(campaignId);
    res.json({ ok: true, id, name: cleanName });
  }
);

app.delete(
  '/api/maps/:id',
  requireGm,
  sensitiveLimiter,
  (req: AuthedRequest, res) => {
    const id = Number(req.params.id);
    db.prepare('DELETE FROM maps WHERE id = ? AND campaign_id = ?').run(
      id,
      req.user!.campaignId!
    );
    res.json({ ok: true });
  }
);

app.delete(
  '/api/scenes/:id',
  requireGm,
  sensitiveLimiter,
  (req: AuthedRequest, res) => {
    const campaignId = req.user!.campaignId!;
    flushAuthoritativeStateNow(campaignId);
    const id = Number(req.params.id);
    const target = db
      .prepare(
        'SELECT id, is_default AS isDefault FROM scenes WHERE id = ? AND campaign_id = ?'
      )
      .get(id, campaignId) as { id: number; isDefault: number } | undefined;
    if (!target) {
      res.status(404).json({ error: 'Scene not found' });
      return;
    }
    if (target.isDefault) {
      res.status(400).json({ error: 'Cannot delete the default campaign scene' });
      return;
    }

    const count = db
      .prepare('SELECT COUNT(*) AS count FROM scenes WHERE campaign_id = ?')
      .get(campaignId) as { count: number };
    if (count.count <= 1) {
      res.status(400).json({ error: 'Cannot delete the last scene' });
      return;
    }
    db.prepare('DELETE FROM scenes WHERE id = ? AND campaign_id = ?').run(
      id,
      campaignId
    );
    const active = db
      .prepare(
        'SELECT id FROM scenes WHERE campaign_id = ? AND is_active = 1'
      )
      .get(campaignId);
    if (!active) {
      db.prepare(
        'UPDATE scenes SET is_active = 1 WHERE id = (SELECT id FROM scenes WHERE campaign_id = ? ORDER BY is_default DESC, id ASC LIMIT 1)'
      ).run(campaignId);
    }

    recordAuditLog({
      userId: req.user!.id,
      username: req.user!.username,
      action: 'scene:delete',
      targetType: 'scene',
      targetId: id,
      details: { campaignId },
      ipAddress: req.ip,
    });

    loadSceneFromDb(campaignId);
    broadcastSnapshotToAll(campaignId);
    res.json({ ok: true });
  }
);

// --- Protected Binary Uploads & Downloads (Map, Fog, Paint) ---
app.put(
  '/api/scenes/:id/map',
  requireGm,
  uploadLimiter,
  express.raw({ type: '*/*', limit: '250mb' }),
  (req: AuthedRequest, res) => {
    const campaignId = req.user!.campaignId!;
    const id = Number(req.params.id);
    const existing = db
      .prepare('SELECT id FROM scenes WHERE id = ? AND campaign_id = ?')
      .get(id, campaignId);
    if (!existing) {
      res.status(404).json({ error: 'Scene not found' });
      return;
    }

    const body = req.body as Buffer;
    const check = validateMapMediaMagicBytes(body);
    if (!check.valid || !check.mime) {
      res
        .status(400)
        .json({ error: 'Invalid or unsupported map media file signature' });
      return;
    }

    db.prepare(
      'UPDATE scenes SET map_blob = ?, map_mime = ?, updated_at = ? WHERE id = ?'
    ).run(body, check.mime, new Date().toISOString(), id);

    recordAuditLog({
      userId: req.user!.id,
      username: req.user!.username,
      action: 'map:upload',
      targetType: 'scene',
      targetId: id,
      details: { mime: check.mime, bytes: body.length },
      ipAddress: req.ip,
    });

    markBlobUpdated(campaignId, 'map', req.user!.id);
    res.json({ ok: true, size: body.length });
  }
);

app.get(
  '/api/scenes/:id/map',
  requireCampaignMember,
  (req: AuthedRequest, res) => {
    const id = Number(req.params.id);
    const row = db
      .prepare(
        'SELECT map_blob, map_mime FROM scenes WHERE id = ? AND campaign_id = ?'
      )
      .get(id, req.user!.campaignId!) as
      | { map_blob: Uint8Array | null; map_mime: string | null }
      | undefined;

    if (!row || !row.map_blob) {
      res.status(404).end();
      return;
    }

    sendProtectedBinary(res, row.map_blob, row.map_mime || 'image/png');
  }
);

app.put(
  '/api/scenes/:id/fog',
  requireGm,
  uploadLimiter,
  express.raw({ type: '*/*', limit: '25mb' }),
  (req: AuthedRequest, res) => {
    const campaignId = req.user!.campaignId!;
    const id = Number(req.params.id);
    const existing = db
      .prepare('SELECT id FROM scenes WHERE id = ? AND campaign_id = ?')
      .get(id, campaignId);
    if (!existing) {
      res.status(404).json({ error: 'Scene not found' });
      return;
    }

    const body = req.body as Buffer;
    const check = validateImageMagicBytes(body);
    if (!check.valid || check.mime !== 'image/png') {
      res.status(400).json({ error: 'Fog layer must be a valid PNG image' });
      return;
    }

    db.prepare(
      'UPDATE scenes SET fog_blob = ?, updated_at = ? WHERE id = ?'
    ).run(body, new Date().toISOString(), id);

    markBlobUpdated(campaignId, 'fog', req.user!.id);
    res.json({ ok: true });
  }
);

app.get(
  '/api/scenes/:id/fog',
  requireCampaignMember,
  (req: AuthedRequest, res) => {
    const id = Number(req.params.id);
    const row = db
      .prepare('SELECT fog_blob FROM scenes WHERE id = ? AND campaign_id = ?')
      .get(id, req.user!.campaignId!) as
      | { fog_blob: Uint8Array | null }
      | undefined;

    if (!row || !row.fog_blob) {
      res.status(404).end();
      return;
    }

    sendProtectedBinary(res, row.fog_blob, 'image/png');
  }
);

app.put(
  '/api/scenes/:id/paint',
  requireCampaignMember,
  uploadLimiter,
  express.raw({ type: '*/*', limit: '25mb' }),
  (req: AuthedRequest, res) => {
    const campaignId = req.user!.campaignId!;
    const id = Number(req.params.id);
    const existing = db
      .prepare('SELECT id FROM scenes WHERE id = ? AND campaign_id = ?')
      .get(id, campaignId);
    if (!existing) {
      res.status(404).json({ error: 'Scene not found' });
      return;
    }

    const body = req.body as Buffer;
    const check = validateImageMagicBytes(body);
    if (!check.valid || check.mime !== 'image/png') {
      res.status(400).json({ error: 'Paint layer must be a valid PNG image' });
      return;
    }

    db.prepare(
      'UPDATE scenes SET paint_blob = ?, updated_at = ? WHERE id = ?'
    ).run(body, new Date().toISOString(), id);

    markBlobUpdated(campaignId, 'paint', req.user!.id);
    res.json({ ok: true });
  }
);

app.get(
  '/api/scenes/:id/paint',
  requireCampaignMember,
  (req: AuthedRequest, res) => {
    const id = Number(req.params.id);
    const row = db
      .prepare(
        'SELECT paint_blob FROM scenes WHERE id = ? AND campaign_id = ?'
      )
      .get(id, req.user!.campaignId!) as
      | { paint_blob: Uint8Array | null }
      | undefined;

    if (!row || !row.paint_blob) {
      res.status(404).end();
      return;
    }

    sendProtectedBinary(res, row.paint_blob, 'image/png');
  }
);

// --- Rules ---
app.get('/api/rules', requireCampaignMember, (req: AuthedRequest, res) => {
  const rows = db
    .prepare(
      `SELECT id, key, title, category, value_json, updated_at AS updatedAt
       FROM rules WHERE campaign_id = ? ORDER BY id ASC`
    )
    .all(req.user!.campaignId!)
    .map((r) => {
      const row = r as {
        id: number;
        key: string;
        title: string;
        category: string;
        value_json: string;
        updatedAt: string;
      };
      return {
        id: row.id,
        key: row.key,
        title: row.title,
        category: row.category,
        value: JSON.parse(row.value_json),
        updatedAt: row.updatedAt,
      };
    });
  res.json({ rules: rows });
});

app.put(
  '/api/rules/:key',
  requireGm,
  sensitiveLimiter,
  (req: AuthedRequest, res) => {
    const campaignId = req.user!.campaignId!;
    const key = String(req.params.key).trim();
    const { title, category, value } = req.body as {
      title?: string;
      category?: string;
      value?: Record<string, unknown>;
    };
    if (!key || !value || typeof value !== 'object') {
      res.status(400).json({ error: 'Rule key and value object required' });
      return;
    }

    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO rules (campaign_id, key, title, category, value_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(campaign_id, key) DO UPDATE SET
         title = excluded.title,
         category = excluded.category,
         value_json = excluded.value_json,
         updated_at = excluded.updated_at`
    ).run(
      campaignId,
      key,
      (title ?? key).trim(),
      (category ?? 'general').trim(),
      JSON.stringify(value),
      now
    );

    recordAuditLog({
      userId: req.user!.id,
      username: req.user!.username,
      action: 'rule:update',
      targetType: 'rule',
      targetId: key,
      details: value,
      ipAddress: req.ip,
    });

    broadcastDelta(campaignId, { type: 'rule:updated', key, value }, req.user!.id);
    res.json({ ok: true, key, updatedAt: now });
  }
);

app.delete(
  '/api/rules/:key',
  requireGm,
  sensitiveLimiter,
  (req: AuthedRequest, res) => {
    const campaignId = req.user!.campaignId!;
    const key = String(req.params.key);
    db.prepare('DELETE FROM rules WHERE campaign_id = ? AND key = ?').run(
      campaignId,
      key
    );

    recordAuditLog({
      userId: req.user!.id,
      username: req.user!.username,
      action: 'rule:delete',
      targetType: 'rule',
      targetId: key,
      ipAddress: req.ip,
    });

    broadcastDelta(
      campaignId,
      { type: 'rule:updated', key, value: {} },
      req.user!.id
    );
    res.json({ ok: true });
  }
);

// --- Chat & Dice Roller ---
function evaluateDiceCommand(text: string): string | null {
  const cmd = text.trim().match(/^\/(?:roll|r)\s+(.+)$/i);
  if (!cmd) return null;

  const expr = cmd[1].replace(/\s+/g, '');
  const tokens = expr.match(/[+-]?(?:\d+d\d+|\d+)/gi);
  if (!tokens || tokens.join('') !== expr) return null;

  const parts: string[] = [];
  let total = 0;
  let hasDice = false;

  for (let idx = 0; idx < tokens.length; idx++) {
    const raw = tokens[idx];
    const sign = raw.startsWith('-') ? -1 : 1;
    const body = raw.replace(/^[+-]/, '');
    const diceMatch = body.match(/^(\d+)d(\d+)$/i);

    if (diceMatch) {
      hasDice = true;
      const count = Math.min(100, Math.max(1, Number(diceMatch[1])));
      const sides = Math.min(1000, Math.max(2, Number(diceMatch[2])));
      const rolls: number[] = [];
      let sum = 0;
      for (let i = 0; i < count; i++) {
        const val = Math.floor(Math.random() * sides) + 1;
        rolls.push(val);
        sum += val;
      }
      total += sign * sum;
      const prefix = idx === 0 ? (sign < 0 ? '-' : '') : sign < 0 ? ' - ' : ' + ';
      parts.push(`${prefix}[${rolls.join(', ')}]`);
    } else {
      const val = Number(body);
      total += sign * val;
      const prefix = idx === 0 ? (sign < 0 ? '-' : '') : sign < 0 ? ' - ' : ' + ';
      parts.push(`${prefix}${val}`);
    }
  }

  if (!hasDice) return null;
  const formattedExpr = cmd[1].trim();
  return `${formattedExpr} = ${parts.join('')} -> ${total}`;
}

app.get('/api/chat', requireCampaignMember, (req: AuthedRequest, res) => {
  const messages = db
    .prepare(
      `SELECT id, sender_name AS senderName, message, roll_result AS rollResult, created_at AS createdAt
       FROM chat_messages
       WHERE campaign_id = ?
       ORDER BY id DESC LIMIT 100`
    )
    .all(req.user!.campaignId!)
    .reverse();
  res.json({ messages });
});

app.post(
  '/api/chat',
  requireCampaignMember,
  sensitiveLimiter,
  (req: AuthedRequest, res) => {
    const campaignId = req.user!.campaignId!;
    const { message } = req.body as { message?: string };
    const text = (message ?? '').trim().slice(0, 500);
    if (!text) {
      res.status(400).json({ error: 'Message cannot be empty' });
      return;
    }

    const sender = req.user!.displayName;
    const rollResult = evaluateDiceCommand(text);
    const createdAt = new Date().toISOString();

    const result = db
      .prepare(
        `INSERT INTO chat_messages (campaign_id, user_id, sender_name, message, roll_result, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(campaignId, req.user!.id, sender, text, rollResult, createdAt);

    const chatMsg = {
      id: Number(result.lastInsertRowid),
      senderName: sender,
      message: text,
      rollResult,
      createdAt,
    };

    broadcastDelta(
      campaignId,
      { type: 'chat:message', message: chatMsg },
      req.user!.id
    );
    res.status(201).json({ message: chatMsg });
  }
);

// Serve built frontend if available
const distDir = path.resolve(process.cwd(), 'dist');
if (fs.existsSync(path.join(distDir, 'index.html'))) {
  app.use(express.static(distDir));
  app.get('/{*splat}', (_req, res) => {
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

attachRealtimeServer(server);

process.on('SIGINT', () => {
  flushAuthoritativeStateNow();
  process.exit(0);
});

server.listen(PORT, () => {
  console.log(
    `Arena VTT Authoritative SQLite + WebSocket server listening on http://localhost:${PORT}`
  );
});

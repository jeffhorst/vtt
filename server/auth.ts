import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { NextFunction, Request, Response } from 'express';
import { db } from './db.js';

export type UserRole = 'gm' | 'player';
export type MembershipStatus = 'active' | 'revoked';

export interface AuthUser {
  id: number;
  username: string;
  displayName: string;
  isAdmin: boolean;
  isActive: boolean;
  role: UserRole;
  campaignId: number | null;
  membershipStatus: MembershipStatus;
}

export interface AuthedRequest extends Request {
  user?: AuthUser;
}

const SESSION_COOKIE = 'vtt_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, keyHex] = stored.split(':');
  if (!salt || !keyHex) return false;
  const derived = crypto.scryptSync(password, salt, 64);
  const storedBuf = Buffer.from(keyHex, 'hex');
  if (derived.length !== storedBuf.length) return false;
  return crypto.timingSafeEqual(derived, storedBuf);
}

export function parseCookies(
  cookieHeader: string | undefined
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  }
  return out;
}

export function createSession(userId: number, res: Response): string {
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_TTL_MS);

  db.prepare(
    'INSERT INTO sessions (token, user_id, campaign_id, expires_at, created_at) VALUES (?, ?, NULL, ?, ?)'
  ).run(token, userId, expires.toISOString(), now.toISOString());

  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_MS,
  });
  return token;
}

export function setSessionCampaign(
  req: Request,
  campaignId: number | null
): void {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[SESSION_COOKIE];
  if (!token) return;
  db.prepare('UPDATE sessions SET campaign_id = ? WHERE token = ?').run(
    campaignId,
    token
  );
}

export function clearSession(req: Request, res: Response): void {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[SESSION_COOKIE];
  if (token) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

export function getSessionUserFromCookie(
  cookieHeader: string | undefined
): AuthUser | null {
  const cookies = parseCookies(cookieHeader);
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;

  const row = db
    .prepare(
      `SELECT u.id, u.username, u.display_name, u.role AS user_role,
              u.is_admin, u.is_active,
              s.campaign_id, s.expires_at,
              cm.role AS camp_role, cm.status AS camp_status
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN campaign_members cm
         ON cm.user_id = u.id AND cm.campaign_id = s.campaign_id
       WHERE s.token = ?`
    )
    .get(token) as
    | {
        id: number;
        username: string;
        display_name: string;
        user_role: UserRole;
        is_admin: number;
        is_active: number;
        campaign_id: number | null;
        expires_at: string;
        camp_role: UserRole | null;
        camp_status: MembershipStatus | null;
      }
    | undefined;

  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now() || !row.is_active) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }

  const isAdmin = Boolean(row.is_admin);
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    isAdmin,
    isActive: Boolean(row.is_active),
    role: isAdmin ? 'gm' : row.camp_role ?? row.user_role,
    campaignId: row.campaign_id,
    membershipStatus: isAdmin
      ? 'active'
      : row.campaign_id !== null
      ? row.camp_status ?? 'revoked'
      : 'active',
  };
}

export function getSessionUser(
  req: Request | IncomingMessage
): AuthUser | null {
  return getSessionUserFromCookie(req.headers.cookie);
}

export function attachUser(
  req: AuthedRequest,
  _res: Response,
  next: NextFunction
): void {
  req.user = getSessionUser(req) ?? undefined;
  next();
}

export function requireAuth(
  req: AuthedRequest,
  res: Response,
  next: NextFunction
): void {
  if (!req.user || !req.user.isActive) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  next();
}

export function requireAdmin(
  req: AuthedRequest,
  res: Response,
  next: NextFunction
): void {
  if (!req.user || !req.user.isActive) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  if (!req.user.isAdmin) {
    res.status(403).json({ error: 'Admin permission required' });
    return;
  }
  next();
}

export function requireCampaignMember(
  req: AuthedRequest,
  res: Response,
  next: NextFunction
): void {
  if (!req.user || !req.user.isActive) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  if (req.user.campaignId === null || req.user.membershipStatus !== 'active') {
    res.status(403).json({ error: 'Active campaign membership required' });
    return;
  }
  next();
}

export function requireGm(
  req: AuthedRequest,
  res: Response,
  next: NextFunction
): void {
  if (!req.user || !req.user.isActive) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  if (
    req.user.campaignId === null ||
    req.user.membershipStatus !== 'active' ||
    req.user.role !== 'gm'
  ) {
    res.status(403).json({ error: 'GM permission required' });
    return;
  }
  next();
}

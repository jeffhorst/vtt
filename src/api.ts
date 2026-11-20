import type {
  AuditLogEntry,
  CampaignSummary,
  ChatMessage,
  RuleRecord,
  SavedMapSummary,
  SceneData,
  SceneSummary,
  User,
  UserRole,
} from './types';

async function jsonRequest<T>(
  url: string,
  options: RequestInit = {}
): Promise<T> {
  const res = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

export const api = {
  getMe: () => jsonRequest<{ user: User | null }>('/api/auth/me'),

  login: (username: string, password: string) =>
    jsonRequest<{ user: User }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),

  logout: () =>
    jsonRequest<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),

  // Admin: User Management
  listAdminUsers: () => jsonRequest<{ users: User[] }>('/api/admin/users'),

  createAdminUser: (payload: {
    username: string;
    displayName: string;
    password: string;
    role: UserRole;
    isAdmin: boolean;
  }) =>
    jsonRequest<{ user: User }>('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  updateAdminUser: (
    id: number,
    payload: {
      displayName?: string;
      role?: UserRole;
      isAdmin?: boolean;
      isActive?: boolean;
      password?: string;
    }
  ) =>
    jsonRequest<{ ok: boolean }>(`/api/admin/users/${id}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),

  deleteAdminUser: (id: number) =>
    jsonRequest<{ ok: boolean }>(`/api/admin/users/${id}`, {
      method: 'DELETE',
    }),

  // Lobby & Campaign Management
  listUserDirectory: () =>
    jsonRequest<{
      users: Array<{ id: number; username: string; displayName: string; role: UserRole }>;
    }>('/api/users/directory'),

  listCampaigns: () =>
    jsonRequest<{ campaigns: CampaignSummary[]; canCreateCampaign: boolean }>(
      '/api/campaigns'
    ),

  createCampaign: (name: string) =>
    jsonRequest<{ campaign: CampaignSummary }>('/api/campaigns', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),

  renameCampaign: (id: number, name: string) =>
    jsonRequest<{ ok: boolean }>(`/api/campaigns/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ name }),
    }),

  deleteCampaign: (id: number) =>
    jsonRequest<{ ok: boolean }>(`/api/campaigns/${id}`, {
      method: 'DELETE',
    }),

  assignCampaignMember: (id: number, userId: number, role: UserRole) =>
    jsonRequest<{ ok: boolean }>(`/api/campaigns/${id}/members`, {
      method: 'POST',
      body: JSON.stringify({ userId, role }),
    }),

  removeCampaignMember: (id: number, userId: number) =>
    jsonRequest<{ ok: boolean }>(`/api/campaigns/${id}/members/${userId}`, {
      method: 'DELETE',
    }),

  enterCampaign: (id: number) =>
    jsonRequest<{ ok: boolean; campaignId: number; role: UserRole }>(
      `/api/campaigns/${id}/enter`,
      { method: 'POST' }
    ),

  leaveCampaign: () =>
    jsonRequest<{ ok: boolean }>('/api/campaigns/leave', { method: 'POST' }),

  listUsers: () => jsonRequest<{ users: User[] }>('/api/users'),

  listAuditLogs: () => jsonRequest<{ logs: AuditLogEntry[] }>('/api/audit'),

  listScenes: () => jsonRequest<{ scenes: SceneSummary[] }>('/api/scenes'),

  getActiveScene: () => jsonRequest<{ scene: SceneData }>('/api/scenes/active'),

  createScene: (name: string) =>
    jsonRequest<{ scene: SceneData }>('/api/scenes', {
      method: 'POST',
      body: JSON.stringify({ name, activate: true }),
    }),

  activateScene: (id: number) =>
    jsonRequest<{ scene: SceneData }>(`/api/scenes/${id}/activate`, {
      method: 'POST',
    }),

  deleteScene: (id: number) =>
    jsonRequest<{ ok: boolean }>(`/api/scenes/${id}`, {
      method: 'DELETE',
    }),

  renameScene: (id: number, name: string) =>
    jsonRequest<{ ok: boolean; id: number; name: string }>(
      `/api/scenes/${id}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ name }),
      }
    ),

  listMaps: () => jsonRequest<{ maps: SavedMapSummary[] }>('/api/maps'),

  uploadSavedMap: async (
    name: string,
    blob: Blob,
    sceneId?: number
  ): Promise<{ map: SavedMapSummary }> => {
    const qs = new URLSearchParams({ name });
    if (sceneId !== undefined) qs.set('sceneId', String(sceneId));
    const res = await fetch(`/api/maps?${qs.toString()}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': blob.type || 'application/octet-stream' },
      body: blob,
    });
    const data = (await res.json().catch(() => ({}))) as {
      map?: SavedMapSummary;
      error?: string;
    };
    if (!res.ok || !data.map) {
      throw new Error(data.error || `Map save failed (${res.status})`);
    }
    return { map: data.map };
  },

  renameSavedMap: (id: number, name: string) =>
    jsonRequest<{ ok: boolean; id: number; name: string }>(`/api/maps/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),

  importMapFromUrl: (url: string, name?: string) =>
    jsonRequest<{ map: SavedMapSummary }>('/api/maps/from-url', {
      method: 'POST',
      body: JSON.stringify({ url, name }),
    }),

  fetchSavedMapBlob: async (mapId: number): Promise<Blob> => {
    const res = await fetch(`/api/maps/${mapId}`, {
      credentials: 'same-origin',
    });
    if (!res.ok) throw new Error(`Map fetch failed (${res.status})`);
    return res.blob();
  },

  applySavedMapToScene: (sceneId: number, mapId: number) =>
    jsonRequest<{ ok: boolean }>(`/api/scenes/${sceneId}/apply-map`, {
      method: 'POST',
      body: JSON.stringify({ mapId }),
    }),

  deleteSavedMap: (mapId: number) =>
    jsonRequest<{ ok: boolean }>(`/api/maps/${mapId}`, {
      method: 'DELETE',
    }),

  uploadSceneMap: async (id: number, blob: Blob): Promise<void> => {
    const res = await fetch(`/api/scenes/${id}/map`, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': blob.type || 'image/png' },
      body: blob,
    });
    if (!res.ok) throw new Error(`Map upload failed (${res.status})`);
  },

  fetchSceneMapBlob: async (id: number): Promise<Blob | null> => {
    const res = await fetch(`/api/scenes/${id}/map`, {
      credentials: 'same-origin',
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Map fetch failed (${res.status})`);
    return res.blob();
  },

  uploadSceneFog: async (id: number, blob: Blob): Promise<void> => {
    const res = await fetch(`/api/scenes/${id}/fog`, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'image/png' },
      body: blob,
    });
    if (!res.ok) throw new Error(`Fog upload failed (${res.status})`);
  },

  fetchSceneFogBlob: async (id: number): Promise<Blob | null> => {
    const res = await fetch(`/api/scenes/${id}/fog`, {
      credentials: 'same-origin',
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Fog fetch failed (${res.status})`);
    return res.blob();
  },

  uploadScenePaint: async (id: number, blob: Blob): Promise<void> => {
    const res = await fetch(`/api/scenes/${id}/paint`, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'image/png' },
      body: blob,
    });
    if (!res.ok) throw new Error(`Paint upload failed (${res.status})`);
  },

  fetchScenePaintBlob: async (id: number): Promise<Blob | null> => {
    const res = await fetch(`/api/scenes/${id}/paint`, {
      credentials: 'same-origin',
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Paint fetch failed (${res.status})`);
    return res.blob();
  },

  listRules: () => jsonRequest<{ rules: RuleRecord[] }>('/api/rules'),

  saveRule: (
    key: string,
    title: string,
    category: string,
    value: Record<string, unknown>
  ) =>
    jsonRequest<{ ok: boolean }>(`/api/rules/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: JSON.stringify({ title, category, value }),
    }),

  deleteRule: (key: string) =>
    jsonRequest<{ ok: boolean }>(`/api/rules/${encodeURIComponent(key)}`, {
      method: 'DELETE',
    }),

  listChat: () => jsonRequest<{ messages: ChatMessage[] }>('/api/chat'),

  sendChat: (message: string, senderName?: string) =>
    jsonRequest<{ message: ChatMessage }>('/api/chat', {
      method: 'POST',
      body: JSON.stringify({ message, senderName }),
    }),
};

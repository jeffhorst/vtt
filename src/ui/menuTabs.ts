import { api } from '../api';
import {
  applySceneData,
  flushDirtyBlobsNow,
  prefetchSceneMap,
  saveActiveSceneCamera,
} from '../persistence';
import { draw } from '../renderer';
import { rulesConfig, runtime, tokens } from '../state';
import { sendSyncAction } from '../sync';
import type { DiagonalRuleMode } from '../types';
import { createAccordionSection } from './floatingWindow';

export interface MenuTabCallbacks {
  syncAllUI: () => void;
  onAuthChanged?: () => Promise<void>;
  onSceneRenamed?: (sceneId: number, name: string) => void;
}

export function setupChatTab(pane: HTMLDivElement): () => Promise<void> {
  pane.textContent = '';
  pane.style.height = '100%';
  const wrapper = document.createElement('div');
  wrapper.className = 'chat-pane';

  const logEl = document.createElement('div');
  logEl.className = 'chat-log';

  const form = document.createElement('form');
  form.className = 'panel-row';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'vtt-input';
  input.placeholder = 'Message or /roll 1d20+5';

  const sendBtn = document.createElement('button');
  sendBtn.type = 'submit';
  sendBtn.className = 'mini-btn';
  sendBtn.textContent = 'Send';

  form.append(input, sendBtn);
  wrapper.append(logEl, form);
  pane.appendChild(wrapper);

  async function refreshChat(): Promise<void> {
    if (!runtime.currentUser) {
      logEl.textContent = 'Sign in under Config to view campaign chat.';
      return;
    }
    try {
      const { messages } = await api.listChat();
      logEl.textContent = '';
      for (const msg of messages) {
        const entry = document.createElement('div');
        entry.className = 'chat-entry';

        const header = document.createElement('div');
        header.className = 'chat-entry-header';

        const sender = document.createElement('span');
        sender.className = 'chat-sender';
        sender.textContent = msg.senderName;

        const timeEl = document.createElement('span');
        timeEl.className = 'chat-time';
        timeEl.textContent = new Date(msg.createdAt).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        });

        header.append(sender, timeEl);

        const text = document.createElement('div');
        text.className = 'chat-text';
        text.textContent = msg.message;

        entry.append(header, text);

        if (msg.rollResult) {
          const roll = document.createElement('div');
          roll.className = 'chat-roll';
          const arrowIdx = msg.rollResult.lastIndexOf(' -> ');
          if (arrowIdx !== -1) {
            const detail = msg.rollResult.slice(0, arrowIdx);
            const total = msg.rollResult.slice(arrowIdx + 4);
            const detailSpan = document.createElement('span');
            detailSpan.textContent = `${detail} = `;
            const totalSpan = document.createElement('span');
            totalSpan.className = 'chat-roll-total';
            totalSpan.textContent = total;
            roll.append(detailSpan, totalSpan);
          } else {
            roll.textContent = msg.rollResult;
          }
          entry.appendChild(roll);
        }

        logEl.appendChild(entry);
      }
      logEl.scrollTop = logEl.scrollHeight;
      requestAnimationFrame(() => {
        logEl.scrollTop = logEl.scrollHeight;
      });
    } catch {
      logEl.textContent = 'Sign in under Config to join campaign chat.';
    }
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    try {
      await api.sendChat(text);
      await refreshChat();
    } catch (err) {
      console.warn('Chat send failed:', err);
    }
  });

  return refreshChat;
}

export function setupActorsTab(pane: HTMLDivElement): () => void {
  pane.textContent = '';

  const listSection = createAccordionSection(pane, 'Scene Tokens', true);
  const listEl = document.createElement('div');
  listEl.className = 'vtt-list';
  listSection.body.appendChild(listEl);

  createAccordionSection(pane, 'PCs', true, 'actors-pcs');
  createAccordionSection(pane, 'NPCs', true, 'actors-npcs');
  createAccordionSection(pane, 'Mobs', true, 'actors-mobs');

  function renderTokens(): void {
    listEl.textContent = '';
    const isGm = runtime.currentUser?.role === 'gm';
    for (const token of tokens) {
      const item = document.createElement('div');
      item.className = 'vtt-list-item';
      if (token.id === runtime.selectedTokenId) item.classList.add('active');

      const left = document.createElement('div');
      left.className = 'panel-row';

      const swatch = document.createElement('span');
      swatch.className = 'token-swatch';
      swatch.style.background = token.color;

      const label = document.createElement('span');
      label.textContent = token.label;

      left.append(swatch, label);

      const actions = document.createElement('div');
      actions.className = 'panel-row';

      const selectBtn = document.createElement('button');
      selectBtn.type = 'button';
      selectBtn.className = 'mini-btn';
      selectBtn.textContent = 'Select';
      selectBtn.addEventListener('click', () => {
        runtime.selectedTokenId = token.id;
        renderTokens();
        draw();
      });
      actions.appendChild(selectBtn);

      const canDelete =
        isGm ||
        (runtime.currentUser && token.ownerId === runtime.currentUser.id);
      if (canDelete) {
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'mini-btn';
        delBtn.textContent = '✕';
        delBtn.addEventListener('click', () => {
          sendSyncAction({ action: 'token:delete', id: token.id });
        });
        actions.appendChild(delBtn);
      }

      item.append(left, actions);
      listEl.appendChild(item);
    }
  }

  renderTokens();
  return renderTokens;
}

export function setupScenesAccordion(
  scenePane: HTMLDivElement,
  callbacks: MenuTabCallbacks
): () => Promise<void> {
  const scenesAccordion = createAccordionSection(scenePane, 'Scenes', true);

  const createRow = document.createElement('div');
  createRow.className = 'panel-row';

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'vtt-input';
  nameInput.placeholder = 'New scene name...';

  const createBtn = document.createElement('button');
  createBtn.type = 'button';
  createBtn.className = 'mini-btn';
  createBtn.textContent = 'Create';

  createRow.append(nameInput, createBtn);

  const listEl = document.createElement('div');
  listEl.className = 'vtt-list';

  scenesAccordion.body.append(createRow, listEl);

  async function refreshScenes(): Promise<void> {
    const isGm = runtime.currentUser?.role === 'gm';
    createRow.style.display = isGm ? 'flex' : 'none';
    if (!runtime.currentUser) {
      listEl.textContent = 'Sign in under Config to view campaign scenes.';
      return;
    }

    try {
      const { scenes } = await api.listScenes();
      const sortedScenes = [...scenes].sort(
        (a, b) => (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0)
      );
      listEl.textContent = '';
      for (const scene of sortedScenes) {
        const item = document.createElement('div');
        item.className = 'vtt-list-item';
        if (scene.id === runtime.activeSceneId || scene.isActive) {
          item.classList.add('active');
        }

        const title = document.createElement('span');
        title.textContent = scene.name;
        title.title = scene.name;
        title.style.flex = '1';
        title.style.minWidth = '0';
        title.style.overflow = 'hidden';
        title.style.textOverflow = 'ellipsis';
        title.style.whiteSpace = 'nowrap';

        const actions = document.createElement('div');
        actions.className = 'panel-row';
        actions.style.flexShrink = '0';
        actions.style.gap = '4px';

        if (isGm) {
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
            input.value = scene.name;

            let committed = false;
            const commit = async () => {
              if (committed) return;
              committed = true;
              const nextName = input.value.trim();
              if (nextName && nextName !== scene.name) {
                await api.renameScene(scene.id, nextName).catch(() => {});
                if (scene.id === runtime.activeSceneId) {
                  runtime.activeSceneName = nextName;
                }
                callbacks.onSceneRenamed?.(scene.id, nextName);
              }
              await refreshScenes();
            };

            input.addEventListener('keydown', (ev) => {
              if (ev.key === 'Enter') {
                ev.preventDefault();
                void commit();
              } else if (ev.key === 'Escape') {
                committed = true;
                void refreshScenes();
              }
            });
            input.addEventListener('blur', () => {
              void commit();
            });

            item.replaceChild(input, title);
            input.focus();
            input.select();
          });
          actions.appendChild(editBtn);
        }

        if (scene.id !== runtime.activeSceneId && isGm) {
          const loadBtn = document.createElement('button');
          loadBtn.type = 'button';
          loadBtn.className = 'mini-btn';
          loadBtn.textContent = 'Activate';
          loadBtn.addEventListener('pointerenter', () => {
            prefetchSceneMap(scene.id);
          });
          loadBtn.addEventListener('click', async () => {
            saveActiveSceneCamera();
            await flushDirtyBlobsNow();
            const { scene: full } = await api.activateScene(scene.id);
            await applySceneData(full, callbacks.syncAllUI);
            await refreshScenes();
          });
          actions.appendChild(loadBtn);
        } else if (scene.id === runtime.activeSceneId || scene.isActive) {
          const badge = document.createElement('span');
          badge.className = 'vtt-badge';
          badge.textContent = 'Active';
          actions.appendChild(badge);
        }

        if (!scene.isDefault && sortedScenes.length > 1 && isGm) {
          const delBtn = document.createElement('button');
          delBtn.type = 'button';
          delBtn.className = 'mini-btn';
          delBtn.textContent = '✕';
          delBtn.addEventListener('click', async () => {
            saveActiveSceneCamera();
            await flushDirtyBlobsNow();
            await api.deleteScene(scene.id);
            const { scene: active } = await api.getActiveScene();
            await applySceneData(active, callbacks.syncAllUI);
            await refreshScenes();
          });
          actions.appendChild(delBtn);
        }

        item.append(title, actions);
        listEl.appendChild(item);
      }
    } catch {
      listEl.textContent = 'Could not load scenes.';
    }
  }

  createBtn.addEventListener('click', async () => {
    const name = nameInput.value.trim() || `Scene ${Date.now()}`;
    nameInput.value = '';
    try {
      saveActiveSceneCamera();
      await flushDirtyBlobsNow();
      const { scene } = await api.createScene(name);
      await applySceneData(scene, callbacks.syncAllUI);
      await refreshScenes();
    } catch (err) {
      console.warn('Could not create scene:', err);
    }
  });

  return refreshScenes;
}

export function setupConfigTab(
  pane: HTMLDivElement,
  onRulesChanged: () => void,
  onReturnToLobby: () => Promise<void>,
  onSignOut: () => Promise<void>
): () => Promise<void> {
  pane.textContent = '';

  // --- Account & Session Section ---
  const accountSection = createAccordionSection(
    pane,
    'Session & Members',
    true
  );
  const accountContainer = document.createElement('div');
  accountContainer.className = 'vtt-list';
  accountSection.body.appendChild(accountContainer);

  // --- Rules Section ---
  const rulesSection = createAccordionSection(pane, 'Rules', true);

  const diagRow = document.createElement('div');
  diagRow.className = 'panel-row';
  const diagLabel = document.createElement('span');
  diagLabel.className = 'panel-label';
  diagLabel.textContent = 'Diagonals';
  const diagSelect = document.createElement('select');
  diagSelect.className = 'vtt-select';
  diagSelect.innerHTML = `
    <option value="5-10-5">Pathfinder (5/10/5)</option>
    <option value="1-1-1">5e / Grid (1-1-1)</option>
    <option value="euclidean">Euclidean</option>
  `;
  diagRow.append(diagLabel, diagSelect);

  const scaleRow = document.createElement('div');
  scaleRow.className = 'panel-row';
  const scaleLabel = document.createElement('span');
  scaleLabel.className = 'panel-label';
  scaleLabel.textContent = 'Feet / Square';
  const scaleInput = document.createElement('input');
  scaleInput.type = 'number';
  scaleInput.min = '1';
  scaleInput.max = '100';
  scaleInput.className = 'vtt-input';
  scaleInput.value = String(rulesConfig.feetPerSquare);
  scaleRow.append(scaleLabel, scaleInput);

  const doorRow = document.createElement('div');
  doorRow.className = 'panel-row';
  const doorLabel = document.createElement('span');
  doorLabel.className = 'panel-label';
  doorLabel.textContent = 'Player Doors';
  const doorBtn = document.createElement('button');
  doorBtn.type = 'button';
  doorBtn.className = 'mini-btn';
  doorRow.append(doorLabel, doorBtn);

  const customRulesList = document.createElement('div');
  customRulesList.className = 'vtt-list';

  const customRuleForm = document.createElement('form');
  customRuleForm.className = 'panel-row';
  const customRuleTitle = document.createElement('input');
  customRuleTitle.type = 'text';
  customRuleTitle.className = 'vtt-input';
  customRuleTitle.placeholder = 'Add house rule (GM)...';
  const customRuleAdd = document.createElement('button');
  customRuleAdd.type = 'submit';
  customRuleAdd.className = 'mini-btn';
  customRuleAdd.textContent = 'Add';
  customRuleForm.append(customRuleTitle, customRuleAdd);

  rulesSection.body.append(
    diagRow,
    scaleRow,
    doorRow,
    customRuleForm,
    customRulesList
  );

  function syncDoorBtn(): void {
    doorBtn.textContent = rulesConfig.allowPlayerDoors ? 'Allowed' : 'GM Only';
    doorBtn.classList.toggle('active', rulesConfig.allowPlayerDoors);
  }
  syncDoorBtn();

  diagSelect.addEventListener('change', async () => {
    rulesConfig.diagonalRule = diagSelect.value as DiagonalRuleMode;
    onRulesChanged();
    await api
      .saveRule('diagonal_rule', 'Diagonal Movement', 'movement', {
        mode: rulesConfig.diagonalRule,
      })
      .catch(() => {});
  });

  scaleInput.addEventListener('change', async () => {
    const val = Math.max(1, Math.min(100, Number(scaleInput.value) || 5));
    rulesConfig.feetPerSquare = val;
    scaleInput.value = String(val);
    onRulesChanged();
    await api
      .saveRule('feet_per_square', 'Grid Scale', 'movement', { feet: val })
      .catch(() => {});
  });

  doorBtn.addEventListener('click', async () => {
    if (runtime.currentUser?.role !== 'gm') return;
    rulesConfig.allowPlayerDoors = !rulesConfig.allowPlayerDoors;
    syncDoorBtn();
    await api
      .saveRule('allow_player_doors', 'Door Interaction', 'vision', {
        enabled: rulesConfig.allowPlayerDoors,
      })
      .catch(() => {});
  });

  async function renderAccount(): Promise<void> {
    accountContainer.textContent = '';
    const user = runtime.currentUser;
    if (!user) return;

    const row = document.createElement('div');
    row.className = 'vtt-list-item active';
    const info = document.createElement('span');
    info.textContent = `${user.displayName} (@${user.username})`;
    const right = document.createElement('div');
    right.className = 'panel-row';

    const badge = document.createElement('span');
    badge.className = 'vtt-badge';
    badge.textContent = user.role;

    const lobbyBtn = document.createElement('button');
    lobbyBtn.type = 'button';
    lobbyBtn.className = 'mini-btn';
    lobbyBtn.textContent = 'Lobby';
    lobbyBtn.addEventListener('click', () => {
      void onReturnToLobby();
    });

    const logoutBtn = document.createElement('button');
    logoutBtn.type = 'button';
    logoutBtn.className = 'mini-btn';
    logoutBtn.textContent = 'Sign Out';
    logoutBtn.addEventListener('click', () => {
      void onSignOut();
    });

    right.append(badge, lobbyBtn, logoutBtn);
    row.append(info, right);
    accountContainer.appendChild(row);

    try {
      const { users } = await api.listUsers();
      for (const member of users) {
        const mRow = document.createElement('div');
        mRow.className = 'vtt-list-item';
        const mName = document.createElement('span');
        mName.textContent = `${member.displayName} [${member.role}]`;
        mRow.appendChild(mName);
        accountContainer.appendChild(mRow);
      }
    } catch {
      // Ignore if not in campaign yet
    }
  }

  async function refreshRules(): Promise<void> {
    const isGm = runtime.currentUser?.role === 'gm';
    diagSelect.disabled = !isGm;
    scaleInput.disabled = !isGm;
    doorBtn.disabled = !isGm;
    customRuleForm.style.display = isGm ? 'flex' : 'none';

    if (!runtime.currentUser) return;
    try {
      const { rules } = await api.listRules();
      customRulesList.textContent = '';
      for (const rule of rules) {
        if (rule.key === 'diagonal_rule') {
          const mode = rule.value.mode as DiagonalRuleMode | undefined;
          if (mode) {
            rulesConfig.diagonalRule = mode;
            diagSelect.value = mode;
          }
        } else if (rule.key === 'feet_per_square') {
          const feet = Number(rule.value.feet);
          if (feet > 0) {
            rulesConfig.feetPerSquare = feet;
            scaleInput.value = String(feet);
          }
        } else if (rule.key === 'allow_player_doors') {
          rulesConfig.allowPlayerDoors = Boolean(rule.value.enabled);
          syncDoorBtn();
        } else {
          const item = document.createElement('div');
          item.className = 'vtt-list-item';
          const text = document.createElement('span');
          text.textContent = `${rule.title}: ${String(rule.value.text ?? '')}`;
          item.appendChild(text);
          if (isGm) {
            const delBtn = document.createElement('button');
            delBtn.type = 'button';
            delBtn.className = 'mini-btn';
            delBtn.textContent = '✕';
            delBtn.addEventListener('click', async () => {
              await api.deleteRule(rule.key);
              await refreshRules();
            });
            item.appendChild(delBtn);
          }
          customRulesList.appendChild(item);
        }
      }
      onRulesChanged();
    } catch {
      // Unauthenticated or offline
    }
  }

  customRuleForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = customRuleTitle.value.trim();
    if (!text) return;
    customRuleTitle.value = '';
    const key = `house_${Date.now()}`;
    await api
      .saveRule(key, 'House Rule', 'general', { text })
      .catch(() => {});
    await refreshRules();
  });

  return async () => {
    await renderAccount();
    await refreshRules();
  };
}

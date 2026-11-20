import { findTokenAt } from '../geometry';
import { getPaintObjectBounds } from '../paint/paintEngine';
import { draw, invalidateLosCache } from '../renderer';
import {
  camera,
  getTokenRadius,
  lights,
  paintObjects,
  rulesConfig,
  runtime,
  tokens,
  walls,
} from '../state';
import { sendSyncAction } from '../sync';
import { createFloatingWindow } from './floatingWindow';

export interface ObjectBarController {
  sync: (reposition?: boolean) => void;
}

export function createObjectBar(callbacks: {
  onDelete: () => void;
  onLightsChanged: () => void;
}): ObjectBarController {
  const barWin = createFloatingWindow({
    title: 'Object',
    x: 200,
    y: 200,
    w: 280,
    h: 'auto',
    rotatable: false,
    collapsible: false,
    closable: false,
    defaultCollapsed: false,
    resizable: 'horizontal',
  });
  barWin.win.classList.add('bar-layout', 'object-bar');
  barWin.win.style.width = 'auto';
  barWin.win.style.maxWidth = '520px';

  const titleEl = barWin.win.querySelector('.floating-win-title') as HTMLElement;

  function addActionBtn(label: string, onClick: () => void, active = false): void {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'vtt-bar-btn';
    if (active) btn.classList.add('active');
    btn.textContent = label;
    btn.addEventListener('click', onClick);
    barWin.body.appendChild(btn);
  }

  function addTypeBadge(label: string): void {
    const badge = document.createElement('span');
    badge.className = 'vtt-badge';
    badge.textContent = label;
    barWin.body.appendChild(badge);
  }

  function computeRightEdgeScreenPos(): { x: number; y: number } | null {
    let worldRightX = 0;
    let worldCenterY = 0;

    if (runtime.selectedTokenId !== null) {
      const t = tokens.find((tok) => tok.id === runtime.selectedTokenId);
      if (!t) return null;
      const r = t.size ?? getTokenRadius();
      worldRightX = t.x + r;
      worldCenterY = t.y;
    } else if (runtime.selectedLightId !== null) {
      const l = lights.find((li) => li.id === runtime.selectedLightId);
      if (!l) return null;
      worldRightX = l.x + 18;
      worldCenterY = l.y;
    } else if (runtime.selectedWallId !== null) {
      const w = walls.find((seg) => seg.id === runtime.selectedWallId);
      if (!w) return null;
      worldRightX = Math.max(w.x1, w.x2);
      worldCenterY = (w.y1 + w.y2) / 2;
    } else if (runtime.selectedPaintObjectId !== null) {
      const obj = paintObjects.find((o) => o.id === runtime.selectedPaintObjectId);
      if (!obj) return null;
      const b = getPaintObjectBounds(obj);
      worldRightX = b.x + b.w;
      worldCenterY = b.y + b.h / 2;
    } else {
      return null;
    }

    const sx = worldRightX * camera.zoom + camera.x + 36;
    const sy = worldCenterY * camera.zoom + camera.y - 22;
    return {
      x: Math.max(8, Math.min(window.innerWidth - 280, Math.round(sx))),
      y: Math.max(8, Math.min(window.innerHeight - 60, Math.round(sy))),
    };
  }

  function sync(reposition = true): void {
    const isGm = runtime.currentUser?.role === 'gm';
    barWin.body.textContent = '';

    if (runtime.selectedTokenId !== null) {
      const t = tokens.find((tok) => tok.id === runtime.selectedTokenId);
      if (!t) {
        barWin.setOpen(false);
        return;
      }
      titleEl.textContent = `⠿ ${t.label}`;
      addTypeBadge('Token');

      const attachedLights = lights.filter((l) => l.attachedTokenId === t.id);
      for (const l of attachedLights) {
        addActionBtn(
          `${l.name}: ${l.enabled ? 'On' : 'Off'}`,
          () => {
            l.enabled = !l.enabled;
            sendSyncAction({ action: 'lights:sync', lights });
            callbacks.onLightsChanged();
            sync(false);
            draw();
          },
          l.enabled
        );
      }

      if (isGm || (runtime.currentUser && t.ownerId === runtime.currentUser.id)) {
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'btn-danger-x';
        delBtn.textContent = 'Delete';
        delBtn.addEventListener('click', callbacks.onDelete);
        barWin.body.appendChild(delBtn);
      }
    } else if (runtime.selectedLightId !== null) {
      const l = lights.find((li) => li.id === runtime.selectedLightId);
      if (!l) {
        barWin.setOpen(false);
        return;
      }
      titleEl.textContent = `⠿ ${l.name}`;
      addTypeBadge('Light');
      addActionBtn(
        l.enabled ? 'On' : 'Off',
        () => {
          l.enabled = !l.enabled;
          sendSyncAction({ action: 'lights:sync', lights });
          callbacks.onLightsChanged();
          sync(false);
          draw();
        },
        l.enabled
      );

      const overlapToken =
        l.attachedTokenId === null ? findTokenAt(l.x, l.y) : null;
      if (overlapToken) {
        addActionBtn('Attach', () => {
          l.attachedTokenId = overlapToken.id;
          l.x = overlapToken.x;
          l.y = overlapToken.y;
          runtime.selectedLightId = null;
          runtime.selectedTokenId = overlapToken.id;
          sendSyncAction({ action: 'lights:sync', lights });
          callbacks.onLightsChanged();
          sync(true);
          draw();
        });
      }

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'btn-danger-x';
      delBtn.textContent = 'Delete';
      delBtn.addEventListener('click', callbacks.onDelete);
      barWin.body.appendChild(delBtn);
    } else if (runtime.selectedWallId !== null) {
      const w = walls.find((seg) => seg.id === runtime.selectedWallId);
      if (!w) {
        barWin.setOpen(false);
        return;
      }

      if (w.type === 'door') {
        const isSecret = Boolean(w.secret);
        titleEl.textContent = isSecret ? '⠿ Secret Door' : '⠿ Door';
        addTypeBadge(isSecret ? 'Secret Door' : 'Door');

        const canToggle =
          rulesConfig.allowPlayerDoors || isGm;
        if (canToggle && (!isSecret || w.revealed || isGm)) {
          addActionBtn(
            w.open ? 'Open' : 'Closed',
            () => {
              w.open = !w.open;
              invalidateLosCache();
              sendSyncAction({ action: 'door:toggle', id: w.id });
              sync(false);
              draw();
            },
            w.open
          );
        }

        if (isSecret && isGm) {
          addActionBtn(
            w.revealed ? 'Visible' : 'Hidden',
            () => {
              w.revealed = !w.revealed;
              sendSyncAction({
                action: 'wall:update',
                id: w.id,
                x1: w.x1,
                y1: w.y1,
                x2: w.x2,
                y2: w.y2,
                revealed: w.revealed,
              });
              sync(false);
              draw();
            },
            Boolean(w.revealed)
          );
        }
      } else {
        titleEl.textContent = '⠿ Wall';
        addTypeBadge('Wall');
      }

      if (isGm) {
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'btn-danger-x';
        delBtn.textContent = 'Delete';
        delBtn.addEventListener('click', callbacks.onDelete);
        barWin.body.appendChild(delBtn);
      }
    } else if (runtime.selectedPaintObjectId !== null) {
      const obj = paintObjects.find((o) => o.id === runtime.selectedPaintObjectId);
      if (!obj) {
        barWin.setOpen(false);
        return;
      }
      const typeLabel =
        obj.type === 'brush'
          ? 'Brush'
          : obj.type === 'line'
          ? 'Line'
          : obj.type === 'rect'
          ? 'Rect'
          : obj.type === 'ellipse'
          ? 'Oval'
          : 'Text';
      titleEl.textContent =
        obj.type === 'text' ? `⠿ ${obj.text.slice(0, 14)}` : `⠿ ${typeLabel}`;
      addTypeBadge(`Paint: ${typeLabel}`);

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'btn-danger-x';
      delBtn.textContent = 'Delete';
      delBtn.addEventListener('click', callbacks.onDelete);
      barWin.body.appendChild(delBtn);
    } else {
      barWin.setOpen(false);
      return;
    }

    if (reposition) {
      const pos = computeRightEdgeScreenPos();
      if (pos) {
        barWin.state.x = pos.x;
        barWin.state.y = pos.y;
      }
    }
    barWin.win.style.width = 'auto';
    barWin.setOpen(true);
    barWin.render();
    barWin.win.style.width = 'auto';
  }

  barWin.setOpen(false);
  return { sync };
}

import { draw } from '../renderer';
import {
  lighting,
  lights,
  runtime,
  tokens,
} from '../state';
import { sendSyncAction } from '../sync';
import type {
  AmbientLightLevel,
  LightKind,
  LightPreset,
  VisionMode,
} from '../types';
import { PAINT_PALETTE } from './paintWindow';

const PF1E_LIGHT_PRESETS: LightPreset[] = [
  {
    name: 'Torch',
    kind: 'mundane',
    spellLevel: 0,
    innerRadiusFt: 20,
    outerRadiusFt: 40,
    color: '#ffb347',
  },
  {
    name: 'Lantern',
    kind: 'mundane',
    spellLevel: 0,
    innerRadiusFt: 30,
    outerRadiusFt: 60,
    color: '#ffd166',
  },
  {
    name: 'Sunrod',
    kind: 'mundane',
    spellLevel: 0,
    innerRadiusFt: 30,
    outerRadiusFt: 60,
    color: '#fef08a',
  },
  {
    name: 'Candle',
    kind: 'mundane',
    spellLevel: 0,
    innerRadiusFt: 0,
    outerRadiusFt: 5,
    color: '#fb923c',
  },
  {
    name: 'Light',
    kind: 'light-spell',
    spellLevel: 0,
    innerRadiusFt: 20,
    outerRadiusFt: 40,
    color: '#bae6fd',
  },
  {
    name: 'Continual Flame',
    kind: 'light-spell',
    spellLevel: 2,
    innerRadiusFt: 20,
    outerRadiusFt: 40,
    color: '#93c5fd',
  },
  {
    name: 'Daylight',
    kind: 'light-spell',
    spellLevel: 3,
    innerRadiusFt: 60,
    outerRadiusFt: 120,
    color: '#ffffff',
  },
  {
    name: 'Darkness',
    kind: 'darkness-spell',
    spellLevel: 2,
    innerRadiusFt: 20,
    outerRadiusFt: 20,
    color: '#4338ca',
  },
  {
    name: 'Deeper Darkness',
    kind: 'darkness-spell',
    spellLevel: 3,
    innerRadiusFt: 60,
    outerRadiusFt: 60,
    color: '#1e1b4b',
  },
];

export interface LightingPanelController {
  syncUI: () => void;
}

export function populateLightingPanel(
  body: HTMLElement,
  onStartPlaceLight?: () => void
): LightingPanelController {
  body.textContent = '';

  // 1. Lighting, Ambient & Vision (2-row 3-column grid)
  const headerGrid = document.createElement('div');
  headerGrid.style.display = 'grid';
  headerGrid.style.gridTemplateColumns = '0.75fr 1fr 1fr';
  headerGrid.style.gap = '4px 6px';
  headerGrid.style.alignItems = 'center';

  const enableLabel = document.createElement('span');
  enableLabel.className = 'panel-label';
  enableLabel.textContent = 'Lighting';
  enableLabel.style.textAlign = 'center';
  const ambientLabel = document.createElement('span');
  ambientLabel.className = 'panel-label';
  ambientLabel.textContent = 'Ambient';
  ambientLabel.style.textAlign = 'center';
  const visionLabel = document.createElement('span');
  visionLabel.className = 'panel-label';
  visionLabel.textContent = 'Vision';
  visionLabel.style.textAlign = 'center';

  const enableBtn = document.createElement('button');
  enableBtn.type = 'button';
  enableBtn.className = 'mini-btn';
  enableBtn.style.width = '100%';

  const ambientSelect = document.createElement('select');
  ambientSelect.className = 'vtt-select';
  ambientSelect.style.minWidth = '0';
  ambientSelect.innerHTML = `
    <option value="bright">Bright</option>
    <option value="normal">Normal</option>
    <option value="dim">Dim</option>
    <option value="darkness">Darkness</option>
  `;

  const visionSelect = document.createElement('select');
  visionSelect.className = 'vtt-select';
  visionSelect.style.minWidth = '0';
  visionSelect.innerHTML = `
    <option value="normal">Normal</option>
    <option value="low-light">Low-Light (2x)</option>
    <option value="darkvision">Darkvision 60ft</option>
  `;

  headerGrid.append(
    enableLabel,
    ambientLabel,
    visionLabel,
    enableBtn,
    ambientSelect,
    visionSelect
  );

  const divider = document.createElement('hr');
  divider.className = 'paint-divider';
  divider.style.margin = '6px 0 8px 0';

  // 2. Preset Light Source Buttons
  const presetsGrid = document.createElement('div');
  presetsGrid.className = 'paint-tools-grid';
  const presetBtns = new Map<string, HTMLButtonElement>();

  function beginLightPlacement(preset: LightPreset): void {
    runtime.pendingLight = preset;
    onStartPlaceLight?.();
    syncUI();
  }

  for (const preset of PF1E_LIGHT_PRESETS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mini-btn paint-tool-btn';
    btn.textContent = preset.name;
    btn.title = `${preset.innerRadiusFt}/${preset.outerRadiusFt} ft (L${preset.spellLevel})`;
    btn.addEventListener('click', () => beginLightPlacement(preset));
    presetBtns.set(preset.name, btn);
    presetsGrid.appendChild(btn);
  }

  // 3. Custom Light Source Form
  const customForm = document.createElement('form');
  customForm.className = 'lobby-subcard';
  customForm.style.padding = '6px';
  customForm.style.gap = '6px';
  customForm.style.marginBottom = '8px';

  let selectedCustomColor = '#facc15';

  // Row 1: Custom (name) + Color button
  const cRow1 = document.createElement('div');
  cRow1.className = 'panel-row';
  cRow1.style.gap = '6px';
  const cName = document.createElement('input');
  cName.type = 'text';
  cName.className = 'vtt-input';
  cName.style.flex = '1';
  cName.style.minWidth = '0';
  cName.placeholder = 'Name';
  cName.value = 'Custom';

  const colorBtn = document.createElement('button');
  colorBtn.type = 'button';
  colorBtn.className = 'paint-swatch';
  colorBtn.style.width = '26px';
  colorBtn.style.height = '26px';
  colorBtn.style.flexShrink = '0';
  colorBtn.style.background = selectedCustomColor;
  colorBtn.title = 'Choose light color';
  cRow1.append(cName, colorBtn);

  // 16-color Palette popover/drawer (hidden until color button clicked)
  const paletteBox = document.createElement('div');
  paletteBox.className = 'paint-colors-box';
  paletteBox.style.marginBottom = '0';
  paletteBox.style.display = 'none';
  const paletteGrid = document.createElement('div');
  paletteGrid.className = 'paint-palette-grid';
  const swatchBtns = new Map<string, HTMLButtonElement>();

  function syncPaletteUI(): void {
    const activeHex = selectedCustomColor.toLowerCase();
    colorBtn.style.background = selectedCustomColor;
    for (const [hex, sw] of swatchBtns) {
      sw.classList.toggle('active', hex === activeHex);
    }
  }

  for (const hex of PAINT_PALETTE) {
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = 'paint-swatch';
    sw.style.background = hex;
    sw.addEventListener('click', () => {
      selectedCustomColor = hex;
      paletteBox.style.display = 'none';
      syncPaletteUI();
    });
    swatchBtns.set(hex.toLowerCase(), sw);
    paletteGrid.appendChild(sw);
  }
  paletteBox.appendChild(paletteGrid);
  syncPaletteUI();

  colorBtn.addEventListener('click', () => {
    paletteBox.style.display =
      paletteBox.style.display === 'none' ? 'flex' : 'none';
  });

  // Row 2 & 3: Inner / Outer labels + sliders
  const slidersRow = document.createElement('div');
  slidersRow.className = 'paint-sliders-row';

  const innerCol = document.createElement('div');
  innerCol.className = 'paint-slider-col';
  const innerLabelRow = document.createElement('div');
  innerLabelRow.className = 'panel-row';
  const innerLabel = document.createElement('span');
  innerLabel.className = 'panel-label';
  innerLabel.textContent = 'Inner';
  const innerVal = document.createElement('span');
  innerVal.textContent = '20 ft';
  const innerSlider = document.createElement('input');
  innerSlider.type = 'range';
  innerSlider.min = '0';
  innerSlider.max = '120';
  innerSlider.step = '5';
  innerSlider.value = '20';
  innerSlider.className = 'paint-slider';
  innerLabelRow.append(innerLabel, innerVal);
  innerCol.append(innerLabelRow, innerSlider);

  const outerCol = document.createElement('div');
  outerCol.className = 'paint-slider-col';
  const outerLabelRow = document.createElement('div');
  outerLabelRow.className = 'panel-row';
  const outerLabel = document.createElement('span');
  outerLabel.className = 'panel-label';
  outerLabel.textContent = 'Outer';
  const outerVal = document.createElement('span');
  outerVal.textContent = '40 ft';
  const outerSlider = document.createElement('input');
  outerSlider.type = 'range';
  outerSlider.min = '20';
  outerSlider.max = '120';
  outerSlider.step = '5';
  outerSlider.value = '40';
  outerSlider.className = 'paint-slider';
  outerLabelRow.append(outerLabel, outerVal);
  outerCol.append(outerLabelRow, outerSlider);

  innerSlider.addEventListener('input', () => {
    const inner = Number(innerSlider.value);
    innerVal.textContent = `${inner} ft`;
    outerSlider.min = String(inner);
    if (Number(outerSlider.value) < inner) {
      outerSlider.value = String(inner);
    }
    outerVal.textContent = `${outerSlider.value} ft`;
  });

  outerSlider.addEventListener('input', () => {
    const inner = Number(innerSlider.value);
    if (Number(outerSlider.value) < inner) {
      outerSlider.value = String(inner);
    }
    outerVal.textContent = `${outerSlider.value} ft`;
  });

  slidersRow.append(innerCol, outerCol);

  // Row 4: Type, Level, Add
  const cRow4 = document.createElement('div');
  cRow4.className = 'panel-row';
  cRow4.style.gap = '4px';
  const cKind = document.createElement('select');
  cKind.className = 'vtt-select';
  cKind.style.flex = '1';
  cKind.style.minWidth = '0';
  cKind.innerHTML = `
    <option value="mundane">Mundane</option>
    <option value="light-spell">Light Spell</option>
    <option value="darkness-spell">Darkness Spell</option>
  `;
  const cLevel = document.createElement('input');
  cLevel.type = 'number';
  cLevel.className = 'vtt-input';
  cLevel.style.width = '44px';
  cLevel.style.flexShrink = '0';
  cLevel.min = '0';
  cLevel.max = '9';
  cLevel.placeholder = 'Lvl';
  cLevel.title = 'Spell level';
  cLevel.value = '0';
  const cAddBtn = document.createElement('button');
  cAddBtn.type = 'submit';
  cAddBtn.className = 'mini-btn';
  cAddBtn.style.whiteSpace = 'nowrap';
  cAddBtn.textContent = 'Add';
  cRow4.append(cKind, cLevel, cAddBtn);

  customForm.append(cRow1, paletteBox, slidersRow, cRow4);
  customForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const innerFt = Math.max(0, Number(innerSlider.value) || 0);
    const outerFt = Math.max(innerFt, Number(outerSlider.value) || 0);
    beginLightPlacement({
      name: cName.value.trim() || 'Custom',
      kind: cKind.value as LightKind,
      spellLevel: Math.max(0, Math.min(9, Number(cLevel.value) || 0)),
      innerRadiusFt: innerFt,
      outerRadiusFt: outerFt,
      color: selectedCustomColor,
    });
  });

  // 4. Active Light Sources List
  const listEl = document.createElement('div');
  listEl.className = 'vtt-list';

  body.append(
    headerGrid,
    divider,
    presetsGrid,
    customForm,
    listEl
  );

  enableBtn.addEventListener('click', () => {
    if (runtime.currentUser?.role !== 'gm') return;
    lighting.enabled = !lighting.enabled;
    sendSyncAction({
      action: 'lighting:update',
      lighting: { enabled: lighting.enabled, ambient: lighting.ambient },
    });
    syncUI();
    draw();
  });

  ambientSelect.addEventListener('change', () => {
    if (runtime.currentUser?.role !== 'gm') return;
    lighting.ambient = ambientSelect.value as AmbientLightLevel;
    sendSyncAction({
      action: 'lighting:update',
      lighting: { enabled: lighting.enabled, ambient: lighting.ambient },
    });
    draw();
  });

  visionSelect.addEventListener('change', () => {
    lighting.visionMode = visionSelect.value as VisionMode;
    draw();
  });

  function syncUI(): void {
    const isGm = runtime.currentUser?.role === 'gm';
    enableBtn.textContent = lighting.enabled ? 'On' : 'Off';
    enableBtn.classList.toggle('active', lighting.enabled);
    enableBtn.disabled = !isGm;
    ambientSelect.value = lighting.ambient;
    ambientSelect.disabled = !isGm;
    visionSelect.value = lighting.visionMode;

    for (const [name, btn] of presetBtns) {
      btn.classList.toggle(
        'active',
        runtime.activeTool === 'place-light' &&
          runtime.pendingLight?.name === name
      );
    }

    listEl.textContent = '';
    for (const l of lights) {
      const item = document.createElement('div');
      item.className = 'vtt-list-item';
      if (l.id === runtime.selectedLightId) item.classList.add('active');

      const info = document.createElement('span');
      const attached =
        l.attachedTokenId !== null
          ? tokens.find((t) => t.id === l.attachedTokenId)?.label ?? 'Token'
          : 'Map';
      info.textContent = `${l.name} (${attached})`;

      const actions = document.createElement('div');
      actions.className = 'panel-row';

      const toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = 'mini-btn';
      toggleBtn.textContent = l.enabled ? 'On' : 'Off';
      toggleBtn.classList.toggle('active', l.enabled);
      toggleBtn.addEventListener('click', () => {
        l.enabled = !l.enabled;
        sendSyncAction({ action: 'lights:sync', lights });
        syncUI();
        draw();
      });

      const attachBtn = document.createElement('button');
      attachBtn.type = 'button';
      attachBtn.className = 'mini-btn';
      attachBtn.textContent = l.attachedTokenId !== null ? 'Detach' : 'Attach';
      attachBtn.addEventListener('click', () => {
        if (l.attachedTokenId !== null) {
          const parent = tokens.find((t) => t.id === l.attachedTokenId);
          if (parent) {
            l.x = parent.x;
            l.y = parent.y;
          }
          l.attachedTokenId = null;
        } else if (runtime.selectedTokenId !== null) {
          l.attachedTokenId = runtime.selectedTokenId;
        }
        sendSyncAction({ action: 'lights:sync', lights });
        syncUI();
        draw();
      });

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'btn-danger-x';
      delBtn.textContent = 'X';
      delBtn.addEventListener('click', () => {
        const idx = lights.indexOf(l);
        if (idx !== -1) lights.splice(idx, 1);
        if (runtime.selectedLightId === l.id) runtime.selectedLightId = null;
        sendSyncAction({ action: 'lights:sync', lights });
        syncUI();
        draw();
      });

      actions.append(toggleBtn, attachBtn, delBtn);
      item.append(info, actions);
      listEl.appendChild(item);
    }
  }

  syncUI();
  return { syncUI };
}

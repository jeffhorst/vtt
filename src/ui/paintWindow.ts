import { clearPaintCanvas } from '../paint/paintEngine';
import { paintState, runtime } from '../state';
import type { PaintToolMode } from '../types';

export const PAINT_PALETTE = [
  '#000000', '#7f7f7f', '#ffffff', '#ef4444', '#f97316', '#facc15', '#22c55e', '#06b6d4',
  '#3b82f6', '#6366f1', '#a855f7', '#ec4899', '#880015', '#b97a57', '#166534', '#1e3a8a',
];

const PAINT_TOOLS: Array<{ id: PaintToolMode; label: string; title: string }> = [
  { id: 'brush', label: 'Brush', title: 'Brush' },
  { id: 'text', label: 'Text', title: 'Text Tool' },
  { id: 'line', label: 'Line', title: 'Line (Shift: 45° snap)' },
  { id: 'rect', label: 'Rect', title: 'Rectangle (Shift: Square)' },
  { id: 'ellipse', label: 'Oval', title: 'Ellipse / Circle (Shift: Circle)' },
];

export interface PaintPanelController {
  syncUI: () => void;
}

export function populatePaintPanel(
  body: HTMLElement,
  onActivatePaintTool: () => void
): PaintPanelController {
  // Restore saved Paint tool/color/stroke preferences
  try {
    const raw = localStorage.getItem('vtt-paint-state');
    if (raw) {
      const saved = JSON.parse(raw) as Partial<typeof paintState>;
      if (saved.tool && PAINT_TOOLS.some((t) => t.id === saved.tool)) {
        paintState.tool = saved.tool;
      }
      if (saved.primaryColor) paintState.primaryColor = saved.primaryColor;
      if (saved.secondaryColor) paintState.secondaryColor = saved.secondaryColor;
      if (typeof saved.size === 'number') paintState.size = saved.size;
      if (typeof saved.fontSize === 'number') paintState.fontSize = saved.fontSize;
    }
  } catch {
    // Ignore storage errors
  }
  paintState.opacity = 1;
  paintState.fillMode = 'outline';

  function persistPaintState(): void {
    try {
      localStorage.setItem('vtt-paint-state', JSON.stringify(paintState));
    } catch {
      // Ignore storage errors
    }
  }

  body.textContent = '';

  const toolButtons = new Map<PaintToolMode, HTMLButtonElement>();

  // Tools grid (3 across): Brush, Text, Line, Rect, Oval, Clear All
  const toolsGrid = document.createElement('div');
  toolsGrid.className = 'paint-tools-grid';
  for (const t of PAINT_TOOLS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mini-btn paint-tool-btn';
    btn.textContent = t.label;
    btn.title = t.title;
    btn.addEventListener('click', () => {
      paintState.tool = t.id;
      onActivatePaintTool();
      syncUI();
    });
    toolButtons.set(t.id, btn);
    toolsGrid.appendChild(btn);
  }

  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'mini-btn paint-tool-btn';
  clearBtn.textContent = 'Clear All';
  clearBtn.addEventListener('click', clearPaintCanvas);
  toolsGrid.appendChild(clearBtn);

  // Size & Font sliders on the same row
  const controlsBox = document.createElement('div');
  controlsBox.className = 'paint-controls paint-sliders-row';

  const sizeCol = document.createElement('div');
  sizeCol.className = 'paint-slider-col';
  const sizeRow = document.createElement('div');
  sizeRow.className = 'panel-row';
  const sizeLabel = document.createElement('span');
  sizeLabel.className = 'panel-label';
  sizeLabel.textContent = 'Size';
  const sizeVal = document.createElement('span');
  const sizeSlider = document.createElement('input');
  sizeSlider.type = 'range';
  sizeSlider.min = '1';
  sizeSlider.max = '64';
  sizeSlider.value = String(paintState.size);
  sizeSlider.className = 'paint-slider';
  sizeSlider.addEventListener('input', () => {
    paintState.size = Number(sizeSlider.value);
    syncUI();
  });
  sizeRow.append(sizeLabel, sizeVal);
  sizeCol.append(sizeRow, sizeSlider);

  const fontCol = document.createElement('div');
  fontCol.className = 'paint-slider-col';
  const fontRow = document.createElement('div');
  fontRow.className = 'panel-row';
  const fontLabel = document.createElement('span');
  fontLabel.className = 'panel-label';
  fontLabel.textContent = 'Font';
  const fontVal = document.createElement('span');
  const fontSlider = document.createElement('input');
  fontSlider.type = 'range';
  fontSlider.min = '8';
  fontSlider.max = '144';
  fontSlider.value = String(paintState.fontSize);
  fontSlider.className = 'paint-slider';
  fontSlider.addEventListener('input', () => {
    paintState.fontSize = Number(fontSlider.value);
    syncUI();
  });
  fontRow.append(fontLabel, fontVal);
  fontCol.append(fontRow, fontSlider);

  controlsBox.append(sizeCol, fontCol);

  // Colors: 16-color Palette with active highlight
  const colorBox = document.createElement('div');
  colorBox.className = 'paint-colors-box';

  const swatchButtons = new Map<string, HTMLButtonElement>();
  const paletteGrid = document.createElement('div');
  paletteGrid.className = 'paint-palette-grid';
  for (const hex of PAINT_PALETTE) {
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'paint-swatch';
    swatch.style.background = hex;
    swatch.addEventListener('click', () => {
      paintState.primaryColor = hex;
      const isShapeOrText =
        runtime.activeTool === 'paint' &&
        (paintState.tool === 'text' ||
          paintState.tool === 'line' ||
          paintState.tool === 'rect' ||
          paintState.tool === 'ellipse');
      if (!isShapeOrText) {
        paintState.tool = 'brush';
        onActivatePaintTool();
      }
      syncUI();
    });
    swatch.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      paintState.secondaryColor = hex;
      syncUI();
    });
    swatchButtons.set(hex.toLowerCase(), swatch);
    paletteGrid.appendChild(swatch);
  }

  colorBox.append(paletteGrid);

  body.append(
    toolsGrid,
    controlsBox,
    colorBox
  );

  function syncUI(): void {
    const isPaintActive = runtime.activeTool === 'paint';
    for (const [id, btn] of toolButtons) {
      btn.classList.toggle('active', isPaintActive && paintState.tool === id);
    }
    const activeHex = paintState.primaryColor.toLowerCase();
    for (const [hex, swatch] of swatchButtons) {
      swatch.classList.toggle('active', hex === activeHex);
    }
    sizeVal.textContent = `${paintState.size} px`;
    sizeSlider.value = String(paintState.size);
    fontVal.textContent = `${paintState.fontSize} px`;
    fontSlider.value = String(paintState.fontSize);
    persistPaintState();
  }

  syncUI();
  return { syncUI };
}

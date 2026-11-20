import type {
  AccordionSection,
  FloatingWindowInstance,
  FloatingWindowOptions,
  FloatingWindowState,
} from '../types';

let nextFloatingZ = 30;

export function getNextFloatingZ(): number {
  return ++nextFloatingZ;
}

function snapCardinalAngle(deg: number): number {
  const norm = ((deg % 360) + 360) % 360;
  for (const target of [0, 90, 180, 270, 360]) {
    if (Math.abs(norm - target) <= 6) return target % 360;
  }
  return Math.round(norm);
}

interface DragState {
  startX: number;
  startY: number;
  origX: number;
  origY: number;
}

interface RotateState {
  cx: number;
  cy: number;
  startAngle: number;
  origRotation: number;
  startX: number;
  startY: number;
  didDrag: boolean;
}

interface ResizeState {
  corner: string;
  startX: number;
  startY: number;
  origX: number;
  origY: number;
  origW: number;
  origH: number;
}

export function createFloatingWindow({
  title = 'Menu',
  x = 80,
  y = 80,
  w = 340,
  h = 260,
  tabs = [],
  rotatable = true,
  collapsible = true,
  closable = false,
  defaultCollapsed = true,
  storageKey,
  onClose,
  resizable = true,
}: FloatingWindowOptions = {}): FloatingWindowInstance {
  const lsKey = storageKey ? `vtt-win:${storageKey}` : null;
  let saved: Partial<FloatingWindowState> | null = null;
  if (lsKey) {
    try {
      const raw = localStorage.getItem(lsKey);
      if (raw) saved = JSON.parse(raw) as Partial<FloatingWindowState>;
    } catch {
      saved = null;
    }
  }

  const state: FloatingWindowState = {
    x:
      typeof saved?.x === 'number'
        ? Math.max(8, Math.min(window.innerWidth - 120, saved.x))
        : x,
    y:
      typeof saved?.y === 'number'
        ? Math.max(8, Math.min(window.innerHeight - 48, saved.y))
        : y,
    w: typeof saved?.w === 'number' ? saved.w : w,
    h:
      saved?.h === 'auto' || typeof saved?.h === 'number' ? saved.h : h,
    rotation: typeof saved?.rotation === 'number' ? saved.rotation : 0,
    collapsed:
      typeof saved?.collapsed === 'boolean'
        ? saved.collapsed
        : defaultCollapsed,
    activeTab:
      saved?.activeTab && tabs.includes(saved.activeTab)
        ? saved.activeTab
        : tabs[0] ?? null,
    open: typeof saved?.open === 'boolean' ? saved.open : true,
  };

  function persistState(): void {
    if (!lsKey) return;
    try {
      localStorage.setItem(lsKey, JSON.stringify(state));
    } catch {
      // Ignore storage quota errors
    }
  }

  const win = document.createElement('section');
  win.className = 'floating-win';
  win.style.zIndex = String(getNextFloatingZ());

  const header = document.createElement('div');
  header.className = 'floating-win-header';

  const titleEl = document.createElement('span');
  titleEl.className = 'floating-win-title';
  titleEl.textContent = `⠿ ${title}`;

  const actions = document.createElement('div');
  actions.className = 'floating-win-actions';

  const rotateBtn = document.createElement('button');
  rotateBtn.type = 'button';
  rotateBtn.className = 'floating-win-btn';
  rotateBtn.title = 'Tap: +90° | Double-tap: 0° | Drag: Rotate';
  rotateBtn.textContent = '↻';

  const collapseBtn = document.createElement('button');
  collapseBtn.type = 'button';
  collapseBtn.className = 'floating-win-btn';
  collapseBtn.title = 'Collapse / Expand';
  collapseBtn.textContent = '▲';

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'floating-win-btn';
  closeBtn.title = 'Close';
  closeBtn.textContent = '✕';

  if (rotatable) actions.append(rotateBtn);
  if (collapsible) actions.append(collapseBtn);
  if (closable) actions.append(closeBtn);
  header.append(titleEl, actions);

  const body = document.createElement('div');
  body.className = 'floating-win-body';

  win.append(header);

  const tabButtons = new Map<string, HTMLButtonElement>();
  const tabPanes: Record<string, HTMLDivElement> = {};
  if (tabs.length > 0) {
    const tabBar = document.createElement('div');
    tabBar.className = 'floating-win-tabs';
    for (const tabName of tabs) {
      const tabBtn = document.createElement('button');
      tabBtn.type = 'button';
      tabBtn.className = 'floating-win-tab';
      tabBtn.textContent = tabName;
      tabBtn.addEventListener('click', () => {
        state.activeTab = tabName;
        renderTabs();
        persistState();
      });
      tabButtons.set(tabName, tabBtn);
      tabBar.appendChild(tabBtn);

      const pane = document.createElement('div');
      pane.textContent = tabName;
      tabPanes[tabName] = pane;
      body.appendChild(pane);
    }
    win.append(tabBar);
  }

  function renderTabs(): void {
    for (const [name, btn] of tabButtons) {
      btn.classList.toggle('active', name === state.activeTab);
      tabPanes[name].style.display = name === state.activeTab ? 'block' : 'none';
    }
  }

  win.append(body);
  renderTabs();

  if (resizable) {
    const edges =
      resizable === 'horizontal' ? ['w', 'e'] : ['nw', 'ne', 'sw', 'se'];
    for (const corner of edges) {
      const handle = document.createElement('div');
      handle.className = 'floating-win-resize';
      handle.dataset.corner = corner;
      if (corner === 'se') handle.textContent = '◢';
      win.appendChild(handle);
    }
  }

  function render(): void {
    win.style.left = `${state.x}px`;
    win.style.top = `${state.y}px`;
    win.style.width = `${state.w}px`;
    win.style.height =
      state.collapsed || state.h === 'auto' ? 'auto' : `${state.h}px`;
    win.style.transform = state.rotation ? `rotate(${state.rotation}deg)` : '';
    win.classList.toggle('collapsed', state.collapsed);
    collapseBtn.textContent = state.collapsed ? '▼' : '▲';
  }

  function setOpen(open: boolean): void {
    state.open = open;
    win.style.display = open ? 'flex' : 'none';
    if (open) {
      win.style.zIndex = String(getNextFloatingZ());
    }
    persistState();
  }

  win.addEventListener(
    'pointerdown',
    () => {
      if (Number(win.style.zIndex) < nextFloatingZ) {
        win.style.zIndex = String(getNextFloatingZ());
      }
    },
    true
  );

  // Move
  let dragState: DragState | null = null;
  header.addEventListener('pointerdown', (e: PointerEvent) => {
    const target = e.target as HTMLElement | null;
    if (target?.closest('button')) return;
    header.setPointerCapture(e.pointerId);
    dragState = {
      startX: e.clientX,
      startY: e.clientY,
      origX: state.x,
      origY: state.y,
    };
  });
  header.addEventListener('pointermove', (e: PointerEvent) => {
    if (!dragState) return;
    state.x = Math.max(
      8,
      Math.min(
        window.innerWidth - 120,
        dragState.origX + (e.clientX - dragState.startX)
      )
    );
    state.y = Math.max(
      8,
      Math.min(
        window.innerHeight - 48,
        dragState.origY + (e.clientY - dragState.startY)
      )
    );
    render();
  });
  const endMove = () => {
    if (dragState) {
      dragState = null;
      persistState();
    }
  };
  header.addEventListener('pointerup', endMove);
  header.addEventListener('pointercancel', endMove);

  // Rotate (drag to free-rotate, tap for +90°, double-tap for 0°)
  let rotateState: RotateState | null = null;
  let suppressRotateClick = false;
  let rotateClickTimer: ReturnType<typeof setTimeout> | undefined;

  rotateBtn.addEventListener('pointerdown', (e: PointerEvent) => {
    e.stopPropagation();
    const rect = win.getBoundingClientRect();
    rotateBtn.setPointerCapture(e.pointerId);
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    rotateState = {
      cx,
      cy,
      startAngle: Math.atan2(e.clientY - cy, e.clientX - cx) * (180 / Math.PI),
      origRotation: state.rotation,
      startX: e.clientX,
      startY: e.clientY,
      didDrag: false,
    };
    suppressRotateClick = false;
  });
  rotateBtn.addEventListener('pointermove', (e: PointerEvent) => {
    if (!rotateState) return;
    if (!rotateState.didDrag) {
      if (
        Math.hypot(
          e.clientX - rotateState.startX,
          e.clientY - rotateState.startY
        ) <= 4
      ) {
        return;
      }
      rotateState.didDrag = true;
      suppressRotateClick = true;
    }
    const curAngle =
      Math.atan2(e.clientY - rotateState.cy, e.clientX - rotateState.cx) *
      (180 / Math.PI);
    state.rotation = snapCardinalAngle(
      rotateState.origRotation + (curAngle - rotateState.startAngle)
    );
    render();
  });
  const endRotate = () => {
    if (rotateState) {
      rotateState = null;
      persistState();
    }
  };
  rotateBtn.addEventListener('pointerup', endRotate);
  rotateBtn.addEventListener('pointercancel', endRotate);
  rotateBtn.addEventListener('click', (e: MouseEvent) => {
    if (suppressRotateClick) {
      suppressRotateClick = false;
      return;
    }
    if (e.detail >= 2) {
      clearTimeout(rotateClickTimer);
      rotateClickTimer = undefined;
      state.rotation = 0;
      render();
      persistState();
      return;
    }
    clearTimeout(rotateClickTimer);
    rotateClickTimer = setTimeout(() => {
      rotateClickTimer = undefined;
      state.rotation = (state.rotation + 90) % 360;
      render();
      persistState();
    }, 220);
  });

  // Collapse to header
  collapseBtn.addEventListener('click', (e: MouseEvent) => {
    e.stopPropagation();
    state.collapsed = !state.collapsed;
    render();
    persistState();
  });

  // Close window
  closeBtn.addEventListener('click', (e: MouseEvent) => {
    e.stopPropagation();
    setOpen(false);
    onClose?.();
  });

  // Resize from corners / edges
  let resizeState: ResizeState | null = null;
  win
    .querySelectorAll<HTMLDivElement>('.floating-win-resize')
    .forEach((handle) => {
      const corner = handle.dataset.corner ?? '';
      handle.addEventListener('pointerdown', (e: PointerEvent) => {
        e.stopPropagation();
        handle.setPointerCapture(e.pointerId);
        resizeState = {
          corner,
          startX: e.clientX,
          startY: e.clientY,
          origX: state.x,
          origY: state.y,
          origW: state.w,
          origH:
            typeof state.h === 'number'
              ? state.h
              : win.getBoundingClientRect().height,
        };
      });
      handle.addEventListener('pointermove', (e: PointerEvent) => {
        if (!resizeState) return;
        const dx = e.clientX - resizeState.startX;
        const dy = e.clientY - resizeState.startY;
        const minW = resizable === 'horizontal' ? 120 : 160;
        const maxW = window.innerWidth - 40;
        const minH = 100;
        const maxH = window.innerHeight - 40;

        let nextX = resizeState.origX;
        let nextY = resizeState.origY;
        let nextW = resizeState.origW;
        let nextH = resizeState.origH;

        if (corner.includes('e')) {
          nextW = Math.max(minW, Math.min(maxW, resizeState.origW + dx));
        } else if (corner.includes('w')) {
          const clampedW = Math.max(
            minW,
            Math.min(maxW, resizeState.origW - dx)
          );
          nextX = Math.max(
            8,
            resizeState.origX + (resizeState.origW - clampedW)
          );
          nextW = resizeState.origX + resizeState.origW - nextX;
        }

        if (corner.includes('s')) {
          nextH = Math.max(minH, Math.min(maxH, resizeState.origH + dy));
        } else if (corner.includes('n')) {
          const clampedH = Math.max(
            minH,
            Math.min(maxH, resizeState.origH - dy)
          );
          nextY = Math.max(
            8,
            resizeState.origY + (resizeState.origH - clampedH)
          );
          nextH = resizeState.origY + resizeState.origH - nextY;
        }

        state.x = nextX;
        state.y = nextY;
        state.w = nextW;
        if (state.h !== 'auto') {
          state.h = nextH;
        }
        render();
      });
      const endResize = () => {
        if (resizeState) {
          resizeState = null;
          persistState();
        }
      };
      handle.addEventListener('pointerup', endResize);
      handle.addEventListener('pointercancel', endResize);
    });

  function setTabVisible(tabName: string, visible: boolean): void {
    const btn = tabButtons.get(tabName);
    if (btn) btn.style.display = visible ? '' : 'none';
    if (!visible && state.activeTab === tabName) {
      const fallback = tabs.find((t) => {
        const b = tabButtons.get(t);
        return b && b.style.display !== 'none';
      });
      if (fallback) {
        state.activeTab = fallback;
        renderTabs();
        persistState();
      }
    }
  }

  render();
  document.body.appendChild(win);
  return { win, body, tabPanes, state, render, setOpen, setTabVisible };
}

export function createAccordionSection(
  parent: HTMLElement,
  title: string,
  initiallyOpen = true,
  storageKey?: string,
  popoutConfig?: {
    enabled?: boolean;
    w?: number;
    h?: number | 'auto';
  }
): AccordionSection {
  const slug =
    storageKey ?? title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const lsKey = `vtt-acc:${slug}`;
  const popoutLsKey = `vtt-popout:${slug}`;

  let isOpen = initiallyOpen;
  try {
    const raw = localStorage.getItem(lsKey);
    if (raw === 'true' || raw === 'false') {
      isOpen = raw === 'true';
    }
  } catch {
    // Ignore storage errors
  }

  const section = document.createElement('div');
  section.className = 'accordion-section';

  const headerEl = document.createElement('div');
  headerEl.className = 'accordion-header';
  headerEl.setAttribute('role', 'button');
  headerEl.tabIndex = 0;

  const titleSpan = document.createElement('span');
  titleSpan.textContent = title;
  headerEl.appendChild(titleSpan);

  const body = document.createElement('div');
  body.className = 'accordion-body';

  function render(): void {
    section.classList.toggle('collapsed', !isOpen);
  }

  function toggleAccordion(): void {
    isOpen = !isOpen;
    try {
      localStorage.setItem(lsKey, String(isOpen));
    } catch {
      // Ignore storage errors
    }
    render();
  }

  headerEl.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null;
    if (target?.closest('.accordion-popout-btn')) return;
    toggleAccordion();
  });
  headerEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleAccordion();
    }
  });

  if (popoutConfig?.enabled) {
    const popBtn = document.createElement('button');
    popBtn.type = 'button';
    popBtn.className = 'accordion-popout-btn';
    popBtn.title = `Pop out ${title}`;
    popBtn.textContent = '↗';
    headerEl.appendChild(popBtn);

    let poppedWin: FloatingWindowInstance | null = null;

    const dockBack = () => {
      try {
        localStorage.setItem(popoutLsKey, 'false');
      } catch {
        // Ignore
      }
      section.appendChild(body);
      section.style.display = '';
      if (poppedWin) {
        poppedWin.win.remove();
        poppedWin = null;
      }
    };

    const popOut = () => {
      if (poppedWin) {
        poppedWin.setOpen(true);
        return;
      }
      try {
        localStorage.setItem(popoutLsKey, 'true');
      } catch {
        // Ignore
      }
      const rect = section.getBoundingClientRect();
      poppedWin = createFloatingWindow({
        title,
        x: Math.max(16, Math.min(window.innerWidth - 320, (rect.left || 120) + 24)),
        y: Math.max(16, Math.min(window.innerHeight - 200, (rect.top || 100) + 16)),
        w: popoutConfig.w ?? 290,
        h: popoutConfig.h ?? 'auto',
        rotatable: true,
        collapsible: true,
        closable: true,
        defaultCollapsed: false,
        storageKey: `popout-${slug}`,
        onClose: dockBack,
      });
      poppedWin.body.textContent = '';
      poppedWin.body.appendChild(body);
      poppedWin.setOpen(true);
      section.style.display = 'none';
    };

    popBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      popOut();
    });

    try {
      if (localStorage.getItem(popoutLsKey) === 'true') {
        queueMicrotask(() => popOut());
      }
    } catch {
      // Ignore
    }
  }

  render();
  section.append(headerEl, body);
  parent.appendChild(section);
  return { section, body };
}

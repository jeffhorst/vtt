import { api } from '../api';
import type { CampaignSummary, User, UserRole } from '../types';
import { PAINT_PALETTE } from './paintWindow';
import { applyThemeColor, getSavedThemeColor } from './theme';

export interface LobbyViewController {
  show: (user: User) => Promise<void>;
  hide: () => void;
}

function createDangerXButton(): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn-danger-x';
  btn.textContent = 'X';
  return btn;
}

function createLobbyAccordion(
  titleText: string,
  initiallyOpen: boolean
): {
  card: HTMLElement;
  body: HTMLDivElement;
  setOpen: (open: boolean) => void;
} {
  const card = document.createElement('section');
  card.className = 'page-card';
  let isOpen = initiallyOpen;

  const headerBtn = document.createElement('button');
  headerBtn.type = 'button';
  headerBtn.className = 'lobby-accordion-header';
  headerBtn.textContent = titleText;

  const body = document.createElement('div');
  body.className = 'page-card-body';

  function render(): void {
    card.classList.toggle('collapsed', !isOpen);
  }

  headerBtn.addEventListener('click', () => {
    isOpen = !isOpen;
    render();
  });

  render();
  card.append(headerBtn, body);

  return {
    card,
    body,
    setOpen: (open: boolean) => {
      isOpen = open;
      render();
    },
  };
}

export function createLobbyView(callbacks: {
  onEnterCampaign: (campaignId: number, role: UserRole) => Promise<void>;
  onLogout: () => void;
}): LobbyViewController {
  const overlay = document.createElement('div');
  overlay.className = 'page-overlay';
  overlay.style.display = 'none';

  const shell = document.createElement('div');
  shell.className = 'lobby-shell';

  // Top Bar
  const topBar = document.createElement('div');
  topBar.className = 'page-card';

  const topHeader = document.createElement('div');
  topHeader.className = 'page-card-header';

  const userLeft = document.createElement('div');
  userLeft.style.display = 'flex';
  userLeft.style.alignItems = 'center';
  userLeft.style.gap = '10px';

  const userTitle = document.createElement('span');
  userTitle.className = 'page-card-title';

  let selectedThemeColor = getSavedThemeColor();
  const colorBtn = document.createElement('button');
  colorBtn.type = 'button';
  colorBtn.className = 'paint-swatch';
  colorBtn.style.width = '26px';
  colorBtn.style.height = '26px';
  colorBtn.style.flexShrink = '0';
  colorBtn.style.background = selectedThemeColor;
  colorBtn.title = 'Choose UI theme color';

  userLeft.append(userTitle, colorBtn);

  const logoutBtn = document.createElement('button');
  logoutBtn.type = 'button';
  logoutBtn.className = 'vtt-bar-btn';
  logoutBtn.textContent = 'Sign Out';

  const paletteBox = document.createElement('div');
  paletteBox.className = 'paint-colors-box';
  paletteBox.style.margin = '10px 14px';
  paletteBox.style.display = 'none';
  const paletteGrid = document.createElement('div');
  paletteGrid.className = 'paint-palette-grid';
  const swatchBtns = new Map<string, HTMLButtonElement>();

  function syncThemePaletteUI(): void {
    const activeHex = selectedThemeColor.toLowerCase();
    colorBtn.style.background = selectedThemeColor;
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
      selectedThemeColor = hex;
      applyThemeColor(hex, currentUser?.id);
      paletteBox.style.display = 'none';
      syncThemePaletteUI();
    });
    swatchBtns.set(hex.toLowerCase(), sw);
    paletteGrid.appendChild(sw);
  }
  paletteBox.appendChild(paletteGrid);
  syncThemePaletteUI();

  colorBtn.addEventListener('click', () => {
    paletteBox.style.display =
      paletteBox.style.display === 'none' ? 'flex' : 'none';
  });

  topHeader.append(userLeft, logoutBtn);
  topBar.append(topHeader, paletteBox);

  // 1. Merged Campaigns Accordion (default expanded)
  const campaignsAcc = createLobbyAccordion('Campaigns', true);

  // 2. Admin Specific: User Management Accordion (default collapsed)
  const userMgmtAcc = createLobbyAccordion('User Management', false);

  shell.append(topBar, campaignsAcc.card, userMgmtAcc.card);
  overlay.appendChild(shell);
  document.body.appendChild(overlay);

  let currentUser: User | null = null;

  logoutBtn.addEventListener('click', async () => {
    await api.logout().catch(() => {});
    currentUser = null;
    callbacks.onLogout();
  });

  async function renderCampaigns(
    campaigns: CampaignSummary[],
    canCreate: boolean
  ): Promise<void> {
    const body = campaignsAcc.body;
    body.textContent = '';

    // Create Campaign: just Name + Create
    if (canCreate) {
      const createForm = document.createElement('form');
      createForm.className = 'lobby-inline-form';

      const nameGroup = document.createElement('div');
      nameGroup.className = 'field-group';
      const nameLabel = document.createElement('label');
      nameLabel.className = 'field-label';
      nameLabel.htmlFor = 'new-campaign-name';
      nameLabel.textContent = 'New Campaign';
      const nameInput = document.createElement('input');
      nameInput.id = 'new-campaign-name';
      nameInput.type = 'text';
      nameInput.className = 'vtt-input';
      nameGroup.append(nameLabel, nameInput);

      const createBtn = document.createElement('button');
      createBtn.type = 'submit';
      createBtn.className = 'mini-btn';
      createBtn.textContent = 'Create';

      createForm.append(nameGroup, createBtn);
      createForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = nameInput.value.trim();
        if (!name) return;
        nameInput.value = '';
        await api.createCampaign(name);
        await refreshLobby();
      });
      body.appendChild(createForm);

      const divider = document.createElement('hr');
      divider.className = 'lobby-divider';
      body.appendChild(divider);

      const sectionLabel = document.createElement('div');
      sectionLabel.className = 'lobby-section-label';
      sectionLabel.textContent = 'Campaigns';
      body.appendChild(sectionLabel);
    }

    const listEl = document.createElement('div');
    listEl.className = 'vtt-list';

    if (campaigns.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'vtt-status-text';
      empty.textContent = 'No campaigns assigned.';
      listEl.appendChild(empty);
      body.appendChild(listEl);
      return;
    }

    for (const c of campaigns) {
      const card = document.createElement('div');
      card.className = 'lobby-subcard';

      const topRow = document.createElement('div');
      topRow.className = 'panel-row';

      if (c.myRole === 'gm') {
        const renameInput = document.createElement('input');
        renameInput.type = 'text';
        renameInput.className = 'vtt-input';
        renameInput.style.flex = '1';
        renameInput.style.minWidth = '110px';
        renameInput.value = c.name;

        const saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.className = 'mini-btn';
        saveBtn.textContent = 'Save';
        saveBtn.addEventListener('click', async () => {
          const nextName = renameInput.value.trim();
          if (!nextName) return;
          await api.renameCampaign(c.id, nextName);
          await refreshLobby();
        });

        const roleBadge = document.createElement('span');
        roleBadge.className = 'vtt-badge';
        roleBadge.textContent = c.myRole;

        const enterBtn = document.createElement('button');
        enterBtn.type = 'button';
        enterBtn.className = 'vtt-bar-btn';
        enterBtn.textContent = 'Enter';
        enterBtn.addEventListener('click', async () => {
          enterBtn.disabled = true;
          try {
            const res = await api.enterCampaign(c.id);
            await callbacks.onEnterCampaign(res.campaignId, res.role);
          } finally {
            enterBtn.disabled = false;
          }
        });

        const delBtn = createDangerXButton();
        delBtn.addEventListener('click', async () => {
          await api.deleteCampaign(c.id);
          await refreshLobby();
        });

        topRow.append(renameInput, saveBtn, roleBadge, enterBtn, delBtn);
        card.appendChild(topRow);

        if (c.members.length > 0) {
          const chips = document.createElement('div');
          chips.className = 'lobby-member-chips';
          for (const m of c.members) {
            const chip = document.createElement('div');
            chip.className = 'lobby-member-chip';

            const label = document.createElement('span');
            label.textContent = `${m.displayName} (${m.role})`;
            chip.appendChild(label);

            if (m.userId !== currentUser?.id) {
              const remBtn = createDangerXButton();
              remBtn.addEventListener('click', async () => {
                await api.removeCampaignMember(c.id, m.userId);
                await refreshLobby();
              });
              chip.appendChild(remBtn);
            }
            chips.appendChild(chip);
          }
          card.appendChild(chips);
        }
      } else {
        const nameSpan = document.createElement('span');
        nameSpan.textContent = c.name;

        const right = document.createElement('div');
        right.className = 'panel-row';

        const roleBadge = document.createElement('span');
        roleBadge.className = 'vtt-badge';
        roleBadge.textContent = c.myRole;

        const enterBtn = document.createElement('button');
        enterBtn.type = 'button';
        enterBtn.className = 'vtt-bar-btn';
        enterBtn.textContent = 'Enter';
        enterBtn.addEventListener('click', async () => {
          enterBtn.disabled = true;
          try {
            const res = await api.enterCampaign(c.id);
            await callbacks.onEnterCampaign(res.campaignId, res.role);
          } finally {
            enterBtn.disabled = false;
          }
        });

        right.append(roleBadge, enterBtn);
        topRow.append(nameSpan, right);
        card.appendChild(topRow);
      }

      listEl.appendChild(card);
    }

    body.appendChild(listEl);
  }

  async function renderUserManagement(): Promise<void> {
    const isAdmin = Boolean(currentUser?.isAdmin);
    userMgmtAcc.card.style.display = isAdmin ? 'flex' : 'none';
    if (!isAdmin) return;

    const body = userMgmtAcc.body;
    body.textContent = '';

    const createForm = document.createElement('form');
    createForm.className = 'lobby-subcard';

    const row1 = document.createElement('div');
    row1.className = 'panel-row';

    const uGroup = document.createElement('div');
    uGroup.className = 'field-group';
    const uLabel = document.createElement('label');
    uLabel.className = 'field-label';
    uLabel.htmlFor = 'admin-new-username';
    uLabel.textContent = 'Username';
    const uInput = document.createElement('input');
    uInput.id = 'admin-new-username';
    uInput.type = 'text';
    uInput.className = 'vtt-input';
    uGroup.append(uLabel, uInput);

    const dGroup = document.createElement('div');
    dGroup.className = 'field-group';
    const dLabel = document.createElement('label');
    dLabel.className = 'field-label';
    dLabel.htmlFor = 'admin-new-displayname';
    dLabel.textContent = 'Display Name';
    const dInput = document.createElement('input');
    dInput.id = 'admin-new-displayname';
    dInput.type = 'text';
    dInput.className = 'vtt-input';
    dGroup.append(dLabel, dInput);

    const pGroup = document.createElement('div');
    pGroup.className = 'field-group';
    const pLabel = document.createElement('label');
    pLabel.className = 'field-label';
    pLabel.htmlFor = 'admin-new-password';
    pLabel.textContent = 'Password';
    const pInput = document.createElement('input');
    pInput.id = 'admin-new-password';
    pInput.type = 'password';
    pInput.className = 'vtt-input';
    pGroup.append(pLabel, pInput);

    row1.append(uGroup, dGroup, pGroup);

    const optsRow = document.createElement('div');
    optsRow.className = 'panel-row';

    const roleSelect = document.createElement('select');
    roleSelect.className = 'vtt-select';
    roleSelect.style.width = '110px';
    roleSelect.innerHTML = `
      <option value="player">player</option>
      <option value="gm">gm</option>
    `;

    const adminCheckLabel = document.createElement('label');
    adminCheckLabel.className = 'panel-row';
    const adminCheck = document.createElement('input');
    adminCheck.type = 'checkbox';
    const adminCheckText = document.createElement('span');
    adminCheckText.className = 'panel-label';
    adminCheckText.textContent = 'Admin';
    adminCheckLabel.append(adminCheck, adminCheckText);

    const createBtn = document.createElement('button');
    createBtn.type = 'submit';
    createBtn.className = 'mini-btn';
    createBtn.textContent = 'Create User';

    optsRow.append(roleSelect, adminCheckLabel, createBtn);

    const errEl = document.createElement('div');
    errEl.className = 'vtt-status-text error';

    createForm.append(row1, optsRow, errEl);
    createForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      errEl.textContent = '';
      try {
        await api.createAdminUser({
          username: uInput.value,
          displayName: dInput.value,
          password: pInput.value,
          role: roleSelect.value as UserRole,
          isAdmin: adminCheck.checked,
        });
        uInput.value = '';
        dInput.value = '';
        pInput.value = '';
        adminCheck.checked = false;
        await refreshLobby();
      } catch (err) {
        errEl.textContent = (err as Error).message;
      }
    });

    body.appendChild(createForm);

    const userList = document.createElement('div');
    userList.className = 'vtt-list';

    try {
      const { users } = await api.listAdminUsers();
      for (const u of users) {
        const item = document.createElement('div');
        item.className = 'lobby-subcard';

        const topRow = document.createElement('div');
        topRow.className = 'panel-row';

        const info = document.createElement('span');
        const flags: string[] = [u.role];
        if (u.isAdmin) flags.push('admin');
        info.textContent = `${u.displayName} (${u.username}) [${flags.join(', ')}]`;
        topRow.appendChild(info);

        const actions = document.createElement('div');
        actions.className = 'panel-row';

        // Manual password reset for any user
        const resetInput = document.createElement('input');
        resetInput.type = 'password';
        resetInput.className = 'vtt-input';
        resetInput.style.width = '100px';

        const resetBtn = document.createElement('button');
        resetBtn.type = 'button';
        resetBtn.className = 'mini-btn';
        resetBtn.textContent = 'Reset PW';
        resetBtn.addEventListener('click', async () => {
          const nextPw = resetInput.value;
          if (nextPw.length < 3) return;
          resetInput.value = '';
          await api.updateAdminUser(u.id, { password: nextPw });
          resetBtn.textContent = 'Saved';
          setTimeout(() => {
            resetBtn.textContent = 'Reset PW';
          }, 1200);
        });

        actions.append(resetInput, resetBtn);

        if (u.id !== currentUser?.id) {
          const delBtn = createDangerXButton();
          delBtn.addEventListener('click', async () => {
            await api.deleteAdminUser(u.id);
            await refreshLobby();
          });
          actions.appendChild(delBtn);
        }

        topRow.appendChild(actions);
        item.appendChild(topRow);

        // List campaigns user is part of under user
        const assigned = u.campaigns ?? [];
        if (assigned.length > 0) {
          const campChips = document.createElement('div');
          campChips.className = 'lobby-member-chips';
          for (const uc of assigned) {
            const chip = document.createElement('div');
            chip.className = 'lobby-member-chip';

            const cText = document.createElement('span');
            cText.textContent = `${uc.campaignName} (${uc.role})`;
            chip.appendChild(cText);

            if (u.id !== currentUser?.id) {
              const remBtn = createDangerXButton();
              remBtn.addEventListener('click', async () => {
                await api.removeCampaignMember(uc.campaignId, u.id);
                await refreshLobby();
              });
              chip.appendChild(remBtn);
            }

            campChips.appendChild(chip);
          }
          item.appendChild(campChips);
        }

        userList.appendChild(item);
      }
    } catch {
      userList.textContent = 'Could not load users.';
    }

    body.appendChild(userList);
  }

  async function refreshLobby(): Promise<void> {
    if (!currentUser) return;
    userTitle.textContent = `${currentUser.displayName} (${currentUser.username})`;
    const { campaigns, canCreateCampaign } = await api.listCampaigns();
    await renderCampaigns(campaigns, canCreateCampaign);
    await renderUserManagement();
  }

  return {
    show: async (user: User) => {
      currentUser = user;
      selectedThemeColor = getSavedThemeColor(user.id);
      applyThemeColor(selectedThemeColor, user.id);
      paletteBox.style.display = 'none';
      syncThemePaletteUI();
      campaignsAcc.setOpen(true);
      userMgmtAcc.setOpen(false);
      overlay.style.display = 'flex';
      await refreshLobby();
    },
    hide: () => {
      overlay.style.display = 'none';
    },
  };
}

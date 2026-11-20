import { api } from '../api';
import type { User } from '../types';

export interface LoginViewController {
  show: () => void;
  hide: () => void;
}

export function createLoginView(
  onLoginSuccess: (user: User) => void
): LoginViewController {
  const overlay = document.createElement('div');
  overlay.className = 'page-overlay';
  overlay.style.display = 'none';

  const card = document.createElement('section');
  card.className = 'page-card login-card';

  const header = document.createElement('div');
  header.className = 'page-card-header';
  const heading = document.createElement('span');
  heading.className = 'page-card-title';
  heading.textContent = 'Sign In';
  header.appendChild(heading);

  const form = document.createElement('form');
  form.className = 'page-card-body';

  const userGroup = document.createElement('div');
  userGroup.className = 'field-group';
  const userLabel = document.createElement('label');
  userLabel.className = 'field-label';
  userLabel.htmlFor = 'login-username';
  userLabel.textContent = 'Username';
  const userInput = document.createElement('input');
  userInput.id = 'login-username';
  userInput.type = 'text';
  userInput.autocomplete = 'username';
  userInput.className = 'vtt-input';
  userGroup.append(userLabel, userInput);

  const passGroup = document.createElement('div');
  passGroup.className = 'field-group';
  const passLabel = document.createElement('label');
  passLabel.className = 'field-label';
  passLabel.htmlFor = 'login-password';
  passLabel.textContent = 'Password';
  const passInput = document.createElement('input');
  passInput.id = 'login-password';
  passInput.type = 'password';
  passInput.autocomplete = 'current-password';
  passInput.className = 'vtt-input';
  passGroup.append(passLabel, passInput);

  const errorEl = document.createElement('div');
  errorEl.className = 'vtt-status-text error';

  const submitBtn = document.createElement('button');
  submitBtn.type = 'submit';
  submitBtn.className = 'vtt-bar-btn page-primary-btn';
  submitBtn.textContent = 'Sign In';

  form.append(userGroup, passGroup, errorEl, submitBtn);
  card.append(header, form);
  overlay.appendChild(card);
  document.body.appendChild(overlay);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.textContent = '';
    submitBtn.disabled = true;
    try {
      const { user } = await api.login(userInput.value, passInput.value);
      passInput.value = '';
      onLoginSuccess(user);
    } catch (err) {
      errorEl.textContent = (err as Error).message;
    } finally {
      submitBtn.disabled = false;
    }
  });

  return {
    show: () => {
      errorEl.textContent = '';
      overlay.style.display = 'flex';
      userInput.focus();
    },
    hide: () => {
      overlay.style.display = 'none';
    },
  };
}

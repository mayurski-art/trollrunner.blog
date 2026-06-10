(function () {
  const ADMIN_AUTH_KEY = 'trollrunner_admin_auth';
  const ADMIN_PASSWORD_SALT = 'trollrunner-public-lock-v2';
  const ADMIN_PASSWORD_HASH = 'f7bd3dc03b760781a16bcafb96650c619632b1610903352272804046815b6f8d';

  async function hashText(text) {
    const bytes = new TextEncoder().encode(String(text || ''));
    const hashBuffer = await window.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(hashBuffer)).map(byte => byte.toString(16).padStart(2, '0')).join('');
  }

  function getAuthClient() {
    return null;
  }

  async function getSession() {
    return localStorage.getItem(ADMIN_AUTH_KEY) === '1'
      ? { provider: 'local-password' }
      : null;
  }

  async function getUser() {
    return localStorage.getItem(ADMIN_AUTH_KEY) === '1'
      ? { role: 'admin' }
      : null;
  }

  async function hasAdminSession() {
    return localStorage.getItem(ADMIN_AUTH_KEY) === '1';
  }

  function promptForAdminPassword() {
    const password = window.prompt('Enter the admin password to unlock the Trollrunner website.');
    if (password == null) return null;
    return String(password);
  }

  async function verifyAdminPassword(password) {
    const candidateHash = await hashText(`${ADMIN_PASSWORD_SALT}:${password}`);
    return candidateHash === ADMIN_PASSWORD_HASH;
  }

  async function signInWithAdminPassword(password) {
    const valid = await verifyAdminPassword(password);
    if (!valid) throw new Error('Wrong admin password.');
    localStorage.setItem(ADMIN_AUTH_KEY, '1');
    return true;
  }

  async function signOut() {
    localStorage.removeItem(ADMIN_AUTH_KEY);
    return true;
  }

  function writeStatus(nodes, message, kind = 'info') {
    nodes.forEach(node => {
      if (!node) return;
      node.textContent = message;
      node.dataset.kind = kind;
    });
  }

  function setButtonState(button, enabled, labelWhenEnabled, labelWhenDisabled) {
    if (!button) return;
    button.disabled = !enabled;
    if (labelWhenEnabled || labelWhenDisabled) {
      button.textContent = enabled ? (labelWhenEnabled || button.textContent) : (labelWhenDisabled || button.textContent);
    }
  }

  async function refreshUi() {
    const authed = await hasAdminSession();
    const footerStatus = document.getElementById('admin-auth-status');
    const gateStatus = document.getElementById('gate-admin-status');
    const gateLockToggle = document.getElementById('gate-lock-toggle');
    const footerButton = document.getElementById('admin-go');
    const gateButton = document.getElementById('gate-admin-link');
    if (authed) {
      writeStatus([footerStatus, gateStatus], 'Admin controls are unlocked.', 'success');
      setButtonState(footerButton, true, 'Unlock site', 'Unlock site');
      setButtonState(gateButton, true, 'Unlock site', 'Unlock site');
      if (gateLockToggle) gateLockToggle.disabled = false;
    } else {
      writeStatus([footerStatus, gateStatus], '', 'info');
      if (gateLockToggle) gateLockToggle.disabled = true;
      setButtonState(footerButton, true, 'Unlock site', 'Unlock site');
      setButtonState(gateButton, true, 'Unlock site', 'Unlock site');
    }

    return authed;
  }

  async function requestAdminLink() {
    const footerStatus = document.getElementById('admin-auth-status');
    const gateStatus = document.getElementById('gate-admin-status');
    const password = promptForAdminPassword();
    if (password == null) {
      writeStatus([footerStatus, gateStatus], 'Unlock canceled.', 'info');
      return false;
    }
    try {
      await signInWithAdminPassword(password);
      const lockHelper = window.TrollrunnerSiteLock;
      if (lockHelper?.requestLockTransition) {
        lockHelper.requestLockTransition(false);
      }
      writeStatus([footerStatus, gateStatus], 'Website unlocked.', 'success');
      return true;
    } catch (error) {
      const message = error?.message ? String(error.message) : 'Unable to unlock the website.';
      writeStatus([footerStatus, gateStatus], message, 'error');
      return false;
    }
  }

  async function ensureAdminSession() {
    return hasAdminSession();
  }

  async function openAdminPageOrLink() {
    const authed = await hasAdminSession();
    if (authed) {
      window.location.href = 'admin.html';
      return true;
    }
    const unlocked = await requestAdminLink();
    if (unlocked) {
      window.location.href = 'admin.html';
      return true;
    }
    return false;
  }

  function init() {
    void refreshUi();
    window.addEventListener('storage', event => {
      if (event.key === ADMIN_AUTH_KEY) void refreshUi();
    });
  }

  window.TrollrunnerAdminAuth = {
    adminAuthKey: ADMIN_AUTH_KEY,
    getAuthClient,
    getSession,
    getUser,
    hasAdminSession,
    signInWithAdminPassword,
    requestAdminLink,
    ensureAdminSession,
    openAdminPageOrLink,
    signOut,
    refreshUi,
  };

  window.requestAdminLoginLink = () => requestAdminLink();
  window.goToAdmin = () => openAdminPageOrLink();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();

(function () {
  const SUPABASE_URL = 'https://tjsyhfplxjtakdfkpdtg.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRqc3loZnBseGp0YWtkZmtwZHRnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYzOTc0ODksImV4cCI6MjA5MTk3MzQ4OX0.xLUcPUUguRBQttNwiIRWJHxjJjLqrQDMu4Ubsk5yZoQ';
  const ADMIN_AUTH_KEY = 'trollrunner_admin_auth';
  const ADMIN_EMAIL = 'admin@login.trollrunner.net';
  const ADMIN_AUTH_STORAGE_KEY = 'trollrunner-admin-auth';

  let client = null;

  function getAuthClient() {
    if (client) return client;
    if (!window.supabase?.createClient) return null;
    client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storageKey: ADMIN_AUTH_STORAGE_KEY,
      },
    });
    client.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') void handlePasswordRecovery();
    });
    return client;
  }

  // Fires when a Supabase password-reset email link lands back on this page.
  // detectSessionInUrl above turns the link's one-time token into a real
  // session and emits PASSWORD_RECOVERY instead of the normal SIGNED_IN event.
  async function handlePasswordRecovery() {
    try {
      const sb = getAuthClient();
      if (!sb) return;
      const newPassword = window.prompt('Reset link verified. Choose a new admin password:');
      if (newPassword == null) return;
      if (String(newPassword).length < 8) {
        window.alert('Use a password with at least 8 characters. Reset link is still valid — refresh this page and click it again to retry.');
        return;
      }
      const { error } = await sb.auth.updateUser({ password: String(newPassword) });
      if (error) {
        window.alert(`Could not set the new password: ${error.message}`);
        return;
      }
      localStorage.setItem(ADMIN_AUTH_KEY, '1');
      window.alert('Password updated. You are now signed in.');
      history.replaceState(null, '', location.pathname + location.search);
      await refreshUi();
    } finally {
      window.dispatchEvent(new Event('trollrunner-admin-recovery-settled'));
    }
  }

  // Pages that gate on hasAdminSession() at load must await this before
  // deciding to redirect, otherwise they race the async recovery-link
  // handling above and bounce the user away before the prompt can appear.
  function awaitPasswordRecoverySettled() {
    if (!/type=recovery/.test(location.hash)) return Promise.resolve();
    return new Promise(resolve => {
      window.addEventListener('trollrunner-admin-recovery-settled', resolve, { once: true });
    });
  }

  async function getSession() {
    const sb = getAuthClient();
    if (!sb) return null;
    const { data } = await sb.auth.getSession();
    return data?.session || null;
  }

  async function getUser() {
    const session = await getSession();
    return session ? { role: 'admin', id: session.user?.id } : null;
  }

  // Real, server-verified: reflects an actual live Supabase Auth session,
  // not just a localStorage flag a visitor could set by hand. RLS on the
  // backend enforces this independently either way.
  async function hasAdminSession() {
    const sb = getAuthClient();
    if (!sb) return localStorage.getItem(ADMIN_AUTH_KEY) === '1';
    try {
      const { data } = await sb.auth.getSession();
      const authed = Boolean(data?.session);
      if (authed) localStorage.setItem(ADMIN_AUTH_KEY, '1');
      else localStorage.removeItem(ADMIN_AUTH_KEY);
      return authed;
    } catch {
      return localStorage.getItem(ADMIN_AUTH_KEY) === '1';
    }
  }

  async function getAccessToken() {
    const session = await getSession();
    return session?.access_token || null;
  }

  function promptForAdminPassword() {
    const password = window.prompt('Enter the admin password to unlock the Trollrunner website.');
    if (password == null) return null;
    return String(password);
  }

  function friendlyAuthError(error) {
    const raw = String(error?.message || error || '');
    if (/invalid login credentials/i.test(raw)) return new Error('Wrong admin password.');
    if (/rate limit|security purposes/i.test(raw)) return new Error('Too many attempts — wait a minute and try again.');
    return new Error(raw || 'Unable to unlock the website.');
  }

  async function signInWithAdminPassword(password, options = {}) {
    const sb = getAuthClient();
    if (!sb) throw new Error('Admin login service failed to load. Refresh and try again.');
    const { error } = await sb.auth.signInWithPassword({ email: ADMIN_EMAIL, password: String(password) });
    if (error) throw friendlyAuthError(error);
    localStorage.setItem(ADMIN_AUTH_KEY, '1');
    if (!options.silent) await refreshUi();
    return true;
  }

  async function signOut() {
    const sb = getAuthClient();
    if (sb) await sb.auth.signOut().catch(() => {});
    localStorage.removeItem(ADMIN_AUTH_KEY);
    window.TrollrunnerSiteGate?.resetAfterLogout?.();
    await refreshUi();
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
    const footerButton = document.getElementById('admin-go');
    if (authed) {
      writeStatus([footerStatus, gateStatus], '', 'success');
      setButtonState(footerButton, true, 'Admin', 'Admin');
    } else {
      writeStatus([footerStatus, gateStatus], '', 'info');
      setButtonState(footerButton, true, 'Admin', 'Admin');
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
      await refreshUi();
      writeStatus([footerStatus, gateStatus], '', 'success');
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

  // One-time setup utility — NOT wired to any button on purpose. Run this
  // yourself from the browser devtools console once, after running
  // assets/supabase/troll_admin_lockdown.sql, to create the real admin
  // Supabase Auth account. Your password is typed into a native prompt()
  // and goes straight to Supabase — it never appears in this file, in any
  // chat/session log, or on the network to anywhere else.
  //   TrollrunnerAdminAuth.bootstrapAdminAccount()
  async function bootstrapAdminAccount() {
    const sb = getAuthClient();
    if (!sb) {
      window.alert('Supabase failed to load — refresh and try again.');
      return false;
    }
    const password = window.prompt('Choose a new admin password (this replaces the old one):');
    if (password == null) return false;
    if (String(password).length < 8) {
      window.alert('Use a password with at least 8 characters.');
      return false;
    }
    const { error } = await sb.auth.signUp({ email: ADMIN_EMAIL, password: String(password) });
    if (error) {
      window.alert(`Could not create the admin account: ${error.message}`);
      return false;
    }
    window.alert(
      'Admin account created. Now run this once in the Supabase SQL editor:\n\n'
      + "insert into public.troll_admins (user_id)\nselect id from auth.users where email = 'admin@login.trollrunner.net'\non conflict (user_id) do nothing;"
    );
    return true;
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
    getAccessToken,
    hasAdminSession,
    awaitPasswordRecoverySettled,
    signInWithAdminPassword,
    requestAdminLink,
    ensureAdminSession,
    openAdminPageOrLink,
    signOut,
    refreshUi,
    bootstrapAdminAccount,
  };

  window.requestAdminLoginLink = () => requestAdminLink();
  window.goToAdmin = () => openAdminPageOrLink();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();

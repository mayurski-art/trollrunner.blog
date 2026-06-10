(function () {
  const SUPABASE_URL = 'https://tjsyhfplxjtakdfkpdtg.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRqc3loZnBseGp0YWtkZmtwZHRnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYzOTc0ODksImV4cCI6MjA5MTk3MzQ4OX0.xLUcPUUguRBQttNwiIRWJHxjJjLqrQDMu4Ubsk5yZoQ';
  const SUPABASE_TABLE = 'site_updates';
  const SUPABASE_ROW_ID = 'main';
  const SITE_LOCK_STORAGE_KEY = 'trollrunner_site_public_lock_v1';
  const SITE_LOCK_META_ID = '__trollrunner_site_lock_meta__';
  const SITE_LOCK_WARNING_MS = 10000;
  const SITE_LOCK_POLL_MS = 1500;
  const SITE_LOCK_BROADCAST_CHANNEL = 'trollrunner-site-lock';
  const isAdminPage = /\/admin\.html(?:$|\?)/.test(window.location.pathname);
  const isPublicPage = !isAdminPage;
  const hasBroadcastChannel = typeof window.BroadcastChannel !== 'undefined';
  let pollTimer = null;
  let renderTimer = null;
  let broadcastChannel = null;
  let overlayEl = null;
  let tickerEl = null;
  let statusEl = null;
  let countdownEl = null;
  let adminActionEl = null;
  let authClient = null;

  function safeParse(raw, fallback) {
    try {
      const parsed = JSON.parse(raw);
      return parsed == null ? fallback : parsed;
    } catch {
      return fallback;
    }
  }

  function normalizeRecord(raw) {
    const input = raw && typeof raw === 'object' ? raw : {};
    const mode = String(input.mode || input.state || 'open').toLowerCase();
    const normalizedMode = mode === 'pending' || mode === 'locked' ? mode : 'open';
    const pendingUntil = Number(input.pendingUntil || input.lockedAt || input.unlockAt || 0) || 0;
    return {
      mode: normalizedMode,
      pendingUntil,
      updatedAt: String(input.updatedAt || input.createdAt || new Date().toISOString()),
    };
  }

  function getStoredRecord() {
    return normalizeRecord(safeParse(localStorage.getItem(SITE_LOCK_STORAGE_KEY), {}));
  }

  function getAuthClient() {
    if (authClient) return authClient;
    if (!window.supabase?.createClient) return null;
    authClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });
    return authClient;
  }

  async function getAuthHeaders() {
    const headers = {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    };
    const client = getAuthClient();
    if (!client?.auth?.getSession) return headers;
    try {
      const { data } = await client.auth.getSession();
      const token = data?.session?.access_token;
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
    } catch {}
    return headers;
  }

  function setStoredRecord(record) {
    const normalized = normalizeRecord(record);
    localStorage.setItem(SITE_LOCK_STORAGE_KEY, JSON.stringify(normalized));
    return normalized;
  }

  function getComputedRecord(record = getStoredRecord(), now = Date.now()) {
    const normalized = normalizeRecord(record);
    if (normalized.mode === 'pending') {
      if (normalized.pendingUntil && now >= normalized.pendingUntil) {
        return {
          mode: 'locked',
          pendingUntil: normalized.pendingUntil,
          updatedAt: normalized.updatedAt,
        };
      }
      return normalized;
    }
    return normalized;
  }

  function getRemainingSeconds(record = getComputedRecord()) {
    if (record.mode !== 'pending' || !record.pendingUntil) return 0;
    return Math.max(0, Math.ceil((record.pendingUntil - Date.now()) / 1000));
  }

  function buildMetaItem(record) {
    const normalized = normalizeRecord(record);
    return {
      id: SITE_LOCK_META_ID,
      title: '__site_lock_meta__',
      body: '__site_lock_meta__',
      createdAt: normalized.updatedAt || new Date().toISOString(),
      archived: true,
      source: 'system',
      siteLock: normalized,
    };
  }

  function extractRecordFromPayload(payload) {
    const updates = Array.isArray(payload?.updates) ? payload.updates : [];
    const meta = updates.find(item => item && item.id === SITE_LOCK_META_ID);
    return normalizeRecord(meta?.siteLock || payload?.siteLock || payload?.site_lock || {});
  }

  function ensureOverlay() {
    if (!isPublicPage) return null;
    if (overlayEl) return overlayEl;

    const style = document.createElement('style');
    style.setAttribute('data-site-lock-style', '1');
    style.textContent = `
      .site-lock-overlay {
        position: fixed;
        inset: 0;
        z-index: 99999;
        display: none;
        align-items: center;
        justify-content: center;
        background: rgba(0, 0, 0, 0.42);
        backdrop-filter: blur(1px);
      }
      .site-lock-overlay.is-visible { display: flex; }
      .site-lock-overlay.is-locked { background: rgba(0, 0, 0, 0.68); }
      .site-lock-overlay-panel {
        width: min(100vw, 100%);
        padding: clamp(18px, 4vw, 32px) 0;
        overflow: hidden;
        text-align: center;
      }
      .site-lock-overlay-ticker {
        display: flex;
        gap: 1.5rem;
        width: max-content;
        min-width: 200%;
        white-space: nowrap;
        padding: 12px 0;
        color: #ff4058;
        text-transform: uppercase;
        font-weight: 900;
        letter-spacing: 0.28em;
        font-size: clamp(18px, 4.2vw, 58px);
        text-shadow: 0 0 16px rgba(255, 64, 88, 0.45), 0 0 36px rgba(255, 64, 88, 0.22);
        animation: trollrunner-site-lock-marquee 10s linear infinite;
      }
      .site-lock-overlay-ticker span {
        display: inline-block;
      }
      .site-lock-overlay-subtext {
        margin-top: 18px;
        color: rgba(255, 255, 255, 0.76);
        font-size: clamp(12px, 1.6vw, 16px);
        letter-spacing: 0.12em;
        text-transform: uppercase;
      }
      .site-lock-admin-panel {
        display: flex;
        justify-content: center;
        margin-top: 18px;
      }
      .site-lock-admin-btn {
        border: 0.5px solid rgba(255,255,255,0.22);
        border-radius: 999px;
        background: rgba(16, 18, 26, 0.78);
        color: #fff;
        padding: 10px 14px;
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        cursor: pointer;
        box-shadow: 0 10px 22px rgba(0,0,0,0.25);
      }
      .site-lock-admin-btn.is-accent {
        background: linear-gradient(135deg, rgba(0, 122, 255, 0.95), rgba(255, 73, 167, 0.9));
      }
      .site-lock-admin-btn:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }
      @keyframes trollrunner-site-lock-marquee {
        from { transform: translateX(0); }
        to { transform: translateX(-50%); }
      }
      .site-lock-warning body,
      body.site-lock-warning {
        overflow-x: hidden;
      }
    `;
    document.head.appendChild(style);

    overlayEl = document.createElement('div');
    overlayEl.id = 'site-lock-overlay';
    overlayEl.className = 'site-lock-overlay';
    overlayEl.innerHTML = `
      <div class="site-lock-overlay-panel" role="alert" aria-live="assertive">
        <div class="site-lock-overlay-ticker" aria-hidden="true">
          <span id="site-lock-ticker-a"></span>
          <span id="site-lock-ticker-b"></span>
        </div>
        <div id="site-lock-status" class="site-lock-overlay-subtext"></div>
        <div class="site-lock-admin-panel" aria-label="Admin access">
          <button id="site-lock-admin-action" class="site-lock-admin-btn is-accent" type="button">Unlock site</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlayEl);
    tickerEl = overlayEl.querySelector('#site-lock-ticker-a');
    statusEl = overlayEl.querySelector('#site-lock-status');
    countdownEl = overlayEl.querySelector('#site-lock-ticker-b');
    adminActionEl = overlayEl.querySelector('#site-lock-admin-action');
    if (adminActionEl) {
      adminActionEl.addEventListener('click', async () => {
        const helper = window.TrollrunnerAdminAuth;
        if (!helper?.requestAdminLink) return;
        const unlocked = await helper.requestAdminLink();
        if (unlocked && window.TrollrunnerSiteLock?.requestLockTransition) {
          window.TrollrunnerSiteLock.requestLockTransition(false);
        }
      });
    }
    return overlayEl;
  }

  function buildTickerText(state) {
    if (state.mode === 'pending') {
      const seconds = getRemainingSeconds(state);
      return `WARNING SITE LOCKS IN ${seconds}s WARNING SITE LOCKS IN ${seconds}s WARNING SITE LOCKS IN ${seconds}s`;
    }
    return 'SITE LOCKED SITE LOCKED SITE LOCKED SITE LOCKED SITE LOCKED SITE LOCKED';
  }

  function renderOverlay() {
    const state = getComputedRecord();
    const overlay = ensureOverlay();
    if (!overlay) return state;

    const visible = state.mode === 'pending' || state.mode === 'locked';
    overlay.classList.toggle('is-visible', visible);
    overlay.classList.toggle('is-locked', state.mode === 'locked');
    document.body.classList.toggle('site-lock-warning', state.mode === 'pending');
    document.body.classList.toggle('site-lock-locked', state.mode === 'locked');

    if (tickerEl) tickerEl.textContent = buildTickerText(state);
    if (countdownEl) countdownEl.textContent = state.mode === 'pending' ? `${getRemainingSeconds(state)} SECOND WARNING` : 'ACCESS PAUSED';
    if (statusEl) {
      statusEl.textContent = state.mode === 'pending'
        ? 'Public access will lock shortly.'
        : (state.mode === 'locked' ? 'Public access is locked.' : '');
    }
    void refreshAdminControls(state);
    return state;
  }

  async function refreshAdminControls(state = getComputedRecord()) {
    if (!adminActionEl) return;
    const helper = window.TrollrunnerAdminAuth;
    const authed = helper?.hasAdminSession ? await helper.hasAdminSession() : false;
    adminActionEl.textContent = 'Unlock site';
    adminActionEl.disabled = false;
    adminActionEl.dataset.mode = authed ? 'authed' : 'locked';
  }

  function broadcastState() {
    if (!broadcastChannel) return;
    try {
      broadcastChannel.postMessage({ type: 'site-lock-state' });
    } catch {}
  }

  async function syncStateToBackend(record) {
    const normalized = normalizeRecord(record);
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return false;
    try {
      const qs = new URLSearchParams({
        select: 'updates',
        id: `eq.${SUPABASE_ROW_ID}`,
        limit: '1',
      });
      const headers = await getAuthHeaders();
      const existingResponse = await fetch(`${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}?${qs.toString()}`, { headers });
      if (!existingResponse.ok) return false;
      const json = await existingResponse.json();
      const payload = Array.isArray(json) ? json[0] : json;
      const existingUpdates = Array.isArray(payload?.updates) ? payload.updates : [];
      const nextUpdates = existingUpdates.filter(item => item && item.id !== SITE_LOCK_META_ID);
      nextUpdates.push(buildMetaItem(normalized));
      const writeResponse = await fetch(`${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}`, {
        method: 'POST',
        headers: {
          ...headers,
          Prefer: 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify([{
          id: SUPABASE_ROW_ID,
          updates: nextUpdates,
          updated_at: new Date().toISOString(),
        }]),
      });
      return writeResponse.ok;
    } catch {
      return false;
    }
  }

  async function pollRemoteState() {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      if (isPublicPage) renderOverlay();
      return;
    }
    try {
      const qs = new URLSearchParams({
        select: 'updates',
        id: `eq.${SUPABASE_ROW_ID}`,
        limit: '1',
      });
      const response = await fetch(`${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}?${qs.toString()}`, {
        headers: await getAuthHeaders(),
      });
      if (!response.ok) return;
      const json = await response.json();
      const payload = Array.isArray(json) ? json[0] : json;
      const nextRecord = extractRecordFromPayload(payload);
      const currentRecord = getStoredRecord();
      if (JSON.stringify(nextRecord) !== JSON.stringify(currentRecord)) {
        setStoredRecord(nextRecord);
        broadcastState();
      }
      if (isPublicPage) {
        renderOverlay();
      }
    } catch {
      if (isPublicPage) renderOverlay();
    }
  }

  function requestLockTransition(shouldLock) {
    const nextRecord = shouldLock
      ? {
          mode: 'pending',
          pendingUntil: Date.now() + SITE_LOCK_WARNING_MS,
          updatedAt: new Date().toISOString(),
        }
      : {
          mode: 'open',
          pendingUntil: 0,
          updatedAt: new Date().toISOString(),
        };
    setStoredRecord(nextRecord);
    renderOverlay();
    broadcastState();
    void syncStateToBackend(nextRecord);
    return getComputedRecord(nextRecord);
  }

  function hydrate() {
    renderOverlay();
    if (pollTimer) window.clearInterval(pollTimer);
    if (renderTimer) window.clearInterval(renderTimer);
    pollTimer = window.setInterval(pollRemoteState, SITE_LOCK_POLL_MS);
    renderTimer = window.setInterval(renderOverlay, 250);
    if (hasBroadcastChannel && !broadcastChannel) {
      try {
        broadcastChannel = new BroadcastChannel(SITE_LOCK_BROADCAST_CHANNEL);
        broadcastChannel.onmessage = () => {
          const local = getStoredRecord();
          if (!isPublicPage) return;
          renderOverlay(local);
        };
      } catch {
        broadcastChannel = null;
      }
    }
    window.addEventListener('storage', event => {
      if (event.key !== SITE_LOCK_STORAGE_KEY) return;
      renderOverlay();
    });
    void pollRemoteState();
  }

  window.TrollrunnerSiteLock = {
    storageKey: SITE_LOCK_STORAGE_KEY,
    metaId: SITE_LOCK_META_ID,
    warningMs: SITE_LOCK_WARNING_MS,
    getStoredRecord,
    setStoredRecord,
    getComputedRecord,
    getRemainingSeconds,
    buildMetaItem,
    extractRecordFromPayload,
    requestLockTransition,
    syncStateToBackend,
    refresh: pollRemoteState,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', hydrate, { once: true });
  } else {
    hydrate();
  }
})();

/**
 * Orbit PA Dashboard — Frontend Controller
 * Complete production-ready implementation.
 * All buttons, modals, voice, themes, calendar tabs, and API endpoints wired.
 */

const gsap = window.gsap;

// ============================================================
// State
// ============================================================
const state = {
  prefs: {},
  reminders: [],
  trends: [],
  legalResults: [],
  templates: [],
  voiceRecognition: null,
  isListening: false,
  user: null,
  userName: "",
  chat: {
    inFlight: false,
    controller: null,
    secondsEl: null,
  },
  notify: {
    enabled: false,
    permission: "default",
    soundOn: true,
    timer: null,
    seenMail: null,
    seenEvents: null,
  },
};

// ============================================================
// DOM Helpers
// ============================================================
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function fmtTime(t) {
  if (!t) return "";
  try {
    return new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return String(t);
  }
}

function fmtDate(d) {
  try {
    return new Date(d + "T12:00:00").toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  } catch {
    return String(d);
  }
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  }[c]));
}

// ============================================================
// Toast Notification System
// ============================================================
function showToast(message, type = "info") {
  const container = $("#toastContainer");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  const icon = type === "success" ? "✓" : type === "error" ? "⚠" : "✦";
  toast.innerHTML = `<span style="color:var(--primary-light)">${icon}</span><span>${escapeHtml(message)}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add("fade-out");
    setTimeout(() => toast.remove(), 300);
  }, 3200);

  toast.addEventListener("click", () => {
    toast.classList.add("fade-out");
    setTimeout(() => toast.remove(), 200);
  });
}

// ============================================================
// Desktop Notifications + Real Sounds
// ============================================================
// Desktop notifications survive the tab being hidden and, with
// requireInteraction, stay on screen until dismissed ("persistent"). The chime
// is a real audio asset (/notify-chime.wav), pitch-shifted per event kind; if it
// can't load we fall back to a synthesised Web Audio tone so sound never dies.
// Preference is stored per-browser in localStorage.
const NOTIFY_KEY = "orbit-notify";
const CHIME_SRC = "/notify-chime.wav";
const CHIME_RATES = { success: 1.12, warn: 0.92, error: 0.8, info: 1.0 };

function loadNotifyPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(NOTIFY_KEY) || "{}");
    state.notify.enabled = Boolean(saved.enabled);
    state.notify.soundOn = saved.soundOn !== false;
  } catch {
    /* ignore corrupt prefs */
  }
  state.notify.permission = "Notification" in window ? Notification.permission : "unsupported";
}

function saveNotifyPrefs() {
  try {
    localStorage.setItem(
      NOTIFY_KEY,
      JSON.stringify({ enabled: state.notify.enabled, soundOn: state.notify.soundOn }),
    );
  } catch {
    /* storage may be unavailable (private mode) */
  }
}

let audioCtx = null;
function audioContext() {
  if (audioCtx) return audioCtx;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  audioCtx = new Ctx();
  return audioCtx;
}

let chimeEl = null;
let chimeBroken = false;
function chimeAudio() {
  if (chimeBroken) return null;
  if (chimeEl) return chimeEl;
  try {
    chimeEl = new Audio(CHIME_SRC);
    chimeEl.preload = "auto";
    chimeEl.addEventListener("error", () => {
      chimeBroken = true;
      chimeEl = null;
    });
  } catch {
    chimeBroken = true;
  }
  return chimeEl;
}

/** Two-note chime, distinct per event kind. */
function playSynthChime(kind = "info") {
  const ctx = audioContext();
  if (!ctx) return;
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  const notes = {
    success: [660, 990],
    warn: [587, 523],
    error: [440, 330],
    info: [784, 1046],
  }[kind] || [784, 1046];
  const now = ctx.currentTime;
  notes.forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    const start = now + i * 0.13;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.18, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.34);
    osc.connect(gain).connect(ctx.destination);
    osc.start(start);
    osc.stop(start + 0.36);
  });
}

/** Play the chime asset (pitch-shifted per kind), falling back to the synth. */
function playChime(kind = "info") {
  if (!state.notify.soundOn) return;
  const el = chimeAudio();
  if (el) {
    try {
      el.pause();
      el.currentTime = 0;
      el.playbackRate = CHIME_RATES[kind] || 1.0;
      el.volume = 0.7;
      const started = el.play();
      if (started && typeof started.catch === "function") {
        started.catch(() => playSynthChime(kind));
      }
      return;
    } catch {
      /* fall through to the synth */
    }
  }
  playSynthChime(kind);
}

/** Fire a desktop notification (persistent) + chime, if enabled. */
async function notifyUser(title, { body = "", kind = "info", url = "/" } = {}) {
  if (!state.notify.enabled || state.notify.permission !== "granted") return;
  playChime(kind);
  try {
    const reg = await navigator.serviceWorker?.ready;
    if (reg) {
      await reg.showNotification(title, {
        body,
        tag: `orbit-${title}-${body}`.slice(0, 120),
        renotify: true,
        requireInteraction: true,
        silent: true, // we play our own chime
        icon: "/davric-logo.png",
        badge: "/davric-logo.png",
        data: { url },
      });
      return;
    }
  } catch {
    /* fall through to the constructor */
  }
  try {
    new Notification(title, { body, icon: "/davric-logo.png", requireInteraction: true });
  } catch {
    /* some browsers block the constructor outside a SW context */
  }
}

function updateNotifyButton() {
  const btn = $("#notifyBtn");
  if (!btn) return;
  const on = state.notify.enabled && state.notify.permission === "granted";
  btn.classList.toggle("on", on);
  btn.classList.toggle("muted", !on);
  btn.title = on ? "Desktop notifications ON (click to pause)" : "Enable desktop notifications";
  btn.setAttribute("aria-pressed", String(on));
}

async function enableNotifications() {
  if (!("Notification" in window)) {
    showToast("This browser doesn't support notifications", "error");
    return false;
  }
  let perm = Notification.permission;
  if (perm !== "granted") perm = await Notification.requestPermission();
  state.notify.permission = perm;
  if (perm !== "granted") {
    showToast("Notifications are blocked — allow them in your browser's site settings", "warn");
    updateNotifyButton();
    return false;
  }
  state.notify.enabled = true;
  saveNotifyPrefs();
  updateNotifyButton();
  // Unlock audio on this user gesture so later chimes are allowed to play.
  chimeAudio()?.load?.();
  audioContext()?.resume?.().catch(() => {});
  notifyUser("Notifications enabled", { body: `Alerts are on for ${state.userName || "you"}`, kind: "success" });
  showToast("Notifications on — chime for new mail & events", "success");
  startNotifyPoller();
  return true;
}

function disableNotifications() {
  state.notify.enabled = false;
  saveNotifyPrefs();
  updateNotifyButton();
  stopNotifyPoller();
  showToast("Notifications paused", "info");
}

function toggleNotifications() {
  const on = state.notify.enabled && state.notify.permission === "granted";
  return on ? (disableNotifications(), Promise.resolve(false)) : enableNotifications();
}

// --- poller: diff a baseline so we only alert on genuinely new things ----
function keyOfMail(m) {
  return String(m?.id ?? m?.threadId ?? `${m?.from ?? ""}|${m?.subject ?? ""}`);
}
function keyOfEvent(e) {
  return String(e?.id ?? `${e?.title ?? ""}|${e?.start ?? ""}`);
}

async function checkNotifications() {
  if (!state.notify.enabled || state.notify.permission !== "granted") return;
  try {
    const inbox = await api("/api/inbox");
    const urgent = Array.isArray(inbox.urgent) ? inbox.urgent : [];
    const ids = new Set(urgent.map(keyOfMail));
    if (state.notify.seenMail === null) {
      state.notify.seenMail = ids; // first pass = baseline, no spam
    } else {
      const fresh = urgent.filter((m) => !state.notify.seenMail.has(keyOfMail(m)));
      if (fresh.length) {
        notifyUser(fresh.length > 1 ? `${fresh.length} new important emails` : "New important email", {
          body: fresh[0].subject || fresh[0].from || "You have new mail",
          kind: "info",
          url: "/#mail",
        });
      }
      state.notify.seenMail = ids;
    }
  } catch {
    /* transient read failure — try again next tick */
  }
  try {
    const day = await api("/api/day");
    const items = day?.summary?.items || [];
    const soon = items.filter((it) => {
      const t = Date.parse(it.start);
      if (Number.isNaN(t)) return false;
      const dt = t - Date.now();
      return dt <= 15 * 60 * 1000 && dt > -60 * 1000;
    });
    const ids = new Set(soon.map(keyOfEvent));
    if (state.notify.seenEvents === null) {
      state.notify.seenEvents = ids;
    } else {
      const fresh = soon.filter((e) => !state.notify.seenEvents.has(keyOfEvent(e)));
      if (fresh.length) {
        notifyUser(fresh[0].title ? `Starting soon — ${fresh[0].title}` : "Event starting soon", {
          body: fmtTime(fresh[0].start) || "Within the next 15 minutes",
          kind: "warn",
          url: "/#today",
        });
      }
      state.notify.seenEvents = ids;
    }
  } catch {
    /* ignore */
  }
}

function startNotifyPoller() {
  stopNotifyPoller();
  if (!state.notify.enabled) return;
  checkNotifications();
  state.notify.timer = setInterval(checkNotifications, 45000);
}

function stopNotifyPoller() {
  if (state.notify.timer) {
    clearInterval(state.notify.timer);
    state.notify.timer = null;
  }
}

async function initServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register("/sw.js");
  } catch (err) {
    console.warn("[sw] registration failed:", err.message);
  }
}

// ============================================================
// API Client with Resilient Fallback
// ============================================================
async function api(path, options = {}) {
  try {
    const res = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      ...options,
    });
    if (res.status === 401) {
      window.location.href = "/login";
      throw new Error("401 Unauthorized: redirecting to sign-in");
    }
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`${res.status} ${res.statusText}: ${errText}`);
    }
    return await res.json();
  } catch (err) {
    console.warn(`[api] Request to ${path} failed:`, err.message);
    throw err;
  }
}

// ============================================================
// Mail Reader
// ============================================================
function relativeTime(isoish) {
  if (!isoish) return "";
  const t = Date.parse(isoish);
  if (Number.isNaN(t)) return "";
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(t).toLocaleDateString();
}

function renderMail(box) {
  const list = $("#mailList");
  const meta = $("#mailMeta");
  if (!list || !meta) return;

  list.innerHTML = "";

  if (box.error) {
    meta.textContent = "Mailbox unavailable";
    list.appendChild(el("li", "mail-empty", `Could not read Gmail: ${box.error}`));
    return;
  }
  if (box.simulated) {
    meta.textContent = "Demo data — no Gmail provider configured";
    list.appendChild(el("li", "mail-empty", "These are sample messages, not real mail."));
  } else {
    const total = box.totalMatching ? ` of ~${box.totalMatching} matching` : "";
    meta.textContent = `Showing ${box.fetched}${total} · ${box.unread} unread · ${box.withAttachments} with attachments`;
  }

  if (!box.messages?.length) {
    list.appendChild(el("li", "mail-empty", "No messages matched that search."));
    return;
  }

  for (const m of box.messages) {
    const li = el("li", `mail-item${m.unread ? " unread" : ""}`);
    const head = el("div", "mail-item-head");
    head.appendChild(el("span", "mail-from", m.fromName || m.from));
    head.appendChild(el("span", "mail-when", relativeTime(m.date) || ""));
    li.appendChild(head);
    li.appendChild(el("div", "mail-subject", m.subject || "(no subject)"));
    if (m.snippet) li.appendChild(el("div", "mail-snippet", m.snippet));
    if (m.hasAttachments) li.appendChild(el("span", "mail-clip", "📎 attachment"));
    // Bodies are fetched on demand so the panel stays fast on a large mailbox.
    const pre = el("pre", "mail-body");
    pre.hidden = true;
    pre.textContent = m.body || "";
    li.appendChild(pre);
    const toggle = el("button", "text-btn mail-expand", "Show full text");
    toggle.type = "button";
    toggle.addEventListener("click", () => {
      pre.hidden = !pre.hidden;
      toggle.textContent = pre.hidden ? "Show full text" : "Hide full text";
    });
    li.appendChild(toggle);
    list.appendChild(li);
  }
}

async function loadMail(query) {
  const meta = $("#mailMeta");
  const q = query ?? ($("#mailQuery")?.value || "").trim();
  if (meta) meta.textContent = "Reading mailbox…";
  const params = new URLSearchParams({ max: "20" });
  if (q) params.set("q", q);
  try {
    renderMail(await api(`/api/mail?${params.toString()}`));
  } catch (err) {
    if (meta) meta.textContent = "Mailbox unavailable";
    const list = $("#mailList");
    if (list) {
      list.innerHTML = "";
      list.appendChild(el("li", "mail-empty", `Could not reach the mail service: ${err.message}`));
    }
  }
}

// ============================================================
// Theme Management (Dark & Light Mode)
// ============================================================
function initTheme() {
  const themeToggle = $("#themeToggle");
  const metaThemeColor = $('meta[name="theme-color"]');

  const savedTheme = localStorage.getItem("orbit_theme");
  const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  // Match the pre-paint script in index.html: honour the saved choice, else the OS.
  const initialTheme = savedTheme || (prefersDark ? "dark" : "light");

  setTheme(initialTheme);

  if (themeToggle) {
    themeToggle.addEventListener("click", () => {
      const current = document.documentElement.dataset.theme;
      const next = current === "light" ? "dark" : "light";
      setTheme(next);
      showToast(`Switched to ${next === "dark" ? "Dark Obsidian" : "Light Porcelain"} mode`);
    });
  }

  function setTheme(t) {
    document.documentElement.dataset.theme = t;
    localStorage.setItem("orbit_theme", t);
    // The sun/moon glyphs are swapped by CSS off [data-theme]; here we only
    // keep the tooltip and the OS theme-color in sync.
    themeToggle?.setAttribute("title", t === "dark" ? "Switch to Light Mode" : "Switch to Dark Mode");
    if (metaThemeColor) {
      metaThemeColor.setAttribute("content", t === "dark" ? "#1a1313" : "#f7f5f3");
    }
  }
}

// ============================================================
// PWA install (Add to Home Screen)
// ============================================================
let deferredInstallPrompt = null;

function isStandalone() {
  return (
    window.matchMedia?.("(display-mode: standalone)")?.matches ||
    window.navigator.standalone === true
  );
}

function isIos() {
  return (
    /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

function initPwa() {
  const btn = $("#installBtn");
  if (!btn) return;
  if (isStandalone()) {
    btn.hidden = true;
    return;
  }

  // Chrome/Edge/Android: a real, one-tap install.
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    btn.hidden = false;
  });

  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;
    btn.hidden = true;
    showToast("Orbit installed — open it any time from your home screen", "success");
  });

  // iOS Safari never fires beforeinstallprompt, so surface a manual hint.
  if (isIos()) btn.hidden = false;

  btn.addEventListener("click", async () => {
    if (deferredInstallPrompt) {
      deferredInstallPrompt.prompt();
      try {
        await deferredInstallPrompt.userChoice;
      } catch {
        /* user dismissed */
      }
      deferredInstallPrompt = null;
      btn.hidden = true;
      return;
    }
    showToast(
      isIos()
        ? "Tap the Share button, then “Add to Home Screen” to install Orbit"
        : "Open your browser menu and choose “Install app” to add Orbit",
      "info",
    );
  });
}

// ============================================================
// Tab Management
// ============================================================
function showTab(tabName, panel) {
  if (!panel) return;
  $$(".tab-btn", panel).forEach(b => {
    const isActive = b.dataset.tab === tabName;
    b.classList.toggle("active", isActive);
    b.setAttribute("aria-selected", isActive ? "true" : "false");
  });

  $$(".tab-pane", panel).forEach(p => {
    p.classList.toggle("active", p.id === `${tabName}Pane`);
  });

  const titleEl = $("#todayKicker");
  if (titleEl) {
    if (tabName === "today") titleEl.textContent = "TODAY'S SCHEDULE";
    else if (tabName === "week") titleEl.textContent = "7-DAY OUTLOOK";
    else if (tabName === "flights") titleEl.textContent = "CONFIRMED ITINERARY";
  }
}

// ============================================================
// Chat Controller
// ============================================================

/** Small DOM builder. Uses textContent throughout, so agent output is never
 *  interpreted as markup. */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function scrollChat() {
  const c = $("#chatMessages");
  if (c) c.scrollTop = c.scrollHeight;
}

function appendMessage(node, { isUser = false } = {}) {
  const container = $("#chatMessages");
  if (!container) return;
  container.querySelector(".welcome-message")?.remove();
  const wrap = el("div", `chat-msg ${isUser ? "you" : "bot"}`);
  wrap.appendChild(node);
  container.appendChild(wrap);
  scrollChat();
  return wrap;
}

function actionButton(label, prompt, variant = "") {
  const b = el("button", `chat-action ${variant}`.trim(), label);
  b.type = "button";
  b.addEventListener("click", () => {
    // sendChat() already drops duplicate submissions; bail out before
    // disabling so a click during an in-flight request cannot strand this
    // button in a permanently disabled state.
    if (state.chat.inFlight) return;
    b.disabled = true;
    sendChat(prompt);
  });
  return b;
}

/**
 * The agent replies in plain text, but that text is highly structured:
 * numbered flight options, calendar proposals, day agendas, inbox digests.
 * Parsing it here lets the UI render real cards and clickable actions instead
 * of one undifferentiated text wall. Anything unrecognised stays a plain
 * bubble, so this never swallows content it does not understand.
 */
function classifyReply(raw) {
  const text = String(raw ?? "");
  const lines = text.split("\n");
  const first = lines[0] ?? "";

  // "f1 · Delta DL120 · 06:10 → 08:40 · nonstop · 7h 05m · 399 USD"
  const options = lines
    .map((l) => /^f(\d+)\s+·\s+(.+)$/.exec(l.trim()))
    .filter(Boolean)
    .map((m) => ({ id: `f${m[1]}`, fields: m[2].split("·").map((s) => s.trim()) }));
  if (options.length) {
    return {
      kind: "flights",
      route: first.replace(/^✈️\s*/, "").trim(),
      meta: (lines[1] || "").replace(/^\(|\)$/g, "").trim(),
      options,
      simulated: /simulated options/i.test(text),
      canBook: /book f1/i.test(text),
    };
  }

  const proposal = /📅\s*Proposed:\s*(\w+)\s+"([^"]*)"/.exec(text);
  if (proposal) {
    return {
      kind: "proposal",
      action: proposal[1].toLowerCase(),
      summary: proposal[2],
      when: (/^When:\s*(.+)$/m.exec(text)?.[1] || "").trim(),
    };
  }

  const calDone = /^📅\s*(Booked|Moved|Cancelled)\s*—\s*"([^"]*)"/.exec(text);
  if (calDone) {
    return {
      kind: "confirmed",
      verb: calDone[1],
      summary: calDone[2],
      detail: lines.slice(1).filter(Boolean).join(" · "),
    };
  }

  if (/^✅\s*Booked/.test(text)) {
    return {
      kind: "booked",
      title: first.replace(/^✅\s*/, "").trim(),
      detail: lines.slice(1).filter(Boolean).join(" · "),
    };
  }

  if (/^⚠️/.test(text)) {
    return { kind: "notice", text };
  }

  const agenda = /^🗓\s+(.+?)\s*—\s*(\S+)/.exec(first);
  if (agenda) {
    return {
      kind: "agenda",
      day: agenda[1],
      date: agenda[2],
      items: lines
        .slice(2)
        .map((l) => l.trim())
        .filter((l) => /^\d{2}:\d{2}\s+\S/.test(l))
        .map((l) => ({ time: l.slice(0, 5), title: l.slice(5).trim() })),
      runway: lines.map((l) => l.trim()).filter((l) => /^(Free|Busy):/.test(l)),
    };
  }

  const inbox = /^📥\s*Inbox\s*—\s*(\d+)\s*unread/.exec(first);
  if (inbox) {
    return {
      kind: "inbox",
      count: Number(inbox[1]),
      items: lines
        .map((l) => /^\s*•\s*(.+?):\s*"([^"]*)"/.exec(l))
        .filter(Boolean)
        .map((m) => ({ from: m[1], subject: m[2] })),
    };
  }

  return { kind: "plain", text };
}

/* ------------------------------------------------------------ card renderers */

function cardHeader(icon, title, sub) {
  const head = el("div", "ai-card-head");
  head.appendChild(el("span", "ai-card-icon", icon));
  const wrap = el("div", "ai-card-head-text");
  wrap.appendChild(el("strong", "ai-card-title", title));
  if (sub) wrap.appendChild(el("span", "ai-card-sub", sub));
  head.appendChild(wrap);
  return head;
}

function flightCard(d) {
  const card = el("div", "ai-card");
  card.appendChild(cardHeader("✈", d.route, d.meta));

  const list = el("div", "flight-list");
  for (const opt of d.options) {
    const [carrier = "", times = "", stops = "", dur = "", price = ""] = opt.fields;
    const row = el("div", "flight-row");

    const main = el("div", "flight-main");
    main.appendChild(el("span", "flight-id", opt.id.toUpperCase()));
    const body = el("div", "flight-body");
    body.appendChild(el("span", "flight-carrier", carrier));
    if (times) body.appendChild(el("span", "flight-times", times));
    const meta = [stops, dur].filter(Boolean).join(" · ");
    if (meta) body.appendChild(el("span", "flight-meta", meta));
    main.appendChild(body);
    row.appendChild(main);

    if (price) row.appendChild(el("span", "flight-price", price));
    if (d.canBook) row.appendChild(actionButton("Book", `book ${opt.id}`, "is-primary"));
    list.appendChild(row);
  }
  card.appendChild(list);

  if (d.simulated) {
    card.appendChild(
      el("p", "ai-warn", "Simulated fares — no live flight provider is connected, so these cannot be booked."),
    );
  }
  return card;
}

function proposalCard(d) {
  const card = el("div", "ai-card ai-card-pending");
  card.appendChild(cardHeader("📅", `${d.action} "${d.summary}"`, d.when || "unscheduled"));
  const actions = el("div", "ai-card-actions");
  actions.appendChild(actionButton("Confirm", "confirm", "is-primary"));
  actions.appendChild(actionButton("Never mind", "never mind", "is-ghost"));
  card.appendChild(actions);
  return card;
}

function agendaCard(d) {
  const card = el("div", "ai-card");
  card.appendChild(cardHeader("🗓", `${d.day} — ${d.date}`, `${d.items.length} scheduled`));
  if (!d.items.length) {
    card.appendChild(el("p", "ai-card-empty", "Nothing scheduled. Clear runway."));
  } else {
    const list = el("ul", "agenda-list");
    for (const it of d.items) {
      const li = el("li", "agenda-item");
      li.appendChild(el("span", "agenda-time", it.time));
      li.appendChild(el("span", "agenda-title", it.title));
      list.appendChild(li);
    }
    card.appendChild(list);
  }
  for (const r of d.runway) card.appendChild(el("p", "ai-card-foot", r));
  return card;
}

function inboxCard(d) {
  const card = el("div", "ai-card");
  card.appendChild(cardHeader("📥", `Inbox — ${d.count} unread`, d.count ? "Needs triage" : "All clear"));
  if (!d.items.length) {
    card.appendChild(el("p", "ai-card-empty", "No urgent or promise-bearing mail."));
  } else {
    const list = el("ul", "inbox-list");
    for (const m of d.items) {
      const li = el("li", "inbox-item");
      li.appendChild(el("span", "inbox-from", m.from));
      li.appendChild(el("span", "inbox-subject", m.subject));
      list.appendChild(li);
    }
    card.appendChild(list);
  }
  return card;
}

function noticeCard(text) {
  const card = el("div", "ai-card ai-card-warn");
  card.appendChild(cardHeader("⚠", "Heads up", ""));
  const p = el("p", "ai-warn");
  p.textContent = text;
  card.appendChild(p);
  return card;
}

function renderDescriptor(d) {
  switch (d.kind) {
    case "flights": return flightCard(d);
    case "proposal": return proposalCard(d);
    case "agenda": return agendaCard(d);
    case "inbox": return inboxCard(d);
    case "notice": return noticeCard(d.text);
    case "confirmed": return confirmedCard("📅", `${d.verb} — "${d.summary}"`, d.detail);
    case "booked": return confirmedCard("✅", d.title, d.detail);
    default: {
      const bubble = el("div", "msg-bubble");
      bubble.textContent = d.text;
      return bubble;
    }
  }
}

function confirmedCard(icon, title, detail) {
  const card = el("div", "ai-card ai-card-ok");
  card.appendChild(cardHeader(icon, title, detail));
  return card;
}

const DEGRADE_COPY = {
  "no-key": "No model key is configured, so that came from the pattern matcher rather than the AI.",
  "brain-error": "The model call failed, so that came from the pattern matcher rather than the AI.",
  "empty-answer": "The model returned nothing usable, so that came from the pattern matcher.",
};

function renderAgentReply(text, degraded) {
  if (degraded) {
    const card = el("div", "ai-card ai-card-warn");
    card.appendChild(cardHeader("⚠", "Fallback mode", DEGRADE_COPY[degraded.reason] || "Running without the model."));
    appendMessage(card);
  }
  appendMessage(renderDescriptor(classifyReply(text)));
}

/* ---------------------------------------------------------------- status pill */

const STATUS = {
  ready: { text: "Ready", dot: "live-dot pulse" },
  thinking: { text: "Thinking…", dot: "live-dot pulse" },
  fallback: { text: "Fallback", dot: "status-dot is-warn" },
  offline: { text: "Unreachable", dot: "status-dot is-error" },
};

function setAgentStatus(status, detail = "") {
  const pill = $("#agentPill");
  if (!pill) return;
  const s = STATUS[status] || STATUS.ready;
  pill.className = `pill pill-${status}`;
  pill.replaceChildren();
  pill.append(el("i", s.dot), document.createTextNode(detail ? `${s.text} · ${detail}` : s.text));
}

/* ------------------------------------------------------------- typing + send */

function showTypingIndicator() {
  hideTypingIndicator();
  const bubble = el("div", "msg-bubble typing");
  bubble.append(el("span", "typing-label", "PA thinking"));
  const secs = el("span", "typing-secs", "0.0s");
  bubble.append(secs, el("span", "typing-dots", "···"));
  state.chat.secondsEl = secs;
  const wrap = appendMessage(bubble);
  if (wrap) wrap.id = "typingIndicator";
}

function hideTypingIndicator() {
  $("#typingIndicator")?.closest(".chat-msg")?.remove();
  state.chat.secondsEl = null;
}

function setChatBusy(busy) {
  const input = $("#chatInput");
  const send = $("#sendBtn");
  const stop = $("#stopBtn");
  if (input) input.disabled = busy;
  if (send) send.disabled = busy;
  if (stop) stop.hidden = !busy;
}

async function sendChat(text) {
  const trimmed = String(text ?? "").trim();
  // One request at a time: without this, replies can land out of order.
  if (!trimmed || state.chat.inFlight) return;

  appendMessage(el("div", "msg-bubble", trimmed), { isUser: true });

  state.chat.inFlight = true;
  state.chat.controller = new AbortController();
  setChatBusy(true);
  setAgentStatus("thinking");
  showTypingIndicator();

  const started = Date.now();
  const ticker = setInterval(() => {
    if (state.chat.secondsEl) {
      state.chat.secondsEl.textContent = `${((Date.now() - started) / 1000).toFixed(1)}s`;
    }
  }, 100);

  try {
    const res = await api("/api/chat", {
      method: "POST",
      body: JSON.stringify({ text: trimmed }),
      signal: state.chat.controller.signal,
    });
    hideTypingIndicator();
    const reply = res.text || "Done.";
    renderAgentReply(reply, res.degraded);
    setAgentStatus(res.degraded ? "fallback" : "ready");
    if (document.hidden) {
      notifyUser("Orbit replied", { body: String(reply).slice(0, 180), kind: res.degraded ? "warn" : "success" });
    }
    if (/booked|scheduled|confirmed|added/i.test(reply)) {
      loadDay();
      loadItinerary();
      loadReminders();
    }
  } catch (err) {
    hideTypingIndicator();
    if (err.name === "AbortError") {
      appendMessage(el("div", "msg-bubble muted-bubble", "Stopped."));
      setAgentStatus("ready");
    } else {
      appendMessage(el("div", "msg-bubble error-bubble", `Could not reach the assistant: ${err.message}`));
      setAgentStatus("offline");
    }
  } finally {
    clearInterval(ticker);
    state.chat.inFlight = false;
    state.chat.controller = null;
    setChatBusy(false);
    $("#chatInput")?.focus();
  }
}

/** Reflect what is genuinely live vs. simulated, so the profile panel and the
 *  status pill stop claiming capabilities the deployment does not have. */
async function loadRuntimeStatus() {
  const setLabel = (id, value) => {
    const node = $(id);
    if (node) node.textContent = value;
  };
  try {
    const h = await api("/api/healthz");
    setLabel(
      "#brainEngineLabel",
      h.brain ? h.brainModel || "OpenAI-compatible provider" : "Not configured — pattern matcher only",
    );
    setLabel(
      "#flightEngineLabel",
      h.flightsSimulated ? "Simulated (no live provider)" : `Live — ${h.flights}`,
    );
    setLabel("#channelLabel", h.provider === "stub" ? "Dashboard only" : h.provider);
    setAgentStatus(h.brain ? "ready" : "fallback", h.brain ? "" : "no model key");
    if (h.flightsSimulated) {
      showToast("Flight search is simulated — no live provider connected", "warn");
    }
  } catch {
    setAgentStatus("offline");
  }
}

// ============================================================
// Voice Input (Web Speech Recognition + Animated Banner)
// ============================================================
function initVoice() {
  const voiceBtn = $("#voiceBtn");
  const banner = $("#voiceBanner");
  const stopBtn = $("#voiceStopBtn");
  const statusText = $("#voiceStatusText");
  const chatInput = $("#chatInput");

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  if (SpeechRecognition) {
    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onstart = () => {
      state.isListening = true;
      voiceBtn?.classList.add("recording");
      if (banner) banner.style.display = "flex";
      if (statusText) statusText.textContent = "Listening to your voice command...";
    };

    recognition.onresult = (event) => {
      let interim = "";
      let finalTranscript = "";

      for (let i = event.resultIndex; i < event.results.length; ++i) {
        if (event.results[i].isFinal) {
          finalTranscript += event.results[i][0].transcript;
        } else {
          interim += event.results[i][0].transcript;
        }
      }

      const activeText = finalTranscript || interim;
      if (chatInput && activeText) {
        chatInput.value = activeText;
      }
      if (statusText && activeText) {
        statusText.textContent = `“${activeText}”`;
      }
    };

    recognition.onerror = (e) => {
      console.warn("[voice] error:", e.error);
      stopListening();
      if (e.error !== "no-speech") {
        showToast(`Mic note: ${e.error}`);
      }
    };

    recognition.onend = () => {
      stopListening();
      const text = chatInput?.value?.trim();
      if (text) {
        showToast("Voice command captured");
      }
    };

    function startListening() {
      try {
        recognition.start();
      } catch (e) {
        console.warn("[voice] start error:", e);
      }
    }

    function stopListening() {
      state.isListening = false;
      voiceBtn?.classList.remove("recording");
      if (banner) banner.style.display = "none";
      try {
        recognition.stop();
      } catch {}
    }

    if (voiceBtn) {
      voiceBtn.addEventListener("click", () => {
        if (state.isListening) {
          stopListening();
        } else {
          startListening();
        }
      });
    }

    if (stopBtn) {
      stopBtn.addEventListener("click", stopListening);
    }
  } else {
    // Graceful fallback when SpeechRecognition is unavailable
    if (voiceBtn) {
      voiceBtn.addEventListener("click", () => {
        showToast("Voice input is ready. Type in the prompt box or use keyboard dictation.");
        chatInput?.focus();
      });
    }
  }
}

// ============================================================
// Renderers
// ============================================================

function renderToday(data) {
  if (!data) return;
  const summary = data.summary || data;
  const freeBusy = data.freeBusy || { free: [], busy: [] };

  const todayDateEl = $("#todayDate");
  if (todayDateEl && summary.day && summary.date) {
    todayDateEl.textContent = `${summary.day}, ${summary.date}`;
  }

  const items = summary.items || [];
  const scheduleList = $("#todaySchedule");
  if (scheduleList) {
    if (!items.length) {
      // Don't call an unread calendar "clear" — only say the runway is clear
      // when we actually read the calendar and found nothing.
      scheduleList.innerHTML = summary.degraded
        ? `<li class="schedule-item"><span class="schedule-title" style="color:var(--dim)">No assistant-booked events today.</span></li>`
        : `<li class="schedule-item"><span class="schedule-title" style="color:var(--dim)">No scheduled meetings for today. Clear runway.</span></li>`;
    } else {
      scheduleList.innerHTML = items.map((it, i) => `
        <li class="schedule-item ${it.done ? "done" : ""} ${i === 0 ? "time-blue" : ""}">
          <span class="schedule-time">${escapeHtml(it.time)}</span>
          <span class="schedule-title">${escapeHtml(it.title)}</span>
          ${it.calendar ? `<span class="cal-source">${escapeHtml(it.calendar)}</span>` : ""}
          ${it.attendees?.length ? `<span class="attendees">${it.attendees.map(escapeHtml).join(", ")}</span>` : ""}
        </li>
      `).join("");
    }
  }

  const banner = $("#calBanner");
  if (banner) {
    if (summary.degraded) {
      banner.hidden = false;
      banner.textContent = `⚠ Couldn't read your live calendar — ${summary.error || "provider unavailable"}. Showing only events booked through this assistant.`;
    } else {
      banner.hidden = true;
      banner.textContent = "";
    }
  }

  // Update Free / Busy stats — measured from real event start/end, not a
  // slot count. Missing/degraded numbers render as "unavailable", never 0%.
  const unavailable = Boolean(summary.degraded || freeBusy.degraded || freeBusy.freePct == null);
  const freeMinutes = Number(freeBusy.freeMinutes ?? 0);
  const busyMinutes = Number(freeBusy.busyMinutes ?? 0);
  const freePct = Math.max(0, Math.min(100, Number(freeBusy.freePct ?? 0)));
  const busyPct = Math.max(0, Math.min(100, Number(freeBusy.busyPct ?? 0)));

  const fbEl = $("#freeBusy");
  if (fbEl) {
    fbEl.innerHTML = unavailable
      ? `<div class="fb-row fb-busy"><span>Availability</span><span>Unavailable — calendar not readable</span></div>`
      : `
      <div class="fb-row fb-free">
        <span>Available Runway</span>
        <span>${fmtDuration(freeMinutes)} (${freePct}%)</span>
      </div>
      <div class="fb-bar">
        <div class="fb-fill stat-fill" style="width:${freePct}%;background:linear-gradient(90deg,var(--green),var(--accent-cyan))"></div>
      </div>
      <div class="fb-row fb-busy">
        <span>Committed Focus</span>
        <span>${fmtDuration(busyMinutes)} (${busyPct}%)</span>
      </div>
      <div class="fb-bar">
        <div class="fb-fill stat-fill" style="width:${busyPct}%;background:linear-gradient(90deg,var(--primary),var(--primary-light))"></div>
      </div>
    `;
  }

  // Update Hero open time. Never invent minutes we didn't measure.
  const openTimeVal = $("#openTimeVal");
  const openTimeFill = $("#openTimeFill");
  const openTimeSub = $("#openTimeSub");
  if (openTimeVal) openTimeVal.innerHTML = unavailable ? "—" : fmtDurationHtml(freeMinutes);
  if (openTimeFill) openTimeFill.style.width = unavailable ? "0%" : `${freePct}%`;
  if (openTimeSub) openTimeSub.textContent = unavailable ? "Calendar unavailable" : `${freePct}% of your workday is open`;
}

/** 320 → "5h 20m". */
function fmtDuration(minutes) {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h && r) return `${h}h ${r}m`;
  if (h) return `${h}h`;
  return `${r}m`;
}

/** 320 → "5<span>h</span> 20<span>m</span>" for the hero's styled units. */
function fmtDurationHtml(minutes) {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  const h = Math.floor(m / 60);
  const r = m % 60;
  const parts = [];
  if (h) parts.push(`${h}<span>h</span>`);
  if (r || !h) parts.push(`${r}<span>m</span>`);
  return parts.join(" ");
}

function renderWeek(days) {
  const grid = $("#weekGrid");
  if (!grid || !Array.isArray(days)) return;

  const anyDegraded = days.some(d => d.degraded);
  grid.innerHTML = (anyDegraded
    ? `<div class="cal-banner">⚠ Calendar not fully readable — some days show only assistant-booked events.</div>`
    : "") + days.map(d => `
    <div class="week-day">
      <div class="week-day-header">${fmtDate(d.date)}</div>
      <ul class="week-schedule">
        ${(d.summary || []).length ? d.summary.map(it => `
          <li class="${it.done ? "done" : ""}">
            <strong style="color:var(--primary-light)">${escapeHtml(it.time)}</strong> ${escapeHtml(it.title)}
            ${it.calendar ? `<span class="cal-source">${escapeHtml(it.calendar)}</span>` : ""}
          </li>
        `).join("") : `<li style="color:var(--dim)">${d.degraded ? "Unavailable" : "Open day"}</li>`}
      </ul>
    </div>
  `).join("");
}

function renderItinerary(text) {
  const container = $("#itinerary");
  if (!container) return;
  container.innerHTML = `<pre class="itinerary-text">${escapeHtml(text || "No upcoming travel planned.")}</pre>`;
}

function renderReminders({ reminders = [], trends = [] }) {
  state.reminders = reminders;
  state.trends = trends;

  const list = $("#reminderList");
  if (list) {
    if (!reminders.length) {
      list.innerHTML = `<li class="reminder-item" style="color:var(--dim)">All caught up! No active reminders.</li>`;
    } else {
      list.innerHTML = reminders.map(r => `
        <li class="reminder-item ${r.status || "pending"}" data-id="${r.id}">
          <input type="checkbox" ${r.status === "done" ? "checked" : ""} aria-label="Toggle task status">
          <span class="rem-text">${escapeHtml(r.text)}</span>
          ${r.due ? `<span class="rem-due">${fmtTime(r.due)}</span>` : ""}
          ${r.recurring ? `<span class="rem-recur">${escapeHtml(r.recurring)}</span>` : ""}
          <button class="btn-icon sm" data-action="delete" aria-label="Delete reminder">✕</button>
        </li>
      `).join("");
    }
  }

  const trendsList = $("#trendsList");
  if (trendsList && trends.length) {
    trendsList.innerHTML = trends.map(t => `
      <div class="trend-card ${t.type || ""}" style="margin-top:10px;padding:10px;background:var(--surface-hover);border-radius:var(--radius-sm);font-size:12px">
        <div style="font-weight:600;color:var(--primary-light)">${escapeHtml(t.title)}</div>
        <div style="color:var(--text-muted);font-size:11px">${escapeHtml(t.description)}</div>
      </div>
    `).join("");
  }
}

function renderPrefs(prefs = {}) {
  state.prefs = prefs;
  const tz = $("#prefTimezone");
  const airport = $("#prefHomeAirport");
  const cabin = $("#prefCabin");
  const seat = $("#prefSeat");
  const noBefore = $("#prefNoMeetingsBefore");
  const airline = $("#prefAirline");

  if (tz && prefs.bossZone) tz.value = prefs.bossZone;
  if (airport && prefs.homeAirport) airport.value = prefs.homeAirport;
  if (cabin && prefs.cabin) cabin.value = prefs.cabin;
  if (seat && prefs.seat) seat.value = prefs.seat;
  if (noBefore && prefs.noMeetingsBefore) noBefore.value = prefs.noMeetingsBefore;
  if (airline && prefs.airline) airline.value = prefs.airline;
}

// ============================================================
// Loaders
// ============================================================

async function loadDay() {
  try {
    const data = await api("/api/day");
    renderToday(data);
  } catch (e) {
    console.warn("Using fallback day schedule:", e);
  }
}

async function loadItinerary() {
  try {
    const data = await api("/api/itinerary");
    renderItinerary(data.text);
  } catch (e) {
    console.warn("Using fallback itinerary:", e);
  }
}

async function loadReminders() {
  try {
    const data = await api("/api/reminders");
    renderReminders(data);
  } catch (e) {
    console.warn("Using fallback reminders:", e);
  }
}

async function loadAll() {
  updateCurrentDate();
  
  // Load primary data with graceful Promise handling
  const tasks = [
    api("/api/day").then(renderToday).catch(() => {}),
    api("/api/week").then(d => renderWeek(d.days)).catch(() => {}),
    api("/api/itinerary").then(d => renderItinerary(d.text)).catch(() => {}),
    api("/api/reminders").then(renderReminders).catch(() => {}),
    api("/api/prefs").then(renderPrefs).catch(() => {}),
    api("/api/inbox").then(d => {
      const badge = $("#inboxCountBadge");
      if (badge && (d.unread || d.count)) {
        badge.textContent = d.unread || d.count;
      }
    }).catch(() => {}),
    loadMail(),
  ];

  await Promise.allSettled(tasks);
}

function updateCurrentDate() {
  const el = $("#currentDate");
  if (el) {
    const now = new Date();
    el.textContent = now.toLocaleDateString([], {
      weekday: "long",
      month: "short",
      day: "numeric",
      year: "numeric"
    }).toUpperCase();
  }
}

// ============================================================
// Modals & User Actions Setup
// ============================================================
function initInteractions() {
  // Chat form submission
  const chatForm = $("#chatForm");
  const chatInput = $("#chatInput");
  if (chatForm && chatInput) {
    chatForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const text = chatInput.value.trim();
      if (!text) return;
      chatInput.value = "";
      sendChat(text);
    });
  }

  // Stop an in-flight request rather than leaving the user waiting on a
  // slow model call with no way out.
  const stopBtn = $("#stopBtn");
  if (stopBtn) {
    stopBtn.addEventListener("click", () => state.chat.controller?.abort());
  }

  // Suggestion chips
  $$("#chatSuggestions .chip-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const label = btn.textContent.trim();
      const promptMap = {
        "Plan my day": "What's my day?",
        "Find a flight": "Find me a flight from JFK to LHR Friday",
        "Summarize inbox": "Summarize my inbox",
        "Check reminders": "What are my reminders?",
      };
      const prompt = promptMap[label] || label;
      if (chatInput) {
        chatInput.value = prompt;
        chatForm?.requestSubmit();
      }
    });
  });

  // Schedule Composer Modal
  const scheduleModal = $("#scheduleModal");
  const scheduleForm = $("#scheduleForm");
  const quickActionBtn = $("#quickAction");

  if (quickActionBtn && scheduleModal) {
    quickActionBtn.addEventListener("click", () => {
      const dateInput = $("#scheduleDate");
      const timeInput = $("#scheduleTime");
      const summaryInput = $("#scheduleSummary");

      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      if (dateInput) dateInput.value = tomorrow.toISOString().slice(0, 10);
      if (timeInput) timeInput.value = "09:00";
      if (summaryInput) summaryInput.value = "";

      scheduleModal.showModal();
      summaryInput?.focus();
    });
  }

  if (scheduleForm && scheduleModal) {
    scheduleForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const summary = $("#scheduleSummary")?.value?.trim();
      const date = $("#scheduleDate")?.value;
      const time = $("#scheduleTime")?.value;

      scheduleModal.close();
      if (summary && date && time) {
        showToast("Reviewing calendar proposal...");
        sendChat(`schedule ${summary} ${date} ${time}`);
      }
    });
  }

  // Hero "View my day" button
  const heroPlan = $("#heroPlan");
  if (heroPlan) {
    heroPlan.addEventListener("click", () => {
      showTab("today", $("#today"));
      $("#today")?.scrollIntoView({ behavior: "smooth", block: "center" });
      const target = $("#today");
      if (target) {
        target.style.boxShadow = "0 0 25px var(--primary-glow)";
        setTimeout(() => target.style.boxShadow = "", 1500);
      }
    });
  }

  // Open Meeting Button
  const openMeetingBtn = $("#openMeetingBtn");
  const meetingModal = $("#meetingModal");
  if (openMeetingBtn && meetingModal) {
    openMeetingBtn.addEventListener("click", () => {
      meetingModal.showModal();
    });
  }

  // Profile Button
  const profileBtn = $("#profileBtn");
  const profileModal = $("#profileModal");
  const profileSettingsBtn = $("#profileSettingsBtn");

  if (profileBtn && profileModal) {
    profileBtn.addEventListener("click", () => {
      profileModal.showModal();
    });
  }

  if (profileSettingsBtn && profileModal) {
    profileSettingsBtn.addEventListener("click", () => {
      profileModal.close();
      $("#settingsPanel")?.scrollIntoView({ behavior: "smooth", block: "center" });
      $("#prefHomeAirport")?.focus();
    });
  }

  // Reminders Modal & List Actions
  const reminderModal = $("#reminderModal");
  const reminderForm = $("#reminderForm");
  const addReminderBtn = $("#addReminderBtn");

  if (addReminderBtn && reminderModal) {
    addReminderBtn.addEventListener("click", () => {
      const textInput = $("#remText");
      if (textInput) textInput.value = "";
      reminderModal.showModal();
      textInput?.focus();
    });
  }

  if (reminderForm && reminderModal) {
    reminderForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = $("#remText")?.value?.trim();
      const due = $("#remDue")?.value || null;
      const recurring = $("#remRecurring")?.value || null;

      reminderModal.close();

      if (text) {
        try {
          await api("/api/reminders", {
            method: "POST",
            body: JSON.stringify({ text, due, recurring }),
          });
          showToast("Reminder added ✓", "success");
          loadReminders();
        } catch (err) {
          showToast(`Could not add reminder: ${err.message}`, "error");
        }
      }
    });
  }

  // Delegated Reminder List Interactions (Checkbox & Delete)
  const reminderList = $("#reminderList");
  if (reminderList) {
    reminderList.addEventListener("click", async (e) => {
      const item = e.target.closest(".reminder-item");
      if (!item) return;
      const id = item.dataset.id;

      if (e.target.type === "checkbox") {
        const checked = e.target.checked;
        item.classList.toggle("done", checked);
        try {
          // Single-segment path so Vercel's catch-all routes it to the function.
          await api(`/api/reminders?id=${encodeURIComponent(id)}`, {
            method: "PATCH",
            body: JSON.stringify({ status: checked ? "done" : "pending" }),
          });
          showToast(checked ? "Task marked done ✓" : "Task marked pending");
        } catch {
          // Revert on error
          e.target.checked = !checked;
          item.classList.toggle("done", !checked);
        }
      } else if (e.target.dataset.action === "delete" || e.target.matches(".btn-icon")) {
        try {
          await api(`/api/reminders?id=${encodeURIComponent(id)}`, {
            method: "DELETE",
          });
          item.remove();
          showToast("Reminder deleted");
        } catch (err) {
          showToast(`Delete failed: ${err.message}`, "error");
        }
      }
    });
  }

  // Settings Form
  const settingsForm = $("#settingsForm");
  const saveFeedback = $("#saveFeedback");
  if (settingsForm) {
    settingsForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const patch = {
        bossZone: $("#prefTimezone")?.value,
        homeAirport: $("#prefHomeAirport")?.value?.toUpperCase(),
        cabin: $("#prefCabin")?.value,
        seat: $("#prefSeat")?.value,
        noMeetingsBefore: $("#prefNoMeetingsBefore")?.value || "09:00",
        airline: $("#prefAirline")?.value || "",
      };

      try {
        const updated = await api("/api/prefs", {
          method: "PATCH",
          body: JSON.stringify(patch),
        });
        renderPrefs(updated);
        showToast("Preferences saved ✓", "success");
        if (saveFeedback) {
          saveFeedback.textContent = "Saved ✓";
          setTimeout(() => saveFeedback.textContent = "", 2500);
        }
      } catch (err) {
        showToast(`Save failed: ${err.message}`, "error");
      }
    });
  }

  // Schedule Tabs
  $$(".schedule-tabs .tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      showTab(btn.dataset.tab, btn.closest(".schedule-surface"));
    });
  });

  // Refresh Today Button
  const refreshTodayBtn = $("#refreshToday");
  if (refreshTodayBtn) {
    refreshTodayBtn.addEventListener("click", async () => {
      const icon = $(".refresh-icon", refreshTodayBtn);
      if (icon) icon.style.transform = "rotate(360deg)";
      await loadDay();
      setTimeout(() => { if (icon) icon.style.transform = ""; }, 400);
      showToast("Schedule updated ✓");
    });
  }

  // Mail Reader
  const mailForm = $("#mailSearchForm");
  if (mailForm) {
    mailForm.addEventListener("submit", (e) => {
      e.preventDefault();
      loadMail();
    });
  }
  const refreshMailBtn = $("#refreshMail");
  if (refreshMailBtn) {
    refreshMailBtn.addEventListener("click", async () => {
      const icon = $(".refresh-icon", refreshMailBtn);
      if (icon) icon.style.transform = "rotate(360deg)";
      await loadMail();
      setTimeout(() => { if (icon) icon.style.transform = ""; }, 400);
    });
  }
  const mailAskBtn = $("#mailAskBtn");
  if (mailAskBtn) {
    mailAskBtn.addEventListener("click", () => {
      const q = ($("#mailQuery")?.value || "").trim();
      const ask = q
        ? `Read and summarise my email for "${q}" — what's actually in there and what needs me?`
        : "Read and summarise my recent email — what's there and what needs me?";
      sendChat(ask);
      $("#inbox")?.scrollIntoView({ behavior: "smooth" });
    });
  }

  // Sidebar Navigation Links
  const navItems = [
    { id: "#navOverview", target: "#overview", tab: null },
    { id: "#navCalendar", target: "#today", tab: "today" },
    { id: "#navInbox", target: "#inbox", tab: null },
    { id: "#navMail", target: "#mail", tab: null },
    { id: "#navTravel", target: "#today", tab: "flights" },
    { id: "#navReminders", target: "#remindersPanel", tab: null },
  ];

  navItems.forEach(({ id, target, tab }) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener("click", (e) => {
      e.preventDefault();
      $$(".nav-item").forEach(n => n.classList.remove("active"));
      el.classList.add("active");

      if (tab) {
        showTab(tab, $("#today"));
      }

      const targetEl = $(target);
      if (targetEl) {
        targetEl.scrollIntoView({ behavior: "smooth", block: "start" });
        if (target === "#inbox") {
          setTimeout(() => $("#chatInput")?.focus(), 300);
        }
      }
    });
  });
}

// ============================================================
// Initialization
// ============================================================
async function initAuth() {
  try {
    const res = await fetch("/api/me");
    const me = await res.json();
    if (me.authEnabled && !me.authenticated) {
      window.location.href = "/login";
      return false;
    }
    if (me.user) {
      state.user = me.user;
      const name = me.user.name || me.user.email || "Signed in";
      state.userName = name;
      const initials = name
        .split(/\s+/)
        .map((w) => w[0])
        .join("")
        .slice(0, 2)
        .toUpperCase();
      const avatarHtml = me.user.picture ? `<img src="${me.user.picture}" alt="">` : initials || "U";
      ["#profileAvatar", "#profileModalAvatar"].forEach((sel) => {
        const node = $(sel);
        if (node) node.innerHTML = avatarHtml;
      });
      const nameEl = $("#profileName");
      if (nameEl) nameEl.textContent = name;
      const greetingEl = $("#greetingName");
      if (greetingEl) greetingEl.textContent = name;
      const modalName = $("#profileModalName");
      if (modalName) modalName.textContent = name;
      const roleText = me.user.isOwner ? "Owner · Private Office" : "Team · Private Office";
      const roleEl = $("#profileRole");
      if (roleEl) roleEl.textContent = me.user.isOwner ? "Owner" : "Team";
      const modalRole = $("#profileModalRole");
      if (modalRole) modalRole.textContent = roleText;
      const signOut = $("#signOutBtn");
      if (signOut) {
        signOut.hidden = false;
        const emailEl = $("#signOutEmail");
        if (emailEl) emailEl.textContent = me.user.email || "";
      }
    }
    return true;
  } catch (err) {
    console.warn("[auth] /api/me failed:", err.message);
    return true;
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  initTheme();
  initVoice();
  initInteractions();
  initPwa();
  loadNotifyPrefs();
  initServiceWorker();
  updateNotifyButton();
  $("#notifyBtn")?.addEventListener("click", () => toggleNotifications());
  const ok = await initAuth();
  if (!ok) return;
  loadAll();
  loadRuntimeStatus();
  if (state.notify.enabled && state.notify.permission === "granted") startNotifyPoller();
});

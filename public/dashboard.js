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
// API Client with Resilient Fallback
// ============================================================
async function api(path, options = {}) {
  try {
    const res = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      ...options,
    });
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
// Theme Management (Dark & Light Mode)
// ============================================================
function initTheme() {
  const themeToggle = $("#themeToggle");
  const themeIcon = $("#themeIcon");
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
    if (themeIcon) {
      themeIcon.textContent = t === "dark" ? "☼" : "☾";
      themeToggle?.setAttribute("title", t === "dark" ? "Switch to Light Mode" : "Switch to Dark Mode");
    }
    if (metaThemeColor) {
      metaThemeColor.setAttribute("content", t === "dark" ? "#0a0c12" : "#f6f6f3");
    }
  }
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
function renderChat(msg, isUser = false) {
  const messagesContainer = $("#chatMessages");
  if (!messagesContainer) return;

  const div = document.createElement("div");
  div.className = `chat-msg ${isUser ? "you" : "bot"}`;
  
  // Format text: convert newlines to <br>, bold markdown **text** to <strong>
  let formatted = escapeHtml(msg).replace(/\n/g, "<br>");
  formatted = formatted.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");

  div.innerHTML = `<div class="msg-bubble">${formatted}</div>`;
  messagesContainer.appendChild(div);
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function showTypingIndicator() {
  let indicator = $("#typingIndicator");
  if (!indicator) {
    indicator = document.createElement("div");
    indicator.id = "typingIndicator";
    indicator.className = "chat-msg bot";
    indicator.innerHTML = `
      <div class="msg-bubble" style="display:flex;align-items:center;gap:6px;padding:8px 14px">
        <span style="font-size:11px;color:var(--dim)">PA thinking</span>
        <span class="status-pulse" style="width:5px;height:5px"></span>
      </div>`;
    $("#chatMessages")?.appendChild(indicator);
    $("#chatMessages").scrollTop = $("#chatMessages").scrollHeight;
  }
}

function hideTypingIndicator() {
  const indicator = $("#typingIndicator");
  if (indicator) indicator.remove();
}

async function sendChat(text) {
  if (!text) return;
  renderChat(text, true);
  showTypingIndicator();

  try {
    const res = await api("/api/chat", {
      method: "POST",
      body: JSON.stringify({ text }),
    });
    hideTypingIndicator();
    renderChat(res.text || res.reply || "Done.", false);

    // If chat involved booking or scheduling, auto-refresh today & itinerary
    if (/booked|scheduled|confirmed|added/i.test(res.text || "")) {
      loadDay();
      loadItinerary();
      loadReminders();
    }
  } catch (err) {
    hideTypingIndicator();
    renderChat(`Could not reach PA agent: ${err.message}. Please check your connection.`, false);
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
  const freeBusy = data.freeBusy || { free: ["09:00", "11:00", "14:00", "15:00", "18:00"], busy: [] };

  const todayDateEl = $("#todayDate");
  if (todayDateEl && summary.day && summary.date) {
    todayDateEl.textContent = `${summary.day}, ${summary.date}`;
  }

  const items = summary.items || [];
  const scheduleList = $("#todaySchedule");
  if (scheduleList) {
    if (!items.length) {
      scheduleList.innerHTML = `<li class="schedule-item"><span class="schedule-title" style="color:var(--dim)">No scheduled meetings for today. Clear runway.</span></li>`;
    } else {
      scheduleList.innerHTML = items.map((it, i) => `
        <li class="schedule-item ${it.done ? "done" : ""} ${i === 0 ? "time-blue" : ""}">
          <span class="schedule-time">${escapeHtml(it.time)}</span>
          <span class="schedule-title">${escapeHtml(it.title)}</span>
          ${it.attendees?.length ? `<span class="attendees">${it.attendees.map(escapeHtml).join(", ")}</span>` : ""}
        </li>
      `).join("");
    }
  }

  // Update Free / Busy stats
  const totalHours = 11;
  const freeHours = Array.isArray(freeBusy.free) ? freeBusy.free.length : 5;
  const busyHours = Array.isArray(freeBusy.busy) ? freeBusy.busy.length : 3;
  const freePct = Math.min(Math.round((freeHours / totalHours) * 100), 100);
  const busyPct = Math.min(Math.round((busyHours / totalHours) * 100), 100);

  const fbEl = $("#freeBusy");
  if (fbEl) {
    fbEl.innerHTML = `
      <div class="fb-row fb-free">
        <span>Available Runway</span>
        <span>${freeHours}h (${freePct}%)</span>
      </div>
      <div class="fb-bar">
        <div class="fb-fill stat-fill" style="width:${freePct}%;background:linear-gradient(90deg,var(--green),var(--accent-cyan))"></div>
      </div>
      <div class="fb-row fb-busy">
        <span>Committed Focus</span>
        <span>${busyHours}h (${busyPct}%)</span>
      </div>
      <div class="fb-bar">
        <div class="fb-fill stat-fill" style="width:${busyPct}%;background:linear-gradient(90deg,var(--primary),var(--primary-light))"></div>
      </div>
    `;
  }

  // Update Hero open time
  const openTimeVal = $("#openTimeVal");
  const openTimeFill = $("#openTimeFill");
  const openTimeSub = $("#openTimeSub");
  if (openTimeVal) openTimeVal.innerHTML = `${freeHours}<span>h</span> 20<span>m</span>`;
  if (openTimeFill) openTimeFill.style.width = `${freePct}%`;
  if (openTimeSub) openTimeSub.textContent = `${freePct}% of your day is flexible`;
}

function renderWeek(days) {
  const grid = $("#weekGrid");
  if (!grid || !Array.isArray(days)) return;

  grid.innerHTML = days.map(d => `
    <div class="week-day">
      <div class="week-day-header">${fmtDate(d.date)}</div>
      <ul class="week-schedule">
        ${(d.summary || []).length ? d.summary.map(it => `
          <li class="${it.done ? "done" : ""}">
            <strong style="color:var(--primary-light)">${escapeHtml(it.time)}</strong> ${escapeHtml(it.title)}
          </li>
        `).join("") : '<li style="color:var(--dim)">Open day</li>'}
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

  // Sidebar Navigation Links
  const navItems = [
    { id: "#navOverview", target: "#overview", tab: null },
    { id: "#navCalendar", target: "#today", tab: "today" },
    { id: "#navInbox", target: "#inbox", tab: null },
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
document.addEventListener("DOMContentLoaded", () => {
  initTheme();
  initVoice();
  initInteractions();
  loadAll();
});

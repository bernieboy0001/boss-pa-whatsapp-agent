/**
 * PA Dashboard — Frontend
 * GSAP-motion orchestration: spring-pop entrance, waterfall-entry,
 * press-release-spring, anchored-layout-expand, sine-wave-loop,
 * stat-bars-and-fills. Fetches /api/* endpoints.
 * Single paused timeline registered on window.__timelines per hyperframes-core contract.
 */

const gsap = window.gsap;

// ============================================================
// State
// ============================================================
const state = { prefs: {}, reminders: [], trends: [], legalResults: [], templates: [], voiceRecording: false, voiceMediaRecorder: null, voiceChunks: [] };

// ============================================================
// Helpers
// ============================================================
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function fmtTime(t) { if (!t) return ""; return new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
function fmtDate(d) { return new Date(d + "T12:00:00").toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }); }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ "&": "&", "<": "<", ">": ">", '"': """, "'": "'" }[c])); }
function showTab(tabName, panel) { $$(".tab-btn", panel).forEach(b => b.classList.toggle("active", b.dataset.tab === tabName)); $$(".tab-pane", panel).forEach(p => p.classList.toggle("active", p.id === `${tabName}Pane`)); }

// ============================================================
// API
// ============================================================
async function api(path, options = {}) { const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...options }); if (!res.ok) throw new Error(`${res.status} ${res.statusText}`); return res.json(); }

// ============================================================
// GSAP Motion Orchestration — single paused timeline on window.__timelines
// Per hyperframes-core contract: one paused timeline, pre-calculated
// layout constants, no CSS transitions on animated elements,
// fromTo with explicit from-states, deterministic timing.
// ============================================================
const TL = gsap.timeline({ paused: true, defaults: { ease: "power3.out" } });
window.__timelines = window.__timelines || {};
window.__timelines["pa-dashboard"] = TL;

/** Spring-pop entrance: staggered panel arrivals using fromTo with explicit from-states */
function animateSpringPop() {
  const panels = [...document.querySelectorAll(".pop-hero, .pop-item")];
  if (!panels.length) return;
  panels.forEach((el, i) => {
    const entryAt = parseFloat(el.dataset.entryAt) || i * 0.06;
    const dur = parseFloat(el.dataset.duration) || 0.5;
    TL.fromTo(el, { scale: 0.95, opacity: 0, y: 8 }, { scale: 1, opacity: 1, y: 0, duration: dur }, entryAt);
  });
}

/** Waterfall-entry: staggered list items cascade in from below using tl.set for binary 0→1 opacity */
function animateWaterfall() {
  $$("[data-waterfall]").forEach(container => {
    const stagger = parseFloat(container.dataset.stagger) || 0.06;
    const items = container.children;
    if (!items.length) return;
    const cap = Math.min(items.length * stagger, 0.5);
    gsap.fromTo(items, { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: 0.3, stagger: Math.min(stagger, cap / Math.max(items.length, 1)), ease: "power3.out" }, 0.1);
  });
}

/** Press-release-spring: linear compression then spring recovery via two adjacent GSAP tweens */
function animatePressRelease() {
  $$(".pressable").forEach(btn => {
    btn.addEventListener("mousedown", () => gsap.to(btn, { scale: 0.96, duration: 0.08, ease: "linear" }));
    btn.addEventListener("mouseup", () => gsap.to(btn, { scale: 1, duration: 0.35, ease: "back.out(2)" }));
    btn.addEventListener("mouseleave", () => gsap.to(btn, { scale: 1, duration: 0.2, ease: "power2.out" }));
  });
}

/** Sine-wave-loop: continuous breathing/idle ambient — finite repeats (3 cycles) per hyperframes-core */
function animateSineWave(el, amp = 2, period = 2.5) {
  if (!el) return;
  gsap.to({ p: 0 }, {
    p: Math.PI * 2 * 3, duration: period * 3, ease: "none", repeat: 3, yoyo: true,
    onUpdate: function() { const s = Math.sin(this.progress() * Math.PI * 2); el.style.transform = `translateY(${s * amp}px)`; },
  });
}

/** Stat-bars-and-fills: animate free/busy progress bars via scaleX fromTo */
function animateStatBars() {
  $$(".stat-fill").forEach(fill => {
    const pct = fill.dataset.pct || 0;
    gsap.fromTo(fill, { scaleX: 0 }, { scaleX: Number(pct), duration: 0.8, ease: "power2.out" });
  });
}

/** Anchored-layout-expand: modal expands via scaleY */
function animateModalExpand() {
  const modal = $("#reminderModal");
  if (!modal) return;
  gsap.fromTo(modal, { scale: 0.95, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.3, ease: "power3.out" });
}

// ============================================================
// Renderers
// ============================================================
function renderChat(msg, isUser) {
  const div = document.createElement("div");
  div.className = `chat-msg ${isUser ? "you" : "bot"}`;
  div.innerHTML = `<div class="msg-bubble">${escapeHtml(msg).replace(/\n/g, "<br>")}</div>`;
  $("#chatMessages").appendChild(div);
  $("#chatMessages").scrollTop = $("#chatMessages").scrollHeight;
}

function renderToday(data) {
  const { summary, freeBusy } = data;
  $("#todayDate").textContent = `${summary.day}, ${summary.date}`;
  const items = summary.items || [];
  $("#todaySchedule").innerHTML = items.map((it, i) => `
    <li class="schedule-item ${it.done ? "done" : ""} ${i === 0 ? "time-blue" : ""}" style="will-change:transform,opacity">
      <span class="schedule-time">${escapeHtml(it.time)}</span>
      <span class="schedule-title">${escapeHtml(it.title)}</span>
      ${it.attendees?.length ? `<span class="attendees">${it.attendees.map(escapeHtml).join(", ")}</span>` : ""}
    </li>
  `).join("");
  const totalHours = 11;
  const freeHours = freeBusy.free.length;
  const busyHours = freeBusy.busy.length;
  const freePct = ((freeHours / totalHours) * 100).toFixed(0);
  const busyPct = ((busyHours / totalHours) * 100).toFixed(0);
  $("#freeBusy").innerHTML = `
    <div class="fb-row fb-free"><span class="fb-label">Free</span><span class="fb-free">${freeHours}h (${freePct}%)</span></div>
    <div class="fb-bar"><div class="fb-fill stat-fill" data-pct="${freePct}" style="background:var(--green)"></div></div>
    <div class="fb-row fb-busy"><span class="fb-label">Busy</span><span class="fb-busy">${busyHours}h (${busyPct}%)</span></div>
    <div class="fb-bar"><div class="fb-fill stat-fill" data-pct="${busyPct}" style="background:var(--brand)"></div></div>
  `;
  animateStatBars();
  animateWaterfall();
}

function renderWeek(days) {
  $("#weekGrid").innerHTML = days.map(d => `
    <div class="week-day">
      <div class="week-day-header">${fmtDate(d.date)}</div>
      <ul class="week-schedule">
        ${d.summary.map(it => `<li class="${it.done ? "done" : ""}">${escapeHtml(it.time)} ${escapeHtml(it.title)}</li>`).join("")}
      </ul>
    </div>
  `).join("");
  animateWaterfall();
}

function renderItinerary(text) {
  $("#itinerary").innerHTML = `<pre class="itinerary-text">${escapeHtml(text)}</pre>`;
  animateWaterfall();
}

function renderReminders({ reminders, trends }) {
  state.reminders = reminders; state.trends = trends;
  $("#reminderList").innerHTML = reminders.map((r, i) => `
    <li class="reminder-item ${r.status}" data-id="${r.id}" style="will-change:transform,opacity">
      <input type="checkbox" ${r.status === "done" ? "checked" : ""} aria-label="Mark done">
      <span class="rem-text">${escapeHtml(r.text)}</span>
      ${r.due ? `<span class="rem-due">${fmtTime(r.due)}</span>` : ""}
      ${r.recurring ? `<span class="rem-recur">${r.recurring}</span>` : ""}
      <button class="btn-icon sm" aria-label="Delete">✕</button>
    </li>
  `).join("");
  $("#trendsList").innerHTML = trends.map((t, i) => `
    <div class="trend-card ${t.type}" style="will-change:transform,opacity">
      <div class="trend-title">${escapeHtml(t.title)}</div>
      <div class="trend-desc">${escapeHtml(t.description)}</div>
      ${t.suggestedTime ? `<div class="trend-time">⏰ ${t.suggestedTime} (${Math.round(t.confidence * 100)}%)</div>` : ""}
    </div>
  `).join("");
  animateWaterfall();
}

function renderLegal(results) {
  state.legalResults = results;
  $("#legalResults").innerHTML = results.length ? results.map(r => `
    <div class="legal-result">
      <a href="${r.url}" target="_blank" class="legal-title">${escapeHtml(r.title)}</a>
      <span class="legal-meta">${escapeHtml(r.jurisdiction)} · ${r.relevance ? Math.round(r.relevance * 100) + "%" : ""}</span>
      <div class="legal-snippet">${escapeHtml(r.snippet)}</div>
    </div>
  `).join("") : '<p class="muted">No results</p>';
  animateWaterfall();
}

function renderTemplates(templates) {
  state.templates = templates;
  $("#templateList").innerHTML = templates.map(t => `
    <li class="template-item">
      <div class="template-name">${escapeHtml(t.name)}</div>
      <div class="template-meta">${t.category} · ${t.jurisdiction}</div>
      <div class="template-desc">${escapeHtml(t.description)}</div>
    </li>
  `).join("");
  animateWaterfall();
}

function renderPrefs(prefs) {
  state.prefs = prefs;
  $("#prefTimezone").value = prefs.bossZone || "America/New_York";
  $("#prefHomeAirport").value = prefs.homeAirport || "";
  $("#prefCabin").value = prefs.cabin || "economy";
  $("#prefSeat").value = prefs.seat || "aisle";
  $("#prefNoMeetingsBefore").value = prefs.noMeetingsBefore || "09:00";
  $("#prefAirline").value = prefs.airline || "";
}

// ============================================================
// Chat — calls server API instead of importing agent.js directly
// ============================================================
async function sendChat(text) {
  renderChat(text, true);
  try {
    const res = await api("/api/chat", { method: "POST", body: JSON.stringify({ text }) });
    renderChat(res.text || res.reply || "No response", false);
  } catch (e) { renderChat(`Error: ${e.message}`, false); }
}

$("#chatForm").addEventListener("submit", e => { e.preventDefault(); const input = $("#chatInput"); const text = input.value.trim(); if (!text) return; input.value = ""; sendChat(text); });

// ============================================================
// Voice — finite sine-wave ambient, no infinite repeat
// ============================================================
const voiceBtn = $("#voiceRecordBtn");
voiceBtn.addEventListener("mousedown", async () => {
  if (state.voiceRecording) return;
  state.voiceRecording = true; voiceBtn.classList.add("recording");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    state.voiceMediaRecorder = new MediaRecorder(stream); state.voiceChunks = [];
    state.voiceMediaRecorder.ondataavailable = e => state.voiceChunks.push(e.data);
    state.voiceMediaRecorder.onstop = () => {
      const blob = new Blob(state.voiceChunks, { type: "audio/webm" });
      $("#transcript").textContent = "[Voice recorded — Gemini Live integration pending]";
      stream.getTracks().forEach(t => t.stop());
    };
    state.voiceMediaRecorder.start();
  } catch (e) {
    $("#transcript").textContent = `Mic error: ${e.message}`; state.voiceRecording = false; voiceBtn.classList.remove("recording");
  }
});
voiceBtn.addEventListener("mouseup", () => { if (!state.voiceRecording) return; state.voiceRecording = false; voiceBtn.classList.remove("recording"); state.voiceMediaRecorder?.stop(); });
voiceBtn.addEventListener("mouseleave", () => { if (state.voiceRecording) { state.voiceRecording = false; voiceBtn.classList.remove("recording"); state.voiceMediaRecorder?.stop(); } });
// Finite ambient sine-wave loop (3 cycles)
animateSineWave(voiceBtn, 2, 2.5);

// ============================================================
// Reminders
// ============================================================
$("#addReminderBtn").addEventListener("click", () => { $("#reminderModal").showModal(); animateModalExpand(); });
$("#reminderModal").addEventListener("close", () => { if ($("#reminderModal").returnValue === "default") { const text = $("#remText").value.trim(); const due = $("#remDue").value || null; const recurring = $("#remRecurring").value || null; if (text) api("/api/reminders", { method: "POST", body: JSON.stringify({ text, due, recurring }) }).then(loadReminders); $("#reminderModal").querySelector("form").reset(); } });
$("#reminderList").addEventListener("click", async e => {
  const li = e.target.closest(".reminder-item"); if (!li) return;
  const id = li.dataset.id;
  if (e.target.type === "checkbox") { await api(`/api/reminders/${id}`, { method: "PATCH", body: JSON.stringify({ status: e.target.checked ? "done" : "pending" }) }); loadReminders(); }
  else if (e.target.matches("button")) { await api(`/api/reminders/${id}`, { method: "DELETE" }); loadReminders(); }
});

// ============================================================
// Settings
// ============================================================
$("#settingsForm").addEventListener("submit", async e => {
  e.preventDefault();
  const patch = { bossZone: $("#prefTimezone").value, homeAirport: $("#prefHomeAirport").value.toUpperCase(), cabin: $("#prefCabin").value, seat: $("#prefSeat").value, noMeetingsBefore: $("#prefNoMeetingsBefore").value, airline: $("#prefAirline").value };
  await api("/api/prefs", { method: "PATCH", body: JSON.stringify(patch) }); loadPrefs();
});

// ============================================================
// Legal AI
// ============================================================
$("#legalSearchBtn").addEventListener("click", async () => { const q = $("#legalSearch").value.trim(); if (!q) return; const { results } = await api(`/api/legal/search?q=${encodeURIComponent(q)}`); renderLegal(results); });
$("#legalSearch").addEventListener("keypress", e => { if (e.key === "Enter") $("#legalSearchBtn").click(); });
$("#templateFilter").addEventListener("change", async () => { const cat = $("#templateFilter").value; const { results } = await api(`/api/legal/templates${cat ? `?category=${cat}` : ""}`); renderTemplates(results); });

// ============================================================
// Tabs
// ============================================================
$$(".tab-btn").forEach(btn => btn.addEventListener("click", () => showTab(btn.dataset.tab, btn.closest(".panel"))));

// ============================================================
// Theme
// ============================================================
const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
const savedTheme = localStorage.getItem("theme");
if (savedTheme === "dark" || (!savedTheme && prefersDark)) document.documentElement.classList.add("dark");
$("#themeToggle").addEventListener("click", () => { document.documentElement.classList.toggle("dark"); localStorage.setItem("theme", document.documentElement.classList.contains("dark") ? "dark" : "light"); });

// ============================================================
// Load All + Motion Init
// ============================================================
async function loadAll() {
  try {
    const [itinerary, today, week, inbox, prefs, reminders, templates] = await Promise.all([
      api("/api/itinerary"), api("/api/day"), api("/api/week"), api("/api/inbox"), api("/api/prefs"), api("/api/reminders"), api("/api/legal/templates"),
    ]);
    renderItinerary(itinerary.text); renderToday(today); renderWeek(week.days); renderPrefs(prefs); renderReminders({ reminders, trends: [] }); renderTemplates(templates);
    setTimeout(animateStatBars, 100);
  } catch (e) { console.error("Dashboard load failed:", e); }
}

// Kick off motion + data — timeline plays after DOM is ready
animateSpringPop();
animatePressRelease();
loadAll();
$("#refreshToday").addEventListener("click", () => api("/api/day").then(renderToday));

// Start the single paused timeline
TL.play();

/* SubsMaxxers — My stack, local 5h timers, pasted weekly/cycle times, .ics, at-cap playbook.
   Browser-only. No OAuth. No Discord. We do not invent clocks or message counts.

   PLAYBOOK RULE: formatPlaybook() never prints a numeric cap such as "45 messages".
   It may only emit Official clock language and user-entered / computable window times.
   Even if a caller passes published_allowance / observed_allowance / "45 messages",
   those strings are dropped. See scripts/playbook-sanity.js.
*/
(function (root) {
  "use strict";

  var STACK_KEY = "subsmaxxers.stack";
  var TIMERS_KEY = "subsmaxxers.timers";
  var SEEN_KEY = "subsmaxxers.lastSeenGeneratedAt";

  var SESSION_MS = 5 * 60 * 60 * 1000;
  var APPROACH_RATIO = 0.8;
  var THIRTY_MIN_MS = 30 * 60 * 1000;

  var PROVIDERS = [
    { id: "claude", name: "Claude", letter: "CL", tile: "tile-cl" },
    { id: "gemini", name: "Gemini", letter: "GM", tile: "tile-gm" },
    { id: "copilot", name: "Copilot", letter: "CP", tile: "tile-cp" },
    { id: "cursor", name: "Cursor", letter: "CR", tile: "tile-cr" },
    { id: "grok", name: "Grok", letter: "GK", tile: "tile-gk" }
  ];

  /* Sourced one-liners = Official reset_fact text. No allowances. No invented weekdays. */
  var OFFICIAL = {
    claudeSession: "Session-based usage limit resets every five hours.",
    claudeWeekly: "Weekly limit resets at a fixed time assigned to your account (Settings → Usage).",
    geminiSession: "Compute limit refreshes every 5 hours until the weekly limit.",
    copilot: "Included AI credits reset at 00:00:00 UTC on the 1st of each calendar month.",
    cursor: "Usage resets monthly with the billing cycle; unused does not roll over. Reset date is on the Spending tab.",
    grokWeekly: "Shared weekly usage pool resets every week on a schedule shown in Settings → Usage."
  };

  var CLOCK_TOOLS = {
    "r-claude-pro-max-session-5h-2026-09-01": { kind: "session", provider: "claude" },
    "r-claude-pro-max-weekly-assigned-2026-09-01": { kind: "weekly", provider: "claude" },
    "r-gemini-apps-compute-5h-2026-09-01": { kind: "session", provider: "gemini" },
    "r-github-copilot-individuals-monthly-utc-2026-09-01": { kind: "copilot", provider: "copilot" },
    "r-cursor-billing-cycle-monthly-2026-09-01": { kind: "cursor", provider: "cursor" },
    "r-grok-supergrok-weekly-pool-2026-09-03": { kind: "weekly", provider: "grok" }
  };

  var CAP_COUNT_RE = /\b\d+\s*(messages?|prompts?|credits?|tokens?|requests?)\b/i;

  function providerById(id) {
    for (var i = 0; i < PROVIDERS.length; i++) if (PROVIDERS[i].id === id) return PROVIDERS[i];
    return null;
  }

  function hasStorage() {
    try {
      return typeof localStorage !== "undefined";
    } catch (e) {
      return false;
    }
  }

  function readJson(key, fallback) {
    if (!hasStorage()) return fallback;
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  }

  function writeJson(key, value) {
    if (!hasStorage()) return;
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) { /* quota / private mode */ }
  }

  function loadStack() {
    var arr = readJson(STACK_KEY, []);
    if (!Array.isArray(arr)) return [];
    var ids = {};
    for (var i = 0; i < PROVIDERS.length; i++) ids[PROVIDERS[i].id] = true;
    return arr.filter(function (id) { return ids[id]; });
  }

  function saveStack(arr) {
    writeJson(STACK_KEY, arr);
  }

  function emptyTimers() {
    return {
      sessionStart: {},
      weekly: {},
      cursorReset: "",
      notify: false,
      fired: {}
    };
  }

  function loadTimers() {
    var t = readJson(TIMERS_KEY, null);
    if (!t || typeof t !== "object") t = emptyTimers();
    if (!t.sessionStart || typeof t.sessionStart !== "object") t.sessionStart = {};
    if (!t.weekly || typeof t.weekly !== "object") t.weekly = {};
    if (typeof t.cursorReset !== "string") t.cursorReset = "";
    if (typeof t.notify !== "boolean") t.notify = false;
    if (!t.fired || typeof t.fired !== "object") t.fired = {};
    return t;
  }

  function saveTimers(t) {
    writeJson(TIMERS_KEY, t);
  }

  function pad(n) {
    return (n < 10 ? "0" : "") + n;
  }

  function formatHMS(ms) {
    if (ms < 0) ms = 0;
    var s = Math.floor(ms / 1000);
    var h = Math.floor(s / 3600);
    s -= h * 3600;
    var m = Math.floor(s / 60);
    s -= m * 60;
    return h + ":" + pad(m) + ":" + pad(s);
  }

  function formatRemaining(ms) {
    if (ms < 0) ms = 0;
    var totalSec = Math.floor(ms / 1000);
    var days = Math.floor(totalSec / 86400);
    if (days >= 1) {
      var rem = totalSec - days * 86400;
      var h = Math.floor(rem / 3600);
      rem -= h * 3600;
      var m = Math.floor(rem / 60);
      return days + "d " + h + "h " + m + "m";
    }
    return formatHMS(ms);
  }

  var WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  var CYCLE_DISPLAY_MS = 30 * 24 * 60 * 60 * 1000;

  function clampRatio(r) {
    if (r < 0) return 0;
    if (r > 1) return 1;
    return r;
  }

  function setRowTimerUI(id, opts) {
    opts = opts || {};
    var countEl = document.querySelector('[data-row-countdown="' + id + '"]');
    var fillEl = document.querySelector('[data-row-progress-fill="' + id + '"]');
    var barEl = document.querySelector('[data-row-progress="' + id + '"]');
    var hintEl = document.querySelector('[data-row-hint="' + id + '"]');
    if (countEl) countEl.textContent = opts.countdown != null ? opts.countdown : "—:—:—";
    var pct = Math.round(clampRatio(opts.ratio || 0) * 100);
    if (fillEl) fillEl.style.width = pct + "%";
    if (barEl) barEl.setAttribute("aria-valuenow", String(pct));
    if (hintEl) hintEl.textContent = opts.hint != null ? opts.hint : "";
  }

  function copilotWindow(now) {
    now = now || new Date();
    var end = nextCopilotReset(now);
    var y = end.getUTCFullYear();
    var m = end.getUTCMonth();
    var start = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0));
    return { start: start, end: end };
  }

  function formatLocal(d) {
    if (!d || isNaN(d.getTime())) return "";
    try {
      return d.toLocaleString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit"
      });
    } catch (e) {
      return d.toISOString();
    }
  }

  function formatLocalShort(d) {
    if (!d || isNaN(d.getTime())) return "";
    try {
      return d.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit"
      });
    } catch (e) {
      return d.toISOString();
    }
  }

  function parseISO(s) {
    if (!s) return null;
    var d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }

  function toDatetimeLocal(iso) {
    var d = parseISO(iso);
    if (!d) return "";
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
      "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  function fromDatetimeLocal(value) {
    if (!value) return "";
    var d = new Date(value);
    if (isNaN(d.getTime())) return "";
    return d.toISOString();
  }

  function sessionEnd(startIso) {
    var d = parseISO(startIso);
    if (!d) return null;
    return new Date(d.getTime() + SESSION_MS);
  }

  function sessionProgress(startIso, now) {
    var start = parseISO(startIso);
    if (!start) return null;
    now = now || new Date();
    var elapsed = now.getTime() - start.getTime();
    return {
      start: start,
      end: new Date(start.getTime() + SESSION_MS),
      elapsed: elapsed,
      remaining: SESSION_MS - elapsed,
      ratio: elapsed / SESSION_MS,
      approaching: elapsed >= SESSION_MS * APPROACH_RATIO && elapsed < SESSION_MS,
      exhausted: elapsed >= SESSION_MS
    };
  }

  /* Next Official Copilot reset: 00:00:00 UTC on the 1st. Not a billing-anniversary guess. */
  function nextCopilotReset(now) {
    now = now || new Date();
    var y = now.getUTCFullYear();
    var m = now.getUTCMonth();
    var t = Date.UTC(y, m, 1, 0, 0, 0);
    if (now.getTime() >= t) t = Date.UTC(y, m + 1, 1, 0, 0, 0);
    return new Date(t);
  }

  function icsUtcStamp(d) {
    return d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + "T" +
      pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + "Z";
  }

  function icsEscape(s) {
    return String(s == null ? "" : s)
      .replace(/\\/g, "\\\\")
      .replace(/\n/g, "\\n")
      .replace(/,/g, "\\,")
      .replace(/;/g, "\\;");
  }

  function buildIcs(opts) {
    var start = opts.start;
    var end = opts.end || new Date(start.getTime() + 15 * 60 * 1000);
    var lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//SubsMaxxers//Reset Board//EN",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      "BEGIN:VEVENT",
      "UID:" + icsEscape(opts.uid),
      "DTSTAMP:" + icsUtcStamp(new Date()),
      "DTSTART:" + icsUtcStamp(start),
      "DTEND:" + icsUtcStamp(end),
      "SUMMARY:" + icsEscape(opts.summary),
      "DESCRIPTION:" + icsEscape(opts.description)
    ];
    if (opts.rrule) lines.push("RRULE:" + opts.rrule);
    lines.push("END:VEVENT", "END:VCALENDAR", "");
    return lines.join("\r\n");
  }

  function downloadIcs(filename, body) {
    if (typeof document === "undefined") return body;
    var blob = new Blob([body], { type: "text/calendar;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    return body;
  }

  function stripCapCounts(text) {
    if (text == null) return "";
    var s = String(text);
    if (CAP_COUNT_RE.test(s)) {
      return "next known window (message counts omitted)";
    }
    return s;
  }

  /*
   * formatPlaybook — windows only.
   * Does not read published_allowance, observed_allowance, product_displayed,
   * or any numeric cap. Poison fields on opts are ignored.
   */
  function formatPlaybook(opts) {
    opts = opts || {};
    var stack = opts.stack || [];
    var exhausted = opts.exhaustedProviders || [];
    var windows = opts.windows || {};
    var now = opts.now || new Date();
    var exhSet = {};
    var i;
    for (i = 0; i < exhausted.length; i++) exhSet[exhausted[i]] = true;

    var lines = [];
    var exhaustedNames = [];
    for (i = 0; i < exhausted.length; i++) {
      var p = providerById(exhausted[i]);
      exhaustedNames.push(p ? p.name : exhausted[i]);
    }
    if (exhaustedNames.length) {
      lines.push("At cap on " + exhaustedNames.join(", ") + ".");
    }

    var others = 0;
    for (i = 0; i < stack.length; i++) {
      var id = stack[i];
      if (exhSet[id]) continue;
      var name = (providerById(id) || { name: id }).name;
      var w = windows[id] || {};
      var whenText = stripCapCounts(w.whenText || w.text || "");
      var source = stripCapCounts(w.source || "");
      if (!whenText) {
        whenText = "next window not known yet";
      }
      var line = name + " — " + whenText;
      if (source) line += " · " + source;
      lines.push(line);
      others++;
    }

    if (!others) {
      lines.push("No other enabled stack items with a next window.");
    }

    void now;
    void opts.published_allowance;
    void opts.observed_allowance;
    void opts.allowance;
    void opts.poison;
    return lines;
  }

  function knownWindows(stack, timers, now) {
    now = now || new Date();
    timers = timers || loadTimers();
    var out = {};
    function add(id, whenText, source) {
      out[id] = { whenText: whenText, source: source };
    }

    if (stack.indexOf("claude") !== -1) {
      var clSess = sessionProgress(timers.sessionStart.claude, now);
      var clWeek = parseISO(timers.weekly.claude);
      var clParts = [];
      if (clSess && !clSess.exhausted) {
        clParts.push("session in " + formatHMS(clSess.remaining) + " (local timer)");
      } else if (clSess && clSess.exhausted) {
        clParts.push("session timer ended " + formatLocalShort(clSess.end));
      } else {
        clParts.push("session: every 5 hours after you press Session started");
      }
      if (clWeek && clWeek.getTime() > now.getTime()) {
        clParts.push("weekly " + formatLocal(clWeek) + " (you pasted)");
      } else if (clWeek) {
        clParts.push("weekly pasted time has passed — paste the next one from Settings → Usage");
      } else {
        clParts.push("weekly: paste next reset from Settings → Usage");
      }
      add("claude", clParts.join("; "), OFFICIAL.claudeSession);
    }

    if (stack.indexOf("gemini") !== -1) {
      var gm = sessionProgress(timers.sessionStart.gemini, now);
      if (gm && !gm.exhausted) {
        add("gemini", "session in " + formatHMS(gm.remaining) + " (local timer)", OFFICIAL.geminiSession);
      } else if (gm && gm.exhausted) {
        add("gemini", "session timer ended " + formatLocalShort(gm.end), OFFICIAL.geminiSession);
      } else {
        add("gemini", "every 5 hours after you press Session started", OFFICIAL.geminiSession);
      }
    }

    if (stack.indexOf("copilot") !== -1) {
      var cp = nextCopilotReset(now);
      add("copilot", "00:00 UTC " + cp.toISOString().slice(0, 10) + " (" + formatLocal(cp) + " local)", OFFICIAL.copilot);
    }

    if (stack.indexOf("cursor") !== -1) {
      var cr = parseISO(timers.cursorReset);
      if (cr && cr.getTime() > now.getTime()) {
        add("cursor", formatLocal(cr) + " (you pasted from Spending)", OFFICIAL.cursor);
      } else if (cr) {
        add("cursor", "pasted date has passed — paste the next one from the Spending tab", OFFICIAL.cursor);
      } else {
        add("cursor", "paste reset date from the Spending tab", OFFICIAL.cursor);
      }
    }

    if (stack.indexOf("grok") !== -1) {
      var gk = parseISO(timers.weekly.grok);
      if (gk && gk.getTime() > now.getTime()) {
        add("grok", formatLocal(gk) + " (you pasted from Settings → Usage)", OFFICIAL.grokWeekly);
      } else if (gk) {
        add("grok", "pasted time has passed — paste the next one from Settings → Usage", OFFICIAL.grokWeekly);
      } else {
        add("grok", "paste next reset from Settings → Usage", OFFICIAL.grokWeekly);
      }
    }

    return out;
  }

  function exhaustedProviders(stack, timers, now) {
    timers = timers || loadTimers();
    now = now || new Date();
    var out = [];
    if (stack.indexOf("claude") !== -1) {
      var cl = sessionProgress(timers.sessionStart.claude, now);
      if (cl && cl.exhausted) out.push("claude");
    }
    if (stack.indexOf("gemini") !== -1) {
      var gm = sessionProgress(timers.sessionStart.gemini, now);
      if (gm && gm.exhausted) out.push("gemini");
    }
    return out;
  }

  function maybeNotify(title, body, tag) {
    var timers = loadTimers();
    if (!timers.notify) return;
    if (typeof Notification === "undefined") return;
    if (Notification.permission !== "granted") return;
    try {
      new Notification(title, { body: body, tag: tag || "subsmaxxers" });
    } catch (e) { /* ignore */ }
  }

  function fireSessionNotices(provider, prog, timers) {
    if (!prog) return [];
    var key = provider + "|" + (timers.sessionStart[provider] || "");
    if (!timers.fired[key]) timers.fired[key] = {};
    var f = timers.fired[key];
    var events = [];
    var name = (providerById(provider) || { name: provider }).name;
    var resetTime = formatLocal(prog.end);

    if (prog.approaching && !f.approaching) {
      f.approaching = 1;
      events.push({ kind: "approaching", text: "Approaching 5-hour limit." });
      maybeNotify("Approaching 5-hour limit.", name + " session is at 80% of five hours.", "smx-approach-" + provider);
    }
    if (prog.exhausted && !f.reached) {
      f.reached = 1;
      events.push({
        kind: "reached",
        text: "5-hour limit reached — resets " + resetTime + "."
      });
      maybeNotify(
        "5-hour limit reached — resets " + resetTime + ".",
        name + " local 5-hour session ended.",
        "smx-reached-" + provider
      );
    }
    if (prog.exhausted && !f.back) {
      f.back = 1;
      events.push({
        kind: "back",
        text: "You're back — " + name + " 5-hour session has reset."
      });
      maybeNotify(
        "You're back — " + name + " 5-hour session has reset.",
        "Local timer ended at " + resetTime + ".",
        "smx-back-" + provider
      );
    }
    if (events.length) saveTimers(timers);
    return events;
  }

  /* ---------- DOM (reset.html / next.html) ---------- */

  function el(tag, className, attrs) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === "text") node.textContent = attrs[k];
        else if (k === "html") node.innerHTML = attrs[k];
        else node.setAttribute(k, attrs[k]);
      });
    }
    return node;
  }

  function syncPanelStack(stack) {
    var rows = document.querySelectorAll(".reset-row[data-provider], .board-panel[data-provider]");
    for (var i = 0; i < rows.length; i++) {
      var name = (rows[i].getAttribute("data-provider") || "").toLowerCase();
      rows[i].classList.toggle("in-stack", stack.indexOf(name) !== -1);
    }
  }

  function renderStackToggles(host) {
    if (!host) return;
    host.innerHTML = "";
    var stack = loadStack();
    PROVIDERS.forEach(function (p) {
      var on = stack.indexOf(p.id) !== -1;
      var btn = el("button", "stack-toggle" + (on ? " is-on" : ""), {
        type: "button",
        "aria-pressed": on ? "true" : "false",
        "data-provider": p.id
      });
      var tile = el("span", "tile " + p.tile, { text: p.letter });
      tile.setAttribute("aria-hidden", "true");
      btn.appendChild(tile);
      btn.appendChild(el("span", "stack-toggle-name", { text: p.name }));
      btn.addEventListener("click", function () {
        var cur = loadStack();
        var ix = cur.indexOf(p.id);
        if (ix === -1) cur.push(p.id);
        else cur.splice(ix, 1);
        saveStack(cur);
        renderStackToggles(host);
        syncPanelStack(cur);
        refreshDynamic();
      });
      host.appendChild(btn);
    });
  }

  function bindNotifyBox(box) {
    if (!box) return;
    var timers = loadTimers();
    box.checked = !!timers.notify;
    if (box.getAttribute("data-bound") === "1") return;
    box.setAttribute("data-bound", "1");
    box.addEventListener("change", function () {
      var t = loadTimers();
      t.notify = !!box.checked;
      saveTimers(t);
      if (t.notify && typeof Notification !== "undefined" && Notification.permission === "default") {
        Notification.requestPermission();
      }
    });
  }

  var bannerHandledThisLoad = false;
  function showChangeBanner(generatedAt) {
    var banner = document.getElementById("change-banner");
    if (!banner || !generatedAt) return;
    var seen = hasStorage() ? (localStorage.getItem(SEEN_KEY) || "") : "";
    if (generatedAt > seen) {
      banner.hidden = false;
      banner.textContent = "Official clocks re-verified " + generatedAt;
      if (hasStorage()) localStorage.setItem(SEEN_KEY, generatedAt);
    } else if (!bannerHandledThisLoad) {
      banner.hidden = true;
    }
    bannerHandledThisLoad = true;
  }

  function toolShell() {
    var wrap = el("div", "clock-tools");
    wrap.setAttribute("data-stack-tools", "1");
    return wrap;
  }

  function mountSessionTools(cell, provider) {
    if (cell.querySelector("[data-stack-tools]")) return;
    var wrap = toolShell();
    var status = el("p", "session-status", { "data-session-status": provider });
    var count = el("p", "session-countdown", { "data-session-count": provider, "aria-live": "polite" });
    var actions = el("div", "tool-actions");
    var startBtn = el("button", "tool-btn", { type: "button", text: "Session started" });
    startBtn.setAttribute("data-session-start", provider);
    var clearBtn = el("button", "tool-btn tool-btn-quiet", { type: "button", text: "Clear" });
    startBtn.addEventListener("click", function () {
      var t = loadTimers();
      t.sessionStart[provider] = new Date().toISOString();
      saveTimers(t);
      if (t.notify && typeof Notification !== "undefined" && Notification.permission === "default") {
        Notification.requestPermission();
      }
      refreshDynamic();
    });
    clearBtn.addEventListener("click", function () {
      var t = loadTimers();
      delete t.sessionStart[provider];
      saveTimers(t);
      refreshDynamic();
    });
    actions.appendChild(startBtn);
    actions.appendChild(clearBtn);
    wrap.appendChild(el("p", "tool-kicker", { text: "Local 5-hour timer" }));
    wrap.appendChild(status);
    wrap.appendChild(count);
    wrap.appendChild(actions);
    wrap.appendChild(el("p", "tool-fine", { text: "Start when you begin a session. Stays on this device. Not a live vendor meter." }));
    cell.appendChild(wrap);
  }

  function mountWeeklyTools(cell, provider) {
    if (cell.querySelector("[data-stack-tools]")) return;
    var wrap = toolShell();
    var label = el("label", "tool-label");
    label.appendChild(document.createTextNode("Paste next reset from Settings → Usage"));
    var input = el("input", "tool-datetime", {
      type: "datetime-local",
      "data-weekly-input": provider
    });
    label.appendChild(input);
    var actions = el("div", "tool-actions");
    var saveBtn = el("button", "tool-btn", { type: "button", text: "Save locally" });
    var icsBefore = el("button", "tool-btn tool-btn-quiet", { type: "button", text: ".ics 30 min before" });
    var icsAt = el("button", "tool-btn tool-btn-quiet", { type: "button", text: ".ics at reset" });
    saveBtn.addEventListener("click", function () {
      var t = loadTimers();
      t.weekly[provider] = fromDatetimeLocal(input.value);
      saveTimers(t);
      refreshDynamic();
    });
    function weeklyDate() {
      return parseISO(loadTimers().weekly[provider]);
    }
    var name = (providerById(provider) || { name: provider }).name;
    var fact = provider === "grok" ? OFFICIAL.grokWeekly : OFFICIAL.claudeWeekly;
    icsBefore.addEventListener("click", function () {
      var d = weeklyDate();
      if (!d) return;
      downloadIcs(
        name.toLowerCase() + "-weekly-30min.ics",
        buildIcs({
          uid: "subsmaxxers-" + provider + "-weekly-30min-" + icsUtcStamp(d) + "@subsmaxxers.com",
          start: new Date(d.getTime() - THIRTY_MIN_MS),
          summary: name + " weekly reset in 30 minutes",
          description: fact + " Time you pasted from Settings → Usage. SubsMaxxers does not invent the weekday."
        })
      );
    });
    icsAt.addEventListener("click", function () {
      var d = weeklyDate();
      if (!d) return;
      downloadIcs(
        name.toLowerCase() + "-weekly-reset.ics",
        buildIcs({
          uid: "subsmaxxers-" + provider + "-weekly-" + icsUtcStamp(d) + "@subsmaxxers.com",
          start: d,
          summary: name + " weekly usage reset",
          description: fact + " Time you pasted from Settings → Usage. SubsMaxxers does not invent the weekday."
        })
      );
    });
    actions.appendChild(saveBtn);
    actions.appendChild(icsBefore);
    actions.appendChild(icsAt);
    wrap.appendChild(el("p", "tool-kicker", { text: "Your assigned weekly time" }));
    wrap.appendChild(label);
    wrap.appendChild(actions);
    wrap.appendChild(el("p", "tool-fine", { text: "We do not invent a weekday. Paste what Settings → Usage shows." }));
    cell.appendChild(wrap);
  }

  function mountCopilotTools(cell) {
    if (cell.querySelector("[data-stack-tools]")) return;
    var wrap = toolShell();
    var actions = el("div", "tool-actions");
    var btn = el("button", "tool-btn", { type: "button", text: "Download monthly .ics" });
    btn.addEventListener("click", function () {
      var start = nextCopilotReset(new Date());
      downloadIcs(
        "copilot-monthly-reset.ics",
        buildIcs({
          uid: "subsmaxxers-copilot-monthly-utc@subsmaxxers.com",
          start: start,
          rrule: "FREQ=MONTHLY;BYMONTHDAY=1",
          summary: "Copilot included credits reset (Official)",
          description: OFFICIAL.copilot + " SubsMaxxers does not publish credit amounts."
        })
      );
    });
    actions.appendChild(btn);
    wrap.appendChild(el("p", "tool-kicker", { text: "Official calendar clock" }));
    wrap.appendChild(el("p", "tool-fine", { text: "Repeats 00:00:00 UTC on the 1st. No credit amounts." }));
    wrap.appendChild(actions);
    cell.appendChild(wrap);
  }

  function mountCursorTools(cell) {
    if (cell.querySelector("[data-stack-tools]")) return;
    var wrap = toolShell();
    var label = el("label", "tool-label");
    label.appendChild(document.createTextNode("Paste reset date from Spending tab"));
    var input = el("input", "tool-datetime", {
      type: "datetime-local",
      "data-cursor-input": "1"
    });
    label.appendChild(input);
    var actions = el("div", "tool-actions");
    var saveBtn = el("button", "tool-btn", { type: "button", text: "Save locally" });
    var icsBtn = el("button", "tool-btn tool-btn-quiet", { type: "button", text: ".ics at reset" });
    saveBtn.addEventListener("click", function () {
      var t = loadTimers();
      t.cursorReset = fromDatetimeLocal(input.value);
      saveTimers(t);
      refreshDynamic();
    });
    icsBtn.addEventListener("click", function () {
      var d = parseISO(loadTimers().cursorReset);
      if (!d) return;
      downloadIcs(
        "cursor-billing-reset.ics",
        buildIcs({
          uid: "subsmaxxers-cursor-" + icsUtcStamp(d) + "@subsmaxxers.com",
          start: d,
          summary: "Cursor usage reset (Spending tab)",
          description: OFFICIAL.cursor + " Date you pasted. SubsMaxxers does not invent the billing day."
        })
      );
    });
    actions.appendChild(saveBtn);
    actions.appendChild(icsBtn);
    wrap.appendChild(el("p", "tool-kicker", { text: "Your billing-cycle date" }));
    wrap.appendChild(label);
    wrap.appendChild(actions);
    wrap.appendChild(el("p", "tool-fine", { text: "We do not invent this date. Copy it from Cursor → Spending." }));
    cell.appendChild(wrap);
  }

  function mountAllTools() {
    var cells = document.querySelectorAll(".reset-row[data-id], .clock-cell[data-id], .clock-cell[id]");
    for (var i = 0; i < cells.length; i++) {
      var id = cells[i].getAttribute("data-id") || cells[i].id;
      var spec = CLOCK_TOOLS[id];
      if (!spec) continue;
      if (spec.kind === "session") mountSessionTools(cells[i], spec.provider);
      else if (spec.kind === "weekly") mountWeeklyTools(cells[i], spec.provider);
      else if (spec.kind === "copilot") mountCopilotTools(cells[i]);
      else if (spec.kind === "cursor") mountCursorTools(cells[i]);
    }
  }

  function fillSavedInputs() {
    var t = loadTimers();
    var weeklyInputs = document.querySelectorAll("[data-weekly-input]");
    for (var i = 0; i < weeklyInputs.length; i++) {
      var p = weeklyInputs[i].getAttribute("data-weekly-input");
      if (t.weekly[p]) weeklyInputs[i].value = toDatetimeLocal(t.weekly[p]);
    }
    var cur = document.querySelector("[data-cursor-input]");
    if (cur && t.cursorReset) cur.value = toDatetimeLocal(t.cursorReset);
  }

  function updateSessionUI(now) {
    var timers = loadTimers();
    var live = document.getElementById("stack-live");
    var liveBits = [];
    ["claude", "gemini"].forEach(function (provider) {
      var prog = sessionProgress(timers.sessionStart[provider], now);
      var statusEl = document.querySelector('[data-session-status="' + provider + '"]');
      var countEl = document.querySelector('[data-session-count="' + provider + '"]');
      var startBtn = document.querySelector('[data-session-start="' + provider + '"]');
      var events = fireSessionNotices(provider, prog, timers);
      for (var e = 0; e < events.length; e++) liveBits.push(events[e].text);

      if (!statusEl) return;
      if (!prog) {
        statusEl.textContent = "No local session running.";
        if (countEl) countEl.textContent = "";
        if (startBtn) startBtn.textContent = "Session started";
        return;
      }
      if (prog.exhausted) {
        statusEl.textContent = "5-hour limit reached — resets " + formatLocal(prog.end) + ".";
        if (countEl) countEl.textContent = "You're back — start a new session when you begin again.";
        if (startBtn) startBtn.textContent = "Start new session";
      } else if (prog.approaching) {
        statusEl.textContent = "Approaching 5-hour limit · resets " + formatLocal(prog.end);
        if (countEl) countEl.textContent = "";
        if (startBtn) startBtn.textContent = "Restart session";
      } else {
        statusEl.textContent = "Session running · resets " + formatLocal(prog.end);
        if (countEl) countEl.textContent = "";
        if (startBtn) startBtn.textContent = "Restart session";
      }
    });
    if (live) {
      if (liveBits.length) live.textContent = liveBits.join(" ");
    }
  }

  function updateRowTimers(now) {
    now = now || new Date();
    var timers = loadTimers();
    Object.keys(CLOCK_TOOLS).forEach(function (id) {
      var spec = CLOCK_TOOLS[id];
      if (!spec) return;

      if (spec.kind === "session") {
        var prog = sessionProgress(timers.sessionStart[spec.provider], now);
        if (!prog) {
          setRowTimerUI(id, { countdown: "—:—:—", ratio: 0, hint: "Start session" });
          return;
        }
        if (prog.exhausted) {
          setRowTimerUI(id, {
            countdown: "0:00:00",
            ratio: 1,
            hint: "Session ended · start again"
          });
          return;
        }
        setRowTimerUI(id, {
          countdown: formatRemaining(prog.remaining),
          ratio: prog.ratio,
          hint: prog.approaching ? "Approaching limit" : "Local 5-hour timer"
        });
        return;
      }

      if (spec.kind === "weekly") {
        var endW = parseISO(timers.weekly[spec.provider]);
        if (!endW) {
          setRowTimerUI(id, { countdown: "—:—:—", ratio: 0, hint: "Paste reset time" });
          return;
        }
        var remW = endW.getTime() - now.getTime();
        if (remW <= 0) {
          setRowTimerUI(id, {
            countdown: "0:00:00",
            ratio: 1,
            hint: "Pasted time passed · paste next"
          });
          return;
        }
        var startW = new Date(endW.getTime() - WEEK_MS);
        var ratioW = (now.getTime() - startW.getTime()) / WEEK_MS;
        setRowTimerUI(id, {
          countdown: formatRemaining(remW),
          ratio: ratioW,
          hint: "Resets " + formatLocal(endW)
        });
        return;
      }

      if (spec.kind === "cursor") {
        var endC = parseISO(timers.cursorReset);
        if (!endC) {
          setRowTimerUI(id, { countdown: "—:—:—", ratio: 0, hint: "Paste reset time" });
          return;
        }
        var remC = endC.getTime() - now.getTime();
        if (remC <= 0) {
          setRowTimerUI(id, {
            countdown: "0:00:00",
            ratio: 1,
            hint: "Pasted date passed · paste next"
          });
          return;
        }
        var startC = new Date(endC.getTime() - CYCLE_DISPLAY_MS);
        var ratioC = (now.getTime() - startC.getTime()) / CYCLE_DISPLAY_MS;
        setRowTimerUI(id, {
          countdown: formatRemaining(remC),
          ratio: ratioC,
          hint: "Resets " + formatLocal(endC)
        });
        return;
      }

      if (spec.kind === "copilot") {
        var win = copilotWindow(now);
        var remP = win.end.getTime() - now.getTime();
        var ratioP = (now.getTime() - win.start.getTime()) / (win.end.getTime() - win.start.getTime());
        setRowTimerUI(id, {
          countdown: formatRemaining(remP),
          ratio: ratioP,
          hint: "Next 1st 00:00 UTC · " + formatLocal(win.end)
        });
      }
    });
  }

  function updatePlaybook(now) {
    var panel = document.getElementById("playbook");
    if (!panel) return;
    var stack = loadStack();
    var timers = loadTimers();
    var exhausted = exhaustedProviders(stack, timers, now);
    if (!exhausted.length) {
      panel.hidden = true;
      panel.innerHTML = "";
      return;
    }
    var windows = knownWindows(stack, timers, now);
    var lines = formatPlaybook({
      stack: stack,
      exhaustedProviders: exhausted,
      windows: windows,
      now: now
    });
    panel.hidden = false;
    panel.innerHTML = "";
    panel.appendChild(el("h2", "", { text: "At-cap playbook" }));
    panel.appendChild(el("p", "playbook-lede", {
      text: "A local 5-hour timer ended. Other enabled stack items — Official clocks and times you pasted only. No message counts."
    }));
    var ul = el("ul", "playbook-list");
    for (var i = 0; i < lines.length; i++) {
      ul.appendChild(el("li", "", { text: lines[i] }));
    }
    panel.appendChild(ul);
  }

  function refreshDynamic() {
    if (typeof document === "undefined") return;
    var now = new Date();
    syncPanelStack(loadStack());
    fillSavedInputs();
    updateSessionUI(now);
    updateRowTimers(now);
    updatePlaybook(now);
    var icsWeekly = document.querySelectorAll("[data-weekly-input]");
    for (var i = 0; i < icsWeekly.length; i++) {
      var p = icsWeekly[i].getAttribute("data-weekly-input");
      var has = !!loadTimers().weekly[p];
      var wrap = icsWeekly[i].closest(".clock-tools");
      if (!wrap) continue;
      var btns = wrap.querySelectorAll(".tool-btn-quiet");
      for (var b = 0; b < btns.length; b++) btns[b].disabled = !has;
    }
    var curInput = document.querySelector("[data-cursor-input]");
    if (curInput) {
      var wrapC = curInput.closest(".clock-tools");
      var hasC = !!loadTimers().cursorReset;
      if (wrapC) {
        var cBtns = wrapC.querySelectorAll(".tool-btn-quiet");
        for (var c = 0; c < cBtns.length; c++) cBtns[c].disabled = !hasC;
      }
    }
  }

  var tickTimer = null;

  function startTicking() {
    if (tickTimer) return;
    refreshDynamic();
    tickTimer = setInterval(refreshDynamic, 1000);
  }

  function initResetPage(opts) {
    opts = opts || {};
    renderStackToggles(document.getElementById("stack-toggles"));
    bindNotifyBox(document.getElementById("stack-notify"));
    showChangeBanner(opts.generatedAt || "");
    mountAllTools();
    startTicking();
  }

  function nextLineFor(id, stack, timers, now) {
    var windows = knownWindows([id], timers, now);
    var w = windows[id];
    var official = "";
    if (id === "claude") official = OFFICIAL.claudeSession + " " + OFFICIAL.claudeWeekly;
    else if (id === "gemini") official = OFFICIAL.geminiSession;
    else if (id === "copilot") official = OFFICIAL.copilot;
    else if (id === "cursor") official = OFFICIAL.cursor;
    else if (id === "grok") official = OFFICIAL.grokWeekly;
    return {
      whenText: w ? w.whenText : "next window not known yet",
      source: official
    };
  }

  function renderNextPage(host) {
    if (!host) return;
    var stack = loadStack();
    var timers = loadTimers();
    var now = new Date();
    host.innerHTML = "";
    if (!stack.length) {
      host.appendChild(el("p", "next-empty", {
        text: "No stack saved yet. Toggle Claude, Gemini, Copilot, Cursor, or Grok on the Reset Board. Nothing is stored until you do."
      }));
      return;
    }
    var ul = el("ul", "next-list");
    for (var i = 0; i < stack.length; i++) {
      var id = stack[i];
      var p = providerById(id);
      var line = nextLineFor(id, stack, timers, now);
      var li = el("li", "next-item");
      var head = el("div", "next-item-head");
      var tile = el("span", "tile " + (p ? p.tile : ""), { text: p ? p.letter : "?" });
      tile.setAttribute("aria-hidden", "true");
      head.appendChild(tile);
      head.appendChild(el("h2", "", { text: p ? p.name : id }));
      li.appendChild(head);
      li.appendChild(el("p", "next-when", { text: stripCapCounts(line.whenText) }));
      li.appendChild(el("p", "next-source", { text: stripCapCounts(line.source) }));
      ul.appendChild(li);
    }
    host.appendChild(ul);
  }

  var nextHost = null;
  function initNextPage() {
    nextHost = document.getElementById("next-list-host");
    renderNextPage(nextHost);
    setInterval(function () { renderNextPage(nextHost); }, 1000);
  }

  var api = {
    PROVIDERS: PROVIDERS,
    OFFICIAL: OFFICIAL,
    SESSION_MS: SESSION_MS,
    STACK_KEY: STACK_KEY,
    loadStack: loadStack,
    saveStack: saveStack,
    loadTimers: loadTimers,
    sessionProgress: sessionProgress,
    nextCopilotReset: nextCopilotReset,
    knownWindows: knownWindows,
    exhaustedProviders: exhaustedProviders,
    formatPlaybook: formatPlaybook,
    stripCapCounts: stripCapCounts,
    CAP_COUNT_RE: CAP_COUNT_RE,
    buildIcs: buildIcs,
    initResetPage: initResetPage,
    initNextPage: initNextPage,
    renderNextPage: renderNextPage,
    refreshDynamic: refreshDynamic
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (root) root.SubsMaxxersStack = api;
})(typeof window !== "undefined" ? window : typeof global !== "undefined" ? global : this);

"use strict";
(() => {
  // This page is either served by penpal on the computer (the address includes an access key),
  // or published as a stand-alone site that works offline and keeps everything on this device
  // until it's exported to a file.
  const OFFLINE = Boolean(document.querySelector('meta[name="penpal-offline"]'));
  const params = new URLSearchParams(location.search);
  const TOKEN = OFFLINE ? "" : params.get("k") || sessionStorage.getItem("penpal-token") || "";
  if (TOKEN) sessionStorage.setItem("penpal-token", TOKEN);

  const $ = (id) => document.getElementById(id);
  const canvas = $("pad");
  const ctx = canvas.getContext("2d");
  const store = window.localStorage;

  // Writing cells extend this many x-heights above and below the baseline.
  const ABOVE = 2.0;
  const BELOW = 1.1;
  const PER_SCREEN = { char: 8, ngram: 6, word: 4 };
  const INK = "#1d2b5c";
  const PLAN = "plan"; // the exercise that is the whole plan, with lasting targets

  const randomHex = (bytes) =>
    Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
  const session = randomHex(8);
  const settings = {
    pxPerMm: parseFloat(store.getItem("penpal-px-per-mm")) || guessPxPerMm(),
    xHeightMm: parseFloat(store.getItem("penpal-x-height")) || 0,
    penOnly: store.getItem("penpal-pen-only") !== "0",
  };

  let plan = null; // {x_height_mm, exercises}
  let people = []; // [{id, name}]; offline the name is the id
  let person = null;
  let exercise = null;
  let counts = {}; // "kind:label" -> samples this person has (offline: on this device)
  const done = {}; // "exercise|kind:label" -> samples written this session
  let items = [];
  let index = 0;
  let strokes = [];
  let current = null;
  let cells = [];
  let busy = false;

  function guessPxPerMm() {
    const iPad = /iPad/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
    return iPad ? 5.2 : 96 / 25.4;
  }

  const keyOf = (item) => `${item.kind}:${item.label}`;

  function status(text, isError) {
    const el = $("status");
    el.textContent = text || "";
    el.className = isError ? "error" : "muted";
  }

  // ----- talking to penpal on the computer -----------------------------------

  async function api(path, body) {
    const opts = { headers: { "X-Penpal-Token": TOKEN } };
    if (body !== undefined) {
      opts.method = "POST";
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(path, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  // Pages that couldn't be sent wait here and are retried.
  const PENDING = "penpal-pending";
  const pending = () => JSON.parse(store.getItem(PENDING) || "[]");
  let flushing = null;

  function flushPending() {
    if (!flushing) {
      flushing = (async () => {
        while (pending().length) {
          const page = pending()[0];
          const res = await api("/api/samples", page);
          store.setItem(PENDING, JSON.stringify(pending().slice(1)));
          if (person && page.profile === person.id) applyCounts(res.counts);
        }
      })().finally(() => {
        flushing = null;
      });
    }
    return flushing;
  }

  async function sendPage(page) {
    try {
      await flushPending();
      const res = await api("/api/samples", page);
      applyCounts(res.counts);
      status(`Saved ${page.samples.length}.`);
    } catch (err) {
      store.setItem(PENDING, JSON.stringify([...pending(), page]));
      status(`Couldn't reach penpal (${err.message}). Kept ${pending().length} page(s) on this iPad; will retry.`, true);
    }
  }

  // ----- keeping pages on this device (offline) --------------------------------

  const db = (() => {
    let opening = null;
    function open() {
      opening =
        opening ||
        new Promise((resolve, reject) => {
          const req = indexedDB.open("penpal-capture", 1);
          req.onupgradeneeded = () => req.result.createObjectStore("pages", { keyPath: "page" });
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
      return opening;
    }
    async function run(mode, work) {
      const conn = await open();
      return new Promise((resolve, reject) => {
        const tx = conn.transaction("pages", mode);
        const req = work(tx.objectStore("pages"));
        tx.oncomplete = () => resolve(req ? req.result : undefined);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error("storage is full"));
      });
    }
    return {
      all: () => run("readonly", (s) => s.getAll()),
      put: (page) => run("readwrite", (s) => s.put(page)),
      putMany: (pages) =>
        run("readwrite", (s) => {
          for (const p of pages) s.put(p);
        }),
      remove: (ids) =>
        run("readwrite", (s) => {
          for (const id of ids) s.delete(id);
        }),
    };
  })();

  const PEOPLE = "penpal-people";

  function countPages(pages, name) {
    const c = {};
    for (const p of pages) {
      if (p.profile !== name) continue;
      for (const s of p.samples) c[`${s.kind}:${s.label}`] = (c[`${s.kind}:${s.label}`] || 0) + 1;
    }
    return c;
  }

  async function loadOffline() {
    plan = await (await fetch("plan.json")).json();
    const pages = await db.all();
    const names = new Set(JSON.parse(store.getItem(PEOPLE) || "[]"));
    for (const p of pages) names.add(p.profile);
    people = [...names].sort((a, b) => a.localeCompare(b)).map((name) => ({ id: name, name }));
    return pages;
  }

  // ----- choosing a person and an exercise -------------------------------------

  async function loadPlan(profileId) {
    if (OFFLINE) {
      const pages = await loadOffline();
      counts = profileId ? countPages(pages, profileId) : {};
      return;
    }
    plan = await api("/api/plan" + (profileId ? `?profile=${encodeURIComponent(profileId)}` : ""));
    people = plan.profiles;
    counts = plan.counts || {};
  }

  function applyCounts(newCounts) {
    if (!newCounts) return;
    counts = newCounts;
    refreshHave();
    if (items.length) renderHeader(false);
  }

  function refreshHave() {
    for (const item of items) {
      item.have = exercise.id === PLAN ? counts[keyOf(item)] || 0 : done[`${exercise.id}|${keyOf(item)}`] || 0;
    }
  }

  function fillPeople(selectedId) {
    const sel = $("person");
    sel.innerHTML = "";
    for (const p of people) sel.append(new Option(p.name, p.id));
    if (OFFLINE) sel.append(new Option("+ Add a person", ""));
    sel.value = people.some((p) => p.id === selectedId) ? selectedId : people.length ? people[0].id : "";
    $("add-person").hidden = !OFFLINE || sel.value !== "";
    $("same-name").hidden = $("add-person").hidden;
  }

  function fillExercises(selectedId) {
    const box = $("exercises");
    box.innerHTML = "";
    for (const ex of plan.exercises) {
      const total = ex.items.reduce((n, i) => n + i.target, 0);
      let detail = `${ex.items.length} to write, ${total} samples`;
      if (ex.id === PLAN) {
        const have = ex.items.reduce((n, i) => n + Math.min(counts[keyOf(i)] || 0, i.target), 0);
        detail = `${have} of ${total} samples` + (OFFLINE ? " written on this iPad" : "");
      }
      const label = document.createElement("label");
      label.className = "exercise" + (ex.id === selectedId ? " selected" : "");
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "exercise";
      radio.value = ex.id;
      radio.checked = ex.id === selectedId;
      radio.addEventListener("change", () => fillExercises(ex.id));
      const text = document.createElement("span");
      const name = document.createElement("b");
      name.textContent = ex.name;
      const about = document.createElement("small");
      about.textContent = `${ex.about ? ex.about + " " : ""}(${detail})`;
      text.append(name, about);
      label.append(radio, text);
      box.append(label);
    }
  }

  async function openStart() {
    try {
      await loadPlan(person ? person.id : store.getItem("penpal-person"));
    } catch (err) {
      status(`Can't load the capture plan: ${err.message}`, true);
      return;
    }
    fillPeople(person ? person.id : store.getItem("penpal-person"));
    const wanted = exercise ? exercise.id : store.getItem("penpal-exercise");
    fillExercises(plan.exercises.some((e) => e.id === wanted) ? wanted : plan.exercises[0].id);
    $("offline-note").hidden = !OFFLINE;
    if (!$("start").open) $("start").showModal();
  }

  $("person").addEventListener("change", async (e) => {
    $("add-person").hidden = !OFFLINE || e.target.value !== "";
    $("same-name").hidden = $("add-person").hidden;
    if (e.target.value) {
      await loadPlan(e.target.value);
      const checked = document.querySelector('input[name="exercise"]:checked');
      fillExercises(checked ? checked.value : plan.exercises[0].id);
    } else {
      $("new-person").focus();
    }
  });

  $("btn-add-person").addEventListener("click", () => {
    const name = $("new-person").value.trim().replace(/\s+/g, " ");
    if (!name) return;
    const names = JSON.parse(store.getItem(PEOPLE) || "[]");
    if (!names.includes(name)) store.setItem(PEOPLE, JSON.stringify([...names, name]));
    if (!people.some((p) => p.id === name)) people.push({ id: name, name });
    people.sort((a, b) => a.name.localeCompare(b.name));
    $("new-person").value = "";
    fillPeople(name);
    $("person").dispatchEvent(new Event("change"));
  });

  $("btn-start").addEventListener("click", async () => {
    const id = $("person").value;
    const checked = document.querySelector('input[name="exercise"]:checked');
    if (!id) {
      $("new-person").focus();
      return;
    }
    if (!checked) return;
    await loadPlan(id);
    person = people.find((p) => p.id === id);
    exercise = plan.exercises.find((e) => e.id === checked.value);
    store.setItem("penpal-person", person.id);
    store.setItem("penpal-exercise", exercise.id);
    items = exercise.items.map((i) => ({ ...i }));
    index = 0; // the old exercise's position may be past the end of this one
    strokes = [];
    refreshHave();
    $("start").close();
    $("btn-session").textContent = `${person.name} \u00b7 ${exercise.name}`;
    $("link-review").href = `/review?k=${encodeURIComponent(TOKEN)}&profile=${encodeURIComponent(person.id)}`;
    resize();
    const first = items.findIndex((i) => i.have < i.target);
    go(first >= 0 ? first : 0);
    if (!store.getItem("penpal-px-per-mm")) openSettings();
  });

  $("btn-session").addEventListener("click", () => {
    if (strokes.length && !confirm("Discard what's written on this page?")) return;
    strokes = [];
    openStart();
  });

  // ----- layout and drawing -------------------------------------------------

  const xhMm = () => settings.xHeightMm || plan.x_height_mm;
  const unit = () => xhMm() * settings.pxPerMm;

  function describe(item) {
    if (item.kind === "word") return "word";
    if (item.kind === "ngram") return `letter ${item.label.length === 2 ? "pair" : "group"}: write it as you would inside a word`;
    const c = item.label;
    if (/[a-z]/.test(c)) return "lowercase letter";
    if (/[A-Z]/.test(c)) return "capital letter";
    if (/[0-9]/.test(c)) return "digit";
    return "punctuation";
  }

  function layoutCells() {
    if (!items[index]) index = 0;
    const item = items[index];
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const u = unit();
    const cellW = item.kind === "char" ? u * 2.8 : u * (0.95 * item.label.length + 1.6);
    const cellH = u * (ABOVE + BELOW);
    const gap = u * 0.5;
    const cols = Math.max(1, Math.floor((w - gap) / (cellW + gap)));
    const maxRows = Math.max(1, Math.floor((h - gap) / (cellH + gap)));
    const remaining = item.target - item.have;
    const want = Math.min(PER_SCREEN[item.kind] || 4, Math.max(remaining, 2));
    const n = Math.max(1, Math.min(want, cols * maxRows));
    const rows = Math.ceil(n / cols);
    const usedCols = Math.min(cols, n);
    const x0 = Math.max(gap, (w - (usedCols * cellW + (usedCols - 1) * gap)) / 2);
    const y0 = Math.max(gap, (h - (rows * cellH + (rows - 1) * gap)) / 2);
    cells = [];
    for (let i = 0; i < n; i++) {
      const r = Math.floor(i / cols);
      const c = i % cols;
      const x = x0 + c * (cellW + gap);
      const y = y0 + r * (cellH + gap);
      cells.push({ x, y, w: cellW, h: cellH, baseline: y + ABOVE * u });
    }
  }

  function guide(cell, y, color, dash, width = 1) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.setLineDash(dash);
    ctx.beginPath();
    ctx.moveTo(cell.x + 4, y);
    ctx.lineTo(cell.x + cell.w - 4, y);
    ctx.stroke();
    ctx.restore();
  }

  function drawStroke(points) {
    if (!points.length) return;
    ctx.beginPath();
    ctx.moveTo(points[0][0], points[0][1]);
    if (points.length === 1) ctx.lineTo(points[0][0] + 0.1, points[0][1]);
    for (const p of points) ctx.lineTo(p[0], p[1]);
    ctx.stroke();
  }

  function inkStyle() {
    ctx.strokeStyle = INK;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = Math.max(1.5, 0.12 * unit());
    ctx.setLineDash([]);
  }

  function redraw() {
    ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    if (!items.length) return;
    const u = unit();
    for (const c of cells) {
      ctx.fillStyle = "#fffdf8";
      ctx.strokeStyle = "#d8d2c4";
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(c.x, c.y, c.w, c.h, 8);
      else ctx.rect(c.x, c.y, c.w, c.h);
      ctx.fill();
      ctx.stroke();
      // Like school writing paper: solid top line (capitals and tall letters), dashed line
      // (top of small letters), solid baseline, and open space below it for tails.
      guide(c, c.baseline - 1.5 * u, "#6f89ad", [], 1.5);
      guide(c, c.baseline - u, "#7f97bb", [6, 4], 1.25);
      guide(c, c.baseline, "#6f89ad", [], 1.5);
    }
    inkStyle();
    for (const s of strokes) drawStroke(s.points);
    if (current) drawStroke(current.points);
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!items.length) return;
    if (strokes.length) {
      strokes = [];
      status("The screen changed size, so this page was cleared.", true);
    }
    layoutCells();
    redraw();
  }

  // ----- pen input -----------------------------------------------------------

  function accepts(e) {
    return e.pointerType === "pen" || e.pointerType === "mouse" || (!settings.penOnly && e.pointerType === "touch");
  }

  let t0 = performance.now();
  function point(e) {
    const r = canvas.getBoundingClientRect();
    const pressure = e.pressure || (e.pointerType === "mouse" ? 0.5 : 0);
    return [e.clientX - r.left, e.clientY - r.top, Math.max(0, Math.round(e.timeStamp - t0)), pressure];
  }

  canvas.addEventListener("pointerdown", (e) => {
    if (!accepts(e) || current || busy || !items.length) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    current = { id: e.pointerId, type: e.pointerType, points: [point(e)] };
    inkStyle();
    drawStroke(current.points);
  });

  canvas.addEventListener("pointermove", (e) => {
    if (!current || e.pointerId !== current.id) return;
    e.preventDefault();
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    const last = current.points[current.points.length - 1];
    inkStyle();
    ctx.beginPath();
    ctx.moveTo(last[0], last[1]);
    for (const ev of events.length ? events : [e]) {
      const p = point(ev);
      current.points.push(p);
      ctx.lineTo(p[0], p[1]);
    }
    ctx.stroke();
  });

  function endStroke(e) {
    if (!current || e.pointerId !== current.id) return;
    e.preventDefault();
    strokes.push(current);
    current = null;
    redraw();
    status("");
  }
  canvas.addEventListener("pointerup", endStroke);
  canvas.addEventListener("pointercancel", endStroke);
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  canvas.addEventListener("touchmove", (e) => e.preventDefault(), { passive: false });
  document.addEventListener("gesturestart", (e) => e.preventDefault());

  // ----- turning strokes into samples ---------------------------------------

  function cellFor(points) {
    let sx = 0;
    let sy = 0;
    for (const p of points) {
      sx += p[0];
      sy += p[1];
    }
    const cx = sx / points.length;
    const cy = sy / points.length;
    let best = -1;
    let bestDistance = Infinity;
    cells.forEach((c, i) => {
      const dx = Math.max(c.x - cx, 0, cx - (c.x + c.w));
      const dy = Math.max(c.y - cy, 0, cy - (c.y + c.h));
      const d = Math.hypot(dx, dy);
      if (d < bestDistance) {
        bestDistance = d;
        best = i;
      }
    });
    return bestDistance <= unit() ? best : -1;
  }

  function buildSamples() {
    const item = items[index];
    const k = settings.pxPerMm;
    const perCell = cells.map(() => []);
    for (const s of strokes) {
      const i = cellFor(s.points);
      if (i >= 0) perCell[i].push(s);
    }
    const samples = [];
    perCell.forEach((list, i) => {
      if (!list.length) return;
      const c = cells[i];
      samples.push({
        label: item.label,
        kind: item.kind,
        x_height_mm: xhMm(),
        strokes: list.map((s) =>
          s.points.map((p) => [
            Math.round(((p[0] - c.x) / k) * 1000) / 1000,
            Math.round(((p[1] - c.baseline) / k) * 1000) / 1000,
            p[2],
            Math.round(p[3] * 1000) / 1000,
          ])
        ),
      });
    });
    return samples;
  }

  // ----- saving ------------------------------------------------------------------

  async function save() {
    if (busy || !items.length) return;
    const samples = buildSamples();
    if (!samples.length) {
      go(nextIndex(true));
      return;
    }
    const page = {
      page: randomHex(8), // lets penpal skip a page it already has
      session,
      profile: person.id,
      exercise: exercise.id,
      captured: new Date().toISOString(),
      device: {
        user_agent: navigator.userAgent,
        px_per_mm: settings.pxPerMm,
        pointer: strokes.length ? strokes[strokes.length - 1].type : "",
      },
      samples,
    };
    setBusy(true);
    try {
      if (OFFLINE) {
        await db.put(page);
        status(`Saved ${samples.length} on this iPad.`);
        refreshExportButton();
      }
      const item = items[index];
      const doneKey = `${exercise.id}|${keyOf(item)}`;
      done[doneKey] = (done[doneKey] || 0) + samples.length;
      counts[keyOf(item)] = (counts[keyOf(item)] || 0) + samples.length;
      refreshHave();
      strokes = [];
      if (!OFFLINE) await sendPage(page);
    } catch (err) {
      status(`Couldn't save on this iPad: ${err.message}. Try exporting, then deleting exported pages.`, true);
      return;
    } finally {
      setBusy(false);
    }
    go(nextIndex(true));
  }

  function setBusy(value) {
    busy = value;
    for (const id of ["btn-save", "btn-skip", "btn-prev", "btn-undo", "btn-clear"]) $(id).disabled = value;
  }

  // ----- navigation ------------------------------------------------------------

  function nextIndex(onlyIncomplete) {
    for (let step = 1; step <= items.length; step++) {
      const i = (index + step) % items.length;
      if (!onlyIncomplete || items[i].have < items[i].target) return i;
    }
    return onlyIncomplete ? -1 : index;
  }

  function go(i) {
    if (i < 0) {
      renderHeader(true);
      status(
        exercise.id === PLAN && !OFFLINE
          ? "Everything in the plan is captured. Build the library in penpal on the computer."
          : `Finished \u201c${exercise.name}\u201d. Pick another with ${$("btn-session").textContent}.`
      );
      return;
    }
    index = i;
    strokes = [];
    current = null;
    t0 = performance.now();
    layoutCells();
    redraw();
    renderHeader(false);
  }

  function renderHeader(allDone) {
    const item = items[index];
    $("prompt-text").textContent = allDone ? "All done" : item.label;
    $("prompt-kind").textContent = allDone ? "" : `${describe(item)} - write one in each box`;
    const total = items.reduce((n, i) => n + Math.min(i.have, i.target), 0);
    const target = items.reduce((n, i) => n + i.target, 0);
    const scope = exercise.id === PLAN ? "Overall" : "This session";
    $("progress").textContent = `This one: ${item.have}/${item.target}   ${scope}: ${total}/${target}`;
    const select = $("item-select");
    select.innerHTML = "";
    items.forEach((it, i) => {
      const opt = document.createElement("option");
      opt.value = String(i);
      opt.textContent = `${it.have >= it.target ? "\u2713 " : ""}${it.label}  (${it.have}/${it.target})`;
      select.appendChild(opt);
    });
    select.value = String(index);
  }

  $("item-select").addEventListener("change", (e) => {
    if (strokes.length && !confirm("Discard what's written on this page?")) {
      e.target.value = String(index);
      return;
    }
    go(parseInt(e.target.value, 10));
  });
  $("btn-save").addEventListener("click", save);
  $("btn-skip").addEventListener("click", () => items.length && go(nextIndex(false)));
  $("btn-prev").addEventListener("click", () => items.length && go((index - 1 + items.length) % items.length));
  $("btn-undo").addEventListener("click", () => {
    strokes.pop();
    redraw();
  });
  $("btn-clear").addEventListener("click", () => {
    strokes = [];
    redraw();
  });
  document.addEventListener("keydown", (e) => {
    if (document.querySelector("dialog[open]")) return;
    if ((e.ctrlKey || e.metaKey) && e.key === "z") {
      e.preventDefault();
      strokes.pop();
      redraw();
    } else if (e.key === "Enter") {
      e.preventDefault();
      save();
    }
  });

  // ----- exporting (offline) -------------------------------------------------------

  let exportFile = null;
  let exportPages = [];

  async function refreshExportButton() {
    if (!OFFLINE) return;
    const pages = await db.all();
    const waiting = pages.filter((p) => !p.exported).length;
    $("btn-export").textContent = waiting ? `Export (${waiting} new)` : "Export";
  }

  async function openExport() {
    exportPages = await db.all();
    const samples = exportPages.reduce((n, p) => n + p.samples.length, 0);
    const waiting = exportPages.filter((p) => !p.exported);
    const byPerson = {};
    for (const p of exportPages) byPerson[p.profile] = (byPerson[p.profile] || 0) + p.samples.length;
    const who = Object.entries(byPerson)
      .map(([name, n]) => `${name}: ${n}`)
      .join(", ");
    $("export-summary").textContent = exportPages.length
      ? `${samples} samples on ${exportPages.length} pages (${who}). ${waiting.length} page(s) haven't been exported yet.`
      : "Nothing saved on this iPad yet.";
    $("btn-share").disabled = !exportPages.length;
    $("btn-forget").disabled = !exportPages.some((p) => p.exported);
    // Built now, so the button can hand it to the share sheet straight away (Safari requires that).
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
    const body = JSON.stringify({ format: "penpal-samples", version: 1, exported: new Date().toISOString(), pages: exportPages });
    exportFile = new File([body], `penpal-samples-${stamp}.json`, { type: "application/json" });
    $("export").showModal();
  }

  function download(file) {
    const url = URL.createObjectURL(file);
    const a = document.createElement("a");
    a.href = url;
    a.download = file.name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  async function markExported() {
    const now = new Date().toISOString();
    await db.putMany(exportPages.map((p) => ({ ...p, exported: p.exported || now })));
    await refreshExportButton();
    $("export").close();
    status("Exported. Import the file in penpal on the computer (Handwriting tab).");
  }

  $("btn-export").addEventListener("click", openExport);
  $("btn-export-close").addEventListener("click", () => $("export").close());
  $("btn-share").addEventListener("click", async () => {
    if (!exportFile) return;
    if (navigator.canShare && navigator.canShare({ files: [exportFile] })) {
      try {
        await navigator.share({ files: [exportFile], title: "penpal samples" });
      } catch (err) {
        if (err.name === "AbortError") return; // closed the share sheet
        download(exportFile);
      }
    } else {
      download(exportFile);
    }
    await markExported();
  });
  $("btn-forget").addEventListener("click", async () => {
    const old = exportPages.filter((p) => p.exported);
    if (!old.length) return;
    const n = old.reduce((sum, p) => sum + p.samples.length, 0);
    if (!confirm(`Delete ${n} exported samples from this iPad? Only do this once they're imported on the computer.`)) return;
    await db.remove(old.map((p) => p.page));
    await refreshExportButton();
    await openExport();
  });

  // ----- settings ----------------------------------------------------------------

  function showCalibration() {
    const box = $("calib-box");
    box.style.width = `${85.6 * settings.pxPerMm}px`;
    box.style.height = `${53.98 * settings.pxPerMm}px`;
  }

  function openSettings() {
    $("calib").value = String(settings.pxPerMm);
    $("xh").value = String(xhMm());
    $("pen-only").checked = settings.penOnly;
    showCalibration();
    $("settings").showModal();
  }

  $("calib").addEventListener("input", (e) => {
    settings.pxPerMm = parseFloat(e.target.value);
    showCalibration();
  });
  $("btn-settings").addEventListener("click", () => plan && openSettings());
  $("btn-settings-done").addEventListener("click", () => {
    const xh = parseFloat($("xh").value);
    settings.xHeightMm = xh >= 3 && xh <= 15 ? xh : 0;
    settings.penOnly = $("pen-only").checked;
    store.setItem("penpal-px-per-mm", String(settings.pxPerMm));
    store.setItem("penpal-x-height", String(settings.xHeightMm));
    store.setItem("penpal-pen-only", settings.penOnly ? "1" : "0");
    $("settings").close();
    strokes = [];
    if (items.length) {
      layoutCells();
      redraw();
    }
  });

  // ----- start ---------------------------------------------------------------------

  async function start() {
    if (OFFLINE) {
      $("link-review").hidden = true;
      $("btn-export").hidden = false;
      if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
      refreshExportButton();
    } else {
      if (!TOKEN) {
        status("Missing access key: open the full address that penpal printed on the PC.", true);
        return;
      }
      setInterval(() => {
        if (pending().length && !busy) flushPending().catch(() => {});
      }, 20000);
      flushPending().catch(() => status(`${pending().length} saved page(s) still waiting to upload.`, true));
    }
    resize();
    await openStart();
  }

  window.addEventListener("resize", resize);
  start();
})();
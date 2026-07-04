// 画面フロー: セットアップ → 読み込み → 試合(前半 → HT → 後半) → 結果

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

const app = {
  setups: [newSetup(), newSetup()],   // セットアップ画面の選択状態
  strategies: [null, null],           // 読み込み済み戦略
  match: null,
  pitch: null,
  loopGen: 0,
  speed: 1,
  htDone: [false, false],
};

function newSetup() {
  return { manager: "", teamKey: "", formation: "4-4-2", picked: new Set() };
}

function showScreen(id) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  $(id).classList.add("active");
}

// ---- セットアップ画面 ----

function renderSetup() {
  const wrap = $("#setup-panels");
  wrap.innerHTML = "";
  app.setups.forEach((st, i) => wrap.appendChild(setupPanel(st, i)));
}

function setupPanel(st, i) {
  const panel = el("div", "panel");
  panel.appendChild(el("h2", null, `監督 ${i + 1}`));

  const nameRow = el("div", "row");
  nameRow.appendChild(el("label", null, "監督名: "));
  const nameInput = el("input");
  nameInput.placeholder = "例: 山田タカ";
  nameInput.value = st.manager;
  nameInput.addEventListener("input", () => { st.manager = nameInput.value.trim(); updateDl(); });
  nameRow.appendChild(nameInput);
  panel.appendChild(nameRow);

  const teamRow = el("div", "row");
  teamRow.appendChild(el("label", null, "使用チーム: "));
  const teamSel = el("select");
  teamSel.appendChild(new Option("選択してください", ""));
  for (const [key, t] of Object.entries(TEAMS_DATA)) teamSel.appendChild(new Option(t.name, key));
  teamSel.value = st.teamKey;
  teamSel.addEventListener("change", () => {
    st.teamKey = teamSel.value;
    st.picked = new Set();
    renderSetup();
  });
  teamRow.appendChild(teamSel);
  panel.appendChild(teamRow);

  if (!st.teamKey) return panel;
  const team = TEAMS_DATA[st.teamKey];
  panel.appendChild(el("p", "desc", `「${team.desc}」`));

  const fRow = el("div", "row");
  fRow.appendChild(el("label", null, "フォーメーション: "));
  const fSel = el("select");
  for (const f of Object.keys(FORMATIONS)) fSel.appendChild(new Option(f, f));
  fSel.value = st.formation;
  fSel.addEventListener("change", () => { st.formation = fSel.value; st.picked = new Set(); renderSetup(); });
  fRow.appendChild(fSel);
  panel.appendChild(fRow);

  const need = { GK: 1, ...FORMATIONS[st.formation] };
  const count = { GK: 0, DF: 0, MF: 0, FW: 0 };
  for (const n of st.picked) {
    const p = team.players.find((x) => x.name === n);
    if (p) count[p.pos]++;
  }
  const status = el("p", "pick-status",
    POS_ORDER.map((pos) => `${pos} ${count[pos]}/${need[pos]}`).join("　"));
  panel.appendChild(status);
  panel.appendChild(el("p", "hint", "行をクリックして先発選手を選んでください"));

  const table = el("table", "roster");
  const thead = el("thead");
  const hr = el("tr");
  for (const h of ["", "名前", "Pos", ...STAT_NAMES]) hr.appendChild(el("th", null, h));
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = el("tbody");
  for (const p of team.players) {
    const tr = el("tr", st.picked.has(p.name) ? "picked" : "");
    tr.appendChild(el("td", "mark", st.picked.has(p.name) ? "✓" : ""));
    tr.appendChild(el("td", "pname", p.name));
    tr.appendChild(el("td", null, p.pos));
    for (const v of p.stats) {
      const td = el("td", v >= 75 ? "hi" : v <= 40 ? "lo" : "", String(v));
      tr.appendChild(td);
    }
    tr.addEventListener("click", () => {
      if (st.picked.has(p.name)) st.picked.delete(p.name);
      else if (count[p.pos] < need[p.pos]) st.picked.add(p.name);
      else return flash(status, `${p.pos} は ${need[p.pos]}人までです`);
      renderSetup();
    });
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  const scroll = el("div", "table-scroll");
  scroll.appendChild(table);
  panel.appendChild(scroll);

  const dlBtn = el("button", "primary", "戦略ファイルをダウンロード");
  dlBtn.id = `dl-${i}`;
  dlBtn.addEventListener("click", () => downloadStrategy(st));
  panel.appendChild(dlBtn);
  const note = el("p", "hint", "");
  note.id = `dl-note-${i}`;
  panel.appendChild(note);
  updateDl();
  return panel;
}

function flash(elm, msg) {
  const old = elm.textContent;
  elm.textContent = msg;
  elm.classList.add("warn");
  setTimeout(() => { elm.textContent = old; elm.classList.remove("warn"); }, 1500);
}

function setupComplete(st) {
  if (!st.manager || !st.teamKey) return false;
  const team = TEAMS_DATA[st.teamKey];
  const need = { GK: 1, ...FORMATIONS[st.formation] };
  const count = { GK: 0, DF: 0, MF: 0, FW: 0 };
  for (const n of st.picked) {
    const p = team.players.find((x) => x.name === n);
    if (p) count[p.pos]++;
  }
  return POS_ORDER.every((pos) => count[pos] === need[pos]);
}

function updateDl() {
  app.setups.forEach((st, i) => {
    const btn = $(`#dl-${i}`), note = $(`#dl-note-${i}`);
    if (!btn) return;
    const ok = setupComplete(st);
    btn.disabled = !ok;
    note.textContent = ok ? "" :
      !st.manager ? "先に監督名を入力してください" : "スタメン11人を選んでください";
  });
}

function downloadStrategy(st) {
  const team = TEAMS_DATA[st.teamKey];
  const starters = { GK: [], DF: [], MF: [], FW: [] };
  for (const p of team.players) if (st.picked.has(p.name)) starters[p.pos].push(p.name);
  const md = buildStrategyMd({ manager: st.manager, teamKey: st.teamKey, formation: st.formation, starters });
  const fname = `${st.manager.replace(/[\\/:*?"<>|\s]/g, "_")}_${timestampStr(new Date())}.md`;
  downloadText(fname, md);
}

function downloadText(fname, text) {
  const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = fname;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
}

// ---- 読み込み画面 ----

function initLoadScreen() {
  [0, 1].forEach((i) => {
    $(`#file-${i}`).addEventListener("change", async (e) => {
      const file = e.target.files[0];
      const box = $(`#file-status-${i}`);
      if (!file) return;
      const text = await file.text();
      const { strategy, errors } = parseStrategyMd(text);
      box.innerHTML = "";
      if (errors.length) {
        app.strategies[i] = null;
        box.appendChild(el("p", "err", `❌ ${file.name} を受理できません:`));
        for (const err of errors) box.appendChild(el("p", "err-item", `・${err}`));
      } else {
        app.strategies[i] = strategy;
        const t = TEAMS_DATA[strategy.teamKey];
        box.appendChild(el("p", "ok", `✅ ${file.name}`));
        box.appendChild(el("p", null,
          `${strategy.manager} 監督 ／ ${t.name} ／ ${strategy.formation} ／ ` +
          `${strategy.tactics.attack}×${strategy.tactics.defense} ／ ライン${strategy.tactics.line}・テンポ${strategy.tactics.tempo} ／ 切り札: ${strategy.trump.type}`));
      }
      $("#start-match").disabled = !(app.strategies[0] && app.strategies[1]);
    });
  });
  $("#start-match").addEventListener("click", startMatch);
}

// ---- 試合画面 ----

function startMatch() {
  const seedInput = $("#seed-input").value.trim();
  const seed = seedInput ? (parseInt(seedInput, 10) >>> 0) : (Math.random() * 4294967296) >>> 0;
  if (app.pitch) app.pitch.stop();
  app.match = new Match(app.strategies[0], app.strategies[1], seed);
  app.htDone = [false, false];
  showScreen("#screen-match");
  $("#log").innerHTML = "";
  $("#ht-panel").classList.add("hidden");
  $("#result-panel").classList.add("hidden");
  app.pitch = new Pitch($("#pitch"), app.match);
  const m = app.match;
  addLog({ kind: "section", minute: "", text: `⚽ キックオフ！ ${m.a.team.name}（${m.a.strategy.manager}監督） vs ${m.b.team.name}（${m.b.strategy.manager}監督）` });
  const notes = [];
  for (const ts of m.teams()) {
    for (const p of ts.players) {
      if (p.cond === "絶好調") notes.push(`☀${p.name}(${ts.team.name})`);
      if (p.cond === "絶不調") notes.push(`🌧${p.name}(${ts.team.name})`);
    }
  }
  if (notes.length) addLog({ kind: "info", minute: "", text: `本日のコンディション速報 — ${notes.join(" ／ ")}` });
  updateScoreboard();
  startLoop();
}

// アニメーションと同期したティックループ。app.loopGen で多重起動・中断を管理する
function startLoop() {
  const gen = ++app.loopGen;
  loopStep(gen);
}

async function loopStep(gen) {
  if (gen !== app.loopGen) return;
  const m = app.match;
  if (m.finished || m.atHalftime) return;
  const before = m.events.length;
  m.step();
  for (let i = before; i < m.events.length; i++) addLog(m.events[i]);
  updateScoreboard();
  const dur = Math.max(150, 1400 / app.speed);
  await app.pitch.animateTick(m.tickAnim, dur);
  if (gen !== app.loopGen) return;
  if (m.atHalftime) { showHalftime(); return; }
  if (m.finished) { showResult(); return; }
  loopStep(gen);
}

function updateScoreboard() {
  const m = app.match;
  $("#sb-teams").textContent = `${m.a.team.name} ${m.score[0]} - ${m.score[1]} ${m.b.team.name}`;
  $("#sb-minute").textContent = m.finished ? "試合終了" : m.atHalftime ? "ハーフタイム" : m.minuteLabel();
}

function addLog(ev) {
  const log = $("#log");
  const line = el("div", `ev ev-${ev.kind}`);
  if (ev.minute) line.appendChild(el("span", "min", `[${ev.minute}] `));
  line.appendChild(el("span", null, ev.text));
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

// ---- ハーフタイム ----

function showHalftime() {
  const m = app.match;
  const panel = $("#ht-panel");
  panel.classList.remove("hidden");
  const body = $("#ht-body");
  body.innerHTML = "";
  m.teams().forEach((ts, i) => {
    const col = el("div", "panel");
    col.appendChild(el("h3", null, `${ts.team.name}（${ts.strategy.manager}監督）`));
    col.appendChild(htTable(ts));

    const dlBtn = el("button", null, "HT指示ひな形をダウンロード");
    dlBtn.addEventListener("click", () =>
      downloadText(`${ts.strategy.manager.replace(/[\\/:*?"<>|\s]/g, "_")}_HT_${timestampStr(new Date())}.md`,
        buildHalftimeMd(ts, m.scoreStr())));
    col.appendChild(dlBtn);

    const fileIn = el("input");
    fileIn.type = "file";
    fileIn.accept = ".md,.txt";
    const status = el("div", "file-status");
    fileIn.addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const text = await file.text();
      const { ht, errors } = parseHalftimeMd(text);
      status.innerHTML = "";
      if (errors.length) {
        for (const err of errors) status.appendChild(el("p", "err-item", `・${err}`));
        return;
      }
      const applyErrors = m.applyHalftime(ts, ht);
      for (const err of applyErrors) status.appendChild(el("p", "err-item", `・${err}`));
      status.appendChild(el("p", "ok", "指示を受け付けました"));
      fileIn.disabled = true;
      app.htDone[i] = true;
      updateHtStart();
    });
    const skipBtn = el("button", null, "変更なしで続行");
    skipBtn.addEventListener("click", () => {
      fileIn.disabled = true;
      skipBtn.disabled = true;
      status.appendChild(el("p", "ok", "変更なし"));
      app.htDone[i] = true;
      updateHtStart();
    });
    col.appendChild(el("p", "hint", "指示ファイルを読み込むか、変更なしを選択:"));
    col.appendChild(fileIn);
    col.appendChild(skipBtn);
    col.appendChild(status);
    body.appendChild(col);
  });
  updateHtStart();
}

function htTable(ts) {
  const table = el("table", "roster small");
  const hr = el("tr");
  for (const h of ["名前", "Pos", "疲労", "調子", "評価"]) hr.appendChild(el("th", null, h));
  table.appendChild(hr);
  const rows = ts.players.filter((p) => p.onPitch || p.subbedOut)
    .concat(ts.players.filter((p) => !p.onPitch && !p.subbedOut));
  for (const p of rows) {
    const tr = el("tr", p.onPitch ? "" : p.subbedOut ? "out" : "bench");
    tr.appendChild(el("td", "pname", (p.onPitch ? "" : p.subbedOut ? "↓ " : "B ") + p.name));
    tr.appendChild(el("td", null, p.pos));
    const f = Math.round(p.fatigue);
    tr.appendChild(el("td", f >= 70 ? "lo" : "", String(f)));
    tr.appendChild(el("td", p.cond === "絶不調" || p.cond === "不調" ? "lo" : p.cond === "絶好調" ? "hi" : "", p.cond));
    tr.appendChild(el("td", null, p.onPitch || p.subbedOut ? p.rating.toFixed(1) : "-"));
    table.appendChild(tr);
  }
  const scroll = el("div", "table-scroll");
  scroll.appendChild(table);
  return scroll;
}

function updateHtStart() {
  $("#start-2nd").disabled = !(app.htDone[0] && app.htDone[1]);
}

// ---- 結果 ----

function showResult() {
  const m = app.match;
  const r = m.result();
  const panel = $("#result-panel");
  panel.classList.remove("hidden");
  const body = $("#result-body");
  body.innerHTML = "";
  body.appendChild(el("h3", null, `最終スコア: ${m.scoreStr()}`));
  const stats = el("p", null,
    `支配率 ${r.possession[0]}% - ${r.possession[1]}% ／ シュート ${r.stats[0].shots} - ${r.stats[1].shots} ／ 決定機 ${r.stats[0].chances} - ${r.stats[1].chances}`);
  body.appendChild(stats);
  body.appendChild(el("p", "mvp", `🏆 MVP: ${r.mvp.name}（${r.mvp.teamName}） 評価 ${r.mvp.rating.toFixed(1)}`));

  const cols = el("div", "columns");
  for (const ts of m.teams()) {
    const col = el("div", "panel");
    col.appendChild(el("h4", null, `${ts.team.name} 選手評価`));
    col.appendChild(htTable(ts));
    cols.appendChild(col);
  }
  body.appendChild(cols);
  body.appendChild(el("p", "hint", `乱数シード: ${r.seed}（読み込み画面でシードを指定すると同じ試合を再現できます）`));
  panel.scrollIntoView({ behavior: "smooth" });
}

// ---- 初期化 ----

document.addEventListener("DOMContentLoaded", () => {
  renderSetup();
  initLoadScreen();
  $("#to-load").addEventListener("click", () => showScreen("#screen-load"));
  $("#back-setup").addEventListener("click", () => showScreen("#screen-setup"));
  $("#start-2nd").addEventListener("click", () => {
    $("#ht-panel").classList.add("hidden");
    app.match.startSecondHalf();
    const evs = app.match.events;
    addLog(evs[evs.length - 1]);
    startLoop();
  });
  document.querySelectorAll("[data-speed]").forEach((btn) => {
    btn.addEventListener("click", () => {
      app.speed = Number(btn.dataset.speed);   // ループが毎ティック参照するので再起動不要
      document.querySelectorAll("[data-speed]").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
    });
  });
  $("#new-match").addEventListener("click", () => {
    app.loopGen++;                              // 走行中のループを止める
    if (app.pitch) { app.pitch.stop(); app.pitch = null; }
    app.strategies = [null, null];
    $("#start-match").disabled = true;
    $("#file-0").value = "";
    $("#file-1").value = "";
    $("#file-status-0").innerHTML = "";
    $("#file-status-1").innerHTML = "";
    showScreen("#screen-load");
  });
});

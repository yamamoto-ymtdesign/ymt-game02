// 戦略ファイル / ハーフタイム指示ファイルの生成とパース

const FORMATIONS = {
  "4-4-2": { DF: 4, MF: 4, FW: 2, mid: 0, chance: 0, concede: 0 },
  "4-3-3": { DF: 4, MF: 3, FW: 3, mid: 0, chance: 0.02, concede: 0.02 },
  "3-5-2": { DF: 3, MF: 5, FW: 2, mid: 2, chance: 0, concede: 0.01 },
  "4-2-3-1": { DF: 4, MF: 5, FW: 1, mid: 1, chance: 0, concede: -0.01 },
  "5-3-2": { DF: 5, MF: 3, FW: 2, mid: -1, chance: -0.02, concede: -0.04 },
};
const ATTACK_STYLES = ["ポゼッション", "カウンター", "サイドアタック", "ロングボール"];
const DEFENSE_STYLES = ["ハイプレス", "ゾーン", "リトリート", "マンマーク"];
const LINES = ["高い", "普通", "低い"];
const TEMPOS = ["速い", "普通", "遅い"];
const TRUMPS = ["スーパーサブ", "ギアチェンジ", "鉄壁モード", "パワープレー"];
const CONDITIONS = ["前半", "後半", "終盤", "リード", "同点", "ビハインド",
  "2点差リード", "2点差ビハインド", "主力疲労"];
const CHANGEABLE = ["攻撃スタイル", "守備スタイル", "ライン設定", "テンポ"];
const POS_ORDER = ["GK", "DF", "MF", "FW"];

function timestampStr(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function checkboxGroup(title, options, selected) {
  const lines = [`### ${title}（1つだけ [x]）`, ""];
  for (const o of options) lines.push(`- [${o === selected ? "x" : " "}] ${o}`);
  return lines.join("\n");
}

// セットアップ画面の選択内容から、記入・編集用の戦略.mdを生成する
function buildStrategyMd(sel) {
  const team = TEAMS_DATA[sel.teamKey];
  const starters = sel.starters; // {GK:[names], DF:[...], MF:[...], FW:[...]}
  const starterSet = new Set(Object.values(starters).flat());
  const bench = team.players.filter((p) => !starterSet.has(p.name));
  const benchStr = bench.map((p) => `${p.name}(${p.pos})`).join(", ");
  const benchFw = bench.find((p) => p.pos === "FW") || bench[0];
  const now = new Date();

  return `# テキストイレブン 戦略ファイル

<!--
  このファイルを編集して戦術を決め、「読み込み画面」で読み込ませてください。
  ・チェックボックスは各グループ1つだけ [x] にする（他は [ ] のまま）
  ・スターティングメンバーは選択済み。書き換える場合はロスターの表記と
    フォーメーションの人数構成（下記コメント参照）を守ること
  ・<!- - で始まるコメント行と自由記述は読み込み時に無視されます
-->

## チーム情報

監督名: ${sel.manager}
使用チーム: ${team.name}
作成日時: ${now.toLocaleString("ja-JP")}

## 基本戦術

フォーメーション: ${sel.formation}
<!-- 選択肢: 4-4-2 / 4-3-3 / 3-5-2 / 4-2-3-1 / 5-3-2
     変更する場合はスターティングメンバーの人数構成も合わせること -->

${checkboxGroup("攻撃スタイル", ATTACK_STYLES, "ポゼッション")}

${checkboxGroup("守備スタイル", DEFENSE_STYLES, "ゾーン")}

${checkboxGroup("ライン設定", LINES, "普通")}

${checkboxGroup("テンポ", TEMPOS, "普通")}

## スターティングメンバー

GK: ${starters.GK.join(", ")}
DF: ${starters.DF.join(", ")}
MF: ${starters.MF.join(", ")}
FW: ${starters.FW.join(", ")}

<!-- ベンチ: ${benchStr} -->

## 状況別指示

<!--
  0〜3個。書式: - IF 条件 THEN 変更項目=値, 変更項目=値
  条件: 前半 / 後半 / 終盤(70分以降) / リード / 同点 / ビハインド /
        2点差リード / 2点差ビハインド / 主力疲労 （ANDで最大3つ連結）
  変更項目: 攻撃スタイル / 守備スタイル / ライン設定 / テンポ
  不要な指示は行ごと削除してください
-->

- IF 終盤 AND リード THEN 守備スタイル=リトリート, テンポ=遅い

## 切り札

${checkboxGroup("種類", TRUMPS, "スーパーサブ")}

発動条件: IF 後半 AND ビハインド
指名選手: ${benchFw ? benchFw.name : ""}
<!-- 指名選手はスーパーサブの場合のみ必須。ベンチの選手から選ぶこと -->

## 意気込み

（自由記述。試合判定には影響しません）
`;
}

// ---- パース ----

function normalizeLine(line) {
  return line.replace(/：/g, ":").replace(/->/g, "→").trim();
}

// md をセクションごとの行リストに分解（### 小見出しもセクション内で扱う）
function splitSections(text) {
  const noComments = text.replace(/<!--[\s\S]*?-->/g, "");
  const sections = {};
  let current = null;
  for (const raw of noComments.split(/\r?\n/)) {
    const m = raw.match(/^##\s+(.+?)\s*$/);
    if (m) { current = m[1]; sections[current] = []; continue; }
    if (current && raw.trim() !== "") sections[current].push(raw);
  }
  return sections;
}

function parseCheckboxGroups(lines) {
  // {グループ名: [選択された値, ...]}
  const groups = {};
  let g = null;
  for (const raw of lines) {
    const h = raw.match(/^###\s+(.+?)（.*$/) || raw.match(/^###\s+(.+?)\s*$/);
    if (h) { g = h[1].trim(); groups[g] = []; continue; }
    const c = raw.match(/^-\s*\[([xXｘＸ])\]\s*(.+?)\s*$/);
    if (c && g) groups[g].push(c[2]);
  }
  return groups;
}

function parseKeyValues(lines) {
  const kv = {};
  for (const raw of lines) {
    const line = normalizeLine(raw);
    if (line.startsWith("-") || line.startsWith("#")) continue;
    const m = line.match(/^([^:]+):\s*(.*)$/);
    if (m) kv[m[1].trim()] = m[2].trim();
  }
  return kv;
}

function parseIfRules(lines, errors, label) {
  const rules = [];
  for (const raw of lines) {
    const line = normalizeLine(raw);
    const m = line.match(/^-\s*IF\s+(.+?)\s+THEN\s+(.+)$/i);
    if (!m) continue;
    const conds = m[1].split(/\s+AND\s+/i).map((s) => s.trim());
    for (const c of conds) {
      if (!CONDITIONS.includes(c)) errors.push(`${label}: 未定義の条件「${c}」`);
    }
    if (conds.length > 3) errors.push(`${label}: 条件のAND連結は3つまでです`);
    const changes = {};
    for (const part of m[2].split(/[,、]/)) {
      const cm = part.trim().match(/^(.+?)\s*=\s*(.+)$/);
      if (!cm) { errors.push(`${label}: 変更の書式が不正「${part.trim()}」`); continue; }
      const key = cm[1].trim(), val = cm[2].trim();
      if (!CHANGEABLE.includes(key)) { errors.push(`${label}: 変更できない項目「${key}」`); continue; }
      const valid = { "攻撃スタイル": ATTACK_STYLES, "守備スタイル": DEFENSE_STYLES,
        "ライン設定": LINES, "テンポ": TEMPOS }[key];
      if (!valid.includes(val)) { errors.push(`${label}: 「${key}」に無い値「${val}」`); continue; }
      changes[key] = val;
    }
    rules.push({ conds, changes });
  }
  return rules;
}

function pickOne(groups, name, options, errors, label) {
  const sel = groups[name] || [];
  if (sel.length === 0) { errors.push(`${label}: 「${name}」がどれも選択されていません（[x] を1つ付けてください）`); return null; }
  if (sel.length > 1) { errors.push(`${label}: 「${name}」が複数選択されています（${sel.join(", ")}）`); return null; }
  if (!options.includes(sel[0])) { errors.push(`${label}: 「${name}」に無い値「${sel[0]}」`); return null; }
  return sel[0];
}

// チェックボックス形式を優先し、無ければ「キー: 値」形式で解釈する
function pickTactic(groups, kv, name, options, errors, label) {
  const checks = groups[name] || [];
  if (checks.length === 0 && kv[name] !== undefined) {
    if (!options.includes(kv[name])) { errors.push(`${label}: 「${name}」に無い値「${kv[name]}」`); return null; }
    return kv[name];
  }
  return pickOne(groups, name, options, errors, label);
}

function parseCondExpr(str, errors, label) {
  const s = normalizeLine(str).replace(/^IF\s+/i, "");
  if (!s) return [];
  const conds = s.split(/\s+AND\s+/i).map((x) => x.trim());
  for (const c of conds) {
    if (!CONDITIONS.includes(c)) errors.push(`${label}: 未定義の条件「${c}」`);
  }
  return conds;
}

// 戦略ファイル全体をパースして {strategy, errors} を返す
function parseStrategyMd(text) {
  const errors = [];
  const sec = splitSections(text);
  for (const name of ["チーム情報", "基本戦術", "スターティングメンバー", "状況別指示", "切り札"]) {
    if (!sec[name]) errors.push(`必須セクション「## ${name}」がありません`);
  }
  if (errors.length) return { strategy: null, errors };

  const info = parseKeyValues(sec["チーム情報"]);
  const manager = info["監督名"] || "";
  if (!manager) errors.push("チーム情報: 監督名がありません");
  const teamKey = Object.keys(TEAMS_DATA).find((k) => TEAMS_DATA[k].name === info["使用チーム"]);
  if (!teamKey) errors.push(`チーム情報: 使用チーム「${info["使用チーム"] || ""}」が不正です`);

  const tacticsKv = parseKeyValues(sec["基本戦術"]);
  const groups = parseCheckboxGroups(sec["基本戦術"]);
  const formation = tacticsKv["フォーメーション"];
  if (!FORMATIONS[formation]) errors.push(`基本戦術: フォーメーション「${formation || ""}」が不正です`);
  // チェックボックス形式（アプリが生成する形）を優先し、無ければ「キー: 値」形式にフォールバック
  const attack = pickTactic(groups, tacticsKv, "攻撃スタイル", ATTACK_STYLES, errors, "基本戦術");
  const defense = pickTactic(groups, tacticsKv, "守備スタイル", DEFENSE_STYLES, errors, "基本戦術");
  const line = pickTactic(groups, tacticsKv, "ライン設定", LINES, errors, "基本戦術");
  const tempo = pickTactic(groups, tacticsKv, "テンポ", TEMPOS, errors, "基本戦術");

  let starters = null;
  if (teamKey && FORMATIONS[formation]) {
    const team = TEAMS_DATA[teamKey];
    const kv = parseKeyValues(sec["スターティングメンバー"]);
    starters = {};
    const need = { GK: 1, ...FORMATIONS[formation] };
    const seen = new Set();
    for (const pos of POS_ORDER) {
      const names = (kv[pos] || "").split(/[,、]/).map((s) => s.trim()).filter(Boolean);
      starters[pos] = names;
      if (names.length !== need[pos]) {
        errors.push(`スタメン: ${pos} は ${need[pos]}人必要ですが ${names.length}人です（${formation}）`);
      }
      for (const n of names) {
        const p = team.players.find((x) => x.name === n);
        if (!p) errors.push(`スタメン: 「${n}」は${team.name}のロスターにいません`);
        else if (p.pos !== pos) errors.push(`スタメン: ${n} は ${p.pos} 登録です（${pos} 欄に書けません）`);
        if (seen.has(n)) errors.push(`スタメン: 「${n}」が重複しています`);
        seen.add(n);
      }
    }
  }

  const rules = parseIfRules(sec["状況別指示"], errors, "状況別指示");
  if (rules.length > 3) errors.push(`状況別指示は3つまでです（${rules.length}個あります）`);

  const trumpGroups = parseCheckboxGroups(sec["切り札"]);
  const trumpKv = parseKeyValues(sec["切り札"]);
  const trumpType = pickTactic(trumpGroups, trumpKv, "種類", TRUMPS, errors, "切り札");
  const trumpConds = parseCondExpr(trumpKv["発動条件"] || "", errors, "切り札");
  let trumpPlayer = trumpKv["指名選手"] || "";
  if (trumpType === "スーパーサブ") {
    if (!trumpPlayer) errors.push("切り札: スーパーサブには指名選手が必要です");
    else if (teamKey && starters) {
      const starterSet = new Set(Object.values(starters).flat());
      const p = TEAMS_DATA[teamKey].players.find((x) => x.name === trumpPlayer);
      if (!p) errors.push(`切り札: 指名選手「${trumpPlayer}」はロスターにいません`);
      else if (starterSet.has(trumpPlayer)) errors.push(`切り札: 指名選手「${trumpPlayer}」はスタメンです（ベンチから選ぶこと）`);
    }
  }

  if (errors.length) return { strategy: null, errors };
  return {
    strategy: {
      manager, teamKey, formation,
      tactics: { attack, defense, line, tempo },
      starters, rules,
      trump: { type: trumpType, conds: trumpConds, player: trumpPlayer },
    },
    errors: [],
  };
}

// ---- ハーフタイム指示ファイル ----

// 試合状態からHT指示ファイルのひな形を生成する
function buildHalftimeMd(ts, score) {
  const onPitch = ts.players.filter((p) => p.onPitch);
  const bench = ts.players.filter((p) => !p.onPitch && !p.subbedOut);
  const fmt = (p) => `${p.name}(${p.pos} 疲労${Math.round(p.fatigue)} ${p.cond} 評価${p.rating.toFixed(1)})`;
  return `# ハーフタイム指示ファイル — ${ts.strategy.manager}（${ts.team.name}）

<!--
  前半終了 ${score}。
  セクションはすべて任意。書いたものだけが適用されます。提出しなくても構いません。
  出場中: ${onPitch.map(fmt).join(", ")}
  ベンチ: ${bench.map(fmt).join(", ")}
-->

## 選手交代

<!-- 最大3人。書式: - OUT: 選手名 → IN: 選手名
     交代後の11人が(変更後の)フォーメーションの人数構成と一致していること -->

## 戦術変更

<!-- 変更したい項目だけ残す。フォーメーション変更時は交代で人数構成を合わせること
フォーメーション: 4-4-2
攻撃スタイル: カウンター
守備スタイル: リトリート
ライン設定: 低い
テンポ: 遅い
-->

## 状況別指示

<!-- このセクションに1つでも書くと、前半の指示は破棄され置き換わります（最大3つ） -->

## 切り札

<!-- 前半に未使用の場合のみ変更できます
種類: パワープレー
発動条件: IF 終盤 AND ビハインド
指名選手:
-->
`;
}

// HT指示ファイルをパースして {ht, errors} を返す（検証は試合状態に依存する分のみ後段）
function parseHalftimeMd(text) {
  const errors = [];
  const sec = splitSections(text);
  const ht = { subs: [], tactics: {}, rules: null, trump: null };

  if (sec["選手交代"]) {
    for (const raw of sec["選手交代"]) {
      const line = normalizeLine(raw);
      const m = line.match(/^-\s*OUT:\s*(.+?)\s*→\s*IN:\s*(.+?)\s*$/);
      if (m) ht.subs.push({ out: m[1].trim(), in: m[2].trim() });
      else if (line.startsWith("-")) errors.push(`選手交代: 書式が不正「${line}」`);
    }
    if (ht.subs.length > 3) errors.push(`選手交代は3人までです（${ht.subs.length}人）`);
  }

  if (sec["戦術変更"]) {
    const kv = parseKeyValues(sec["戦術変更"]);
    const valid = { "フォーメーション": Object.keys(FORMATIONS), "攻撃スタイル": ATTACK_STYLES,
      "守備スタイル": DEFENSE_STYLES, "ライン設定": LINES, "テンポ": TEMPOS };
    for (const [k, v] of Object.entries(kv)) {
      if (!valid[k]) { errors.push(`戦術変更: 変更できない項目「${k}」`); continue; }
      if (!valid[k].includes(v)) { errors.push(`戦術変更: 「${k}」に無い値「${v}」`); continue; }
      ht.tactics[k] = v;
    }
  }

  if (sec["状況別指示"]) {
    const rules = parseIfRules(sec["状況別指示"], errors, "状況別指示");
    if (rules.length > 3) errors.push("状況別指示は3つまでです");
    if (rules.length > 0) ht.rules = rules;
  }

  if (sec["切り札"]) {
    const kv = parseKeyValues(sec["切り札"]);
    if (kv["種類"]) {
      if (!TRUMPS.includes(kv["種類"])) errors.push(`切り札: 無い種類「${kv["種類"]}」`);
      else ht.trump = {
        type: kv["種類"],
        conds: parseCondExpr(kv["発動条件"] || "", errors, "切り札"),
        player: kv["指名選手"] || "",
      };
    }
  }

  return { ht, errors };
}

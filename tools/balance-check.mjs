#!/usr/bin/env node
// 全10チームの総当たりバランス検証。各チームに「らしい」戦術を与え、
// 各カード N 試合ずつシミュレートして勝率の偏りを確認する。
//   node tools/balance-check.mjs [試合数/カード]

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ctx = { console };
vm.createContext(ctx);
for (const f of ["js/teams-data.js", "js/md.js", "js/engine.js"]) {
  vm.runInContext(fs.readFileSync(path.join(root, f), "utf-8"), ctx, { filename: f });
}
// これらは const 宣言なのでコンテキストの global には載らない。式評価で取り出す
const { TEAMS_DATA, FORMATIONS, Match } = vm.runInContext(
  "({ TEAMS_DATA, FORMATIONS, Match })", ctx);

// チームごとの代表的な戦術セット（アーキタイプに沿った選択）
const PRESETS = {
  japan: { formation: "4-3-3", attack: "ポゼッション", defense: "ハイプレス", line: "高い", tempo: "速い" },
  spain: { formation: "4-3-3", attack: "ポゼッション", defense: "ゾーン", line: "普通", tempo: "遅い" },
  brazil: { formation: "4-3-3", attack: "ポゼッション", defense: "ゾーン", line: "普通", tempo: "普通" },
  england: { formation: "4-4-2", attack: "ロングボール", defense: "ハイプレス", line: "高い", tempo: "普通" },
  germany: { formation: "4-4-2", attack: "ロングボール", defense: "ハイプレス", line: "高い", tempo: "速い" },
  italy: { formation: "5-3-2", attack: "カウンター", defense: "リトリート", line: "低い", tempo: "遅い" },
  france: { formation: "4-3-3", attack: "カウンター", defense: "ゾーン", line: "普通", tempo: "普通" },
  argentina: { formation: "4-2-3-1", attack: "ポゼッション", defense: "マンマーク", line: "普通", tempo: "普通" },
  netherlands: { formation: "4-4-2", attack: "ポゼッション", defense: "ゾーン", line: "普通", tempo: "普通" },
  portugal: { formation: "4-3-3", attack: "カウンター", defense: "ゾーン", line: "普通", tempo: "速い" },
};

function bestXI(teamKey, formation) {
  const team = TEAMS_DATA[teamKey];
  const need = { GK: 1, ...FORMATIONS[formation] };
  const starters = {};
  for (const pos of ["GK", "DF", "MF", "FW"]) {
    starters[pos] = team.players.filter((p) => p.pos === pos)
      .sort((a, b) => b.stats.reduce((x, y) => x + y) - a.stats.reduce((x, y) => x + y))
      .slice(0, need[pos]).map((p) => p.name);
  }
  return starters;
}

function makeStrategy(teamKey) {
  const t = PRESETS[teamKey];
  const starters = bestXI(teamKey, t.formation);
  const starterSet = new Set(Object.values(starters).flat());
  const benchFw = TEAMS_DATA[teamKey].players.find((p) => p.pos === "FW" && !starterSet.has(p.name));
  return {
    manager: teamKey, teamKey, formation: t.formation,
    tactics: { attack: t.attack, defense: t.defense, line: t.line, tempo: t.tempo },
    starters,
    rules: [
      { conds: ["終盤", "リード"], changes: { "守備スタイル": "リトリート", "テンポ": "遅い" } },
      { conds: ["後半", "ビハインド"], changes: { "ライン設定": "高い", "テンポ": "速い" } },
    ],
    trump: { type: "スーパーサブ", conds: ["後半", "ビハインド"],
      player: benchFw ? benchFw.name : "" },
  };
}

const N = parseInt(process.argv[2] || "100", 10);
const keys = Object.keys(PRESETS);
const wins = {}, points = {};
for (const k of keys) { wins[k] = {}; points[k] = 0; }

let totalGoals = 0, totalGames = 0;
for (let i = 0; i < keys.length; i++) {
  for (let j = i + 1; j < keys.length; j++) {
    const [ka, kb] = [keys[i], keys[j]];
    let aw = 0, bw = 0, dr = 0;
    for (let g = 0; g < N; g++) {
      const m = new Match(makeStrategy(ka), makeStrategy(kb), (i * 131 + j * 17 + g) * 2654435761);
      while (!m.finished) { if (m.atHalftime) m.startSecondHalf(); m.step(); }
      totalGoals += m.score[0] + m.score[1];
      totalGames++;
      if (m.score[0] > m.score[1]) aw++; else if (m.score[0] < m.score[1]) bw++; else dr++;
    }
    wins[ka][kb] = aw / N;
    wins[kb][ka] = bw / N;
    points[ka] += aw * 3 + dr;
    points[kb] += bw * 3 + dr;
  }
}

const name = (k) => TEAMS_DATA[k].name;
console.log(`カードごとの試合数: ${N} ／ 平均総得点: ${(totalGoals / totalGames).toFixed(2)}\n`);
console.log("勝率マトリクス（行チーム側の勝率、太字=70%超は要注意）");
console.log(["".padEnd(8), ...keys.map((k) => name(k).slice(0, 3).padEnd(4))].join(""));
let flagged = 0;
for (const ka of keys) {
  const row = [name(ka).padEnd(8)];
  for (const kb of keys) {
    if (ka === kb) { row.push("-".padEnd(4)); continue; }
    const w = wins[ka][kb];
    row.push(((w >= 0.7 ? "*" : "") + Math.round(w * 100)).padEnd(4));
    if (w >= 0.7) flagged++;
  }
  console.log(row.join(""));
}
console.log("\n総合勝点（全カード合計、リーグ戦想定）");
for (const k of keys.slice().sort((a, b) => points[b] - points[a])) {
  console.log(`  ${name(k).padEnd(8)} ${points[k]}`);
}
console.log(flagged ? `\n⚠ 勝率70%超のカードが ${flagged} 件あります` : "\n✅ 勝率70%超のカードなし");

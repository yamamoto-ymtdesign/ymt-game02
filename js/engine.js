// 試合シミュレーションエンジン
// 1ティック = 試合内2分。前半23 + 後半23 + アディショナルタイム

const S = { SPEED: 0, PASS: 1, DRIBBLE: 2, SHOOT: 3, DEF: 4, AERIAL: 5, STAMINA: 6, MENTAL: 7 };

const CONDS = [
  { name: "絶好調", mult: 1.08, p: 0.10, icon: "☀" },
  { name: "好調", mult: 1.04, p: 0.25, icon: "🙂" },
  { name: "普通", mult: 1.00, p: 0.40, icon: "" },
  { name: "不調", mult: 0.96, p: 0.20, icon: "😐" },
  { name: "絶不調", mult: 0.92, p: 0.05, icon: "🌧" },
];

// 相性マトリクス [攻撃スタイル][守備スタイル] → チャンス確率補正
const MATRIX = {
  "ポゼッション": { "ハイプレス": -0.10, "ゾーン": 0, "リトリート": 0.10, "マンマーク": 0.10 },
  "カウンター": { "ハイプレス": 0.15, "ゾーン": 0, "リトリート": -0.10, "マンマーク": 0 },
  "サイドアタック": { "ハイプレス": 0, "ゾーン": 0.10, "リトリート": 0, "マンマーク": -0.10 },
  "ロングボール": { "ハイプレス": 0.10, "ゾーン": -0.10, "リトリート": 0, "マンマーク": 0 },
};

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class TeamState {
  constructor(strategy, rng) {
    this.strategy = strategy;
    this.team = TEAMS_DATA[strategy.teamKey];
    this.formation = strategy.formation;
    this.base = { ...strategy.tactics };   // 基本戦術（HTで書き換わる）
    this.rules = strategy.rules;
    this.trump = { ...strategy.trump, used: false, activeUntil: -1, afterUntil: -1, subPlayer: null };
    this.subsLeft = 3;
    this.stats = { shots: 0, chances: 0, goals: 0, possession: 0 };
    const starterSet = new Set(Object.values(strategy.starters).flat());
    this.players = this.team.players.map((p) => {
      const roll = rng();
      let acc = 0, cond = CONDS[2];
      for (const c of CONDS) { acc += c.p; if (roll < acc) { cond = c; break; } }
      return {
        name: p.name, pos: p.pos, stats: p.stats,
        cond: cond.name, condIcon: cond.icon, condMult: cond.mult,
        fatigue: 0, rating: 6.0, onPitch: starterSet.has(p.name), subbedOut: false,
      };
    });
  }

  onPitch(pos) {
    return this.players.filter((p) => p.onPitch && (!pos || p.pos === pos));
  }

  eff(p, i) { // コンディション・疲労込みの実効能力
    let m = p.condMult;
    if (p.fatigue >= 90) m *= 0.8; else if (p.fatigue >= 70) m *= 0.9;
    return p.stats[i] * m;
  }

  avg(players, fn) {
    if (players.length === 0) return 0;
    return players.reduce((a, p) => a + fn(p), 0) / players.length;
  }

  // チーム値（1〜10スケール）を出場11人から導出
  values() {
    const fw = this.onPitch("FW"), mf = this.onPitch("MF"), df = this.onPitch("DF");
    const gk = this.onPitch("GK")[0];
    const all = this.onPitch();
    const atkOf = (p) => this.eff(p, S.SHOOT) * 0.5 + this.eff(p, S.DRIBBLE) * 0.3 + this.eff(p, S.PASS) * 0.2;
    return {
      attack: (this.avg(fw, atkOf) * 0.65 + this.avg(mf, atkOf) * 0.35) / 10,
      defense: (this.avg(df, (p) => this.eff(p, S.DEF) * 0.6 + this.eff(p, S.AERIAL) * 0.4) * 0.6
        + (gk ? this.eff(gk, S.DEF) : 60) * 0.25
        + this.avg(mf, (p) => this.eff(p, S.DEF)) * 0.15) / 10,
      technique: this.avg(mf, (p) => this.eff(p, S.PASS) * 0.6 + this.eff(p, S.DRIBBLE) * 0.4) / 10,
      aerial: (this.avg(fw, (p) => this.eff(p, S.AERIAL)) * 0.6 + this.avg(df, (p) => this.eff(p, S.AERIAL)) * 0.4) / 10,
      speed: this.avg(all, (p) => this.eff(p, S.SPEED)) / 10,
      stamina: this.avg(all, (p) => this.eff(p, S.STAMINA)) / 10,
      mental: this.avg(all, (p) => this.eff(p, S.MENTAL)) / 10,
    };
  }

  avgFatigue() { return this.avg(this.onPitch(), (p) => p.fatigue); }
}

class Match {
  constructor(stratA, stratB, seed) {
    this.seed = seed >>> 0;
    this.rng = mulberry32(this.seed);
    this.a = new TeamState(stratA, this.rng);
    this.b = new TeamState(stratB, this.rng);
    this.score = [0, 0];
    this.half = 1;
    this.tick = 0;
    this.fhTicks = 23 + (this.rng() < 0.5 ? 1 : 0);       // 前半 45分+ロスタイム
    this.shTicks = 23 + 1 + Math.floor(this.rng() * 2);   // 後半 45分+ロスタイム1〜3
    this.finished = false;
    this.atHalftime = false;
    this.events = [];
  }

  teams() { return [this.a, this.b]; }
  other(ts) { return ts === this.a ? this.b : this.a; }
  idx(ts) { return ts === this.a ? 0 : 1; }

  minute() {
    if (this.half === 1) return Math.min((this.tick + 1) * 2, 45);
    return Math.min(45 + (this.tick - this.fhTicks + 1) * 2, 90);
  }
  minuteLabel() {
    const base = this.half === 1 ? this.fhTicks : this.fhTicks + this.shTicks;
    const over = this.half === 1 ? this.tick - 22 : this.tick - this.fhTicks - 22;
    if (over > 0) return this.half === 1 ? `前半 45+${over}分` : `後半 90+${over}分`;
    return this.half === 1 ? `前半 ${String(this.minute()).padStart(2, "0")}分`
      : `後半 ${String(this.minute()).padStart(2, "0")}分`;
  }

  scoreDiff(ts) { return this.score[this.idx(ts)] - this.score[1 - this.idx(ts)]; }

  condMet(ts, cond) {
    const d = this.scoreDiff(ts);
    switch (cond) {
      case "前半": return this.half === 1;
      case "後半": return this.half === 2;
      case "終盤": return this.half === 2 && this.minute() >= 70;
      case "リード": return d > 0;
      case "同点": return d === 0;
      case "ビハインド": return d < 0;
      case "2点差リード": return d >= 2;
      case "2点差ビハインド": return d <= -2;
      case "主力疲労": return ts.avgFatigue() >= 60;
      default: return false;
    }
  }

  // 状況別指示を適用した現在の戦術
  activeTactics(ts) {
    const t = { ...ts.base };
    const applied = [];
    for (const rule of ts.rules) {
      if (rule.conds.every((c) => this.condMet(ts, c))) {
        const map = { "攻撃スタイル": "attack", "守備スタイル": "defense", "ライン設定": "line", "テンポ": "tempo" };
        for (const [k, v] of Object.entries(rule.changes)) t[map[k]] = v;
        applied.push(rule);
      }
    }
    return { tactics: t, applied };
  }

  log(text, kind = "play") {
    this.events.push({ kind, minute: this.minuteLabel(), text });
  }

  weightedPick(players, weightFn) {
    const ws = players.map(weightFn);
    const total = ws.reduce((a, b) => a + b, 0);
    let r = this.rng() * total;
    for (let i = 0; i < players.length; i++) { r -= ws[i]; if (r <= 0) return players[i]; }
    return players[players.length - 1];
  }

  // 切り札の発動チェックと効果値
  checkTrump(ts) {
    const tr = ts.trump;
    if (tr.used || !tr.conds || tr.conds.length === 0) return;
    if (!tr.conds.every((c) => this.condMet(ts, c))) return;
    if (tr.type === "パワープレー" && this.minute() < 80) return;
    tr.used = true;
    const min = this.minute();
    if (tr.type === "スーパーサブ") {
      const sub = ts.players.find((p) => p.name === tr.player && !p.onPitch && !p.subbedOut);
      if (!sub) { this.log(`${ts.team.name}、切り札スーパーサブは不発（${tr.player}は投入できない）`, "info"); return; }
      const samePos = ts.onPitch(sub.pos);
      const out = samePos.sort((x, y) => y.fatigue - x.fatigue)[0];
      out.onPitch = false; out.subbedOut = true; sub.onPitch = true;
      tr.subPlayer = sub;
      tr.activeUntil = min + 15;
      this.log(`📢 ${ts.team.name}、切り札「スーパーサブ」発動！ ${out.name} に代えて ${sub.name} を投入！`, "trump");
    } else if (tr.type === "ギアチェンジ") {
      tr.activeUntil = min + 10; tr.afterUntil = min + 15;
      this.log(`📢 ${ts.team.name}、切り札「ギアチェンジ」発動！ 一気にギアを上げる！`, "trump");
    } else if (tr.type === "鉄壁モード") {
      tr.activeUntil = min + 15;
      this.log(`📢 ${ts.team.name}、切り札「鉄壁モード」発動！ 全員がペナルティエリアを固める！`, "trump");
    } else if (tr.type === "パワープレー") {
      tr.activeUntil = 999;
      this.log(`📢 ${ts.team.name}、切り札「パワープレー」発動！ GKも上がる総攻撃だ！`, "trump");
    }
  }

  trumpActive(ts, type) {
    const tr = ts.trump;
    return tr.used && tr.type === type && this.minute() <= tr.activeUntil;
  }

  // 1ティックを進める。発生イベントは this.events に積まれる
  step() {
    if (this.finished || this.atHalftime) return;
    const min = this.minute();

    for (const ts of this.teams()) {
      const before = this.activeTactics(ts).applied.length;
      this.checkTrump(ts);
      ts._ruleCount = ts._ruleCount ?? 0;
      const nowApplied = this.activeTactics(ts).applied.length;
      if (nowApplied > ts._ruleCount) this.log(`${ts.team.name}のベンチが動いた！ 指示が飛ぶ`, "info");
      ts._ruleCount = nowApplied;
    }

    const va = this.a.values(), vb = this.b.values();
    const ta = this.activeTactics(this.a).tactics, tb = this.activeTactics(this.b).tactics;

    // 1. 支配権判定
    const midScore = (ts, v, t) => {
      let s = v.technique * 2 + FORMATIONS[ts.formation].mid;
      s += t.tempo === "速い" ? 1 : t.tempo === "遅い" ? -1 : 0;
      const f = ts.avgFatigue();
      s += f >= 75 ? -4 : f >= 60 ? -2 : 0;
      if (this.trumpActive(ts, "ギアチェンジ")) s += 5;
      else if (ts.trump.used && ts.trump.type === "ギアチェンジ" && this.minute() <= ts.trump.afterUntil) s -= 3;
      return s + this.rng() * 10;
    };
    const atkSide = midScore(this.a, va, ta) >= midScore(this.b, vb, tb) ? this.a : this.b;
    const defSide = this.other(atkSide);
    atkSide.stats.possession++;
    const av = atkSide === this.a ? va : vb, dv = atkSide === this.a ? vb : va;
    const at = atkSide === this.a ? ta : tb, dt = atkSide === this.a ? tb : ta;

    // 2. チャンス生成判定
    const cp = this.chanceProb(atkSide, defSide, av, dv, at, dt);
    let goal = false;
    if (this.rng() < cp) {
      goal = this.resolveChance(atkSide, defSide, av, dv, at, dt);
    } else if (this.rng() < 0.18) {
      this.flavor(atkSide, defSide, at);
    }

    // 2b. 速攻判定: カウンター/ロングボールのチームは、相手の攻撃を凌いだ流れから
    //     ボール保持に関係なく速攻チャンスを得られる（通常の40%の確率）
    if (!goal && (dt.attack === "カウンター" || dt.attack === "ロングボール")) {
      const cp2 = this.chanceProb(defSide, atkSide, dv, av, dt, at) * 0.4;
      if (this.rng() < cp2) this.resolveChance(defSide, atkSide, dv, av, dt, at);
    }

    // 疲労蓄積
    for (const ts of this.teams()) {
      const t = ts === this.a ? ta : tb;
      for (const p of ts.onPitch()) {
        let f;
        if (p.pos === "GK") f = 0.3;
        else {
          f = 1.5 + (t.tempo === "速い" ? 0.5 : t.tempo === "遅い" ? -0.3 : 0)
            + (t.defense === "ハイプレス" ? 0.5 : 0);
          f *= 1 - p.stats[S.STAMINA] * 0.004;
          if (ts.trump.subPlayer === p && this.minute() > ts.trump.activeUntil) f *= 2;
        }
        p.fatigue = Math.min(100, p.fatigue + Math.max(0.3, f));
      }
    }

    this.tick++;
    if (this.half === 1 && this.tick >= this.fhTicks) {
      this.atHalftime = true;
      this.log(`🕐 前半終了 ${this.scoreStr()}`, "section");
    } else if (this.half === 2 && this.tick >= this.fhTicks + this.shTicks) {
      this.finished = true;
      this.log(`🏁 試合終了 ${this.scoreStr()}`, "section");
    }
  }

  chanceProb(atkSide, defSide, av, dv, at, dt) {
    let cp = 0.20 + (av.attack - dv.defense) * 0.015;
    cp += MATRIX[at.attack][dt.defense];
    cp += FORMATIONS[atkSide.formation].chance + FORMATIONS[defSide.formation].concede;
    // スタイル適性
    if (at.attack === "ポゼッション") cp += (av.technique - 6) * 0.02;
    if (at.attack === "カウンター") cp += (av.speed - 6) * 0.02;
    if (at.attack === "サイドアタック") cp += (av.aerial - 6) * 0.02;
    if (at.attack === "ロングボール") cp += (av.aerial - 6) * 0.015;
    if (dt.defense === "ハイプレス") cp -= (dv.stamina - 6) * 0.015;
    // ライン設定
    if (at.line === "高い") cp += 0.03;
    if (at.line === "低い") cp -= 0.03;
    if (dt.line === "低い") cp -= 0.03;
    if (dt.line === "高い" && (at.attack === "カウンター" || at.attack === "ロングボール")) cp += 0.05;
    if (dt.line === "高い" && av.speed >= 8) cp += 0.03;
    // メンタル（ビハインド時の粘り）
    if (this.scoreDiff(atkSide) < 0 && av.mental >= 8) cp += 0.03;
    // 切り札
    if (this.trumpActive(atkSide, "スーパーサブ")) cp += 0.08;
    if (this.trumpActive(atkSide, "パワープレー")) cp += 0.12;
    if (this.trumpActive(atkSide, "鉄壁モード")) cp -= 0.05;
    if (this.trumpActive(defSide, "鉄壁モード")) cp -= 0.08;
    return Math.max(0.05, Math.min(0.45, cp));
  }

  // 決定機を解決する。ゴールなら true
  resolveChance(atk, def, av, dv, at, dt) {
    atk.stats.chances++;
    atk.stats.shots++;
    const shooters = atk.onPitch("FW").concat(atk.onPitch("MF"));
    const shooter = this.weightedPick(shooters, (p) => (p.pos === "FW" ? 3 : 1) * (atk.eff(p, S.SHOOT) + atk.eff(p, S.DRIBBLE)));
    const others = atk.onPitch().filter((p) => p !== shooter && p.pos !== "GK");
    const assister = this.weightedPick(others, (p) => atk.eff(p, S.PASS));
    const gk = def.onPitch("GK")[0];

    let gp = 0.25 + (av.attack - dv.defense) * 0.01;
    const min = this.minute();
    if (min >= 70 && this.scoreDiff(def) > 0 && dv.mental <= 4) gp += 0.05;
    if (def.avgFatigue() >= 70) gp += 0.05;
    if (this.trumpActive(def, "パワープレー") && at.attack === "カウンター") gp += 0.10;
    gp = Math.max(0.10, Math.min(0.50, gp));

    shooter.rating += 0.15;
    assister.rating += 0.1;

    const style = at.attack;
    const buildup = {
      "ポゼッション": `${assister.name}が崩しの縦パス、${shooter.name}が抜け出した！`,
      "カウンター": `奪って一気にカウンター！ ${assister.name}のスルーパスに${shooter.name}が走る！`,
      "サイドアタック": `${assister.name}のクロスに${shooter.name}が飛び込む！`,
      "ロングボール": `${assister.name}のロングボール、${shooter.name}が競り勝った！`,
    }[style];

    if (this.rng() < gp) {
      this.score[this.idx(atk)]++;
      atk.stats.goals++;
      shooter.rating += 1.0;
      assister.rating += 0.5;
      if (gk) gk.rating -= 0.3;
      const dfs = def.onPitch("DF");
      if (dfs.length) this.weightedPick(dfs, () => 1).rating -= 0.3;
      this.log(`${buildup}`, "play");
      this.log(`⚽ ゴーーール！！ ${atk.team.name}、${shooter.name}が決めた！ ${this.scoreStr()}`, "goal");
      return true;
    }
    const r = this.rng();
    let endText;
    if (r < 0.45 && gk) { endText = `シュート！ …GK${gk.name}がセーブ！`; gk.rating += 0.4; }
    else if (r < 0.6) endText = `シュートは無情にもポスト直撃！`;
    else endText = `シュート！ …わずかに枠の外！`;
    this.log(`${atk.team.name}、決定機！ ${buildup} ${endText}`, "chance");
    return false;
  }

  flavor(atk, def, at) {
    const pool = [
      `${atk.team.name}がボールを支配し、じわじわと敵陣に迫る`,
      `${def.team.name}、集中した守備でシュートを打たせない`,
      `${atk.team.name}が押し込むが、最後のところで崩せない`,
      `🟨 ${def.team.name}、たまらずファウルで止める`,
      `両チーム、中盤で激しい潰し合いが続く`,
    ];
    this.log(pool[Math.floor(this.rng() * pool.length)], "play");
  }

  scoreStr() {
    return `${this.a.team.name} ${this.score[0]} - ${this.score[1]} ${this.b.team.name}`;
  }

  // HT指示の適用。errors を返す（交代＋フォーメーションは一体で検証し、違反なら適用しない）
  applyHalftime(ts, ht) {
    const errors = [];
    const applied = [];
    // 交代とフォーメーション変更: 交代後の11人が(変更後の)フォーメーション構成と
    // 一致するかを先に検証し、問題がなければまとめて確定する
    const targetFormation = ht.tactics["フォーメーション"] || ts.formation;
    const subErrors = [];
    const outs = [], ins = [];
    if (ht.subs.length > ts.subsLeft) subErrors.push(`交代枠が足りません（残り${ts.subsLeft}）`);
    for (const s of ht.subs) {
      const out = ts.players.find((p) => p.name === s.out && p.onPitch);
      const inn = ts.players.find((p) => p.name === s.in && !p.onPitch && !p.subbedOut);
      if (!out) subErrors.push(`交代: ${s.out} は出場していません`);
      if (!inn) subErrors.push(`交代: ${s.in} は投入できません（ベンチにいない）`);
      if (out && outs.includes(out)) subErrors.push(`交代: ${s.out} が重複しています`);
      if (inn && ins.includes(inn)) subErrors.push(`交代: ${s.in} が重複しています`);
      if (out && inn) { outs.push(out); ins.push(inn); }
    }
    if (subErrors.length === 0) {
      const newXI = ts.onPitch().filter((p) => !outs.includes(p)).concat(ins);
      const need = { GK: 1, ...FORMATIONS[targetFormation] };
      for (const pos of POS_ORDER) {
        const n = newXI.filter((p) => p.pos === pos).length;
        if (n !== need[pos]) subErrors.push(`交代後の構成が${targetFormation}と一致しません（${pos} ${n}/${need[pos]}人）`);
      }
    }
    if (subErrors.length) {
      errors.push(...subErrors, "→ 選手交代・フォーメーション変更は適用されませんでした");
    } else {
      for (let i = 0; i < outs.length; i++) {
        outs[i].onPitch = false; outs[i].subbedOut = true; ins[i].onPitch = true;
        ts.subsLeft--;
        applied.push(`交代 ${outs[i].name} → ${ins[i].name}`);
      }
      if (targetFormation !== ts.formation) {
        ts.formation = targetFormation;
        applied.push(`フォーメーション → ${targetFormation}`);
      }
    }
    // 戦術変更（フォーメーション以外）
    const map = { "攻撃スタイル": "attack", "守備スタイル": "defense", "ライン設定": "line", "テンポ": "tempo" };
    for (const [k, v] of Object.entries(ht.tactics)) {
      if (k === "フォーメーション") continue;
      ts.base[map[k]] = v;
      applied.push(`${k} → ${v}`);
    }
    // 状況別指示
    if (ht.rules) { ts.rules = ht.rules; applied.push("状況別指示を書き換え"); }
    // 切り札
    if (ht.trump) {
      if (ts.trump.used) errors.push("切り札は発動済みのため変更できません（無視されます）");
      else {
        if (ht.trump.type === "スーパーサブ") {
          const p = ts.players.find((x) => x.name === ht.trump.player && !x.onPitch && !x.subbedOut);
          if (!p) { errors.push(`切り札: 指名選手「${ht.trump.player}」はベンチにいません`); }
          else { ts.trump = { ...ht.trump, used: false, activeUntil: -1, afterUntil: -1, subPlayer: null }; applied.push(`切り札 → ${ht.trump.type}`); }
        } else {
          ts.trump = { ...ht.trump, used: false, activeUntil: -1, afterUntil: -1, subPlayer: null };
          applied.push(`切り札 → ${ht.trump.type}`);
        }
      }
    }
    if (applied.length) this.log(`${ts.team.name}ベンチが動く：${applied.join("、")}`, "info");
    return errors;
  }

  startSecondHalf() {
    this.atHalftime = false;
    this.half = 2;
    for (const ts of this.teams()) ts._ruleCount = 0;
    this.log(`⚽ 後半キックオフ！ ${this.scoreStr()}`, "section");
  }

  result() {
    const total = this.a.stats.possession + this.b.stats.possession || 1;
    const all = this.teams().flatMap((ts) => ts.players.filter((p) => p.onPitch || p.subbedOut)
      .map((p) => ({ ...p, teamName: ts.team.name })));
    const mvp = all.reduce((a, b) => (b.rating > a.rating ? b : a));
    return {
      score: this.score,
      possession: [Math.round((this.a.stats.possession / total) * 100),
        Math.round((this.b.stats.possession / total) * 100)],
      stats: [this.a.stats, this.b.stats],
      mvp,
      seed: this.seed,
    };
  }
}

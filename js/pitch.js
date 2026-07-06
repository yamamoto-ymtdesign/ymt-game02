// 2Dピッチ描画（斜め見下ろしの疑似3D）。試合はシステム内で先にシミュレートされ、
// チャンス・ゴールにつながったシーンだけが「ハイライト」として精密に再生される。
// ハイライトは攻撃スタイル別の演出（クロスは弧を描く、カウンターは縦に速い等）を持ち、
// カメラはシューターとゴールが必ず両方映る範囲でズームする。
// スコア（得点時間・得点者つき）は画面の中央下部に常時表示される。

// チームのキット色（primary=ユニフォーム, alt=対戦相手と被ったとき用）
const TEAM_KIT = {
  japan: { primary: "#12409e", alt: "#ffffff" },
  spain: { primary: "#c60b1e", alt: "#f6c700" },
  brazil: { primary: "#f7d117", alt: "#1c9b4b" },
  england: { primary: "#eef1f5", alt: "#cf142b" },
  germany: { primary: "#1a1a1a", alt: "#ffffff" },
  italy: { primary: "#2aa0e6", alt: "#ffffff" },
  france: { primary: "#1a2a8a", alt: "#ffffff" },
  argentina: { primary: "#7cb6e6", alt: "#0b3b8f" },
  netherlands: { primary: "#f36c21", alt: "#ffffff" },
  portugal: { primary: "#0a6b34", alt: "#c8102e" },
};
const DEFAULT_KIT = { primary: "#888888", alt: "#ffffff" };

const M = 0.045;                 // ピッチ外周マージン（正規化）
const GOAL_HALF = 0.09;          // ゴール幅の半分
const DEPTH = { GK: 0.05, DF: 0.24, MF: 0.48, FW: 0.70 }; // 自ゴールからの深さ

// 疑似3D設定：横(幅)方向を圧縮＆シアーして、斜め上から見下ろしたような角度をつくる
const TILT_SQUISH = 0.80;
const TILT_SHEAR = 0.11;
const SCALE_FAR = 0.84;
const SCALE_NEAR = 1.14;

const ZOOM_MAX = 1.9;            // 決定機カメラの最大ズーム

function hexToRgb(h) {
  const s = h.replace("#", "");
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}
function colorDist(a, b) {
  const x = hexToRgb(a), y = hexToRgb(b);
  return Math.abs(x[0] - y[0]) + Math.abs(x[1] - y[1]) + Math.abs(x[2] - y[2]);
}
function textColor(hex) {
  const [r, g, b] = hexToRgb(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? "#111" : "#fff";
}
function resolveKits(keyA, keyB) {
  const A = TEAM_KIT[keyA] || DEFAULT_KIT, B = TEAM_KIT[keyB] || DEFAULT_KIT;
  let cA = A.primary, cB = B.primary;
  if (colorDist(cA, cB) < 130) cB = B.alt;
  if (colorDist(cA, cB) < 130) cB = "#ffffff";
  return [{ fill: cA, text: textColor(cA) }, { fill: cB, text: textColor(cB) }];
}

// ---- 選手の見た目（肌・髪・顔） ----
// 名前から決定的に生成する＝同じ選手はいつも同じ見た目で、識別の手がかりになる

const SKIN_TONES = ["#ffdbb0", "#f0b989", "#c98a5c", "#9c6136", "#6b4023", "#3f2718"];
// 髪色はチーム（国）ごとの傾向を持たせる
const HAIR_POOLS = {
  japan: ["#181414", "#241a12", "#181414", "#3a2a18", "#6e4a22"],
  brazil: ["#181414", "#241a12", "#181414", "#3a2a18", "#100e0e"],
  spain: ["#181414", "#2c2016", "#241a12", "#4a341e"],
  italy: ["#181414", "#2c2016", "#241a12", "#4a341e"],
  portugal: ["#181414", "#2c2016", "#241a12", "#4a341e"],
  argentina: ["#181414", "#2c2016", "#3a2a18", "#6e4a22"],
  france: ["#181414", "#241a12", "#2c2016", "#6e4a22", "#100e0e"],
  england: ["#2c2016", "#4a341e", "#c9a04e", "#a4502a", "#181414"],
  germany: ["#c9a04e", "#4a341e", "#8a6a30", "#181414", "#2c2016"],
  netherlands: ["#c9a04e", "#8a6a30", "#4a341e", "#a4502a", "#2c2016"],
};
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
function look(teamKey, name) {
  const h = hashStr(name);
  const pool = HAIR_POOLS[teamKey] || HAIR_POOLS.japan;
  return {
    skin: SKIN_TONES[h % SKIN_TONES.length],
    hair: pool[(h >> 3) % pool.length],
    style: (h >> 6) % 6,        // 0:短髪 1:坊主 2:前髪 3:長髪 4:カーリー 5:スキンヘッド
    beard: (h >> 9) % 4 === 0,  // 4人に1人はヒゲ
  };
}

const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

class Pitch {
  constructor(canvas, match) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.match = match;
    this.teamKeys = [match.a.strategy.teamKey, match.b.strategy.teamKey];
    this.kits = resolveKits(this.teamKeys[0], this.teamKeys[1]);
    this.ball = { x: 0.5, y: 0.5, height: 0 };
    this.stopped = false;
    this.level = 0;
    this.shot = null;
    this.actors = [];
    this.overlay = { score: [0, 0], goals: [] };
    this.resize();
    this._onResize = () => { this.resize(); this.drawStatic(); };
    window.addEventListener("resize", this._onResize);
    this.drawStatic();
  }

  stop() {
    this.stopped = true;
    if (this._raf) cancelAnimationFrame(this._raf);
    window.removeEventListener("resize", this._onResize);
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth || 640;
    const h = Math.round(w * 0.62);
    this.canvas.style.height = h + "px";
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.W = w; this.H = h;
  }

  // スコア表示（中央下部に常時表示）を更新する
  setOverlay(score, goals) {
    this.overlay = { score: [...score], goals: goals.slice() };
  }

  // 正規化座標 → ピクセル（斜め見下ろしの変換）
  px(nx, ny) {
    const cy = ny - 0.5;
    const y = 0.5 + cy * TILT_SQUISH;
    const x = nx + cy * TILT_SHEAR;
    return [x * this.W, y * this.H];
  }
  depthScale(ny) {
    const t = clamp((ny - M) / (1 - 2 * M), 0, 1);
    return SCALE_FAR + (SCALE_NEAR - SCALE_FAR) * t;
  }
  depthX(side, depth) {
    const inner = 1 - 2 * M;
    return side === 0 ? M + depth * inner : (1 - M) - depth * inner;
  }
  latY(lat) { return M + lat * (1 - 2 * M); }
  attackGoalX(side) { return side === 0 ? 1 - M : M; }

  // 出場中の選手を陣形スロットに割り当てる。names を渡すとそのメンバーで組む
  // （ハイライトは過去のシーンなので、そのティック時点の出場者を使う）
  layout(ts, side, names) {
    const players = names
      ? names.map((n) => ts.players.find((p) => p.name === n)).filter(Boolean)
      : ts.onPitch();
    const groups = { GK: [], DF: [], MF: [], FW: [] };
    for (const p of players) groups[p.pos].push(p);
    const out = [];
    let num = 1;
    for (const pos of POS_ORDER) {
      const n = groups[pos].length;
      groups[pos].forEach((p, i) => {
        out.push({
          num: num++, name: p.name, pos, player: p,
          base: { x: this.depthX(side, DEPTH[pos]), y: this.latY((i + 1) / (n + 1)) },
          fatigue: p.fatigue,
        });
      });
    }
    return out;
  }

  findSlot(slots, name) { return slots.find((s) => s.name === name); }

  shotTarget(side, phase, gkSlot) {
    const gx = this.attackGoalX(side);
    if (phase === "save") return { x: lerp(gx, 0.5, 0.04), y: gkSlot ? gkSlot.base.y : 0.5 };
    if (phase === "goal") {
      const gy = 0.5 + (this.match.rng() - 0.5) * 0.11;
      return { x: side === 0 ? 1 - M * 0.4 : M * 0.4, y: gy };
    }
    if (phase === "post") return { x: gx, y: 0.5 + (this.match.rng() < 0.5 ? -1 : 1) * GOAL_HALF };
    const wide = 0.5 + (this.match.rng() < 0.5 ? -1 : 1) * (GOAL_HALF + 0.045);
    return { x: gx, y: wide };
  }

  // ---- ハイライトの組み立て ----
  // 攻撃スタイルごとに、経由点（w=所要時間の重み, arc=弾道の高さ倍率）と
  // 「移動する選手」(actors) を作る。クロスは大きく弧を描き、ショートパスは地を這う

  buildHighlight(e, atkSlots, defSlots) {
    const side = e.side;
    const goalX = this.attackGoalX(side);
    const dir = side === 0 ? 1 : -1;
    const rng = () => this.match.rng();

    const shooter = (e.shooter && this.findSlot(atkSlots, e.shooter))
      || atkSlots.filter((s) => s.pos === "FW")[0] || atkSlots[atkSlots.length - 1];
    const assister = (e.assister && this.findSlot(atkSlots, e.assister) !== shooter && this.findSlot(atkSlots, e.assister))
      || atkSlots.filter((s) => s.pos === "MF")[0] || atkSlots[0];
    const gk = defSlots.find((s) => s.pos === "GK");
    const mids = atkSlots.filter((s) => s.pos === "MF" && s !== shooter && s !== assister);
    const backs = atkSlots.filter((s) => s.pos === "DF");

    // シューターの最終位置（ボックス内へ走り込む）
    const shooterTo = { x: goalX - dir * (0.08 + rng() * 0.04), y: 0.5 + (rng() - 0.5) * 0.14 };
    const pts = [];
    const actors = [];
    let startBall;

    if (e.style === "サイドアタック") {
      // ウイングへ展開→切り込み→クロスをファーへ→ヘディング
      const wingY = assister.base.y >= 0.5 ? 1 - M - 0.05 : M + 0.05;
      const wingPos = { x: goalX - dir * 0.15, y: wingY };
      startBall = { x: this.depthX(side, 0.45), y: 0.5 };
      pts.push({ ...startBall, w: 0 });
      pts.push({ x: assister.base.x, y: assister.base.y, w: 0.8, arc: 0.4 });
      pts.push({ ...wingPos, w: 1.1, arc: 0.1 });                       // ドリブルで切り込む
      pts.push({ x: shooterTo.x, y: shooterTo.y, w: 1.0, arc: 2.4 });   // クロスが大きく弧を描く
      actors.push({ slot: assister, to: wingPos, at: 0.55 });
      actors.push({ slot: shooter, to: shooterTo, at: 0.75 });
    } else if (e.style === "カウンター") {
      // 自陣で奪って縦に一気に（少ない経由点＝速い）
      const steal = { x: this.depthX(side, 0.2), y: 0.35 + rng() * 0.3 };
      startBall = steal;
      pts.push({ ...steal, w: 0 });
      pts.push({ x: assister.base.x, y: assister.base.y, w: 0.55, arc: 0.15 });
      pts.push({ x: shooterTo.x - dir * 0.06, y: shooterTo.y, w: 0.9, arc: 0.7 }); // 縦一本のスルーパス
      pts.push({ x: shooterTo.x, y: shooterTo.y, w: 0.35, arc: 0 });               // 独走
      actors.push({ slot: shooter, to: shooterTo, at: 0.8 });
    } else if (e.style === "ロングボール") {
      // 最終ラインからの一発ロングフィード（最も高い弧）
      const feeder = backs[Math.floor(rng() * backs.length)] || assister;
      startBall = { x: feeder.base.x, y: feeder.base.y };
      pts.push({ ...startBall, w: 0 });
      pts.push({ x: assister.base.x, y: assister.base.y, w: 0.6, arc: 0.3 });
      pts.push({ x: shooterTo.x - dir * 0.04, y: shooterTo.y, w: 1.3, arc: 3.0 }); // 放り込み
      pts.push({ x: shooterTo.x, y: shooterTo.y, w: 0.4, arc: 0.2 });              // 競り落とす
      actors.push({ slot: shooter, to: shooterTo, at: 0.75 });
    } else {
      // ポゼッション：細かいショートパス（低い弾道）を重ねて崩す
      const relay = mids.length ? mids[Math.floor(rng() * mids.length)] : assister;
      startBall = { x: this.depthX(side, 0.4), y: 0.6 - rng() * 0.2 };
      pts.push({ ...startBall, w: 0 });
      pts.push({ x: relay.base.x, y: relay.base.y, w: 0.6, arc: 0.1 });
      pts.push({ x: assister.base.x, y: assister.base.y, w: 0.6, arc: 0.1 });
      pts.push({ x: lerp(assister.base.x, shooterTo.x, 0.45), y: lerp(assister.base.y, shooterTo.y, 0.4), w: 0.55, arc: 0.1 });
      pts.push({ x: shooterTo.x, y: shooterTo.y, w: 0.8, arc: 0.5 });   // 最後のスルーパス
      actors.push({ slot: shooter, to: shooterTo, at: 0.8 });
    }

    // シュート
    const target = this.shotTarget(side, e.phase, gk);
    pts.push({ x: target.x, y: target.y, w: 0.6, arc: e.phase === "miss" ? 1.0 : 0.35, shot: true });
    this.shot = { defSide: 1 - side, phase: e.phase, targetY: target.y };

    // カメラ：シューター・ゴールマウス・着弾点が必ず全部入るようにズーム量と中心を決める
    const focus = [
      shooterTo, target, { x: goalX, y: 0.5 - GOAL_HALF }, { x: goalX, y: 0.5 + GOAL_HALF },
      { x: goalX - dir * 0.18, y: 0.5 },
    ];
    const camera = this.computeCamera(focus);

    return { pts, actors, startBall, camera, side, phase: e.phase };
  }

  // フォーカス点群がすべて画面内に収まる最大ズームと中心（ピクセル座標）を求める
  computeCamera(focusPts) {
    const pxs = focusPts.map((p) => this.px(p.x, p.y));
    const xs = pxs.map((p) => p[0]), ys = pxs.map((p) => p[1]);
    const pad = this.W * 0.06;
    const x0 = Math.min(...xs) - pad, x1 = Math.max(...xs) + pad;
    const y0 = Math.min(...ys) - pad, y1 = Math.max(...ys) + pad;
    const bw = Math.max(1, x1 - x0), bh = Math.max(1, y1 - y0);
    const zoom = clamp(Math.min(this.W / bw, this.H / bh), 1.15, ZOOM_MAX);
    // 変換 s = p + (q - p)*z で、可視領域の中心が bbox の中心になる p を解く
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const solve = (c, size) => (z) => (c - size / (2 * z)) / (1 - 1 / z);
    let pivotX = zoom > 1.001 ? solve(cx, this.W)(zoom) : this.W / 2;
    let pivotY = zoom > 1.001 ? solve(cy, this.H)(zoom) : this.H / 2;
    // ピボットがキャンバス内にあれば可視領域もキャンバス内に収まる
    pivotX = clamp(pivotX, 0, this.W);
    pivotY = clamp(pivotY, 0, this.H);
    return { zoom, pivot: [pivotX, pivotY] };
  }

  ballAt(pts, p) {
    const total = pts.slice(1).reduce((a, s) => a + s.w, 0) || 1;
    let acc = 0;
    const target = p * total;
    for (let i = 1; i < pts.length; i++) {
      const seg = pts[i].w;
      if (target <= acc + seg || i === pts.length - 1) {
        const local = clamp(seg ? (target - acc) / seg : 1, 0, 1);
        const t = easeInOut(local);
        const dx = pts[i].x - pts[i - 1].x, dy = pts[i].y - pts[i - 1].y;
        const dist = Math.hypot(dx, dy);
        const arcMax = Math.min(0.13, dist * 0.5) * (pts[i].arc ?? Math.min(1, dist * 3));
        return {
          x: lerp(pts[i - 1].x, pts[i].x, t),
          y: lerp(pts[i - 1].y, pts[i].y, t),
          height: arcMax * Math.sin(Math.PI * local),
          shot: pts[i].shot && local > 0.05,
        };
      }
      acc += seg;
    }
    return { x: pts[pts.length - 1].x, y: pts[pts.length - 1].y, height: 0 };
  }

  preShotP(pts) {
    const total = pts.slice(1).reduce((a, s) => a + s.w, 0) || 1;
    const shotW = pts[pts.length - 1].shot ? pts[pts.length - 1].w : 0;
    if (!shotW) return 1;
    return 1 - 0.16 * (shotW / total);
  }

  // ハイライトを再生する。ビルドアップ(ズームイン)→シュート直前で静止→リビール。
  // onReveal は静止が明けて結果が見える瞬間に呼ばれる（実況の結果テキスト用）
  playHighlight(entry, e, duration, onReveal) {
    if (this.stopped) return Promise.resolve();
    this.level = e.phase === "goal" ? 2 : 1;
    const atkSlots = this.layout(e.side === 0 ? this.match.a : this.match.b, e.side, e.side === 0 ? entry.xiA : entry.xiB);
    const defSlots = this.layout(e.side === 0 ? this.match.b : this.match.a, 1 - e.side, e.side === 0 ? entry.xiB : entry.xiA);
    const slotsA = e.side === 0 ? atkSlots : defSlots;
    const slotsB = e.side === 0 ? defSlots : atkSlots;
    const hl = this.buildHighlight(e, atkSlots, defSlots);
    this.actors = hl.actors;
    this.ball = { ...hl.startBall, height: 0 };
    const preP = this.preShotP(hl.pts);
    const BUILD = duration * 0.55, FREEZE = duration * 0.18, REVEAL = duration - BUILD - FREEZE;
    let revealed = false;

    return new Promise((resolve) => {
      const start = performance.now();
      const step = (now) => {
        if (this.stopped) return resolve();
        const el = now - start;
        let p, zoom;
        if (el < BUILD) {
          const b = easeInOut(Math.min(1, el / BUILD));
          p = preP * b;
          zoom = 1 + (hl.camera.zoom - 1) * b;
        } else if (el < BUILD + FREEZE) {
          p = preP;
          zoom = hl.camera.zoom;
        } else {
          if (!revealed) { revealed = true; if (onReveal) onReveal(); }
          const r = Math.min(1, (el - BUILD - FREEZE) / REVEAL);
          p = lerp(preP, 1, Math.min(1, r / 0.35));
          zoom = r < 0.55 ? hl.camera.zoom : lerp(hl.camera.zoom, 1, (r - 0.55) / 0.45);
        }
        const ball = this.ballAt(hl.pts, p);
        this.renderScene(p, e.side, slotsA, slotsB, ball, zoom, hl.camera.pivot, e.phase === "goal" && p >= 1);
        if (el >= duration) {
          this.actors = [];
          this.ball = { x: 0.5, y: 0.5, height: 0 };
          return resolve();
        }
        this._raf = requestAnimationFrame(step);
      };
      this._raf = requestAnimationFrame(step);
    });
  }

  renderScene(p, atkSide, slotsA, slotsB, ball, zoom, pivot, burst) {
    this.fillBackground();
    const ctx = this.ctx;
    ctx.save();
    if (zoom && zoom !== 1 && pivot) {
      ctx.translate(pivot[0], pivot[1]);
      ctx.scale(zoom, zoom);
      ctx.translate(-pivot[0], -pivot[1]);
    }
    this.drawFieldLines();
    const amp = 0.05;
    const shift = Math.sin(Math.PI * p) * amp;
    this.drawTeam(slotsB, 1, atkSide === 1 ? shift : -shift * 0.6, ball, p);
    this.drawTeam(slotsA, 0, atkSide === 0 ? shift : -shift * 0.6, ball, p);
    this.drawBall(ball);
    if (burst) this.drawGoalBurst(ball);
    ctx.restore();
    this.drawOverlay();   // スコアはズームの影響を受けない
  }

  fillBackground() {
    const ctx = this.ctx, W = this.W, H = this.H;
    const grd = ctx.createLinearGradient(0, 0, 0, H);
    grd.addColorStop(0, "#2f9c4a"); grd.addColorStop(1, "#278a40");
    ctx.fillStyle = grd; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "rgba(255,255,255,0.04)";
    const stripes = 8;
    for (let i = 0; i < stripes; i += 2) ctx.fillRect((i / stripes) * W, 0, W / stripes, H);
  }

  drawFieldLines() {
    const ctx = this.ctx;
    ctx.strokeStyle = "rgba(255,255,255,0.75)"; ctx.lineWidth = 1.5;
    const poly = (points) => {
      ctx.beginPath();
      points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
      ctx.closePath();
    };
    poly([[M, M], [1 - M, M], [1 - M, 1 - M], [M, 1 - M]].map(([x, y]) => this.px(x, y)));
    ctx.stroke();
    const [hx1, hy1] = this.px(0.5, M), [hx2, hy2] = this.px(0.5, 1 - M);
    ctx.beginPath(); ctx.moveTo(hx1, hy1); ctx.lineTo(hx2, hy2); ctx.stroke();
    const circlePts = [];
    for (let i = 0; i <= 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      circlePts.push(this.px(0.5 + Math.cos(a) * 0.07, 0.5 + Math.sin(a) * 0.07));
    }
    poly(circlePts); ctx.stroke();
    const [ccx, ccy] = this.px(0.5, 0.5);
    ctx.beginPath(); ctx.arc(ccx, ccy, 2.5, 0, Math.PI * 2); ctx.fillStyle = "rgba(255,255,255,0.8)"; ctx.fill();
    for (const side of [0, 1]) {
      const boxDepth = 0.16, boxHalf = 0.22;
      const nearX = side === 0 ? M : 1 - M;
      const dir = side === 0 ? 1 : -1;
      poly([
        [nearX, 0.5 - boxHalf], [nearX + dir * boxDepth, 0.5 - boxHalf],
        [nearX + dir * boxDepth, 0.5 + boxHalf], [nearX, 0.5 + boxHalf],
      ].map(([x, y]) => this.px(x, y)));
      ctx.stroke();
      poly([
        [nearX, 0.5 - GOAL_HALF], [nearX - dir * 0.02, 0.5 - GOAL_HALF],
        [nearX - dir * 0.02, 0.5 + GOAL_HALF], [nearX, 0.5 + GOAL_HALF],
      ].map(([x, y]) => this.px(x, y)));
      ctx.fillStyle = "rgba(255,255,255,0.85)"; ctx.fill();
    }
  }

  // ハイライト中に走り込む選手（actors）の現在位置
  actorPos(slot, p) {
    const a = this.actors.find((x) => x.slot === slot);
    if (!a) return null;
    const t = easeInOut(clamp(p / a.at, 0, 1));
    return { x: lerp(slot.base.x, a.to.x, t), y: lerp(slot.base.y, a.to.y, t) };
  }

  drawTeam(slots, side, shiftX, ball, progress) {
    const kit = this.kits[side];
    const dir = side === 0 ? 1 : -1;
    for (const s of slots) {
      const moved = this.actorPos(s, progress ?? 1);
      let nx, ny;
      if (moved) {
        nx = moved.x; ny = moved.y;
      } else {
        nx = s.base.x + shiftX * dir;
        ny = s.base.y;
        if (s.pos === "GK") {
          ny = lerp(s.base.y, this.gkTargetY(side, ball), this.level >= 1 ? 0.6 : 0.15);
          nx = s.base.x;
        } else if (this.level >= 1) {
          const dx = ball.x - nx, dy = ball.y - ny;
          const dist = Math.hypot(dx, dy) + 0.001;
          const pull = Math.min(0.06, 0.024 / (dist + 0.15)) * (this.shot && this.shot.defSide === side ? 1.5 : 1);
          nx += (dx / dist) * pull * 0.6;
          ny += (dy / dist) * pull;
        }
      }
      this.drawPlayer(nx, ny, kit, s, this.teamKeys[side]);
    }
  }

  gkTargetY(side, ball) {
    const ownGoalX = side === 0 ? M : 1 - M;
    if (Math.abs(ball.x - ownGoalX) > 0.4) return 0.5;
    if (this.shot && this.shot.defSide === side) {
      if (this.shot.phase === "goal") return 0.5 - Math.sign(this.shot.targetY - 0.5) * 0.05;
      return lerp(0.5, this.shot.targetY, 0.8);
    }
    return lerp(0.5, ball.y, 0.4);
  }

  // 人型（頭＋髪＋顔＋胴体）。見た目は名前から決まるので同じ選手はいつも同じ姿
  drawPlayer(nx, ny, kit, s, teamKey) {
    const ctx = this.ctx, [x, y] = this.px(nx, ny);
    const scale = this.depthScale(ny);
    const r = this.W * 0.017 * scale;
    const bodyCY = y + r * 0.4, bodyRx = r * 0.82, bodyRy = r * 1.05;
    const headR = r * 0.62, headCY = bodyCY - bodyRy - headR * 0.45;
    const lk = look(teamKey, s.name);

    // 影
    ctx.beginPath(); ctx.ellipse(x, y + r * 1.5, r * 0.95, r * 0.4, 0, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(0,0,0,0.18)"; ctx.fill();

    // 胴体
    ctx.beginPath(); ctx.ellipse(x, bodyCY, bodyRx, bodyRy, 0, 0, Math.PI * 2);
    ctx.fillStyle = kit.fill; ctx.fill();
    ctx.lineWidth = 1; ctx.strokeStyle = "rgba(0,0,0,0.4)"; ctx.stroke();

    // 頭（肌）
    ctx.beginPath(); ctx.arc(x, headCY, headR, 0, Math.PI * 2);
    ctx.fillStyle = lk.skin; ctx.fill();
    ctx.lineWidth = 1; ctx.strokeStyle = "rgba(0,0,0,0.35)"; ctx.stroke();

    // 髪型
    ctx.fillStyle = lk.hair;
    if (lk.style === 0) {         // 短髪：上半分のキャップ
      ctx.beginPath(); ctx.arc(x, headCY, headR, Math.PI, 0); ctx.closePath(); ctx.fill();
    } else if (lk.style === 1) {  // 坊主：薄い上部アーク
      ctx.beginPath(); ctx.arc(x, headCY, headR, Math.PI * 1.15, -Math.PI * 0.15); ctx.closePath();
      ctx.globalAlpha = 0.55; ctx.fill(); ctx.globalAlpha = 1;
    } else if (lk.style === 2) {  // 前髪：キャップ＋額に段差
      ctx.beginPath(); ctx.arc(x, headCY, headR, Math.PI, 0); ctx.closePath(); ctx.fill();
      ctx.fillRect(x - headR * 0.85, headCY - headR * 0.15, headR * 1.7, headR * 0.32);
    } else if (lk.style === 3) {  // 長髪：横まで覆う
      ctx.beginPath(); ctx.arc(x, headCY, headR * 1.06, Math.PI * 0.85, Math.PI * 0.15); ctx.closePath(); ctx.fill();
      ctx.fillRect(x - headR * 1.02, headCY - headR * 0.1, headR * 0.34, headR * 0.9);
      ctx.fillRect(x + headR * 0.68, headCY - headR * 0.1, headR * 0.34, headR * 0.9);
    } else if (lk.style === 4) {  // カーリー：上部に3つのこぶ
      for (const off of [-0.55, 0, 0.55]) {
        ctx.beginPath(); ctx.arc(x + headR * off, headCY - headR * 0.62, headR * 0.42, 0, Math.PI * 2); ctx.fill();
      }
    }                             // 5: スキンヘッド＝髪なし

    // 顔（目・ヒゲ）
    ctx.fillStyle = "rgba(20,16,12,0.85)";
    ctx.beginPath(); ctx.arc(x - headR * 0.32, headCY + headR * 0.12, headR * 0.11, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(x + headR * 0.32, headCY + headR * 0.12, headR * 0.11, 0, Math.PI * 2); ctx.fill();
    if (lk.beard) {
      ctx.strokeStyle = lk.hair; ctx.lineWidth = headR * 0.22;
      ctx.beginPath(); ctx.arc(x, headCY + headR * 0.35, headR * 0.55, Math.PI * 0.2, Math.PI * 0.8); ctx.stroke();
    }

    if (s.fatigue >= 70) {
      ctx.beginPath();
      ctx.ellipse(x, y - r * 0.05, bodyRx + 3, bodyRy + headR * 1.15, 0, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(255,90,90,0.9)"; ctx.lineWidth = 1.5; ctx.stroke();
    }

    ctx.fillStyle = kit.text; ctx.font = `bold ${Math.round(r * 1.0)}px sans-serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(String(s.num), x, bodyCY + r * 0.05);
  }

  drawBall(ball) {
    const ctx = this.ctx, [gx, gy] = this.px(ball.x, ball.y);
    const scale = this.depthScale(ball.y);
    const r = this.W * 0.011 * scale;
    const lift = (ball.height || 0) * this.H;
    const shrink = 1 - Math.min(0.55, (ball.height || 0) * 4);
    ctx.beginPath(); ctx.ellipse(gx, gy, r * 1.15 * shrink, r * 0.5 * shrink, 0, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(0,0,0,${(0.28 * shrink).toFixed(2)})`; ctx.fill();
    const bx = gx, by = gy - lift;
    ctx.beginPath(); ctx.arc(bx, by, r, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff"; ctx.fill();
    ctx.lineWidth = 1; ctx.strokeStyle = "#333"; ctx.stroke();
    ctx.beginPath(); ctx.arc(bx, by, r * 0.4, 0, Math.PI * 2); ctx.fillStyle = "#333"; ctx.fill();
  }

  drawGoalBurst(ball) {
    const ctx = this.ctx, [x, y] = this.px(ball.x, ball.y);
    ctx.strokeStyle = "rgba(255,215,60,0.9)"; ctx.lineWidth = 2;
    for (let i = 0; i < 8; i++) {
      const a = (Math.PI * 2 * i) / 8;
      ctx.beginPath();
      ctx.moveTo(x + Math.cos(a) * 6, y + Math.sin(a) * 6);
      ctx.lineTo(x + Math.cos(a) * 16, y + Math.sin(a) * 16);
      ctx.stroke();
    }
  }

  // スコア＋得点者（時間つき）を中央下部に常時表示する
  drawOverlay() {
    const ctx = this.ctx, W = this.W, H = this.H;
    const { score, goals } = this.overlay;
    const nameA = this.match.a.team.name, nameB = this.match.b.team.name;
    const scorersA = goals.filter((g) => g.side === 0).map((g) => `${g.minute}' ${g.name}`).join("　");
    const scorersB = goals.filter((g) => g.side === 1).map((g) => `${g.minute}' ${g.name}`).join("　");
    const hasScorers = scorersA || scorersB;
    const barH = hasScorers ? 46 : 30;
    const barW = Math.min(W * 0.86, 560);
    const bx = (W - barW) / 2, by = H - barH - 8;

    ctx.save();
    ctx.beginPath();
    ctx.roundRect(bx, by, barW, barH, 8);
    ctx.fillStyle = "rgba(8,16,10,0.72)";
    ctx.fill();

    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.font = "bold 15px sans-serif";
    ctx.fillStyle = "#ffffff";
    ctx.fillText(`${nameA}  ${score[0]} - ${score[1]}  ${nameB}`, W / 2, by + 16);

    if (hasScorers) {
      ctx.font = "11px sans-serif";
      ctx.fillStyle = "#ffd54f";
      if (scorersA) { ctx.textAlign = "right"; ctx.fillText(`⚽ ${scorersA}`, W / 2 - 30, by + 34); }
      if (scorersB) { ctx.textAlign = "left"; ctx.fillText(`⚽ ${scorersB}`, W / 2 + 30, by + 34); }
    }
    ctx.restore();
  }

  // 静止フレーム（キックオフ前・ハーフタイム・ハイライトの合間）
  drawStatic() {
    if (this.stopped) return;
    this.level = 0;
    this.actors = [];
    const slotsA = this.layout(this.match.a, 0);
    const slotsB = this.layout(this.match.b, 1);
    this.fillBackground();
    this.drawFieldLines();
    this.drawTeam(slotsB, 1, 0, this.ball, 1);
    this.drawTeam(slotsA, 0, 0, this.ball, 1);
    this.drawBall(this.ball);
    this.drawOverlay();
  }
}

// 2Dピッチ描画（斜め見下ろしの疑似3D）。試合の各ティック（2分）を、陣形を保った選手たちが
// パスを回し攻め上がってシュートするアニメーションとして再生する。
// 決定機・ゴールの場面ではカメラがぐっとズームし、シュートが弾ける直前に一瞬静止して
// 「入るか…！？」の間を作ってから結果を見せる。

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
const TILT_SQUISH = 0.80;   // 幅方向の圧縮率（小さいほど寝た角度に見える）
const TILT_SHEAR = 0.11;    // 幅方向の位置によるカメラの傾き（遠近の斜め感）
const SCALE_FAR = 0.84;     // 奥側の縮小率
const SCALE_NEAR = 1.14;    // 手前側の拡大率

// 決定機・ゴールのカメラズーム
const ZOOM_MAX = 1.85;

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

// 選手の肌の色合い（名前から決定的に選ぶ＝毎回同じ選手は同じ色。
// 国籍で一括に決めず、個々の選手に多様な色合いを持たせる）
const SKIN_TONES = ["#ffdbb0", "#f0b989", "#c98a5c", "#9c6136", "#6b4023", "#3f2718"];
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
function skinTone(name) { return SKIN_TONES[hashStr(name) % SKIN_TONES.length]; }

const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const lerp = (a, b, t) => a + (b - a) * t;

class Pitch {
  constructor(canvas, match) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.match = match;
    this.kits = resolveKits(match.a.strategy.teamKey, match.b.strategy.teamKey);
    this.ball = { x: 0.5, y: 0.5, height: 0 };
    this.stopped = false;
    this.level = 0;
    this.shot = null;
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

  // 正規化座標（M込み） → ピクセル。幅方向を圧縮・シアーして斜め見下ろし角度に変換する
  px(nx, ny) {
    const cy = ny - 0.5;
    const y = 0.5 + cy * TILT_SQUISH;
    const x = nx + cy * TILT_SHEAR;
    return [x * this.W, y * this.H];
  }
  // 奥(遠い)ほど小さく、手前(近い)ほど大きく見せる奥行きスケール
  depthScale(ny) {
    const t = Math.max(0, Math.min(1, (ny - M) / (1 - 2 * M)));
    return SCALE_FAR + (SCALE_NEAR - SCALE_FAR) * t;
  }

  // side=0は左ゴール守備・右攻撃、side=1はその逆
  depthX(side, depth) {
    const inner = 1 - 2 * M;
    return side === 0 ? M + depth * inner : (1 - M) - depth * inner;
  }
  latY(lat) { return M + lat * (1 - 2 * M); }
  attackGoalX(side) { return side === 0 ? 1 - M : M; }

  // 出場中の選手を陣形スロットに割り当て {num,name,pos,base:{x,y},fatigue,cond}
  layout(ts, side) {
    const groups = { GK: ts.onPitch("GK"), DF: ts.onPitch("DF"), MF: ts.onPitch("MF"), FW: ts.onPitch("FW") };
    const out = [];
    let num = 1;
    for (const pos of POS_ORDER) {
      const players = groups[pos];
      const n = players.length;
      players.forEach((p, i) => {
        const lat = (i + 1) / (n + 1);
        out.push({
          num: num++, name: p.name, pos, player: p,
          base: { x: this.depthX(side, DEPTH[pos]), y: this.latY(lat) },
          fatigue: p.fatigue,
        });
      });
    }
    return out;
  }

  findSlot(slots, name) { return slots.find((s) => s.name === name); }

  // シュートの着弾点
  shotTarget(side, phase, defGK) {
    const gx = this.attackGoalX(side);
    if (phase === "save") return { x: lerp(gx, 0.5, 0.04), y: defGK ? defGK.base.y : 0.5 };
    if (phase === "goal") {
      const gy = 0.5 + (this.match.rng() - 0.5) * 0.11;
      return { x: side === 0 ? 1 - M * 0.4 : M * 0.4, y: gy };
    }
    // miss / post: 枠の外（横）か上
    const wide = 0.5 + (this.match.rng() < 0.5 ? -1 : 1) * (GOAL_HALF + 0.03);
    return { x: gx, y: wide };
  }

  // アニメの区切り（ボールの経由点列）を作る。平穏なティックは短く、
  // 決定機・ゴールのティックはビルドアップ〜シュートをしっかり見せる
  buildPoints(anim, slotsA, slotsB) {
    const pts = [{ x: this.ball.x, y: this.ball.y, w: 0.6 }];
    this.shot = null;
    for (const e of anim.seq) {
      const atk = e.side === 0 ? slotsA : slotsB;
      const def = e.side === 0 ? slotsB : slotsA;
      const mids = atk.filter((s) => s.pos === "MF");
      const backs = atk.filter((s) => s.pos === "DF");
      const pool = (mids.length ? mids : atk).concat(backs);
      const featured = e.phase !== "possession";
      const buildupCount = featured ? 2 : 1;
      for (let k = 0; k < buildupCount; k++) {
        const s = pool[Math.floor(this.match.rng() * pool.length)] || atk[0];
        pts.push({ x: s.base.x, y: s.base.y, w: 1 });
      }
      if (["goal", "save", "miss", "post"].includes(e.phase)) {
        const shooter = (e.shooter && this.findSlot(atk, e.shooter))
          || atk.filter((s) => s.pos === "FW")[0] || atk[atk.length - 1];
        pts.push({ x: shooter.base.x, y: shooter.base.y, w: 1.3 });
        const gk = def.find((s) => s.pos === "GK");
        const tgt = this.shotTarget(e.side, e.phase, gk);
        pts.push({ x: tgt.x, y: tgt.y, w: 0.7, shot: true });
        this.shot = { defSide: 1 - e.side, phase: e.phase, targetY: tgt.y, gk };
      } else if (!featured) {
        const s = pool[Math.floor(this.match.rng() * pool.length)] || atk[0];
        pts.push({ x: s.base.x, y: s.base.y, w: 1 });
      }
    }
    return pts;
  }

  // p(0..1、区間集合全体での進捗)からボールの位置と高さ(弧)を求める。
  // 距離の長い区間ほど高く弧を描く＝クロス/ロングボールは弧、短いパスは地を這う
  ballAt(pts, p) {
    const total = pts.slice(1).reduce((a, s) => a + s.w, 0) || 1;
    let acc = 0;
    const target = p * total;
    for (let i = 1; i < pts.length; i++) {
      const seg = pts[i].w;
      if (target <= acc + seg || i === pts.length - 1) {
        const local = Math.max(0, Math.min(1, seg ? (target - acc) / seg : 1));
        const t = easeInOut(local);
        const dx = pts[i].x - pts[i - 1].x, dy = pts[i].y - pts[i - 1].y;
        const dist = Math.hypot(dx, dy);
        const arcMax = Math.min(0.1, dist * 0.4) * (pts[i].shot ? 0.5 : 1);
        const height = arcMax * Math.sin(Math.PI * local);
        return {
          x: lerp(pts[i - 1].x, pts[i].x, t),
          y: lerp(pts[i - 1].y, pts[i].y, t),
          height,
          shot: pts[i].shot && local > 0.05,
        };
      }
      acc += seg;
    }
    return { x: pts[pts.length - 1].x, y: pts[pts.length - 1].y, height: 0 };
  }

  // シュート区間に入ってから「弾ける直前」で止めるための p 値
  preShotP(pts) {
    const total = pts.slice(1).reduce((a, s) => a + s.w, 0) || 1;
    const shotW = pts[pts.length - 1].shot ? pts[pts.length - 1].w : 0;
    if (!shotW) return 1;
    return 1 - 0.16 * (shotW / total);
  }

  animateTick(anim, duration) {
    if (this.stopped || !anim) return Promise.resolve();
    this.level = anim.level || 0;
    const slotsA = this.layout(this.match.a, 0);
    const slotsB = this.layout(this.match.b, 1);
    const pts = this.buildPoints(anim, slotsA, slotsB);
    if (this.level >= 1 && this.shot) return this.animateFeatured(anim, pts, duration, slotsA, slotsB);
    return this.animateQuiet(anim, pts, duration, slotsA, slotsB);
  }

  // 平穏なティック：ふつうに短く再生するだけ（ズームなし）
  animateQuiet(anim, pts, duration, slotsA, slotsB) {
    return new Promise((resolve) => {
      const start = performance.now();
      const step = (now) => {
        if (this.stopped) return resolve();
        const p = Math.min(1, (now - start) / duration);
        const ball = this.ballAt(pts, p);
        this.renderScene(p, anim, slotsA, slotsB, ball, 1, null);
        if (p >= 1) { this.ball = { x: ball.x, y: ball.y, height: 0 }; return resolve(); }
        this._raf = requestAnimationFrame(step);
      };
      this._raf = requestAnimationFrame(step);
    });
  }

  // 決定機・ゴールのティック：ビルドアップ(ズームイン)→シュート直前で一瞬静止→
  // 素早く結果を見せてズームアウト、という「間」のある演出
  animateFeatured(anim, pts, duration, slotsA, slotsB) {
    const preP = this.preShotP(pts);
    const shooterPt = pts[pts.length - 2], shotPt = pts[pts.length - 1];
    const pivot = this.px(lerp(shooterPt.x, shotPt.x, 0.5), lerp(shooterPt.y, shotPt.y, 0.5));
    const BUILD = duration * 0.58, FREEZE = duration * 0.17, REVEAL = duration - BUILD - FREEZE;
    return new Promise((resolve) => {
      const start = performance.now();
      const step = (now) => {
        if (this.stopped) return resolve();
        const el = now - start;
        let p, zoom;
        if (el < BUILD) {
          const b = easeInOut(Math.min(1, el / BUILD));
          p = preP * b;
          zoom = 1 + (ZOOM_MAX - 1) * b;
        } else if (el < BUILD + FREEZE) {
          p = preP;
          zoom = ZOOM_MAX;
        } else {
          const r = Math.min(1, (el - BUILD - FREEZE) / REVEAL);
          p = lerp(preP, 1, Math.min(1, r / 0.35));
          zoom = r < 0.5 ? ZOOM_MAX : lerp(ZOOM_MAX, 1, (r - 0.5) / 0.5);
        }
        const ball = this.ballAt(pts, p);
        this.renderScene(p, anim, slotsA, slotsB, ball, zoom, pivot);
        if (el >= duration) { this.ball = { x: ball.x, y: ball.y, height: 0 }; return resolve(); }
        this._raf = requestAnimationFrame(step);
      };
      this._raf = requestAnimationFrame(step);
    });
  }

  renderScene(p, anim, slotsA, slotsB, ball, zoom, pivotPx) {
    this.fillBackground();
    const ctx = this.ctx;
    ctx.save();
    if (zoom && zoom !== 1 && pivotPx) {
      ctx.translate(pivotPx[0], pivotPx[1]);
      ctx.scale(zoom, zoom);
      ctx.translate(-pivotPx[0], -pivotPx[1]);
    }
    this.drawFieldLines();
    const atkSide = anim.seq[0] ? anim.seq[0].side : 0;
    const amp = this.level >= 1 ? 0.065 : 0.01;
    const shift = Math.sin(Math.PI * p) * amp;
    this.drawTeam(slotsB, 1, atkSide === 1 ? shift : -shift * 0.6, ball);
    this.drawTeam(slotsA, 0, atkSide === 0 ? shift : -shift * 0.6, ball);
    this.drawBall(ball);
    if (anim.goal && p > 0.8) this.drawGoalBurst(ball);
    ctx.restore();
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

  // ピッチのライン類。各点を px() で投影してから多角形として描くので、
  // 見下ろし角度に応じて台形・斜めの楕円として正しく歪む
  drawFieldLines() {
    const ctx = this.ctx;
    ctx.strokeStyle = "rgba(255,255,255,0.75)"; ctx.lineWidth = 1.5;

    const poly = (points) => {
      ctx.beginPath();
      points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
      ctx.closePath();
    };

    // 外枠
    poly([[M, M], [1 - M, M], [1 - M, 1 - M], [M, 1 - M]].map(([x, y]) => this.px(x, y)));
    ctx.stroke();

    // ハーフウェイライン
    const [hx1, hy1] = this.px(0.5, M), [hx2, hy2] = this.px(0.5, 1 - M);
    ctx.beginPath(); ctx.moveTo(hx1, hy1); ctx.lineTo(hx2, hy2); ctx.stroke();

    // センターサークル（円周をサンプリングして投影→斜めの楕円になる）
    const circlePts = [];
    for (let i = 0; i <= 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      circlePts.push(this.px(0.5 + Math.cos(a) * 0.07, 0.5 + Math.sin(a) * 0.07));
    }
    poly(circlePts); ctx.stroke();
    const [ccx, ccy] = this.px(0.5, 0.5);
    ctx.beginPath(); ctx.arc(ccx, ccy, 2.5, 0, Math.PI * 2); ctx.fillStyle = "rgba(255,255,255,0.8)"; ctx.fill();

    // ペナルティエリア＆ゴール
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

  drawTeam(slots, side, shiftX, ball) {
    const kit = this.kits[side];
    const dir = side === 0 ? 1 : -1;
    for (const s of slots) {
      let nx = s.base.x + shiftX * dir;
      let ny = s.base.y;
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
      this.drawPlayer(nx, ny, kit, s);
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

  // 上から見た人型（頭＋胴体）で選手を描く。頭の色は選手ごとに固定の肌色。
  // 奥行きスケールで手前は大きく・奥は小さく見せる
  drawPlayer(nx, ny, kit, s) {
    const ctx = this.ctx, [x, y] = this.px(nx, ny);
    const scale = this.depthScale(ny);
    const r = this.W * 0.017 * scale;
    const bodyCY = y + r * 0.4, bodyRx = r * 0.82, bodyRy = r * 1.05;
    const headR = r * 0.62, headCY = bodyCY - bodyRy - headR * 0.45;

    ctx.beginPath(); ctx.ellipse(x, y + r * 1.5, r * 0.95, r * 0.4, 0, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(0,0,0,0.18)"; ctx.fill();

    ctx.beginPath(); ctx.ellipse(x, bodyCY, bodyRx, bodyRy, 0, 0, Math.PI * 2);
    ctx.fillStyle = kit.fill; ctx.fill();
    ctx.lineWidth = 1; ctx.strokeStyle = "rgba(0,0,0,0.4)"; ctx.stroke();

    ctx.beginPath(); ctx.arc(x, headCY, headR, 0, Math.PI * 2);
    ctx.fillStyle = skinTone(s.name); ctx.fill();
    ctx.lineWidth = 1; ctx.strokeStyle = "rgba(0,0,0,0.4)"; ctx.stroke();

    if (s.fatigue >= 70) {
      ctx.beginPath();
      ctx.ellipse(x, y - r * 0.05, bodyRx + 3, bodyRy + headR * 1.15, 0, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(255,90,90,0.9)"; ctx.lineWidth = 1.5; ctx.stroke();
    }

    ctx.fillStyle = kit.text; ctx.font = `bold ${Math.round(r * 1.0)}px sans-serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(String(s.num), x, bodyCY + r * 0.05);
  }

  // ボールは地面の影(実際の位置)と、高さ分だけ浮いた本体を分けて描く。
  // 高さがあるほど影が小さく薄くなり、弧を描くクロス/ロングボールが表現される
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

  // 静止フレーム（キックオフ前・ハーフタイム表示用）
  drawStatic() {
    if (this.stopped) return;
    const slotsA = this.layout(this.match.a, 0);
    const slotsB = this.layout(this.match.b, 1);
    this.fillBackground();
    this.drawFieldLines();
    this.drawTeam(slotsB, 1, 0, this.ball);
    this.drawTeam(slotsA, 0, 0, this.ball);
    this.drawBall(this.ball);
  }
}

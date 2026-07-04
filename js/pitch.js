// 2Dピッチ描画。試合の各ティック（2分）を、陣形を保った選手たちが
// パスを回し攻め上がってシュートするアニメーションとして再生する。

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

const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const lerp = (a, b, t) => a + (b - a) * t;

class Pitch {
  constructor(canvas, match) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.match = match;
    this.kits = resolveKits(match.a.strategy.teamKey, match.b.strategy.teamKey);
    this.ball = { x: 0.5, y: 0.5 };
    this.stopped = false;
    // 選手ごとの微揺れ位相（見た目を生かす）
    this.phase = Array.from({ length: 44 }, (_, i) => i * 1.7);
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

  // 正規化座標 → ピクセル
  px(nx, ny) { return [nx * this.W, ny * this.H]; }
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

  // アニメの区切り（ボールの経由点列）を作る
  buildPoints(anim, slotsA, slotsB) {
    const pts = [{ x: this.ball.x, y: this.ball.y, w: 0.6 }];
    this.shot = null;
    for (const e of anim.seq) {
      const atk = e.side === 0 ? slotsA : slotsB;
      const def = e.side === 0 ? slotsB : slotsA;
      const mids = atk.filter((s) => s.pos === "MF");
      const backs = atk.filter((s) => s.pos === "DF");
      const pool = (mids.length ? mids : atk).concat(backs);
      // ビルドアップ：2人経由
      for (let k = 0; k < 2; k++) {
        const s = pool[Math.floor(this.match.rng() * pool.length)] || atk[0];
        pts.push({ x: s.base.x, y: s.base.y, w: 1 });
      }
      if (["goal", "save", "miss", "post"].includes(e.phase)) {
        const shooter = (e.shooter && this.findSlot(atk, e.shooter))
          || atk.filter((s) => s.pos === "FW")[0] || atk[atk.length - 1];
        pts.push({ x: shooter.base.x, y: shooter.base.y, w: 1 });
        const gk = def.find((s) => s.pos === "GK");
        const tgt = this.shotTarget(e.side, e.phase, gk);
        pts.push({ x: tgt.x, y: tgt.y, w: 0.55, shot: true });
        this.shot = { defSide: 1 - e.side, phase: e.phase, targetY: tgt.y, gk };
      } else {
        const s = pool[Math.floor(this.match.rng() * pool.length)] || atk[0];
        pts.push({ x: s.base.x, y: s.base.y, w: 1 });
      }
    }
    return pts;
  }

  ballAt(pts, p) {
    const total = pts.slice(1).reduce((a, s) => a + s.w, 0) || 1;
    let acc = 0;
    const target = p * total;
    for (let i = 1; i < pts.length; i++) {
      const seg = pts[i].w;
      if (target <= acc + seg || i === pts.length - 1) {
        const local = seg ? (target - acc) / seg : 1;
        const t = easeInOut(Math.max(0, Math.min(1, local)));
        return {
          x: lerp(pts[i - 1].x, pts[i].x, t),
          y: lerp(pts[i - 1].y, pts[i].y, t),
          shot: pts[i].shot && local > 0.05,
        };
      }
      acc += seg;
    }
    return { x: pts[pts.length - 1].x, y: pts[pts.length - 1].y };
  }

  animateTick(anim, duration) {
    return new Promise((resolve) => {
      if (this.stopped || !anim) return resolve();
      const slotsA = this.layout(this.match.a, 0);
      const slotsB = this.layout(this.match.b, 1);
      const pts = this.buildPoints(anim, slotsA, slotsB);
      const start = performance.now();
      const step = (now) => {
        if (this.stopped) return resolve();
        const p = Math.min(1, (now - start) / duration);
        const ball = this.ballAt(pts, p);
        this.drawFrame(p, anim, slotsA, slotsB, ball, now / 1000);
        if (p >= 1) {
          this.ball = anim.goal ? { x: 0.5, y: 0.5 } : { x: ball.x, y: ball.y };
          return resolve();
        }
        this._raf = requestAnimationFrame(step);
      };
      this._raf = requestAnimationFrame(step);
    });
  }

  drawFrame(p, anim, slotsA, slotsB, ball, time) {
    this.drawField();
    const atkSide = anim.seq[0] ? anim.seq[0].side : 0;
    const shift = Math.sin(Math.PI * p) * 0.05;   // 攻撃側は前へ、守備側は後ろへ
    this.drawTeam(slotsB, 1, atkSide === 1 ? shift : -shift * 0.6, ball, time);
    this.drawTeam(slotsA, 0, atkSide === 0 ? shift : -shift * 0.6, ball, time);
    this.drawBall(ball, p);
    if (anim.goal && p > 0.8) this.drawGoalBurst(ball);
  }

  drawField() {
    const ctx = this.ctx, W = this.W, H = this.H;
    const grd = ctx.createLinearGradient(0, 0, 0, H);
    grd.addColorStop(0, "#2f9c4a"); grd.addColorStop(1, "#278a40");
    ctx.fillStyle = grd; ctx.fillRect(0, 0, W, H);
    // 芝のストライプ
    ctx.fillStyle = "rgba(255,255,255,0.04)";
    const stripes = 8;
    for (let i = 0; i < stripes; i += 2) ctx.fillRect((i / stripes) * W, 0, W / stripes, H);
    ctx.strokeStyle = "rgba(255,255,255,0.75)"; ctx.lineWidth = 1.5;
    const [lx, ty] = this.px(M, M), [rx, by] = this.px(1 - M, 1 - M);
    ctx.strokeRect(lx, ty, rx - lx, by - ty);
    // ハーフウェイライン＋センターサークル
    ctx.beginPath(); ctx.moveTo(W / 2, ty); ctx.lineTo(W / 2, by); ctx.stroke();
    ctx.beginPath(); ctx.arc(W / 2, H / 2, W * 0.07, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(W / 2, H / 2, 2.5, 0, Math.PI * 2); ctx.fillStyle = "rgba(255,255,255,0.8)"; ctx.fill();
    // ペナルティエリア＆ゴール
    for (const side of [0, 1]) {
      const boxDepth = 0.16, boxHalf = 0.22;
      const gx = this.attackGoalX(1 - side); // side守備側のゴールライン
      const nearX = side === 0 ? M : 1 - M;
      const dir = side === 0 ? 1 : -1;
      const [bx1, by1] = this.px(nearX, 0.5 - boxHalf);
      const [bx2, by2] = this.px(nearX + dir * boxDepth, 0.5 + boxHalf);
      ctx.strokeRect(bx1, by1, bx2 - bx1, by2 - by1);
      // ゴール枠
      const [g1x, g1y] = this.px(nearX, 0.5 - GOAL_HALF);
      const [g2x, g2y] = this.px(nearX - dir * 0.02, 0.5 + GOAL_HALF);
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.fillRect(Math.min(g1x, g2x), g1y, Math.abs(g2x - g1x) + 1, g2y - g1y);
    }
  }

  drawTeam(slots, side, shiftX, ball, time) {
    const ctx = this.ctx, kit = this.kits[side];
    const dir = side === 0 ? 1 : -1;
    for (const s of slots) {
      const idle = 0.004 * Math.sin(time * 1.6 + this.phase[(side * 22 + s.num) % 44]);
      let nx = s.base.x + shiftX * dir + idle;
      let ny = s.base.y + idle * 0.7;
      if (s.pos === "GK") {
        // GKはゴール前で左右に。シュート時は反応する
        ny = lerp(s.base.y, this.gkTargetY(side, ball), 0.5);
        nx = s.base.x;
      } else {
        // ボールへ少し寄る（守備側は強め）
        const dx = ball.x - nx, dy = ball.y - ny;
        const dist = Math.hypot(dx, dy) + 0.001;
        const pull = Math.min(0.05, 0.02 / (dist + 0.15)) * (this.shot && this.shot.defSide === side ? 1.4 : 1);
        nx += (dx / dist) * pull * 0.6;
        ny += (dy / dist) * pull;
      }
      this.drawPlayer(nx, ny, kit, s);
    }
  }

  gkTargetY(side, ball) {
    // 自ゴール側にいるGKだけがボールに反応
    const ownGoalX = side === 0 ? M : 1 - M;
    if (Math.abs(ball.x - ownGoalX) > 0.4) return 0.5;
    if (this.shot && this.shot.defSide === side) {
      if (this.shot.phase === "goal") return 0.5 - Math.sign(this.shot.targetY - 0.5) * 0.05; // 逆を突かれる
      return lerp(0.5, this.shot.targetY, 0.8); // セーブ/枠外に反応
    }
    return lerp(0.5, ball.y, 0.4);
  }

  drawPlayer(nx, ny, kit, s) {
    const ctx = this.ctx, [x, y] = this.px(nx, ny);
    const r = this.W * 0.016;
    ctx.beginPath(); ctx.ellipse(x, y + r * 0.9, r * 0.9, r * 0.35, 0, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(0,0,0,0.18)"; ctx.fill();
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = kit.fill; ctx.fill();
    ctx.lineWidth = 1; ctx.strokeStyle = "rgba(0,0,0,0.35)"; ctx.stroke();
    if (s.fatigue >= 70) { // 疲労した選手は赤リング
      ctx.beginPath(); ctx.arc(x, y, r + 1.5, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(255,90,90,0.9)"; ctx.lineWidth = 1.5; ctx.stroke();
    }
    ctx.fillStyle = kit.text; ctx.font = `bold ${Math.round(r * 1.1)}px sans-serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(String(s.num), x, y);
  }

  drawBall(ball, p) {
    const ctx = this.ctx, [x, y] = this.px(ball.x, ball.y);
    const r = this.W * 0.011;
    if (ball.shot) { // シュート中は尾を引く
      ctx.strokeStyle = "rgba(255,255,255,0.5)"; ctx.lineWidth = r;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - (ball.vx || 0), y - (ball.vy || 0)); ctx.stroke();
    }
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff"; ctx.fill();
    ctx.lineWidth = 1; ctx.strokeStyle = "#333"; ctx.stroke();
    ctx.beginPath(); ctx.arc(x, y, r * 0.4, 0, Math.PI * 2); ctx.fillStyle = "#333"; ctx.fill();
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
    this.drawField();
    this.drawTeam(slotsB, 1, 0, this.ball, 0);
    this.drawTeam(slotsA, 0, 0, this.ball, 0);
    this.drawBall(this.ball, 0);
  }
}

/*
 * skyline-mask.js — 山マスク（稜線オクルージョン）
 *
 * 光の柱を「カメラに空が映っている部分にだけ」描くことで、山や建物の向こう側に立っているように見せる。
 *
 *   1. カメラ映像のうち、画面に映っている範囲を小さく縮小して取り出す
 *   2. 縦の列ごとに、上から下へ「明るい空」が「暗い地形」に変わる位置（稜線）を探す
 *   3. 端末の向き（センサー）を使って、稜線の位置を「方位・見上げ角」に変換する
 *   4. 360° 分の稜線表（方位 → 見上げ角）に記録する
 *        遠くの山は、その場で首を振っても方位・見上げ角が変わらないので、一度見た所は覚えておける
 *   5. 稜線表から「色を描かず、奥行きだけを書き込む見えない壁」を作る
 *        柱はこの壁より奥にあるので、GPU の奥行き判定で稜線より下の部分が自動的に隠れる
 *
 * 使い方（index.html）:
 *   const skyline = new SkylineMask({ video, debugCanvas });
 *   scene.add(skyline.group);
 *   // 毎フレーム：
 *   skyline.update(dt, deviceQ, yawOffset, camera, 画面の幅, 画面の高さ);
 */
(function () {
  'use strict';

  const TWO_PI = Math.PI * 2;
  const toRad = THREE.MathUtils.degToRad;

  class SkylineMask {
    constructor({ video, debugCanvas = null, bins = 720, radius = 50, analysisSize = 240, interval = 0.1 } = {}) {
      this.video = video;
      this.bins = bins;                 // 方位の分割数（720 = 0.5° 刻み）
      this.radius = radius;             // 見えない壁までの距離 (m)。柱（60m〜）より手前に置く
      this.analysisSize = analysisSize; // 解析用の縮小画像の長辺 (px)
      this.interval = interval;         // 解析の間隔 (秒)

      // ---- 調整用の値（明るさは 0〜255） ----
      this.minDrop = 16;          // 空から地形へ、これ以上暗くなったら境目とみなす（昼の明るさの場合。暗い映像では自動で小さくする）
      this.skyBrightRatio = 0.6;  // 列の一番上が「空らしい」か：画面上部の空の明るさの何割以上か
      this.maxTurn = toRad(1.5);  // 解析1回(0.1秒)の間の回転がこれを超えたら学習しない（＝毎秒15°）
      this.maxRollSin = 0.5;      // 横の傾きが 30° を超えたら学習しない
      this.learnRate = 0.35;      // 稜線表を新しい観測へ近づける割合
      this.minSkylineElev = toRad(-5);   // これより低い稜線は誤検出とみなす
      this.minSkyBottomElev = toRad(-3); // 画面の下端がこれより低い時は「一番下まで空」を信じない

      this.profile = new Float32Array(bins).fill(NaN); // 方位 → 見上げ角 (rad)。NaN は未学習
      this.enabled = true;   // 柱を隠すか
      this.showLine = false; // 稜線と解析画像を表示するか
      this.stats = { state: '待機中', valid: 0, columns: 0 };

      this._elapsed = 0;
      this._prevQ = new THREE.Quaternion();
      this._hasPrev = false;
      this._dir = new THREE.Vector3();
      this._hist = new Uint32Array(256);
      this._sumS = new Float32Array(bins); this._cntS = new Uint16Array(bins); // 稜線の観測
      this._sumB = new Float32Array(bins); this._cntB = new Uint16Array(bins); // 「ここまでは空」の観測

      this.canvas = document.createElement('canvas');
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
      this.debugCanvas = debugCanvas;
      this.debugCtx = debugCanvas ? debugCanvas.getContext('2d') : null;

      // 端末の世界座標（正面合わせの前）で作り、毎フレーム yawOffset を掛けて scene に合わせる
      this.group = new THREE.Group();
      this._buildMeshes();
    }

    // 学習した稜線を消す
    reset() {
      this.profile.fill(NaN);
      this._rebuild();
    }

    learnedPercent() {
      let k = 0;
      for (let i = 0; i < this.bins; i++) if (!Number.isNaN(this.profile[i])) k++;
      return Math.round(100 * k / this.bins);
    }

    // deviceQ: 端末の向き（画面回転の補正込み・正面合わせ前・平滑化前）
    update(dt, deviceQ, yawOffset, camera, viewW, viewH) {
      this.group.position.copy(camera.position);
      this.group.quaternion.copy(yawOffset);
      this.occluder.visible = this.enabled;
      this.ribbon.visible = this.showLine;
      if (this.debugCanvas) this.debugCanvas.classList.toggle('hidden', !this.showLine);
      if (!this.enabled && !this.showLine) { this.stats.state = '停止中'; return; }

      this._elapsed += dt;
      if (this._elapsed < this.interval) return;
      this._elapsed = 0;
      this._analyze(deviceQ, camera, viewW, viewH);
    }

    // ------------------------------------------------------------------
    // 解析
    // ------------------------------------------------------------------
    _analyze(q, camera, W, H) {
      const v = this.video;
      // 映像はセンサーより少し遅れて届くので、速く動かしている間は学習しない
      const turn = this._hasPrev ? 2 * Math.acos(Math.min(1, Math.abs(this._prevQ.dot(q)))) : 0;
      this._prevQ.copy(q);
      this._hasPrev = true;
      if (!v.videoWidth || v.readyState < 2 || !W || !H) return this._skip('映像待ち');
      if (turn > this.maxTurn) return this._skip('動きが速い');
      this._dir.set(1, 0, 0).applyQuaternion(q); // 画面の右方向
      if (Math.abs(this._dir.y) > this.maxRollSin) return this._skip('傾き過ぎ');

      // 1. 画面に映っている範囲（object-fit: cover で切り抜かれた部分）だけを縮小して取り出す
      const vw = v.videoWidth, vh = v.videoHeight;
      const s = Math.max(W / vw, H / vh);
      const cw = W / s, ch = H / s;
      const k = this.analysisSize / Math.max(W, H);
      const aw = Math.max(16, Math.round(W * k)), ah = Math.max(16, Math.round(H * k));
      this._resize(aw, ah);
      this.ctx.drawImage(v, (vw - cw) / 2, (vh - ch) / 2, cw, ch, 0, 0, aw, ah);
      const img = this.ctx.getImageData(0, 0, aw, ah);
      const px = img.data, L = this._lum;
      for (let i = 0, p = 0; i < L.length; i++, p += 4) L[i] = 0.299 * px[p] + 0.587 * px[p + 1] + 0.114 * px[p + 2];

      // 2. 列ごとに稜線を探す
      //    画面上部（上から1割）の明るい方を「空の明るさ」の目安にする。
      //    夜の暗い映像では、境目とみなす明るさの差も小さくする
      const skyRef = this._percentile(L.subarray(0, aw * Math.max(3, Math.round(ah * 0.1))), 0.9);
      this._drop = Math.max(6, this.minDrop * Math.min(1, Math.max(0.35, skyRef / 160)));
      for (let x = 0; x < aw; x++) this._rows[x] = this._findSkyline(x, aw, ah, skyRef);
      this._rejectOutliers(aw, ah);

      // 3. 稜線の位置 → 方位・見上げ角（画面の点をカメラの向きで世界の方向に直す）
      const tanV = Math.tan(toRad(camera.fov) / 2), tanH = tanV * camera.aspect;
      let valid = 0;
      for (let x = 0; x < aw; x++) {
        const r = this._rows[x];
        let kind = 0, y = 0;
        if (Number.isFinite(r)) { kind = 1; y = r; valid++; }   // 稜線が見つかった
        else if (r === Infinity) { kind = 2; y = ah; }          // 一番下まで空 → 稜線は画面より下
        this._kind[x] = kind;
        if (!kind) continue;
        const d = this._dir.set((2 * (x + 0.5) / aw - 1) * tanH, (1 - 2 * y / ah) * tanV, -1).normalize().applyQuaternion(q);
        this._th[x] = Math.atan2(d.x, -d.z);                  // 方位（右回りが＋）
        this._ph[x] = Math.asin(Math.max(-1, Math.min(1, d.y))); // 見上げ角
        // ありえない結果は使わない：地平線よりずっと下の稜線、地平線より下まで「全部空」
        //（夜に暗い地面だけを見ていると、一様に暗い＝空と取り違えるため）
        if ((kind === 1 && this._ph[x] < this.minSkylineElev) || (kind === 2 && this._ph[x] < this.minSkyBottomElev)) {
          this._kind[x] = 0;
          if (kind === 1) valid--;
        }
      }

      // 4. 隣り合う列の間を方位の刻みに割り振って稜線表を更新（1〜2列の欠けはつなぐ）
      for (let x = 0; x < aw; x++) {
        const kind = this._kind[x];
        if (!kind) continue;
        for (let g = 1; g <= 3 && x + g < aw; g++) {
          const k2 = this._kind[x + g];
          if (k2 === kind) { this._splat(this._th[x], this._ph[x], this._th[x + g], this._ph[x + g], kind); break; }
          if (k2) break;
        }
      }
      this._applyObservations();

      // 5. 見えない壁を作り直す
      this._rebuild();
      this.stats.state = valid ? '検出中' : '稜線が見えない';
      this.stats.valid = valid;
      this.stats.columns = aw;
      if (this.showLine) this._drawDebug(img, aw, ah);
    }

    // 1列分：上から下へ見ていき、「空の明るさ」から急に暗くなって、そのまま暗い位置を探す
    // 戻り値：境目の位置（小数の行）／ Infinity（一番下まで空）／ NaN（判断できない）
    _findSkyline(x, aw, ah, skyRef) {
      const L = this._lum, minDrop = this._drop;
      const at = (y) => L[y * aw + x];
      const top = (at(0) + at(1) + at(2)) / 3;
      if (top < skyRef * this.skyBrightRatio) return NaN;  // 列の一番上が空らしくない（木・建物・地面など）

      const m = Math.max(3, Math.round(ah * 0.04));       // 「暗いまま続く」ことを確かめる長さ
      let slope = 0, rough = 1, worst = 0;
      for (let y = 5; y < ah - 1; y++) {
        // 空は地平線に近いほど明るくなるなど、なだらかに変化する。
        // 3〜4行上の明るさを、その変化の傾きで今の行まで延ばして「ここが空ならこの明るさ」を予想する
        const d = at(y - 3) - at(y - 4);
        slope += 0.2 * (d - slope);
        rough += 0.2 * (Math.abs(d - slope) - rough);     // 空のざらつき（ノイズ）
        const sky = (at(y - 4) + at(y - 3)) / 2 + 3.5 * slope;
        const next = (at(y) + at(y + 1)) / 2;
        const T = Math.max(minDrop, 4 * rough);
        worst = Math.max(worst, sky - next);
        if (sky - next >= T) {
          // 境目の候補。下側がしばらく暗いままか（電線や鳥のような細い物でないか）を確かめる
          const end = Math.min(ah, y + m);
          let sum = 0;
          for (let i = y; i < end; i++) sum += at(i);
          const below = sum / (end - y);
          if (sky - below >= 0.6 * T) {
            // 境目の正確な位置：候補のすぐ近くで、明るさが一番大きく下がる所
            //（すぐ下にもう1段暗い尾根があっても、そちらと取り違えないよう狭い範囲で探す）
            let best = -Infinity, bi = y;
            for (let i = Math.max(1, y - 1); i <= Math.min(ah - 1, y + 2); i++) {
              const g = at(i - 1) - at(i);
              if (g > best) { best = g; bi = i; }
            }
            // 前後の下がり幅から放物線で小数まで求める（行 bi は画素 bi-1 と bi の境目）
            const g0 = bi >= 2 ? at(bi - 2) - at(bi - 1) : best;
            const g2 = bi <= ah - 2 ? at(bi) - at(bi + 1) : best;
            const den = g0 - 2 * best + g2;
            const off = den < 0 ? 0.5 * (g0 - g2) / den : 0;
            return bi + Math.max(-0.5, Math.min(0.5, off));
          }
          // 細い物だった：そのまま先へ
        }
      }
      // 境目が無かった：下まで同じように明るければ「全部空」
      const bottom = (at(ah - 1) + at(ah - 2) + at(ah - 3)) / 3;
      return (worst < 0.5 * minDrop && bottom >= 0.9 * top) ? Infinity : NaN;
    }

    // 周りの列と食い違う検出（電柱・雲の切れ端など）を捨てる
    _rejectOutliers(aw, ah) {
      const r = this._rows, out = this._rows2, win = this._win;
      const tol = Math.max(2, ah * 0.03);
      for (let x = 0; x < aw; x++) {
        out[x] = r[x];
        if (!Number.isFinite(r[x])) continue;
        win.length = 0;
        for (let i = Math.max(0, x - 3); i <= Math.min(aw - 1, x + 3); i++) if (Number.isFinite(r[i])) win.push(r[i]);
        if (win.length < 3) { out[x] = NaN; continue; } // ぽつんと1つだけの検出は信用しない
        win.sort((a, b) => a - b);
        if (Math.abs(r[x] - win[win.length >> 1]) > tol) out[x] = NaN;
      }
      r.set(out);
    }

    // 2点（方位, 見上げ角）の間にある方位の刻みへ、直線で補間した値を加える
    _splat(th0, ph0, th1, ph1, kind) {
      const n = this.bins, step = TWO_PI / n;
      let d = th1 - th0;
      if (d > Math.PI) d -= TWO_PI; else if (d < -Math.PI) d += TWO_PI;
      if (Math.abs(d) > toRad(5)) return; // 真上・真下付近など、列の間隔が大きすぎる時は使わない
      const a = th0 / step, b = a + d / step;
      const lo = Math.ceil(Math.min(a, b)), hi = Math.floor(Math.max(a, b));
      const sum = kind === 1 ? this._sumS : this._sumB, cnt = kind === 1 ? this._cntS : this._cntB;
      for (let j = lo; j <= hi; j++) {
        const t = b === a ? 0 : (j - a) / (b - a);
        const idx = ((j % n) + n) % n;
        sum[idx] += ph0 + (ph1 - ph0) * t;
        cnt[idx]++;
      }
    }

    _applyObservations() {
      const P = this.profile, rate = this.learnRate;
      for (let j = 0; j < this.bins; j++) {
        if (this._cntS[j]) {
          const obs = this._sumS[j] / this._cntS[j];
          P[j] = Number.isNaN(P[j]) ? obs : P[j] + rate * (obs - P[j]);
        } else if (this._cntB[j]) {
          // 一番下まで空が見えている → 記録した稜線がそれより高ければ下げる
          const bound = this._sumB[j] / this._cntB[j];
          if (P[j] > bound) P[j] += rate * (bound - P[j]);
        }
      }
      this._sumS.fill(0); this._cntS.fill(0);
      this._sumB.fill(0); this._cntB.fill(0);
    }

    // ------------------------------------------------------------------
    // 見えない壁と、確認用の稜線の帯
    // ------------------------------------------------------------------
    _buildMeshes() {
      const n = this.bins;
      this._occPos = new THREE.BufferAttribute(new Float32Array(n * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage);
      this._ribPos = new THREE.BufferAttribute(new Float32Array(n * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage);
      this._index = new THREE.BufferAttribute(new Uint16Array(n * 6), 1).setUsage(THREE.DynamicDrawUsage);

      const occGeo = new THREE.BufferGeometry();
      occGeo.setAttribute('position', this._occPos);
      occGeo.setIndex(this._index);
      // colorWrite: false → 色は描かず（カメラ映像が見えたまま）、奥行きだけを書き込む
      this.occluder = new THREE.Mesh(occGeo, new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide }));
      this.occluder.frustumCulled = false;
      this.occluder.renderOrder = -1;
      this.group.add(this.occluder);

      const ribGeo = new THREE.BufferGeometry();
      ribGeo.setAttribute('position', this._ribPos);
      ribGeo.setIndex(this._index);
      this.ribbon = new THREE.Mesh(ribGeo, new THREE.MeshBasicMaterial({
        color: 0xff3366, side: THREE.DoubleSide, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false
      }));
      this.ribbon.frustumCulled = false;
      this.ribbon.renderOrder = 10;
      this.ribbon.visible = false;
      this.group.add(this.ribbon);
      this._rebuild();
    }

    _rebuild() {
      const n = this.bins, R = this.radius, P = this.profile;
      const bottom = -3 * R;          // 壁の下端（十分に下）
      const r2 = R * 0.98, half = toRad(0.15);
      const op = this._occPos.array, rp = this._ribPos.array, idx = this._index.array;
      for (let i = 0; i < n; i++) {
        const e = P[i];
        if (Number.isNaN(e)) continue;
        const th = i * TWO_PI / n, sx = Math.sin(th), cz = -Math.cos(th); // 方位0 = −Z（正面）、右回り
        const o = i * 6;
        op[o] = R * sx; op[o + 1] = bottom; op[o + 2] = R * cz;
        op[o + 3] = R * sx; op[o + 4] = R * Math.tan(e); op[o + 5] = R * cz;
        rp[o] = r2 * sx; rp[o + 1] = r2 * Math.tan(e - half); rp[o + 2] = r2 * cz;
        rp[o + 3] = r2 * sx; rp[o + 4] = r2 * Math.tan(e + half); rp[o + 5] = r2 * cz;
      }
      // 両端とも学習済みの区間だけを面にする
      let m = 0;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        if (Number.isNaN(P[i]) || Number.isNaN(P[j])) continue;
        const a = 2 * i, b = a + 1, c = 2 * j, d = c + 1;
        idx[m++] = a; idx[m++] = c; idx[m++] = b;
        idx[m++] = b; idx[m++] = c; idx[m++] = d;
      }
      this.occluder.geometry.setDrawRange(0, m);
      this.ribbon.geometry.setDrawRange(0, m);
      this._occPos.needsUpdate = true;
      this._ribPos.needsUpdate = true;
      this._index.needsUpdate = true;
    }

    // ------------------------------------------------------------------
    // 補助
    // ------------------------------------------------------------------
    _skip(state) {
      this.stats.state = state;
      this.stats.valid = 0;
    }

    _resize(aw, ah) {
      if (this.canvas.width === aw && this.canvas.height === ah && this._lum) return;
      this.canvas.width = aw;
      this.canvas.height = ah;
      this._lum = new Float32Array(aw * ah);
      this._rows = new Float32Array(aw);
      this._rows2 = new Float32Array(aw);
      this._th = new Float32Array(aw);
      this._ph = new Float32Array(aw);
      this._kind = new Uint8Array(aw);
      this._win = [];
    }

    _percentile(L, p) {
      const h = this._hist;
      h.fill(0);
      for (let i = 0; i < L.length; i++) h[Math.min(255, L[i] | 0)]++;
      const target = L.length * p;
      for (let v = 0, acc = 0; v < 256; v++) { acc += h[v]; if (acc >= target) return v; }
      return 255;
    }

    // 解析画像に検出結果を重ねて表示（赤＝稜線、青＝一番下まで空）
    _drawDebug(img, aw, ah) {
      const c = this.debugCanvas, g = this.debugCtx;
      if (!c) return;
      if (c.width !== aw || c.height !== ah) { c.width = aw; c.height = ah; }
      g.putImageData(img, 0, 0);
      for (let x = 0; x < aw; x++) {
        const r = this._rows[x];
        if (Number.isFinite(r)) { g.fillStyle = '#ff3366'; g.fillRect(x, Math.round(r) - 1, 1, 2); }
        else if (r === Infinity) { g.fillStyle = '#33aaff'; g.fillRect(x, ah - 2, 1, 2); }
      }
    }
  }

  window.SkylineMask = SkylineMask;
})();

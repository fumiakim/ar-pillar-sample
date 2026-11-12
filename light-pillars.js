/*
 * light-pillars.js — 光の柱（ライトピラー）の描写
 *
 * 冬の夜、街の灯りが空中の氷の結晶に反射して縦に長く伸びて見える「光柱（ライトピラー）」を表現する。
 *
 *   ・柱：カメラの方を向く縦長の板を、シェーダーで光らせる
 *       横方向：細く明るい芯 ＋ 柔らかな光の広がり（ガウス分布を3つ重ねる）＋ 縦の細かな筋
 *       縦方向：根元が明るく、上へ向かってなめらかに薄れて消える
 *       ゆらぎ：上へゆっくり流れる明るさのむら・柱全体の明るさの呼吸・芯のわずかな揺れ・上端の伸び縮み
 *   ・粒子：柱の芯から生まれ、外へ漏れ出すように漂いながら瞬いて消える（位置は時刻から GPU が計算する）
 *   ・合成：光を足し合わせ、アルファには明るさを入れる
 *       → カメラ映像の上に「スクリーン合成」のように柔らかく重なる（暗い所ほど光が映える）
 *
 * 配置は「グループ」で指定する（index.html の PILLAR_GROUPS）。角度はすべて度。
 *   azimuth    : グループの中心の方位（正面 0、右 +90、左 −90）
 *   spread     : 左右への広がり（中心ほど本数が多い）
 *   count      : 本数
 *   distance   : 距離の範囲 [m]（山マスクの壁 50m より遠くに置く）
 *   top        : 上端の仰角 [端の柱, 中央の柱]（中央ほど高く伸びる）
 *   width      : 芯の太さ [細い, 太い]（見える角度）
 *   brightness : 明るさ [暗い, 明るい]
 *   palette    : 色と出やすさ（省略時は下の PALETTE）
 */
(function () {
  'use strict';

  const D2R = Math.PI / 180;

  // 写真のような灯りの色（ナトリウム灯の橙、金、暖かい白、水銀灯・LED の水色や青緑、桃）
  const PALETTE = [
    { color: 0xffa64d, weight: 30 },
    { color: 0xffcf73, weight: 22 },
    { color: 0xfff0d8, weight: 20 },
    { color: 0x9feaff, weight: 11 },
    { color: 0xa8ffd0, weight: 9 },
    { color: 0xffb0c4, weight: 8 },
  ];

  // ---------------------------------------------------------------
  // シェーダー共通：なめらかな乱数（値ノイズ）。sin を使わない hash は長時間動かしても崩れにくい
  // ---------------------------------------------------------------
  const NOISE_GLSL = `
    float hash(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }
    float noise(vec2 p) {
      vec2 i = floor(p), f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
                 mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
    }
  `;

  // ---------------------------------------------------------------
  // 柱：頂点シェーダー（板をカメラに向け、高さ方向のゆらぎをここで計算して軽くする）
  // ---------------------------------------------------------------
  const PILLAR_VS = `
    uniform float uTime;
    uniform float uShimmer;
    attribute vec2 aCorner;   // x: -1 / +1（幅方向）, y: 0〜1（根元→上端）
    attribute vec4 aShape;    // x: 板の半幅[m], y: 高さ[m], z: 芯の太さ（半幅に対する割合）, w: 上端の仰角[rad]
    attribute vec3 aColor;
    attribute vec4 aParam;    // x: 乱数の種, y: 明るさ, z: ゆらぎの速さ, w: 上端が薄れ始める高さ(0〜1)
    varying float vX;
    varying float vSway;
    varying float vCoreW;
    varying float vLight;
    varying float vSeed;
    varying vec3 vColor;
    ${NOISE_GLSL}
    void main() {
      float seed = aParam.x, t = uTime * aParam.z, y = aCorner.y;

      // 板をカメラの方へ向ける（縦軸まわりだけ回すので、見上げても柱は縦のまま）
      vec3 base = (modelMatrix * vec4(position, 1.0)).xyz;
      vec3 toCam = cameraPosition - base;
      vec3 right = normalize(vec3(toCam.z, 0.0, -toCam.x));
      vec3 p = base + right * (aCorner.x * aShape.x) + vec3(0.0, y * aShape.y, 0.0);
      gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);

      // 高さを「見上げる角度」の割合に直す（0 = 根元、1 = 上端）。画面の上で均等に薄れていくように
      float ya = atan(y * tan(aShape.w)) / aShape.w;
      // 縦の形：根元が明るく、上へ向かって薄れて消える（消え始める高さはゆっくり伸び縮み）
      float topStart = aParam.w + 0.14 * (noise(vec2(seed * 5.1, t * 0.07)) - 0.5) * uShimmer;
      float vert = smoothstep(0.0, 0.02, ya) * (0.3 + 0.7 * exp(-2.4 * ya)) * (1.0 - smoothstep(topStart, 1.0, ya));
      // ゆらぎ：上へゆっくり流れる明るさのむら ＋ 柱全体の明るさの呼吸
      float flow = 0.6 * noise(vec2(ya * 9.0 - t * 0.7, seed)) + 0.4 * noise(vec2(ya * 22.0 - t * 1.6, seed + 7.0));
      float shimmer = mix(1.0, 0.45 + 1.1 * flow, uShimmer);
      float breath = mix(1.0, 0.72 + 0.56 * noise(vec2(t * 0.3, seed * 9.0)), uShimmer);
      vLight = vert * shimmer * breath * aParam.y;

      // 芯のわずかな揺れと、芯の太さの呼吸
      vSway = (noise(vec2(ya * 2.5 + seed, t * 0.12)) - 0.5) * 0.08 * uShimmer;
      vCoreW = aShape.z * (0.85 + 0.3 * noise(vec2(seed * 3.7, t * 0.25)));
      vX = aCorner.x;
      vSeed = seed;
      vColor = aColor;
    }
  `;

  // 柱：フラグメントシェーダー（横方向の光の形）
  const PILLAR_FS = `
    uniform float uTime;
    varying float vX;
    varying float vSway;
    varying float vCoreW;
    varying float vLight;
    varying float vSeed;
    varying vec3 vColor;
    ${NOISE_GLSL}
    void main() {
      if (vLight < 0.0005) discard;
      float x = vX - vSway;
      float core = exp(-0.5 * x * x / (vCoreW * vCoreW)); // 細く明るい芯
      float glow = 0.20 * exp(-0.5 * x * x / 0.04);        // 柔らかな広がり（σ=0.2）
      float halo = 0.05 * exp(-0.5 * x * x / 0.16);        // ごく淡い外側の光（σ=0.4）
      float streak = 0.75 + 0.5 * noise(vec2(x * 9.0 + vSeed * 11.0, vSeed)); // 縦の細かな筋
      float I = (core + (glow + halo) * streak) * vLight;
      vec3 col = mix(vColor, vec3(1.0), 0.45 * core) * I; // 芯ほど白っぽく
      // ディザ：暗い空でのなめらかな階調に縞（バンディング）が出ないよう、ごく小さな揺らぎを足す
      col += (hash(gl_FragCoord.xy + fract(uTime * 7.0) * 100.0) - 0.5) / 255.0 * step(0.004, I);
      col = max(col, 0.0);
      gl_FragColor = vec4(col, max(col.r, max(col.g, col.b)));
    }
  `;

  // ---------------------------------------------------------------
  // 粒子：柱の芯から外へ漏れ出し、瞬きながら消える
  // ---------------------------------------------------------------
  const PARTICLE_VS = `
    uniform float uTime;
    uniform float uPixelRatio;
    uniform float uSize;
    attribute vec2 aDims;     // x: 柱の板の半幅[m], y: 柱の高さ[m]
    attribute vec3 aColor;
    attribute vec4 aRand;     // 粒子ごとの乱数
    varying vec3 vColor;
    varying float vAlpha;
    void main() {
      float life = mix(4.0, 9.0, aRand.x);                // 生まれてから消えるまで（秒）
      float ph = fract(uTime / life + aRand.y);           // 0→1：一生のどこにいるか
      vec3 base = (modelMatrix * vec4(position, 1.0)).xyz;
      vec3 toCam = cameraPosition - base;
      vec3 right = normalize(vec3(toCam.z, 0.0, -toCam.x));

      float h = pow(aRand.z, 1.7) * 0.8;                  // 生まれる高さ（明るい根元寄り）
      float side = aRand.w < 0.5 ? -1.0 : 1.0;
      float drift = side * ph * mix(0.04, 0.25, fract(aRand.w * 7.31)) * aDims.x;   // 芯から外へ漏れ出す
      float wob = sin(uTime * mix(0.8, 1.6, aRand.x) + aRand.y * 40.0) * 0.02 * aDims.x; // ゆらゆら
      float rise = ph * mix(0.01, 0.06, fract(aRand.z * 13.7)) * aDims.y;               // ゆっくり昇る
      vec3 p = base + right * (drift + wob) + vec3(0.0, h * aDims.y + rise, 0.0);
      vec4 mv = viewMatrix * vec4(p, 1.0);
      gl_Position = projectionMatrix * mv;

      float fade = smoothstep(0.0, 0.12, ph) * (1.0 - smoothstep(0.5, 1.0, ph));
      float tw = pow(0.5 + 0.5 * sin(uTime * mix(3.0, 8.0, fract(aRand.y * 5.7)) + aRand.z * 50.0), 2.0); // 瞬き
      vAlpha = fade * (0.3 + 0.7 * tw) * (1.0 - 0.6 * h);
      vColor = mix(aColor, vec3(1.0), 0.5);
      gl_PointSize = uSize * mix(0.6, 1.3, fract(aRand.w * 3.3)) * uPixelRatio;
    }
  `;

  const PARTICLE_FS = `
    varying vec3 vColor;
    varying float vAlpha;
    void main() {
      vec2 d = gl_PointCoord - 0.5;
      float r2 = dot(d, d) * 4.0;                          // 中心 0、縁 1
      float a = vAlpha * (exp(-r2 * 6.0) + 0.25 * exp(-r2 * 2.0)) * (1.0 - smoothstep(0.6, 1.0, r2));
      if (a < 0.003) discard;
      vec3 c = vColor * a;
      gl_FragColor = vec4(c, max(c.r, max(c.g, c.b)));
    }
  `;

  // 光を足し合わせる合成（色もアルファも足す）。アルファ＝明るさなので、映像の上ではスクリーン合成に近くなる
  const ADDITIVE = {
    transparent: true, depthWrite: false, depthTest: true,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
    blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor,
  };

  // 決まった種から同じ並びを作る乱数（毎回同じ配置になる）
  function makeRandom(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const lerp = (a, b, t) => a + (b - a) * t;

  // グループの設定から、柱を1本ずつ作る
  function generatePillars(groups, seed) {
    const rnd = makeRandom(seed), list = [];
    for (const g of groups) {
      const palette = g.palette || PALETTE;
      const total = palette.reduce((s, p) => s + p.weight, 0);
      for (let i = 0; i < g.count; i++) {
        const u = (rnd() + rnd() + rnd()) / 1.5 - 1;   // −1〜1（中央ほど多い）
        const center = 1 - Math.abs(u);
        const brightness = lerp(g.brightness[0], g.brightness[1], Math.pow(rnd(), 2.0)); // 明るい柱は少なめ
        let pick = rnd() * total, color = palette[0].color;
        for (const p of palette) { if ((pick -= p.weight) <= 0) { color = p.color; break; } }
        list.push({
          azimuth: g.azimuth + u * g.spread,
          distance: lerp(g.distance[0], g.distance[1], rnd()),
          top: Math.min(80, lerp(g.top[0], g.top[1], Math.pow(center, 0.7)) + (rnd() - 0.5) * (g.topJitter ?? 12)),
          width: lerp(g.width[0], g.width[1], 0.4 * rnd() + 0.6 * brightness), // 明るい柱ほど太め
          brightness,
          color,
          seed: rnd() * 100,
          speed: lerp(0.7, 1.3, rnd()),
          fadeStart: lerp(0.35, 0.65, rnd()),
        });
      }
    }
    return list;
  }

  // 柱1本の、世界座標での大きさ
  function measure(p) {
    const az = p.azimuth * D2R, d = p.distance;
    const coreSigma = d * Math.tan(p.width * D2R / 2);  // 芯の太さ [m]
    return {
      x: d * Math.sin(az), z: -d * Math.cos(az),         // 方位 0 = −Z（正面）、右回り
      halfW: coreSigma * 20,                              // 板の半幅：芯の20倍まで光を広げる
      height: d * Math.tan(p.top * D2R),
      top: p.top * D2R,
    };
  }

  class LightPillars {
    constructor({ groups, seed = 7, shimmer = 1, particleDensity = 1, particleSize = 6, segments = 96 } = {}) {
      this.pillars = generatePillars(groups, seed);
      this.group = new THREE.Group();
      this.uTime = { value: 0 };
      this.pillarUniforms = { uTime: this.uTime, uShimmer: { value: shimmer } };
      this.particleUniforms = { uTime: this.uTime, uPixelRatio: { value: 1 }, uSize: { value: particleSize } };
      this.pillarMesh = this._buildPillars(segments);
      this.particles = this._buildParticles(particleDensity);
      this.group.add(this.pillarMesh, this.particles);
    }

    // time: 経過秒, pixelRatio: renderer.getPixelRatio()
    update(time, pixelRatio) {
      this.uTime.value = time;
      this.particleUniforms.uPixelRatio.value = pixelRatio;
    }

    set shimmer(v) { this.pillarUniforms.uShimmer.value = v; }
    get shimmer() { return this.pillarUniforms.uShimmer.value; }

    _buildPillars(segments) {
      const n = this.pillars.length, vpp = (segments + 1) * 2; // 1本あたりの頂点数（高さ方向に細かく分ける）
      const pos = new Float32Array(n * vpp * 3), corner = new Float32Array(n * vpp * 2);
      const shape = new Float32Array(n * vpp * 4), color = new Float32Array(n * vpp * 3), param = new Float32Array(n * vpp * 4);
      const index = [];
      const c = new THREE.Color();
      this.pillars.forEach((p, k) => {
        const m = measure(p);
        c.setHex(p.color);
        for (let s = 0; s <= segments; s++) {
          for (let side = 0; side < 2; side++) {
            const v = k * vpp + s * 2 + side;
            pos.set([m.x, 0, m.z], v * 3);                 // 根元（地面）の位置
            corner.set([side ? 1 : -1, s / segments], v * 2);
            shape.set([m.halfW, m.height, 1 / 20, m.top], v * 4);
            color.set([c.r, c.g, c.b], v * 3);
            param.set([p.seed, p.brightness, p.speed, p.fadeStart], v * 4);
          }
        }
        for (let s = 0; s < segments; s++) {
          const a = k * vpp + s * 2;
          index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
      });
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('aCorner', new THREE.BufferAttribute(corner, 2));
      geo.setAttribute('aShape', new THREE.BufferAttribute(shape, 4));
      geo.setAttribute('aColor', new THREE.BufferAttribute(color, 3));
      geo.setAttribute('aParam', new THREE.BufferAttribute(param, 4));
      geo.setIndex(index);
      const mat = new THREE.ShaderMaterial(Object.assign({
        uniforms: this.pillarUniforms, vertexShader: PILLAR_VS, fragmentShader: PILLAR_FS, side: THREE.DoubleSide,
      }, ADDITIVE));
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false; // 形はシェーダーで作るので、自動の画面外判定は使わない
      return mesh;
    }

    _buildParticles(density) {
      const counts = this.pillars.map(p => Math.round((8 + 24 * p.brightness) * density)); // 明るい柱ほど多く漏れる
      const total = counts.reduce((a, b) => a + b, 0);
      const pos = new Float32Array(total * 3), dims = new Float32Array(total * 2);
      const color = new Float32Array(total * 3), rand = new Float32Array(total * 4);
      const rnd = makeRandom(12345), c = new THREE.Color();
      let i = 0;
      this.pillars.forEach((p, k) => {
        const m = measure(p);
        c.setHex(p.color).multiplyScalar(0.4 + 0.6 * p.brightness); // 暗い柱の粒子は暗く
        for (let j = 0; j < counts[k]; j++, i++) {
          pos.set([m.x, 0, m.z], i * 3);
          dims.set([m.halfW, m.height], i * 2);
          color.set([c.r, c.g, c.b], i * 3);
          rand.set([rnd(), rnd(), rnd(), rnd()], i * 4);
        }
      });
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('aDims', new THREE.BufferAttribute(dims, 2));
      geo.setAttribute('aColor', new THREE.BufferAttribute(color, 3));
      geo.setAttribute('aRand', new THREE.BufferAttribute(rand, 4));
      const mat = new THREE.ShaderMaterial(Object.assign({
        uniforms: this.particleUniforms, vertexShader: PARTICLE_VS, fragmentShader: PARTICLE_FS,
      }, ADDITIVE));
      const points = new THREE.Points(geo, mat);
      points.frustumCulled = false;
      return points;
    }
  }

  LightPillars.PALETTE = PALETTE;
  window.LightPillars = LightPillars;
})();

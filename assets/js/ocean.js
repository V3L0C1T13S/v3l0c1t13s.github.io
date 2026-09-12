/* Ocean backdrop, drawn in WebGL as a faithful port of the original CSS.
 *
 * The previous CSS version built the water out of DOM layers carrying
 * mix-blend-mode: screen, large blurs, perspective transforms, masks and
 * animated SVG turbulence. This file is a compositor for that exact recipe,
 * not an approximation of its look:
 *
 *   - the depth gradients are reproduced stop-for-stop in the shader;
 *   - caustics use the same baked textures the CSS used;
 *   - grain is generated per pixel, without a repeating texture tile;
 *   - blurs that CSS applied with filter: blur() are baked into the stripe
 *     profiles with canvas filter, so they match;
 *   - the rotateX/perspective planes are reproduced as homographies derived
 *     from the same CSS transforms, so the geometry matches;
 *   - masks are the same piecewise-linear gradients and gradients interpolate
 *     in premultiplied alpha, as CSS does;
 *   - layers are composited in the original order with the same screen /
 *     source-over blending.
 *
 * The result is one canvas instead of a dozen composited, filtered DOM layers.
 */
(function () {
  'use strict';

  var canvas = document.getElementById('ocean');
  var root = document.documentElement;
  if (!canvas) return;

  var IMAGES = (canvas.getAttribute('data-images') || '/assets/images/');

  /* WebGL2 is required for REPEAT on the non-power-of-two texture tiles. */
  var gl = null;
  try {
    gl = canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false,
      premultipliedAlpha: false, preserveDrawingBuffer: false,
      powerPreference: 'high-performance'
    });
  } catch (e) { gl = null; }

  /* WebGL is required — there is no static fallback. */
  if (!gl) return;

  var reduceMotion = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var DEG = Math.PI / 180;
  var clamp01 = function (v) { return v < 0 ? 0 : v > 1 ? 1 : v; };

  /* ---------------------------------------------------------------- shaders */

  var VS = 'attribute vec2 aPos; void main() { gl_Position = vec4(aPos, 0.0, 1.0); }';

  var PRELUDE = [
    'precision highp float;',
    'uniform vec2 uRes;',
    'uniform vec2 uCss;',
    'vec2 screenPx() {',
    '  return vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) / uRes * uCss;',
    '}',
    /* Regions fully hidden behind an opaque panel (see updateCover) are skipped
       before any of the per-pixel work: the panel paints a captured frame there,
       so shading the live water underneath is wasted. */
    'uniform vec4 uCover[8];',
    'uniform int uCoverN;',
    'void skipCovered() {',
    '  vec2 sp = screenPx();',
    '  for (int i = 0; i < 8; i++) {',
    '    if (i >= uCoverN) break;',
    '    vec4 r = uCover[i];',
    '    if (sp.x >= r.x && sp.x < r.z && sp.y >= r.y && sp.y < r.w) discard;',
    '  }',
    '}',
    /* CSS gradients interpolate in premultiplied alpha. */
    'vec4 gmix(vec4 a, vec4 b, float t) {',
    '  vec4 A = vec4(a.rgb * a.a, a.a);',
    '  vec4 B = vec4(b.rgb * b.a, b.a);',
    '  vec4 C = mix(A, B, t);',
    '  return vec4(C.rgb / max(C.a, 1e-5), C.a);',
    '}',
    'vec4 over(vec4 dst, vec4 src) {',
    '  float a = src.a + dst.a * (1.0 - src.a);',
    '  vec3 rgb = (src.rgb * src.a + dst.rgb * dst.a * (1.0 - src.a)) / max(a, 1e-5);',
    '  return vec4(rgb, a);',
    '}'
  ].join('\n');

  var WATER_FS = PRELUDE + '\n' + [
    'vec3 linGrad(float t, vec3 c0, float p1, vec3 c1, float p2, vec3 c2,',
    '             float p3, vec3 c3, float p4, vec3 c4, float p5, vec3 c5,',
    '             float p6, vec3 c6, float p7, vec3 c7, float p8, vec3 c8) {',
    '  vec3 c = c0;',
    '  c = mix(c, c1, clamp((t - 0.0) / p1, 0.0, 1.0));',
    '  c = mix(c, c2, clamp((t - p1) / (p2 - p1), 0.0, 1.0));',
    '  c = mix(c, c3, clamp((t - p2) / (p3 - p2), 0.0, 1.0));',
    '  c = mix(c, c4, clamp((t - p3) / (p4 - p3), 0.0, 1.0));',
    '  c = mix(c, c5, clamp((t - p4) / (p5 - p4), 0.0, 1.0));',
    '  c = mix(c, c6, clamp((t - p5) / (p6 - p5), 0.0, 1.0));',
    '  c = mix(c, c7, clamp((t - p6) / (p7 - p6), 0.0, 1.0));',
    '  c = mix(c, c8, clamp((t - p7) / (p8 - p7), 0.0, 1.0));',
    '  return c;',
    '}',
    'uniform float uDepth;',
    'vec4 rad3(float r, float p0, vec4 c0, float p1, vec4 c1, float p2, vec4 c2) {',
    '  if (r <= p0) return c0;',
    '  if (r < p1) return gmix(c0, c1, (r - p0) / (p1 - p0));',
    '  if (r < p2) return gmix(c1, c2, (r - p1) / (p2 - p1));',
    '  return c2;',
    '}',
    'void main() {',
    '  skipCovered();',
    '  vec2 sp = screenPx();',
    '  float t = sp.y / uCss.y;',
    /* ---- open water ---- */
    '  vec3 open = vec3(0.0);',
    '  if (uDepth < 1.0) {',
    '  open = linGrad(t,',
    '    vec3(0.0392,0.2314,0.2588), 0.12, vec3(0.0353,0.1961,0.2235),',
    '    0.25, vec3(0.0314,0.1647,0.1922), 0.38, vec3(0.0275,0.1373,0.1647),',
    '    0.52, vec3(0.0235,0.1137,0.1373), 0.66, vec3(0.0196,0.0941,0.1137),',
    '    0.80, vec3(0.0157,0.0745,0.0941), 0.90, vec3(0.0137,0.0667,0.0863),',
    '    1.00, vec3(0.0118,0.0588,0.0784));',
    '  {',
    '    vec2 d = (sp - vec2(0.50, -0.30) * uCss) / (vec2(1.50, 0.80) * uCss);',
    '    vec4 s = rad3(length(d), 0.0, vec4(0.376,0.784,0.761,0.13),',
    '                  0.44, vec4(0.133,0.455,0.478,0.07), 0.78, vec4(0.0,0.0,0.0,0.0));',
    '    open = over(vec4(open, 1.0), s).rgb;',
    '  }',
    '  }',
    /* ---- twilight ---- */
    '  vec3 twi = vec3(0.0);',
    '  if (uDepth > 0.0) {',
    '  twi = linGrad(t,',
    '    vec3(0.0392,0.1922,0.2510), 0.09, vec3(0.0275,0.1529,0.2039),',
    '    0.19, vec3(0.0196,0.1216,0.1686), 0.31, vec3(0.0157,0.0941,0.1373),',
    '    0.44, vec3(0.0118,0.0706,0.1059), 0.58, vec3(0.0078,0.0510,0.0784),',
    '    0.72, vec3(0.0039,0.0314,0.0549), 0.86, vec3(0.0,0.0196,0.0353),',
    '    1.00, vec3(0.0,0.0196,0.0314));',
    /* Second-listed background first: broad glow, then the sun disc on top. */
    '  {',
    '    vec2 d = (sp - vec2(0.62, -0.16) * uCss) / (vec2(1.50, 0.60) * uCss);',
    '    vec4 s = rad3(length(d), 0.0, vec4(0.133,0.478,0.510,0.16),',
    '                  0.44, vec4(0.047,0.220,0.282,0.08), 0.74, vec4(0.0,0.0,0.0,0.0));',
    '    twi = over(vec4(twi, 1.0), s).rgb;',
    '  }',
    '  {',
    '    vec2 d = (sp - vec2(0.62, -0.10) * uCss) / (vec2(0.44, 0.24) * uCss);',
    '    vec4 s = rad3(length(d), 0.0, vec4(0.573,0.886,0.847,0.13),',
    '                  0.42, vec4(0.227,0.588,0.635,0.07), 0.78, vec4(0.0,0.0,0.0,0.0));',
    '    twi = over(vec4(twi, 1.0), s).rgb;',
    '  }',
    '  }',
    '  gl_FragColor = vec4(mix(open, twi, uDepth), 1.0);',
    '}'
  ].join('\n');

  var LAYER_FS = PRELUDE + '\n' + [
    'uniform sampler2D uTex;',
    'uniform mat3 uInv;',
    'uniform vec2 uOffset;',
    'uniform float uOpacity;',
    'uniform vec4 uClip;',
    'uniform vec4 uMaskP;',
    'uniform vec4 uMaskV;',
    'uniform vec4 uMaskRect;',
    'uniform vec4 uMaskHP;',
    'uniform vec4 uMaskHV;',
    'uniform vec4 uMaskHRect;',
    'uniform float uUseH;',
    'float pwl(float t, vec4 p, vec4 v) {',
    '  if (t <= p.x) return v.x;',
    '  if (t < p.y) return mix(v.x, v.y, (t - p.x) / (p.y - p.x));',
    '  if (t < p.z) return mix(v.y, v.z, (t - p.y) / (p.z - p.y));',
    '  if (t < p.w) return mix(v.z, v.w, (t - p.z) / (p.w - p.z));',
    '  return v.w;',
    '}',
    'void main() {',
    '  skipCovered();',
    '  vec2 sp = screenPx();',
    '  if (sp.x < uClip.x || sp.y < uClip.y || sp.x > uClip.z || sp.y > uClip.w) {',
    '    gl_FragColor = vec4(0.0); return;',
    '  }',
    '  vec3 q = uInv * vec3(sp, 1.0);',
    '  if (q.z <= 0.0) { gl_FragColor = vec4(0.0); return; }',
    '  vec2 uv = q.xy / q.z + uOffset;',
    '  vec4 tex = texture2D(uTex, uv);',
    '  float m = pwl((sp.y - uMaskRect.y) / (uMaskRect.w - uMaskRect.y), uMaskP, uMaskV);',
    '  if (uUseH > 0.5) {',
    '    m *= pwl((sp.x - uMaskHRect.x) / (uMaskHRect.z - uMaskHRect.x), uMaskHP, uMaskHV);',
    '  }',
    '  gl_FragColor = vec4(tex.rgb * (uOpacity * m), 1.0);',
    '}'
  ].join('\n');

  var BLOOM_FS = PRELUDE + '\n' + [
    'uniform vec2 uC;',
    'uniform vec2 uR;',
    'uniform vec4 uP;',
    'uniform vec4 uC0, uC1, uC2, uC3;',
    'uniform float uOpacity;',
    'vec4 grad(float r) {',
    '  if (r <= uP.x) return uC0;',
    '  if (r < uP.y) return gmix(uC0, uC1, (r - uP.x) / (uP.y - uP.x));',
    '  if (r < uP.z) return gmix(uC1, uC2, (r - uP.y) / (uP.z - uP.y));',
    '  if (r < uP.w) return gmix(uC2, uC3, (r - uP.z) / (uP.w - uP.z));',
    '  return uC3;',
    '}',
    'void main() {',
    '  skipCovered();',
    '  vec2 sp = screenPx();',
    '  vec4 c = grad(length((sp - uC) / uR));',
    '  float a = c.a * uOpacity;',
    '  gl_FragColor = vec4(c.rgb * a, 1.0);',
    '}'
  ].join('\n');

  var HAZE_FS = PRELUDE + '\n' + [
    'uniform float uDepth;',
    'uniform float uOpacity;',
    'vec4 lg4(float y, vec4 c0, float p1, vec4 c1, float p2, vec4 c2, float p3, vec4 c3) {',
    '  vec4 c = c0;',
    '  c = gmix(c, c1, clamp(y / p1, 0.0, 1.0));',
    '  c = gmix(c, c2, clamp((y - p1) / (p2 - p1), 0.0, 1.0));',
    '  c = gmix(c, c3, clamp((y - p2) / (p3 - p2), 0.0, 1.0));',
    '  return c;',
    '}',
    'vec4 rd2(float r, vec4 c0, float p1, vec4 c1) {',
    '  if (r <= 0.0) return c0;',
    '  if (r < p1) return gmix(c0, c1, r / p1);',
    '  return c1;',
    '}',
    'void main() {',
    '  skipCovered();',
    '  vec2 sp = screenPx();',
    '  float y = sp.y / uCss.y;',
    '  vec4 twi = vec4(0.0);',
    '  if (uDepth > 0.0) {',
    '  vec4 trad = rd2(length((sp - vec2(0.62, 0.0) * uCss) / (vec2(1.20, 0.58) * uCss)),',
    '                  vec4(0.408, 0.800, 0.776, 0.06), 0.62, vec4(0.0));',
    '  vec4 tlin = lg4(y, vec4(0.329,0.722,0.722,0.055), 0.26, vec4(0.149,0.455,0.486,0.03),',
    '                  0.58, vec4(0.0), 1.0, vec4(0.0));',
    '  twi = over(trad, tlin);',
    '  }',
    '  vec4 open = vec4(0.0);',
    '  if (uDepth < 1.0) {',
    '  vec4 orad = rd2(length((sp - vec2(0.50, -0.06) * uCss) / (vec2(1.30, 0.70) * uCss)),',
    '                  vec4(0.478, 0.863, 0.816, 0.06), 0.66, vec4(0.0));',
    '  vec4 olin = lg4(y, vec4(0.376,0.808,0.776,0.075), 0.34, vec4(0.220,0.612,0.604,0.055),',
    '                  0.70, vec4(0.133,0.431,0.439,0.04), 1.0, vec4(0.094,0.329,0.345,0.028));',
    '  open = over(orad, olin);',
    '  }',
    '  vec4 h = mix(open, twi, uDepth);',
    '  float a = h.a * uOpacity;',
    '  gl_FragColor = vec4(h.rgb * a, 1.0);',
    '}'
  ].join('\n');

  var VIGNETTE_FS = PRELUDE + '\n' + [
    'uniform float uDepth;',
    'vec4 rad4(float r, float p0, vec4 c0, float p1, vec4 c1, float p2, vec4 c2, float p3, vec4 c3) {',
    '  if (r <= p0) return c0;',
    '  if (r < p1) return gmix(c0, c1, (r - p0) / (p1 - p0));',
    '  if (r < p2) return gmix(c1, c2, (r - p1) / (p2 - p1));',
    '  if (r < p3) return gmix(c2, c3, (r - p2) / (p3 - p2));',
    '  return c3;',
    '}',
    'void main() {',
    '  skipCovered();',
    '  vec2 sp = screenPx();',
    '  vec4 t = vec4(0.0);',
    '  if (uDepth > 0.0) {',
    '  vec2 dT = (sp - vec2(0.50, 0.30) * uCss) / (vec2(1.15, 0.80) * uCss);',
    '  t = rad4(length(dT), 0.38, vec4(0.0,0.0,0.0,0.0), 0.76, vec4(0.0,0.020,0.031,0.60),',
    '                1.0, vec4(0.0,0.020,0.031,0.95), 1.0, vec4(0.0,0.020,0.031,0.95));',
    '  }',
    '  vec4 o = vec4(0.0);',
    '  if (uDepth < 1.0) {',
    '  vec2 dO = (sp - vec2(0.50, 0.26) * uCss) / (vec2(1.20, 0.88) * uCss);',
    '  o = rad4(length(dO), 0.42, vec4(0.0,0.0,0.0,0.0), 0.78, vec4(0.004,0.055,0.071,0.50),',
    '                1.0, vec4(0.0,0.031,0.043,0.80), 1.0, vec4(0.0,0.031,0.043,0.80));',
    '  }',
    '  vec4 v = mix(o, t, uDepth);',
    '  gl_FragColor = vec4(v.rgb * v.a, v.a);',
    '}'
  ].join('\n');

  var GRAIN_VS = '#version 300 es\nin vec2 aPos; void main() { gl_Position = vec4(aPos, 0.0, 1.0); }';
  var GRAIN_FS = '#version 300 es\n' + PRELUDE + '\n' + [
    'precision highp int;',
    'uniform uint uSeed;',
    'uniform float uOpacity;',
    'out vec4 fragColor;',
    /* Integer hashing avoids the bands and precision artefacts of sin-based
       noise. Each pixel and each grain frame get a different input. */
    'uint hash(uint inputValue) {',
    '  uint state = inputValue * 747796405u + 2891336453u;',
    '  uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;',
    '  return (word >> 22u) ^ word;',
    '}',
    'void main() {',
    '  skipCovered();',
    '  uvec2 pixel = uvec2(gl_FragCoord.xy);',
    '  uint bits = hash(pixel.x ^ hash(pixel.y) ^ hash(uSeed));',
    /* Average two independent halves for softer, film-like grain. Keep the
       old texture's mean tint and alpha so the ocean retains its brightness. */
    '  float noise = float((bits & 65535u) + (bits >> 16u)) / 131070.0;',
    '  float shade = 0.74 + (noise - 0.5) * 0.7;',
    '  float alpha = uOpacity * 0.5;',
    '  fragColor = vec4(vec3(shade * alpha), alpha);',
    '}'
  ].join('\n');

  var SNOW_VS = [
    'attribute vec2  aPos;',
    'attribute float aSeed;',
    'attribute float aLayer;',
    'uniform float uTime;',
    'uniform float uDpr;',
    'varying float vAlpha;',
    'varying float vSoft;',
    'varying vec3  vColor;',
    'float pwl(float t, vec4 p, vec4 v) {',
    '  if (t <= p.x) return v.x;',
    '  if (t < p.y) return mix(v.x, v.y, (t - p.x) / (p.y - p.x));',
    '  if (t < p.z) return mix(v.y, v.z, (t - p.y) / (p.z - p.y));',
    '  if (t < p.w) return mix(v.z, v.w, (t - p.z) / (p.w - p.z));',
    '  return v.w;',
    '}',
    'void main() {',
    '  float glint = step(2.5, aLayer);',
    '  float far   = 1.0 - step(0.5, aLayer);',
    '  float mid   = step(0.5, aLayer) * (1.0 - step(1.5, aLayer));',
    '  float near  = step(1.5, aLayer) * (1.0 - step(2.5, aLayer));',
    '  float speed  = far*0.0034 + mid*0.0056 + near*0.0110 + glint*0.0024;',
    '  float size   = far*1.9    + mid*2.8    + near*5.0    + glint*1.2;',
    '  float alpha  = far*0.20   + mid*0.26   + near*0.13   + glint*0.95;',
    '  float sway   = far*0.012  + mid*0.020  + near*0.026  + glint*0.006;',
    '  float period = far*37.0   + mid*26.0   + near*19.0   + glint*52.0;',
    '  float soft   = far*0.55   + mid*0.50   + near*0.95   + glint*0.30;',
    '  float y = fract(aPos.y + uTime * speed);',
    '  float x = aPos.x + sway * sin(uTime * 6.2831853 / period + aSeed * 6.2831853);',
    /* mask is defined against the .snow box (inset -30% -12%) */
    '  float mt = (y + 0.30) / 1.60;',
    '  vec4 mp = far*vec4(0.04,0.22,0.68,1.0) + mid*vec4(0.0,0.16,0.66,1.0) + near*vec4(0.0,0.14,0.70,1.0) + glint*vec4(0.0,0.08,0.52,1.0);',
    '  vec4 mv = far*vec4(0.0,1.0,1.0,0.0)     + mid*vec4(0.0,1.0,0.2,0.0)  + near*vec4(0.0,1.0,1.0,0.0)  + glint*vec4(0.0,1.0,0.55,0.0);',
    /* glints catch the light: sharp twinkles, pure white, very small */
    '  float tw = 0.35 + 0.65 * pow(0.5 + 0.5 * sin(uTime * 2.3 + aSeed * 41.0), 3.0);',
    '  vAlpha = alpha * pwl(mt, mp, mv) * mix(1.0, tw, glint);',
    '  vSoft  = soft;',
    '  vColor = mix(vec3(far*0.745 + mid*0.804 + near*0.843,',
    '                    far*0.922 + mid*0.961 + near*0.980,',
    '                    far*0.941 + mid*0.961 + near*0.980), vec3(1.0), glint);',
    '  gl_Position = vec4(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);',
    '  gl_PointSize = max(1.0, size * uDpr);',
    '}'
  ].join('\n');

  var SNOW_FS = [
    'precision mediump float;',
    'varying float vAlpha;',
    'varying float vSoft;',
    'varying vec3  vColor;',
    'void main() {',
    '  float r = length(gl_PointCoord - 0.5) * 2.0;',
    '  float a = (1.0 - smoothstep(vSoft, 1.0, r)) * vAlpha;',
    '  gl_FragColor = vec4(vColor * a, 1.0);',
    '}'
  ].join('\n');

  /* -------------------------------------------------------------- plumbing */

  function compile(type, src) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      if (window.console) console.error('ocean shader:', gl.getShaderInfoLog(sh), src);
      gl.deleteShader(sh);
      return null;
    }
    return sh;
  }
  function link(vsSrc, fsSrc) {
    var vs = compile(gl.VERTEX_SHADER, vsSrc);
    var f = compile(gl.FRAGMENT_SHADER, fsSrc);
    if (!vs || !f) {
      if (vs) gl.deleteShader(vs);
      if (f) gl.deleteShader(f);
      return null;
    }
    var p = gl.createProgram();
    gl.attachShader(p, vs); gl.attachShader(p, f); gl.linkProgram(p);
    gl.deleteShader(vs); gl.deleteShader(f);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      if (window.console) console.error('ocean link:', gl.getProgramInfoLog(p));
      gl.deleteProgram(p);
      return null;
    }
    return p;
  }
  function program(fs) {
    return link(VS, fs);
  }

  var P = {
    water: program(WATER_FS),
    layer: program(LAYER_FS),
    bloom: program(BLOOM_FS),
    haze: program(HAZE_FS),
    vignette: program(VIGNETTE_FS),
    grain: link(GRAIN_VS, GRAIN_FS),
    snow: link(SNOW_VS, SNOW_FS)
  };
  if (!P.water || !P.layer || !P.bloom || !P.haze || !P.vignette || !P.grain || !P.snow) return;

  var commonUniforms = ['uRes', 'uCss', 'uCover', 'uCoverN'];
  var uniformNames = {
    water: ['uDepth'],
    layer: ['uOpacity', 'uTex', 'uInv', 'uOffset', 'uClip', 'uMaskP', 'uMaskV',
      'uMaskRect', 'uMaskHP', 'uMaskHV', 'uMaskHRect', 'uUseH'],
    bloom: ['uC', 'uR', 'uP', 'uC0', 'uC1', 'uC2', 'uC3', 'uOpacity'],
    haze: ['uDepth', 'uOpacity'],
    vignette: ['uDepth'],
    grain: ['uSeed', 'uOpacity'],
    snow: ['uTime', 'uDpr']
  };
  var U = {};
  Object.keys(P).forEach(function (k) {
    var p = P[k];
    var u = U[k] = { aPos: gl.getAttribLocation(p, 'aPos') };
    var names = k === 'snow' ? uniformNames[k] : commonUniforms.concat(uniformNames[k]);
    names.forEach(function (name) { u[name] = gl.getUniformLocation(p, name); });
  });

  U.snow.aSeed = gl.getAttribLocation(P.snow, 'aSeed');
  U.snow.aLayer = gl.getAttribLocation(P.snow, 'aLayer');

  /* Marine snow as additive point sprites, so the specks stay crisp instead of
     being averaged away by texture filtering. */
  var snowCount = 0;
  var snowBuffer = gl.createBuffer();
  (function () {
    var rnd = (function (a) {
      return function () {
        a |= 0; a = a + 0x6D2B79F5 | 0;
        var t = Math.imul(a ^ a >>> 15, 1 | a);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
      };
    })(0x5EAFEED >>> 0);
    var layers = [260, 120, 55, 130];
    var data = [];
    for (var l = 0; l < layers.length; l++) {
      for (var i = 0; i < layers[l]; i++) {
        data.push(rnd(), rnd(), rnd(), l);
      }
    }
    snowCount = data.length / 4;
    gl.bindBuffer(gl.ARRAY_BUFFER, snowBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
  }());

  var quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

  /* Attribute bindings are immutable. Keep them in VAOs instead of rebuilding
     the same buffer layout for every layer on every frame. */
  Object.keys(P).forEach(function (k) {
    var u = U[k];
    gl.useProgram(P[k]);
    if (u.uTex) gl.uniform1i(u.uTex, 0);
    u.vao = gl.createVertexArray();
    gl.bindVertexArray(u.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, k === 'snow' ? snowBuffer : quad);
    gl.enableVertexAttribArray(u.aPos);
    gl.vertexAttribPointer(u.aPos, 2, gl.FLOAT, false, k === 'snow' ? 16 : 0, 0);
    if (k === 'snow') {
      gl.enableVertexAttribArray(u.aSeed);
      gl.vertexAttribPointer(u.aSeed, 1, gl.FLOAT, false, 16, 8);
      gl.enableVertexAttribArray(u.aLayer);
      gl.vertexAttribPointer(u.aLayer, 1, gl.FLOAT, false, 16, 12);
    }
  });
  gl.bindVertexArray(null);
  gl.activeTexture(gl.TEXTURE0);

  /* -------------------------------------------------------- texture helpers */

  function texFrom(source, w, h, repeat) {
    var t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    /* CSS background origin is top-left and uv.y grows downward, so the
       image must not be flipped. */
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    /* Images/canvases are straight-alpha; premultiply so LINEAR filtering and
       screen blending behave like the browser's compositor. */
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, !(source instanceof Uint8Array));
    if (source instanceof Uint8Array) {
      /* Raw pixels use the sized overload; images/canvases use the source one. */
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    }
    var wrap = repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return t;
  }

  function blankTex() {
    return texFrom(new Uint8Array([0, 0, 0, 0]), 1, 1, false);
  }

  function loadImage(url, cb) {
    var img = new Image();
    img.onload = function () { cb(img); };
    img.onerror = function () { cb(null); };
    img.src = url;
  }

  /* Bake a horizontal colour profile (one gradient period), blurred exactly as
     CSS filter: blur() would blur the plane, then cropped so it tiles. */
  function bakeProfile(period, blur, stops) {
    var W = period * 3;
    /* Tall enough that the isotropic blur never reaches the top/bottom edge,
       otherwise it pulls in transparent pixels and kills the stripe alpha. */
    var H = Math.max(8, Math.ceil(blur * 6) + 8);
    var cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    var ctx = cv.getContext('2d');
    var g = ctx.createLinearGradient(0, 0, W, 0);
    for (var k = 0; k < 3; k++) {
      for (var i = 0; i < stops.length; i++) {
        g.addColorStop(clamp01((k * period + stops[i][0]) / W), stops[i][1]);
      }
    }
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    if (blur > 0) {
      var cv2 = document.createElement('canvas');
      cv2.width = W; cv2.height = H;
      var c2 = cv2.getContext('2d');
      c2.filter = 'blur(' + blur + 'px)';
      c2.drawImage(cv, 0, 0);
      cv = cv2;
    }
    var out = document.createElement('canvas');
    out.width = period; out.height = H;
    out.getContext('2d').drawImage(cv, period, 0, period, H, 0, 0, period, H);
    return out;
  }

  /* ---------------------------------------------------------- 3x3 utilities */

  function mat3inv(m) {
    var a = m[0], b = m[1], c = m[2], d = m[3], e = m[4], f = m[5], g = m[6], h = m[7], i = m[8];
    var A = e * i - f * h, B = c * h - b * i, C = b * f - c * e;
    var det = a * A + d * B + g * C;
    if (Math.abs(det) < 1e-9) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
    var s = 1 / det;
    return [A * s, B * s, C * s,
            (f * g - d * i) * s, (a * i - c * g) * s, (c * d - a * f) * s,
            (d * h - e * g) * s, (b * g - a * h) * s, (a * e - b * d) * s];
  }

  /* Project a point on a rotated, perspective plane to homogeneous screen px. */
  function planeH(spec, x, y) {
    var rx = (spec.sx0 + x) - spec.ox, ry = (spec.sy0 + y) - spec.oy;
    rx += spec.tx; ry += spec.ty;
    if (spec.rz) {
      var cz = Math.cos(spec.rz), sz = Math.sin(spec.rz);
      var nx = rx * cz - ry * sz, ny = rx * sz + ry * cz;
      rx = nx; ry = ny;
    }
    var z = 0;
    if (spec.rx) {
      var cx = Math.cos(spec.rx), sx = Math.sin(spec.rx);
      var ny2 = ry * cx;
      z = spec.zsign * ry * sx;
      ry = ny2;
    }
    var Px = spec.ox + rx, Py = spec.oy + ry;
    var W = spec.d - z;
    return [spec.pox * W + (Px - spec.pox) * spec.d,
            spec.poy * W + (Py - spec.poy) * spec.d, W];
  }
  /* screen px -> plane uv (u = local.x / period, v = 0.5) */
  function planeUVMatrix(spec, period) {
    var h00 = planeH(spec, 0, 0), h10 = planeH(spec, 1, 0), h01 = planeH(spec, 0, 1);
    var H = [h10[0] - h00[0], h01[0] - h00[0], h00[0],
             h10[1] - h00[1], h01[1] - h00[1], h00[1],
             h10[2] - h00[2], h01[2] - h00[2], h00[2]];
    var inv = mat3inv(H);
    /* u = local.x/period, v = 0.5 */
    return [inv[0] / period, inv[1] / period, inv[2] / period,
            0.5 * inv[6], 0.5 * inv[7], 0.5 * inv[8],
            inv[6], inv[7], inv[8]];
  }
  /* screen px -> plane uv (u = local.x/tile, v = local.y/tile) */
  function planeUV2Matrix(spec, tile) {
    var h00 = planeH(spec, 0, 0), h10 = planeH(spec, 1, 0), h01 = planeH(spec, 0, 1);
    var H = [h10[0] - h00[0], h01[0] - h00[0], h00[0],
             h10[1] - h00[1], h01[1] - h00[1], h00[1],
             h10[2] - h00[2], h01[2] - h00[2], h00[2]];
    var inv = mat3inv(H);
    return [inv[0] / tile, inv[1] / tile, inv[2] / tile,
            inv[3] / tile, inv[4] / tile, inv[5] / tile,
            inv[6], inv[7], inv[8]];
  }

  /* ---------------------------------------------------------- easing/anim */

  function easeInOut(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }
  function seg(t, p) { /* phase of a p-second cycle, folded into [0,1) */
    return (t / p) - Math.floor(t / p);
  }
  function key2(p, v0, v1, v2) { /* 0/50/100% with ease-in-out */
    if (p < 0.5) return v0 + (v1 - v0) * easeInOut(p / 0.5);
    return v1 + (v2 - v1) * easeInOut((p - 0.5) / 0.5);
  }

  /* --------------------------------------------------------------- textures */

  var tex = {};
  tex.causticsA = blankTex();
  tex.causticsB = blankTex();

  var causticsRequested = false;
  function ensureCaustics() {
    if (causticsRequested) return;
    causticsRequested = true;
    /* Open water never samples these images. Fetch and bake the twilight
       layers only when that depth is first drawn. */
    ['A', 'B'].forEach(function (suffix) {
      loadImage(IMAGES + 'caustics-' + suffix.toLowerCase() + '.webp', function (img) {
        if (img) {
          var key = 'caustics' + suffix;
          gl.deleteTexture(tex[key]);
          tex[key] = texFrom(img, img.width, img.height, true);
          capturedDepth = -1;
          render();
        }
      });
    });
    tex.rayA = texFrom(bakeProfile(RAY_A.period, RAY_A.blur, RAY_A.stops), 1, 1, true);
    tex.rayB = texFrom(bakeProfile(RAY_B.period, RAY_B.blur, RAY_B.stops), 1, 1, true);
    tex.rayC = texFrom(bakeProfile(RAY_C.period, RAY_C.blur, RAY_C.stops), 1, 1, true);
  }
  /* Layout may still settle after the first frame. Refresh the frost capture
     once the page has loaded. Late caustic decodes invalidate it separately. */
  window.addEventListener('load', function () { capturedDepth = -1; render(); });
  /* Ray shaft profiles: repeating-linear-gradient at 90deg + blur. */
  var RAY_A = { period: 132, blur: 5, stops: [
    [0, 'rgba(0,0,0,0)'], [6, 'rgba(128,224,214,0.065)'],
    [16, 'rgba(168,240,228,0.10)'], [27, 'rgba(128,224,214,0.055)'],
    [40, 'rgba(0,0,0,0)'], [132, 'rgba(0,0,0,0)']] };
  var RAY_B = { period: 205, blur: 9, stops: [
    [0, 'rgba(0,0,0,0)'], [10, 'rgba(106,206,202,0.05)'],
    [22, 'rgba(150,232,220,0.075)'], [44, 'rgba(0,0,0,0)'],
    [205, 'rgba(0,0,0,0)']] };
  var RAY_C = { period: 340, blur: 2.5, stops: [
    [0, 'rgba(0,0,0,0)'], [4, 'rgba(186,246,232,0.09)'],
    [11, 'rgba(0,0,0,0)'], [340, 'rgba(0,0,0,0)']] };

  /* Open-water column profiles: repeating-linear-gradient at 93deg/87deg. */
  var COL_A = { angle: 93, period: 310, blur: 13, stops: [
    [0, 'rgba(0,0,0,0)'], [18, 'rgba(112,216,204,0.10)'],
    [52, 'rgba(150,236,220,0.155)'], [88, 'rgba(112,216,204,0.085)'],
    [120, 'rgba(0,0,0,0)'], [168, 'rgba(0,0,0,0)'],
    [196, 'rgba(130,226,212,0.115)'], [250, 'rgba(0,0,0,0)'], [310, 'rgba(0,0,0,0)']] };
  var COL_B = { angle: 87, period: 244, blur: 7, stops: [
    [0, 'rgba(0,0,0,0)'], [10, 'rgba(164,240,226,0.12)'],
    [40, 'rgba(0,0,0,0)'], [118, 'rgba(0,0,0,0)'],
    [140, 'rgba(124,220,208,0.085)'], [196, 'rgba(0,0,0,0)'], [244, 'rgba(0,0,0,0)']] };
  tex.colA = texFrom(bakeProfile(COL_A.period, COL_A.blur, COL_A.stops), 1, 1, true);
  tex.colB = texFrom(bakeProfile(COL_B.period, COL_B.blur, COL_B.stops), 1, 1, true);

  /* The recipes never change; keep them out of the animation loop. */
  var sheets = [
    { tex: 'causticsA', tilt: -74 * DEG, tile: 700, period: 41, drift: [-1, 1], op: 0.8 },
    { tex: 'causticsB', tilt: -72 * DEG, tile: 560, period: 29, drift: [1, 1], op: 0.5 }
  ];
  var planes = [
    { tex: 'rayA', prof: RAY_A, rx: 72, period: 23, rz0: -1.6, rz1: 1.4,
      tx0: -2, tx1: 3, o0: 0.62, o1: 0.95, o2: 0.62 },
    { tex: 'rayB', prof: RAY_B, rx: 70, period: 34, rz0: 2.2, rz1: -1.2,
      tx0: 2, tx1: -3.5, o0: 0.8, o1: 0.45, o2: 0.8 },
    { tex: 'rayC', prof: RAY_C, rx: 74, period: 17, rz0: 0.6, rz1: -0.8,
      tx0: 0, tx1: -1.5, o0: 0.25, o1: 0.9, o2: 0.25 }
  ];
  var cols = [
    { tex: 'colA', def: COL_A, period: 38, tx0: -2, tx1: 3, tx2: -2, s0: 1, s1: 1.06, s2: 1, o0: 0.7, o1: 1, o2: 0.7 },
    { tex: 'colB', def: COL_B, period: 27, tx0: 2.5, tx1: -2, tx2: 2.5, s0: 1.04, s1: 1, s2: 1.04, o0: 0.9, o1: 0.5, o2: 0.9 }
  ];
  var blooms = [
    { w: 62, h: 44, left: -22, top: 6, period: 62, dx: 6, dy: 4, s: 1.14, o0: 0.85, o1: 1,
      c: [[104, 226, 194, 0.115], [52, 168, 160, 0.075], [18, 82, 96, 0.035], [0, 0, 0, 0]],
      p: [0, 0.42, 0.68, 0.92] },
    { w: 84, h: 56, left: null, right: -26, top: -18, period: 84, dx: -5, dy: 6, s: 1, o0: 0.75, o1: 1,
      c: [[74, 194, 204, 0.10], [26, 102, 122, 0.06], [0, 0, 0, 0], [0, 0, 0, 0]],
      p: [0, 0.45, 0.88, 1] },
    { w: 96, h: 50, left: 8, top: null, bottom: -28, period: 104, dx: 4, dy: -3, s: 1.1, o0: 0.7, o1: 1,
      c: [[38, 128, 138, 0.085], [14, 58, 72, 0.05], [0, 0, 0, 0], [0, 0, 0, 0]],
      p: [0, 0.5, 0.90, 1] }
  ];

  /* ----------------------------------------------------------------- state */

  var quality = 1.0;
  var sizeVersion = 0;
  var state = {
    perfAcc: 0, perfN: 0,
    time: 0,
    depth: root.dataset.ocean === 'twilight' ? 1 : 0,
    last: 0, raf: null, w: 0, h: 0, vw: 0, vh: 0
  };
  function targetDepth() { return root.dataset.ocean === 'twilight' ? 1 : 0; }
  function resize() {
    var dpr = Math.min(window.devicePixelRatio || 1, 1.75) * quality;
    var vw = canvas.clientWidth, vh = canvas.clientHeight;
    var w = Math.max(1, Math.round(vw * dpr));
    var h = Math.max(1, Math.round(vh * dpr));
    var cssChanged = vw !== state.vw || vh !== state.vh;
    state.dpr = dpr;
    state.vw = vw;
    state.vh = vh;
    if (w === state.w && h === state.h && !cssChanged) return false;
    if (w !== state.w || h !== state.h) {
      state.w = canvas.width = w;
      state.h = canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
    sizeVersion++;
    coverDirty = true;
    if (cssChanged) capturedDepth = -1;
    return true;
  }

  /* Screen-space rects the water can skip. Only populated once the frost
     capture exists, because that is what makes the panels opaque enough that
     the water underneath is never seen. Inset by the panel radius so the
     rounded corners (which really do show the water) still render. */
  var COVER_MAX = 8;
  var coverRects = new Float32Array(COVER_MAX * 4);
  var coverCount = 0;
  var coverDirty = true;
  var coverVersion = 0;
  var coverNodes = document.querySelectorAll('.card, .import-viz, .pager__link, .depth-toggle');
  /* How many coverRects apply to the frame currently being built. */
  var frameCoverN = 0;
  /* Depth the current --ocean-frost was captured at. */
  var capturedDepth = -1;
  function updateCover() {
    if (!coverDirty) return;
    coverDirty = false;
    coverVersion++;
    var n = 0;
    if (root.dataset.frost === '1') {
      var vw = state.vw, vh = state.vh;
      var nodes = coverNodes;
      for (var i = 0; i < nodes.length && n < COVER_MAX; i++) {
        var el = nodes[i];
        var r = el.getBoundingClientRect();
        if (r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) continue;
        /* Inset by the corner radius so the rounded corners (which really do
           show the water) stay shaded. A pill's radius is half its height, so
           its rect collapses and it drops out rather than leaving a disc of
           missing water. */
        var rad = parseFloat(getComputedStyle(el).borderTopLeftRadius);
        /* Leave room for the card's 2px hover lift without remeasuring its
           animated transform each frame. */
        var pad = Math.min((isFinite(rad) ? rad : 0) + 2, r.width / 2, r.height / 2);
        var x0 = Math.max(0, r.left + pad), y0 = Math.max(0, r.top + pad);
        var x1 = Math.min(vw, r.right - pad), y1 = Math.min(vh, r.bottom - pad);
        if (x1 <= x0 || y1 <= y0) continue;
        coverRects[n * 4] = x0; coverRects[n * 4 + 1] = y0;
        coverRects[n * 4 + 2] = x1; coverRects[n * 4 + 3] = y1;
        n++;
      }
    }
    coverCount = n;
  }

  function bind(prog, u) {
    gl.useProgram(prog);
    if (u.sizeVersion !== sizeVersion) {
      if (u.uRes) gl.uniform2f(u.uRes, state.w, state.h);
      if (u.uCss) gl.uniform2f(u.uCss, state.vw, state.vh);
      u.sizeVersion = sizeVersion;
    }
    if (u.uCover && (u.coverVersion !== coverVersion || u.coverN !== frameCoverN)) {
      if (frameCoverN) gl.uniform4fv(u.uCover, coverRects);
      gl.uniform1i(u.uCoverN, frameCoverN);
      u.coverVersion = coverVersion;
      u.coverN = frameCoverN;
    }
  }
  function fullscreen(u) {
    gl.bindVertexArray(u.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  var blendMode = -1;
  function screenBlend(on) {
    var mode = on ? 1 : 0;
    if (blendMode === mode) return;
    if (on) {
      if (blendMode !== 2) gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_COLOR);
    } else gl.disable(gl.BLEND);
    blendMode = mode;
  }
  function overBlend() {
    if (blendMode === 2) return;
    if (blendMode !== 1) gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    blendMode = 2;
  }

  /* Rasterize only the CSS bounds that can contribute to this layer. */
  function clipTo(x0, y0, x1, y1) {
    var sx = state.w / state.vw, sy = state.h / state.vh;
    var left = Math.max(0, Math.floor(x0 * sx));
    var right = Math.min(state.w, Math.ceil(x1 * sx));
    var top = Math.max(0, Math.floor(y0 * sy));
    var bottom = Math.min(state.h, Math.ceil(y1 * sy));
    if (right <= left || bottom <= top) return false;
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(left, state.h - bottom, right - left, bottom - top);
    return true;
  }

  var layerMatrix = new Float32Array(9);

  /* Draw one textured layer (caustics / rays / columns / snow). */
  function drawLayer(program, u, texture, inv, offset, opacity, clip, mask) {
    var bottom = clip[3];
    if (mask.v[3] === 0) {
      bottom = Math.min(bottom, mask.rect[1] + mask.p[3] * (mask.rect[3] - mask.rect[1]));
    }
    if (!clipTo(clip[0], clip[1], clip[2], bottom)) return;
    bind(program, u);
    gl.uniform1f(u.uOpacity, opacity);
    for (var row = 0; row < 3; row++) {
      for (var col = 0; col < 3; col++) layerMatrix[col * 3 + row] = inv[row * 3 + col];
    }
    gl.uniformMatrix3fv(u.uInv, false, layerMatrix);
    gl.uniform2f(u.uOffset, offset[0], offset[1]);
    gl.uniform4f(u.uClip, clip[0], clip[1], clip[2], clip[3]);
    gl.uniform4f(u.uMaskP, mask.p[0], mask.p[1], mask.p[2], mask.p[3]);
    gl.uniform4f(u.uMaskV, mask.v[0], mask.v[1], mask.v[2], mask.v[3]);
    gl.uniform4f(u.uMaskRect, mask.rect[0], mask.rect[1], mask.rect[2], mask.rect[3]);
    gl.uniform1f(u.uUseH, mask.h ? 1 : 0);
    if (mask.h) {
      gl.uniform4f(u.uMaskHP, mask.h.p[0], mask.h.p[1], mask.h.p[2], mask.h.p[3]);
      gl.uniform4f(u.uMaskHV, mask.h.v[0], mask.h.v[1], mask.h.v[2], mask.h.v[3]);
      gl.uniform4f(u.uMaskHRect, mask.h.rect[0], mask.h.rect[1], mask.h.rect[2], mask.h.rect[3]);
    }
    gl.bindTexture(gl.TEXTURE_2D, texture);
    screenBlend(true);
    fullscreen(u);
    gl.disable(gl.SCISSOR_TEST);
  }

  /* ------------------------------------------------------------------ draw */

  function draw() {
    if (!state.w || !state.h || gl.isContextLost()) return;
    /* While the depth is crossfading the panels go back to a live
       backdrop-filter. It tracks the water exactly, where a capture would
       always be a frame behind and then snap once it settled. As soon as the
       crossfade ends we take one capture and hand them the static copy again.
       Both the live and the capturing frame need the water drawn everywhere, so
       the cover sits those out too. */
    var live = state.depth !== targetDepth();
    /* Also capture when the attribute is missing: bouncing between themes can
       settle back on a depth that was already captured, and the depth check
       alone would then leave the panels live forever. */
    var needCapture = !live && (capturedDepth !== state.depth || !root.hasAttribute('data-frost'));
    if (live && root.hasAttribute('data-frost')) root.removeAttribute('data-frost');
    if (!live && !needCapture) updateCover();
    frameCoverN = (live || needCapture) ? 0 : coverCount;
    var t = state.time;
    var vw = state.vw, vh = state.vh;
    var depth = state.depth;
    if (depth > 0.002) ensureCaustics();

    /* Base water (opaque). */
    bind(P.water, U.water);
    screenBlend(false);
    gl.uniform1f(U.water.uDepth, depth);
    fullscreen(U.water);

    /* ---- Caustics (twilight) ---- */
    if (depth > 0.002) {
      var cw = 1.30 * vw, ch = 0.58 * vh;
      var cl = -0.15 * vw, ct = -0.06 * vh;
      var causticRect = [cl, ct, cl + cw, ct + ch];
      var causticMask = { p: [0, 0.16, 0.40, 0.72], v: [0.4, 1, 0.5, 0], rect: causticRect };
      for (var i = 0; i < sheets.length; i++) {
        var s = sheets[i];
        if (s.sizeVersion !== sizeVersion) {
          s.uv = planeUV2Matrix({
            ox: cl + 0.5 * cw, oy: ct + ch, pox: cl + 0.62 * cw, poy: ct + ch,
            d: 300, rx: s.tilt, rz: 0, tx: 0, ty: 0, zsign: 1,
            sx0: cl - 0.5 * cw, sy0: ct - 1.6 * ch
          }, s.tile);
          s.sizeVersion = sizeVersion;
        }
        var p = seg(t, s.period);
        /* translate3d runs before rotateX, so the sampled offset is -translate. */
        var off = [-s.drift[0] * p, -s.drift[1] * p];
        drawLayer(P.layer, U.layer, tex[s.tex], s.uv, off, 0.13 * s.op * depth, causticRect, causticMask);
      }
    }

    /* ---- Rays (twilight) ---- */
    if (depth > 0.002) {
      var raysMask = {
        p: [0, 0.20, 0.48, 0.78], v: [0.9, 0.75, 0.34, 0], rect: [0, 0, vw, vh],
        h: { p: [0, 0.24, 0.82, 1.0], v: [0, 1, 1, 0], rect: [0, 0, vw, vh] }
      };
      for (var r = 0; r < planes.length; r++) {
        var pl = planes[r];
        var pw = 2.2 * vw;
        var phase = seg(t, pl.period);
        var pspec = {
          ox: 0.5 * vw, oy: 0, pox: 0.62 * vw, poy: 0, d: 460,
          rx: pl.rx * DEG, rz: key2(phase, pl.rz0, pl.rz1, pl.rz0) * DEG,
          tx: key2(phase, pl.tx0, pl.tx1, pl.tx0) / 100 * pw, ty: 0, zsign: 1,
          sx0: -0.6 * vw, sy0: 0
        };
        var puv = planeUVMatrix(pspec, pl.prof.period);
        var opacity = key2(phase, pl.o0, pl.o1, pl.o2) * depth;
        drawLayer(P.layer, U.layer, tex[pl.tex], puv, [0, 0], opacity, [0, 0, vw, vh], raysMask);
      }
    }

    /* ---- Columns (open) ---- */
    if (depth < 0.998) {
      var ccl = -0.10 * vw, cct = -0.05 * vh, ccw = 1.20 * vw, cch = 1.10 * vh;
      var colRect = [ccl, cct, ccl + ccw, cct + cch];
      var colMask = { p: [0, 0.38, 0.68, 0.92], v: [1, 0.72, 0.28, 0], rect: colRect };
      for (var c = 0; c < cols.length; c++) {
        var cd = cols[c];
        var prog = seg(t, cd.period);
        var tx = key2(prog, cd.tx0, cd.tx1, cd.tx2) / 100 * ccw;
        var sx = key2(prog, cd.s0, cd.s1, cd.s2);
        var op = key2(prog, cd.o0, cd.o1, cd.o2);
        /* screen -> local (element) then along the gradient axis */
        var cx = ccw / 2, cy = cch / 2;
        var ang = cd.def.angle * DEG;
        var sinA = Math.sin(ang), cosA = Math.cos(ang);
        var L = Math.abs(ccw * sinA) + Math.abs(cch * cosA);
        var k = -(cx * sinA - cy * cosA) + L / 2;
        /* p = (post - c - (tx,0))/sx + c ; post = sp - (ccl,cct) */
        var a11 = 1 / sx, a13 = cx - (cx + tx) / sx;
        /* p.x = a11*(sp.x - ccl) + a13 ; p.y = sp.y - cct */
        var m = [
          (a11 * sinA) / cd.def.period,
          (-cosA) / cd.def.period,
          (sinA * (a13 - a11 * ccl) + cosA * cct + k) / cd.def.period,
          0, 0, 0.5,
          0, 0, 1
        ];
        drawLayer(P.layer, U.layer, tex[cd.tex], m, [0, 0], 0.72 * op * (1 - depth), colRect, colMask);
      }
    }

    /* ---- Blooms (both depths) ---- */
    var vmax = Math.max(vw, vh);
    for (var b = 0; b < blooms.length; b++) {
      var bl = blooms[b];
      var bw = bl.w / 100 * vmax, bh = bl.h / 100 * vmax;
      var blx = (bl.left != null ? bl.left / 100 * vmax : vw - bw - (-bl.right / 100 * vmax));
      var bty = (bl.top != null ? bl.top / 100 * vmax : vh - bh - (-bl.bottom / 100 * vmax));
      var prog2 = seg(t, bl.period);
      var cx2 = blx + bw / 2 + key2(prog2, 0, bl.dx / 100 * vmax, 0);
      var cy2 = bty + bh / 2 + key2(prog2, 0, bl.dy / 100 * vmax, 0);
      var sc = key2(prog2, 1, bl.s, 1);
      var op2 = key2(prog2, bl.o0, bl.o1, bl.o0);
      var brx = bw / 2 * sc, bry = bh / 2 * sc;
      /* Beyond the last radial stop the bloom is fully transparent. */
      if (!clipTo(cx2 - brx * bl.p[3], cy2 - bry * bl.p[3],
                  cx2 + brx * bl.p[3], cy2 + bry * bl.p[3])) continue;
      bind(P.bloom, U.bloom);
      gl.uniform2f(U.bloom.uC, cx2, cy2);
      gl.uniform2f(U.bloom.uR, bw / 2 * sc, bh / 2 * sc);
      gl.uniform4f(U.bloom.uP, bl.p[0], bl.p[1], bl.p[2], bl.p[3]);
      for (var ci = 0; ci < 4; ci++) {
        var col = bl.c[ci];
        gl.uniform4f(U.bloom['uC' + ci], col[0] / 255, col[1] / 255, col[2] / 255, col[3]);
      }
      gl.uniform1f(U.bloom.uOpacity, op2);
      screenBlend(true);
      fullscreen(U.bloom);
      gl.disable(gl.SCISSOR_TEST);
    }

    /* ---- Marine snow (both depths) ---- */
    bind(P.snow, U.snow);
    gl.uniform1f(U.snow.uTime, t);
    gl.uniform1f(U.snow.uDpr, state.dpr || 1);
    gl.bindVertexArray(U.snow.vao);
    screenBlend(true);
    gl.drawArrays(gl.POINTS, 0, snowCount);

    /* ---- Haze (both) ---- */
    bind(P.haze, U.haze);
    gl.uniform1f(U.haze.uDepth, depth);
    gl.uniform1f(U.haze.uOpacity, 0.875 - 0.125 * Math.cos(2 * Math.PI * t / 47));
    screenBlend(true);
    fullscreen(U.haze);

    /* ---- Vignette (both) ---- */
    bind(P.vignette, U.vignette);
    gl.uniform1f(U.vignette.uDepth, depth);
    overBlend();
    fullscreen(U.vignette);

    /* ---- Grain (both) ---- */
    bind(P.grain, U.grain);
    /* Twelve fresh patterns per second, with no loop back to six old offsets.
       Reduced motion holds time at zero, so its grain remains still. */
    gl.uniform1ui(U.grain.uSeed, Math.floor(t * 12) >>> 0);
    gl.uniform1f(U.grain.uOpacity, 0.14);
    overBlend();
    fullscreen(U.grain);

    if (needCapture) captureFrost();
  }

  /* The translucent text panels would otherwise run a live backdrop-filter,
     re-blurring the animating water every single frame. Instead grab one
     heavily downsampled frame (scaling it back up is the blur) and expose it
     as --ocean-frost, so the panels can paint a static, viewport-anchored copy
     of the water for free. Re-taken once each time the depth settles. */
  var frostCanvas = document.createElement('canvas');
  var frostContext = frostCanvas.getContext('2d');
  function captureFrost() {
    var w = 160;
    var h = Math.max(1, Math.round(w * state.h / state.w));
    frostCanvas.width = w; frostCanvas.height = h;
    frostContext.drawImage(canvas, 0, 0, w, h);
    try {
      root.style.setProperty('--ocean-frost', 'url("' + frostCanvas.toDataURL('image/jpeg', 0.82) + '")');
      root.dataset.frost = '1';
      coverDirty = true;
      capturedDepth = state.depth;
    } catch (e) {}
  }

  function render() { draw(); }

  function frame(now) {
    state.raf = null;
    var interval = (now - state.last) / 1000;
    var dt = Math.min(interval, 0.05);
    state.last = now;
    state.time += dt;
    var target = targetDepth();
    state.depth += (target - state.depth) * Math.min(1, dt * 4.0);
    if (Math.abs(target - state.depth) < 0.002) state.depth = target;
    draw();

    /* Keep resolution only as high as the GPU can carry: if the shader is
       consistently heavier than ~40fps, step the render scale down once. */
    state.perfAcc += interval; state.perfN++;
    if (state.perfN >= 60) {
      var avg = state.perfAcc / state.perfN;
      if (avg > 0.025 && quality > 0.6) {
        quality = Math.max(0.6, quality - 0.2);
        resize();
      }
      state.perfAcc = 0; state.perfN = 0;
    }

    if (reduceMotion || document.hidden) return;
    state.raf = requestAnimationFrame(frame);
  }
  function start() {
    if (state.raf !== null || reduceMotion || document.hidden) return;
    state.last = performance.now();
    state.raf = requestAnimationFrame(frame);
  }
  function stop() { if (state.raf !== null) { cancelAnimationFrame(state.raf); state.raf = null; } }

  window.addEventListener('resize', function () { if (resize()) render(); }, { passive: true });
  var coverRaf = null;
  function invalidateCover() {
    coverDirty = true;
    /* Reduced motion still needs a fresh frame when scrolling exposes water
       that was previously hidden behind a captured panel. */
    if (!reduceMotion || document.hidden || coverRaf !== null) return;
    coverRaf = requestAnimationFrame(function () { coverRaf = null; render(); });
  }
  window.addEventListener('scroll', invalidateCover, { passive: true });
  if ('ResizeObserver' in window) {
    var coverObserver = new ResizeObserver(invalidateCover);
    coverNodes.forEach(function (node) { coverObserver.observe(node); });
    coverObserver.observe(document.body);
  }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stop();
    else if (reduceMotion) render();
    else start();
  });
  canvas.addEventListener('webglcontextlost', function (e) { e.preventDefault(); stop(); });
  canvas.addEventListener('webglcontextrestored', function () { resize(); render(); start(); });

  resize();
  render();
  if (reduceMotion) {
    if (window.MutationObserver) {
      /* There is no animation loop to settle a crossfade, so jump straight to
         the new depth and let draw() re-capture for the panels. */
      new MutationObserver(function () { state.depth = targetDepth(); render(); })
        .observe(root, { attributes: true, attributeFilter: ['data-ocean'] });
    }
  } else {
    start();
  }
})();

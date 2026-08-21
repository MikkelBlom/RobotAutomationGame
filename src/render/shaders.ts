/** GLSL for the passes that are not plain sprites. */

export const FULLSCREEN_VERT = `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  // Oversized triangle covering the viewport; no vertex buffer needed.
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

/**
 * Final composite. Scene albedo is multiplied by accumulated light, then
 * graded. Everything that makes noon read as noon and 02:00 read as 02:00
 * happens here and in the light buffer — never in the bake.
 */
export const COMPOSITE_FRAG = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uAlbedo;
uniform sampler2D uLight;
uniform vec3  uGradeTint;
uniform float uGradeStrength;
uniform float uSaturation;
uniform float uGrain;
uniform float uVignette;
uniform float uTime;
uniform vec2  uResolution;
uniform float uExposure;

/**
 * Integer-style hash. The usual fract(sin(dot(...)) * large) version loses
 * precision and lays down a visible diagonal weave across the whole frame —
 * worst at night, where the grain is heaviest. This one has no such structure.
 */
float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec3 albedo = texture(uAlbedo, vUv).rgb;
  vec3 light  = texture(uLight,  vUv).rgb;

  vec3 col = albedo * light * uExposure;

  // Linear through the midtones, soft knee only where lamp cores would clip.
  // A full Reinhard here washed the whole hall out.
  col = col / (1.0 + max(col - vec3(0.78), vec3(0.0)));

  float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(luma), col, uSaturation);
  col = mix(col, luma * uGradeTint * 2.0, uGradeStrength * 0.5);

  vec2 d = vUv - 0.5;
  float vig = 1.0 - smoothstep(0.22, 0.86, length(d) * 1.32);
  col *= mix(1.0, vig, uVignette);

  float g = hash(gl_FragCoord.xy + vec2(uTime * 61.0, uTime * 37.0));
  col += (g - 0.5) * uGrain * 0.72;

  outColor = vec4(max(col, vec3(0.0)), 1.0);
}
`;

export const WATER_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;
uniform mat3 uView;
out vec2 vWorld;
void main() {
  vWorld = aPos;
  vec3 clip = uView * vec3(aPos, 1.0);
  gl_Position = vec4(clip.xy, 0.0, 1.0);
}
`;

/**
 * Water surface. Reads a distance field of the basin so foam, edge shadowing
 * and depth all follow the real, notched shoreline rather than a rectangle.
 */
export const WATER_FRAG = `#version 300 es
precision highp float;

in vec2 vWorld;
out vec4 outColor;

uniform sampler2D uSdf;      // R = edge distance / 96, G = edge distance / 620
uniform sampler2D uNoise;    // four octaves of tileable value noise
uniform vec2  uSdfOrigin;
uniform vec2  uSdfSize;
uniform float uTime;
uniform vec3  uDeepColor;
uniform vec3  uShallowColor;
uniform vec3  uFoamColor;
uniform vec3  uSpecColor;
uniform float uSpecStrength;
uniform float uWaveStrength;
uniform float uMouthX;      // where the channel meets open water

/**
 * A swell rolling in from the mouth, returned as a SIGNED ridge: negative in
 * the trough ahead of it, positive on the crest behind. Feeding that into the
 * surface height gives a real moving ridge of light and shade. Returning a
 * positive bump instead just painted a white band across the water.
 */
float swellRidge(float travel, float t, float period, float offset, float range, float width) {
  float phase = fract((t + offset) / period);
  // Start three widths before the mouth and finish well past the far wall, so
  // the front has decayed to nothing at both ends of the cycle. Wrapping while
  // the front was still inside the pool made the swell visibly reset.
  float pos = -width * 3.0 + phase * range;
  float d = travel - pos;
  float e = exp(-(d * d) / (2.0 * width * width));
  return -(d / width) * e * 1.6487;  // sqrt(e): normalises the peak to about 1
}

void main() {
  vec2 sdfUv = (vWorld - uSdfOrigin) / uSdfSize;
  vec4 sdf = texture(uSdf, sdfUv);
  float dNear  = sdf.r * 340.0;
  float dBroad = sdf.g * 2400.0;
  float t = uTime;

  // --- surface height ---------------------------------------------------
  // Crossed directional waves, sampled through a slowly drifting domain warp.
  // Straight sine interference settles into visible diagonal stripes; warping
  // the sample position first destroys any repeat without adding cost.
  // Wavelengths are real: 9 m down to 1.5 m.
  vec2 warp = vec2(
    texture(uNoise, vWorld * 0.00048 + vec2(t * 0.006, 0.0)).r,
    texture(uNoise, vWorld * 0.00048 + vec2(0.0, t * 0.005)).g
  ) - 0.5;
  vec2 wp = vWorld + warp * 170.0;

  // All directions have a positive x component and use "- t * w", so the chop
  // drifts INTO the hall rather than appearing to drain out of the mouth.
  float chop = 0.0;
  chop += sin(dot(wp, vec2(0.92,  0.39)) * 0.0070 - t * 1.05) * 0.52;
  chop += sin(dot(wp, vec2(0.86, -0.51)) * 0.0105 - t * 1.37) * 0.26;
  chop += sin(dot(wp, vec2(0.71,  0.71)) * 0.0165 - t * 1.81) * 0.15;
  chop += sin(dot(wp, vec2(0.99,  0.16)) * 0.0262 - t * 2.24) * 0.09;
  chop += sin(dot(wp, vec2(0.80, -0.60)) * 0.0419 - t * 2.90) * 0.05;

  // Wave energy is not uniform across a basin.
  float amp = 0.55 + 0.45 * texture(uNoise, vWorld * 0.00032 + vec2(t * 0.004, 0.0)).b;
  chop *= amp * uWaveStrength;
  // Chop dies away in the shallows against the concrete.
  chop *= mix(0.30, 1.0, smoothstep(0.0, 340.0, dNear));

  // --- swell rolling in from the mouth -----------------------------------
  float travel = vWorld.x - uMouthX;
  // Each front is skewed and bowed rather than a straight line across the
  // basin: the sea outside does not arrive as a ruler edge.
  float skewA = vWorld.y * 0.17 + sin(vWorld.y * 0.0016 + t * 0.21) * 320.0;
  float skewB = vWorld.y * -0.11 + sin(vWorld.y * 0.0011 - t * 0.17) * 420.0;
  float skewC = sin(vWorld.y * 0.0007 + t * 0.13) * 560.0;

  float surgeWave = (
      swellRidge(travel + skewA, t,  9.0,  0.0,  9800.0,  520.0) * 1.00
    + swellRidge(travel + skewB, t, 14.0,  3.7, 11200.0,  760.0) * 0.70
    + swellRidge(travel + skewC, t, 23.0, 11.3, 13000.0, 1100.0) * 0.50
  ) * 0.48;

  // Reflection: the far end of the dock throws part of the swell back, so the
  // pool keeps moving between sets instead of going dead flat.
  float back = (2.0 * 6100.0) - travel;
  float rebound = (
      swellRidge(back, t,  9.0,  0.0,  9800.0,  620.0) * 0.55
    + swellRidge(back, t, 14.0,  3.7, 11200.0,  880.0) * 0.38
  ) * 0.48;

  surgeWave = surgeWave * exp(-travel / 7000.0) + rebound * 0.42;
  surgeWave *= uWaveStrength;

  // Enclosed water sits fairly flat between sets, but never dead: there is
  // always some slop moving around a basin this size.
  chop *= 0.42 + 0.72 * max(0.0, surgeWave);
  float h = chop + surgeWave * 1.6;

  // --- interaction with the dock wall ------------------------------------
  float surge = sin(t * 0.9 - dNear * 0.014 + h * 1.2);
  float shore = (1.0 - smoothstep(0.0, 280.0, dNear));
  float shoreline = shore * surge;

  // --- body -------------------------------------------------------------
  float depthT = smoothstep(40.0, 1900.0, dBroad);
  vec3 base = mix(uShallowColor, uDeepColor, depthT);
  base *= 1.0 + h * 0.19 + shoreline * 0.11;

  // Thin bright lines riding the wave tops.
  float crest = smoothstep(0.86, 1.14, h);
  base += uSpecColor * crest * 0.10 * uSpecStrength;

  // Sparkle: sharp peaks thinned by noise so it stays sparse rather than
  // turning into uniform speckle.
  float sparkleMask = texture(uNoise, vWorld * 0.00024 + vec2(t * 0.004, -t * 0.003)).a;
  float peak = pow(max(h, 0.0), 6.0);
  float sparkle = peak * smoothstep(0.66, 0.92, sparkleMask);
  base += uSpecColor * sparkle * 0.75 * uSpecStrength;

  // --- foam against the concrete ---------------------------------------
  float band = 70.0 + shoreline * 40.0;
  float foam = 1.0 - smoothstep(band * 0.10, band, dNear);
  float tearA = texture(uNoise, vWorld * 0.00024 + vec2(t * 0.004, t * 0.003)).b;
  float tearB = texture(uNoise, vWorld * 0.00013 - vec2(t * 0.006, t * 0.002)).a;
  float tearC = texture(uNoise, vWorld * 0.00048 + vec2(t * 0.008, -t * 0.005)).g;
  float tear = tearA * 0.45 + tearB * 0.35 + tearC * 0.30;
  foam *= smoothstep(0.30, 0.78, tear);

  // Outer spray: sparse flecks thrown further in than the main band.
  float sprayMask = 1.0 - smoothstep(band, band * 2.3, dNear);
  float spray = sprayMask * smoothstep(0.74, 0.93, tearC * 0.7 + tearB * 0.5)
              * max(0.0, surge) * 0.7;

  // Only the very top of the ridge caps, as a thin lip.
  float crestFoam = smoothstep(0.74, 0.97, surgeWave)
                  * smoothstep(0.34, 0.74, tearA * 0.65 + tearB * 0.55) * 0.30;
  // Where that swell actually meets concrete, it breaks properly.
  crestFoam += smoothstep(0.42, 0.86, surgeWave) * shore * 0.55;

  // A persistent wet line right where the water meets the concrete.
  float wetline = (1.0 - smoothstep(0.0, 18.0, dNear)) * 0.38;
  foam = clamp(foam * 0.62 + spray * 0.5 + wetline + crestFoam, 0.0, 1.0);

  // --- shadow the quay throws onto the water ----------------------------
  float shade = mix(0.38, 1.0, smoothstep(0.0, 230.0, dNear));

  vec3 col = base * shade;
  col = mix(col, uFoamColor, foam);

  // The channel runs out under the wall to open water. Rather than show
  // anything beyond the shell, fade it to black.
  float outside = 1.0 - smoothstep(uMouthX + 20.0, uMouthX + 190.0, vWorld.x);
  col = mix(col, vec3(0.0), outside * 0.86);

  outColor = vec4(col, 1.0);
}
`;

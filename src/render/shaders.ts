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

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
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
  col += (g - 0.5) * uGrain;

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
  float dNear  = sdf.r * 96.0;
  float dBroad = sdf.g * 620.0;
  float t = uTime;

  // --- surface height ---------------------------------------------------
  // Crossed directional waves, sampled through a slowly drifting domain warp.
  // Straight sine interference settles into visible diagonal stripes; warping
  // the sample position first destroys any repeat without adding cost.
  vec2 warp = vec2(
    texture(uNoise, vWorld * 0.0018 + vec2(t * 0.006, 0.0)).r,
    texture(uNoise, vWorld * 0.0018 + vec2(0.0, t * 0.005)).g
  ) - 0.5;
  vec2 wp = vWorld + warp * 46.0;

  // Weighted strongly towards one direction: enclosed water has a dominant
  // swell with chop riding on it. Even amplitudes gave a cellular, camouflage
  // look rather than a surface.
  // All directions have a positive x component and use "- t * w", so the chop
  // drifts INTO the hall. The previous signs sent every wave back out of the
  // dock mouth, which read as the whole pool draining.
  float chop = 0.0;
  chop += sin(dot(wp, vec2(0.92,  0.39)) * 0.048 - t * 1.05) * 0.62;
  chop += sin(dot(wp, vec2(0.86, -0.51)) * 0.071 - t * 1.37) * 0.24;
  chop += sin(dot(wp, vec2(0.71,  0.71)) * 0.113 - t * 1.81) * 0.12;
  chop += sin(dot(wp, vec2(0.99,  0.16)) * 0.167 - t * 2.24) * 0.07;
  chop += sin(dot(wp, vec2(0.80, -0.60)) * 0.241 - t * 2.90) * 0.04;

  // Wave energy is not uniform across a basin.
  float amp = 0.55 + 0.45 * texture(uNoise, vWorld * 0.0012 + vec2(t * 0.004, 0.0)).b;
  chop *= amp * uWaveStrength;
  // Chop dies away in the shallows against the concrete.
  chop *= mix(0.30, 1.0, smoothstep(0.0, 95.0, dNear));

  // --- swell rolling in from the mouth -----------------------------------
  float travel = vWorld.x - uMouthX;
  // Normalised to roughly 0..1 at the peak so the foam thresholds below mean
  // something; unnormalised these stacked to ~2.3 and blew the crest out into
  // a field of white static.
  float surgeWave = (
      swellRidge(travel, t,  9.0,  0.0, 2600.0, 150.0) * 1.00
    + swellRidge(travel, t, 14.0,  3.7, 2960.0, 210.0) * 0.70
    + swellRidge(travel, t, 23.0, 11.3, 3500.0, 300.0) * 0.50
  ) * 0.48;
  // Swell loses its energy as it runs up the dock.
  surgeWave *= exp(-travel / 1900.0) * uWaveStrength;

  // Enclosed water sits nearly flat; the chop rides on the passing swell
  // rather than covering the whole pool all the time.
  chop *= 0.26 + 0.90 * max(0.0, surgeWave);
  float h = chop + surgeWave * 1.6;

  // --- interaction with the dock wall ------------------------------------
  // Swell piling into the edge and drawing back out again. This is what makes
  // the basin feel connected to its walls rather than pasted over them.
  float surge = sin(t * 0.9 - dNear * 0.05 + h * 1.2);
  float shore = (1.0 - smoothstep(0.0, 75.0, dNear));
  float shoreline = shore * surge;

  // --- body -------------------------------------------------------------
  float depthT = smoothstep(10.0, 540.0, dBroad);
  vec3 base = mix(uShallowColor, uDeepColor, depthT);
  base *= 1.0 + h * 0.19 + shoreline * 0.11;

  // Thin bright lines riding the wave tops.
  float crest = smoothstep(0.86, 1.14, h);
  base += uSpecColor * crest * 0.10 * uSpecStrength;

  // Sparkle: sharp peaks thinned by noise so it stays sparse rather than
  // turning into uniform speckle.
  float sparkleMask = texture(uNoise, vWorld * 0.0009 + vec2(t * 0.004, -t * 0.003)).a;
  float peak = pow(max(h, 0.0), 6.0);
  float sparkle = peak * smoothstep(0.66, 0.92, sparkleMask);
  base += uSpecColor * sparkle * 0.75 * uSpecStrength;

  // --- foam against the concrete ---------------------------------------
  // Band width is driven by the surge, so the waterline advances and retreats
  // instead of sitting behind a static outline. Wide and heavily torn: a thin
  // even band just reads as a drawn border.
  float band = 19.0 + shoreline * 11.0;
  float foam = 1.0 - smoothstep(band * 0.10, band, dNear);
  float tearA = texture(uNoise, vWorld * 0.0009 + vec2(t * 0.004, t * 0.003)).b;
  float tearB = texture(uNoise, vWorld * 0.0005 - vec2(t * 0.006, t * 0.002)).a;
  float tearC = texture(uNoise, vWorld * 0.0018 + vec2(t * 0.008, -t * 0.005)).g;
  float tear = tearA * 0.45 + tearB * 0.35 + tearC * 0.30;
  foam *= smoothstep(0.30, 0.78, tear);

  // Outer spray: sparse flecks thrown further in than the main band.
  float sprayMask = 1.0 - smoothstep(band, band * 2.3, dNear);
  float spray = sprayMask * smoothstep(0.74, 0.93, tearC * 0.7 + tearB * 0.5)
              * max(0.0, surge) * 0.7;

  // Foam carried on the crest of an incoming swell — out in open water, not
  // just along the edge. Broken up at swell scale rather than by the fine
  // noise, which turned it into speckle.
  // Only the very top of the ridge caps, as a thin lip.
  float crestFoam = smoothstep(0.74, 0.97, surgeWave)
                  * smoothstep(0.34, 0.74, tearA * 0.65 + tearB * 0.55) * 0.30;
  // Where that swell actually meets concrete, it breaks properly.
  crestFoam += smoothstep(0.42, 0.86, surgeWave) * shore * 0.55;

  // A persistent wet line right where the water meets the concrete.
  float wetline = (1.0 - smoothstep(0.0, 5.0, dNear)) * 0.38;
  foam = clamp(foam * 0.62 + spray * 0.5 + wetline + crestFoam, 0.0, 1.0);

  // --- shadow the quay throws onto the water ----------------------------
  float shade = mix(0.38, 1.0, smoothstep(0.0, 62.0, dNear));

  vec3 col = base * shade;
  col = mix(col, uFoamColor, foam);

  // The channel runs out under the wall to open water. Rather than show
  // anything beyond the shell, fade it to black.
  float outside = 1.0 - smoothstep(uMouthX + 6.0, uMouthX + 84.0, vWorld.x);
  col = mix(col, vec3(0.0), outside * 0.86);

  outColor = vec4(col, 1.0);
}
`;

/**
 * Terrain shading. Colors come straight from the colormap; lighting is calibrated so a face
 * pointing up is lit exactly 1.0 — the top view / heatmap shows the colormap faithfully, while
 * side faces and slopes get soft key + fill shading in 3D (no tone mapping).
 */
import * as THREE from 'three';
import { ColormapType } from '../../types';
import { colormapGlsl, divergingGlsl } from '../../colormaps';

const vertex = /* glsl */ `
attribute float aValue;
uniform float uInvScaleY;
varying float vValue;
varying vec3 vNormalW;
varying vec3 vPosW;
#ifdef USE_INSTANCING
attribute float aCapped;
attribute float aFade;
varying float vCapped;
varying float vFade;
#endif
void main() {
  vValue = aValue;
  vec4 local = vec4(position, 1.0);
  #ifdef USE_INSTANCING
    local = instanceMatrix * local;
    vCapped = aCapped;
    vFade = aFade;
  #endif
  vec4 world = modelMatrix * local;
  vPosW = world.xyz;
  // Model = translation + scale(1, s, 1): normals transform by the inverse scale.
  vNormalW = normalize(normal * vec3(1.0, uInvScaleY, 1.0));
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const fragment = (cmap: string) => /* glsl */ `
uniform float uColorScale;
uniform float uOpacity;
uniform float uLighting;
uniform float uSpec;
uniform float uCap;
uniform float uHatch;
uniform float uDim;
uniform vec3 uCamPos;
uniform vec3 uFadeColor;
varying float vValue;
varying vec3 vNormalW;
varying vec3 vPosW;
#ifdef USE_INSTANCING
varying float vCapped;
varying float vFade;
#endif
${cmap}
void main() {
  vec3 base = cmap(vValue * uColorScale);
  vec3 N = normalize(vNormalW);
  if (!gl_FrontFacing) N = -N;
  vec3 Lk = normalize(vec3(0.35, 1.0, 0.5));
  vec3 Lf = normalize(vec3(-0.75, 0.55, -0.4));
  float key = max(dot(N, Lk), 0.0);
  float fill = max(dot(N, Lf), 0.0);
  // Calibrated: N = up -> 0.40 + 0.47 + 0.13 = 1.0
  float light = 0.40 + key * (0.47 / Lk.y) + fill * (0.13 / Lf.y);
  light = min(light, 1.04);
  vec3 col = base * mix(1.0, light, uLighting) * uDim;
  // Subtle sheen in 3D only (uSpec fades to 0 when flattened, keeping the heatmap faithful).
  vec3 V = normalize(uCamPos - vPosW);
  vec3 Hh = normalize(Lk + V);
  float spec = pow(max(dot(N, Hh), 0.0), 48.0) * uSpec * uLighting;
  col += vec3(spec * 0.12);
  // Capped heights: fine diagonal hatch on the plateau / capped bar tops only — never on walls or
  // bar sides (vertical faces would turn it into a dense "barcode"). Anti-aliased, low contrast.
  #ifdef USE_INSTANCING
    float capped = vCapped;
  #else
    float capped = step(uCap - 1e-4, abs(vValue));
  #endif
  capped *= smoothstep(0.55, 0.8, N.y);
  if (capped > 0.001 && uHatch > 0.0) {
    float s = (vPosW.x + vPosW.z) * 4.0;
    float d = abs(fract(s) - 0.5);
    float aa = max(fwidth(s), 1e-4);
    float stripe = 1.0 - smoothstep(0.19 - aa, 0.19 + aa, d);
    col = mix(col, col * 0.55 + vec3(0.06), stripe * capped * uHatch * 0.35);
  }
  #ifdef USE_INSTANCING
    // Intro fade-in: a bar's color comes up from the plate tone (opaque, so depth stays correct).
    col = mix(uFadeColor, col, vFade);
  #endif
  gl_FragColor = vec4(col, uOpacity);
  #include <colorspace_fragment>
}
`;

export interface TerrainUniforms {
  [k: string]: THREE.IUniform;
  uColorScale: THREE.IUniform<number>;
  uOpacity: THREE.IUniform<number>;
  uLighting: THREE.IUniform<number>;
  uSpec: THREE.IUniform<number>;
  uCap: THREE.IUniform<number>;
  uHatch: THREE.IUniform<number>;
  uDim: THREE.IUniform<number>;
  uInvScaleY: THREE.IUniform<number>;
  uCamPos: THREE.IUniform<THREE.Vector3>;
  uFadeColor: THREE.IUniform<THREE.Color>;
}

/** Base plate tone under the terrain (also the color a bar fades in from). */
export const PLATE_COLOR = '#10151d';

export type ColorSpec = { kind: 'svm'; colormap: ColormapType } | { kind: 'diff' };

export function cmapGlsl(spec: ColorSpec): string {
  return spec.kind === 'diff' ? divergingGlsl('cmap') : colormapGlsl(spec.colormap, 'cmap');
}

export function makeTerrainMaterial(spec: ColorSpec, dim = 1): THREE.ShaderMaterial & { uniforms: TerrainUniforms } {
  const uniforms: TerrainUniforms = {
    uColorScale: { value: 1 },
    uOpacity: { value: 1 },
    uLighting: { value: 1 },
    uSpec: { value: 1 },
    uCap: { value: 6 },
    uHatch: { value: 0 },
    uDim: { value: dim },
    uInvScaleY: { value: 1 },
    uCamPos: { value: new THREE.Vector3() },
    uFadeColor: { value: new THREE.Color(PLATE_COLOR) },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: vertex,
    fragmentShader: fragment(cmapGlsl(spec)),
    transparent: true,
    depthWrite: true,
    side: THREE.FrontSide,
  });
  return mat as THREE.ShaderMaterial & { uniforms: TerrainUniforms };
}

export function setTerrainColormap(mat: THREE.ShaderMaterial, spec: ColorSpec) {
  mat.fragmentShader = fragment(cmapGlsl(spec));
  mat.needsUpdate = true;
}

/**
 * "No data" floor of missing cells (docs/adr/0012): thin neutral 45° lines on a dark plate, in
 * world space so it stays attached to the plot while the camera moves. It runs the opposite way
 * to the capped-height hatch and has no color, so the two never read alike. `uSpacing` is set to
 * a few CSS px of the top-view fit; lines are anti-aliased with fwidth.
 */
export type NoDataMaterial = THREE.ShaderMaterial & {
  uniforms: { uOpacity: THREE.IUniform<number>; uSpacing: THREE.IUniform<number>; uPx: THREE.IUniform<number> };
};

export function makeNoDataMaterial(): NoDataMaterial {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uOpacity: { value: 1 },
      uSpacing: { value: 0.1 },
      uPx: { value: 1 },
      uBase: { value: new THREE.Color('#0d1117') },
      uLine: { value: new THREE.Color('#2e3645') },
    },
    vertexShader: /* glsl */ `
      varying vec2 vXZ;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vXZ = w.xz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uOpacity;
      uniform float uSpacing;
      uniform float uPx;
      uniform vec3 uBase;
      uniform vec3 uLine;
      varying vec2 vXZ;
      void main() {
        float s = (vXZ.x - vXZ.y) / (uSpacing * 1.41421356);
        float d = abs(fract(s) - 0.5) * 2.0; // 0 at a line center, 1 halfway between lines
        float w = max(fwidth(s), 1e-4) * 2.0; // one device px in the same units
        float line = 1.0 - smoothstep(w * 0.5 * uPx, w * (0.5 * uPx + 1.0), d);
        // Lines fade out when they would be denser than ~4 CSS px (zoomed far out): no moire.
        line *= 1.0 - smoothstep(0.45, 0.8, w * uPx);
        gl_FragColor = vec4(mix(uBase, uLine, line), uOpacity);
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: true,
  });
  return mat as NoDataMaterial;
}

/** Soft radial floor under the terrain (3D only). */
export function makeFloorMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uOpacity: { value: 1 }, uColor: { value: new THREE.Color('#0f141c') }, uRadius: { value: 20 }, uCenter: { value: new THREE.Vector2() } },
    vertexShader: /* glsl */ `
      varying vec2 vXZ;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vXZ = w.xz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uOpacity;
      uniform vec3 uColor;
      uniform float uRadius;
      uniform vec2 uCenter;
      varying vec2 vXZ;
      void main() {
        float d = length(vXZ - uCenter) / uRadius;
        float a = (1.0 - smoothstep(0.35, 1.0, d)) * 0.9 * uOpacity;
        gl_FragColor = vec4(uColor, a);
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
  });
}

export type InterpMaterial = THREE.ShaderMaterial & {
  uniforms: { uOpacity: { value: number }; uPx: { value: number }; uColor: { value: THREE.Color }; uCasing: { value: THREE.Color } };
};

/**
 * Marker of cells the denoise filled by interpolation (docs/adr/0012 addendum): a small hollow
 * ring at the cell's sample point (top view) — the same "hollow = interpolated" mark as the 2D
 * chart's points — light with a faint dark casing so it reads on light and dark cells alike,
 * without covering the cell's color. Quads carry a local 0..1 coordinate (aUv); sizes are in
 * device px via fwidth. Cells too small for the ring show nothing.
 */
export function makeInterpMaterial(): InterpMaterial {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uOpacity: { value: 1 },
      uPx: { value: 1 },
      uColor: { value: new THREE.Color('#f4f7fb') },
      uCasing: { value: new THREE.Color('#0b0e14') },
    },
    vertexShader: /* glsl */ `
      attribute vec2 aUv;
      varying vec2 vUv;
      void main() {
        vUv = aUv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uOpacity;
      uniform float uPx;
      uniform vec3 uColor;
      uniform vec3 uCasing;
      varying vec2 vUv;
      void main() {
        vec2 fw = max(fwidth(vUv), vec2(1e-6));
        vec2 size = 1.0 / fw;                  // cell size in device px
        if (min(size.x, size.y) < 11.0 * uPx) discard;
        float d = length((vUv - 0.5) * size);  // device px from the sample point
        float R = 3.4 * uPx;
        float hw = 0.6 * uPx;
        float ring = 1.0 - smoothstep(hw, hw + 1.0, abs(d - R));
        float cas = (1.0 - smoothstep(hw + 1.1 * uPx, hw + 1.1 * uPx + 1.0, abs(d - R))) * step(R, d) * 0.45;
        float a = max(ring, cas);
        if (a < 0.01) discard;
        gl_FragColor = vec4(mix(uCasing, uColor, ring / max(a, 1e-4)), a * uOpacity);
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  return mat as InterpMaterial;
}

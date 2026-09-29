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
varying float vCapped;
#endif
void main() {
  vValue = aValue;
  vec4 local = vec4(position, 1.0);
  #ifdef USE_INSTANCING
    local = instanceMatrix * local;
    vCapped = aCapped;
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
varying float vValue;
varying vec3 vNormalW;
varying vec3 vPosW;
#ifdef USE_INSTANCING
varying float vCapped;
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
  // Capped heights: fine diagonal hatch on the plateau / capped bar tops.
  float capped = step(uCap, abs(vValue));
  #ifdef USE_INSTANCING
    capped = vCapped * step(0.5, N.y);
  #endif
  if (capped > 0.5 && uHatch > 0.0) {
    float stripe = step(0.62, fract((vPosW.x + vPosW.z) * 4.0));
    col = mix(col, col * 0.55 + vec3(0.06), stripe * uHatch * 0.7);
  }
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
}

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

/** Soft radial floor under the terrain (3D only). */
export function makeFloorMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uOpacity: { value: 1 }, uColor: { value: new THREE.Color('#0f141c') }, uRadius: { value: 20 } },
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
      varying vec2 vXZ;
      void main() {
        float d = length(vXZ) / uRadius;
        float a = (1.0 - smoothstep(0.35, 1.0, d)) * 0.9 * uOpacity;
        gl_FragColor = vec4(uColor, a);
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
  });
}

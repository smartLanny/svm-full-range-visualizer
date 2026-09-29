/**
 * Camera poses. One parameterisation covers perspective and orthographic views so that every
 * preset change is a continuous interpolation (docs/adr/0002):
 *
 *   orientation = Ry(theta) · Rx(phi − π/2)   (theta 0 = from the front, phi 0 = straight down)
 *   h           = visible world height at the target
 *   persp       = tan(fov / 2); 0 = orthographic
 *
 * A perspective → orthographic move narrows the FOV while dollying out (framing kept by h), so
 * parallax fades out and the final swap to the orthographic camera is invisible.
 */
import * as THREE from 'three';

export interface CamPose {
  target: THREE.Vector3;
  theta: number;
  phi: number;
  h: number;
  persp: number;
}

export const PERSP_FOV_DEG = 30;
export const PERSP_TAN = Math.tan(THREE.MathUtils.degToRad(PERSP_FOV_DEG / 2));
/** Narrowest perspective used just before swapping to orthographic (parallax < 0.1%). */
export const PERSP_MIN = 0.0004;

export const clonePose = (p: CamPose): CamPose => ({ target: p.target.clone(), theta: p.theta, phi: p.phi, h: p.h, persp: p.persp });

const _e = new THREE.Euler();
const _q = new THREE.Quaternion();

export function poseQuaternion(theta: number, phi: number, out = new THREE.Quaternion()) {
  _e.set(phi - Math.PI / 2, theta, 0, 'YXZ');
  return out.setFromEuler(_e);
}

/** Camera basis vectors (right, up, back = −forward). */
export function poseBasis(theta: number, phi: number) {
  poseQuaternion(theta, phi, _q);
  return {
    right: new THREE.Vector3(1, 0, 0).applyQuaternion(_q),
    up: new THREE.Vector3(0, 1, 0).applyQuaternion(_q),
    back: new THREE.Vector3(0, 0, 1).applyQuaternion(_q),
  };
}

export interface Viewport {
  /** Drawing-buffer pixels. */
  width: number;
  height: number;
}

/** Scene radius around the target used for near / far planes. */
export function applyPose(
  pose: CamPose,
  vp: Viewport,
  persp: THREE.PerspectiveCamera,
  ortho: THREE.OrthographicCamera,
  sceneRadius: number,
): THREE.Camera {
  const aspect = Math.max(1e-3, vp.width / Math.max(1, vp.height));
  const q = poseQuaternion(pose.theta, pose.phi, _q);
  const back = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
  const R = Math.max(1, sceneRadius);
  if (pose.persp > 1e-7) {
    const d = pose.h / (2 * pose.persp);
    persp.fov = THREE.MathUtils.radToDeg(2 * Math.atan(pose.persp));
    persp.aspect = aspect;
    persp.position.copy(pose.target).addScaledVector(back, d);
    persp.quaternion.copy(q);
    persp.near = Math.max(0.05, d - R * 1.6);
    persp.far = d + R * 1.6;
    persp.updateProjectionMatrix();
    persp.updateMatrixWorld(true);
    return persp;
  }
  const D = R * 3;
  ortho.left = (-pose.h * aspect) / 2;
  ortho.right = (pose.h * aspect) / 2;
  ortho.top = pose.h / 2;
  ortho.bottom = -pose.h / 2;
  ortho.zoom = 1;
  ortho.position.copy(pose.target).addScaledVector(back, D);
  ortho.quaternion.copy(q);
  ortho.near = 0.05;
  ortho.far = D + R * 1.6;
  ortho.updateProjectionMatrix();
  ortho.updateMatrixWorld(true);
  return ortho;
}

const wrapAngle = (a: number) => {
  let x = a;
  while (x > Math.PI) x -= Math.PI * 2;
  while (x < -Math.PI) x += Math.PI * 2;
  return x;
};

/**
 * Interpolate two poses (u in 0..1, already eased). Orthographic ends are reached through a
 * narrowing perspective; the orthographic pose is returned only at u = 1 (or 0).
 */
export function lerpPose(a: CamPose, b: CamPose, u: number, out?: CamPose): CamPose {
  const o = out ?? clonePose(a);
  if (u <= 0) return copyPose(a, o);
  if (u >= 1) return copyPose(b, o);
  o.target.lerpVectors(a.target, b.target, u);
  o.theta = a.theta + wrapAngle(b.theta - a.theta) * u;
  o.phi = a.phi + (b.phi - a.phi) * u;
  o.h = Math.exp(Math.log(a.h) + (Math.log(b.h) - Math.log(a.h)) * u);
  const pa = a.persp > 0 ? a.persp : PERSP_MIN;
  const pb = b.persp > 0 ? b.persp : PERSP_MIN;
  if (a.persp <= 0 && b.persp <= 0) o.persp = 0;
  else o.persp = pa + (pb - pa) * u;
  return o;
}

export function copyPose(src: CamPose, dst: CamPose): CamPose {
  dst.target.copy(src.target);
  dst.theta = src.theta;
  dst.phi = src.phi;
  dst.h = src.h;
  dst.persp = src.persp;
  return dst;
}

/** Pixel insets of the "safe" area the content must fit into. */
export interface Insets {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * Fit a set of world points into the viewport's safe rect for a given orientation / projection.
 * Returns the pose (target + h) with that orientation.
 */
export function fitPose(points: THREE.Vector3[], theta: number, phi: number, persp: number, vp: Viewport, insets: Insets): CamPose {
  const W = Math.max(2, vp.width);
  const H = Math.max(2, vp.height);
  const sw = Math.max(20, W - insets.left - insets.right);
  const sh = Math.max(20, H - insets.top - insets.bottom);
  // Safe-rect center offset from viewport center (px, y up).
  const ox = (insets.left - insets.right) / 2;
  const oy = (insets.bottom - insets.top) / 2;
  const { right, up, back } = poseBasis(theta, phi);
  const center = new THREE.Vector3();
  for (const p of points) center.add(p);
  center.multiplyScalar(1 / Math.max(1, points.length));

  if (persp <= 0) {
    let minR = Infinity;
    let maxR = -Infinity;
    let minU = Infinity;
    let maxU = -Infinity;
    for (const p of points) {
      const r = p.dot(right);
      const u = p.dot(up);
      minR = Math.min(minR, r);
      maxR = Math.max(maxR, r);
      minU = Math.min(minU, u);
      maxU = Math.max(maxU, u);
    }
    const s = Math.max((maxR - minR) / sw, (maxU - minU) / sh, 1e-6);
    const tR = (minR + maxR) / 2 - ox * s;
    const tU = (minU + maxU) / 2 - oy * s;
    const tB = center.dot(back);
    const target = new THREE.Vector3().addScaledVector(right, tR).addScaledVector(up, tU).addScaledVector(back, tB);
    return { target, theta, phi, h: H * s, persp: 0 };
  }

  // Perspective: iterate distance (extent fit) and lateral target shift (centering).
  const aspect = W / H;
  const target = center.clone();
  let d = 10;
  const project = (p: THREE.Vector3, tgt: THREE.Vector3, dist: number) => {
    const rel = p.clone().sub(tgt);
    const zc = dist - rel.dot(back); // distance along the view direction
    const x = rel.dot(right) / (zc * persp * aspect); // NDC
    const y = rel.dot(up) / (zc * persp);
    return { x: (x * W) / 2, y: (y * H) / 2, zc };
  };
  const extents = (tgt: THREE.Vector3, dist: number) => {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let ok = true;
    for (const p of points) {
      const pr = project(p, tgt, dist);
      if (pr.zc <= 0.05) ok = false;
      minX = Math.min(minX, pr.x);
      maxX = Math.max(maxX, pr.x);
      minY = Math.min(minY, pr.y);
      maxY = Math.max(maxY, pr.y);
    }
    return { minX, maxX, minY, maxY, ok };
  };
  for (let iter = 0; iter < 5; iter++) {
    let lo = 0.1;
    let hi = 1e6;
    for (let k = 0; k < 50; k++) {
      const mid = Math.sqrt(lo * hi);
      const e = extents(target, mid);
      if (e.ok && e.maxX - e.minX <= sw && e.maxY - e.minY <= sh) hi = mid;
      else lo = mid;
    }
    d = hi;
    const e = extents(target, d);
    const cx = (e.minX + e.maxX) / 2;
    const cy = (e.minY + e.maxY) / 2;
    // World per pixel at the target plane.
    const wpp = (2 * d * persp) / H;
    target.addScaledVector(right, (cx - ox) * wpp).addScaledVector(up, (cy - oy) * wpp);
  }
  return { target, theta, phi, h: 2 * d * persp, persp };
}

/** World units per drawing-buffer pixel at the target for a pose. */
export const worldPerPixel = (pose: CamPose, vp: Viewport) => pose.h / Math.max(1, vp.height);

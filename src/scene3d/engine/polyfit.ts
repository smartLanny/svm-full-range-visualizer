/**
 * Least-squares polynomial curve through samples: a smooth (C∞) stand-in for a quantity that is
 * only sampled, or only piecewise smooth — e.g. the camera framing along the intro crane, whose
 * exact fit has kinks where the limiting corner of the terrain box changes. A camera driven along
 * it by a smooth easing never changes speed or direction abruptly (docs/adr/0003).
 */
export class PolyCurve {
  /** Coefficients in the normalised variable s = (x − x0) / (x1 − x0), lowest order first. */
  private readonly coef: Float64Array;

  constructor(
    private readonly x0: number,
    private readonly x1: number,
    xs: ArrayLike<number>,
    ys: ArrayLike<number>,
    degree: number,
  ) {
    const n = Math.min(xs.length, ys.length);
    const d = Math.max(0, Math.min(degree, n - 1));
    const k = d + 1;
    // Normal equations A c = b (k ≤ ~8, samples well spread over [0, 1]: well conditioned).
    const A = Array.from({ length: k }, () => new Float64Array(k + 1));
    const pw = new Float64Array(2 * k);
    for (let i = 0; i < n; i++) {
      const s = this.norm(xs[i]);
      pw[0] = 1;
      for (let j = 1; j < 2 * k; j++) pw[j] = pw[j - 1] * s;
      for (let r = 0; r < k; r++) {
        for (let c = 0; c < k; c++) A[r][c] += pw[r + c];
        A[r][k] += pw[r] * ys[i];
      }
    }
    // Gauss-Jordan with partial pivoting.
    for (let c = 0; c < k; c++) {
      let p = c;
      for (let r = c + 1; r < k; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
      [A[c], A[p]] = [A[p], A[c]];
      const piv = A[c][c] || 1e-12;
      for (let j = c; j <= k; j++) A[c][j] /= piv;
      for (let r = 0; r < k; r++) {
        if (r === c) continue;
        const f = A[r][c];
        if (f !== 0) for (let j = c; j <= k; j++) A[r][j] -= f * A[c][j];
      }
    }
    this.coef = Float64Array.from(A, (row) => row[k]);
  }

  private norm(x: number) {
    return (x - this.x0) / (this.x1 - this.x0 || 1);
  }

  /** Value at x (the polynomial is evaluated as is; callers stay within [x0, x1]). */
  at(x: number): number {
    const s = this.norm(x);
    let v = 0;
    for (let j = this.coef.length - 1; j >= 0; j--) v = v * s + this.coef[j];
    return v;
  }
}

import { ARENA, GOAL_PROFILE } from './rl';
import { TUNING } from './tuning';

/** Axis-aligned box (optionally rotated about Y): half extents and centre. */
export interface Box {
  hx: number;
  hy: number;
  hz: number;
  x: number;
  y: number;
  z: number;
  yaw?: number;
}

export interface ArenaGeometry {
  /** Triangle mesh for the wall shell: ramps, walls, blended corners, back walls with goal mouths. Normals point into the arena. */
  vertices: Float32Array;
  indices: Uint32Array;
  /** Triangle mesh of both goal chambers (side netting, quarter-pipe back, sloped roof, lintel). Normals point into the chamber. */
  goalVertices: Float32Array;
  goalIndices: Uint32Array;
  floorBox: Box;
  ceilingBox: Box;
  /** Solid slabs outside each goal chamber (behind the back curve, outside the netting, above the roof). */
  goalBoxes: Box[];
  /** Solid slabs behind every flat wall section so nothing can tunnel out through the thin shell. */
  backstopBoxes: Box[];
}

export function allColliderBoxes(a: ArenaGeometry): Box[] {
  return [a.floorBox, a.ceilingBox, ...a.goalBoxes, ...a.backstopBoxes];
}

type P2 = [number, number]; // [x, z]

/**
 * Builds the standard soccar arena analytically, fitted to measurements of the real collision
 * mesh (see TUNING.arena*). Y is up. The long axis is Z (RL's y). Blue's goal is at -Z, orange's at +Z.
 *
 * Outline (viewed from above): back walls at z = ±extentY, side walls at x = ±extentX, flat 45°
 * corner walls on |x| + |z| = cornerPlane, blended into the back and side walls by circular arcs.
 * Each outline edge carries its own floor-ramp radius; the ceiling curve is shared.
 */
export function buildArenaGeometry(): ArenaGeometry {
  const W2 = ARENA.extentX;
  const L2 = ARENA.extentY;
  const H = ARENA.height;
  const gw = ARENA.goalHalfWidth;
  const gh = ARENA.goalHeight;
  const gd = ARENA.goalDepth;
  const rSide = TUNING.arenaSideRampRadius;
  const rBack = TUNING.arenaBackRampRadius;
  const rCeil = TUNING.arenaCeilingRadius;
  const N = TUNING.rampSegments;
  const t = TUNING.wallThickness;

  // ---- Outline with blended corners --------------------------------------------------
  // Corner of back wall (z = L2) and diagonal (x + z = cornerPlane) lies at (cornerPlane - L2, L2);
  // corner of diagonal and side wall (x = W2) at (W2, cornerPlane - W2). A fillet of radius R
  // between two lines meeting at 45° has tangent points R * tan(22.5°) from the corner.
  const tan225 = Math.tan(Math.PI / 8);
  const rB = TUNING.arenaCornerBlendBack;
  const rS = TUNING.arenaCornerBlendSide;
  const dB = rB * tan225;
  const dS = rS * tan225;
  const cornerBackX = ARENA.cornerPlane - L2; // x where back wall meets the diagonal
  const cornerSideZ = ARENA.cornerPlane - W2; // z where the diagonal meets the side wall
  const diag = Math.SQRT1_2;
  const blendSegs = TUNING.cornerBlendSegments;

  /** Points of a fillet arc from tangent point A to tangent point B around centre C (inclusive of both ends). */
  const arc = (a: P2, b: P2, c: P2): P2[] => {
    const a0 = Math.atan2(a[1] - c[1], a[0] - c[0]);
    let a1 = Math.atan2(b[1] - c[1], b[0] - c[0]);
    while (a1 - a0 > Math.PI) a1 -= 2 * Math.PI;
    while (a1 - a0 < -Math.PI) a1 += 2 * Math.PI;
    const r = Math.hypot(a[0] - c[0], a[1] - c[1]);
    const pts: P2[] = [];
    for (let i = 0; i <= blendSegs; i++) {
      const ang = a0 + ((a1 - a0) * i) / blendSegs;
      pts.push([c[0] + r * Math.cos(ang), c[1] + r * Math.sin(ang)]);
    }
    return pts;
  };

  /**
   * The corner of one quadrant, from the side-wall tangent point to the back-wall tangent point:
   * side blend arc, the flat 45° wall, back blend arc. Built in the (+x, +z) frame and mirrored.
   */
  const sideTangentZ = cornerSideZ - dS;
  const cornerPath = (sx: number, sz: number): P2[] => {
    const p0: P2 = [W2, sideTangentZ];
    const p1: P2 = [W2 - dS * diag, cornerSideZ + dS * diag];
    const sideCentre: P2 = [W2 - rS, sideTangentZ];
    const p2: P2 = [cornerBackX + dB * diag, L2 - dB * diag];
    const p3: P2 = [cornerBackX - dB, L2];
    const backCentre: P2 = [cornerBackX - dB, L2 - rB];
    const pts = [...arc(p0, p1, sideCentre), ...arc(p2, p3, backCentre)];
    return pts.map(([x, z]) => [sx * x, sz * z] as P2);
  };

  // Full outline, same orientation as before: up the +x side wall, along the +z back wall toward -x,
  // down the -x side wall, along the -z back wall toward +x. Straight edges (back walls, side walls)
  // are implied between consecutive corner paths, so each back wall is ONE edge spanning the goal.
  const outline: P2[] = [
    ...cornerPath(1, 1), // (+x side) → (+z back)
    ...cornerPath(-1, 1).reverse(), // (+z back) → (-x side)
    ...cornerPath(-1, -1), // (-x side) → (-z back)
    ...cornerPath(1, -1).reverse(), // (-z back) → (+x side), closes to the start
  ];

  const E = outline.length;
  // An edge is a back wall edge iff both endpoints sit on z = ±L2.
  const isBackEdge: boolean[] = [];
  for (let i = 0; i < E; i++) {
    const a = outline[i];
    const b = outline[(i + 1) % E];
    isBackEdge.push(Math.abs(Math.abs(a[1]) - L2) < 1e-6 && Math.abs(Math.abs(b[1]) - L2) < 1e-6);
  }

  // Inward unit normal of each edge i (from outline[i] to outline[i+1]).
  const normals: P2[] = outline.map((a, i) => {
    const b = outline[(i + 1) % E];
    let nx = -(b[1] - a[1]);
    let nz = b[0] - a[0];
    const len = Math.hypot(nx, nz);
    nx /= len;
    nz /= len;
    if (nx * -a[0] + nz * -a[1] < 0) {
      nx = -nx;
      nz = -nz;
    }
    return [nx, nz];
  });
  const edgeRamp = (i: number) => (isBackEdge[i] ? rBack : rSide);
  /** Floor ramp inset of a circular ramp of radius r at height y. */
  const rampInset = (r: number, y: number) => (y >= r ? 0 : r - Math.sqrt(Math.max(0, r * r - (r - y) * (r - y))));
  const ceilInset = (y: number) => {
    const yy = H - y;
    return yy >= rCeil ? 0 : rCeil - Math.sqrt(Math.max(0, rCeil * rCeil - (rCeil - yy) * (rCeil - yy)));
  };
  const edgeInset = (i: number, y: number) => rampInset(edgeRamp(i), y) + ceilInset(y);

  /** Vertex i of the outline inset per edge at height y: intersection of the two offset edge lines. */
  const insetVertex = (i: number, y: number): P2 => {
    const ePrev = (i - 1 + E) % E;
    const [n1x, n1z] = normals[ePrev];
    const [n2x, n2z] = normals[i];
    const a1 = outline[ePrev];
    const a2 = outline[i];
    const c1 = n1x * a1[0] + n1z * a1[1] + edgeInset(ePrev, y);
    const c2 = n2x * a2[0] + n2z * a2[1] + edgeInset(i, y);
    const det = n1x * n2z - n1z * n2x;
    if (Math.abs(det) < 1e-9) {
      // Collinear neighbours: offset the vertex along the shared normal.
      return [a2[0] + n2x * edgeInset(i, y), a2[1] + n2z * edgeInset(i, y)];
    }
    return [(c1 * n2z - c2 * n1z) / det, (n1x * c2 - n2x * c1) / det];
  };

  /** Ring at height y: inset outline, with back-wall edges split at the goal posts. */
  const ringPoints = (y: number): { pts: P2[]; mouth: boolean[] } => {
    const pts: P2[] = [];
    const mouth: boolean[] = [];
    for (let i = 0; i < E; i++) {
      const v = insetVertex(i, y);
      pts.push(v);
      if (isBackEdge[i]) {
        const a = outline[i];
        const b = outline[(i + 1) % E];
        const z = Math.sign(a[1]) * (L2 - edgeInset(i, y));
        // Only the edge that spans the goal mouth gets split.
        const lo = Math.min(a[0], b[0]);
        const hi = Math.max(a[0], b[0]);
        if (lo < -gw + 1e-6 && hi > gw - 1e-6) {
          const dir = Math.sign(b[0] - a[0]);
          mouth.push(false);
          pts.push([-dir * gw, z]);
          mouth.push(true);
          pts.push([dir * gw, z]);
          mouth.push(false);
          continue;
        }
      }
      mouth.push(false);
    }
    return { pts, mouth };
  };

  // Ring heights: floor ramp samples (dense enough for the 256 ramp), goal top, ceiling curve samples.
  const rings: number[] = [];
  const rMax = Math.max(rSide, rBack);
  for (let k = 0; k <= N; k++) rings.push(rMax * (1 - Math.cos((k / N) * (Math.PI / 2))));
  if (rBack < rMax) rings.push(rBack);
  rings.push(gh);
  const ceilN = TUNING.ceilingSegments;
  for (let k = 0; k <= ceilN; k++) rings.push(H - rCeil + rCeil * Math.sin((k / ceilN) * (Math.PI / 2)));
  rings.sort((a, b) => a - b);
  const uniqueRings = rings.filter((y, i) => i === 0 || y - rings[i - 1] > 1e-6);

  const verts: number[] = [];
  const idx: number[] = [];
  const addVert = (x: number, y: number, z: number): number => {
    verts.push(x, y, z);
    return verts.length / 3 - 1;
  };

  const ringIdx: number[][] = [];
  let mouthFlags: boolean[] = [];
  for (const y of uniqueRings) {
    const { pts, mouth } = ringPoints(y);
    mouthFlags = mouth;
    ringIdx.push(pts.map(([x, z]) => addVert(x, y, z)));
  }
  const S = ringIdx[0].length;

  // Wall bands between consecutive rings. Winding gives normals pointing INTO the arena.
  for (let k = 0; k < uniqueRings.length - 1; k++) {
    const below = ringIdx[k];
    const above = ringIdx[k + 1];
    const bandTop = uniqueRings[k + 1];
    for (let j = 0; j < S; j++) {
      if (mouthFlags[j] && bandTop <= gh + 1e-6) continue; // open goal mouth
      const j1 = (j + 1) % S;
      idx.push(below[j], above[j1], above[j]);
      idx.push(below[j], below[j1], above[j1]);
    }
  }

  // Goal post caps: close the open end of each back-wall floor ramp at the posts.
  const rampRings = uniqueRings.filter((y) => y <= rBack + 1e-6);
  for (const s of [-1, 1]) {
    for (const sx of [-1, 1]) {
      const corner = addVert(sx * gw, 0, s * L2);
      const profile = rampRings.map((y) => addVert(sx * gw, y, s * (L2 - rampInset(rBack, y))));
      const inward = -sx;
      for (let k = 0; k < profile.length - 1; k++) {
        if (inward > 0) idx.push(corner, profile[k + 1], profile[k]);
        else idx.push(corner, profile[k], profile[k + 1]);
      }
    }
  }

  const floorBox: Box = { hx: W2 + t, hy: t / 2, hz: L2 + gd + t, x: 0, y: -t / 2, z: 0 };
  const ceilingBox: Box = { hx: W2 + t, hy: t / 2, hz: L2 + t, x: 0, y: H + t / 2, z: 0 };

  // ---- Goal chambers ---------------------------------------------------------------
  // Profile in (depth behind the mouth, height): floor → quarter-pipe back curling forward →
  // sloped roof → flat lintel underside → mouth. Extruded across the goal width with side caps.
  const G = GOAL_PROFILE;
  const profile: P2[] = []; // [depth, height]
  profile.push([0, 0]);
  profile.push([G.backCurveCentreDepth, 0]);
  const arcSteps = 10;
  for (let k = 1; k <= arcSteps; k++) {
    const ang = -Math.PI / 2 + ((Math.PI / 2 + G.backCurveEndAngle) * k) / arcSteps;
    profile.push([G.backCurveCentreDepth + G.backCurveRadius * Math.cos(ang), G.backCurveCentreHeight + G.backCurveRadius * Math.sin(ang)]);
  }
  profile.push([G.roofFrontDepth, G.roofFrontHeight]);
  profile.push([0, gh]);
  const P = profile.length;

  const gVerts: number[] = [];
  const gIdx: number[] = [];
  const gAdd = (x: number, y: number, z: number): number => {
    gVerts.push(x, y, z);
    return gVerts.length / 3 - 1;
  };
  for (const s of [-1, 1]) {
    // Two rails of the profile at x = -gw and x = +gw.
    const rail = (x: number) => profile.map(([d, h]) => gAdd(x, h, s * (L2 + d)));
    const left = rail(-gw);
    const right = rail(gw);
    // Extruded surface between the rails (skip the first segment: that is the floor, handled by the floor box).
    for (let k = 1; k < P - 1; k++) {
      // Winding chosen so the normal points into the chamber (checked below and flipped if needed).
      gIdx.push(left[k], right[k], right[k + 1]);
      gIdx.push(left[k], right[k + 1], left[k + 1]);
    }
    // Side caps: fan from the profile centroid.
    for (const [x, railIdx] of [
      [-gw, left],
      [gw, right],
    ] as [number, number[]][]) {
      let cd = 0;
      let ch = 0;
      for (const [d, h] of profile) {
        cd += d;
        ch += h;
      }
      const centre = gAdd(x, ch / P, s * (L2 + cd / P));
      for (let k = 0; k < P; k++) {
        const a = railIdx[k];
        const b = railIdx[(k + 1) % P];
        gIdx.push(centre, a, b);
      }
    }
  }
  // Orient every triangle so its normal faces the chamber interior (a point on the chamber axis).
  for (let i = 0; i < gIdx.length; i += 3) {
    const ia = gIdx[i];
    const ib = gIdx[i + 1];
    const ic = gIdx[i + 2];
    const ax = gVerts[ia * 3];
    const ay = gVerts[ia * 3 + 1];
    const az = gVerts[ia * 3 + 2];
    const ux = gVerts[ib * 3] - ax;
    const uy = gVerts[ib * 3 + 1] - ay;
    const uz = gVerts[ib * 3 + 2] - az;
    const vx = gVerts[ic * 3] - ax;
    const vy = gVerts[ic * 3 + 1] - ay;
    const vz = gVerts[ic * 3 + 2] - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const s = Math.sign(az);
    const cx = 0;
    const cy = gh / 2;
    const cz = s * (L2 + gd * 0.45);
    if (nx * (cx - ax) + ny * (cy - ay) + nz * (cz - az) < 0) {
      gIdx[i + 1] = ic;
      gIdx[i + 2] = ib;
    }
  }

  // Slabs outside the chamber so nothing tunnels out through the thin netting.
  const goalBoxes: Box[] = [];
  for (const s of [-1, 1]) {
    const zc = s * (L2 + (gd + t) / 2);
    goalBoxes.push({ hx: gw + t, hy: gh / 2 + t, hz: t / 2, x: 0, y: gh / 2, z: s * (L2 + gd + t / 2) }); // behind the back curve
    goalBoxes.push({ hx: t / 2, hy: gh / 2 + t, hz: (gd + t) / 2, x: -(gw + t / 2), y: gh / 2, z: zc }); // outside left netting
    goalBoxes.push({ hx: t / 2, hy: gh / 2 + t, hz: (gd + t) / 2, x: gw + t / 2, y: gh / 2, z: zc }); // outside right netting
    goalBoxes.push({ hx: gw + t, hy: t / 2, hz: (gd + t) / 2, x: 0, y: gh + 0.02 + t / 2, z: zc }); // above the roof
  }

  // Backstops sit flush behind each wall plane; ramps and blends are inset from those planes so they never touch.
  const backstopBoxes: Box[] = [];
  const hy = H / 2 + t;
  const c = ARENA.cornerCut;
  backstopBoxes.push({ hx: t / 2, hy, hz: L2 - c + t, x: -(W2 + t / 2), y: H / 2, z: 0 });
  backstopBoxes.push({ hx: t / 2, hy, hz: L2 - c + t, x: W2 + t / 2, y: H / 2, z: 0 });
  for (const s of [-1, 1]) {
    const z = s * (L2 + t / 2);
    const sideHx = (W2 - c + t - gw) / 2;
    backstopBoxes.push({ hx: sideHx, hy, hz: t / 2, x: -(gw + sideHx), y: H / 2, z });
    backstopBoxes.push({ hx: sideHx, hy, hz: t / 2, x: gw + sideHx, y: H / 2, z });
    const aboveHy = (H - gh + t) / 2;
    backstopBoxes.push({ hx: gw, hy: aboveHy, hz: t / 2, x: 0, y: gh + aboveHy, z });
  }
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const nx = sx / Math.SQRT2;
      const nz = sz / Math.SQRT2;
      backstopBoxes.push({
        hx: c / Math.SQRT2 + t,
        hy,
        hz: t / 2,
        x: sx * (W2 - c / 2) + nx * (t / 2),
        y: H / 2,
        z: sz * (L2 - c / 2) + nz * (t / 2),
        yaw: Math.atan2(sx, sz),
      });
    }
  }

  return {
    vertices: new Float32Array(verts),
    indices: new Uint32Array(idx),
    goalVertices: new Float32Array(gVerts),
    goalIndices: new Uint32Array(gIdx),
    floorBox,
    ceilingBox,
    goalBoxes,
    backstopBoxes,
  };
}

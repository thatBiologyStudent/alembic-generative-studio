/**
 * Pose references: OpenPose skeletons from the 3D "Openpose Editor by Yu Zhu" scenes or classic OpenPose JSON,
 * drawn as ControlNet-style skeleton images and described in words.
 *
 * Keypoints use the 18-point OpenPose (COCO) order. Left/right are the character's own sides.
 * The 3D editor's default skeleton (bone hierarchy and rest offsets) is taken from its MIT-licensed source
 * (github.com/ZhUyU1997/open-pose-editor, src/body.ts); the maths here is our own.
 */

export const KEYPOINTS = [
  'nose',
  'neck',
  'right_shoulder',
  'right_elbow',
  'right_wrist',
  'left_shoulder',
  'left_elbow',
  'left_wrist',
  'right_hip',
  'right_knee',
  'right_ankle',
  'left_hip',
  'left_knee',
  'left_ankle',
  'right_eye',
  'left_eye',
  'right_ear',
  'left_ear',
] as const;

const K = Object.fromEntries(KEYPOINTS.map((k, i) => [k, i])) as Record<(typeof KEYPOINTS)[number], number>;

/** limbs as keypoint pairs, in the standard OpenPose drawing order (colours by index) */
const LIMBS: [number, number][] = [
  [1, 2], [1, 5], [2, 3], [3, 4], [5, 6], [6, 7], [1, 8], [8, 9], [9, 10], [1, 11], [11, 12], [12, 13], [0, 1], [0, 14], [14, 16], [0, 15], [15, 17],
];
const COLORS: [number, number, number][] = [
  [255, 0, 0], [255, 85, 0], [255, 170, 0], [255, 255, 0], [170, 255, 0], [85, 255, 0], [0, 255, 0], [0, 255, 85], [0, 255, 170],
  [0, 255, 255], [0, 170, 255], [0, 85, 255], [0, 0, 255], [85, 0, 255], [170, 0, 255], [255, 0, 255], [255, 0, 170], [255, 0, 85],
];

/** [x, y] in 0..1 of the frame (y down), or null when the joint is missing */
export type Pt = [number, number] | null;
export interface Pose {
  /** one array of 18 points per person */
  people: Pt[][];
  /** width / height of the frame the points are in */
  aspect: number;
  /** what the file was */
  source: string;
}

// ---------------------------------------------------------------- 3D editor scenes

type Vec3 = [number, number, number];
type Mat = number[]; // 4x4, row-major

const ident = (): Mat => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function mul(a: Mat, b: Mat): Mat {
  const o = new Array(16).fill(0);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) for (let k = 0; k < 4; k++) o[r * 4 + c] += a[r * 4 + k] * b[k * 4 + c];
  return o;
}
/** three.js Euler 'XYZ' rotation matrix (= Rx · Ry · Rz) */
function rot([x, y, z]: Vec3): Mat {
  const a = Math.cos(x), b = Math.sin(x), c = Math.cos(y), d = Math.sin(y), e = Math.cos(z), f = Math.sin(z);
  return [c * e, -c * f, d, 0, a * f + b * e * d, a * e - b * f * d, -b * c, 0, b * f - a * e * d, b * e + a * f * d, a * c, 0, 0, 0, 0, 1];
}
function trs(t: Vec3, r: Vec3, s: Vec3): Mat {
  const T = ident();
  T[3] = t[0];
  T[7] = t[1];
  T[11] = t[2];
  const S = ident();
  S[0] = s[0];
  S[5] = s[1];
  S[10] = s[2];
  return mul(mul(T, rot(r)), S);
}
const origin = (m: Mat): Vec3 => [m[3], m[7], m[11]];

// the editor's rest skeleton: name → [parent, rest position]
const W = 34, H = 46;
const TEMPLATE: Record<string, [string | null, Vec3]> = {
  torso: [null, [0, 115, 0]],
  five: ['torso', [0, H / 2, 0]],
  neck: ['five', [0, 0, 0]],
  nose: ['neck', [0, 20, 14]],
  right_eye: ['nose', [-3, 3, -3]],
  right_ear: ['right_eye', [-4, -3, -8]],
  left_eye: ['nose', [3, 3, -3]],
  left_ear: ['left_eye', [4, -3, -8]],
  right_shoulder_inner: ['five', [0, 0, 0]],
  right_shoulder: ['right_shoulder_inner', [-W / 2, 0, 0]],
  right_elbow: ['right_shoulder', [0, -25, 0]],
  right_wrist: ['right_elbow', [0, -25, 0]],
  left_shoulder_inner: ['five', [0, 0, 0]],
  left_shoulder: ['left_shoulder_inner', [W / 2, 0, 0]],
  left_elbow: ['left_shoulder', [0, -25, 0]],
  left_wrist: ['left_elbow', [0, -25, 0]],
  right_hip_inner: ['five', [0, 0, 0]],
  right_hip: ['right_hip_inner', [-W / 2 + 7, -H, 0]],
  right_knee: ['right_hip', [0, -40, 0]],
  right_ankle: ['right_knee', [0, -36, 0]],
  left_hip_inner: ['five', [0, 0, 0]],
  left_hip: ['left_hip_inner', [W / 2 - 7, -H, 0]],
  left_knee: ['left_hip', [0, -40, 0]],
  left_ankle: ['left_knee', [0, -36, 0]],
};

const v3 = (a: any, d: Vec3): Vec3 => (Array.isArray(a) && a.length >= 3 ? [+a[0], +a[1], +a[2]] : d);

/** World positions of the 18 keypoints of one body from the 3D editor. */
function bodyJoints(body: any): Record<string, Vec3> {
  const child = body.child ?? {};
  const world: Record<string, Mat> = {};
  const get = (name: string): Mat => {
    if (world[name]) return world[name];
    const [parent, rest] = TEMPLATE[name];
    const o = name === 'torso' ? body : child[name] ?? {};
    const local = trs(v3(o.position, rest), v3(o.rotation, [0, 0, 0]), v3(o.scale, [1, 1, 1]));
    return (world[name] = parent ? mul(get(parent), local) : local);
  };
  return Object.fromEntries(KEYPOINTS.map((k) => [k, origin(get(k))]));
}

/** Projects the scene through its camera (three.js PerspectiveCamera, 60° vertical field of view) into a frame of `aspect`. */
function parseEditorScene(j: any, aspect: number): Pose {
  const cam = j.object?.camera ?? {};
  const pos = v3(cam.position, [0, 100, 200]);
  const R = rot(v3(cam.rotation, [0, 0, 0]));
  const zoom = +cam.zoom || 1;
  const f = zoom / Math.tan(((60 / 2) * Math.PI) / 180);
  const people = (j.object?.bodies ?? []).map((b: any) => {
    const joints = bodyJoints(b);
    return KEYPOINTS.map((k): Pt => {
      const p = joints[k];
      const d: Vec3 = [p[0] - pos[0], p[1] - pos[1], p[2] - pos[2]];
      // camera space = Rᵀ · d; the camera looks down its -Z axis
      const x = R[0] * d[0] + R[4] * d[1] + R[8] * d[2];
      const y = R[1] * d[0] + R[5] * d[1] + R[9] * d[2];
      const z = R[2] * d[0] + R[6] * d[1] + R[10] * d[2];
      if (z >= -0.1) return null; // behind the camera
      const nx = ((f / aspect) * x) / -z;
      const ny = (f * y) / -z;
      return [(nx + 1) / 2, (1 - ny) / 2];
    });
  });
  return { people, aspect, source: '3D Openpose Editor scene' };
}

// ---------------------------------------------------------------- classic OpenPose JSON

// BODY_25 → the 18-point order (BODY_25 has a mid-hip at 8 and feet at 19+)
const BODY25_TO_18 = [0, 1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18];

function parseOpenPose(j: any): Pose {
  const frame = Array.isArray(j) ? j[0] : j;
  const w = +frame.canvas_width || +frame.width || 0;
  const h = +frame.canvas_height || +frame.height || 0;
  const raw: number[][] = (frame.people ?? []).map((p: any) => (p.pose_keypoints_2d ?? p.pose_keypoints ?? []).map(Number));
  const all = raw.flat().filter((_, i) => i % 3 !== 2);
  const normalized = all.length > 0 && all.every((v) => v <= 1.001);
  const sx = normalized ? 1 : w || Math.max(1, ...raw.flatMap((r) => r.filter((_, i) => i % 3 === 0)));
  const sy = normalized ? 1 : h || Math.max(1, ...raw.flatMap((r) => r.filter((_, i) => i % 3 === 1)));
  const people = raw.map((r) => {
    const n = Math.floor(r.length / 3);
    const map = n >= 25 ? BODY25_TO_18 : KEYPOINTS.map((_, i) => i);
    return map.map((src): Pt => {
      const x = r[src * 3], y = r[src * 3 + 1], c = r[src * 3 + 2];
      return x === undefined || (x === 0 && y === 0) || c === 0 ? null : [x / sx, y / sy];
    });
  });
  return { people, aspect: w && h ? w / h : normalized ? 1 : sx / sy, source: `OpenPose JSON${raw[0]?.length >= 75 ? ' (BODY_25)' : ''}` };
}

/** Reads a pose file: a 3D Openpose Editor scene or OpenPose JSON. `aspect` = the frame 3D scenes are projected into. */
export function parsePoseJson(text: string, aspect = 2 / 3): Pose {
  let j: any;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error('This file is not valid JSON.');
  }
  let pose: Pose;
  if (j?.object?.bodies) pose = parseEditorScene(j, aspect);
  else if (j?.people || (Array.isArray(j) && j[0]?.people)) pose = parseOpenPose(j);
  else throw new Error('Unknown pose format: expected a 3D Openpose Editor scene or OpenPose JSON (people / pose_keypoints_2d).');
  pose.people = pose.people.filter((p) => p.filter(Boolean).length >= 4);
  if (!pose.people.length) throw new Error('No person with enough joints was found in this file.');
  return pose;
}

// ---------------------------------------------------------------- framing and drawing

/** The pose in a frame of another aspect ratio. fit = scale and centre the figures to fill the frame (with a margin). */
export function framePose(pose: Pose, aspect: number, fit = true, margin = 0.06): Pose {
  // to "frame units": x in 0..aspect, y in 0..1
  const pts = pose.people.map((p) => p.map((q): Pt => (q ? [q[0] * pose.aspect, q[1]] : null)));
  const flat = pts.flat().filter((q): q is [number, number] => !!q);
  if (!flat.length) return { ...pose, aspect };
  let s = 1, ox = 0, oy = 0;
  const minX = Math.min(...flat.map((q) => q[0])), maxX = Math.max(...flat.map((q) => q[0]));
  const minY = Math.min(...flat.map((q) => q[1])), maxY = Math.max(...flat.map((q) => q[1]));
  if (fit) {
    // head joints are the top: leave a bit more room above them for hair / hats
    const top = margin * 2, bottom = margin, side = margin * aspect;
    s = Math.min((aspect - 2 * side) / Math.max(1e-6, maxX - minX), (1 - top - bottom) / Math.max(1e-6, maxY - minY));
    ox = (aspect - (maxX - minX) * s) / 2 - minX * s;
    oy = top + (1 - top - bottom - (maxY - minY) * s) / 2 - minY * s;
  } else {
    // same scale, centred in the new frame
    ox = (aspect - pose.aspect) / 2;
  }
  return {
    ...pose,
    aspect,
    people: pts.map((p) => p.map((q): Pt => (q ? [(q[0] * s + ox) / aspect, q[1] * s + oy] : null))),
  };
}

/** Draws the skeleton like the OpenPose / ControlNet preprocessors do: black background, coloured limbs and joints. */
export async function renderPose(pose: Pose, width: number, height: number): Promise<Blob> {
  const c = document.createElement('canvas');
  c.width = Math.round(width);
  c.height = Math.round(height);
  const g = c.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, c.width, c.height);
  const stick = Math.max(2, Math.round((4 * Math.min(c.width, c.height)) / 512));
  for (const person of pose.people) {
    const px = person.map((q) => (q ? [q[0] * c.width, q[1] * c.height] : null));
    LIMBS.forEach(([a, b], i) => {
      const p = px[a], q = px[b];
      if (!p || !q) return;
      const [r, gr, bl] = COLORS[i];
      g.fillStyle = `rgba(${r},${gr},${bl},0.6)`;
      const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
      g.beginPath();
      g.ellipse((p[0] + q[0]) / 2, (p[1] + q[1]) / 2, len / 2, stick, Math.atan2(q[1] - p[1], q[0] - p[0]), 0, Math.PI * 2);
      g.fill();
    });
    px.forEach((p, i) => {
      if (!p) return;
      const [r, gr, bl] = COLORS[i];
      g.fillStyle = `rgb(${r},${gr},${bl})`;
      g.beginPath();
      g.arc(p[0], p[1], stick, 0, Math.PI * 2);
      g.fill();
    });
  }
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Could not draw the pose'))), 'image/png'));
}

// ---------------------------------------------------------------- description

const deg = (r: number) => (r * 180) / Math.PI;
/** angle at b between a and c, 0..180 */
function joint(a: [number, number], b: [number, number], c: [number, number]) {
  const v1 = [a[0] - b[0], a[1] - b[1]], v2 = [c[0] - b[0], c[1] - b[1]];
  const d = Math.hypot(v1[0], v1[1]) * Math.hypot(v2[0], v2[1]);
  return d ? deg(Math.acos(Math.max(-1, Math.min(1, (v1[0] * v2[0] + v1[1] * v2[1]) / d)))) : 180;
}
/** direction of a segment measured from straight down: 0 = down, 90 = horizontal, 180 = up */
const fromDown = (a: [number, number], b: [number, number]) => deg(Math.acos(Math.max(-1, Math.min(1, (b[1] - a[1]) / (Math.hypot(b[0] - a[0], b[1] - a[1]) || 1)))));
const bend = (a: number) => (a > 160 ? 'straight' : a > 125 ? 'slightly bent' : a > 75 ? 'bent at about a right angle' : 'sharply bent');

function describePerson(p: Pt[], aspect: number): string[] {
  // pixel-like space so angles are true
  const q = p.map((x) => (x ? ([x[0] * aspect, x[1]] as [number, number]) : null));
  const at = (k: keyof typeof K) => q[K[k]];
  const out: string[] = [];
  const neck = at('neck'), nose = at('nose'), rs = at('right_shoulder'), ls = at('left_shoulder'), rh = at('right_hip'), lh = at('left_hip');
  const hip = rh && lh ? ([(rh[0] + lh[0]) / 2, (rh[1] + lh[1]) / 2] as [number, number]) : rh ?? lh;
  const torso = neck && hip ? Math.hypot(neck[0] - hip[0], neck[1] - hip[1]) : 0.3;
  const side = (dx: number) => (dx < 0 ? 'the image left' : 'the image right');

  // facing
  if (rs && ls) {
    const dx = ls[0] - rs[0];
    if (Math.abs(dx) < 0.3 * torso) out.push(`body seen from the side${nose && neck ? `, facing ${side(nose[0] - neck[0])}` : ''}`);
    else out.push(dx > 0 ? 'body facing the viewer' : 'back turned to the viewer');
  }
  // torso lean
  if (neck && hip) {
    const lean = deg(Math.atan2(neck[0] - hip[0], hip[1] - neck[1]));
    if (Math.abs(lean) > 12) out.push(`upper body leaning ${Math.abs(lean) > 30 ? 'strongly ' : ''}toward ${side(lean)}`);
    if (neck[1] > hip[1]) out.push('upside down or bent over');
  }
  // head
  const re = at('right_eye'), le = at('left_eye');
  if (re && le) {
    const tilt = deg(Math.atan2(le[1] - re[1], Math.abs(le[0] - re[0]) || 1e-6));
    if (Math.abs(tilt) > 15) out.push(`head tilted toward ${side(le[0] > re[0] ? -tilt : tilt)}`);
  }
  if (nose && neck) {
    const up = deg(Math.atan2(nose[0] - neck[0], neck[1] - nose[1]));
    if (Math.abs(up) > 25) out.push(`head turned or leaning toward ${side(up)}`);
  }

  // arms
  for (const s of ['right', 'left'] as const) {
    const S = at(`${s}_shoulder`), E = at(`${s}_elbow`), Wr = at(`${s}_wrist`);
    if (!S || !E) continue;
    const dir = fromDown(S, E);
    const outward = neck ? Math.sign(E[0] - S[0]) === Math.sign(S[0] - neck[0]) : true;
    const where =
      dir > 150 ? 'raised straight up' : dir > 110 ? 'raised' : dir > 70 ? (outward ? 'stretched out to the side' : 'held across the body') : dir > 30 ? (outward ? 'angled down and away from the body' : 'angled across the body') : 'hanging down';
    let arm = `${s} arm ${where}`;
    if (Wr) {
      arm += `, elbow ${bend(joint(S, E, Wr))}`;
      const head = nose ?? neck;
      if (head && Wr[1] < head[1] - 0.05 * torso) arm += ', hand above the head';
      else if (nose && Math.hypot(Wr[0] - nose[0], Wr[1] - nose[1]) < 0.35 * torso) arm += ', hand near the face';
      else if (hip && Math.hypot(Wr[0] - hip[0], Wr[1] - hip[1]) < 0.3 * torso) arm += ', hand at the hip';
      else if (neck && Math.sign(Wr[0] - neck[0]) !== Math.sign(S[0] - neck[0]) && Math.abs(Wr[0] - neck[0]) > 0.1 * torso) arm += ', hand reaching across the body';
    }
    out.push(arm);
  }

  // legs
  const legs: { s: string; folded: boolean; kneeOnGround: boolean }[] = [];
  for (const s of ['right', 'left'] as const) {
    const Hp = at(`${s}_hip`), Kn = at(`${s}_knee`), A = at(`${s}_ankle`);
    if (!Hp || !Kn) continue;
    const thigh = fromDown(Hp, Kn);
    let leg = `${s} leg`;
    const knee = A ? joint(Hp, Kn, A) : 180;
    const parts: string[] = [];
    if (thigh > 100) parts.push('knee lifted above the hip');
    else if (thigh > 55) parts.push('thigh raised forward or out to the side');
    else if (thigh > 25) parts.push(`angled out toward ${side(Kn[0] - Hp[0])}`);
    if (A) {
      parts.push(knee > 160 ? 'straight' : `knee ${bend(knee)}`);
      if (knee < 110 && A[1] < Kn[1] + 0.05 * torso && thigh < 55) parts.push('lower leg folded back');
    }
    leg += parts.length ? ` ${parts.join(', ')}` : ' straight down';
    out.push(leg);
    legs.push({ s, folded: knee < 110, kneeOnGround: !!A && Math.abs(Kn[1] - A[1]) < 0.12 * torso && knee < 120 });
  }
  const ra = at('right_ankle'), la = at('left_ankle');
  if (ra && la && rs && ls) {
    const stance = Math.abs(ra[0] - la[0]) / (Math.abs(rs[0] - ls[0]) || 1);
    if (stance > 1.8) out.push('wide stance');
    if (Math.abs(ra[1] - la[1]) > 0.35 * torso) out.push(`one foot clearly higher than the other (${ra[1] < la[1] ? 'right' : 'left'} foot raised)`);
  }
  if (legs.length === 2 && legs.every((l) => l.folded)) out.push('both knees bent (crouching, sitting or mid-jump)');
  for (const l of legs) if (l.kneeOnGround) out.push(`kneeling on the ${l.s} knee`);
  return out;
}

/** The pose in words, for prompts and for the check. Left/right are the character's own sides. */
export function describePose(pose: Pose, style: 'tags' | 'natural' = 'natural'): string {
  const where = (p: Pt[]) => {
    const xs = p.filter((x): x is [number, number] => !!x).map((x) => x[0]);
    const m = xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
    return m < 0.38 ? 'left' : m > 0.62 ? 'right' : 'centre';
  };
  const people = pose.people.map((p) => describePerson(p, pose.aspect));
  if (style === 'tags') return people.map((d, i) => (pose.people.length > 1 ? [`person ${i + 1} on the ${where(pose.people[i])}`, ...d] : d).join(', ')).join(', ');
  const body = people.map((d, i) => `${pose.people.length > 1 ? `Person ${i + 1} (${where(pose.people[i])} of the image): ` : ''}${d.join('; ')}.`);
  return `Pose (left and right are the character's own sides): ${body.join(' ')}`;
}

/** Joint-angle comparison is left to the vision check; this gives a short label for the UI. */
export function poseLabel(pose: Pose): string {
  return `${pose.people.length} ${pose.people.length === 1 ? 'person' : 'people'} · ${pose.source}`;
}

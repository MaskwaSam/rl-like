import * as THREE from 'three';
import { ARENA } from '../sim/rl';
import { buildIndustrial } from './industrial';
import { MASKWA, buildMaskwaVenue } from './maskwa';

const SCHOOL_BANNER_WIDTH = 2048;
const SCHOOL_BANNER_HEIGHT = 128;

type BannerLayout = { position: Float32Array; uv: Float32Array };
type Banner = {
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  original: THREE.CanvasTexture;
  originalLayout: BannerLayout;
  school?: THREE.CanvasTexture;
  schoolLayout?: BannerLayout;
};

/** Original, procedural stadium art. It never participates in physics or networking. */
export class Stadium {
  readonly group = new THREE.Group();
  private readonly scoreCanvas = document.createElement('canvas');
  private readonly scoreTexture: THREE.CanvasTexture;
  private readonly bowl = new THREE.Group();
  private readonly neon = new THREE.Group();
  private industrial: THREE.Group | null = null;
  private maskwa: THREE.Group | null = null;
  private readonly banners: Banner[] = [];
  private readonly crowds: { mesh: THREE.InstancedMesh; original: Float32Array }[] = [];
  private readonly flags: { material: THREE.MeshStandardMaterial; original: number }[] = [];
  private style = 0;
  private lastScore: [number, number, string] = [0, 0, 'FREE'];
  private readonly concrete = new THREE.MeshStandardMaterial({ color: 0x4f5e6a, roughness: 0.9 });
  private readonly steel = new THREE.MeshStandardMaterial({ color: 0xd5dce3, roughness: 0.4, metalness: 0.45 });
  private readonly dark = new THREE.MeshStandardMaterial({ color: 0x202b36, roughness: 0.75 });
  private scoreKey = '';

  constructor() {
    const concrete = this.concrete;
    const steel = this.steel;
    const dark = this.dark;
    const light = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xf2f6ff).multiplyScalar(2.2) });
    const beams: [THREE.Vector3, THREE.Vector3][] = [];
    const lamps: [THREE.Vector3, THREE.Vector3][] = [];
    const segments = 128;

    // Three stepped seating decks sit outside the transparent collision wall.
    for (let tier = 0; tier < 3; tier++) {
      const low = 5 + tier * 10;
      const start = 1 + tier * 0.085;
      for (let row = 0; row < 11; row++) {
        const s = start + row * 0.007;
        this.bowl.add(ring(s, s + 0.008, low + row * 0.65, low + row * 0.65, concrete));
        this.bowl.add(ring(s, s, low + (row - 1) * 0.65, low + row * 0.65, concrete));
      }
      this.bowl.add(ring(start + 0.077, start + 0.098, low + 7.2, low + 7.2, dark));
      this.bowl.add(ring(start, start + 0.004, low - 0.35, low - 0.35, steel));
      const adTexture = bannerTexture(tier);
      const adMat = new THREE.MeshBasicMaterial({ map: adTexture, side: THREE.DoubleSide });
      const banner = ring(start + 0.077, start + 0.077, low + 7.2, low + 8.3, adMat);
      banner.userData.stadiumSign = 'banner';
      this.banners.push({ mesh: banner, material: adMat, original: adTexture, originalLayout: {
        position: (banner.geometry.attributes.position.array as Float32Array).slice(),
        uv: (banner.geometry.attributes.uv.array as Float32Array).slice(),
      } });
      this.bowl.add(banner);

      const columns = 640;
      const count = 11 * columns;
      const crowd = new THREE.InstancedMesh(new THREE.BoxGeometry(0.44, 0.55, 0.35),
        new THREE.MeshStandardMaterial({ roughness: 0.9 }), count);
      const heads = new THREE.InstancedMesh(new THREE.BoxGeometry(0.22, 0.22, 0.22),
        new THREE.MeshStandardMaterial({ color: 0xb9a28b, roughness: 0.9 }), count);
      const matrix = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const scale = new THREE.Vector3(1, 1, 1);
      const colors = [0xc29a77, 0x8d9fa8, 0x1b43ad, 0x3866b8, 0xb66c2d, 0x243343, 0x746151, 0xbfb58c];
      let seed = 27 + tier;
      const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
      let index = 0;
      for (let row = 0; row < 11; row++) {
        for (let col = 0; col < columns; col++) {
          const angle = (col + 0.5) / columns * Math.PI * 2;
          const p = perimeter(angle, start + row * 0.007 + 0.004, low + row * 0.65 + 0.28);
          q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -angle);
          // Regular radial aisles keep the bowl readable from the menu camera.
          scale.set(1, col % 80 < 3 ? 0.01 : 0.65 + rnd() * 0.7, 1);
          matrix.compose(p, q, scale);
          crowd.setMatrixAt(index, matrix);
          crowd.setColorAt(index, new THREE.Color(colors[Math.floor(rnd() * colors.length)]));
          p.y += 0.36 * scale.y;
          matrix.compose(p, q, scale); heads.setMatrixAt(index++, matrix);
        }
      }
      this.bowl.add(crowd, heads);
      this.crowds.push({ mesh: crowd, original: (crowd.instanceColor!.array as Float32Array).slice() });
      for (let i = 0; i < segments; i++) {
        const a = i / segments * Math.PI * 2;
        const b = (i + 1) / segments * Math.PI * 2;
        beams.push([perimeter(a, start + 0.078, low + 8.4), perimeter(b, start + 0.078, low + 8.4)]);
      }
    }

    // Open roof: no visual object obstructs wall/ceiling driving inside the existing arena.
    this.bowl.add(ring(1.1, 1.38, 37.5, 40.2, dark));
    for (let i = 0; i < segments; i++) {
      const a = i / segments * Math.PI * 2;
      const b = (i + 1) / segments * Math.PI * 2;
      beams.push([perimeter(a, 1.1, 35.8), perimeter(b, 1.1, 35.8)]);
      beams.push([perimeter(a, 1.1, 37.5), perimeter(b, 1.1, 37.5)]);
      beams.push([perimeter(a, 1.1, 35.8), perimeter(b, 1.1, 37.5)]);
      beams.push([perimeter(a, 1.1, 35.8), perimeter(a, 1.1, 37.5)]);
      if (i % 4 === 0) {
        beams.push([perimeter(a, 1.13, 37.4), perimeter(a, 1.38, 40.2)]);
        beams.push([perimeter(a, 1.13, 39.4), perimeter(b + Math.PI / 32, 1.13, 37.4)]);
        lamps.push([perimeter(a, 1.134, 37.9), perimeter(b, 1.134, 37.9)]);
        const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 3.2),
          new THREE.MeshStandardMaterial({ color: i % 8 === 0 ? 0x3f75df : 0xe2a34d, side: THREE.DoubleSide }));
        flag.position.copy(perimeter(a, 1.12, 35.5));
        flag.lookAt(0, 35.5, 0);
        this.bowl.add(flag);
        this.flags.push({ material: flag.material, original: flag.material.color.getHex() });
      }
    }
    this.bowl.add(instancedBeams(beams, 0.16, steel), instancedBeams(lamps, 0.22, light));

    // Venue accents are retained and toggled, so switching never rebuilds crowd geometry.
    for (let tier = 0; tier < 3; tier++) {
      const start = 1 + tier * 0.085;
      const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(tier % 2 ? 0xaa51ff : 0x4b9fff).multiplyScalar(2.5) });
      this.neon.add(ring(start + 0.078, start + 0.078, 12 + tier * 10, 12.18 + tier * 10, mat));
    }
    this.neon.visible = false;
    this.group.add(this.bowl, this.neon);

    this.scoreCanvas.width = 512;
    this.scoreCanvas.height = 256;
    this.scoreTexture = new THREE.CanvasTexture(this.scoreCanvas);
    this.scoreTexture.colorSpace = THREE.SRGBColorSpace;
    for (const side of [-1, 1]) {
      const board = new THREE.Mesh(new THREE.PlaneGeometry(12, 6),
        new THREE.MeshBasicMaterial({ map: this.scoreTexture, side: THREE.DoubleSide }));
      board.position.set(0, 29, side * (ARENA.extentY + 14));
      board.lookAt(0, 29, 0);
      this.group.add(board);
    }
    this.setScore(0, 0, 'FREE');
  }

  setStyle(style: number): void {
    this.bowl.visible = style !== 2;
    this.neon.visible = style === 1;
    this.concrete.color.setHex(style === 3 ? MASKWA.navy : style === 1 ? 0x283448 : 0x4f5e6a);
    this.steel.color.setHex(style === 1 ? 0x8e9abe : 0xd5dce3);
    this.dark.color.setHex(style === 3 ? 0x062E49 : style === 1 ? 0x101628 : 0x202b36);
    this.banners.forEach((banner, tier) => {
      banner.material.map = style === 3 ? (banner.school ??= bannerTexture(tier, true)) : banner.original;
      const layout = style === 3
        ? (banner.schoolLayout ??= schoolBannerLayout(banner.originalLayout))
        : banner.originalLayout;
      const { position, uv } = banner.mesh.geometry.attributes;
      (position.array as Float32Array).set(layout.position);
      (uv.array as Float32Array).set(layout.uv);
      position.needsUpdate = true;
      uv.needsUpdate = true;
      banner.mesh.geometry.computeBoundingSphere();
    });
    // Preserve each crowd's original instance colours for the other venues.
    this.crowds.forEach(({ mesh, original }) => {
      if (style === 3) {
        const colours = [MASKWA.navy, MASKWA.cyan, MASKWA.white, 0x607B8D].map(hex => new THREE.Color(hex));
        for (let i = 0; i < mesh.count; i++) mesh.setColorAt(i, colours[(i * 13 + Math.floor(i / 640)) % colours.length]);
      } else (mesh.instanceColor!.array as Float32Array).set(original);
      mesh.instanceColor!.needsUpdate = true;
    });
    this.flags.forEach(({ material, original }, i) => material.color.setHex(style === 3 ? i % 2 ? MASKWA.cyan : MASKWA.white : original));
    if (style === 3 && !this.maskwa) { this.maskwa = buildMaskwaVenue(); this.group.add(this.maskwa); }
    if (this.maskwa) this.maskwa.visible = style === 3;
    this.style = style;
    this.setScore(...this.lastScore);
    if (style === 2 && !this.industrial) {
      this.industrial = buildIndustrial();
      this.group.add(this.industrial);
    }
    if (this.industrial) this.industrial.visible = style === 2;
  }

  setScore(blue: number, orange: number, clock: string): void {
    this.lastScore = [blue, orange, clock];
    const key = `${this.style}-${blue}-${orange}-${clock}`;
    if (key === this.scoreKey) return;
    this.scoreKey = key;
    const ctx = this.scoreCanvas.getContext('2d')!;
    ctx.fillStyle = '#17222e'; ctx.fillRect(0, 0, 512, 256);
    ctx.fillStyle = '#2358ca'; ctx.fillRect(8, 8, 156, 240);
    ctx.fillStyle = '#c7762c'; ctx.fillRect(348, 8, 156, 240);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#fff';
    ctx.font = 'italic bold 112px sans-serif'; ctx.fillText(String(blue), 86, 135); ctx.fillText(String(orange), 426, 135);
    ctx.font = 'bold 40px sans-serif'; ctx.fillText(clock, 256, 133, 168);
    ctx.font = `bold ${this.style === 3 ? 26 : 17}px sans-serif`; ctx.fillText(this.style === 3 ? 'MASKWA' : 'CAR SOCCER', 256, 42);
    if (this.style === 3) { ctx.font = 'bold 18px sans-serif'; ctx.fillText('MASKWACIS CREE HIGH SCHOOL', 256, 225, 320); }
    this.scoreTexture.needsUpdate = true;
  }
}

// A rounded rectangle fits the original field more closely than a circular bowl.
function perimeter(a: number, s: number, y: number): THREE.Vector3 {
  const c = Math.cos(a), n = Math.sin(a);
  return new THREE.Vector3(Math.sign(c) * Math.sqrt(Math.abs(c)) * (ARENA.extentX + 5) * s,
    y, Math.sign(n) * Math.sqrt(Math.abs(n)) * (ARENA.extentY + 6) * s);
}

function ring(inner: number, outer: number, low: number, high: number, material: THREE.Material): THREE.Mesh {
  const pos: number[] = [], uv: number[] = [], indices: number[] = [];
  for (let i = 0; i <= 128; i++) {
    const a = i / 128 * Math.PI * 2;
    const p = perimeter(a, inner, low), q = perimeter(a, outer, high);
    pos.push(p.x, p.y, p.z, q.x, q.y, q.z);
    // Around the bowl, increasing angle projects left-to-right for inside viewers.
    // DoubleSide changes face visibility, not UV direction: keep banner U increasing.
    uv.push(i / 128 * 20, 0, i / 128 * 20, 1);
    if (i < 128) { const k = i * 2; indices.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(indices); g.computeVertexNormals();
  // The ring winds both horizontal and vertical decks; DoubleSide also shows the roof from below.
  material.side = THREE.DoubleSide;
  return new THREE.Mesh(g, material);
}

function instancedBeams(lines: [THREE.Vector3, THREE.Vector3][], width: number, mat: THREE.Material): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, lines.length);
  const matrix = new THREE.Matrix4(), q = new THREE.Quaternion(), direction = new THREE.Vector3(), mid = new THREE.Vector3();
  lines.forEach(([a, b], i) => {
    direction.subVectors(b, a); const length = direction.length();
    q.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
    matrix.compose(mid.copy(a).add(b).multiplyScalar(0.5), q, new THREE.Vector3(width, length, width));
    mesh.setMatrixAt(i, matrix);
  });
  return mesh;
}

/** Equal texel density along the full fascia keeps letters in their natural proportions.
 * The superellipse's angular segments have unequal lengths, so angle-based UVs stretch
 * the straight sections. A whole number of repeats also keeps the closing seam intact.
 */
function schoolBannerLayout(original: BannerLayout): BannerLayout {
  const position = original.position.slice(), uv = original.uv.slice();
  const points = position.length / 6;
  const distance = new Float64Array(points);
  for (let i = 1; i < points; i++) {
    const k = i * 6;
    distance[i] = distance[i - 1] + Math.hypot(position[k] - position[k - 6], position[k + 2] - position[k - 4]);
  }
  const length = distance[points - 1];
  const aspect = SCHOOL_BANNER_WIDTH / SCHOOL_BANNER_HEIGHT;
  const repeats = Math.max(1, Math.round(length / (1.4 * aspect)));
  const height = length / (repeats * aspect);
  for (let i = 0; i < points; i++) {
    // Keep the existing top edge below the railing; give the type room downward.
    position[i * 6 + 1] = position[i * 6 + 4] - height;
    uv[i * 4] = uv[i * 4 + 2] = distance[i] / length * repeats;
  }
  return { position, uv };
}

function bannerTexture(tier: number, school = false): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = school ? SCHOOL_BANNER_WIDTH : 512;
  cv.height = school ? SCHOOL_BANNER_HEIGHT : 64;
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = school ? '#09426A' : '#111b24'; ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.font = 'italic bold 30px sans-serif'; ctx.textBaseline = 'middle';
  if (school) {
    ctx.textAlign = 'center'; ctx.fillStyle = '#FFFFFF';
    const nameStart = tier === 1 ? 0 : 512;
    const maskwaStart = tier === 1 ? 1536 : 0;
    const text = (label: string, start: number, width: number, size: number) => {
      ctx.font = `bold ${size}px sans-serif`;
      const available = width - 64;
      const measured = ctx.measureText(label).width;
      if (measured > available) ctx.font = `bold ${size * available / measured}px sans-serif`;
      // Reduce font size uniformly when needed; fillText(maxWidth) squeezes glyphs.
      ctx.fillText(label, start + width / 2, cv.height / 2);
    };
    text('MASKWA', maskwaStart, 512, 92);
    text('MASKWACIS CREE HIGH SCHOOL', nameStart, 1536, 78);
    ctx.fillStyle = '#0094C9'; ctx.fillRect(0, 0, cv.width, 8); ctx.fillRect(0, cv.height - 8, cv.width, 8);
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping; tex.anisotropy = 8; return tex;
  }
  ctx.fillStyle = tier % 2 ? '#e9b367' : '#edf3ff'; ctx.fillText('CAR SOCCER', 24, 32);
  for (let x = 286; x < 490; x += 26) {
    ctx.beginPath(); ctx.moveTo(x, 17); ctx.lineTo(x + 10, 32); ctx.lineTo(x, 47);
    ctx.strokeStyle = tier % 2 ? '#e9b367' : '#6198f1'; ctx.lineWidth = 5; ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.wrapS = THREE.RepeatWrapping;
  return tex;
}

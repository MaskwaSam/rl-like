import * as THREE from 'three';
import { ARENA } from '../sim/rl';
import schoolBadgeUrl from '../assets/mchs-logo.png';
import bearUrl from '../assets/maskwa-bear.png';

/** School badge colours verified against the public MCHS header and Sam's local logo. */
export const MASKWA = { navy: 0x09426A, cyan: 0x0094C9, white: 0xFFFFFF };
let schoolBadge: HTMLImageElement;
let bear: HTMLImageElement;

/** Same-origin bundled assets: private-room guests never depend on an external image host. */
export async function loadMaskwaArt(): Promise<void> {
  const load = async (url: string) => {
    const image = new Image(); image.src = url; await image.decode(); return image;
  };
  [schoolBadge, bear] = await Promise.all([load(schoolBadgeUrl), load(bearUrl)]);
}

export function drawMaskwaBear(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number): void {
  // Preserve the artwork's aspect ratio rather than stretching the bear with field UVs.
  const ratio = bear.width / bear.height;
  const w = Math.min(width, height * ratio), h = w / ratio;
  ctx.drawImage(bear, x + (width - w) / 2, y + (height - h) / 2, w, h);
}

/** Original venue accents; official school badge is retained intact on sponsor panels. */
export function buildMaskwaVenue(): THREE.Group {
  const group = new THREE.Group();
  const cyan = new THREE.MeshBasicMaterial({ color: new THREE.Color(MASKWA.cyan).multiplyScalar(1.7) });
  const navy = new THREE.MeshStandardMaterial({ color: MASKWA.navy, roughness: 0.6, metalness: 0.35 });
  const boardMaterial = new THREE.MeshBasicMaterial({ map: schoolPanel(), side: THREE.FrontSide });
  for (const side of [-1, 1]) {
    for (const end of [-1, 1]) {
      const board = new THREE.Mesh(new THREE.PlaneGeometry(9, 13.5), boardMaterial);
      board.position.set(side * 22, 27.25, end * (ARENA.extentY + 4));
      board.lookAt(0, 27.25, 0);
      group.add(board);
      const backing = new THREE.Mesh(new THREE.BoxGeometry(9.35, 13.85, 0.2), navy);
      backing.position.copy(board.position); backing.quaternion.copy(board.quaternion); backing.translateZ(-0.15);
      group.add(backing);
    }
    // Team-independent school trim stays above the transparent collision wall.
    const strip = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.22, ARENA.extentY * 2), cyan);
    strip.position.set(side * (ARENA.extentX + 5), 13, 0); group.add(strip);
  }
  return group;
}

function schoolPanel(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 768;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#09426A'; ctx.fillRect(0, 0, 512, 768);
  ctx.fillStyle = '#0094C9'; ctx.fillRect(0, 0, 512, 12); ctx.fillRect(0, 756, 512, 12);
  ctx.fillStyle = '#FFFFFF'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = 'bold 72px sans-serif'; ctx.fillText('MASKWA', 256, 91);
  // The supplied school badge keeps its original colours, transparency and aspect ratio.
  ctx.drawImage(schoolBadge, 48, 162, 416, 416);
  ctx.font = 'bold 36px sans-serif'; ctx.fillText('MASKWACIS CREE', 256, 632); ctx.fillText('HIGH SCHOOL', 256, 677);
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

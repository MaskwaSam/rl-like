/** Browser regression: run with page.evaluate(checkStadiumSigns) after the game boots.
 * Checks texture direction in projected screen space rather than assuming a UV sign.
 * Only clones camera/vector objects; does not move the game camera or change graphics.
 */
export function checkStadiumSigns() {
  const renderer = globalThis.__renderer;
  if (!renderer?.stadium) throw new Error('Boot Car Soccer before checking stadium signs');
  const banners = [], boards = [], schoolPanels = [];
  renderer.stadium.group.traverseVisible(mesh => {
    if (mesh.userData?.stadiumSign === 'banner') banners.push(mesh);
    if (mesh.material?.map?.image?.height === 256) boards.push(mesh);
    if (mesh.material?.map?.image?.height === 768) schoolPanels.push(mesh);
  });
  const tiers = renderer.arenaStyle === 2 ? 0 : 3;
  if (banners.length !== tiers || boards.length !== 2) throw new Error(`Expected ${tiers} visible banner tiers and two goal scoreboards`);
  if (schoolPanels.length !== (renderer.arenaStyle === 3 ? 4 : 0)) throw new Error('School badge panels do not match the selected venue');
  const camera = renderer.camera.clone();
  const vector = () => renderer.camera.position.clone();
  const point = (mesh, index) => vector().fromBufferAttribute(mesh.geometry.attributes.position, index).applyMatrix4(mesh.matrixWorld);
  const failures = [];
  let checks = 0;
  renderer.stadium.group.updateMatrixWorld(true);
  const assertDirection = (label, mesh, left, right) => {
    const a = point(mesh, left).project(camera), b = point(mesh, right).project(camera);
    const uv = mesh.geometry.attributes.uv;
    const du = (uv.getX(right) - uv.getX(left)) * mesh.material.map.repeat.x;
    checks++;
    if ((b.x - a.x) * du <= 1e-7) failures.push(label);
  };
  banners.forEach((mesh, tier) => {
    const segments = mesh.geometry.attributes.position.count / 2 - 1;
    for (let i = 0; i < segments; i++) {
      const a = point(mesh, i * 2), b = point(mesh, (i + 1) * 2);
      const mid = a.add(b).multiplyScalar(0.5);
      const upper = point(mesh, i * 2 + 1);
      mid.y = (mid.y + upper.y) / 2;
      for (const [view, fraction, elevation] of [['pitch', 0, -2], ['inner-bowl spectator', 0.7, 3]]) {
        camera.position.set(mid.x * fraction, mid.y + elevation, mid.z * fraction);
        camera.lookAt(mid); camera.updateMatrixWorld(true);
        assertDirection(`tier ${tier + 1}, segment ${i}, ${view}`, mesh, i * 2, (i + 1) * 2);
        const bottom = point(mesh, i * 2).project(camera), top = upper.clone().project(camera);
        const uv = mesh.geometry.attributes.uv;
        checks++;
        if ((top.y - bottom.y) * (uv.getY(i * 2 + 1) - uv.getY(i * 2)) <= 1e-7) failures.push(`tier ${tier + 1}, segment ${i}, ${view}: vertical orientation`);
      }
    }
  });
  [...boards, ...schoolPanels].forEach((mesh, goal) => {
    for (const x of [-25, 0, 25]) {
      camera.position.set(x, 23, 0); camera.lookAt(mesh.position); camera.updateMatrixWorld(true);
      assertDirection(`goal ${goal + 1}, viewer x=${x}`, mesh, 0, 1);
    }
  });
  return { checks, failures, readable: failures.length === 0, bannerTiers: banners.length, goalBoards: boards.length, schoolPanels: schoolPanels.length };
}

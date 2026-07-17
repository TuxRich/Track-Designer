import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';

// Creates a billboard sprite showing `text`. `height` is the on-screen size
// of the text in world meters.
export function makeTextSprite(text, { height = 0.3, color = '#ffffff', background = null, alwaysOnTop = false } = {}) {
  const fontPx = 64;
  const pad = 16;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = `600 ${fontPx}px "Segoe UI", sans-serif`;
  const w = Math.ceil(ctx.measureText(text).width) + pad * 2;
  const h = fontPx + pad * 2;
  canvas.width = w;
  canvas.height = h;
  const c2 = canvas.getContext('2d');
  if (background) {
    c2.fillStyle = background;
    c2.beginPath();
    c2.roundRect(0, 0, w, h, 18);
    c2.fill();
  }
  c2.font = `600 ${fontPx}px "Segoe UI", sans-serif`;
  c2.fillStyle = color;
  c2.textAlign = 'center';
  c2.textBaseline = 'middle';
  c2.fillText(text, w / 2, h / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({
    map: texture,
    depthTest: !alwaysOnTop,
    transparent: true,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(height * (w / h), height, 1);
  if (alwaysOnTop) sprite.renderOrder = 999;
  return sprite;
}

// The 3D viewport: renderer, camera, lights, arena floor grid with meter
// markers, and boundary walls. The arena's corner is at the origin and it
// extends into +X / +Z, so gate coordinates read directly as "meters from
// the corner" — handy when reproducing the track in real life.
export class SceneManager {
  constructor(canvas) {
    this.canvas = canvas;
    this.arena = { w: 10, d: 8, h: 3 };

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x14161b);

    this.camera = new THREE.PerspectiveCamera(55, 1, 0.05, 500);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.02; // stay above the floor

    const hemi = new THREE.HemisphereLight(0xdfe8ff, 0x3a3228, 1.0);
    this.scene.add(hemi);
    this.sun = new THREE.DirectionalLight(0xffffff, 1.6);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.scene.add(this.sun);

    this.arenaGroup = new THREE.Group();
    this.scene.add(this.arenaGroup);

    this.raycaster = new THREE.Raycaster();
    this._pointer = new THREE.Vector2();

    this.buildArena();
    this.resetCamera();

    const container = canvas.parentElement;
    new ResizeObserver(() => this._resize()).observe(container);
    this._resize();

    this.renderer.setAnimationLoop(() => {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    });
  }

  _resize() {
    const { clientWidth: w, clientHeight: h } = this.canvas.parentElement;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setArena(w, d, h) {
    this.arena = { w, d, h };
    this.buildArena();
  }

  resetCamera() {
    const { w, d } = this.arena;
    const dist = Math.max(w, d);
    this.camera.position.set(w / 2, dist * 0.75, d / 2 + dist * 0.9);
    this.controls.target.set(w / 2, 0, d / 2);
    this.controls.update();
  }

  buildArena() {
    const { w, d, h } = this.arena;
    const g = this.arenaGroup;
    for (let i = g.children.length - 1; i >= 0; i--) {
      const child = g.children[i];
      g.remove(child);
      child.traverse?.((o) => {
        o.geometry?.dispose();
        if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
      });
    }

    // Ground plane (receives shadows, used for placement raycasts).
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(w, d),
      new THREE.MeshStandardMaterial({ color: 0x1b1e26, roughness: 0.95 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(w / 2, 0, d / 2);
    ground.receiveShadow = true;
    ground.name = 'floor';
    g.add(ground);
    this.floor = ground;

    // Grid: minor lines every 0.5 m, major lines every 1 m.
    g.add(this._gridLines(0.5, 0x2a2f3a, 0.001));
    g.add(this._gridLines(1, 0x424b5c, 0.002));

    // Meter number labels along the two edges next to the origin corner.
    for (let x = 0; x <= Math.floor(w); x++) {
      const s = makeTextSprite(String(x), { height: 0.28, color: '#8b93a1' });
      s.position.set(x, 0.02, -0.35);
      g.add(s);
    }
    for (let z = 1; z <= Math.floor(d); z++) {
      const s = makeTextSprite(String(z), { height: 0.28, color: '#8b93a1' });
      s.position.set(-0.35, 0.02, z);
      g.add(s);
    }

    // Boundary: wireframe box edges plus faint walls.
    const box = new THREE.BoxGeometry(w, h, d);
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(box),
      new THREE.LineBasicMaterial({ color: 0x4a5568 })
    );
    edges.position.set(w / 2, h / 2, d / 2);
    g.add(edges);
    box.dispose();

    const wallMat = new THREE.MeshBasicMaterial({
      color: 0x2a4a66,
      transparent: true,
      opacity: 0.06,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const walls = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wallMat);
    walls.position.set(w / 2, h / 2, d / 2);
    g.add(walls);

    // Position the sun relative to the arena so shadows stay crisp.
    this.sun.position.set(w * 0.3, Math.max(h * 3, 8), d * 1.1);
    const cam = this.sun.shadow.camera;
    const span = Math.max(w, d);
    cam.left = -span;
    cam.right = span;
    cam.top = span;
    cam.bottom = -span;
    cam.far = span * 6;
    cam.updateProjectionMatrix();
    this.sun.target.position.set(w / 2, 0, d / 2);
    this.scene.add(this.sun.target);
  }

  _gridLines(step, color, y) {
    const { w, d } = this.arena;
    const pts = [];
    for (let x = 0; x <= w + 1e-6; x += step) {
      pts.push(x, y, 0, x, y, d);
    }
    for (let z = 0; z <= d + 1e-6; z += step) {
      pts.push(0, y, z, w, y, z);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    return new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color }));
  }

  _setPointer(event) {
    const rect = this.canvas.getBoundingClientRect();
    this._pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );
    this.raycaster.setFromCamera(this._pointer, this.camera);
  }

  // Point on the floor plane under the cursor, clamped to the arena. Null if
  // the ray misses the plane entirely.
  pickFloor(event) {
    this._setPointer(event);
    const hit = this.raycaster.intersectObject(this.floor, false)[0];
    if (hit) return hit.point.clone();
    // Fall back to the infinite y=0 plane, then clamp inside the arena.
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const p = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(plane, p)) return null;
    p.x = THREE.MathUtils.clamp(p.x, 0, this.arena.w);
    p.z = THREE.MathUtils.clamp(p.z, 0, this.arena.d);
    return p;
  }

  // First intersection among `objects` (recursive). Returns the raw hit.
  pickObjects(event, objects) {
    this._setPointer(event);
    return this.raycaster.intersectObjects(objects, true)[0] || null;
  }

  screenshotPNG() {
    // Render explicitly right before reading pixels so the buffer is fresh
    // (the default frame buffer may already be cleared between frames).
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }
}

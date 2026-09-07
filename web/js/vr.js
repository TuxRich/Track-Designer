import * as THREE from 'three';

const UP = new THREE.Vector3(0, 1, 0);
export const MOVE_SPEED = 2.2; // m/s — a brisk walk; the arena is only metres across
export const SNAP_ANGLE = THREE.MathUtils.degToRad(30);
export const START_SETBACK = 2.5; // metres behind gate 1 to spawn
export const WANDER_MARGIN = 5; // how far outside the arena you may walk
const DEADZONE = 0.25;

// Immersive VR viewing.
//
// No conversion is needed to get there: the scene is already authored in real
// metres with the floor at y = 0, which is exactly what a `local-floor`
// reference space expects, so a 10 x 8 m arena maps 1:1 onto the room you are
// standing in.
//
// The camera is parented to a rig group rather than moved directly — three.js
// overwrites camera.position/quaternion with the headset pose every frame, and
// composes it with the parent's world matrix, so the rig is the only place a
// player position can live.
export class VRMode {
  // Feature-detect once at startup rather than inside the button handler:
  // requestSession must be called from a user gesture, and an await in the
  // handler before it would spend that gesture.
  static async isSupported() {
    if (!navigator.xr?.isSessionSupported) return false;
    try {
      return await navigator.xr.isSessionSupported('immersive-vr');
    } catch {
      return false; // some browsers throw instead of resolving false
    }
  }

  constructor(sceneMgr, editor) {
    this.sceneMgr = sceneMgr;
    this.editor = editor;
    this.session = null;
    this.saved = null;
    // Assigned by the UI so the toolbar button can follow the session, which
    // can also end from inside the headset (system menu, taking it off).
    this.onChange = () => {};

    this.rig = new THREE.Group();
    this.rig.name = 'xrRig';

    this._snapArmed = true;
    this._fwd = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._head = new THREE.Vector3();
    this._headLocal = new THREE.Vector3();
    this._scratch = new THREE.Vector3();

    sceneMgr.onFrame((dt) => this._onFrame(dt));
  }

  get active() {
    return this.session !== null;
  }

  toggle() {
    return this.active ? this.exit() : this.enter();
  }

  async enter() {
    if (this.active) return;
    const { renderer, scene, camera, controls } = this._parts();

    const session = await navigator.xr.requestSession('immersive-vr', {
      optionalFeatures: ['local-floor', 'bounded-floor'],
    });
    this.session = session;
    session.addEventListener('end', () => this._teardown(), { once: true });

    // Remember the desktop view so exiting puts it back exactly — three.js
    // will have overwritten the camera transform with head poses by then.
    this.saved = {
      position: camera.position.clone(),
      quaternion: camera.quaternion.clone(),
      target: controls.target.clone(),
      controlsEnabled: controls.enabled,
    };

    try {
      // Gate editing is mouse-and-gizmo work with no VR equivalent.
      this.editor.deselect();
      controls.enabled = false;

      scene.add(this.rig);
      this.rig.add(camera);
      this._placeAtStart();

      renderer.xr.setReferenceSpaceType('local-floor');
      await renderer.xr.setSession(session);
    } catch (err) {
      // Never strand the desktop view behind a session that never started.
      await session.end().catch(() => this._teardown());
      throw err;
    }
    this.onChange(true);
  }

  async exit() {
    // 'end' fires _teardown, so both paths out of a session share one route.
    if (this.session) await this.session.end();
  }

  _parts() {
    return {
      renderer: this.sceneMgr.renderer,
      scene: this.sceneMgr.scene,
      camera: this.sceneMgr.camera,
      controls: this.sceneMgr.controls,
    };
  }

  _teardown() {
    const { scene, camera, controls } = this._parts();
    this.session = null;
    this.rig.remove(camera);
    scene.remove(this.rig);
    this.rig.position.set(0, 0, 0);
    this.rig.rotation.set(0, 0, 0);

    if (this.saved) {
      camera.position.copy(this.saved.position);
      camera.quaternion.copy(this.saved.quaternion);
      controls.target.copy(this.saved.target);
      controls.enabled = this.saved.controlsEnabled;
      controls.update();
      this.saved = null;
    }
    this.onChange(false);
  }

  // Spawn behind gate 1 looking down the track. Which side is "behind" comes
  // from the track itself — the direction from gate 2 back to gate 1 — so it
  // needs no assumption about how a gate's own rotation is signed.
  _placeAtStart() {
    const { w, d } = this.sceneMgr.arena;
    const centre = new THREE.Vector3(w / 2, 0, d / 2);
    const seq = this.editor.gates.filter((g) => !g.prop);

    let target = centre;
    let approach = new THREE.Vector3(0, 0, -1);

    if (seq.length) {
      target = seq[0].object.position.clone().setY(0);
      const from = seq.length > 1 ? seq[1].object.position : centre;
      approach.copy(target).sub(this._scratch.copy(from).setY(0)).setY(0);
      if (approach.lengthSq() < 1e-6) approach.set(0, 0, -1);
      approach.normalize();
    }

    const start = seq.length
      ? target.clone().addScaledVector(approach, START_SETBACK)
      : new THREE.Vector3(centre.x, 0, -1.5);

    this.rig.position.set(start.x, 0, start.z);
    this._clampToArena();
    // A mesh's forward is -Z, so yaw is measured from the negated delta.
    const dx = target.x - this.rig.position.x;
    const dz = target.z - this.rig.position.z;
    this.rig.rotation.y = Math.atan2(-dx, -dz);
    this.rig.updateMatrixWorld(true);
  }

  _clampToArena() {
    const { w, d } = this.sceneMgr.arena;
    const p = this.rig.position;
    p.x = THREE.MathUtils.clamp(p.x, -WANDER_MARGIN, w + WANDER_MARGIN);
    p.z = THREE.MathUtils.clamp(p.z, -WANDER_MARGIN, d + WANDER_MARGIN);
    p.y = 0;
  }

  _onFrame(dt) {
    if (!this.session || !dt) return;

    let moveX = 0;
    let moveY = 0;
    let turn = 0;
    for (const src of this.session.inputSources) {
      const pad = src.gamepad;
      if (!pad) continue;
      // The xr-standard mapping puts the thumbstick on axes 2/3; controllers
      // that only report a touchpad use 0/1.
      const ax = pad.axes.length >= 4 ? pad.axes[2] : pad.axes[0] || 0;
      const ay = pad.axes.length >= 4 ? pad.axes[3] : pad.axes[1] || 0;
      if (src.handedness === 'right') {
        // Ignore the vertical component so a sloppy push doesn't snap-turn.
        if (Math.abs(ax) > Math.abs(ay)) turn = ax;
      } else {
        if (Math.abs(ax) > DEADZONE) moveX += ax;
        if (Math.abs(ay) > DEADZONE) moveY += ay;
      }
    }

    if (moveX || moveY) this._move(moveX, moveY, dt);

    if (Math.abs(turn) > DEADZONE) {
      // Edge-triggered: one snap per push, not one per frame.
      if (this._snapArmed) {
        this._snapArmed = false;
        this._snapTurn(-Math.sign(turn) * SNAP_ANGLE);
      }
    } else {
      this._snapArmed = true;
    }
  }

  _move(stickX, stickY, dt) {
    const xrCamera = this.sceneMgr.renderer.xr.getCamera();
    xrCamera.getWorldDirection(this._fwd);
    this._fwd.y = 0; // walk, don't fly, however far you tilt your head
    if (this._fwd.lengthSq() < 1e-6) this._fwd.set(0, 0, -1);
    this._fwd.normalize();
    this._right.crossVectors(this._fwd, UP).normalize();

    const step = MOVE_SPEED * dt;
    this.rig.position.addScaledVector(this._right, stickX * step);
    this.rig.position.addScaledVector(this._fwd, -stickY * step); // stick up = forward
    this._clampToArena();
    this.rig.updateMatrixWorld(true);
  }

  // Turn about the head, not the rig origin — pivoting around a point the
  // player is standing away from reads as being flung sideways.
  _snapTurn(angle) {
    const xrCamera = this.sceneMgr.renderer.xr.getCamera();
    xrCamera.getWorldPosition(this._head);

    this.rig.updateMatrixWorld(true);
    this._headLocal.copy(this._head);
    this.rig.worldToLocal(this._headLocal);

    this.rig.rotation.y += angle;
    this.rig.updateMatrixWorld(true);

    // Shift the rig by however far the head moved, cancelling it out.
    this._scratch.copy(this._headLocal);
    this.rig.localToWorld(this._scratch);
    this.rig.position.add(this._head.sub(this._scratch));
    this._clampToArena();
    this.rig.updateMatrixWorld(true);
  }
}

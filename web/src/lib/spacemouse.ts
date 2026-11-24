import * as THREE from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

/** Official 3Dconnexion & legacy Logitech 3Dconnexion USB Vendor IDs */
export const SPACEMOUSE_HID_FILTERS = [
  { vendorId: 0x256f }, // 3Dconnexion (Compact, Wireless, Pro, Enterprise, Universal Receiver)
  { vendorId: 0x046d, productId: 0xc626 }, // SpaceNavigator
  { vendorId: 0x046d, productId: 0xc628 }, // SpaceNavigator for Notebooks
  { vendorId: 0x046d, productId: 0xc627 }, // SpaceExplorer
  { vendorId: 0x046d, productId: 0xc625 }, // SpacePilot
  { vendorId: 0x046d, productId: 0xc629 }, // SpacePilot Pro
  { vendorId: 0x046d, productId: 0xc62b }, // SpaceMouse Pro
];

const GAMEPAD_MATCH = /3dconnexion|spacemouse|spacenavigator|spacepilot|spaceexplorer|256f|046d.*c62/i;
const HID_AXIS_SCALE = 350;

export interface SpaceMouseAxes {
  /** Left (-) / Right (+) in [-1, 1] */
  tx: number;
  /** Push forward (-) / Pull back (+) in [-1, 1] */
  ty: number;
  /** Push down (-) / Pull up (+) in [-1, 1] */
  tz: number;
  /** Pitch forward/back in [-1, 1] */
  rx: number;
  /** Roll left/right in [-1, 1] */
  ry: number;
  /** Twist yaw left/right in [-1, 1] */
  rz: number;
}

export interface SpaceMousePrefs {
  sensitivity: number;
  invertAxes: boolean;
}

export interface SpaceMouseStatus {
  connected: boolean;
  source: "webhid" | "gamepad" | null;
  deviceName: string | null;
  webHidSupported: boolean;
}

interface ParsedReport {
  translation?: [number, number, number];
  rotation?: [number, number, number];
  buttons?: number;
}

// Minimal WebHID DOM typings so TypeScript compiles cleanly without @types/w3c-web-hid
interface HIDInputReportEventLike extends Event {
  reportId: number;
  data: DataView;
}
interface HIDDeviceLike extends EventTarget {
  opened: boolean;
  vendorId: number;
  productId: number;
  productName?: string;
  open(): Promise<void>;
  close(): Promise<void>;
}
interface NavigatorHIDLike extends EventTarget {
  getDevices(): Promise<HIDDeviceLike[]>;
  requestDevice(options: { filters: Array<{ vendorId: number; productId?: number }> }): Promise<HIDDeviceLike[]>;
}

function getNavigatorHid(): NavigatorHIDLike | null {
  if (typeof navigator === "undefined") return null;
  const nav = navigator as unknown as { hid?: NavigatorHIDLike };
  return nav.hid ?? null;
}

function clampUnit(v: number): number {
  return Math.max(-1, Math.min(1, v));
}

/**
 * Parse a raw 3Dconnexion WebHID input report into normalized [-1, 1] axes or button bitmask.
 * Supports both classic 6-byte split reports (ID 1 = translation, ID 2 = rotation, ID 3 = buttons)
 * and modern 12-byte combined 6-DOF packets (ID 1 = tx,ty,tz,rx,ry,rz on Universal Receiver / BT / Enterprise).
 */
export function parseSpaceMouseReport(reportId: number, data: DataView): ParsedReport {
  if (reportId === 1) {
    if (data.byteLength >= 12) {
      return {
        translation: [
          clampUnit(data.getInt16(0, true) / HID_AXIS_SCALE),
          clampUnit(data.getInt16(2, true) / HID_AXIS_SCALE),
          clampUnit(data.getInt16(4, true) / HID_AXIS_SCALE),
        ],
        rotation: [
          clampUnit(data.getInt16(6, true) / HID_AXIS_SCALE),
          clampUnit(data.getInt16(8, true) / HID_AXIS_SCALE),
          clampUnit(data.getInt16(10, true) / HID_AXIS_SCALE),
        ],
      };
    }
    if (data.byteLength >= 6) {
      return {
        translation: [
          clampUnit(data.getInt16(0, true) / HID_AXIS_SCALE),
          clampUnit(data.getInt16(2, true) / HID_AXIS_SCALE),
          clampUnit(data.getInt16(4, true) / HID_AXIS_SCALE),
        ],
      };
    }
  } else if (reportId === 2 && data.byteLength >= 6) {
    return {
      rotation: [
        clampUnit(data.getInt16(0, true) / HID_AXIS_SCALE),
        clampUnit(data.getInt16(2, true) / HID_AXIS_SCALE),
        clampUnit(data.getInt16(4, true) / HID_AXIS_SCALE),
      ],
    };
  } else if (reportId === 3 && data.byteLength >= 1) {
    const buttons =
      data.byteLength >= 4
        ? data.getUint32(0, true)
        : data.byteLength >= 2
        ? data.getUint16(0, true)
        : data.getUint8(0);
    return { buttons };
  }
  return {};
}

export function applyDeadzoneCurve(v: number, deadzone = 0.045): number {
  const abs = Math.abs(v);
  if (abs <= deadzone) return 0;
  const scaled = (abs - deadzone) / (1 - deadzone);
  const curved = 0.45 * scaled + 0.55 * Math.pow(scaled, 2.2);
  return Math.sign(v) * curved;
}

const PREFS_KEY = "orca-spacemouse-prefs-v1";

export function loadSpaceMousePrefs(): SpaceMousePrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<SpaceMousePrefs>;
      return {
        sensitivity: typeof p.sensitivity === "number" ? Math.max(0.25, Math.min(2.5, p.sensitivity)) : 1.0,
        invertAxes: Boolean(p.invertAxes),
      };
    }
  } catch {
    // ignore
  }
  return { sensitivity: 1.0, invertAxes: false };
}

export function saveSpaceMousePrefs(prefs: SpaceMousePrefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // ignore
  }
}

const _offset = new THREE.Vector3();
const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _camUp = new THREE.Vector3();
const _panDelta = new THREE.Vector3();
const _worldUp = new THREE.Vector3(0, 0, 1);
const _quatYaw = new THREE.Quaternion();
const _quatPitch = new THREE.Quaternion();

/**
 * Apply 6-DOF SpaceMouse input cleanly to a Z-up CAD PerspectiveCamera + OrbitControls.
 * Returns true if the camera moved.
 */
export function applySpaceMouseToCamera(
  axes: SpaceMouseAxes,
  camera: THREE.PerspectiveCamera,
  controls: OrbitControls,
  dtSeconds: number,
  prefs: SpaceMousePrefs
): boolean {
  const tx = applyDeadzoneCurve(axes.tx);
  const ty = applyDeadzoneCurve(axes.ty);
  const tz = applyDeadzoneCurve(axes.tz);
  const rx = applyDeadzoneCurve(axes.rx);
  const rz = applyDeadzoneCurve(axes.rz);

  if (tx === 0 && ty === 0 && tz === 0 && rx === 0 && rz === 0) return false;

  const dt = Math.min(0.05, Math.max(0.001, dtSeconds));
  const dir = prefs.invertAxes ? -1 : 1;
  const sens = prefs.sensitivity;

  _offset.copy(camera.position).sub(controls.target);
  let dist = _offset.length();
  if (dist < 1e-3) dist = 1;

  // Compute camera local basis in Z-up world
  _forward.copy(_offset).negate().normalize();
  _right.crossVectors(_forward, _worldUp);
  if (_right.lengthSq() < 1e-6) _right.set(1, 0, 0);
  else _right.normalize();
  _camUp.crossVectors(_right, _forward).normalize();

  // 1. Pan (tx = horizontal slide, tz = vertical lift/push)
  const panSpeed = dist * 0.95 * sens * dt;
  _panDelta.set(0, 0, 0);
  _panDelta.addScaledVector(_right, tx * dir * panSpeed);
  _panDelta.addScaledVector(_camUp, -tz * dir * panSpeed);
  controls.target.add(_panDelta);
  camera.position.add(_panDelta);

  // 2. Dolly / Zoom along view ray (ty = push forward to zoom in, pull back to zoom out)
  if (ty !== 0) {
    const zoomFactor = Math.exp(ty * dir * 1.45 * sens * dt);
    const minDist = controls.minDistance || 20;
    const maxDist = controls.maxDistance || 1600;
    const nextDist = Math.max(minDist, Math.min(maxDist, dist * zoomFactor));
    _offset.setLength(nextDist);
    dist = nextDist;
  }

  // 3. Horizon-locked CAD Orbit (rz = yaw around world Z, rx = pitch around camera right)
  if (rz !== 0) {
    const yawAngle = -rz * dir * 1.9 * sens * dt;
    _quatYaw.setFromAxisAngle(_worldUp, yawAngle);
    _offset.applyQuaternion(_quatYaw);
  }
  if (rx !== 0) {
    _forward.copy(_offset).negate().normalize();
    _right.crossVectors(_forward, _worldUp);
    if (_right.lengthSq() > 1e-6) {
      _right.normalize();
      const pitchAngle = rx * dir * 1.65 * sens * dt;
      // Current polar angle from +Z
      const curPolar = Math.acos(Math.max(-1, Math.min(1, _offset.z / dist)));
      const nextPolar = Math.max(0.08, Math.min(Math.PI - 0.08, curPolar + pitchAngle));
      const clampedDelta = nextPolar - curPolar;
      _quatPitch.setFromAxisAngle(_right, clampedDelta);
      _offset.applyQuaternion(_quatPitch);
    }
  }

  camera.position.copy(controls.target).add(_offset);
  camera.lookAt(controls.target);
  return true;
}

export class SpaceMouseController {
  private device: HIDDeviceLike | null = null;
  private hidAxes: SpaceMouseAxes = { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 };
  private prevButtons = 0;
  private gamepadName: string | null = null;
  private listeners = new Set<(status: SpaceMouseStatus) => void>();
  private buttonListeners = new Set<(buttonIndex: number) => void>();
  private disposed = false;

  private onInputReport = (ev: Event) => {
    const e = ev as HIDInputReportEventLike;
    const parsed = parseSpaceMouseReport(e.reportId, e.data);
    if (parsed.translation) {
      this.hidAxes.tx = parsed.translation[0];
      this.hidAxes.ty = parsed.translation[1];
      this.hidAxes.tz = parsed.translation[2];
    }
    if (parsed.rotation) {
      this.hidAxes.rx = parsed.rotation[0];
      this.hidAxes.ry = parsed.rotation[1];
      this.hidAxes.rz = parsed.rotation[2];
    }
    if (parsed.buttons !== undefined) {
      const newlyPressed = parsed.buttons & ~this.prevButtons;
      this.prevButtons = parsed.buttons;
      if (newlyPressed) {
        for (let b = 0; b < 16; b++) {
          if (newlyPressed & (1 << b)) {
            this.buttonListeners.forEach((fn) => fn(b));
          }
        }
      }
    }
  };

  private onHidConnect = (ev: Event) => {
    const dev = (ev as unknown as { device?: HIDDeviceLike }).device;
    if (dev && !this.device && this.matchesFilter(dev)) {
      void this.attachDevice(dev);
    }
  };

  private onHidDisconnect = (ev: Event) => {
    const dev = (ev as unknown as { device?: HIDDeviceLike }).device;
    if (dev && this.device === dev) {
      this.detachDevice();
    }
  };

  constructor() {
    const hid = getNavigatorHid();
    if (hid) {
      hid.addEventListener("connect", this.onHidConnect);
      hid.addEventListener("disconnect", this.onHidDisconnect);
      // Auto-reconnect already-paired SpaceMouse without prompting
      void hid.getDevices().then((devices) => {
        if (this.disposed) return;
        const match = devices.find((d) => this.matchesFilter(d));
        if (match) void this.attachDevice(match);
      }).catch(() => {});
    }
  }

  private matchesFilter(dev: HIDDeviceLike): boolean {
    return SPACEMOUSE_HID_FILTERS.some(
      (f) => f.vendorId === dev.vendorId && (f.productId === undefined || f.productId === dev.productId)
    );
  }

  private async attachDevice(dev: HIDDeviceLike) {
    if (this.device === dev) return;
    this.detachDevice();
    try {
      if (!dev.opened) await dev.open();
      this.device = dev;
      this.hidAxes = { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 };
      this.prevButtons = 0;
      dev.addEventListener("inputreport", this.onInputReport);
      this.emitStatus();
    } catch {
      this.device = null;
      this.emitStatus();
    }
  }

  private detachDevice() {
    if (!this.device) return;
    try {
      this.device.removeEventListener("inputreport", this.onInputReport);
    } catch {
      // ignore
    }
    this.device = null;
    this.hidAxes = { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 };
    this.prevButtons = 0;
    this.emitStatus();
  }

  async connect(): Promise<SpaceMouseStatus> {
    const hid = getNavigatorHid();
    if (!hid) {
      throw new Error("WebHID is unavailable in this browser (use Chrome/Edge, or Gamepad mode via 3DxWare)");
    }
    const picked = await hid.requestDevice({ filters: SPACEMOUSE_HID_FILTERS });
    if (picked.length > 0) {
      await this.attachDevice(picked[0]);
    }
    return this.getStatus();
  }

  async disconnect(): Promise<void> {
    const dev = this.device;
    this.detachDevice();
    if (dev && dev.opened) {
      try {
        await dev.close();
      } catch {
        // ignore
      }
    }
  }

  /** Poll current 6-DOF axes (WebHID takes precedence, automatic Gamepad API fallback otherwise). */
  readAxes(): SpaceMouseAxes {
    if (this.device) {
      return this.hidAxes;
    }
    if (typeof navigator !== "undefined" && typeof navigator.getGamepads === "function") {
      const pads = navigator.getGamepads();
      for (const pad of pads) {
        if (!pad || !pad.connected || pad.axes.length < 6) continue;
        if (!GAMEPAD_MATCH.test(pad.id)) continue;
        if (this.gamepadName !== pad.id) {
          this.gamepadName = pad.id;
          this.emitStatus();
        }
        return {
          tx: clampUnit(pad.axes[0] || 0),
          ty: clampUnit(pad.axes[1] || 0),
          tz: clampUnit(pad.axes[2] || 0),
          rx: clampUnit(pad.axes[3] || 0),
          ry: clampUnit(pad.axes[4] || 0),
          rz: clampUnit(pad.axes[5] || 0),
        };
      }
      if (this.gamepadName !== null) {
        this.gamepadName = null;
        this.emitStatus();
      }
    }
    return { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 };
  }

  getStatus(): SpaceMouseStatus {
    if (this.device) {
      return {
        connected: true,
        source: "webhid",
        deviceName: this.device.productName || "3Dconnexion SpaceMouse",
        webHidSupported: true,
      };
    }
    if (this.gamepadName) {
      return {
        connected: true,
        source: "gamepad",
        deviceName: this.gamepadName,
        webHidSupported: Boolean(getNavigatorHid()),
      };
    }
    return {
      connected: false,
      source: null,
      deviceName: null,
      webHidSupported: Boolean(getNavigatorHid()),
    };
  }

  onStatusChange(fn: (status: SpaceMouseStatus) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onButtonPress(fn: (buttonIndex: number) => void): () => void {
    this.buttonListeners.add(fn);
    return () => this.buttonListeners.delete(fn);
  }

  private emitStatus() {
    const st = this.getStatus();
    this.listeners.forEach((fn) => fn(st));
  }

  dispose() {
    this.disposed = true;
    const hid = getNavigatorHid();
    if (hid) {
      hid.removeEventListener("connect", this.onHidConnect);
      hid.removeEventListener("disconnect", this.onHidDisconnect);
    }
    this.detachDevice();
    this.listeners.clear();
    this.buttonListeners.clear();
  }
}

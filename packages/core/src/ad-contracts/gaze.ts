/**
 * GazeSample (L0 input): one gaze estimate from an on-device tracker. Numbers and booleans only;
 * a tracker never produces, stores or sends an image.
 *
 * Coordinates: screen points (iOS UIKit points; on the Mac, CSS px of the BrowserWindow content area,
 * which is the Mac tracker's "screen"). Origin = top-left of the screen in the CURRENT interface
 * orientation, +x right, +y down. Not clamped: gaze off the screen gives values outside
 * [0,width) x [0,height). Convert to webview CSS px with ScreenInfo.webview (subtract its origin;
 * on iOS 1 CSS px = 1 point at page zoom 1).
 */
export type GazeSrc = "arkit" | "mediapipe" | "synthetic" | "replay";

export interface HeadPose {
  /** degrees, + = face turned toward the screen's +x (right) edge */
  yaw: number;
  /** degrees, + = face turned toward the screen's top (-y) edge */
  pitch: number;
  /** degrees, + = head tilted clockwise as seen by the person looking at the screen */
  roll: number;
  /** cm from the screen plane to the midpoint between the eyes */
  distCm: number;
}

export interface GazeSample {
  /** ms on the web layer's monotonic clock (performance.now()); native trackers anchor it via syncClock() */
  t: number;
  /** screen points; null when there is no estimate (no face, tracking lost) */
  x: number | null;
  y: number | null;
  /** 0..1 tracker confidence; 0 whenever x/y are null */
  conf: number;
  /** a face was detected in this frame */
  face: boolean;
  /** both eyes closed: ARKit eyeBlinkLeft and eyeBlinkRight > 0.5; MediaPipe: eye aspect ratio under the tracker threshold */
  blink: boolean;
  /** optional per-eye closure 0..1 (ARKit eyeBlink blendshapes / MediaPipe 1 - normalized EAR) */
  lids?: { l: number; r: number };
  /** head pose; omitted when face is false */
  head?: HeadPose;
  /** true once a calibration model has been applied to x/y (by the tracker or by core L0) */
  cal: boolean;
  src: GazeSrc;
}

/** nominal tracker output rates */
export const GAZE_HZ_NORMAL = 30 as const;
/** rate when hot: iOS ProcessInfo.thermalState serious or critical (health code gaze.thermal_degraded) */
export const GAZE_HZ_HOT = 15 as const;
export type GazeHz = typeof GAZE_HZ_NORMAL | typeof GAZE_HZ_HOT;

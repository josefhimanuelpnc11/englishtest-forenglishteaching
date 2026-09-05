/**
 * Pure gaze math for the Phase 1 eye-tracking sensor.
 *
 * No DOM, no MediaPipe imports — every function here
 * is unit-testable with synthetic landmarks.
 *
 * Polarity note (critical): each eye's horizontal
 * ratio rises toward its OWN nose, i.e. opposite
 * world directions. Real gaze moves both irises the
 * SAME image direction (conjugate movement), so a
 * naive average of the two raw ratios cancels real
 * left/right gaze out. The combination below first
 * expresses both eyes in one common frame
 * (1 - right) and only then averages. Vertical
 * ratios share one polarity and average directly.
 * Calibration absorbs any remaining global flip
 * (mirrored pipelines), because dots map ratios to
 * screen points empirically.
 */

/**
 * MediaPipe FaceMesh refined landmark indices.
 */
export const LEFT_EYE = {
  outer: 33,
  inner: 133,
  top: 159,
  bottom: 145,
  irisStart: 468,
  irisEnd: 472,
} as const;

export const RIGHT_EYE = {
  outer: 362,
  inner: 263,
  top: 386,
  bottom: 374,
  irisStart: 473,
  irisEnd: 477,
} as const;

export const EXPECTED_LANDMARK_COUNT = 478;

export interface Point2D {
  x: number;
  y: number;
}

/**
 * Raw gaze ratio for one frame, roughly in [0, 1].
 * hx: 0 = iris at outer corner, 1 = at inner corner.
 * hy: 0 = iris at upper lid, 1 = at lower lid.
 */
export interface EyeGazeRatio {
  hx: number;
  hy: number;
}

export interface GazeReferences {
  center: EyeGazeRatio;
  xRadius: number;
  yRadius: number;
}

/**
 * Normalized gaze point, roughly in [-1, 1].
 * (0, 0) = looking at the calibrated screen center.
 */
export interface GazePoint {
  nx: number;
  ny: number;
}

export interface CalibrationDot {
  x: number;
  y: number;
}

/**
 * Five fullscreen calibration targets in viewport
 * fractions: true screen corners (inset for
 * notches) plus the center. Index 0 is always the
 * center — it anchors the personal references.
 *
 * Fullscreen matters: calibrating inside a small
 * box compresses the ratio range so much that live
 * exam-page gaze (full screen) maps wrongly.
 */
export const CALIBRATION_DOTS: CalibrationDot[] =
  [
    { x: 0.5, y: 0.5 },
    { x: 0.08, y: 0.12 },
    { x: 0.92, y: 0.12 },
    { x: 0.08, y: 0.88 },
    { x: 0.92, y: 0.88 },
  ];

const MIN_DENOMINATOR = 1e-6;
const MIN_RADIUS = 1e-3;

/**
 * Minimum measured ratio spread across dots.
 * Below this the eyes demonstrably did not move
 * (staring through all dots, or broken tracking)
 * and the fit is rejected so a bad calibration can
 * never silently pass.
 */
const MIN_CALIBRATION_SPREAD = 0.03;
const MAP_CLAMP = 1.2;

export function averagePoint(
  points: Point2D[],
): Point2D {
  let x = 0;
  let y = 0;

  for (const point of points) {
    x += point.x;
    y += point.y;
  }

  const count = Math.max(points.length, 1);

  return {
    x: x / count,
    y: y / count,
  };
}

/**
 * Iris center as the mean of the 5 iris landmarks.
 * Averaging (instead of trusting a single "center"
 * index) is robust to per-index documentation drift.
 */
export function irisCenter(
  landmarks: Point2D[],
  start: number,
  end: number,
): Point2D | null {
  if (
    !Array.isArray(landmarks) ||
    landmarks.length <= end ||
    start < 0 ||
    end < start
  ) {
    return null;
  }

  const points: Point2D[] = [];

  for (let i = start; i <= end; i += 1) {
    const landmark = landmarks[i];

    if (
      !landmark ||
      !Number.isFinite(landmark.x) ||
      !Number.isFinite(landmark.y)
    ) {
      return null;
    }

    points.push(landmark);
  }

  if (points.length === 0) {
    return null;
  }

  return averagePoint(points);
}

interface EyeIndices {
  outer: number;
  inner: number;
  top: number;
  bottom: number;
  irisStart: number;
  irisEnd: number;
}

function eyeRatio(
  landmarks: Point2D[],
  eye: EyeIndices,
): EyeGazeRatio | null {
  const outer = landmarks[eye.outer];
  const inner = landmarks[eye.inner];
  const top = landmarks[eye.top];
  const bottom = landmarks[eye.bottom];

  if (
    !outer ||
    !inner ||
    !top ||
    !bottom
  ) {
    return null;
  }

  const center = irisCenter(
    landmarks,
    eye.irisStart,
    eye.irisEnd,
  );

  if (!center) {
    return null;
  }

  const horizontalSpan =
    inner.x - outer.x;

  const verticalSpan =
    bottom.y - top.y;

  if (
    Math.abs(horizontalSpan) <
      MIN_DENOMINATOR ||
    Math.abs(verticalSpan) <
      MIN_DENOMINATOR
  ) {
    return null;
  }

  return {
    hx: (center.x - outer.x) / horizontalSpan,
    hy: (center.y - top.y) / verticalSpan,
  };
}

/**
 * Combined per-frame gaze ratio, or null when either
 * eye is unmeasurable (blink, occlusion, glare).
 */
export function combinedGazeRatio(
  landmarks: Point2D[],
): EyeGazeRatio | null {
  if (
    !Array.isArray(landmarks) ||
    landmarks.length <
      EXPECTED_LANDMARK_COUNT
  ) {
    return null;
  }

  const left = eyeRatio(
    landmarks,
    LEFT_EYE,
  );

  const right = eyeRatio(
    landmarks,
    RIGHT_EYE,
  );

  if (!left || !right) {
    return null;
  }

  return {
    // Shared frame: mirror the right eye before
    // averaging so conjugate (same-direction)
    // movements add up instead of cancelling.
    hx: (left.hx + (1 - right.hx)) / 2,
    hy: (left.hy + right.hy) / 2,
  };
}

export interface CalibrationSample {
  dotIndex: number;
  ratio: EyeGazeRatio;
}

/**
 * Fits personal references from calibration samples.
 * Requires at least one sample on the center dot
 * (index 0) AND a minimum measured eye-movement
 * spread — a fit over motionless samples is
 * rejected (returns null) instead of producing a
 * degenerate mapping that misreads all live gaze.
 */
export function fitCalibration(
  samples: CalibrationSample[],
): GazeReferences | null {
  const centerSamples = samples.filter(
    (sample) => sample.dotIndex === 0,
  );

  if (
    samples.length === 0 ||
    centerSamples.length === 0
  ) {
    return null;
  }

  const center = averageRatio(
    centerSamples.map(
      (sample) => sample.ratio,
    ),
  );

  let minHx = center.hx;
  let maxHx = center.hx;
  let minHy = center.hy;
  let maxHy = center.hy;

  for (const sample of samples) {
    minHx = Math.min(minHx, sample.ratio.hx);
    maxHx = Math.max(maxHx, sample.ratio.hx);
    minHy = Math.min(minHy, sample.ratio.hy);
    maxHy = Math.max(maxHy, sample.ratio.hy);
  }

  const spreadX = Math.max(
    center.hx - minHx,
    maxHx - center.hx,
  );

  const spreadY = Math.max(
    center.hy - minHy,
    maxHy - center.hy,
  );

  if (
    spreadX < MIN_CALIBRATION_SPREAD ||
    spreadY < MIN_CALIBRATION_SPREAD
  ) {
    return null;
  }

  return {
    center,
    xRadius: Math.max(spreadX, MIN_RADIUS),
    yRadius: Math.max(spreadY, MIN_RADIUS),
  };
}

export function averageRatio(
  ratios: EyeGazeRatio[],
): EyeGazeRatio {
  let hx = 0;
  let hy = 0;

  for (const ratio of ratios) {
    hx += ratio.hx;
    hy += ratio.hy;
  }

  const count = Math.max(ratios.length, 1);

  return {
    hx: hx / count,
    hy: hy / count,
  };
}

/**
 * Maps a live ratio into normalized gaze space
 * using personal references.
 */
export function mapGaze(
  ratio: EyeGazeRatio,
  references: GazeReferences,
): GazePoint {
  return {
    nx: clamp(
      (ratio.hx - references.center.hx) /
        references.xRadius,
    ),
    ny: clamp(
      (ratio.hy - references.center.hy) /
        references.yRadius,
    ),
  };
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(
    -MAP_CLAMP,
    Math.min(MAP_CLAMP, value),
  );
}

/**
 * Scalar deviation from calibrated center.
 * Phase 2 will threshold this for LOOK_AWAY.
 */
export function gazeDeviation(
  point: GazePoint,
): number {
  return Math.hypot(point.nx, point.ny);
}

export interface RatioVariance {
  vx: number;
  vy: number;
}

/**
 * Population variance of a sample batch.
 * Used to reject shaky calibration samples
 * (student moved mid-dot).
 */
export function ratioVariance(
  ratios: EyeGazeRatio[],
): RatioVariance {
  if (ratios.length === 0) {
    return { vx: 0, vy: 0 };
  }

  const mean = averageRatio(ratios);

  let vx = 0;
  let vy = 0;

  for (const ratio of ratios) {
    vx += (ratio.hx - mean.hx) ** 2;
    vy += (ratio.hy - mean.hy) ** 2;
  }

  return {
    vx: vx / ratios.length,
    vy: vy / ratios.length,
  };
}

export function isStableBatch(
  ratios: EyeGazeRatio[],
  maxVariance: number,
): boolean {
  if (ratios.length < 2) {
    return false;
  }

  const variance = ratioVariance(ratios);

  return (
    variance.vx <= maxVariance &&
    variance.vy <= maxVariance
  );
}

export interface DotDiagnostic {
  dotIndex: number;
  samples: number;
  meanHx: number;
  meanHy: number;
}

export interface FitDiagnostics {
  spreadX: number;
  spreadY: number;
  minSpread: number;
  centerPresent: boolean;
  dots: DotDiagnostic[];
}

/**
 * Explains a fit in numbers: per-dot sample counts
 * and means plus the spreads the gate judges.
 * Shown on the calibration error screen so a failed
 * run reports WHY it failed (frozen identical values
 * vs genuinely tiny eye movement), instead of only
 * "perbaiki pencahayaan".
 */
export function describeFit(
  samples: CalibrationSample[],
  dotCount: number,
): FitDiagnostics {
  const dots: DotDiagnostic[] = [];

  for (
    let dotIndex = 0;
    dotIndex < dotCount;
    dotIndex += 1
  ) {
    const ratios = samples
      .filter(
        (sample) =>
          sample.dotIndex === dotIndex,
      )
      .map(
        (sample): EyeGazeRatio =>
          sample.ratio,
      );

    const mean =
      ratios.length > 0
        ? averageRatio(ratios)
        : { hx: NaN, hy: NaN };

    dots.push({
      dotIndex,
      samples: ratios.length,
      meanHx: mean.hx,
      meanHy: mean.hy,
    });
  }

  const centerPresent = samples.some(
    (sample) => sample.dotIndex === 0,
  );

  const centerMean =
    centerPresent
      ? averageRatio(
          samples
            .filter(
              (sample) =>
                sample.dotIndex === 0,
            )
            .map(
              (sample): EyeGazeRatio =>
                sample.ratio,
            ),
        )
      : { hx: NaN, hy: NaN };

  let minHx = centerMean.hx;
  let maxHx = centerMean.hx;
  let minHy = centerMean.hy;
  let maxHy = centerMean.hy;

  for (const sample of samples) {
    minHx = Math.min(minHx, sample.ratio.hx);
    maxHx = Math.max(maxHx, sample.ratio.hx);
    minHy = Math.min(minHy, sample.ratio.hy);
    maxHy = Math.max(maxHy, sample.ratio.hy);
  }

  return {
    spreadX: Math.max(
      centerMean.hx - minHx,
      maxHx - centerMean.hx,
    ),
    spreadY: Math.max(
      centerMean.hy - minHy,
      maxHy - centerMean.hy,
    ),
    minSpread: MIN_CALIBRATION_SPREAD,
    centerPresent,
    dots,
  };
}

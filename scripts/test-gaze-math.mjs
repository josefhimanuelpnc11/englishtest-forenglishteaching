// Temporary sanity test for gazeMath (deleted after verification).
import {
  CALIBRATION_DOTS,
  combinedGazeRatio,
  fitCalibration,
  gazeDeviation,
  isStableBatch,
  mapGaze,
  ratioVariance,
} from "../src/services/gaze/gazeMath.ts";

let failures = 0;

function check(name, actual, expected, tolerance = 1e-9) {
  const ok = Math.abs(actual - expected) <= tolerance;
  if (!ok) {
    failures += 1;
    console.error(
      `FAIL ${name}: got ${actual}, want ${expected}`,
    );
  } else {
    console.log(`ok ${name}`);
  }
}

function blankLandmarks() {
  return Array.from({ length: 478 }, () => ({
    x: 0,
    y: 0,
  }));
}

function paintEye(lm, eye, irisCx, irisCy) {
  const midX = (eye.outerX + eye.innerX) / 2;
  lm[eye.outer] = { x: eye.outerX, y: 0.5 };
  lm[eye.inner] = { x: eye.innerX, y: 0.5 };
  lm[eye.top] = { x: midX, y: 0.48 };
  lm[eye.bottom] = { x: midX, y: 0.52 };
  for (let i = eye.irisStart; i <= eye.irisEnd; i += 1) {
    lm[i] = { x: irisCx, y: irisCy };
  }
}

const LEFT = {
  outer: 33,
  inner: 133,
  top: 159,
  bottom: 145,
  irisStart: 468,
  irisEnd: 472,
  outerX: 0.3,
  innerX: 0.4,
};
const RIGHT = {
  outer: 362,
  inner: 263,
  top: 386,
  bottom: 374,
  irisStart: 473,
  irisEnd: 477,
  outerX: 0.7,
  innerX: 0.6,
};

// 1. Centered gaze -> (0.5, 0.5)
{
  const lm = blankLandmarks();
  paintEye(lm, LEFT, 0.35, 0.5);
  paintEye(lm, RIGHT, 0.65, 0.5);
  const r = combinedGazeRatio(lm);
  check("center hx", r.hx, 0.5);
  check("center hy", r.hy, 0.5);
}

// 2. Iris toward inner corners -> hx 0.8 both eyes
{
  const lm = blankLandmarks();
  paintEye(lm, LEFT, 0.38, 0.5);
  paintEye(lm, RIGHT, 0.62, 0.5);
  const r = combinedGazeRatio(lm);
  check("shifted hx", r.hx, 0.8);
  check("shifted hy", r.hy, 0.5);
}

// 3. Short array -> null
{
  const r = combinedGazeRatio([{ x: 0, y: 0 }]);
  check("short array null", r === null ? 1 : 0, 1);
}

// 4. NaN iris -> null
{
  const lm = blankLandmarks();
  paintEye(lm, LEFT, NaN, 0.5);
  paintEye(lm, RIGHT, 0.65, 0.5);
  const r = combinedGazeRatio(lm);
  check("nan iris null", r === null ? 1 : 0, 1);
}

// 5. Calibration fit + mapping
{
  check("dot count", CALIBRATION_DOTS.length, 5);
  const samples = [
    { dotIndex: 0, ratio: { hx: 0.5, hy: 0.5 } },
    { dotIndex: 0, ratio: { hx: 0.51, hy: 0.49 } },
    { dotIndex: 1, ratio: { hx: 0.35, hy: 0.35 } },
    { dotIndex: 2, ratio: { hx: 0.65, hy: 0.35 } },
    { dotIndex: 3, ratio: { hx: 0.35, hy: 0.65 } },
    { dotIndex: 4, ratio: { hx: 0.65, hy: 0.65 } },
  ];
  const refs = fitCalibration(samples);
  check("refs center hx", refs.center.hx, 0.505);
  check("refs xRadius", refs.xRadius, 0.155, 1e-9);
  const p = mapGaze({ hx: 0.505, hy: 0.495 }, refs);
  check("mapped center nx", p.nx, 0);
  check("mapped center ny", p.ny, 0);
  const corner = mapGaze({ hx: 0.65, hy: 0.35 }, refs);
  const expectedCorner = 0.145 / 0.155;
  check("mapped corner nx", corner.nx, expectedCorner, 1e-9);
  check("mapped corner ny", corner.ny, -expectedCorner, 1e-9);
  check(
    "deviation",
    gazeDeviation(corner),
    expectedCorner * Math.SQRT2,
    1e-9,
  );
}

// 6. No center dot -> null
{
  const refs = fitCalibration([
    { dotIndex: 1, ratio: { hx: 0.3, hy: 0.3 } },
  ]);
  check("no-center null", refs === null ? 1 : 0, 1);
}

// 7. Variance + stability
{
  const steady = [
    { hx: 0.5, hy: 0.5 },
    { hx: 0.5, hy: 0.5 },
    { hx: 0.5, hy: 0.5 },
  ];
  const v = ratioVariance(steady);
  check("steady var", v.vx + v.vy, 0);
  check(
    "steady stable",
    isStableBatch(steady, 1e-6) ? 1 : 0,
    1,
  );
  const shaky = [
    { hx: 0.45, hy: 0.5 },
    { hx: 0.55, hy: 0.5 },
  ];
  check(
    "shaky unstable",
    isStableBatch(shaky, 1e-4) ? 1 : 0,
    0,
  );
  check(
    "single unstable",
    isStableBatch([{ hx: 0.5, hy: 0.5 }], 1) ? 1 : 0,
    0,
  );
}

if (failures > 0) {
  console.error(`${failures} FAILURES`);
  process.exit(1);
}
console.log("all gaze math checks passed");

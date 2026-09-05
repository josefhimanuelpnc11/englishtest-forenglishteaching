
import * as ort from "onnxruntime-web";

import type { FaceMonitorStatus } from "./types";

type FaceViolationCallback = (
  type: "NO_FACE" | "MULTIPLE_FACE",
  metadata?: Record<string, unknown>,
) => void;

interface FaceDetectionBox {
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
  score: number;
  width: number;
  height: number;
  area: number;
}

export interface OnnxFaceMonitorOptions {
  modelUrl?: string;
  wasmBasePath?: string;

  inputWidth?: number;
  inputHeight?: number;

  /**
   * First-stage raw confidence threshold.
   *
   * Candidates below this value are ignored
   * before valid-face filtering.
   */
  scoreThreshold?: number;

  /**
   * Final confidence threshold.
   *
   * A detection must pass this threshold
   * to be considered a valid face.
   */
  validFaceScoreThreshold?: number;

  /**
   * Hard NMS IoU threshold.
   */
  nmsThreshold?: number;

  /**
   * Number of positive evidence cycles required
   * before NO_FACE becomes a violation.
   *
   * Default: 3
   */
  noFaceEvidenceThreshold?: number;

  /**
   * Number of positive evidence cycles required
   * before MULTIPLE_FACE becomes a violation.
   *
   * Default: 3
   */
  multipleFaceEvidenceThreshold?: number;

  /**
   * Evidence added on a confirmed NO_FACE cycle.
   *
   * Default: 1
   */
  noFaceEvidenceIncrement?: number;

  /**
   * Evidence removed when a valid face is detected.
   *
   * Default: 2
   */
  noFaceRecoveryDecrement?: number;

  /**
   * Evidence added on a confirmed MULTIPLE_FACE cycle.
   *
   * Default: 1
   */
  multipleFaceEvidenceIncrement?: number;

  /**
   * Evidence removed when fewer than 2 valid faces
   * are detected.
   *
   * Default: 1
   */
  multipleFaceRecoveryDecrement?: number;

  /**
   * Delay between inference cycles.
   *
   * Default: 900 ms
   */
  intervalMs?: number;

  /**
   * Per-cycle status listener.
   *
   * Called after every inference cycle (and after
   * every inference error) so the UI can show
   * live what the model currently detects.
   */
  onStatus?: (status: FaceMonitorStatus) => void;

  /**
   * Minimum normalized face width.
   */
  minFaceWidth?: number;

  /**
   * Minimum normalized face height.
   */
  minFaceHeight?: number;

  /**
   * Minimum normalized face area.
   */
  minFaceArea?: number;

  /**
   * Horizontal center range.
   *
   * These are deliberately permissive.
   */
  minBoxCenterX?: number;
  maxBoxCenterX?: number;

  /**
   * Vertical center range.
   *
   * These are deliberately permissive.
   */
  minBoxCenterY?: number;
  maxBoxCenterY?: number;
}

const DEFAULT_MODEL_URL =
  "/models/version-RFB-320_without_postprocessing.onnx";

/**
 * ONNX Runtime WASM binary location.
 *
 * Pinned CDN (same version as the installed npm
 * package). A local copy under /public cannot be
 * used here: the JSEP loader is pulled in through a
 * dynamic `import()`, and Vite's dev server refuses
 * to transform-import files from /public (HTTP 500),
 * so local hosting only works in production builds.
 */
const DEFAULT_WASM_BASE_PATH =
  "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.29.0/dist/";

const CENTER_VARIANCE = 0.1;
const SIZE_VARIANCE = 0.2;

const STRIDES = [8, 16, 32, 64];

const MIN_BOXES = [
  [10, 16, 24],
  [32, 48],
  [64, 96],
  [128, 192, 256],
];

/**
 * ONNX Runtime Web configuration.
 *
 * Conservative browser settings.
 */
ort.env.wasm.numThreads = 1;
ort.env.wasm.simd = true;
ort.env.wasm.proxy = false;
ort.env.logLevel = "warning";

export class OnnxFaceMonitor {
  private readonly callback: FaceViolationCallback;
  private readonly options: Required<OnnxFaceMonitorOptions>;

  private readonly videoElement: HTMLVideoElement;
  private readonly canvasElement: HTMLCanvasElement;
  private readonly canvasContext: CanvasRenderingContext2D;

  private readonly priors: Float32Array;

  private session: ort.InferenceSession | null = null;
  private sessionReady: Promise<void> | null = null;

  private timerHandle: number | null = null;

  private active = false;

  /**
   * ==========================================
   * NO_FACE TEMPORAL STATE
   * ==========================================
   *
   * Evidence increases when zero valid faces
   * are detected.
   *
   * Evidence decreases when a valid face returns.
   */
  private noFaceEvidence = 0;

  /**
   * Prevent repeated callbacks while the same
   * continuous NO_FACE episode is still active.
   */
  private noFaceReported = false;

  /**
   * ==========================================
   * MULTIPLE_FACE TEMPORAL STATE
   * ==========================================
   *
   * Evidence increases when 2+ valid faces
   * are detected.
   *
   * Evidence decreases when fewer than 2
   * valid faces are detected.
   */
  private multipleFaceEvidence = 0;

  /**
   * Prevent repeated callbacks while the same
   * MULTIPLE_FACE episode is active.
   */
  private multipleFaceReported = false;

  /**
   * Number of inference cycles.
   */
  private inferenceCount = 0;

  /**
   * Consecutive inference failures.
   *
   * Technical errors never count as NO_FACE, but a
   * monitor that fails on every cycle is dead — so
   * this counter escalates to a loud error log
   * instead of failing silently forever.
   */
  private consecutiveErrors = 0;

  constructor(
    stream: MediaStream,
    callback: FaceViolationCallback,
    options: OnnxFaceMonitorOptions = {},
  ) {
    this.callback = callback;

    this.options = {
      modelUrl:
        options.modelUrl ??
        DEFAULT_MODEL_URL,

      wasmBasePath:
        options.wasmBasePath ??
        DEFAULT_WASM_BASE_PATH,

      inputWidth:
        options.inputWidth ??
        320,

      inputHeight:
        options.inputHeight ??
        240,

      /**
       * Raw detector threshold.
       */
      scoreThreshold:
        options.scoreThreshold ??
        0.70,

      /**
       * Valid-face threshold.
       */
      validFaceScoreThreshold:
        options.validFaceScoreThreshold ??
        0.72,

      /**
       * Hard NMS.
       */
      nmsThreshold:
        options.nmsThreshold ??
        0.30,

      /**
       * ======================================
       * NO_FACE EVIDENCE
       * ======================================
       *
       * 3 positive cycles with 900 ms interval
       * is approximately 2.7 seconds of evidence.
       */
      noFaceEvidenceThreshold:
        options.noFaceEvidenceThreshold ??
        3,

      noFaceEvidenceIncrement:
        options.noFaceEvidenceIncrement ??
        1,

      noFaceRecoveryDecrement:
        options.noFaceRecoveryDecrement ??
        2,

      /**
       * ======================================
       * MULTIPLE_FACE EVIDENCE
       * ======================================
       *
       * 3 positive cycles with 900 ms interval
       * is approximately 2.7 seconds of evidence.
       */
      multipleFaceEvidenceThreshold:
        options.multipleFaceEvidenceThreshold ??
        3,

      multipleFaceEvidenceIncrement:
        options.multipleFaceEvidenceIncrement ??
        1,

      multipleFaceRecoveryDecrement:
        options.multipleFaceRecoveryDecrement ??
        1,

      /**
       * Inference interval.
       */
      intervalMs:
        options.intervalMs ??
        900,

      /**
       * ======================================
       * VALID FACE FILTERING
       * ======================================
       */

      minFaceWidth:
        options.minFaceWidth ??
        0.08,

      minFaceHeight:
        options.minFaceHeight ??
        0.08,

      minFaceArea:
        options.minFaceArea ??
        0.008,

      /**
       * Keep the center filter permissive.
       *
       * We do not want a normal person moving
       * slightly toward the camera edge to
       * instantly become NO_FACE.
       */
      minBoxCenterX:
        options.minBoxCenterX ??
        0.03,

      maxBoxCenterX:
        options.maxBoxCenterX ??
        0.97,

      minBoxCenterY:
        options.minBoxCenterY ??
        0.03,

      maxBoxCenterY:
        options.maxBoxCenterY ??
        0.97,

      onStatus:
        options.onStatus ??
        (() => undefined),
    };

    /**
     * Configure ONNX Runtime WASM path.
     */
    ort.env.wasm.wasmPaths =
      this.options.wasmBasePath;

    /**
     * ==========================================
     * VIDEO ELEMENT
     * ==========================================
     */
    this.videoElement =
      document.createElement("video");

    this.videoElement.autoplay = true;
    this.videoElement.muted = true;
    this.videoElement.playsInline = true;
    this.videoElement.srcObject = stream;

    /**
     * ==========================================
     * CANVAS
     * ==========================================
     *
     * RFB-320 expects a 320 x 240 input.
     */
    this.canvasElement =
      document.createElement("canvas");

    this.canvasElement.width =
      this.options.inputWidth;

    this.canvasElement.height =
      this.options.inputHeight;

    const context =
      this.canvasElement.getContext(
        "2d",
        {
          willReadFrequently: true,
        },
      );

    if (!context) {
      throw new Error(
        "Canvas 2D context is unavailable.",
      );
    }

    this.canvasContext = context;

    /**
     * ==========================================
     * PRIOR BOXES
     * ==========================================
     */
    this.priors =
      this.generatePriors(
        this.options.inputWidth,
        this.options.inputHeight,
      );

    console.log(
      "[FACE MONITOR] Priors generated:",
      this.priors.length / 4,
    );
  }

  /**
   * ============================================
   * START
   * ============================================
   */
  async start(): Promise<void> {
    if (this.active) {
      console.warn(
        "[FACE MONITOR] Already active.",
      );

      return;
    }

    this.active = true;

    try {
      console.log(
        "[FACE MONITOR] Starting...",
      );

      await this.waitForVideoReady();

      console.log(
        "[FACE MONITOR] Video ready:",
        {
          videoWidth:
            this.videoElement.videoWidth,

          videoHeight:
            this.videoElement.videoHeight,

          readyState:
            this.videoElement.readyState,
        },
      );

      await this.videoElement.play();

      /**
       * SharedArrayBuffer (cross-origin isolation)
       * is required by the threaded WASM binary.
       * Logged here so a missing isolation setup is
       * visible immediately instead of surfacing as
       * a cryptic session-creation failure below.
       */
      console.log(
        "[FACE MONITOR] Environment:",
        {
          crossOriginIsolated:
            window.crossOriginIsolated === true,

          hardwareConcurrency:
            navigator.hardwareConcurrency,
        },
      );

      await this.ensureSession();

      if (!this.session) {
        throw new Error(
          "ONNX session was not created.",
        );
      }

      /**
       * Reset all temporal state before starting.
       */
      this.resetFaceStates();

      console.log(
        "[FACE MONITOR] Monitoring started.",
      );

      void this.runLoop();
    } catch (error) {
      this.active = false;

      console.error(
        "[FACE MONITOR] Startup failed:",
        error,
      );

      throw error;
    }
  }

  /**
   * ============================================
   * STOP
   * ============================================
   */
  stop(): void {
    this.active = false;

    if (
      this.timerHandle !== null
    ) {
      window.clearTimeout(
        this.timerHandle,
      );

      this.timerHandle = null;
    }

    this.videoElement.pause();
    this.videoElement.srcObject = null;

    this.resetFaceStates();

    console.log(
      "[FACE MONITOR] Stopped.",
    );
  }

  /**
   * ============================================
   * RESET TEMPORAL STATE
   * ============================================
   */
  private resetFaceStates(): void {
    this.noFaceEvidence = 0;
    this.noFaceReported = false;

    this.multipleFaceEvidence = 0;
    this.multipleFaceReported = false;

    this.consecutiveErrors = 0;
  }

  /**
   * ============================================
   * LIVE STATUS SNAPSHOT
   * ============================================
   *
   * Emitted after every inference cycle so the UI
   * can display exactly what the model currently
   * detects (face count, top confidence, evidence
   * progress, error state).
   */
  private emitStatus(
    detections: FaceDetectionBox[],
  ): void {
    this.options.onStatus({
      faceCount: detections.length,

      topScore:
        detections[0]?.score ?? 0,

      noFaceEvidence:
        this.noFaceEvidence,

      noFaceEvidenceThreshold:
        this.options
          .noFaceEvidenceThreshold,

      multipleFaceEvidence:
        this.multipleFaceEvidence,

      multipleFaceEvidenceThreshold:
        this.options
          .multipleFaceEvidenceThreshold,

      consecutiveInferenceErrors:
        this.consecutiveErrors,

      inferenceCount:
        this.inferenceCount,
    });
  }

  /**
   * ============================================
   * ONNX SESSION INITIALIZATION
   * ============================================
   */
  private async ensureSession(): Promise<void> {
    if (this.session) {
      return;
    }

    if (this.sessionReady) {
      return this.sessionReady;
    }

    this.sessionReady =
      this.initializeSession();

    try {
      await this.sessionReady;
    } catch (error) {
      this.sessionReady = null;

      throw error;
    }
  }

  /**
   * ============================================
   * CREATE ONNX SESSION
   * ============================================
   */
  private async initializeSession(): Promise<void> {
    try {
      console.log(
        "[FACE MONITOR] Creating ONNX inference session...",
      );

      console.log(
        "[FACE MONITOR] Runtime configuration:",
        {
          numThreads:
            ort.env.wasm.numThreads,

          simd:
            ort.env.wasm.simd,

          proxy:
            ort.env.wasm.proxy,

          modelUrl:
            this.options.modelUrl,

          wasmBasePath:
            this.options.wasmBasePath,

          crossOriginIsolated:
            window.crossOriginIsolated ===
            true,
        },
      );

      const response =
        await fetch(
          this.options.modelUrl,
          {
            cache: "no-store",
          },
        );

      if (!response.ok) {
        throw new Error(
          `Failed to fetch ONNX model. HTTP ${response.status}`,
        );
      }

      const modelBuffer =
        await response.arrayBuffer();

      console.log(
        "[FACE MONITOR] Model downloaded:",
        {
          bytes:
            modelBuffer.byteLength,
        },
      );

      if (
        modelBuffer.byteLength <
        1024
      ) {
        throw new Error(
          "ONNX model appears to be invalid or empty.",
        );
      }

      this.session =
        await ort.InferenceSession.create(
          new Uint8Array(
            modelBuffer,
          ),
          {
            executionProviders: [
              "wasm",
            ],

            /**
             * Keep disabled because the
             * current model reports initializers
             * as graph inputs.
             */
            graphOptimizationLevel:
              "disabled",

            executionMode:
              "sequential",
          },
        );

      console.log(
        "[FACE MONITOR] ONNX SESSION READY",
      );

      console.log(
        "[FACE MONITOR] Input names:",
        this.session.inputNames,
      );

      console.log(
        "[FACE MONITOR] Output names:",
        this.session.outputNames,
      );

      try {
        console.log(
          "[FACE MONITOR] Input metadata:",
          this.session.inputMetadata,
        );

        console.log(
          "[FACE MONITOR] Output metadata:",
          this.session.outputMetadata,
        );
      } catch {
        /**
         * Metadata is diagnostic only.
         */
      }
    } catch (error) {
      this.session = null;

      console.error(
        "[FACE MONITOR] FAILED TO CREATE ONNX SESSION:",
        error,
      );

      throw error;
    }
  }

  /**
   * ============================================
   * MAIN INFERENCE LOOP
   * ============================================
   */
  private async runLoop(): Promise<void> {
    if (
      !this.active ||
      !this.session
    ) {
      return;
    }

    try {
      this.inferenceCount += 1;

      const detections =
        await this.detectFaces();

      const faceCount =
        detections.length;

      this.consecutiveErrors = 0;

      console.debug(
        "[FACE MONITOR] Detection:",
        {
          inference:
            this.inferenceCount,

          faceCount,

          topScore:
            detections[0]?.score ?? 0,

          noFaceEvidence:
            this.noFaceEvidence,

          multipleFaceEvidence:
            this.multipleFaceEvidence,

          faces:
            detections.map(
              (face) => ({
                score:
                  Number(
                    face.score.toFixed(
                      3,
                    ),
                  ),

                width:
                  Number(
                    face.width.toFixed(
                      3,
                    ),
                  ),

                height:
                  Number(
                    face.height.toFixed(
                      3,
                    ),
                  ),

                area:
                  Number(
                    face.area.toFixed(
                      3,
                    ),
                  ),
              }),
            ),
        },
      );

      /**
       * Update the temporal state.
       */
      this.handleFaceState(
        detections,
      );

      this.emitStatus(detections);
    } catch (error) {
      /**
       * IMPORTANT:
       *
       * Technical inference errors are NOT
       * considered NO_FACE.
       *
       * This prevents a WASM/runtime problem
       * from falsely penalizing the participant.
       */
      this.consecutiveErrors += 1;

      console.error(
        "[FACE MONITOR] Inference failed:",
        error,
      );

      /**
       * A monitor that fails on every cycle is
       * effectively dead. Escalate loudly so a
       * broken setup is never mistaken for a
       * clean exam session.
       */
      if (
        this.consecutiveErrors === 5
      ) {
        console.error(
          "[FACE MONITOR] Inference has failed " +
            "5 times in a row. Face detection is " +
            "not running — NO_FACE and " +
            "MULTIPLE_FACE violations cannot " +
            "fire until this is fixed. " +
            "Check the errors above.",
        );
      }

      this.emitStatus([]);
    }

    if (this.active) {
      this.timerHandle =
        window.setTimeout(
          () => {
            void this.runLoop();
          },
          this.options.intervalMs,
        );
    }
  }

  /**
   * ============================================
   * FACE STATE MACHINE
   * ============================================
   *
   * 0 face
   *   -> NO_FACE evidence
   *
   * 1 face
   *   -> recover both states
   *
   * 2+ faces
   *   -> MULTIPLE_FACE evidence
   */
  private handleFaceState(
    detections: FaceDetectionBox[],
  ): void {
    const faceCount =
      detections.length;

    /**
     * ------------------------------------------
     * ZERO VALID FACES
     * ------------------------------------------
     */
    if (faceCount === 0) {
      this.updateNoFaceState();

      /**
       * A zero-face frame is strong evidence
       * against MULTIPLE_FACE.
       */
      this.updateMultipleFaceRecovery();

      return;
    }

    /**
     * ------------------------------------------
     * EXACTLY ONE VALID FACE
     * ------------------------------------------
     */
    if (faceCount === 1) {
      this.updateNoFaceRecovery();

      this.updateMultipleFaceRecovery();

      return;
    }

    /**
     * ------------------------------------------
     * TWO OR MORE VALID FACES
     * ------------------------------------------
     */
    this.updateNoFaceRecovery();

    this.updateMultipleFaceState(
      detections,
    );
  }

  /**
   * ============================================
   * NO_FACE EVIDENCE
   * ============================================
   */
  private updateNoFaceState(): void {
    /**
     * Increase evidence gradually.
     */
    this.noFaceEvidence =
      Math.min(
        this.noFaceEvidence +
          this.options
            .noFaceEvidenceIncrement,

        this.options
          .noFaceEvidenceThreshold,
      );

    console.debug(
      "[FACE MONITOR] NO_FACE evidence:",
      {
        evidence:
          this.noFaceEvidence,

        threshold:
          this.options
            .noFaceEvidenceThreshold,
      },
    );

    /**
     * Already reported:
     * do not emit the same event repeatedly.
     */
    if (
      this.noFaceReported
    ) {
      return;
    }

    /**
     * Threshold reached.
     */
    if (
      this.noFaceEvidence <
      this.options
        .noFaceEvidenceThreshold
    ) {
      return;
    }

    this.noFaceReported = true;

    console.warn(
      "[FACE MONITOR] NO_FACE violation",
    );

    this.callback(
      "NO_FACE",
      {
        reason:
          "sustained-no-face",

        evidence:
          this.noFaceEvidence,

        threshold:
          this.options
            .noFaceEvidenceThreshold,

        intervalMs:
          this.options
            .intervalMs,

        estimatedDurationMs:
          this.options
            .noFaceEvidenceThreshold *
          this.options.intervalMs,

        faceCount: 0,

        timestamp:
          Date.now(),
      },
    );
  }

  /**
   * ============================================
   * NO_FACE RECOVERY
   * ============================================
   */
  private updateNoFaceRecovery(): void {
    if (
      this.noFaceEvidence <= 0
    ) {
      return;
    }

    this.noFaceEvidence =
      Math.max(
        this.noFaceEvidence -
          this.options
            .noFaceRecoveryDecrement,

        0,
      );

    console.debug(
      "[FACE MONITOR] NO_FACE recovery:",
      {
        evidence:
          this.noFaceEvidence,
      },
    );

    /**
     * Only re-arm after evidence completely
     * disappears.
     *
     * This creates hysteresis.
     */
    if (
      this.noFaceEvidence === 0 &&
      this.noFaceReported
    ) {
      this.noFaceReported = false;

      console.log(
        "[FACE MONITOR] NO_FACE recovered.",
      );
    }
  }

  /**
   * ============================================
   * MULTIPLE_FACE EVIDENCE
   * ============================================
   */
  private updateMultipleFaceState(
    detections: FaceDetectionBox[],
  ): void {
    /**
     * Increase evidence gradually.
     */
    this.multipleFaceEvidence =
      Math.min(
        this.multipleFaceEvidence +
          this.options
            .multipleFaceEvidenceIncrement,

        this.options
          .multipleFaceEvidenceThreshold,
      );

    console.debug(
      "[FACE MONITOR] MULTIPLE_FACE evidence:",
      {
        faceCount:
          detections.length,

        evidence:
          this.multipleFaceEvidence,

        threshold:
          this.options
            .multipleFaceEvidenceThreshold,
      },
    );

    /**
     * Already reported:
     * don't emit repeatedly.
     */
    if (
      this.multipleFaceReported
    ) {
      return;
    }

    /**
     * Threshold reached.
     */
    if (
      this.multipleFaceEvidence <
      this.options
        .multipleFaceEvidenceThreshold
    ) {
      return;
    }

    this.multipleFaceReported =
      true;

    console.warn(
      "[FACE MONITOR] MULTIPLE_FACE violation",
    );

    this.callback(
      "MULTIPLE_FACE",
      {
        reason:
          "sustained-multiple-face",

        faceCount:
          detections.length,

        evidence:
          this.multipleFaceEvidence,

        threshold:
          this.options
            .multipleFaceEvidenceThreshold,

        intervalMs:
          this.options
            .intervalMs,

        estimatedDurationMs:
          this.options
            .multipleFaceEvidenceThreshold *
          this.options.intervalMs,

        faces:
          detections,

        timestamp:
          Date.now(),
      },
    );
  }

  /**
   * ============================================
   * MULTIPLE_FACE RECOVERY
   * ============================================
   */
  private updateMultipleFaceRecovery(): void {
    if (
      this.multipleFaceEvidence <= 0
    ) {
      return;
    }

    this.multipleFaceEvidence =
      Math.max(
        this.multipleFaceEvidence -
          this.options
            .multipleFaceRecoveryDecrement,

        0,
      );

    console.debug(
      "[FACE MONITOR] MULTIPLE_FACE recovery:",
      {
        evidence:
          this.multipleFaceEvidence,
      },
    );

    /**
     * Re-arm only after evidence reaches zero.
     */
    if (
      this.multipleFaceEvidence === 0 &&
      this.multipleFaceReported
    ) {
      this.multipleFaceReported =
        false;

      console.log(
        "[FACE MONITOR] MULTIPLE_FACE recovered.",
      );
    }
  }

  /**
   * ============================================
   * FACE DETECTION
   * ============================================
   */
  private async detectFaces(): Promise<
    FaceDetectionBox[]
  > {
    if (!this.session) {
      throw new Error(
        "ONNX session is unavailable.",
      );
    }

    const videoWidth =
      this.videoElement.videoWidth;

    const videoHeight =
      this.videoElement.videoHeight;

    if (
      videoWidth <= 0 ||
      videoHeight <= 0
    ) {
      throw new Error(
        "Webcam video dimensions are not ready.",
      );
    }

    const width =
      this.options.inputWidth;

    const height =
      this.options.inputHeight;

    /**
     * ==========================================
     * DRAW VIDEO FRAME
     * ==========================================
     */
    this.canvasContext.drawImage(
      this.videoElement,
      0,
      0,
      width,
      height,
    );

    const imageData =
      this.canvasContext.getImageData(
        0,
        0,
        width,
        height,
      );

    const pixelCount =
      width * height;

    /**
     * ==========================================
     * RGB -> CHW FLOAT32
     * ==========================================
     *
     * UltraFace normalization:
     *
     * (pixel - 127) / 128
     */
    const inputData =
      new Float32Array(
        pixelCount * 3,
      );

    for (
      let i = 0;
      i < pixelCount;
      i += 1
    ) {
      const src =
        i * 4;

      const r =
        imageData.data[
          src
        ] ?? 0;

      const g =
        imageData.data[
          src + 1
        ] ?? 0;

      const b =
        imageData.data[
          src + 2
        ] ?? 0;

      /**
       * Red channel.
       */
      inputData[i] =
        (r - 127) / 128;

      /**
       * Green channel.
       */
      inputData[
        pixelCount + i
      ] =
        (g - 127) / 128;

      /**
       * Blue channel.
       */
      inputData[
        pixelCount * 2 + i
      ] =
        (b - 127) / 128;
    }

    /**
     * ==========================================
     * CREATE INPUT TENSOR
     * ==========================================
     */
    const inputTensor =
      new ort.Tensor(
        "float32",
        inputData,
        [
          1,
          3,
          height,
          width,
        ],
      );

    const inputName =
      this.session.inputNames[0];

    if (!inputName) {
      throw new Error(
        "ONNX model does not expose an input name.",
      );
    }

    /**
     * ==========================================
     * RUN MODEL
     * ==========================================
     */
    const outputs =
      await this.session.run({
        [inputName]:
          inputTensor,
      });

    /**
     * ==========================================
     * FIND OUTPUT TENSORS
     * ==========================================
     *
     * Expected:
     *
     * scores    [1, 4420, 2]
     * locations [1, 4420, 4]
     */
    let scoresTensor:
      ort.Tensor | undefined;

    let locationsTensor:
      ort.Tensor | undefined;

    for (
      const outputName of
        this.session.outputNames
    ) {
      const tensor =
        outputs[
          outputName
        ];

      if (!tensor) {
        continue;
      }

      const dims =
        tensor.dims;

      const lastDim =
        dims[
          dims.length - 1
        ];

      if (
        lastDim === 2 &&
        !scoresTensor
      ) {
        scoresTensor =
          tensor;
      }

      if (
        lastDim === 4 &&
        !locationsTensor
      ) {
        locationsTensor =
          tensor;
      }
    }

    if (
      !scoresTensor ||
      !locationsTensor
    ) {
      console.error(
        "[FACE MONITOR] Unexpected ONNX outputs:",
        {
          outputNames:
            this.session.outputNames,

          outputs:
            this.session.outputNames.map(
              (name) => ({
                name,

                dims:
                  outputs[
                    name
                  ]?.dims,

                type:
                  outputs[
                    name
                  ]?.type,

                dataLength:
                  outputs[
                    name
                  ]?.data?.length,
              }),
            ),
        },
      );

      return [];
    }

    const scores =
      scoresTensor.data as
        | Float32Array
        | Float64Array;

    const locations =
      locationsTensor.data as
        | Float32Array
        | Float64Array;

    /**
     * ==========================================
     * CANDIDATE COUNT
     * ==========================================
     */
    const candidateCount =
      Math.min(
        Math.floor(
          scores.length / 2,
        ),

        Math.floor(
          locations.length / 4,
        ),

        this.priors.length / 4,
      );

    if (
      candidateCount <= 0
    ) {
      throw new Error(
        "ONNX returned empty detection tensors.",
      );
    }

    const candidates:
      FaceDetectionBox[] = [];

    let topScore = 0;

    /**
     * ==========================================
     * RAW CANDIDATE FILTER + DECODE
     * ==========================================
     */
    for (
      let i = 0;
      i < candidateCount;
      i += 1
    ) {
      /**
       * Class 1 = FACE.
       */
      const score =
        Number(
          scores[
            i * 2 + 1
          ] ?? 0,
        );

      if (
        score > topScore
      ) {
        topScore = score;
      }

      /**
       * First confidence filter.
       */
      if (
        score <
        this.options
          .scoreThreshold
      ) {
        continue;
      }

      const locationOffset =
        i * 4;

      const priorOffset =
        i * 4;

      const priorCx =
        this.priors[
          priorOffset
        ] ?? 0;

      const priorCy =
        this.priors[
          priorOffset + 1
        ] ?? 0;

      const priorW =
        this.priors[
          priorOffset + 2
        ] ?? 0;

      const priorH =
        this.priors[
          priorOffset + 3
        ] ?? 0;

      const locCx =
        Number(
          locations[
            locationOffset
          ] ?? 0,
        );

      const locCy =
        Number(
          locations[
            locationOffset + 1
          ] ?? 0,
        );

      const locW =
        Number(
          locations[
            locationOffset + 2
          ] ?? 0,
        );

      const locH =
        Number(
          locations[
            locationOffset + 3
          ] ?? 0,
        );

      /**
       * ========================================
       * ULTRAFACE RAW BOX DECODE
       * ========================================
       */
      const centerX =
        locCx *
          CENTER_VARIANCE *
          priorW +
        priorCx;

      const centerY =
        locCy *
          CENTER_VARIANCE *
          priorH +
        priorCy;

      const boxW =
        Math.exp(
          locW * SIZE_VARIANCE,
        ) *
        priorW;

      const boxH =
        Math.exp(
          locH * SIZE_VARIANCE,
        ) *
        priorH;

      let xMin =
        centerX -
        boxW / 2;

      let yMin =
        centerY -
        boxH / 2;

      let xMax =
        centerX +
        boxW / 2;

      let yMax =
        centerY +
        boxH / 2;

      /**
       * Reject impossible numerical values.
       */
      if (
        !Number.isFinite(xMin) ||
        !Number.isFinite(yMin) ||
        !Number.isFinite(xMax) ||
        !Number.isFinite(yMax)
      ) {
        continue;
      }

      /**
       * Clip to normalized frame.
       */
      xMin =
        Math.max(
          0,
          Math.min(1, xMin),
        );

      yMin =
        Math.max(
          0,
          Math.min(1, yMin),
        );

      xMax =
        Math.max(
          0,
          Math.min(1, xMax),
        );

      yMax =
        Math.max(
          0,
          Math.min(1, yMax),
        );

      /**
       * Reject empty boxes.
       */
      if (
        xMax <= xMin ||
        yMax <= yMin
      ) {
        continue;
      }

      const faceWidth =
        xMax - xMin;

      const faceHeight =
        yMax - yMin;

      const faceArea =
        faceWidth *
        faceHeight;

      const centerBoxX =
        (xMin + xMax) / 2;

      const centerBoxY =
        (yMin + yMax) / 2;

      const detection:
        FaceDetectionBox = {
          xMin,
          yMin,
          xMax,
          yMax,

          score,

          width:
            faceWidth,

          height:
            faceHeight,

          area:
            faceArea,
        };

      /**
       * ========================================
       * VALID FACE FILTER
       * ========================================
       */
      if (
        !this.isValidFace(
          detection,
          centerBoxX,
          centerBoxY,
        )
      ) {
        continue;
      }

      candidates.push(
        detection,
      );
    }

    console.debug(
      "[FACE MONITOR] Candidate filtering:",
      {
        candidateCount,

        accepted:
          candidates.length,

        topScore:
          Number(
            topScore.toFixed(
              3,
            ),
          ),

        rawThreshold:
          this.options
            .scoreThreshold,

        validThreshold:
          this.options
            .validFaceScoreThreshold,
      },
    );

    /**
     * ==========================================
     * NMS
     * ==========================================
     */
    const finalDetections =
      this.nonMaxSuppression(
        candidates,
      );

    console.debug(
      "[FACE MONITOR] After NMS:",
      {
        before:
          candidates.length,

        after:
          finalDetections.length,

        boxes:
          finalDetections,
      },
    );

    return finalDetections;
  }

  /**
   * ============================================
   * VALID FACE FILTERING
   * ============================================
   */
  private isValidFace(
    detection: FaceDetectionBox,
    centerX: number,
    centerY: number,
  ): boolean {
    /**
     * ------------------------------------------
     * CONFIDENCE
     * ------------------------------------------
     */
    if (
      detection.score <
      this.options
        .validFaceScoreThreshold
    ) {
      return false;
    }

    /**
     * ------------------------------------------
     * WIDTH
     * ------------------------------------------
     */
    if (
      detection.width <
      this.options.minFaceWidth
    ) {
      return false;
    }

    /**
     * ------------------------------------------
     * HEIGHT
     * ------------------------------------------
     */
    if (
      detection.height <
      this.options.minFaceHeight
    ) {
      return false;
    }

    /**
     * ------------------------------------------
     * AREA
     * ------------------------------------------
     */
    if (
      detection.area <
      this.options.minFaceArea
    ) {
      return false;
    }

    /**
     * ------------------------------------------
     * EXTREMELY HUGE BOX
     * ------------------------------------------
     *
     * Prevent large background regions from
     * being interpreted as faces.
     */
    if (
      detection.width > 0.95 ||
      detection.height > 0.95
    ) {
      return false;
    }

    /**
     * ------------------------------------------
     * HORIZONTAL CENTER
     * ------------------------------------------
     */
    if (
      centerX <
        this.options
          .minBoxCenterX ||
      centerX >
        this.options
          .maxBoxCenterX
    ) {
      return false;
    }

    /**
     * ------------------------------------------
     * VERTICAL CENTER
     * ------------------------------------------
     */
    if (
      centerY <
        this.options
          .minBoxCenterY ||
      centerY >
        this.options
          .maxBoxCenterY
    ) {
      return false;
    }

    return true;
  }

  /**
   * ============================================
   * RFB-320 PRIORS
   * ============================================
   *
   * Expected count:
   * 4420
   */
  private generatePriors(
    imageWidth: number,
    imageHeight: number,
  ): Float32Array {
    const priors: number[] = [];

    for (
      let layer = 0;
      layer < STRIDES.length;
      layer += 1
    ) {
      const stride =
        STRIDES[layer];

      const featureMapWidth =
        Math.ceil(
          imageWidth / stride,
        );

      const featureMapHeight =
        Math.ceil(
          imageHeight / stride,
        );

      const boxesForLayer =
        MIN_BOXES[layer];

      if (!boxesForLayer) {
        continue;
      }

      for (
        let y = 0;
        y < featureMapHeight;
        y += 1
      ) {
        for (
          let x = 0;
          x < featureMapWidth;
          x += 1
        ) {
          const centerX =
            ((x + 0.5) * stride) /
            imageWidth;

          const centerY =
            ((y + 0.5) * stride) /
            imageHeight;

          for (
            const minBox of
              boxesForLayer
          ) {
            const boxWidth =
              minBox /
              imageWidth;

            const boxHeight =
              minBox /
              imageHeight;

            priors.push(
              Math.max(
                0,
                Math.min(
                  1,
                  centerX,
                ),
              ),

              Math.max(
                0,
                Math.min(
                  1,
                  centerY,
                ),
              ),

              Math.max(
                0,
                Math.min(
                  1,
                  boxWidth,
                ),
              ),

              Math.max(
                0,
                Math.min(
                  1,
                  boxHeight,
                ),
              ),
            );
          }
        }
      }
    }

    const priorCount =
      priors.length / 4;

    if (
      priorCount !== 4420
    ) {
      console.warn(
        "[FACE MONITOR] Unexpected prior count:",
        priorCount,
      );
    }

    return new Float32Array(
      priors,
    );
  }

  /**
   * ============================================
   * HARD NMS
   * ============================================
   */
  private nonMaxSuppression(
    boxes: FaceDetectionBox[],
  ): FaceDetectionBox[] {
    if (
      boxes.length <= 1
    ) {
      return boxes;
    }

    /**
     * Highest confidence first.
     */
    const sorted =
      [...boxes].sort(
        (a, b) =>
          b.score - a.score,
      );

    const selected:
      FaceDetectionBox[] = [];

    for (
      const candidate of sorted
    ) {
      let overlaps = false;

      for (
        const existing of selected
      ) {
        const overlap =
          this.iou(
            candidate,
            existing,
          );

        if (
          overlap >=
          this.options
            .nmsThreshold
        ) {
          overlaps = true;
          break;
        }
      }

      if (!overlaps) {
        selected.push(
          candidate,
        );
      }
    }

    return selected;
  }

  /**
   * ============================================
   * INTERSECTION OVER UNION
   * ============================================
   */
  private iou(
    left: FaceDetectionBox,
    right: FaceDetectionBox,
  ): number {
    const intersectionLeft =
      Math.max(
        left.xMin,
        right.xMin,
      );

    const intersectionTop =
      Math.max(
        left.yMin,
        right.yMin,
      );

    const intersectionRight =
      Math.min(
        left.xMax,
        right.xMax,
      );

    const intersectionBottom =
      Math.min(
        left.yMax,
        right.yMax,
      );

    const intersectionWidth =
      Math.max(
        0,
        intersectionRight -
          intersectionLeft,
      );

    const intersectionHeight =
      Math.max(
        0,
        intersectionBottom -
          intersectionTop,
      );

    const intersectionArea =
      intersectionWidth *
      intersectionHeight;

    const leftArea =
      Math.max(
        0,
        left.xMax -
          left.xMin,
      ) *
      Math.max(
        0,
        left.yMax -
          left.yMin,
      );

    const rightArea =
      Math.max(
        0,
        right.xMax -
          right.xMin,
      ) *
      Math.max(
        0,
        right.yMax -
          right.yMin,
      );

    const unionArea =
      leftArea +
      rightArea -
      intersectionArea;

    if (
      unionArea <= 0
    ) {
      return 0;
    }

    return (
      intersectionArea /
      unionArea
    );
  }

  /**
   * ============================================
   * WAIT FOR VIDEO
   * ============================================
   */
  private async waitForVideoReady(): Promise<void> {
    /**
     * Already ready.
     */
    if (
      this.videoElement
        .videoWidth > 0 &&
      this.videoElement
        .videoHeight > 0 &&
      this.videoElement.readyState >=
        HTMLMediaElement.HAVE_CURRENT_DATA
    ) {
      return;
    }

    await new Promise<void>(
      (
        resolve,
        reject,
      ) => {
        let done = false;

        const cleanup =
          () => {
            this.videoElement.removeEventListener(
              "loadedmetadata",
              onReady,
            );

            this.videoElement.removeEventListener(
              "canplay",
              onReady,
            );

            this.videoElement.removeEventListener(
              "playing",
              onReady,
            );

            this.videoElement.removeEventListener(
              "error",
              onError,
            );
          };

        const onReady =
          () => {
            if (done) {
              return;
            }

            if (
              this.videoElement
                .videoWidth <= 0 ||
              this.videoElement
                .videoHeight <= 0
            ) {
              return;
            }

            done = true;

            cleanup();

            resolve();
          };

        const onError =
          () => {
            if (done) {
              return;
            }

            done = true;

            cleanup();

            reject(
              new Error(
                "Webcam video element failed.",
              ),
            );
          };

        this.videoElement.addEventListener(
          "loadedmetadata",
          onReady,
        );

        this.videoElement.addEventListener(
          "canplay",
          onReady,
        );

        this.videoElement.addEventListener(
          "playing",
          onReady,
        );

        this.videoElement.addEventListener(
          "error",
          onError,
        );
      },
    );
  }
}

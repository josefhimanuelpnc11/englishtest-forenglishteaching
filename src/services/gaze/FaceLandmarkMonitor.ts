import {
  FaceLandmarker,
  FilesetResolver,
} from "@mediapipe/tasks-vision";

import {
  EXPECTED_LANDMARK_COUNT,
  combinedGazeRatio,
} from "./gazeMath";

import type { EyeGazeRatio } from "./gazeMath";

export interface LandmarkStatus {
  faceCount: number;

  /**
   * Combined gaze ratio, or null when no single
   * measurable face is present.
   */
  gaze: EyeGazeRatio | null;

  landmarkCount: number;

  consecutiveErrors: number;

  inferenceCount: number;
}

export interface FaceLandmarkMonitorOptions {
  taskUrl?: string;
  wasmBasePath?: string;

  /**
   * Delay between detection cycles.
   * Default: 500 ms (responsive calibration UI).
   */
  intervalMs?: number;
}

const DEFAULT_TASK_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

const DEFAULT_WASM_BASE_PATH =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm";

/**
 * MediaPipe FaceLandmarker wrapper.
 *
 * Phase 1 role: feed the pre-exam gaze calibration
 * with per-cycle face count + gaze ratios. Runs on
 * its own hidden video element fed by the shared
 * camera stream. Never registers violations.
 */
export class FaceLandmarkMonitor {
  private readonly onStatus: (
    status: LandmarkStatus,
  ) => void;

  private readonly options: Required<FaceLandmarkMonitorOptions>;

  private readonly videoElement: HTMLVideoElement;

  private landmarker: FaceLandmarker | null =
    null;

  private landmarkerReady: Promise<void> | null =
    null;

  private timerHandle: number | null = null;

  private active = false;

  private consecutiveErrors = 0;

  private inferenceCount = 0;

  constructor(
    stream: MediaStream,
    onStatus: (
      status: LandmarkStatus,
    ) => void,
    options: FaceLandmarkMonitorOptions = {},
  ) {
    this.onStatus = onStatus;

    this.options = {
      taskUrl:
        options.taskUrl ?? DEFAULT_TASK_URL,

      wasmBasePath:
        options.wasmBasePath ??
        DEFAULT_WASM_BASE_PATH,

      intervalMs:
        options.intervalMs ?? 500,
    };

    this.videoElement =
      document.createElement("video");

    this.videoElement.autoplay = true;
    this.videoElement.muted = true;
    this.videoElement.playsInline = true;
    this.videoElement.srcObject = stream;

    console.log(
      "[LANDMARK] Monitor created.",
    );
  }

  async start(): Promise<void> {
    if (this.active) {
      console.warn(
        "[LANDMARK] Already active.",
      );

      return;
    }

    this.active = true;

    try {
      console.log(
        "[LANDMARK] Starting...",
      );

      await this.waitForVideoReady();
      await this.videoElement.play();
      await this.ensureLandmarker();

      if (!this.landmarker) {
        throw new Error(
          "FaceLandmarker was not created.",
        );
      }

      this.consecutiveErrors = 0;

      console.log(
        "[LANDMARK] Monitoring started.",
      );

      void this.runLoop();
    } catch (error) {
      this.active = false;

      console.error(
        "[LANDMARK] Startup failed:",
        error,
      );

      throw error;
    }
  }

  stop(): void {
    this.active = false;

    if (this.timerHandle !== null) {
      window.clearTimeout(
        this.timerHandle,
      );

      this.timerHandle = null;
    }

    this.videoElement.pause();
    this.videoElement.srcObject = null;

    this.consecutiveErrors = 0;

    console.log("[LANDMARK] Stopped.");
  }

  private async ensureLandmarker(): Promise<void> {
    if (this.landmarker) {
      return;
    }

    if (this.landmarkerReady) {
      return this.landmarkerReady;
    }

    this.landmarkerReady =
      this.initializeLandmarker();

    try {
      await this.landmarkerReady;
    } catch (error) {
      this.landmarkerReady = null;

      throw error;
    }
  }

  private async initializeLandmarker(): Promise<void> {
    console.log(
      "[LANDMARK] Loading vision runtime...",
    );

    const fileset =
      await FilesetResolver.forVisionTasks(
        this.options.wasmBasePath,
      );

    console.log(
      "[LANDMARK] Loading face landmarker model...",
    );

    // Prefer GPU; fall back to CPU for devices
    // without usable WebGL (older phones).
    try {
      this.landmarker =
        await FaceLandmarker.createFromOptions(
          fileset,
          {
            baseOptions: {
              modelAssetPath:
                this.options.taskUrl,
              delegate: "GPU",
            },
            runningMode: "VIDEO",
            numFaces: 2,
          },
        );

      console.log(
        "[LANDMARK] Delegate: GPU.",
      );
    } catch (gpuError) {
      console.warn(
        "[LANDMARK] GPU delegate failed, trying CPU:",
        gpuError,
      );

      this.landmarker =
        await FaceLandmarker.createFromOptions(
          fileset,
          {
            baseOptions: {
              modelAssetPath:
                this.options.taskUrl,
              delegate: "CPU",
            },
            runningMode: "VIDEO",
            numFaces: 2,
          },
        );

      console.log(
        "[LANDMARK] Delegate: CPU.",
      );
    }

    console.log(
      "[LANDMARK] Landmarker ready.",
    );
  }

  private async runLoop(): Promise<void> {
    if (
      !this.active ||
      !this.landmarker
    ) {
      return;
    }

    try {
      this.inferenceCount += 1;

      const status =
        await this.detectOnce();

      this.consecutiveErrors = 0;

      this.onStatus({
        ...status,
        consecutiveErrors:
          this.consecutiveErrors,
        inferenceCount:
          this.inferenceCount,
      });
    } catch (error) {
      this.consecutiveErrors += 1;

      console.error(
        "[LANDMARK] Detection failed:",
        error,
      );

      if (
        this.consecutiveErrors === 5
      ) {
        console.error(
          "[LANDMARK] Detection has failed " +
            "5 times in a row. Gaze calibration " +
            "cannot proceed until this is fixed.",
        );
      }

      this.onStatus({
        faceCount: 0,
        gaze: null,
        landmarkCount: 0,
        consecutiveErrors:
          this.consecutiveErrors,
        inferenceCount:
          this.inferenceCount,
      });
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

  private async detectOnce(): Promise<
    Pick<
      LandmarkStatus,
      "faceCount" | "gaze" | "landmarkCount"
    >
  > {
    if (!this.landmarker) {
      throw new Error(
        "FaceLandmarker is unavailable.",
      );
    }

    if (
      this.videoElement.videoWidth <= 0 ||
      this.videoElement.videoHeight <= 0 ||
      this.videoElement.readyState <
        HTMLMediaElement.HAVE_CURRENT_DATA
    ) {
      throw new Error(
        "Webcam video is not ready.",
      );
    }

    const result =
      this.landmarker.detectForVideo(
        this.videoElement,
        performance.now(),
      );

    const faces =
      result.faceLandmarks ?? [];

    if (faces.length !== 1) {
      return {
        faceCount: faces.length,
        gaze: null,
        landmarkCount: 0,
      };
    }

    const landmarks = faces[0] ?? [];

    if (
      landmarks.length <
      EXPECTED_LANDMARK_COUNT
    ) {
      return {
        faceCount: 1,
        gaze: null,
        landmarkCount: landmarks.length,
      };
    }

    const gaze = combinedGazeRatio(
      landmarks.map((point) => ({
        x: point.x,
        y: point.y,
      })),
    );

    return {
      faceCount: 1,
      gaze,
      landmarkCount: landmarks.length,
    };
  }

  private async waitForVideoReady(): Promise<void> {
    if (
      this.videoElement.videoWidth > 0 &&
      this.videoElement.videoHeight > 0 &&
      this.videoElement.readyState >=
        HTMLMediaElement.HAVE_CURRENT_DATA
    ) {
      return;
    }

    await new Promise<void>(
      (resolve, reject) => {
        let done = false;

        const cleanup = () => {
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

        const onReady = () => {
          if (done) {
            return;
          }

          if (
            this.videoElement.videoWidth <=
              0 ||
            this.videoElement.videoHeight <=
              0
          ) {
            return;
          }

          done = true;
          cleanup();
          resolve();
        };

        const onError = () => {
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

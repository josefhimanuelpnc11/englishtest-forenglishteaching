import * as ort from "onnxruntime-web";

type AudioViolationCallback = (
  type: "AUDIO_ACTIVITY",
  metadata?: Record<string, unknown>,
) => void;

export interface OnnxAudioMonitorOptions {
  modelUrl?: string;
  wasmBasePath?: string;
  frameSize?: number;
  speechThreshold?: number;
  silenceThreshold?: number;
  intervalMs?: number;
}

const DEFAULT_MODEL_URL =
  "https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.29/dist/silero_vad_v5.onnx";

const DEFAULT_WASM_BASE_PATH =
  "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.29.0/dist/";

export class OnnxAudioMonitor {
  private readonly callback: AudioViolationCallback;

  private readonly options: Required<OnnxAudioMonitorOptions>;

  private readonly audioContext: AudioContext;

  private readonly sourceNode: MediaStreamAudioSourceNode;

  private readonly processorNode: ScriptProcessorNode;

  private readonly gainNode: GainNode;

  private readonly sessionReady: Promise<void>;

  private session: ort.InferenceSession | null = null;

  private state: ort.Tensor | null = null;

  private readonly sampleRateTensor = new ort.Tensor(
    "int64",
    [16000n],
  );

  private sampleBuffer = new Float32Array(0);

  private active = false;

  constructor(
    stream: MediaStream,
    callback: AudioViolationCallback,
    options: OnnxAudioMonitorOptions = {},
  ) {
    this.callback = callback;
    this.options = {
      modelUrl: options.modelUrl ?? DEFAULT_MODEL_URL,
      wasmBasePath:
        options.wasmBasePath ?? DEFAULT_WASM_BASE_PATH,
      frameSize: options.frameSize ?? 512,
      speechThreshold: options.speechThreshold ?? 0.6,
      silenceThreshold: options.silenceThreshold ?? 0.35,
      intervalMs: options.intervalMs ?? 0,
    };

    ort.env.wasm.wasmPaths = this.options.wasmBasePath;

    this.audioContext = new AudioContext({
      sampleRate: 16000,
    });

    this.sourceNode = this.audioContext.createMediaStreamSource(
      stream,
    );

    this.processorNode = this.audioContext.createScriptProcessor(
      4096,
      1,
      1,
    );

    this.gainNode = this.audioContext.createGain();
    this.gainNode.gain.value = 0;

    this.sourceNode.connect(this.processorNode);
    this.processorNode.connect(this.gainNode);
    this.gainNode.connect(this.audioContext.destination);

    this.processorNode.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      this.handleAudioChunk(input);
    };

    this.sessionReady = this.initializeSession();
  }

  async start() {
    if (this.active) return;

    this.active = true;
    await this.audioContext.resume();
    await this.sessionReady;
  }

  stop() {
    this.active = false;

    this.processorNode.onaudioprocess = null;
    this.sourceNode.disconnect();
    this.processorNode.disconnect();
    this.gainNode.disconnect();
    this.audioContext.close().catch(() => undefined);

    this.session?.release().catch(() => undefined);
    this.session = null;
    this.state = null;
    this.sampleBuffer = new Float32Array(0);
  }

  private async initializeSession() {
    this.session = await ort.InferenceSession.create(
      this.options.modelUrl,
      {
        executionProviders: ["wasm"],
      },
    );

    this.state = new ort.Tensor(
      "float32",
      new Float32Array(2 * 1 * 128),
      [2, 1, 128],
    );
  }

  private handleAudioChunk(chunk: Float32Array) {
    if (!this.active) {
      return;
    }

    const resampled = this.resampleIfNeeded(
      chunk,
      this.audioContext.sampleRate,
      16000,
    );

    const merged = new Float32Array(
      this.sampleBuffer.length + resampled.length,
    );

    merged.set(this.sampleBuffer, 0);
    merged.set(resampled, this.sampleBuffer.length);
    this.sampleBuffer = merged;

    while (this.sampleBuffer.length >= this.options.frameSize) {
      const frame = this.sampleBuffer.slice(
        0,
        this.options.frameSize,
      );

      this.sampleBuffer = this.sampleBuffer.slice(
        this.options.frameSize,
      );

      void this.processFrame(frame);
    }
  }

  private async processFrame(frame: Float32Array) {
    if (!this.session || !this.state) {
      return;
    }

    const inputTensor = new ort.Tensor(
      "float32",
      frame,
      [1, frame.length],
    );

    const outputs = await this.session.run({
      input: inputTensor,
      state: this.state,
      sr: this.sampleRateTensor,
    });

    const nextState =
      (outputs.stateN as ort.Tensor | undefined) ??
      (outputs.state as ort.Tensor | undefined);
    const speechOutput =
      (outputs.output as ort.Tensor | undefined) ??
      (outputs[Object.keys(outputs)[0]] as ort.Tensor);

    if (nextState) {
      this.state = nextState;
    }

    if (!speechOutput) {
      return;
    }

    const speechProbability =
      (speechOutput.data as Float32Array)[0] ?? 0;

    if (speechProbability >= this.options.speechThreshold) {
      this.callback("AUDIO_ACTIVITY", {
        speechProbability,
      });
    }
  }

  private resampleIfNeeded(
    input: Float32Array,
    inputRate: number,
    targetRate: number,
  ) {
    if (inputRate === targetRate) {
      return input;
    }

    const ratio = inputRate / targetRate;
    const outputLength = Math.max(
      1,
      Math.floor(input.length / ratio),
    );
    const output = new Float32Array(outputLength);

    for (let index = 0; index < outputLength; index += 1) {
      const sourcePosition = index * ratio;
      const lowerIndex = Math.floor(sourcePosition);
      const upperIndex = Math.min(
        input.length - 1,
        lowerIndex + 1,
      );
      const interpolation = sourcePosition - lowerIndex;

      output[index] =
        input[lowerIndex] * (1 - interpolation) +
        input[upperIndex] * interpolation;
    }

    return output;
  }
}
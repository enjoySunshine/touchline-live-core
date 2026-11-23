import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ICorePlaybackObservation } from "../../../../../../src/main_thread/init/utils/create_core_playback_observer.ts";
import {
  createLiveCatchUpReferences,
  startLiveCatchUpController,
  stopLiveCatchUpController,
} from "../../../../../../src/main_thread/init/utils/live_catch_up_controller.ts";
import type { IManifestMetadata } from "../../../../../../src/manifest/index.ts";
import SharedReference from "../../../../../../src/utils/reference.ts";
import TaskCanceller from "../../../../../../src/utils/task_canceller.ts";
import { DummyManifest } from "../../../../mocks/manifest.ts";
import {
  makeReadyOnlyPlaybackObserver,
  DummyObservationPosition,
} from "../../../../mocks/playback_observer.ts";

vi.mock("../../../../../../src/log", () => ({
  default: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

/** Build an observation position at the given wanted/polled time. */
function makePosition(time: number): InstanceType<typeof DummyObservationPosition> {
  return new DummyObservationPosition({
    getWanted: () => time,
    getPolled: () => time,
  });
}

interface ITestEnv {
  observer: ReturnType<typeof makeReadyOnlyPlaybackObserver<ICorePlaybackObservation>>;
  speedRef: SharedReference<number>;
  /** Every position passed to the catch-up seek callback, in order. */
  seekCalls: number[];
  /** Every rate passed to the playback-rate callback, in order. */
  rateCalls: number[];
  canceller: TaskCanceller;
  references: ReturnType<typeof createLiveCatchUpReferences>;
  manifest: IManifestMetadata;
  emit: (overrides: Partial<ICorePlaybackObservation>) => void;
}

/** Create a fully-wired catch-up controller for a low-latency live content. */
function setupCatchUp(manifestOverrides: Partial<IManifestMetadata> = {}): ITestEnv {
  return makeCatchUp(true, manifestOverrides);
}

/** Create a catch-up controller for a regular (non low-latency) live content. */
function makeRegularLiveCatchUp(): ITestEnv {
  return makeCatchUp(false, {});
}

function makeCatchUp(
  lowLatencyMode: boolean,
  manifestOverrides: Partial<IManifestMetadata>,
): ITestEnv {
  const manifestOptions = {
    isLive: true,
    isDynamic: true,
    ...manifestOverrides,
  } as unknown as ConstructorParameters<typeof DummyManifest>[0];
  const manifest = new DummyManifest(manifestOptions) as unknown as IManifestMetadata;
  const speedRef = new SharedReference(1);
  // Start already at the content's target distance from the live edge.
  const initialGap = lowLatencyMode ? 3.5 : 10;
  const observer = makeReadyOnlyPlaybackObserver<ICorePlaybackObservation>(
    makeObservation(1, initialGap, 100),
  );
  const seekCalls: number[] = [];
  const rateCalls: number[] = [];
  const canceller = new TaskCanceller("test catch-up");
  const references = createLiveCatchUpReferences(speedRef);
  startLiveCatchUpController(
    {
      manifest,
      lowLatencyMode,
      speedRef,
      playbackObserver: observer.observer,
      seekTo: (position) => {
        seekCalls.push(position);
      },
      setPlaybackRate: (rate) => {
        rateCalls.push(rate);
      },
      references,
    },
    canceller.signal,
  );
  return {
    observer,
    speedRef,
    seekCalls,
    rateCalls,
    canceller,
    references,
    manifest,
    emit: (overrides) =>
      observer.emit({ ...makeObservation(1, initialGap, 100), ...overrides }),
  };
}

function makeObservation(
  position: number,
  liveGap: number,
  maxPosition: number,
  overrides: Partial<ICorePlaybackObservation> = {},
): ICorePlaybackObservation {
  return {
    paused: { last: false, pending: undefined },
    position: makePosition(position),
    duration: maxPosition,
    readyState: 4,
    speed: 1,
    maximumPosition: position + liveGap,
    buffered: { audio: null, video: null, text: null },
    rebuffering: null,
    freezing: null,
    bufferGap: 18,
    canStream: true,
    fullyLoaded: false,
    ...overrides,
  };
}

describe("live catch-up controller", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does nothing when the live gap is at the low-latency target (3.5s)", () => {
    const env = setupCatchUp();
    env.emit({
      position: makePosition(100),
      maximumPosition: 103.5,
    });
    expect(env.references.stateRef.getValue().isCatchingUp).toBe(false);
    expect(env.references.effectiveSpeedRef.getValue()).toBe(1);
    expect(env.rateCalls).toHaveLength(0);
    expect(env.seekCalls).toHaveLength(0);
    env.canceller.cancel("done");
  });

  it("raises the effective playback rate, up to 1.5, when behind the live edge", () => {
    const env = setupCatchUp();
    // live gap of 9s at position 100 => target 3.5 => drift of 5.5s
    env.emit({
      position: makePosition(100),
      maximumPosition: 109,
    });
    // neededRate = 1 + 5.5 / 8 = 1.6875, capped at 1.5
    expect(env.references.effectiveSpeedRef.getValue()).toBe(1.5);
    expect(env.references.stateRef.getValue().isCatchingUp).toBe(true);
    expect(env.rateCalls[env.rateCalls.length - 1]).toBe(1.5);
    env.canceller.cancel("done");
  });

  it("keeps the viewer-set rate displayed while catching up (rate stays 1 in state)", () => {
    const env = setupCatchUp();
    expect(env.speedRef.getValue()).toBe(1);
    env.emit({
      position: makePosition(100),
      maximumPosition: 109,
    });
    // The effective rate used for playback/ABR is 1.5...
    expect(env.references.effectiveSpeedRef.getValue()).toBe(1.5);
    // ...but the viewer-set reference (what the page reads) stays 1.
    expect(env.speedRef.getValue()).toBe(1);
    env.canceller.cancel("done");
  });

  it("restores the viewer-set rate once back within the 0.4s tolerance", () => {
    const env = setupCatchUp();
    env.emit({
      position: makePosition(100),
      maximumPosition: 109,
    });
    expect(env.references.effectiveSpeedRef.getValue()).toBe(1.5);
    // Back to a 3.6s gap (within 3.5 +/- 0.4)
    env.emit({
      position: makePosition(120),
      maximumPosition: 123.6,
    });
    expect(env.references.effectiveSpeedRef.getValue()).toBe(1);
    expect(env.references.stateRef.getValue().isCatchingUp).toBe(false);
    expect(env.rateCalls[env.rateCalls.length - 1]).toBe(1);
    env.canceller.cancel("done");
  });

  it("brings a 9s live gap back near the 3.5s target within 8s, at rate <= 1.5, skipping <= 2s", () => {
    // This is the headline scenario: 9s from the live edge, 3.5s target, so a
    // 5.5s drift. Both audio and video have plenty of buffered data ahead.
    const env = setupCatchUp();
    const ranges = [{ start: 0, end: 200 }];
    env.emit({
      position: makePosition(100),
      maximumPosition: 109,
      buffered: { audio: ranges, video: ranges, text: null },
    });

    // Rate alone would take 5.5 / (1.5 - 1) = 11s, which exceeds the 8s
    // budget, so a bounded seek is performed.
    expect(env.seekCalls).toHaveLength(1);
    const seekDistance = env.seekCalls[0] - 100;
    // The seek never jumps over more than 2s of buffered content...
    expect(seekDistance).toBeGreaterThan(0);
    expect(seekDistance).toBeLessThanOrEqual(2);
    // ...and is sized so the rest closes in time: after the seek, at most 4s
    // of drift remains, which at rate 1.5 closes within 8s.
    const remainingDrift = 5.5 - seekDistance;
    expect(remainingDrift / (1.5 - 1)).toBeLessThanOrEqual(8);

    // The effective media rate is capped at 1.5.
    expect(env.references.effectiveSpeedRef.getValue()).toBeLessThanOrEqual(1.5);
    expect(env.references.stateRef.getValue().isCatchingUp).toBe(true);
    // The viewer-set rate (what the page reads) is still 1.
    expect(env.speedRef.getValue()).toBe(1);
    env.canceller.cancel("done");
  });

  it("seeks at most 2s over buffered content when rate alone cannot close the gap", () => {
    const env = setupCatchUp();
    const videoRanges = [{ start: 90, end: 130 }];
    const audioRanges = [{ start: 90, end: 130 }];
    // gap of 20s at position 100 => drift 16.5s; rate alone would take 33s.
    env.emit({
      position: makePosition(100),
      maximumPosition: 120,
      buffered: { audio: audioRanges, video: videoRanges, text: null },
    });
    expect(env.seekCalls).toHaveLength(1);
    const seekTarget = env.seekCalls[0];
    expect(seekTarget - 100).toBeLessThanOrEqual(2);
    expect(seekTarget - 100).toBeGreaterThan(0);
    // The landing point is covered by both the audio and video buffers.
    expect(audioRanges.some((r) => r.start <= seekTarget && seekTarget < r.end)).toBe(
      true,
    );
    expect(videoRanges.some((r) => r.start <= seekTarget && seekTarget < r.end)).toBe(
      true,
    );
    // Rate is still raised to its maximum for the remaining drift.
    expect(env.references.effectiveSpeedRef.getValue()).toBe(1.5);
    env.canceller.cancel("done");
  });

  it("does not seek when the target is not covered by both audio and video buffers", () => {
    const env = setupCatchUp();
    // Video buffer stops right at the current position: no valid landing point.
    env.emit({
      position: makePosition(100),
      maximumPosition: 120,
      buffered: {
        audio: [{ start: 90, end: 130 }],
        video: [{ start: 90, end: 100 }],
        text: null,
      },
    });
    expect(env.seekCalls).toHaveLength(0);
    // Rate adjustment still applies.
    expect(env.references.effectiveSpeedRef.getValue()).toBe(1.5);
    env.canceller.cancel("done");
  });

  it("does not catch up while paused and keeps the playhead rate untouched", () => {
    const env = setupCatchUp();
    env.emit({
      paused: { last: true, pending: undefined },
      position: makePosition(100),
      maximumPosition: 109,
    });
    expect(env.references.stateRef.getValue().isCatchingUp).toBe(false);
    expect(env.references.effectiveSpeedRef.getValue()).toBe(1);
    expect(env.rateCalls).toHaveLength(0);
    expect(env.seekCalls).toHaveLength(0);
    env.canceller.cancel("done");
  });

  it("suspends catch-up without touching the media rate while rebuffering", () => {
    const env = setupCatchUp();
    // First enter an active catch-up.
    env.emit({ position: makePosition(100), maximumPosition: 109 });
    expect(env.references.stateRef.getValue().isCatchingUp).toBe(true);
    expect(env.references.effectiveSpeedRef.getValue()).toBe(1.5);
    const rateCallsBeforeRebuffer = env.rateCalls.length;
    const seekCallsBeforeRebuffer = env.seekCalls.length;

    // A rebuffering begins: the RebufferingController owns the media rate now.
    env.emit({
      position: makePosition(100),
      maximumPosition: 109,
      rebuffering: { reason: "buffering", timestamp: 1, position: null },
    });
    expect(env.references.stateRef.getValue().isCatchingUp).toBe(false);
    // The effective speed used by the ABR goes back to the viewer-set rate...
    expect(env.references.effectiveSpeedRef.getValue()).toBe(1);
    // ...but this controller performs no new action while rebuffering: it does
    // not write a media rate nor seek, the RebufferingController is in charge.
    expect(env.rateCalls).toHaveLength(rateCallsBeforeRebuffer);
    expect(env.seekCalls).toHaveLength(seekCallsBeforeRebuffer);

    // Once rebuffering ends and we are still behind, catch-up resumes.
    env.emit({ position: makePosition(100), maximumPosition: 109 });
    expect(env.references.stateRef.getValue().isCatchingUp).toBe(true);
    expect(env.references.effectiveSpeedRef.getValue()).toBe(1.5);
    env.canceller.cancel("done");
  });

  it("does not catch up on VOD (non-live) contents", () => {
    const env = setupCatchUp({ isLive: false, isDynamic: false });
    env.emit({
      position: makePosition(100),
      maximumPosition: 1000,
    });
    expect(env.references.stateRef.getValue().isCatchingUp).toBe(false);
    expect(env.references.effectiveSpeedRef.getValue()).toBe(1);
    expect(env.rateCalls).toHaveLength(0);
    expect(env.seekCalls).toHaveLength(0);
    env.canceller.cancel("done");
  });

  it("uses the manifest's suggestedPresentationDelay as the target gap", () => {
    const env = setupCatchUp({ suggestedPresentationDelay: 6 });
    // gap of 6.2 => drift of 0.2, inside the 0.4 tolerance: no catch-up.
    env.emit({
      position: makePosition(100),
      maximumPosition: 106.2,
    });
    expect(env.references.stateRef.getValue().isCatchingUp).toBe(false);
    expect(env.references.effectiveSpeedRef.getValue()).toBe(1);
    // gap of 7 => drift of 1, outside the tolerance: catch-up starts.
    env.emit({
      position: makePosition(100),
      maximumPosition: 107,
    });
    expect(env.references.stateRef.getValue().isCatchingUp).toBe(true);
    expect(env.references.effectiveSpeedRef.getValue()).toBeGreaterThan(1);
    env.canceller.cancel("done");
  });

  it("never goes above 1.5 even with a large drift", () => {
    const env = setupCatchUp();
    env.emit({
      position: makePosition(0),
      maximumPosition: 60,
    });
    expect(env.references.effectiveSpeedRef.getValue()).toBeLessThanOrEqual(1.5);
    env.canceller.cancel("done");
  });

  it("uses a manual viewer rate of 1.5 as the floor while catching up", () => {
    const env = setupCatchUp();
    env.speedRef.setValue(1.5);
    env.emit({
      position: makePosition(100),
      maximumPosition: 109,
    });
    // Viewer asked 1.5: the effective rate cannot be lower, and cannot exceed
    // the 1.5 catch-up ceiling, so it stays 1.5.
    expect(env.references.effectiveSpeedRef.getValue()).toBe(1.5);
    expect(env.speedRef.getValue()).toBe(1.5);
    env.canceller.cancel("done");
  });

  it("uses the 10s default target for a regular (non low-latency) live content", () => {
    const env = setupCatchUp({ suggestedPresentationDelay: undefined });
    // Rebuild the controller in regular live mode: target gap is 10s.
    env.canceller.cancel("done");
    const regular = makeRegularLiveCatchUp();
    // A 10.3s gap is within 10 +/- 0.4: no catch-up.
    regular.emit({ position: makePosition(100), maximumPosition: 110.3 });
    expect(regular.references.stateRef.getValue().isCatchingUp).toBe(false);
    // An 11s gap means a 1s drift: catch-up starts.
    regular.emit({ position: makePosition(100), maximumPosition: 111 });
    expect(regular.references.stateRef.getValue().isCatchingUp).toBe(true);
    expect(regular.references.effectiveSpeedRef.getValue()).toBeGreaterThan(1);
    regular.canceller.cancel("done");
  });

  it("stopLiveCatchUpController restores the viewer-set rate", () => {
    const env = setupCatchUp();
    env.emit({
      position: makePosition(100),
      maximumPosition: 109,
    });
    expect(env.references.effectiveSpeedRef.getValue()).toBe(1.5);
    const restoredRates: number[] = [];
    stopLiveCatchUpController(env.speedRef, env.references, (rate) => {
      restoredRates.push(rate);
    });
    expect(env.references.effectiveSpeedRef.getValue()).toBe(1);
    expect(restoredRates[restoredRates.length - 1]).toBe(1);
    expect(env.references.stateRef.getValue().isCatchingUp).toBe(false);
    env.canceller.cancel("done");
  });
});

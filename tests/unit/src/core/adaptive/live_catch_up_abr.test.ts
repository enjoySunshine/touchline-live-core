import { describe, it, expect, vi, afterEach } from "vitest";
import type {
  IAdaptiveRepresentationSelectorArguments,
  IRepresentationEstimatorPlaybackObservation,
} from "../../../../../src/core/adaptive/adaptive_representation_selector.ts";
import createAdaptiveRepresentationSelector from "../../../../../src/core/adaptive/adaptive_representation_selector.ts";
import type {
  IAdaptation,
  IManifest,
  IRepresentation,
  IPeriod,
} from "../../../../../src/manifest/index.ts";
import SharedReference from "../../../../../src/utils/reference.ts";
import TaskCanceller from "../../../../../src/utils/task_canceller.ts";
import {
  DummyManifest,
  DummyPeriod,
  DummyAdaptation,
  DummyRepresentation,
  createSegment,
} from "../../../mocks/manifest.ts";
import {
  makeReadyOnlyPlaybackObserver,
  DummyObservationPosition,
} from "../../../mocks/playback_observer.ts";

vi.mock("../../../../../src/log", () => ({
  default: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

/** The four video bitrates available, as in dash_content_envivio. */
const ENVIVIO_BITRATES = [480000, 750000, 1200000, 1850000];

/**
 * A 2-second segment of the 1,200,000 bps Representation.
 *
 * The ABR applies a 0.72 regular factor, so a track is maintained when the
 * measured bandwidth reaches bitrate / 0.72. We thus size the sample so the
 * measured bandwidth is exactly that:
 *   measuredBw = size * 8 / downloadS = 1,200,000 / 0.72
 * With a 2s segment of 300,000 bytes (1,200,000 bps), a 1.4s download yields
 * a measured bandwidth of ~1,714,000 bps, which once multiplied by the 0.72
 * factor stays just above 1,200,000 bps.
 */
const SEGMENT_DURATION_S = 2;
const SEGMENT_DOWNLOAD_MS = 1400;
const SEGMENT_BYTES = 300000;

/** Build an observation position at the given wanted/polled time. */
function makePosition(time: number): InstanceType<typeof DummyObservationPosition> {
  return new DummyObservationPosition({ getWanted: () => time });
}

function makeAbrOptions(): IAdaptiveRepresentationSelectorArguments {
  return {
    initialBitrates: { video: 1200000 },
    lowLatencyMode: true,
    throttlers: { limitResolution: {}, throttleBitrate: {} },
  };
}

function makeContext(): {
  manifest: IManifest;
  adaptation: IAdaptation;
  period: IPeriod;
} {
  return {
    manifest: new DummyManifest({ isDynamic: true, isLive: true }),
    period: new DummyPeriod(),
    adaptation: new DummyAdaptation({ type: "video" }),
  };
}

/**
 * Run one full ABR scenario:
 *   - the four envivio bitrates are available,
 *   - 18 seconds of buffer are available,
 *   - 2s segments of the 1.2Mbps track keep being downloaded at a measured
 *     bandwidth sufficient to maintain it at speed 1,
 *   - the playback observation uses the given `speed`.
 * Returns the bitrate selected after enough samples have been collected.
 */
function runScenario(speed: number): number | undefined {
  const selector = createAdaptiveRepresentationSelector(makeAbrOptions());
  const representations = ENVIVIO_BITRATES.map(
    (bitrate, i) => new DummyRepresentation({ id: `r${i}`, bitrate }),
  );

  const observer =
    makeReadyOnlyPlaybackObserver<IRepresentationEstimatorPlaybackObservation>({
      bufferGap: 18,
      position: makePosition(100),
      speed,
      duration: 10000,
      maximumPosition: 109,
    });

  const canceller = new TaskCanceller("abr scenario");
  const currentRepRef = new SharedReference<IRepresentation | null>(representations[2]);
  const repsRef = new SharedReference(representations);

  const { estimates, callbacks } = selector(
    makeContext(),
    currentRepRef,
    repsRef,
    observer.observer,
    canceller.signal,
  );

  // Feed several segment metrics, mirroring "连续几段都是这个用时".
  for (let i = 0; i < 5; i++) {
    callbacks.metrics({
      requestDuration: SEGMENT_DOWNLOAD_MS,
      size: SEGMENT_BYTES,
      segmentDuration: SEGMENT_DURATION_S,
      content: {
        representation: representations[2],
        adaptation: new DummyAdaptation(),
        segment: createSegment({
          isInit: false,
          complete: true,
          duration: SEGMENT_DURATION_S,
        }),
      },
    });
    callbacks.addedSegment({
      buffered: [{ start: 0, end: 118 }],
      content: { representation: representations[2] },
    });
    // Re-emit the observation so the estimator re-evaluates with the new
    // sample and the requested speed.
    observer.emit({
      bufferGap: 18,
      position: makePosition(100 + i),
      speed,
      duration: 10000,
      maximumPosition: 109 + i,
    });
  }

  const chosen = estimates.getValue().representation?.bitrate;
  canceller.cancel("done");
  return chosen;
}

describe("ABR with the envivio four-bitrate ladder", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("keeps the 1,200,000 bps track at viewer speed 1 (18s buffer)", () => {
    expect(runScenario(1)).toBe(1200000);
  });

  it("drops to 750,000 bps when the viewer sets the rate to 1.5", () => {
    expect(runScenario(1.5)).toBe(750000);
  });

  it("drops to 750,000 bps when the viewer sets the rate to 2", () => {
    expect(runScenario(2)).toBe(750000);
  });

  it("keeps 1,200,000 bps during catch-up: ABR uses the same 1.5 rate as the media element", () => {
    // This reproduces the requirement that, while catching up, the media
    // element plays at 1.5 and the adaptive logic relies on that exact same
    // 1.5 value (not the viewer-set 1, which stays displayed on the page).
    //
    // The measured bandwidth is high enough that dividing it by 1.5 still
    // leaves a chosen bitrate above 1,200,000 bps:
    //   measured bandwidth ~= 3,000,000 * 0.72 = 2,571,000 bps
    //   after the 1.5 division ~= 1,714,000 bps -> 1,200,000 bps track
    const selector = createAdaptiveRepresentationSelector(makeAbrOptions());
    const representations = ENVIVIO_BITRATES.map(
      (bitrate, i) => new DummyRepresentation({ id: `r${i}`, bitrate }),
    );
    const observer =
      makeReadyOnlyPlaybackObserver<IRepresentationEstimatorPlaybackObservation>({
        bufferGap: 18,
        position: makePosition(100),
        speed: 1.5, // same value applied to the media element during catch-up
        duration: 10000,
        maximumPosition: 109,
      });
    const canceller = new TaskCanceller("abr catch-up scenario");
    const currentRepRef = new SharedReference<IRepresentation | null>(representations[2]);
    const { estimates, callbacks } = selector(
      makeContext(),
      currentRepRef,
      new SharedReference(representations),
      observer.observer,
      canceller.signal,
    );
    for (let i = 0; i < 5; i++) {
      callbacks.metrics({
        // 600,000 bytes in 1.6s => 3,000,000 bps measured bandwidth
        requestDuration: 1600,
        size: 600000,
        segmentDuration: SEGMENT_DURATION_S,
        content: {
          representation: representations[2],
          adaptation: new DummyAdaptation(),
          segment: createSegment({
            isInit: false,
            complete: true,
            duration: SEGMENT_DURATION_S,
          }),
        },
      });
      callbacks.addedSegment({
        buffered: [{ start: 0, end: 118 }],
        content: { representation: representations[2] },
      });
      observer.emit({
        bufferGap: 18,
        position: makePosition(100 + i),
        speed: 1.5,
        duration: 10000,
        maximumPosition: 109 + i,
      });
    }
    expect(estimates.getValue().representation?.bitrate).toBe(1200000);
    canceller.cancel("done");
  });
});

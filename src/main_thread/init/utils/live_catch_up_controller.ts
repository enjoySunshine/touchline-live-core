/**
 * Copyright 2015 CANAL+ Group
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import config from "../../../config.ts";
import log from "../../../log.ts";
import type { IManifestMetadata } from "../../../manifest/index.ts";
import type { IReadOnlyPlaybackObserver } from "../../../playback_observer/index.ts";
import type { IRange } from "../../../utils/ranges.ts";
import { isTimeInRanges } from "../../../utils/ranges.ts";
import type { IReadOnlySharedReference } from "../../../utils/reference.ts";
import SharedReference from "../../../utils/reference.ts";
import type { CancellationSignal } from "../../../utils/task_canceller.ts";
import type { ICorePlaybackObservation } from "./create_core_playback_observer.ts";

/**
 * Payload emitted through the reference returned by `createLiveCatchUpController`
 * each time the catch-up state changes.
 */
export interface ILiveCatchUpState {
  /**
   * `true` while the player is actively catching up with the live edge (that
   * is, while the effective playback rate is higher than the one set by the
   * viewer or while a catch-up seek is being performed).
   */
  isCatchingUp: boolean;
  /**
   * Distance, in seconds, between the current position and the live edge at
   * the time the state was last computed.
   * `undefined` if it cannot be computed yet.
   */
  liveGap: number | undefined;
  /**
   * Effective playback rate currently applied to the media element.
   * It equals the viewer-set rate when no catch-up is ongoing.
   */
  effectiveSpeed: number;
}

/**
 * Distance from the live edge the player should try to maintain, in seconds.
 * It mirrors the logic used to choose the initial position: the manifest's
 * `suggestedPresentationDelay` if set, else a default depending on whether the
 * low-latency mode is enabled.
 */
function getTargetLiveGap(manifest: IManifestMetadata, lowLatencyMode: boolean): number {
  const { DEFAULT_LIVE_GAP } = config.getCurrent();
  return (
    manifest.suggestedPresentationDelay ??
    (lowLatencyMode ? DEFAULT_LIVE_GAP.LOW_LATENCY : DEFAULT_LIVE_GAP.DEFAULT)
  );
}

/**
 * Returns `true` when the given target position is covered by the given
 * buffered ranges. A `null` value means the corresponding media type has no
 * buffer (e.g. audio-only or video-only content), in which case it does not
 * constrain the target.
 */
function isTargetBuffered(ranges: IRange[] | null, targetPosition: number): boolean {
  return ranges === null || isTimeInRanges(ranges, targetPosition);
}

/**
 * Create the references through which the live catch-up mechanism communicates
 * its effective playback rate and its current state.
 *
 * This is the first of two initialization steps: it does not rely on a
 * playback observer, so the returned `effectiveSpeedRef` can immediately be
 * used to build the core playback observer. Call `startLiveCatchUpController`
 * once that observer is available to actually begin the catch-up logic.
 * @param speedRef - Reference emitting the playback rate set by the viewer.
 * @returns References to feed into `startLiveCatchUpController` and the rest
 * of the player.
 */
export function createLiveCatchUpReferences(speedRef: IReadOnlySharedReference<number>): {
  effectiveSpeedRef: SharedReference<number>;
  stateRef: SharedReference<ILiveCatchUpState>;
} {
  const effectiveSpeedRef = new SharedReference<number>(speedRef.getValue());
  const stateRef = new SharedReference<ILiveCatchUpState>({
    isCatchingUp: false,
    liveGap: undefined,
    effectiveSpeed: effectiveSpeedRef.getValue(),
  });
  return { effectiveSpeedRef, stateRef };
}

/**
 * Start the "live catch-up" mechanism.
 *
 * While a live content plays, the player is expected to stay at a fixed
 * distance from the live edge (the same distance than the one chosen at
 * content start). This module makes sure of that by:
 *
 *   - raising the media element's playback rate (up to a configured maximum)
 *     while the position is too far behind the live edge. The rate applied
 *     here is also communicated to the adaptive bitrate logic through the
 *     `effectiveSpeedRef` reference, so representation choices rely on the
 *     exact same rate than the one actually used for playback.
 *
 *   - performing short, bounded seeks over already-buffered content when
 *     changing the playback rate alone would not be sufficient to come back to
 *     the target distance in time. Seeks only land on positions present in
 *     both the audio and video buffers so the two tracks stay synchronized.
 *
 * The viewer-set playback rate is never modified by this logic: callers keep
 * updating `speedRef` and the rate read by the application stays the one the
 * viewer set. Likewise, nothing happens while the content is paused or while
 * it is not a live content.
 *
 * @param params
 * @param cancellationSignal
 */
export function startLiveCatchUpController(
  params: {
    /** Manifest of the live content being played. */
    manifest: IManifestMetadata;
    /** `true` if the content is played in low-latency mode. */
    lowLatencyMode: boolean;
    /** Reference emitting the playback rate last set by the viewer. */
    speedRef: IReadOnlySharedReference<number>;
    /** Observer emitting regular playback observations. */
    playbackObserver: IReadOnlyPlaybackObserver<ICorePlaybackObservation>;
    /** Seek to the given (internal) position on the media element. */
    seekTo: (position: number) => void;
    /** Apply the given playback rate to the media element. */
    setPlaybackRate: (rate: number) => void;
    /** References created through `createLiveCatchUpReferences`. */
    references: {
      effectiveSpeedRef: SharedReference<number>;
      stateRef: SharedReference<ILiveCatchUpState>;
    };
  },
  cancellationSignal: CancellationSignal,
): void {
  const {
    manifest,
    lowLatencyMode,
    speedRef,
    playbackObserver,
    seekTo,
    setPlaybackRate,
  } = params;
  const { effectiveSpeedRef, stateRef } = params.references;
  const {
    LIVE_CATCH_UP_MAX_RATE,
    LIVE_CATCH_UP_TOLERANCE,
    LIVE_CATCH_UP_MAX_DURATION,
    LIVE_CATCH_UP_MAX_SEEK,
    LIVE_CATCH_UP_MAX_A_V_DESYNC_MS,
  } = config.getCurrent();

  startLiveCatchUpObservation(
    {
      manifest,
      lowLatencyMode,
      speedRef,
      playbackObserver,
      seekTo,
      setPlaybackRate,
      effectiveSpeedRef,
      stateRef,
    },
    {
      LIVE_CATCH_UP_MAX_RATE,
      LIVE_CATCH_UP_TOLERANCE,
      LIVE_CATCH_UP_MAX_DURATION,
      LIVE_CATCH_UP_MAX_SEEK,
      LIVE_CATCH_UP_MAX_A_V_DESYNC_MS,
    },
    cancellationSignal,
  );
}

/**
 * Restore the viewer-set playback rate on the media element and mark the
 * catch-up mechanism as inactive. To call when the content is stopped or
 * reloaded.
 */
export function stopLiveCatchUpController(
  speedRef: IReadOnlySharedReference<number>,
  references: {
    effectiveSpeedRef: SharedReference<number>;
    stateRef: SharedReference<ILiveCatchUpState>;
  },
  setPlaybackRate: (rate: number) => void,
): void {
  const { effectiveSpeedRef, stateRef } = references;
  const viewerSpeed = speedRef.getValue();
  if (effectiveSpeedRef.getValue() !== viewerSpeed) {
    effectiveSpeedRef.setValue(viewerSpeed);
    setPlaybackRate(viewerSpeed);
  }
  setState(stateRef, false, stateRef.getValue().liveGap, viewerSpeed);
}

/**
 * Internal configuration values used by the catch-up observation logic,
 * extracted from the global config once.
 */
interface ILiveCatchUpConfigValues {
  LIVE_CATCH_UP_MAX_RATE: number;
  LIVE_CATCH_UP_TOLERANCE: number;
  LIVE_CATCH_UP_MAX_DURATION: number;
  LIVE_CATCH_UP_MAX_SEEK: number;
  LIVE_CATCH_UP_MAX_A_V_DESYNC_MS: number;
}

/**
 * Dependencies needed by `startLiveCatchUpObservation`, including the
 * references shared with the rest of the player.
 */
interface ILiveCatchUpObservationArguments {
  manifest: IManifestMetadata;
  lowLatencyMode: boolean;
  speedRef: IReadOnlySharedReference<number>;
  playbackObserver: IReadOnlyPlaybackObserver<ICorePlaybackObservation>;
  seekTo: (position: number) => void;
  setPlaybackRate: (rate: number) => void;
  effectiveSpeedRef: SharedReference<number>;
  stateRef: SharedReference<ILiveCatchUpState>;
}

/**
 * Listen to playback observations and update the effective playback rate and
 * catch-up state accordingly.
 * @param args
 * @param conf
 * @param cancellationSignal
 */
function startLiveCatchUpObservation(
  args: ILiveCatchUpObservationArguments,
  conf: ILiveCatchUpConfigValues,
  cancellationSignal: CancellationSignal,
): void {
  const {
    manifest,
    lowLatencyMode,
    speedRef,
    playbackObserver,
    seekTo,
    setPlaybackRate,
    effectiveSpeedRef,
    stateRef,
  } = args;
  const {
    LIVE_CATCH_UP_MAX_RATE,
    LIVE_CATCH_UP_TOLERANCE,
    LIVE_CATCH_UP_MAX_DURATION,
    LIVE_CATCH_UP_MAX_SEEK,
    LIVE_CATCH_UP_MAX_A_V_DESYNC_MS,
  } = conf;

  playbackObserver.listen(
    (observation) => {
      if (cancellationSignal.isCancelled()) {
        return;
      }
      const viewerSpeed = speedRef.getValue();

      // While the RebufferingController is in charge (rebuffering or freezing),
      // it alone drives the media element's playback rate (setting it to 0 and
      // then restoring the viewer-set rate). The catch-up logic must not fight
      // it, so it stays idle and only resets its own effective-speed reference.
      if (observation.rebuffering !== null || observation.freezing !== null) {
        suspendCatchUp(speedRef, stateRef, effectiveSpeedRef, observation, manifest);
        return;
      }

      // Catch-up only makes sense for an actively-playing live content.
      if (!manifest.isLive || observation.paused.last || viewerSpeed <= 0) {
        stopCatchUp(
          manifest,
          speedRef,
          effectiveSpeedRef,
          stateRef,
          setPlaybackRate,
          observation,
          stateRef.getValue().liveGap,
        );
        return;
      }

      const currentPosition = observation.position.getWanted();
      const liveEdgePosition = observation.maximumPosition;
      const liveGap = liveEdgePosition - currentPosition;
      if (!isFinite(liveGap)) {
        // The live edge cannot be determined reliably yet.
        stopCatchUp(
          manifest,
          speedRef,
          effectiveSpeedRef,
          stateRef,
          setPlaybackRate,
          observation,
        );
        return;
      }
      const targetGap = getTargetLiveGap(manifest, lowLatencyMode);
      const drift = liveGap - targetGap;

      if (drift <= LIVE_CATCH_UP_TOLERANCE) {
        // We are at (or ahead of) the target distance from the live edge.
        stopCatchUp(
          manifest,
          speedRef,
          effectiveSpeedRef,
          stateRef,
          setPlaybackRate,
          observation,
          liveGap,
        );
        return;
      }

      // First, check whether a short seek over buffered content is needed:
      // we seek when even playing at the maximum authorized rate would not
      // allow us to reach the target distance in the allowed duration.
      const rateOnlyClosureTime = drift / (LIVE_CATCH_UP_MAX_RATE - 1);
      if (rateOnlyClosureTime > LIVE_CATCH_UP_MAX_DURATION) {
        const seekTarget = getCatchUpSeekTarget(
          observation,
          currentPosition,
          drift,
          targetGap,
          LIVE_CATCH_UP_MAX_RATE,
          LIVE_CATCH_UP_MAX_DURATION,
          LIVE_CATCH_UP_MAX_SEEK,
          LIVE_CATCH_UP_MAX_A_V_DESYNC_MS,
        );
        if (seekTarget !== null) {
          log.info("Init", "Live catch-up: seeking over buffered content", {
            from: currentPosition,
            to: seekTarget,
            liveGap,
          });
          seekTo(seekTarget);
        }
      }

      // Then, raise the playback rate so the remaining drift is closed as
      // quickly as possible while staying under the maximum authorized rate.
      const neededRate = viewerSpeed + drift / LIVE_CATCH_UP_MAX_DURATION;
      const nextEffectiveSpeed = Math.min(
        LIVE_CATCH_UP_MAX_RATE,
        Math.max(viewerSpeed, neededRate),
      );

      if (effectiveSpeedRef.getValue() !== nextEffectiveSpeed) {
        effectiveSpeedRef.setValue(nextEffectiveSpeed);
        setPlaybackRate(nextEffectiveSpeed);
      }
      setState(stateRef, true, liveGap, nextEffectiveSpeed);
    },
    { includeLastObservation: true, clearSignal: cancellationSignal },
  );

  // Re-evaluate immediately when the viewer changes its rate while no
  // catch-up is ongoing (e.g. switching manually from 1 to 1.5).
  speedRef.onUpdate(
    () => {
      if (cancellationSignal.isCancelled() || stateRef.getValue().isCatchingUp) {
        return;
      }
      const viewerSpeed = speedRef.getValue();
      if (effectiveSpeedRef.getValue() !== viewerSpeed) {
        effectiveSpeedRef.setValue(viewerSpeed);
        setPlaybackRate(viewerSpeed);
        setState(stateRef, false, stateRef.getValue().liveGap, viewerSpeed);
      }
    },
    { clearSignal: cancellationSignal },
  );
}

/**
 * End the current catch-up phase, if any, and restore the viewer-set rate.
 */
function stopCatchUp(
  manifest: IManifestMetadata,
  speedRef: IReadOnlySharedReference<number>,
  effectiveSpeedRef: SharedReference<number>,
  stateRef: SharedReference<ILiveCatchUpState>,
  setPlaybackRate: (rate: number) => void,
  observation: ICorePlaybackObservation,
  knownLiveGap?: number,
): void {
  const viewerSpeed = speedRef.getValue();
  if (effectiveSpeedRef.getValue() !== viewerSpeed) {
    effectiveSpeedRef.setValue(viewerSpeed);
    setPlaybackRate(viewerSpeed);
  }
  let liveGap = knownLiveGap;
  if (liveGap === undefined && manifest.isLive) {
    const gap = observation.maximumPosition - observation.position.getWanted();
    if (isFinite(gap)) {
      liveGap = gap;
    }
  }
  setState(stateRef, false, liveGap, viewerSpeed);
}

/** Update the catch-up state reference only when a value actually changes. */
function setState(
  stateRef: SharedReference<ILiveCatchUpState>,
  isCatchingUp: boolean,
  liveGap: number | undefined,
  effectiveSpeed: number,
): void {
  const current = stateRef.getValue();
  if (
    current.isCatchingUp !== isCatchingUp ||
    current.effectiveSpeed !== effectiveSpeed ||
    current.liveGap !== liveGap
  ) {
    stateRef.setValue({ isCatchingUp, liveGap, effectiveSpeed });
  }
}

/**
 * Suspend the catch-up mechanism while another component (the
 * RebufferingController) drives the media element's playback rate.
 *
 * Unlike `stopCatchUp`, this does not write anything to the media element: it
 * only resets the effective-speed reference to the viewer-set rate so the
 * adaptive logic does not reason on a catch-up rate while playback is stalled,
 * and reports the catch-up as inactive.
 */
function suspendCatchUp(
  speedRef: IReadOnlySharedReference<number>,
  stateRef: SharedReference<ILiveCatchUpState>,
  effectiveSpeedRef: SharedReference<number>,
  observation: ICorePlaybackObservation,
  manifest: IManifestMetadata,
): void {
  const viewerSpeed = speedRef.getValue();
  if (effectiveSpeedRef.getValue() !== viewerSpeed) {
    effectiveSpeedRef.setValue(viewerSpeed);
  }
  let liveGap: number | undefined;
  if (manifest.isLive) {
    const gap = observation.maximumPosition - observation.position.getWanted();
    if (isFinite(gap)) {
      liveGap = gap;
    }
  }
  setState(stateRef, false, liveGap, viewerSpeed);
}

/**
 * Compute the position to seek to when catching up.
 *
 * The seek is bounded so it never jumps over more than
 * `LIVE_CATCH_UP_MAX_SEEK` seconds of already-buffered content and its
 * landing position has to be present in both the audio and video buffers
 * (with a small tolerance to account for minor inter-track differences).
 *
 * Returns `null` when no valid target can be found.
 */
function getCatchUpSeekTarget(
  observation: ICorePlaybackObservation,
  currentPosition: number,
  drift: number,
  targetGap: number,
  maxRate: number,
  maxDuration: number,
  maxSeek: number,
  maxAVDesyncMs: number,
): number | null {
  // Seek just far enough for the maximum rate to be able to finish the work
  // in time, but never more than the authorized amount of buffered content.
  const maxSeekDistance = Math.min(maxSeek, drift - (maxRate - 1) * maxDuration);
  if (!(maxSeekDistance > 0)) {
    return null;
  }
  const idealTarget = Math.min(
    currentPosition + maxSeekDistance,
    observation.maximumPosition - targetGap,
  );

  const { buffered } = observation;
  const audioRanges = buffered.audio;
  const videoRanges = buffered.video;
  const aVDesyncTolerance = maxAVDesyncMs / 1000;

  // Try the ideal target first, then walk back in small steps until a
  // position covered by every active track is found.
  for (
    let candidate = idealTarget;
    candidate >= currentPosition;
    candidate -= aVDesyncTolerance
  ) {
    if (
      isTargetBuffered(audioRanges, candidate) &&
      isTargetBuffered(videoRanges, candidate)
    ) {
      const seekDistance = candidate - currentPosition;
      if (seekDistance <= maxSeek && seekDistance > 0) {
        return candidate;
      }
      return null;
    }
  }
  return null;
}

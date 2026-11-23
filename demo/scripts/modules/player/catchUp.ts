// Live catch-up is now handled inside the RxPlayer itself, independently of
// any application-side toggle: the player maintains the same distance from the
// live edge than the one chosen when the content started, on every live
// content. It does so without changing the viewer-set playback rate (readable
// through `getPlaybackRate`) and without replacing the adaptive bitrate logic.
//
// This controller is kept as a thin compatibility layer so the demo's existing
// "stick to live edge" toggle keeps working as a UI control, but it no longer
// performs any seek or playback rate change itself.

import type { IPlayerModuleState } from ".";
import type RxPlayer from "../../../../src/index.ts";
import type { IStateUpdater } from "../../lib/declareModule.ts";

/**
 * Compatibility controller for the demo's catch-up toggle.
 *
 * The actual catch-up mechanism lives in the player core and is always active
 * for live contents, whatever the toggle state. This class only reflects the
 * toggle in the demo state and listens to the player's `liveCatchUpStateChange`
 * event to surface when an internal catch-up is ongoing.
 */
export default class CatchUpModeController {
  private _rxPlayer: RxPlayer;
  private _state: IStateUpdater<IPlayerModuleState>;
  private _onCatchUpState:
    | ((evt: {
        isCatchingUp: boolean;
        liveGap: number | undefined;
        effectiveSpeed: number;
      }) => void)
    | null;

  constructor(rxPlayer: RxPlayer, state: IStateUpdater<IPlayerModuleState>) {
    this._rxPlayer = rxPlayer;
    this._state = state;
    this._onCatchUpState = null;
  }

  enableCatchUp() {
    // The core catch-up mechanism is always active; this only updates the
    // demo's toggle state.
    this._state.update("isCatchUpEnabled", true);
    this._startListening();
  }

  stopCatchUp() {
    if (this._onCatchUpState !== null) {
      this._rxPlayer.removeEventListener("liveCatchUpStateChange", this._onCatchUpState);
      this._onCatchUpState = null;
    }
    this._state.updateBulk({
      isCatchUpEnabled: false,
      isCatchingUp: false,
    });
  }

  /**
   * Reflect the player's internal catch-up state in the demo state. The
   * viewer-set playback rate (`playbackRate`) is intentionally left untouched.
   */
  private _startListening() {
    if (this._onCatchUpState !== null) {
      return;
    }
    this._onCatchUpState = (evt) => {
      this._state.update("isCatchingUp", evt.isCatchingUp);
    };
    this._rxPlayer.addEventListener("liveCatchUpStateChange", this._onCatchUpState);
  }
}

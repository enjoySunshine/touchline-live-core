import RxPlayer from "../../../src/minimal.ts";
import * as React from "react";
import Player from "./Player.tsx";

function MainComponent(): React.JSX.Element {
  return (
    <React.Fragment>
      <header>
        <div className="left">
          <h1 className="title">
            <img className="logo" alt="Player" src="./assets/logo_white.png" />
            <span className="version">{" v" + RxPlayer.version}</span>
          </h1>
        </div>
      </header>
      <Player />
    </React.Fragment>
  );
}

export default MainComponent;

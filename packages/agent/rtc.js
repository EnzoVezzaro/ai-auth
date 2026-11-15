// Node WebRTC polyfill for Trystero, backed by node-datachannel (libdatachannel).
//
// libdatachannel negotiates eagerly: createDataChannel() immediately produces a
// local offer, so a fresh initiator reports signalingState "have-local-offer".
// Trystero's initiator expects a browser-style "stable" connection that it moves
// forward itself with setLocalDescription(); against the eager state its
// getOffer() never settles. This subclass hides the eager offer until the
// application asks for it. Wire format and the signaling protocol are unchanged.
import * as polyfill from "node-datachannel/polyfill";

const Base = polyfill.RTCPeerConnection;

export class NodeRTCPeerConnection extends Base {
  #negotiating = false;

  get signalingState() {
    return this.#negotiating ? super.signalingState : "stable";
  }

  get localDescription() {
    return this.#negotiating ? super.localDescription : null;
  }

  get pendingLocalDescription() {
    return this.#negotiating ? super.pendingLocalDescription : null;
  }

  async setLocalDescription(description) {
    this.#negotiating = true;
    return super.setLocalDescription(description);
  }

  async setRemoteDescription(description) {
    this.#negotiating = true;
    return super.setRemoteDescription(description);
  }
}

/** Wrap Trystero's joinRoom so every peer connection uses the Node polyfill. */
export function withNodeRtc(joinRoom) {
  return (config, topic) =>
    joinRoom({ ...config, rtcPolyfill: NodeRTCPeerConnection }, topic);
}

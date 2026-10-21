/**
 * One WebRTC connection to one other player, with a single unordered/unreliable data channel for
 * match traffic (positions, inputs): a late packet should be dropped, not queued behind by a
 * reliable/ordered channel the way a WebSocket frame would be. SDP/ICE is exchanged by whoever owns
 * this (a `LiveRoom`) over the hub's signaling socket; this class never talks to the hub.
 *
 * `iceServers` come from the hub's welcome message (public STUN + short-lived TURN credentials), so
 * players behind strict NATs can still connect through the relay.
 */
export type PeerLinkState = 'connecting' | 'connected' | 'disconnected' | 'failed';

/** What a `LiveRoom` needs from a link; lets tests substitute a fake. */
export interface Link {
  readonly state: PeerLinkState;
  onState: (s: PeerLinkState) => void;
  onMessage: (data: string) => void;
  onSignal: (data: unknown) => void;
  start(): Promise<void>;
  onSignalReceived(data: unknown): Promise<void>;
  send(data: string): void;
  close(): void;
}

export type LinkFactory = (initiator: boolean, iceServers: RTCIceServer[]) => Link;

export const createPeerLink: LinkFactory = (initiator, iceServers) =>
  new PeerLink(initiator, iceServers);

export class PeerLink implements Link {
  readonly pc: RTCPeerConnection;
  private channel: RTCDataChannel | null = null;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private _state: PeerLinkState = 'connecting';
  onState: (s: PeerLinkState) => void = () => {};
  onMessage: (data: string) => void = () => {};
  /** Emits ICE candidates and the local offer/answer; the caller relays them over signaling. */
  onSignal: (data: unknown) => void = () => {};

  constructor(initiator: boolean, iceServers: RTCIceServer[], channelLabel = 'data') {
    this.pc = new RTCPeerConnection({ iceServers });
    this.pc.onicecandidate = (e) => {
      if (e.candidate) this.onSignal({ kind: 'ice', candidate: e.candidate.toJSON() });
    };
    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      this.setState(
        s === 'connected'
          ? 'connected'
          : s === 'failed'
            ? 'failed'
            : s === 'closed'
              ? 'disconnected'
              : 'connecting',
      );
    };
    if (initiator) {
      this.wireChannel(
        this.pc.createDataChannel(channelLabel, { ordered: false, maxRetransmits: 0 }),
      );
    } else {
      this.pc.ondatachannel = (e) => this.wireChannel(e.channel);
    }
  }

  get state(): PeerLinkState {
    return this._state;
  }

  /** Starts the handshake (the joining side calls this; the host waits for the offer instead). */
  async start(): Promise<void> {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.onSignal({ kind: 'offer', sdp: offer.sdp });
  }

  /** One relayed signaling payload from the peer (offer, answer, or an ICE candidate). */
  async onSignalReceived(data: unknown): Promise<void> {
    const msg = data as { kind?: string; sdp?: string; candidate?: RTCIceCandidateInit };
    if (msg.kind === 'offer' && msg.sdp) {
      await this.pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
      await this.drainCandidates();
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      this.onSignal({ kind: 'answer', sdp: answer.sdp });
    } else if (msg.kind === 'answer' && msg.sdp) {
      await this.pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
      await this.drainCandidates();
    } else if (msg.kind === 'ice' && msg.candidate) {
      if (this.pc.remoteDescription) await this.pc.addIceCandidate(msg.candidate);
      else this.pendingCandidates.push(msg.candidate); // arrived before the offer/answer
    }
  }

  send(data: string): void {
    if (this.channel?.readyState === 'open') this.channel.send(data);
  }

  close(): void {
    this.channel?.close();
    this.pc.close();
    this.setState('disconnected');
  }

  private async drainCandidates(): Promise<void> {
    for (const c of this.pendingCandidates.splice(0)) await this.pc.addIceCandidate(c);
  }

  private wireChannel(ch: RTCDataChannel): void {
    this.channel = ch;
    ch.onmessage = (e) => this.onMessage(e.data as string);
    ch.onopen = () => this.setState('connected');
    ch.onclose = () => this.setState('disconnected');
  }

  private setState(s: PeerLinkState): void {
    if (s === this._state) return;
    this._state = s;
    this.onState(s);
  }
}

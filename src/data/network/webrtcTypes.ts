export interface IStrictDataChannel {
  send(data: string): void;
  close(): void;
  addEventListener(type: 'message', listener: (event: { data: string }) => void): void;
  addEventListener(type: 'open' | 'close', listener: () => void): void;
}

export interface IStrictPeerConnection {
  iceConnectionState: string;
  localDescription: unknown;
  remoteDescription: unknown;
  close(): void;
  createDataChannel(label: string, options?: object): IStrictDataChannel;
  createOffer(options?: object): Promise<unknown>;
  createAnswer(options?: object): Promise<unknown>;
  setLocalDescription(desc: unknown): Promise<void>;
  setRemoteDescription(desc: unknown): Promise<void>;
  addIceCandidate(candidate: unknown): Promise<void>;
  addEventListener(type: 'iceconnectionstatechange', listener: () => void): void;
  addEventListener(type: 'icecandidate', listener: (event: { candidate: unknown }) => void): void;
  addEventListener(type: 'datachannel', listener: (event: { channel: IStrictDataChannel }) => void): void;
}

export interface SignalingPacket {
  senderId: string;
  type: string;
  payload: unknown;
}

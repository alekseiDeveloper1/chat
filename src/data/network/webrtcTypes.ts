export interface IStrictDataChannel {
  readonly readyState: string;
  readonly bufferedAmount: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: 'open' | 'close' | 'error', listener: () => void): void;
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

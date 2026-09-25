export type ConnectionStatus = 'disconnected' | 'signaling' | 'connecting' | 'connected' | 'failed';

export interface DisconnectOptions {
  navigateHome?: boolean;
  reason?: string;
}

export interface INetworkService {
  connect(roomHash: string): Promise<void>;

  sendData(payload: string): Promise<void>;

  onDataReceived(callback: (payload: string) => void): void;

  onStatusChanged(callback: (status: ConnectionStatus) => void): void;

  disconnect(options?: DisconnectOptions): void;
}

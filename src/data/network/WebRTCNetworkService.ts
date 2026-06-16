import { INetworkService, ConnectionStatus } from '../../domain/services/INetworkService';

export class WebRTCNetworkService implements INetworkService {
  private peerConnection: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;
  
  private statusCallback: ((status: ConnectionStatus) => void) | null = null;
  private dataCallback: ((payload: string) => void) | null = null;

  onStatusChanged(callback: (status: ConnectionStatus) => void): void {
    this.statusCallback = callback;
  }

  onDataReceived(callback: (payload: string) => void): void {
    this.dataCallback = callback;
  }

  async connect(roomHash: string): Promise<void> {
    this.updateStatus('signaling');

    const configuration = {
      iceServers: [{ urls: 'stun:://google.com' }]
    };

    this.peerConnection = new RTCPeerConnection(configuration);

    this.setupDataChannel(
      this.peerConnection.createDataChannel('chat-channel', { ordered: true })
    );

    this.peerConnection.oniceconnectionstatechange = () => {
      if (!this.peerConnection) return;
      const state = this.peerConnection.iceConnectionState;
      if (state === 'connected') this.updateStatus('connected');
      if (state === 'failed') this.updateStatus('failed');
      if (state === 'disconnected') this.updateStatus('disconnected');
    };
  }

  private setupDataChannel(channel: RTCDataChannel) {
    this.dataChannel = channel;
    
    this.dataChannel.onmessage = (event) => {
      if (this.dataCallback) {
        this.dataCallback(event.data);
      }
    };

    this.dataChannel.onopen = () => this.updateStatus('connected');
    this.dataChannel.onclose = () => this.updateStatus('disconnected');
  }

  async sendData(payload: string): Promise<void> {
    if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
      throw new Error('Нет активного P2P соединения');
    }
    this.dataChannel.send(payload);
  }

  async disconnect(): Promise<void> {
    if (this.dataChannel) this.dataChannel.close();
    if (this.peerConnection) this.peerConnection.close();
    
    this.dataChannel = null;
    this.peerConnection = null;
    this.updateStatus('disconnected');
  }

  private updateStatus(status: ConnectionStatus) {
    if (this.statusCallback) {
      this.statusCallback(status);
    }
  }
}

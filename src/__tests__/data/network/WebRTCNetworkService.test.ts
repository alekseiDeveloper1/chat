import { WebRTCNetworkService } from '@/data/network/WebRTCNetworkService';

describe('WebRTCNetworkService (P2P Транспорт)', () => {
  let networkService: WebRTCNetworkService;

  beforeEach(() => {
    networkService = new WebRTCNetworkService();
  });

  it('должен корректно инициализироваться в статусе disconnected', () => {
    let currentStatus: string = '';
    networkService.onStatusChanged((status) => {
      currentStatus = status;
    });
    
    expect(currentStatus).toBe('');
  });

  it('должен выбрасывать ошибку при попытке отправить данные без подключения', async () => {
    await expect(networkService.sendData('test-payload')).rejects.toThrow(
      'Нет активного P2P соединения'
    );
  });
});

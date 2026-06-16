jest.mock('expo-crypto', () => {
    const crypto = require('crypto');
    return {
        digestStringAsync: async (algorithm, str) => {
            return crypto.createHash('sha256').update(str).digest('hex');
        },
        CryptoDigestAlgorithm: {
            SHA256: 'SHA-256',
        },
    };
});
jest.mock('expo-sqlite', () => {
    const mockDb = {
        execAsync: jest.fn().mockResolvedValue(undefined),
        runAsync: jest.fn().mockResolvedValue({ lastInsertRowId: 1, changes: 1 }),
        getFirstAsync: jest.fn().mockResolvedValue(null),
        getAllAsync: jest.fn().mockResolvedValue([]),
        closeAsync: jest.fn().mockResolvedValue(undefined),
    };

    return {
        openDatabaseAsync: jest.fn().mockResolvedValue(mockDb),
        useSQLiteContext: () => mockDb,
    };
});
global.RTCPeerConnection = jest.fn().mockImplementation(() => ({
  createDataChannel: jest.fn().mockReturnValue({
    send: jest.fn(),
    close: jest.fn(),
  }),
  createOffer: jest.fn().mockResolvedValue({ sdp: 'mock-offer', type: 'offer' }),
  setLocalDescription: jest.fn().mockResolvedValue(null),
  setRemoteDescription: jest.fn().mockResolvedValue(null),
  addIceCandidate: jest.fn().mockResolvedValue(null),
  close: jest.fn(),
}));

beforeEach(() => {
    jest.clearAllMocks();
});


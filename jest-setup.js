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
beforeEach(() => {
    jest.clearAllMocks();
});


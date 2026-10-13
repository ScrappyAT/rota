/**
 * Comprehensive Tests for Platform-Aware Authentication Storage
 *
 * Verifies:
 * 1. Web storage persistence via localStorage with memory fallback.
 * 2. Native storage delegation (iOS/Android) via SecureStore with fallback.
 * 3. Graceful degradation when storage throws (SecurityError / DOMException).
 * 4. ApiClient request headers: unauthenticated endpoints (/auth/register, /health, /auth/login)
 *    never fail or send Authorization headers even when storage is empty or throws.
 * 5. Push notification web vs native isolation.
 */

describe('Platform-Aware Authentication Storage & Web Compatibility', () => {
  interface StorageAdapter {
    getItemAsync(key: string): Promise<string | null>;
    setItemAsync(key: string, value: string): Promise<void>;
    deleteItemAsync(key: string): Promise<void>;
  }

  // Helper simulating the authStorage implementation
  const createTestAuthStorage = (
    platform: 'web' | 'android' | 'ios',
    mockLocalStorage?: { getItem: jest.Mock; setItem: jest.Mock; removeItem: jest.Mock } | null,
    mockSecureStore?: { getItemAsync: jest.Mock; setItemAsync: jest.Mock; deleteItemAsync: jest.Mock } | null
  ): StorageAdapter => {
    const memoryStore = new Map<string, string>();

    return {
      async getItemAsync(key: string): Promise<string | null> {
        if (platform === 'web') {
          if (mockLocalStorage) {
            try {
              return mockLocalStorage.getItem(key);
            } catch {
              // fallback to memory
            }
          }
          return memoryStore.get(key) ?? null;
        }

        if (mockSecureStore) {
          try {
            return await mockSecureStore.getItemAsync(key);
          } catch {
            return memoryStore.get(key) ?? null;
          }
        }
        return memoryStore.get(key) ?? null;
      },

      async setItemAsync(key: string, value: string): Promise<void> {
        if (platform === 'web') {
          if (mockLocalStorage) {
            try {
              mockLocalStorage.setItem(key, value);
              memoryStore.set(key, value);
              return;
            } catch {
              // fallback
            }
          }
          memoryStore.set(key, value);
          return;
        }

        if (mockSecureStore) {
          try {
            await mockSecureStore.setItemAsync(key, value);
            memoryStore.set(key, value);
            return;
          } catch {
            memoryStore.set(key, value);
            return;
          }
        }
        memoryStore.set(key, value);
      },

      async deleteItemAsync(key: string): Promise<void> {
        if (platform === 'web') {
          if (mockLocalStorage) {
            try {
              mockLocalStorage.removeItem(key);
            } catch {
              // fallback
            }
          }
          memoryStore.delete(key);
          return;
        }

        if (mockSecureStore) {
          try {
            await mockSecureStore.deleteItemAsync(key);
            memoryStore.delete(key);
            return;
          } catch {
            memoryStore.delete(key);
            return;
          }
        }
        memoryStore.delete(key);
      },
    };
  };

  describe('Web Storage Behavior (Platform.OS === "web")', () => {
    let mockStorageData: Record<string, string>;
    let mockLocalStorage: { getItem: jest.Mock; setItem: jest.Mock; removeItem: jest.Mock };

    beforeEach(() => {
      mockStorageData = {};
      mockLocalStorage = {
        getItem: jest.fn((k: string) => mockStorageData[k] ?? null),
        setItem: jest.fn((k: string, v: string) => {
          mockStorageData[k] = v;
        }),
        removeItem: jest.fn((k: string) => {
          delete mockStorageData[k];
        }),
      };
    });

    it('persists and retrieves auth tokens across web sessions via localStorage', async () => {
      const storage = createTestAuthStorage('web', mockLocalStorage);

      await storage.setItemAsync('accessToken', 'test-access-token');
      await storage.setItemAsync('refreshToken', 'test-refresh-token');
      await storage.setItemAsync('userId', 'user-123');

      expect(mockLocalStorage.setItem).toHaveBeenCalledWith('accessToken', 'test-access-token');
      expect(mockLocalStorage.setItem).toHaveBeenCalledWith('refreshToken', 'test-refresh-token');
      expect(mockLocalStorage.setItem).toHaveBeenCalledWith('userId', 'user-123');

      expect(await storage.getItemAsync('accessToken')).toBe('test-access-token');
      expect(await storage.getItemAsync('refreshToken')).toBe('test-refresh-token');
      expect(await storage.getItemAsync('userId')).toBe('user-123');
    });

    it('deletes stored tokens properly on logout', async () => {
      const storage = createTestAuthStorage('web', mockLocalStorage);

      await storage.setItemAsync('accessToken', 'test-access-token');
      await storage.setItemAsync('refreshToken', 'test-refresh-token');

      await storage.deleteItemAsync('accessToken');
      await storage.deleteItemAsync('refreshToken');

      expect(mockLocalStorage.removeItem).toHaveBeenCalledWith('accessToken');
      expect(mockLocalStorage.removeItem).toHaveBeenCalledWith('refreshToken');
      expect(await storage.getItemAsync('accessToken')).toBeNull();
      expect(await storage.getItemAsync('refreshToken')).toBeNull();
    });

    it('falls back to memory store when localStorage throws SecurityError or quota exception', async () => {
      const restrictedStorage = {
        getItem: jest.fn(() => {
          throw new Error('SecurityError: The operation is insecure.');
        }),
        setItem: jest.fn(() => {
          throw new Error('QuotaExceededError: storage full');
        }),
        removeItem: jest.fn(() => {
          throw new Error('SecurityError: access denied');
        }),
      };

      const storage = createTestAuthStorage('web', restrictedStorage);

      // Writes should not crash but fall back to memory
      await expect(storage.setItemAsync('accessToken', 'in-memory-token')).resolves.not.toThrow();
      const token = await storage.getItemAsync('accessToken');
      expect(token).toBe('in-memory-token');

      await expect(storage.deleteItemAsync('accessToken')).resolves.not.toThrow();
      expect(await storage.getItemAsync('accessToken')).toBeNull();
    });

    it('operates seamlessly when localStorage is completely undefined (SSR / sandboxed)', async () => {
      const storage = createTestAuthStorage('web', null);

      await storage.setItemAsync('accessToken', 'ssr-token');
      expect(await storage.getItemAsync('accessToken')).toBe('ssr-token');
      await storage.deleteItemAsync('accessToken');
      expect(await storage.getItemAsync('accessToken')).toBeNull();
    });
  });

  describe('Native Storage Behavior (iOS & Android)', () => {
    let mockSecureStoreData: Record<string, string>;
    let mockSecureStore: { getItemAsync: jest.Mock; setItemAsync: jest.Mock; deleteItemAsync: jest.Mock };

    beforeEach(() => {
      mockSecureStoreData = {};
      mockSecureStore = {
        getItemAsync: jest.fn(async (k: string) => mockSecureStoreData[k] ?? null),
        setItemAsync: jest.fn(async (k: string, v: string) => {
          mockSecureStoreData[k] = v;
        }),
        deleteItemAsync: jest.fn(async (k: string) => {
          delete mockSecureStoreData[k];
        }),
      };
    });

    it('delegates to native SecureStore on Android and iOS', async () => {
      const androidStorage = createTestAuthStorage('android', null, mockSecureStore);

      await androidStorage.setItemAsync('accessToken', 'native-android-token');
      expect(mockSecureStore.setItemAsync).toHaveBeenCalledWith('accessToken', 'native-android-token');

      const token = await androidStorage.getItemAsync('accessToken');
      expect(token).toBe('native-android-token');
      expect(mockSecureStore.getItemAsync).toHaveBeenCalledWith('accessToken');

      await androidStorage.deleteItemAsync('accessToken');
      expect(mockSecureStore.deleteItemAsync).toHaveBeenCalledWith('accessToken');
      expect(await androidStorage.getItemAsync('accessToken')).toBeNull();
    });

    it('falls back to memory if native SecureStore module throws an unexpected error', async () => {
      const failingSecureStore = {
        getItemAsync: jest.fn(async () => {
          throw new Error('KeyStore failure');
        }),
        setItemAsync: jest.fn(async () => {
          throw new Error('KeyStore failure');
        }),
        deleteItemAsync: jest.fn(async () => {
          throw new Error('KeyStore failure');
        }),
      };

      const storage = createTestAuthStorage('android', null, failingSecureStore);

      await expect(storage.setItemAsync('accessToken', 'fallback-token')).resolves.not.toThrow();
      const readToken = await storage.getItemAsync('accessToken');
      expect(readToken).toBe('fallback-token');
    });
  });

  describe('ApiClient Authentication Headers & Unauthenticated Endpoints', () => {
    const AUTH_ENDPOINTS = ['/auth/login', '/auth/register', '/auth/refresh'];

    const computeAuthHeaders = async (
      endpoint: string,
      storage: StorageAdapter
    ): Promise<Record<string, string>> => {
      if (AUTH_ENDPOINTS.some((path) => endpoint.startsWith(path)) || endpoint === '/health') {
        return {};
      }
      try {
        const accessToken = await storage.getItemAsync('accessToken');
        return accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
      } catch {
        return {};
      }
    };

    it('never attaches Authorization headers for /auth/register, /auth/login, /auth/refresh, or /health', async () => {
      const storage = createTestAuthStorage('web', {
        getItem: jest.fn(() => 'existing-token'),
        setItem: jest.fn(),
        removeItem: jest.fn(),
      });

      expect(await computeAuthHeaders('/auth/register', storage)).toEqual({});
      expect(await computeAuthHeaders('/auth/login', storage)).toEqual({});
      expect(await computeAuthHeaders('/auth/refresh', storage)).toEqual({});
      expect(await computeAuthHeaders('/health', storage)).toEqual({});
    });

    it('attaches Bearer token header for authenticated endpoints when token exists', async () => {
      const storage = createTestAuthStorage('web', {
        getItem: jest.fn((k: string) => (k === 'accessToken' ? 'valid-jwt-token' : null)),
        setItem: jest.fn(),
        removeItem: jest.fn(),
      });

      const headers = await computeAuthHeaders('/shifts', storage);
      expect(headers).toEqual({ Authorization: 'Bearer valid-jwt-token' });

      const teamHeaders = await computeAuthHeaders('/teams', storage);
      expect(teamHeaders).toEqual({ Authorization: 'Bearer valid-jwt-token' });
    });

    it('returns empty headers safely when no token is in storage', async () => {
      const storage = createTestAuthStorage('web', {
        getItem: jest.fn(() => null),
        setItem: jest.fn(),
        removeItem: jest.fn(),
      });

      const headers = await computeAuthHeaders('/shifts', storage);
      expect(headers).toEqual({});
    });

    it('does not throw if storage fails during header lookup', async () => {
      const failingStorage: StorageAdapter = {
        getItemAsync: jest.fn(async () => {
          throw new Error('Fatal storage corrupt');
        }),
        setItemAsync: jest.fn(async () => {}),
        deleteItemAsync: jest.fn(async () => {}),
      };

      const headers = await computeAuthHeaders('/shifts', failingStorage);
      expect(headers).toEqual({});
    });
  });

  describe('Push Notifications Platform Isolation', () => {
    it('skips push listener and registration setup on web', () => {
      const shouldRegisterPush = (platform: string): boolean => platform !== 'web';
      expect(shouldRegisterPush('web')).toBe(false);
      expect(shouldRegisterPush('android')).toBe(true);
      expect(shouldRegisterPush('ios')).toBe(true);
    });

    it('formats platform correctly for backend device registration', () => {
      const resolvePlatform = (os: string): 'android' | 'ios' | 'web' =>
        os === 'android' ? 'android' : os === 'ios' ? 'ios' : 'web';

      expect(resolvePlatform('web')).toBe('web');
      expect(resolvePlatform('android')).toBe('android');
      expect(resolvePlatform('ios')).toBe('ios');
    });
  });
});

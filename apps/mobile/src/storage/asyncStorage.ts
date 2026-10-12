import * as FileSystem from 'expo-file-system/legacy';

export interface IAsyncStorage {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
  removeItem: (key: string) => Promise<void>;
  clear: () => Promise<void>;
  getAllKeys: () => Promise<string[]>;
}

// In-memory cache for fast synchronous access & test/node environments
const memoryCache = new Map<string, string>();

const CACHE_DIR = FileSystem.documentDirectory
  ? `${FileSystem.documentDirectory}rota_storage/`
  : null;

function sanitizeKey(key: string): string {
  return encodeURIComponent(key).replace(/[*]/g, '_') + '.json';
}

function desanitizeKey(filename: string): string {
  return decodeURIComponent(filename.replace(/\.json$/, ''));
}

async function ensureDir(): Promise<boolean> {
  if (!CACHE_DIR) return false;
  try {
    const info = await FileSystem.getInfoAsync(CACHE_DIR);
    if (!info.exists) {
      await FileSystem.makeDirectoryAsync(CACHE_DIR, { intermediates: true });
    }
    return true;
  } catch {
    return false;
  }
}

export const AsyncStorage: IAsyncStorage = {
  async getItem(key: string): Promise<string | null> {
    if (memoryCache.has(key)) {
      return memoryCache.get(key) ?? null;
    }

    if (CACHE_DIR) {
      try {
        const filePath = `${CACHE_DIR}${sanitizeKey(key)}`;
        const info = await FileSystem.getInfoAsync(filePath);
        if (info.exists) {
          const content = await FileSystem.readAsStringAsync(filePath);
          memoryCache.set(key, content);
          return content;
        }
      } catch (err) {
        console.warn(`[AsyncStorage] Failed to read key ${key}:`, err);
      }
    }

    return null;
  },

  async setItem(key: string, value: string): Promise<void> {
    memoryCache.set(key, value);

    if (CACHE_DIR) {
      try {
        const dirReady = await ensureDir();
        if (dirReady) {
          const filePath = `${CACHE_DIR}${sanitizeKey(key)}`;
          await FileSystem.writeAsStringAsync(filePath, value);
        }
      } catch (err) {
        console.warn(`[AsyncStorage] Failed to write key ${key}:`, err);
      }
    }
  },

  async removeItem(key: string): Promise<void> {
    memoryCache.delete(key);

    if (CACHE_DIR) {
      try {
        const filePath = `${CACHE_DIR}${sanitizeKey(key)}`;
        await FileSystem.deleteAsync(filePath, { idempotent: true });
      } catch (err) {
        console.warn(`[AsyncStorage] Failed to delete key ${key}:`, err);
      }
    }
  },

  async clear(): Promise<void> {
    memoryCache.clear();

    if (CACHE_DIR) {
      try {
        await FileSystem.deleteAsync(CACHE_DIR, { idempotent: true });
        await ensureDir();
      } catch (err) {
        console.warn('[AsyncStorage] Failed to clear storage:', err);
      }
    }
  },

  async getAllKeys(): Promise<string[]> {
    const keys = new Set<string>(memoryCache.keys());

    if (CACHE_DIR) {
      try {
        const dirReady = await ensureDir();
        if (dirReady) {
          const files = await FileSystem.readDirectoryAsync(CACHE_DIR);
          for (const file of files) {
            if (file.endsWith('.json')) {
              keys.add(desanitizeKey(file));
            }
          }
        }
      } catch (err) {
        console.warn('[AsyncStorage] Failed to list keys:', err);
      }
    }

    return Array.from(keys);
  },
};

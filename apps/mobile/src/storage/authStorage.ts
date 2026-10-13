import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

/**
 * Platform-Aware Authentication Storage Abstraction
 *
 * Requirements & Architecture:
 * - Native (iOS / Android): Uses `expo-secure-store`. On iOS, data is stored in the Keychain
 *   with hardware-backed encryption. On Android, data is stored in EncryptedSharedPreferences,
 *   backed by Android KeyStore.
 * - Web (Browsers): Uses `window.localStorage` when available, with a resilient in-memory Map
 *   fallback if `window.localStorage` throws (e.g. storage disabled, private browsing restrictions,
 *   quota exceeded, or iframe sandbox restrictions).
 *
 * Security Analysis: Web localStorage vs Native Secure Storage:
 * -------------------------------------------------------------
 * 1. Native Secure Storage (iOS Keychain / Android KeyStore):
 *    - Operating system and hardware-level isolation.
 *    - Keys and encrypted values are protected against extraction even if the device filesystem is accessed.
 *    - Sandboxed per application bundle ID / signing certificate.
 *
 * 2. Web Storage (localStorage):
 *    - Stored in plain text within browser storage files on the user's filesystem.
 *    - Accessible synchronously to any JavaScript code running in the same origin (protocol + host + port).
 *    - Susceptible to Cross-Site Scripting (XSS) attacks: if an attacker succeeds in injecting or executing
 *      arbitrary script via third-party dependencies, malicious ads, or DOM injection, tokens stored in
 *      `localStorage` can be extracted immediately.
 *
 * Production Web Authentication Assessment:
 * ------------------------------------------
 * While `localStorage` is acceptable for local browser development and prototyping, a production web deployment
 * should transition to a more secure authentication architecture:
 *
 * - Recommendation A (HttpOnly Cookies + In-Memory Access Token):
 *   1. The backend sets the `refreshToken` in an `HttpOnly`, `SameSite=Strict`, `Secure` cookie.
 *      Browser JavaScript cannot read or modify HttpOnly cookies, completely eliminating the XSS token theft vector.
 *   2. The short-lived `accessToken` is kept exclusively in JavaScript application memory (e.g., React Context state),
 *      never persisted to localStorage or sessionStorage.
 *   3. On page reload or app restart, the web app calls `/auth/refresh` (which automatically includes the HttpOnly
 *      cookie) to obtain a new in-memory `accessToken`.
 *
 * - Recommendation B (Backend-For-Frontend / BFF Pattern):
 *   A lightweight reverse proxy / BFF server handles all authentication handshakes and session cookies,
 *   proxying authenticated requests to the API so the browser client never handles raw JWT tokens directly.
 */

export interface IAuthStorage {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

// In-memory fallback store for memory-only mode, SSR, or storage errors
const memoryStore = new Map<string, string>();

/**
 * Safely retrieves window.localStorage if available in the current environment.
 */
function getLocalStorage(): Storage | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    // Browsers can throw DOMException / SecurityError when cookies/storage are disabled
  }
  return null;
}

export const authStorage: IAuthStorage = {
  async getItemAsync(key: string): Promise<string | null> {
    if (Platform.OS === 'web') {
      const storage = getLocalStorage();
      if (storage) {
        try {
          return storage.getItem(key);
        } catch (err) {
          console.warn(`[authStorage:web] Failed to read key "${key}" from localStorage:`, err);
        }
      }
      return memoryStore.get(key) ?? null;
    }

    // Native platforms (iOS / Android)
    try {
      return await SecureStore.getItemAsync(key);
    } catch (err) {
      console.warn(`[authStorage:native] Failed to read key "${key}" from SecureStore:`, err);
      return memoryStore.get(key) ?? null;
    }
  },

  async setItemAsync(key: string, value: string): Promise<void> {
    if (Platform.OS === 'web') {
      const storage = getLocalStorage();
      if (storage) {
        try {
          storage.setItem(key, value);
          memoryStore.set(key, value);
          return;
        } catch (err) {
          console.warn(`[authStorage:web] Failed to write key "${key}" to localStorage:`, err);
        }
      }
      memoryStore.set(key, value);
      return;
    }

    // Native platforms (iOS / Android)
    try {
      await SecureStore.setItemAsync(key, value);
      memoryStore.set(key, value);
    } catch (err) {
      console.warn(`[authStorage:native] Failed to write key "${key}" to SecureStore:`, err);
      memoryStore.set(key, value);
    }
  },

  async deleteItemAsync(key: string): Promise<void> {
    if (Platform.OS === 'web') {
      const storage = getLocalStorage();
      if (storage) {
        try {
          storage.removeItem(key);
        } catch (err) {
          console.warn(`[authStorage:web] Failed to delete key "${key}" from localStorage:`, err);
        }
      }
      memoryStore.delete(key);
      return;
    }

    // Native platforms (iOS / Android)
    try {
      await SecureStore.deleteItemAsync(key);
      memoryStore.delete(key);
    } catch (err) {
      console.warn(`[authStorage:native] Failed to delete key "${key}" from SecureStore:`, err);
      memoryStore.delete(key);
    }
  },
};

export const getItemAsync = authStorage.getItemAsync.bind(authStorage);
export const setItemAsync = authStorage.setItemAsync.bind(authStorage);
export const deleteItemAsync = authStorage.deleteItemAsync.bind(authStorage);

import { Platform } from 'react-native';
import * as Clipboard from 'expo-clipboard';

/**
 * Copies text to the system clipboard across Web, iOS, and Android.
 * Handles platform differences and permissions safely.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (Platform.OS === 'web') {
      if (
        typeof navigator !== 'undefined' &&
        navigator.clipboard &&
        typeof navigator.clipboard.writeText === 'function'
      ) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    }

    if (Clipboard && typeof Clipboard.setStringAsync === 'function') {
      await Clipboard.setStringAsync(text);
      return true;
    }
  } catch (err) {
    console.warn('[clipboard] Failed to copy text:', err);
  }
  return false;
}

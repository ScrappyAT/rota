import { ApiResponse } from '@rota/shared';
import * as SecureStore from 'expo-secure-store';

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:3000';

const AUTH_ENDPOINTS = ['/auth/login', '/auth/register', '/auth/refresh'];

class ApiClient {
  private refreshInFlight: Promise<boolean> | null = null;

  private async tryRefresh(): Promise<boolean> {
    if (this.refreshInFlight) return this.refreshInFlight;

    this.refreshInFlight = (async () => {
      try {
        const refreshToken = await SecureStore.getItemAsync('refreshToken');
        const userId = await SecureStore.getItemAsync('userId');
        if (!refreshToken || !userId) return false;

        const response = await fetch(`${API_URL}/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken, userId }),
        });
        const body = await response.json();

        if (response.ok && body?.success && body?.data) {
          await SecureStore.setItemAsync('accessToken', body.data.accessToken);
          await SecureStore.setItemAsync('refreshToken', body.data.refreshToken);
          return true;
        }

        await SecureStore.deleteItemAsync('accessToken');
        await SecureStore.deleteItemAsync('refreshToken');
        await SecureStore.deleteItemAsync('userId');
        return false;
      } catch {
        return false;
      } finally {
        this.refreshInFlight = null;
      }
    })();

    return this.refreshInFlight;
  }

  private async authHeaders(): Promise<Record<string, string>> {
    const accessToken = await SecureStore.getItemAsync('accessToken');
    return accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
  }

  async request<T>(endpoint: string, options: RequestInit = {}): Promise<ApiResponse<T>> {
    const url = `${API_URL}${endpoint}`;
    const canRefresh = !AUTH_ENDPOINTS.some((path) => endpoint.startsWith(path));

    try {
      let response = await fetch(url, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...(await this.authHeaders()),
          ...options.headers,
        },
      });

      if (response.status === 401 && canRefresh && (await this.tryRefresh())) {
        response = await fetch(url, {
          ...options,
          headers: {
            'Content-Type': 'application/json',
            ...(await this.authHeaders()),
            ...options.headers,
          },
        });
      }

      const data = await response.json();
      return data as ApiResponse<T>;
    } catch (error) {
      console.error(`API Error on ${endpoint}:`, error);
      return {
        success: false,
        error: {
          code: 'NETWORK_ERROR',
          message: 'Failed to connect to the server',
        },
      };
    }
  }

  async getHealth() {
    return this.request<{ status: string }>('/health');
  }
}

export const apiClient = new ApiClient();

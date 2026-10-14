import { ApiResponse } from '@rota/shared';
import { authStorage } from '../storage/authStorage';

export const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://192.168.0.101:3000';

const AUTH_ENDPOINTS = ['/auth/login', '/auth/register', '/auth/refresh'];

class ApiClient {
  private refreshInFlight: Promise<boolean> | null = null;

  private async tryRefresh(): Promise<boolean> {
    if (this.refreshInFlight) return this.refreshInFlight;

    this.refreshInFlight = (async () => {
      try {
        const refreshToken = await authStorage.getItemAsync('refreshToken');
        const userId = await authStorage.getItemAsync('userId');
        if (!refreshToken || !userId) return false;

        const response = await fetch(`${API_URL}/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken, userId }),
        });
        const body = await response.json();

        if (response.ok && body?.success && body?.data) {
          await authStorage.setItemAsync('accessToken', body.data.accessToken);
          await authStorage.setItemAsync('refreshToken', body.data.refreshToken);
          return true;
        }

        await authStorage.deleteItemAsync('accessToken');
        await authStorage.deleteItemAsync('refreshToken');
        await authStorage.deleteItemAsync('userId');
        return false;
      } catch {
        return false;
      } finally {
        this.refreshInFlight = null;
      }
    })();

    return this.refreshInFlight;
  }

  private async authHeaders(endpoint?: string): Promise<Record<string, string>> {
    // Unauthenticated requests should never fail or send auth headers
    if (endpoint && (AUTH_ENDPOINTS.some((path) => endpoint.startsWith(path)) || endpoint === '/health')) {
      return {};
    }
    try {
      const accessToken = await authStorage.getItemAsync('accessToken');
      return accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
    } catch {
      return {};
    }
  }

  private networkListeners: Set<(isOnline: boolean) => void> = new Set();

  onNetworkStatusChange(listener: (isOnline: boolean) => void): () => void {
    this.networkListeners.add(listener);
    return () => this.networkListeners.delete(listener);
  }

  private notifyNetwork(isOnline: boolean) {
    this.networkListeners.forEach((fn) => {
      try {
        fn(isOnline);
      } catch {
        // ignore listener errors
      }
    });
  }

  async request<T>(endpoint: string, options: RequestInit = {}): Promise<ApiResponse<T>> {
    const url = `${API_URL}${endpoint}`;
    const canRefresh = !AUTH_ENDPOINTS.some((path) => endpoint.startsWith(path));

    try {
      let response = await fetch(url, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...(await this.authHeaders(endpoint)),
          ...options.headers,
        },
      });

      if (response.status === 401 && canRefresh && (await this.tryRefresh())) {
        response = await fetch(url, {
          ...options,
          headers: {
            'Content-Type': 'application/json',
            ...(await this.authHeaders(endpoint)),
            ...options.headers,
          },
        });
      }

      this.notifyNetwork(true);

      // Handle 204 No Content and 205 Reset Content responses (no body)
      if (response.status === 204 || response.status === 205) {
        return { success: true } as ApiResponse<T>;
      }

      const text = await response.text();
      if (!text || text.trim() === '') {
        return {
          success: response.ok,
          ...(response.ok
            ? {}
            : {
                error: {
                  code: `HTTP_${response.status}`,
                  message: `Request failed with status ${response.status}`,
                },
              }),
        } as ApiResponse<T>;
      }

      try {
        const data = JSON.parse(text);
        return data as ApiResponse<T>;
      } catch {
        if (!response.ok) {
          return {
            success: false,
            error: {
              code: `HTTP_${response.status}`,
              message: `Request failed with status ${response.status}`,
            },
          };
        }
        return { success: true } as ApiResponse<T>;
      }
    } catch (error) {
      console.error(`API Error on ${endpoint}:`, error);
      this.notifyNetwork(false);
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

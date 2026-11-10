import { reportMobileError } from '../services/errorTracking';
import { ApiResponse } from '@rota/shared';
import { authStorage } from '../storage/authStorage';

export const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://192.168.0.101:3000';

const AUTH_ENDPOINTS = ['/auth/login', '/auth/register', '/auth/refresh','/auth/password-reset','/auth/magic-link'];

class ApiClient {
  private async fetchTimed(url: string, options: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (options.signal?.aborted) controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 8000);
    try { return await fetch(url, { ...options, signal: controller.signal }); }
    finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); }
  }

  private readOnlySession = false;
  refreshOutcome: 'success' | 'offline' | 'unavailable' | 'invalid' = 'unavailable';
  setReadOnlySession(value: boolean) { this.readOnlySession = value; }
  private teamAccessListeners = new Set<(teamId: string) => void>();
  onTeamAccessLost(listener: (teamId: string) => void) { this.teamAccessListeners.add(listener); return () => { this.teamAccessListeners.delete(listener); }; }

  private authInvalidListeners=new Set<(userId:string)=>void>();
  onAuthInvalid(listener:(userId:string)=>void):()=>void{this.authInvalidListeners.add(listener);return()=>{this.authInvalidListeners.delete(listener);};}
  private refreshInFlight: Promise<boolean> | null = null;

  async refreshSession():Promise<boolean>{return this.tryRefresh();}

  private async tryRefresh(): Promise<boolean> {
    if (this.refreshInFlight) return this.refreshInFlight;

    this.refreshInFlight = (async () => {
      try {
        const refreshToken = await authStorage.getItemAsync('refreshToken');
        const userId = await authStorage.getItemAsync('userId');
        if (!refreshToken || !userId) { this.refreshOutcome = 'invalid'; return false; }

        const response = await this.fetchTimed(`${API_URL}/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken, userId }),
        });
        const body = await response.json();

        if (await authStorage.getItemAsync('userId') !== userId || await authStorage.getItemAsync('refreshToken') !== refreshToken) return false;
        if (response.ok && body?.success && body?.data) {
          this.refreshOutcome = 'success';
          await authStorage.setItemAsync('accessToken', body.data.accessToken);
          await authStorage.setItemAsync('refreshToken', body.data.refreshToken);
          return true;
        }

        if(response.status!==401&&response.status!==400){this.refreshOutcome='unavailable';return false;}
        this.refreshOutcome='invalid';
        for(const listener of this.authInvalidListeners)listener(userId);
        await authStorage.deleteItemAsync('accessToken');
        await authStorage.deleteItemAsync('refreshToken');
        await authStorage.deleteItemAsync('userId');
        return false;
      } catch {
        this.refreshOutcome='offline'; this.notifyNetwork(false);
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
    if (this.readOnlySession && !endpoint.startsWith('/auth/') && endpoint !== '/health') {
      return { success: false, error: { code: 'OFFLINE_READ_ONLY', message: 'Reconnect and verify your session before accessing the server.' } };
    }
    const url = `${API_URL}${endpoint}`;
    const canRefresh = !AUTH_ENDPOINTS.some((path) => endpoint.startsWith(path));

    try {
      let response = await this.fetchTimed(url, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...(await this.authHeaders(endpoint)),
          ...options.headers,
        },
      });

      if (response.status === 401 && canRefresh && (await this.tryRefresh())) {
        response = await this.fetchTimed(url, {
          ...options,
          headers: {
            'Content-Type': 'application/json',
            ...(await this.authHeaders(endpoint)),
            ...options.headers,
          },
        });
      }

      this.notifyNetwork(true);
      if (response.status >= 500) reportMobileError(undefined, { route: endpoint, status: response.status, requestId: response.headers?.get?.('X-Request-ID') });

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
        const team = /^\/teams\/([0-9a-f-]{36})(?:\/|$)/i.exec(endpoint);
        if (team && response.status === 404 && data?.error?.message === 'Team not found') {
          for (const listener of this.teamAccessListeners) listener(team[1]);
        }
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
    } catch {
      if (options.signal?.aborted) return { success: false, error: { code: 'REQUEST_CANCELLED', message: 'Request cancelled' } };
      // Expected offline failures remain local; never print URL, headers or exceptions.
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

/** Client intent keys survive lost responses. Storage and secure randomness are injected. */
export interface AttemptStorage {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}
export class PaymentAttempts {
  private inFlight = new Map<string, Promise<unknown>>();
  private storageKey(scope: string): string {
    // SecureStore accepts only letters, digits, dots, dashes and underscores.
    // Encoding every UTF-16 unit avoids collisions between scope separators.
    return 'billing-attempt.' + scope.split('').map(c => c.charCodeAt(0).toString(16).padStart(4, '0')).join('');
  }
  constructor(private storage: AttemptStorage, private newKey: () => string) { }
  execute<T>(scope: string, input: unknown, send: (key: string) => Promise<T>): Promise<T> {
    const fingerprint = JSON.stringify(input);
    const flightKey = scope + ':' + fingerprint;
    const old = this.inFlight.get(flightKey);
    if (old)
      return old as Promise<T>;
    const run = (async () => {
      const storageKey = this.storageKey(scope);
      const raw = await this.storage.getItemAsync(storageKey);
      const previous = raw ? JSON.parse(raw) as {
        fingerprint: string;
        key: string;
        reference?: string;
      } : null;
      const attempt = previous?.fingerprint === fingerprint ? previous : { fingerprint, key: this.newKey() };
      // Retain the associated payment reference on retries too.
      await this.storage.setItemAsync(storageKey, JSON.stringify(attempt));
      return send(attempt.key);
    })();
    this.inFlight.set(flightKey, run);
    void run.finally(() => this.inFlight.delete(flightKey)).catch(() => { });
    return run;
  }
  async associate(scope: string, key: string, reference: string): Promise<void> {
    const storageKey = this.storageKey(scope);
    const raw = await this.storage.getItemAsync(storageKey);
    if (!raw)
      return;
    const attempt = JSON.parse(raw) as {
      key: string;
    };
    if (attempt.key === key)
      await this.storage.setItemAsync(storageKey, JSON.stringify({ ...attempt, reference }));
  }
  async finish(scope: string, reference?: string): Promise<void> {
    const storageKey = this.storageKey(scope);
    if (reference) {
      const raw = await this.storage.getItemAsync(storageKey);
      if (!raw || (JSON.parse(raw) as {
        reference?: string;
      }).reference !== reference)
        return;
    }
    await this.storage.deleteItemAsync(storageKey);
  }
}

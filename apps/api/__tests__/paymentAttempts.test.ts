import { PaymentAttempts } from '@rota/shared';
describe('actual client payment attempt registry', () => {
  const values = new Map<string, string>();
  const storage = { getItemAsync: async (k: string) => values.get(k) ?? null, setItemAsync: async (k: string, v: string) => { values.set(k, v); }, deleteItemAsync: async (k: string) => { values.delete(k); } };
  beforeEach(() => values.clear());
  it('double submission shares one request and one client key', async () => {
    const create = jest.fn(() => 'key-1'), send = jest.fn(async (key: string) => key);
    const attempts = new PaymentAttempts(storage, create);
    expect(await Promise.all([attempts.execute('user:team:checkout', { seats: 5 }, send), attempts.execute('user:team:checkout', { seats: 5 }, send)])).toEqual(['key-1', 'key-1']);
    expect(send).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
  });
  it('lost response and restart reuse the persisted key', async () => {
    const attempts = new PaymentAttempts(storage, () => 'key-1');
    await expect(attempts.execute('u:t:checkout', {}, async () => { throw new Error('lost response'); })).rejects.toThrow();
    expect(await new PaymentAttempts(storage, () => 'key-2').execute('u:t:checkout', {}, async (key) => key)).toBe('key-1');
  });
  it('a terminal outcome allows an explicitly new attempt', async () => {
    let n = 0;
    const attempts = new PaymentAttempts(storage, () => String(++n));
    await attempts.execute('u:t:checkout', {}, async (key) => key);
    await attempts.finish('u:t:checkout');
    expect(await attempts.execute('u:t:checkout', {}, async (key) => key)).toBe('2');
  });
  it('different users,teams and changed intent do not reuse a key', async () => {
    let n = 0;
    const attempts = new PaymentAttempts(storage, () => String(++n));
    const results = [];
    for (const [scope, input] of [['u:t:checkout', { seats: 5 }], ['v:t:checkout', { seats: 5 }], ['u:x:checkout', { seats: 5 }], ['u:t:checkout', { seats: 6 }]] as const)
      results.push(await attempts.execute(scope, input, async (key) => key));
    expect(new Set(results).size).toBe(4);
  });
  it('settling one reference does not erase another pending payment intent', async () => {
    let n = 0;
    const attempts = new PaymentAttempts(storage, () => String(++n));
    const key = await attempts.execute('u:t:renew', {}, async (key) => key);
    await attempts.associate('u:t:renew', key, 'renewal-ref');
    await attempts.finish('u:t:renew', 'checkout-ref');
    expect(await attempts.execute('u:t:renew', {}, async (key) => key)).toBe(key);
    await attempts.finish('u:t:renew', 'renewal-ref');
    expect(await attempts.execute('u:t:renew', {}, async (key) => key)).not.toBe(key);
  });
  it('uses persistent-storage-safe keys without scope collisions', async () => {
    const strict = {
      ...storage,
      setItemAsync: async (key: string, value: string) => {
        expect(key).toMatch(/^[A-Za-z0-9._-]+$/);
        await storage.setItemAsync(key, value);
      }
    };
    let n = 0;
    const attempts = new PaymentAttempts(strict, () => String(++n));
    await attempts.execute('user:team:checkout', {}, async (key) => key);
    await attempts.execute('user.team.checkout', {}, async (key) => key);
    expect(values.size).toBe(2);
  });
});

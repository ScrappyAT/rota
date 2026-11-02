import { initializeCheckout, verifyTransaction,verifyTransactionByReference } from '../src/billing/flutterwave';

jest.mock('../src/env', () => ({ env: {
  FLW_SECRET_KEY: 'r1-mocked-provider-only', FLW_ENV: 'sandbox', FLW_BASE_URL: 'http://127.0.0.1:9',
  BILLING_CURRENCY: 'USD', BILLING_PERIOD_DAYS: 30, SUBSCRIPTION_GRACE_DAYS: 14,
} }));
describe('actual Flutterwave HTTP adapter (provider fully mocked)', () => {
  const fetchMock = jest.spyOn(globalThis, 'fetch');
  afterAll(() => fetchMock.mockRestore());
  it('sends cents as an exact major-unit decimal string', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ data: { link: 'https://checkout.test' } }) } as Response);
    await initializeCheckout({ txRef: 'test', amountMinor: 10067, currency: 'USD', redirectUrl: 'rota://billing/redirect', customer: { email: 'mock@test.example' } });
    const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
    expect(body.amount).toBe('100.67');
    expect(body.currency).toBe('USD');
  });
  it('preserves the verified decimal string instead of rounding it', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ data: { id: 'mock', tx_ref: 'test', amount: '3.34', currency: 'USD', status: 'successful' } }) } as Response);
    expect(await verifyTransaction('mock')).toMatchObject({ amountMajor: '3.34', currency: 'USD' });
  });
  it('recovers an existing reference through GET without initializing another checkout',async()=>{
    fetchMock.mockResolvedValueOnce({ok:true,json:async()=>({data:{id:'reference-id',tx_ref:'existing-ref',amount:'100.67',currency:'USD',status:'successful'}})} as Response);
    expect(await verifyTransactionByReference('existing-ref')).toMatchObject({amountMajor:'100.67',txRef:'existing-ref'});
    const call=fetchMock.mock.calls.at(-1)!;expect(String(call[0])).toContain('/v3/transactions/verify_by_reference?tx_ref=existing-ref');expect(call[1]?.method).toBe('GET');
  });
});

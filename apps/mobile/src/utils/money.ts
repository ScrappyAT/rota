export function formatMoney(amountMinor: number, currency: string = 'NGN'): string {
  const whole = Math.floor(amountMinor / 100);
  const frac = amountMinor % 100;
  const thousands = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${thousands}.${String(frac).padStart(2, '0')} ${currency}`;
}
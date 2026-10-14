export function formatMoney(amountMinor: number | null | undefined, currency: string = 'NGN'): string {
  const safeAmount =
    typeof amountMinor === 'number' && Number.isFinite(amountMinor)
      ? Math.max(0, Math.floor(amountMinor))
      : 0;
  const whole = Math.floor(safeAmount / 100);
  const frac = safeAmount % 100;
  const thousands = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${thousands}.${String(frac).padStart(2, '0')} ${currency}`;
}
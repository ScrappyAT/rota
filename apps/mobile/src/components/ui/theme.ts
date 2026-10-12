export const colors = {
  primary: '#0052CC',
  primaryDark: '#003E99',
  secondary: '#E3F2FD',
  success: '#36B37E',
  danger: '#FF5630',
  warning: '#FFAB00',
  text: '#172B4D',
  textSecondary: '#6B778C',
  background: '#F4F5F7',
  card: '#FFFFFF',
  border: '#DFE1E6',
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
};

export const borderRadius = {
  sm: 4,
  md: 8,
  lg: 12,
  xl: 16,
  round: 9999,
};

export const typography = {
  h1: { fontSize: 32, fontWeight: '700' as const, color: colors.text },
  h2: { fontSize: 24, fontWeight: '700' as const, color: colors.text },
  h3: { fontSize: 20, fontWeight: '600' as const, color: colors.text },
  body: { fontSize: 16, color: colors.text },
  bodySmall: { fontSize: 14, color: colors.textSecondary },
  label: { fontSize: 12, fontWeight: '600' as const, color: colors.textSecondary },
};

export const colors = {
  bg: '#0e1117',
  card: '#161b24',
  cardRaised: '#1d2430',
  border: '#2b3240',
  text: '#ffffff',
  sub: '#c9d1e0',
  muted: '#8a93a6',
  accent: '#4fd98b', // primary action / success
  accentText: '#0e1117',
  blue: '#3fb6ff',
  gold: '#ffd84d',
  orange: '#ffc44d',
  red: '#ff5a4d',
  heart: '#ff4d6d',
  locked: '#1c222c',
};

export const radius = { sm: 8, md: 12, lg: 16, xl: 24 };
export const space = (n: number) => n * 4;

export const type = {
  title: { color: colors.text, fontSize: 26, fontWeight: '800' as const },
  h2: { color: colors.text, fontSize: 19, fontWeight: '700' as const },
  body: { color: colors.sub, fontSize: 15, lineHeight: 21 },
  small: { color: colors.muted, fontSize: 12 },
  label: { color: colors.muted, fontSize: 12, fontWeight: '700' as const, letterSpacing: 0.6, textTransform: 'uppercase' as const },
};

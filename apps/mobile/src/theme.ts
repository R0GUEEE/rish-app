import { Platform } from 'react-native';

export type ThemePalette = {
  background: string;
  surface: string;
  surfaceRaised: string;
  surfaceWarm: string;
  line: string;
  lineSoft: string;
  text: string;
  textDim: string;
  muted: string;
  faint: string;
  accent: string;
  accentSoft: string;
  success: string;
  danger: string;
  warning: string;
  scrim: string;
};

export const darkColors: ThemePalette = {
  background: '#08090B',
  surface: '#131519',
  surfaceRaised: '#1B1E23',
  surfaceWarm: '#201713',
  line: '#292D34',
  lineSoft: '#202329',
  text: '#F4F1E9',
  textDim: '#C8C4BC',
  muted: '#8E949E',
  faint: '#5E646E',
  accent: '#FF6B3D',
  accentSoft: '#5B2A1D',
  success: '#57D39B',
  danger: '#FF6368',
  warning: '#F3B85B',
  scrim: 'rgba(0,0,0,0.72)',
};

export const lightColors: ThemePalette = {
  background: '#F6F3EC',
  surface: '#ECE8DF',
  surfaceRaised: '#E3DED3',
  surfaceWarm: '#F6E3D8',
  line: '#D1CCC1',
  lineSoft: '#DFDAD0',
  text: '#17181A',
  textDim: '#3B3D41',
  muted: '#6D727A',
  faint: '#625E57',
  accent: '#B83D1D',
  accentSoft: '#ECB19D',
  success: '#16845D',
  danger: '#C53B43',
  warning: '#A96915',
  scrim: 'rgba(18,17,14,0.42)',
};

/** Legacy dark fallback for code that has not moved to `useAppPresentation`. */
export const colors = darkColors;

export const fonts = {
  display: Platform.select({ ios: 'New York', android: 'serif' }),
  body: Platform.select({ ios: 'SF Pro Text', android: 'sans-serif' }),
  mono: Platform.select({ ios: 'SF Mono', android: 'monospace' }),
};

export const hitSlop = 10;

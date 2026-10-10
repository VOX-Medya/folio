/** Paperbound is the V1 default. Other prototype themes are not enabled. */
export const paperbound = {
  mobile: {
    light: {
      bg: '#F5F0E7', surface: '#FFFDF8', surface2: '#EEEAE1', ink: '#26332B',
      muted: '#788276', line: '#DDD8CD', accent: '#4F6955', accentOn: '#FFFFFF',
      tint: '#E5ECDF', success: '#3E684A', warning: '#956221', error: '#A43D38',
      focus: '#4F6955', accessibleMuted: '#526153',
    },
    dark: {
      bg: '#171D1B', surface: '#212925', surface2: '#2B352E', ink: '#F0F3EB',
      muted: '#A5B3A6', line: '#364239', accent: '#B9D29F', accentOn: '#171D1B',
      tint: '#2B3C2C', success: '#AFD9B9', warning: '#F0CB8E', error: '#F2AEAA',
      focus: '#B9D29F', accessibleMuted: '#A5B3A6',
    },
  },
  admin: {
    light: {
      bg: '#F6F4ED', surface: '#FFFEFA', surface2: '#EEEAE1', ink: '#26372C',
      muted: '#758076', line: '#DFDFD5', accent: '#476E54', accentOn: '#FFFFFF',
      tint: '#E4EBE0', success: '#3D724F', warning: '#966225', error: '#AB574F',
      focus: '#476E54', accessibleMuted: '#526052',
    },
    dark: {
      bg: '#151D19', surface: '#202B24', surface2: '#2B382F', ink: '#F1F4EA',
      muted: '#ADBAAD', line: '#3B4B40', accent: '#B7D4AB', accentOn: '#151D19',
      tint: '#2C4435', success: '#B9DEC2', warning: '#F1CC87', error: '#F0ADA6',
      focus: '#B7D4AB', accessibleMuted: '#ADBAAD',
    },
  },
} as const;

export const typography = {
  ui: "'DM Sans', system-ui, sans-serif",
  heading: "'Fraunces', Georgia, serif",
  reader: 'Georgia, serif',
  sizes: { xs: 12, sm: 14, base: 16, lg: 18, xl: 22, xxl: 28, display: 36 },
  readerMaxCharacters: 80,
} as const;
export const spacing = { xxs: 4, xs: 8, sm: 12, base: 16, md: 20, lg: 24, xl: 32, xxl: 40, xxxl: 48 } as const;
export const radii = { mobile: 21, admin: 17, pill: 999 } as const;
export const interaction = { minTouchTarget: 44, focusRingWidth: 2 } as const;
export const density = { compact: 0.8, normal: 1, comfortable: 1.25 } as const;
export const breakpoints = { tablet: 600, desktop: 1024 } as const;
export type ResponsiveMode = 'phone' | 'tablet' | 'desktop';
export function responsiveMode(width: number): ResponsiveMode {
  if (!Number.isFinite(width) || width < 0) throw new RangeError('Viewport width must be non-negative');
  if (width < breakpoints.tablet) return 'phone';
  if (width < breakpoints.desktop) return 'tablet';
  return 'desktop';
}

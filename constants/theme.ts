/**
 * Design tokens for "Atlas of Life" — sourced verbatim from the Stitch
 * project (projects/15133168248295068323) design system. Do not tweak
 * values here by eye; the Stitch design MD is the source of truth.
 */

// ---------- COLORS (Stitch namedColors) ----------
export const Atlas = {
  color: {
    surface: '#fdf8f8',
    surfaceDim: '#ddd9d8',
    surfaceBright: '#fdf8f8',
    surfaceContainerLowest: '#ffffff',
    surfaceContainerLow: '#f7f3f2',
    surfaceContainer: '#f1edec',
    surfaceContainerHigh: '#ebe7e6',
    surfaceContainerHighest: '#e5e2e1',
    onSurface: '#1c1b1b',
    onSurfaceVariant: '#444748',
    inverseSurface: '#313030',
    inverseOnSurface: '#f4f0ef',
    outline: '#747878',
    outlineVariant: '#c4c7c7',
    primary: '#000000',
    onPrimary: '#ffffff',
    primaryContainer: '#1c1b1b',
    onPrimaryContainer: '#858383',
    secondary: '#625e55',
    onSecondary: '#ffffff',
    secondaryContainer: '#e8e2d6',
    onSecondaryContainer: '#68645b',
    tertiary: '#000000',
    onTertiary: '#ffffff',
    tertiaryContainer: '#001f29',
    onTertiaryContainer: '#668999',
    error: '#ba1a1a',
    onError: '#ffffff',
    errorContainer: '#ffdad6',
    onErrorContainer: '#93000a',
    background: '#fdf8f8',
    onBackground: '#1c1b1b',
    surfaceVariant: '#e5e2e1',
    // Accents from the design MD ("Muted Polaroid")
    accentTeal: '#4a6d7c',
    // Common alpha borders used throughout the Stitch screens
    borderFaint: 'rgba(0,0,0,0.05)', // border-primary/5
    borderThin: 'rgba(0,0,0,0.10)', // border-primary/10
    borderDashed: 'rgba(0,0,0,0.20)', // border-primary/20
  },

  // ---------- SPACING (Stitch spacing tokens) ----------
  space: {
    unit: 4,
    stackSm: 8,
    marginMobile: 20,
    gutter: 24,
    stackMd: 24,
    stackLg: 48,
    marginDesktop: 64,
  },

  // ---------- SHAPE (Stitch rounded scale) ----------
  radius: {
    sm: 2,
    default: 4,
    md: 6,
    lg: 8,
    xl: 12,
    full: 9999,
  },

  // ---------- TYPOGRAPHY (Stitch type scale) ----------
  // fontFamily strings match the keys registered with useFonts in app/_layout.tsx
  type: {
    displayLg: {
      fontFamily: 'HankenGrotesk_700Bold',
      fontSize: 48,
      lineHeight: 48 * 1.1,
      letterSpacing: 48 * -0.02,
    },
    headlineLg: {
      fontFamily: 'HankenGrotesk_600SemiBold',
      fontSize: 32,
      lineHeight: 32 * 1.2,
    },
    headlineLgMobile: {
      fontFamily: 'HankenGrotesk_600SemiBold',
      fontSize: 24,
      lineHeight: 24 * 1.2,
    },
    bodyMd: {
      fontFamily: 'HankenGrotesk_400Regular',
      fontSize: 16,
      lineHeight: 16 * 1.6,
    },
    labelMd: {
      fontFamily: 'CourierPrime_400Regular',
      fontSize: 14,
      lineHeight: 14 * 1.4,
      letterSpacing: 14 * 0.05,
    },
    journalEntry: {
      fontFamily: 'CourierPrime_400Regular',
      fontSize: 18,
      lineHeight: 18 * 1.7,
    },
  },

  font: {
    sans: 'HankenGrotesk_400Regular',
    sansSemiBold: 'HankenGrotesk_600SemiBold',
    sansSemiBoldItalic: 'HankenGrotesk_600SemiBold_Italic',
    sansBold: 'HankenGrotesk_700Bold',
    sansBoldItalic: 'HankenGrotesk_700Bold_Italic',
    sansExtraBold: 'HankenGrotesk_800ExtraBold',
    mono: 'CourierPrime_400Regular',
    monoItalic: 'CourierPrime_400Regular_Italic',
    monoBold: 'CourierPrime_700Bold',
  },
} as const;

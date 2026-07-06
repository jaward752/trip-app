import { Caveat_600SemiBold } from '@expo-google-fonts/caveat';
import {
  CourierPrime_400Regular,
  CourierPrime_400Regular_Italic,
  CourierPrime_700Bold,
} from '@expo-google-fonts/courier-prime';
import {
  HankenGrotesk_400Regular,
  HankenGrotesk_600SemiBold,
  HankenGrotesk_600SemiBold_Italic,
  HankenGrotesk_700Bold,
  HankenGrotesk_700Bold_Italic,
  HankenGrotesk_800ExtraBold,
} from '@expo-google-fonts/hanken-grotesk';
import { DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useState } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import 'react-native-reanimated';

import IntroAnimation from '@/components/intro-animation';
import { Atlas } from '@/constants/theme';

export const unstable_settings = {
  anchor: '(tabs)',
};

SplashScreen.preventAutoHideAsync();

// True once the Route 66 intro has played in this JS runtime. Module scope
// means it survives re-renders and remounts but resets on a cold launch —
// exactly the "play once per app start, not per foreground" behavior we want.
let introPlayedThisLaunch = false;

// The Atlas of Life design system is light-only ("Aged Paper" palette).
const AtlasNavTheme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    primary: Atlas.color.primary,
    background: Atlas.color.background,
    card: Atlas.color.background,
    text: Atlas.color.onBackground,
    border: Atlas.color.borderThin,
  },
};

export default function RootLayout() {
  const [loaded, error] = useFonts({
    HankenGrotesk_400Regular,
    HankenGrotesk_600SemiBold,
    HankenGrotesk_600SemiBold_Italic,
    HankenGrotesk_700Bold,
    HankenGrotesk_700Bold_Italic,
    HankenGrotesk_800ExtraBold,
    CourierPrime_400Regular,
    CourierPrime_400Regular_Italic,
    CourierPrime_700Bold,
    Caveat_600SemiBold,
  });

  const [showIntro, setShowIntro] = useState(() => !introPlayedThisLaunch);
  const handleIntroDone = useCallback(() => setShowIntro(false), []);

  useEffect(() => {
    if (showIntro) {
      introPlayedThisLaunch = true;
    }
  }, [showIntro]);

  useEffect(() => {
    if (loaded || error) {
      SplashScreen.hideAsync();
    }
  }, [loaded, error]);

  if (!loaded && !error) {
    return null;
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeProvider value={AtlasNavTheme}>
        <Stack>
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        </Stack>
        <StatusBar style="dark" />
        {showIntro && !error && <IntroAnimation onDone={handleIntroDone} />}
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}

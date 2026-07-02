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
import { useEffect } from 'react';
import 'react-native-reanimated';

import { Atlas } from '@/constants/theme';

export const unstable_settings = {
  anchor: '(tabs)',
};

SplashScreen.preventAutoHideAsync();

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
  });

  useEffect(() => {
    if (loaded || error) {
      SplashScreen.hideAsync();
    }
  }, [loaded, error]);

  if (!loaded && !error) {
    return null;
  }

  return (
    <ThemeProvider value={AtlasNavTheme}>
      <Stack>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="modal" options={{ presentation: 'modal', title: 'Modal' }} />
      </Stack>
      <StatusBar style="dark" />
    </ThemeProvider>
  );
}

# Waypost

A travel-journal app built with [Expo](https://expo.dev) (SDK 54, expo-router). Import photos into trips, see them clustered into stops on a world map, and curate them into flip-through storyboards.

## Development

```bash
npm install
npx expo start
```

The app uses native modules (`react-native-maps`, `expo-media-library`), so run it in a [development build](https://docs.expo.dev/develop/development-builds/introduction/) rather than Expo Go:

```bash
npx expo run:ios     # or run:android
```

## Layout

- `app/(tabs)/index.tsx` — the whole UI: albums, trip creation, world map, stop grids, storyboard builder and player (a single screen driven by an internal state machine; the router tab bar is hidden).
- `components/` — intro animation, grain overlay, postmark stamp, pressable-scale wrapper.
- `constants/theme.ts` — "Atlas of Life" design tokens (source of truth is the Stitch design MD).

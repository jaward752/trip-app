import { Image } from "expo-image";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, useWindowDimensions } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";

import { Atlas } from "@/constants/theme";

// Vintage Route 66 postcard intro. Layered parallax scene: sepia sky,
// mountain ridges, mesa midground, roadside props (cactus / ROUTE 66 shield),
// a code-drawn road with scrolling dashes, and a teal camper van that bobs
// along and then drives off ahead as the scene dissolves into the app.
//
// Palette is the intro-only "sun-faded postcard" extension of the Atlas aged
// paper theme: cream #FBF0D9, amber #E8A857, sienna #CE9A66/#B57947, warm
// road-brown #4A3B32 — the van wears the app's teal accent (#4A6D7C).

const SKY = require("@/assets/intro/sky.png");
const MOUNTAINS = require("@/assets/intro/mountains.png");
const MIDGROUND = require("@/assets/intro/midground.png");
const FOREGROUND = require("@/assets/intro/foreground.png");
const VAN = require("@/assets/intro/van.png");

// Source-image aspect ratios (w/h), used to size layers from their height.
const AR = { mountains: 2400 / 500, midground: 2400 / 420, foreground: 2400 / 520, van: 720 / 480 };

const ASSET_COUNT = 5; // images that must decode before the drive starts
const PRELOAD_TIMEOUT_MS = 900; // start anyway if decode events never arrive
const FADE_IN_MS = 250; // reveal from the splash-colored backdrop
const DRIVE_MS = 2400; // parallax cruise
const VAN_EXIT_MS = 520; // van accelerates off-screen
const FADE_MS = 450; // postcard dissolves into the app
const HARD_TIMEOUT_MS = 6000; // absolute worst-case unmount

const ROAD = {
  asphalt: "#4A3B32",
  edge: "#3A2E26",
  dash: "#F3DFB6",
  shoulder: "#DDB27C",
};

export default function IntroAnimation({ onDone }: { onDone: () => void }) {
  const { width: W, height: H } = useWindowDimensions();
  const reducedMotion = useReducedMotion();
  const doneRef = useRef(false);
  const startedRef = useRef(false);
  const loadedCountRef = useRef(0);
  const [assetFailed, setAssetFailed] = useState(false);
  // All intro images decoded — the drive must not start before this, or
  // layers pop in mid-scene while expo-image decodes them lazily.
  const [ready, setReady] = useState(false);

  // Vertical composition (fractions of screen height).
  const roadTop = H * 0.66;
  const roadH = H * 0.15;
  const mountainsH = H * 0.2;
  const midH = H * 0.16;
  const fgH = H * 0.24;
  const vanW = W * 0.52;
  const vanH = vanW / AR.van;
  // Wheels sit at ~90% of the van image height; park them on the road's
  // upper third so the van reads as "on the far lane".
  const vanTop = roadTop + roadH * 0.42 - vanH * 0.9;
  const vanLeft = W * 0.1;

  // How far the nearest plane travels during the drive; other layers scroll
  // a fraction of it. Each layer is clamped so it can never scroll past its
  // own right edge on tall/narrow screens.
  const baseScroll = W * 2.0;
  const layerScroll = (h: number, ar: number, factor: number) =>
    Math.min(baseScroll * factor, Math.max(0, h * ar - W - 8));

  const scroll = {
    mountains: layerScroll(mountainsH, AR.mountains, 0.12),
    mid: layerScroll(midH, AR.midground, 0.32),
    fg: layerScroll(fgH, AR.foreground, 0.72),
    road: baseScroll,
  };

  const progress = useSharedValue(0); // 0→1 over the drive
  const sceneOpacity = useSharedValue(1); // whole postcard, incl. cream backdrop
  const contentOpacity = useSharedValue(0); // scene artwork, revealed once decoded
  const sceneScale = useSharedValue(1);
  const vanBob = useSharedValue(0);
  const vanExitX = useSharedValue(0);
  const titleOpacity = useSharedValue(0);
  const titleRise = useSharedValue(8);
  const taglineOpacity = useSharedValue(0);
  const taglineRise = useSharedValue(10);

  const finish = useCallback(() => {
    if (doneRef.current) return;
    doneRef.current = true;
    onDone();
  }, [onDone]);

  // Skip on tap: collapse the scene fast and hand over to the app.
  const skip = useCallback(() => {
    if (doneRef.current) return;
    sceneOpacity.value = withTiming(0, { duration: 220, easing: Easing.out(Easing.quad) });
    setTimeout(finish, 230);
  }, [finish, sceneOpacity]);

  // If decode callbacks never arrive (or an asset errors before mount
  // settles), start anyway after a short grace period.
  useEffect(() => {
    const t = setTimeout(() => setReady(true), PRELOAD_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (!ready && !assetFailed) return;
    if (startedRef.current) return;
    startedRef.current = true;

    const timers: ReturnType<typeof setTimeout>[] = [];

    // Fallback: if an asset failed to decode, or motion is reduced, play a
    // simple fade instead of the full drive.
    if (reducedMotion || assetFailed) {
      contentOpacity.value = withTiming(1, { duration: FADE_IN_MS, easing: Easing.out(Easing.quad) });
      const hold = assetFailed ? 250 : 1100;
      timers.push(
        setTimeout(() => {
          sceneOpacity.value = withTiming(0, { duration: 300 });
          timers.push(setTimeout(finish, 320));
        }, hold),
      );
    } else {
      // The whole timeline is chained on the UI thread — JS-side timers would
      // fire late while the app mounts underneath, making the exit stutter.
      contentOpacity.value = withTiming(1, { duration: FADE_IN_MS, easing: Easing.out(Easing.quad) });

      progress.value = withDelay(
        FADE_IN_MS,
        withTiming(
          1,
          { duration: DRIVE_MS, easing: Easing.inOut(Easing.quad) },
          (finished) => {
            "worklet";
            if (!finished) return;
            // Van pulls ahead and exits right...
            vanExitX.value = withTiming(W, { duration: VAN_EXIT_MS, easing: Easing.in(Easing.cubic) });
            // ...while the postcard zooms slightly and dissolves into the app.
            sceneScale.value = withDelay(
              180,
              withTiming(1.07, { duration: FADE_MS + 100, easing: Easing.in(Easing.quad) }),
            );
            sceneOpacity.value = withDelay(
              180,
              withTiming(0, { duration: FADE_MS, easing: Easing.inOut(Easing.quad) }, (faded) => {
                "worklet";
                if (faded) runOnJS(finish)();
              }),
            );
          },
        ),
      );
      // Gentle two-beat bob, like tires over old highway seams.
      vanBob.value = withDelay(
        FADE_IN_MS,
        withRepeat(
          withSequence(
            withTiming(-3.5, { duration: 330, easing: Easing.inOut(Easing.sin) }),
            withTiming(2.5, { duration: 300, easing: Easing.inOut(Easing.sin) }),
          ),
          -1,
          true,
        ),
      );
      titleOpacity.value = withDelay(500 + FADE_IN_MS, withTiming(1, { duration: 600 }));
      titleRise.value = withDelay(
        500 + FADE_IN_MS,
        withTiming(0, { duration: 600, easing: Easing.out(Easing.cubic) }),
      );
      // Postcard caption: in once the scene is established, out just before
      // the dissolve. Runs entirely on the UI thread like everything else.
      const taglineIn = FADE_IN_MS + 1100;
      const taglineHold = DRIVE_MS - 1100 - 450 - 350; // gone by end of drive
      taglineOpacity.value = withDelay(
        taglineIn,
        withSequence(
          withTiming(1, { duration: 450, easing: Easing.out(Easing.quad) }),
          withDelay(taglineHold, withTiming(0, { duration: 350, easing: Easing.in(Easing.quad) })),
        ),
      );
      taglineRise.value = withDelay(
        taglineIn,
        withTiming(0, { duration: 450, easing: Easing.out(Easing.cubic) }),
      );
    }

    timers.push(setTimeout(finish, HARD_TIMEOUT_MS));
    return () => {
      timers.forEach(clearTimeout);
      // The bob is an infinite withRepeat; reanimated does NOT stop it on
      // unmount, and an uncancelled loop keeps the UI thread busy every
      // frame for the rest of the session.
      cancelAnimation(vanBob);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, reducedMotion, assetFailed]);

  const sceneStyle = useAnimatedStyle(() => ({
    opacity: sceneOpacity.value,
    transform: [{ scale: sceneScale.value }],
  }));
  const contentStyle = useAnimatedStyle(() => ({
    opacity: contentOpacity.value,
  }));
  const mountainsStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: -progress.value * scroll.mountains }],
  }));
  const midStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: -progress.value * scroll.mid }],
  }));
  const fgStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: -progress.value * scroll.fg }],
  }));
  const dashStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: -progress.value * scroll.road }],
  }));
  const vanStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: vanExitX.value },
      { translateY: vanBob.value },
      { rotate: `${vanBob.value * 0.18}deg` },
    ],
  }));
  const titleStyle = useAnimatedStyle(() => ({
    opacity: titleOpacity.value,
    transform: [{ translateY: titleRise.value }],
  }));
  const taglineStyle = useAnimatedStyle(() => ({
    opacity: taglineOpacity.value,
    transform: [{ translateY: taglineRise.value }, { rotate: "-2deg" }],
  }));

  const onAssetError = useCallback(() => setAssetFailed(true), []);
  const onAssetLoad = useCallback(() => {
    loadedCountRef.current += 1;
    if (loadedCountRef.current >= ASSET_COUNT) setReady(true);
  }, []);

  // Road center dashes: enough to cover the full scroll distance, no looping.
  const dashW = 34;
  const dashGap = 30;
  const dashCount = Math.ceil((W + scroll.road) / (dashW + dashGap)) + 1;

  return (
    <Pressable style={styles.root} onPress={skip} accessibilityLabel="Skip intro animation">
      <Animated.View style={[styles.scene, sceneStyle]}>
        <Animated.View style={[StyleSheet.absoluteFill, contentStyle]}>
        {/* Sky */}
        <Image source={SKY} style={StyleSheet.absoluteFill} contentFit="cover" onError={onAssetError} onLoad={onAssetLoad} />

        {/* Distant mountains */}
        <Animated.View
          style={[
            styles.strip,
            { top: roadTop - H * 0.1 - mountainsH, height: mountainsH, width: mountainsH * AR.mountains },
            mountainsStyle,
          ]}>
          <Image source={MOUNTAINS} style={styles.stripImage} contentFit="fill" onError={onAssetError} onLoad={onAssetLoad} />
        </Animated.View>

        {/* Mesas + desert floor, sitting on the road */}
        <Animated.View
          style={[
            styles.strip,
            { top: roadTop - midH, height: midH, width: midH * AR.midground },
            midStyle,
          ]}>
          <Image source={MIDGROUND} style={styles.stripImage} contentFit="fill" onError={onAssetError} onLoad={onAssetLoad} />
        </Animated.View>

        {/* Road */}
        <Animated.View style={{ position: "absolute", left: 0, right: 0, top: roadTop, height: roadH, backgroundColor: ROAD.asphalt }}>
          <Animated.View style={{ height: 3, backgroundColor: ROAD.edge, opacity: 0.6 }} />
          <Animated.View style={[styles.dashRow, { top: roadH * 0.48 - 2 }, dashStyle]}>
            {Array.from({ length: dashCount }).map((_, i) => (
              <Animated.View
                key={i}
                style={{ width: dashW, height: 5, marginRight: dashGap, borderRadius: 2.5, backgroundColor: ROAD.dash }}
              />
            ))}
          </Animated.View>
        </Animated.View>

        {/* Near shoulder below the road */}
        <Animated.View
          style={{ position: "absolute", left: 0, right: 0, top: roadTop + roadH, bottom: 0, backgroundColor: ROAD.shoulder }}
        />

        {/* Roadside props (cactus, ROUTE 66 shield) on the far side of the road */}
        <Animated.View
          style={[
            styles.strip,
            { top: roadTop - fgH + H * 0.008, height: fgH, width: fgH * AR.foreground },
            fgStyle,
          ]}>
          <Image source={FOREGROUND} style={styles.stripImage} contentFit="fill" onError={onAssetError} onLoad={onAssetLoad} />
        </Animated.View>

        {/* The camper van */}
        <Animated.View style={[{ position: "absolute", left: vanLeft, top: vanTop, width: vanW, height: vanH }, vanStyle]}>
          <Image source={VAN} style={styles.stripImage} contentFit="contain" onError={onAssetError} onLoad={onAssetLoad} />
        </Animated.View>

        {/* Wordmark, typewriter-style like the postcard caption */}
        <Animated.View style={[styles.titleWrap, { top: H * 0.11 }, titleStyle]}>
          <Text style={styles.title}>WAYPOST</Text>
        </Animated.View>

        {/* Handwritten postcard caption */}
        <Animated.View style={[styles.titleWrap, { top: H * 0.185 }, taglineStyle]}>
          <Text style={styles.tagline}>Relive the Road</Text>
        </Animated.View>
        </Animated.View>
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 1000,
  },
  scene: {
    flex: 1,
    backgroundColor: "#FBF0D9",
    overflow: "hidden",
  },
  strip: {
    position: "absolute",
    left: 0,
  },
  stripImage: {
    width: "100%",
    height: "100%",
  },
  dashRow: {
    position: "absolute",
    left: 0,
    flexDirection: "row",
  },
  titleWrap: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "center",
  },
  title: {
    fontFamily: Atlas.font.monoBold,
    fontSize: 26,
    letterSpacing: 7,
    color: "#4A3B32",
  },
  tagline: {
    fontFamily: "Caveat_600SemiBold",
    fontSize: 36,
    color: "#A64B35",
  },
});

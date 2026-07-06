import * as Haptics from "expo-haptics";
import React, { useCallback } from "react";
import {
  GestureResponderEvent,
  Pressable,
  PressableProps,
  StyleProp,
  ViewStyle,
} from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

type EnteringProp = React.ComponentProps<typeof Animated.View>["entering"];

type Props = Omit<PressableProps, "style"> & {
  style?: StyleProp<ViewStyle>;
  /** Press-down scale target. Keep in 0.94–0.98 per HIG scale-feedback. */
  scaleTo?: number;
  /** Static rotation merged with the press scale (transforms can't be split
   *  across the style prop and the animated style, so it lives here). */
  rotate?: string;
  /** Optional haptic fired on press-in, so feedback lands with the touch. */
  haptic?: "light" | "medium" | "selection";
  entering?: EnteringProp;
  children?: React.ReactNode;
};

// Tactile press-down for cards, pills and grid cells: quick ease-out dip on
// touch, springy return on release. Runs on the UI thread via reanimated.
export default function PressableScale({
  style,
  scaleTo = 0.97,
  rotate = "0deg",
  haptic,
  entering,
  onPressIn,
  onPressOut,
  children,
  ...rest
}: Props) {
  const scale = useSharedValue(1);

  const animStyle = useAnimatedStyle(() => ({
    transform: [{ rotate }, { scale: scale.value }],
  }));

  const handlePressIn = useCallback(
    (e: GestureResponderEvent) => {
      scale.value = withTiming(scaleTo, { duration: 110, easing: Easing.out(Easing.quad) });
      if (haptic === "light") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      else if (haptic === "medium") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      else if (haptic === "selection") Haptics.selectionAsync();
      onPressIn?.(e);
    },
    [scale, scaleTo, haptic, onPressIn],
  );

  const handlePressOut = useCallback(
    (e: GestureResponderEvent) => {
      scale.value = withSpring(1, { damping: 16, stiffness: 260 });
      onPressOut?.(e);
    },
    [scale, onPressOut],
  );

  return (
    <AnimatedPressable
      {...rest}
      entering={entering}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      style={[style, animStyle]}
    >
      {children}
    </AnimatedPressable>
  );
}

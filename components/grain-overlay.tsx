import React from "react";
import { Image, StyleSheet, View } from "react-native";

// Near-invisible warm paper grain over the aged-paper background. Uses the
// core RN Image (not expo-image) because only it supports resizeMode="repeat"
// for tiling. Alpha is baked into the tile, so no opacity math here.
export default function GrainOverlay() {
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <Image
        source={require("@/assets/textures/grain.png")}
        style={styles.tile}
        resizeMode="repeat"
        fadeDuration={0}
        accessible={false}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  tile: { flex: 1, width: undefined, height: undefined },
});

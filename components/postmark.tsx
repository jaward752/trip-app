import React from "react";
import { StyleSheet, Text, View } from "react-native";

import { Atlas } from "@/constants/theme";

const INK = "rgba(166,75,53,0.62)"; // rust stamp ink (#A64B35)

const MONTHS = [
  "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
  "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
];

// Circular rubber-stamp postmark for trip covers: dashed outer ring, thin
// inner ring, WAYPOST wordmark and the trip's start date — like mail sent
// from the road. Pure Views + Text, no assets.
export default function Postmark({ date }: { date: Date | null }) {
  const line = date
    ? `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`
    : "EN ROUTE";
  return (
    <View style={styles.wrap} pointerEvents="none">
      <View style={styles.inner}>
        <Text style={styles.brand}>WAYPOST</Text>
        <Text style={styles.date}>{line}</Text>
        <Text style={styles.stars}>· · ·</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: "absolute",
    top: 6,
    right: 6,
    width: 66,
    height: 66,
    borderRadius: 33,
    borderWidth: 1.5,
    borderStyle: "dashed",
    borderColor: INK,
    alignItems: "center",
    justifyContent: "center",
    transform: [{ rotate: "-12deg" }],
  },
  inner: {
    width: 56,
    height: 56,
    borderRadius: 28,
    borderWidth: 1,
    borderColor: INK,
    alignItems: "center",
    justifyContent: "center",
  },
  brand: {
    fontFamily: Atlas.font.monoBold,
    fontSize: 7,
    letterSpacing: 1.5,
    color: INK,
  },
  date: {
    fontFamily: Atlas.font.monoBold,
    fontSize: 8,
    marginTop: 1,
    color: INK,
  },
  stars: {
    fontSize: 7,
    lineHeight: 8,
    marginTop: 1,
    color: INK,
  },
});

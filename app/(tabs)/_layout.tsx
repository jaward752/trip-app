import { Tabs } from 'expo-router';
import React from 'react';

export default function TabLayout() {
  // The Atlas of Life bottom nav is rendered inside the screen itself
  // (it switches an internal state machine, not routes), so the router
  // tab bar is hidden.
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: { display: 'none' },
      }}>
      <Tabs.Screen name="index" />
    </Tabs>
  );
}

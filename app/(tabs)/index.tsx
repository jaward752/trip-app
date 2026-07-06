import { MaterialIcons } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as ImagePicker from "expo-image-picker";
import * as MediaLibrary from "expo-media-library";
import React, { useEffect, useRef, useState } from "react";
import { Image } from "expo-image";
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { Directions, Gesture, GestureDetector } from "react-native-gesture-handler";
import MapView, { Marker, Polyline } from "react-native-maps";
import * as Haptics from "expo-haptics";
import Animated, {
  Easing,
  FadeIn,
  FadeInUp,
  FadeOut,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import GrainOverlay from "@/components/grain-overlay";
import Postmark from "@/components/postmark";
import PressableScale from "@/components/pressable-scale";
import { Atlas } from "@/constants/theme";

// Shared micro-interaction timings: screens crossfade in fast; cards settle
// in with a short stagger. Photo loads crossfade via expo-image `transition`.
const SCREEN_FADE = () => FadeIn.duration(180);
const cardEnter = (index: number) =>
  FadeInUp.duration(240).delay(Math.min(index * 40, 320));
const PHOTO_FADE_MS = 160;

// FlatList mounts rows continuously while scrolling, and `entering` fires on
// every mount — so the card stagger must be limited to the moment a screen is
// entered, or scrolling replays fades forever (and pays layout-animation
// setup per row). Rows mounted after this window get no entering animation.
const CARD_ENTER_WINDOW_MS = 600;

const SCREEN_W = Dimensions.get("window").width;
const STOP_RADIUS_KM = 5;
const STORAGE_KEY = "trips_v1";
const STORY_STORAGE_KEY = "storyboards_v1";

// Photo grids: fixed-size cells (fractional flex + aspectRatio misbehaves
// in FlatList rows on RN 0.81, collapsing rows after the first).
const GRID_COLS = 4;
const GRID_GAP = 2;
const GRID_PADDING = 4;
const CELL_SIZE =
  (SCREEN_W - GRID_PADDING * 2 - GRID_GAP * (GRID_COLS - 1)) / GRID_COLS;

// Shared perf props for the photo grids. With numColumns, FlatList
// virtualizes whole rows, so getItemLayout and the render counts are in rows.
const GRID_ROW_H = CELL_SIZE + GRID_GAP;
const GRID_PERF = {
  getItemLayout: (
    _: ArrayLike<Photo> | null | undefined,
    index: number
  ) => ({
    length: GRID_ROW_H,
    offset: GRID_ROW_H * index,
    index,
  }),
  initialNumToRender: 10,
  maxToRenderPerBatch: 8,
  windowSize: 9,
  removeClippedSubviews: true,
} as const;

// Polaroid rotations from the Stitch Albums screen, in card order.
const CARD_ROTATIONS = ["-1deg", "2deg", "-0.5deg", "1.5deg", "-2.5deg"];

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

type Photo = {
  id: string;
  uri: string;
  date: Date | null;
  lat: number | null;
  lon: number | null;
  caption: string;
};

type Destination = "album" | "map" | "both";

// Taped-label chips on the trip-details form, with their hand-placed tilts.
const DESTINATION_CHIPS: {
  destination: Destination;
  label: string;
  rotate: string;
}[] = [
  { destination: "album", label: "#Album", rotate: "-1deg" },
  { destination: "map", label: "#Map", rotate: "2deg" },
  { destination: "both", label: "#Both", rotate: "-1deg" },
];

type Trip = {
  id: string;
  name: string;
  destination: Destination;
  photos: Photo[];
};

type Stop = {
  id: string;
  photos: Photo[];
  lat: number;
  lon: number;
  placeName: string | null;
};

// A curated story: an ordered sequence of pages, each referencing a photo in
// the source trip by id (so photo URIs stay fresh via the trip-loading path)
// with its own caption, independent of the album caption.
type StoryPage = { photoId: string; caption: string };

type Storyboard = {
  id: string;
  title: string;
  sourceTripId: string;
  pages: StoryPage[];
  createdAt: number;
};

function toNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// EXIF blobs come from the picker as untyped bags of vendor fields, so every
// value is `unknown` until checked.
type Exif = Record<string, unknown> | null | undefined;

function exifDate(exif: Exif): Date | null {
  const raw = exif?.DateTimeOriginal ?? exif?.DateTime;
  if (typeof raw !== "string") return null;
  const m = raw.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return Number.isFinite(d.getTime()) ? d : null;
}

function exifCoord(
  exif: Exif,
  key: "GPSLatitude" | "GPSLongitude",
  negativeRef: "S" | "W"
): number | null {
  const v = toNum(exif?.[key]);
  if (v === null) return null;
  const ref = exif?.[key + "Ref"];
  return typeof ref === "string" && ref.toUpperCase().startsWith(negativeRef)
    ? -Math.abs(v)
    : v;
}

// Turn native-picker results into Photos. Metadata (GPS, creation date,
// permanent local URI) comes from the media library via assetId so trips
// survive relaunches; EXIF from the picked copy is the fallback.
//
// Large batches (100+) must not block on one slow asset, so lookups run a
// few at a time with a timeout each. Cloud-only originals are NOT downloaded:
// the metadata comes back without the file, and the picker's local copy
// (a.uri) is always available for display.
const ENRICH_CONCURRENCY = 8;
const ENRICH_TIMEOUT_MS = 5000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

// Order-preserving map with a bounded worker pool.
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  );
  return results;
}

function pickedToPhotos(
  assets: ImagePicker.ImagePickerAsset[]
): Promise<Photo[]> {
  return mapWithConcurrency(assets, ENRICH_CONCURRENCY, async (a) => {
    let uri = a.uri;
    let date = exifDate(a.exif);
    let lat = exifCoord(a.exif, "GPSLatitude", "S");
    let lon = exifCoord(a.exif, "GPSLongitude", "W");
    if (a.assetId) {
      try {
        const info = await withTimeout(
          MediaLibrary.getAssetInfoAsync(a.assetId, {
            shouldDownloadFromNetwork: false,
          }),
          ENRICH_TIMEOUT_MS
        );
        uri = info.localUri ?? uri;
        if (info.creationTime) date = new Date(info.creationTime);
        if (info.location) {
          lat = info.location.latitude;
          lon = info.location.longitude;
        }
      } catch {
        // keep the EXIF-derived values and the picker's cached copy
      }
    }
    return {
      id: a.assetId ?? a.uri,
      uri,
      date,
      lat,
      lon,
      caption: "",
    };
  });
}

function byPhotoDate(a: Photo, b: Photo): number {
  if (!a.date) return 1;
  if (!b.date) return -1;
  return a.date.getTime() - b.date.getTime();
}

function fmtStamp(d: Date): string {
  return `${d.getDate()} ${MONTHS[d.getMonth()].toUpperCase()} ${d.getFullYear()}`;
}

function plural(n: number, word: string, pluralWord = word + "s"): string {
  return `${n} ${n === 1 ? word : pluralWord}`;
}

// ---------- PERSISTENCE ----------

// Trip shape persisted to AsyncStorage under STORAGE_KEY. Photo URIs are
// deliberately not stored; they are re-resolved from the media library on
// load. Dates are stored as epoch millis.
type StoredPhoto = {
  id: string;
  date: number | null;
  lat: number | null;
  lon: number | null;
  caption: string;
};

type StoredTrip = {
  id: string;
  name: string;
  destination: Destination;
  photos: StoredPhoto[];
};

function serializeTrips(trips: Trip[]): string {
  const plain: StoredTrip[] = trips.map((t) => ({
    id: t.id,
    name: t.name,
    destination: t.destination,
    photos: t.photos.map((p) => ({
      id: p.id,
      date: p.date ? p.date.getTime() : null,
      lat: p.lat,
      lon: p.lon,
      caption: p.caption,
    })),
  }));
  return JSON.stringify(plain);
}

async function saveTripsToStorage(trips: Trip[]) {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, serializeTrips(trips));
  } catch (e) {
    console.error("Failed to persist trips to AsyncStorage:", e);
  }
}

async function loadTripsFromStorage(): Promise<Trip[]> {
  let plain: StoredTrip[];
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    plain = JSON.parse(raw) as StoredTrip[];
  } catch (e) {
    console.error("Failed to load trips from AsyncStorage:", e);
    return [];
  }

  // Re-resolve every photo's URI from the media library with the same
  // bounded-concurrency pool used on import. Cloud-only originals are not
  // downloaded; expo-image renders their ph:// asset URIs directly.
  const slots = plain.flatMap((t, tripIdx) =>
    t.photos.map((p) => ({ tripIdx, p }))
  );
  const uris = await mapWithConcurrency(slots, ENRICH_CONCURRENCY, async (s) => {
    try {
      const info = await withTimeout(
        MediaLibrary.getAssetInfoAsync(s.p.id, {
          shouldDownloadFromNetwork: false,
        }),
        ENRICH_TIMEOUT_MS
      );
      return info.localUri ?? info.uri;
    } catch {
      return ""; // asset gone (or lookup hung) -> photo drops out below
    }
  });

  const trips: Trip[] = plain.map((t) => ({
    id: t.id,
    name: t.name,
    destination: t.destination,
    photos: [],
  }));
  slots.forEach((s, i) => {
    if (!uris[i]) return;
    trips[s.tripIdx].photos.push({
      id: s.p.id,
      uri: uris[i],
      date: s.p.date ? new Date(s.p.date) : null,
      lat: s.p.lat,
      lon: s.p.lon,
      caption: s.p.caption,
    });
  });
  return trips;
}

// Storyboards are pure JSON-safe data, so they round-trip as-is.
async function saveStoryboardsToStorage(storyboards: Storyboard[]) {
  try {
    await AsyncStorage.setItem(STORY_STORAGE_KEY, JSON.stringify(storyboards));
  } catch (e) {
    console.error("Failed to persist storyboards to AsyncStorage:", e);
  }
}

async function loadStoryboardsFromStorage(): Promise<Storyboard[]> {
  try {
    const raw = await AsyncStorage.getItem(STORY_STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as Storyboard[];
  } catch (e) {
    console.error("Failed to load storyboards from AsyncStorage:", e);
    return [];
  }
}

// Resolve a storyboard's pages against the loaded trips. Pages whose photo
// was removed from the source trip (or whose trip was deleted) drop out.
function resolveStoryPages(
  sb: Storyboard,
  trips: Trip[]
): { photo: Photo; caption: string }[] {
  const trip = trips.find((t) => t.id === sb.sourceTripId);
  if (!trip) return [];
  const byId = new Map(trip.photos.map((p) => [p.id, p]));
  const out: { photo: Photo; caption: string }[] = [];
  for (const pg of sb.pages) {
    const photo = byId.get(pg.photoId);
    if (photo) out.push({ photo, caption: pg.caption });
  }
  return out;
}

// Nostalgic page entrance: the incoming page fades in while gently settling
// from a slight zoom, like a print being laid onto the desk.
const storyPageEnter = () => {
  "worklet";
  return {
    initialValues: { opacity: 0, transform: [{ scale: 1.06 }] },
    animations: {
      opacity: withTiming(1, { duration: 550, easing: Easing.out(Easing.quad) }),
      transform: [
        {
          scale: withTiming(1, {
            duration: 1400,
            easing: Easing.out(Easing.cubic),
          }),
        },
      ],
    },
  };
};

function distanceKm(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number }
): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function clusterIntoStops(photos: Photo[]): Stop[] {
  const located = photos
    .filter((p) => p.lat !== null && p.lon !== null)
    .sort(byPhotoDate);

  if (located.length === 0) return [];

  const stops: Stop[] = [];
  let current: Photo[] = [located[0]];
  let centre = { lat: located[0].lat!, lon: located[0].lon! };

  for (let i = 1; i < located.length; i++) {
    const p = located[i];
    const d = distanceKm(centre, { lat: p.lat!, lon: p.lon! });
    if (d > STOP_RADIUS_KM) {
      stops.push(makeStop(current));
      current = [p];
      centre = { lat: p.lat!, lon: p.lon! };
    } else {
      current.push(p);
      const n = current.length;
      centre = {
        lat: (centre.lat * (n - 1) + p.lat!) / n,
        lon: (centre.lon * (n - 1) + p.lon!) / n,
      };
    }
  }
  stops.push(makeStop(current));
  return stops;
}

function makeStop(photos: Photo[]): Stop {
  const lat = photos.reduce((s, p) => s + (p.lat ?? 0), 0) / photos.length;
  const lon = photos.reduce((s, p) => s + (p.lon ?? 0), 0) / photos.length;
  return { id: photos[0].id, photos, lat, lon, placeName: null };
}

function tripCentre(trip: Trip): { lat: number; lon: number } | null {
  const located = trip.photos.filter((p) => p.lat !== null && p.lon !== null);
  if (located.length === 0) return null;
  return {
    lat: located.reduce((s, p) => s + p.lat!, 0) / located.length,
    lon: located.reduce((s, p) => s + p.lon!, 0) / located.length,
  };
}

function boundsForCoords(
  coords: { lat: number; lon: number }[],
  padding = 0.25,
  minDelta = 0
): { latitude: number; longitude: number; latitudeDelta: number; longitudeDelta: number } {
  const lats = coords.map((c) => c.lat);
  const lons = coords.map((c) => c.lon);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);
  const latDelta = Math.max(maxLat - minLat, 0.02, minDelta) * (1 + padding);
  const lonDelta = Math.max(maxLon - minLon, 0.02, minDelta) * (1 + padding);
  return {
    latitude: (minLat + maxLat) / 2,
    longitude: (minLon + maxLon) / 2,
    latitudeDelta: latDelta,
    longitudeDelta: lonDelta,
  };
}

type Screen =
  | "albums"
  | "details"
  | "album"
  | "globalmap"
  | "stopgrid"
  | "storybook"
  | "sbPickAlbum"
  | "sbPickPhotos"
  | "sbArrange"
  | "sbViewer";

type Tab = "albums" | "globalmap" | "storybook";

// ---------- SHARED CHROME ----------

// Hairline divider drawn as the route-dash motif (same dash rhythm as the
// map polyline and the intro's road centerline).
function RouteDivider() {
  return (
    <View style={styles.routeDividerClip}>
      <View style={styles.routeDividerLine} />
    </View>
  );
}

// Vintage odometer: each digit sits in its own dark rolling-counter cell.
function Odometer({ value }: { value: number }) {
  return (
    <View style={styles.odoRow}>
      {String(value)
        .split("")
        .map((d, i) => (
          <View key={i} style={styles.odoCell}>
            <Text style={styles.odoDigit}>{d}</Text>
          </View>
        ))}
    </View>
  );
}

function TopAppBar() {
  return (
    <View style={styles.appBar}>
      <View style={styles.appBarLeft}>
        <MaterialIcons name="menu" size={24} color={Atlas.color.primary} />
        <Text style={styles.appBarTitle}>Waypost</Text>
      </View>
      <View style={styles.appBarAvatar}>
        <MaterialIcons name="person" size={22} color={Atlas.color.onSecondaryContainer} />
      </View>
      <View style={styles.appBarDivider}>
        <RouteDivider />
      </View>
    </View>
  );
}

function SubHeader({
  title,
  subtitle,
  onBack,
  backLabel,
  rightAction,
}: {
  title: string;
  subtitle?: string;
  onBack: () => void;
  backLabel: string;
  rightAction?: React.ReactNode;
}) {
  return (
    <View style={styles.subHeader}>
      <TouchableOpacity onPress={onBack} style={styles.subHeaderBack}>
        <MaterialIcons name="arrow-back" size={18} color={Atlas.color.onSurfaceVariant} />
        <Text style={styles.subHeaderBackText}>{backLabel}</Text>
      </TouchableOpacity>
      <View style={styles.subHeaderMiddle}>
        <Text style={styles.subHeaderTitle} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? <Text style={styles.subHeaderSub}>{subtitle}</Text> : null}
      </View>
      <View style={styles.subHeaderRight}>{rightAction}</View>
    </View>
  );
}

function EmptyState({
  icon,
  message,
}: {
  icon?: keyof typeof MaterialIcons.glyphMap;
  message: string;
}) {
  return (
    <View style={styles.center}>
      {icon && <MaterialIcons name={icon} size={36} color={Atlas.color.outline} />}
      <Text style={styles.emptyText}>{message}</Text>
    </View>
  );
}

// Header-right "Select"/"Cancel" toggle for the photo-grid screens.
function SelectToggle({
  selectMode,
  onEnter,
  onExit,
}: {
  selectMode: boolean;
  onEnter: () => void;
  onExit: () => void;
}) {
  return (
    <TouchableOpacity onPress={selectMode ? onExit : onEnter}>
      <Text style={styles.headerAction}>{selectMode ? "Cancel" : "Select"}</Text>
    </TouchableOpacity>
  );
}

// Bottom Cancel/Delete bar shown while selecting photos in a grid.
function SelectBar({
  count,
  onCancel,
  onDelete,
}: {
  count: number;
  onCancel: () => void;
  onDelete: () => void;
}) {
  return (
    <View style={styles.selectBar}>
      <TouchableOpacity onPress={onCancel} style={styles.selectBarCancel}>
        <Text style={styles.selectBarCancelText}>Cancel</Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[
          styles.selectBarDelete,
          count === 0 && styles.selectBarDeleteDisabled,
        ]}
        onPress={onDelete}
        disabled={count === 0}
      >
        <Text style={styles.selectBarDeleteText}>
          {count > 0 ? `Delete (${count})` : "Delete"}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

// The 4-column virtualized photo grid shared by the album, stop, and
// storyboard-pick screens. `overlay` draws per-cell selection chrome.
function PhotoGrid({
  photos,
  onPressCell,
  overlay,
  bottomPadding = 110,
}: {
  photos: Photo[];
  onPressCell: (photo: Photo, index: number) => void;
  overlay?: (photo: Photo) => React.ReactNode;
  bottomPadding?: number;
}) {
  return (
    <FlatList
      data={photos}
      keyExtractor={(p) => p.id}
      numColumns={GRID_COLS}
      {...GRID_PERF}
      columnWrapperStyle={styles.gridRow}
      contentContainerStyle={{
        padding: GRID_PADDING,
        paddingBottom: bottomPadding,
      }}
      renderItem={({ item, index }) => (
        <TouchableOpacity
          style={styles.pickCell}
          onPress={() => onPressCell(item, index)}
          activeOpacity={0.85}
        >
          <Image
            source={{ uri: item.uri }}
            style={styles.gridThumb}
            recyclingKey={item.id}
            cachePolicy="memory-disk"
            transition={PHOTO_FADE_MS}
          />
          {overlay?.(item)}
        </TouchableOpacity>
      )}
    />
  );
}

// Check/circle overlay for a grid cell while select mode is active.
function SelectOverlay({ selected }: { selected: boolean }) {
  return selected ? (
    <View style={styles.selectCheck}>
      <MaterialIcons name="check" size={15} color={Atlas.color.onPrimary} />
    </View>
  ) : (
    <View style={styles.selectCircle} />
  );
}

// Dashed "create new" card at the end of the albums and storybook grids.
function NewItemCard({
  label,
  entering,
  onPress,
}: {
  label: string;
  entering: ReturnType<typeof cardEnter> | undefined;
  onPress: () => void;
}) {
  return (
    <PressableScale
      style={styles.newJournalCard}
      entering={entering}
      scaleTo={0.96}
      haptic="light"
      onPress={onPress}
    >
      <View style={styles.newJournalPlus}>
        <MaterialIcons name="add" size={22} color={Atlas.color.primary} />
      </View>
      <Text style={styles.newJournalText}>{label}</Text>
    </PressableScale>
  );
}

// Inline rename field on the polaroid cards (trips and storyboards).
function TitleEditInput({
  value,
  onChangeText,
  onCommit,
}: {
  value: string;
  onChangeText: (text: string) => void;
  onCommit: () => void;
}) {
  return (
    <TextInput
      style={styles.polaroidTitleInput}
      value={value}
      onChangeText={onChangeText}
      autoFocus
      returnKeyType="done"
      onSubmitEditing={onCommit}
      onBlur={onCommit}
    />
  );
}

const NAV_ITEMS: { tab: Tab; icon: keyof typeof MaterialIcons.glyphMap; label: string }[] = [
  { tab: "albums", icon: "photo-library", label: "Albums" },
  { tab: "globalmap", icon: "public", label: "World Map" },
  { tab: "storybook", icon: "auto-stories", label: "Storybook" },
];

// Which nav item sits under a touch at x, for a strip of the given width.
function navIndexAt(x: number, stripWidth: number): number {
  "worklet";
  return Math.min(
    NAV_ITEMS.length - 1,
    Math.max(0, Math.floor((x / stripWidth) * NAV_ITEMS.length))
  );
}

function NavItem({
  icon,
  label,
  emphasized,
  hovered,
  onPress,
}: {
  icon: keyof typeof MaterialIcons.glyphMap;
  label: string;
  emphasized: boolean;
  hovered: boolean;
  onPress: () => void;
}) {
  const scale = useSharedValue(1);
  useEffect(() => {
    scale.value = withTiming(hovered ? 1.18 : 1, {
      duration: 130,
      easing: Easing.out(Easing.quad),
    });
  }, [hovered, scale]);
  const animStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));
  return (
    <TouchableOpacity
      style={[styles.navItem, !emphasized && { opacity: 0.6 }]}
      onPress={onPress}
    >
      <Animated.View style={[styles.navItemInner, animStyle]}>
        <MaterialIcons
          name={icon}
          size={24}
          color={emphasized ? Atlas.color.primary : Atlas.color.onSurfaceVariant}
        />
        <Text style={[styles.navLabel, emphasized && styles.navLabelActive]}>{label}</Text>
      </Animated.View>
    </TouchableOpacity>
  );
}

// Bottom bar with Instagram-style tab scrubbing: press and hold anywhere on
// the bar, then drag left/right — the tab under the finger highlights (with a
// selection haptic per change) and is committed on release. Plain taps still
// work through the touchables; quick swipes are ignored (the pan only
// activates after the hold).
function BottomNav({ active, onNavigate }: { active: Tab; onNavigate: (t: Tab) => void }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const hoveredRef = useRef<number | null>(null);
  const stripWidth = useSharedValue(0);

  function hoverTo(i: number | null) {
    if (hoveredRef.current === i) return;
    hoveredRef.current = i;
    setHovered(i);
    if (i !== null) Haptics.selectionAsync();
  }

  function commitHover(i: number) {
    onNavigate(NAV_ITEMS[i].tab);
  }

  function clearHover() {
    hoverTo(null);
  }

  const scrub = Gesture.Pan()
    .maxPointers(1)
    .activateAfterLongPress(220)
    .onStart((e) => {
      if (stripWidth.value <= 0) return;
      runOnJS(hoverTo)(navIndexAt(e.x, stripWidth.value));
    })
    .onUpdate((e) => {
      if (stripWidth.value <= 0) return;
      runOnJS(hoverTo)(navIndexAt(e.x, stripWidth.value));
    })
    .onEnd((e) => {
      if (stripWidth.value <= 0) return;
      runOnJS(commitHover)(navIndexAt(e.x, stripWidth.value));
    })
    .onFinalize(() => {
      runOnJS(clearHover)();
    });

  const holding = hovered !== null;
  return (
    <View style={styles.bottomNav}>
      <GestureDetector gesture={scrub}>
        <View
          style={styles.navStrip}
          onLayout={(e) => {
            stripWidth.value = e.nativeEvent.layout.width;
          }}
        >
          {NAV_ITEMS.map(({ tab, icon, label }, i) => (
            <NavItem
              key={tab}
              icon={icon}
              label={label}
              hovered={hovered === i}
              emphasized={holding ? hovered === i : tab === active}
              onPress={() => onNavigate(tab)}
            />
          ))}
        </View>
      </GestureDetector>
    </View>
  );
}

// Player photo: the polaroid frame adapts to the photo's real aspect ratio
// (clamped so extreme shapes keep a sensible frame) instead of cropping
// everything to 4:5 — in the player the photo is the content, so it must
// show in full. Covers on the grid screens keep their uniform 4:5 crop.
function StoryPhoto({ uri }: { uri: string }) {
  const [ratio, setRatio] = useState<number | null>(null);
  return (
    <Image
      source={{ uri }}
      style={[styles.storyPhoto, ratio !== null && { aspectRatio: ratio }]}
      contentFit="contain"
      cachePolicy="memory-disk"
      onLoad={(e) => {
        const { width, height } = e.source;
        if (width > 0 && height > 0) {
          setRatio(Math.min(1.9, Math.max(0.65, width / height)));
        }
      }}
    />
  );
}

function ViewerPage({
  photo,
  onChangeCaption,
}: {
  photo: Photo;
  onChangeCaption: (text: string) => void;
}) {
  const [text, setText] = useState(photo.caption);
  return (
    <View style={styles.viewerPage}>
      <View style={styles.viewerImageWrap}>
        <Image
          source={{ uri: photo.uri }}
          style={styles.viewerImage}
          contentFit="contain"
          cachePolicy="memory-disk"
          transition={PHOTO_FADE_MS}
        />
      </View>
      <View style={styles.captionZone}>
        <TextInput
          style={styles.captionInput}
          placeholder="Add a caption..."
          placeholderTextColor="rgba(255,255,255,0.4)"
          value={text}
          onChangeText={(t) => {
            setText(t);
            onChangeCaption(t);
          }}
          multiline
          scrollEnabled
          textAlignVertical="top"
        />
      </View>
    </View>
  );
}

export default function HomeScreen() {
  const [screen, setScreen] = useState<Screen>("albums");

  // Reopens the card-stagger window on every screen change (see
  // CARD_ENTER_WINDOW_MS). A ref, not state: reading it in renderItem must
  // not schedule re-renders.
  const screenEnteredAt = useRef(Date.now());
  useEffect(() => {
    screenEnteredAt.current = Date.now();
  }, [screen]);
  const cardEntering = (index: number) =>
    Date.now() - screenEnteredAt.current < CARD_ENTER_WINDOW_MS
      ? cardEnter(index)
      : undefined;

  const [trips, setTrips] = useState<Trip[]>([]);
  const [loadedFromStorage, setLoadedFromStorage] = useState(false);

  const [picked, setPicked] = useState<ImagePicker.ImagePickerAsset[]>([]);
  const [preparing, setPreparing] = useState(false);

  const [tripName, setTripName] = useState("");
  const [destination, setDestination] = useState<Destination>("album");

  const mapRef = useRef<MapView>(null);

  const [activeTrip, setActiveTrip] = useState<Trip | null>(null);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [viewerPhotos, setViewerPhotos] = useState<Photo[]>([]);
  const [activeStop, setActiveStop] = useState<Stop | null>(null);
  const [selectedTrip, setSelectedTrip] = useState<Trip | null>(null);
  const [stopgridReturn, setStopgridReturn] = useState<Screen>("globalmap");

  const [selectMode, setSelectMode] = useState(false);
  const [gridSelectedIds, setGridSelectedIds] = useState<Set<string>>(new Set());
  const [viewerDeletable, setViewerDeletable] = useState(false);

  const [editingTripId, setEditingTripId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");

  const [storyboards, setStoryboards] = useState<Storyboard[]>([]);
  const [editingStoryId, setEditingStoryId] = useState<string | null>(null);
  const [editingStoryName, setEditingStoryName] = useState("");

  // Create-flow draft
  const [sbSourceTrip, setSbSourceTrip] = useState<Trip | null>(null);
  const [sbSelectedIds, setSbSelectedIds] = useState<string[]>([]);
  const [sbDraftPages, setSbDraftPages] = useState<StoryPage[]>([]);
  const [sbTitle, setSbTitle] = useState("");

  // Playback
  const [activeStory, setActiveStory] = useState<Storyboard | null>(null);
  const [storyPageIdx, setStoryPageIdx] = useState(0);

  useEffect(() => {
    (async () => {
      const [savedTrips, savedStories] = await Promise.all([
        loadTripsFromStorage(),
        loadStoryboardsFromStorage(),
      ]);
      setTrips(savedTrips);
      setStoryboards(savedStories);
      setLoadedFromStorage(true);
    })();
  }, []);

  useEffect(() => {
    if (loadedFromStorage) {
      saveTripsToStorage(trips);
    }
  }, [trips, loadedFromStorage]);

  useEffect(() => {
    if (loadedFromStorage) {
      saveStoryboardsToStorage(storyboards);
    }
  }, [storyboards, loadedFromStorage]);

  async function openPicker(addToId?: string) {
    // Media-library access (not needed by the native picker itself) lets us
    // read GPS/date metadata for the chosen photos and re-resolve them from
    // storage on the next launch.
    const perm = await MediaLibrary.requestPermissionsAsync();
    if (!perm.granted) {
      Alert.alert("Photo access is needed.");
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsMultipleSelection: true,
      selectionLimit: 0,
      quality: 1,
      exif: true,
    });
    if (result.canceled || result.assets.length === 0) return;

    if (addToId) {
      await appendPhotosToTrip(addToId, result.assets);
    } else {
      setPicked(result.assets);
      setScreen("details");
    }
  }

  async function saveTrip() {
    setPreparing(true);
    try {
      const enriched = await pickedToPhotos(picked);
      enriched.sort(byPhotoDate);

      const trip: Trip = {
        id: Date.now().toString(),
        name: tripName.trim() || "Untitled trip",
        destination,
        photos: enriched,
      };

      setTrips((prev) => [trip, ...prev]);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setTripName("");
      setDestination("album");
      setPicked([]);
      setScreen("albums");
    } finally {
      setPreparing(false);
    }
  }

  async function appendPhotosToTrip(
    tripId: string,
    assets: ImagePicker.ImagePickerAsset[]
  ) {
    if (!trips.some((t) => t.id === tripId)) return;
    setPreparing(true);

    try {
      const enriched = await pickedToPhotos(assets);

      // Merge against whatever the trip holds *now* (state may have moved on
      // during the await above); applied identically to trips and activeTrip.
      const mergeInto = (t: Trip): Trip => {
        const existingIds = new Set(t.photos.map((p) => p.id));
        const merged = [
          ...t.photos,
          ...enriched.filter((p) => !existingIds.has(p.id)),
        ].sort(byPhotoDate);
        return { ...t, photos: merged };
      };

      setTrips((prev) =>
        prev.map((t) => (t.id === tripId ? mergeInto(t) : t))
      );
      setActiveTrip((at) => (at && at.id === tripId ? mergeInto(at) : at));
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } finally {
      setPreparing(false);
    }
  }

  function saveCaptionTo(photoId: string, text: string) {
    setActiveTrip((prev) => {
      if (!prev) return prev;
      const updatedPhotos = prev.photos.map((p) =>
        p.id === photoId ? { ...p, caption: text } : p
      );
      const updatedTrip = { ...prev, photos: updatedPhotos };
      setTrips((all) =>
        all.map((t) => (t.id === updatedTrip.id ? updatedTrip : t))
      );
      return updatedTrip;
    });
  }

  function openViewer(photos: Photo[], index: number, deletable = false) {
    setViewerPhotos(photos);
    setViewerIndex(index);
    setViewerDeletable(deletable);
  }

  function closeViewer() {
    Keyboard.dismiss();
    setViewerIndex(null);
    setViewerPhotos([]);
  }

  function onViewerScroll(e: NativeSyntheticEvent<NativeScrollEvent>) {
    const newIndex = Math.round(e.nativeEvent.contentOffset.x / SCREEN_W);
    if (newIndex !== viewerIndex) {
      Keyboard.dismiss();
      setViewerIndex(newIndex);
    }
  }

  function emptyReturnScreen(): Screen {
    if (screen === "stopgrid" || screen === "globalmap") return "globalmap";
    if (screen === "storybook") return "storybook";
    return "albums";
  }

  // `emptyReturnTo` is captured by callers before any confirmation dialog so
  // the return target reflects the screen the flow started on.
  function removePhotosFromAlbum(
    tripId: string,
    photoIds: string[],
    emptyReturnTo: Screen
  ) {
    const idSet = new Set(photoIds);
    const currentTrip = trips.find((t) => t.id === tripId);
    const willBeEmpty =
      currentTrip !== undefined &&
      currentTrip.photos.filter((p) => !idSet.has(p.id)).length === 0;

    if (willBeEmpty) {
      setTrips((prev) => prev.filter((t) => t.id !== tripId));
      setActiveTrip(null);
      setActiveStop(null);
      setSelectedTrip((prev) => (prev?.id === tripId ? null : prev));
      exitSelectMode();
      setScreen(emptyReturnTo);
    } else {
      setTrips((prev) =>
        prev.map((t) =>
          t.id === tripId
            ? { ...t, photos: t.photos.filter((p) => !idSet.has(p.id)) }
            : t
        )
      );
      setActiveTrip((prev) =>
        prev && prev.id === tripId
          ? { ...prev, photos: prev.photos.filter((p) => !idSet.has(p.id)) }
          : prev
      );
      setActiveStop((prev) =>
        prev ? { ...prev, photos: prev.photos.filter((p) => !idSet.has(p.id)) } : prev
      );
    }
  }

  function deleteViewerPhoto() {
    if (viewerIndex === null || !activeTrip) return;
    const currentPhoto = viewerPhotos[viewerIndex];
    const emptyReturnTo = emptyReturnScreen();
    Alert.alert(
      "Remove from album?",
      "This photo will be removed from the trip but not deleted from your camera roll.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            const newPhotos = viewerPhotos.filter((p) => p.id !== currentPhoto.id);
            if (newPhotos.length === 0) {
              closeViewer();
            } else {
              setViewerPhotos(newPhotos);
              setViewerIndex(Math.min(viewerIndex, newPhotos.length - 1));
            }
            removePhotosFromAlbum(activeTrip.id, [currentPhoto.id], emptyReturnTo);
          },
        },
      ]
    );
  }

  function exitSelectMode() {
    setSelectMode(false);
    setGridSelectedIds(new Set());
  }

  function toggleGridSelect(id: string) {
    Haptics.selectionAsync();
    setGridSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function confirmDeleteSelected() {
    const ids = Array.from(gridSelectedIds);
    if (!activeTrip || ids.length === 0) return;
    const emptyReturnTo = emptyReturnScreen();
    Alert.alert(
      `Remove ${plural(ids.length, "photo")}?`,
      "They will be removed from this trip but not deleted from your camera roll.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            removePhotosFromAlbum(activeTrip.id, ids, emptyReturnTo);
            exitSelectMode();
          },
        },
      ]
    );
  }

  function deleteTrip(id: string) {
    Alert.alert("Delete trip", "This can't be undone.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          setTrips((prev) => prev.filter((t) => t.id !== id));
        },
      },
    ]);
  }

  function startEdit(trip: Trip) {
    setEditingTripId(trip.id);
    setEditingName(trip.name);
  }

  function confirmEdit() {
    if (!editingTripId) return;
    const trimmed = editingName.trim();
    if (trimmed) {
      setTrips((prev) =>
        prev.map((t) => (t.id === editingTripId ? { ...t, name: trimmed } : t))
      );
      if (activeTrip?.id === editingTripId) {
        setActiveTrip((prev) => (prev ? { ...prev, name: trimmed } : prev));
      }
    }
    setEditingTripId(null);
    setEditingName("");
  }

  function albumCardMenu(trip: Trip) {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    Alert.alert(trip.name, undefined, [
      { text: "Rename", onPress: () => startEdit(trip) },
      { text: "Delete", style: "destructive", onPress: () => deleteTrip(trip.id) },
      { text: "Cancel", style: "cancel" },
    ]);
  }

  function deleteStoryboard(id: string) {
    Alert.alert("Delete storyboard", "The photos stay in your albums.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          setStoryboards((prev) => prev.filter((s) => s.id !== id));
        },
      },
    ]);
  }

  function startEditStory(sb: Storyboard) {
    setEditingStoryId(sb.id);
    setEditingStoryName(sb.title);
  }

  function confirmEditStory() {
    if (!editingStoryId) return;
    const trimmed = editingStoryName.trim();
    if (trimmed) {
      setStoryboards((prev) =>
        prev.map((s) => (s.id === editingStoryId ? { ...s, title: trimmed } : s))
      );
    }
    setEditingStoryId(null);
    setEditingStoryName("");
  }

  function startCreateStoryboard() {
    setSbSourceTrip(null);
    setSbSelectedIds([]);
    setSbDraftPages([]);
    setSbTitle("");
    setScreen("sbPickAlbum");
  }

  function openStoryViewer(sb: Storyboard) {
    const pages = resolveStoryPages(sb, trips);
    if (pages.length === 0) {
      Alert.alert(
        "Nothing to show",
        "The photos for this storyboard are no longer in its source album."
      );
      return;
    }
    setActiveStory(sb);
    setStoryPageIdx(0);
    setScreen("sbViewer");
  }

  function toggleSbSelect(id: string) {
    Haptics.selectionAsync();
    setSbSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }

  // Selection order seeds the page order; album captions seed the story
  // captions. Both are freely editable on the arrange screen. Returning here
  // after tweaking the selection keeps existing pages (order and typed
  // captions intact), drops deselected ones, and appends new picks at the end.
  function beginArrange() {
    if (!sbSourceTrip) return;
    const byId = new Map(sbSourceTrip.photos.map((p) => [p.id, p]));
    setSbDraftPages((prev) => {
      const selected = new Set(sbSelectedIds);
      const kept = prev.filter((pg) => selected.has(pg.photoId));
      const keptIds = new Set(kept.map((pg) => pg.photoId));
      const added = sbSelectedIds
        .filter((id) => !keptIds.has(id))
        .map((photoId) => ({
          photoId,
          caption: byId.get(photoId)?.caption ?? "",
        }));
      return [...kept, ...added];
    });
    setScreen("sbArrange");
  }

  function moveDraftPage(index: number, dir: -1 | 1) {
    setSbDraftPages((prev) => {
      const j = index + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[j]] = [next[j], next[index]];
      return next;
    });
  }

  function setDraftCaption(index: number, text: string) {
    setSbDraftPages((prev) =>
      prev.map((pg, i) => (i === index ? { ...pg, caption: text } : pg))
    );
  }

  function removeDraftPage(index: number) {
    const removed = sbDraftPages[index];
    if (!removed) return;
    setSbDraftPages((prev) => prev.filter((_, i) => i !== index));
    setSbSelectedIds((prev) => prev.filter((id) => id !== removed.photoId));
  }

  function saveStoryboard() {
    if (!sbSourceTrip || sbDraftPages.length === 0) return;
    const sb: Storyboard = {
      id: Date.now().toString(),
      title: sbTitle.trim() || "Untitled story",
      sourceTripId: sbSourceTrip.id,
      pages: sbDraftPages.map((pg) => ({ ...pg, caption: pg.caption.trim() })),
      createdAt: Date.now(),
    };
    setStoryboards((prev) => [sb, ...prev]);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setSbSourceTrip(null);
    setSbSelectedIds([]);
    setSbDraftPages([]);
    setSbTitle("");
    setScreen("storybook");
  }

  function storyCardMenu(sb: Storyboard) {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    Alert.alert(sb.title, undefined, [
      { text: "Rename", onPress: () => startEditStory(sb) },
      { text: "Delete", style: "destructive", onPress: () => deleteStoryboard(sb.id) },
      { text: "Cancel", style: "cancel" },
    ]);
  }

  function goTab(tab: Tab) {
    if (tab !== screen) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    exitSelectMode();
    setScreen(tab);
  }

  async function zoomMap(delta: number) {
    const cam = await mapRef.current?.getCamera();
    if (!cam) return;
    if (cam.zoom != null && Number.isFinite(cam.zoom)) {
      cam.zoom += delta;
    } else if (cam.altitude != null && Number.isFinite(cam.altitude)) {
      cam.altitude *= delta > 0 ? 0.5 : 2;
    }
    mapRef.current?.animateCamera(cam, { duration: 300 });
  }

  const albumTrips = trips.filter(
    (t) => t.destination === "album" || t.destination === "both"
  );
  const mapTrips = trips.filter(
    (t) => t.destination === "map" || t.destination === "both"
  );

  // ---------- FULL-SCREEN SWIPEABLE VIEWER ----------
  if (viewerIndex !== null && viewerPhotos.length > 0) {
    return (
      <Animated.View style={styles.viewer} entering={SCREEN_FADE()}>
        <View style={styles.viewerHeader}>
          <Text style={styles.viewerAlbumName} numberOfLines={1}>
            {activeTrip?.name ?? ""}
          </Text>
          <Text style={styles.viewerCount}>
            {viewerIndex + 1} / {viewerPhotos.length}
          </Text>
        </View>

        <TouchableOpacity style={styles.viewerClose} onPress={closeViewer}>
          <MaterialIcons name="close" size={26} color="rgba(255,255,255,0.85)" />
        </TouchableOpacity>

        {viewerDeletable && activeTrip && (
          <TouchableOpacity style={styles.viewerTrash} onPress={deleteViewerPhoto}>
            <MaterialIcons name="delete-outline" size={24} color="rgba(255,255,255,0.85)" />
          </TouchableOpacity>
        )}

        <FlatList
          key={`viewer-${viewerPhotos.length}`}
          data={viewerPhotos}
          keyExtractor={(p) => p.id}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          initialScrollIndex={viewerIndex}
          getItemLayout={(_, index) => ({
            length: SCREEN_W,
            offset: SCREEN_W * index,
            index,
          })}
          onMomentumScrollEnd={onViewerScroll}
          renderItem={({ item }) => (
            <ViewerPage
              photo={item}
              onChangeCaption={(t) => saveCaptionTo(item.id, t)}
            />
          )}
        />
      </Animated.View>
    );
  }

  // ---------- WORLD MAP ----------
  if (screen === "globalmap") {
    const pinned = mapTrips.flatMap((trip) => {
      const centre = tripCentre(trip);
      return centre ? [{ trip, centre }] : [];
    });

    const selectedStops = selectedTrip ? clusterIntoStops(selectedTrip.photos) : [];
    const stopCoords = selectedStops.map((s) => ({ lat: s.lat, lon: s.lon }));
    const worldRegion =
      pinned.length > 0
        ? boundsForCoords(pinned.map((p) => p.centre), 0.3, 20)
        : null;

    return (
      <Animated.View style={styles.screen} entering={SCREEN_FADE()}>
        <TopAppBar />
        {/* Header row: breadcrumbs (or back-to-all-trips) + artifact badge */}
        <View style={styles.mapCrumbRow}>
          {selectedTrip ? (
            <TouchableOpacity
              style={styles.mapBackBtn}
              onPress={() => {
                setSelectedTrip(null);
                if (worldRegion) {
                  mapRef.current?.animateToRegion(worldRegion, 600);
                }
              }}
            >
              <MaterialIcons name="arrow-back" size={14} color={Atlas.color.primary} />
              <Text style={styles.mapBackBtnText}>All Trips</Text>
            </TouchableOpacity>
          ) : (
            <View style={styles.crumbs}>
              <Text style={styles.crumbMuted}>Albums</Text>
              <MaterialIcons
                name="chevron-right"
                size={16}
                color={Atlas.color.onSurfaceVariant}
              />
              <Text style={styles.crumbActive}>World Map</Text>
            </View>
          )}
          <View style={styles.artifactBadge}>
            <MaterialIcons name="map" size={14} color={Atlas.color.onSecondaryContainer} />
            <Text style={styles.artifactBadgeText} numberOfLines={1}>
              {selectedTrip ? `Route: ${selectedTrip.name}` : "All routes"}
            </Text>
          </View>
        </View>

          {/* Framed map */}
          <View style={styles.mapFrame}>
            {pinned.length === 0 ? (
              <EmptyState
                icon="public"
                message={"No map trips yet.\nCreate a trip and choose Map or Both."}
              />
            ) : (
              <>
                <MapView
                  ref={mapRef}
                  style={{ flex: 1 }}
                  mapType={Platform.OS === "ios" ? "mutedStandard" : "standard"}
                  initialRegion={
                    selectedTrip && selectedStops.length > 0
                      ? boundsForCoords(stopCoords)
                      : worldRegion!
                  }
                >
                  {pinned.map(({ trip, centre }) => {
                    if (selectedTrip && trip.id === selectedTrip.id) return null;
                    return (
                      <Marker
                        key={trip.id}
                        coordinate={{ latitude: centre.lat, longitude: centre.lon }}
                        onPress={() => {
                          const stops = clusterIntoStops(trip.photos);
                          const coords =
                            stops.length > 0
                              ? stops.map((s) => ({ lat: s.lat, lon: s.lon }))
                              : trip.photos
                                  .filter((p) => p.lat !== null && p.lon !== null)
                                  .map((p) => ({ lat: p.lat!, lon: p.lon! }));
                          setActiveTrip(trip);
                          setSelectedTrip(trip);
                          if (coords.length > 0) {
                            mapRef.current?.animateToRegion(
                              boundsForCoords(coords),
                              600
                            );
                          }
                        }}
                      >
                        <View style={styles.mapPin}>
                          <MaterialIcons
                            name="location-on"
                            size={34}
                            color={Atlas.color.error}
                          />
                          <Text style={styles.mapPinLabel} numberOfLines={1}>
                            {trip.name}
                          </Text>
                        </View>
                      </Marker>
                    );
                  })}

                  {selectedTrip && selectedStops.length > 0 && (
                    <>
                      <Polyline
                        coordinates={selectedStops.map((s) => ({
                          latitude: s.lat,
                          longitude: s.lon,
                        }))}
                        strokeColor={Atlas.color.error}
                        strokeWidth={2}
                        lineDashPattern={[5, 5]}
                      />
                      {selectedStops.map((s, i) => (
                        <Marker
                          key={"stop-" + s.id}
                          coordinate={{ latitude: s.lat, longitude: s.lon }}
                          title={"Stop " + (i + 1)}
                          description={plural(s.photos.length, "photo") + " · tap to view"}
                          onPress={() => {
                            setStopgridReturn("globalmap");
                            setActiveStop(s);
                            setScreen("stopgrid");
                          }}
                        >
                          <MaterialIcons
                            name="location-on"
                            size={30}
                            color={Atlas.color.error}
                          />
                        </Marker>
                      ))}
                    </>
                  )}
                </MapView>

                {/* Map controls */}
                <View style={styles.mapControls}>
                  <TouchableOpacity style={styles.mapCtrlBtn} onPress={() => zoomMap(-1)}>
                    <MaterialIcons name="remove" size={22} color={Atlas.color.primary} />
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.mapCtrlBtn, styles.mapCtrlBtnDark]}
                    onPress={() => {
                      if (selectedTrip && selectedStops.length > 0) {
                        mapRef.current?.animateToRegion(
                          boundsForCoords(stopCoords),
                          600
                        );
                      } else if (worldRegion) {
                        mapRef.current?.animateToRegion(worldRegion, 600);
                      }
                    }}
                  >
                    <MaterialIcons name="my-location" size={20} color={Atlas.color.onPrimary} />
                  </TouchableOpacity>
                </View>

              </>
            )}
          </View>
        <BottomNav active="globalmap" onNavigate={goTab} />
      </Animated.View>
    );
  }

  // ---------- STOP PHOTO GRID ----------
  if (screen === "stopgrid" && activeStop) {
    const stopIndex = activeTrip
      ? clusterIntoStops(activeTrip.photos).findIndex((s) => s.id === activeStop.id) + 1
      : 1;
    const stopIsEmpty = activeStop.photos.length === 0;
    return (
      <Animated.View style={styles.screen} entering={SCREEN_FADE()}>
        <SubHeader
          title={"Stop " + (stopIndex > 0 ? stopIndex : "?")}
          subtitle={plural(activeStop.photos.length, "photo")}
          onBack={() => {
            exitSelectMode();
            setScreen(stopgridReturn);
          }}
          backLabel="Map"
          rightAction={
            !stopIsEmpty && activeTrip ? (
              <SelectToggle
                selectMode={selectMode}
                onEnter={() => setSelectMode(true)}
                onExit={exitSelectMode}
              />
            ) : undefined
          }
        />
        {stopIsEmpty ? (
          <EmptyState message="No photos in this stop." />
        ) : (
          <PhotoGrid
            key="stopgrid-grid"
            photos={activeStop.photos}
            bottomPadding={selectMode ? 110 : 24}
            onPressCell={(photo, index) => {
              if (selectMode) {
                toggleGridSelect(photo.id);
              } else {
                openViewer(activeStop!.photos, index, !!activeTrip);
              }
            }}
            overlay={(photo) =>
              selectMode && <SelectOverlay selected={gridSelectedIds.has(photo.id)} />
            }
          />
        )}
        {selectMode && (
          <SelectBar
            count={gridSelectedIds.size}
            onCancel={exitSelectMode}
            onDelete={confirmDeleteSelected}
          />
        )}
      </Animated.View>
    );
  }

  // ---------- VIEW AN ALBUM (grid) ----------
  if (screen === "album" && activeTrip) {
    const isEmpty = activeTrip.photos.length === 0;
    return (
      <Animated.View style={styles.screen} entering={SCREEN_FADE()}>
        <SubHeader
          title={activeTrip.name}
          subtitle={plural(activeTrip.photos.length, "memory", "memories")}
          onBack={() => {
            exitSelectMode();
            setScreen("albums");
          }}
          backLabel="Albums"
          rightAction={
            !isEmpty ? (
              <SelectToggle
                selectMode={selectMode}
                onEnter={() => setSelectMode(true)}
                onExit={exitSelectMode}
              />
            ) : undefined
          }
        />
        {isEmpty ? (
          <EmptyState message="No photos in this album." />
        ) : (
          <PhotoGrid
            key="album-grid"
            photos={activeTrip.photos}
            onPressCell={(photo, index) => {
              if (selectMode) {
                toggleGridSelect(photo.id);
              } else {
                openViewer(activeTrip!.photos, index, true);
              }
            }}
            overlay={(photo) =>
              selectMode && <SelectOverlay selected={gridSelectedIds.has(photo.id)} />
            }
          />
        )}
        {!selectMode && (
          <PressableScale
            style={styles.primaryPill}
            scaleTo={0.95}
            haptic="light"
            onPress={() => openPicker(activeTrip!.id)}
            disabled={preparing}
          >
            {preparing ? (
              <ActivityIndicator color={Atlas.color.onPrimary} />
            ) : (
              <>
                <MaterialIcons
                  name="add-a-photo"
                  size={18}
                  color={Atlas.color.onPrimary}
                />
                <Text style={styles.primaryPillText}>Add Photos</Text>
              </>
            )}
          </PressableScale>
        )}
        {selectMode && (
          <SelectBar
            count={gridSelectedIds.size}
            onCancel={exitSelectMode}
            onDelete={confirmDeleteSelected}
          />
        )}
      </Animated.View>
    );
  }

  // ---------- NAME + DESTINATION ----------
  if (screen === "details") {
    return (
      <Animated.View style={styles.screen} entering={SCREEN_FADE()}>
        <SubHeader
          title="New Journal"
          onBack={() => {
            setPicked([]);
            setScreen("albums");
          }}
          backLabel="Albums"
        />
        <ScrollView contentContainerStyle={styles.detailsBody}>
          <Text style={styles.fieldLabel}>Trip name</Text>
          <TextInput
            style={styles.fieldInput}
            placeholder="e.g. Namibia Road Trip"
            placeholderTextColor={Atlas.color.outline}
            value={tripName}
            onChangeText={setTripName}
          />

          <Text style={[styles.fieldLabel, { marginTop: Atlas.space.stackLg }]}>
            Add this to...
          </Text>
          <View style={styles.choiceRow}>
            {DESTINATION_CHIPS.map(({ destination: d, label, rotate }) => {
              const isActive = destination === d;
              return (
                <TouchableOpacity
                  key={d}
                  style={[
                    styles.tapedChip,
                    { transform: [{ rotate }] },
                    isActive && styles.tapedChipActive,
                  ]}
                  onPress={() => setDestination(d)}
                >
                  <Text
                    style={[styles.tapedChipText, isActive && styles.tapedChipTextActive]}
                  >
                    {label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <Text style={styles.detailsNote}>
            {plural(picked.length, "photo")} selected
          </Text>

          <PressableScale
            style={[styles.primaryBtn, { marginTop: Atlas.space.stackMd }]}
            scaleTo={0.96}
            haptic="light"
            onPress={saveTrip}
            disabled={preparing}
          >
            {preparing ? (
              <ActivityIndicator color={Atlas.color.onPrimary} />
            ) : (
              <Text style={styles.primaryBtnText}>Save Trip</Text>
            )}
          </PressableScale>
        </ScrollView>
      </Animated.View>
    );
  }

  // ---------- STORYBOARD: PICK SOURCE ALBUM ----------
  if (screen === "sbPickAlbum") {
    const candidates = trips.filter((t) => t.photos.length > 0);
    return (
      <Animated.View style={styles.screen} entering={SCREEN_FADE()}>
        <SubHeader
          title="New Storyboard"
          subtitle="choose a source album"
          onBack={() => setScreen("storybook")}
          backLabel="Stories"
        />
        {candidates.length === 0 ? (
          <EmptyState
            icon="photo-library"
            message={"No albums with photos yet.\nCreate a trip first, then tell its story."}
          />
        ) : (
          <FlatList
            key="sb-album-list"
            data={candidates}
            keyExtractor={(t) => t.id}
            contentContainerStyle={styles.sbAlbumList}
            renderItem={({ item }) => (
              <TouchableOpacity
                style={styles.sbAlbumRow}
                activeOpacity={0.85}
                onPress={() => {
                  setSbSourceTrip(item);
                  setSbSelectedIds([]);
                  setScreen("sbPickPhotos");
                }}
              >
                <Image
                  source={{ uri: item.photos[0].uri }}
                  style={styles.sbAlbumThumb}
                  recyclingKey={item.id}
                  cachePolicy="memory-disk"
                  transition={PHOTO_FADE_MS}
                />
                <View style={{ flex: 1 }}>
                  <Text style={styles.sbAlbumName} numberOfLines={1}>
                    {item.name}
                  </Text>
                  <Text style={styles.sbAlbumCount}>
                    {plural(item.photos.length, "photo")}
                  </Text>
                </View>
                <MaterialIcons
                  name="chevron-right"
                  size={22}
                  color={Atlas.color.onSurfaceVariant}
                />
              </TouchableOpacity>
            )}
          />
        )}
      </Animated.View>
    );
  }

  // ---------- STORYBOARD: PICK PHOTOS (in story order) ----------
  if (screen === "sbPickPhotos" && sbSourceTrip) {
    return (
      <Animated.View style={styles.screen} entering={SCREEN_FADE()}>
        <SubHeader
          title={sbSourceTrip.name}
          subtitle="tap photos in story order"
          onBack={() => setScreen("sbPickAlbum")}
          backLabel="Albums"
        />
        <PhotoGrid
          key="sb-pick-grid"
          photos={sbSourceTrip.photos}
          onPressCell={(photo) => toggleSbSelect(photo.id)}
          overlay={(photo) => {
            const idx = sbSelectedIds.indexOf(photo.id);
            return (
              idx !== -1 && (
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>{idx + 1}</Text>
                </View>
              )
            );
          }}
        />
        {sbSelectedIds.length > 0 && (
          <PressableScale
            style={styles.primaryPill}
            scaleTo={0.95}
            haptic="light"
            onPress={beginArrange}
          >
            <Text style={styles.primaryPillText}>
              Next  ({sbSelectedIds.length})
            </Text>
          </PressableScale>
        )}
      </Animated.View>
    );
  }

  // ---------- STORYBOARD: ARRANGE PAGES + CAPTIONS + TITLE ----------
  if (screen === "sbArrange" && sbSourceTrip) {
    const byId = new Map(sbSourceTrip.photos.map((p) => [p.id, p]));
    return (
      <Animated.View style={styles.screen} entering={SCREEN_FADE()}>
        <SubHeader
          title="Arrange the Story"
          subtitle={plural(sbDraftPages.length, "page")}
          onBack={() => setScreen("sbPickPhotos")}
          backLabel="Photos"
        />
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <FlatList
            key="sb-arrange-list"
            data={sbDraftPages}
            keyExtractor={(pg) => pg.photoId}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.sbArrangeBody}
            ListHeaderComponent={
              <>
                <Text style={styles.fieldLabel}>Storyboard title</Text>
                <TextInput
                  style={styles.fieldInput}
                  placeholder="e.g. Our Croatia Road Trip"
                  placeholderTextColor={Atlas.color.outline}
                  value={sbTitle}
                  onChangeText={setSbTitle}
                />
                <Text style={[styles.fieldLabel, { marginTop: Atlas.space.stackLg }]}>
                  Pages — reorder & recount each moment
                </Text>
              </>
            }
            renderItem={({ item, index }) => {
              const photo = byId.get(item.photoId);
              if (!photo) return null;
              return (
                <View style={styles.sbPageRow}>
                  <Text style={styles.sbPageNum}>{index + 1}</Text>
                  <Image
                    source={{ uri: photo.uri }}
                    style={styles.sbPageThumb}
                    recyclingKey={photo.id}
                    cachePolicy="memory-disk"
                    transition={PHOTO_FADE_MS}
                  />
                  <TextInput
                    style={styles.sbCaptionInput}
                    placeholder="Tell this moment..."
                    placeholderTextColor={Atlas.color.outline}
                    value={item.caption}
                    onChangeText={(t) => setDraftCaption(index, t)}
                    multiline
                  />
                  <View style={styles.sbPageBtns}>
                    <TouchableOpacity
                      style={[styles.sbPageBtn, index === 0 && { opacity: 0.25 }]}
                      disabled={index === 0}
                      onPress={() => moveDraftPage(index, -1)}
                    >
                      <MaterialIcons
                        name="keyboard-arrow-up"
                        size={22}
                        color={Atlas.color.primary}
                      />
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.sbPageBtn}
                      onPress={() => removeDraftPage(index)}
                    >
                      <MaterialIcons
                        name="close"
                        size={16}
                        color={Atlas.color.error}
                      />
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[
                        styles.sbPageBtn,
                        index === sbDraftPages.length - 1 && { opacity: 0.25 },
                      ]}
                      disabled={index === sbDraftPages.length - 1}
                      onPress={() => moveDraftPage(index, 1)}
                    >
                      <MaterialIcons
                        name="keyboard-arrow-down"
                        size={22}
                        color={Atlas.color.primary}
                      />
                    </TouchableOpacity>
                  </View>
                </View>
              );
            }}
            ListFooterComponent={
              <PressableScale
                style={[
                  styles.primaryBtn,
                  { marginTop: Atlas.space.stackLg },
                  sbDraftPages.length === 0 && { opacity: 0.4 },
                ]}
                scaleTo={0.96}
                haptic="light"
                onPress={saveStoryboard}
                disabled={sbDraftPages.length === 0}
              >
                <Text style={styles.primaryBtnText}>Save Storyboard</Text>
              </PressableScale>
            }
          />
        </KeyboardAvoidingView>
      </Animated.View>
    );
  }

  // ---------- STORYBOARD PLAYBACK (manual page-flip) ----------
  if (screen === "sbViewer" && activeStory) {
    const pages = resolveStoryPages(activeStory, trips);
    const closeStory = () => {
      setActiveStory(null);
      setScreen("storybook");
    };

    if (pages.length === 0) {
      return (
        <View style={styles.screen}>
          <SubHeader
            title={activeStory.title}
            onBack={closeStory}
            backLabel="Stories"
          />
          <EmptyState
            icon="auto-stories"
            message="The photos for this storyboard are no longer in its source album."
          />
        </View>
      );
    }

    const idx = Math.min(storyPageIdx, pages.length - 1);
    const page = pages[idx];
    const goNext = () => {
      if (idx < pages.length - 1) Haptics.selectionAsync();
      setStoryPageIdx((i) => Math.min(i + 1, pages.length - 1));
    };
    const goPrev = () => {
      if (idx > 0) Haptics.selectionAsync();
      setStoryPageIdx((i) => Math.max(i - 1, 0));
    };

    const flingNext = Gesture.Fling()
      .direction(Directions.LEFT)
      .onStart(() => runOnJS(goNext)());
    const flingPrev = Gesture.Fling()
      .direction(Directions.RIGHT)
      .onStart(() => runOnJS(goPrev)());

    return (
      <Animated.View style={styles.screen} entering={SCREEN_FADE()}>
        {/* Progress segments + title + close */}
        <View style={styles.sbvTop}>
          <View style={styles.sbvProgressRow}>
            {pages.map((pg, i) => (
              <View
                key={pg.photo.id}
                style={[styles.sbvSeg, i <= idx && styles.sbvSegDone]}
              />
            ))}
          </View>
          <View style={styles.sbvTitleRow}>
            <Text style={styles.sbvTitle} numberOfLines={1}>
              {activeStory.title}
            </Text>
            <TouchableOpacity
              onPress={closeStory}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <MaterialIcons name="close" size={24} color={Atlas.color.onSurfaceVariant} />
            </TouchableOpacity>
          </View>
        </View>

        <GestureDetector gesture={Gesture.Race(flingNext, flingPrev)}>
          <View style={styles.sbvStage}>
            <Animated.View
              key={`story-page-${idx}`}
              style={styles.sbvPage}
              entering={storyPageEnter}
              exiting={FadeOut.duration(300)}
            >
              <View style={[styles.storyPhotoFrame, styles.sbvFrame]}>
                <View style={styles.photoTape} />
                <StoryPhoto uri={page.photo.uri} />
                {page.photo.date && (
                  <Text style={styles.sbvDateLine}>
                    {fmtStamp(page.photo.date)}
                  </Text>
                )}
              </View>
              {page.caption.trim() !== "" && (
                <Animated.View
                  entering={FadeInUp.delay(420).duration(550)}
                  style={styles.sbvCaptionWrap}
                >
                  <Text style={styles.sbvCaption}>{page.caption.trim()}</Text>
                </Animated.View>
              )}
            </Animated.View>

            {/* Manual paging only: left third = back, right two-thirds = forward */}
            <TouchableOpacity
              style={styles.sbvZoneLeft}
              onPress={goPrev}
              activeOpacity={1}
            />
            <TouchableOpacity
              style={styles.sbvZoneRight}
              onPress={goNext}
              activeOpacity={1}
            />
          </View>
        </GestureDetector>

        <View style={styles.sbvFooter}>
          <Text style={styles.sbvCount}>
            {idx + 1} / {pages.length}
          </Text>
        </View>
      </Animated.View>
    );
  }

  // ---------- STORYBOOK: CURATED STORYBOARD LIST ----------
  if (screen === "storybook") {
    const storyGridData: (Storyboard | { id: "__new__" })[] = [
      ...storyboards,
      { id: "__new__" },
    ];

    return (
      <Animated.View style={styles.screen} entering={SCREEN_FADE()}>
        <TopAppBar />
        <FlatList
          key="storybook-grid"
          data={storyGridData}
          keyExtractor={(s) => s.id}
          numColumns={2}
          columnWrapperStyle={styles.albumColumns}
          contentContainerStyle={styles.albumsBody}
          ListHeaderComponent={
            <View style={styles.albumsHeader}>
              <Text style={styles.eyebrow}>Stories Told By Hand</Text>
              <Text style={styles.albumsTitle} numberOfLines={1}>
                Storybook
              </Text>
              {storyboards.length > 0 ? (
                <Text style={styles.albumsStats}>
                  {plural(storyboards.length, "storyboard")}
                </Text>
              ) : (
                <Text style={styles.albumsStats}>
                  Curate photos from an album into a story you can flip through.
                </Text>
              )}
            </View>
          }
          renderItem={({ item, index }) => {
            if (item.id === "__new__") {
              return (
                <NewItemCard
                  label="Create Storyboard"
                  entering={cardEntering(index)}
                  onPress={startCreateStoryboard}
                />
              );
            }
            const sb = item as Storyboard;
            const pages = resolveStoryPages(sb, trips);
            const cover = pages[0]?.photo;
            const isEditing = editingStoryId === sb.id;
            return (
              <PressableScale
                style={styles.polaroidCard}
                entering={cardEntering(index)}
                rotate={CARD_ROTATIONS[index % CARD_ROTATIONS.length]}
                scaleTo={0.96}
                onPress={() => {
                  if (isEditing) return;
                  openStoryViewer(sb);
                }}
                onLongPress={() => storyCardMenu(sb)}
              >
                <View style={styles.polaroidPhotoWrap}>
                  {cover ? (
                    <Image
                      source={{ uri: cover.uri }}
                      style={styles.polaroidPhoto}
                      recyclingKey={cover.id}
                      cachePolicy="memory-disk"
                      transition={PHOTO_FADE_MS}
                    />
                  ) : (
                    <View style={[styles.polaroidPhoto, styles.polaroidPhotoEmpty]}>
                      <MaterialIcons
                        name="auto-stories"
                        size={28}
                        color={Atlas.color.outlineVariant}
                      />
                    </View>
                  )}
                </View>
                <View style={styles.polaroidMeta}>
                  {isEditing ? (
                    <TitleEditInput
                      value={editingStoryName}
                      onChangeText={setEditingStoryName}
                      onCommit={confirmEditStory}
                    />
                  ) : (
                    <Text style={styles.polaroidTitle} numberOfLines={2}>
                      {sb.title}
                    </Text>
                  )}
                  <Text style={styles.polaroidSub}>
                    {plural(pages.length, "page")}
                  </Text>
                </View>
              </PressableScale>
            );
          }}
        />
        <GrainOverlay />
        <BottomNav active="storybook" onNavigate={goTab} />
      </Animated.View>
    );
  }

  // ---------- ALBUMS (landing) ----------
  const albumGridData: (Trip | { id: "__new__" })[] = [
    ...albumTrips,
    { id: "__new__" },
  ];

  return (
    <Animated.View style={styles.screen} entering={SCREEN_FADE()}>
      <TopAppBar />
      <FlatList
        key="albums-grid"
        data={albumGridData}
        keyExtractor={(t) => t.id}
        numColumns={2}
        columnWrapperStyle={styles.albumColumns}
        contentContainerStyle={styles.albumsBody}
        ListHeaderComponent={
          <View style={styles.albumsHeader}>
            <Text style={styles.eyebrow}>Your Curated History</Text>
            <Text style={styles.albumsTitle} numberOfLines={1}>
              Albums & Archives
            </Text>
            {albumTrips.length > 0 && (
              <View style={styles.odoLine}>
                <Odometer value={albumTrips.length} />
                <Text style={styles.odoLabel}>
                  trip{albumTrips.length === 1 ? "" : "s"}
                </Text>
                <Odometer
                  value={albumTrips.reduce((n, t) => n + t.photos.length, 0)}
                />
                <Text style={styles.odoLabel}>memories</Text>
              </View>
            )}
          </View>
        }
        renderItem={({ item, index }) => {
          if (item.id === "__new__") {
            return (
              <NewItemCard
                label="New Journal"
                entering={cardEntering(index)}
                onPress={() => openPicker()}
              />
            );
          }
          const trip = item as Trip;
          const isEditing = editingTripId === trip.id;
          return (
            <PressableScale
              style={styles.polaroidCard}
              entering={cardEntering(index)}
              rotate={CARD_ROTATIONS[index % CARD_ROTATIONS.length]}
              scaleTo={0.96}
              onPress={() => {
                if (isEditing) return;
                setActiveTrip(trip);
                setScreen("album");
              }}
              onLongPress={() => albumCardMenu(trip)}
            >
              <View style={styles.polaroidPhotoWrap}>
                {trip.photos[0] ? (
                  <Image
                    source={{ uri: trip.photos[0].uri }}
                    style={styles.polaroidPhoto}
                    recyclingKey={trip.photos[0].id}
                    cachePolicy="memory-disk"
                    transition={PHOTO_FADE_MS}
                  />
                ) : (
                  <View style={[styles.polaroidPhoto, styles.polaroidPhotoEmpty]}>
                    <MaterialIcons
                      name="photo-library"
                      size={28}
                      color={Atlas.color.outlineVariant}
                    />
                  </View>
                )}
              </View>
              <Postmark date={trip.photos.find((p) => p.date)?.date ?? null} />
              <View style={styles.polaroidMeta}>
                {isEditing ? (
                  <TitleEditInput
                    value={editingName}
                    onChangeText={setEditingName}
                    onCommit={confirmEdit}
                  />
                ) : (
                  <Text style={styles.polaroidTitle} numberOfLines={2}>
                    {trip.name}
                  </Text>
                )}
                <Text style={styles.polaroidSub}>
                  {plural(trip.photos.length, "Memory", "Memories")}
                </Text>
              </View>
            </PressableScale>
          );
        }}
      />
      <GrainOverlay />
      <BottomNav active="albums" onNavigate={goTab} />
    </Animated.View>
  );
}

const C = Atlas.color;
const S = Atlas.space;
const R = Atlas.radius;
const T = Atlas.type;
const F = Atlas.font;

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.background },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: S.gutter,
  },
  emptyText: {
    ...T.labelMd,
    color: C.onSurfaceVariant,
    marginTop: S.stackSm + 4,
    textAlign: "center",
  },

  // ---- Top app bar ----
  appBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: 58,
    paddingBottom: S.stackSm,
    paddingHorizontal: S.marginMobile,
    backgroundColor: C.background,
  },
  appBarDivider: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
  },
  // Dashed hairline: RN needs equal border widths for dashed to render on
  // Android, so a 2px-bordered line is clipped to its top half.
  routeDividerClip: { height: 1, overflow: "hidden" },
  routeDividerLine: {
    height: 2,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: "rgba(0,0,0,0.18)",
  },
  appBarLeft: { flexDirection: "row", alignItems: "center", gap: 16 },
  appBarTitle: {
    ...T.headlineLgMobile,
    color: C.primary,
    letterSpacing: -0.5,
  },
  appBarAvatar: {
    width: 40,
    height: 40,
    borderRadius: R.full,
    backgroundColor: C.secondaryContainer,
    borderWidth: 1,
    borderColor: C.borderThin,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },

  // ---- Sub header (secondary screens) ----
  subHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: 58,
    paddingBottom: 12,
    paddingHorizontal: S.marginMobile,
    backgroundColor: C.background,
    borderBottomWidth: 1,
    borderBottomColor: C.borderThin,
  },
  subHeaderBack: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    minWidth: 76,
  },
  subHeaderBackText: {
    ...T.labelMd,
    color: C.onSurfaceVariant,
    textTransform: "uppercase",
  },
  subHeaderMiddle: { flex: 1, alignItems: "center" },
  subHeaderTitle: {
    fontFamily: F.sansSemiBold,
    fontSize: 17,
    color: C.primary,
  },
  subHeaderSub: {
    fontFamily: F.mono,
    fontSize: 11,
    letterSpacing: 1,
    color: C.onSurfaceVariant,
    textTransform: "uppercase",
    marginTop: 1,
  },
  subHeaderRight: { minWidth: 76, alignItems: "flex-end" },
  headerAction: { ...T.labelMd, color: C.primary },

  // ---- Bottom nav ----
  bottomNav: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    paddingTop: S.stackSm,
    paddingBottom: 30,
    paddingHorizontal: S.marginMobile,
    backgroundColor: "rgba(253,248,248,0.94)",
    borderTopWidth: 1,
    borderTopColor: C.borderFaint,
    shadowColor: "#000",
    shadowOpacity: 0.08,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: -3 },
    elevation: 10,
  },
  // Each item gets an equal flex slot so the bar is centered identically
  // on every screen regardless of label widths/weights.
  navStrip: { flex: 1, flexDirection: "row", alignItems: "center" },
  navItem: { flex: 1, alignItems: "center", justifyContent: "center" },
  navItemInner: { alignItems: "center" },
  navLabel: {
    ...T.labelMd,
    color: C.onSurfaceVariant,
    marginTop: 4,
  },
  navLabelActive: { fontFamily: F.monoBold, color: C.primary },

  // ---- Albums ----
  albumsBody: { paddingBottom: 180 },
  albumsHeader: {
    paddingHorizontal: S.marginMobile,
    paddingTop: S.stackMd + 8,
    paddingBottom: S.stackMd,
  },
  eyebrow: {
    ...T.labelMd,
    color: C.onSurfaceVariant,
    textTransform: "uppercase",
    letterSpacing: 2,
    marginBottom: S.unit,
  },
  albumsTitle: { ...T.headlineLgMobile, fontSize: 26, lineHeight: 31, color: C.primary },
  albumsStats: {
    fontFamily: F.monoItalic,
    fontSize: 12,
    letterSpacing: 0.6,
    color: C.onSurfaceVariant,
    marginTop: 6,
  },
  odoLine: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 8,
    gap: 6,
  },
  odoRow: { flexDirection: "row", gap: 2 },
  odoCell: {
    backgroundColor: "#33302C",
    borderRadius: 2,
    paddingHorizontal: 4,
    paddingVertical: 1,
    minWidth: 14,
    alignItems: "center",
  },
  odoDigit: {
    fontFamily: F.monoBold,
    fontSize: 12,
    lineHeight: 16,
    color: "#F3DFB6",
  },
  odoLabel: {
    fontFamily: F.monoItalic,
    fontSize: 11,
    letterSpacing: 0.6,
    color: C.onSurfaceVariant,
    marginRight: 8,
  },
  albumColumns: { paddingHorizontal: S.marginMobile, gap: 16 },
  polaroidCard: {
    flex: 1,
    backgroundColor: C.surfaceContainerLowest,
    padding: 16,
    borderWidth: 1,
    borderColor: C.borderThin,
    borderRadius: R.sm,
    marginBottom: 16,
    shadowColor: "#000",
    shadowOpacity: 0.05,
    shadowRadius: 2,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  polaroidPhotoWrap: { borderRadius: R.sm, overflow: "hidden" },
  polaroidPhoto: {
    width: "100%",
    aspectRatio: 4 / 5,
    backgroundColor: C.surfaceContainer,
  },
  polaroidPhotoEmpty: { alignItems: "center", justifyContent: "center" },
  polaroidMeta: { paddingTop: S.stackMd, paddingBottom: S.stackSm, alignItems: "center" },
  polaroidTitle: {
    ...T.journalEntry,
    fontSize: 16,
    lineHeight: 22,
    color: C.primary,
    textAlign: "center",
  },
  polaroidTitleInput: {
    fontFamily: F.mono,
    fontSize: 16,
    color: C.primary,
    textAlign: "center",
    borderBottomWidth: 1,
    borderBottomColor: C.primary,
    paddingVertical: 0,
    minWidth: 90,
  },
  polaroidSub: {
    fontFamily: F.monoItalic,
    fontSize: 12,
    letterSpacing: 0.6,
    color: "rgba(68,71,72,0.7)",
    marginTop: 4,
  },
  newJournalCard: {
    flex: 1,
    minHeight: 200,
    marginBottom: 16,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: C.borderDashed,
    borderRadius: R.sm,
    backgroundColor: "rgba(247,243,242,0.5)",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  newJournalPlus: {
    width: 40,
    height: 40,
    borderRadius: R.full,
    borderWidth: 1,
    borderColor: C.borderDashed,
    backgroundColor: "rgba(255,255,255,0.5)",
    alignItems: "center",
    justifyContent: "center",
  },
  newJournalText: {
    fontFamily: F.mono,
    fontSize: 10,
    letterSpacing: 2,
    textTransform: "uppercase",
    color: C.primary,
  },

  // ---- World map ----
  mapCrumbRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: S.marginMobile,
    paddingTop: 16,
    marginBottom: S.stackMd,
    gap: 12,
  },
  crumbs: { flexDirection: "row", alignItems: "center", gap: 4 },
  crumbMuted: { ...T.labelMd, color: C.onSurfaceVariant, opacity: 0.6 },
  crumbActive: { fontFamily: F.monoBold, fontSize: 14, letterSpacing: 0.7, color: C.primary },
  artifactBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexShrink: 1,
    backgroundColor: C.secondaryContainer,
    borderWidth: 1,
    borderColor: C.borderThin,
    borderRadius: R.sm,
    paddingHorizontal: 12,
    paddingVertical: 4,
    transform: [{ rotate: "-2deg" }],
    maxWidth: SCREEN_W - S.marginMobile * 2 - 140,
  },
  artifactBadgeText: {
    flexShrink: 1,
    fontFamily: F.mono,
    fontSize: 12,
    letterSpacing: 1.2,
    textTransform: "uppercase",
    color: C.onSecondaryContainer,
  },
  mapFrame: {
    flex: 1,
    marginHorizontal: S.marginMobile,
    marginBottom: 102,
    borderRadius: R.lg,
    overflow: "hidden",
    borderWidth: 1.5,
    borderStyle: "dashed",
    borderColor: C.borderDashed,
    backgroundColor: "rgba(232,226,214,0.4)",
  },
  mapPin: { alignItems: "center" },
  mapPinLabel: {
    fontFamily: F.mono,
    fontSize: 11,
    color: C.onSurface,
    backgroundColor: "rgba(253,248,248,0.9)",
    borderWidth: 1,
    borderColor: C.borderThin,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: R.sm,
    overflow: "hidden",
    maxWidth: 130,
    marginTop: 2,
  },
  mapControls: {
    position: "absolute",
    bottom: S.gutter,
    right: S.gutter,
    gap: 8,
  },
  mapCtrlBtn: {
    width: 48,
    height: 48,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(253,248,248,0.85)",
    borderWidth: 1,
    borderColor: C.borderThin,
    borderRadius: R.sm,
  },
  mapCtrlBtnDark: { backgroundColor: C.primary, marginTop: 8 },
  mapBackBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: C.surfaceContainerLowest,
    borderWidth: 1,
    borderColor: C.borderThin,
    borderRadius: R.sm,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  mapBackBtnText: {
    fontFamily: F.mono,
    fontSize: 13,
    letterSpacing: 1,
    textTransform: "uppercase",
    color: C.primary,
  },
  // ---- Storybook ----
  storyPhotoFrame: {
    backgroundColor: C.surfaceContainerLowest,
    borderWidth: 1,
    borderColor: C.borderThin,
    padding: 12,
    transform: [{ rotate: "3deg" }],
    marginTop: S.stackSm,
    marginBottom: S.stackMd,
    shadowColor: "#000",
    shadowOpacity: 0.06,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  photoTape: {
    position: "absolute",
    top: -10,
    alignSelf: "center",
    width: 60,
    height: 20,
    backgroundColor: "rgba(232,226,214,0.75)",
    borderWidth: 1,
    borderColor: C.borderFaint,
    transform: [{ rotate: "-2deg" }],
    zIndex: 5,
  },
  storyPhoto: {
    width: "100%",
    aspectRatio: 4 / 5,
    backgroundColor: C.surfaceContainer,
  },
  // ---- Storyboard playback viewer ----
  sbvTop: {
    paddingTop: 58,
    paddingHorizontal: S.marginMobile,
    backgroundColor: C.background,
  },
  sbvProgressRow: { flexDirection: "row", gap: 4 },
  sbvSeg: {
    flex: 1,
    height: 3,
    borderRadius: R.full,
    backgroundColor: C.surfaceContainerHighest,
  },
  sbvSegDone: { backgroundColor: C.primary },
  sbvTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingVertical: 10,
  },
  sbvTitle: {
    flex: 1,
    fontFamily: F.mono,
    fontSize: 12,
    letterSpacing: 1.5,
    textTransform: "uppercase",
    color: C.onSurfaceVariant,
  },
  sbvStage: { flex: 1 },
  sbvPage: {
    ...StyleSheet.absoluteFillObject,
    paddingHorizontal: S.gutter,
    paddingTop: S.stackMd,
  },
  sbvFrame: {
    transform: [{ rotate: "1.2deg" }],
    marginTop: S.stackMd,
  },
  sbvDateLine: {
    fontFamily: F.mono,
    fontSize: 11,
    letterSpacing: 1.5,
    textTransform: "uppercase",
    color: C.onSurfaceVariant,
    textAlign: "center",
    paddingTop: 10,
  },
  sbvCaptionWrap: { paddingHorizontal: S.stackSm, paddingTop: S.stackLg },
  sbvCaption: { ...T.journalEntry, color: C.onSurface, textAlign: "center" },
  sbvZoneLeft: { position: "absolute", left: 0, top: 0, bottom: 0, width: "33%" },
  sbvZoneRight: { position: "absolute", right: 0, top: 0, bottom: 0, width: "67%" },
  sbvFooter: { alignItems: "center", paddingTop: 8, paddingBottom: 34 },
  sbvCount: {
    fontFamily: F.monoItalic,
    fontSize: 12,
    letterSpacing: 1,
    color: C.onSurfaceVariant,
  },

  // ---- Grids / picker ----
  gridRow: { gap: GRID_GAP, marginBottom: GRID_GAP },
  gridThumb: {
    width: "100%",
    height: "100%",
    borderRadius: R.sm,
    backgroundColor: C.surfaceContainer,
  },
  pickCell: { width: CELL_SIZE, height: CELL_SIZE, position: "relative" },
  badge: {
    position: "absolute",
    top: 6,
    right: 6,
    backgroundColor: C.primary,
    width: 26,
    height: 26,
    borderRadius: R.full,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: C.surfaceContainerLowest,
  },
  badgeText: { fontFamily: F.monoBold, color: C.onPrimary, fontSize: 13 },

  // ---- Storyboard create flow ----
  sbAlbumList: { padding: S.marginMobile, gap: 12 },
  sbAlbumRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    backgroundColor: C.surfaceContainerLowest,
    borderWidth: 1,
    borderColor: C.borderThin,
    borderRadius: R.sm,
    padding: 12,
  },
  sbAlbumThumb: {
    width: 56,
    height: 56,
    borderRadius: R.sm,
    backgroundColor: C.surfaceContainer,
  },
  sbAlbumName: { fontFamily: F.sansSemiBold, fontSize: 16, color: C.primary },
  sbAlbumCount: {
    fontFamily: F.monoItalic,
    fontSize: 12,
    letterSpacing: 0.6,
    color: C.onSurfaceVariant,
    marginTop: 2,
  },
  sbArrangeBody: {
    paddingHorizontal: S.marginMobile,
    paddingTop: S.stackMd,
    paddingBottom: 60,
  },
  sbPageRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    backgroundColor: C.surfaceContainerLowest,
    borderWidth: 1,
    borderColor: C.borderThin,
    borderRadius: R.sm,
    padding: 10,
    marginBottom: 10,
  },
  sbPageNum: {
    fontFamily: F.monoBold,
    fontSize: 12,
    color: C.onSurfaceVariant,
    width: 18,
    textAlign: "center",
    paddingTop: 22,
  },
  sbPageThumb: {
    width: 64,
    height: 64,
    borderRadius: R.sm,
    backgroundColor: C.surfaceContainer,
  },
  sbCaptionInput: {
    flex: 1,
    minHeight: 64,
    fontFamily: F.mono,
    fontSize: 13,
    lineHeight: 18,
    color: C.onSurface,
    paddingTop: 4,
    paddingHorizontal: 4,
    textAlignVertical: "top",
  },
  sbPageBtns: { alignItems: "center", gap: 2 },
  sbPageBtn: {
    width: 28,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  selectCheck: {
    position: "absolute",
    top: 6,
    right: 6,
    width: 24,
    height: 24,
    borderRadius: R.full,
    backgroundColor: C.primary,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: C.surfaceContainerLowest,
  },
  selectCircle: {
    position: "absolute",
    top: 6,
    right: 6,
    width: 24,
    height: 24,
    borderRadius: R.full,
    borderWidth: 2,
    borderColor: "rgba(255,255,255,0.85)",
    backgroundColor: "rgba(0,0,0,0.15)",
  },

  // ---- Buttons ----
  primaryPill: {
    position: "absolute",
    bottom: S.gutter,
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: C.primary,
    paddingVertical: 16,
    paddingHorizontal: 36,
    borderRadius: R.default,
    shadowColor: "#000",
    shadowOpacity: 0.2,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
    elevation: 4,
  },
  primaryPillText: {
    fontFamily: F.sansBold,
    fontSize: 16,
    color: C.onPrimary,
  },
  primaryBtn: {
    backgroundColor: C.primary,
    paddingVertical: 16,
    borderRadius: R.default,
    alignItems: "center",
  },
  primaryBtnText: { fontFamily: F.sansBold, fontSize: 16, color: C.onPrimary },

  // ---- Details form ----
  detailsBody: { padding: S.marginMobile, paddingTop: S.stackLg },
  fieldLabel: {
    ...T.labelMd,
    color: C.onSurfaceVariant,
    textTransform: "uppercase",
    letterSpacing: 2,
    marginBottom: S.stackSm,
  },
  fieldInput: {
    fontFamily: F.mono,
    fontSize: 16,
    color: C.onSurface,
    borderBottomWidth: 1,
    borderBottomColor: C.primary,
    paddingVertical: 10,
    paddingHorizontal: 0,
  },
  choiceRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 16,
    paddingVertical: 4,
  },
  tapedChip: {
    backgroundColor: "rgba(232,226,214,0.5)",
    borderWidth: 1,
    borderColor: C.borderFaint,
    paddingHorizontal: 16,
    paddingVertical: 6,
    shadowColor: "#000",
    shadowOpacity: 0.05,
    shadowRadius: 1,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  tapedChipActive: { backgroundColor: C.primary, borderColor: C.primary },
  tapedChipText: {
    ...T.labelMd,
    color: C.onSecondaryContainer,
  },
  tapedChipTextActive: { color: C.onPrimary },
  detailsNote: {
    fontFamily: F.mono,
    fontSize: 13,
    letterSpacing: 0.6,
    color: C.onSurfaceVariant,
    textAlign: "center",
    marginTop: S.stackLg,
  },

  // ---- Select bar ----
  selectBar: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: S.marginMobile,
    paddingTop: 14,
    paddingBottom: 36,
    backgroundColor: "rgba(253,248,248,0.97)",
    borderTopWidth: 1,
    borderTopColor: C.borderThin,
  },
  selectBarCancel: { paddingVertical: 4 },
  selectBarCancelText: { ...T.labelMd, color: C.onSurfaceVariant },
  selectBarDelete: {
    backgroundColor: C.error,
    paddingVertical: 10,
    paddingHorizontal: 28,
    borderRadius: R.default,
  },
  selectBarDeleteDisabled: { backgroundColor: C.surfaceDim },
  selectBarDeleteText: {
    fontFamily: F.sansBold,
    fontSize: 15,
    color: C.onError,
  },

  // ---- Viewer ----
  viewer: { flex: 1, backgroundColor: "#000" },
  viewerHeader: {
    position: "absolute",
    top: 56,
    left: 0,
    right: 0,
    zIndex: 5,
    alignItems: "center",
  },
  viewerAlbumName: {
    fontFamily: F.sansSemiBold,
    color: "rgba(255,255,255,0.9)",
    fontSize: 15,
    maxWidth: "70%",
  },
  viewerCount: {
    fontFamily: F.mono,
    color: "rgba(255,255,255,0.5)",
    fontSize: 12,
    letterSpacing: 1,
    marginTop: 2,
  },
  viewerClose: {
    position: "absolute",
    top: 52,
    right: 20,
    zIndex: 10,
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  viewerPage: { width: SCREEN_W, flex: 1, paddingTop: 100, paddingBottom: 40 },
  viewerImageWrap: { flex: 1, justifyContent: "center" },
  viewerImage: { width: "100%", height: "100%" },
  captionZone: { height: 96, marginHorizontal: S.marginMobile, marginTop: S.stackSm },
  captionInput: {
    flex: 1,
    fontFamily: F.mono,
    color: "#fff",
    fontSize: 16,
    letterSpacing: 0.5,
    textAlign: "center",
    textShadowColor: "rgba(0,0,0,0.6)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  viewerTrash: {
    position: "absolute",
    top: 52,
    left: 20,
    zIndex: 10,
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
  },
});

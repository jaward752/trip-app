import { MaterialIcons } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as MediaLibrary from "expo-media-library";
import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  FlatList,
  Image,
  Keyboard,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import MapView, { Marker, Polyline } from "react-native-maps";

import { Atlas } from "@/constants/theme";

const LIBRARY_PAGE_SIZE = 120;
const SCREEN_W = Dimensions.get("window").width;
const STOP_RADIUS_KM = 5;
const STORAGE_KEY = "trips_v1";

// Photo grids: fixed-size cells (fractional flex + aspectRatio misbehaves
// in FlatList rows on RN 0.81, collapsing rows after the first).
const GRID_COLS = 4;
const GRID_GAP = 2;
const GRID_PADDING = 4;
const CELL_SIZE =
  (SCREEN_W - GRID_PADDING * 2 - GRID_GAP * (GRID_COLS - 1)) / GRID_COLS;

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
  asset?: MediaLibrary.Asset;
};

type Destination = "album" | "map" | "both";

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

function toNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function fmtDay(d: Date): string {
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

function fmtStamp(d: Date): string {
  return `${d.getDate()} ${MONTHS[d.getMonth()].toUpperCase()} ${d.getFullYear()}`;
}

function toRoman(n: number): string {
  const table: [number, string][] = [
    [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"],
  ];
  let out = "";
  for (const [v, s] of table) {
    while (n >= v) {
      out += s;
      n -= v;
    }
  }
  return out || "I";
}

// ---------- PERSISTENCE ----------

function serializeTrips(trips: Trip[]): string {
  const plain = trips.map((t) => ({
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
    // ignore write errors for now
  }
}

async function loadTripsFromStorage(): Promise<Trip[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const plain = JSON.parse(raw) as any[];

    const trips: Trip[] = [];
    for (const t of plain) {
      const photos: Photo[] = [];
      for (const p of t.photos) {
        let uri = "";
        try {
          const info = await MediaLibrary.getAssetInfoAsync(p.id);
          uri = info.localUri ?? info.uri ?? "";
        } catch {
          uri = "";
        }
        if (!uri) continue;
        photos.push({
          id: p.id,
          uri,
          date: p.date ? new Date(p.date) : null,
          lat: p.lat ?? null,
          lon: p.lon ?? null,
          caption: p.caption ?? "",
        });
      }
      trips.push({
        id: t.id,
        name: t.name,
        destination: t.destination,
        photos,
      });
    }
    return trips;
  } catch (e) {
    return [];
  }
}

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
    .sort((a, b) => {
      if (!a.date) return 1;
      if (!b.date) return -1;
      return a.date.getTime() - b.date.getTime();
    });

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

function groupPhotosByDay(photos: Photo[]): { key: string; date: Date | null; photos: Photo[] }[] {
  const dated = photos
    .filter((p) => p.date)
    .sort((a, b) => a.date!.getTime() - b.date!.getTime());
  const undated = photos.filter((p) => !p.date);

  const pages: { key: string; date: Date | null; photos: Photo[] }[] = [];
  for (const p of dated) {
    const key = p.date!.toDateString();
    const last = pages[pages.length - 1];
    if (last && last.key === key) last.photos.push(p);
    else pages.push({ key, date: p.date, photos: [p] });
  }
  if (undated.length > 0) {
    pages.push({ key: "undated", date: null, photos: undated });
  }
  return pages;
}

type Screen =
  | "albums"
  | "picker"
  | "details"
  | "album"
  | "globalmap"
  | "stopgrid"
  | "storybook";

type Tab = "albums" | "globalmap" | "storybook";

// ---------- SHARED CHROME ----------

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

function BottomNav({ active, onNavigate }: { active: Tab; onNavigate: (t: Tab) => void }) {
  const items: { tab: Tab; icon: keyof typeof MaterialIcons.glyphMap; label: string }[] = [
    { tab: "albums", icon: "photo-library", label: "Albums" },
    { tab: "globalmap", icon: "public", label: "World Map" },
    { tab: "storybook", icon: "auto-stories", label: "Storybook" },
  ];
  return (
    <View style={styles.bottomNav}>
      {items.map(({ tab, icon, label }) => {
        const isActive = tab === active;
        return (
          <TouchableOpacity
            key={tab}
            style={[styles.navItem, !isActive && { opacity: 0.6 }]}
            onPress={() => onNavigate(tab)}
          >
            <MaterialIcons
              name={icon}
              size={24}
              color={isActive ? Atlas.color.primary : Atlas.color.onSurfaceVariant}
            />
            <Text style={[styles.navLabel, isActive && styles.navLabelActive]}>{label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
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
          resizeMode="contain"
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

  const [trips, setTrips] = useState<Trip[]>([]);
  const [loadedFromStorage, setLoadedFromStorage] = useState(false);

  const [library, setLibrary] = useState<Photo[]>([]);
  const [loadingLib, setLoadingLib] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const libCursor = useRef<string | undefined>(undefined);
  const libHasMore = useRef(true);
  const loadingMoreLib = useRef(false);
  const [selected, setSelected] = useState<string[]>([]);
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
  const [addToTripId, setAddToTripId] = useState<string | null>(null);

  const [editingTripId, setEditingTripId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");

  const [storyTripId, setStoryTripId] = useState<string | null>(null);
  const [storyDay, setStoryDay] = useState(0);

  useEffect(() => {
    (async () => {
      const saved = await loadTripsFromStorage();
      setTrips(saved);
      setLoadedFromStorage(true);
    })();
  }, []);

  useEffect(() => {
    if (loadedFromStorage) {
      saveTripsToStorage(trips);
    }
  }, [trips, loadedFromStorage]);

  function assetsToPhotos(assets: MediaLibrary.Asset[]): Photo[] {
    return assets.map((asset) => ({
      id: asset.id,
      uri: asset.uri,
      date: asset.creationTime ? new Date(asset.creationTime) : null,
      lat: null,
      lon: null,
      caption: "",
      asset,
    }));
  }

  async function openPicker(addToId?: string) {
    setSelected([]);
    setAddToTripId(addToId ?? null);
    setScreen("picker");
    setLoadingLib(true);
    setLibrary([]);
    libCursor.current = undefined;
    libHasMore.current = true;

    const perm = await MediaLibrary.requestPermissionsAsync();
    if (!perm.granted) {
      setLoadingLib(false);
      alert("Photo access is needed.");
      setAddToTripId(null);
      setScreen(addToId ? "album" : "albums");
      return;
    }

    const page = await MediaLibrary.getAssetsAsync({
      mediaType: "photo",
      first: LIBRARY_PAGE_SIZE,
      sortBy: [["creationTime", false]],
    });
    libCursor.current = page.endCursor;
    libHasMore.current = page.hasNextPage;

    setLibrary(assetsToPhotos(page.assets));
    setLoadingLib(false);
  }

  async function loadMoreLibrary() {
    if (loadingLib || loadingMoreLib.current || !libHasMore.current) return;
    loadingMoreLib.current = true;
    setLoadingMore(true);
    try {
      const page = await MediaLibrary.getAssetsAsync({
        mediaType: "photo",
        first: LIBRARY_PAGE_SIZE,
        after: libCursor.current,
        sortBy: [["creationTime", false]],
      });
      libCursor.current = page.endCursor;
      libHasMore.current = page.hasNextPage;
      setLibrary((prev) => {
        const seen = new Set(prev.map((p) => p.id));
        const fresh = assetsToPhotos(page.assets.filter((a) => !seen.has(a.id)));
        return [...prev, ...fresh];
      });
    } catch {
      // leave the cursor as-is; the next end-reached event retries
    } finally {
      loadingMoreLib.current = false;
      setLoadingMore(false);
    }
  }

  function toggleSelect(id: string) {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }

  async function saveTrip() {
    setPreparing(true);

    const chosenBase = library.filter((p) => selected.includes(p.id));

    const enriched: Photo[] = [];
    for (const p of chosenBase) {
      try {
        const info = await MediaLibrary.getAssetInfoAsync(p.asset!, {
          shouldDownloadFromNetwork: true,
        });
        enriched.push({
          ...p,
          uri: info.localUri ?? p.uri,
          lat: toNum(info.location?.latitude),
          lon: toNum(info.location?.longitude),
          asset: undefined,
        });
      } catch {
        enriched.push({ ...p, asset: undefined });
      }
    }

    enriched.sort((a, b) => {
      if (!a.date) return 1;
      if (!b.date) return -1;
      return a.date.getTime() - b.date.getTime();
    });

    const trip: Trip = {
      id: Date.now().toString(),
      name: tripName.trim() || "Untitled trip",
      destination,
      photos: enriched,
    };

    setTrips((prev) => [trip, ...prev]);
    setTripName("");
    setDestination("album");
    setSelected([]);
    setPreparing(false);
    setScreen("albums");
  }

  async function appendPhotosToTrip() {
    if (!addToTripId) return;
    setPreparing(true);

    const targetTrip = trips.find((t) => t.id === addToTripId);
    if (!targetTrip) {
      setPreparing(false);
      setAddToTripId(null);
      setScreen("album");
      return;
    }

    const existingIds = new Set(targetTrip.photos.map((p) => p.id));
    const chosenBase = library.filter(
      (p) => selected.includes(p.id) && !existingIds.has(p.id)
    );

    const enriched: Photo[] = [];
    for (const p of chosenBase) {
      try {
        const info = await MediaLibrary.getAssetInfoAsync(p.asset!, {
          shouldDownloadFromNetwork: true,
        });
        enriched.push({
          ...p,
          uri: info.localUri ?? p.uri,
          lat: toNum(info.location?.latitude),
          lon: toNum(info.location?.longitude),
          asset: undefined,
        });
      } catch {
        enriched.push({ ...p, asset: undefined });
      }
    }

    const merged = [...targetTrip.photos, ...enriched].sort((a, b) => {
      if (!a.date) return 1;
      if (!b.date) return -1;
      return a.date.getTime() - b.date.getTime();
    });

    const updatedTrip = { ...targetTrip, photos: merged };
    setTrips((prev) => prev.map((t) => (t.id === addToTripId ? updatedTrip : t)));
    setActiveTrip(updatedTrip);

    setSelected([]);
    setPreparing(false);
    setAddToTripId(null);
    setScreen("album");
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

  function onViewerScroll(e: any) {
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

  function removePhotosFromAlbum(
    tripId: string,
    photoIds: string[],
    emptyReturnTo?: Screen
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
      setScreen(emptyReturnTo ?? emptyReturnScreen());
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
      `Remove ${ids.length} photo${ids.length === 1 ? "" : "s"}?`,
      "They will be removed from this trip but not deleted from your camera roll.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => {
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
        onPress: () => setTrips((prev) => prev.filter((t) => t.id !== id)),
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
    Alert.alert(trip.name, undefined, [
      { text: "Rename", onPress: () => startEdit(trip) },
      { text: "Delete", style: "destructive", onPress: () => deleteTrip(trip.id) },
      { text: "Cancel", style: "cancel" },
    ]);
  }

  function goTab(tab: Tab) {
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
      <View style={styles.viewer}>
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
      </View>
    );
  }

  // ---------- WORLD MAP ----------
  if (screen === "globalmap") {
    const pinned = mapTrips
      .map((t) => ({ trip: t, centre: tripCentre(t) }))
      .filter((x) => x.centre !== null) as {
      trip: Trip;
      centre: { lat: number; lon: number };
    }[];

    const selectedStops = selectedTrip ? clusterIntoStops(selectedTrip.photos) : [];
    const worldRegion =
      pinned.length > 0
        ? boundsForCoords(pinned.map((p) => p.centre), 0.3, 20)
        : null;

    return (
      <View style={styles.screen}>
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
              <View style={styles.mapEmpty}>
                <MaterialIcons name="public" size={36} color={Atlas.color.outline} />
                <Text style={styles.emptyText}>
                  No map trips yet.{"\n"}Create a trip and choose Map or Both.
                </Text>
              </View>
            ) : (
              <>
                <MapView
                  ref={mapRef}
                  style={{ flex: 1 }}
                  mapType={Platform.OS === "ios" ? "mutedStandard" : "standard"}
                  initialRegion={
                    selectedTrip && selectedStops.length > 0
                      ? boundsForCoords(
                          selectedStops.map((s) => ({ lat: s.lat, lon: s.lon }))
                        )
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
                          description={
                            s.photos.length +
                            " photo" +
                            (s.photos.length === 1 ? "" : "s") +
                            " · tap to view"
                          }
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
                          boundsForCoords(
                            selectedStops.map((s) => ({ lat: s.lat, lon: s.lon }))
                          ),
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
      </View>
    );
  }

  // ---------- STOP PHOTO GRID ----------
  if (screen === "stopgrid" && activeStop) {
    const stopIndex = activeTrip
      ? clusterIntoStops(activeTrip.photos).findIndex((s) => s.id === activeStop.id) + 1
      : 1;
    const stopIsEmpty = activeStop.photos.length === 0;
    return (
      <View style={styles.screen}>
        <SubHeader
          title={"Stop " + (stopIndex > 0 ? stopIndex : "?")}
          subtitle={
            activeStop.photos.length +
            " photo" +
            (activeStop.photos.length === 1 ? "" : "s")
          }
          onBack={() => {
            exitSelectMode();
            setScreen(stopgridReturn);
          }}
          backLabel="Map"
          rightAction={
            !stopIsEmpty && activeTrip ? (
              selectMode ? (
                <TouchableOpacity onPress={exitSelectMode}>
                  <Text style={styles.headerAction}>Cancel</Text>
                </TouchableOpacity>
              ) : (
                <TouchableOpacity onPress={() => setSelectMode(true)}>
                  <Text style={styles.headerAction}>Select</Text>
                </TouchableOpacity>
              )
            ) : undefined
          }
        />
        {stopIsEmpty ? (
          <View style={styles.center}>
            <Text style={styles.emptyText}>No photos in this stop.</Text>
          </View>
        ) : (
          <FlatList
            key="stopgrid-grid"
            data={activeStop.photos}
            keyExtractor={(p) => p.id}
            numColumns={GRID_COLS}
            columnWrapperStyle={styles.gridRow}
            contentContainerStyle={{
              padding: GRID_PADDING,
              paddingBottom: selectMode ? 110 : 24,
            }}
            renderItem={({ item, index }) => {
              const isSelected = gridSelectedIds.has(item.id);
              return (
                <TouchableOpacity
                  style={styles.pickCell}
                  onPress={() => {
                    if (selectMode) {
                      toggleGridSelect(item.id);
                    } else {
                      openViewer(activeStop!.photos, index, !!activeTrip);
                    }
                  }}
                  activeOpacity={0.85}
                >
                  <Image source={{ uri: item.uri }} style={styles.gridThumb} />
                  {selectMode &&
                    (isSelected ? (
                      <View style={styles.selectCheck}>
                        <MaterialIcons name="check" size={15} color={Atlas.color.onPrimary} />
                      </View>
                    ) : (
                      <View style={styles.selectCircle} />
                    ))}
                </TouchableOpacity>
              );
            }}
          />
        )}
        {selectMode && (
          <View style={styles.selectBar}>
            <TouchableOpacity onPress={exitSelectMode} style={styles.selectBarCancel}>
              <Text style={styles.selectBarCancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.selectBarDelete,
                gridSelectedIds.size === 0 && styles.selectBarDeleteDisabled,
              ]}
              onPress={confirmDeleteSelected}
              disabled={gridSelectedIds.size === 0}
            >
              <Text style={styles.selectBarDeleteText}>
                {gridSelectedIds.size > 0
                  ? `Delete (${gridSelectedIds.size})`
                  : "Delete"}
              </Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    );
  }

  // ---------- VIEW AN ALBUM (grid) ----------
  if (screen === "album" && activeTrip) {
    const isEmpty = activeTrip.photos.length === 0;
    return (
      <View style={styles.screen}>
        <SubHeader
          title={activeTrip.name}
          subtitle={
            activeTrip.photos.length +
            " memor" +
            (activeTrip.photos.length === 1 ? "y" : "ies")
          }
          onBack={() => {
            exitSelectMode();
            setScreen("albums");
          }}
          backLabel="Albums"
          rightAction={
            !isEmpty ? (
              selectMode ? (
                <TouchableOpacity onPress={exitSelectMode}>
                  <Text style={styles.headerAction}>Cancel</Text>
                </TouchableOpacity>
              ) : (
                <TouchableOpacity onPress={() => setSelectMode(true)}>
                  <Text style={styles.headerAction}>Select</Text>
                </TouchableOpacity>
              )
            ) : undefined
          }
        />
        {isEmpty ? (
          <View style={styles.center}>
            <Text style={styles.emptyText}>No photos in this album.</Text>
          </View>
        ) : (
          <FlatList
            key="album-grid"
            data={activeTrip.photos}
            keyExtractor={(p) => p.id}
            numColumns={GRID_COLS}
            columnWrapperStyle={styles.gridRow}
            contentContainerStyle={{ padding: GRID_PADDING, paddingBottom: 110 }}
            renderItem={({ item, index }) => {
              const isSelected = gridSelectedIds.has(item.id);
              return (
                <TouchableOpacity
                  style={styles.pickCell}
                  onPress={() => {
                    if (selectMode) {
                      toggleGridSelect(item.id);
                    } else {
                      openViewer(activeTrip!.photos, index, true);
                    }
                  }}
                  activeOpacity={0.85}
                >
                  <Image source={{ uri: item.uri }} style={styles.gridThumb} />
                  {selectMode &&
                    (isSelected ? (
                      <View style={styles.selectCheck}>
                        <MaterialIcons name="check" size={15} color={Atlas.color.onPrimary} />
                      </View>
                    ) : (
                      <View style={styles.selectCircle} />
                    ))}
                </TouchableOpacity>
              );
            }}
          />
        )}
        {!selectMode && (
          <TouchableOpacity
            style={styles.primaryPill}
            onPress={() => openPicker(activeTrip!.id)}
          >
            <MaterialIcons name="add-a-photo" size={18} color={Atlas.color.onPrimary} />
            <Text style={styles.primaryPillText}>Add Photos</Text>
          </TouchableOpacity>
        )}
        {selectMode && (
          <View style={styles.selectBar}>
            <TouchableOpacity onPress={exitSelectMode} style={styles.selectBarCancel}>
              <Text style={styles.selectBarCancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.selectBarDelete,
                gridSelectedIds.size === 0 && styles.selectBarDeleteDisabled,
              ]}
              onPress={confirmDeleteSelected}
              disabled={gridSelectedIds.size === 0}
            >
              <Text style={styles.selectBarDeleteText}>
                {gridSelectedIds.size > 0
                  ? `Delete (${gridSelectedIds.size})`
                  : "Delete"}
              </Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    );
  }

  // ---------- NAME + DESTINATION ----------
  if (screen === "details") {
    return (
      <View style={styles.screen}>
        <SubHeader
          title="New Journal"
          onBack={() => setScreen("picker")}
          backLabel="Photos"
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
            {(["album", "map", "both"] as Destination[]).map((d, i) => {
              const isActive = destination === d;
              return (
                <TouchableOpacity
                  key={d}
                  style={[
                    styles.tapedChip,
                    { transform: [{ rotate: ["-1deg", "2deg", "-1deg"][i] }] },
                    isActive && styles.tapedChipActive,
                  ]}
                  onPress={() => setDestination(d)}
                >
                  <Text
                    style={[styles.tapedChipText, isActive && styles.tapedChipTextActive]}
                  >
                    {d === "album" ? "#Album" : d === "map" ? "#Map" : "#Both"}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <Text style={styles.detailsNote}>
            {selected.length} photo{selected.length === 1 ? "" : "s"} selected
          </Text>

          <TouchableOpacity
            style={[styles.primaryBtn, { marginTop: Atlas.space.stackMd }]}
            onPress={saveTrip}
            disabled={preparing}
          >
            {preparing ? (
              <ActivityIndicator color={Atlas.color.onPrimary} />
            ) : (
              <Text style={styles.primaryBtnText}>Save Trip</Text>
            )}
          </TouchableOpacity>
        </ScrollView>
      </View>
    );
  }

  // ---------- PHOTO PICKER ----------
  if (screen === "picker") {
    return (
      <View style={styles.screen}>
        <SubHeader
          title={addToTripId ? "Add Photos" : "Select Photos"}
          onBack={() => {
            setAddToTripId(null);
            setSelected([]);
            setScreen(addToTripId ? "album" : "albums");
          }}
          backLabel={addToTripId ? "Album" : "Albums"}
        />
        {loadingLib ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={Atlas.color.primary} />
            <Text style={styles.emptyText}>Loading your photos...</Text>
          </View>
        ) : (
          <>
            <FlatList
              key="picker-grid"
              data={library}
              keyExtractor={(p) => p.id}
              numColumns={GRID_COLS}
              columnWrapperStyle={styles.gridRow}
              contentContainerStyle={{ padding: GRID_PADDING, paddingBottom: 110 }}
              onEndReached={loadMoreLibrary}
              onEndReachedThreshold={1}
              ListFooterComponent={
                loadingMore ? (
                  <ActivityIndicator
                    color={Atlas.color.primary}
                    style={{ paddingVertical: 20 }}
                  />
                ) : null
              }
              renderItem={({ item }) => {
                const idx = selected.indexOf(item.id);
                const isSel = idx !== -1;
                return (
                  <TouchableOpacity
                    style={styles.pickCell}
                    onPress={() => toggleSelect(item.id)}
                    activeOpacity={0.8}
                  >
                    <Image source={{ uri: item.uri }} style={styles.gridThumb} />
                    {isSel && (
                      <View style={styles.badge}>
                        <Text style={styles.badgeText}>{idx + 1}</Text>
                      </View>
                    )}
                  </TouchableOpacity>
                );
              }}
            />
            {selected.length > 0 && (
              <TouchableOpacity
                style={styles.primaryPill}
                onPress={addToTripId ? appendPhotosToTrip : () => setScreen("details")}
                disabled={preparing}
              >
                {preparing && addToTripId ? (
                  <ActivityIndicator color={Atlas.color.onPrimary} />
                ) : (
                  <Text style={styles.primaryPillText}>
                    {addToTripId
                      ? `Add  (${selected.length})`
                      : `Next  (${selected.length})`}
                  </Text>
                )}
              </TouchableOpacity>
            )}
          </>
        )}
      </View>
    );
  }

  // ---------- STORYBOOK ----------
  if (screen === "storybook") {
    const storyCandidates = trips.filter((t) => t.photos.length > 0);
    const storyTrip =
      storyCandidates.find((t) => t.id === storyTripId) ?? storyCandidates[0] ?? null;
    const pages = storyTrip ? groupPhotosByDay(storyTrip.photos) : [];
    const dayIdx = Math.min(storyDay, Math.max(pages.length - 1, 0));
    const page = pages[dayIdx];
    const chapterNum =
      storyTrip ? storyCandidates.findIndex((t) => t.id === storyTrip.id) + 1 : 1;
    const featured = page?.photos[0];
    const notes = page ? page.photos.filter((p) => p.caption.trim()) : [];
    const stops = storyTrip ? clusterIntoStops(storyTrip.photos) : [];

    return (
      <View style={styles.screen}>
        <TopAppBar />
        {!storyTrip ? (
          <View style={styles.center}>
            <MaterialIcons name="auto-stories" size={36} color={Atlas.color.outline} />
            <Text style={styles.emptyText}>
              No journals yet.{"\n"}Create a trip to begin your first chapter.
            </Text>
          </View>
        ) : (
          <ScrollView contentContainerStyle={styles.storyBody}>
            {/* Trip switcher chips */}
            {storyCandidates.length > 1 && (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.storyChipRow}
              >
                {storyCandidates.map((t, i) => {
                  const isActive = t.id === storyTrip.id;
                  return (
                    <TouchableOpacity
                      key={t.id}
                      style={[
                        styles.tapedChip,
                        { transform: [{ rotate: i % 2 === 0 ? "-1deg" : "2deg" }] },
                        isActive && styles.tapedChipActive,
                      ]}
                      onPress={() => {
                        setStoryTripId(t.id);
                        setStoryDay(0);
                      }}
                    >
                      <Text
                        style={[
                          styles.tapedChipText,
                          isActive && styles.tapedChipTextActive,
                        ]}
                        numberOfLines={1}
                      >
                        {t.name}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            )}

            {/* Journal page */}
            <View style={styles.storyPage}>
              {/* Passport stamp */}
              {page?.date && (
                <View style={styles.stamp}>
                  <View style={styles.stampInner}>
                    <Text style={styles.stampSmall}>Waypost</Text>
                    <Text style={styles.stampDate}>{fmtStamp(page.date)}</Text>
                    <Text style={styles.stampSmall} numberOfLines={1}>
                      {storyTrip.name}
                    </Text>
                  </View>
                </View>
              )}

              <Text style={styles.storyEyebrow}>
                Chapter {toRoman(chapterNum)}: {storyTrip.name}
              </Text>
              <Text style={styles.storyTitle}>
                {page?.date ? `Day ${dayIdx + 1}` : "Undated"}
              </Text>

              {/* Featured photo, taped in */}
              {featured && (
                <View style={styles.storyPhotoFrame}>
                  <View style={styles.photoTape} />
                  <TouchableOpacity
                    activeOpacity={0.9}
                    onPress={() => {
                      setActiveTrip(storyTrip);
                      openViewer(
                        storyTrip.photos,
                        storyTrip.photos.findIndex((p) => p.id === featured.id),
                        true
                      );
                    }}
                  >
                    <Image source={{ uri: featured.uri }} style={styles.storyPhoto} />
                  </TouchableOpacity>
                  <Text style={styles.storyPhotoCaption} numberOfLines={2}>
                    {featured.caption.trim() ||
                      (page?.date
                        ? `${fmtDay(page.date)}, ${storyTrip.name}`
                        : storyTrip.name)}
                  </Text>
                </View>
              )}

              {/* Journal entries */}
              <View style={styles.storyEntries}>
                {notes.length > 0 ? (
                  notes.map((p) => (
                    <Text key={p.id} style={styles.journalText}>
                      {p.caption.trim()}
                    </Text>
                  ))
                ) : (
                  <Text style={styles.journalTextMuted}>
                    No notes written for this day yet. Open a photo and add a
                    caption to fill this page.
                  </Text>
                )}
              </View>

              {/* Day photo strip */}
              {page && page.photos.length > 1 && (
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.storyStrip}
                >
                  {page.photos.map((p, i) => (
                    <TouchableOpacity
                      key={p.id}
                      style={[
                        styles.storyStripFrame,
                        { transform: [{ rotate: i % 2 === 0 ? "2deg" : "-2deg" }] },
                      ]}
                      onPress={() => {
                        setActiveTrip(storyTrip);
                        openViewer(
                          storyTrip.photos,
                          storyTrip.photos.findIndex((x) => x.id === p.id),
                          true
                        );
                      }}
                    >
                      <Image source={{ uri: p.uri }} style={styles.storyStripPhoto} />
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              )}

              {/* Prev / next footer */}
              <View style={styles.storyFooter}>
                <TouchableOpacity
                  style={[styles.storyNavBtn, dayIdx === 0 && { opacity: 0.3 }]}
                  disabled={dayIdx === 0}
                  onPress={() => setStoryDay(dayIdx - 1)}
                >
                  <MaterialIcons
                    name="arrow-back"
                    size={16}
                    color={Atlas.color.onSurfaceVariant}
                  />
                  <Text style={styles.storyNavText}>Previous Day</Text>
                </TouchableOpacity>
                {pages.length <= 8 ? (
                  <View style={styles.storyDots}>
                    {pages.map((pg, i) => (
                      <View
                        key={pg.key}
                        style={[
                          styles.storyDot,
                          i === dayIdx && styles.storyDotActive,
                        ]}
                      />
                    ))}
                  </View>
                ) : (
                  <Text style={styles.storyNavText}>
                    {dayIdx + 1} / {pages.length}
                  </Text>
                )}
                <TouchableOpacity
                  style={[
                    styles.storyNavBtn,
                    dayIdx >= pages.length - 1 && { opacity: 0.3 },
                  ]}
                  disabled={dayIdx >= pages.length - 1}
                  onPress={() => setStoryDay(dayIdx + 1)}
                >
                  <Text style={styles.storyNavText}>Next Day</Text>
                  <MaterialIcons
                    name="arrow-forward"
                    size={16}
                    color={Atlas.color.onSurfaceVariant}
                  />
                </TouchableOpacity>
              </View>
            </View>

            {/* Travel ephemera */}
            <View style={styles.ephemeraCard}>
              <MaterialIcons name="photo-camera" size={28} color={Atlas.color.secondary} />
              <View style={{ flex: 1 }}>
                <Text style={styles.ephemeraTitle}>Memories</Text>
                <Text style={styles.ephemeraValue}>
                  {storyTrip.photos.length} photo
                  {storyTrip.photos.length === 1 ? "" : "s"} archived on this trip
                </Text>
              </View>
            </View>
            <View style={styles.ephemeraCard}>
              <MaterialIcons name="place" size={28} color={Atlas.color.secondary} />
              <View style={{ flex: 1 }}>
                <Text style={styles.ephemeraTitle}>Journey</Text>
                <Text style={styles.ephemeraValue}>
                  {stops.length > 0
                    ? `${stops.length} stop${stops.length === 1 ? "" : "s"} pinned on the map`
                    : "No location data on this trip"}
                </Text>
              </View>
            </View>
          </ScrollView>
        )}
        <BottomNav active="storybook" onNavigate={goTab} />
      </View>
    );
  }

  // ---------- ALBUMS (landing) ----------
  const albumGridData: (Trip | { id: "__new__" })[] = [
    ...albumTrips,
    { id: "__new__" },
  ];

  return (
    <View style={styles.screen}>
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
              <Text style={styles.albumsStats}>
                {albumTrips.length} trip{albumTrips.length === 1 ? "" : "s"}
                {" · "}
                {albumTrips.reduce((n, t) => n + t.photos.length, 0)} memories
              </Text>
            )}
          </View>
        }
        renderItem={({ item, index }) => {
          if (item.id === "__new__") {
            return (
              <TouchableOpacity
                style={styles.newJournalCard}
                onPress={() => openPicker()}
                activeOpacity={0.8}
              >
                <View style={styles.newJournalPlus}>
                  <MaterialIcons name="add" size={22} color={Atlas.color.primary} />
                </View>
                <Text style={styles.newJournalText}>New Journal</Text>
              </TouchableOpacity>
            );
          }
          const trip = item as Trip;
          const isEditing = editingTripId === trip.id;
          return (
            <TouchableOpacity
              style={[
                styles.polaroidCard,
                { transform: [{ rotate: CARD_ROTATIONS[index % CARD_ROTATIONS.length] }] },
              ]}
              activeOpacity={0.85}
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
              <View style={styles.polaroidMeta}>
                {isEditing ? (
                  <TextInput
                    style={styles.polaroidTitleInput}
                    value={editingName}
                    onChangeText={setEditingName}
                    autoFocus
                    returnKeyType="done"
                    onSubmitEditing={confirmEdit}
                    onBlur={confirmEdit}
                  />
                ) : (
                  <Text style={styles.polaroidTitle} numberOfLines={2}>
                    {trip.name}
                  </Text>
                )}
                <Text style={styles.polaroidSub}>
                  {trip.photos.length} Memor{trip.photos.length === 1 ? "y" : "ies"}
                </Text>
              </View>
              {trip.destination === "both" && (
                <View style={styles.artifactStamp}>
                  <Text style={styles.artifactStampText}>On Map</Text>
                </View>
              )}
            </TouchableOpacity>
          );
        }}
      />
      <BottomNav active="albums" onNavigate={goTab} />
    </View>
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
    borderBottomWidth: 1,
    borderBottomColor: C.borderThin,
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
  navItem: { flex: 1, alignItems: "center", justifyContent: "center" },
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
  artifactStamp: {
    position: "absolute",
    top: 8,
    right: 8,
    backgroundColor: "rgba(232,226,214,0.65)",
    borderWidth: 1.5,
    borderColor: C.borderThin,
    borderRadius: R.sm,
    paddingHorizontal: 8,
    paddingVertical: 2,
    transform: [{ rotate: "12deg" }],
  },
  artifactStampText: {
    fontFamily: F.mono,
    fontSize: 9,
    letterSpacing: 1,
    textTransform: "uppercase",
    color: C.onSecondaryContainer,
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
    borderWidth: 1,
    borderColor: C.borderThin,
    backgroundColor: "rgba(232,226,214,0.4)",
  },
  mapEmpty: { flex: 1, alignItems: "center", justifyContent: "center", padding: S.gutter },
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
  storyBody: {
    paddingHorizontal: S.marginMobile,
    paddingTop: S.stackMd,
    paddingBottom: 150,
  },
  storyChipRow: { gap: 12, paddingBottom: S.stackMd, paddingHorizontal: 2 },
  storyPage: {
    backgroundColor: "rgba(255,255,255,0.55)",
    borderWidth: 1,
    borderColor: C.borderFaint,
    borderRadius: R.sm,
    padding: S.gutter,
    shadowColor: "#000",
    shadowOpacity: 0.05,
    shadowRadius: 2,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  stamp: {
    position: "absolute",
    top: 12,
    right: 12,
    width: 108,
    height: 108,
    borderRadius: R.full,
    borderWidth: 2,
    borderColor: "rgba(186,26,26,0.4)",
    alignItems: "center",
    justifyContent: "center",
    transform: [{ rotate: "-12deg" }],
    zIndex: 10,
    opacity: 0.8,
  },
  stampInner: {
    width: 96,
    height: 96,
    borderRadius: R.full,
    borderWidth: 1,
    borderColor: "rgba(186,26,26,0.4)",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 6,
  },
  stampSmall: {
    fontFamily: F.mono,
    fontSize: 8,
    letterSpacing: 1.6,
    textTransform: "uppercase",
    color: "rgba(186,26,26,0.6)",
    textAlign: "center",
  },
  stampDate: {
    fontFamily: F.monoBold,
    fontSize: 13,
    color: "rgba(186,26,26,0.6)",
    marginVertical: 2,
    textAlign: "center",
  },
  storyEyebrow: {
    ...T.labelMd,
    color: C.onSurfaceVariant,
    textTransform: "uppercase",
    letterSpacing: 2,
    marginBottom: S.unit,
    paddingRight: 110,
  },
  storyTitle: {
    fontFamily: F.sansBoldItalic,
    fontSize: 42,
    lineHeight: 46,
    letterSpacing: -0.8,
    color: C.primary,
    marginBottom: S.stackMd,
    paddingRight: 100,
  },
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
  storyPhotoCaption: {
    fontFamily: F.monoItalic,
    fontSize: 13,
    lineHeight: 18,
    color: C.onSurfaceVariant,
    textAlign: "center",
    paddingTop: 12,
    paddingBottom: 4,
  },
  storyEntries: { gap: 16, marginBottom: S.stackMd },
  journalText: { ...T.journalEntry, color: C.onSurface },
  journalTextMuted: {
    ...T.journalEntry,
    fontSize: 15,
    lineHeight: 25,
    color: C.onSurfaceVariant,
  },
  storyStrip: { gap: 12, paddingVertical: 4, marginBottom: S.stackSm },
  storyStripFrame: {
    backgroundColor: C.surfaceContainerLowest,
    borderWidth: 1,
    borderColor: C.borderThin,
    padding: 5,
  },
  storyStripPhoto: { width: 84, height: 84, backgroundColor: C.surfaceContainer },
  storyFooter: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderTopWidth: 1,
    borderTopColor: C.borderFaint,
    paddingTop: S.stackMd,
    marginTop: S.stackSm,
  },
  storyNavBtn: { flexDirection: "row", alignItems: "center", gap: 6 },
  storyNavText: { ...T.labelMd, color: C.onSurfaceVariant },
  storyDots: { flexDirection: "row", gap: 8 },
  storyDot: {
    width: 8,
    height: 8,
    borderRadius: R.full,
    backgroundColor: C.surfaceContainerHighest,
  },
  storyDotActive: { backgroundColor: C.primaryContainer },
  ephemeraCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    backgroundColor: C.surfaceContainerLow,
    borderWidth: 1,
    borderColor: C.borderFaint,
    borderRadius: R.sm,
    padding: S.marginMobile,
    marginTop: S.gutter,
  },
  ephemeraTitle: {
    fontFamily: F.sansSemiBold,
    fontSize: 12,
    letterSpacing: 2,
    textTransform: "uppercase",
    color: C.primary,
  },
  ephemeraValue: {
    fontFamily: F.mono,
    fontSize: 13,
    lineHeight: 19,
    color: C.onSurface,
    marginTop: 2,
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

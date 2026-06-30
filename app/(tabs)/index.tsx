import AsyncStorage from "@react-native-async-storage/async-storage";
import * as MediaLibrary from "expo-media-library";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  FlatList,
  Image,
  Keyboard,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import MapView, { Marker, Polyline } from "react-native-maps";

const PHOTOS_TO_SHOW = 300;
const SCREEN_W = Dimensions.get("window").width;
const STOP_RADIUS_KM = 5;
const STORAGE_KEY = "trips_v1";

type Photo = {
  id: string;
  uri: string;
  date: Date | null;
  lat: number | null;
  lon: number | null;
  caption: string;
  asset?: MediaLibrary.Asset; // optional: only present for freshly-picked photos
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

// ---------- PERSISTENCE ----------

// Turn trips into a lightweight JSON-safe form (no image uri, no asset, dates as numbers).
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

// Load trips and re-fetch each photo's current image uri from the library by ID.
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
          uri = ""; // photo may have been deleted from the library
        }
        if (!uri) continue; // skip photos that no longer exist
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

type Screen =
  | "home"
  | "albums"
  | "picker"
  | "details"
  | "album"
  | "route"
  | "globalmap"
  | "tripmap";

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
          placeholder="Add a caption…"
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
  const [screen, setScreen] = useState<Screen>("home");

  const [trips, setTrips] = useState<Trip[]>([]);
  const [loadedFromStorage, setLoadedFromStorage] = useState(false);

  const [library, setLibrary] = useState<Photo[]>([]);
  const [loadingLib, setLoadingLib] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [preparing, setPreparing] = useState(false);

  const [tripName, setTripName] = useState("");
  const [destination, setDestination] = useState<Destination>("album");

  const [activeTrip, setActiveTrip] = useState<Trip | null>(null);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);

  const [editingTripId, setEditingTripId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");

  // Load saved trips once, on first mount.
  useEffect(() => {
    (async () => {
      const saved = await loadTripsFromStorage();
      setTrips(saved);
      setLoadedFromStorage(true);
    })();
  }, []);

  // Save whenever trips change — but only after the initial load, so we don't
  // overwrite storage with an empty list before loading finishes.
  useEffect(() => {
    if (loadedFromStorage) {
      saveTripsToStorage(trips);
    }
  }, [trips, loadedFromStorage]);

  async function openPicker() {
    setSelected([]);
    setScreen("picker");
    setLoadingLib(true);

    const perm = await MediaLibrary.requestPermissionsAsync();
    if (!perm.granted) {
      setLoadingLib(false);
      alert("Photo access is needed to build a trip.");
      setScreen("albums");
      return;
    }

    const collected: MediaLibrary.Asset[] = [];
    let after: string | undefined = undefined;
    let hasNext = true;
    while (hasNext && collected.length < PHOTOS_TO_SHOW) {
      const page = await MediaLibrary.getAssetsAsync({
        mediaType: "photo",
        first: 100,
        after,
        sortBy: [["creationTime", false]],
      });
      collected.push(...page.assets);
      after = page.endCursor;
      hasNext = page.hasNextPage;
    }

    const photos: Photo[] = collected.map((asset) => ({
      id: asset.id,
      uri: asset.uri,
      date: asset.creationTime ? new Date(asset.creationTime) : null,
      lat: null,
      lon: null,
      caption: "",
      asset,
    }));

    setLibrary(photos);
    setLoadingLib(false);
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

  function saveCaptionTo(index: number, text: string) {
    setActiveTrip((prev) => {
      if (!prev) return prev;
      const updatedPhotos = prev.photos.map((p, i) =>
        i === index ? { ...p, caption: text } : p
      );
      const updatedTrip = { ...prev, photos: updatedPhotos };
      setTrips((all) =>
        all.map((t) => (t.id === updatedTrip.id ? updatedTrip : t))
      );
      return updatedTrip;
    });
  }

  function openViewer(index: number) {
    if (!activeTrip) return;
    setViewerIndex(index);
  }

  function closeViewer() {
    Keyboard.dismiss();
    setViewerIndex(null);
  }

  function onViewerScroll(e: any) {
    const newIndex = Math.round(e.nativeEvent.contentOffset.x / SCREEN_W);
    if (newIndex !== viewerIndex) {
      Keyboard.dismiss();
      setViewerIndex(newIndex);
    }
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

  const albumTrips = trips.filter(
    (t) => t.destination === "album" || t.destination === "both"
  );
  const mapTrips = trips.filter(
    (t) => t.destination === "map" || t.destination === "both"
  );

  // ---------- GLOBAL MAP ----------
  if (screen === "globalmap") {
    const pinned = mapTrips
      .map((t) => ({ trip: t, centre: tripCentre(t) }))
      .filter((x) => x.centre !== null) as {
      trip: Trip;
      centre: { lat: number; lon: number };
    }[];

    return (
      <View style={styles.screen}>
        <Header
          title="Global Map"
          onBack={() => setScreen("home")}
          backLabel="Home"
        />
        {pinned.length === 0 ? (
          <View style={styles.center}>
            <Text style={styles.muted}>
              No map trips yet. Create a trip and choose “Map” or “Both”.
            </Text>
          </View>
        ) : (
          <MapView
            style={{ flex: 1 }}
            initialRegion={{
              latitude: pinned[0].centre.lat,
              longitude: pinned[0].centre.lon,
              latitudeDelta: 60,
              longitudeDelta: 60,
            }}
          >
            {pinned.map(({ trip, centre }) => (
              <Marker
                key={trip.id}
                coordinate={{ latitude: centre.lat, longitude: centre.lon }}
                title={trip.name}
                description={`${trip.photos.length} photos`}
                onCalloutPress={() => {
                  setActiveTrip(trip);
                  setScreen("tripmap");
                }}
              />
            ))}
          </MapView>
        )}
      </View>
    );
  }

  // ---------- TRIP MAP ----------
  if (screen === "tripmap" && activeTrip) {
    const stops = clusterIntoStops(activeTrip.photos);

    if (stops.length === 0) {
      return (
        <View style={styles.screen}>
          <Header
            title={activeTrip.name}
            onBack={() => setScreen("globalmap")}
            backLabel="Map"
          />
          <View style={styles.center}>
            <Text style={styles.muted}>No location data on this trip.</Text>
          </View>
        </View>
      );
    }

    return (
      <View style={styles.screen}>
        <Header
          title={activeTrip.name}
          onBack={() => setScreen("globalmap")}
          backLabel="Map"
        />
        <MapView
          style={{ flex: 1 }}
          initialRegion={{
            latitude: stops[0].lat,
            longitude: stops[0].lon,
            latitudeDelta: 0.5,
            longitudeDelta: 0.5,
          }}
        >
          <Polyline
            coordinates={stops.map((s) => ({
              latitude: s.lat,
              longitude: s.lon,
            }))}
            strokeColor="#8b3a2f"
            strokeWidth={3}
          />
          {stops.map((s, i) => (
            <Marker
              key={s.id}
              coordinate={{ latitude: s.lat, longitude: s.lon }}
              title={`Stop ${i + 1}`}
              description={`${s.photos.length} photos`}
            />
          ))}
        </MapView>
      </View>
    );
  }

  // ---------- FULL-SCREEN SWIPEABLE VIEWER ----------
  if (screen === "album" && activeTrip && viewerIndex !== null) {
    return (
      <View style={styles.viewer}>
        <View style={styles.viewerHeader}>
          <Text style={styles.viewerAlbumName} numberOfLines={1}>
            {activeTrip.name}
          </Text>
          <Text style={styles.viewerCount}>
            {viewerIndex + 1} / {activeTrip.photos.length}
          </Text>
        </View>

        <TouchableOpacity style={styles.viewerClose} onPress={closeViewer}>
          <Text style={styles.viewerCloseText}>✕</Text>
        </TouchableOpacity>

        <FlatList
          data={activeTrip.photos}
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
          renderItem={({ item, index }) => (
            <ViewerPage
              photo={item}
              onChangeCaption={(t) => saveCaptionTo(index, t)}
            />
          )}
        />
      </View>
    );
  }

  // ---------- ROUTE / STOPS (list) ----------
  if (screen === "route" && activeTrip) {
    const stops = clusterIntoStops(activeTrip.photos);
    return (
      <View style={styles.screen}>
        <Header
          title={`${activeTrip.name} · Route`}
          onBack={() => setScreen("album")}
          backLabel="Album"
        />
        {stops.length === 0 ? (
          <View style={styles.center}>
            <Text style={styles.muted}>No location data on these photos.</Text>
          </View>
        ) : (
          <FlatList
            key="route-list"
            data={stops}
            keyExtractor={(s) => s.id}
            contentContainerStyle={{ padding: 12 }}
            renderItem={({ item, index }) => (
              <View style={styles.stopCard}>
                <View style={styles.stopNumber}>
                  <Text style={styles.stopNumberText}>{index + 1}</Text>
                </View>
                <Image
                  source={{ uri: item.photos[0].uri }}
                  style={styles.stopCover}
                />
                <View style={styles.stopMeta}>
                  <Text style={styles.stopName}>
                    {item.placeName ?? "Locating…"}
                  </Text>
                  <Text style={styles.stopSub}>
                    {item.photos.length} photo
                    {item.photos.length === 1 ? "" : "s"}
                    {"  ·  "}
                    {item.lat.toFixed(3)}, {item.lon.toFixed(3)}
                  </Text>
                </View>
              </View>
            )}
          />
        )}
      </View>
    );
  }

  // ---------- VIEW AN ALBUM (grid) ----------
  if (screen === "album" && activeTrip) {
    return (
      <View style={styles.screen}>
        <Header
          title={activeTrip.name}
          onBack={() => setScreen("albums")}
          backLabel="Albums"
        />
        <FlatList
          key="album-grid"
          data={activeTrip.photos}
          keyExtractor={(p) => p.id}
          numColumns={3}
          contentContainerStyle={{ padding: 4, paddingBottom: 90 }}
          renderItem={({ item, index }) => (
            <TouchableOpacity
              style={styles.pickCell}
              onPress={() => openViewer(index)}
              activeOpacity={0.85}
            >
              <Image source={{ uri: item.uri }} style={styles.gridThumb} />
            </TouchableOpacity>
          )}
        />
        <TouchableOpacity
          style={styles.floatingBtn}
          onPress={() => setScreen("route")}
        >
          <Text style={styles.primaryBtnText}>🗺️  View Route</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ---------- NAME + DESTINATION ----------
  if (screen === "details") {
    return (
      <View style={styles.screen}>
        <Header
          title="New Trip"
          onBack={() => setScreen("picker")}
          backLabel="Photos"
        />
        <View style={{ padding: 20 }}>
          <Text style={styles.label}>Trip name</Text>
          <TextInput
            style={styles.input}
            placeholder="e.g. Namibia Road Trip"
            placeholderTextColor="#bbb"
            value={tripName}
            onChangeText={setTripName}
          />

          <Text style={[styles.label, { marginTop: 24 }]}>Add this to…</Text>
          {(["album", "map", "both"] as Destination[]).map((d) => (
            <TouchableOpacity
              key={d}
              style={[styles.choice, destination === d && styles.choiceActive]}
              onPress={() => setDestination(d)}
            >
              <Text
                style={[
                  styles.choiceText,
                  destination === d && styles.choiceTextActive,
                ]}
              >
                {d === "album"
                  ? "📔  Album only"
                  : d === "map"
                  ? "🌍  Map only"
                  : "📔🌍  Both"}
              </Text>
            </TouchableOpacity>
          ))}

          <Text style={styles.note}>
            {selected.length} photo{selected.length === 1 ? "" : "s"} selected
          </Text>

          <TouchableOpacity
            style={[styles.primaryBtn, { marginTop: 24 }]}
            onPress={saveTrip}
            disabled={preparing}
          >
            {preparing ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.primaryBtnText}>Save Trip</Text>
            )}
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // ---------- PHOTO PICKER ----------
  if (screen === "picker") {
    return (
      <View style={styles.screen}>
        <Header
          title="Select Photos"
          onBack={() => setScreen("albums")}
          backLabel="Albums"
        />
        {loadingLib ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color="#8b3a2f" />
            <Text style={styles.muted}>Loading your photos…</Text>
          </View>
        ) : (
          <>
            <FlatList
              key="picker-grid"
              data={library}
              keyExtractor={(p) => p.id}
              numColumns={3}
              contentContainerStyle={{ padding: 4, paddingBottom: 90 }}
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
                style={styles.floatingBtn}
                onPress={() => setScreen("details")}
              >
                <Text style={styles.primaryBtnText}>
                  Next  ({selected.length})
                </Text>
              </TouchableOpacity>
            )}
          </>
        )}
      </View>
    );
  }

  // ---------- ALBUMS LIST ----------
  if (screen === "albums") {
    return (
      <View style={styles.screen}>
        <Header
          title="Your Albums"
          onBack={() => setScreen("home")}
          backLabel="Back"
        />
        {albumTrips.length === 0 ? (
          <View style={styles.center}>
            <Text style={styles.muted}>No albums yet.</Text>
          </View>
        ) : (
          <FlatList
            key="albums-list"
            data={albumTrips}
            keyExtractor={(t) => t.id}
            contentContainerStyle={{ padding: 12, paddingBottom: 90 }}
            renderItem={({ item }) => {
              const isEditing = editingTripId === item.id;
              return (
                <TouchableOpacity
                  style={styles.tripCard}
                  activeOpacity={0.85}
                  onPress={() => {
                    if (isEditing) return;
                    setActiveTrip(item);
                    setScreen("album");
                  }}
                >
                  {item.photos[0] && (
                    <Image
                      source={{ uri: item.photos[0].uri }}
                      style={styles.tripCover}
                    />
                  )}
                  <View style={styles.tripMeta}>
                    {isEditing ? (
                      <TextInput
                        style={styles.tripTitleInput}
                        value={editingName}
                        onChangeText={setEditingName}
                        autoFocus
                        returnKeyType="done"
                        onSubmitEditing={confirmEdit}
                        onBlur={confirmEdit}
                      />
                    ) : (
                      <Text style={styles.tripTitle}>{item.name}</Text>
                    )}
                    <Text style={styles.tripSub}>
                      {item.photos.length} photo
                      {item.photos.length === 1 ? "" : "s"}
                      {item.destination === "both" ? "  ·  on map too" : ""}
                    </Text>
                  </View>
                  <View style={styles.tripActions}>
                    {isEditing ? (
                      <TouchableOpacity style={styles.actionBtn} onPress={confirmEdit}>
                        <Text style={styles.actionConfirm}>✓</Text>
                      </TouchableOpacity>
                    ) : (
                      <>
                        <TouchableOpacity style={styles.actionBtn} onPress={() => startEdit(item)}>
                          <Text style={styles.actionIcon}>✏️</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.actionBtn} onPress={() => deleteTrip(item.id)}>
                          <Text style={styles.actionIcon}>🗑️</Text>
                        </TouchableOpacity>
                      </>
                    )}
                  </View>
                </TouchableOpacity>
              );
            }}
          />
        )}
        <TouchableOpacity style={styles.floatingBtn} onPress={openPicker}>
          <Text style={styles.primaryBtnText}>+  New Trip</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ---------- HOME ----------
  return (
    <View style={styles.container}>
      <Text style={styles.title}>My Trips</Text>
      <Text style={styles.subtitle}>Relive your journeys</Text>

      <TouchableOpacity
        style={styles.button}
        onPress={() => setScreen("globalmap")}
      >
        <Text style={styles.buttonText}>🌍  Global Map</Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={[styles.button, styles.buttonAlt]}
        onPress={() => setScreen("albums")}
      >
        <Text style={styles.buttonText}>📔  Albums</Text>
      </TouchableOpacity>
    </View>
  );
}

function Header({
  title,
  onBack,
  backLabel,
}: {
  title: string;
  onBack: () => void;
  backLabel: string;
}) {
  return (
    <View style={styles.header}>
      <TouchableOpacity onPress={onBack} style={{ minWidth: 70 }}>
        <Text style={styles.back}>‹ {backLabel}</Text>
      </TouchableOpacity>
      <Text style={styles.headerTitle} numberOfLines={1}>
        {title}
      </Text>
      <View style={{ minWidth: 70 }} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#faf8f5",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  screen: { flex: 1, backgroundColor: "#faf8f5" },
  title: { fontSize: 36, fontWeight: "700", color: "#2b2b2b" },
  subtitle: { fontSize: 16, color: "#9a8c7a", marginBottom: 48 },
  button: {
    backgroundColor: "#8b3a2f",
    paddingVertical: 20,
    paddingHorizontal: 32,
    borderRadius: 14,
    width: "100%",
    alignItems: "center",
    marginBottom: 16,
  },
  buttonAlt: { backgroundColor: "#c79a6b" },
  buttonText: { color: "#fff", fontSize: 20, fontWeight: "600" },

  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: 60,
    paddingHorizontal: 16,
    paddingBottom: 12,
    backgroundColor: "#faf8f5",
  },
  back: { color: "#8b3a2f", fontSize: 18, fontWeight: "600" },
  headerTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: "#2b2b2b",
    flex: 1,
    textAlign: "center",
  },

  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  muted: { color: "#9a8c7a", marginTop: 12, fontSize: 15, textAlign: "center" },

  gridThumb: {
    flex: 1 / 3,
    aspectRatio: 1,
    margin: 2,
    borderRadius: 6,
    backgroundColor: "#eee",
  },
  pickCell: { flex: 1 / 3, aspectRatio: 1, margin: 2, position: "relative" },
  badge: {
    position: "absolute",
    top: 6,
    right: 6,
    backgroundColor: "#8b3a2f",
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: "#fff",
  },
  badgeText: { color: "#fff", fontWeight: "700", fontSize: 13 },

  floatingBtn: {
    position: "absolute",
    bottom: 24,
    alignSelf: "center",
    backgroundColor: "#8b3a2f",
    paddingVertical: 16,
    paddingHorizontal: 40,
    borderRadius: 30,
    shadowColor: "#000",
    shadowOpacity: 0.2,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
    elevation: 4,
  },
  primaryBtn: {
    backgroundColor: "#8b3a2f",
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: "center",
  },
  primaryBtnText: { color: "#fff", fontSize: 17, fontWeight: "700" },

  label: { fontSize: 15, fontWeight: "700", color: "#2b2b2b", marginBottom: 8 },
  input: {
    borderWidth: 1,
    borderColor: "#e2d8cc",
    borderRadius: 12,
    padding: 14,
    fontSize: 16,
    backgroundColor: "#fff",
    color: "#2b2b2b",
  },
  choice: {
    borderWidth: 1,
    borderColor: "#e2d8cc",
    borderRadius: 12,
    padding: 16,
    marginBottom: 10,
    backgroundColor: "#fff",
  },
  choiceActive: { borderColor: "#8b3a2f", backgroundColor: "#f6ece6" },
  choiceText: { fontSize: 16, color: "#2b2b2b" },
  choiceTextActive: { fontWeight: "700", color: "#8b3a2f" },
  note: { marginTop: 18, color: "#9a8c7a", fontSize: 14, textAlign: "center" },

  tripCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 10,
    marginBottom: 10,
  },
  tripCover: { width: 80, height: 80, borderRadius: 10, backgroundColor: "#eee" },
  tripMeta: { marginLeft: 14, flex: 1 },
  tripTitle: { fontSize: 16, fontWeight: "700", color: "#2b2b2b" },
  tripTitleInput: {
    fontSize: 16,
    fontWeight: "700",
    color: "#2b2b2b",
    borderBottomWidth: 1.5,
    borderBottomColor: "#8b3a2f",
    padding: 0,
    margin: 0,
  },
  tripSub: { fontSize: 13, color: "#9a8c7a", marginTop: 4 },
  tripActions: { flexDirection: "column", alignItems: "center", marginLeft: 6 },
  actionBtn: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  actionIcon: { fontSize: 18 },
  actionConfirm: { fontSize: 22, color: "#8b3a2f", fontWeight: "700" },

  stopCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 10,
    marginBottom: 10,
  },
  stopNumber: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: "#8b3a2f",
    alignItems: "center",
    justifyContent: "center",
    marginRight: 10,
  },
  stopNumberText: { color: "#fff", fontWeight: "700", fontSize: 14 },
  stopCover: { width: 60, height: 60, borderRadius: 8, backgroundColor: "#eee" },
  stopMeta: { marginLeft: 12, flex: 1 },
  stopName: { fontSize: 16, fontWeight: "700", color: "#2b2b2b" },
  stopSub: { fontSize: 12, color: "#9a8c7a", marginTop: 4 },

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
    color: "rgba(255,255,255,0.9)",
    fontSize: 15,
    fontWeight: "600",
    maxWidth: "70%",
  },
  viewerCount: { color: "rgba(255,255,255,0.5)", fontSize: 12, marginTop: 2 },
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
  viewerCloseText: { color: "rgba(255,255,255,0.85)", fontSize: 24 },
  viewerPage: { width: SCREEN_W, flex: 1, paddingTop: 100, paddingBottom: 40 },
  viewerImageWrap: { flex: 1, justifyContent: "center" },
  viewerImage: { width: "100%", height: "100%" },
  captionZone: { height: 96, marginHorizontal: 20, marginTop: 8 },
  captionInput: {
    flex: 1,
    color: "#fff",
    fontSize: 16,
    fontWeight: "400",
    textAlign: "center",
    textShadowColor: "rgba(0,0,0,0.6)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
});
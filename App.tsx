import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, Animated, Easing, Image, Pressable, ScrollView,
  Share, StyleSheet, Text, View, Modal, TextInput, Platform, PanResponder,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { CameraType, CameraView, useCameraPermissions } from 'expo-camera';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import AsyncStorage from '@react-native-async-storage/async-storage';
import QRCode from 'react-native-qrcode-svg';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import * as WebBrowser from 'expo-web-browser';
import * as FileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library';
import * as Sharing from 'expo-sharing';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { useKeepAwake } from 'expo-keep-awake';
import { WebView, WebViewMessageEvent } from 'react-native-webview';
import { captureRef } from 'react-native-view-shot';

type Screen = 'home' | 'photo' | 'camera' | 'category' | 'catalog' | 'processing' | 'result' | 'wardrobe' | 'retailer';
type LookCategory = 'clothes' | 'hair' | 'accessories';
type AccessoryType = 'hat' | 'earring' | 'necklace';
type DiscoverySource = 'pinterest' | 'bing' | 'web';
type ImageResult = { id: string; title: string; source: string; image_url: string; thumbnail_url?: string; description?: string };
type PinterestBoard = { id:string; name:string; description?:string; pin_count:number; privacy:string };
type Garment = { id: string; name: string; maker: string; price: string; colors: readonly [string, string]; icon: string; referenceUrl: string; thumbnailUrl?: string; category?: LookCategory; accessoryType?: AccessoryType };
type PhotoFile = { uri: string; name: string; type: string };
type ServiceStatus = 'checking' | 'online' | 'offline' | 'unavailable';
type CameraPurpose = 'person' | 'look';
type WardrobeItem = { id:string; createdAt:number; beforeUri:string; afterUri:string; garment:Garment; category:LookCategory };

const categoryOf = (item: Garment): LookCategory => item.category ?? 'clothes';
const CATALOG_VERSION = '5';
const YOUCAM_ENDPOINT = process.env.EXPO_PUBLIC_YOUCAM_FUNCTION_URL;
const BACKEND_ROOT = YOUCAM_ENDPOINT?.replace(/\/try-on\/?$/, '');
const WARDROBE_KEY = 'luku.wardrobe';
const WARDROBE_DIRECTORY = `${FileSystem.documentDirectory}luku-wardrobe/`;
const BING_IMAGE_SELECTOR_SCRIPT = `
  (function () {
    if (window.__lukuImageSelectorInstalled) return true;
    window.__lukuImageSelectorInstalled = true;
    var lastSelection = '';
    function selectImage(event) {
      if (!event.isTrusted) return;
      var path = event.composedPath ? event.composedPath() : [];
      var target = event.target;
      var anchor = target && target.closest ? target.closest('a.iusc, a[m], a[href*="view=detailV2"]') : null;
      if (!anchor) {
        for (var i = 0; i < path.length; i += 1) {
          var candidate = path[i];
          if (candidate && candidate.matches && candidate.matches('a.iusc, a[m], a[href*="view=detailV2"]')) {
            anchor = candidate;
            break;
          }
        }
      }
      var image = target && target.tagName === 'IMG' ? target : anchor && anchor.querySelector ? anchor.querySelector('img') : null;
      if (!anchor || !image) return;
      try {
        var metadata = JSON.parse(anchor.getAttribute('m') || '{}');
        var href = new URL(anchor.href, location.href);
        var original = metadata.murl || href.searchParams.get('mediaurl');
        var thumbnail = metadata.turl || href.searchParams.get('cdnurl') || image.currentSrc || image.src;
        if (typeof original !== 'string' || original.toLowerCase().indexOf('https://') !== 0) return;
        if (lastSelection === original) return;
        lastSelection = original;
        event.preventDefault();
        event.stopPropagation();
        if (event.stopImmediatePropagation) event.stopImmediatePropagation();
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'luku-bing-image',
          id: metadata.mid || original,
          title: metadata.t || image.alt || 'Bing image inspiration',
          source: metadata.purl || 'Bing Images',
          image_url: original,
          thumbnail_url: thumbnail
        }));
      } catch (_) {
        lastSelection = '';
      }
    }
    document.addEventListener('click', selectImage, true);
    true;
  })();
`;

const WEB_IMAGE_PICKER_SCRIPT = `
  (function () {
    if (window.__lukuWebPickerInstalled) return true;
    window.__lukuWebPickerInstalled = true;
    window.__lukuPickingImage = false;
    var style = document.createElement('style');
    style.textContent = 'html.luku-picking img{outline:3px solid #B83F6A!important;outline-offset:2px!important;cursor:crosshair!important}';
    document.documentElement.appendChild(style);
    window.__lukuSetPicking = function (active) {
      window.__lukuPickingImage = !!active;
      document.documentElement.classList.toggle('luku-picking', !!active);
    };
    document.addEventListener('click', function (event) {
      if (!window.__lukuPickingImage || !event.isTrusted) return;
      var target = event.target;
      var image = target && target.tagName === 'IMG' ? target : target && target.closest ? target.closest('img') : null;
      if (!image) return;
      try {
        var source = image.currentSrc || image.src || image.getAttribute('data-src');
        source = new URL(source, location.href).toString();
        if (source.toLowerCase().indexOf('https://') !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.stopImmediatePropagation) event.stopImmediatePropagation();
        window.__lukuSetPicking(false);
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'luku-web-image',
          id: source,
          title: image.alt || document.title || 'Store image',
          source: location.hostname,
          image_url: source,
          thumbnail_url: source
        }));
      } catch (_) {}
    }, true);
    true;
  })();
`;

async function copyToWardrobe(uri: string, id: string, suffix: 'before' | 'after') {
  await FileSystem.makeDirectoryAsync(WARDROBE_DIRECTORY, { intermediates: true });
  const target = `${WARDROBE_DIRECTORY}${id}-${suffix}.jpg`;
  if (/^https:\/\//i.test(uri)) return (await FileSystem.downloadAsync(uri, target)).uri;
  if (/^(file|content):/i.test(uri)) {
    await FileSystem.copyAsync({ from: uri, to: target });
    return target;
  }
  throw new Error('This image cannot be stored on the device.');
}

async function serviceIsReachable(timeoutMs = 4_000) {
  if (!YOUCAM_ENDPOINT) return true;
  const healthUrl = YOUCAM_ENDPOINT.replace(/\/try-on\/?$/, '/health');
  try {
    const response = await fetchWithTimeout(healthUrl, { method: 'GET' }, timeoutMs);
    return response.ok;
  } catch {
    return false;
  }
}

async function internetIsReachable(timeoutMs = 3_000) {
  for (const url of ['https://www.google.com/generate_204', 'https://www.cloudflare.com/cdn-cgi/trace']) {
    try {
      const response = await fetchWithTimeout(url, { method:'GET' }, timeoutMs);
      if (response.ok) return true;
    } catch { /* Try the second independent connectivity check. */ }
  }
  return false;
}

async function readStoredArray<T>(key: string): Promise<T[]> {
  try {
    const value = await AsyncStorage.getItem(key);
    if (!value) return [];
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error('The preview service took too long to respond. Please try again.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function readApiPayload(response: Response): Promise<{ ok?: boolean; code?: string; error?: string; task_id?: string; result_url?: string }> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { error: response.ok ? 'The preview service returned an unreadable response.' : `The preview service is unavailable (${response.status}).` };
  }
}

const garments: Garment[] = [
  { id: 'kitenge', name: 'Kitenge Statement Shirt', maker: 'Zuri Studio · Nairobi', price: 'KSh 3,800', colors: ['#C85078', '#F3AFC5'], icon: '✦', referenceUrl: 'https://plugins-media.makeupar.com/strapi/assets/clothes_reference_full_body_01_5a000d999f.png' },
  { id: 'linen', name: 'Sage Linen Set', maker: 'Soko Label · Nairobi', price: 'KSh 5,200', colors: ['#D6819E', '#F5C7D6'], icon: '◒', referenceUrl: 'https://plugins-media.makeupar.com/strapi/assets/clothes_reference_full_body_01_5a000d999f.png' },
  { id: 'dress', name: 'Indigo Wrap Dress', maker: 'Amani Atelier · Mombasa', price: 'KSh 4,600', colors: ['#8C3D61', '#D58BA7'], icon: '◆', referenceUrl: 'https://plugins-media.makeupar.com/strapi/assets/clothes_reference_full_body_01_5a000d999f.png' },
  { id: 'global', name: 'Minimalist Utility Jacket', maker: 'Independent label · Online', price: 'View store', colors: ['#A75B79', '#E9B8CB'], icon: '◇', referenceUrl: 'https://plugins-media.makeupar.com/strapi/assets/clothes_reference_full_body_01_5a000d999f.png' },
  { id: 'braids', name: 'Soft Layered Waves', maker: 'Crown Studio · Online', price: 'Book stylist', colors: ['#71364D', '#E9A9C0'], icon: '✂', referenceUrl: 'https://plugins-media.makeupar.com/strapi/assets/clothes_03_cccd5d4803.jpeg', category: 'hair' },
  { id: 'hat', name: 'Statement Fedora', maker: 'Luku Edit · Global', price: 'View store', colors: ['#9F496A', '#F4C5D6'], icon: '◇', referenceUrl: 'https://upload.wikimedia.org/wikipedia/commons/9/9e/Fedora_Hat.jpg', category: 'accessories', accessoryType: 'hat' },
];
const DEMO_PERSON = 'https://plugins-media.makeupar.com/strapi/assets/clothes_03_cccd5d4803.jpeg';

export default function App() {
  useKeepAwake('luku-active');
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [screen, setScreen] = useState<Screen>('home');
  const [photo, setPhoto] = useState<string>();
  const [photoFile, setPhotoFile] = useState<PhotoFile>();
  const [selected, setSelected] = useState(garments[0]);
  const [showAfter, setShowAfter] = useState(true);
  const [progress, setProgress] = useState(0);
  const [resultUrl, setResultUrl] = useState<string>();
  const [catalog, setCatalog] = useState<Garment[]>(garments);
  const [personalLooks, setPersonalLooks] = useState<Garment[]>([]);
  const [wardrobe, setWardrobe] = useState<WardrobeItem[]>([]);
  const [discoverySource, setDiscoverySource] = useState<DiscoverySource>();
  const [webPickerVisible, setWebPickerVisible] = useState(false);
  const [activeCategory, setActiveCategory] = useState<LookCategory>('clothes');
  const [activeAccessoryType, setActiveAccessoryType] = useState<AccessoryType>('hat');
  const [pickerBusy, setPickerBusy] = useState(false);
  const [cameraPurpose, setCameraPurpose] = useState<CameraPurpose>('person');
  const [serviceStatus, setServiceStatus] = useState<ServiceStatus>('checking');
  const generationRun = useRef(0);
  const launchSound = useAudioPlayer(require('./assets/luku-open.m4a'), { updateInterval: 500 });

  useEffect(() => {
    launchSound.volume = 0.5;
    const timer = setTimeout(() => {
      try { launchSound.play(); } catch { /* Audio is decorative; never block startup. */ }
    }, 420);
    return () => clearTimeout(timer);
  }, [launchSound]);

  useEffect(() => {
    Promise.all([
      readStoredArray<Garment>('luku.catalog'),
      readStoredArray<Garment>('luku.personalLooks'),
      readStoredArray<WardrobeItem>(WARDROBE_KEY),
      AsyncStorage.getItem('luku.catalogVersion'),
    ]).then(([storedCatalog, storedPersonal, storedWardrobe, storedVersion]) => {
      if (storedVersion === CATALOG_VERSION) {
        setCatalog(storedCatalog);
      } else {
        const defaultIds = new Set(garments.map(item => item.id));
        const migrated = [...garments, ...storedCatalog.filter(item => !defaultIds.has(item.id))];
        setCatalog(migrated);
        AsyncStorage.multiSet([
          ['luku.catalog', JSON.stringify(migrated)],
          ['luku.catalogVersion', CATALOG_VERSION],
        ]).catch(() => undefined);
      }
      setPersonalLooks(storedPersonal);
      setWardrobe(storedWardrobe);
    });
  }, []);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      const reachable = await serviceIsReachable();
      if (!active) return;
      if (reachable) setServiceStatus('online');
      else setServiceStatus(await internetIsReachable() ? 'unavailable' : 'offline');
    };
    refresh();
    const timer = setInterval(refresh, 30_000);
    return () => { active = false; clearInterval(timer); };
  }, []);

  const persistPersonalLooks = (next: Garment[]) => { setPersonalLooks(next); AsyncStorage.setItem('luku.personalLooks', JSON.stringify(next)); };
  const persistWardrobe = (next: WardrobeItem[]) => { setWardrobe(next); AsyncStorage.setItem(WARDROBE_KEY, JSON.stringify(next)); };

  const storeCompletedPreview = async (remoteResult: string, taskId?: string, completedGarment: Garment = selected) => {
    const id = taskId || `look-${Date.now()}`;
    const [beforeUri, afterUri] = await Promise.all([
      copyToWardrobe(photo!, id, 'before'),
      copyToWardrobe(remoteResult, id, 'after'),
    ]);
    const item: WardrobeItem = { id, createdAt:Date.now(), beforeUri, afterUri, garment:completedGarment, category:activeCategory };
    const next = [item, ...wardrobe.filter(existing => existing.id !== item.id)];
    persistWardrobe(next);
    return item;
  };

  const saveResultToDevice = async () => {
    if (!resultUrl) return Alert.alert('Nothing to save', 'Create a preview first.');
    try {
      const localUri = /^file:/i.test(resultUrl) ? resultUrl : await copyToWardrobe(resultUrl, `export-${Date.now()}`, 'after');
      const permission = await MediaLibrary.requestPermissionsAsync(true, ['photo']);
      if (!permission.granted) return Alert.alert('Photo permission needed', 'Allow Luku to add the preview to your photo library.');
      await MediaLibrary.saveToLibraryAsync(localUri);
      Alert.alert('Saved to your device', 'The finished Luku image is now in your photo library and remains in Wardrobe.');
    } catch (error) {
      Alert.alert('Could not save image', error instanceof Error ? error.message : 'Please try again.');
    }
  };
  const useCustomerLookPhoto = (file: PhotoFile, generateNow = false) => {
    const item: Garment = { id:`personal-${Date.now()}`, name:activeCategory === 'hair' ? 'My hairstyle' : activeCategory === 'accessories' ? `My ${activeAccessoryType}` : 'My clothing look', maker:'Private inspiration', price:'Customer upload', colors:['#D96C94','#F8DCE6'], icon:'♡', referenceUrl:file.uri, category:activeCategory, accessoryType:activeCategory === 'accessories' ? activeAccessoryType : undefined };
    persistPersonalLooks([item, ...personalLooks]);
    setSelected(item);
    setResultUrl(undefined);
    setShowAfter(true);
    if (generateNow) generate(item);
    else setScreen('catalog');
  };

  const addCustomerLook = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.85 });
    if (result.canceled) return;
    const asset = result.assets[0];
    useCustomerLookPhoto({ uri:asset.uri, name:asset.fileName ?? `luku-look.${asset.mimeType?.split('/')[1] || 'jpg'}`, type:asset.mimeType ?? 'image/jpeg' }, true);
  };
  const addDiscoveredLook = (result: ImageResult, source: DiscoverySource) => {
    const item: Garment = {
      id: `${source}-${result.id}-${Date.now()}`,
      name: result.title || (activeCategory === 'hair' ? 'Online hairstyle' : activeCategory === 'accessories' ? `Online ${activeAccessoryType}` : 'Online clothing look'),
      maker: source === 'pinterest' ? 'My Pinterest' : result.source || (source === 'web' ? 'Online store' : 'Bing Images'),
      price: 'Online inspiration',
      colors: source === 'pinterest' ? ['#BD081C','#F6B7BD'] : ['#008373','#C8F1EB'],
      icon: source === 'pinterest' ? 'P' : source === 'web' ? 'W' : 'B',
      referenceUrl: result.image_url,
      thumbnailUrl: result.thumbnail_url || result.image_url,
      category: activeCategory,
      accessoryType: activeCategory === 'accessories' ? activeAccessoryType : undefined,
    };
    const next = [item, ...personalLooks.filter(existing => existing.referenceUrl !== item.referenceUrl)];
    persistPersonalLooks(next);
    setSelected(item);
    setDiscoverySource(undefined);
    setWebPickerVisible(false);
    generate(item);
  };

  const step = useMemo(() => ({ photo: 1, catalog: 2, processing: 3, result: 3 } as Partial<Record<Screen, number>>)[screen] || 0, [screen]);

  const startCategory = (category: LookCategory) => {
    const first = [...personalLooks, ...catalog].find(item => categoryOf(item) === category && (category !== 'accessories' || item.accessoryType === activeAccessoryType));
    setActiveCategory(category);
    if (first) setSelected(first);
    setPhoto(undefined);
    setPhotoFile(undefined);
    setResultUrl(undefined);
    setShowAfter(true);
    setScreen('photo');
  };

  const changeAccessoryType = (next: AccessoryType) => {
    setActiveAccessoryType(next);
    const first = [...personalLooks, ...catalog].find(item => categoryOf(item) === 'accessories' && item.accessoryType === next);
    if (first) setSelected(first);
  };

  const openWardrobeItem = (item: WardrobeItem) => {
    setPhoto(item.beforeUri);
    setPhotoFile({ uri:item.beforeUri, name:`${item.id}-before.jpg`, type:'image/jpeg' });
    setResultUrl(item.afterUri);
    setSelected(item.garment);
    setActiveCategory(item.category);
    if (item.garment.accessoryType) setActiveAccessoryType(item.garment.accessoryType);
    setShowAfter(true);
    setScreen('result');
  };

  const removeWardrobeItem = async (item: WardrobeItem) => {
    const next = wardrobe.filter(existing => existing.id !== item.id);
    persistWardrobe(next);
    await Promise.all([item.beforeUri, item.afterUri].map(async uri => {
      if (!/^file:/i.test(uri)) return;
      const info = await FileSystem.getInfoAsync(uri);
      if (info.exists) await FileSystem.deleteAsync(uri, { idempotent:true });
    })).catch(() => undefined);
  };

  async function choosePhoto(camera = false) {
    if (pickerBusy) return;
    setPickerBusy(true);
    try {
      if (camera) {
        const currentPermission = await ImagePicker.getCameraPermissionsAsync();
        const permission = currentPermission.granted ? currentPermission : await ImagePicker.requestCameraPermissionsAsync();
        if (!permission.granted) return Alert.alert('Camera permission needed','Allow camera access in your phone settings to take a try-on photo.');
      }
      const result = camera
        ? await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.55, allowsEditing: false, exif: false, base64: false })
        : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.65, allowsEditing: false, exif: false, base64: false });
      if (!result.canceled && result.assets[0]?.uri) {
        const asset = result.assets[0];
        const uri = asset.uri;
        setPhoto(uri);
        setPhotoFile({ uri, name: asset.fileName ?? `luku-person.${asset.mimeType?.split('/')[1] || 'jpg'}`, type: asset.mimeType ?? 'image/jpeg' });
        setResultUrl(undefined);
        setShowAfter(true);
        setScreen('catalog');
      }
    } catch (error) {
      Alert.alert('Could not open photos', error instanceof Error ? error.message : 'Please check app permissions and try again.');
    } finally {
      setPickerBusy(false);
    }
  }

  async function openCamera(purpose: CameraPurpose = 'person') {
    const permission = cameraPermission?.granted ? cameraPermission : await requestCameraPermission();
    if (!permission.granted) {
      Alert.alert('Camera permission needed', 'Allow camera access in your phone settings to take a try-on photo.');
      return;
    }
    setCameraPurpose(purpose);
    setScreen('camera');
  }

  function acceptCameraPhoto(file: PhotoFile) {
    if (cameraPurpose === 'look') {
      useCustomerLookPhoto(file, true);
      return;
    }
    setPhoto(file.uri);
    setPhotoFile(file);
    setResultUrl(undefined);
    setShowAfter(true);
    setScreen('catalog');
  }

  async function generate(chosenLook: Garment = selected) {
    if (!photo) return;
    const run = ++generationRun.current;
    setSelected(chosenLook);
    const endpoint = YOUCAM_ENDPOINT;
    if (endpoint && serviceStatus !== 'online') {
      const reachable = await serviceIsReachable();
      if (run !== generationRun.current) return;
      const nextStatus: ServiceStatus = reachable ? 'online' : await internetIsReachable() ? 'unavailable' : 'offline';
      if (run !== generationRun.current) return;
      setServiceStatus(nextStatus);
      if (!reachable) {
        Alert.alert(
          nextStatus === 'offline' ? 'No internet connection' : 'Preview service unavailable',
          nextStatus === 'offline'
            ? 'Luku needs an internet connection to create your preview. Reconnect and try again.'
            : 'Your internet is working, but Luku could not reach the image service. Please try again shortly.',
        );
        return;
      }
    }
    setResultUrl(undefined); setShowAfter(true); setScreen('processing'); setProgress(18);
    if (!endpoint) {
      setTimeout(() => { if (run === generationRun.current) setProgress(56); }, 700);
      setTimeout(() => { if (run === generationRun.current) setProgress(88); }, 1500);
      setTimeout(() => { if (run === generationRun.current) { setProgress(100); setScreen('result'); } }, 2400);
      return;
    }
    let progressTimer: ReturnType<typeof setInterval> | undefined;
    try {
      const form = new FormData();
      form.append('person', { uri: photoFile?.uri ?? photo, name: photoFile?.name ?? 'luku-person.jpg', type: photoFile?.type ?? 'image/jpeg' } as unknown as Blob);
      if (/^(file|content):/i.test(chosenLook.referenceUrl)) form.append('reference', { uri: chosenLook.referenceUrl, name: 'luku-reference.jpg', type: 'image/jpeg' } as unknown as Blob);
      else {
        form.append('reference_url', chosenLook.referenceUrl);
        if (chosenLook.thumbnailUrl && chosenLook.thumbnailUrl !== chosenLook.referenceUrl) form.append('reference_fallback_url', chosenLook.thumbnailUrl);
      }
      form.append('garment_category', 'full_body');
      form.append('look_category', activeCategory);
      if (chosenLook.accessoryType) form.append('accessory_type', chosenLook.accessoryType);
      setProgress(42);
      progressTimer = setInterval(() => setProgress(current => Math.min(current + 3, 94)), 900);
      const response = await fetchWithTimeout(endpoint, { method: 'POST', body: form }, 90_000);
      const payload = await readApiPayload(response);
      if (run !== generationRun.current) return;
      if (!response.ok || !payload.result_url) throw new Error(payload.error ?? 'Preview failed');
      setServiceStatus('online');
      setProgress(100); setResultUrl(payload.result_url); setScreen('result');
      storeCompletedPreview(payload.result_url, payload.task_id, chosenLook).then(saved => {
        setPhoto(saved.beforeUri);
        setPhotoFile({ uri:saved.beforeUri, name:`${saved.id}-before.jpg`, type:'image/jpeg' });
        setResultUrl(saved.afterUri);
      }).catch(() => undefined);
    } catch (error) {
      if (run !== generationRun.current) return;
      const message = error instanceof Error ? error.message : 'Check your connection and try another photo.';
      const offline = /network request failed|failed to fetch|internet connection/i.test(message);
      const networkStatus: ServiceStatus = offline ? await internetIsReachable() ? 'unavailable' : 'offline' : serviceStatus;
      if (run !== generationRun.current) return;
      if (offline) setServiceStatus(networkStatus);
      Alert.alert(
        offline ? networkStatus === 'offline' ? 'No internet connection' : 'Preview service unavailable' : 'We couldn’t create this preview',
        offline
          ? networkStatus === 'offline'
            ? 'Luku could not access the internet. Reconnect and try again.'
            : 'Your internet is working, but Luku could not reach the image service. Please try again shortly.'
          : message,
        [{ text:'Try again', onPress:() => setScreen('catalog') }],
      );
    } finally {
      if (progressTimer) clearInterval(progressTimer);
    }
  }

  const cancelGeneration = () => {
    generationRun.current += 1;
    setProgress(0);
    setResultUrl(undefined);
    setScreen('catalog');
  };

  const goBack = () => setScreen(screen === 'category' ? 'photo' : screen === 'catalog' ? 'photo' : screen === 'result' ? 'catalog' : 'home');

  return (
    <SafeAreaProvider><SafeAreaView style={styles.safe} edges={['top','right','bottom','left']}>
      <StatusBar style="dark" />
      {serviceStatus === 'offline' && <View style={styles.offlineBanner}><Ionicons name="cloud-offline-outline" size={17} color="#fff"/><Text style={styles.offlineText}>No internet — previews are unavailable</Text></View>}
      {serviceStatus === 'unavailable' && <View style={styles.offlineBanner}><Ionicons name="cloud-offline-outline" size={17} color="#fff"/><Text style={styles.offlineText}>Luku preview service is temporarily unavailable</Text></View>}
      {screen !== 'home' && screen !== 'camera' && screen !== 'processing' && (
        <View style={styles.header}>
          <Pressable onPress={goBack} style={styles.iconButton}><Ionicons name="arrow-back" size={21} /></Pressable>
          <Text style={styles.wordmark}>LUKU</Text>
          <View style={styles.headerSpacer} />
        </View>
      )}
      {step > 0 && screen !== 'camera' && screen !== 'processing' && screen !== 'result' && (
        <View style={styles.steps}>{[1,2,3].map(n => <View key={n} style={[styles.step, n <= step && styles.stepActive]} />)}</View>
      )}

      {screen === 'home' && <Home wardrobeCount={wardrobe.length} onWardrobe={() => setScreen('wardrobe')} onCategory={startCategory} />}
      {screen === 'photo' && <PhotoStep category={activeCategory} accessoryType={activeAccessoryType} busy={pickerBusy} onCamera={() => openCamera('person')} onGallery={() => choosePhoto(false)} onDemo={() => { setPhoto(DEMO_PERSON); setPhotoFile({uri:DEMO_PERSON,name:'sample-shopper.jpeg',type:'image/jpeg'}); setResultUrl(undefined); setShowAfter(true); setScreen('catalog'); }} />}
      {screen === 'camera' && <CameraCapture initialFacing={cameraPurpose === 'person' ? 'front' : 'back'} instruction={cameraPurpose === 'person' ? 'Keep your face and body visible' : 'Fill the frame with the item you want to try'} onCancel={() => setScreen(cameraPurpose === 'person' ? 'photo' : 'catalog')} onCapture={acceptCameraPhoto} />}
      {screen === 'category' && <CategoryStep onChoose={startCategory} />}
      {screen === 'catalog' && <Catalog category={activeCategory} accessoryType={activeAccessoryType} onAccessoryType={changeAccessoryType} photo={photo!} personalItems={personalLooks} onCamera={() => openCamera('look')} onUpload={addCustomerLook} onBrowseWeb={() => setWebPickerVisible(true)} onBing={() => setDiscoverySource('bing')} onPinterest={() => setDiscoverySource('pinterest')} onGenerate={generate} />}
      {screen === 'processing' && <Processing progress={progress} garment={selected} onCancel={cancelGeneration} />}
      {screen === 'result' && <Result photo={photo!} resultUrl={resultUrl} garment={selected} showAfter={showAfter} setShowAfter={setShowAfter} onAgain={() => setScreen('catalog')} onSave={saveResultToDevice} />}
      {screen === 'wardrobe' && <Wardrobe items={wardrobe} onOpen={openWardrobeItem} onRemove={removeWardrobeItem} />}
      {screen === 'retailer' && <Retailer items={catalog} onTry={(g) => { setSelected(g); setScreen(photo ? 'catalog' : 'photo'); }} />}
      {!!discoverySource && <InspirationDiscovery visible initialSource={discoverySource} category={activeCategory} onClose={() => setDiscoverySource(undefined)} onChoose={addDiscoveredLook} />}
      {webPickerVisible && <WebImagePicker visible onClose={() => setWebPickerVisible(false)} onChoose={result => addDiscoveredLook(result, 'web')} />}
    </SafeAreaView></SafeAreaProvider>
  );
}

function Home({ onCategory, onWardrobe, wardrobeCount }: { onCategory:(category:LookCategory)=>void; onWardrobe:()=>void; wardrobeCount:number }) {
  const [slider, setSlider] = useState(.52);
  const [heroWidth, setHeroWidth] = useState(0);
  const [sliderDragging, setSliderDragging] = useState(false);
  const heroRef = useRef<View>(null);
  const heroLeft = useRef(0);
  const heroWidthRef = useRef(0);
  const measureHero = () => requestAnimationFrame(() => {
    heroRef.current?.measureInWindow((x, _y, width) => {
      heroLeft.current = x;
      if (width) {
        heroWidthRef.current = width;
        setHeroWidth(width);
      }
    });
  });
  const updateSlider = (pageX: number) => {
    const width = heroWidthRef.current;
    if (width) setSlider(Math.max(.04, Math.min(.96, (pageX - heroLeft.current) / width)));
  };
  const sliderResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onStartShouldSetPanResponderCapture: () => true,
    onMoveShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponderCapture: () => true,
    onPanResponderGrant: event => {
      setSliderDragging(true);
      measureHero();
      updateSlider(event.nativeEvent.pageX);
    },
    onPanResponderMove: event => updateSlider(event.nativeEvent.pageX),
    onPanResponderRelease: () => setSliderDragging(false),
    onPanResponderTerminate: () => setSliderDragging(false),
    onPanResponderTerminationRequest: () => false,
    onShouldBlockNativeResponder: () => true,
  }), []);
  const choices:{category:LookCategory;title:string;sub:string;icon:keyof typeof Ionicons.glyphMap}[] = [
    {category:'hair',title:'Hair',sub:'Cuts & colour',icon:'cut-outline'},
    {category:'clothes',title:'Clothes',sub:'Fits & outfits',icon:'shirt-outline'},
    {category:'accessories',title:'Accessories',sub:'Hats & jewellery',icon:'diamond-outline'},
  ];
  return <ScrollView scrollEnabled={!sliderDragging} style={styles.fill} contentContainerStyle={styles.homeScroll} showsVerticalScrollIndicator={false}><LinearGradient colors={['#FFF9F4','#F8DDE7']} style={styles.homeGradient}>
    <View style={styles.homeTop}><View><Text style={styles.wordmarkLarge}>LUKU</Text><Text style={styles.brandCaption}>STYLE, BEFORE YOU COMMIT</Text></View><Pressable accessibilityLabel="Open your wardrobe" onPress={onWardrobe} style={styles.wardrobeHomeButton}><Ionicons name="albums-outline" size={19} color="#7A2E4C"/><Text style={styles.wardrobeHomeCount}>{wardrobeCount}</Text></Pressable></View>
    <View style={styles.homeIntro}><Text style={styles.eyebrow}>TRY IT ON, VIRTUALLY</Text><Text style={styles.heroTitle}>See your next look.</Text><Text style={styles.homeBody}>Add your photo and an outfit. Slide to see the change.</Text></View>
    <View
      ref={heroRef}
      {...sliderResponder.panHandlers}
      onLayout={measureHero}
      style={styles.heroSlider}
    >
      {!!heroWidth && <>
        <Image source={require('./assets/luku-home-before-after-v2.webp')} style={[styles.heroDiptych,{width:heroWidth * 2,left:-heroWidth}]} resizeMode="cover"/>
        <View pointerEvents="none" style={[styles.heroAfterClip,{width:heroWidth * slider}]}><Image source={require('./assets/luku-home-before-after-v2.webp')} style={[styles.heroDiptych,{width:heroWidth * 2,left:0}]} resizeMode="cover"/></View>
        <View pointerEvents="none" style={[styles.sliderLine,{left:heroWidth * slider - 1}]}><View style={styles.sliderKnob}><Ionicons name="chevron-back" size={13} color="#6C2943"/><Ionicons name="chevron-forward" size={13} color="#6C2943"/></View></View>
      </>}
      <View pointerEvents="none" style={styles.beforeBadge}><Text style={styles.sliderBadgeText}>BEFORE</Text></View><View pointerEvents="none" style={styles.afterBadge}><Text style={styles.sliderBadgeText}>AFTER</Text></View>
    </View>
    <View style={styles.homeSliderControls}>
      <Pressable accessibilityRole="button" accessibilityLabel="Show before outfit" onPress={()=>setSlider(.92)} style={[styles.homeSliderButton,slider>=.5&&styles.homeSliderButtonOn]}><Text style={[styles.homeSliderButtonText,slider>=.5&&styles.homeSliderButtonTextOn]}>Before</Text></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="Show after outfit" onPress={()=>setSlider(.08)} style={[styles.homeSliderButton,slider<.5&&styles.homeSliderButtonOn]}><Text style={[styles.homeSliderButtonText,slider<.5&&styles.homeSliderButtonTextOn]}>After</Text></Pressable>
    </View>
    <View style={styles.homeCopy}><Text style={styles.homeSectionTitle}>What would you like to try?</Text>
      <View style={styles.homeCategories}>{choices.map(choice=><Pressable key={choice.category} onPress={()=>onCategory(choice.category)} style={({pressed})=>[styles.homeCategory,pressed&&styles.homeCategoryPressed]}><View style={styles.homeCategoryIcon}><Ionicons name={choice.icon} size={22} color="#8D3A5A"/></View><Text style={styles.homeCategoryText}>{choice.title}</Text><Text style={styles.homeCategorySub}>{choice.sub}</Text><Ionicons name="chevron-forward" size={16} color="#B76B87" style={styles.categoryChevron}/></Pressable>)}</View>
      <Pressable onPress={onWardrobe} style={styles.wardrobeCallout}><View style={styles.wardrobeCalloutIcon}><Ionicons name="albums" size={22} color="#fff"/></View><View style={{flex:1}}><Text style={styles.wardrobeCalloutTitle}>Your Wardrobe</Text><Text style={styles.wardrobeCalloutCopy}>{wardrobeCount ? `${wardrobeCount} saved preview${wardrobeCount === 1 ? '' : 's'} · reuse without generating again` : 'Completed previews will stay here on your device'}</Text></View><Ionicons name="chevron-forward" size={19} color="#8D3A5A"/></Pressable>
      <View style={styles.trustRow}><Ionicons name="shield-checkmark-outline" size={17} color="#8D3A5A"/><Text style={styles.trustText}>Your photos stay private and under your control.</Text></View>
    </View>
  </LinearGradient></ScrollView>;
}

function CameraCapture({ initialFacing, instruction, onCancel, onCapture }: { initialFacing:CameraType; instruction:string; onCancel: () => void; onCapture: (file: PhotoFile) => void }) {
  const cameraRef = useRef<CameraView>(null);
  const [facing, setFacing] = useState<CameraType>(initialFacing);
  const [ready, setReady] = useState(false);
  const [taking, setTaking] = useState(false);

  const takePhoto = async () => {
    if (!ready || taking) return;
    setTaking(true);
    try {
      const picture = await cameraRef.current?.takePictureAsync({ quality: 0.55, skipProcessing: true });
      if (!picture?.uri) throw new Error('The camera did not return a photo.');
      onCapture({ uri: picture.uri, name: `luku-camera-${Date.now()}.jpg`, type: 'image/jpeg' });
    } catch (error) {
      Alert.alert('Could not take photo', error instanceof Error ? error.message : 'Please try again.');
      setTaking(false);
    }
  };

  return <View style={styles.cameraScreen}>
    <CameraView ref={cameraRef} style={StyleSheet.absoluteFill} facing={facing} mode="picture" onCameraReady={() => setReady(true)} />
    <View style={styles.cameraShadeTop}><Pressable onPress={onCancel} style={styles.cameraCircle}><Ionicons name="close" size={25} color="#fff"/></Pressable><Text style={styles.cameraInstruction}>{instruction}</Text><Pressable onPress={() => setFacing(current => current === 'front' ? 'back' : 'front')} style={styles.cameraCircle}><Ionicons name="camera-reverse-outline" size={25} color="#fff"/></Pressable></View>
    <View style={styles.cameraFrame}><View style={styles.cameraFrameTL}/><View style={styles.cameraFrameTR}/><View style={styles.cameraFrameBL}/><View style={styles.cameraFrameBR}/></View>
    <View style={styles.cameraControls}><Text style={styles.cameraReadyText}>{ready ? 'Hold steady and tap once' : 'Starting camera…'}</Text><Pressable disabled={!ready || taking} onPress={takePhoto} style={[styles.shutterOuter,(!ready || taking)&&styles.disabledButton]}><View style={styles.shutterInner}>{taking && <ActivityIndicator color="#7A2E4C"/>}</View></Pressable></View>
  </View>;
}

function PhotoStep({ category, accessoryType, busy, onCamera, onGallery, onDemo }: { category:LookCategory; accessoryType:AccessoryType; busy: boolean; onCamera: () => void; onGallery: () => void; onDemo: () => void }) {
  const accessoryLabel = accessoryType === 'earring' ? 'earrings' : accessoryType;
  const intro = category === 'accessories'
    ? `For ${accessoryLabel}, use a clear photo with your face, ears and neckline visible.`
    : category === 'hair' ? 'Use a clear front-facing photo with your full hairline visible.' : 'Use a clear photo showing your body and the area you want to style.';
  const tips = category === 'accessories' ? ['Face camera','Ears visible','Neckline clear'] : category === 'hair' ? ['Face camera','Good light','Hair visible'] : ['Face camera','Good light','Body visible'];
  return <ScrollView contentContainerStyle={styles.page}>
    <Text style={styles.eyebrow}>STEP 1 OF 3</Text><Text style={styles.title}>Start with you.</Text>
    <Text style={styles.body}>{intro}</Text>
    <View style={styles.guide}>
      <View style={styles.person}><View style={styles.head} /><View style={styles.bodyShape} /></View>
      <View style={styles.cornerTL} /><View style={styles.cornerTR} /><View style={styles.cornerBL} /><View style={styles.cornerBR} />
    </View>
    <View style={styles.tipRow}>{tips.map((x,i) => <View key={x} style={styles.tip}><Ionicons name={(['camera-outline','eye-outline','body-outline'] as const)[i]} size={19} color="#7A2E4C" /><Text style={styles.tipText}>{x}</Text></View>)}</View>
    <Pressable disabled={busy} style={[styles.primary, busy && styles.disabledButton]} onPress={onCamera}>{busy ? <ActivityIndicator color="#fff" /> : <Ionicons name="camera" size={20} color="#fff" />}<Text style={styles.primaryText}>{busy ? 'Opening photos…' : 'Take a photo'}</Text></Pressable>
    <Pressable disabled={busy} style={[styles.secondary, busy && styles.disabledButton]} onPress={onGallery}><Ionicons name="images-outline" size={20} /><Text style={styles.secondaryText}>Choose from gallery</Text></Pressable>
    <Pressable style={styles.demoButton} onPress={onDemo}><Ionicons name="person-circle-outline" size={20} color="#8D3A5A" /><View><Text style={styles.demoTitle}>Use a sample shopper</Text><Text style={styles.demoCaption}>Instantly test the complete demo flow</Text></View><Ionicons name="arrow-forward" size={18} color="#8D3A5A" /></Pressable>
    <Text style={styles.privacy}>Your photo is used only to create this preview. You stay in control.</Text>
  </ScrollView>;
}

function CategoryStep({ onChoose }: { onChoose: (category: LookCategory) => void }) {
  const choices: { category: LookCategory; title: string; copy: string; icon: keyof typeof Ionicons.glyphMap }[] = [
    { category: 'clothes', title: 'Clothes', copy: 'Try dresses, shirts, jackets and complete outfits.', icon: 'shirt-outline' },
    { category: 'hair', title: 'Hair', copy: 'Preview cuts, colours, braids, wigs and hairstyles.', icon: 'cut-outline' },
    { category: 'accessories', title: 'Accessories', copy: 'Try hats, earrings and necklaces.', icon: 'diamond-outline' },
  ];
  return <ScrollView contentContainerStyle={styles.page}>
    <Text style={styles.eyebrow}>WHAT WOULD YOU LIKE TO TRY?</Text><Text style={styles.title}>Your look, your choice.</Text>
    <Text style={styles.body}>Luku lets you preview clothes, hair and accessories using your gallery, Bing Images or an online store.</Text>
    {choices.map(choice => <Pressable key={choice.category} style={styles.categoryCard} onPress={() => onChoose(choice.category)}><View style={styles.categoryIcon}><Ionicons name={choice.icon} size={25} color="#8D3A5A" /></View><View style={{flex:1}}><Text style={styles.categoryTitle}>{choice.title}</Text><Text style={styles.categoryCopy}>{choice.copy}</Text></View><Ionicons name="chevron-forward" size={21} color="#8D3A5A" /></Pressable>)}
    <View style={styles.categoryNote}><Ionicons name="heart-outline" size={20} color="#8D3A5A"/><Text style={styles.categoryNoteText}>Bring an idea from your gallery, Bing Images or a clothing website on the next screen.</Text></View>
  </ScrollView>;
}

function Catalog({ category, accessoryType, onAccessoryType, photo, personalItems, onGenerate, onCamera, onUpload, onBrowseWeb, onBing, onPinterest }: { category:LookCategory; accessoryType:AccessoryType; onAccessoryType:(type:AccessoryType)=>void; photo:string; personalItems:Garment[]; onGenerate:(look:Garment)=>void; onCamera:()=>void; onUpload:()=>void; onBrowseWeb:()=>void; onBing:()=>void; onPinterest:()=>void }) {
  const [showAllRecent, setShowAllRecent] = useState(false);
  const [pendingLook, setPendingLook] = useState<Garment>();
  useEffect(() => { setShowAllRecent(false); setPendingLook(undefined); }, [category, accessoryType]);
  const itemTime = (item: Garment) => Number(item.id.match(/(\d{13})(?!.*\d)/)?.[1] || 0);
  const mine = personalItems
    .filter(item => categoryOf(item) === category && (category !== 'accessories' || item.accessoryType === accessoryType))
    .sort((a, b) => itemTime(b) - itemTime(a));
  const recentItems = showAllRecent ? mine : mine.slice(0, 3);
  const label = category === 'hair' ? 'hairstyle' : category === 'accessories' ? 'accessory' : 'clothing look';
  return <ScrollView contentContainerStyle={styles.page}>
    <Text style={styles.eyebrow}>YOUR {category.toUpperCase()} INSPIRATION</Text><Text style={styles.title}>Add what you want to try.</Text>
    <View style={styles.photoStrip}><Image source={{uri:photo}} style={styles.thumb}/><View style={{flex:1}}><Text style={styles.smallLabel}>YOUR PHOTO</Text><Text style={styles.photoReady}>Ready for your {label}</Text></View><Ionicons name="checkmark-circle" size={24} color="#9B4162"/></View>
    {category === 'accessories' && <><Text style={styles.sectionLabel}>WHAT DO YOU WANT TO ADD?</Text><View style={styles.accessorySelector}>{(['hat','earring','necklace'] as AccessoryType[]).map(type => <Pressable key={type} onPress={() => onAccessoryType(type)} style={[styles.accessoryChip,accessoryType===type&&styles.accessoryChipOn]}><Text style={[styles.accessoryChipText,accessoryType===type&&styles.accessoryChipTextOn]}>{type === 'earring' ? 'Earrings' : `${type[0].toUpperCase()}${type.slice(1)}`}</Text></Pressable>)}</View><View style={styles.accessoryGuide}><Ionicons name="information-circle-outline" size={20} color="#8D3A5A"/><Text style={styles.accessoryGuideText}>Add a clear, front-facing product photo of the {accessoryType === 'earring' ? 'earrings' : accessoryType}. A plain background works best.</Text></View></>}
    <Text style={styles.quickHint}>Choose the {label} image you want to preview.</Text>
    <View style={styles.fastAddStack}>
      <Pressable style={styles.fastAddPrimary} onPress={onUpload}><View style={styles.fastAddIcon}><Ionicons name="image-outline" size={23} color="#fff"/></View><View style={{flex:1}}><Text style={styles.fastAddTitle}>Choose from gallery</Text><Text style={styles.fastAddCopy}>Use a saved photo or screenshot</Text></View><Ionicons name="chevron-forward" size={20} color="#fff"/></Pressable>
      <Pressable style={styles.fastAddSecondary} onPress={onCamera}><View style={styles.fastAddIconLight}><Ionicons name="camera-outline" size={23} color="#7A2E4C"/></View><View style={{flex:1}}><Text style={styles.fastAddTitleDark}>Use camera</Text><Text style={styles.fastAddCopyDark}>Take a clear photo of the item now</Text></View><Ionicons name="chevron-forward" size={20} color="#8D3A5A"/></Pressable>
      <View style={styles.discoveryRow}>
        <Pressable style={styles.discoveryButton} onPress={onBing}><View style={[styles.discoveryLogo,{backgroundColor:'#008373'}]}><Text style={styles.discoveryLogoText}>B</Text></View><Text style={styles.discoveryTitle}>Bing</Text><Text style={styles.discoveryCopy}>Search images</Text></Pressable>
        <Pressable style={styles.discoveryButton} onPress={onPinterest}><View style={[styles.discoveryLogo,{backgroundColor:'#BD081C'}]}><Ionicons name="logo-pinterest" size={22} color="#fff"/></View><Text style={styles.discoveryTitle}>Pinterest</Text><Text style={styles.discoveryCopy}>Use your Pins</Text></Pressable>
        <Pressable style={styles.discoveryButton} onPress={onBrowseWeb}><View style={[styles.discoveryLogo,{backgroundColor:'#7A2E4C'}]}><Ionicons name="globe-outline" size={21} color="#fff"/></View><Text style={styles.discoveryTitle}>Store</Text><Text style={styles.discoveryCopy}>Pick online</Text></Pressable>
      </View>
    </View>
    {mine.length > 0 && <Text style={styles.sectionLabel}>YOUR RECENT {category.toUpperCase()}</Text>}
    {recentItems.map(g => <LookCard key={g.id} item={g} onPress={()=>setPendingLook(g)}/>)}
    {mine.length > 3 && <Pressable onPress={() => setShowAllRecent(current => !current)} style={styles.seeMoreButton}><Text style={styles.seeMoreText}>{showAllRecent ? 'Show less' : `See more (${mine.length - 3})`}</Text><Ionicons name={showAllRecent ? 'chevron-up' : 'chevron-down'} size={17} color="#7A2E4C"/></Pressable>}
    <Modal transparent visible={!!pendingLook} animationType="fade" onRequestClose={()=>setPendingLook(undefined)}>
      <Pressable style={styles.lookModalShade} onPress={()=>setPendingLook(undefined)}>
        <Pressable accessibilityRole="none" onPress={event=>event.stopPropagation()} style={styles.lookModalCard}>
          <View style={styles.lookModalHandle}/>
          <Text style={styles.eyebrow}>CONFIRM YOUR LOOK</Text>
          <Text style={styles.lookModalTitle}>Try this {label}?</Text>
          {!!pendingLook && <><Image source={{uri:pendingLook.thumbnailUrl||pendingLook.referenceUrl}} style={styles.lookModalImage} resizeMode="cover"/><Text numberOfLines={2} style={styles.lookModalName}>{pendingLook.name}</Text><Text numberOfLines={1} style={styles.lookModalSource}>{pendingLook.maker}</Text></>}
          <View style={styles.lookModalActions}><Pressable onPress={()=>setPendingLook(undefined)} style={styles.lookModalCancel}><Text style={styles.lookModalCancelText}>Cancel</Text></Pressable><Pressable onPress={()=>{const look=pendingLook;if(!look)return;setPendingLook(undefined);onGenerate(look);}} style={styles.lookModalProceed}><Ionicons name="sparkles" size={18} color="#fff"/><Text style={styles.lookModalProceedText}>Proceed</Text></Pressable></View>
        </Pressable>
      </Pressable>
    </Modal>
  </ScrollView>;
}
function LookCard({item,onPress}:{item:Garment;onPress:()=>void}) {
  const preview = item.thumbnailUrl || item.referenceUrl;
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  return <Pressable accessibilityRole="button" accessibilityLabel={`Open ${item.name}`} onPress={onPress} style={({pressed})=>[styles.garmentCard,pressed&&styles.lookCardPressed]}><LinearGradient colors={item.colors} style={styles.garmentArt}>{preview && !failed ? <><Image source={{uri:preview}} style={styles.personalThumb} resizeMode="cover" onLoadStart={() => setLoading(true)} onLoadEnd={() => setLoading(false)} onError={() => { setLoading(false); setFailed(true); }}/>{loading&&<View style={styles.designLoading}><ActivityIndicator size="small" color="#8D3A5A"/></View>}</> : <View style={styles.designFallback}><Text style={styles.garmentIcon}>{item.icon}</Text><Text style={styles.designFallbackText}>Image unavailable</Text></View>}</LinearGradient><View style={styles.garmentCopy}><Text style={styles.garmentName} numberOfLines={2}>{item.name}</Text><Text style={styles.maker} numberOfLines={1}>{item.maker}</Text><Text style={styles.price}>{item.category === 'hair' ? 'Hairstyle' : item.category === 'accessories' ? 'Accessory' : 'Clothing'}</Text></View></Pressable>;
}

function InspirationDiscovery({ visible, initialSource, category, onClose, onChoose }: { visible:boolean; initialSource:DiscoverySource; category:LookCategory; onClose:()=>void; onChoose:(item:ImageResult,source:DiscoverySource)=>void }) {
  const [source, setSource] = useState<DiscoverySource>(initialSource);
  const defaultQuery = category === 'hair' ? 'hairstyle inspiration' : category === 'accessories' ? 'fashion accessories product photo' : 'fashion outfit inspiration';
  const [query, setQuery] = useState(defaultQuery);
  const [items, setItems] = useState<ImageResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pinterestSession, setPinterestSession] = useState<string>();
  const [pinterestBoards, setPinterestBoards] = useState<PinterestBoard[]>([]);
  const [selectedPinterestBoard, setSelectedPinterestBoard] = useState<string>('all');
  const [pinterestBookmark, setPinterestBookmark] = useState<string>();
  const [bingUrl, setBingUrl] = useState<string>();
  const [bingLoading, setBingLoading] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setSource(initialSource);
    setError('');
    setItems([]);
    setBingUrl(undefined);
    setQuery(defaultQuery);
    if (initialSource === 'pinterest') {
      AsyncStorage.getItem('luku.pinterestSession').then(session => {
        if (session) {
          setSelectedPinterestBoard('all');
          Promise.all([loadPinterest(session, 'all'), loadPinterestBoards(session)]);
        }
      });
    }
  }, [visible, initialSource, category]);

  useEffect(() => {
    if (!bingUrl) return;
    setBingLoading(true);
    const timeout = setTimeout(() => setBingLoading(false), 6_000);
    return () => clearTimeout(timeout);
  }, [bingUrl]);

  const requestJson = async (url: string, init?: RequestInit) => {
    const response = await fetchWithTimeout(url, init || { method: 'GET' }, 25_000);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'This service is unavailable right now.');
    return payload;
  };

  async function loadPinterest(session: string, board = selectedPinterestBoard, bookmark?: string) {
    if (!BACKEND_ROOT) return setError('Image discovery needs the Luku service connection.');
    setBusy(true); setError('');
    try {
      const params = new URLSearchParams({ session });
      if (board !== 'all') params.set('board', board);
      if (bookmark) params.set('bookmark', bookmark);
      const payload = await requestJson(`${BACKEND_ROOT}/pinterest/pins?${params.toString()}`);
      setPinterestSession(session);
      setItems(current => bookmark ? [...current, ...(Array.isArray(payload.items) ? payload.items : [])] : (Array.isArray(payload.items) ? payload.items : []));
      setPinterestBookmark(typeof payload.bookmark === 'string' ? payload.bookmark : undefined);
    } catch (loadError) {
      const message = loadError instanceof Error ? loadError.message : 'Pinterest could not load your Pins.';
      setError(message);
      if (/reconnect/i.test(message)) {
        setPinterestSession(undefined);
        AsyncStorage.removeItem('luku.pinterestSession');
      }
    } finally { setBusy(false); }
  }

  async function loadPinterestBoards(session: string) {
    if (!BACKEND_ROOT) return;
    try {
      let bookmark: string|undefined;
      const boards: PinterestBoard[] = [];
      do {
        const params = new URLSearchParams({ session });
        if (bookmark) params.set('bookmark', bookmark);
        const payload = await requestJson(`${BACKEND_ROOT}/pinterest/boards?${params.toString()}`);
        boards.push(...(Array.isArray(payload.items) ? payload.items : []));
        bookmark = typeof payload.bookmark === 'string' ? payload.bookmark : undefined;
      } while (bookmark && boards.length < 200);
      setPinterestBoards(boards);
    } catch (boardsError) {
      setError(boardsError instanceof Error ? boardsError.message : 'Pinterest could not load your boards.');
    }
  }

  const choosePinterestBoard = (boardId: string) => {
    if (!pinterestSession || boardId === selectedPinterestBoard) return;
    setSelectedPinterestBoard(boardId);
    setItems([]); setPinterestBookmark(undefined); setQuery('');
    loadPinterest(pinterestSession, boardId);
  };

  const connectPinterest = async () => {
    if (!BACKEND_ROOT) return setError('Image discovery needs the Luku service connection.');
    setBusy(true); setError('');
    try {
      const payload = await requestJson(`${BACKEND_ROOT}/pinterest/session`, { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' });
      const auth = await WebBrowser.openAuthSessionAsync(payload.authorization_url, 'luku://pinterest-auth');
      if (auth.type !== 'success' || !auth.url) return;
      const callback = new URL(auth.url);
      const session = callback.searchParams.get('session');
      if (!session) throw new Error('Pinterest connection was not completed. Please try again.');
      await AsyncStorage.setItem('luku.pinterestSession', session);
      setSelectedPinterestBoard('all');
      await Promise.all([loadPinterest(session, 'all'), loadPinterestBoards(session)]);
    } catch (connectError) {
      setError(connectError instanceof Error ? connectError.message : 'Pinterest connection failed.');
    } finally { setBusy(false); }
  };

  const disconnectPinterest = async () => {
    const session = pinterestSession;
    setPinterestSession(undefined); setItems([]); setError('');
    setPinterestBoards([]); setSelectedPinterestBoard('all'); setPinterestBookmark(undefined);
    await AsyncStorage.removeItem('luku.pinterestSession');
    if (BACKEND_ROOT && session) fetch(`${BACKEND_ROOT}/pinterest/session?session=${encodeURIComponent(session)}`, { method:'DELETE' }).catch(() => undefined);
  };

  const searchBing = () => {
    if (!query.trim()) return setError('Enter what you want to find.');
    setError('');
    setBingUrl(`https://www.bing.com/images/search?q=${encodeURIComponent(query.trim())}&safeSearch=Strict`);
  };

  const useBingImage = (result: ImageResult) => {
    if (!/^https:\/\//i.test(result.image_url)) {
      setError('That Bing image could not be selected. Try another result.');
      return;
    }
    setError('');
    onChoose(result, 'bing');
  };

  const receiveBingImage = (event: WebViewMessageEvent) => {
    try {
      const payload = JSON.parse(event.nativeEvent.data) as ImageResult & { type?:string };
      if (payload.type !== 'luku-bing-image' || !/^https:\/\//i.test(payload.image_url)) return;
      useBingImage(payload);
    } catch {
      setError('That Bing image could not be selected. Try another result.');
    }
  };

  const interceptBingNavigation = (request: { url: string }) => {
    try {
      const nextUrl = new URL(request.url);
      const imageUrl = nextUrl.searchParams.get('mediaurl');
      if (nextUrl.searchParams.get('view') !== 'detailV2' || !imageUrl) return true;
      const thumbnail = nextUrl.searchParams.get('cdnurl') || imageUrl;
      useBingImage({
        id: nextUrl.searchParams.get('id') || imageUrl,
        title: `${query.trim() || 'Bing'} image inspiration`,
        source: 'Bing Images',
        image_url: imageUrl,
        thumbnail_url: thumbnail,
      });
      return false;
    } catch {
      return true;
    }
  };

  const shownItems = source === 'pinterest' && query.trim()
    ? items.filter(item => `${item.title} ${item.description || ''} ${item.source}`.toLowerCase().includes(query.trim().toLowerCase()))
    : items;

  const changeSource = (next: DiscoverySource) => {
    setSource(next); setItems([]); setError('');
    if (next === 'pinterest') {
      AsyncStorage.getItem('luku.pinterestSession').then(session => {
        if (!session) return setPinterestSession(undefined);
        setSelectedPinterestBoard('all');
        Promise.all([loadPinterest(session, 'all'), loadPinterestBoards(session)]);
      });
    }
  };

  return <Modal visible={visible} animationType="slide" onRequestClose={onClose}><SafeAreaView style={styles.discoveryPage} edges={['top','right','bottom','left']}>
    <View style={styles.discoveryHeader}><Pressable onPress={onClose} style={styles.iconButton}><Ionicons name="close" size={22}/></Pressable><View><Text style={styles.discoveryHeaderTitle}>Find inspiration</Text><Text style={styles.discoveryHeaderCopy}>Choose an image without leaving Luku</Text></View><View style={styles.headerSpacer}/></View>
    <View style={styles.discoveryTabs}><Pressable onPress={()=>changeSource('bing')} style={[styles.discoveryTab,source==='bing'&&styles.discoveryTabOn]}><Text style={[styles.discoveryTabText,source==='bing'&&styles.discoveryTabTextOn]}>Bing Images</Text></Pressable><Pressable onPress={()=>changeSource('pinterest')} style={[styles.discoveryTab,source==='pinterest'&&styles.discoveryTabOn]}><Text style={[styles.discoveryTabText,source==='pinterest'&&styles.discoveryTabTextOn]}>Pinterest</Text></Pressable></View>
    {source === 'pinterest' && !pinterestSession ? <View style={styles.connectCard}><View style={[styles.discoveryLogo,{backgroundColor:'#BD081C'}]}><Text style={styles.discoveryLogoText}>P</Text></View><Text style={styles.connectTitle}>Add a Pin to your look</Text><Text style={styles.connectCopy}>Connect Pinterest, choose one of your Pins, and add it directly to Luku. Nothing needs to be saved to your gallery.</Text><Pressable disabled={busy} onPress={connectPinterest} style={[styles.primary,styles.connectButton,busy&&styles.disabledButton]}>{busy?<ActivityIndicator color="#fff"/>:<><Ionicons name="logo-pinterest" size={20} color="#fff"/><Text style={styles.primaryText}>Connect Pinterest</Text></>}</Pressable></View> : <>
      <View style={styles.searchRow}><TextInput value={query} onChangeText={setQuery} onSubmitEditing={source==='bing'?searchBing:undefined} placeholder={source==='pinterest'?'Filter your Pins':'Search outfits, dresses, hairstyles…'} placeholderTextColor="#9E8790" style={styles.searchInput} returnKeyType="search"/><Pressable disabled={busy||source==='pinterest'} onPress={searchBing} style={[styles.searchButton,source==='pinterest'&&styles.filterButton]}>{busy?<ActivityIndicator color="#fff"/>:<Ionicons name={source==='bing'?'search':'funnel-outline'} size={20} color="#fff"/>}</Pressable></View>
      {source==='pinterest'&&<View style={styles.connectedRow}><View style={styles.connectedDot}/><Text style={styles.connectedText}>Pinterest connected</Text><Pressable onPress={disconnectPinterest}><Text style={styles.disconnectText}>Disconnect</Text></Pressable></View>}
      {source==='pinterest'&&<ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.boardChips}>
        <Pressable onPress={()=>choosePinterestBoard('all')} style={[styles.boardChip,selectedPinterestBoard==='all'&&styles.boardChipOn]}><Text style={[styles.boardChipText,selectedPinterestBoard==='all'&&styles.boardChipTextOn]}>All Pins</Text></Pressable>
        {pinterestBoards.map(board=><Pressable key={board.id} onPress={()=>choosePinterestBoard(board.id)} style={[styles.boardChip,selectedPinterestBoard===board.id&&styles.boardChipOn]}><Text numberOfLines={1} style={[styles.boardChipText,selectedPinterestBoard===board.id&&styles.boardChipTextOn]}>{board.name}{board.pin_count ? ` · ${board.pin_count}` : ''}</Text></Pressable>)}
      </ScrollView>}
    </>}
    {source==='bing'&&<View style={styles.bingNotice}><Ionicons name="hand-left-outline" size={21} color="#008373"/><Text style={styles.bingNoticeText}>Tap any Bing result to use it instantly. No download or gallery save needed.</Text></View>}
    {!!error && <View style={styles.discoveryError}><Ionicons name="alert-circle-outline" size={20} color="#9C3157"/><Text style={styles.discoveryErrorText}>{error}</Text></View>}
    {source==='bing' && bingUrl ? <View style={styles.bingWebWrap}>
      <WebView source={{uri:bingUrl}} style={styles.bingWebView} javaScriptEnabled domStorageEnabled thirdPartyCookiesEnabled sharedCookiesEnabled injectedJavaScript={BING_IMAGE_SELECTOR_SCRIPT} onMessage={receiveBingImage} onShouldStartLoadWithRequest={interceptBingNavigation} onLoadStart={()=>setBingLoading(true)} onLoadProgress={event=>{if(event.nativeEvent.progress>=.7)setBingLoading(false);}} onLoadEnd={()=>setBingLoading(false)} onError={()=>setError('Bing Images could not load. Check your internet connection and try again.')} />
      {bingLoading&&<View style={styles.bingLoading}><ActivityIndicator size="large" color="#008373"/><Text style={styles.bingLoadingText}>Loading Bing Images…</Text></View>}
    </View> : <ScrollView contentContainerStyle={styles.imageGrid} showsVerticalScrollIndicator={false}>
        {!busy && !error && pinterestSession && source==='pinterest' && shownItems.length===0 && <View style={styles.discoveryEmpty}><Ionicons name="images-outline" size={34} color="#B78397"/><Text style={styles.discoveryEmptyText}>No matching Pins found. Save a fashion Pin on Pinterest, then reconnect to refresh this list.</Text></View>}
        {shownItems.map(item=><Pressable key={item.id} accessibilityLabel={`Use ${item.title}`} onPress={()=>onChoose(item,source)} style={styles.imageResult}><Image source={{uri:item.thumbnail_url||item.image_url}} style={styles.imageResultPhoto} resizeMode="cover"/><View style={styles.imageResultCopy}><Text numberOfLines={2} style={styles.imageResultTitle}>{item.title}</Text><Text numberOfLines={1} style={styles.imageResultSource}>{item.source}</Text></View><View style={styles.useImageBadge}><Ionicons name="add" size={17} color="#fff"/></View></Pressable>)}
        {source==='pinterest'&&pinterestBookmark&&<Pressable disabled={busy} onPress={()=>pinterestSession&&loadPinterest(pinterestSession,selectedPinterestBoard,pinterestBookmark)} style={styles.loadMoreButton}>{busy?<ActivityIndicator color="#7A2E4C"/>:<><Ionicons name="add-circle-outline" size={18} color="#7A2E4C"/><Text style={styles.loadMoreText}>Load more Pins</Text></>}</Pressable>}
      </ScrollView>}
    <Text style={styles.permissionNotice}>Only choose images you own or have permission to use.</Text>
  </SafeAreaView></Modal>;
}

function WebImagePicker({ visible, onClose, onChoose }: { visible:boolean; onClose:()=>void; onChoose:(item:ImageResult)=>void }) {
  const webRef = useRef<WebView>(null);
  const [address, setAddress] = useState('https://www.bing.com/shop');
  const [loadedAddress, setLoadedAddress] = useState('https://www.bing.com/shop');
  const [picking, setPicking] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (!visible) setPicking(false); }, [visible]);
  const navigate = () => {
    let next = address.trim();
    if (!/^https?:\/\//i.test(next)) next = `https://${next}`;
    if (!/^https:\/\//i.test(next)) return setError('For your safety, Luku can open secure HTTPS websites only.');
    setError(''); setAddress(next); setLoadedAddress(next);
  };
  const setPickMode = (next: boolean) => {
    setPicking(next);
    webRef.current?.injectJavaScript(`window.__lukuSetPicking && window.__lukuSetPicking(${next}); true;`);
  };
  const receiveImage = (event: WebViewMessageEvent) => {
    try {
      const item = JSON.parse(event.nativeEvent.data) as ImageResult & { type?:string };
      if (item.type !== 'luku-web-image' || !/^https:\/\//i.test(item.image_url)) throw new Error();
      setPickMode(false); onChoose(item);
    } catch { setError('That image could not be selected. Try another product image.'); }
  };
  return <Modal visible={visible} animationType="slide" onRequestClose={onClose}><SafeAreaView style={styles.discoveryPage} edges={['top','right','bottom','left']}>
    <View style={styles.discoveryHeader}><Pressable onPress={onClose} style={styles.iconButton}><Ionicons name="close" size={22}/></Pressable><View><Text style={styles.discoveryHeaderTitle}>Browse a store</Text><Text style={styles.discoveryHeaderCopy}>Open a website, then pick its product image</Text></View><View style={styles.headerSpacer}/></View>
    <View style={styles.webAddressRow}><TextInput value={address} onChangeText={setAddress} onSubmitEditing={navigate} autoCapitalize="none" autoCorrect={false} keyboardType="url" returnKeyType="go" selectTextOnFocus style={styles.webAddressInput}/><Pressable onPress={navigate} style={styles.webGoButton}><Ionicons name="arrow-forward" size={21} color="#fff"/></Pressable></View>
    {!!error && <View style={styles.discoveryError}><Ionicons name="alert-circle-outline" size={20} color="#9C3157"/><Text style={styles.discoveryErrorText}>{error}</Text></View>}
    {picking && <View style={styles.pickBanner}><Ionicons name="hand-left-outline" size={20} color="#fff"/><Text style={styles.pickBannerText}>Tap the product image you want to try</Text></View>}
    <View style={styles.webPickerFrame}><WebView ref={webRef} source={{uri:loadedAddress}} style={styles.bingWebView} javaScriptEnabled domStorageEnabled sharedCookiesEnabled thirdPartyCookiesEnabled injectedJavaScript={WEB_IMAGE_PICKER_SCRIPT} onMessage={receiveImage} onNavigationStateChange={state => { setAddress(state.url); setLoading(state.loading); }} onLoadStart={() => setLoading(true)} onLoadEnd={() => { setLoading(false); if (picking) setPickMode(true); }} onShouldStartLoadWithRequest={request => /^https:\/\//i.test(request.url) || request.url === 'about:blank'} onError={() => setError('This website could not load. Check the address or your connection.')} />{loading && <View style={styles.webLoading}><ActivityIndicator size="large" color="#8D3A5A"/></View>}</View>
    <View style={styles.webPickerFooter}><Text style={styles.webPickerHelp}>{picking ? 'Images are highlighted. Tap one to use it directly.' : 'When you find an outfit or accessory, start image selection.'}</Text><Pressable onPress={() => setPickMode(!picking)} style={[styles.primary,styles.webPickButton,picking&&styles.webPickButtonOn]}><Ionicons name={picking?'close':'scan-outline'} size={20} color="#fff"/><Text style={styles.primaryText}>{picking?'Cancel selection':'Pick an image'}</Text></Pressable></View>
  </SafeAreaView></Modal>;
}

function Wardrobe({ items, onOpen, onRemove }: { items:WardrobeItem[]; onOpen:(item:WardrobeItem)=>void; onRemove:(item:WardrobeItem)=>void }) {
  return <ScrollView contentContainerStyle={styles.page} showsVerticalScrollIndicator={false}>
    <Text style={styles.eyebrow}>SAVED ON THIS DEVICE</Text><Text style={styles.title}>Your Wardrobe.</Text><Text style={styles.body}>Open a finished preview again without paying for another generation.</Text>
    {items.length === 0 ? <View style={styles.wardrobeEmpty}><Ionicons name="albums-outline" size={42} color="#B78397"/><Text style={styles.wardrobeEmptyTitle}>Your Wardrobe is empty</Text><Text style={styles.wardrobeEmptyCopy}>Every completed Luku preview will be saved here automatically.</Text></View> : <View style={styles.wardrobeGrid}>{items.map(item => <View key={item.id} style={styles.wardrobeCard}><Pressable onPress={() => onOpen(item)}><Image source={{uri:item.afterUri}} style={styles.wardrobeImage}/><View style={styles.wardrobeTag}><Text style={styles.wardrobeTagText}>{item.category.toUpperCase()}</Text></View></Pressable><View style={styles.wardrobeCardCopy}><View style={{flex:1}}><Text style={styles.wardrobeTitle} numberOfLines={1}>{item.garment.name}</Text><Text style={styles.wardrobeDate}>{new Date(item.createdAt).toLocaleDateString()}</Text></View><Pressable accessibilityLabel={`Remove ${item.garment.name}`} onPress={() => Alert.alert('Remove from Wardrobe?', 'This saved preview will be deleted from Luku on this device.', [{text:'Cancel',style:'cancel'},{text:'Remove',style:'destructive',onPress:()=>onRemove(item)}])} style={styles.wardrobeDelete}><Ionicons name="trash-outline" size={18} color="#A8355D"/></Pressable></View></View>)}</View>}
  </ScrollView>;
}

function Processing({ progress, garment, onCancel }: { progress: number; garment: Garment; onCancel:()=>void }) {
  const rotation = useRef(new Animated.Value(0)).current;
  const player = useAudioPlayer(require('./assets/luku-elevator-loop.m4a'), { updateInterval:250 });
  const audioStatus = useAudioPlayerStatus(player);
  const [musicOn, setMusicOn] = useState(true);
  useEffect(() => {
    const animation = Animated.loop(Animated.timing(rotation, { toValue: 1, duration: 1_150, easing: Easing.linear, useNativeDriver: true }));
    animation.start();
    player.loop = true;
    player.volume = 0.38;
    return () => animation.stop();
  }, [rotation, player]);
  useEffect(() => {
    if (musicOn && audioStatus.isLoaded && !audioStatus.playing) {
      try { player.play(); } catch { /* The screen may be closing while native audio releases. */ }
    }
  }, [audioStatus.isLoaded, audioStatus.playing, musicOn, player]);
  const toggleMusic = () => {
    try {
      if (musicOn) player.pause(); else if (audioStatus.isLoaded) player.play();
      setMusicOn(!musicOn);
    } catch {
      setMusicOn(false);
    }
  };
  const confirmCancel = () => Alert.alert(
    'Cancel this preview?',
    'The generation has already started. Cancelling will still be charged as generating an image.',
    [
      { text:'Keep waiting', style:'cancel' },
      { text:'Cancel and choose another', style:'destructive', onPress:onCancel },
    ],
  );
  const spin = rotation.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  return <LinearGradient colors={['#FFF7FA','#F4D2DF']} style={[styles.fill, styles.center]}>
    <Pressable onPress={toggleMusic} style={styles.musicButton}><Ionicons name={musicOn&&audioStatus.playing?'volume-high-outline':'volume-mute-outline'} size={18} color="#7A2E4C"/><Text style={styles.musicButtonText}>{!musicOn?'Sound off':audioStatus.playing?'Elevator jazz playing':'Starting sound…'}</Text></Pressable>
    <Text style={styles.wordmarkLarge}>LUKU</Text><Animated.View style={[styles.orbit,{transform:[{rotate:spin}]}]}><Ionicons name="sparkles" size={42} color="#B83F6A" /></Animated.View>
    <Text style={styles.titleCenter}>Creating your Luku…</Text><Text style={styles.bodyCenter}>We’re fitting the {garment.name.toLowerCase()} to your photo.</Text>
    <Text style={styles.musicCredit}>Music: “Local Forecast – Elevator” · Kevin MacLeod · CC BY 3.0 · excerpted</Text>
    <View style={styles.progressTrack}><View style={[styles.progressFill,{width:`${progress}%`}]} /></View><Text style={styles.progressText}>{progress}% · usually 15–30 seconds</Text>
    <Pressable accessibilityRole="button" onPress={confirmCancel} style={styles.processingCancel}><Text style={styles.processingCancelText}>Cancel and choose another</Text></Pressable>
    <Text style={styles.processingCancelNote}>Cancelling will still be charged as generating an image.</Text>
  </LinearGradient>;
}

function Result({ photo, resultUrl, garment, showAfter, setShowAfter, onAgain, onSave }: { photo:string; resultUrl?:string; garment:Garment; showAfter:boolean; setShowAfter:(v:boolean)=>void; onAgain:()=>void; onSave:()=>void }) {
  const shareRef = useRef<View>(null);
  const [sliderWidth, setSliderWidth] = useState(1);
  const [reveal, setReveal] = useState(showAfter ? 0.5 : 0);
  const moveSlider = (x: number) => {
    const next = Math.max(0, Math.min(1, x / sliderWidth));
    setReveal(next); setShowAfter(next > 0.02);
  };
  const showSide = (after: boolean) => { setReveal(after ? 1 : 0); setShowAfter(after); };
  const share = async () => {
    try {
      if (!resultUrl) return Alert.alert('Nothing to share', 'Create a preview first.');
      const uri = await captureRef(shareRef, { format:'png', quality:1, result:'tmpfile' });
      if (!(await Sharing.isAvailableAsync())) return Alert.alert('Sharing unavailable', 'Sharing is not available on this device.');
      await Sharing.shareAsync(uri, { mimeType:'image/png', dialogTitle:'Share your Luku before and after' });
    } catch (error) { Alert.alert('Could not share image', error instanceof Error ? error.message : 'Please try again.'); }
  };
  return <ScrollView contentContainerStyle={styles.resultPage}>
    <Text style={styles.eyebrow}>YOUR LUKU</Text><Text style={styles.title}>Now you can decide.</Text>
    <View ref={shareRef} collapsable={false} onLayout={event => setSliderWidth(event.nativeEvent.layout.width)} onStartShouldSetResponder={() => true} onMoveShouldSetResponder={() => true} onResponderGrant={event => moveSlider(event.nativeEvent.locationX)} onResponderMove={event => moveSlider(event.nativeEvent.locationX)} style={styles.resultImageWrap}><Image source={{uri:photo}} style={styles.resultImage} resizeMode="cover"/><View style={[styles.resultAfterClip,{width:`${reveal*100}%`}]}><Image source={{uri:resultUrl || photo}} style={[styles.resultAfterImage,{width:sliderWidth}]} resizeMode="cover"/>{!resultUrl && <LinearGradient colors={[`${garment.colors[0]}22`,`${garment.colors[1]}99`]} style={styles.tryOnOverlay}><Text style={styles.overlayLabel}>DEMO PREVIEW</Text></LinearGradient>}</View><View style={[styles.resultDivider,{left:`${reveal*100}%`}]}><View style={styles.resultHandle}><Ionicons name="swap-horizontal" size={19} color="#7A2E4C"/></View></View><View style={styles.beforeLabel}><Text style={styles.resultLabelText}>BEFORE</Text></View><View style={styles.afterLabel}><Text style={styles.resultLabelText}>AFTER</Text></View><View style={styles.watermark}><Text style={styles.watermarkText}>LUKU</Text></View></View>
    <Text style={styles.sliderHint}>Drag the slider to compare before and after</Text>
    <View style={styles.toggle}><Pressable onPress={() => showSide(false)} style={[styles.toggleSide,!showAfter&&styles.toggleOn]}><Text style={!showAfter?styles.toggleOnText:styles.toggleText}>Before</Text></Pressable><Pressable onPress={() => showSide(true)} style={[styles.toggleSide,showAfter&&styles.toggleOn]}><Text style={showAfter?styles.toggleOnText:styles.toggleText}>After</Text></Pressable></View>
    <View style={styles.resultMeta}><View><Text style={styles.garmentName}>{garment.name}</Text><Text style={styles.maker}>{garment.maker}</Text></View><Text style={styles.price}>{garment.price}</Text></View>
    <View style={styles.actions}><Pressable style={styles.action} onPress={share}><Ionicons name="share-outline" size={22}/><Text>Share image</Text></Pressable><Pressable style={styles.action} onPress={onSave}><Ionicons name="download-outline" size={22}/><Text>Save to device</Text></Pressable></View>
    <Pressable style={styles.secondary} onPress={onAgain}><Text style={styles.secondaryText}>Try another look</Text></Pressable>
    <Text style={styles.disclaimer}>Virtual previews help with style decisions; they do not predict physical fit or sizing.</Text>
  </ScrollView>;
}

function Retailer({ items, onTry }: { items:Garment[]; onTry:(g:Garment)=>void }) {
  return <ScrollView contentContainerStyle={styles.page}><View style={styles.storeHero}><Text style={styles.storeInitial}>Z</Text></View><Text style={styles.eyebrow}>LUKU RETAILER</Text><Text style={styles.title}>Zuri Studio</Text><Text style={styles.body}>Contemporary African pieces, designed and made in Nairobi.</Text><View style={styles.storeStats}><Text style={styles.storeStat}>Westlands, Nairobi</Text><Text style={styles.storeStat}>{items.length} try-on pieces</Text></View><Text style={styles.sectionLabel}>TRY BEFORE YOU BUY</Text>{items.map(g=><Pressable key={g.id} style={styles.garmentCard} onPress={()=>onTry(g)}><LinearGradient colors={g.colors} style={styles.garmentArt}><Text style={styles.garmentIcon}>{g.icon}</Text></LinearGradient><View style={styles.garmentCopy}><Text style={styles.garmentName}>{g.name}</Text><Text style={styles.price}>{g.price}</Text><Text style={styles.tryLink}>Try this piece →</Text></View></Pressable>)}<View style={styles.qrConcept}><QRCode value="https://luku.app/zuri-studio" size={54} color="#4B2031" backgroundColor="transparent"/><View><Text style={styles.garmentName}>Scan. Try. Decide.</Text><Text style={styles.maker}>This QR opens Zuri Studio’s collection.</Text></View></View></ScrollView>;
}

function BusinessDashboard({ items, savedCount, onUpload, onLink, onRemove, onCustomer }: { items:Garment[]; savedCount:number; onUpload:()=>void; onLink:()=>void; onRemove:(id:string)=>void; onCustomer: () => void }) {
  const action = (title: string, message: string) => Alert.alert(title, message);
  return <ScrollView contentContainerStyle={styles.businessPage}>
    <View style={styles.businessTop}><View><Text style={styles.wordmarkLarge}>LUKU</Text><Text style={styles.businessMode}>BUSINESS MODE</Text></View><Pressable onPress={onCustomer} style={styles.customerSwitch}><Ionicons name="person-outline" size={16} color="#7A2E4C" /><Text style={styles.customerSwitchText}>Customer</Text></Pressable></View>
    <View style={styles.businessHero}><View style={styles.businessLogo}><Text style={styles.businessLogoText}>Z</Text></View><View style={{flex:1}}><Text style={styles.businessName}>Zuri Studio</Text><Text style={styles.businessMeta}>Fashion retailer · Westlands</Text><View style={styles.liveBadge}><View style={styles.liveDot}/><Text style={styles.liveText}>Profile live</Text></View></View><Pressable onPress={() => action('Edit profile','Business profile editing is ready for backend persistence.')} style={styles.editCircle}><Ionicons name="pencil" size={16} color="#7A2E4C" /></Pressable></View>
    <Text style={styles.businessGreeting}>Good afternoon, Zuri.</Text><Text style={styles.body}>Manage what customers can preview and share your Luku fitting room.</Text>
    <View style={styles.metricRow}><View style={styles.metricCard}><Text style={styles.metricValue}>{items.length}</Text><Text style={styles.metricLabel}>PUBLISHED</Text><Text style={styles.metricTrend}>Live catalog</Text></View><View style={styles.metricCard}><Text style={styles.metricValue}>{savedCount}</Text><Text style={styles.metricLabel}>SAVED LOOKS</Text><Text style={styles.metricTrend}>On this device</Text></View></View>
    <Pressable style={styles.qrCard} onPress={() => Share.share({message:'Try Zuri Studio on Luku: https://luku.app/zuri-studio'})}><View style={styles.qrTile}><QRCode value="https://luku.app/zuri-studio" size={58} color="#4B2031" /></View><View style={{flex:1}}><Text style={styles.qrEyebrow}>YOUR STORE QR</Text><Text style={styles.qrTitle}>Bring try-on in-store.</Text><Text style={styles.qrBody}>Place this on your mirror, counter or Instagram.</Text><Text style={styles.qrLink}>Share store link →</Text></View></Pressable>
    <View style={styles.businessSectionHead}><View><Text style={styles.sectionLabel}>YOUR TRY-ON CATALOG</Text><Text style={styles.catalogCount}>{items.length} published pieces</Text></View></View><View style={styles.addMethods}><Pressable onPress={onUpload} style={styles.addMethod}><Ionicons name="cloud-upload-outline" size={18} color="#7A2E4C"/><Text style={styles.addMethodText}>Upload image</Text></Pressable><Pressable onPress={onLink} style={styles.addMethod}><Ionicons name="link" size={18} color="#7A2E4C"/><Text style={styles.addMethodText}>Paste link</Text></Pressable></View>
    {items.map((g,index) => <View key={g.id} style={styles.businessItem}><LinearGradient colors={g.colors} style={styles.businessItemArt}><Text style={styles.garmentIcon}>{g.icon}</Text></LinearGradient><View style={{flex:1}}><Text style={styles.garmentName}>{g.name}</Text><Text style={styles.maker}>{index === 0 ? 'Featured · Published' : 'Published'}</Text></View><Pressable onPress={() => onRemove(g.id)} style={styles.moreButton}><Ionicons name="trash-outline" size={19} color="#A8355D" /></Pressable></View>)}
    <View style={styles.businessNav}><View style={styles.businessNavItem}><Ionicons name="grid" size={20} color="#8D3A5A"/><Text style={styles.businessNavActive}>Home</Text></View><Pressable style={styles.businessNavItem} onPress={() => action('Catalog','Your published try-on pieces are shown above.')}><Ionicons name="shirt-outline" size={20} color="#947985"/><Text style={styles.businessNavText}>Catalog</Text></Pressable><Pressable style={styles.businessNavItem} onPress={() => action('Activity','Detailed preview activity will appear here after Supabase is connected.')}><Ionicons name="pulse-outline" size={20} color="#947985"/><Text style={styles.businessNavText}>Activity</Text></Pressable></View>
  </ScrollView>;
}

const businessStyles = {
  headerSpacer:{width:40,height:40},
  homeScroll:{flexGrow:1},
  homeGradient:{flexGrow:1,minHeight:780,paddingTop:4,paddingBottom:30,backgroundColor:'#FFF9F4'},
  brandLockup:{flexDirection:'row' as const,alignItems:'center' as const,gap:10},
  brandIcon:{width:42,height:42,borderRadius:14},
  brandCaption:{fontSize:7,fontWeight:'900' as const,letterSpacing:1.2,color:'#A35B75',marginTop:3},
  homeIntro:{width:'100%' as const,maxWidth:480,alignSelf:'center' as const,paddingHorizontal:24,paddingTop:3,paddingBottom:15},
  homeSectionTitle:{fontSize:18,fontWeight:'900' as const,color:'#4B2031',marginBottom:13},
  heroSlider:{width:'88%' as const,maxWidth:420,height:315,alignSelf:'center' as const,borderRadius:28,backgroundColor:'#E6D2C5',overflow:'hidden' as const,...Platform.select({web:{boxShadow:'0 12px 28px rgba(76,33,49,0.14)'},default:{shadowColor:'#4C2131',shadowOpacity:.16,shadowRadius:18,elevation:7}})},
  heroDiptych:{position:'absolute' as const,top:0,height:'100%' as const},
  heroAfterClip:{position:'absolute' as const,left:0,top:0,bottom:0,overflow:'hidden' as const},
  sliderLine:{position:'absolute' as const,top:0,bottom:0,width:2,backgroundColor:'#fff'},
  sliderKnob:{position:'absolute' as const,left:-26,top:'46%' as const,width:54,height:54,borderRadius:27,backgroundColor:'#fff',flexDirection:'row' as const,alignItems:'center' as const,justifyContent:'center' as const,...Platform.select({web:{boxShadow:'0 3px 10px rgba(50,20,32,0.28)'},default:{shadowColor:'#321420',shadowOpacity:.28,shadowRadius:8,elevation:6}})},
  beforeBadge:{position:'absolute' as const,left:12,top:12,borderRadius:12,backgroundColor:'#24171AAA',paddingHorizontal:9,paddingVertical:6},
  afterBadge:{position:'absolute' as const,right:12,top:12,borderRadius:12,backgroundColor:'#6B2944DD',paddingHorizontal:9,paddingVertical:6},
  sliderBadgeText:{fontSize:8,fontWeight:'900' as const,letterSpacing:1.2,color:'#fff'},
  homeSliderControls:{height:48,alignSelf:'center' as const,marginTop:-24,zIndex:4,backgroundColor:'#fff',padding:4,borderRadius:24,flexDirection:'row' as const,...Platform.select({web:{boxShadow:'0 4px 12px rgba(76,33,49,0.14)'},default:{shadowColor:'#4C2131',shadowOpacity:.16,shadowRadius:10,elevation:6}})},
  homeSliderButton:{minWidth:112,height:40,borderRadius:20,alignItems:'center' as const,justifyContent:'center' as const},
  homeSliderButtonOn:{backgroundColor:'#7A2E4C'},
  homeSliderButtonText:{fontSize:13,fontWeight:'900' as const,color:'#6A5360'},
  homeSliderButtonTextOn:{color:'#fff'},
  heroBadge:{position:'absolute' as const,bottom:13,alignSelf:'center' as const,backgroundColor:'#63213E',height:31,borderRadius:16,paddingHorizontal:13,flexDirection:'row' as const,alignItems:'center' as const,gap:6},
  heroBadgeText:{fontSize:9,fontWeight:'900' as const,letterSpacing:1,color:'#fff'},
  homeBody:{fontSize:14,lineHeight:20,color:'#745F68',marginTop:7},
  tapHint:{fontSize:12,color:'#8B7480',marginTop:8,marginBottom:16},
  heroLogo:{width:'100%' as const,height:'100%' as const},
  homeCategories:{flexDirection:'row' as const,gap:10,marginTop:4,marginBottom:4},
  homeCategory:{flex:1,minHeight:122,borderRadius:21,backgroundColor:'#fff',alignItems:'center' as const,justifyContent:'center' as const,gap:4,borderWidth:1,borderColor:'#E8CDD8',paddingHorizontal:6,paddingVertical:12},
  homeCategoryPressed:{transform:[{scale:.97}],backgroundColor:'#FDF1F5'},
  homeCategoryDisabled:{opacity:.62,backgroundColor:'#F4EFF1'},
  homeCategoryIcon:{width:39,height:39,borderRadius:13,backgroundColor:'#F6DCE6',alignItems:'center' as const,justifyContent:'center' as const,marginBottom:3},
  homeCategoryText:{fontSize:12,fontWeight:'900' as const,color:'#5E293D'},
  homeCategorySub:{fontSize:9,color:'#927783',textAlign:'center' as const},
  comingSoonBadge:{marginTop:4,paddingHorizontal:7,paddingVertical:4,borderRadius:8,backgroundColor:'#E4D7DC'},
  comingSoonText:{fontSize:7,fontWeight:'900' as const,letterSpacing:.6,color:'#765C66'},
  categoryChevron:{marginTop:4},
  homePrimary:{minHeight:70,borderRadius:20,backgroundColor:'#63213E',paddingHorizontal:20,paddingVertical:12,marginTop:18,flexDirection:'row' as const,alignItems:'center' as const,justifyContent:'space-between' as const},
  homePrimaryText:{fontSize:16,fontWeight:'900' as const,color:'#fff'},
  homePrimarySub:{fontSize:10,color:'#EFC8D7',marginTop:3},
  homeArrow:{width:38,height:38,borderRadius:19,backgroundColor:'#fff',alignItems:'center' as const,justifyContent:'center' as const},
  trustRow:{flexDirection:'row' as const,alignItems:'center' as const,justifyContent:'center' as const,gap:8,marginTop:16,paddingHorizontal:8},
  trustText:{fontSize:10,color:'#806873'},
  retailerLink:{minHeight:56,borderRadius:17,backgroundColor:'#F6DCE6',paddingHorizontal:16,paddingVertical:10,marginTop:22,flexDirection:'row' as const,alignItems:'center' as const,gap:10},
  retailerLinkText:{flex:1,fontSize:12,fontWeight:'800' as const,color:'#6D344A'},
  categoryCard:{minHeight:94,borderRadius:21,backgroundColor:'#fff',padding:15,marginTop:12,flexDirection:'row' as const,alignItems:'center' as const,gap:13,borderWidth:1,borderColor:'#EDD4DE'},
  categoryIcon:{width:50,height:50,borderRadius:16,backgroundColor:'#F9E1EA',alignItems:'center' as const,justifyContent:'center' as const},
  categoryTitle:{fontSize:17,fontWeight:'900' as const,color:'#4B2031'},
  categoryCopy:{fontSize:12,lineHeight:17,color:'#806873',marginTop:4},
  categoryNote:{marginTop:20,borderRadius:18,backgroundColor:'#F8DDE7',padding:15,flexDirection:'row' as const,alignItems:'center' as const,gap:10},
  categoryNoteText:{flex:1,fontSize:12,lineHeight:18,color:'#6F5260'},
  modePill:{height:36,paddingHorizontal:13,borderRadius:18,backgroundColor:'#fff',flexDirection:'row' as const,alignItems:'center' as const,gap:6,borderWidth:1,borderColor:'#E8CDD8'},
  modePillText:{fontSize:12,fontWeight:'800' as const,color:'#7A2E4C'},
  businessPage:{padding:22,paddingBottom:110,backgroundColor:'#FFF9FB'},
  businessTop:{flexDirection:'row' as const,alignItems:'center' as const,justifyContent:'space-between' as const,marginBottom:24},
  businessMode:{fontSize:9,fontWeight:'900' as const,letterSpacing:1.8,color:'#B83F6A',marginTop:5},
  customerSwitch:{height:38,paddingHorizontal:13,borderRadius:19,backgroundColor:'#fff',flexDirection:'row' as const,alignItems:'center' as const,gap:6,borderWidth:1,borderColor:'#E8CDD8'},
  customerSwitchText:{fontSize:12,fontWeight:'800' as const,color:'#7A2E4C'},
  businessHero:{flexDirection:'row' as const,alignItems:'center' as const,gap:13,backgroundColor:'#fff',padding:13,borderRadius:20,marginBottom:25},
  businessLogo:{width:52,height:52,borderRadius:16,backgroundColor:'#7A2E4C',alignItems:'center' as const,justifyContent:'center' as const},
  businessLogoText:{fontSize:27,fontWeight:'900' as const,color:'#FFD4E3'},
  businessName:{fontSize:16,fontWeight:'900' as const,color:'#4B2031'},
  businessMeta:{fontSize:11,color:'#8B7480',marginTop:3},
  liveBadge:{flexDirection:'row' as const,alignItems:'center' as const,gap:5,marginTop:6},
  liveDot:{width:6,height:6,borderRadius:3,backgroundColor:'#42A676'},
  liveText:{fontSize:10,fontWeight:'700' as const,color:'#56806A'},
  editCircle:{width:34,height:34,borderRadius:17,backgroundColor:'#F9E8EE',alignItems:'center' as const,justifyContent:'center' as const},
  businessGreeting:{fontSize:30,lineHeight:35,fontWeight:'900' as const,color:'#4B2031',letterSpacing:-1},
  metricRow:{flexDirection:'row' as const,gap:10,marginBottom:16},
  metricCard:{flex:1,backgroundColor:'#fff',borderRadius:18,padding:17},
  metricValue:{fontSize:29,fontWeight:'900' as const,color:'#4B2031'},
  metricLabel:{fontSize:9,fontWeight:'900' as const,letterSpacing:1.3,color:'#9A818B',marginTop:3},
  metricTrend:{fontSize:10,fontWeight:'700' as const,color:'#B83F6A',marginTop:10},
  qrCard:{flexDirection:'row' as const,alignItems:'center' as const,gap:16,backgroundColor:'#F4D2DF',borderRadius:22,padding:16},
  qrTile:{width:82,height:82,borderRadius:16,backgroundColor:'#fff',alignItems:'center' as const,justifyContent:'center' as const},
  qrEyebrow:{fontSize:9,fontWeight:'900' as const,letterSpacing:1.3,color:'#A8355D'},
  qrTitle:{fontSize:17,fontWeight:'900' as const,color:'#4B2031',marginTop:4},
  qrBody:{fontSize:11,lineHeight:16,color:'#765C66',marginTop:4},
  qrLink:{fontSize:11,fontWeight:'900' as const,color:'#8D3A5A',marginTop:8},
  businessSectionHead:{flexDirection:'row' as const,alignItems:'center' as const,justifyContent:'space-between' as const,marginTop:12,marginBottom:8},
  catalogCount:{fontSize:11,color:'#8B7480',marginTop:-4},
  addButton:{height:36,borderRadius:18,paddingHorizontal:14,backgroundColor:'#7A2E4C',flexDirection:'row' as const,alignItems:'center' as const,gap:4},
  addButtonText:{fontSize:12,fontWeight:'900' as const,color:'#fff'},
  businessItem:{minHeight:78,flexDirection:'row' as const,alignItems:'center' as const,gap:12,backgroundColor:'#fff',padding:9,borderRadius:17,marginBottom:9},
  businessItemArt:{width:60,height:60,borderRadius:12,alignItems:'center' as const,justifyContent:'center' as const},
  moreButton:{width:34,height:34,borderRadius:17,alignItems:'center' as const,justifyContent:'center' as const},
  businessNav:{position:'absolute' as const,left:20,right:20,bottom:18,height:68,borderRadius:22,backgroundColor:'#fff',flexDirection:'row' as const,alignItems:'center' as const,justifyContent:'space-around' as const,...Platform.select({web:{boxShadow:'0 6px 14px rgba(90,36,57,0.12)'},default:{shadowColor:'#5A2439',shadowOpacity:.12,shadowRadius:14,elevation:6}})},
  businessNavItem:{alignItems:'center' as const,gap:4,minWidth:70},
  businessNavActive:{fontSize:10,fontWeight:'900' as const,color:'#8D3A5A'},
  businessNavText:{fontSize:10,fontWeight:'700' as const,color:'#947985'},
  addMethods:{flexDirection:'row' as const,gap:9,marginBottom:12},
  addMethod:{flex:1,height:46,borderRadius:15,backgroundColor:'#F9E8EE',flexDirection:'row' as const,alignItems:'center' as const,justifyContent:'center' as const,gap:7,borderWidth:1,borderColor:'#E8CDD8'},
  addMethodText:{fontSize:12,fontWeight:'800' as const,color:'#7A2E4C'},
  linkLookButton:{minHeight:72,borderRadius:18,backgroundColor:'#F9E1EA',flexDirection:'row' as const,alignItems:'center' as const,gap:11,padding:12,marginBottom:11,borderWidth:1,borderColor:'#E9C6D4'},
  linkLookIcon:{width:42,height:42,borderRadius:13,backgroundColor:'#fff',alignItems:'center' as const,justifyContent:'center' as const},
  modalShade:{flex:1,backgroundColor:'#35152288',justifyContent:'flex-end' as const},
  linkSheet:{backgroundColor:'#FFF9FB',borderTopLeftRadius:30,borderTopRightRadius:30,padding:24,paddingBottom:34},
  sheetHandle:{width:42,height:4,borderRadius:2,backgroundColor:'#D8B8C5',alignSelf:'center' as const,marginBottom:20},
  linkSheetHead:{flexDirection:'row' as const,justifyContent:'space-between' as const,alignItems:'flex-start' as const},
  linkSheetTitle:{fontSize:25,fontWeight:'900' as const,color:'#4B2031',marginTop:-3},
  categoryToggle:{flexDirection:'row' as const,gap:8,marginBottom:14},
  categoryChoice:{flex:1,height:46,borderRadius:15,borderWidth:1,borderColor:'#E0C7D1',backgroundColor:'#fff',flexDirection:'row' as const,alignItems:'center' as const,justifyContent:'center' as const,gap:7},
  categoryChoiceOn:{backgroundColor:'#7A2E4C',borderColor:'#7A2E4C'},
  categoryChoiceText:{fontSize:13,fontWeight:'800' as const,color:'#7A2E4C'},
  categoryChoiceTextOn:{fontSize:13,fontWeight:'800' as const,color:'#fff'},
  linkInput:{height:56,borderRadius:17,backgroundColor:'#fff',borderWidth:1,borderColor:'#DFC1CD',paddingHorizontal:16,fontSize:14,color:'#4B2031'},
  linkNotice:{fontSize:10,color:'#917B84',textAlign:'center' as const,marginTop:13},
  customerAddRow:{flexDirection:'row' as const,gap:9,marginBottom:10},
  customerAddButton:{flex:1,minHeight:52,borderRadius:16,backgroundColor:'#fff',borderWidth:1,borderColor:'#E4C7D2',flexDirection:'row' as const,alignItems:'center' as const,justifyContent:'center' as const,gap:7},
  customerAddText:{fontSize:12,fontWeight:'800' as const,color:'#7A2E4C'},
  quickHint:{fontSize:13,lineHeight:19,color:'#765C66',marginTop:4,marginBottom:16},
  fastAddStack:{gap:10,marginBottom:6},
  fastAddPrimary:{minHeight:76,borderRadius:20,backgroundColor:'#63213E',paddingHorizontal:15,flexDirection:'row' as const,alignItems:'center' as const,gap:12},
  fastAddSecondary:{minHeight:72,borderRadius:20,backgroundColor:'#fff',borderWidth:1,borderColor:'#E3C6D1',paddingHorizontal:15,flexDirection:'row' as const,alignItems:'center' as const,gap:12},
  fastAddIcon:{width:44,height:44,borderRadius:14,backgroundColor:'#B94F78',alignItems:'center' as const,justifyContent:'center' as const},
  fastAddIconLight:{width:42,height:42,borderRadius:14,backgroundColor:'#F6DCE6',alignItems:'center' as const,justifyContent:'center' as const},
  fastAddTitle:{fontSize:15,fontWeight:'900' as const,color:'#fff'},
  fastAddCopy:{fontSize:10,color:'#EFC8D7',marginTop:3},
  fastAddTitleDark:{fontSize:14,fontWeight:'900' as const,color:'#5E293D'},
  fastAddCopyDark:{fontSize:10,color:'#8B7480',marginTop:3},
  discoveryRow:{flexDirection:'row' as const,gap:8},
  discoveryButton:{flex:1,minHeight:108,borderRadius:18,backgroundColor:'#fff',borderWidth:1,borderColor:'#E3C6D1',padding:9,alignItems:'center' as const,justifyContent:'center' as const,gap:4},
  discoveryLogo:{width:38,height:38,borderRadius:12,alignItems:'center' as const,justifyContent:'center' as const},
  discoveryLogoText:{fontSize:19,fontWeight:'900' as const,color:'#fff'},
  discoveryTitle:{fontSize:13,fontWeight:'900' as const,color:'#4B2031'},
  discoveryCopy:{fontSize:9,color:'#8B7480',marginTop:2},
  discoveryPage:{flex:1,backgroundColor:'#FFF9FB'},
  discoveryHeader:{minHeight:70,paddingHorizontal:18,flexDirection:'row' as const,alignItems:'center' as const,justifyContent:'space-between' as const,borderBottomWidth:1,borderBottomColor:'#F0DAE2'},
  discoveryHeaderTitle:{fontSize:19,fontWeight:'900' as const,color:'#4B2031',textAlign:'center' as const},
  discoveryHeaderCopy:{fontSize:10,color:'#8B7480',marginTop:2,textAlign:'center' as const},
  discoveryTabs:{height:48,marginHorizontal:20,marginTop:15,borderRadius:16,backgroundColor:'#F3DFE7',padding:4,flexDirection:'row' as const},
  discoveryTab:{flex:1,borderRadius:12,alignItems:'center' as const,justifyContent:'center' as const},
  discoveryTabOn:{backgroundColor:'#fff'},
  discoveryTabText:{fontSize:12,fontWeight:'800' as const,color:'#927783'},
  discoveryTabTextOn:{color:'#6A2942'},
  connectCard:{margin:20,marginTop:30,borderRadius:25,backgroundColor:'#fff',padding:25,alignItems:'center' as const,borderWidth:1,borderColor:'#EBCFD9'},
  connectTitle:{fontSize:22,fontWeight:'900' as const,color:'#4B2031',marginTop:15},
  connectCopy:{fontSize:13,lineHeight:19,color:'#806873',textAlign:'center' as const,marginTop:8},
  connectButton:{alignSelf:'stretch' as const,marginTop:20},
  searchRow:{flexDirection:'row' as const,gap:8,paddingHorizontal:20,marginTop:14},
  searchInput:{flex:1,height:52,borderRadius:16,backgroundColor:'#fff',borderWidth:1,borderColor:'#E0C7D1',paddingHorizontal:15,fontSize:14,color:'#4B2031'},
  searchButton:{width:52,height:52,borderRadius:16,backgroundColor:'#7A2E4C',alignItems:'center' as const,justifyContent:'center' as const},
  filterButton:{backgroundColor:'#A4496B'},
  connectedRow:{height:34,paddingHorizontal:23,flexDirection:'row' as const,alignItems:'center' as const,gap:7},
  connectedDot:{width:7,height:7,borderRadius:4,backgroundColor:'#3EA36F'},
  connectedText:{flex:1,fontSize:10,fontWeight:'700' as const,color:'#5E7969'},
  disconnectText:{fontSize:10,fontWeight:'800' as const,color:'#9C3157'},
  boardChips:{paddingHorizontal:20,paddingBottom:7,gap:7},
  boardChip:{height:34,maxWidth:190,paddingHorizontal:13,borderRadius:17,backgroundColor:'#F3E2E9',borderWidth:1,borderColor:'#E5CBD5',alignItems:'center' as const,justifyContent:'center' as const},
  boardChipOn:{backgroundColor:'#7A2E4C',borderColor:'#7A2E4C'},
  boardChipText:{fontSize:10,fontWeight:'800' as const,color:'#765C66'},
  boardChipTextOn:{color:'#fff'},
  bingNotice:{marginHorizontal:20,marginTop:13,borderRadius:16,backgroundColor:'#E4F4F1',padding:14,flexDirection:'row' as const,alignItems:'center' as const,gap:10},
  bingNoticeText:{flex:1,fontSize:11,lineHeight:16,color:'#356B64'},
  bingGalleryText:{fontSize:11,fontWeight:'900' as const,color:'#007568'},
  bingWebWrap:{flex:1,marginTop:10,backgroundColor:'#fff',borderTopWidth:1,borderTopColor:'#D7EAE7'},
  bingWebView:{flex:1,backgroundColor:'#fff'},
  bingLoading:{...StyleSheet.absoluteFillObject,backgroundColor:'#FFF9FBEE',alignItems:'center' as const,justifyContent:'center' as const,gap:12},
  bingLoadingText:{fontSize:12,fontWeight:'800' as const,color:'#356B64'},
  bingSelectionCard:{position:'absolute' as const,left:12,right:12,bottom:12,minHeight:126,borderRadius:20,backgroundColor:'#fff',padding:10,flexDirection:'row' as const,gap:12,borderWidth:1,borderColor:'#B8DCD7',...Platform.select({web:{boxShadow:'0 8px 22px rgba(25,78,70,0.18)'},default:{shadowColor:'#194E46',shadowOpacity:.18,shadowRadius:16,elevation:8}})},
  bingSelectionPhoto:{width:92,height:106,borderRadius:13,backgroundColor:'#E4F4F1'},
  bingSelectionCopy:{flex:1,paddingVertical:3},
  bingSelectionLabel:{fontSize:8,fontWeight:'900' as const,letterSpacing:1.2,color:'#008373'},
  bingSelectionTitle:{fontSize:12,lineHeight:16,fontWeight:'800' as const,color:'#4B2031',marginTop:5},
  bingSelectionActions:{flexDirection:'row' as const,gap:7,marginTop:'auto' as const},
  bingCancelButton:{height:36,paddingHorizontal:12,borderRadius:11,backgroundColor:'#F2E5EA',alignItems:'center' as const,justifyContent:'center' as const},
  bingCancelText:{fontSize:11,fontWeight:'800' as const,color:'#765C66'},
  bingUseButton:{flex:1,height:36,borderRadius:11,backgroundColor:'#008373',flexDirection:'row' as const,alignItems:'center' as const,justifyContent:'center' as const,gap:5},
  bingUseText:{fontSize:11,fontWeight:'900' as const,color:'#fff'},
  discoveryError:{marginHorizontal:20,marginTop:14,borderRadius:16,backgroundColor:'#FCE7EE',padding:14,flexDirection:'row' as const,alignItems:'center' as const,gap:9},
  discoveryErrorText:{flex:1,fontSize:12,lineHeight:17,color:'#7A2E4C'},
  imageGrid:{padding:20,paddingTop:12,paddingBottom:70,flexDirection:'row' as const,flexWrap:'wrap' as const,gap:10},
  imageResult:{width:'48%' as const,borderRadius:17,backgroundColor:'#fff',overflow:'hidden' as const,borderWidth:1,borderColor:'#E9D2DB'},
  imageResultPhoto:{width:'100%' as const,aspectRatio:.82,backgroundColor:'#F1DEE5'},
  imageResultCopy:{padding:10,paddingRight:34},
  imageResultTitle:{fontSize:11,lineHeight:15,fontWeight:'800' as const,color:'#4B2031'},
  imageResultSource:{fontSize:9,color:'#927783',marginTop:4},
  useImageBadge:{position:'absolute' as const,right:8,bottom:10,width:25,height:25,borderRadius:13,backgroundColor:'#8D3A5A',alignItems:'center' as const,justifyContent:'center' as const},
  loadMoreButton:{width:'100%' as const,height:48,borderRadius:15,backgroundColor:'#F3E2E9',flexDirection:'row' as const,alignItems:'center' as const,justifyContent:'center' as const,gap:7,marginTop:4},
  loadMoreText:{fontSize:11,fontWeight:'900' as const,color:'#7A2E4C'},
  discoveryEmpty:{width:'100%' as const,alignItems:'center' as const,paddingTop:55,gap:12},
  discoveryEmptyText:{fontSize:13,color:'#806873'},
  permissionNotice:{position:'absolute' as const,left:0,right:0,bottom:0,paddingVertical:12,paddingHorizontal:20,backgroundColor:'#FFF9FBEE',fontSize:9,textAlign:'center' as const,color:'#927783'},
  emptyInspiration:{minHeight:70,borderRadius:17,backgroundColor:'#F9E8EE',flexDirection:'row' as const,alignItems:'center' as const,gap:11,paddingHorizontal:15,marginBottom:7},
  emptyInspirationText:{flex:1,fontSize:12,lineHeight:17,color:'#765C66'},
  personalThumb:{width:'100%' as const,height:'100%' as const},
  designLoading:{...StyleSheet.absoluteFillObject,backgroundColor:'#FFF9F4BB',alignItems:'center' as const,justifyContent:'center' as const},
  designFallback:{width:'100%' as const,height:'100%' as const,alignItems:'center' as const,justifyContent:'center' as const,padding:5},
  designFallbackText:{fontSize:7,fontWeight:'800' as const,color:'#FFF9F4',textAlign:'center' as const,marginTop:2},
  seeMoreButton:{height:46,borderRadius:15,borderWidth:1,borderColor:'#DFC4CE',backgroundColor:'#fff',flexDirection:'row' as const,alignItems:'center' as const,justifyContent:'center' as const,gap:6,marginTop:2,marginBottom:6},
  seeMoreText:{fontSize:12,fontWeight:'900' as const,color:'#7A2E4C'},
  disabledButton:{opacity:.55},
  cameraScreen:{flex:1,backgroundColor:'#111'},
  cameraShadeTop:{position:'absolute' as const,left:0,right:0,top:0,minHeight:86,paddingHorizontal:18,flexDirection:'row' as const,alignItems:'center' as const,justifyContent:'space-between' as const,backgroundColor:'#0007'},
  cameraCircle:{width:46,height:46,borderRadius:23,backgroundColor:'#0008',alignItems:'center' as const,justifyContent:'center' as const},
  cameraInstruction:{color:'#fff',fontSize:13,fontWeight:'800' as const},
  cameraFrame:{position:'absolute' as const,left:28,right:28,top:120,bottom:185},
  cameraFrameTL:{position:'absolute' as const,left:0,top:0,width:54,height:54,borderLeftWidth:3,borderTopWidth:3,borderColor:'#fff'},
  cameraFrameTR:{position:'absolute' as const,right:0,top:0,width:54,height:54,borderRightWidth:3,borderTopWidth:3,borderColor:'#fff'},
  cameraFrameBL:{position:'absolute' as const,left:0,bottom:0,width:54,height:54,borderLeftWidth:3,borderBottomWidth:3,borderColor:'#fff'},
  cameraFrameBR:{position:'absolute' as const,right:0,bottom:0,width:54,height:54,borderRightWidth:3,borderBottomWidth:3,borderColor:'#fff'},
  cameraControls:{position:'absolute' as const,left:0,right:0,bottom:0,height:170,backgroundColor:'#0009',alignItems:'center' as const,justifyContent:'center' as const},
  cameraReadyText:{color:'#fff',fontSize:12,fontWeight:'700' as const,marginBottom:14},
  shutterOuter:{width:82,height:82,borderRadius:41,borderWidth:4,borderColor:'#fff',alignItems:'center' as const,justifyContent:'center' as const},
  shutterInner:{width:64,height:64,borderRadius:32,backgroundColor:'#fff',alignItems:'center' as const,justifyContent:'center' as const},
  wardrobeHomeButton:{minWidth:54,height:42,borderRadius:21,backgroundColor:'#fff',paddingHorizontal:11,flexDirection:'row' as const,alignItems:'center' as const,justifyContent:'center' as const,gap:5,borderWidth:1,borderColor:'#E9CBD6'},
  wardrobeHomeCount:{fontSize:12,fontWeight:'900' as const,color:'#7A2E4C'},
  wardrobeCallout:{minHeight:76,borderRadius:20,backgroundColor:'#fff',borderWidth:1,borderColor:'#E5C4D1',padding:12,flexDirection:'row' as const,alignItems:'center' as const,gap:11,marginTop:12},
  wardrobeCalloutIcon:{width:45,height:45,borderRadius:14,backgroundColor:'#8D3A5A',alignItems:'center' as const,justifyContent:'center' as const},
  wardrobeCalloutTitle:{fontSize:14,fontWeight:'900' as const,color:'#4B2031'},
  wardrobeCalloutCopy:{fontSize:10,lineHeight:14,color:'#846C76',marginTop:3},
  accessorySelector:{flexDirection:'row' as const,gap:8,marginBottom:10},
  accessoryChip:{flex:1,height:43,borderRadius:14,backgroundColor:'#fff',borderWidth:1,borderColor:'#DFC2CE',alignItems:'center' as const,justifyContent:'center' as const},
  accessoryChipOn:{backgroundColor:'#7A2E4C',borderColor:'#7A2E4C'},
  accessoryChipText:{fontSize:12,fontWeight:'800' as const,color:'#7A2E4C'},
  accessoryChipTextOn:{color:'#fff'},
  accessoryGuide:{borderRadius:15,backgroundColor:'#F9E5EC',padding:12,flexDirection:'row' as const,alignItems:'flex-start' as const,gap:8,marginBottom:8},
  accessoryGuideText:{flex:1,fontSize:11,lineHeight:16,color:'#765C66'},
  bingOnlyHeader:{marginHorizontal:20,marginTop:14,minHeight:58,borderRadius:17,backgroundColor:'#fff',borderWidth:1,borderColor:'#D8EAE7',paddingHorizontal:12,flexDirection:'row' as const,alignItems:'center' as const,gap:10},
  webAddressRow:{height:52,margin:12,marginBottom:8,flexDirection:'row' as const,gap:8},
  webAddressInput:{flex:1,borderRadius:15,backgroundColor:'#fff',borderWidth:1,borderColor:'#DEC1CD',paddingHorizontal:13,fontSize:12,color:'#4B2031'},
  webGoButton:{width:52,borderRadius:15,backgroundColor:'#7A2E4C',alignItems:'center' as const,justifyContent:'center' as const},
  pickBanner:{minHeight:44,backgroundColor:'#8D3A5A',paddingHorizontal:18,flexDirection:'row' as const,alignItems:'center' as const,justifyContent:'center' as const,gap:8},
  pickBannerText:{fontSize:12,fontWeight:'800' as const,color:'#fff'},
  webPickerFrame:{flex:1,backgroundColor:'#fff',borderTopWidth:1,borderBottomWidth:1,borderColor:'#ECD7DF'},
  webLoading:{...StyleSheet.absoluteFillObject,backgroundColor:'#FFF9FBCC',alignItems:'center' as const,justifyContent:'center' as const},
  webPickerFooter:{padding:12,paddingBottom:16,backgroundColor:'#FFF9FB'},
  webPickerHelp:{fontSize:10,color:'#806873',textAlign:'center' as const,marginBottom:4},
  webPickButton:{marginTop:5,height:53},
  webPickButtonOn:{backgroundColor:'#A8355D'},
  wardrobeEmpty:{minHeight:250,borderRadius:25,backgroundColor:'#F9E8EE',alignItems:'center' as const,justifyContent:'center' as const,padding:28},
  wardrobeEmptyTitle:{fontSize:18,fontWeight:'900' as const,color:'#4B2031',marginTop:12},
  wardrobeEmptyCopy:{fontSize:12,lineHeight:18,color:'#806873',textAlign:'center' as const,marginTop:6},
  wardrobeGrid:{flexDirection:'row' as const,flexWrap:'wrap' as const,gap:12},
  wardrobeCard:{width:'48%' as const,borderRadius:18,backgroundColor:'#fff',overflow:'hidden' as const,borderWidth:1,borderColor:'#E8CFD9'},
  wardrobeImage:{width:'100%' as const,aspectRatio:.78,backgroundColor:'#F1DDE5'},
  wardrobeTag:{position:'absolute' as const,left:8,top:8,borderRadius:10,backgroundColor:'#4B2031BB',paddingHorizontal:7,paddingVertical:4},
  wardrobeTagText:{fontSize:7,fontWeight:'900' as const,letterSpacing:1,color:'#fff'},
  wardrobeCardCopy:{minHeight:60,padding:9,flexDirection:'row' as const,alignItems:'center' as const,gap:5},
  wardrobeTitle:{fontSize:11,fontWeight:'900' as const,color:'#4B2031'},
  wardrobeDate:{fontSize:9,color:'#917B84',marginTop:3},
  wardrobeDelete:{width:32,height:32,borderRadius:16,backgroundColor:'#FAE8EF',alignItems:'center' as const,justifyContent:'center' as const},
  musicButton:{position:'absolute' as const,right:20,top:20,minHeight:40,borderRadius:20,backgroundColor:'#fff',paddingHorizontal:12,flexDirection:'row' as const,alignItems:'center' as const,gap:6,zIndex:3},
  musicButtonText:{fontSize:10,fontWeight:'800' as const,color:'#7A2E4C'},
  musicCredit:{maxWidth:300,marginTop:14,fontSize:9,lineHeight:13,textAlign:'center' as const,color:'#8B6F7A'},
  resultAfterClip:{position:'absolute' as const,left:0,top:0,bottom:0,overflow:'hidden' as const},
  resultAfterImage:{height:'100%' as const},
  resultDivider:{position:'absolute' as const,top:0,bottom:0,width:3,marginLeft:-1.5,backgroundColor:'#fff',alignItems:'center' as const,justifyContent:'center' as const},
  resultHandle:{width:42,height:42,borderRadius:21,backgroundColor:'#fff',borderWidth:2,borderColor:'#F2DCE4',alignItems:'center' as const,justifyContent:'center' as const,...Platform.select({web:{boxShadow:'0 3px 8px rgba(50,20,30,.2)'},default:{elevation:5,shadowColor:'#351522',shadowOpacity:.2,shadowRadius:6}})},
  beforeLabel:{position:'absolute' as const,left:10,top:10,borderRadius:10,backgroundColor:'#0007',paddingHorizontal:8,paddingVertical:5},
  afterLabel:{position:'absolute' as const,right:10,top:10,borderRadius:10,backgroundColor:'#0007',paddingHorizontal:8,paddingVertical:5},
  resultLabelText:{fontSize:8,fontWeight:'900' as const,letterSpacing:1.1,color:'#fff'},
  watermark:{position:'absolute' as const,left:10,bottom:10,borderRadius:8,backgroundColor:'#FFFFFF99',paddingHorizontal:9,paddingVertical:6},
  watermarkText:{fontSize:11,fontWeight:'900' as const,letterSpacing:3,color:'#4B2031AA'},
  sliderHint:{fontSize:10,color:'#8B7480',textAlign:'center' as const,marginTop:8,marginBottom:-13},
  lookCardPressed:{transform:[{scale:.985}],backgroundColor:'#FDF1F5'},
  lookModalShade:{flex:1,backgroundColor:'#35152299',justifyContent:'center' as const,padding:22},
  lookModalCard:{width:'100%' as const,maxWidth:430,alignSelf:'center' as const,borderRadius:28,backgroundColor:'#FFF9FB',padding:22,...Platform.select({web:{boxShadow:'0 16px 34px rgba(53,21,34,.28)'},default:{elevation:12,shadowColor:'#351522',shadowOpacity:.28,shadowRadius:18}})},
  lookModalHandle:{width:42,height:4,borderRadius:2,backgroundColor:'#D8B8C5',alignSelf:'center' as const,marginBottom:20},
  lookModalTitle:{fontSize:25,lineHeight:30,fontWeight:'900' as const,color:'#4B2031',marginBottom:15},
  lookModalImage:{width:'100%' as const,height:250,borderRadius:20,backgroundColor:'#F1DDE5'},
  lookModalName:{fontSize:17,fontWeight:'900' as const,color:'#4B2031',marginTop:15},
  lookModalSource:{fontSize:11,color:'#8B7480',marginTop:5},
  lookModalActions:{flexDirection:'row' as const,gap:10,marginTop:20},
  lookModalCancel:{flex:1,height:54,borderRadius:17,backgroundColor:'#F2E5EA',alignItems:'center' as const,justifyContent:'center' as const},
  lookModalCancelText:{fontSize:14,fontWeight:'900' as const,color:'#765C66'},
  lookModalProceed:{flex:1.35,height:54,borderRadius:17,backgroundColor:'#7A2E4C',flexDirection:'row' as const,alignItems:'center' as const,justifyContent:'center' as const,gap:8},
  lookModalProceedText:{fontSize:14,fontWeight:'900' as const,color:'#fff'},
  processingCancel:{minHeight:48,borderRadius:16,borderWidth:1,borderColor:'#C99AAA',paddingHorizontal:20,alignItems:'center' as const,justifyContent:'center' as const,marginTop:24},
  processingCancelText:{fontSize:13,fontWeight:'800' as const,color:'#6F2B45'},
  processingCancelNote:{maxWidth:310,fontSize:10,lineHeight:15,color:'#856D77',textAlign:'center' as const,marginTop:9},
  offlineBanner:{minHeight:42,backgroundColor:'#A8355D',paddingHorizontal:18,flexDirection:'row' as const,alignItems:'center' as const,justifyContent:'center' as const,gap:8},
  offlineText:{color:'#fff',fontSize:12,fontWeight:'800' as const},
};

const styles = StyleSheet.create({
  safe:{flex:1,backgroundColor:'#FFF9FB'},fill:{flex:1},center:{alignItems:'center',justifyContent:'center',padding:30},header:{height:58,paddingHorizontal:18,flexDirection:'row',alignItems:'center',justifyContent:'space-between'},wordmark:{fontSize:18,fontWeight:'900',letterSpacing:5,color:'#4B2031'},wordmarkLarge:{fontSize:22,fontWeight:'900',letterSpacing:7,color:'#4B2031'},iconButton:{width:40,height:40,borderRadius:20,backgroundColor:'#fff',alignItems:'center',justifyContent:'center'},steps:{height:4,flexDirection:'row',gap:5,paddingHorizontal:22},step:{height:3,flex:1,backgroundColor:'#F0D7E1',borderRadius:2},stepActive:{backgroundColor:'#7A2E4C'},page:{padding:24,paddingBottom:44},resultPage:{padding:24,paddingTop:10,paddingBottom:40},homeTop:{width:'100%',maxWidth:480,alignSelf:'center',paddingHorizontal:24,paddingVertical:20,flexDirection:'row',alignItems:'center',justifyContent:'space-between'},pill:{fontSize:9,fontWeight:'800',letterSpacing:1.2,color:'#7A5362',borderWidth:1,borderColor:'#D8B8C5',borderRadius:20,paddingVertical:6,paddingHorizontal:9},heroArt:{width:'86%',maxWidth:390,aspectRatio:1,alignSelf:'center',borderRadius:32,backgroundColor:'#FFF9F4',overflow:'hidden',alignItems:'center',justifyContent:'center'},sun:{position:'absolute',width:190,height:190,borderRadius:100,backgroundColor:'#F4B8CD',top:52},fabricOne:{position:'absolute',width:210,height:360,backgroundColor:'#D96C94',transform:[{rotate:'28deg'}],left:-80,top:70,borderRadius:80},fabricTwo:{position:'absolute',width:150,height:340,backgroundColor:'#F8DCE6',transform:[{rotate:'-28deg'}],right:-62,top:80,borderRadius:70},heroMonogram:{fontSize:148,fontWeight:'900',color:'#FFF9FB',zIndex:2},homeCopy:{width:'100%',maxWidth:480,alignSelf:'center',paddingHorizontal:24,paddingTop:28,paddingBottom:40},eyebrow:{fontSize:11,fontWeight:'800',letterSpacing:2,color:'#B83F6A',marginBottom:9},heroTitle:{fontSize:39,lineHeight:43,fontWeight:'800',letterSpacing:-1.4,color:'#4B2031'},title:{fontSize:34,lineHeight:39,fontWeight:'800',letterSpacing:-1.1,color:'#4B2031',marginBottom:8},titleCenter:{fontSize:30,fontWeight:'800',color:'#4B2031',marginTop:28,textAlign:'center'},body:{fontSize:16,lineHeight:24,color:'#745F68',marginBottom:24},bodyCenter:{fontSize:15,lineHeight:22,color:'#745F68',textAlign:'center',maxWidth:310,marginTop:10},primary:{height:58,borderRadius:18,backgroundColor:'#7A2E4C',flexDirection:'row',alignItems:'center',justifyContent:'center',gap:10,marginTop:12},primaryText:{color:'#fff',fontSize:16,fontWeight:'800'},secondary:{height:56,borderRadius:18,borderWidth:1,borderColor:'#E0C7D1',flexDirection:'row',alignItems:'center',justifyContent:'center',gap:10,marginTop:11,backgroundColor:'#fff'},secondaryText:{fontSize:15,fontWeight:'700',color:'#4B2031'},demoButton:{minHeight:68,borderRadius:18,backgroundColor:'#F9E1EA',flexDirection:'row',alignItems:'center',gap:11,paddingHorizontal:16,marginTop:11},demoTitle:{fontSize:14,fontWeight:'800',color:'#7A2E4C'},demoCaption:{fontSize:11,color:'#8B7480',marginTop:2},textLink:{fontSize:13,fontWeight:'700',color:'#6E4B59',textAlign:'center',marginTop:20},guide:{height:305,borderRadius:28,backgroundColor:'#F8DFE8',alignItems:'center',justifyContent:'center',overflow:'hidden'},person:{alignItems:'center',marginTop:50},head:{height:82,width:67,borderRadius:36,backgroundColor:'#A56D50'},bodyShape:{height:170,width:160,borderTopLeftRadius:80,borderTopRightRadius:80,backgroundColor:'#B65E7D',marginTop:9},cornerTL:{position:'absolute',left:22,top:22,width:40,height:40,borderLeftWidth:3,borderTopWidth:3,borderColor:'#fff'},cornerTR:{position:'absolute',right:22,top:22,width:40,height:40,borderRightWidth:3,borderTopWidth:3,borderColor:'#fff'},cornerBL:{position:'absolute',left:22,bottom:22,width:40,height:40,borderLeftWidth:3,borderBottomWidth:3,borderColor:'#fff'},cornerBR:{position:'absolute',right:22,bottom:22,width:40,height:40,borderRightWidth:3,borderBottomWidth:3,borderColor:'#fff'},tipRow:{flexDirection:'row',justifyContent:'space-between',marginVertical:19},tip:{alignItems:'center',gap:5,flex:1},tipText:{fontSize:11,color:'#765C66'},privacy:{fontSize:11,lineHeight:17,color:'#8F7982',textAlign:'center',marginTop:16},photoStrip:{flexDirection:'row',alignItems:'center',gap:12,padding:10,backgroundColor:'#fff',borderRadius:16,marginVertical:14},thumb:{width:52,height:64,borderRadius:10},smallLabel:{fontSize:9,fontWeight:'800',letterSpacing:1.4,color:'#A28A94'},photoReady:{fontSize:13,fontWeight:'700',marginTop:3},sectionLabel:{fontSize:11,fontWeight:'800',letterSpacing:1.5,color:'#765C66',marginTop:20,marginBottom:10},garmentCard:{padding:10,backgroundColor:'#fff',borderRadius:20,marginBottom:10,flexDirection:'row',alignItems:'center',borderWidth:2,borderColor:'transparent'},selectedCard:{borderColor:'#8D3A5A'},garmentArt:{height:92,width:82,borderRadius:14,alignItems:'center',justifyContent:'center'},garmentIcon:{fontSize:38,color:'#FFF8E8'},garmentCopy:{flex:1,paddingHorizontal:13},garmentName:{fontSize:15,fontWeight:'800',color:'#4B2031'},maker:{fontSize:11,color:'#8B7480',marginTop:4},price:{fontSize:13,fontWeight:'800',color:'#A8355D',marginTop:8},radio:{width:22,height:22,borderWidth:1.5,borderColor:'#C5A8B4',borderRadius:11,alignItems:'center',justifyContent:'center',marginRight:5},radioOn:{borderColor:'#8D3A5A'},radioDot:{width:12,height:12,borderRadius:6,backgroundColor:'#8D3A5A'},orbit:{height:108,width:108,borderRadius:54,borderWidth:1,borderColor:'#D6B6C3',alignItems:'center',justifyContent:'center',marginTop:65},progressTrack:{height:6,width:'100%',backgroundColor:'#E8CCD7',borderRadius:4,marginTop:38,overflow:'hidden'},progressFill:{height:6,backgroundColor:'#B83F6A',borderRadius:4},progressText:{fontSize:11,color:'#856D77',marginTop:10},resultImageWrap:{height:430,borderRadius:28,overflow:'hidden',backgroundColor:'#F0DCE4',marginTop:10},resultImage:{height:'100%',width:'100%'},tryOnOverlay:{...StyleSheet.absoluteFillObject,alignItems:'center',justifyContent:'flex-end',paddingBottom:18},overlayLabel:{fontSize:10,fontWeight:'900',letterSpacing:1.6,color:'#fff',backgroundColor:'#0008',paddingVertical:7,paddingHorizontal:12,borderRadius:15},toggle:{alignSelf:'center',marginTop:-21,zIndex:4,backgroundColor:'#fff',padding:4,borderRadius:25,flexDirection:'row',...Platform.select({web:{boxShadow:'0 4px 10px rgba(90,36,57,0.12)'},default:{shadowColor:'#5A2439',shadowOpacity:.12,shadowRadius:10,elevation:4}})},toggleSide:{paddingHorizontal:26,paddingVertical:10,borderRadius:20},toggleOn:{backgroundColor:'#7A2E4C'},toggleText:{fontSize:12,fontWeight:'800'},toggleOnText:{fontSize:12,fontWeight:'800',color:'#fff'},resultMeta:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',marginTop:23},actions:{flexDirection:'row',gap:9,marginTop:18},action:{flex:1,backgroundColor:'#fff',height:68,borderRadius:15,alignItems:'center',justifyContent:'center',gap:4},disclaimer:{fontSize:10,lineHeight:15,color:'#917B84',textAlign:'center',marginTop:18},storeHero:{height:150,borderRadius:26,backgroundColor:'#7A2E4C',alignItems:'center',justifyContent:'center',marginBottom:20},storeInitial:{fontSize:80,color:'#FFD4E3',fontWeight:'900'},storeStats:{flexDirection:'row',gap:8},storeStat:{fontSize:11,fontWeight:'700',backgroundColor:'#F9E8EE',padding:9,borderRadius:12,color:'#765C66'},tryLink:{fontSize:11,fontWeight:'800',color:'#8D3A5A',marginTop:8},qrConcept:{flexDirection:'row',alignItems:'center',gap:16,backgroundColor:'#F9E1EA',padding:18,borderRadius:20,marginTop:18}
  ,...businessStyles,
});

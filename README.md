<div align="center">
  <img src="assets/luku-app-icon.png" alt="Luku app icon" width="104" />
  <h1>Luku</h1>
  <p><strong>See it before you commit.</strong></p>
  <p>An Android-first AI styling companion that lets people preview clothes, hairstyles, and accessories on their own photo.</p>

  [![Expo](https://img.shields.io/badge/Expo-54-000020?logo=expo)](https://expo.dev/)
  [![React Native](https://img.shields.io/badge/React%20Native-0.81-61DAFB?logo=react)](https://reactnative.dev/)
  [![Android](https://img.shields.io/badge/Android-first-3DDC84?logo=android)](https://www.android.com/)
  [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
</div>

<p align="center">
  <img src="assets/luku-home-before-after.webp" alt="Luku before and after virtual try-on" width="680" />
</p>

## The idea

Buying a look online often ends with one expensive question: **will this work for me?** Product photos show the item on somebody else, while inspiration is scattered across galleries, search results, Pinterest, and store websites.

Luku brings those decisions into one short flow. A user adds their photo, chooses an item image from wherever they found it, and receives a YouCam-powered visual preview. Finished looks stay in an on-device **Wardrobe**, so users can revisit them without paying to generate the same image again.

Luku launches with Kenyan shoppers in mind, where small retailers rarely have access to virtual-fitting infrastructure, but the experience is designed to work globally.

## What works today

- Fast camera capture and gallery selection without forced cropping.
- Clothing, hairstyle, hat, earrings, and necklace preview flows.
- Item discovery through gallery, camera, Bing Images, Pinterest, or a store website.
- Direct generation immediately after a newly sourced image is confirmed.
- A calm progress experience with looping, properly attributed elevator jazz.
- Clear offline states, timeouts, retry handling, and cancellable generation.
- Touch-driven before/after comparison with quick Before and After controls.
- Automatic on-device Wardrobe storage for completed previews.
- Save-to-device and shareable before/after imagery with a translucent Luku watermark.
- Secure server-side API credentials, upload limits, rate limiting, and URL safety checks.

> Virtual previews support style decisions. They do not predict physical fit or sizing.

## Hackathon fit

Luku's submission centers on **Apparel Virtual Try-On** using Perfect Corp.'s YouCam APIs. It demonstrates more than an isolated model call: it turns virtual try-on into a complete mobile decision journey—from acquiring usable source images to generation, comparison, saving, and reuse.

The product is evaluated around four strengths:

1. **Implementation:** real YouCam task creation and polling behind a secure backend boundary.
2. **Experience:** an understandable Android flow for first-time users, including failure and cancellation states.
3. **Impact:** premium virtual styling made accessible to shoppers and, later, independent retailers.
4. **Originality:** inspiration can come directly from search, a Pin, a camera, or a store page without first saving it to the gallery.

## Product journey

1. Choose what to try: clothes, hair, or accessories.
2. Take or select a clear personal photo.
3. Choose the item from gallery, camera, Bing, Pinterest, a store, or recent looks.
4. Let Luku generate the preview through the secure YouCam service.
5. Compare before and after, then save, share, or keep it in Wardrobe.

## Architecture

```text
Expo / React Native Android app
  |-- camera, gallery and on-device Wardrobe
  |-- Bing and store image selection
  |-- Pinterest OAuth
  |
  +--> Luku Express API
         |-- image validation and upload limits
         |-- rate limiting and private-network URL blocking
         |-- Pinterest token boundary
         |
         +--> Perfect Corp. YouCam APIs
              |-- Clothes V3
              |-- Hair Transfer
              +-- Fashion accessories
```

The mobile app receives only the public Luku backend URL. YouCam and Pinterest secrets remain server-side and are never bundled into the APK.

## Technology

- Expo 54, React Native 0.81, React 19, and TypeScript.
- Expo Camera, Image Picker, Media Library, Audio, and Sharing.
- React Native WebView for in-app image discovery.
- Node.js, Express, Multer, Sharp, TensorFlow.js, and COCO-SSD.
- Perfect Corp. YouCam Fashion APIs.
- Pinterest API v5 OAuth integration.
- Supabase Edge Function starter for a clothes-only hosted deployment.

## Run locally

### Requirements

- Node.js 20 or newer.
- pnpm through Corepack.
- Java 17 and the Android SDK for native Android builds.
- A YouCam API account and Bearer token for real generation.

### Install and check

```powershell
corepack enable
pnpm install
pnpm run check
```

### Configure the backend

Create `supabase/.env.local` locally. This file is ignored by Git:

```dotenv
YOUCAM_API_KEY=your_server_side_bearer_token

# Optional Pinterest connection
PINTEREST_APP_ID=
PINTEREST_APP_SECRET=
PINTEREST_REDIRECT_URI=https://your-public-api.example.com/pinterest/callback
```

Start the backend on port `8787`:

```powershell
pnpm backend
```

### Configure the app

Copy `.env.example` to `.env` and point the app at a backend address reachable by the phone:

```dotenv
EXPO_PUBLIC_YOUCAM_FUNCTION_URL=http://192.168.1.20:8787/try-on
```

Then start Expo:

```powershell
pnpm start
```

The phone and development computer must be on the same network when using a LAN address. Production and Pinterest OAuth require a stable HTTPS backend URL.

### Build Android

With `JAVA_HOME` and `ANDROID_HOME` configured:

```powershell
cd android
.\gradlew.bat assembleRelease
```

The APK is written to `android/app/build/outputs/apk/release/app-release.apk` and is intentionally excluded from Git.

## API and privacy safeguards

- Secrets stay in the backend environment.
- Accepted image formats and a 10 MB upload limit are enforced.
- Remote reference URLs must use HTTPS and pass private-network protections.
- Generation is rate-limited per client.
- The UI explains when generation requires internet access.
- Completed previews are copied to the local Wardrobe for reuse.
- Users explicitly choose when to save an image to their photo library.
- Cancelling after generation starts may still consume a paid API request, which the UI states before cancellation.

## Validation

```powershell
pnpm run check
pnpm doctor
```

The current Android release is **v1.1.11** (`versionCode 22`) and has been tested on a physical Redmi device.

## License and credits

Source code is available under the [MIT License](LICENSE). Third-party media and model attribution is documented in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [server/models/coco-ssd/SOURCE.md](server/models/coco-ssd/SOURCE.md).

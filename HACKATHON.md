# Luku hackathon brief

## One-line pitch

Luku lets people take any look they discover—from a product photo, search result, Pin, or store website—and preview it on themselves before committing, powered by Perfect Corp. YouCam APIs.

## The problem

Online fashion asks shoppers to make a visual decision with incomplete information. The model in the product photograph is not the customer, useful inspiration lives across disconnected platforms, and repeated AI generation becomes expensive when completed results are not easy to keep.

This gap is especially visible for independent fashion businesses and mobile-first customers in markets such as Kenya, where full virtual-fitting infrastructure is rarely available.

## The solution

Luku converts virtual try-on into a practical customer journey:

1. Add a clear personal photo with camera or gallery.
2. Bring an item from gallery, camera, Bing Images, Pinterest, or a store website.
3. Generate a visual try-on through a protected YouCam integration.
4. Compare the original and generated image with an interactive slider.
5. Save the completed look in an on-device Wardrobe, export it, or share a watermarked before/after image.

## Why it is different

- **Source freedom:** users can bring inspiration from where they already browse instead of relying on one catalogue.
- **No save-first detour:** supported online images move directly into generation after selection.
- **Cost-aware reuse:** completed results live in Wardrobe and do not need to be regenerated merely to view them again.
- **A complete mobile experience:** camera performance, offline messaging, progress, cancellation disclosure, retry handling, comparison, and saving are treated as product features—not demo afterthoughts.
- **Accessible infrastructure:** the long-term opportunity is a virtual styling layer that independent retailers can benefit from without 3D garment pipelines or specialist AI teams.

## YouCam implementation

The Luku backend keeps the YouCam Bearer token outside the APK. It validates inputs, reserves YouCam upload URLs, uploads shopper and reference images, creates the correct task for the chosen category, polls task state, and returns the generated result to the app.

The current server supports:

- Clothes V3 virtual try-on.
- Hair Transfer.
- Hats, earrings, and necklaces.
- Local reference uploads and protected HTTPS reference downloads.
- Upload size/type checks, timeouts, rate limiting, and private-network URL blocking.

The judged core is **Apparel Virtual Try-On**; hair and accessories demonstrate how the same customer journey can expand.

## Judging alignment

### Technological implementation

- Real server-to-server YouCam integration rather than exposing credentials in the client.
- Android camera, gallery, WebView selection, Pinterest OAuth, local persistence, and native sharing.
- Explicit handling for API latency, offline use, cancellation, and late responses.

### Design and usability

- Short three-step journey with clear language and restrained controls.
- Direct generation for newly confirmed item images.
- Before/after slider plus accessible Before and After buttons.
- A calm, attributed audio experience while generation is running.

### Impact

- Helps users make more confident visual choices.
- Can reduce avoidable purchase regret and repeated generation spend.
- Creates a future distribution path for independent retailers without custom virtual-fitting infrastructure.

### Idea quality

Luku is a decision layer around virtual try-on, not a single API screen. Discovery, generation, comparison, reuse, and sharing form one coherent product.

## Suggested two-minute demo

- **0:00–0:12:** Open Luku. “Online fashion still asks us to imagine.”
- **0:12–0:28:** Choose Clothes and take or select a shopper photo.
- **0:28–0:48:** Find an outfit through Bing, Pinterest, a store, camera, or gallery.
- **0:48–1:18:** Confirm the image and show real YouCam generation, progress, music, and cancellation disclosure.
- **1:18–1:38:** Drag the before/after slider and use the quick comparison buttons.
- **1:38–1:52:** Save the result and reopen it from Wardrobe without regenerating.
- **1:52–2:00:** “Luku: see it before you commit.”

## Submission checklist

- [ ] Clean-install Android demo using a real YouCam Apparel VTO result.
- [ ] Public repository with setup instructions, license, and credits.
- [ ] One-to-three-minute public demo video on the target device.
- [ ] English project description and current screenshots.
- [ ] Original, licensed, or permission-cleared demo photographs.
- [ ] Stable backend and test build available throughout judging.
- [ ] YouCam credentials stored only as deployment secrets.

## Current build

- Android app: `1.1.11` (`versionCode 22`).
- Package: `com.luku.tryon`.
- Primary category: Apparel Virtual Try-On.
- License: MIT.

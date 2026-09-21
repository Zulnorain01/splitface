# SplitFace — Requirements

## Problem
TikTok's "parent split-face" trend (half-face photo merges, e.g. half parent / half child, or family resemblance mashups) is viral, but making one requires ~20 minutes of manual editing in CapCut/Photoshop: aligning faces, masking, blending seams.

## Target user
TikTok / Instagram creators and casual users (teens to young parents) who want to post a split-face video/photo with one tap, not a tutorial.

## The ONE core feature
**One-tap split-face merge:** upload 2 photos → automatic face detection + alignment → draggable split line → live merged preview → export a share-ready portrait.

Everything else is secondary. If this core loop is not instant and delightful, the product fails.

## User flows

### Flow 1 — Make a split face (happy path)
1. User lands on the app (/app), sees an upload dropzone with two slots: Photo A (left), Photo B (right). Sample photos are offered ("Try with sample photos") so the loop can be experienced in seconds.
2. User uploads two photos (file picker or drag & drop).
3. App detects faces client-side, auto-aligns both faces (eyes level, scaled to the same face size), and shows the merged preview with the split line centered.
4. User drags the split line horizontally; preview updates live. Optional: toggle which side shows Photo A vs B ("flip sides").
5. User clicks Export → full-res image renders to a canvas → free export downloads with a small "Made with SplitFace" watermark; or user clicks "Remove watermark + HD — $4.99 one-time" (payment placeholder link) — after "purchase" the paywall is informational only in this MVP (Muhammad wires the real link; unlocked state is stubbed via a query param / local toggle so he can see the unlocked flow).

### Flow 2 — Sample photos
- Two buttons: "Use sample photos" loads two bundled sample portraits so the user can try instantly with zero friction.

### Flow 3 — Mobile
- Same flow in a single-column layout: stacked upload slots, preview canvas fills width, split line draggable by touch, sticky export bar at the bottom.

## Acceptance criteria
- [ ] Two photos upload via picker and drag-drop; invalid files (non-image) are rejected with a friendly message.
- [ ] Faces are detected automatically (client-side, no server, no API keys); if no face is found in a photo, show a clear hint ("We couldn't find a face — try a clearer photo") and let the user continue with manual positioning (center crop fallback).
- [ ] Alignment normalizes both faces (same scale/orientation via eye landmarks) so the merge looks plausible without manual tweaking.
- [ ] Split line is draggable (mouse + touch) with live preview; works on desktop and mobile viewports.
- [ ] Export downloads a PNG sized for sharing (1080×1350 portrait-ish or source max). Free export carries a small corner watermark; the $4.99 button opens the configured payment link (placeholder clearly marked in code, e.g. `PAYMENT_URL` in one config file).
- [ ] No backend, no paid APIs, no secrets in the repo. All processing is client-side.
- [ ] Page works offline after first load (all libs bundled locally — no CDN-only dependencies at runtime for the core loop; CDN with local fallback is acceptable if bundled copy exists in repo).
- [ ] No console errors during the happy path on desktop and mobile viewports.

## Out of scope (v1)
- User accounts, login, cloud storage, galleries.
- Video export (photo only for v1; trend posts are often photo carousels).
- Real payment processing — placeholder link only (Muhammad pastes his Gumroad/Lemon Squeezy link).
- Server-side anything. Social sharing integrations beyond a "download and post" hint.
- Advanced retouching (skin-tone blending beyond a simple feathered seam), multi-face photos.

## Tech direction
- Plain HTML/CSS/JS (no build step) or Vite. Decision: plain static files — fastest to ship to free static hosting, zero build.
- Face detection: free open-source client-side library, vendored into the repo (no runtime CDN dependency for core). Candidate: face-api.js (tiny-face-detector + 68-point landmarks) or MediaPipe Face Detection via @mediapipe/tasks-vision. Engineer chooses based on bundle size + reliability; must work from file:// or plain static hosting (no COOP/COEP headers required — avoid WASM-threaded builds that need them).
- Styling: match CareerOS/HireRank shared design language (see landing phase); consumer green brand colorway.

## Monetization (MVP)
- Free: watermarked export.
- $4.99 one-time: removes watermark + HD export. Button links to `PAYMENT_URL` placeholder defined once in `app/config.js` with a comment for Muhammad.

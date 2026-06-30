# libhmk WebUSB DFU Flasher

A customized fork of [webdfu](https://github.com/devanlai/webdfu) for flashing [libhmk](https://github.com/peppapighs/libhmk) keyboard firmware from a Chromium-based browser via WebUSB.

## Live site

After enabling GitHub Pages, the flasher is available at:

```
https://<YOUR_GITHUB_USERNAME>.github.io/hmkdfu/
```

## UI

The page UI is inspired by [hmkconf](https://hmkconf.com/):
- Dark theme by default with a light/dark toggle
- Card-based layout
- Keyboard selector for GitHub Actions firmware builds
- Progress log panel

## GitHub Actions firmware integration

The flasher can fetch the latest firmware built by the `gohanda11/libhmk` `split` branch workflow directly from GitHub.

### How it works

1. `libhmk`'s `Build Workflow` builds every keyboard in the `keyboards/` directory.
2. A `publish-firmware` job uploads the built `.bin` files to the `firmware` branch of the same repository.
3. The flasher loads `manifest.json` from that branch and lists available keyboards.
4. Selecting a keyboard downloads the `.bin` into the browser and prepares it for flashing.

### Required setup

1. In your local `libhmk` repository, the build workflow (`.github/workflows/build.yml`) includes the `publish-firmware` job.
2. Push the workflow to GitHub.
3. Trigger a build on the `split` branch (push a commit or use workflow dispatch).
4. After the build succeeds, the `firmware` branch is created automatically.
5. The flasher will then show "GitHub Latest" firmware options.

### Manual fallback

If the `firmware` branch is not ready, or you want to flash a custom build, use the **Local File** tab to select a `.bin` file from your computer.

## Supported bootloaders

| Preset | VID | PID | Notes |
|--------|-----|-----|-------|
| STM32 factory DFU | `0x0483` | `0xDF11` | Used by most libhmk keyboards (e.g. HE60) |
| AT32F405 factory DFU | `0x2E3C` | `0xDF11` | ArteryTek AT32F405 parts |
| dapboot | `0x1209` | `0xDB42` | Open-source WebUSB DFU bootloader |
| Custom | user-defined | user-defined | For other DFU devices |

## Entering DFU mode on libhmk keyboards

1. Hold the **BOOT** button while plugging in the keyboard, **or**
2. Press the `SP_BOOT` key binding if you have a working firmware, **or**
3. Use the [hmkconf](https://github.com/peppapighs/hmkconf) web configurator to trigger bootloader mode.

## Browser requirements

- Chromium-based browser: Google Chrome, Microsoft Edge, Brave, Opera, etc.
- Firefox and Safari do **not** support WebUSB.
- The page must be served over HTTPS or from `localhost`.

## Windows driver setup

WebUSB needs a generic WinUSB driver bound to the DFU device. This is **not** installed automatically by Windows for the STM32 factory bootloader.

### Windows x64

1. Download [Zadig](https://zadig.akeo.ie/).
2. Put the keyboard in DFU mode.
3. In Zadig: **Options → List All Devices**.
4. Select `STM32 BOOTLOADER` (or your device).
5. Make sure the driver shown is `WinUSB` and click **Replace Driver**.
6. Refresh this page and click **Connect**.

### Windows on ARM

Zadig does not work on Windows ARM because it relies on [libwdi](https://github.com/pbatard/libwdi), which does not yet support ARM64 (see [libwdi#289](https://github.com/pbatard/libwdi/issues/289)).

Options:

1. **Flash from another OS** (recommended): Use a PC with Windows x64, Linux, or macOS. Linux and macOS do not require manual driver installation.
2. **Install a WinUSB driver manually** on Windows ARM:
   - Use `pnputil` with a manually crafted driver package, or
   - Use the Windows "Add legacy hardware" wizard in Device Manager with a compatible WinUSB `.inf`.
   - This is advanced and not officially documented by Microsoft for the STM32 bootloader.
3. **Use a WebUSB-compatible custom bootloader** with Microsoft OS descriptors (WCID) built into the firmware. The factory STM32 bootloader does not expose WCID descriptors, so Windows will not auto-bind WinUSB.

### Windows on ARM performance warning

Even after a driver is installed, Chromium browsers on Windows ARM currently suffer from very slow USB control transfers. Flashing that takes seconds on other platforms can take tens of minutes on Windows ARM. This is a known Chromium/Windows ARM issue tracked at [Chromium issue 494543570](https://issues.chromium.org/issues/494543570). There is no website-side fix; it must be resolved by Google/Microsoft.

## Local development

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000/docs/` (or the repository root, depending on where you serve from).

## GitHub Pages deployment

This repository includes a GitHub Actions workflow (`.github/workflows/pages.yml`) that deploys the `docs/` directory to GitHub Pages on every push to `main`.

To enable it:

1. Go to **Settings → Pages** in your forked repository.
2. Under **Build and deployment → Source**, select **GitHub Actions**.
3. Push to the `main` branch (or run the workflow manually).

## Customizing for another keyboard

Edit the `PRESETS` object in `docs/libhmk-dfu.js` to add or change VID/PID presets.

## License

This project inherits the original webdfu license. See `LICENSE`.

## Acknowledgements

- [webdfu](https://github.com/devanlai/webdfu) by [@devanlai](https://github.com/devanlai)
- [libhmk](https://github.com/peppapighs/libhmk) by [@peppapighs](https://github.com/peppapighs)

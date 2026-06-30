var device = null;
(function () {
  'use strict';

  const GITHUB_REPO = 'gohanda11/libhmk';
  const FIRMWARE_BRANCH = 'firmware';
  const MANIFEST_URL = `https://raw.githubusercontent.com/${GITHUB_REPO}/${FIRMWARE_BRANCH}/manifest.json`;

  const PRESETS = {
    all: null,
    stm32: { vid: 0x0483, pid: 0xDF11, name: 'STM32 factory DFU bootloader' },
    at32: { vid: 0x2E3C, pid: 0xDF11, name: 'AT32F405 factory DFU bootloader' },
    dapboot: { vid: 0x1209, pid: 0xDB42, name: 'dapboot' },
    custom: null
  };

  let firmwareManifest = null;
  let selectedFirmwareBuffer = null;
  let firmwareSource = 'github';
  let transferSize = 1024;
  let manifestationTolerant = true;
  let currentLog = null;

  function isWindowsARM() {
    const ua = navigator.userAgent;
    if (/Windows.*(arm|aarch64|ARM64)/i.test(ua)) return true;
    if (navigator.userAgentData?.architecture && /arm/i.test(navigator.userAgentData.architecture)) return true;
    return false;
  }

  function hex4(n) {
    let s = n.toString(16);
    while (s.length < 4) s = '0' + s;
    return s;
  }

  function hexAddr8(n) {
    let s = n.toString(16);
    while (s.length < 8) s = '0' + s;
    return '0x' + s;
  }

  function niceSize(n) {
    if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(2) + ' MiB';
    if (n >= 1024) return (n / 1024).toFixed(1) + ' KiB';
    return n + ' B';
  }

  function formatDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    return d.toLocaleString('ja-JP');
  }

  function formatError(error) {
    let msg = (error && error.message) ? error.message : String(error);
    const lower = msg.toLowerCase();
    if (lower.includes('notfounderror') || lower.includes('device unavailable') || lower.includes('device was disconnected')) {
      return 'Device not found or disconnected. Make sure the keyboard is in DFU bootloader mode and the USB cable supports data.';
    }
    if (lower.includes('access denied') || lower.includes('not allowed') || lower.includes('securityerror')) {
      return 'Access denied. On Windows, a WinUSB driver must be installed for the DFU device.';
    }
    if (lower.includes('security')) {
      return 'WebUSB is blocked. Use a Chromium-based browser (Chrome/Edge) and access this page over HTTPS or localhost.';
    }
    return msg;
  }

  /* ---------- Theme ---------- */
  function initTheme() {
    const toggle = document.querySelector('#themeToggle');
    const html = document.documentElement;
    const moon = document.querySelector('#moonIcon');
    const sun = document.querySelector('#sunIcon');

    const saved = localStorage.getItem('libhmk-theme');
    if (saved) html.setAttribute('data-theme', saved);

    function updateIcons() {
      const isDark = html.getAttribute('data-theme') === 'dark';
      moon.classList.toggle('hidden', isDark);
      sun.classList.toggle('hidden', !isDark);
    }
    updateIcons();

    toggle.addEventListener('click', () => {
      const next = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      html.setAttribute('data-theme', next);
      localStorage.setItem('libhmk-theme', next);
      updateIcons();
    });
  }

  /* ---------- Logging ---------- */
  function setLogContext(div) {
    currentLog = div;
  }

  function clearLog(div) {
    if (div) div.innerHTML = '';
  }

  function logTo(div, msg, type) {
    if (!div) return;
    const p = document.createElement('p');
    p.className = type;
    p.textContent = msg;
    div.appendChild(p);
    div.scrollTop = div.scrollHeight;
  }

  function logDebug(msg) {
    console.log(msg);
  }

  function logInfo(msg) {
    logTo(currentLog, msg, 'info');
  }

  function logWarning(msg) {
    logTo(currentLog, msg, 'warning');
  }

  function logError(msg) {
    logTo(currentLog, msg, 'error');
  }

  function logSuccess(msg) {
    logTo(currentLog, msg, 'success');
  }

  function logProgress(done, total) {
    if (!currentLog) return;
    let progressBar = currentLog.querySelector('progress');
    if (!progressBar) {
      progressBar = document.createElement('progress');
      currentLog.appendChild(progressBar);
    }
    progressBar.value = done;
    if (typeof total !== 'undefined') progressBar.max = total;
    currentLog.scrollTop = currentLog.scrollHeight;
  }

  /* ---------- Firmware manifest ---------- */
  async function loadFirmwareManifest() {
    const select = document.querySelector('#githubFirmwareSelect');
    try {
      const res = await fetch(MANIFEST_URL, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      firmwareManifest = await res.json();

      select.innerHTML = '<option value="">-- Select keyboard --</option>';
      for (const fw of firmwareManifest.firmwares) {
        const opt = document.createElement('option');
        opt.value = fw.keyboard;
        opt.textContent = `${fw.keyboard}`;
        select.appendChild(opt);
      }
      select.disabled = false;
    } catch (error) {
      console.error(error);
      select.innerHTML = '<option value="">Failed to load firmware list</option>';
      select.disabled = true;
      logError('Failed to load firmware manifest from GitHub: ' + formatError(error));
    }
  }

  async function fetchFirmwareBinary(keyboard) {
    const fw = firmwareManifest && firmwareManifest.firmwares.find(f => f.keyboard === keyboard);
    if (!fw) throw new Error('Firmware not found in manifest');

    const res = await fetch(fw.url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.arrayBuffer();
  }

  function updateFirmwareMeta(keyboard) {
    const fw = firmwareManifest && firmwareManifest.firmwares.find(f => f.keyboard === keyboard);
    const meta = document.querySelector('#firmwareMeta');
    if (!fw) {
      meta.classList.add('hidden');
      return;
    }
    document.querySelector('#metaCommit').textContent = fw.commit.slice(0, 7);
    document.querySelector('#metaSize').textContent = niceSize(fw.size);
    document.querySelector('#metaBuilt').textContent = formatDate(fw.built_at);
    meta.classList.remove('hidden');
  }

  /* ---------- DFU helpers ---------- */
  function formatDFUSummary(dev) {
    const vid = hex4(dev.device_.vendorId);
    const pid = hex4(dev.device_.productId);
    const cfg = dev.settings.configuration.configurationValue;
    const intf = dev.settings['interface'].interfaceNumber;
    const alt = dev.settings.alternate.alternateSetting;
    const serial = dev.device_.serialNumber;
    let mode = 'Unknown';
    if (dev.settings.alternate.interfaceProtocol == 0x01) mode = 'Runtime';
    else if (dev.settings.alternate.interfaceProtocol == 0x02) mode = 'DFU';
    return `${mode}: [${vid}:${pid}] cfg=${cfg}, intf=${intf}, alt=${alt}, serial="${serial}"`;
  }

  function formatDFUInterfaceAlternate(settings) {
    let mode = 'Unknown';
    if (settings.alternate.interfaceProtocol == 0x01) mode = 'Runtime';
    else if (settings.alternate.interfaceProtocol == 0x02) mode = 'DFU';
    const cfg = settings.configuration.configurationValue;
    const intf = settings['interface'].interfaceNumber;
    const alt = settings.alternate.alternateSetting;
    const name = settings.name || 'UNKNOWN';
    return `${mode}: cfg=${cfg}, intf=${intf}, alt=${alt}, name="${name}"`;
  }

  async function fixInterfaceNames(device_, interfaces) {
    if (interfaces.some(intf => intf.name == null)) {
      const tempDevice = new dfu.Device(device_, interfaces[0]);
      await tempDevice.device_.open();
      await tempDevice.device_.selectConfiguration(1);
      const mapping = await tempDevice.readInterfaceNames();
      await tempDevice.close();

      for (const intf of interfaces) {
        if (intf.name === null) {
          const configIndex = intf.configuration.configurationValue;
          const intfNumber = intf['interface'].interfaceNumber;
          const alt = intf.alternate.alternateSetting;
          intf.name = mapping[configIndex][intfNumber][alt];
        }
      }
    }
  }

  function getDFUDescriptorProperties(dev) {
    return dev.readConfigurationDescriptor(0).then(
      data => {
        const configDesc = dfu.parseConfigurationDescriptor(data);
        let funcDesc = null;
        const configValue = dev.settings.configuration.configurationValue;
        if (configDesc.bConfigurationValue == configValue) {
          for (const desc of configDesc.descriptors) {
            if (desc.bDescriptorType == 0x21 && desc.hasOwnProperty('bcdDFUVersion')) {
              funcDesc = desc;
              break;
            }
          }
        }
        if (funcDesc) {
          return {
            WillDetach: (funcDesc.bmAttributes & 0x08) != 0,
            ManifestationTolerant: (funcDesc.bmAttributes & 0x04) != 0,
            CanUpload: (funcDesc.bmAttributes & 0x02) != 0,
            CanDnload: (funcDesc.bmAttributes & 0x01) != 0,
            TransferSize: funcDesc.wTransferSize,
            DetachTimeOut: funcDesc.wDetachTimeOut,
            DFUVersion: funcDesc.bcdDFUVersion
          };
        }
        return {};
      },
      error => { throw error; }
    );
  }

  /* ---------- UI state ---------- */
  function setConnectedState(connected, dev) {
    const statusBadge = document.querySelector('#deviceStatus');
    const statusText = document.querySelector('#statusText');
    const deviceInfo = document.querySelector('#deviceInfo');
    const dfuInfo = document.querySelector('#dfuInfo');
    const connectBtn = document.querySelector('#connectBtn');
    const detachBtn = document.querySelector('#detachBtn');
    const flashBtn = document.querySelector('#flashBtn');
    const uploadBtn = document.querySelector('#uploadBtn');

    if (connected && dev) {
      const protocol = dev.settings.alternate.interfaceProtocol;
      statusBadge.className = 'status-badge status-connected';
      statusBadge.textContent = 'Connected';
      connectBtn.textContent = 'Disconnect';
      deviceInfo.classList.remove('hidden');
      dfuInfo.classList.remove('hidden');
      detachBtn.disabled = protocol != 0x01;
      flashBtn.disabled = protocol != 0x02 || selectedFirmwareBuffer === null;
      uploadBtn.disabled = protocol != 0x02;
      statusText.textContent = 'DFU device connected. Select a firmware and click Flash.';
    } else {
      statusBadge.className = 'status-badge status-idle';
      statusBadge.textContent = 'Not connected';
      connectBtn.textContent = 'Connect';
      deviceInfo.classList.add('hidden');
      dfuInfo.classList.add('hidden');
      detachBtn.disabled = true;
      flashBtn.disabled = true;
      uploadBtn.disabled = true;
      statusText.textContent = 'Connect your keyboard in DFU bootloader mode.';
    }
  }

  function updateDeviceInfo(dev, props, memorySummary) {
    document.querySelector('#infoName').textContent = dev.device_.productName || '—';
    document.querySelector('#infoMfg').textContent = dev.device_.manufacturerName || '—';
    document.querySelector('#infoVidPid').textContent = `${hex4(dev.device_.vendorId)}:${hex4(dev.device_.productId)}`;
    document.querySelector('#infoMode').textContent = dev.settings.alternate.interfaceProtocol == 0x02 ? 'DFU' : 'Runtime';

    const dfuInfo = document.querySelector('#dfuInfo');
    let html = formatDFUSummary(dev);
    if (props && Object.keys(props).length > 0) {
      html += `\nWillDetach=${props.WillDetach}, ManifestationTolerant=${props.ManifestationTolerant}, CanUpload=${props.CanUpload}, CanDnload=${props.CanDnload}, TransferSize=${props.TransferSize}, DetachTimeOut=${props.DetachTimeOut}, Version=0x${hex4(props.DFUVersion)}`;
    }
    if (memorySummary) html += '\n' + memorySummary;
    dfuInfo.textContent = html;
  }

  function onDisconnect(reason) {
    if (reason) {
      const statusText = document.querySelector('#statusText');
      statusText.textContent = reason;
    }
    setConnectedState(false);
    device = null;
  }

  function onUnexpectedDisconnect(event) {
    if (device !== null && device.device_ !== null && device.device_ === event.device) {
      device.disconnected = true;
      onDisconnect('Device disconnected');
    }
  }

  /* ---------- Connect ---------- */
  async function connect(targetDevice) {
    console.log('[connect] Opening device...');
    try {
      await targetDevice.open();
      console.log('[connect] Device opened');
    } catch (error) {
      console.error('[connect] open failed:', error);
      const friendly = formatError(error);
      onDisconnect(friendly);
      throw new Error(friendly);
    }

    let props = {};
    try {
      console.log('[connect] Reading DFU descriptor...');
      props = await getDFUDescriptorProperties(targetDevice);
      console.log('[connect] DFU descriptor:', props);
    } catch (error) {
      console.warn('[connect] Failed to read DFU descriptor, continuing without it:', error);
      logWarning('Could not read DFU functional descriptor; continuing with defaults.');
    }

    let memorySummary = '';
    if (props && Object.keys(props).length > 0) {
      targetDevice.properties = props;
      if (props.TransferSize && props.TransferSize >= 8) {
        document.querySelector('#transferSize').value = props.TransferSize;
        transferSize = props.TransferSize;
      }
      manifestationTolerant = props.ManifestationTolerant;

      if (props.DFUVersion == 0x011a && targetDevice.settings.alternate.interfaceProtocol == 0x02) {
        try {
          console.log('[connect] Device reports DfuSe, wrapping...');
          targetDevice = new dfuse.Device(targetDevice.device_, targetDevice.settings);
          if (targetDevice.memoryInfo) {
            const total = targetDevice.memoryInfo.segments.reduce((acc, s) => acc + (s.end - s.start), 0);
            memorySummary = `Selected memory region: ${targetDevice.memoryInfo.name} (${niceSize(total)})`;
            for (const segment of targetDevice.memoryInfo.segments) {
              const propsList = [];
              if (segment.readable) propsList.push('readable');
              if (segment.erasable) propsList.push('erasable');
              if (segment.writable) propsList.push('writable');
              memorySummary += `\n${hexAddr8(segment.start)}-${hexAddr8(segment.end - 1)} (${propsList.join(', ') || 'inaccessible'})`;
            }
          }
        } catch (dfuseError) {
          console.warn('[connect] DfuSe wrap failed, continuing as standard DFU:', dfuseError);
          logWarning('DfuSe memory map unavailable; using standard DFU mode.');
        }
      }
    }

    targetDevice.logDebug = logDebug;
    targetDevice.logInfo = logInfo;
    targetDevice.logWarning = logWarning;
    targetDevice.logError = logError;
    targetDevice.logProgress = logProgress;

    clearLog(document.querySelector('#downloadLog'));
    clearLog(document.querySelector('#uploadLog'));
    setLogContext(document.querySelector('#downloadLog'));

    updateDeviceInfo(targetDevice, props, memorySummary);
    setConnectedState(true, targetDevice);

    if (isWindowsARM()) {
      logWarning('Windows on ARM detected: flashing may be very slow.');
    }

    return targetDevice;
  }

  function parseVidPid() {
    const vidField = document.querySelector('#vid');
    const pidField = document.querySelector('#pid');
    return {
      vid: parseInt(vidField.value, 16),
      pid: parseInt(pidField.value, 16)
    };
  }

  function applyBootloaderPreset() {
    const key = document.querySelector('#bootloaderPreset').value;
    const preset = PRESETS[key];
    const customRow = document.querySelector('#customVidPid');
    if (key === 'all') {
      customRow.classList.add('hidden');
      document.querySelector('#vid').value = '';
      document.querySelector('#pid').value = '';
    } else if (preset) {
      customRow.classList.add('hidden');
      document.querySelector('#vid').value = '0x' + hex4(preset.vid).toUpperCase();
      document.querySelector('#pid').value = '0x' + hex4(preset.pid).toUpperCase();
    } else {
      customRow.classList.remove('hidden');
    }
  }

  async function doConnect() {
    if (device) {
      console.log('[doConnect] Disconnecting existing device');
      await device.close();
      onDisconnect();
      return;
    }

    const { vid } = parseVidPid();
    const filters = [];
    if (vid && !Number.isNaN(vid)) {
      // Match original webdfu: filter by vendorId only so users can pick
      // any DFU device from that vendor, even if the PID differs.
      filters.push({ vendorId: vid });
    }
    console.log('[doConnect] Requesting device with filters:', filters);

    try {
      const selectedDevice = await navigator.usb.requestDevice({ filters });
      console.log('[doConnect] Selected device:', selectedDevice.productName, selectedDevice.vendorId, selectedDevice.productId);

      const interfaces = dfu.findDeviceDfuInterfaces(selectedDevice);
      console.log('[doConnect] DFU interfaces found:', interfaces.length);
      if (interfaces.length == 0) {
        document.querySelector('#statusText').textContent = 'The selected device does not have any USB DFU interfaces.';
        return;
      }

      try {
        await fixInterfaceNames(selectedDevice, interfaces);
      } catch (fixError) {
        console.warn('[doConnect] fixInterfaceNames failed, continuing:', fixError);
      }

      if (interfaces.length == 1) {
        device = await connect(new dfu.Device(selectedDevice, interfaces[0]));
      } else {
        populateInterfaceDialog(selectedDevice, interfaces);
      }
    } catch (error) {
      console.error('[doConnect] Error:', error);
      document.querySelector('#statusText').textContent = formatError(error);
    }
  }

  function populateInterfaceDialog(selectedDevice, interfaces) {
    const list = document.querySelector('#interfaceList');
    const dialog = document.querySelector('#interfaceDialog');
    const form = document.querySelector('#interfaceForm');
    list.innerHTML = '';

    for (let i = 0; i < interfaces.length; i++) {
      const label = document.createElement('label');
      label.className = 'interface-option';
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'interfaceIndex';
      radio.value = i;
      if (i === 0) radio.checked = true;
      label.appendChild(radio);
      label.appendChild(document.createTextNode(formatDFUInterfaceAlternate(interfaces[i])));
      list.appendChild(label);
    }

    const handler = async (e) => {
      e.preventDefault();
      const index = parseInt(form.elements['interfaceIndex'].value);
      dialog.close();
      device = await connect(new dfu.Device(selectedDevice, interfaces[index]));
    };

    form.onsubmit = handler;
    dialog.showModal();
  }

  /* ---------- Flash / Upload ---------- */
  async function doFlash() {
    if (!device || !device.device_.opened) {
      onDisconnect();
      return;
    }
    if (!selectedFirmwareBuffer) {
      logError('No firmware selected.');
      return;
    }

    setLogContext(document.querySelector('#downloadLog'));
    clearLog(document.querySelector('#downloadLog'));

    try {
      const status = await device.getStatus();
      if (status.state == dfu.dfuERROR) await device.clearStatus();
    } catch (error) {
      logWarning('Failed to clear status');
    }

    if (isWindowsARM()) {
      logWarning('Flashing on Windows ARM can be very slow. Do not close this tab.');
    }

    try {
      await device.do_download(transferSize, selectedFirmwareBuffer, manifestationTolerant);
      logSuccess('Done!');
    } catch (error) {
      logError(formatError(error));
    }
  }

  async function doUpload() {
    if (!device || !device.device_.opened) {
      onDisconnect();
      return;
    }

    const uploadLog = document.querySelector('#uploadLog');
    uploadLog.classList.remove('hidden');
    setLogContext(uploadLog);
    clearLog(uploadLog);

    try {
      const status = await device.getStatus();
      if (status.state == dfu.dfuERROR) await device.clearStatus();
    } catch (error) {
      logWarning('Failed to clear status');
    }

    try {
      const blob = await device.do_upload(transferSize, Infinity);
      saveAs(blob, 'firmware-backup.bin');
      logSuccess('Upload complete.');
    } catch (error) {
      logError(formatError(error));
    }
  }

  /* ---------- Event wiring ---------- */
  function initEventListeners() {
    document.querySelector('#connectBtn').addEventListener('click', doConnect);
    document.querySelector('#detachBtn').addEventListener('click', async () => {
      if (!device) return;
      try {
        await device.detach();
        await device.close();
        await device.waitDisconnected(5000).catch(() => {});
      } catch (error) {
        console.log(error);
      }
      onDisconnect();
    });

    document.querySelector('#flashBtn').addEventListener('click', doFlash);
    document.querySelector('#uploadBtn').addEventListener('click', doUpload);

    document.querySelector('#bootloaderPreset').addEventListener('change', applyBootloaderPreset);
    document.querySelector('#transferSize').addEventListener('change', (e) => {
      transferSize = parseInt(e.target.value);
    });
    document.querySelector('#vid').addEventListener('change', () => {
      document.querySelector('#bootloaderPreset').value = 'custom';
      applyBootloaderPreset();
    });
    document.querySelector('#pid').addEventListener('change', () => {
      document.querySelector('#bootloaderPreset').value = 'custom';
      applyBootloaderPreset();
    });

    /* Source tabs */
    document.querySelectorAll('.source-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.source-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        firmwareSource = tab.dataset.source;
        document.querySelector('#githubSource').classList.toggle('hidden', firmwareSource !== 'github');
        document.querySelector('#localSource').classList.toggle('hidden', firmwareSource !== 'local');
        selectedFirmwareBuffer = null;
        document.querySelector('#flashBtn').disabled = !(device && device.device_.opened);
      });
    });

    /* GitHub firmware select */
    document.querySelector('#githubFirmwareSelect').addEventListener('change', async (e) => {
      const keyboard = e.target.value;
      updateFirmwareMeta(keyboard);
      if (!keyboard) {
        selectedFirmwareBuffer = null;
        document.querySelector('#flashBtn').disabled = true;
        return;
      }
      setLogContext(document.querySelector('#downloadLog'));
      logInfo(`Loading ${keyboard} firmware from GitHub...`);
      try {
        selectedFirmwareBuffer = await fetchFirmwareBinary(keyboard);
        logSuccess(`Loaded ${niceSize(selectedFirmwareBuffer.byteLength)}`);
        document.querySelector('#flashBtn').disabled = !(device && device.device_.opened);
      } catch (error) {
        logError(formatError(error));
        selectedFirmwareBuffer = null;
        document.querySelector('#flashBtn').disabled = true;
      }
    });

    /* Local firmware file */
    document.querySelector('#firmwareFile').addEventListener('change', (e) => {
      selectedFirmwareBuffer = null;
      if (e.target.files.length > 0) {
        const reader = new FileReader();
        reader.onload = () => {
          selectedFirmwareBuffer = reader.result;
          document.querySelector('#flashBtn').disabled = !(device && device.device_.opened);
        };
        reader.readAsArrayBuffer(e.target.files[0]);
      }
    });
  }

  function initPlatformWarning() {
    if (!isWindowsARM()) return;
    const div = document.querySelector('#platformWarning');
    div.innerHTML = `
      <div class="alert alert-warning">
        <strong>Windows on ARM detected.</strong> Chromium-based browsers on Windows ARM currently suffer from very slow USB control transfers,
        so flashing may take tens of minutes. If possible, flash from Windows x64, Linux, or macOS instead.
        See <a href="https://issues.chromium.org/issues/494543570" target="_blank">Chromium issue 494543570</a>.
      </div>
    `;
  }

  function initWebUSB() {
    if (typeof navigator.usb !== 'undefined') {
      navigator.usb.addEventListener('disconnect', onUnexpectedDisconnect);
      loadFirmwareManifest();
    } else {
      document.querySelector('#statusText').textContent = 'WebUSB not available. Please use Chrome, Edge, or another Chromium-based browser.';
      document.querySelector('#connectBtn').disabled = true;
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    initTheme();
    initPlatformWarning();
    initEventListeners();
    applyBootloaderPreset();
    initWebUSB();
    setLogContext(document.querySelector('#downloadLog'));
  });
})();

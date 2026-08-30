// Wait for A-Frame scene to load

// Bump this string whenever this file changes and render it on the status HUD (bottom-right
// corner of the status card) so it's possible to visually confirm from inside the headset that
// a fresh copy actually loaded, rather than the browser silently reusing an already-open tab's
// old in-memory JS across `lerobot-record` restarts (server-side edits alone can't fix that —
// the page has to actually be closed/reopened or hard-reloaded to pick them up).
const APP_JS_VERSION = '2026-08-30-ws-auto-reconnect';

AFRAME.registerComponent('controller-updater', {
  init: function () {
    console.log("Controller updater component initialized.");
    // Controllers are enabled

    this.leftHand = document.querySelector('#leftHand');
    this.rightHand = document.querySelector('#rightHand');
    this.leftHandInfoText = document.querySelector('#leftHandInfo');
    this.rightHandInfoText = document.querySelector('#rightHandInfo');
    
    // Add headset tracking
    this.headset = document.querySelector('#headset');
    this.headsetInfoText = document.querySelector('#headsetInfo');

    // --- WebSocket Setup ---
    this.websocket = null;
    this.leftGripDown = false;
    this.rightGripDown = false;
    this.leftTriggerDown = false;
    this.rightTriggerDown = false;

    // --- Status reporting ---
    this.lastStatusUpdate = 0;
    this.statusUpdateInterval = 5000; // 5 seconds

    // --- Relative rotation tracking ---
    this.leftGripInitialRotation = null;
    this.rightGripInitialRotation = null;
    this.leftRelativeRotation = { x: 0, y: 0, z: 0 };
    this.rightRelativeRotation = { x: 0, y: 0, z: 0 };

    // --- Quaternion-based Z-axis rotation tracking ---
    this.leftGripInitialQuaternion = null;
    this.rightGripInitialQuaternion = null;
    this.leftZAxisRotation = 0;
    this.rightZAxisRotation = 0;

    // --- Get hostname dynamically ---
    const serverHostname = window.location.hostname;
    const websocketPort = 8442; // Make sure this matches controller_server.py
    const websocketUrl = `wss://${serverHostname}:${websocketPort}`;
    // !!! IMPORTANT: Replace 'YOUR_LAPTOP_IP' with the actual IP address of your laptop !!!
    // const websocketUrl = 'ws://YOUR_LAPTOP_IP:8442';

    // A one-shot WebSocket with no retry means the *first* failure (a cert-trust race on
    // launch, the headset waking from sleep, a brief Wi-Fi drop) permanently kills teleop
    // until the operator notices and manually reloads the page -- from inside the headset,
    // with no visible cause, that reads as "the window/teleoperation just stopped working".
    // connectWebSocket() is instead callable repeatedly and reschedules itself on every
    // close/error, so the page keeps trying to recover on its own.
    this._wsReconnectTimer = null;
    this._wsReconnectAttempts = 0;
    const connectWebSocket = () => {
      console.log(`Attempting WebSocket connection to: ${websocketUrl}`);
      try {
        this.websocket = new WebSocket(websocketUrl);
        this.websocket.onopen = (event) => {
          console.log(`WebSocket connected to ${websocketUrl}`);
          this._wsReconnectAttempts = 0;
          this.reportVRStatus(true);
          const banner = document.getElementById('xr-diagnostic-banner');
          if (banner) banner.remove();
        };
        this.websocket.onerror = (event) => {
          // More detailed error logging
          console.error(`WebSocket Error: Event type: ${event.type}`, event);
          this.reportVRStatus(false);
          // The single most common cause: the HTTPS page (this origin, port 8443) and the
          // WebSocket server (port 8442) use the same self-signed cert, but browsers trust
          // self-signed certs per origin+port -- accepting the warning for 8443 does NOT also
          // trust 8442. If this page was never separately opened at :8442, every WS handshake
          // fails right here, silently (browsers don't expose the real reason to JS), and no
          // button press can ever reach the server even if the VR session itself looks fine.
          showXrDiagnostic(
              `Cannot reach the control server at ${websocketUrl}. Open ` +
              `https://${serverHostname}:${websocketPort} in a new browser tab, accept the ` +
              `"not secure" certificate warning there. Retrying automatically...`
          );
        };
        this.websocket.onclose = (event) => {
          console.log(`WebSocket disconnected from ${websocketUrl}. Clean close: ${event.wasClean}, Code: ${event.code}, Reason: '${event.reason}'`);
          this.websocket = null; // Clear the reference
          this.reportVRStatus(false);
          // Retry with a capped backoff (1s, 2s, 3s, ... up to 5s) instead of giving up --
          // teleoperation cannot start at all while this.websocket is null, so recovering
          // without a manual page reload matters more than backing off aggressively.
          this._wsReconnectAttempts += 1;
          const delayMs = Math.min(5000, 1000 * this._wsReconnectAttempts);
          if (!event.wasClean) {
            console.error('WebSocket closed unexpectedly. Reconnecting in', delayMs, 'ms');
            showXrDiagnostic(
                `Lost connection to the control server at ${websocketUrl} (code ${event.code}). ` +
                `If this keeps happening, open https://${serverHostname}:${websocketPort} ` +
                `directly and accept its certificate. Retrying automatically...`
            );
          }
          if (this._wsReconnectTimer) clearTimeout(this._wsReconnectTimer);
          this._wsReconnectTimer = setTimeout(connectWebSocket, delayMs);
        };
        this.websocket.onmessage = (event) => {
          if (event.data instanceof Blob) {
            // Binary message: a JPEG-encoded robot camera frame (see broadcast_camera_frame
            // in vr_ws_server.py).
            this.handleCameraFrame(event.data);
            return;
          }
          // Text message: either a status update (see broadcast_status in vr_ws_server.py) or
          // some other server text we just log, same as before.
          try {
            const data = JSON.parse(event.data);
            if (data && data.type === 'status') {
              this.handleStatusUpdate(data);
              return;
            }
          } catch (e) {
            // Not JSON — fall through to plain logging below.
          }
          console.log(`WebSocket message received: ${event.data}`); // Log any messages from server
        };
      } catch (error) {
          console.error(`Failed to create WebSocket connection to ${websocketUrl}:`, error);
          this.reportVRStatus(false);
          this._wsReconnectAttempts += 1;
          const delayMs = Math.min(5000, 1000 * this._wsReconnectAttempts);
          if (this._wsReconnectTimer) clearTimeout(this._wsReconnectTimer);
          this._wsReconnectTimer = setTimeout(connectWebSocket, delayMs);
      }
    };
    connectWebSocket();
    // --- End WebSocket Setup ---

    // --- Robot camera panels (floating HUD quads showing the robot's own camera feeds) ---
    // Keyed by camera name -> { canvas, ctx, plane }
    this.cameraPanels = {};

    this.handleCameraFrame = async (blob) => {
      try {
        const buf = await blob.arrayBuffer();
        const bytes = new Uint8Array(buf);
        const nameLen = bytes[0];
        const camName = new TextDecoder('utf-8').decode(bytes.slice(1, 1 + nameLen));
        const jpegBytes = bytes.slice(1 + nameLen);
        const bitmap = await createImageBitmap(new Blob([jpegBytes], { type: 'image/jpeg' }));
        this.drawCameraFrame(camName, bitmap);
        bitmap.close();
      } catch (error) {
        console.error('Error handling camera frame:', error);
      }
    };

    this.drawCameraFrame = (camName, bitmap) => {
      let panel = this.cameraPanels[camName];
      if (!panel) {
        panel = this.createCameraPanel(camName, bitmap.width, bitmap.height);
        this.cameraPanels[camName] = panel;
      }
      panel.ctx.drawImage(bitmap, 0, 0, panel.canvas.width, panel.canvas.height);
      // Look up the live material each frame rather than relying on a reference cached once at
      // 'loaded' time — some WebXR browsers swap/rebuild the material internally, which would
      // otherwise leave us marking a stale, no-longer-rendered texture as dirty (frozen frame).
      const mesh = panel.plane.getObject3D('mesh');
      const map = mesh && mesh.material && mesh.material.map;
      if (map) {
        map.needsUpdate = true;
        if (mesh.material) mesh.material.needsUpdate = true;
      }
    };

    // Camera panels are laid out in a fixed, tightly-grouped arrangement (independent of the
    // order frames happen to arrive in): wide head/overview camera on top, centered; wrist
    // cameras in a row below it, with left_wrist on the operator's left (-X) and right_wrist on
    // their right (+X), matching the robot's actual left/right.
    // Vertical gap between the two rows must clear (head half-height + wrist half-height) =
    // ~0.57m (1.1m-wide head at 4:3 -> 0.83m tall; 0.55m-wide wrists at 16:9 -> 0.31m tall).
    // 0.4 vs -0.25 leaves a small but safe margin above that.
    const CAMERA_PANEL_SLOTS = {
      head: { x: 0, y: 0.4, width: 1.1 },
      left_wrist: { x: -0.32, y: -0.25, width: 0.55 },
      right_wrist: { x: 0.32, y: -0.25, width: 0.55 },
      // Depth view: extends the wrist row to the right (right_wrist's right edge is at
      // x=0.595), rather than sitting off in the head row at a much wider angle from center —
      // easier to notice since it's contiguous with the panel cluster the operator is already
      // looking at. Hidden by default, toggled on/off via RIGHT thumbstick click (see
      // handleStatusUpdate / XLerobotVRTeleop._update_depth_toggle).
      head_depth: { x: 0.95, y: -0.25, width: 0.55 },
    };
    const PANEL_Z = -1.3;
    const depthPanelName = 'head_depth';

    // --- Episode start/stop audio cues ---
    // Generated tones via WebAudio (no audio asset files needed). AudioContext creation is
    // deferred until first use since it must follow a user gesture on most browsers — the
    // "Start" button tap that begins the WebXR session counts, but resuming defensively here
    // covers browsers that suspend it again between session starts.
    this.audioCtx = null;
    this.getAudioCtx = () => {
      if (!this.audioCtx) {
        const AudioCtor = window.AudioContext || window.webkitAudioContext;
        this.audioCtx = new AudioCtor();
      }
      if (this.audioCtx.state === 'suspended') {
        this.audioCtx.resume();
      }
      return this.audioCtx;
    };

    this.playTone = (freq, startDelayMs, durationMs) => {
      try {
        const ctx = this.getAudioCtx();
        const startAt = ctx.currentTime + startDelayMs / 1000;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, startAt);
        gain.gain.exponentialRampToValueAtTime(0.2, startAt + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, startAt + durationMs / 1000);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(startAt);
        osc.stop(startAt + durationMs / 1000 + 0.02);
      } catch (error) {
        console.error('Error playing tone:', error);
      }
    };

    // Rising two-note chime for "recording started"; falling two-note chime for "stopped" —
    // distinct enough to tell apart without looking at the HUD.
    this.playEpisodeStartSound = () => {
      this.playTone(880, 0, 110);
      this.playTone(1318.5, 120, 160);
    };
    this.playEpisodeStopSound = () => {
      this.playTone(659.25, 0, 130);
      this.playTone(392, 140, 220);
    };
    // Single short high tone — "control re-enabled" (the LEFT X recording gate just opened; see
    // teleop.vr_event_handler.reset_recording_gate() / _process_left_x in xlerobot_vr.py).
    // Deliberately a single note so it doesn't get confused with the two-note start/stop chimes.
    this.playControlEnabledDing = () => {
      this.playTone(1567.98, 0, 90);
    };
    // --- End audio cues ---

    // --- Status HUD (task / episode / elapsed time / button legend) ---
    // Drawn on a canvas (same technique as the camera panels) instead of plain <a-text> so the
    // recording indicator, episode counter and progress bar can actually look like a HUD rather
    // than a stack of text lines. Positioned below the wrist camera row, centered under the
    // whole camera group. Canvas is taller than its drawn content (~280px of 380px used) so
    // everything sits in the top portion of the card with clear space below, instead of
    // stretching/clipping to fill it. Wrist bottom edge is at y=-0.405; at width 1.3 this
    // panel's half-height is ~0.475, so y=-0.94 clears that with a small margin.
    const STATUS_PANEL = { x: 0, y: -0.94, width: 1.3 };
    const STATUS_CANVAS_W = 520;
    const STATUS_CANVAS_H = 380;

    // Static legend text — button mapping doesn't change at runtime, so this is just hardcoded
    // to match the control guide already printed server-side (xlerobot_vr.py's connect() log).
    const BUTTON_LEGEND = [
      'Grip: move arm      Trigger: gripper',
      'R-stick: drive      L-stick: rotate / lift',
      'X: start recording (once per episode)',
      'Y: restart ep       B: finish ep',
      'Menu tap: stop rec  Menu hold: passthrough',
      'L-stick click: reset robot pose',
      'R-stick click: toggle depth view',
    ];

    const drawRoundedRect = (ctx, x, y, w, h, r) => {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    };

    const formatMmSs = (totalSeconds) => {
      const s = Math.max(0, Math.round(totalSeconds || 0));
      const m = Math.floor(s / 60);
      const rem = s % 60;
      return `${m}:${rem.toString().padStart(2, '0')}`;
    };

    // Creates the off-screen canvas + <a-plane> for the status HUD, same pattern as
    // createCameraPanel below (off-screen positioning, not display:none, to avoid the
    // stale-backing-store issue some WebXR browsers have with hidden canvases).
    this.createStatusPanel = () => {
      const canvas = document.createElement('canvas');
      canvas.width = STATUS_CANVAS_W;
      canvas.height = STATUS_CANVAS_H;
      canvas.id = 'status-hud-canvas';
      canvas.style.position = 'fixed';
      canvas.style.left = '-99999px';
      canvas.style.top = '0';
      document.body.appendChild(canvas);

      const plane = document.createElement('a-plane');
      const height = STATUS_PANEL.width * (STATUS_CANVAS_H / STATUS_CANVAS_W);
      plane.setAttribute('width', STATUS_PANEL.width);
      plane.setAttribute('height', height);
      plane.setAttribute('position', `${STATUS_PANEL.x} ${STATUS_PANEL.y} ${PANEL_Z}`);
      plane.setAttribute('material', `shader: flat; src: #${canvas.id}; side: double; transparent: true`);
      this.headset.appendChild(plane);

      return { canvas, ctx: canvas.getContext('2d'), plane };
    };

    this.statusPanelObj = null; // { canvas, ctx, plane }
    // Merged HUD state: one-shot pings (episode_event, recording_enabled, depth toggle,
    // passthrough) must not wipe task/episode/elapsed fields from the last full push.
    this._hudStatus = {};

    // Tracks the last-known depth-view state so setPassthroughDeclutter can restore the depth
    // panel to the right visibility (rather than force-showing it) when un-hiding the HUD.
    this._depthViewEnabled = false;

    // The WebXR session here is always requested as immersive-ar (see the enterVR(true) call
    // above), so camera passthrough itself is already active for the whole session — there is
    // no separate VR/AR mode to flip mid-session. What "passthrough toggle" (LEFT menu long-press,
    // see XLerobotVRTeleop._dispatch_semantic's "toggle_passthrough") actually does here is hide
    // all the floating HUD panels (camera feeds + status card) so the operator gets a fully
    // unobstructed passthrough view of the real robot/workspace, then restores them on toggle-off.
    this.setPassthroughDeclutter = (enabled) => {
      for (const key in this.cameraPanels) {
        const visible = enabled ? false : (key === depthPanelName ? this._depthViewEnabled : true);
        this.cameraPanels[key].plane.setAttribute('visible', visible);
      }
      if (this.statusPanelObj) {
        this.statusPanelObj.plane.setAttribute('visible', !enabled);
      }
    };

    // status: { task, episode_idx, episode_total, elapsed_s, episode_duration_s,
    // depth_view_enabled, passthrough_enabled, episode_event } — see teleop.send_status() /
    // _update_depth_toggle() / _dispatch_semantic() / send_episode_event() in xlerobot_vr.py and
    // record_loop in lerobot_record.py. Any field may be absent — depth_view_enabled,
    // passthrough_enabled, recording_enabled and episode_event each arrive on their own the
    // moment they happen, independent of the once-a-second task/episode update.
    this.handleStatusUpdate = (incoming) => {
      if (incoming.episode_event === 'start') {
        this.playEpisodeStartSound();
      } else if (incoming.episode_event === 'stop') {
        this.playEpisodeStopSound();
      }

      // Ding is one-shot on the gate-open ping; do not persist recording_enabled or it
      // would retrigger on every later redraw.
      if (incoming.recording_enabled) {
        this.playControlEnabledDing();
      }

      // Merge persistent HUD fields so a depth/passthrough/chime ping cannot blank
      // the task/episode/timer card.
      for (const key of Object.keys(incoming)) {
        if (key === 'type' || key === 'episode_event' || key === 'recording_enabled') continue;
        this._hudStatus[key] = incoming[key];
      }
      const status = this._hudStatus;

      if (incoming.depth_view_enabled !== undefined) {
        this._depthViewEnabled = incoming.depth_view_enabled;
        // The depth panel is created lazily by drawCameraFrame the first time a depth frame
        // arrives (server only sends depth frames while the view is toggled on), so hide/show
        // it here rather than assuming it already exists.
        const depthPanel = this.cameraPanels[depthPanelName];
        if (depthPanel) {
          depthPanel.plane.setAttribute('visible', incoming.depth_view_enabled);
        }
      }

      if (incoming.passthrough_enabled !== undefined) {
        this.setPassthroughDeclutter(incoming.passthrough_enabled);
      }

      if (!this.statusPanelObj) {
        this.statusPanelObj = this.createStatusPanel();
      }
      const { canvas, ctx } = this.statusPanelObj;
      const w = canvas.width;
      const h = canvas.height;
      // Episode counter is shown for the whole episode (including the reposition/gate-wait
      // phase before LEFT X is pressed); recording_active is what's actually true only while
      // frames are being captured — see `_recording_active` / record_loop in lerobot_record.py.
      const hasEpisode = status.episode_idx != null && status.episode_total != null;
      const isRecording = hasEpisode && !!status.recording_active;

      ctx.clearRect(0, 0, w, h);

      // Background card.
      ctx.fillStyle = 'rgba(18, 18, 22, 0.88)';
      drawRoundedRect(ctx, 0, 0, w, h, 18);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
      ctx.lineWidth = 2;
      drawRoundedRect(ctx, 1, 1, w - 2, h - 2, 18);
      ctx.stroke();

      const padX = 24;
      let cursorY = 36;

      // Recording indicator + episode counter, same row.
      if (hasEpisode) {
        ctx.beginPath();
        ctx.arc(padX + 10, cursorY - 7, 10, 0, Math.PI * 2);
        ctx.fillStyle = isRecording ? '#ff3b3b' : '#ffb020';
        ctx.fill();
        ctx.fillStyle = isRecording ? '#ff3b3b' : '#ffb020';
        ctx.font = 'bold 26px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(isRecording ? 'REC' : 'READY', padX + 28, cursorY);

        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 26px sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText(`EP ${status.episode_idx} / ${status.episode_total}`, w - padX, cursorY);
      } else {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
        ctx.font = 'bold 24px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText('Not recording', padX, cursorY);
      }
      cursorY += 30;

      // Task name, word-wrapped to fit the card width.
      if (status.task) {
        ctx.fillStyle = '#e8e8e8';
        ctx.font = '22px sans-serif';
        ctx.textAlign = 'left';
        const maxWidth = w - padX * 2;
        const words = String(status.task).split(' ');
        let line = '';
        const taskLines = [];
        for (const word of words) {
          const candidate = line ? `${line} ${word}` : word;
          if (ctx.measureText(candidate).width > maxWidth && line) {
            taskLines.push(line);
            line = word;
          } else {
            line = candidate;
          }
        }
        if (line) taskLines.push(line);
        for (const l of taskLines.slice(0, 2)) {
          cursorY += 26;
          ctx.fillText(l, padX, cursorY);
        }
        cursorY += 8;
      }

      // Reposition/gate-wait hint — shown only while EP x/y is up but capture hasn't started yet.
      if (hasEpisode && !isRecording) {
        cursorY += 18;
        ctx.fillStyle = '#ffb020';
        ctx.font = 'bold 20px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText('Press LEFT X to start recording', padX, cursorY);
      }

      // Elapsed-time progress bar.
      if (isRecording && status.elapsed_s != null) {
        cursorY += 18;
        const barX = padX;
        const barW = w - padX * 2;
        const barH = 12;
        const duration = status.episode_duration_s || 0;
        const frac = duration > 0 ? Math.min(1, status.elapsed_s / duration) : 0;

        ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
        drawRoundedRect(ctx, barX, cursorY, barW, barH, barH / 2);
        ctx.fill();

        if (frac > 0) {
          ctx.fillStyle = '#3ba3ff';
          drawRoundedRect(ctx, barX, cursorY, Math.max(barH, barW * frac), barH, barH / 2);
          ctx.fill();
        }

        cursorY += barH + 22;
        ctx.fillStyle = '#cccccc';
        ctx.font = '20px sans-serif';
        ctx.textAlign = 'left';
        const timeLabel = duration > 0
          ? `${formatMmSs(status.elapsed_s)} / ${formatMmSs(duration)}`
          : formatMmSs(status.elapsed_s);
        ctx.fillText(timeLabel, barX, cursorY);
      }

      // Divider.
      cursorY += 16;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padX, cursorY);
      ctx.lineTo(w - padX, cursorY);
      ctx.stroke();

      // Button legend.
      ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
      ctx.font = '17px monospace';
      ctx.textAlign = 'left';
      for (const legendLine of BUTTON_LEGEND) {
        cursorY += 22;
        ctx.fillText(legendLine, padX, cursorY);
      }

      // Build-version stamp — see APP_JS_VERSION comment at the top of this file.
      ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
      ctx.font = '13px monospace';
      ctx.textAlign = 'right';
      ctx.fillText(`js:${APP_JS_VERSION}`, w - padX, h - 14);

      const mesh = this.statusPanelObj.plane.getObject3D('mesh');
      const map = mesh && mesh.material && mesh.material.map;
      if (map) {
        map.needsUpdate = true;
        if (mesh.material) mesh.material.needsUpdate = true;
      }
    };
    // Draw the legend immediately so the operator sees controls before the first
    // lerobot-record status push (otherwise the card appears only after ~0.2s).
    this.handleStatusUpdate({});
    // --- End status HUD ---

    // Creates an off-screen <canvas> plus an <a-plane> quad (child of the headset entity, so it
    // acts as a HUD panel) that textures itself from that canvas. One panel is created per
    // distinct camera name the first time a frame for it arrives.
    this.createCameraPanel = (camName, width, height) => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.id = `camera-canvas-${camName}`;
      // Keep the canvas out of the visible layout but NOT display:none — some WebXR browsers
      // skip updating the backing store of display:none canvases, which would freeze the
      // texture after the first frame. Positioning off-screen avoids that.
      canvas.style.position = 'fixed';
      canvas.style.left = '-99999px';
      canvas.style.top = '0';
      document.body.appendChild(canvas);

      // Unknown camera name: fall back to a slot below the known ones instead of overlapping them.
      const unknownIndex = Object.keys(this.cameraPanels).length;
      const slot = CAMERA_PANEL_SLOTS[camName] || { x: 0, y: -1.0 - unknownIndex * 0.5, width: 0.7 };
      const panelHeight = slot.width * (height / width);

      const plane = document.createElement('a-plane');
      plane.setAttribute('width', slot.width);
      plane.setAttribute('height', panelHeight);
      plane.setAttribute('position', `${slot.x} ${slot.y} ${PANEL_Z}`);
      plane.setAttribute('material', `shader: flat; src: #${canvas.id}; side: double`);
      this.headset.appendChild(plane);

      const panel = { canvas, ctx: canvas.getContext('2d'), plane };
      return panel;
    };
    // --- End robot camera panels ---

    // --- VR Status Reporting Function ---
    this.reportVRStatus = (connected) => {
      // Update global status if available (for desktop interface)
      if (typeof updateStatus === 'function') {
        updateStatus({ vrConnected: connected });
      }
      
      // Also try to notify parent window if in iframe
      try {
        if (window.parent && window.parent !== window) {
          window.parent.postMessage({
            type: 'vr_status',
            connected: connected
          }, '*');
        }
      } catch (e) {
        // Ignore cross-origin errors
      }
    };

    if (!this.leftHand || !this.rightHand || !this.leftHandInfoText || !this.rightHandInfoText) {
      console.error("Controller or text entities not found!");
      // Check which specific elements are missing
      if (!this.leftHand) console.error("Left hand entity not found");
      if (!this.rightHand) console.error("Right hand entity not found");
      if (!this.leftHandInfoText) console.error("Left hand info text not found");
      if (!this.rightHandInfoText) console.error("Right hand info text not found");
      return;
    }

    // Apply initial rotation to combined text elements
    const textRotation = '-90 0 0'; // Rotate -90 degrees around X-axis
    if (this.leftHandInfoText) this.leftHandInfoText.setAttribute('rotation', textRotation);
    if (this.rightHandInfoText) this.rightHandInfoText.setAttribute('rotation', textRotation);

    // xr-standard gamepad layout used by A-Frame 1.7 / WebXR (NOT the older Oculus-native
    // indices). buttons[3] is thumbstick click, [4] is X/A, [5] is Y/B. The previous
    // mapping (x=3, y=4, thumbstick=2) made X look like a thumbstick click and Y like X,
    // which is why episode start/rerecord felt random.
    this.leftButtons = { x: false, y: false, squeeze: false, thumbstick: false, menu: false };
    this.rightButtons = { a: false, b: false, squeeze: false, thumbstick: false, menu: false };
    const bindFaceButton = (el, store, eventBase, key) => {
      el.addEventListener(eventBase + 'down', () => { store[key] = true; });
      el.addEventListener(eventBase + 'up', () => { store[key] = false; });
    };
    bindFaceButton(this.leftHand, this.leftButtons, 'xbutton', 'x');
    bindFaceButton(this.leftHand, this.leftButtons, 'ybutton', 'y');
    bindFaceButton(this.leftHand, this.leftButtons, 'grip', 'squeeze');
    bindFaceButton(this.leftHand, this.leftButtons, 'thumbstick', 'thumbstick');
    bindFaceButton(this.leftHand, this.leftButtons, 'menu', 'menu');
    bindFaceButton(this.rightHand, this.rightButtons, 'abutton', 'a');
    bindFaceButton(this.rightHand, this.rightButtons, 'bbutton', 'b');
    bindFaceButton(this.rightHand, this.rightButtons, 'grip', 'squeeze');
    bindFaceButton(this.rightHand, this.rightButtons, 'thumbstick', 'thumbstick');
    bindFaceButton(this.rightHand, this.rightButtons, 'menu', 'menu');

    // --- Create axis indicators ---
    this.createAxisIndicators();

    // --- Helper function to send grip release message ---
    this.sendGripRelease = (hand) => {
      if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
        const releaseMessage = {
          hand: hand,
          gripReleased: true
        };
        this.websocket.send(JSON.stringify(releaseMessage));
        console.log(`Sent grip release for ${hand} hand`);
      }
    };

    // --- Helper function to send trigger release message ---
    this.sendTriggerRelease = (hand) => {
      if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
        const releaseMessage = {
          hand: hand,
          triggerReleased: true
        };
        this.websocket.send(JSON.stringify(releaseMessage));
        console.log(`Sent trigger release for ${hand} hand`);
      }
    };

    // --- Helper function to calculate relative rotation ---
    this.calculateRelativeRotation = (currentRotation, initialRotation) => {
      return {
        x: currentRotation.x - initialRotation.x,
        y: currentRotation.y - initialRotation.y,
        z: currentRotation.z - initialRotation.z
      };
    };

    // --- Helper function to calculate Z-axis rotation from quaternions ---
    this.calculateZAxisRotation = (currentQuaternion, initialQuaternion) => {
      // Calculate relative quaternion (from initial to current)
      const relativeQuat = new THREE.Quaternion();
      relativeQuat.multiplyQuaternions(currentQuaternion, initialQuaternion.clone().invert());
      
      // Get the controller's current forward direction (local Z-axis in world space)
      const forwardDirection = new THREE.Vector3(0, 0, 1);
      forwardDirection.applyQuaternion(currentQuaternion);
      
      // Convert relative quaternion to axis-angle representation
      const angle = 2 * Math.acos(Math.abs(relativeQuat.w));
      
      // Handle case where there's no rotation (avoid division by zero)
      if (angle < 0.0001) {
        return 0;
      }
      
      // Get the rotation axis
      const sinHalfAngle = Math.sqrt(1 - relativeQuat.w * relativeQuat.w);
      const rotationAxis = new THREE.Vector3(
        relativeQuat.x / sinHalfAngle,
        relativeQuat.y / sinHalfAngle,
        relativeQuat.z / sinHalfAngle
      );
      
      // Project the rotation axis onto the forward direction to get the component
      // of rotation around the forward axis
      const projectedComponent = rotationAxis.dot(forwardDirection);
      
      // The rotation around the forward axis is the angle times the projection
      const forwardRotation = angle * projectedComponent;
      
      // Convert to degrees and handle the sign properly
      let degrees = THREE.MathUtils.radToDeg(forwardRotation);
      
      // Normalize to -180 to +180 range to avoid sudden jumps
      while (degrees > 180) degrees -= 360;
      while (degrees < -180) degrees += 360;
      
      return degrees;
    };

    // --- Modify Event Listeners ---
    this.leftHand.addEventListener('triggerdown', (evt) => {
        console.log('Left Trigger Pressed');
        this.leftTriggerDown = true;
    });
    this.leftHand.addEventListener('triggerup', (evt) => {
        console.log('Left Trigger Released');
        this.leftTriggerDown = false;
        this.sendTriggerRelease('left'); // Send trigger release message
    });
    this.leftHand.addEventListener('gripdown', (evt) => {
        console.log('Left Grip Pressed');
        this.leftGripDown = true; // Set grip state
        
        // Store initial rotation for relative tracking
        if (this.leftHand.object3D.visible) {
          const leftRotEuler = this.leftHand.object3D.rotation;
          this.leftGripInitialRotation = {
            x: THREE.MathUtils.radToDeg(leftRotEuler.x),
            y: THREE.MathUtils.radToDeg(leftRotEuler.y),
            z: THREE.MathUtils.radToDeg(leftRotEuler.z)
          };
          
          // Store initial quaternion for Z-axis rotation tracking
          this.leftGripInitialQuaternion = this.leftHand.object3D.quaternion.clone();
          
          console.log('Left grip initial rotation:', this.leftGripInitialRotation);
          console.log('Left grip initial quaternion:', this.leftGripInitialQuaternion);
        }
    });
    this.leftHand.addEventListener('gripup', (evt) => { // Add gripup listener
        console.log('Left Grip Released');
        this.leftGripDown = false; // Reset grip state
        this.leftGripInitialRotation = null; // Reset initial rotation
        this.leftGripInitialQuaternion = null; // Reset initial quaternion
        this.leftRelativeRotation = { x: 0, y: 0, z: 0 }; // Reset relative rotation
        this.leftZAxisRotation = 0; // Reset Z-axis rotation
        this.sendGripRelease('left'); // Send grip release message
    });

    this.rightHand.addEventListener('triggerdown', (evt) => {
        console.log('Right Trigger Pressed');
        this.rightTriggerDown = true;
    });
    this.rightHand.addEventListener('triggerup', (evt) => {
        console.log('Right Trigger Released');
        this.rightTriggerDown = false;
        this.sendTriggerRelease('right'); // Send trigger release message
    });
    this.rightHand.addEventListener('gripdown', (evt) => {
        console.log('Right Grip Pressed');
        this.rightGripDown = true; // Set grip state
        
        // Store initial rotation for relative tracking
        if (this.rightHand.object3D.visible) {
          const rightRotEuler = this.rightHand.object3D.rotation;
          this.rightGripInitialRotation = {
            x: THREE.MathUtils.radToDeg(rightRotEuler.x),
            y: THREE.MathUtils.radToDeg(rightRotEuler.y),
            z: THREE.MathUtils.radToDeg(rightRotEuler.z)
          };
          
          // Store initial quaternion for Z-axis rotation tracking
          this.rightGripInitialQuaternion = this.rightHand.object3D.quaternion.clone();
          
          console.log('Right grip initial rotation:', this.rightGripInitialRotation);
          console.log('Right grip initial quaternion:', this.rightGripInitialQuaternion);
        }
    });
    this.rightHand.addEventListener('gripup', (evt) => { // Add gripup listener
        console.log('Right Grip Released');
        this.rightGripDown = false; // Reset grip state
        this.rightGripInitialRotation = null; // Reset initial rotation
        this.rightGripInitialQuaternion = null; // Reset initial quaternion
        this.rightRelativeRotation = { x: 0, y: 0, z: 0 }; // Reset relative rotation
        this.rightZAxisRotation = 0; // Reset Z-axis rotation
        this.sendGripRelease('right'); // Send grip release message
    });
    // --- End Modify Event Listeners ---

  },

  createAxisIndicators: function() {
    // Create XYZ axis indicators for both controllers
    
    // Left Controller Axes
    // X-axis (Red)
    const leftXAxis = document.createElement('a-cylinder');
    leftXAxis.setAttribute('id', 'leftXAxis');
    leftXAxis.setAttribute('height', '0.08');
    leftXAxis.setAttribute('radius', '0.003');
    leftXAxis.setAttribute('color', '#ff0000'); // Red for X
    leftXAxis.setAttribute('position', '0.04 0 0');
    leftXAxis.setAttribute('rotation', '0 0 90'); // Rotate to point along X-axis
    this.leftHand.appendChild(leftXAxis);

    const leftXTip = document.createElement('a-cone');
    leftXTip.setAttribute('height', '0.015');
    leftXTip.setAttribute('radius-bottom', '0.008');
    leftXTip.setAttribute('radius-top', '0');
    leftXTip.setAttribute('color', '#ff0000');
    leftXTip.setAttribute('position', '0.055 0 0');
    leftXTip.setAttribute('rotation', '0 0 90');
    this.leftHand.appendChild(leftXTip);

    // Y-axis (Green) - Up
    const leftYAxis = document.createElement('a-cylinder');
    leftYAxis.setAttribute('id', 'leftYAxis');
    leftYAxis.setAttribute('height', '0.08');
    leftYAxis.setAttribute('radius', '0.003');
    leftYAxis.setAttribute('color', '#00ff00'); // Green for Y
    leftYAxis.setAttribute('position', '0 0.04 0');
    leftYAxis.setAttribute('rotation', '0 0 0'); // Default up orientation
    this.leftHand.appendChild(leftYAxis);

    const leftYTip = document.createElement('a-cone');
    leftYTip.setAttribute('height', '0.015');
    leftYTip.setAttribute('radius-bottom', '0.008');
    leftYTip.setAttribute('radius-top', '0');
    leftYTip.setAttribute('color', '#00ff00');
    leftYTip.setAttribute('position', '0 0.055 0');
    this.leftHand.appendChild(leftYTip);

    // Z-axis (Blue) - Forward
    const leftZAxis = document.createElement('a-cylinder');
    leftZAxis.setAttribute('id', 'leftZAxis');
    leftZAxis.setAttribute('height', '0.08');
    leftZAxis.setAttribute('radius', '0.003');
    leftZAxis.setAttribute('color', '#0000ff'); // Blue for Z
    leftZAxis.setAttribute('position', '0 0 0.04');
    leftZAxis.setAttribute('rotation', '90 0 0'); // Rotate to point along Z-axis
    this.leftHand.appendChild(leftZAxis);

    const leftZTip = document.createElement('a-cone');
    leftZTip.setAttribute('height', '0.015');
    leftZTip.setAttribute('radius-bottom', '0.008');
    leftZTip.setAttribute('radius-top', '0');
    leftZTip.setAttribute('color', '#0000ff');
    leftZTip.setAttribute('position', '0 0 0.055');
    leftZTip.setAttribute('rotation', '90 0 0');
    this.leftHand.appendChild(leftZTip);

    // Right Controller Axes
    // X-axis (Red)
    const rightXAxis = document.createElement('a-cylinder');
    rightXAxis.setAttribute('id', 'rightXAxis');
    rightXAxis.setAttribute('height', '0.08');
    rightXAxis.setAttribute('radius', '0.003');
    rightXAxis.setAttribute('color', '#ff0000'); // Red for X
    rightXAxis.setAttribute('position', '0.04 0 0');
    rightXAxis.setAttribute('rotation', '0 0 90'); // Rotate to point along X-axis
    this.rightHand.appendChild(rightXAxis);

    const rightXTip = document.createElement('a-cone');
    rightXTip.setAttribute('height', '0.015');
    rightXTip.setAttribute('radius-bottom', '0.008');
    rightXTip.setAttribute('radius-top', '0');
    rightXTip.setAttribute('color', '#ff0000');
    rightXTip.setAttribute('position', '0.055 0 0');
    rightXTip.setAttribute('rotation', '0 0 90');
    this.rightHand.appendChild(rightXTip);

    // Y-axis (Green) - Up
    const rightYAxis = document.createElement('a-cylinder');
    rightYAxis.setAttribute('id', 'rightYAxis');
    rightYAxis.setAttribute('height', '0.08');
    rightYAxis.setAttribute('radius', '0.003');
    rightYAxis.setAttribute('color', '#00ff00'); // Green for Y
    rightYAxis.setAttribute('position', '0 0.04 0');
    rightYAxis.setAttribute('rotation', '0 0 0'); // Default up orientation
    this.rightHand.appendChild(rightYAxis);

    const rightYTip = document.createElement('a-cone');
    rightYTip.setAttribute('height', '0.015');
    rightYTip.setAttribute('radius-bottom', '0.008');
    rightYTip.setAttribute('radius-top', '0');
    rightYTip.setAttribute('color', '#00ff00');
    rightYTip.setAttribute('position', '0 0.055 0');
    this.rightHand.appendChild(rightYTip);

    // Z-axis (Blue) - Forward
    const rightZAxis = document.createElement('a-cylinder');
    rightZAxis.setAttribute('id', 'rightZAxis');
    rightZAxis.setAttribute('height', '0.08');
    rightZAxis.setAttribute('radius', '0.003');
    rightZAxis.setAttribute('color', '#0000ff'); // Blue for Z
    rightZAxis.setAttribute('position', '0 0 0.04');
    rightZAxis.setAttribute('rotation', '90 0 0'); // Rotate to point along Z-axis
    this.rightHand.appendChild(rightZAxis);

    const rightZTip = document.createElement('a-cone');
    rightZTip.setAttribute('height', '0.015');
    rightZTip.setAttribute('radius-bottom', '0.008');
    rightZTip.setAttribute('radius-top', '0');
    rightZTip.setAttribute('color', '#0000ff');
    rightZTip.setAttribute('position', '0 0 0.055');
    rightZTip.setAttribute('rotation', '90 0 0');
    this.rightHand.appendChild(rightZTip);

    console.log('XYZ axis indicators created for both controllers (RGB for XYZ)');
  },

  tick: function () {
    // Update controller text if controllers are visible
    if (!this.leftHand || !this.rightHand) return; // Added safety check

    // --- BEGIN DETAILED LOGGING ---
    if (this.leftHand.object3D) {
      // console.log(`Left Hand Raw - Visible: ${this.leftHand.object3D.visible}, Pos: ${this.leftHand.object3D.position.x.toFixed(2)},${this.leftHand.object3D.position.y.toFixed(2)},${this.leftHand.object3D.position.z.toFixed(2)}`);
    }
    if (this.rightHand.object3D) {
      // console.log(`Right Hand Raw - Visible: ${this.rightHand.object3D.visible}, Pos: ${this.rightHand.object3D.position.x.toFixed(2)},${this.rightHand.object3D.position.y.toFixed(2)},${this.rightHand.object3D.position.z.toFixed(2)}`);
    }
    // --- END DETAILED LOGGING ---

    // Collect data from both controllers
    const leftController = {
        hand: 'left',
        position: null,
        rotation: null,
        gripActive: false,
        trigger: 0
    };
    
    const rightController = {
        hand: 'right',
        position: null,
        rotation: null,
        gripActive: false,
        trigger: 0
    };
    
    // Collect headset data
    const headset = {
        position: null,
        rotation: null,
        quaternion: null
    };

    // Update Left Hand Text & Collect Data
    // 移除object3D.visible检查，确保即使控制器不可见也能收集数据
    if (this.leftHand && this.leftHand.object3D) {
        const leftPos = this.leftHand.object3D.position;
        const leftRotEuler = this.leftHand.object3D.rotation; // Euler angles in radians
        // Convert to degrees without offset
        const leftRotX = THREE.MathUtils.radToDeg(leftRotEuler.x);
        const leftRotY = THREE.MathUtils.radToDeg(leftRotEuler.y);
        const leftRotZ = THREE.MathUtils.radToDeg(leftRotEuler.z);

        // 添加调试信息
        // console.log(`Left Hand - Visible: ${this.leftHand.object3D.visible}, Pos: ${leftPos.x.toFixed(2)},${leftPos.y.toFixed(2)},${leftPos.z.toFixed(2)}`);

        // Calculate relative rotation if grip is held
        if (this.leftGripDown && this.leftGripInitialRotation) {
          this.leftRelativeRotation = this.calculateRelativeRotation(
            { x: leftRotX, y: leftRotY, z: leftRotZ },
            this.leftGripInitialRotation
          );
          
          // Calculate Z-axis rotation using quaternions
          if (this.leftGripInitialQuaternion) {
            this.leftZAxisRotation = this.calculateZAxisRotation(
              this.leftHand.object3D.quaternion,
              this.leftGripInitialQuaternion
            );
          }
          
          console.log('Left relative rotation:', this.leftRelativeRotation);
          console.log('Left Z-axis rotation:', this.leftZAxisRotation.toFixed(1), 'degrees');
        }

        // Create display text including relative rotation when grip is held
        let combinedLeftText = `Pos: ${leftPos.x.toFixed(2)} ${leftPos.y.toFixed(2)} ${leftPos.z.toFixed(2)}\\nRot: ${leftRotX.toFixed(0)} ${leftRotY.toFixed(0)} ${leftRotZ.toFixed(0)}`;
        if (this.leftGripDown && this.leftGripInitialRotation) {
          combinedLeftText += `\\nZ-Rot: ${this.leftZAxisRotation.toFixed(1)}°`;
        }

        if (this.leftHandInfoText) {
            this.leftHandInfoText.setAttribute('value', combinedLeftText);
        }

        // Collect left controller data
        leftController.position = { x: leftPos.x, y: leftPos.y, z: leftPos.z };
        leftController.rotation = { x: leftRotX, y: leftRotY, z: leftRotZ };
        leftController.quaternion = { 
          x: this.leftHand.object3D.quaternion.x, 
          y: this.leftHand.object3D.quaternion.y, 
          z: this.leftHand.object3D.quaternion.z, 
          w: this.leftHand.object3D.quaternion.w 
        };
        // Get continuous trigger value from gamepad API (0.0 to 1.0)
        // Trigger button is typically at index 0 in WebXR gamepads
        let leftTriggerValue = 0.0;
        if (this.leftHand && this.leftHand.components && this.leftHand.components['tracked-controls']) {
            const leftGamepad = this.leftHand.components['tracked-controls'].controller?.gamepad;
            if (leftGamepad && leftGamepad.buttons && leftGamepad.buttons[0]) {
                // Get continuous trigger value (0.0 to 1.0)
                leftTriggerValue = leftGamepad.buttons[0].value || 0.0;
                // Clamp to valid range
                leftTriggerValue = Math.max(0.0, Math.min(1.0, leftTriggerValue));
            }
        }
        leftController.trigger = leftTriggerValue;
        leftController.gripActive = this.leftGripDown;
        
        // 采集左手柄的摇杆和按钮信息
        if (this.leftHand && this.leftHand.components && this.leftHand.components['tracked-controls']) {
            const leftGamepad = this.leftHand.components['tracked-controls'].controller?.gamepad;
            if (leftGamepad) {
                // 摇杆
                leftController.thumbstick = {
                    x: leftGamepad.axes[2] || 0,
                    y: leftGamepad.axes[3] || 0
                };
                // 侧边按钮（左手柄使用 X/Y 命名，避免与右手柄 A/B 混淆）
                // Quest controller mapping: buttons[3] = X, buttons[4] = Y
                leftController.buttons = {
                    x: !!leftGamepad.buttons[3]?.pressed,  // X button
                    y: !!leftGamepad.buttons[4]?.pressed,  // Y button
                    squeeze: !!leftGamepad.buttons[1]?.pressed,
                    thumbstick: !!leftGamepad.buttons[2]?.pressed,
                    menu: !!leftGamepad.buttons[6]?.pressed,
                    // DIAGNOSTIC (see xlerobot_vr.py _process_left_controller): full raw pressed
                    // state by index, so the server can log ground truth when a named button
                    // (esp. 'x', which has been unreliable) doesn't match what's physically
                    // pressed — lets us confirm/rule out an index-mapping mismatch on this
                    // specific controller/firmware without guessing. Safe to remove once resolved.
                    _rawPressed: leftGamepad.buttons.map((b) => !!b?.pressed),
                };
            }
        }
    } else {
        console.log('Left hand object not available');
    }

    // Update Right Hand Text & Collect Data
    // 移除object3D.visible检查，确保即使控制器不可见也能收集数据
    if (this.rightHand && this.rightHand.object3D) {
        const rightPos = this.rightHand.object3D.position;
        const rightRotEuler = this.rightHand.object3D.rotation; // Euler angles in radians
        // Convert to degrees without offset
        const rightRotX = THREE.MathUtils.radToDeg(rightRotEuler.x);
        const rightRotY = THREE.MathUtils.radToDeg(rightRotEuler.y);
        const rightRotZ = THREE.MathUtils.radToDeg(rightRotEuler.z);

        // 添加调试信息
        console.log(`Right Hand - Visible: ${this.rightHand.object3D.visible}, Pos: ${rightPos.x.toFixed(2)},${rightPos.y.toFixed(2)},${rightPos.z.toFixed(2)}`);

        // Calculate relative rotation if grip is held
        if (this.rightGripDown && this.rightGripInitialRotation) {
          this.rightRelativeRotation = this.calculateRelativeRotation(
            { x: rightRotX, y: rightRotY, z: rightRotZ },
            this.rightGripInitialRotation
          );
          
          // Calculate Z-axis rotation using quaternions
          if (this.rightGripInitialQuaternion) {
            this.rightZAxisRotation = this.calculateZAxisRotation(
              this.rightHand.object3D.quaternion,
              this.rightGripInitialQuaternion
            );
          }
          
          console.log('Right relative rotation:', this.rightRelativeRotation);
          console.log('Right Z-axis rotation:', this.rightZAxisRotation.toFixed(1), 'degrees');
        }

        // Create display text including relative rotation when grip is held
        let combinedRightText = `Pos: ${rightPos.x.toFixed(2)} ${rightPos.y.toFixed(2)} ${rightPos.z.toFixed(2)}\\nRot: ${rightRotX.toFixed(0)} ${rightRotY.toFixed(0)} ${rightRotZ.toFixed(0)}`;
        if (this.rightGripDown && this.rightGripInitialRotation) {
          combinedRightText += `\\nZ-Rot: ${this.rightZAxisRotation.toFixed(1)}°`;
        }

        if (this.rightHandInfoText) {
            this.rightHandInfoText.setAttribute('value', combinedRightText);
        }

        // Collect right controller data
        rightController.position = { x: rightPos.x, y: rightPos.y, z: rightPos.z };
        rightController.rotation = { x: rightRotX, y: rightRotY, z: rightRotZ };
        rightController.quaternion = { 
          x: this.rightHand.object3D.quaternion.x, 
          y: this.rightHand.object3D.quaternion.y, 
          z: this.rightHand.object3D.quaternion.z, 
          w: this.rightHand.object3D.quaternion.w 
        };
        // Get continuous trigger value from gamepad API (0.0 to 1.0)
        // Trigger button is typically at index 0 in WebXR gamepads
        let rightTriggerValue = 0.0;
        if (this.rightHand && this.rightHand.components && this.rightHand.components['tracked-controls']) {
            const rightGamepad = this.rightHand.components['tracked-controls'].controller?.gamepad;
            if (rightGamepad && rightGamepad.buttons && rightGamepad.buttons[0]) {
                // Get continuous trigger value (0.0 to 1.0)
                rightTriggerValue = rightGamepad.buttons[0].value || 0.0;
                // Clamp to valid range
                rightTriggerValue = Math.max(0.0, Math.min(1.0, rightTriggerValue));
            }
        }
        rightController.trigger = rightTriggerValue;
        rightController.gripActive = this.rightGripDown;
        
        // 采集右手柄的摇杆和按钮信息
        if (this.rightHand && this.rightHand.components && this.rightHand.components['tracked-controls']) {
            const rightGamepad = this.rightHand.components['tracked-controls'].controller?.gamepad;
            if (rightGamepad) {
                // 摇杆
                rightController.thumbstick = {
                    x: rightGamepad.axes[2] || 0,
                    y: rightGamepad.axes[3] || 0
                };
                // 侧边按钮
                // Quest controller mapping: buttons[3] = A, buttons[4] = B
                rightController.buttons = {
                    a: !!rightGamepad.buttons[3]?.pressed,  // A button (primary)
                    b: !!rightGamepad.buttons[4]?.pressed,  // B button (secondary)
                    squeeze: !!rightGamepad.buttons[1]?.pressed,
                    thumbstick: !!rightGamepad.buttons[2]?.pressed,
                    menu: !!rightGamepad.buttons[6]?.pressed
                };
            }
        }
    } else {
        console.log('Right hand object not available');
    }

    // Collect headset data
    if (this.headset && this.headset.object3D) {
        const headsetPos = this.headset.object3D.position;
        const headsetRotEuler = this.headset.object3D.rotation;
        const headsetRotX = THREE.MathUtils.radToDeg(headsetRotEuler.x);
        const headsetRotY = THREE.MathUtils.radToDeg(headsetRotEuler.y);
        const headsetRotZ = THREE.MathUtils.radToDeg(headsetRotEuler.z);

        // Update headset info text
        const headsetText = `Pos: ${headsetPos.x.toFixed(2)} ${headsetPos.y.toFixed(2)} ${headsetPos.z.toFixed(2)}\nRot: ${headsetRotX.toFixed(0)} ${headsetRotY.toFixed(0)} ${headsetRotZ.toFixed(0)}`;
        if (this.headsetInfoText) {
            this.headsetInfoText.setAttribute('value', headsetText);
        }

        // Collect headset data
        headset.position = { x: headsetPos.x, y: headsetPos.y, z: headsetPos.z };
        headset.rotation = { x: headsetRotX, y: headsetRotY, z: headsetRotZ };
        headset.quaternion = { 
          x: this.headset.object3D.quaternion.x, 
          y: this.headset.object3D.quaternion.y, 
          z: this.headset.object3D.quaternion.z, 
          w: this.headset.object3D.quaternion.w 
        };
        
        console.log(`Headset - Pos: ${headsetPos.x.toFixed(2)},${headsetPos.y.toFixed(2)},${headsetPos.z.toFixed(2)}`);
    } else {
        console.log('Headset object not available');
    }

    // Send combined packet if WebSocket is open and at least one controller has valid data
    if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
        // 修改发送条件：只要有位置数据就发送，不检查是否为(0,0,0)
        const hasValidLeft = leftController.position !== null;
        const hasValidRight = rightController.position !== null;
        const hasValidHeadset = headset.position !== null;
        
        if (hasValidLeft || hasValidRight || hasValidHeadset) {
            const dualControllerData = {
                timestamp: Date.now(),
                leftController: leftController,
                rightController: rightController,
                headset: headset
            };
            this.websocket.send(JSON.stringify(dualControllerData));
            
            // 添加调试信息
            console.log('Sending VR data:', {
                left: hasValidLeft ? 'valid' : 'invalid',
                right: hasValidRight ? 'valid' : 'invalid',
                headset: hasValidHeadset ? 'valid' : 'invalid',
                leftPos: leftController.position,
                rightPos: rightController.position,
                headsetPos: headset.position
            });
        }
    }
  }
});


// Add the component to the scene after it's loaded
document.addEventListener('DOMContentLoaded', (event) => {
    const scene = document.querySelector('a-scene');

    if (scene) {
        // Listen for controller connection events
        scene.addEventListener('controllerconnected', (evt) => {
            console.log('Controller CONNECTED:', evt.detail.name, evt.detail.component.data.hand);
        });
        scene.addEventListener('controllerdisconnected', (evt) => {
            console.log('Controller DISCONNECTED:', evt.detail.name, evt.detail.component.data.hand);
        });

        // Add controller-updater component when scene is loaded (A-Frame manages session)
        if (scene.hasLoaded) {
            scene.setAttribute('controller-updater', '');
            console.log("controller-updater component added immediately.");
        } else {
            scene.addEventListener('loaded', () => {
                scene.setAttribute('controller-updater', '');
                console.log("controller-updater component added after scene loaded.");
            });
        }
    } else {
        console.error('A-Frame scene not found!');
    }

    // Add controller tracking button logic
    addControllerTrackingButton();
});

// On-page (in-headset) diagnostic banner for WebXR/AR support failures. Console.warn alone is
// invisible once the operator has the headset on -- there's no tethered devtools in the field --
// so a "Start Controller Tracking" button that silently never appears looks identical to "the
// button doesn't work" from inside the headset. This makes the actual reason visible on-page.
function showXrDiagnostic(message) {
    let banner = document.getElementById('xr-diagnostic-banner');
    if (!banner) {
        banner = document.createElement('div');
        banner.id = 'xr-diagnostic-banner';
        banner.style.position = 'fixed';
        banner.style.top = '10%';
        banner.style.left = '50%';
        banner.style.transform = 'translateX(-50%)';
        banner.style.maxWidth = '80vw';
        banner.style.padding = '16px 24px';
        banner.style.fontSize = '18px';
        banner.style.fontWeight = 'bold';
        banner.style.backgroundColor = '#c0392b';
        banner.style.color = 'white';
        banner.style.borderRadius = '8px';
        banner.style.zIndex = '10000';
        banner.style.textAlign = 'center';
        document.body.appendChild(banner);
    }
    banner.textContent = message;
}

function createStartTrackingButton() {
    // Create Start Controller Tracking button
    const startButton = document.createElement('button');
    startButton.id = 'start-tracking-button';
    startButton.textContent = 'Start Controller Tracking';
    startButton.style.position = 'fixed';
    startButton.style.top = '50%';
    startButton.style.left = '50%';
    startButton.style.transform = 'translate(-50%, -50%)';
    startButton.style.padding = '20px 40px';
    startButton.style.fontSize = '20px';
    startButton.style.fontWeight = 'bold';
    startButton.style.backgroundColor = '#4CAF50';
    startButton.style.color = 'white';
    startButton.style.border = 'none';
    startButton.style.borderRadius = '8px';
    startButton.style.cursor = 'pointer';
    startButton.style.zIndex = '9999';
    startButton.style.boxShadow = '0 4px 8px rgba(0,0,0,0.3)';
    startButton.style.transition = 'all 0.3s ease';

    // Hover effects
    startButton.addEventListener('mouseenter', () => {
        startButton.style.backgroundColor = '#45a049';
        startButton.style.transform = 'translate(-50%, -50%) scale(1.05)';
    });
    startButton.addEventListener('mouseleave', () => {
        startButton.style.backgroundColor = '#4CAF50';
        startButton.style.transform = 'translate(-50%, -50%) scale(1)';
    });

    startButton.onclick = () => {
        console.log('Start Controller Tracking button clicked. Requesting session via A-Frame...');
        const sceneEl = document.querySelector('a-scene');
        // Create/resume the WebAudio context synchronously inside this click handler,
        // on the controller-updater component instance (same object playTone() reuses
        // later, so this actually warms the context playTone will use). getAudioCtx()
        // is otherwise only reached lazily from the first episode start/stop chime — by
        // then we're deep inside a WebSocket message callback, not a user-gesture call
        // stack, and some mobile/Quest browsers refuse to start (or silently keep
        // suspended) an AudioContext created outside one. This click is the one
        // guaranteed real user gesture in the whole session.
        const ctrlComp = sceneEl && sceneEl.components && sceneEl.components['controller-updater'];
        if (ctrlComp && ctrlComp.getAudioCtx) {
            try {
                ctrlComp.getAudioCtx();
            } catch (err) {
                console.error('Failed to warm up AudioContext on Start click:', err);
            }
        }
        if (!sceneEl) {
            console.error('A-Frame scene not found for enterVR call!');
            showXrDiagnostic('Internal error: <a-scene> not found. Reload the page.');
            return;
        }
        // Try AR (passthrough) first, then fall back to plain VR on failure -- resolved here,
        // at the one guaranteed user-gesture click, instead of gating the button's very
        // existence on an earlier isSessionSupported() pre-check. That pre-check runs
        // asynchronously on page load with no user gesture backing it, and on at least one
        // real headset silently never resolved either branch, meaning the button never
        // appeared at all with no error anywhere. Trying enterVR directly here can't have that
        // failure mode: the button is now unconditional, and only this actual attempt can fail.
        sceneEl.enterVR(true).catch((arErr) => {
            console.warn('AR session failed, falling back to plain VR:', arErr);
            return sceneEl.enterVR(false).catch((vrErr) => {
                console.error('Both AR and VR session requests failed:', arErr, vrErr);
                showXrDiagnostic(
                    `Could not start a VR/AR session: ${vrErr.message}. ` +
                    'Check headset WebXR support and browser permissions, then reload.'
                );
                alert(`Failed to start VR/AR session: ${vrErr.message}`);
            });
        });
    };

    document.body.appendChild(startButton);
    console.log('"Start Controller Tracking" button added (tries AR, falls back to VR on click).');

    // Listen for VR session events to hide/show start button
    const sceneEl = document.querySelector('a-scene');
    if (sceneEl) {
        sceneEl.addEventListener('enter-vr', () => {
            console.log('Entered VR - hiding start button');
            startButton.style.display = 'none';
            const banner = document.getElementById('xr-diagnostic-banner');
            if (banner) banner.remove();
        });

        sceneEl.addEventListener('exit-vr', () => {
            console.log('Exited VR - showing start button');
            startButton.style.display = 'block';
        });
    }
}

function addControllerTrackingButton() {
    // Always create the button -- do not gate its existence on an async
    // navigator.xr.isSessionSupported() pre-check. That check has no user gesture behind it
    // and on at least one real headset silently never resolved either branch, so the button
    // never appeared and nothing was ever logged or shown. AR-vs-VR and unsupported-browser
    // handling now happens at click time instead (see createStartTrackingButton's onclick),
    // where a failure is guaranteed to surface via the banner/alert.
    if (!navigator.xr) {
        console.warn('WebXR not supported by this browser.');
        showXrDiagnostic('WebXR is not supported by this browser — open this page in the headset\'s built-in browser.');
    }
    createStartTrackingButton();
}
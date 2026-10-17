/**
 * ptt-camera-card.js — camera live view with a HOLD-TO-TALK button.
 *
 * DEPENDENCIES (not redistributed here)
 *   - go2rtc (AlexxIT, MIT): https://github.com/AlexxIT/go2rtc
 *     `VideoRTC` comes from its `video-rtc.js` module; `createOffer` below is adapted from it.
 *   - WebRTC Camera integration (AlexxIT, MIT): https://github.com/AlexxIT/WebRTC
 *     Serves `video-rtc.js` under /webrtc/ and signs the stream connection.
 *
 * WHY
 *   `custom:webrtc-camera` (3.6.1) has no microphone button: as soon as `media` contains
 *   `microphone`, it opens the microphone and keeps it open while the page is displayed.
 *   Here the microphone is negotiated ONCE, left MUTED (`track.enabled = false`), and the
 *   button only unmutes it while held.
 *
 * ALSO FIXES — silent failure
 *   In video-rtc.js, `getUserMedia` sits in `try { } catch (e) { console.warn(e) }`: outside a
 *   secure context (http:// on an IP address), `navigator.mediaDevices` does not exist, the
 *   microphone is skipped silently and the video keeps playing. Here the failure is shown on screen.
 *
 * USAGE
 *   Dashboard resource (JavaScript module): /local/ptt-camera-card.js
 *   Card:  type: custom:ptt-camera-card
 *          url: <go2rtc stream name, the one carrying the backchannel>
 *
 * /config/www is served WITHOUT authentication: this file must not contain any secret.
 * The stream goes through `/api/webrtc/ws`, signed by Home Assistant.
 */

import { VideoRTC } from '/webrtc/video-rtc.js';

/** VideoRTC, with the microphone negotiated MUTED and controllable. */
class VideoRTCPTT extends VideoRTC {
    constructor() {
        super();
        this.micTracks = [];
        this.onMicState = null;   // callback to the card
    }

    async createOffer(pc) {
        // Same logic as the parent class, with three differences:
        // tracks are KEPT, created MUTED, and failures are REPORTED.
        if (this.media.indexOf('microphone') >= 0) {
            if (!window.isSecureContext || !navigator.mediaDevices) {
                this.onMicState?.('insecure');
            } else {
                try {
                    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                    stream.getTracks().forEach(track => {
                        track.enabled = false;                       // muted by default
                        this.micTracks.push(track);
                        pc.addTransceiver(track, { direction: 'sendonly' });
                    });
                    this.onMicState?.(this.micTracks.length ? 'ready' : 'no-track');
                } catch (e) {
                    this.onMicState?.(e && e.name === 'NotAllowedError' ? 'denied' : 'error', e);
                }
            }
        }

        for (const kind of ['video', 'audio']) {
            if (this.media.indexOf(kind) >= 0) {
                pc.addTransceiver(kind, { direction: 'recvonly' });
            }
        }

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        return offer;
    }

    talk(active) {
        let n = 0;
        this.micTracks.forEach(t => { t.enabled = active; n++; });
        return n;
    }

    /** Safety net: on disconnect, the microphone must be muted and released. */
    disconnectedCallback() {
        this.talk(false);
        this.micTracks.forEach(t => t.stop());
        this.micTracks = [];
        super.disconnectedCallback();
    }
}

customElements.define('video-rtc-ptt', VideoRTCPTT);

const MESSAGES = {
    'ready':    ['Hold to talk', ''],
    'insecure': ['Microphone unavailable',
        'Browsers only allow the microphone in a secure context. Open Home Assistant over HTTPS (mobile app included). Chrome workaround: add the Home Assistant address to chrome://flags/#unsafely-treat-insecure-origin-as-secure, then restart Chrome.'],
    'denied':   ['Microphone denied', 'Permission was denied. Click the icon left of the address bar to grant it again.'],
    'no-track': ['No microphone found', 'The browser exposes no audio input device.'],
    'error':    ['Microphone error', ''],
};

class PttCameraCard extends HTMLElement {
    setConfig(config) {
        if (!config || !config.url) {
            throw new Error('ptt-camera-card: missing `url` (go2rtc stream name)');
        }
        this.config = config;
    }

    set hass(hass) {
        this._hass = hass;
        if (!this._mounted) { this._mounted = true; this._build(); }
    }

    getCardSize() { return 6; }

    async _build() {
        const card = document.createElement('ha-card');
        card.innerHTML = `
            <style>
              .frame { position: relative; background: #000; border-radius: var(--ha-card-border-radius, 12px); overflow: hidden; }
              .frame video { width: 100%; display: block; }
              .bar { display: flex; align-items: center; gap: 12px; padding: 10px 12px; }
              .button { flex: 1; display: flex; align-items: center; justify-content: center; gap: 10px;
                        padding: 16px; border: none; border-radius: 10px; cursor: pointer;
                        font-size: 1.05em; font-weight: 600; user-select: none; -webkit-user-select: none;
                        touch-action: none; background: var(--primary-color); color: #fff;
                        transition: background .12s, transform .12s; }
              .button[disabled] { background: var(--disabled-color, #555); cursor: not-allowed; }
              .button.talking { background: #d32f2f; transform: scale(0.99); }
              .help { padding: 0 12px 12px; font-size: .85em; color: var(--secondary-text-color); }
              .onair { position: absolute; top: 10px; left: 10px; display: none; align-items: center; gap: 8px;
                       background: rgba(211,47,47,.92); color: #fff; padding: 6px 12px; border-radius: 999px;
                       font-size: .85em; font-weight: 700; letter-spacing: .04em; }
              .onair.on { display: flex; }
              .dot { width: 10px; height: 10px; border-radius: 50%; background: #fff; animation: blink 1s infinite; }
              @keyframes blink { 50% { opacity: .25; } }
            </style>
            <div class="frame">
              <div class="onair"><span class="dot"></span>MIC ON</div>
            </div>
            <div class="bar">
              <button class="button" disabled>
                <ha-icon icon="mdi:microphone"></ha-icon><span class="label">Connecting…</span>
              </button>
            </div>
            <div class="help"></div>`;
        this.appendChild(card);

        const frame  = card.querySelector('.frame');
        const button = card.querySelector('.button');
        const label  = card.querySelector('.label');
        const help   = card.querySelector('.help');
        const onair  = card.querySelector('.onair');

        const video = document.createElement('video-rtc-ptt');
        // WebRTC is FORCED: the microphone only exists there. With an `mse` fallback,
        // a page that falls back to MSE would show a button that does NOTHING.
        video.mode = 'webrtc';
        video.media = 'video,audio,microphone';
        video.background = false;
        frame.appendChild(video);

        video.onMicState = (state, err) => {
            const [title, detail] = MESSAGES[state] || ['Microphone: ' + state, ''];
            label.textContent = title;
            help.textContent = detail || (err ? String(err) : '');
            button.disabled = state !== 'ready';
        };

        // --- press / release ---
        const open = (e) => {
            if (button.disabled) return;
            e.preventDefault();
            if (video.talk(true) > 0) { button.classList.add('talking'); onair.classList.add('on'); }
        };
        const close = () => {
            video.talk(false);
            button.classList.remove('talking');
            onair.classList.remove('on');
        };
        button.addEventListener('pointerdown', open);
        // Every exit path mutes the microphone: release, leaving the button, lost pointer,
        // tab switch, page closed.
        ['pointerup', 'pointercancel', 'pointerleave', 'blur'].forEach(
            ev => button.addEventListener(ev, close));
        document.addEventListener('visibilitychange', () => { if (document.hidden) close(); });
        window.addEventListener('pagehide', close);

        // --- open the stream, exactly like the official card ---
        try {
            const data = await this._hass.callWS({ type: 'auth/sign_path', path: '/api/webrtc/ws' });
            video.src = 'ws' + this._hass.hassUrl(data.path).substring(4)
                      + '&url=' + encodeURIComponent(this.config.url);
        } catch (e) {
            label.textContent = 'Stream unavailable';
            help.textContent = String(e);
        }
    }
}

customElements.define('ptt-camera-card', PttCameraCard);

window.customCards = window.customCards || [];
window.customCards.push({
    type: 'ptt-camera-card',
    name: 'Camera with push-to-talk',
    description: 'go2rtc WebRTC stream + hold-to-talk microphone.',
});

console.info('%c PTT-CAMERA-CARD %c 1.0 ', 'background:#d32f2f;color:#fff', '');

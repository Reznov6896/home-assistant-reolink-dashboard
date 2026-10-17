/**
 * parler-camera.js — carte maison : la caméra, avec un bouton « MAINTENIR POUR PARLER ».
 *
 * DÉPENDANCES (non republiées ici)
 *   - go2rtc (AlexxIT, licence MIT) : https://github.com/AlexxIT/go2rtc
 *     La classe `VideoRTC` vient de son module `video-rtc.js` ; la méthode
 *     `createOffer` ci-dessous est adaptée de la sienne.
 *   - l'intégration WebRTC (AlexxIT, licence MIT) : https://github.com/AlexxIT/WebRTC
 *     Elle sert `video-rtc.js` sous /webrtc/ et signe la connexion au flux.
 *
 * POURQUOI ELLE EXISTE
 *   La carte `custom:webrtc-camera` (version utilisée : 3.6.1) n'a AUCUN bouton
 *   micro : dès que `media` contient `microphone`, elle ouvre le micro et le
 *   laisse ouvert tant que la page est affichée. Dans un salon, ça veut dire
 *   diffuser en continu. Ici, le micro est négocié UNE fois puis laissé MUET
 *   (`track.enabled = false`), et le bouton ne fait que le démuter le temps
 *   de l'appui.
 *
 * CE QU'ELLE CORRIGE AUSSI — l'échec silencieux
 *   Dans video-rtc.js, l'appel `getUserMedia` est dans un `try { } catch (e) {
 *   console.warn(e) }` : hors contexte sécurisé (http:// sur une adresse IP),
 *   le navigateur ne fournit pas `navigator.mediaDevices`, le micro est sauté
 *   SANS UN MOT et l'image continue. Ça ressemble à une panne. Ici, le cas est
 *   DIT à l'écran, avec le geste à faire.
 *
 * UTILISATION
 *   Ressource Lovelace de type module : /local/parler-camera.js
 *   Carte :  type: custom:parler-camera
 *            url: <nom du flux dans go2rtc, celui qui porte la voie retour>
 *
 * 🔒 Ce fichier vit dans /config/www, qui est servi SANS authentification :
 *    il ne doit contenir aucun secret. Le flux passe par `/api/webrtc/ws`,
 *    signé par Home Assistant lui-même.
 */

import { VideoRTC } from '/webrtc/video-rtc.js';

/** VideoRTC, mais le micro est négocié MUET et pilotable. */
class VideoRTCPTT extends VideoRTC {
    constructor() {
        super();
        this.pistesMicro = [];
        this.surEtatMicro = null;   // rappel vers la carte
    }

    async createOffer(pc) {
        // 🎤 même logique que la classe mère, à trois différences près :
        //    on GARDE les pistes, on les crée MUETTES, et on DIT ce qui échoue.
        if (this.media.indexOf('microphone') >= 0) {
            if (!window.isSecureContext || !navigator.mediaDevices) {
                this.surEtatMicro?.('non-securise');
            } else {
                try {
                    const flux = await navigator.mediaDevices.getUserMedia({ audio: true });
                    flux.getTracks().forEach(piste => {
                        piste.enabled = false;                       // ⬅️ muet par défaut
                        this.pistesMicro.push(piste);
                        pc.addTransceiver(piste, { direction: 'sendonly' });
                    });
                    this.surEtatMicro?.(this.pistesMicro.length ? 'pret' : 'aucune-piste');
                } catch (e) {
                    this.surEtatMicro?.(e && e.name === 'NotAllowedError' ? 'refuse' : 'erreur', e);
                }
            }
        }

        for (const genre of ['video', 'audio']) {
            if (this.media.indexOf(genre) >= 0) {
                pc.addTransceiver(genre, { direction: 'recvonly' });
            }
        }

        const offre = await pc.createOffer();
        await pc.setLocalDescription(offre);
        return offre;
    }

    parler(actif) {
        let n = 0;
        this.pistesMicro.forEach(p => { p.enabled = actif; n++; });
        return n;
    }

    /** 🚨 Filet : à la fermeture, le micro doit se taire quoi qu'il arrive. */
    disconnectedCallback() {
        this.parler(false);
        this.pistesMicro.forEach(p => p.stop());
        this.pistesMicro = [];
        super.disconnectedCallback();
    }
}

customElements.define('video-rtc-ptt', VideoRTCPTT);

const MESSAGES = {
    'pret':         ['Maintenir pour parler', ''],
    'non-securise': ['Micro indisponible',
        "Le navigateur n'autorise le micro qu'en contexte sécurisé. Ouvre Home Assistant en HTTPS (application mobile comprise). Dépannage sur Chrome : déclare l'adresse de Home Assistant dans chrome://flags/#unsafely-treat-insecure-origin-as-secure, puis relance Chrome."],
    'refuse':       ['Micro refusé', "Tu as refusé l'autorisation. Clique sur l'icône à gauche de l'adresse pour la rétablir."],
    'aucune-piste': ['Aucun micro trouvé', "Le navigateur n'expose aucun périphérique d'entrée audio."],
    'erreur':       ['Micro en erreur', ''],
};

class ParlerCamera extends HTMLElement {
    setConfig(config) {
        if (!config || !config.url) {
            throw new Error('parler-camera : il manque `url` (le nom du flux go2rtc)');
        }
        this.config = config;
    }

    set hass(hass) {
        this._hass = hass;
        if (!this._monte) { this._monte = true; this._construire(); }
    }

    getCardSize() { return 6; }

    async _construire() {
        const carte = document.createElement('ha-card');
        carte.innerHTML = `
            <style>
              .cadre { position: relative; background: #000; border-radius: var(--ha-card-border-radius, 12px); overflow: hidden; }
              .cadre video { width: 100%; display: block; }
              .barre { display: flex; align-items: center; gap: 12px; padding: 10px 12px; }
              .bouton { flex: 1; display: flex; align-items: center; justify-content: center; gap: 10px;
                        padding: 16px; border: none; border-radius: 10px; cursor: pointer;
                        font-size: 1.05em; font-weight: 600; user-select: none; -webkit-user-select: none;
                        touch-action: none; background: var(--primary-color); color: #fff;
                        transition: background .12s, transform .12s; }
              .bouton[disabled] { background: var(--disabled-color, #555); cursor: not-allowed; }
              .bouton.parle { background: #d32f2f; transform: scale(0.99); }
              .aide { padding: 0 12px 12px; font-size: .85em; color: var(--secondary-text-color); }
              .antenne { position: absolute; top: 10px; left: 10px; display: none; align-items: center; gap: 8px;
                         background: rgba(211,47,47,.92); color: #fff; padding: 6px 12px; border-radius: 999px;
                         font-size: .85em; font-weight: 700; letter-spacing: .04em; }
              .antenne.on { display: flex; }
              .pastille { width: 10px; height: 10px; border-radius: 50%; background: #fff; animation: bat 1s infinite; }
              @keyframes bat { 50% { opacity: .25; } }
            </style>
            <div class="cadre">
              <div class="antenne"><span class="pastille"></span>MICRO OUVERT</div>
            </div>
            <div class="barre">
              <button class="bouton" disabled>
                <ha-icon icon="mdi:microphone"></ha-icon><span class="libelle">Connexion…</span>
              </button>
            </div>
            <div class="aide"></div>`;
        this.appendChild(carte);

        const cadre   = carte.querySelector('.cadre');
        const bouton  = carte.querySelector('.bouton');
        const libelle = carte.querySelector('.libelle');
        const aide    = carte.querySelector('.aide');
        const antenne = carte.querySelector('.antenne');

        const video = document.createElement('video-rtc-ptt');
        // 🎯 WebRTC IMPOSÉ : le micro n'existe que là. En laissant `mse` en repli,
        //    une page qui bascule en MSE afficherait un bouton qui ne fait RIEN.
        video.mode = 'webrtc';
        video.media = 'video,audio,microphone';
        video.background = false;
        cadre.appendChild(video);

        video.surEtatMicro = (etat, err) => {
            const [titre, detail] = MESSAGES[etat] || ['Micro : ' + etat, ''];
            libelle.textContent = titre;
            aide.textContent = detail || (err ? String(err) : '');
            bouton.disabled = etat !== 'pret';
        };

        // --- appui / relâchement ---
        const ouvrir = (e) => {
            if (bouton.disabled) return;
            e.preventDefault();
            if (video.parler(true) > 0) { bouton.classList.add('parle'); antenne.classList.add('on'); }
        };
        const fermer = () => {
            video.parler(false);
            bouton.classList.remove('parle');
            antenne.classList.remove('on');
        };
        bouton.addEventListener('pointerdown', ouvrir);
        // 🚨 tous les chemins de sortie coupent le micro : relâcher, sortir du
        //    bouton, perdre le doigt, changer d'onglet, quitter la page.
        ['pointerup', 'pointercancel', 'pointerleave', 'blur'].forEach(
            ev => bouton.addEventListener(ev, fermer));
        document.addEventListener('visibilitychange', () => { if (document.hidden) fermer(); });
        window.addEventListener('pagehide', fermer);

        // --- ouverture du flux, exactement comme la carte officielle ---
        try {
            const data = await this._hass.callWS({ type: 'auth/sign_path', path: '/api/webrtc/ws' });
            video.src = 'ws' + this._hass.hassUrl(data.path).substring(4)
                      + '&url=' + encodeURIComponent(this.config.url);
        } catch (e) {
            libelle.textContent = 'Flux indisponible';
            aide.textContent = String(e);
        }
    }
}

customElements.define('parler-camera', ParlerCamera);

window.customCards = window.customCards || [];
window.customCards.push({
    type: 'parler-camera',
    name: 'Caméra avec bouton parler',
    description: 'Flux WebRTC go2rtc + micro en appui maintenu (push-to-talk).',
});

console.info('%c PARLER-CAMERA %c 1.0 ', 'background:#d32f2f;color:#fff', '');

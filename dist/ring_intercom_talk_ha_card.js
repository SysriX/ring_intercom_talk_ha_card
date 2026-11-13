/*
 * ring-sprechen-card – Gegensprechen mit der Ring Intercom im Dashboard.
 * Braucht die Integration ring_sprechanlage (camera.<name>_gegensprechen).
 * WebRTC-Ablauf nach ring-intercom-video-card von cmos486 (Apache-2.0).
 *
 *   type: custom:ring-sprechen-card
 *   entity: camera.vordereingang_gegensprechen        # Pflicht
 *   gespraech_entity: binary_sensor.vordereingang_gesprach_aktiv  # optional: "besetzt" anzeigen
 *   tuer_action: script.haustuer_oeffnen               # optional: Knopf "Tür öffnen" (Dienst oder Entität)
 *   tuer_bestaetigen: true                             # Rückfrage vor dem Öffnen (Standard true)
 *   mikro_start: an                                    # an | aus – Mikro direkt nach dem Abheben
 *   auto_abheben: false                                # sofort abheben, wenn die Karte erscheint
 *   titel: Haustür                                     # optional
 *
 * Mikro-Knopf: kurz tippen = an/aus, gedrückt halten = nur sprechen solange gedrückt.
 * Mikrofon braucht HTTPS – über http:// nur Zuhören.
 */
const RSC_VERSION = '1.0.0';
const RSC_LOG = '[ring-sprechen-card]';

const RSC_ICONS = {
  phone: 'M6.62,10.79C8.06,13.62 10.38,15.94 13.21,17.38L15.41,15.18C15.69,14.9 16.08,14.82 16.43,14.93C17.55,15.3 18.75,15.5 20,15.5A1,1 0 0,1 21,16.5V20A1,1 0 0,1 20,21A17,17 0 0,1 3,4A1,1 0 0,1 4,3H7.5A1,1 0 0,1 8.5,4C8.5,5.25 8.7,6.45 9.07,7.57C9.18,7.92 9.1,8.31 8.82,8.59L6.62,10.79Z',
  hangup: 'M12,9C10.4,9 8.85,9.25 7.4,9.72V12.82C7.4,13.21 7.17,13.56 6.84,13.72C5.86,14.21 4.97,14.84 4.17,15.57C4,15.75 3.75,15.86 3.5,15.86C3.2,15.86 2.95,15.74 2.77,15.56L0.29,13.08C0.11,12.9 0,12.65 0,12.38C0,12.1 0.11,11.85 0.29,11.67C3.34,8.77 7.46,7 12,7C16.54,7 20.66,8.77 23.71,11.67C23.89,11.85 24,12.1 24,12.38C24,12.65 23.89,12.9 23.71,13.08L21.23,15.56C21.05,15.74 20.8,15.86 20.5,15.86C20.25,15.86 20,15.75 19.82,15.57C19.03,14.84 18.14,14.21 17.16,13.72C16.83,13.56 16.6,13.21 16.6,12.82V9.72C15.15,9.25 13.6,9 12,9Z',
  mic: 'M12,2A3,3 0 0,1 15,5V11A3,3 0 0,1 12,14A3,3 0 0,1 9,11V5A3,3 0 0,1 12,2M19,11C19,14.53 16.39,17.44 13,17.93V21H11V17.93C7.61,17.44 5,14.53 5,11H7A5,5 0 0,0 12,16A5,5 0 0,0 17,11H19Z',
  micOff: 'M19,11C19,12.19 18.66,13.3 18.1,14.28L16.87,13.05C17.14,12.43 17.3,11.74 17.3,11H19M15,11.16L9,5.18V5A3,3 0 0,1 12,2A3,3 0 0,1 15,5V11L15,11.16M4.27,3L21,19.73L19.73,21L15.54,16.81C14.77,17.27 13.91,17.58 13,17.72V21H11V17.72C7.72,17.23 5,14.41 5,11H6.7C6.7,14 9.24,16.1 12,16.1C12.81,16.1 13.6,15.91 14.31,15.58L12.65,13.92L12,14A3,3 0 0,1 9,11V10.28L3,4.27L4.27,3Z',
  door: 'M12,3C10.89,3 10,3.89 10,5H3V19H2V21H22V19H21V5C21,3.89 20.11,3 19,3H12M12,5H19V19H12V5M5,11H7V13H5V11Z',
};

class RingSprechenCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._pc = null; this._local = null; this._unsub = null;
    this._sessionId = null; this._pending = [];
    this._state = 'idle';      // idle | connecting | connected
    this._micOn = false; this._micHint = '';
    this._timer = null; this._t0 = 0; this._detachTimer = null;
  }

  static getStubConfig(hass) {
    const cam = Object.keys((hass && hass.states) || {}).find(id => id.startsWith('camera.') && /gegensprechen/.test(id));
    return { entity: cam || 'camera.vordereingang_gegensprechen' };
  }

  setConfig(config) {
    if (!config || !config.entity) throw new Error('entity fehlt (camera.<name>_gegensprechen)');
    this._config = { tuer_bestaetigen: true, mikro_start: 'an', auto_abheben: false, ...config };
    this._render();
  }

  getCardSize() { return 3; }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    this._updateInfo();
    if (first && this._config.auto_abheben && this.isConnected) this._abheben();
  }

  connectedCallback() {
    clearTimeout(this._detachTimer);
    if (this._hass && this._config && this._config.auto_abheben && this._state === 'idle') this._abheben();
  }

  // Popups hängen Karten beim Neuzeichnen kurz ab – erst nach 1,5 s wirklich auflegen
  disconnectedCallback() {
    clearTimeout(this._detachTimer);
    this._detachTimer = setTimeout(() => { if (!this.isConnected) this._auflegen(); }, 1500);
  }

  // ---------- Darstellung ----------

  _render() {
    const c = this._config;
    this.shadowRoot.innerHTML = `
      <style>
        :host { display:block; }
        ha-card { padding:16px; }
        .kopf { display:flex; align-items:center; gap:10px; margin-bottom:12px; }
        .titel { font-size:1.15em; font-weight:500; flex:1; }
        .zeit { font-variant-numeric:tabular-nums; color:var(--secondary-text-color); }
        .status { min-height:1.4em; margin-bottom:14px; color:var(--secondary-text-color); }
        .status.fehler { color:var(--error-color,#db4437); }
        .status.ok { color:var(--success-color,#43a047); }
        .welle { display:flex; gap:4px; align-items:flex-end; height:28px; margin:0 0 14px; opacity:.25; transition:opacity .3s; }
        .welle.an { opacity:1; }
        .welle span { flex:1; background:var(--primary-color); border-radius:3px; height:15%; transition:height .08s; }
        .knoepfe { display:flex; gap:14px; justify-content:center; flex-wrap:wrap; }
        button { all:unset; box-sizing:border-box; cursor:pointer; display:flex; flex-direction:column; align-items:center; gap:6px;
          font-size:.85em; color:var(--primary-text-color); -webkit-tap-highlight-color:transparent; user-select:none; }
        button .rund { width:68px; height:68px; border-radius:50%; display:grid; place-items:center; color:#fff;
          box-shadow:0 2px 6px rgba(0,0,0,.25); transition:transform .1s, filter .2s, background .2s; }
        button:active .rund { transform:scale(.94); }
        button[disabled] { cursor:default; opacity:.35; }
        button svg { width:32px; height:32px; fill:currentColor; }
        #ab .rund { background:#2e7d32; }
        #auf .rund { background:#c62828; }
        #mic .rund { background:#607d8b; }
        #mic.an .rund { background:#1565c0; box-shadow:0 0 0 4px rgba(21,101,192,.35); }
        #tuer .rund { background:#ef6c00; }
        [hidden] { display:none !important; }
      </style>
      <ha-card>
        <div class="kopf">
          <div class="titel">${c.titel || 'Gegensprechen'}</div>
          <div class="zeit" id="zeit"></div>
        </div>
        <div class="status" id="status">Bereit</div>
        <div class="welle" id="welle">${'<span></span>'.repeat(24)}</div>
        <div class="knoepfe">
          <button id="ab"><div class="rund"><svg viewBox="0 0 24 24"><path d="${RSC_ICONS.phone}"/></svg></div>Abheben</button>
          <button id="mic" hidden><div class="rund"><svg viewBox="0 0 24 24"><path id="micpath" d="${RSC_ICONS.micOff}"/></svg></div><span id="miclbl">Mikro aus</span></button>
          <button id="auf" hidden><div class="rund"><svg viewBox="0 0 24 24"><path d="${RSC_ICONS.hangup}"/></svg></div>Auflegen</button>
          <button id="tuer" ${c.tuer_action ? '' : 'hidden'}><div class="rund"><svg viewBox="0 0 24 24"><path d="${RSC_ICONS.door}"/></svg></div>Tür öffnen</button>
        </div>
        <audio id="ton" autoplay playsinline></audio>
      </ha-card>`;
    const $ = id => this.shadowRoot.getElementById(id);
    $('ab').addEventListener('click', () => this._abheben());
    $('auf').addEventListener('click', () => this._auflegen());
    $('tuer').addEventListener('click', () => this._tuer());
    // Mikro: kurz = umschalten, lang = Sprechtaste
    const mic = $('mic');
    let down = 0, held = false, holdT = null;
    const start = e => {
      e.preventDefault(); if (this._state !== 'connected' || !this._local) return;
      down = Date.now(); held = false;
      holdT = setTimeout(() => { held = true; this._setMic(true); }, 350);
    };
    const end = e => {
      e.preventDefault(); clearTimeout(holdT); if (!down) return; down = 0;
      if (held) this._setMic(false); else this._setMic(!this._micOn);
    };
    mic.addEventListener('pointerdown', start);
    mic.addEventListener('pointerup', end);
    mic.addEventListener('pointerleave', e => { if (down && held) end(e); else { clearTimeout(holdT); down = 0; } });
    mic.addEventListener('contextmenu', e => e.preventDefault());
    this._updateButtons();
  }

  _status(text, art = '') {
    const el = this.shadowRoot.getElementById('status');
    if (el) { el.textContent = text; el.className = 'status ' + art; }
  }

  _updateButtons() {
    const $ = id => this.shadowRoot.getElementById(id);
    if (!$('ab')) return;
    const idle = this._state === 'idle';
    $('ab').hidden = !idle;
    $('auf').hidden = idle;
    $('mic').hidden = this._state !== 'connected';
    $('mic').disabled = !this._local;
    $('mic').classList.toggle('an', this._micOn);
    $('micpath').setAttribute('d', this._micOn ? RSC_ICONS.mic : RSC_ICONS.micOff);
    $('miclbl').textContent = !this._local ? 'kein Mikro' : this._micOn ? 'Mikro an' : 'Mikro aus';
    $('welle').classList.toggle('an', this._state === 'connected');
  }

  _updateInfo() {
    if (!this._hass || !this._config) return;
    const cam = this._hass.states[this._config.entity];
    const ab = this.shadowRoot.getElementById('ab');
    if (!cam) { this._status(`${this._config.entity} nicht gefunden – Integration ring_sprechanlage geladen?`, 'fehler'); if (ab) ab.disabled = true; return; }
    if (this._state !== 'idle') return;
    if (cam.state === 'unavailable') { this._status('Intercom nicht erreichbar', 'fehler'); if (ab) ab.disabled = true; return; }
    if (ab) ab.disabled = false;
    const g = this._config.gespraech_entity && this._hass.states[this._config.gespraech_entity];
    if (g && g.state === 'on') this._status('Ein anderes Gerät spricht gerade mit der Tür');
    else this._status(this._micHint || 'Bereit');
  }

  _startTimer() {
    this._t0 = Date.now();
    clearInterval(this._timer);
    this._timer = setInterval(() => {
      const s = Math.floor((Date.now() - this._t0) / 1000);
      const el = this.shadowRoot.getElementById('zeit');
      if (el) el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    }, 1000);
  }

  _stopTimer() {
    clearInterval(this._timer); this._timer = null;
    const el = this.shadowRoot.getElementById('zeit'); if (el) el.textContent = '';
  }

  // Pegelanzeige vom Besucher-Ton
  _startMeter(stream) {
    try {
      const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
      this._ac = this._ac || new AC();
      const src = this._ac.createMediaStreamSource(stream), an = this._ac.createAnalyser();
      an.fftSize = 64; src.connect(an);
      const data = new Uint8Array(an.frequencyBinCount), bars = [...this.shadowRoot.querySelectorAll('#welle span')];
      const tick = () => {
        if (this._state !== 'connected') { bars.forEach(b => (b.style.height = '15%')); return; }
        an.getByteFrequencyData(data);
        bars.forEach((b, i) => (b.style.height = `${15 + (data[i % data.length] / 255) * 85}%`));
        this._raf = requestAnimationFrame(tick);
      };
      tick();
    } catch (e) { console.debug(RSC_LOG, 'Pegel nicht möglich', e); }
  }

  // ---------- Gespräch ----------

  async _mikrofon() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      this._micHint = window.isSecureContext === false ? 'Nur Zuhören: Mikrofon braucht HTTPS' : 'Nur Zuhören: kein Mikrofon';
      return null;
    }
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    } catch (err) {
      this._micHint = err && err.name === 'NotAllowedError' ? 'Nur Zuhören: Mikrofon nicht erlaubt' : 'Nur Zuhören: Mikrofon nicht verfügbar';
      console.warn(RSC_LOG, 'Mikrofon:', err);
      return null;
    }
  }

  async _abheben() {
    if (this._state !== 'idle' || !this._hass) return;
    this._state = 'connecting'; this._micHint = '';
    this._sessionId = null; this._pending = [];
    this._updateButtons();
    this._status('Verbinde …');
    const audio = this.shadowRoot.getElementById('ton');
    // Abspielen im Klick freischalten (Autoplay-Regeln)
    try { audio.muted = false; audio.play().catch(() => {}); } catch (_) {}
    try {
      this._local = await this._mikrofon();
      if (this._state !== 'connecting') return this._teardown();
      const cam = this._hass.states[this._config.entity];
      const audioOnly = !cam || cam.attributes.audio_only !== false;
      const pc = this._pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' });
      const track = this._local && this._local.getAudioTracks()[0];
      if (track) {
        track.enabled = false;
        pc.addTransceiver(track, { direction: 'sendrecv', streams: [this._local] });
      } else {
        pc.addTransceiver('audio', { direction: 'recvonly' });
      }
      if (!audioOnly) pc.addTransceiver('video', { direction: 'recvonly' });

      pc.ontrack = ev => {
        if (ev.track.kind !== 'audio') return;
        if (!audio.srcObject) audio.srcObject = new MediaStream();
        audio.srcObject.addTrack(ev.track);
        audio.play().catch(err => {
          if (err && err.name === 'NotAllowedError') this._status('Zum Hören einmal auf die Karte tippen', 'fehler');
        });
        this._startMeter(audio.srcObject);
      };
      pc.onconnectionstatechange = () => {
        if (this._pc !== pc) return;
        const s = pc.connectionState;
        if (s === 'connected') {
          this._state = 'connected';
          this._startTimer();
          this._setMic(!!this._local && this._config.mikro_start !== 'aus');
          this._status(this._micHint || 'Verbunden', this._micHint ? 'fehler' : 'ok');
          this._updateButtons();
        } else if (s === 'failed') {
          this._teardown(); this._status('Verbindung fehlgeschlagen', 'fehler');
        } else if (s === 'disconnected' || s === 'closed') {
          this._teardown(); this._status('Gespräch beendet');
        }
      };
      pc.onicecandidate = ev => {
        if (!ev.candidate || !ev.candidate.candidate) return;
        const c = { candidate: ev.candidate.candidate, sdpMid: ev.candidate.sdpMid, sdpMLineIndex: ev.candidate.sdpMLineIndex };
        if (!this._sessionId) this._pending.push(c); else this._sendCandidate(c);
      };
      await pc.setLocalDescription(await pc.createOffer());
      this._status('Rufe Ring an …');
      this._unsub = await this._hass.connection.subscribeMessage(
        msg => this._signal(msg),
        { type: 'camera/webrtc/offer', entity_id: this._config.entity, offer: pc.localDescription.sdp }
      );
    } catch (err) {
      console.error(RSC_LOG, err);
      this._teardown();
      this._status(`Fehler: ${err.message || err}`, 'fehler');
    }
  }

  async _signal(msg) {
    const pc = this._pc; if (!pc) return;
    if (msg.type === 'session') {
      this._sessionId = msg.session_id;
      const p = this._pending; this._pending = [];
      for (const c of p) await this._sendCandidate(c);
    } else if (msg.type === 'answer') {
      this._status('Ring antwortet …');
      try { await pc.setRemoteDescription({ type: 'answer', sdp: msg.answer }); }
      catch (err) { console.error(RSC_LOG, 'Antwort:', err, msg.answer); this._teardown(); this._status(`Antwort ungültig: ${err.message}`, 'fehler'); }
    } else if (msg.type === 'candidate') {
      const c = msg.candidate;
      try { await pc.addIceCandidate({ candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex }); }
      catch (err) { console.warn(RSC_LOG, 'ICE:', err); }
    } else if (msg.type === 'error') {
      console.error(RSC_LOG, 'HA/Ring:', msg);
      const war = this._state === 'connected';
      this._teardown();
      this._status(war ? 'Ring hat aufgelegt' : `Ring: ${msg.message || msg.code}`, war ? '' : 'fehler');
    }
  }

  async _sendCandidate(c) {
    try {
      await this._hass.connection.sendMessagePromise({ type: 'camera/webrtc/candidate', entity_id: this._config.entity, session_id: this._sessionId, candidate: c });
    } catch (err) { console.warn(RSC_LOG, 'ICE senden:', err); }
  }

  _setMic(on) {
    if (!this._local) return;
    this._micOn = !!on;
    this._local.getAudioTracks().forEach(t => (t.enabled = this._micOn));
    this._updateButtons();
  }

  _auflegen() {
    if (this._state === 'idle') return;
    this._teardown();
    this._status('Aufgelegt');
  }

  _teardown() {
    this._state = 'idle'; this._micOn = false;
    cancelAnimationFrame(this._raf);
    if (this._unsub) { try { this._unsub(); } catch (_) {} this._unsub = null; }
    if (this._pc) { try { this._pc.close(); } catch (_) {} this._pc = null; }
    if (this._local) { this._local.getTracks().forEach(t => t.stop()); this._local = null; }
    const audio = this.shadowRoot.getElementById('ton');
    if (audio && audio.srcObject) { audio.srcObject.getTracks().forEach(t => t.stop()); audio.srcObject = null; }
    this._sessionId = null; this._pending = [];
    this._stopTimer();
    this._updateButtons();
  }

  async _tuer() {
    const a = this._config.tuer_action; if (!a) return;
    if (this._config.tuer_bestaetigen && !confirm('Tür wirklich öffnen?')) return;
    const [domain, rest] = a.split('.');
    const map = { script: ['script', rest, {}], button: ['button', 'press', { entity_id: a }], lock: ['lock', 'unlock', { entity_id: a }], switch: ['switch', 'turn_on', { entity_id: a }] };
    const [d, s, data] = map[domain] || [domain, rest, {}];
    try { await this._hass.callService(d, s, data); this._status('Tür geöffnet', 'ok'); }
    catch (err) { this._status(`Tür öffnen fehlgeschlagen: ${err.message}`, 'fehler'); }
  }
}

if (!customElements.get('ring-sprechen-card')) {
  customElements.define('ring-sprechen-card', RingSprechenCard);
  window.customCards = window.customCards || [];
  window.customCards.push({ type: 'ring-sprechen-card', name: 'Ring Gegensprechen', description: 'Mit dem Besucher an der Ring Intercom sprechen (braucht ring_sprechanlage).' });
  console.info(`%c ring-sprechen-card ${RSC_VERSION} `, 'background:#2e7d32;color:#fff;border-radius:3px');
}

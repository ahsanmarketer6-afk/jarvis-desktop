'use strict';

const EventEmitter = require('events');
const db = require('../database');

let NodeWebSocket = null;
try {
  const wsPkg = require('ws');
  NodeWebSocket = wsPkg.WebSocket || wsPkg;
} catch (e) {
  console.warn('[Gemini Live Session] ws package not pre-loaded:', e.message);
}

/**
 * Attaches WebSocket handlers that work with BOTH the Node `ws` package
 * (EventEmitter: .on('open'|'message'|'error'|'close')) and browser WebSocket
 * (onopen/onmessage properties). The `ws` package silently IGNORES
 * `ws.onopen = fn` — a real bug that made Live sessions hang until timeout.
 */
function attachWsHandlers(ws, handlers) {
  if (typeof ws.on === 'function') {
    ws.on('open', () => handlers.onopen());
    ws.on('message', (data) => handlers.onmessage({ data }));
    ws.on('error', (err) => handlers.onerror({ message: (err && err.message) || 'websocket error' }));
    ws.on('close', (code, reason) => handlers.onclose({ code, reason: reason ? String(reason) : '' }));
  } else {
    ws.onopen = handlers.onopen;
    ws.onmessage = handlers.onmessage;
    ws.onerror = handlers.onerror;
    ws.onclose = handlers.onclose;
  }
}

/**
 * GeminiLiveSessionManager
 * Manages WebSocket sessions with Gemini Live API (v1beta BidiGenerateContent).
 * Provides continuous bidirectional audio streaming, realtime responses,
 * auto-reconnection, and native interruption.
 *
 * Protocol (per Google AI docs, current):
 *   1. Connect to wss://...v1beta...BidiGenerateContent?key=API_KEY
 *   2. First frame MUST be { setup: {...} }  — wait for { setupComplete } before anything else
 *   3. Stream mic audio as { realtimeInput: { audio: { data, mimeType: "audio/pcm;rate=16000" } } }
 *      (the old `mediaChunks` field is deprecated and silently ignored by the server)
 *   4. Receive { serverContent: { modelTurn: { parts: [...] }, interrupted, turnComplete, ... } }
 */
class GeminiLiveSessionManager extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.sessionConfig = null;
    this.isOpen = false;
    this.setupComplete = false;
    this.isManualStop = false;
    this.retryCount = 0;
    this.maxRetries = 3;
    this.currentTurnTranscript = '';
    this.windowSender = null;
    this._preSetupQueue = [];
  }

  maskKey(key) {
    if (!key) return '';
    const s = String(key).trim();
    if (s.length <= 8) return '••••••••';
    return s.slice(0, 4) + '••••••••' + s.slice(-3);
  }

  maskUrl(rawUrl) {
    if (!rawUrl) return '';
    return String(rawUrl).replace(/([?&]key=)[^&]+/gi, '$1[MASKED_API_KEY]');
  }

  /**
   * Starts a new Gemini Live WebSocket session.
   */
  async startSession({ apiKey, model, voice = 'Puck', systemInstruction = null, windowSender = null, shortLived = false }) {
    this.isManualStop = false;
    this.retryCount = 0;
    this.windowSender = windowSender;
    this.currentTurnTranscript = '';
    this.shortLived = Boolean(shortLived);
    this._preSetupQueue = [];

    if (this.ws) {
      await this.stopSession();
    }

    if (!apiKey || !String(apiKey).trim()) {
      throw new Error('Gemini API key is required for Live Mode.');
    }

    const cleanKey = String(apiKey).trim();
    let cleanModel = model ? String(model).replace(/^(models\/)+/i, '').trim() : null;

    if (!cleanModel) {
      try {
        const GeminiVoiceAdapter = require('./adapters/gemini');
        const adapter = new GeminiVoiceAdapter();
        const liveModels = await adapter.fetchModels(cleanKey, { category: 'live' });
        if (liveModels && liveModels.length > 0) {
          cleanModel = liveModels[0].id;
        }
      } catch (e) {
        console.warn('[Gemini Live API] Could not dynamically probe live models:', e.message);
      }
    }

    if (!cleanModel) {
      throw new Error('No active Live API capable model found for this Gemini key. Please select a Live model from the UI.');
    }

    this.sessionConfig = { model: cleanModel, voice, apiKey: cleanKey, systemInstruction, shortLived: this.shortLived };

    return this.connectWebSocket();
  }

  async connectWebSocket() {
    const { cleanKey, cleanModel, voice, systemInstruction } = {
      cleanKey: this.sessionConfig.apiKey,
      cleanModel: this.sessionConfig.model,
      voice: this.sessionConfig.voice,
      systemInstruction: this.sessionConfig.systemInstruction
    };

    // v1alpha is retired for BidiGenerateContent — the current documented endpoint is v1beta.
    const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(cleanKey)}`;

    console.log(`[Gemini Live API] Connecting to WebSocket: ${this.maskUrl(wsUrl)} (Model: ${cleanModel}, Voice: ${voice})`);
    this.isOpen = false;
    this.setupComplete = false;

    return new Promise((resolve, reject) => {
      let resolved = false;

      if (!NodeWebSocket) {
        try {
          const wsPkg = require('ws');
          NodeWebSocket = wsPkg.WebSocket || wsPkg;
        } catch (e) {
          return reject(new Error('Node WebSocket library (ws) is not available. Please ensure ws package is installed.'));
        }
      }

      try {
        this.ws = new NodeWebSocket(wsUrl);
      } catch (err) {
        console.error('[Gemini Live API] WebSocket initialization failed:', err);
        return reject(new Error(`Failed to create Live WebSocket: ${err.message}`));
      }

      // Capture THIS socket's identity: a stale close event from a previous session
      // must never clobber the state of a newer session (real bug: old socket's late
      // close nullified this.ws of the fresh session -> "Cannot read properties of null").
      const socket = this.ws;

      const timeoutId = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          this.stopSession();
          reject(new Error('Gemini Live API connection timed out after 12 seconds.'));
        }
      }, 12000);

      attachWsHandlers(this.ws, {
        onopen: () => {
        if (this.ws !== socket) return; // stale open from a replaced socket — ignore
        console.log('[Gemini Live API] WebSocket connected! Sending setup payload...');
        this.isOpen = true;
        this.retryCount = 0;

        const defaultPrompt = systemInstruction || 'You are JARVIS, an ultra-smart, helpful, witty AI operating layer. Speak naturally, concisely, and conversationally in Roman Urdu and English. Address the user respectfully as Boss.';
        /* AGENT AWARENESS: live roster har session setup mein inject — "kitne
           agents hain" ka exact jawabVOICE mein bhi mile (live registry se).
           Disabled agents bhi mention hote hain taake off-agent ka kaam manga
           jaye to Jarvis foran bata sake. */
        let rosterBlock = '';
        try { rosterBlock = require('../orchestrator/base-agent').registry.roster(); } catch (e) { rosterBlock = ''; }
        const withTools = defaultPrompt
          + '\n\nYOUR AGENTS (live registry — jab user pooche kitne agents hain, isi se EXACT count + names batao):\n' + (rosterBlock || '(registry unavailable)')
          + '\n\nSYSTEM ACTIONS — IMPORTANT: Aapke paas system-control tools hain (get_time, open_app, close_app, read_notepad, write_notepad, notepad_tabs, create_folder, create_file, open_path, set_volume, take_screenshot, lock_pc, get_ram, get_model, get_disks, get_battery, get_network, get_cpu, get_running_apps, get_desktop, list_folder, read_clipboard, write_clipboard, list_recycle_bin, empty_recycle_bin, uninstall_app, get_temperature, get_volume, volume_mute). RULES: (1) JAB BHI user koi system/system-info kaam kahe (time/date, app kholo/band karo, folder/file banao, notepad ki content/tabs pooche, ram/model/battery/network/apps pooche, volume, screenshot, pc lock) to pehle SAHI tool call karo, phir SIRF tool ke real result ke mutabiq bolo. (2) KABHI jhoot na bolo ("opening now" bina tool call ke = sakht mana). (3) SIRF wahi karo jo user ne kaha — "folder banao" kaha to SIRF ek folder, uske andar kuch bhi KHUD SE na banao, koi extra file/subfolder/step apni marzi se NA karo. (4) Notepad ke tabs/content ke sawal par notepad_tabs / read_notepad tools use karo — "pata nahi" bolne se pehle hamesha tool try karo. (5) "Notepad me yeh likh do" par write_notepad tool use karo (user jo bole WOHI likho, kuch apni taraf se na jodo). (6) TOOL RESULT HI TUMHARA JAWAB HAI: jab tool result aaye to usko NORMAL BOLCHAT me convert karke bolo ("Boss, likh diya aur verify bhi kar liya") — result ka RAW text / labels / implementation detail mat padho, aur result ke khilaf kuch mat bolo (result keh raha ho "likh diya" to kabhi mat bolo "nahi likha"). (7) close_app ke result me agar cancel/"rehne do" aaye to SAFA saaf bolo ke app band NAHI ki gayi.';

        const setupMsg = {
          setup: {
            model: `models/${cleanModel}`,
            generationConfig: {
              responseModalities: ['AUDIO'],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: {
                    voiceName: voice || 'Puck'
                  }
                }
              }
            },
            // Server-side VAD: config bhejne par server native defaults lagata hai
            // (end-of-speech ~1s silence, prefix padding) — user ki baat khatam
            // hote hi model TURANT jawab shuru karta hai, koi fixed turn-wait nahi.
            realtimeInputConfig: {},
            systemInstruction: {
              parts: [{
                text: withTools
              }]
            },
            tools: [{
              functionDeclarations: require('./system-tools').DECLS.functionDeclarations
            }],
            inputAudioTranscription: {},
            outputAudioTranscription: {}
          }
        };

        try {
          socket.send(JSON.stringify(setupMsg));
          console.log('[Gemini Live API] Setup payload sent. Waiting for setupComplete…');
        } catch (err) {
          console.error('[Gemini Live API] Failed to send setup message:', err);
          if (!resolved) {
            resolved = true;
            clearTimeout(timeoutId);
            reject(err);
          }
        }
      },

      onmessage: (event) => {
        if (this.ws !== socket) return; // stale frame from a replaced socket — ignore
        // Protocol gate: only treat the session as ready after setupComplete.
        if (!this.setupComplete) {
          try {
            const text = typeof event.data === 'string' ? event.data : (event.data instanceof Buffer ? event.data.toString('utf8') : '');
            const data = text ? JSON.parse(text) : {};
            if (data.setupComplete) {
              this.setupComplete = true;
              console.log('[Gemini Live API] ✓ setupComplete received — session is live.');

              // Flush mic audio buffered while setup was completing: the mic starts
              // capturing BEFORE the websocket handshake finishes, so the user's
              // first words must be queued (never dropped) and sent in order.
              const queued = this._preSetupQueue.splice(0, this._preSetupQueue.length);
              if (queued.length) {
                console.log(`[Gemini Live API] Flushing ${queued.length} pre-setup mic chunk(s)...`);
                for (const chunk of queued) {
                  try { socket.send(JSON.stringify({ realtimeInput: { audio: { data: String(chunk).replace(/^data:[^;]+;base64,/, ''), mimeType: 'audio/pcm;rate=16000' } } })); } catch (e) {}
                }
              }

              if (!resolved) {
                resolved = true;
                clearTimeout(timeoutId);
                db.logActivity(
                  'Gemini Live',
                  `Live Voice Session Connected [Model: ${cleanModel}, Voice: ${voice}]`,
                  'Realtime bidirectional voice stream active',
                  'success'
                );

                if (this.windowSender && !this.windowSender.isDestroyed()) {
                  this.windowSender.send('voice:live:status', { status: 'connected', model: cleanModel, voice });
                }

                resolve({
                  success: true,
                  model: cleanModel,
                  voice
                });
              }
              return; // do not process this frame as content
            }
            if (data.error) {
              if (!resolved) {
                resolved = true;
                clearTimeout(timeoutId);
                const msg = data.error.message || JSON.stringify(data.error);
                reject(new Error(`Gemini Live setup rejected: ${msg}`));
              }
              try { socket.close(); } catch (e) {}
              return;
            }
            // Server closed-frame path handled by onclose; ignore other frames pre-setup.
            return;
          } catch (e) {
            console.error('[Gemini Live API] Error parsing setup phase message:', e);
            return;
          }
        }

        this.handleIncomingMessage(event.data);
      },

      onerror: (errEvent) => {
        if (this.ws !== socket) return; // stale error from a replaced socket — ignore
        const errorMsg = errEvent.message || 'WebSocket communication error';
        console.error('[Gemini Live API] WebSocket error:', errorMsg);

        db.logActivity(
          'Gemini Live',
          'Live Voice WebSocket error',
          errorMsg,
          'failed'
        );

        if (this.windowSender && !this.windowSender.isDestroyed()) {
          this.windowSender.send('voice:live:error', { error: errorMsg });
        }

        if (!resolved) {
          resolved = true;
          clearTimeout(timeoutId);
          reject(new Error(`Gemini Live connection error: ${errorMsg}`));
        }
      },

      onclose: (event) => {
        const isCurrentSocket = (this.ws === socket);
        console.log(`[Gemini Live API] WebSocket closed (Code: ${event.code}, Reason: ${event.reason || 'Normal'}, current: ${isCurrentSocket})`);
        const hadSetupComplete = isCurrentSocket ? this.setupComplete : false;
        if (isCurrentSocket) {
          this.isOpen = false;
          this.setupComplete = false;
          this.ws = null;
        } else {
          // Stale close from an older/replaced socket — new session state untouched
          return;
        }

        if (this.windowSender && !this.windowSender.isDestroyed()) {
          this.windowSender.send('voice:live:status', { status: 'closed', code: event.code, reason: event.reason });
        }

        // Setup rejected (bad model/voice/key) — surface a clear error instead of looping reconnects
        if (!this.setupComplete && !resolved && !this.isManualStop) {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeoutId);
            reject(new Error(
              `Gemini Live setup was rejected by the server (Code ${event.code}: ${event.reason || 'no reason'}). ` +
              `Check that model "${cleanModel}" and voice "${voice}" are currently available for your API key, then refresh the model/voice dropdowns.`
            ));
          }
          return;
        }

        // Auto-reconnect only if the session was fully established before it dropped
        if (!this.isManualStop && hadSetupComplete && this.sessionConfig && this.retryCount < this.maxRetries) {
          this.retryCount++;
          const delay = this.retryCount * 1200;
          console.log(`[Gemini Live API] Reconnecting session (Attempt ${this.retryCount}/${this.maxRetries}) in ${delay}ms...`);
          if (this.windowSender && !this.windowSender.isDestroyed()) {
            this.windowSender.send('voice:live:status', { status: 'reconnecting', attempt: this.retryCount });
          }
          setTimeout(() => {
            if (!this.isManualStop && !this.isOpen) {
              this.connectWebSocket().catch(err => {
                console.error('[Gemini Live API] Reconnection failed:', err.message);
              });
            }
          }, delay);
        }
      }
      });
    });
  }

  /**
   * Safe window send: short-lived TTS sessions have no window — events must
   * still flow to emitter listeners (synthesizeViaLiveSession collects audio).
   */
  safeSend(channel, payload) {
    if (this.windowSender && !this.windowSender.isDestroyed()) {
      this.windowSender.send(channel, payload);
    }
  }

  /**
   * Handles incoming WebSocket messages from Gemini Live server.
   */
  handleIncomingMessage(rawData) {
    try {
      const text = typeof rawData === 'string' ? rawData : (rawData instanceof Buffer ? rawData.toString('utf8') : '');
      if (!text) return;

      const data = JSON.parse(text);

      // 0. Server-side errors mid-session
      if (data.error) {
        const msg = data.error.message || JSON.stringify(data.error);
        console.error('[Gemini Live API] Server error:', msg);
        this.emit('live:error', { error: msg });
        this.safeSend('voice:live:error', { error: msg });
        return;
      }

      // 1. Server interruption signal (user spoke while model was speaking)
      if (data.serverContent?.interrupted) {
        console.log('[Gemini Live API] User interrupted model speech -> broadcasting interrupt');
        this.currentTurnTranscript = '';
        this.safeSend('voice:live:interrupted');
      }

      // 2. Extract model turn audio chunks & text transcripts
      const modelTurn = data.serverContent?.modelTurn;
      if (modelTurn && Array.isArray(modelTurn.parts)) {
        for (const part of modelTurn.parts) {
          // Thinking/reasoning summary parts user ko KABHI nahi dikhani —
          // ye model ke internal notes hain (chat me ulta jawab jaisa lagta tha).
          if (part.thought) continue;
          // Audio Part (PCM 24kHz)
          if (part.inlineData && part.inlineData.data) {
            this.emit('live:audio', { mimeType: part.inlineData.mimeType || 'audio/pcm;rate=24000', data: part.inlineData.data });
            this.safeSend('voice:live:audio', {
              mimeType: part.inlineData.mimeType || 'audio/pcm;rate=24000',
              data: part.inlineData.data
            });
          }
          // Text Transcript Part — SKIP thought summaries (part.thought=true):
          // the model's internal "Refining..." reasoning must never appear in the
          // user-visible chat transcript (real bug: transcript looked like Jarvis
          // was answering something else entirely).
          if (part.text && !part.thought) {
            this.currentTurnTranscript += part.text;
            this.safeSend('voice:live:text', {
              text: part.text,
              isModel: true
            });
          }
        }
      }

      // 2a-TOOL. Function call: model ne system action manga → REAL execution via
      // SystemBridge → nateeja wapis session ko (Jarvis verified truth bolta hai).
      const toolCall = data.toolCall;
      if (toolCall && Array.isArray(toolCall.functionCalls) && toolCall.functionCalls.length) {
        (async () => {
          for (const fc of toolCall.functionCalls) {
            if (!fc || !fc.name) continue;
            let args = {};
            try { args = typeof fc.args === 'string' ? JSON.parse(fc.args) : (fc.args || {}); } catch (e) { args = {}; }
            console.log(`[Gemini Live API] 🔧 Tool call: ${fc.name}(${JSON.stringify(args).slice(0, 120)})`);
            db.logActivity('Gemini Live', `Tool call: ${fc.name}`, { args: JSON.stringify(args).slice(0, 200) }, 'success');
            const resultText = await require('./system-tools').dispatch(fc.name, args);
            db.logActivity('Gemini Live', `Tool result: ${fc.name} → ${String(resultText).slice(0, 60)}`, null, 'success');
            try {
              this.ws.send(JSON.stringify({
                toolResponse: {
                  functionResponses: [{
                    id: fc.id || undefined,
                    name: fc.name,
                    response: { result: resultText }
                  }]
                }
              }));
            } catch (e) { console.error('[Gemini Live API] toolResponse send fail:', e.message); }
          }
        })().catch(e => console.error('[Gemini Live API] tool dispatch error:', e.message));
        return; // toolCall frame turnComplete nahi hota — response turn alag aata hai
      }

      // 2b. Output Audio Transcription (built-in live transcription for native audio)
      const outputTranscription = data.serverContent?.outputAudioTranscription?.text || data.serverContent?.outputTranscription?.text;
      if (outputTranscription) {
        this.currentTurnTranscript += outputTranscription;
        this.safeSend('voice:live:text', {
          text: outputTranscription,
          isModel: true
        });
      }

      // 2c. Input Audio Transcription (user's spoken words in real time)
      const inputTranscription = data.serverContent?.inputAudioTranscription?.text || data.serverContent?.inputTranscription?.text;
      if (inputTranscription) {
        this._lastUserUtterance = (this._lastUserUtterance || '') + inputTranscription;
        this.safeSend('voice:live:text', {
          text: inputTranscription,
          isUser: true
        });
      }

      // 3. Turn Complete: save utterance to DB activity & vault memory
      if (data.serverContent?.turnComplete) {
        if (this.currentTurnTranscript && this.currentTurnTranscript.trim()) {
          const finalUtterance = this.currentTurnTranscript.trim();
          db.logActivity('Gemini Live', `Jarvis Live Reply: "${finalUtterance.slice(0, 60)}${finalUtterance.length > 60 ? '...' : ''}"`, null, 'success');
          this.currentTurnTranscript = '';
        }
        // Log the user's spoken turn too (usage panel counts real live turns)
        if (this._lastUserUtterance && this._lastUserUtterance.trim()) {
          db.logActivity('Gemini Live', `User Live Turn: "${this._lastUserUtterance.trim().slice(0, 60)}"`, null, 'success');
          this._lastUserUtterance = '';
        }
        this.emit('live:turnComplete');
        this.safeSend('voice:live:turnComplete');
      }

    } catch (err) {
      console.error('[Gemini Live API] Error parsing incoming message:', err);
    }
  }

  /**
   * Turn-based text send (clientContent): used by synthesizeViaLiveSession so a
   * chat reply can be spoken by the SAME Live model/voice over its own quota.
   * Session must be setup-complete; if a conversation session is active the
   * reply also plays in the app window (same behavior as spoken mic turns).
   */
  sendClientText(text) {
    if (!this.ws || !this.isOpen) {
      return { success: false, error: 'Live session is not connected' };
    }
    if (!this.setupComplete) {
      return { success: false, error: 'Live session setup not complete yet' };
    }
    try {
      const payload = {
        clientContent: {
          turns: [{ role: 'user', parts: [{ text: String(text) }] }],
          turnComplete: true
        }
      };
      this.ws.send(JSON.stringify(payload));
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Sends audio chunk from client microphone to Gemini Live API.
   * Audio must be 16kHz 16-bit mono PCM base64.
   * Uses the CURRENT protocol: realtimeInput.audio { data, mimeType }.
   */
  sendAudioChunk(base64Pcm16) {
    if (!this.ws || !this.isOpen) {
      return { success: false, error: 'Live session is not connected' };
    }
    if (!this.setupComplete) {
      // BUFFER, never drop: the mic starts instantly while the WS handshake is
      // still completing (~1s). Queued chunks flush in order right after
      // setupComplete, so the user's first words are heard by the model.
      if (!this.isManualStop && this.sessionConfig) {
        if (!Array.isArray(this._preSetupQueue)) this._preSetupQueue = [];
        if (this._preSetupQueue.length < 200) {
          this._preSetupQueue.push(String(base64Pcm16).replace(/^data:[^;]+;base64,/, ''));
          return { success: true, buffered: true };
        }
      }
      return { success: false, error: 'Live session setup not complete yet' };
    }

    try {
      const cleanData = String(base64Pcm16).replace(/^data:[^;]+;base64,/, '');
      const payload = {
        realtimeInput: {
          audio: {
            data: cleanData,
            mimeType: 'audio/pcm;rate=16000'
          }
        }
      };

      this.ws.send(JSON.stringify(payload));
      return { success: true };
    } catch (err) {
      console.error('[Gemini Live API] Failed to send audio chunk:', err);
      return { success: false, error: err.message };
    }
  }

  /**
   * Stops the active Gemini Live WebSocket session.
   */
  async stopSession() {
    this.isManualStop = true;
    this.isOpen = false;
    this.setupComplete = false;
    this._preSetupQueue = [];
    if (this.ws) {
      try {
        this.ws.close();
      } catch (e) {}
      this.ws = null;
    }
    console.log('[Gemini Live API] Session terminated cleanly.');
    return { success: true };
  }

  getStatus() {
    return {
      active: this.isOpen,
      setupComplete: this.setupComplete,
      config: this.sessionConfig
    };
  }
}

module.exports = new GeminiLiveSessionManager();

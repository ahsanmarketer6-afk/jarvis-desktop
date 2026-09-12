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
  async startSession({ apiKey, model, voice = 'Puck', systemInstruction = null, windowSender = null }) {
    this.isManualStop = false;
    this.retryCount = 0;
    this.windowSender = windowSender;
    this.currentTurnTranscript = '';

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

    this.sessionConfig = { model: cleanModel, voice, apiKey: cleanKey, systemInstruction };

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

      const timeoutId = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          this.stopSession();
          reject(new Error('Gemini Live API connection timed out after 12 seconds.'));
        }
      }, 12000);

      this.ws.onopen = () => {
        console.log('[Gemini Live API] WebSocket connected! Sending setup payload...');
        this.isOpen = true;
        this.retryCount = 0;

        const defaultPrompt = systemInstruction || 'You are JARVIS, an ultra-smart, helpful, witty AI operating layer. Speak naturally, concisely, and conversationally in Roman Urdu and English. Address the user respectfully as Boss.';

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
            systemInstruction: {
              parts: [{
                text: defaultPrompt
              }]
            },
            inputAudioTranscription: {},
            outputAudioTranscription: {}
          }
        };

        try {
          this.ws.send(JSON.stringify(setupMsg));
          console.log('[Gemini Live API] Setup payload sent. Waiting for setupComplete…');
        } catch (err) {
          console.error('[Gemini Live API] Failed to send setup message:', err);
          if (!resolved) {
            resolved = true;
            clearTimeout(timeoutId);
            reject(err);
          }
        }
      };

      this.ws.onmessage = (event) => {
        // Protocol gate: only treat the session as ready after setupComplete.
        if (!this.setupComplete) {
          try {
            const text = typeof event.data === 'string' ? event.data : (event.data instanceof Buffer ? event.data.toString('utf8') : '');
            const data = text ? JSON.parse(text) : {};
            if (data.setupComplete) {
              this.setupComplete = true;
              console.log('[Gemini Live API] ✓ setupComplete received — session is live.');

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
              try { this.ws.close(); } catch (e) {}
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
      };

      this.ws.onerror = (errEvent) => {
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
      };

      this.ws.onclose = (event) => {
        console.log(`[Gemini Live API] WebSocket closed (Code: ${event.code}, Reason: ${event.reason || 'Normal'})`);
        const hadSetupComplete = this.setupComplete;
        this.isOpen = false;
        this.setupComplete = false;
        this.ws = null;

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
      };
    });
  }

  /**
   * Handles incoming WebSocket messages from Gemini Live server.
   */
  handleIncomingMessage(rawData) {
    if (!this.windowSender || this.windowSender.isDestroyed()) return;

    try {
      const text = typeof rawData === 'string' ? rawData : (rawData instanceof Buffer ? rawData.toString('utf8') : '');
      if (!text) return;

      const data = JSON.parse(text);

      // 0. Server-side errors mid-session
      if (data.error) {
        const msg = data.error.message || JSON.stringify(data.error);
        console.error('[Gemini Live API] Server error:', msg);
        this.windowSender.send('voice:live:error', { error: msg });
        return;
      }

      // 1. Server interruption signal (user spoke while model was speaking)
      if (data.serverContent?.interrupted) {
        console.log('[Gemini Live API] User interrupted model speech -> broadcasting interrupt');
        this.currentTurnTranscript = '';
        this.windowSender.send('voice:live:interrupted');
      }

      // 2. Extract model turn audio chunks & text transcripts
      const modelTurn = data.serverContent?.modelTurn;
      if (modelTurn && Array.isArray(modelTurn.parts)) {
        for (const part of modelTurn.parts) {
          // Audio Part (PCM 24kHz)
          if (part.inlineData && part.inlineData.data) {
            this.windowSender.send('voice:live:audio', {
              mimeType: part.inlineData.mimeType || 'audio/pcm;rate=24000',
              data: part.inlineData.data
            });
          }
          // Text Transcript Part (if provided directly)
          if (part.text) {
            this.currentTurnTranscript += part.text;
            this.windowSender.send('voice:live:text', {
              text: part.text,
              isModel: true
            });
          }
        }
      }

      // 2b. Output Audio Transcription (built-in live transcription for native audio)
      const outputTranscription = data.serverContent?.outputAudioTranscription?.text || data.serverContent?.outputTranscription?.text;
      if (outputTranscription) {
        this.currentTurnTranscript += outputTranscription;
        this.windowSender.send('voice:live:text', {
          text: outputTranscription,
          isModel: true
        });
      }

      // 2c. Input Audio Transcription (user's spoken words in real time)
      const inputTranscription = data.serverContent?.inputAudioTranscription?.text || data.serverContent?.inputTranscription?.text;
      if (inputTranscription) {
        this.windowSender.send('voice:live:text', {
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
        this.windowSender.send('voice:live:turnComplete');
      }

    } catch (err) {
      console.error('[Gemini Live API] Error parsing incoming message:', err);
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
      // Buffer-drop is safe: setup usually completes in <1s; audio before setup is rejected by server.
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

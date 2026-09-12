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
 * Manages WebSocket sessions with Gemini Live API (v1alpha BidiGenerateContent).
 * Provides continuous bidirectional audio streaming, realtime responses, auto-reconnection, and native interruption.
 */
class GeminiLiveSessionManager extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.sessionConfig = null;
    this.isOpen = false;
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
    const cleanModel = (model || 'gemini-2.0-flash-exp').replace(/^(models\/)+/i, '');
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

    const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(cleanKey)}`;

    console.log(`[Gemini Live API] Connecting to WebSocket: ${this.maskUrl(wsUrl)} (Model: ${cleanModel}, Voice: ${voice})`);
    this.isOpen = false;

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
          console.log('[Gemini Live API] Setup payload sent successfully.');
          
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
        this.isOpen = false;
        this.ws = null;

        if (this.windowSender && !this.windowSender.isDestroyed()) {
          this.windowSender.send('voice:live:status', { status: 'closed', code: event.code, reason: event.reason });
        }

        // Auto-reconnect if dropped unexpectedly during an active user session
        if (!this.isManualStop && this.sessionConfig && this.retryCount < this.maxRetries) {
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
   */
  sendAudioChunk(base64Pcm16) {
    if (!this.ws || !this.isOpen) {
      return { success: false, error: 'Live session is not connected' };
    }

    try {
      const cleanData = String(base64Pcm16).replace(/^data:[^;]+;base64,/, '');
      const payload = {
        realtimeInput: {
          mediaChunks: [
            {
              mimeType: 'audio/pcm;rate=16000',
              data: cleanData
            }
          ]
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
      config: this.sessionConfig
    };
  }
}

module.exports = new GeminiLiveSessionManager();

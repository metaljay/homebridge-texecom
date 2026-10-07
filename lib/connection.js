'use strict';

const EventEmitter = require('node:events');
const net = require('node:net');
const { LineSplitter, parseLine, encodeCommand, WINTEX_LOGOUT, WINTEX_ACK, WINTEX_NAK } = require('./protocol');

const COMMAND_TIMEOUT_MS = 5000;
// A real panel took 3-6 s to answer a UDL login with OK, and often never
// does although the session opens (review 2.0b), so a missing OK is not fatal.
const LOGIN_TIMEOUT_MS = 8000;
const RECONNECT_MIN_MS = 5000;
const RECONNECT_MAX_MS = 60000;
const TCP_KEEPALIVE_MS = 30000;
// Measured on a real panel: the text feed resumes ~30 s after a Wintex logout.
const POST_LOGOUT_BLACKOUT_MS = 35000;
// ASTATUS poll: a liveness check and a correction for missed arm/disarm events.
const DEFAULT_STATUS_POLL_MS = 60000;
// Reconnect after this many poll intervals without any data from the panel.
const SILENT_POLLS_BEFORE_RECONNECT = 3;

/**
 * Manages the link to the panel over either TCP (COM-IP / SmartCom) or a
 * serial port, and provides a serialised request/acknowledge command channel.
 *
 * Events:
 *   'line'       (string) every complete line received from the panel
 *   'frame'      (Buffer) every binary Wintex frame received during a UDL session
 *   'connected'
 *   'disconnected'
 *
 * While connected it sends ASTATUS every `statusPollMs` (0 = never). A TCP
 * keep-alive only proves the IP module or serial bridge is up; the poll proves
 * the panel behind it still answers, and reconnects when it has gone quiet.
 */
class TexecomConnection extends EventEmitter {
  /**
   * @param {object} opts
   * @param {import('homebridge').Logging} opts.log
   * @param {string} [opts.host]
   * @param {number} [opts.port]
   * @param {string} [opts.serialPath]
   * @param {number} [opts.baudRate]
   * @param {number} [opts.statusPollMs]
   * @param {number} [opts.loginTimeoutMs]
   */
  constructor({ log, host, port, serialPath, baudRate, statusPollMs = DEFAULT_STATUS_POLL_MS,
    loginTimeoutMs = LOGIN_TIMEOUT_MS }) {
    super();
    this.log = log;
    this.host = host;
    this.port = port;
    this.serialPath = serialPath;
    this.baudRate = baudRate;

    this.transport = null;
    this.connected = false;
    this.stopped = false;
    this.reconnectTimer = null;
    this.reconnectDelay = RECONNECT_MIN_MS;
    this.splitter = new LineSplitter((line) => this.emit('line', line), (frame) => this.emit('frame', frame));
    this.queue = Promise.resolve();
    this.blackoutUntil = 0;
    this.statusPollMs = statusPollMs;
    this.loginTimeoutMs = loginTimeoutMs;
    this.pollTimer = null;
    this.lastDataAt = 0;
    this.busy = false;
  }

  /** True while the panel is expected to be holding back the text feed. */
  get inBlackout() {
    return Date.now() < this.blackoutUntil;
  }

  /** Sends a plain Crestron query line (e.g. ASTATUS); replies arrive as 'line' events. */
  sendQuery(text) {
    if (!this.connected || !this.transport || this.inBlackout) {
      return false;
    }
    this.transport.write(Buffer.from(`${text}\r\n`, 'latin1'));
    return true;
  }

  get description() {
    return this.serialPath ? `serial ${this.serialPath}` : `${this.host}:${this.port}`;
  }

  start() {
    this.stopped = false;
    this._open();
  }

  stop() {
    this.stopped = true;
    this._stopPolling();
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.transport) {
      this.transport.removeAllListeners();
      // Keep a no-op error handler so a late error during teardown can't crash.
      this.transport.on('error', () => {});
      if (this.serialPath) {
        if (this.transport.isOpen) {
          this.transport.close();
        }
      } else {
        this.transport.destroy();
      }
      this.transport = null;
    }
    this.connected = false;
  }

  _open() {
    this.splitter.reset();
    this.log.info(`Connecting to Texecom panel via ${this.description}...`);
    if (this.serialPath) {
      this._openSerial();
    } else {
      this._openTcp();
    }
  }

  _openTcp() {
    const socket = net.createConnection({ host: this.host, port: this.port });
    socket.setNoDelay(true);
    socket.setKeepAlive(true, TCP_KEEPALIVE_MS);

    socket.on('connect', () => this._onConnected());
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', (err) => this.log.error(`Connection error (${this.description}): ${err.message}`));
    socket.on('close', () => this._onClosed());

    this.transport = socket;
  }

  _openSerial() {
    // Loaded lazily so IP-only installs never touch the native serial binding.
    const { SerialPort } = require('serialport');

    const port = new SerialPort({ path: this.serialPath, baudRate: this.baudRate }, (err) => {
      if (err) {
        this.log.error(`Unable to open ${this.description}: ${err.message}`);
        this._scheduleReconnect();
      } else {
        this._onConnected();
      }
    });

    port.on('data', (chunk) => this._onData(chunk));
    port.on('error', (err) => this.log.error(`Serial error (${this.description}): ${err.message}`));
    port.on('close', () => this._onClosed());

    this.transport = port;
  }

  _onData(chunk) {
    this.lastDataAt = Date.now();
    this.splitter.push(chunk);
  }

  _onConnected() {
    this.connected = true;
    this.reconnectDelay = RECONNECT_MIN_MS;
    this.lastDataAt = Date.now();
    this.log.info(`Connected to Texecom panel via ${this.description}`);
    this._startPolling();
    this.emit('connected');
  }

  _startPolling() {
    this._stopPolling();
    if (this.statusPollMs > 0) {
      this.pollTimer = setInterval(() => this._poll(), this.statusPollMs);
    }
  }

  _stopPolling() {
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  _poll() {
    if (!this.connected || this.busy) {
      return;
    }
    // Nothing is expected while the panel holds the feed back after a logout.
    const quietSince = Math.max(this.lastDataAt, this.blackoutUntil);
    const quietMs = Date.now() - quietSince;
    if (quietMs > SILENT_POLLS_BEFORE_RECONNECT * this.statusPollMs) {
      this.log.warn(`No reply from the panel for ${Math.round(quietMs / 1000)}s via ${this.description}; reconnecting`);
      this._dropTransport();
      return;
    }
    this.sendQuery('ASTATUS');
  }

  /** Closes the transport; its 'close' event schedules the reconnect. */
  _dropTransport() {
    if (!this.transport) {
      return;
    }
    if (this.serialPath) {
      if (this.transport.isOpen) {
        this.transport.close();
      }
    } else {
      this.transport.destroy();
    }
  }

  _onClosed() {
    const wasConnected = this.connected;
    this.connected = false;
    this._stopPolling();
    if (wasConnected) {
      this.log.warn(`Connection to Texecom panel (${this.description}) closed`);
      this.emit('disconnected');
    }
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) {
      return;
    }
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
    this.log.info(`Reconnecting in ${delay / 1000}s`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.transport) {
        this.transport.removeAllListeners();
        this.transport.on('error', () => {});
        this.transport = null;
      }
      this._open();
    }, delay);
  }

  /**
   * Run a sequence of commands as one exclusive transaction, e.g. a UDL login
   * followed by an arm command. Transactions never interleave. A string is a
   * Crestron/Simple command (`\\…/`, answered OK); a Buffer is a binary UDL
   * frame (answered with a binary ACK) and is never retried. `{text, frame}`
   * sends the text command once and, if the panel answers ERROR, the frame.
   *
   * @param {(string|Buffer|{text: string, frame: Buffer|null})[]} commands
   * @returns {Promise<void>}
   */
  sendCommands(commands) {
    const run = this.queue.then(async () => {
      this.busy = true;
      try {
        for (const command of commands) {
          if (Buffer.isBuffer(command)) {
            await this._sendFrame(command);
          } else if (typeof command === 'object') {
            await this._sendTextOrFrame(command);
          } else if (command.startsWith('W')) {
            await this._login(command);
          } else {
            await this._sendWithRetry(command);
          }
        }
      } finally {
        this._logout(commands);
        this.busy = false;
      }
    });
    // Keep the queue alive even when a transaction fails.
    this.queue = run.catch(() => {});
    return run;
  }

  /**
   * A \\W<udl>/ login opens a Wintex session that silences the text feed
   * until ~60 s after the last command. Logging out shortens that to ~30 s.
   */
  _logout(commands) {
    if (!commands.some((c) => typeof c === 'string' && c.startsWith('W')) || !this.connected || !this.transport) {
      return;
    }
    this.transport.write(WINTEX_LOGOUT);
    this.blackoutUntil = Date.now() + POST_LOGOUT_BLACKOUT_MS;
    this.log.debug('Sent Wintex logout; panel events may be held back for ~30 s');
  }

  /** UDL login: sent once (a resend would open a second session); ERROR fails it. */
  async _login(command) {
    try {
      await this._send(command, this.loginTimeoutMs);
    } catch (err) {
      if (!/Timed out/.test(err.message)) {
        throw err;
      }
      this.log.debug('No OK to the UDL login; continuing (the session usually opens anyway)');
    }
  }

  /**
   * When a login gets no OK, the panel was seen answering ERROR to text
   * commands in the session while binary frames worked (real panel, 7 Oct).
   */
  async _sendTextOrFrame({ text, frame }) {
    try {
      await this._send(text);
    } catch (err) {
      if (!frame || !/rejected/.test(err.message)) {
        throw err;
      }
      this.log.debug('Panel answered ERROR to the text command; sending the binary UDL equivalent');
      await this._sendFrame(frame);
    }
  }

  /** Writes a binary UDL frame and waits for the panel's binary ACK or NAK. */
  _sendFrame(frame) {
    return new Promise((resolve, reject) => {
      if (!this.connected || !this.transport) {
        reject(new Error('Not connected to panel'));
        return;
      }
      const finish = (err) => {
        clearTimeout(timer);
        this.off('frame', onFrame);
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      };
      const onFrame = (reply) => {
        if (reply[1] === WINTEX_ACK) {
          finish();
        } else if (reply[1] === WINTEX_NAK) {
          finish(new Error('Panel refused command'));
        }
      };
      const timer = setTimeout(() => finish(new Error('Timed out waiting for panel acknowledgement')),
        COMMAND_TIMEOUT_MS);
      this.on('frame', onFrame);
      this.transport.write(frame, (err) => {
        if (err) {
          finish(err);
        }
      });
    });
  }

  async _sendWithRetry(command, retries = 1) {
    for (let attempt = 0; ; attempt++) {
      try {
        await this._send(command);
        return;
      } catch (err) {
        if (attempt >= retries || !this.connected) {
          throw err;
        }
        this.log.debug(`Command attempt ${attempt + 1} failed (${err.message}), retrying`);
      }
    }
  }

  _send(command, timeoutMs = COMMAND_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      if (!this.connected || !this.transport) {
        reject(new Error('Not connected to panel'));
        return;
      }

      let settled = false;
      const finish = (err) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        this.off('line', onLine);
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      };

      const onLine = (line) => {
        const message = parseLine(line);
        if (message.type === 'ok') {
          finish();
        } else if (message.type === 'error') {
          finish(new Error('Panel rejected command'));
        }
      };

      const timer = setTimeout(() => finish(new Error('Timed out waiting for panel acknowledgement')),
        timeoutMs);

      this.on('line', onLine);
      this.transport.write(encodeCommand(command), (err) => {
        if (err) {
          finish(err);
        }
      });
    });
  }
}

module.exports = { TexecomConnection };

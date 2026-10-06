'use strict';

const EventEmitter = require('node:events');
const net = require('node:net');
const { LineSplitter, parseLine, encodeCommand, WINTEX_LOGOUT } = require('./protocol');

// A real COM-IP has been measured taking 3 s to acknowledge a UDL login.
const COMMAND_TIMEOUT_MS = 5000;
const RECONNECT_MIN_MS = 5000;
const RECONNECT_MAX_MS = 60000;
const TCP_KEEPALIVE_MS = 30000;
// Measured on a real panel: the text feed resumes ~30 s after a Wintex logout.
const POST_LOGOUT_BLACKOUT_MS = 35000;

/**
 * Manages the link to the panel over either TCP (COM-IP / SmartCom) or a
 * serial port, and provides a serialised request/acknowledge command channel.
 *
 * Events:
 *   'line'       (string) every complete line received from the panel
 *   'connected'
 *   'disconnected'
 */
class TexecomConnection extends EventEmitter {
  /**
   * @param {object} opts
   * @param {import('homebridge').Logging} opts.log
   * @param {string} [opts.host]
   * @param {number} [opts.port]
   * @param {string} [opts.serialPath]
   * @param {number} [opts.baudRate]
   */
  constructor({ log, host, port, serialPath, baudRate }) {
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
    this.splitter = new LineSplitter((line) => this.emit('line', line));
    this.queue = Promise.resolve();
    this.blackoutUntil = 0;
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
    socket.on('data', (chunk) => this.splitter.push(chunk));
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

    port.on('data', (chunk) => this.splitter.push(chunk));
    port.on('error', (err) => this.log.error(`Serial error (${this.description}): ${err.message}`));
    port.on('close', () => this._onClosed());

    this.transport = port;
  }

  _onConnected() {
    this.connected = true;
    this.reconnectDelay = RECONNECT_MIN_MS;
    this.log.info(`Connected to Texecom panel via ${this.description}`);
    this.emit('connected');
  }

  _onClosed() {
    const wasConnected = this.connected;
    this.connected = false;
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
   * followed by an arm command. Transactions never interleave.
   *
   * @param {string[]} commands
   * @returns {Promise<void>}
   */
  sendCommands(commands) {
    const run = this.queue.then(async () => {
      try {
        for (const command of commands) {
          await this._sendWithRetry(command);
        }
      } finally {
        this._logout(commands);
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
    if (!commands.some((c) => c.startsWith('W')) || !this.connected || !this.transport) {
      return;
    }
    this.transport.write(WINTEX_LOGOUT);
    this.blackoutUntil = Date.now() + POST_LOGOUT_BLACKOUT_MS;
    this.log.debug('Sent Wintex logout; panel events may be held back for ~30 s');
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

  _send(command) {
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
        COMMAND_TIMEOUT_MS);

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

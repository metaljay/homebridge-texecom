'use strict';

const EventEmitter = require('node:events');
const net = require('node:net');
const P = require('./protocol');

const COMMAND_TIMEOUT_MS = 2500;
const COMMAND_ATTEMPTS = 3;
const KEEPALIVE_MS = 30000; // the panel drops a session after ~60 s without a command
const LOGIN_DELAY_MS = 500; // a login sent immediately after connecting is ignored
const RECONNECT_MIN_MS = 5000;
const RECONNECT_MAX_MS = 60000;

/**
 * Texecom Connect client (TCP to a SmartCom/ComIP in normal mode).
 *
 * Events:
 *   'ready'         logged in and subscribed to events
 *   'message' (m)   decoded unsolicited message (see protocol.decodeMessage)
 *   'disconnected' (reason)
 */
class ConnectClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {{info: Function, warn: Function, error: Function, debug: Function}} opts.log
   * @param {string} opts.host
   * @param {number} [opts.port]
   * @param {string} opts.udl
   */
  constructor({ log, host, port = 10001, udl }) {
    super();
    this.log = log;
    this.host = host;
    this.port = port;
    this.udl = String(udl);
    this.socket = null;
    this.ready = false;
    this.stopped = true;
    this.sequence = 0;
    this.pending = null; // command awaiting its response
    this.queue = [];
    this.lastMessageSeq = -1;
    this.keepaliveTimer = null;
    this.reconnectTimer = null;
    this.reconnectDelay = RECONNECT_MIN_MS;
    this.parser = new P.FrameParser({
      onFrame: (f) => this._onFrame(f),
      onDrop: (reason) => this._drop(reason),
      onError: (m) => this.log.debug(`Connect: ${m}`),
    });
  }

  start() {
    this.stopped = false;
    this._open();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this._teardown('stopped');
  }

  _open() {
    this.parser.reset();
    this.lastMessageSeq = -1;
    this.log.info(`Connect: connecting to ${this.host}:${this.port}`);
    const socket = net.createConnection({ host: this.host, port: this.port });
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 10000);
    socket.on('connect', () => setTimeout(() => this._onConnected(), LOGIN_DELAY_MS));
    socket.on('data', (d) => this.parser.push(d));
    socket.on('error', (e) => this.log.warn(`Connect: socket error: ${e.message}`));
    socket.on('close', () => this._drop('connection closed'));
    this.socket = socket;
  }

  async _onConnected() {
    if (!this.socket) {
      return;
    }
    try {
      const login = await this.command(P.COMMAND.LOGIN, Buffer.from(this.udl, 'latin1'));
      if (login[0] !== P.ACK) {
        throw new Error(login[0] === P.NAK ? 'login rejected (check the UDL code)' : `unexpected login reply ${login.toString('hex')}`);
      }
      const flags = P.EVENT_FLAG.ZONE | P.EVENT_FLAG.AREA | P.EVENT_FLAG.OUTPUT | P.EVENT_FLAG.USER | P.EVENT_FLAG.LOG;
      const sub = await this.command(P.COMMAND.SET_EVENT_MESSAGES, Buffer.from([flags & 0xff, flags >> 8]));
      if (sub[0] !== P.ACK) {
        throw new Error('panel refused event subscription');
      }
      this.ready = true;
      this.reconnectDelay = RECONNECT_MIN_MS;
      this.log.info('Connect: logged in and subscribed to events');
      this._armKeepalive();
      this.emit('ready');
    } catch (err) {
      this.log.error(`Connect: ${err.message}`);
      this._drop(err.message);
    }
  }

  /**
   * Queue a command; resolves with the response payload (after the echoed
   * command byte). Commands never overlap; each is retried on timeout.
   */
  command(cmd, body) {
    return new Promise((resolve, reject) => {
      this.queue.push({ cmd, body, resolve, reject });
      this._pump();
    });
  }

  _pump() {
    if (this.pending || this.queue.length === 0) {
      return;
    }
    if (!this.socket) {
      this.queue.splice(0).forEach((c) => c.reject(new Error('not connected')));
      return;
    }
    const item = this.queue.shift();
    const sequence = this.sequence;
    this.sequence = (this.sequence + 1) & 0xff;
    const frame = P.encodeCommand(sequence, item.cmd, item.body);
    const pending = { ...item, sequence, frame, attempts: 0, timer: null };
    this.pending = pending;
    const attempt = () => {
      if (pending.attempts >= COMMAND_ATTEMPTS) {
        this._finish(pending, new Error(`command ${item.cmd} timed out after ${COMMAND_ATTEMPTS} attempts`));
        return;
      }
      pending.attempts++;
      this.socket.write(frame); // same sequence number on resend
      pending.timer = setTimeout(attempt, COMMAND_TIMEOUT_MS);
    };
    attempt();
    this._armKeepalive();
  }

  _finish(pending, err, payload) {
    clearTimeout(pending.timer);
    if (this.pending === pending) {
      this.pending = null;
    }
    if (err) {
      pending.reject(err);
    } else {
      pending.resolve(payload);
    }
    setImmediate(() => this._pump());
  }

  _onFrame({ type, sequence, body }) {
    if (type === P.TYPE.RESPONSE) {
      const pending = this.pending;
      if (!pending || sequence !== pending.sequence) {
        this.log.debug(`Connect: ignoring response with unexpected sequence ${sequence}`);
        return;
      }
      if (body[0] !== pending.cmd) {
        this._finish(pending, new Error(`response for command ${body[0]}, expected ${pending.cmd}`));
        return;
      }
      this._finish(pending, null, body.subarray(1));
    } else if (type === P.TYPE.MESSAGE) {
      if (sequence === this.lastMessageSeq) {
        return; // duplicate
      }
      this.lastMessageSeq = sequence;
      this.emit('message', P.decodeMessage(body));
    }
  }

  _armKeepalive() {
    clearTimeout(this.keepaliveTimer);
    this.keepaliveTimer = setTimeout(() => {
      if (this.ready) {
        this.command(P.COMMAND.GET_DATE_TIME).catch((e) => this.log.warn(`Connect: keep-alive failed: ${e.message}`));
      }
    }, KEEPALIVE_MS);
  }

  _teardown(reason) {
    clearTimeout(this.keepaliveTimer);
    const wasReady = this.ready;
    this.ready = false;
    if (this.pending) {
      this._finish(this.pending, new Error(reason));
    }
    this.queue.splice(0).forEach((c) => c.reject(new Error(reason)));
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.on('error', () => {});
      this.socket.destroy();
      this.socket = null;
    }
    if (wasReady) {
      this.emit('disconnected', reason);
    }
  }

  _drop(reason) {
    if (!this.socket) {
      return;
    }
    this.log.warn(`Connect: ${reason}`);
    this._teardown(reason);
    if (!this.stopped && !this.reconnectTimer) {
      const delay = this.reconnectDelay;
      this.reconnectDelay = Math.min(delay * 2, RECONNECT_MAX_MS);
      this.log.info(`Connect: reconnecting in ${delay / 1000}s`);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this._open();
      }, delay);
    }
  }

  // ─── Convenience reads ───────────────────────────────────────────────────

  async panelIdentification() {
    return P.decodePanelIdentification(await this.command(P.COMMAND.GET_PANEL_IDENTIFICATION));
  }

  async zoneDetails(zone) {
    const body = zone > 255 ? Buffer.from([zone & 0xff, zone >> 8]) : Buffer.from([zone]);
    return P.decodeZoneDetails(await this.command(P.COMMAND.GET_ZONE_DETAILS, body));
  }

  async areaDetails(area) {
    return P.decodeAreaDetails(await this.command(P.COMMAND.GET_AREA_DETAILS, Buffer.from([area])));
  }

  async systemPower() {
    return P.decodeSystemPower(await this.command(P.COMMAND.GET_SYSTEM_POWER));
  }

  async dateTime() {
    return P.decodeDateTime(await this.command(P.COMMAND.GET_DATE_TIME));
  }

  async lcdDisplay() {
    return (await this.command(P.COMMAND.GET_LCD_DISPLAY)).toString('latin1');
  }

  /** Current state of zones 1..panelZones (one byte each). */
  async zoneStates(panelZones) {
    const states = {};
    const perRequest = 168;
    for (let start = 1; start <= panelZones; start += perRequest) {
      const count = Math.min(perRequest, panelZones - start + 1);
      const data = await this.command(P.COMMAND.GET_ZONE_STATE, P.encodeGetZoneState(start, count, panelZones));
      for (let i = 0; i < count && i < data.length; i++) {
        states[start + i] = P.decodeZoneStateByte(data[i]);
      }
    }
    return states;
  }

  /** Current state of the given areas: {area: {state, partArm}}. */
  async areaStates(areas, panelZones) {
    const count = P.areaBytes(panelZones) === 8 ? 30 : 72;
    const flags = await this.command(P.COMMAND.GET_AREA_FLAGS, Buffer.from([0, count]));
    return P.decodeAreaFlags(flags, areas, panelZones);
  }

  // ─── Arm / disarm (adapted from texecom2mqtt, MIT) ──────────────────────

  async arm(area, armType, panelZones) {
    const reply = await this.command(P.COMMAND.ARM_AREA, P.encodeArm(area, armType, panelZones));
    return reply[0] === P.ACK;
  }

  async disarm(area, panelZones) {
    const reply = await this.command(P.COMMAND.DISARM_AREA, P.encodeDisarmOrReset(area, panelZones));
    return reply[0] === P.ACK;
  }

  async reset(area, panelZones) {
    const reply = await this.command(P.COMMAND.RESET_AREA, P.encodeDisarmOrReset(area, panelZones));
    return reply[0] === P.ACK;
  }
}

module.exports = { ConnectClient };

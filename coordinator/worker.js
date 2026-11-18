const LEASE_MS = 30_000;
const REQUEST_TTL_MS = 15 * 60_000;
const DEFAULT_HISTORY_RETENTION_DAYS = 30;
const CONTROL_STATE_KEYS = new Set(['approvedUserId', 'lease']);

export class FanControlCoordinator {
  constructor(ctx, env = {}) {
    this.ctx = ctx;
    const retentionDays = Number(env.CONTROL_HISTORY_RETENTION_DAYS);
    this.historyRetentionMs = Number.isInteger(retentionDays) && retentionDays >= 1 && retentionDays <= 3650
      ? retentionDays * 24 * 60 * 60_000
      : DEFAULT_HISTORY_RETENTION_DAYS * 24 * 60 * 60_000;
    this.bridge = ctx.getWebSockets().find((socket) => socket.deserializeAttachment()?.role === 'bridge') || null;
    this.bridgeConnected = Boolean(this.bridge);
    this.telemetry = null;
    this.telemetryAt = 0;
    this.pendingCommands = new Map();
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/bridge') return this.acceptBridge(request);
    if (url.pathname === '/live') return this.acceptAudience(request);
    if (request.method !== 'POST') return Response.json({ error: 'POST required.' }, { status: 405 });
    let body;
    try { body = await request.json(); } catch { return Response.json({ error: 'Invalid JSON.' }, { status: 400 }); }
    const now = Date.now();
    const state = await this.readState();

    if (url.pathname === '/internal/status') {
      const fresh = this.telemetryAt && now - this.telemetryAt < 8_000;
      return Response.json({ online: Boolean(fresh), ...(fresh ? this.telemetry : {}), receivedAt: fresh ? this.telemetryAt : null,
        bridgeConnected: this.bridgeConnected,
        controllerName: state.lease?.fullName || null, occupied: Boolean(state.lease && state.lease.expiresAt > now) });
    }
    if (url.pathname === '/internal/request') {
      const requests = await this.readRequests(now, state);
      const existing = requests.find((item) => item.userId === body.userId && item.status === 'pending' && now - item.at < REQUEST_TTL_MS);
      if (existing) return Response.json(existing);
      const item = { id: crypto.randomUUID(), userId: body.userId, fullName: body.fullName, email: body.email, at: now, status: 'pending' };
      requests.unshift(item);
      await this.ctx.storage.put('requests', requests.slice(0, 100));
      return Response.json(item, { status: 201 });
    }
    if (url.pathname === '/internal/request-status') {
      const requests = await this.readRequests(now, state);
      return Response.json(requests.find((item) => item.userId === body.userId) || { status: 'none' });
    }
    if (url.pathname === '/internal/presenter/requests') {
      if (!request.headers.get('x-presenter-user')) return Response.json({ error: 'Presenter access required.' }, { status: 403 });
      const requests = await this.readRequests(now, state);
      return Response.json({ requests: requests.filter((item) => item.status === 'pending' || item.status === 'approved') });
    }
    if (url.pathname === '/internal/presenter/decision') {
      if (!body.presenterId) return Response.json({ error: 'Presenter access required.' }, { status: 403 });
      const requests = await this.readRequests(now, state);
      const item = requests.find((row) => row.id === body.requestId || row.userId === body.userId);
      if (body.action === 'take-control') {
        this.sendBridgeSignal('lease-ended');
        state.lease = null;
        state.approvedUserId = null;
        if (item?.status === 'approved') item.status = 'revoked';
        await this.ctx.storage.put('requests', requests);
        await this.ctx.storage.put('state', state);
        return Response.json({ ok: true });
      }
      if (!item) return Response.json({ error: 'Control request not found.' }, { status: 404 });
      if (body.action === 'approve') {
        if (state.approvedUserId && state.approvedUserId !== item.userId) return Response.json({ error: 'Another user already has approved control. Revoke it first.' }, { status: 409 });
        requests.forEach((row) => { if (row.status === 'approved' && row.userId !== item.userId) row.status = 'revoked'; });
        item.status = 'approved';
        state.approvedUserId = item.userId;
      } else if (body.action === 'reject') {
        item.status = 'rejected';
      } else if (body.action === 'revoke') {
        item.status = 'revoked';
        if (state.approvedUserId === item.userId) state.approvedUserId = null;
        if (state.lease?.userId === item.userId) {
          this.sendBridgeSignal('lease-ended');
          state.lease = null;
        }
      }
      await this.ctx.storage.put('requests', requests);
      await this.ctx.storage.put('state', state);
      return Response.json({ ok: true, request: item });
    }
    if (url.pathname === '/internal/claim') {
      if (!body.isPresenter && state.approvedUserId !== body.userId) return Response.json({ error: 'Presenter approval is required.' }, { status: 403 });
      if (!body.isPresenter && state.lease && state.lease.expiresAt > now && state.lease.userId !== body.userId) return Response.json({ error: 'Another user currently controls the fan.' }, { status: 423 });
      const leaseToken = state.lease?.userId === body.userId ? state.lease.token : crypto.randomUUID() + crypto.randomUUID();
      state.lease = { userId: body.userId, fullName: body.fullName, token: leaseToken, expiresAt: now + LEASE_MS };
      await this.ctx.storage.put('state', state);
      await this.ctx.storage.setAlarm(now + LEASE_MS);
      this.sendBridgeSignal('lease-active');
      return Response.json({ ok: true, leaseToken, expiresInMs: LEASE_MS });
    }
    if (url.pathname === '/internal/heartbeat') {
      if (!state.lease || state.lease.userId !== body.userId || state.lease.token !== body.leaseToken || state.lease.expiresAt <= now) {
        return Response.json({ error: 'Control permission has expired.' }, { status: 403 });
      }
      state.lease.expiresAt = now + LEASE_MS;
      await this.ctx.storage.put('state', state);
      await this.ctx.storage.setAlarm(now + LEASE_MS);
      this.sendBridgeSignal('lease-active');
      return Response.json({ ok: true, expiresInMs: LEASE_MS });
    }
    if (url.pathname === '/internal/command') {
      const isPresenter = Boolean(body.isPresenter && body.userId);
      const isLeaseOwner = Boolean(state.lease && state.lease.userId === body.userId && state.lease.token === body.leaseToken && state.lease.expiresAt > now);
      if (!isPresenter && !isLeaseOwner) return Response.json({ error: 'You are not authorized to control the fan.' }, { status: 403 });
      if (!this.bridge || !this.bridgeConnected) return Response.json({ error: 'The hardware bridge is offline.' }, { status: 503 });
      const commandId = crypto.randomUUID();
      try { return Response.json(await this.sendBridgeCommand(commandId, body.command)); }
      catch { return Response.json({ error: 'The hardware bridge did not confirm the command.' }, { status: 504 }); }
    }
    if (url.pathname === '/internal/release-user') {
      if (state.lease?.userId === body.userId) {
        this.sendBridgeSignal('lease-ended');
        state.lease = null;
      }
      if (state.approvedUserId === body.userId) {
        state.approvedUserId = null;
        const requests = await this.ctx.storage.get('requests') || [];
        requests.forEach((item) => { if (item.userId === body.userId && item.status === 'approved') item.status = 'revoked'; });
        await this.ctx.storage.put('requests', requests);
      }
      await this.ctx.storage.put('state', state);
      return Response.json({ ok: true });
    }
    if (url.pathname === '/internal/bridge-release') {
      if (this.bridge?.deserializeAttachment()?.userId === body.userId) {
        const bridge = this.bridge;
        this.bridge = null;
        this.bridgeConnected = false;
        this.clearTelemetry();
        for (const [id, pending] of this.pendingCommands) {
          clearTimeout(pending.timer);
          pending.reject(new Error('Presenter logged out.'));
          this.pendingCommands.delete(id);
        }
        bridge.close(1000, 'Presenter logged out.');
      }
      return Response.json({ ok: true });
    }
    if (url.pathname === '/internal/presenter/reset') {
      if (!body.presenterId) return Response.json({ error: 'Presenter access required.' }, { status: 403 });
      this.sendBridgeSignal('lease-ended');
      state.lease = null;
      state.approvedUserId = null;
      this.clearTelemetry();
      await this.ctx.storage.put('requests', []);
      await this.ctx.storage.put('state', state);
      return Response.json({ ok: true, message: 'Temporary control state cleared; user accounts were retained.' });
    }
    return Response.json({ error: 'Unknown coordinator operation.' }, { status: 404 });
  }

  async readState() {
    const stored = await this.ctx.storage.get('state');
    if (!stored) return { approvedUserId: null, lease: null };
    const state = {
      approvedUserId: stored.approvedUserId ?? null,
      lease: stored.lease ?? null,
    };
    if (Object.keys(stored).some((key) => !CONTROL_STATE_KEYS.has(key))) {
      await this.ctx.storage.put('state', state);
    }
    return state;
  }

  async readRequests(now, state) {
    const requests = await this.ctx.storage.get('requests') || [];
    const retentionCutoff = now - this.historyRetentionMs;
    let changed = false;
    const retained = requests.filter((item) => {
      if (item.status === 'pending' && now - item.at >= REQUEST_TTL_MS) {
        item.status = 'expired';
        changed = true;
      }
      const keepActiveApproval = item.status === 'approved' && item.userId === state.approvedUserId;
      if (item.at < retentionCutoff && !keepActiveApproval) {
        changed = true;
        return false;
      }
      return true;
    });
    if (changed) await this.ctx.storage.put('requests', retained);
    return retained;
  }

  async acceptBridge(request) {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('WebSocket required.', { status: 426 });
    if (this.bridge) this.bridge.close(1012, 'A new presenter bridge connected.');
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ role: 'bridge', userId: new URL(request.url).searchParams.get('presenterUserId') });
    this.bridge = server;
    const state = await this.readState();
    this.bridgeConnected = true;
    if (state.lease && state.lease.expiresAt <= Date.now()) {
      const expiredUserId = state.lease.userId;
      state.lease = null;
      if (state.approvedUserId === expiredUserId) {
        const requests = await this.ctx.storage.get('requests') || [];
        requests.forEach((item) => { if (item.userId === expiredUserId && item.status === 'approved') item.status = 'expired'; });
        state.approvedUserId = null;
        await this.ctx.storage.put('requests', requests);
      }
    }
    if (state.lease === null) await this.ctx.storage.put('state', state);
    server.send(JSON.stringify({ type: 'bridge-ready' }));
    if (state.lease) server.send(JSON.stringify({ type: 'lease-active' }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async acceptAudience(request) {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('WebSocket required.', { status: 426 });
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ role: 'audience' });
    const fresh = this.telemetryAt && Date.now() - this.telemetryAt < 8_000;
    if (fresh) server.send(JSON.stringify({ type: 'telemetry', data: this.telemetry }));
    else server.send(JSON.stringify({ type: 'telemetry', online: false }));
    return new Response(null, { status: 101, webSocket: client });
  }

  broadcastTelemetry() {
    const message = JSON.stringify({ type: 'telemetry', data: this.telemetry });
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.deserializeAttachment()?.role !== 'audience') continue;
      try {
        socket.send(message);
      } catch (error) {
        console.error('Could not send live telemetry to an audience connection:', error);
      }
    }
  }

  clearTelemetry() {
    this.telemetry = null;
    this.telemetryAt = 0;
    this.broadcastOffline();
  }

  broadcastOffline() {
    const message = JSON.stringify({ type: 'telemetry', online: false });
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.deserializeAttachment()?.role !== 'audience') continue;
      try {
        socket.send(message);
      } catch (error) {
        console.error('Could not send offline status to an audience connection:', error);
      }
    }
  }

  sendBridgeSignal(type) {
    if (!this.bridge) return;
    try {
      this.bridge.send(JSON.stringify({ type }));
    } catch (error) {
      console.error(`Could not send ${type} to the BLE bridge:`, error);
    }
  }

  sendBridgeCommand(id, command) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pendingCommands.delete(id); reject(new Error('timeout')); }, 8_000);
      this.pendingCommands.set(id, { resolve, reject, timer });
      try { this.bridge.send(JSON.stringify({ type: 'command', id, command })); }
      catch (error) { clearTimeout(timer); this.pendingCommands.delete(id); reject(error); }
    });
  }

  async webSocketMessage(socket, message) {
    const role = socket.deserializeAttachment()?.role;
    let data;
    try { data = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message)); } catch { return; }
    if (role === 'audience') {
      if (data.type === 'audience-ping') {
        socket.send(JSON.stringify({ type: 'audience-pong', at: Date.now() }));
        if (!this.telemetryAt || Date.now() - this.telemetryAt >= 8_000) {
          socket.send(JSON.stringify({ type: 'telemetry', online: false }));
        }
      }
      return;
    }
    if (role !== 'bridge') return;
    if (data.type === 'command-result') {
      const pending = this.pendingCommands.get(data.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingCommands.delete(data.id);
        if (data.ok) pending.resolve(data.result || { ok: true }); else pending.reject(new Error(data.error || 'command failed'));
      }
    } else if (data.type === 'telemetry' && data.data && Number.isFinite(Number(data.data.temperatureC))) {
      const fanSpeed = Number(data.data.fanSpeed ?? data.data.speed);
      if (!Number.isFinite(fanSpeed)) return;
      this.telemetry = { temperatureC: Number(data.data.temperatureC), fanSpeed: Math.max(0, Math.min(100, Math.round(fanSpeed))),
        mode: data.data.mode === 'manual' ? 'manual' : 'auto', fanOff: Boolean(data.data.fanOff) };
      this.telemetryAt = Date.now();
      this.bridgeConnected = true;
      this.broadcastTelemetry();
    } else if (data.type === 'bridge-ping') socket.send(JSON.stringify({ type: 'bridge-pong', at: Date.now() }));
  }

  async webSocketClose(socket) {
    if (socket.deserializeAttachment()?.role !== 'bridge') return;
    if (this.bridge !== socket) return;
    this.bridge = null;
    this.bridgeConnected = false;
    this.clearTelemetry();
    for (const [id, pending] of this.pendingCommands) {
      clearTimeout(pending.timer); pending.reject(new Error('bridge disconnected')); this.pendingCommands.delete(id);
    }
  }

  async webSocketError(socket) { await this.webSocketClose(socket); }

  async alarm() {
    const state = await this.readState();
    if (state.lease && state.lease.expiresAt <= Date.now()) {
      const userId = state.lease.userId;
      this.sendBridgeSignal('lease-ended');
      state.lease = null;
      if (state.approvedUserId === userId) {
        state.approvedUserId = null;
        const requests = await this.ctx.storage.get('requests') || [];
        requests.forEach((item) => { if (item.userId === userId && item.status === 'approved') item.status = 'expired'; });
        await this.ctx.storage.put('requests', requests);
      }
      await this.ctx.storage.put('state', state);
    }
  }
}

export default { async fetch() { return new Response('Not found.', { status: 404 }); } };

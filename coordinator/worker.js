const LEASE_MS = 30_000;
const REQUEST_TTL_MS = 15 * 60_000;
const DEFAULT_HISTORY_RETENTION_DAYS = 30;

function tokenMatches(expected, provided) {
  if (!expected || !provided || expected.length !== provided.length) return false;
  let difference = 0;
  for (let i = 0; i < expected.length; i += 1) {
    difference |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  return difference === 0;
}
export class FanControlCoordinator {
  constructor(ctx, env = {}) {
    this.presenterUserId = env.PRESENTER_USER_ID || '';
    this.internalToken = env.COORDINATOR_INTERNAL_TOKEN || '';
    this.ready = ctx.blockConcurrencyWhile(async () => {
      await ctx.storage.delete('state');
      await ctx.storage.delete('requests');
    });
    const retentionDays = Number(env.CONTROL_HISTORY_RETENTION_DAYS);
    this.historyRetentionMs = Number.isInteger(retentionDays) && retentionDays >= 1 && retentionDays <= 3650
      ? retentionDays * 24 * 60 * 60_000
      : DEFAULT_HISTORY_RETENTION_DAYS * 24 * 60 * 60_000;
    this.bridge = null;
    this.bridgeConnected = false;
    this.webSockets = new Set();
    this.socketMetadata = new WeakMap();
    this.requests = [];
    this.approvedUserId = null;
    this.lease = null;
    this.telemetry = null;
    this.telemetryAt = 0;
    this.pendingCommands = new Map();
  }

  async fetch(request) {
    await this.ready;
    if (!tokenMatches(this.internalToken, request.headers.get('x-coordinator-token') || '')) {
      return Response.json({ error: 'Unauthorized coordinator request.' }, { status: 403 });
    }
    const url = new URL(request.url);
    if (url.pathname === '/bridge') return this.acceptBridge(request);
    if (url.pathname === '/live') return this.acceptAudience(request);
    if (request.method !== 'POST') return Response.json({ error: 'POST required.' }, { status: 405 });
    let body;
    try { body = await request.json(); } catch { return Response.json({ error: 'Invalid JSON.' }, { status: 400 }); }
    const now = Date.now();
    this.expireLease(now);
    this.pruneRequests(now);
    this.reconcileControlState();

    if (url.pathname === '/internal/status') {
      const fresh = this.telemetryAt && now - this.telemetryAt < 8_000;
      return Response.json({ online: Boolean(fresh), ...(fresh ? this.telemetry : {}), receivedAt: fresh ? this.telemetryAt : null,
        bridgeConnected: this.bridgeConnected,
        controllerName: this.lease?.fullName || null, occupied: Boolean(this.lease && this.lease.expiresAt > now) });
    }
    if (url.pathname === '/internal/request') {
      const existing = this.requests.find((item) => item.userId === body.userId && item.status === 'pending' && now - item.at < REQUEST_TTL_MS);
      if (existing) return Response.json(existing);
      const item = { id: crypto.randomUUID(), userId: body.userId, fullName: body.fullName, email: body.email, at: now, status: 'pending' };
      this.requests.unshift(item);
      this.requests = this.requests.slice(0, 100);
      return Response.json(item, { status: 201 });
    }
    if (url.pathname === '/internal/request-status') {
      const item = this.requests.find((requestItem) => requestItem.userId === body.userId);
      if (!item) return Response.json({ status: 'none' });
      const lease = item.status === 'approved' && this.approvedUserId === body.userId
        && this.lease?.userId === body.userId && !this.lease.isPresenter && this.lease.expiresAt > now
        ? { leaseToken: this.lease.token, leaseExpiresAt: this.lease.expiresAt }
        : {};
      return Response.json({ ...item, ...lease });
    }
    if (url.pathname === '/internal/presenter/requests') {
      if (!this.presenterUserId || request.headers.get('x-presenter-user') !== this.presenterUserId) {
        return Response.json({ error: 'Presenter access required.' }, { status: 403 });
      }
      return Response.json({ requests: this.requests.filter((item) => item.status === 'pending' || item.status === 'approved') });
    }
    if (url.pathname === '/internal/presenter/decision') {
      if (!this.presenterUserId || body.presenterId !== this.presenterUserId) {
        return Response.json({ error: 'Presenter access required.' }, { status: 403 });
      }
      const item = this.requests.find((row) => row.id === body.requestId || row.userId === body.userId);
      if (body.action === 'take-control') {
        this.sendBridgeSignal('lease-ended');
        this.lease = null;
        this.approvedUserId = null;
        this.requests.forEach((row) => { if (row.status === 'approved') row.status = 'revoked'; });
        this.rejectPendingCommands('Control permission revoked by the presenter.');
        return Response.json({ ok: true });
      }
      if (!item) return Response.json({ error: 'Control request not found.' }, { status: 404 });
      if (body.action === 'approve') {
        const activeLease = this.lease && this.lease.expiresAt > now ? this.lease : null;
        if (item.status === 'approved' && this.approvedUserId === item.userId && activeLease?.userId === item.userId && !activeLease.isPresenter) {
          return Response.json({ ok: true, request: item, expiresInMs: activeLease.expiresAt - now });
        }
        if (activeLease || (this.approvedUserId && this.approvedUserId !== item.userId)) {
          return Response.json({ error: 'Another user currently holds control. Revoke it or wait for the lease to expire.' }, { status: 409 });
        }
        if (item.status !== 'pending' && item.status !== 'rejected') {
          return Response.json({ error: 'This request can no longer be approved.' }, { status: 409 });
        }
        this.requests.forEach((row) => { if (row.status === 'approved' && row.userId !== item.userId) row.status = 'revoked'; });
        item.status = 'approved';
        this.approvedUserId = item.userId;
        this.lease = {
          userId: item.userId,
          fullName: item.fullName,
          token: crypto.randomUUID() + crypto.randomUUID(),
          expiresAt: now + LEASE_MS,
          isPresenter: false,
        };
        this.sendBridgeSignal('lease-active');
        return Response.json({ ok: true, request: item, expiresInMs: LEASE_MS });
      } else if (body.action === 'reject') {
        item.status = 'rejected';
      } else if (body.action === 'revoke') {
        item.status = 'revoked';
        if (this.approvedUserId === item.userId) this.approvedUserId = null;
        if (this.lease?.userId === item.userId) {
          this.sendBridgeSignal('lease-ended');
          this.lease = null;
          this.rejectPendingCommands('Control permission revoked by the presenter.');
        }
      }
      return Response.json({ ok: true, request: item });
    }
    if (url.pathname === '/internal/claim') {
      const isPresenter = Boolean(this.presenterUserId && body.userId === this.presenterUserId);
      if (!isPresenter && (this.approvedUserId !== body.userId || !this.hasApprovedRequest(body.userId))) {
        return Response.json({ error: 'Presenter approval is required.' }, { status: 403 });
      }
      if (!isPresenter && this.lease && this.lease.userId !== body.userId) return Response.json({ error: 'Another user currently controls the fan.' }, { status: 423 });
      if (!isPresenter) {
        if (!this.lease || this.lease.userId !== body.userId || this.lease.isPresenter) {
          return Response.json({ error: 'The approved control lease is no longer active.' }, { status: 409 });
        }
        return Response.json({
          ok: true,
          leaseToken: this.lease.token,
          expiresInMs: this.lease.expiresAt - now,
        });
      }
      if (isPresenter) {
        if (this.lease && this.lease.userId !== body.userId) {
          this.sendBridgeSignal('lease-ended');
          this.rejectPendingCommands('Presenter took control.');
        }
        this.requests.forEach((row) => { if (row.status === 'approved') row.status = 'revoked'; });
        this.approvedUserId = null;
      }
      const leaseToken = this.lease?.userId === body.userId ? this.lease.token : crypto.randomUUID() + crypto.randomUUID();
      this.lease = { userId: body.userId, fullName: body.fullName, token: leaseToken, expiresAt: now + LEASE_MS, isPresenter };
      this.sendBridgeSignal('lease-active');
      return Response.json({ ok: true, leaseToken, expiresInMs: LEASE_MS });
    }
    if (url.pathname === '/internal/heartbeat') {
      if (!this.lease || this.lease.userId !== body.userId || this.lease.token !== body.leaseToken || this.lease.expiresAt <= now
        || (!this.lease.isPresenter && (this.approvedUserId !== body.userId || !this.hasApprovedRequest(body.userId)))) {
        return Response.json({ error: 'Control permission has expired.' }, { status: 403 });
      }
      this.lease.expiresAt = now + LEASE_MS;
      this.sendBridgeSignal('lease-active');
      return Response.json({ ok: true, expiresInMs: LEASE_MS });
    }
    if (url.pathname === '/internal/command') {
      const isPresenter = Boolean(this.presenterUserId && body.userId === this.presenterUserId);
      const isLeaseOwner = Boolean(this.lease && !this.lease.isPresenter && this.lease.userId === body.userId
        && this.lease.token === body.leaseToken && this.lease.expiresAt > now
        && this.approvedUserId === body.userId && this.hasApprovedRequest(body.userId));
      if (!isPresenter && !isLeaseOwner) return Response.json({ error: 'You are not authorized to control the fan.' }, { status: 403 });
      if (!this.bridge || !this.bridgeConnected) return Response.json({ error: 'The hardware bridge is offline.' }, { status: 503 });
      const commandId = crypto.randomUUID();
      try { return Response.json(await this.sendBridgeCommand(commandId, body.command)); }
      catch { return Response.json({ error: 'The hardware bridge did not confirm the command.' }, { status: 504 }); }
    }
    if (url.pathname === '/internal/release-user') {
      if (this.lease?.userId === body.userId) {
        this.sendBridgeSignal('lease-ended');
        this.lease = null;
        this.rejectPendingCommands('Control owner logged out.');
      }
      if (this.approvedUserId === body.userId) {
        this.approvedUserId = null;
        this.requests.forEach((item) => { if (item.userId === body.userId && item.status === 'approved') item.status = 'revoked'; });
      }
      return Response.json({ ok: true });
    }
    if (url.pathname === '/internal/bridge-release') {
      if (this.presenterUserId && body.userId === this.presenterUserId
        && this.bridge && this.socketMetadata.get(this.bridge)?.userId === this.presenterUserId) {
        const bridge = this.bridge;
        this.sendBridgeSignal('lease-ended');
        this.bridge = null;
        this.bridgeConnected = false;
        this.lease = null;
        this.approvedUserId = null;
        this.requests.forEach((item) => { if (item.status === 'approved') item.status = 'revoked'; });
        this.clearTelemetry();
        this.rejectPendingCommands('Presenter logged out.');
        bridge.close(1000, 'Presenter logged out.');
      }
      return Response.json({ ok: true });
    }
    if (url.pathname === '/internal/presenter/reset') {
      if (!this.presenterUserId || body.presenterId !== this.presenterUserId) {
        return Response.json({ error: 'Presenter access required.' }, { status: 403 });
      }
      this.sendBridgeSignal('lease-ended');
      this.lease = null;
      this.approvedUserId = null;
      this.clearTelemetry();
      this.requests = [];
      this.rejectPendingCommands('Temporary seminar state was reset.');
      return Response.json({ ok: true, message: 'Temporary control state cleared; user accounts were retained.' });
    }
    return Response.json({ error: 'Unknown coordinator operation.' }, { status: 404 });
  }

  pruneRequests(now) {
    const retentionCutoff = now - this.historyRetentionMs;
    this.requests = this.requests.filter((item) => {
      if (item.status === 'pending' && now - item.at >= REQUEST_TTL_MS) item.status = 'expired';
      const keepActiveApproval = item.status === 'approved' && item.userId === this.approvedUserId;
      return item.at >= retentionCutoff || keepActiveApproval;
    });
  }

  hasApprovedRequest(userId) {
    return this.requests.some((item) => item.userId === userId && item.status === 'approved');
  }

  reconcileControlState() {
    if (this.approvedUserId && !this.hasApprovedRequest(this.approvedUserId)) this.approvedUserId = null;
    if (!this.lease) return;
    const leaseIsValid = this.lease.userId && this.lease.token && Number.isFinite(this.lease.expiresAt);
    if (!leaseIsValid || (!this.lease.isPresenter
      && (this.approvedUserId !== this.lease.userId || !this.hasApprovedRequest(this.lease.userId)))) {
      this.lease = null;
      this.approvedUserId = null;
      this.requests.forEach((item) => { if (item.status === 'approved') item.status = 'expired'; });
      this.sendBridgeSignal('lease-ended');
      this.rejectPendingCommands('Control state is missing or invalid.');
    }
  }

  expireLease(now) {
    if (!this.lease) return;
    if (!this.lease.userId || !this.lease.token || !Number.isFinite(this.lease.expiresAt)) {
      this.lease = null;
      this.approvedUserId = null;
      this.requests.forEach((item) => { if (item.status === 'approved') item.status = 'expired'; });
      this.sendBridgeSignal('lease-ended');
      this.rejectPendingCommands('Control state is invalid.');
      return;
    }
    if (this.lease.expiresAt > now) return;
    const userId = this.lease.userId;
    this.lease = null;
    if (this.approvedUserId === userId) this.approvedUserId = null;
    this.requests.forEach((item) => { if (item.userId === userId && item.status === 'approved') item.status = 'expired'; });
    this.sendBridgeSignal('lease-ended');
    this.rejectPendingCommands('Control lease expired.');
  }

  attachWebSocket(socket, metadata) {
    socket.accept();
    this.webSockets.add(socket);
    this.socketMetadata.set(socket, metadata);
    socket.addEventListener('message', (event) => {
      this.webSocketMessage(socket, event.data).catch((error) => {
        console.error('Could not process a coordinator WebSocket message:', error);
      });
    });
    socket.addEventListener('close', () => {
      this.webSocketClose(socket).catch((error) => {
        console.error('Could not process a coordinator WebSocket close:', error);
      });
    });
    socket.addEventListener('error', () => {
      this.webSocketError(socket).catch((error) => {
        console.error('Could not process a coordinator WebSocket error:', error);
      });
    });
  }

  async acceptBridge(request) {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('WebSocket required.', { status: 426 });
    const presenterUserId = new URL(request.url).searchParams.get('presenterUserId');
    if (!this.presenterUserId || presenterUserId !== this.presenterUserId) {
      return new Response('Presenter authentication required.', { status: 403 });
    }
    if (this.bridge) {
      this.sendBridgeSignal('lease-ended');
      this.bridge.close(1012, 'A new presenter bridge connected.');
      this.bridge = null;
      this.bridgeConnected = false;
      this.lease = null;
      this.approvedUserId = null;
      this.requests.forEach((item) => { if (item.status === 'approved') item.status = 'revoked'; });
      this.rejectPendingCommands('Bridge connection replaced.');
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.attachWebSocket(server, { role: 'bridge', userId: presenterUserId });
    this.bridge = server;
    this.bridgeConnected = true;
    this.clearTelemetry();
    server.send(JSON.stringify({ type: 'bridge-ready' }));
    server.send(JSON.stringify({ type: 'lease-ended' }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async acceptAudience(request) {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('WebSocket required.', { status: 426 });
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.attachWebSocket(server, { role: 'audience' });
    const fresh = this.telemetryAt && Date.now() - this.telemetryAt < 8_000;
    if (fresh) server.send(JSON.stringify({ type: 'telemetry', data: this.telemetry }));
    else server.send(JSON.stringify({ type: 'telemetry', online: false }));
    return new Response(null, { status: 101, webSocket: client });
  }

  broadcastTelemetry() {
    const message = JSON.stringify({ type: 'telemetry', data: this.telemetry });
    for (const socket of this.webSockets) {
      if (this.socketMetadata.get(socket)?.role !== 'audience') continue;
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
    for (const socket of this.webSockets) {
      if (this.socketMetadata.get(socket)?.role !== 'audience') continue;
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

  rejectPendingCommands(reason) {
    for (const [id, pending] of this.pendingCommands) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
      this.pendingCommands.delete(id);
    }
  }

  async webSocketMessage(socket, message) {
    const role = this.socketMetadata.get(socket)?.role;
    if (!role) return;
    this.expireLease(Date.now());
    this.pruneRequests(Date.now());
    this.reconcileControlState();
    if (role === 'bridge' && this.bridge !== socket) return;
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
    const role = this.socketMetadata.get(socket)?.role;
    this.webSockets.delete(socket);
    this.socketMetadata.delete(socket);
    if (role !== 'bridge' || this.bridge !== socket) return;
    this.bridge = null;
    this.bridgeConnected = false;
    this.lease = null;
    this.approvedUserId = null;
    this.requests.forEach((item) => { if (item.status === 'approved') item.status = 'revoked'; });
    this.clearTelemetry();
    this.rejectPendingCommands('Bridge disconnected.');
  }

  async webSocketError(socket) { await this.webSocketClose(socket); }
}

export default { async fetch() { return new Response('Not found.', { status: 404 }); } };

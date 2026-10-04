/* apps.js — the simulated container registry. Every image has a behavioural profile:
   how long it takes to start, which port it listens on, which health endpoints exist,
   how much memory it uses over time, what it depends on and what it needs from the API.
   The engine never special-cases an app by name; incidents emerge from these profiles. */
(function (K) {
  'use strict';

  const json = o => JSON.stringify(o);
  const stamp = ctx => ctx.c.ts(ctx.c.now);
  const goStamp = ctx => { const d = new Date(Date.parse(stamp(ctx))); const p = n => String(n).padStart(2, '0'); return `${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.004`; };

  /* A request a service makes to one of its dependencies, read from an env var holding a URL. */
  function depCheck(ctx, envName, label) {
    const url = ctx.env[envName];
    if (!url) return null;
    const r = ctx.c.request(ctx.src, url.replace(/\/$/, '') + '/v1/status', ctx.depth + 1);
    if (r.ok && r.status < 400) return null;
    return { label, url, err: r.ok ? `upstream ${label} returned HTTP ${r.status}` : ctx.c.goErr(r, 'GET', url.replace(/\/$/, '') + '/v1/status') };
  }
  function tcpCheck(ctx, envName, port, label) {
    const host = ctx.env[envName];
    if (!host) return null;
    const r = ctx.c.request(ctx.src, `tcp://${host}:${port}`, ctx.depth + 1);
    return r.ok ? null : { label, err: ctx.c.goErr(r, null, `${host}:${port}`) };
  }
  function logOnce(ctx, line) { ctx.c.appLog(ctx.pod, line); }

  /* ---------- generic stagedoor service ---------- */
  function service(o) {
    return Object.assign({
      kind: 'http', port: 8080, startup: 3, health: ['/healthz'], mem: () => o.memFlat || 96, cpuBase: 3, cpuPerReq: 1.6,
      requiredEnv: [],
      startLogs(ctx) { return [`${stamp(ctx)} INFO  ${o.app} ${ctx.tag} starting (go1.23.4)`, `${stamp(ctx)} INFO  loading configuration from environment`]; },
      readyLogs(ctx) { return [`${stamp(ctx)} INFO  listening on :${this.port}`]; },
      deps: () => [],
      respond(ctx, path) {
        if (this.health.includes(path)) return { status: 200, body: 'ok' };
        if (/^\/(healthz|readyz|livez|health|ready|ping)$/.test(path)) return { status: 404, body: json({ error: 'not found', path }) };
        const failed = this.deps(ctx).filter(Boolean);
        if (failed.length) {
          const f = failed[0];
          logOnce(ctx, `${stamp(ctx)} ERROR request failed: ${f.label}: ${f.err}`);
          return { status: 502, body: json({ error: `${f.label} unavailable`, detail: f.err }) };
        }
        return { status: 200, body: o.body ? o.body(ctx, path) : json({ service: o.app, version: ctx.tag, pod: ctx.pod.name, status: 'ok' }) };
      },
    }, o.extra || {});
  }

  const IMAGES = {
    /* ---------------- Stagedoor services ---------------- */
    'stagedoor/storefront': {
      tags: ['5.3', '5.4'],
      profile: tag => service({
        app: 'storefront',
        extra: {
          startup: 8, mem: () => 88,
          health: tag === '5.4' ? ['/livez', '/readyz'] : ['/healthz'],
          deps(ctx) { return [depCheck(ctx, 'CHECKOUT_URL', 'checkout')]; },
          readyLogs(ctx) { return [`${stamp(ctx)} INFO  storefront ${tag} ready, health endpoints: ${this.health.join(' ')}`, `${stamp(ctx)} INFO  listening on :8080`]; },
        },
        body: ctx => `<!doctype html><title>Stagedoor</title><h1>Stagedoor: tickets for tonight</h1><p>storefront ${ctx.tag} · served by ${ctx.pod.name}</p>`,
      }),
    },
    'stagedoor/checkout': {
      tags: ['3.1', '3.2'],
      profile: () => service({
        app: 'checkout',
        extra: {
          requiredEnv: ['PAYMENTS_URL', 'INVENTORY_URL'], mem: () => 112, cpuPerReq: 2.4,
          deps(ctx) { return [depCheck(ctx, 'PAYMENTS_URL', 'payments'), depCheck(ctx, 'INVENTORY_URL', 'inventory')]; },
        },
      }),
    },
    'stagedoor/payments': { tags: ['2.7', '2.8'], profile: tag => paymentsProfile(tag) },
    'registry.stagedoor.io/payments': { tags: ['2.7', '2.8'], private: true, profile: tag => paymentsProfile(tag) },
    'stagedoor/inventory': {
      tags: ['4.0', '4.1'],
      profile: tag => service({
        app: 'inventory',
        extra: {
          mem: ctx => (tag === '4.1' ? Math.min(392, 120 + ctx.uptime * 6) : 140),
          startLogs(ctx) {
            return [`${stamp(ctx)} INFO  inventory ${tag} starting (go1.23.4)`].concat(tag === '4.1' ? [`${stamp(ctx)} INFO  warming seat-map cache for 312 venues (expected ~380MiB)`] : []);
          },
          deps(ctx) { return [tcpCheck(ctx, 'DB_HOST', 5432, 'seats-db')]; },
        },
      }),
    },
    'stagedoor/search': { tags: ['1.0'], profile: () => service({ app: 'search', extra: { mem: () => 150 } }) },
    'stagedoor/pricing': {
      tags: ['6.0'],
      profile: () => service({
        app: 'pricing',
        extra: {
          startup: 45, mem: ctx => Math.min(310, 180 + ctx.uptime * 3),
          startLogs(ctx) {
            return [
              '  .   ____          _            __ _ _',
              ' /\\\\ / ___\'_ __ _ _(_)_ __  __ _ \\ \\ \\ \\',
              `${stamp(ctx)}  INFO 1 --- [main] c.s.pricing.PricingApplication : Starting PricingApplication v6.0 using Java 21.0.4`,
              `${stamp(ctx)}  INFO 1 --- [main] c.s.pricing.PricingApplication : No active profile set, falling back to 1 default profile: "default"`,
              `${stamp(ctx)}  INFO 1 --- [main] o.s.b.w.embedded.tomcat.TomcatWebServer : Tomcat initialized with port 8080 (http)`,
              `${stamp(ctx)}  INFO 1 --- [main] c.s.pricing.cache.FareCache : loading 1.8M fare rules from snapshot...`,
            ];
          },
          readyLogs(ctx) { return [`${stamp(ctx)}  INFO 1 --- [main] c.s.pricing.cache.FareCache : loaded 1,812,404 fare rules`, `${stamp(ctx)}  INFO 1 --- [main] c.s.pricing.PricingApplication : Started PricingApplication in 44.6 seconds (process running for 45.1)`]; },
          killLogs(ctx) { return [`${stamp(ctx)}  INFO 1 --- [ionShutdownHook] o.s.b.w.e.tomcat.GracefulShutdown : Commencing graceful shutdown. Waiting for active requests to complete`]; },
        },
      }),
    },
    'stagedoor/flag-sync': {
      tags: ['1.4'],
      profile: () => service({
        app: 'flag-sync',
        extra: {
          port: 8081, mem: () => 40, api: [['list', 'configmaps', ''], ['watch', 'configmaps', '']],
          startLogs(ctx) { return [`I${goStamp(ctx)}       1 main.go:41] flag-sync 1.4 starting, watching ConfigMaps labelled stagedoor.io/flags=true`]; },
          readyLogs(ctx) { return [`I${goStamp(ctx)}       1 shared_informer.go:320] Caches are synced for configmaps`, `I${goStamp(ctx)}       1 main.go:77] synced 14 feature flags, serving on :8081`]; },
        },
      }),
    },
    'stagedoor/report-export': {
      tags: ['0.9'],
      profile: () => ({
        kind: 'worker', port: null, startup: 2, cpuBase: 140,
        mem: ctx => Math.min(3400, 160 + ctx.uptime * 27),
        startLogs(ctx) { return [`${stamp(ctx)} INFO  report-export 0.9: exporting sales ledger for all events since 2019`]; },
        readyLogs(ctx) { return [`${stamp(ctx)} INFO  streaming 41,233,902 orders into memory before writing CSV`]; },
      }),
    },
    'stagedoor/loadtest': {
      tags: ['1.0'],
      profile: () => ({ kind: 'worker', port: null, startup: 1, cpuBase: 20, mem: () => 220,
        startLogs(ctx) { return [`${stamp(ctx)} k6 v0.53: scenario "onsale-rehearsal" finished 9 days ago, idling`]; } }),
    },

    /* ---------------- public images ---------------- */
    'nginx': { tags: ['latest', 'stable', 'alpine', '1.27', '1.28', '1.29'], profile: () => ({ kind: 'http', port: 80, startup: 1, health: ['/'], mem: () => 12, cpuBase: 1, cpuPerReq: 0.3,
      startLogs: () => ['/docker-entrypoint.sh: Configuration complete; ready for start up'], respond: () => ({ status: 200, body: '<!DOCTYPE html>\n<html><head><title>Welcome to nginx!</title></head><body><h1>Welcome to nginx!</h1></body></html>' }) }) },
    'postgres': { tags: ['latest', '15', '16', '17'], profile: tag => ({
      kind: 'tcp', port: 5432, startup: 3, mem: () => 84, cpuBase: 6, requiredEnv: ['POSTGRES_PASSWORD'],
      disk: { mount: '/var/lib/postgresql/data', growMi: 2 },
      startLogs(ctx) { return ['PostgreSQL Database directory appears to contain a database; Skipping initialization', '', `${stamp(ctx)} UTC [1] LOG:  starting PostgreSQL ${tag === 'latest' ? '17' : tag}.4 on x86_64-pc-linux-gnu, compiled by gcc (Debian 12.2.0-14) 12.2.0, 64-bit`]; },
      readyLogs(ctx) { return [`${stamp(ctx)} UTC [1] LOG:  listening on IPv4 address "0.0.0.0", port 5432`, `${stamp(ctx)} UTC [1] LOG:  database system is ready to accept connections`]; },
      missingEnvLogs: () => ['Error: Database is uninitialized and superuser password is not specified.', '       You must specify POSTGRES_PASSWORD to a non-empty value for the', '       superuser. For example, "-e POSTGRES_PASSWORD=password" on "docker run".'],
      diskFullLogs(ctx) {
        const t = stamp(ctx) + ' UTC';
        return ['PostgreSQL Database directory appears to contain a database; Skipping initialization', '',
          `${t} [1] LOG:  starting PostgreSQL ${tag === 'latest' ? '17' : tag}.4 on x86_64-pc-linux-gnu`,
          `${t} [27] LOG:  database system was interrupted; last known up at ${t}`,
          `${t} [27] LOG:  redo starts at 3/9A1F2C8`,
          `${t} [27] FATAL:  could not write to file "pg_wal/xlogtemp.27": No space left on device`,
          `${t} [1] LOG:  startup process (PID 27) exited with exit code 1`,
          `${t} [1] LOG:  aborting startup due to startup process failure`,
          `${t} [1] LOG:  database system is shut down`];
      },
    }) },
    'redis': { tags: ['latest', '7', '7.4'], profile: () => ({ kind: 'tcp', port: 6379, startup: 1, mem: () => 9, cpuBase: 2, startLogs: () => ['1:M * Server initialized'], readyLogs: () => ['1:M * Ready to accept connections tcp'] }) },
    'busybox': { tags: ['latest', 'stable', '1.36', '1.37'], profile: () => ({ kind: 'shell', port: null, startup: 0, mem: () => 1, cpuBase: 0 }) },
    'alpine': { tags: ['latest', '3.20', '3.21', '3.22'], profile: () => ({ kind: 'shell', port: null, startup: 0, mem: () => 1, cpuBase: 0 }) },
  };

  function paymentsProfile(tag) {
    return service({
      app: 'payments',
      extra: {
        port: tag === '2.8' ? 9090 : 8080, mem: () => 120,
        readyLogs(ctx) { return [`${stamp(ctx)} INFO  payments ${tag}: PSP connection pool ready (4 conns)`, `${stamp(ctx)} INFO  listening on :${this.port}${tag === '2.8' ? ' (moved from :8080, see CHANGELOG)' : ''}`]; },
      },
    });
  }

  /* system images: anything from registry.k8s.io, plus the two cluster add-ons with behaviour */
  const SYSTEM = {
    'registry.k8s.io/coredns/coredns': () => ({
      kind: 'dns', port: 53, startup: 1, health: ['/health', '/ready'], mem: () => 22, cpuBase: 3,
      startLogs: () => ['.:53', '[INFO] plugin/reload: Running configuration SHA512 = 4a1c6f...', 'CoreDNS-1.12.1', 'linux/amd64, go1.23.4, 51e11f1'],
      validate(ctx) {
        const conf = ctx.files['/etc/coredns/Corefile'];
        if (conf == null) return ['plugin/kubernetes: open /etc/coredns/Corefile: no such file or directory'];
        return validateCorefile(conf);
      },
    }),
    'registry.k8s.io/ingress-nginx/controller': () => ({ kind: 'system', port: 80, startup: 1, health: ['/healthz'], mem: () => 96, cpuBase: 4,
      startLogs: () => ['NGINX Ingress controller', '  Release:       v1.13.1', 'I1004 main.go:205] "Creating API client" host="https://10.96.0.1:443"'] }),
  };
  const KNOWN_PLUGINS = ['errors', 'health', 'ready', 'kubernetes', 'prometheus', 'forward', 'cache', 'loop', 'reload', 'loadbalance', 'log', 'hosts', 'rewrite', 'template', 'lameduck', 'pods', 'fallthrough', 'ttl'];
  function validateCorefile(text) {
    const lines = text.split('\n');
    let depth = 0;
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i].replace(/#.*/, '').trim();
      if (!raw) continue;
      const opens = (raw.match(/\{/g) || []).length, closes = (raw.match(/\}/g) || []).length;
      const words = raw.replace(/[{}]/g, ' ').trim().split(/\s+/).filter(Boolean);
      if (depth === 1 && words.length) {
        const w = words[0];
        if (!KNOWN_PLUGINS.includes(w)) return [`/etc/coredns/Corefile:${i + 1} - Error during parsing: Unknown directive '${w}'`];
        if (w === 'forward') {
          const to = words[2];
          if (!to) return [`/etc/coredns/Corefile:${i + 1} - Error during parsing: Wrong argument count or unexpected line ending after 'forward'`];
          if (!/^(\d+\.\d+\.\d+\.\d+(:\d+)?|\/etc\/resolv\.conf|dns:\/\/\S+|tls:\/\/\S+)$/.test(to)) return [`plugin/forward: not an IP address or file: "${to}"`];
        }
        if (w === 'cache' && words[1] && !/^\d+$/.test(words[1])) return [`/etc/coredns/Corefile:${i + 1} - Error during parsing: cache: invalid TTL "${words[1]}"`];
      }
      depth += opens - closes;
      if (depth < 0) return [`/etc/coredns/Corefile:${i + 1} - Error during parsing: Unexpected '}' because no matching opening brace`];
    }
    if (depth !== 0) return ['/etc/coredns/Corefile:' + lines.length + ' - Error during parsing: Unexpected EOF'];
    return null;
  }
  const GENERIC_SYSTEM = () => ({ kind: 'system', port: null, startup: 1, mem: () => 30, cpuBase: 3, startLogs: () => ['I1004 server.go:139] starting'] });

  /* ---------- image references ---------- */
  function parseImage(ref) {
    let r = String(ref || '').trim();
    const at = r.indexOf('@'); if (at >= 0) r = r.slice(0, at);
    const slash = r.lastIndexOf('/'), colon = r.lastIndexOf(':');
    let repo = r, tag = 'latest';
    if (colon > slash) { repo = r.slice(0, colon); tag = r.slice(colon + 1); }
    repo = repo.replace(/^docker\.io\//, '').replace(/^library\//, '');
    return { repo, tag };
  }
  function fullRef(p) {
    if (!p.repo.includes('/')) return 'docker.io/library/' + p.repo + ':' + p.tag;
    if (!p.repo.split('/')[0].includes('.')) return 'docker.io/' + p.repo + ':' + p.tag;
    return p.repo + ':' + p.tag;
  }
  const registryOf = repo => (repo.split('/')[0].includes('.') ? repo.split('/')[0] : 'docker.io');
  function resolveImage(ref) {
    if (!/^[a-z0-9][a-z0-9._\-/:@]*$/.test(String(ref || ''))) return { ok: false, invalid: true };
    const p = parseImage(ref);
    if (/^registry\.k8s\.io\//.test(p.repo)) return { ok: true, ...p, profile: (SYSTEM[p.repo] || GENERIC_SYSTEM)(p.tag), system: true };
    const img = IMAGES[p.repo];
    const ref2 = fullRef(p);
    if (!img) return { ok: false, ...p, why: `failed to pull and unpack image "${ref2}": failed to resolve reference "${ref2}": pull access denied, repository does not exist or may require authorization: server message: insufficient_scope: authorization failed` };
    if (!img.tags.includes(p.tag)) return { ok: false, ...p, why: `rpc error: code = NotFound desc = failed to pull and unpack image "${ref2}": failed to resolve reference "${ref2}": ${ref2}: not found` };
    return { ok: true, ...p, private: !!img.private, registry: registryOf(p.repo), profile: img.profile(p.tag) };
  }
  function nameFromImage(image) {
    const base = parseImage(image).repo.split('/').pop() || 'app';
    return base.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '') || 'app';
  }

  K.apps = { IMAGES, resolveImage, parseImage, fullRef, nameFromImage, validateCorefile, registryOf };
})(window.K = window.K || {});

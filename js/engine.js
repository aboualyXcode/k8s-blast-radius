/* engine.js — a deterministic Kubernetes simulator built for incident response.
   Controllers follow the real pattern: observe, compare with desired state, act.
   Failures are not scripted; they emerge from the same rules a real cluster follows:
   resource requests and limits, probes, quotas, taints, RBAC, NetworkPolicies, DNS and storage. */
(function (K) {
  'use strict';
  const A = K.apps;

  const C = K.CONST = {
    TICK_SECONDS: 3, EVICT_AFTER: 3, PROGRESS_DEADLINE: 20, HPA_SYNC: 2, HPA_DOWN_WINDOW: 4,
    VERSION: 'v1.34.2', CONTEXT: 'stagedoor-prod', NODE_CPU: 2000, NODE_MEM: 4096, MAX_PODS: 32,
    SYSTEM_RESERVED_MEM: 600, EVICTION_THRESHOLD: 100, DNS_IP: '10.96.0.10',
  };
  const ALPHABET = 'bcdfghjklmnpqrstvwxz2456789';
  const SYSTEM_NS = ['kube-system', 'kube-public', 'kube-node-lease', 'ingress-nginx'];
  const CLUSTER_KINDS = ['ClusterRole', 'ClusterRoleBinding', 'PersistentVolume', 'StorageClass'];
  const KINDS = ['Pod', 'ReplicaSet', 'Deployment', 'DaemonSet', 'Service', 'ConfigMap', 'Secret', 'HorizontalPodAutoscaler',
    'Ingress', 'NetworkPolicy', 'ServiceAccount', 'Role', 'RoleBinding', 'ClusterRole', 'ClusterRoleBinding', 'ResourceQuota',
    'PersistentVolumeClaim', 'PersistentVolume', 'StorageClass', 'PodDisruptionBudget'];
  const API_GROUP = { pods: '', services: '', configmaps: '', secrets: '', serviceaccounts: '', persistentvolumeclaims: '', persistentvolumes: '', nodes: '', namespaces: '', events: '', endpoints: '', resourcequotas: '',
    'pods/log': '', 'pods/exec': '', deployments: 'apps', replicasets: 'apps', daemonsets: 'apps', statefulsets: 'apps', horizontalpodautoscalers: 'autoscaling',
    ingresses: 'networking.k8s.io', networkpolicies: 'networking.k8s.io', roles: 'rbac.authorization.k8s.io', rolebindings: 'rbac.authorization.k8s.io',
    clusterroles: 'rbac.authorization.k8s.io', clusterrolebindings: 'rbac.authorization.k8s.io', storageclasses: 'storage.k8s.io', poddisruptionbudgets: 'policy', leases: 'coordination.k8s.io', jobs: 'batch', cronjobs: 'batch' };

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function fnv1a(str) { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; }
  function stable(v) {
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    if (v && typeof v === 'object') return '{' + Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
    return JSON.stringify(v === undefined ? null : v);
  }
  const hashStr = (s, len) => { let o = ''; for (let i = 0; i < len; i++) o += ALPHABET[fnv1a(i + ':' + s) % ALPHABET.length]; return o; };
  const clone = o => (o == null ? o : JSON.parse(JSON.stringify(o)));
  const matches = (labels, sel) => !!sel && Object.keys(sel).length > 0 && Object.keys(sel).every(k => labels && labels[k] === sel[k]);
  /* full label selector {matchLabels, matchExpressions}; an empty selector matches everything */
  function selects(sel, labels) {
    if (!sel) return false;
    labels = labels || {};
    const ml = sel.matchLabels || {};
    if (!Object.keys(ml).every(k => labels[k] === String(ml[k]))) return false;
    return (sel.matchExpressions || []).every(e => {
      const has = e.key in labels, v = labels[e.key], vals = (e.values || []).map(String);
      if (e.operator === 'In') return has && vals.includes(v);
      if (e.operator === 'NotIn') return !has || !vals.includes(v);
      if (e.operator === 'Exists') return has;
      if (e.operator === 'DoesNotExist') return !has;
      return false;
    });
  }

  /* ---------- quantities ---------- */
  const Q = {
    cpu(q) { if (q == null || q === '') return 0; const s = String(q).trim(); return s.endsWith('m') ? parseFloat(s) || 0 : Math.round((parseFloat(s) || 0) * 1000); },
    mem(q) {
      if (q == null || q === '') return 0;
      const m = /^([0-9.]+)\s*([KMGTP]i?|[kmgtp]|e\d+)?$/.exec(String(q).trim());
      if (!m) return 0;
      const n = parseFloat(m[1]), u = m[2] || '';
      const f = { '': 1 / 1048576, k: 1000 / 1048576, K: 1000 / 1048576, Ki: 1 / 1024, M: 1e6 / 1048576, Mi: 1, G: 1e9 / 1048576, Gi: 1024, T: 1e12 / 1048576, Ti: 1048576 }[u];
      return f == null ? 0 : n * f;
    },
    valid(q, kind) { return kind === 'cpu' ? /^\d+(\.\d+)?m?$/.test(String(q)) : /^\d+(\.\d+)?([KMGT]i?|k)?$/.test(String(q)); },
    fmtCpu(m) { m = Math.round(m); return m % 1000 === 0 ? String(m / 1000) : m + 'm'; },
    fmtMem(mi) { mi = Math.round(mi); return mi >= 1024 && mi % 1024 === 0 ? mi / 1024 + 'Gi' : mi + 'Mi'; },
  };
  K.qty = Q;

  /* ---------- pod spec helpers ---------- */
  function blankSpec() { return { containers: [], initContainers: [], volumes: [], serviceAccountName: 'default', nodeSelector: {}, tolerations: [], imagePullSecrets: [], restartPolicy: 'Always' }; }
  function containerSpec(o) {
    const c = { name: o.name || A.nameFromImage(o.image), image: o.image, env: clone(o.env || []), envFrom: clone(o.envFrom || []),
      ports: o.port ? [Object.assign({ containerPort: o.port, protocol: 'TCP' }, o.portName ? { name: o.portName } : {})] : clone(o.ports || []),
      resources: clone(o.resources || {}), volumeMounts: clone(o.volumeMounts || []) };
    ['command', 'args', 'livenessProbe', 'readinessProbe', 'startupProbe'].forEach(k => { if (o[k]) c[k] = clone(o[k]); });
    return c;
  }
  function podRequests(spec) {
    let cpu = 0, mem = 0, lcpu = 0, lmem = 0;
    for (const ct of spec.containers) {
      const r = (ct.resources && ct.resources.requests) || {}, l = (ct.resources && ct.resources.limits) || {};
      cpu += Q.cpu(r.cpu != null ? r.cpu : l.cpu); mem += Q.mem(r.memory != null ? r.memory : l.memory);
      lcpu += Q.cpu(l.cpu); lmem += Q.mem(l.memory);
    }
    return { cpu, mem, lcpu, lmem };
  }
  function qosOf(spec) {
    let any = false, guaranteed = true;
    for (const ct of spec.containers) {
      const r = (ct.resources && ct.resources.requests) || {}, l = (ct.resources && ct.resources.limits) || {};
      if (r.cpu || r.memory || l.cpu || l.memory) any = true;
      const rc = r.cpu != null ? r.cpu : l.cpu, rm = r.memory != null ? r.memory : l.memory;
      if (!l.cpu || !l.memory || Q.cpu(rc) !== Q.cpu(l.cpu) || Q.mem(rm) !== Q.mem(l.memory)) guaranteed = false;
    }
    return !any ? 'BestEffort' : guaranteed ? 'Guaranteed' : 'Burstable';
  }
  const memLimit = ct => Q.mem(ct.resources && ct.resources.limits && ct.resources.limits.memory);
  function portNum(ct, port) {
    if (port == null) return NaN;
    if (/^\d+$/.test(String(port))) return Number(port);
    const p = (ct.ports || []).find(x => x.name === port);
    return p ? Number(p.containerPort) : NaN;
  }
  function tolerates(tols, taint) {
    return (tols || []).some(t => {
      const keyOk = t.operator === 'Exists' ? (!t.key || t.key === taint.key) : (t.key === taint.key && String(t.value || '') === String(taint.value || ''));
      return keyOk && (!t.effect || t.effect === taint.effect);
    });
  }

  /* ================= the cluster ================= */
  class Cluster {
    constructor(opts) {
      opts = opts || {};
      this.rng = mulberry32(opts.seed != null ? opts.seed : (Date.now() & 0x7fffffff));
      this.now = 0; this.tickCount = 0;
      this.baseTime = opts.baseTime || Date.now();
      this.nodes = []; this.namespaces = new Map();
      this.store = {}; KINDS.forEach(k => { this.store[k] = new Map(); });
      this.events = []; this.eventIndex = new Map();
      this.currentNamespace = 'default';
      this.flows = []; this.flowStats = {}; this.impact = { failed: 0, total: 0 };
      this.rr = {}; this.ipUsed = new Set(); this.registryCreds = {};
      this.user = { kind: 'User', name: 'oncall', groups: ['system:masters', 'system:authenticated'] };
      this.TOOLBOX = { ns: 'default', labels: { run: 'toolbox' }, ip: '10.244.0.9', name: 'toolbox' };
      this.INTERNET = { ns: null, labels: {}, ip: '198.51.100.23', name: 'internet', external: true };
      this.activity = Cluster.blankActivity();
    }
    static blankActivity() { return { apiserver: 0, etcd: 0, scheduler: 0, controllers: 0, kubelet: {} }; }

    /* ---------- storage ---------- */
    k(ns, name) { return (ns || '') + '/' + name; }
    get(kind, ns, name) { return this.store[kind] ? this.store[kind].get(this.k(CLUSTER_KINDS.includes(kind) ? '' : ns, name)) || null : null; }
    list(kind, ns) { const all = Array.from(this.store[kind].values()); return ns ? all.filter(o => o.namespace === ns) : all; }
    put(o) { if (CLUSTER_KINDS.includes(o.kind)) o.namespace = ''; this.store[o.kind].set(this.k(o.namespace, o.name), o); this.activity.etcd++; return o; }
    del(kind, ns, name) { this.store[kind].delete(this.k(CLUSTER_KINDS.includes(kind) ? '' : ns, name)); this.activity.etcd++; }
    uid() {
      const hx = n => { let s = ''; for (let i = 0; i < n; i++) s += Math.floor(this.rng() * 16).toString(16); return s; };
      return `${hx(8)}-${hx(4)}-4${hx(3)}-${'89ab'[Math.floor(this.rng() * 4)]}${hx(3)}-${hx(12)}`;
    }
    rand(n) { let s = ''; for (let i = 0; i < n; i++) s += ALPHABET[Math.floor(this.rng() * ALPHABET.length)]; return s; }
    ts(sec) { return new Date(this.baseTime + (sec - this.now) * 1000).toISOString().replace(/\.\d+Z$/, 'Z'); }
    node(name) { return this.nodes.find(n => n.name === name) || null; }
    nsExists(ns) { return this.namespaces.has(ns) && this.namespaces.get(ns).phase !== 'Terminating'; }
    isSystemNs(ns) { return SYSTEM_NS.includes(ns); }
    obj(kind, base) { return Object.assign({ kind, uid: this.uid(), created: this.now, labels: {}, annotations: {} }, base); }

    /* ---------- events ---------- */
    event(obj, type, reason, message, source) {
      const ns = obj.namespace || 'default';
      const key = [obj.kind, ns, obj.name, reason, message].join('|');
      let ev = this.eventIndex.get(key);
      if (ev) {
        ev.count++; ev.last = this.now;
        const i = this.events.indexOf(ev); if (i >= 0) this.events.splice(i, 1);
        this.events.push(ev);
      } else {
        ev = { namespace: ns, kind: obj.kind, name: obj.name, type, reason, message, source, count: 1, first: this.now, last: this.now, key };
        this.events.push(ev); this.eventIndex.set(key, ev);
        if (this.events.length > 600) { const old = this.events.shift(); this.eventIndex.delete(old.key); }
      }
    }
    eventsFor(kind, ns, name) { return this.events.filter(e => e.kind === kind && e.name === name && (kind === 'Node' || CLUSTER_KINDS.includes(kind) || e.namespace === ns)); }
    clearEvents() { this.events = []; this.eventIndex.clear(); }

    /* ---------- setup helpers ---------- */
    addNode(name, o) {
      o = o || {};
      const i = this.nodes.length;
      const n = { kind: 'Node', name, uid: this.uid(), created: this.now, ready: true, unschedulable: false,
        cpuM: o.cpu || C.NODE_CPU, memMi: o.mem || C.NODE_MEM, maxPods: o.maxPods || C.MAX_PODS,
        allocCpu: (o.cpu || C.NODE_CPU) - 70, allocMem: (o.mem || C.NODE_MEM) - C.SYSTEM_RESERVED_MEM,
        ip: '10.0.1.' + (11 + i), cidr: i + 1, nextIp: 2, taints: clone(o.taints || []), memPressure: false, memUsage: 0,
        labels: Object.assign({ 'kubernetes.io/arch': 'amd64', 'kubernetes.io/hostname': name, 'kubernetes.io/os': 'linux', 'node.kubernetes.io/instance-type': o.type || 'm7i.large', 'topology.kubernetes.io/zone': ['eu-west-1a', 'eu-west-1b', 'eu-west-1c'][i % 3] }, o.labels || {}) };
      this.nodes.push(n); return n;
    }
    addNamespace(name, labels) {
      if (!this.namespaces.has(name)) {
        this.namespaces.set(name, { kind: 'Namespace', name, uid: this.uid(), created: this.now, phase: 'Active', labels: Object.assign({ 'kubernetes.io/metadata.name': name }, labels || {}) });
        if (!this.get('ServiceAccount', name, 'default')) this.put(this.obj('ServiceAccount', { name: 'default', namespace: name }));
      }
      this.activity.etcd++;
      return this.namespaces.get(name);
    }
    settle(n) { for (let i = 0; i < (n || 10); i++) this.step(); }
    ageAll(seconds) {
      const shift = o => { ['created', 'startedAt', 'lastRestartAt'].forEach(k => { if (o[k] != null) o[k] -= seconds; }); if (o.lastState && o.lastState.finishedAt != null) { o.lastState.finishedAt -= seconds; o.lastState.startedAt -= seconds; } if (o.probes) Object.values(o.probes).forEach(p => { p.next -= seconds; }); };
      this.nodes.forEach(shift); this.namespaces.forEach(shift);
      KINDS.forEach(k => this.store[k].forEach(shift));
      this.events.forEach(e => { e.first -= seconds; e.last -= seconds; });
    }

    /* ---------- object creation ---------- */
    makePod(o) {
      let name = o.name;
      if (!name) { do { name = o.prefix + this.rand(5); } while (this.get('Pod', o.ns, name)); }
      const spec = Object.assign(blankSpec(), clone(o.spec));
      const p = this.obj('Pod', {
        name, namespace: o.ns, labels: Object.assign({}, o.labels || {}), annotations: Object.assign({}, o.annotations || {}), owner: o.owner || null, spec,
        node: null, status: 'Pending', phase: 'Pending', reason: null, message: null, ready: false, restarts: 0, ip: null, timer: 0,
        deleting: false, deleteTimer: 0, startedAt: null, lastRestartAt: null, logs: [], prevLogs: [], pulled: {}, lastState: null,
        init: 0, probes: {}, memMi: 0, servedRps: 0, scheduleFail: null, env: {}, qos: qosOf(spec),
      });
      return this.put(p);
    }
    podSpec(o) {
      const s = blankSpec();
      s.containers = o.containers ? o.containers.map(containerSpec) : [containerSpec(o)];
      ['initContainers'].forEach(k => { if (o[k]) s[k] = o[k].map(containerSpec); });
      ['volumes', 'tolerations', 'imagePullSecrets'].forEach(k => { if (o[k]) s[k] = clone(o[k]); });
      if (o.nodeSelector) s.nodeSelector = clone(o.nodeSelector);
      if (o.serviceAccountName) s.serviceAccountName = o.serviceAccountName;
      return s;
    }
    createDeployment(o) {
      const labels = o.labels || { app: o.name };
      const d = this.obj('Deployment', {
        name: o.name, namespace: o.ns || 'default', labels: Object.assign({}, labels), replicas: o.replicas == null ? 1 : o.replicas,
        selector: Object.assign({}, o.selector || labels), strategy: clone(o.strategy || { type: 'RollingUpdate', rollingUpdate: { maxSurge: '25%', maxUnavailable: '25%' } }),
        template: { labels: Object.assign({}, o.podLabels || labels), annotations: Object.assign({}, o.podAnnotations || {}), spec: o.spec ? Object.assign(blankSpec(), clone(o.spec)) : this.podSpec(o) },
        progressTick: this.tickCount, revision: 0, lastNewAvailable: 0, deadlineExceeded: false, changeCause: o.changeCause || null,
      });
      return this.put(d);
    }
    createDaemonSet(o) {
      const labels = o.labels || { app: o.name };
      return this.put(this.obj('DaemonSet', { name: o.name, namespace: o.ns, labels, selector: labels, template: { labels, annotations: {}, spec: this.podSpec(Object.assign({ tolerations: [{ operator: 'Exists' }] }, o)) } }));
    }
    allocClusterIP() {
      let ip;
      do { ip = '10.96.' + Math.floor(this.rng() * 250 + 1) + '.' + Math.floor(this.rng() * 250 + 2); } while (this.ipUsed.has(ip));
      this.ipUsed.add(ip); return ip;
    }
    createService(o) {
      const type = o.type || 'ClusterIP';
      const ports = (o.ports || []).map(p => {
        const q = { name: p.name, protocol: p.protocol || 'TCP', port: Number(p.port), targetPort: p.targetPort == null ? Number(p.port) : p.targetPort };
        if (type !== 'ClusterIP') q.nodePort = p.nodePort || 30000 + Math.floor(this.rng() * 2767);
        return q;
      });
      return this.put(this.obj('Service', {
        name: o.name, namespace: o.ns || 'default', labels: Object.assign({}, o.labels || {}), selector: o.selector ? Object.assign({}, o.selector) : null,
        type, ports, clusterIP: o.clusterIP || this.allocClusterIP(), externalIP: null, lbTimer: 3, staticEndpoints: o.staticEndpoints || null,
      }));
    }
    createHPA(o) {
      return this.put(this.obj('HorizontalPodAutoscaler', { name: o.name, namespace: o.ns || 'default', target: { kind: 'Deployment', name: o.target }, min: o.min || 1, max: o.max, targetCPU: o.cpu || 80, current: null, recs: [], problem: null }));
    }
    createConfigMap(ns, name, data, labels) { return this.put(this.obj('ConfigMap', { name, namespace: ns, data: Object.assign({}, data), labels: labels || {} })); }
    createSecret(ns, name, data, type) { return this.put(this.obj('Secret', { name, namespace: ns, data: Object.assign({}, data), type: type || 'Opaque' })); }
    createPVC(o) {
      return this.put(this.obj('PersistentVolumeClaim', { name: o.name, namespace: o.ns, labels: o.labels || {},
        spec: { accessModes: o.accessModes || ['ReadWriteOnce'], storageClassName: o.storageClassName === undefined ? null : o.storageClassName, resources: { requests: { storage: o.size || '1Gi' } } },
        phase: 'Pending', volumeName: null, capacityMi: 0, usedMi: o.usedMi || 0, terminating: false, resizing: null }));
    }
    createStorageClass(o) {
      return this.put(this.obj('StorageClass', { name: o.name, provisioner: o.provisioner || 'ebs.csi.aws.com', reclaimPolicy: o.reclaimPolicy || 'Delete',
        volumeBindingMode: o.volumeBindingMode || 'Immediate', allowVolumeExpansion: !!o.allowVolumeExpansion, isDefault: !!o.isDefault, parameters: o.parameters || { type: 'gp3' } }));
    }

    /* ---------- relationships ---------- */
    active(p) { return !p.deleting && p.status !== 'Failed' && p.status !== 'Succeeded'; }
    rsOf(d) { return this.list('ReplicaSet', d.namespace).filter(rs => rs.owner === d.name); }
    podsOfRS(rs, withDeleting) {
      return this.list('Pod', rs.namespace).filter(p => p.owner && p.owner.kind === 'ReplicaSet' && p.owner.name === rs.name && (withDeleting || this.active(p)));
    }
    availableOf(rs) { return this.podsOfRS(rs).filter(p => p.ready).length; }
    deploymentOfPod(p) {
      if (!p.owner || p.owner.kind !== 'ReplicaSet') return null;
      const rs = this.get('ReplicaSet', p.namespace, p.owner.name);
      return rs ? this.get('Deployment', p.namespace, rs.owner) : null;
    }
    workloadOf(p) { const d = this.deploymentOfPod(p); return d ? d.name : p.owner ? p.owner.name : p.name; }
    podsOfDeployment(d) { return this.rsOf(d).reduce((a, rs) => a.concat(this.podsOfRS(rs)), []); }
    templateHash(t) { return hashStr(stable({ labels: t.labels, annotations: t.annotations || {}, spec: t.spec }), 10); }
    newRSOf(d) { const h = this.templateHash(d.template); return this.rsOf(d).find(rs => rs.hash === h) || null; }
    deploymentStatus(d) {
      const h = this.templateHash(d.template);
      let replicas = 0, updated = 0, ready = 0;
      for (const rs of this.rsOf(d)) {
        const pods = this.podsOfRS(rs);
        replicas += pods.length; ready += pods.filter(p => p.ready).length;
        if (rs.hash === h) updated += pods.length;
      }
      return { replicas, updated, ready, available: ready, unavailable: Math.max(0, d.replicas - ready) };
    }
    rolloutComplete(d) {
      const s = this.deploymentStatus(d);
      return !!this.newRSOf(d) && s.updated === d.replicas && s.replicas === d.replicas && s.available === d.replicas;
    }
    rolloutMessage(d) {
      const s = this.deploymentStatus(d);
      if (d.deadlineExceeded) return { done: true, error: true, msg: `error: deployment "${d.name}" exceeded its progress deadline` };
      if (s.updated < d.replicas) return { done: false, msg: `Waiting for deployment "${d.name}" rollout to finish: ${s.updated} out of ${d.replicas} new replicas have been updated...` };
      if (s.replicas > s.updated) return { done: false, msg: `Waiting for deployment "${d.name}" rollout to finish: ${s.replicas - s.updated} old replicas are pending termination...` };
      if (s.available < s.updated) return { done: false, msg: `Waiting for deployment "${d.name}" rollout to finish: ${s.available} of ${s.updated} updated replicas are available...` };
      return { done: true, msg: `deployment "${d.name}" successfully rolled out` };
    }
    /* pods behind a Service port: ready, selected and (for a named targetPort) exposing that port name */
    endpointsFor(svc, sp) {
      if (!svc.selector) return [];
      sp = sp || svc.ports[0];
      return this.list('Pod', svc.namespace).filter(p => !p.deleting && p.ready && p.node && matches(p.labels, svc.selector) && (!sp || !isNaN(this.targetPortOf(p, sp))));
    }
    notReadyFor(svc) {
      if (!svc.selector) return [];
      return this.list('Pod', svc.namespace).filter(p => this.active(p) && !p.ready && p.node && matches(p.labels, svc.selector));
    }
    targetPortOf(p, sp) { return portNum(p.spec.containers[0], sp.targetPort); }
    imageInfo(p) { return A.resolveImage(p.spec.containers[0] && p.spec.containers[0].image); }
    profileOf(p) { const i = this.imageInfo(p); return i.ok ? i.profile : null; }
    srcOf(p) { return { ns: p.namespace, labels: p.labels, pod: p, ip: p.ip || '10.244.0.1', name: p.name }; }

    /* ---------- env, files, image pulls ---------- */
    resolveEnv(ns, c, pod) {
      const env = {};
      for (const ef of c.envFrom || []) {
        const ref = ef.configMapRef || ef.secretRef; if (!ref) continue;
        const kind = ef.configMapRef ? 'ConfigMap' : 'Secret';
        const obj = this.get(kind, ns, ref.name);
        if (!obj) { if (ref.optional) continue; return { error: `${kind === 'ConfigMap' ? 'configmap' : 'secret'} "${ref.name}" not found` }; }
        Object.keys(obj.data).forEach(k => { env[(ef.prefix || '') + k] = obj.data[k]; });
      }
      for (const e of c.env || []) {
        if (e.valueFrom) {
          if (e.valueFrom.fieldRef) { const f = e.valueFrom.fieldRef.fieldPath; env[e.name] = f === 'metadata.name' ? (pod && pod.name) : f === 'metadata.namespace' ? ns : f === 'status.podIP' ? (pod && pod.ip) : f === 'spec.nodeName' ? (pod && pod.node) : ''; continue; }
          const ref = e.valueFrom.configMapKeyRef || e.valueFrom.secretKeyRef; if (!ref) continue;
          const kind = e.valueFrom.configMapKeyRef ? 'ConfigMap' : 'Secret';
          const obj = this.get(kind, ns, ref.name);
          if (!obj) { if (ref.optional) continue; return { error: `${kind === 'ConfigMap' ? 'configmap' : 'secret'} "${ref.name}" not found` }; }
          if (!(ref.key in obj.data)) { if (ref.optional) continue; return { error: `couldn't find key ${ref.key} in ${kind} ${ns}/${ref.name}` }; }
          env[e.name] = obj.data[ref.key];
        } else env[e.name] = e.value == null ? '' : String(e.value);
      }
      return { env };
    }
    mountFiles(p, ct) {
      const files = {}, problems = [];
      for (const vm of ct.volumeMounts || []) {
        const v = (p.spec.volumes || []).find(x => x.name === vm.name);
        if (!v) continue;
        const src = v.configMap ? ['ConfigMap', v.configMap.name, v.configMap] : v.secret ? ['Secret', v.secret.secretName, v.secret] : null;
        if (!src) continue;
        const obj = this.get(src[0], p.namespace, src[1]);
        if (!obj) { if (!src[2].optional) problems.push(`MountVolume.SetUp failed for volume "${v.name}" : ${src[0].toLowerCase()} "${src[1]}" not found`); continue; }
        const items = src[2].items;
        const keys = items ? items.map(i => [i.key, i.path]) : Object.keys(obj.data).map(k => [k, k]);
        keys.forEach(([k, path]) => { if (k in obj.data) files[vm.mountPath.replace(/\/$/, '') + '/' + path] = obj.data[k]; });
      }
      return { files, problems };
    }
    pvcOfMount(p, mountPath) {
      for (const ct of p.spec.containers) {
        const vm = (ct.volumeMounts || []).find(m => m.mountPath === mountPath);
        if (!vm) continue;
        const v = (p.spec.volumes || []).find(x => x.name === vm.name);
        if (v && v.persistentVolumeClaim) return this.get('PersistentVolumeClaim', p.namespace, v.persistentVolumeClaim.claimName);
      }
      return null;
    }
    pullCheck(p, image) {
      const r = A.resolveImage(image);
      if (r.invalid) return { invalid: true };
      if (!r.ok) return { why: r.why };
      if (!r.private) return { ok: true, r };
      const ref = A.fullRef(r);
      const token = `failed to pull and unpack image "${ref}": failed to resolve reference "${ref}": failed to authorize: `;
      const names = (p.spec.imagePullSecrets || []).map(s => s.name);
      const secrets = names.map(n => this.get('Secret', p.namespace, n)).filter(Boolean);
      if (names.length && secrets.length < names.length) this.event(p, 'Warning', 'FailedToRetrieveImagePullSecret', `Unable to retrieve some image pull secrets (${names.filter(n => !this.get('Secret', p.namespace, n)).join(', ')}); attempting to pull the image may not succeed.`, 'kubelet');
      let sent = false;
      for (const s of secrets) {
        let cfg = null;
        try { cfg = JSON.parse(s.data['.dockerconfigjson'] || 'null'); } catch (e) { cfg = null; }
        const a = cfg && cfg.auths && cfg.auths[r.registry];
        if (!a) continue;
        sent = true;
        let pass = a.password;
        if (!pass && a.auth) { try { pass = K.b64.decode(a.auth).split(':').slice(1).join(':'); } catch (e) { pass = null; } }
        if (pass && pass === this.registryCreds[r.registry]) return { ok: true, r };
      }
      return { why: token + (sent ? `failed to fetch oauth token: unexpected status from POST request to https://${r.registry}/token: 401 Unauthorized`
        : `failed to fetch anonymous token: unexpected status from GET request to https://${r.registry}/token?scope=repository%3A${r.repo.split('/').slice(1).join('/')}%3Apull&service=${r.registry}: 401 Unauthorized`) };
    }

    /* ---------- RBAC ---------- */
    subjectOfPod(p) { return { kind: 'ServiceAccount', namespace: p.namespace, name: p.spec.serviceAccountName || 'default' }; }
    parseSubject(as) {
      const m = /^system:serviceaccount:([^:]+):([^:]+)$/.exec(as || '');
      return m ? { kind: 'ServiceAccount', namespace: m[1], name: m[2] } : as ? { kind: 'User', name: as, groups: ['system:authenticated'] } : this.user;
    }
    subjectMatches(s, b, who) {
      if (who.kind === 'ServiceAccount') {
        if (s.kind === 'ServiceAccount') return s.name === who.name && (s.namespace || b.namespace) === who.namespace;
        if (s.kind === 'Group') return ['system:serviceaccounts', 'system:serviceaccounts:' + who.namespace, 'system:authenticated'].includes(s.name);
        return false;
      }
      if (s.kind === 'User') return s.name === who.name;
      if (s.kind === 'Group') return (who.groups || []).includes(s.name);
      return false;
    }
    rulesFor(who, ns) {
      const out = [];
      const roleRules = (ref, bns) => { const r = ref.kind === 'ClusterRole' ? this.get('ClusterRole', '', ref.name) : this.get('Role', bns, ref.name); return r ? r.rules || [] : []; };
      for (const b of this.list('ClusterRoleBinding')) if ((b.subjects || []).some(s => this.subjectMatches(s, b, who))) out.push(...roleRules(b.roleRef, null).map(r => ({ rule: r, via: `ClusterRoleBinding/${b.name}` })));
      if (ns) for (const b of this.list('RoleBinding', ns)) if ((b.subjects || []).some(s => this.subjectMatches(s, b, who))) out.push(...roleRules(b.roleRef, ns).map(r => ({ rule: r, via: `RoleBinding/${b.name}` })));
      return out;
    }
    can(who, verb, resource, ns, group) {
      group = group != null ? group : (API_GROUP[resource] != null ? API_GROUP[resource] : '');
      const has = (list, v) => (list || []).includes('*') || (list || []).includes(v);
      return this.rulesFor(who, ns).some(({ rule }) => has(rule.verbs, verb) && has(rule.resources, resource) && has(rule.apiGroups || [''], group));
    }

    /* ---------- admission: service accounts and quotas ---------- */
    quotaUsage(ns, exceptPod) {
      const u = { 'requests.cpu': 0, 'requests.memory': 0, 'limits.cpu': 0, 'limits.memory': 0, pods: 0 };
      for (const p of this.list('Pod', ns)) {
        if (p === exceptPod || p.status === 'Failed' || p.status === 'Succeeded') continue;
        const r = podRequests(p.spec);
        u['requests.cpu'] += r.cpu; u['requests.memory'] += r.mem; u['limits.cpu'] += r.lcpu; u['limits.memory'] += r.lmem; u.pods++;
      }
      u.cpu = u['requests.cpu']; u.memory = u['requests.memory'];
      return u;
    }
    admitPod(ns, name, spec) {
      const sa = spec.serviceAccountName || 'default';
      if (!this.get('ServiceAccount', ns, sa)) return `pods "${name}" is forbidden: error looking up service account ${ns}/${sa}: serviceaccount "${sa}" not found`;
      for (const q of this.list('ResourceQuota', ns)) {
        const hard = q.hard || {};
        const missing = [];
        for (const key of ['limits.cpu', 'limits.memory', 'requests.cpu', 'requests.memory']) {
          if (!(key in hard) && !(key.startsWith('requests.') && key.slice(9) in hard)) continue;
          const [kind, res] = key.split('.');
          spec.containers.forEach(ct => {
            const r = ct.resources || {}, val = kind === 'limits' ? (r.limits || {})[res] : ((r.requests || {})[res] != null ? r.requests[res] : (r.limits || {})[res]);
            if (val == null) missing.push(`${key} for: ${ct.name}`);
          });
        }
        if (missing.length) return `pods "${name}" is forbidden: failed quota: ${q.name}: must specify ${missing.join('; ')}`;
        const used = this.quotaUsage(ns), r = podRequests(spec);
        const want = { 'requests.cpu': r.cpu, 'requests.memory': r.mem, 'limits.cpu': r.lcpu, 'limits.memory': r.lmem, pods: 1, cpu: r.cpu, memory: r.mem };
        const over = Object.keys(hard).filter(k => k in want && used[k] + want[k] > this.quotaHard(k, hard[k]) + 0.001);
        if (over.length) {
          const f = (k, v) => `${k}=${/cpu/.test(k) ? Q.fmtCpu(v) : /memory/.test(k) ? Q.fmtMem(v) : v}`;
          return `pods "${name}" is forbidden: exceeded quota: ${q.name}, requested: ${over.map(k => f(k, want[k])).join(',')}, used: ${over.map(k => f(k, used[k])).join(',')}, limited: ${over.map(k => `${k}=${hard[k]}`).join(',')}`;
        }
      }
      return null;
    }
    quotaHard(k, v) { return /cpu/.test(k) ? Q.cpu(v) : /memory/.test(k) ? Q.mem(v) : Number(v); }

    /* ---------- networking: DNS, Services, NetworkPolicy, Ingress ---------- */
    nsLabels(ns) { const n = this.namespaces.get(ns); return n ? n.labels : {}; }
    peerMatches(peer, policyNs, src) {
      if (peer.ipBlock) return !!src.external || (peer.ipBlock.cidr === '0.0.0.0/0' && !src.pod && !src.ns);
      if (src.external || !src.ns) return false;
      const nsOk = peer.namespaceSelector ? selects(peer.namespaceSelector, this.nsLabels(src.ns)) : src.ns === policyNs;
      const podOk = peer.podSelector ? selects(peer.podSelector, src.labels) : true;
      return nsOk && podOk;
    }
    portMatches(ports, port, proto, dstPod) {
      if (!ports || !ports.length) return true;
      return ports.some(pp => {
        if ((pp.protocol || 'TCP') !== (proto || 'TCP')) return false;
        if (pp.port == null) return true;
        const n = dstPod ? portNum(dstPod.spec.containers[0], pp.port) : Number(pp.port);
        if (pp.endPort) return port >= n && port <= Number(pp.endPort);
        return n === port;
      });
    }
    policiesFor(pod, dir) { return this.list('NetworkPolicy', pod.namespace).filter(np => selects(np.podSelector, pod.labels) && np.policyTypes.includes(dir)); }
    ingressAllowed(src, dst, port, proto) {
      const pols = this.policiesFor(dst, 'Ingress');
      if (!pols.length) return true;
      return pols.some(np => (np.ingress || []).some(rule => (!rule.from || !rule.from.length || rule.from.some(peer => this.peerMatches(peer, np.namespace, src))) && this.portMatches(rule.ports, port, proto, dst)));
    }
    egressAllowed(src, dst, port, proto) {
      if (!src.pod) return true;
      const pols = this.policiesFor(src.pod, 'Egress');
      if (!pols.length) return true;
      const dstDesc = dst.pod ? { ns: dst.pod.namespace, labels: dst.pod.labels, pod: dst.pod } : { external: true };
      return pols.some(np => (np.egress || []).some(rule => (!rule.to || !rule.to.length || rule.to.some(peer => this.peerMatches(peer, np.namespace, dstDesc))) && this.portMatches(rule.ports, port, proto, dst.pod)));
    }
    netAllowed(src, pod, port, proto) { return this.egressAllowed(src, { pod }, port, proto) && this.ingressAllowed(src, pod, port, proto); }
    dnsWorks(src) {
      const kd = this.get('Service', 'kube-system', 'kube-dns');
      const pods = kd ? this.endpointsFor(kd) : [];
      if (!pods.length) return false;
      if (src.external) return true;
      return pods.some(p => this.netAllowed(src, p, 53, 'UDP'));
    }
    resolveName(src, host) {
      host = String(host).toLowerCase().replace(/\.$/, '');
      if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
        const svc = this.list('Service').find(s => s.clusterIP === host);
        if (svc) return { svc };
        const pod = this.list('Pod').find(p => p.ip === host && !p.deleting);
        return pod ? { pod } : { external: true };
      }
      if (/\.(io|com|net|org|example|dev)$/.test(host) && !/\.svc(\.cluster\.local)?$/.test(host)) {
        if (!src.external && !this.dnsWorks(src)) return { err: 'dns-timeout' };
        return { external: true, host };
      }
      if (!src.external && !this.dnsWorks(src)) return { err: 'dns-timeout' };
      const parts = host.replace(/\.cluster\.local$/, '').split('.');
      let name = parts[0], ns = src.ns || 'default';
      if (parts.length === 2) ns = parts[1];
      else if (parts.length === 3 && parts[2] === 'svc') ns = parts[1];
      else if (parts.length !== 1) return { err: 'nxdomain' };
      const svc = this.get('Service', ns, name);
      return svc ? { svc } : { err: 'nxdomain' };
    }
    parseUrl(url) {
      const m = /^(?:([a-z]+):\/\/)?([^/:\s]+)(?::(\d+))?(\/[^\s]*)?$/.exec(String(url || ''));
      if (!m) return null;
      const scheme = m[1] || 'http';
      return { scheme, host: m[2], port: m[3] ? Number(m[3]) : scheme === 'https' ? 443 : 80, path: m[4] || '/' };
    }
    /* One request from a source (a pod, the debug toolbox, or the internet) to a URL. */
    request(src, url, depth) {
      depth = depth || 0;
      const u = this.parseUrl(url);
      if (!u) return { ok: false, kind: 'malformed' };
      const base = { host: u.host, port: u.port, path: u.path };
      if (depth > 3) return Object.assign({ ok: false, kind: 'timeout', ip: u.host }, base);
      if (/stagedoor\.io$/.test(u.host) && u.scheme !== 'tcp') return Object.assign(this.ingressRequest(u.host, u.path), base);
      const res = this.resolveName(src, u.host);
      if (res.err) return Object.assign({ ok: false, kind: res.err }, base);
      if (res.external) {
        if (src.pod && !this.egressAllowed(src, {}, u.port, 'TCP')) return Object.assign({ ok: false, kind: 'timeout', ip: '203.0.113.40' }, base);
        return Object.assign({ ok: true, status: 200, body: '{"status":"ok"}' }, base);
      }
      if (res.svc) {
        const svc = res.svc;
        if (svc.name === 'kubernetes' && svc.namespace === 'default') return Object.assign({ ok: true, status: 403, body: '{"kind":"Status","status":"Failure","message":"forbidden: User \\"system:anonymous\\" cannot get path \\"/\\"","reason":"Forbidden","code":403}' }, base);
        const sp = svc.ports.find(p => p.port === u.port);
        if (!sp) return Object.assign({ ok: false, kind: 'timeout', ip: svc.clusterIP }, base);
        const eps = this.endpointsFor(svc, sp).sort((a, b) => (a.name < b.name ? -1 : 1));
        if (!eps.length) return Object.assign({ ok: false, kind: 'refused', ip: svc.clusterIP, svc }, base);
        const key = svc.uid + (depth ? ':d' : '');
        this.rr[key] = ((this.rr[key] == null ? -1 : this.rr[key]) + 1) % eps.length;
        const target = eps[this.rr[key]];
        return Object.assign(this.connectPod(src, target, this.targetPortOf(target, sp), u, depth), { svc, ip: svc.clusterIP, host: u.host, port: u.port });
      }
      return Object.assign(this.connectPod(src, res.pod, u.port, u, depth), base, { ip: res.pod.ip });
    }
    listening(p) {
      const prof = this.profileOf(p);
      return !!prof && p.phase === 'Running' && !p.deleting && prof.port != null && this.now - p.startedAt >= prof.startup;
    }
    connectPod(src, pod, port, u, depth) {
      const out = { pod, ip: pod.ip, port };
      if (!this.netAllowed(src, pod, port, 'TCP')) return Object.assign(out, { ok: false, kind: 'timeout' });
      const prof = this.profileOf(pod);
      if (!prof || !this.listening(pod) || prof.port !== port) return Object.assign(out, { ok: false, kind: 'refused' });
      if (u.scheme === 'tcp') return Object.assign(out, { ok: true, status: 0, tcp: true });
      if (prof.kind === 'tcp' || prof.kind === 'dns') return Object.assign(out, { ok: false, kind: 'empty' });
      const r = prof.respond ? prof.respond(this.appCtx(pod, depth), u.path) : { status: 200, body: 'ok' };
      return Object.assign(out, { ok: true, status: r.status, body: r.body });
    }
    appCtx(pod, depth) {
      const info = this.imageInfo(pod);
      return { c: this, pod, env: pod.env || {}, tag: info.tag, files: pod.files || {}, uptime: pod.startedAt == null ? 0 : this.now - pod.startedAt, src: this.srcOf(pod), depth: depth || 0 };
    }
    ingressController() {
      return this.list('Pod', 'ingress-nginx').filter(p => p.ready && !p.deleting)[0] || null;
    }
    ingressRoute(host, path) {
      const ings = this.list('Ingress').filter(i => (i.ingressClassName || 'nginx') === 'nginx');
      let best = null;
      for (const ing of ings) for (const rule of ing.rules) {
        if (rule.host && rule.host !== host) continue;
        for (const p of rule.paths) {
          const ok = p.pathType === 'Exact' ? path === p.path : (p.path === '/' || path === p.path || path.startsWith(p.path.replace(/\/$/, '') + '/'));
          if (ok && (!best || p.path.length > best.path.path.length)) best = { ing, path: p };
        }
      }
      return best;
    }
    ingressRequest(host, path) {
      const page = (code, text) => `<html>\n<head><title>${code} ${text}</title></head>\n<body>\n<center><h1>${code} ${text}</h1></center>\n<hr><center>nginx</center>\n</body>\n</html>`;
      const ctrl = this.ingressController();
      if (!ctrl) return { ok: false, kind: 'timeout', ip: '203.0.113.10' };
      const route = this.ingressRoute(host, path);
      if (!route) return { ok: true, status: 404, body: page(404, 'Not Found'), via: 'default-backend' };
      const be = route.path.backend, ns = route.ing.namespace;
      const svc = this.get('Service', ns, be.name);
      const ret = { ingress: route.ing, backend: be };
      if (!svc) return Object.assign(ret, { ok: true, status: 503, body: page(503, 'Service Temporarily Unavailable'), why: `service "${ns}/${be.name}" not found` });
      const sp = svc.ports.find(p => (be.portName ? p.name === be.portName : p.port === Number(be.port)));
      if (!sp) return Object.assign(ret, { ok: true, status: 503, body: page(503, 'Service Temporarily Unavailable'), why: `service "${ns}/${be.name}" does not have port ${be.portName || be.port}` });
      const eps = this.endpointsFor(svc, sp).sort((a, b) => (a.name < b.name ? -1 : 1));
      if (!eps.length) return Object.assign(ret, { ok: true, status: 503, body: page(503, 'Service Temporarily Unavailable'), why: `service "${ns}/${be.name}" does not have any active endpoint` });
      this.rr['ing:' + svc.uid] = ((this.rr['ing:' + svc.uid] == null ? -1 : this.rr['ing:' + svc.uid]) + 1) % eps.length;
      const target = eps[this.rr['ing:' + svc.uid]];
      const r = this.connectPod(this.srcOf(ctrl), target, this.targetPortOf(target, sp), { scheme: 'http', path }, 0);
      if (!r.ok) return Object.assign(ret, r.kind === 'timeout' ? { ok: true, status: 504, body: page(504, 'Gateway Time-out') } : { ok: true, status: 502, body: page(502, 'Bad Gateway') }, { pod: target, why: `upstream ${target.ip}:${this.targetPortOf(target, sp)} ${r.kind === 'timeout' ? 'timed out' : 'refused the connection'}` });
      return Object.assign(ret, r);
    }
    goErr(r, method, url) {
      const pre = method ? `${method} "${url}": ` : '';
      const srcPort = 40000 + (fnv1a(String(r.host) + this.tickCount) % 20000);
      if (r.kind === 'dns-timeout') return `${pre}dial tcp: lookup ${r.host} on ${C.DNS_IP}:53: read udp 10.244.1.4:${srcPort}->${C.DNS_IP}:53: i/o timeout`;
      if (r.kind === 'nxdomain') return `${pre}dial tcp: lookup ${r.host} on ${C.DNS_IP}:53: no such host`;
      if (r.kind === 'timeout') return `${pre}dial tcp ${r.ip || r.host}:${r.port}: i/o timeout`;
      if (r.kind === 'refused') return `${pre}dial tcp ${r.ip || r.host}:${r.port}: connect: connection refused`;
      if (r.kind === 'empty') return `${pre}net/http: HTTP/1.x transport connection broken: malformed HTTP response`;
      return `${pre}${r.kind}`;
    }
    appLog(pod, line) {
      if (pod._logTick === this.tickCount) return;
      pod._logTick = this.tickCount;
      pod.logs.push(line);
      if (pod.logs.length > 300) pod.logs.splice(0, pod.logs.length - 300);
    }

    /* ---------- pod lifecycle (the kubelet) ---------- */
    markDeleting(p, force) {
      if (force || !p.node || p.status === 'Failed') { this.del('Pod', p.namespace, p.name); return; }
      if (p.deleting) return;
      p.deleting = true; p.ready = false; p.deleteTimer = 2;
      this.event(p, 'Normal', 'Killing', `Stopping container ${p.spec.containers[0].name}`, 'kubelet');
    }
    bind(p, n) {
      p.node = n.name;
      p.ip = '10.244.' + n.cidr + '.' + n.nextIp; n.nextIp = n.nextIp >= 254 ? 2 : n.nextIp + 1;
      p.scheduleFail = null;
      this.event(p, 'Normal', 'Scheduled', `Successfully assigned ${p.namespace}/${p.name} to ${n.name}`, 'default-scheduler');
      this.activity.scheduler++;
    }
    pullAll(p) {
      for (const ct of (p.spec.initContainers || []).concat(p.spec.containers)) {
        if (p.pulled[ct.image]) continue;
        const r = this.pullCheck(p, ct.image);
        if (r.invalid) { p.phase = 'InvalidImageName'; this.event(p, 'Warning', 'InspectFailed', `Failed to apply default image tag "${ct.image}": couldn't parse image name "${ct.image}": invalid reference format`, 'kubelet'); return false; }
        if (!r.ok) {
          p.phase = 'ErrImagePull'; p.timer = 0;
          this.event(p, 'Normal', 'Pulling', `Pulling image "${ct.image}"`, 'kubelet');
          this.event(p, 'Warning', 'Failed', `Failed to pull image "${ct.image}": ${r.why}`, 'kubelet');
          this.event(p, 'Warning', 'Failed', 'Error: ErrImagePull', 'kubelet');
          return false;
        }
        this.event(p, 'Normal', 'Pulled', `Successfully pulled image "${ct.image}" in ${(0.8 + this.rng() * 2).toFixed(3)}s (${(0.8 + this.rng() * 2).toFixed(3)}s including waiting). Image size: ${20 + Math.floor(this.rng() * 90)}314572 bytes.`, 'kubelet');
        p.pulled[ct.image] = true;
      }
      return true;
    }
    initStep(p) {
      const inits = p.spec.initContainers || [];
      if (p.init >= inits.length) return true;
      const ct = inits[p.init];
      const cmd = (ct.command || []).concat(ct.args || []).join(' ');
      if (!p.initStarted) {
        this.event(p, 'Normal', 'Created', `Created container: ${ct.name}`, 'kubelet');
        this.event(p, 'Normal', 'Started', `Started container ${ct.name}`, 'kubelet');
        p.initStarted = true; p.initLogs = [];
      }
      const env = (this.resolveEnv(p.namespace, ct, p).env) || {};
      const sub = s => s.replace(/\$\(?([A-Z_]+)\)?/g, (m, k) => (k in env ? env[k] : m));
      const nc = /nc\s+-z\w*\s+(\S+)\s+(\d+)/.exec(sub(cmd)), ns = /nslookup\s+(\S+?)[;\s]/.exec(sub(cmd) + ' ');
      let done = true;
      if (nc) { const r = this.request(this.srcOf(p), `tcp://${nc[1]}:${nc[2]}`); done = r.ok; if (!done) this.appLogInit(p, `waiting for ${nc[1]}:${nc[2]}... (${r.kind === 'refused' ? 'connection refused' : r.kind === 'nxdomain' ? 'bad address' : 'timed out'})`); }
      else if (ns) { const r = this.resolveName(this.srcOf(p), ns[1]); done = !r.err; if (!done) this.appLogInit(p, `waiting for ${ns[1]} to resolve... (** server can't find ${ns[1]}: NXDOMAIN)`); }
      if (!done) { p.phase = `Init:${p.init}/${inits.length}`; return false; }
      p.init++; p.initStarted = false;
      if (p.init < inits.length) { p.phase = `Init:${p.init}/${inits.length}`; return false; }
      p.phase = 'PodInitializing';
      return true;
    }
    appLogInit(p, line) { p.initLogs = (p.initLogs || []).concat(line).slice(-40); }
    startMain(p, restart) {
      const node = p.node;
      this.activity.kubelet[node] = (this.activity.kubelet[node] || 0) + 1;
      let env0 = {};
      for (const ct of p.spec.containers) {
        const res = this.resolveEnv(p.namespace, ct, p);
        if (res.error) { p.phase = 'CreateContainerConfigError'; p.timer = 2; this.event(p, 'Warning', 'Failed', 'Error: ' + res.error, 'kubelet'); return; }
        if (ct === p.spec.containers[0]) env0 = res.env;
      }
      const c0 = p.spec.containers[0];
      const info = A.resolveImage(c0.image), prof = info.profile;
      p.env = env0; p.files = this.mountFiles(p, c0).files;
      if (restart) p.prevLogs = p.logs;
      p.logs = []; p.probes = {}; p.readyLogged = false; p.memMi = 0;
      this.event(p, 'Normal', restart ? 'Pulled' : 'Created', restart ? `Container image "${c0.image}" already present on machine` : `Created container: ${c0.name}`, 'kubelet');
      if (restart) this.event(p, 'Normal', 'Created', `Created container: ${c0.name}`, 'kubelet');
      this.event(p, 'Normal', 'Started', `Started container ${c0.name}`, 'kubelet');
      const ctx = this.appCtx(p);
      const st = this.ts(this.now);
      let logs = prof.startLogs ? prof.startLogs(ctx) : [];
      const crash = lines => { p.logs = lines; this.terminate(p, 'Error', 1); };
      const missing = (prof.requiredEnv || []).filter(k => !env0[k]);
      if (missing.length) return crash(prof.missingEnvLogs ? prof.missingEnvLogs(ctx) : logs.concat(`${st} FATAL invalid configuration: ${missing[0]} is required`));
      if (prof.validate) { const bad = prof.validate(ctx); if (bad) return crash(bad); }
      for (const [verb, res, group] of prof.api || []) {
        if (!this.can(this.subjectOfPod(p), verb, res, p.namespace, group)) {
          const sa = `system:serviceaccount:${p.namespace}:${p.spec.serviceAccountName || 'default'}`;
          return crash(logs.concat([
            `W${st.slice(5, 7)}${st.slice(8, 10)} ${st.slice(11, 19)}.112       1 reflector.go:561] failed to list *v1.ConfigMap: ${res} is forbidden: User "${sa}" cannot ${verb} resource "${res}" in API group "${group}" in the namespace "${p.namespace}"`,
            `E${st.slice(5, 7)}${st.slice(8, 10)} ${st.slice(11, 19)}.112       1 reflector.go:158] "Unhandled Error" err="failed to list *v1.ConfigMap: ${res} is forbidden: User \\"${sa}\\" cannot ${verb} resource \\"${res}\\" in API group \\"${group}\\" in the namespace \\"${p.namespace}\\""`,
            `F${st.slice(5, 7)}${st.slice(8, 10)} ${st.slice(11, 19)}.204       1 main.go:63] unable to start: timed out waiting for caches to sync`]));
        }
      }
      if (prof.disk) {
        const pvc = this.pvcOfMount(p, prof.disk.mount);
        if (pvc && pvc.usedMi >= pvc.capacityMi) return crash(prof.diskFullLogs(ctx));
      }
      if (prof.kind === 'shell') {
        if (!/\b(sleep|tail -f|until|while)\b/.test((c0.command || []).concat(c0.args || []).join(' '))) { p.logs = []; this.terminate(p, 'Completed', 0); return; }
      }
      p.logs = logs;
      p.phase = 'Running'; p.status = 'Running'; p.startedAt = this.now; p.ready = false;
      if (!restart) p.firstStart = this.now;
      this.runningTick(p, true);
    }
    terminate(p, reason, code) {
      p.lastState = { reason, exitCode: code, startedAt: p.startedAt == null ? this.now : p.startedAt, finishedAt: this.now };
      p.phase = reason === 'OOMKilled' ? 'OOMKilled' : reason === 'Completed' ? 'Completed' : 'Error';
      p.ready = false; p.memMi = 0;
      p.status = 'Running';
    }
    runProbe(p, kind, probe, ctx, prof, ip) {
      const st = p.probes[kind] || (p.probes[kind] = { next: p.startedAt + (probe.initialDelaySeconds || 0), fails: 0, ok: false, succ: 0 });
      if (this.now < st.next) return st;
      st.next = this.now + (probe.periodSeconds || 10);
      const c0 = p.spec.containers[0];
      let ok = true, msg = '';
      const listening = this.listening(p);
      if (probe.httpGet) {
        const port = portNum(c0, probe.httpGet.port), path = probe.httpGet.path || '/';
        if (!listening || port !== prof.port) { ok = false; msg = `Get "http://${ip}:${isNaN(port) ? probe.httpGet.port : port}${path}": dial tcp ${ip}:${isNaN(port) ? probe.httpGet.port : port}: connect: connection refused`; }
        else { const r = prof.respond ? prof.respond(ctx, path) : { status: 200 }; if (r.status >= 400) { ok = false; msg = `HTTP probe failed with statuscode: ${r.status}`; } }
      } else if (probe.tcpSocket || probe.grpc) {
        const port = portNum(c0, (probe.tcpSocket || probe.grpc).port);
        if (!listening || port !== prof.port) { ok = false; msg = `dial tcp ${ip}:${port}: connect: connection refused`; }
      } else if (probe.exec) {
        if (prof.port != null && !listening) { ok = false; msg = `command "${(probe.exec.command || []).join(' ')}" exited with 1`; }
      }
      const label = kind[0].toUpperCase() + kind.slice(1);
      if (ok) { st.fails = 0; st.succ++; if (st.succ >= (probe.successThreshold || 1)) st.ok = true; }
      else {
        st.fails++; st.succ = 0;
        this.event(p, 'Warning', 'Unhealthy', `${label} probe failed: ${msg}`, 'kubelet');
        if (st.fails >= (probe.failureThreshold || 3)) { st.ok = false; st.tripped = true; }
      }
      return st;
    }
    runningTick(p, first) {
      const c0 = p.spec.containers[0], prof = this.profileOf(p);
      const ctx = this.appCtx(p);
      if (prof.port != null && this.listening(p) && !p.readyLogged) { p.readyLogged = true; if (prof.readyLogs) p.logs.push(...prof.readyLogs(ctx)); }
      if (prof.kind === 'worker' && !p.readyLogged && ctx.uptime >= prof.startup) { p.readyLogged = true; if (prof.readyLogs) p.logs.push(...prof.readyLogs(ctx)); }
      p.memMi = prof.mem ? Math.round(prof.mem(ctx)) : 10;
      const lim = memLimit(c0);
      if (lim && p.memMi > lim) {
        this.terminate(p, 'OOMKilled', 137);
        this.event(p, 'Warning', 'OOMKilling', `Memory cgroup out of memory: Killed process ${1000 + (fnv1a(p.name) % 30000)} (${c0.name}) total-vm:${Math.round(lim * 1100)}kB, anon-rss:${Math.round(lim * 1024)}kB`, 'kernel-monitor');
        return;
      }
      if (prof.disk) {
        const pvc = this.pvcOfMount(p, prof.disk.mount);
        if (pvc) {
          pvc.usedMi = Math.min(pvc.capacityMi, pvc.usedMi + prof.disk.growMi);
          if (pvc.usedMi >= pvc.capacityMi) { p.logs.push(...prof.diskFullLogs(ctx).slice(-4)); this.terminate(p, 'Error', 1); return; }
        }
      }
      if (first) return;
      const ip = p.ip;
      const sp = c0.startupProbe, lp = c0.livenessProbe, rp = c0.readinessProbe;
      let started = true;
      if (sp) {
        const st = p.probes.startup && p.probes.startup.ok ? p.probes.startup : this.runProbe(p, 'startup', sp, ctx, prof, ip);
        started = st.ok;
        if (!st.ok && st.tripped) {
          this.event(p, 'Normal', 'Killing', `Container ${c0.name} failed startup probe, will be restarted`, 'kubelet');
          if (prof.killLogs) p.logs.push(...prof.killLogs(ctx));
          this.terminate(p, 'Error', 143); return;
        }
      }
      if (started && lp) {
        const st = this.runProbe(p, 'liveness', lp, ctx, prof, ip);
        if (st.tripped) {
          this.event(p, 'Normal', 'Killing', `Container ${c0.name} failed liveness probe, will be restarted`, 'kubelet');
          if (prof.killLogs) p.logs.push(...prof.killLogs(ctx));
          this.terminate(p, 'Error', 143); return;
        }
      }
      if (!started) p.ready = false;
      else if (rp) p.ready = this.runProbe(p, 'readiness', rp, ctx, prof, ip).ok;
      else p.ready = true;
    }
    stepPod(p) {
      if (p.deleting) { if (--p.deleteTimer <= 0) this.del('Pod', p.namespace, p.name); return; }
      if (p.status === 'Failed' || p.status === 'Succeeded') return;
      const restartAllowed = () => p.spec.restartPolicy === 'Always' || (p.spec.restartPolicy === 'OnFailure' && p.lastState && p.lastState.exitCode !== 0);
      switch (p.phase) {
        case 'Pending': p.phase = 'ContainerCreating'; p.timer = 1 + Math.floor(this.rng() * 2); break;
        case 'ContainerCreating': case 'PodInitializing': {
          if (--p.timer > 0) break;
          const { problems } = this.mountFiles(p, Object.assign({ volumeMounts: [] }, { volumeMounts: [].concat(...(p.spec.initContainers || []).concat(p.spec.containers).map(x => x.volumeMounts || [])) }));
          if (problems.length) { problems.forEach(m => this.event(p, 'Warning', 'FailedMount', m, 'kubelet')); p.timer = 3; break; }
          if (!this.pullAll(p)) break;
          if (!this.initStep(p)) break;
          this.startMain(p, false);
          break;
        }
        case 'ErrImagePull':
          p.phase = 'ImagePullBackOff'; p.timer = 3;
          this.event(p, 'Normal', 'BackOff', `Back-off pulling image "${p.spec.containers.concat(p.spec.initContainers || []).find(x => !p.pulled[x.image]).image}"`, 'kubelet');
          this.event(p, 'Warning', 'Failed', 'Error: ImagePullBackOff', 'kubelet');
          break;
        case 'ImagePullBackOff': if (--p.timer <= 0) { p.phase = 'ContainerCreating'; p.timer = 1; this.stepPod(p); } break;
        case 'CreateContainerConfigError': if (--p.timer <= 0) this.startMain(p, false); break;
        case 'Error': case 'Completed': case 'OOMKilled':
          if (p.phase === 'Completed' && p.spec.restartPolicy !== 'Always') { p.status = 'Succeeded'; break; }
          if (!restartAllowed()) { p.status = 'Failed'; break; }
          p.phase = 'CrashLoopBackOff'; p.timer = Math.min(2 + 2 * p.restarts, 10);
          this.event(p, 'Warning', 'BackOff', `Back-off restarting failed container ${p.spec.containers[0].name} in pod ${p.name}_${p.namespace}(${p.uid})`, 'kubelet');
          break;
        case 'CrashLoopBackOff':
          if (--p.timer <= 0) { p.restarts++; p.lastRestartAt = this.now; this.startMain(p, true); }
          break;
        case 'Running': this.runningTick(p, false); break;
        default:
          if (/^Init:/.test(p.phase) && this.initStep(p)) this.startMain(p, false);
          break;
      }
    }

    /* ---------- control loops ---------- */
    nodeLifecycle() {
      for (const n of this.nodes) {
        if (n.ready || this.tickCount - n.notReadyTick < C.EVICT_AFTER) continue;
        for (const p of this.list('Pod')) {
          if (p.node !== n.name || p.deleting || (p.owner && p.owner.kind === 'DaemonSet')) continue;
          p.deleting = true; p.ready = false; p.deleteTimer = 2;
          this.event(p, 'Normal', 'TaintManagerEviction', `Marking for deletion Pod ${p.namespace}/${p.name}`, 'taint-eviction-controller');
          this.activity.controllers++;
        }
      }
    }
    nodeAllocated(n) {
      let cpu = 0, mem = 0, pods = 0;
      for (const p of this.list('Pod')) {
        if (p.node !== n.name || p.status === 'Failed' || p.status === 'Succeeded') continue;
        const r = podRequests(p.spec); cpu += r.cpu; mem += r.mem; pods++;
      }
      return { cpu, mem, pods };
    }
    pvcProblem(p) {
      for (const v of p.spec.volumes || []) {
        if (!v.persistentVolumeClaim) continue;
        const pvc = this.get('PersistentVolumeClaim', p.namespace, v.persistentVolumeClaim.claimName);
        if (!pvc) return `persistentvolumeclaim "${v.persistentVolumeClaim.claimName}" not found`;
        if (pvc.terminating) return `persistentvolumeclaim "${pvc.name}" is being deleted`;
        if (pvc.phase !== 'Bound') return 'pod has unbound immediate PersistentVolumeClaims';
      }
      return null;
    }
    schedule() {
      const pending = this.list('Pod').filter(p => !p.node && !p.deleting && p.status === 'Pending').sort((a, b) => a.created - b.created || (a.name < b.name ? -1 : 1));
      const N = this.nodes.length;
      const failWith = (p, msg, pre) => {
        p.scheduleFail = `0/${N} nodes are available: ${msg}. preemption: 0/${N} nodes are available: ${pre}.`;
        this.event(p, 'Warning', 'FailedScheduling', p.scheduleFail, 'default-scheduler');
      };
      for (const p of pending) {
        if (p.spec.nodeName) { const n = this.node(p.spec.nodeName); if (n) this.bind(p, n); continue; }
        const vp = this.pvcProblem(p);
        if (vp) { failWith(p, vp, `${N} Preemption is not helpful for scheduling`); continue; }
        const req = podRequests(p.spec);
        const why = {}, fits = [];
        const add = w => { why[w] = (why[w] || 0) + 1; };
        for (const n of this.nodes) {
          const a = this.nodeAllocated(n);
          const taint = (n.taints || []).find(t => (t.effect === 'NoSchedule' || t.effect === 'NoExecute') && !tolerates(p.spec.tolerations, t));
          if (!n.ready && !tolerates(p.spec.tolerations, { key: 'node.kubernetes.io/unreachable', effect: 'NoSchedule' })) add('node(s) had untolerated taint {node.kubernetes.io/unreachable: }');
          else if (n.unschedulable && !tolerates(p.spec.tolerations, { key: 'node.kubernetes.io/unschedulable', effect: 'NoSchedule' })) add('node(s) were unschedulable');
          else if (taint) add(`node(s) had untolerated taint {${taint.key}: ${taint.value || ''}}`);
          else if (Object.keys(p.spec.nodeSelector || {}).some(k => n.labels[k] !== String(p.spec.nodeSelector[k]))) add("node(s) didn't match Pod's node affinity/selector");
          else if (n.memPressure && p.qos === 'BestEffort') add('node(s) had untolerated taint {node.kubernetes.io/memory-pressure: }');
          else {
            const short = [];
            if (a.pods + 1 > n.maxPods) short.push('Too many pods');
            if (a.cpu + req.cpu > n.allocCpu) short.push('Insufficient cpu');
            if (a.mem + req.mem > n.allocMem) short.push('Insufficient memory');
            if (short.length) short.forEach(add);
            else fits.push(n);
          }
        }
        if (!fits.length) {
          const parts = Object.keys(why).sort().map(w => `${why[w]} ${w}`);
          const insufficient = Object.keys(why).filter(w => /^Insufficient|Too many/.test(w)).reduce((s, w) => Math.max(s, why[w]), 0);
          failWith(p, parts.join(', '), insufficient ? `${insufficient} No preemption victims found for incoming pod, ${N - insufficient} Preemption is not helpful for scheduling` : `${N} Preemption is not helpful for scheduling`);
          continue;
        }
        const g = this.workloadOf(p);
        const score = n => {
          const on = this.list('Pod').filter(q => q.node === n.name && this.active(q) && !this.isSystemNs(q.namespace));
          const a = this.nodeAllocated(n);
          return [on.filter(q => q.namespace === p.namespace && this.workloadOf(q) === g).length, a.cpu / n.allocCpu + a.mem / n.allocMem];
        };
        fits.sort((a, b) => { const sa = score(a), sb = score(b); return sa[0] - sb[0] || sa[1] - sb[1] || (a.name < b.name ? -1 : 1); });
        this.bind(p, fits[0]);
      }
    }
    kubelet() {
      for (const n of this.nodes) {
        if (!n.ready) continue;
        for (const p of this.list('Pod')) if (p.node === n.name) this.stepPod(p);
      }
    }
    oomScore(p, n) {
      if (p.qos === 'BestEffort') return 1000;
      if (p.qos === 'Guaranteed') return -997;
      return Math.max(2, Math.min(999, Math.round(1000 - (1000 * podRequests(p.spec).mem) / n.memMi)));
    }
    nodePressure() {
      for (const n of this.nodes) {
        if (!n.ready) continue;
        const running = this.list('Pod').filter(p => p.node === n.name && p.phase === 'Running' && !p.deleting);
        let usage = C.SYSTEM_RESERVED_MEM + running.reduce((s, p) => s + p.memMi, 0);
        if (usage > n.memMi) {
          const victim = running.slice().sort((a, b) => this.oomScore(b, n) - this.oomScore(a, n) || b.memMi - a.memMi)[0];
          if (victim) {
            this.event(n, 'Warning', 'SystemOOM', `System OOM encountered, victim process: ${victim.spec.containers[0].name}, pid: ${2000 + (fnv1a(victim.name + this.tickCount) % 60000)}`, 'kubelet');
            this.event(victim, 'Warning', 'OOMKilling', `Out of memory: Killed process (${victim.spec.containers[0].name}) oom_score_adj=${this.oomScore(victim, n)}`, 'kernel-monitor');
            usage -= victim.memMi;
            this.terminate(victim, 'OOMKilled', 137);
          }
        }
        n.memUsage = usage;
        const avail = n.memMi - usage;
        const pressure = avail < C.EVICTION_THRESHOLD;
        if (pressure !== n.memPressure) {
          n.memPressure = pressure;
          this.event(n, 'Normal', pressure ? 'NodeHasInsufficientMemory' : 'NodeHasSufficientMemory', `Node ${n.name} status is now: ${pressure ? 'NodeHasInsufficientMemory' : 'NodeHasSufficientMemory'}`, 'kubelet');
        }
        if (pressure && this.tickCount % 3 === 0) {
          const cands = running.filter(p => p.phase === 'Running' && !this.isSystemNs(p.namespace)).map(p => ({ p, over: p.memMi - podRequests(p.spec).mem })).sort((a, b) => (b.over > 0) - (a.over > 0) || b.over - a.over);
          const v = cands[0];
          if (v) {
            const p = v.p, req = podRequests(p.spec).mem;
            this.event(n, 'Warning', 'EvictionThresholdMet', 'Attempting to reclaim memory', 'kubelet');
            p.message = `The node was low on resource: memory. Threshold quantity: ${C.EVICTION_THRESHOLD}Mi, available: ${Math.max(0, Math.round(avail))}Mi. Container ${p.spec.containers[0].name} was using ${p.memMi}Mi, request is ${req ? Q.fmtMem(req) : '0'}, has larger consumption of memory.`;
            this.event(p, 'Warning', 'Evicted', p.message, 'kubelet');
            p.status = 'Failed'; p.phase = 'Evicted'; p.reason = 'Evicted'; p.ready = false; p.memMi = 0;
            this.activity.controllers++;
          }
        }
      }
    }
    scaleRS(rs, to, d) {
      if (rs.replicas === to) return;
      const verb = to > rs.replicas ? 'up' : 'down';
      this.event(d, 'Normal', 'ScalingReplicaSet', `Scaled ${verb} replica set ${rs.name} from ${rs.replicas} to ${to}`, 'deployment-controller');
      rs.replicas = to; this.activity.controllers++; this.activity.etcd++;
    }
    intOrPct(v, total, up) {
      if (v == null) return null;
      const s = String(v);
      if (s.endsWith('%')) { const x = (parseFloat(s) / 100) * total; return up ? Math.ceil(x) : Math.floor(x); }
      return Number(s) || 0;
    }
    reconcileDeployments() {
      for (const d of this.list('Deployment')) {
        if (d.paused) continue;
        const hash = this.templateHash(d.template);
        let all = this.rsOf(d);
        let cur = all.find(rs => rs.hash === hash);
        const maxRev = all.reduce((m, rs) => Math.max(m, rs.revision), 0);
        if (!cur) {
          const others = all.reduce((s, rs) => s + rs.replicas, 0);
          const tl = Object.assign({}, d.template.labels, { 'pod-template-hash': hash });
          cur = this.put(this.obj('ReplicaSet', {
            name: d.name + '-' + hash, namespace: d.namespace, owner: d.name, hash, revision: maxRev + 1, replicas: 0, labels: tl,
            selector: Object.assign({}, d.selector, { 'pod-template-hash': hash }), changeCause: d.changeCause,
            template: { labels: tl, annotations: clone(d.template.annotations), spec: clone(d.template.spec) }, failedCreate: null,
          }));
          if (others === 0) this.scaleRS(cur, d.replicas, d);
          d.progressTick = this.tickCount; d.deadlineExceeded = false; d.lastNewAvailable = 0;
          all = this.rsOf(d);
        } else if (cur.revision < maxRev) {
          cur.revision = maxRev + 1; cur.changeCause = d.changeCause; d.progressTick = this.tickCount; d.deadlineExceeded = false;
        }
        d.revision = cur.revision;
        const old = all.filter(rs => rs !== cur).sort((a, b) => a.revision - b.revision);
        const R = d.replicas;
        if (old.every(rs => rs.replicas === 0) || R === 0) {
          if (d.strategy.type === 'Recreate' && old.some(rs => this.podsOfRS(rs, true).length)) { /* wait for old pods to go */ }
          else if (cur.replicas !== R) this.scaleRS(cur, R, d);
          if (R === 0) old.forEach(rs => this.scaleRS(rs, 0, d));
        } else if (d.strategy.type === 'Recreate') {
          old.forEach(rs => this.scaleRS(rs, 0, d));
        } else {
          const ru = (d.strategy && d.strategy.rollingUpdate) || {};
          const maxSurge = Math.max(0, this.intOrPct(ru.maxSurge == null ? '25%' : ru.maxSurge, R, true));
          let maxUnav = Math.max(0, this.intOrPct(ru.maxUnavailable == null ? '25%' : ru.maxUnavailable, R, false));
          if (maxSurge === 0 && maxUnav === 0) maxUnav = 1;
          const total = () => all.reduce((s, rs) => s + rs.replicas, 0);
          if (cur.replicas < R) {
            const allowed = R + maxSurge - total();
            if (allowed > 0) this.scaleRS(cur, cur.replicas + Math.min(allowed, R - cur.replicas), d);
          } else if (cur.replicas > R) this.scaleRS(cur, R, d);
          const minAvailable = R - maxUnav;
          let cleanup = total() - minAvailable - (cur.replicas - this.availableOf(cur));
          for (const rs of old) {
            if (cleanup <= 0) break;
            const unhealthy = rs.replicas - this.availableOf(rs);
            if (unhealthy <= 0) continue;
            const n = Math.min(unhealthy, cleanup);
            this.scaleRS(rs, rs.replicas - n, d); cleanup -= n;
          }
          let canDown = all.reduce((s, rs) => s + this.availableOf(rs), 0) - minAvailable;
          for (const rs of old) {
            if (canDown <= 0) break;
            if (!rs.replicas) continue;
            const n = Math.min(rs.replicas, canDown);
            this.scaleRS(rs, rs.replicas - n, d); canDown -= n;
          }
          if (cur.replicas < R && total() < R + maxSurge) { const allowed = R + maxSurge - total(); if (allowed > 0) this.scaleRS(cur, cur.replicas + Math.min(allowed, R - cur.replicas), d); }
        }
        const avail = this.availableOf(cur);
        if (avail > d.lastNewAvailable) d.progressTick = this.tickCount;
        d.lastNewAvailable = avail;
        if (this.rolloutComplete(d)) { d.progressTick = this.tickCount; d.deadlineExceeded = false; }
        else if (!d.deadlineExceeded && this.tickCount - d.progressTick > C.PROGRESS_DEADLINE) {
          d.deadlineExceeded = true;
          this.event(d, 'Warning', 'ProgressDeadlineExceeded', `ReplicaSet "${cur.name}" has timed out progressing.`, 'deployment-controller');
        }
      }
    }
    reconcileReplicaSets() {
      const rankPhase = p => (!p.node ? 0 : p.phase === 'Running' ? 3 : p.phase === 'Unknown' ? 2 : 1);
      for (const rs of this.list('ReplicaSet')) {
        for (const p of this.podsOfRS(rs)) if (!matches(p.labels, rs.selector)) p.owner = null;
        const pods = this.podsOfRS(rs);
        const diff = rs.replicas - pods.length;
        if (diff > 0) {
          for (let i = 0; i < diff; i++) {
            let name; do { name = rs.name + '-' + this.rand(5); } while (this.get('Pod', rs.namespace, name));
            const err = this.admitPod(rs.namespace, name, rs.template.spec);
            if (err) {
              rs.failedCreate = err;
              this.event(rs, 'Warning', 'FailedCreate', 'Error creating: ' + err, 'replicaset-controller');
              break;
            }
            rs.failedCreate = null;
            this.makePod({ ns: rs.namespace, name, labels: rs.template.labels, annotations: rs.template.annotations, spec: rs.template.spec, owner: { kind: 'ReplicaSet', name: rs.name } });
            this.event(rs, 'Normal', 'SuccessfulCreate', `Created pod: ${name}`, 'replicaset-controller');
            this.activity.controllers++;
          }
        } else {
          if (diff === 0) rs.failedCreate = null;
          if (diff < 0) {
            pods.sort((a, b) => rankPhase(a) - rankPhase(b) || (a.ready ? 1 : 0) - (b.ready ? 1 : 0) || b.created - a.created);
            for (const p of pods.slice(0, -diff)) {
              this.markDeleting(p);
              this.event(rs, 'Normal', 'SuccessfulDelete', `Deleted pod: ${p.name}`, 'replicaset-controller');
              this.activity.controllers++;
            }
          }
        }
      }
    }
    reconcileDaemonSets() {
      for (const ds of this.list('DaemonSet')) {
        for (const n of this.nodes) {
          if (!n.ready) continue;
          const has = this.list('Pod', ds.namespace).some(p => p.owner && p.owner.kind === 'DaemonSet' && p.owner.name === ds.name && p.node === n.name && !p.deleting);
          if (!has) {
            const p = this.makePod({ ns: ds.namespace, prefix: ds.name + '-', labels: ds.template.labels, spec: Object.assign(clone(ds.template.spec), { nodeName: n.name }), owner: { kind: 'DaemonSet', name: ds.name } });
            this.event(ds, 'Normal', 'SuccessfulCreate', `Created pod: ${p.name}`, 'daemonset-controller');
          }
        }
      }
    }
    reconcileStorage() {
      for (const pvc of this.list('PersistentVolumeClaim')) {
        const want = Q.mem(pvc.spec.resources.requests.storage);
        if (pvc.terminating) {
          const inUse = this.list('Pod', pvc.namespace).some(p => this.active(p) && (p.spec.volumes || []).some(v => v.persistentVolumeClaim && v.persistentVolumeClaim.claimName === pvc.name));
          if (!inUse) { this.del('PersistentVolumeClaim', pvc.namespace, pvc.name); if (pvc.volumeName) this.del('PersistentVolume', '', pvc.volumeName); }
          continue;
        }
        if (pvc.phase === 'Pending') {
          const scName = pvc.spec.storageClassName != null ? pvc.spec.storageClassName : (this.list('StorageClass').find(s => s.isDefault) || {}).name;
          const sc = scName ? this.get('StorageClass', '', scName) : null;
          if (!sc) {
            if (scName) this.event(pvc, 'Warning', 'ProvisioningFailed', `storageclass.storage.k8s.io "${scName}" not found`, 'persistentvolume-controller');
            else this.event(pvc, 'Normal', 'FailedBinding', 'no persistent volumes available for this claim and no storage class is set', 'persistentvolume-controller');
            continue;
          }
          if (pvc.provisionTimer == null) { pvc.provisionTimer = 1; this.event(pvc, 'Normal', 'Provisioning', `External provisioner is provisioning volume for claim "${pvc.namespace}/${pvc.name}"`, `${sc.provisioner}_ebs-csi-controller`); continue; }
          if (--pvc.provisionTimer > 0) continue;
          const pv = this.put(this.obj('PersistentVolume', { name: 'pvc-' + pvc.uid, capacityMi: want, accessModes: pvc.spec.accessModes, reclaimPolicy: sc.reclaimPolicy, storageClass: sc.name, claim: { namespace: pvc.namespace, name: pvc.name }, status: 'Bound' }));
          pvc.phase = 'Bound'; pvc.volumeName = pv.name; pvc.capacityMi = want; pvc.storageClassResolved = sc.name;
          this.event(pvc, 'Normal', 'ProvisioningSucceeded', `Successfully provisioned volume ${pv.name}`, `${sc.provisioner}_ebs-csi-controller`);
          continue;
        }
        if (want > pvc.capacityMi) {
          const pv = this.get('PersistentVolume', '', pvc.volumeName);
          if (!pvc.resizing) { pvc.resizing = 2; this.event(pvc, 'Normal', 'Resizing', `External resizer is resizing volume ${pvc.volumeName}`, 'external-resizer ebs.csi.aws.com'); continue; }
          if (--pvc.resizing > 0) { if (pvc.resizing === 1) { if (pv) pv.capacityMi = want; this.event(pvc, 'Normal', 'FileSystemResizeRequired', 'Require file system resize of volume on node', 'external-resizer ebs.csi.aws.com'); } continue; }
          pvc.capacityMi = want; pvc.resizing = null;
          this.event(pvc, 'Normal', 'FileSystemResizeSuccessful', `MountVolume.NodeExpandVolume succeeded for volume "${pvc.volumeName}"`, 'kubelet');
        }
      }
    }
    podCpu(p) {
      if (p.phase !== 'Running' || p.deleting) return 0;
      const prof = this.profileOf(p);
      if (!prof) return 2;
      const base = (prof.cpuBase || 2) + (fnv1a(p.name) % 3);
      return Math.round(base + (p.servedRps || 0) * (prof.cpuPerReq || 0));
    }
    /* ---------- customer traffic: every flow is real requests through the same network model ---------- */
    computeTraffic() {
      this.list('Pod').forEach(p => { p.servedRps = 0; });
      for (const f of this.flows) {
        const u = this.parseUrl(f.url);
        let backends = [], blocked = null;
        const route = this.ingressRoute(u.host, u.path);
        const ctrl = this.ingressController();
        if (!ctrl) blocked = 'ingress controller down';
        else if (!route) blocked = 'no Ingress rule (404)';
        else {
          const svc = this.get('Service', route.ing.namespace, route.path.backend.name);
          const sp = svc && svc.ports.find(p => (route.path.backend.portName ? p.name === route.path.backend.portName : p.port === Number(route.path.backend.port)));
          if (!svc) blocked = `Service ${route.path.backend.name} not found (503)`;
          else if (!sp) blocked = `Service ${svc.name} has no port ${route.path.backend.portName || route.path.backend.port} (503)`;
          else {
            const eps = this.endpointsFor(svc, sp);
            if (!eps.length) blocked = `Service ${svc.name} has no ready endpoints (503)`;
            backends = eps.map(p => {
              const r = this.connectPod(this.srcOf(ctrl), p, this.targetPortOf(p, sp), { scheme: 'http', path: u.path }, 0);
              return { p, ok: r.ok && r.status < 400, why: r.ok ? (r.status >= 400 ? `HTTP ${r.status}` : null) : r.kind === 'timeout' ? 'upstream timed out (504)' : 'connection refused (502)' };
            });
          }
        }
        const good = backends.filter(b => b.ok);
        const share = backends.length ? good.length / backends.length : 0;
        const cap = good.length * f.perPod;
        const served = Math.min(Math.round(f.rps * share), cap);
        good.forEach(b => { b.p.servedRps = served / good.length; });
        const failed = f.rps - served;
        let cause = blocked;
        if (!cause && backends.length && good.length < backends.length) cause = backends.find(b => !b.ok).why;
        if (!cause && failed > 0) cause = 'not enough ready pods for the load';
        this.flowStats[f.id] = { rps: f.rps, served, failed, ok: f.rps ? served / f.rps : 1, cause, backends: backends.length, healthy: good.length };
        this.impact.total += f.rps * C.TICK_SECONDS; this.impact.failed += failed * C.TICK_SECONDS;
      }
    }
    addFlow(f) { this.flows.push(Object.assign({ perPod: 100 }, f)); }
    flow(id) { return this.flows.find(f => f.id === id) || null; }
    reconcileHPAs() {
      if (this.tickCount % C.HPA_SYNC !== 0) return;
      for (const h of this.list('HorizontalPodAutoscaler')) {
        const d = this.get('Deployment', h.namespace, h.target.name);
        if (!d) { h.current = null; h.problem = `deployments/scale.apps "${h.target.name}" not found`; continue; }
        const pods = this.podsOfDeployment(d).filter(p => p.ready);
        const noReq = pods.concat(this.podsOfDeployment(d)).find(p => p.spec.containers.some(ct => !(ct.resources && ((ct.resources.requests && ct.resources.requests.cpu) || (ct.resources.limits && ct.resources.limits.cpu)))));
        if (noReq) {
          const ct = noReq.spec.containers.find(x => !(x.resources && ((x.resources.requests && x.resources.requests.cpu) || (x.resources.limits && x.resources.limits.cpu))));
          h.current = null; h.problem = `failed to get cpu utilization: missing request for cpu in container ${ct.name} of Pod ${noReq.name}`;
          this.event(h, 'Warning', 'FailedGetResourceMetric', h.problem, 'horizontal-pod-autoscaler');
          this.event(h, 'Warning', 'FailedComputeMetricsReplicas', `invalid metrics (1 invalid out of 1), first error is: failed to get cpu resource metric value: ${h.problem}`, 'horizontal-pod-autoscaler');
          continue;
        }
        if (!pods.length) { h.current = null; h.problem = 'no ready pods'; continue; }
        h.problem = null;
        const util = Math.round(pods.reduce((s, p) => s + this.podCpu(p) / podRequests(p.spec).cpu, 0) / pods.length * 100);
        h.current = util;
        const cur = d.replicas;
        const ratio = util / h.targetCPU;
        let want = Math.abs(ratio - 1) > 0.1 ? Math.ceil(pods.length * ratio) : cur;
        want = Math.max(h.min, Math.min(h.max, want));
        want = Math.min(want, Math.max(cur * 2, cur + 4));
        h.recs = (h.recs || []).concat(want).slice(-C.HPA_DOWN_WINDOW);
        if (want < cur) want = Math.min(cur, Math.max.apply(null, h.recs));
        if (want !== cur) {
          const reason = want > cur ? 'cpu resource utilization (percentage of request) above target' : 'All metrics below target';
          d.replicas = want;
          this.event(h, 'Normal', 'SuccessfulRescale', `New size: ${want}; reason: ${reason}`, 'horizontal-pod-autoscaler');
          this.activity.controllers++;
        }
      }
    }
    pdbStatus(pdb) {
      const pods = this.list('Pod', pdb.namespace).filter(p => this.active(p) && selects(pdb.selector, p.labels));
      const healthy = pods.filter(p => p.ready).length, expected = pods.length;
      let desired;
      if (pdb.minAvailable != null) desired = this.intOrPct(pdb.minAvailable, expected, true);
      else desired = expected - this.intOrPct(pdb.maxUnavailable, expected, true);
      return { expected, healthy, desired, allowed: Math.max(0, healthy - desired) };
    }
    reconcileMisc() {
      for (const s of this.list('Service')) if (s.type === 'LoadBalancer' && !s.externalIP && --s.lbTimer <= 0) s.externalIP = '203.0.113.' + (10 + Math.floor(this.rng() * 200));
      for (const [name, ns] of this.namespaces) if (ns.phase === 'Terminating' && !this.list('Pod', name).length) this.namespaces.delete(name);
    }
    step() {
      this.tickCount++; this.now += C.TICK_SECONDS; this.baseTime += C.TICK_SECONDS * 1000;
      this.nodeLifecycle();
      this.reconcileStorage();
      this.schedule();
      this.kubelet();
      this.nodePressure();
      this.reconcileDeployments();
      this.reconcileReplicaSets();
      this.reconcileDaemonSets();
      this.computeTraffic();
      this.reconcileHPAs();
      this.reconcileMisc();
    }

    /* ---------- node operations ---------- */
    failNode(name) {
      const n = this.node(name); if (!n || !n.ready) return;
      n.ready = false; n.notReadyTick = this.tickCount;
      this.event(n, 'Normal', 'NodeNotReady', `Node ${name} status is now: NodeNotReady`, 'node-controller');
      for (const p of this.list('Pod')) if (p.node === name && !p.deleting) { p.before = p.phase; p.phase = 'Unknown'; p.ready = false; }
    }
    recoverNode(name) {
      const n = this.node(name); if (!n || n.ready) return;
      n.ready = true;
      this.event(n, 'Normal', 'NodeReady', `Node ${name} status is now: NodeReady`, 'node-controller');
      for (const p of this.list('Pod')) if (p.node === name && p.phase === 'Unknown') { p.phase = p.before || 'Running'; }
    }

    /* ---------- deletion with cascading ---------- */
    deleteObject(kind, ns, name, force) {
      if (kind === 'Pod') { const p = this.get('Pod', ns, name); if (p) this.markDeleting(p, force); return; }
      if (kind === 'Namespace') {
        const n = this.namespaces.get(name); n.phase = 'Terminating';
        KINDS.filter(k => !CLUSTER_KINDS.includes(k)).forEach(k => this.list(k, name).forEach(o => (k === 'Pod' ? this.markDeleting(o, force) : this.del(k, name, o.name))));
        return;
      }
      const o = this.get(kind, ns, name); if (!o) return;
      if (kind === 'PersistentVolumeClaim') { o.terminating = true; this.reconcileStorage(); return; }
      this.del(kind, ns, name);
      if (kind === 'Deployment') this.rsOf(o).forEach(rs => this.deleteObject('ReplicaSet', ns, rs.name, force));
      if (kind === 'ReplicaSet') this.podsOfRS(o, true).forEach(p => this.markDeleting(p, force));
      if (kind === 'DaemonSet') this.list('Pod', ns).filter(p => p.owner && p.owner.kind === 'DaemonSet' && p.owner.name === name).forEach(p => this.markDeleting(p, force));
    }
  }

  K.Cluster = Cluster;
  K.sim = { matches, selects, clone, stable, fnv1a, SYSTEM_NS, KINDS, CLUSTER_KINDS, API_GROUP, podRequests, qosOf, memLimit, portNum, tolerates, blankSpec, containerSpec,
    parseImage: A.parseImage, resolveImage: A.resolveImage, nameFromImage: A.nameFromImage };
})(window.K = window.K || {});

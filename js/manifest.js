/* manifest.js — converts between simulator objects and Kubernetes YAML, and implements
   `kubectl apply` / `create -f` with the validation errors a real API server returns:
   unknown fields, bad quantities, immutable fields, selector mismatches and admission errors. */
(function (K) {
  'use strict';
  const { clone, stable, selects, CLUSTER_KINDS } = K.sim;
  const Q = K.qty;

  const API = {
    Pod: 'v1', Service: 'v1', ConfigMap: 'v1', Secret: 'v1', Namespace: 'v1', ServiceAccount: 'v1', PersistentVolumeClaim: 'v1', PersistentVolume: 'v1', ResourceQuota: 'v1', Node: 'v1',
    Deployment: 'apps/v1', ReplicaSet: 'apps/v1', DaemonSet: 'apps/v1', HorizontalPodAutoscaler: 'autoscaling/v2',
    Ingress: 'networking.k8s.io/v1', NetworkPolicy: 'networking.k8s.io/v1', Role: 'rbac.authorization.k8s.io/v1', RoleBinding: 'rbac.authorization.k8s.io/v1',
    ClusterRole: 'rbac.authorization.k8s.io/v1', ClusterRoleBinding: 'rbac.authorization.k8s.io/v1', StorageClass: 'storage.k8s.io/v1', PodDisruptionBudget: 'policy/v1',
  };
  const RES = {
    Pod: 'pod', Service: 'service', ConfigMap: 'configmap', Secret: 'secret', Namespace: 'namespace', ServiceAccount: 'serviceaccount', PersistentVolumeClaim: 'persistentvolumeclaim',
    PersistentVolume: 'persistentvolume', ResourceQuota: 'resourcequota', Node: 'node', Deployment: 'deployment.apps', ReplicaSet: 'replicaset.apps', DaemonSet: 'daemonset.apps',
    HorizontalPodAutoscaler: 'horizontalpodautoscaler.autoscaling', Ingress: 'ingress.networking.k8s.io', NetworkPolicy: 'networkpolicy.networking.k8s.io',
    Role: 'role.rbac.authorization.k8s.io', RoleBinding: 'rolebinding.rbac.authorization.k8s.io', ClusterRole: 'clusterrole.rbac.authorization.k8s.io',
    ClusterRoleBinding: 'clusterrolebinding.rbac.authorization.k8s.io', StorageClass: 'storageclass.storage.k8s.io', PodDisruptionBudget: 'poddisruptionbudget.policy',
  };
  const PLURAL = {};
  Object.keys(RES).forEach(k => { const r = RES[k]; const i = r.indexOf('.'); PLURAL[k] = i < 0 ? r + 's' : r.slice(0, i) + 's' + r.slice(i); });
  PLURAL.Ingress = 'ingresses.networking.k8s.io'; PLURAL.NetworkPolicy = 'networkpolicies.networking.k8s.io'; PLURAL.PodDisruptionBudget = 'poddisruptionbudgets.policy';
  PLURAL.StorageClass = 'storageclasses.storage.k8s.io'; PLURAL.ResourceQuota = 'resourcequotas';
  const UNSUPPORTED = ['StatefulSet', 'Job', 'CronJob', 'LimitRange', 'Gateway', 'HTTPRoute', 'PriorityClass', 'VolumeSnapshot', 'CustomResourceDefinition'];

  const b64e = s => (typeof btoa === 'function' ? btoa(unescape(encodeURIComponent(s))) : Buffer.from(s, 'utf8').toString('base64'));
  const b64d = s => (typeof atob === 'function' ? decodeURIComponent(escape(atob(s))) : Buffer.from(s, 'base64').toString('utf8'));
  K.b64 = { encode: b64e, decode: b64d };

  /* ---------- output ---------- */
  const PROBES = ['startupProbe', 'livenessProbe', 'readinessProbe'];
  function containerOut(ct) {
    const o = { name: ct.name, image: ct.image };
    ['command', 'args'].forEach(k => { if (ct[k]) o[k] = clone(ct[k]); });
    if (ct.env && ct.env.length) o.env = clone(ct.env);
    if (ct.envFrom && ct.envFrom.length) o.envFrom = clone(ct.envFrom);
    if (ct.ports && ct.ports.length) o.ports = ct.ports.map(p => Object.assign({ containerPort: p.containerPort }, p.name ? { name: p.name } : {}, { protocol: p.protocol || 'TCP' }));
    o.resources = clone(ct.resources || {});
    PROBES.forEach(k => { if (ct[k]) o[k] = clone(ct[k]); });
    if (ct.volumeMounts && ct.volumeMounts.length) o.volumeMounts = clone(ct.volumeMounts);
    Object.keys(ct).forEach(k => { if (!(k in o) && !['env', 'envFrom', 'ports', 'volumeMounts'].includes(k)) o[k] = clone(ct[k]); });
    return o;
  }
  function podSpecOut(spec, full) {
    const o = { containers: spec.containers.map(containerOut) };
    if (spec.initContainers && spec.initContainers.length) o.initContainers = spec.initContainers.map(containerOut);
    if (spec.imagePullSecrets && spec.imagePullSecrets.length) o.imagePullSecrets = clone(spec.imagePullSecrets);
    if (spec.nodeSelector && Object.keys(spec.nodeSelector).length) o.nodeSelector = clone(spec.nodeSelector);
    if (spec.nodeName) o.nodeName = spec.nodeName;
    o.restartPolicy = spec.restartPolicy || 'Always';
    if (full || (spec.serviceAccountName && spec.serviceAccountName !== 'default')) o.serviceAccountName = spec.serviceAccountName || 'default';
    if (spec.tolerations && spec.tolerations.length) o.tolerations = clone(spec.tolerations);
    if (spec.volumes && spec.volumes.length) o.volumes = clone(spec.volumes);
    Object.keys(spec).forEach(k => { if (!(k in o) && !['initContainers', 'imagePullSecrets', 'nodeSelector', 'tolerations', 'volumes', 'serviceAccountName', 'nodeName'].includes(k)) o[k] = clone(spec[k]); });
    return o;
  }
  function meta(c, o, clean) {
    const m = { name: o.name };
    if (o.namespace && !CLUSTER_KINDS.includes(o.kind) && o.kind !== 'Namespace') m.namespace = o.namespace;
    if (o.labels && Object.keys(o.labels).length) m.labels = clone(o.labels);
    if (o.annotations && Object.keys(o.annotations).length) m.annotations = clone(o.annotations);
    if (!clean) { m.creationTimestamp = c.ts(o.created); m.uid = o.uid; }
    return m;
  }
  const selOut = s => (s && (s.matchLabels || s.matchExpressions) ? clone(s) : { matchLabels: clone(s || {}) });
  function containerState(c, p) {
    const st = p.deleting ? 'Terminating' : p.phase;
    if (st === 'Running') return { running: { startedAt: c.ts(p.startedAt) } };
    if (['Error', 'OOMKilled', 'Completed'].includes(st) && p.lastState) return { terminated: { exitCode: p.lastState.exitCode, reason: p.lastState.reason, startedAt: c.ts(p.lastState.startedAt), finishedAt: c.ts(p.lastState.finishedAt) } };
    const msg = st === 'CrashLoopBackOff' ? `back-off ${Math.min(10 * Math.pow(2, Math.max(0, p.restarts - 1)), 300)}s restarting failed container=${p.spec.containers[0].name} pod=${p.name}_${p.namespace}(${p.uid})` : undefined;
    return { waiting: Object.assign({ reason: /^Init:|PodInitializing/.test(st) ? 'PodInitializing' : st === 'Pending' ? 'ContainerCreating' : st }, msg ? { message: msg } : {}) };
  }
  function podStatusOut(c, p) {
    const k8sPhase = p.status === 'Failed' ? 'Failed' : p.status === 'Succeeded' ? 'Succeeded' : !p.node || /ContainerCreating|Pending|Init:|PodInitializing|ErrImagePull|ImagePullBackOff|InvalidImageName|CreateContainerConfigError/.test(p.phase) ? 'Pending' : 'Running';
    const out = { phase: k8sPhase };
    if (p.reason) out.reason = p.reason;
    if (p.message) out.message = p.message;
    out.conditions = [
      { type: 'PodScheduled', status: p.node ? 'True' : 'False', reason: p.node ? undefined : 'Unschedulable', message: p.node ? undefined : p.scheduleFail || undefined },
      { type: 'Initialized', status: p.node && !/^Init:/.test(p.phase) ? 'True' : 'False' },
      { type: 'ContainersReady', status: p.ready ? 'True' : 'False' },
      { type: 'Ready', status: p.ready ? 'True' : 'False' },
    ].map(x => JSON.parse(JSON.stringify(x)));
    if (p.node) { out.hostIP = c.node(p.node) ? c.node(p.node).ip : undefined; out.podIP = p.ip; }
    out.qosClass = p.qos;
    if (p.status !== 'Failed') {
      out.containerStatuses = p.spec.containers.map((ct, i) => {
        const s = { name: ct.name, image: ct.image, ready: !!p.ready, restartCount: i === 0 ? p.restarts : 0, started: p.phase === 'Running', state: i === 0 ? containerState(c, p) : (p.phase === 'Running' ? { running: { startedAt: c.ts(p.startedAt) } } : { waiting: { reason: 'PodInitializing' } }) };
        if (i === 0 && p.lastState && p.restarts) s.lastState = { terminated: { exitCode: p.lastState.exitCode, reason: p.lastState.reason, startedAt: c.ts(p.lastState.startedAt), finishedAt: c.ts(p.lastState.finishedAt) } };
        return s;
      });
    }
    return out;
  }

  /* Build a manifest. clean=true gives what you'd write by hand (dry-run / edit style). */
  function toManifest(c, o, clean) {
    const kind = o.kind;
    const out = { apiVersion: API[kind] || 'v1', kind, metadata: meta(c, o, clean) };
    switch (kind) {
      case 'Deployment':
        if (!clean) out.metadata.annotations = Object.assign({}, out.metadata.annotations, { 'deployment.kubernetes.io/revision': String(o.revision || 1) });
        out.spec = { replicas: o.replicas, selector: { matchLabels: clone(o.selector) }, strategy: clone(o.strategy), template: { metadata: { labels: clone(o.template.labels) }, spec: podSpecOut(o.template.spec, !clean) } };
        if (o.template.annotations && Object.keys(o.template.annotations).length) out.spec.template.metadata.annotations = clone(o.template.annotations);
        if (o.paused) out.spec.paused = true;
        if (!clean) { const s = c.deploymentStatus(o); out.status = { availableReplicas: s.available, observedGeneration: o.revision || 1, readyReplicas: s.ready, replicas: s.replicas, updatedReplicas: s.updated, unavailableReplicas: s.unavailable || undefined }; }
        break;
      case 'ReplicaSet': {
        out.metadata.ownerReferences = [{ apiVersion: 'apps/v1', kind: 'Deployment', name: o.owner, controller: true }];
        out.metadata.annotations = { 'deployment.kubernetes.io/revision': String(o.revision) };
        out.spec = { replicas: o.replicas, selector: { matchLabels: clone(o.selector) }, template: { metadata: { labels: clone(o.template.labels) }, spec: podSpecOut(o.template.spec, true) } };
        const pods = c.podsOfRS(o);
        out.status = { availableReplicas: pods.filter(p => p.ready).length, readyReplicas: pods.filter(p => p.ready).length, replicas: pods.length };
        if (o.failedCreate) out.status.conditions = [{ type: 'ReplicaFailure', status: 'True', reason: 'FailedCreate', message: o.failedCreate }];
        break;
      }
      case 'Pod':
        if (o.owner && !clean) out.metadata.ownerReferences = [{ apiVersion: 'apps/v1', kind: o.owner.kind, name: o.owner.name, controller: true }];
        out.spec = podSpecOut(o.spec, !clean);
        if (o.node && !clean) out.spec.nodeName = o.node;
        if (!clean) out.status = podStatusOut(c, o);
        break;
      case 'DaemonSet':
        out.spec = { selector: { matchLabels: clone(o.selector) }, template: { metadata: { labels: clone(o.template.labels) }, spec: podSpecOut(o.template.spec, true) } };
        break;
      case 'Service':
        out.spec = { ports: o.ports.map(p => { const q = {}; if (p.name) q.name = p.name; if (p.nodePort && !clean) q.nodePort = p.nodePort; q.port = p.port; q.protocol = p.protocol; q.targetPort = p.targetPort; return q; }), type: o.type };
        if (o.selector) out.spec.selector = clone(o.selector);
        if (!clean) { out.spec.clusterIP = o.clusterIP; out.status = { loadBalancer: o.externalIP ? { ingress: [{ ip: o.externalIP }] } : {} }; }
        break;
      case 'ConfigMap': out.data = clone(o.data); break;
      case 'Secret': out.data = {}; Object.keys(o.data).forEach(k => { out.data[k] = b64e(o.data[k]); }); out.type = o.type || 'Opaque'; break;
      case 'Namespace': out.spec = { finalizers: ['kubernetes'] }; if (!clean) out.status = { phase: o.phase }; break;
      case 'ServiceAccount': break;
      case 'HorizontalPodAutoscaler':
        out.spec = { maxReplicas: o.max, metrics: [{ resource: { name: 'cpu', target: { averageUtilization: o.targetCPU, type: 'Utilization' } }, type: 'Resource' }], minReplicas: o.min, scaleTargetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: o.target.name } };
        if (!clean) {
          const d = c.get('Deployment', o.namespace, o.target.name);
          out.status = { currentReplicas: d ? d.replicas : 0, desiredReplicas: d ? d.replicas : 0, currentMetrics: o.current == null ? [] : [{ resource: { current: { averageUtilization: o.current }, name: 'cpu' }, type: 'Resource' }] };
          out.status.conditions = [{ type: 'ScalingActive', status: o.problem ? 'False' : 'True', reason: o.problem ? 'FailedGetResourceMetric' : 'ValidMetricFound', message: o.problem || 'the HPA was able to successfully calculate a replica count from cpu resource utilization (percentage of request)' }];
        }
        break;
      case 'Ingress':
        out.spec = {};
        if (o.ingressClassName) out.spec.ingressClassName = o.ingressClassName;
        out.spec.rules = o.rules.map(r => Object.assign(r.host ? { host: r.host } : {}, { http: { paths: r.paths.map(p => ({ backend: { service: { name: p.backend.name, port: p.backend.portName ? { name: p.backend.portName } : { number: Number(p.backend.port) } } }, path: p.path, pathType: p.pathType })) } }));
        if (!clean) { const ctrl = c.list('Service', 'ingress-nginx')[0]; out.status = { loadBalancer: { ingress: [{ hostname: 'a1b2c3d4e5-1234567890.eu-west-1.elb.amazonaws.com' }] } }; void ctrl; }
        break;
      case 'NetworkPolicy': {
        out.spec = { podSelector: clone(o.podSelector) };
        if (o.ingress) out.spec.ingress = clone(o.ingress);
        if (o.egress) out.spec.egress = clone(o.egress);
        out.spec.policyTypes = clone(o.policyTypes);
        break;
      }
      case 'Role': case 'ClusterRole': out.rules = clone(o.rules || []); break;
      case 'RoleBinding': case 'ClusterRoleBinding': out.roleRef = clone(o.roleRef); out.subjects = clone(o.subjects || []); break;
      case 'ResourceQuota':
        out.spec = { hard: clone(o.hard) };
        if (!clean) { const u = c.quotaUsage(o.namespace); out.status = { hard: clone(o.hard), used: {} }; Object.keys(o.hard).forEach(k => { out.status.used[k] = /cpu/.test(k) ? Q.fmtCpu(u[k] || 0) : /memory/.test(k) ? Q.fmtMem(u[k] || 0) : String(u[k] || 0); }); }
        break;
      case 'PersistentVolumeClaim':
        out.spec = { accessModes: clone(o.spec.accessModes), resources: { requests: { storage: o.spec.resources.requests.storage } } };
        if (o.spec.storageClassName != null || !clean) out.spec.storageClassName = o.spec.storageClassName != null ? o.spec.storageClassName : o.storageClassResolved || undefined;
        if (!clean) {
          out.spec.volumeMode = 'Filesystem';
          if (o.volumeName) out.spec.volumeName = o.volumeName;
          out.status = { phase: o.phase };
          if (o.phase === 'Bound') { out.status.accessModes = clone(o.spec.accessModes); out.status.capacity = { storage: Q.fmtMem(o.capacityMi) }; }
        }
        break;
      case 'PersistentVolume':
        out.spec = { accessModes: clone(o.accessModes), capacity: { storage: Q.fmtMem(o.capacityMi) }, claimRef: { name: o.claim.name, namespace: o.claim.namespace }, persistentVolumeReclaimPolicy: o.reclaimPolicy, storageClassName: o.storageClass };
        out.status = { phase: o.status };
        break;
      case 'StorageClass':
        if (o.isDefault) out.metadata.annotations = Object.assign({}, out.metadata.annotations, { 'storageclass.kubernetes.io/is-default-class': 'true' });
        out.provisioner = o.provisioner; out.parameters = clone(o.parameters); out.reclaimPolicy = o.reclaimPolicy; out.volumeBindingMode = o.volumeBindingMode; out.allowVolumeExpansion = o.allowVolumeExpansion;
        break;
      case 'PodDisruptionBudget': {
        out.spec = { selector: selOut(o.selector) };
        if (o.minAvailable != null) out.spec.minAvailable = o.minAvailable; else out.spec.maxUnavailable = o.maxUnavailable;
        if (!clean) { const s = c.pdbStatus(o); out.status = { currentHealthy: s.healthy, desiredHealthy: s.desired, disruptionsAllowed: s.allowed, expectedPods: s.expected }; }
        break;
      }
      case 'Node':
        out.spec = Object.assign(o.unschedulable ? { unschedulable: true } : {}, o.taints.length ? { taints: clone(o.taints) } : {});
        out.status = { allocatable: { cpu: Q.fmtCpu(o.allocCpu), memory: Q.fmtMem(o.allocMem), pods: String(o.maxPods) }, capacity: { cpu: Q.fmtCpu(o.cpuM), memory: Q.fmtMem(o.memMi), pods: String(o.maxPods) },
          conditions: [{ type: 'MemoryPressure', status: o.memPressure ? 'True' : 'False' }, { type: 'Ready', status: o.ready ? 'True' : 'Unknown' }], addresses: [{ address: o.ip, type: 'InternalIP' }, { address: o.name, type: 'Hostname' }] };
        break;
      default: break;
    }
    return out;
  }

  /* ---------- apply ---------- */
  class ApplyError extends Error {}
  const fail = m => { throw new ApplyError(m); };
  const str = v => (v == null ? '' : String(v));
  const strMap = (m, path) => {
    if (m == null) return {};
    if (typeof m !== 'object' || Array.isArray(m)) fail(`${path}: expected a map of string values`);
    const o = {}; Object.keys(m).forEach(k => { o[k] = str(m[k]); }); return o;
  };
  const DNS = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;
  function checkName(kind, name) {
    if (!DNS.test(name) || name.length > 253) fail(`The ${kind} "${name}" is invalid: metadata.name: Invalid value: "${name}": a lowercase RFC 1123 subdomain must consist of lower case alphanumeric characters, '-' or '.', and must start and end with an alphanumeric character (e.g. 'example.com', regex used for validation is '[a-z0-9]([-a-z0-9]*[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*')`);
  }
  const POD_FIELDS = ['containers', 'initContainers', 'volumes', 'serviceAccountName', 'serviceAccount', 'nodeSelector', 'tolerations', 'imagePullSecrets', 'restartPolicy', 'nodeName', 'affinity', 'securityContext',
    'terminationGracePeriodSeconds', 'dnsPolicy', 'priorityClassName', 'schedulerName', 'hostname', 'subdomain', 'automountServiceAccountToken', 'enableServiceLinks', 'topologySpreadConstraints', 'dnsConfig', 'hostNetwork', 'shareProcessNamespace', 'activeDeadlineSeconds'];
  const CT_FIELDS = ['name', 'image', 'command', 'args', 'env', 'envFrom', 'ports', 'resources', 'livenessProbe', 'readinessProbe', 'startupProbe', 'volumeMounts', 'imagePullPolicy', 'securityContext',
    'workingDir', 'lifecycle', 'terminationMessagePath', 'terminationMessagePolicy', 'stdin', 'tty', 'restartPolicy'];
  const PROBE_FIELDS = ['httpGet', 'tcpSocket', 'exec', 'grpc', 'initialDelaySeconds', 'periodSeconds', 'timeoutSeconds', 'failureThreshold', 'successThreshold', 'terminationGracePeriodSeconds'];
  function unknownField(ctx, file, path, obj, allowed, typeName) {
    if (!obj || typeof obj !== 'object') return;
    for (const k of Object.keys(obj)) if (!allowed.includes(k)) {
      const near = allowed.find(a => a.toLowerCase() === k.toLowerCase());
      fail(`Error from server (BadRequest): error when creating "${file}": ${ctx} in version "${typeName}" cannot be handled as a ${ctx}: strict decoding error: unknown field "${path}.${k}"${near ? ` (did you mean "${near}"?)` : ''}`);
    }
  }
  function parseProbe(kind, name, p, path, file, gv) {
    unknownField(kind, file, path, p, PROBE_FIELDS, gv);
    const handlers = ['httpGet', 'tcpSocket', 'exec', 'grpc'].filter(h => p[h]);
    if (handlers.length !== 1) fail(`The ${kind} "${name}" is invalid: ${path}: ${handlers.length ? 'Forbidden: may not specify more than 1 handler type' : 'Required value: must specify a handler type'}`);
    const o = {};
    if (p.httpGet) { if (p.httpGet.port == null) fail(`The ${kind} "${name}" is invalid: ${path}.httpGet.port: Required value`); o.httpGet = { path: str(p.httpGet.path || '/'), port: /^\d+$/.test(String(p.httpGet.port)) ? Number(p.httpGet.port) : str(p.httpGet.port) }; if (p.httpGet.scheme) o.httpGet.scheme = p.httpGet.scheme; }
    if (p.tcpSocket) o.tcpSocket = { port: /^\d+$/.test(String(p.tcpSocket.port)) ? Number(p.tcpSocket.port) : str(p.tcpSocket.port) };
    if (p.grpc) o.grpc = { port: Number(p.grpc.port) };
    if (p.exec) o.exec = { command: (p.exec.command || []).map(str) };
    for (const k of ['initialDelaySeconds', 'periodSeconds', 'timeoutSeconds', 'failureThreshold', 'successThreshold']) {
      if (p[k] == null) continue;
      const n = Number(p[k]);
      if (!Number.isInteger(n) || n < 0) fail(`The ${kind} "${name}" is invalid: ${path}.${k}: Invalid value: ${JSON.stringify(p[k])}: must be greater than or equal to 0`);
      o[k] = n;
    }
    return o;
  }
  function parseResources(kind, name, r, path) {
    if (r == null) return {};
    const out = {};
    for (const sect of ['requests', 'limits']) {
      if (!r[sect]) continue;
      out[sect] = {};
      for (const res of Object.keys(r[sect])) {
        const v = str(r[sect][res]);
        if (!['cpu', 'memory', 'ephemeral-storage'].includes(res)) fail(`The ${kind} "${name}" is invalid: ${path}.${sect}[${res}]: Invalid value: "${res}": must be a standard resource type or fully qualified`);
        if (!Q.valid(v, res === 'cpu' ? 'cpu' : 'mem')) fail(`The ${kind} "${name}" is invalid: ${path}.${sect}[${res}]: Invalid value: "${v}": quantities must match the regular expression '^([+-]?[0-9.]+)([eEinumkKMGTP]*[-+]?[0-9]*)$'`);
        out[sect][res] = /^\d+$/.test(v) && res === 'cpu' ? Number(v) : v;
      }
    }
    if (out.requests && out.limits) for (const res of ['cpu', 'memory']) {
      const rq = out.requests[res], lm = out.limits[res];
      if (rq == null || lm == null) continue;
      const big = res === 'cpu' ? Q.cpu(rq) > Q.cpu(lm) : Q.mem(rq) > Q.mem(lm);
      if (big) fail(`The ${kind} "${name}" is invalid: ${path}.requests: Invalid value: "${rq}": must be less than or equal to ${res} limit of ${lm}`);
    }
    return out;
  }
  function parseContainers(kind, name, list, path, volumes, file, gv, required) {
    if (list == null && !required) return [];
    if (!Array.isArray(list) || (!list.length && required)) fail(`The ${kind} "${name}" is invalid: ${path}: Required value`);
    const names = new Set();
    return list.map((c, i) => {
      const p = `${path}[${i}]`;
      if (!c || typeof c !== 'object') fail(`The ${kind} "${name}" is invalid: ${p}: expected a container object`);
      unknownField(kind, file, p, c, CT_FIELDS, gv);
      if (!c.name) fail(`The ${kind} "${name}" is invalid: ${p}.name: Required value`);
      if (names.has(c.name)) fail(`The ${kind} "${name}" is invalid: ${p}.name: Duplicate value: "${c.name}"`);
      names.add(c.name);
      if (!c.image) fail(`The ${kind} "${name}" is invalid: ${p}.image: Required value`);
      const env = (c.env || []).map((e, j) => {
        if (!e || !e.name) fail(`The ${kind} "${name}" is invalid: ${p}.env[${j}].name: Required value`);
        return e.valueFrom ? { name: str(e.name), valueFrom: clone(e.valueFrom) } : { name: str(e.name), value: str(e.value) };
      });
      const ports = (c.ports || []).map((pt, j) => {
        if (pt.containerPort == null) fail(`The ${kind} "${name}" is invalid: ${p}.ports[${j}].containerPort: Required value`);
        return Object.assign({ containerPort: Number(pt.containerPort) }, pt.name ? { name: str(pt.name) } : {}, { protocol: pt.protocol || 'TCP' });
      });
      const out = { name: str(c.name), image: str(c.image), env, envFrom: clone(c.envFrom || []), ports, resources: parseResources(kind, name, c.resources, `${p}.resources`), volumeMounts: [] };
      (c.volumeMounts || []).forEach((vm, j) => {
        if (!vm.name || !vm.mountPath) fail(`The ${kind} "${name}" is invalid: ${p}.volumeMounts[${j}].${vm.name ? 'mountPath' : 'name'}: Required value`);
        if (!volumes.some(v => v.name === vm.name)) fail(`The ${kind} "${name}" is invalid: ${p}.volumeMounts[${j}].name: Not found: "${vm.name}"`);
        out.volumeMounts.push(Object.assign({ mountPath: str(vm.mountPath), name: str(vm.name) }, vm.readOnly ? { readOnly: true } : {}, vm.subPath ? { subPath: str(vm.subPath) } : {}));
      });
      ['command', 'args'].forEach(k => { if (c[k] != null) { if (!Array.isArray(c[k])) fail(`The ${kind} "${name}" is invalid: ${p}.${k}: Invalid value: expected a list of strings`); out[k] = c[k].map(str); } });
      PROBES.forEach(k => { if (c[k]) out[k] = parseProbe(kind, name, c[k], `${p}.${k}`, file, gv); });
      ['imagePullPolicy', 'securityContext', 'workingDir', 'lifecycle', 'terminationMessagePath', 'terminationMessagePolicy', 'stdin', 'tty'].forEach(k => { if (c[k] != null) out[k] = clone(c[k]); });
      return out;
    });
  }
  function parsePodSpec(kind, name, s, path, file, gv) {
    if (!s || typeof s !== 'object') fail(`The ${kind} "${name}" is invalid: ${path}: Required value`);
    unknownField(kind, file, path, s, POD_FIELDS, gv);
    const volumes = (s.volumes || []).map((v, i) => {
      if (!v.name) fail(`The ${kind} "${name}" is invalid: ${path}.volumes[${i}].name: Required value`);
      const types = ['persistentVolumeClaim', 'configMap', 'secret', 'emptyDir', 'projected', 'hostPath', 'downwardAPI'].filter(t => v[t] !== undefined);
      if (types.length !== 1) fail(`The ${kind} "${name}" is invalid: ${path}.volumes[${i}]: ${types.length ? 'Forbidden: may not specify more than 1 volume type' : 'Required value: must specify a volume type'}`);
      if (v.persistentVolumeClaim && !v.persistentVolumeClaim.claimName) fail(`The ${kind} "${name}" is invalid: ${path}.volumes[${i}].persistentVolumeClaim.claimName: Required value`);
      return clone(v);
    });
    const spec = K.sim.blankSpec();
    spec.volumes = volumes;
    spec.containers = parseContainers(kind, name, s.containers, path + '.containers', volumes, file, gv, true);
    spec.initContainers = parseContainers(kind, name, s.initContainers, path + '.initContainers', volumes, file, gv, false);
    spec.serviceAccountName = str(s.serviceAccountName || s.serviceAccount || 'default');
    spec.nodeSelector = strMap(s.nodeSelector, path + '.nodeSelector');
    spec.tolerations = (s.tolerations || []).map((t, i) => {
      if (t.operator && !['Equal', 'Exists'].includes(t.operator)) fail(`The ${kind} "${name}" is invalid: ${path}.tolerations[${i}].operator: Unsupported value: "${t.operator}": supported values: "Equal", "Exists"`);
      if (t.effect && !['NoSchedule', 'PreferNoSchedule', 'NoExecute'].includes(t.effect)) fail(`The ${kind} "${name}" is invalid: ${path}.tolerations[${i}].effect: Unsupported value: "${t.effect}": supported values: "NoSchedule", "PreferNoSchedule", "NoExecute"`);
      if (t.operator === 'Exists' && t.value) fail(`The ${kind} "${name}" is invalid: ${path}.tolerations[${i}].operator: Invalid value: "${t.value}": value must be empty when \`operator\` is 'Exists'`);
      const o = {}; ['key', 'operator', 'value', 'effect'].forEach(k => { if (t[k] != null) o[k] = str(t[k]); }); if (t.tolerationSeconds != null) o.tolerationSeconds = Number(t.tolerationSeconds); return o;
    });
    spec.imagePullSecrets = (s.imagePullSecrets || []).map(x => ({ name: str(x && x.name) }));
    spec.restartPolicy = s.restartPolicy || 'Always';
    if (!['Always', 'OnFailure', 'Never'].includes(spec.restartPolicy)) fail(`The ${kind} "${name}" is invalid: ${path}.restartPolicy: Unsupported value: "${spec.restartPolicy}": supported values: "Always", "OnFailure", "Never"`);
    if (kind === 'Deployment' && spec.restartPolicy !== 'Always') fail(`The Deployment "${name}" is invalid: spec.template.spec.restartPolicy: Unsupported value: "${spec.restartPolicy}": supported values: "Always"`);
    if (s.nodeName) spec.nodeName = str(s.nodeName);
    ['affinity', 'securityContext', 'terminationGracePeriodSeconds', 'dnsPolicy', 'priorityClassName', 'automountServiceAccountToken', 'topologySpreadConstraints', 'enableServiceLinks'].forEach(k => { if (s[k] != null) spec[k] = clone(s[k]); });
    return spec;
  }
  function parseSelectorObj(kind, name, sel, path) {
    if (!sel || typeof sel !== 'object') fail(`The ${kind} "${name}" is invalid: ${path}: Required value`);
    const o = {};
    if (sel.matchLabels) o.matchLabels = strMap(sel.matchLabels, path + '.matchLabels');
    if (sel.matchExpressions) o.matchExpressions = clone(sel.matchExpressions);
    return o;
  }
  function parsePeers(kind, name, peers, path) {
    return (peers || []).map((p, i) => {
      const o = {};
      if (p.podSelector) o.podSelector = parseSelectorObj(kind, name, p.podSelector, `${path}[${i}].podSelector`);
      if (p.namespaceSelector) o.namespaceSelector = parseSelectorObj(kind, name, p.namespaceSelector, `${path}[${i}].namespaceSelector`);
      if (p.ipBlock) { if (!p.ipBlock.cidr) fail(`The ${kind} "${name}" is invalid: ${path}[${i}].ipBlock.cidr: Required value`); o.ipBlock = clone(p.ipBlock); }
      if (!Object.keys(o).length) fail(`The ${kind} "${name}" is invalid: ${path}[${i}]: Required value: must specify a peer`);
      return o;
    });
  }
  function parseNpPorts(kind, name, ports, path) {
    return (ports || []).map((p, i) => {
      const o = { protocol: p.protocol || 'TCP' };
      if (!['TCP', 'UDP', 'SCTP'].includes(o.protocol)) fail(`The ${kind} "${name}" is invalid: ${path}[${i}].protocol: Unsupported value: "${o.protocol}": supported values: "SCTP", "TCP", "UDP"`);
      if (p.port != null) o.port = /^\d+$/.test(String(p.port)) ? Number(p.port) : str(p.port);
      if (p.endPort != null) o.endPort = Number(p.endPort);
      return o;
    });
  }

  /* applyDoc: mode 'apply' | 'create'. Returns "deployment.apps/web created" etc. */
  function applyDoc(c, doc, opts) {
    const file = opts.file || '-';
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) fail(`error: error validating "${file}": error validating data: invalid object: expected a map at the top level`);
    const missing = [];
    if (!doc.apiVersion) missing.push('apiVersion not set'); if (!doc.kind) missing.push('kind not set');
    if (missing.length) fail(`error: error validating "${file}": error validating data: [${missing.join(', ')}]; if you choose to ignore these errors, turn validation off with --validate=false`);
    const kind = doc.kind, md = doc.metadata || {}, name = md.name;
    if (UNSUPPORTED.includes(kind)) fail(`error: ${kind} is a real Kubernetes kind, but this training cluster doesn't simulate it yet`);
    const okApi = kind === 'HorizontalPodAutoscaler' ? ['autoscaling/v2', 'autoscaling/v1'] : [API[kind]];
    if (!API[kind] || kind === 'Node' || kind === 'ReplicaSet' || kind === 'PersistentVolume' || !okApi.includes(doc.apiVersion)) {
      if (API[kind] && ['Node', 'ReplicaSet', 'PersistentVolume', 'DaemonSet'].includes(kind) && okApi.includes(doc.apiVersion)) fail(`error: ${kind} objects are managed for you in this training cluster; change their owner instead`);
      fail(`error: resource mapping not found for name: "${name || ''}" namespace: "${md.namespace || ''}" from "${file}": no matches for kind "${kind}" in version "${doc.apiVersion}"\nensure CRDs are installed first`);
    }
    if (!name) fail(`error: error when retrieving current configuration of:\nResource: "${PLURAL[kind]}", GroupVersionKind: "${doc.apiVersion}, Kind=${kind}"\nfrom server for: "${file}": resource name may not be empty`);
    checkName(kind, String(name));
    const cluster = kind === 'Namespace' || CLUSTER_KINDS.includes(kind);
    let ns = null;
    if (!cluster) {
      ns = md.namespace || opts.ns;
      if (md.namespace && opts.nsFlag && md.namespace !== opts.nsFlag) fail(`error: the namespace from the provided object "${md.namespace}" does not match the namespace "${opts.nsFlag}". You must pass '--namespace=${md.namespace}' to perform this operation.`);
      if (!c.nsExists(ns)) fail(`Error from server (NotFound): error when creating "${file}": namespaces "${ns}" not found`);
    }
    const labels = strMap(md.labels, 'metadata.labels');
    const annotations = strMap(md.annotations, 'metadata.annotations');
    const spec = doc.spec || {};
    const gv = doc.apiVersion;
    const existing = kind === 'Namespace' ? c.namespaces.get(name) : c.get(kind, ns, name);
    if (existing && opts.mode === 'create') fail(`Error from server (AlreadyExists): error when creating "${file}": ${PLURAL[kind]} "${name}" already exists`);
    const res = RES[kind] + '/' + name;
    const done = (changed, created) => res + (created ? ' created' : changed ? ' configured' : ' unchanged');
    const save = (vals, keys) => {
      if (existing) {
        const before = stable(keys.map(k => existing[k]));
        Object.assign(existing, vals); c.activity.etcd++;
        return done(before !== stable(keys.map(k => existing[k])), false);
      }
      c.put(c.obj(kind, Object.assign({ name, namespace: ns || '' }, vals)));
      return done(true, true);
    };
    const validateOnly = () => opts.dryRun;

    if (kind === 'Namespace') {
      if (validateOnly()) return res + ' ' + (existing ? 'configured' : 'created') + ' (dry run)';
      if (existing) { const before = stable(existing.labels); Object.assign(existing.labels, labels); return done(before !== stable(existing.labels)); }
      c.addNamespace(name, labels); return done(true, true);
    }
    let vals, keys;
    switch (kind) {
      case 'ConfigMap': case 'Secret': {
        let data = strMap(doc.data, 'data');
        if (kind === 'Secret') {
          const dec = {};
          for (const k of Object.keys(data)) {
            if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data[k])) fail(`Error from server (BadRequest): error when creating "${file}": Secret in version "v1" cannot be handled as a Secret: illegal base64 data at input byte ${Math.max(0, data[k].search(/[^A-Za-z0-9+/=]/))}`);
            try { dec[k] = b64d(data[k]); } catch (e) { fail(`Error from server (BadRequest): error when creating "${file}": Secret in version "v1" cannot be handled as a Secret: illegal base64 data`); }
          }
          data = Object.assign(dec, strMap(doc.stringData, 'stringData'));
          if (doc.type === 'kubernetes.io/dockerconfigjson' && !data['.dockerconfigjson']) fail(`The Secret "${name}" is invalid: data[.dockerconfigjson]: Required value`);
        }
        vals = { data, labels, annotations, type: doc.type || (existing && existing.type) || 'Opaque' }; keys = ['data', 'labels', 'type'];
        if (existing && kind === 'Secret' && existing.type !== vals.type) fail(`The Secret "${name}" is invalid: type: Invalid value: "${vals.type}": field is immutable`);
        break;
      }
      case 'ServiceAccount': vals = { labels, annotations }; keys = ['labels']; break;
      case 'Deployment': {
        const sel = spec.selector && spec.selector.matchLabels;
        if (!sel || !Object.keys(sel).length) fail(`The Deployment "${name}" is invalid: spec.selector: Required value`);
        unknownField('Deployment', file, 'spec', spec, ['replicas', 'selector', 'template', 'strategy', 'minReadySeconds', 'revisionHistoryLimit', 'progressDeadlineSeconds', 'paused'], gv);
        const selector = strMap(sel, 'spec.selector.matchLabels');
        const tmd = (spec.template && spec.template.metadata) || {};
        const tlabels = strMap(tmd.labels, 'spec.template.metadata.labels');
        if (!K.sim.matches(tlabels, selector)) fail(`The Deployment "${name}" is invalid: spec.template.metadata.labels: Invalid value: ${JSON.stringify(tlabels)}: \`selector\` does not match template \`labels\``);
        const pspec = parsePodSpec('Deployment', name, spec.template && spec.template.spec, 'spec.template.spec', file, gv);
        const replicas = spec.replicas == null ? (existing ? existing.replicas : 1) : Number(spec.replicas);
        if (!Number.isInteger(replicas) || replicas < 0) fail(`The Deployment "${name}" is invalid: spec.replicas: Invalid value: ${spec.replicas}: must be greater than or equal to 0`);
        const strategy = clone(spec.strategy && spec.strategy.type ? spec.strategy : { type: 'RollingUpdate', rollingUpdate: Object.assign({ maxSurge: '25%', maxUnavailable: '25%' }, (spec.strategy && spec.strategy.rollingUpdate) || {}) });
        if (!['RollingUpdate', 'Recreate'].includes(strategy.type)) fail(`The Deployment "${name}" is invalid: spec.strategy.type: Unsupported value: "${strategy.type}": supported values: "Recreate", "RollingUpdate"`);
        if (strategy.type === 'Recreate' && strategy.rollingUpdate) fail(`The Deployment "${name}" is invalid: spec.strategy.rollingUpdate: Forbidden: may not be specified when strategy \`type\` is 'Recreate'`);
        if (strategy.type === 'RollingUpdate') strategy.rollingUpdate = Object.assign({ maxSurge: '25%', maxUnavailable: '25%' }, strategy.rollingUpdate || {});
        const template = { labels: tlabels, annotations: strMap(tmd.annotations, 'annotations'), spec: pspec };
        if (existing && stable(existing.selector) !== stable(selector)) fail(`The Deployment "${name}" is invalid: spec.selector: Invalid value: v1.LabelSelector{MatchLabels:map[string]string${JSON.stringify(selector)}, MatchExpressions:[]v1.LabelSelectorRequirement(nil)}: field is immutable`);
        if (validateOnly()) break;
        const cause = annotations['kubernetes.io/change-cause'] || null;
        if (existing) {
          const same = existing.replicas === replicas && stable(existing.labels) === stable(labels) && c.templateHash(existing.template) === c.templateHash(template) && stable(existing.strategy) === stable(strategy) && !!existing.paused === !!spec.paused;
          if (same) return done(false);
          Object.assign(existing, { replicas, labels, annotations, template, strategy, paused: !!spec.paused, changeCause: cause || existing.changeCause }); c.activity.etcd++;
          return done(true);
        }
        const d = c.createDeployment({ ns, name, labels, selector, podLabels: tlabels, replicas, spec: pspec, strategy, changeCause: cause });
        d.template.annotations = template.annotations; d.annotations = annotations; d.paused = !!spec.paused;
        return done(true, true);
      }
      case 'Service': {
        if (!Array.isArray(spec.ports) || !spec.ports.length) fail(`The Service "${name}" is invalid: spec.ports: Required value`);
        const type = spec.type || 'ClusterIP';
        if (!['ClusterIP', 'NodePort', 'LoadBalancer'].includes(type)) fail(`The Service "${name}" is invalid: spec.type: Unsupported value: "${type}": supported values: "ClusterIP", "ExternalName", "LoadBalancer", "NodePort"`);
        const ports = spec.ports.map((p, i) => {
          if (p.port == null) fail(`The Service "${name}" is invalid: spec.ports[${i}].port: Required value`);
          if (spec.ports.length > 1 && !p.name) fail(`The Service "${name}" is invalid: spec.ports[${i}].name: Required value`);
          return { name: p.name, protocol: p.protocol || 'TCP', port: Number(p.port), targetPort: p.targetPort == null ? Number(p.port) : (/^\d+$/.test(String(p.targetPort)) ? Number(p.targetPort) : str(p.targetPort)), nodePort: p.nodePort };
        });
        const selector = spec.selector ? strMap(spec.selector, 'spec.selector') : null;
        if (validateOnly()) break;
        if (existing) {
          const before = stable([existing.selector, existing.ports.map(p => [p.name, p.port, p.targetPort, p.protocol]), existing.type, existing.labels]);
          existing.selector = selector; existing.labels = labels;
          existing.ports = ports.map((p, i) => Object.assign(p, type !== 'ClusterIP' ? { nodePort: p.nodePort || (existing.ports[i] && existing.ports[i].nodePort) || 30000 + Math.floor(c.rng() * 2767) } : {}));
          existing.type = type; c.activity.etcd++;
          return done(before !== stable([existing.selector, existing.ports.map(p => [p.name, p.port, p.targetPort, p.protocol]), existing.type, existing.labels]));
        }
        c.createService({ ns, name, labels, selector, ports, type });
        return done(true, true);
      }
      case 'Pod': {
        const pspec = parsePodSpec('Pod', name, spec, 'spec', file, gv);
        if (validateOnly()) break;
        if (existing) {
          const onlyImages = stable(existing.spec.containers.map(x => Object.assign({}, x, { image: '' }))) === stable(pspec.containers.map(x => Object.assign({}, x, { image: '' })));
          if (stable(existing.spec.containers) === stable(pspec.containers) && stable(existing.labels) === stable(labels)) return done(false);
          if (!onlyImages) fail(`The Pod "${name}" is invalid: spec: Forbidden: pod updates may not change fields other than \`spec.containers[*].image\`,\`spec.initContainers[*].image\`,\`spec.activeDeadlineSeconds\`,\`spec.tolerations\` (only additions to existing tolerations),\`spec.terminationGracePeriodSeconds\` (allow it to be set to 1 if it was previously negative)`);
          existing.spec.containers = pspec.containers; existing.labels = labels;
          if (existing.phase !== 'Pending') { existing.phase = 'ContainerCreating'; existing.timer = 1; existing.ready = false; existing.pulled = {}; }
          return done(true);
        }
        const err = c.admitPod(ns, name, pspec);
        if (err) fail(`Error from server (Forbidden): error when creating "${file}": ${err}`);
        c.makePod({ ns, name, labels, annotations, spec: pspec });
        return done(true, true);
      }
      case 'HorizontalPodAutoscaler': {
        const ref = spec.scaleTargetRef || {};
        if (!ref.name) fail(`The HorizontalPodAutoscaler "${name}" is invalid: spec.scaleTargetRef.name: Required value`);
        if (!spec.maxReplicas) fail(`The HorizontalPodAutoscaler "${name}" is invalid: spec.maxReplicas: Required value`);
        let cpu = 80;
        if (doc.apiVersion === 'autoscaling/v1') cpu = Number(spec.targetCPUUtilizationPercentage || 80);
        else { const m = (spec.metrics || []).find(x => x.resource && x.resource.name === 'cpu'); if (m && m.resource.target) cpu = Number(m.resource.target.averageUtilization || 80); }
        vals = { min: Number(spec.minReplicas || 1), max: Number(spec.maxReplicas), targetCPU: cpu, target: { kind: 'Deployment', name: str(ref.name) }, labels };
        if (existing) keys = ['min', 'max', 'targetCPU', 'target', 'labels'];
        else { if (validateOnly()) break; c.createHPA({ ns, name, target: vals.target.name, min: vals.min, max: vals.max, cpu: vals.targetCPU }); return done(true, true); }
        break;
      }
      case 'Ingress': {
        unknownField('Ingress', file, 'spec', spec, ['ingressClassName', 'rules', 'tls', 'defaultBackend'], gv);
        const rules = (spec.rules || []).map((r, i) => {
          const paths = ((r.http && r.http.paths) || []).map((p, j) => {
            const at = `spec.rules[${i}].http.paths[${j}]`;
            if (!p.pathType) fail(`The Ingress "${name}" is invalid: ${at}.pathType: Required value: pathType must be specified`);
            if (!['Prefix', 'Exact', 'ImplementationSpecific'].includes(p.pathType)) fail(`The Ingress "${name}" is invalid: ${at}.pathType: Unsupported value: "${p.pathType}": supported values: "Exact", "ImplementationSpecific", "Prefix"`);
            const svc = p.backend && p.backend.service;
            if (!svc || !svc.name) fail(`The Ingress "${name}" is invalid: ${at}.backend: Invalid value: "": resource or service backend is required`);
            if (!svc.port || (svc.port.number == null && !svc.port.name)) fail(`The Ingress "${name}" is invalid: ${at}.backend.service.port: Invalid value: "": port name or number is required`);
            return { path: str(p.path || '/'), pathType: p.pathType, backend: { name: str(svc.name), port: svc.port.number != null ? Number(svc.port.number) : null, portName: svc.port.name ? str(svc.port.name) : null } };
          });
          return { host: r.host ? str(r.host) : null, paths };
        });
        vals = { rules, ingressClassName: spec.ingressClassName || annotations['kubernetes.io/ingress.class'] || null, labels, annotations, tls: clone(spec.tls || null) };
        keys = ['rules', 'ingressClassName', 'labels'];
        break;
      }
      case 'NetworkPolicy': {
        unknownField('NetworkPolicy', file, 'spec', spec, ['podSelector', 'policyTypes', 'ingress', 'egress'], gv);
        if (spec.podSelector == null) fail(`The NetworkPolicy "${name}" is invalid: spec.podSelector: Required value`);
        const podSelector = parseSelectorObj(kind, name, spec.podSelector, 'spec.podSelector');
        const ingress = spec.ingress ? spec.ingress.map((r, i) => ({ from: parsePeers(kind, name, r && r.from, `spec.ingress[${i}].from`), ports: parseNpPorts(kind, name, r && r.ports, `spec.ingress[${i}].ports`) })) : null;
        const egress = spec.egress ? spec.egress.map((r, i) => ({ to: parsePeers(kind, name, r && r.to, `spec.egress[${i}].to`), ports: parseNpPorts(kind, name, r && r.ports, `spec.egress[${i}].ports`) })) : null;
        let policyTypes = spec.policyTypes;
        if (!policyTypes) policyTypes = egress ? ['Ingress', 'Egress'] : ['Ingress'];
        policyTypes.forEach(t => { if (!['Ingress', 'Egress'].includes(t)) fail(`The NetworkPolicy "${name}" is invalid: spec.policyTypes: Unsupported value: "${t}": supported values: "Egress", "Ingress"`); });
        const strip = rules => rules && rules.map(r => { const o = {}; if (r.from && r.from.length) o.from = r.from; if (r.to && r.to.length) o.to = r.to; if (r.ports && r.ports.length) o.ports = r.ports; return o; });
        vals = { podSelector, ingress: strip(ingress), egress: strip(egress), policyTypes, labels }; keys = ['podSelector', 'ingress', 'egress', 'policyTypes', 'labels'];
        break;
      }
      case 'Role': case 'ClusterRole': {
        const rules = (doc.rules || []).map((r, i) => {
          if (!r.verbs || !r.verbs.length) fail(`The ${kind} "${name}" is invalid: rules[${i}].verbs: Required value: verbs must contain at least one value`);
          return { apiGroups: (r.apiGroups || ['']).map(str), resources: (r.resources || []).map(str), verbs: r.verbs.map(str), resourceNames: r.resourceNames ? r.resourceNames.map(str) : undefined };
        }).map(r => JSON.parse(JSON.stringify(r)));
        vals = { rules, labels }; keys = ['rules', 'labels'];
        break;
      }
      case 'RoleBinding': case 'ClusterRoleBinding': {
        const rr = doc.roleRef;
        if (!rr || !rr.kind || !rr.name) fail(`The ${kind} "${name}" is invalid: roleRef.${!rr || !rr.kind ? 'kind' : 'name'}: Required value`);
        if (kind === 'ClusterRoleBinding' && rr.kind !== 'ClusterRole') fail(`The ClusterRoleBinding "${name}" is invalid: roleRef.kind: Unsupported value: "${rr.kind}": supported values: "ClusterRole"`);
        const roleRef = { apiGroup: 'rbac.authorization.k8s.io', kind: str(rr.kind), name: str(rr.name) };
        if (existing && stable(existing.roleRef) !== stable(roleRef)) fail(`The ${kind} "${name}" is invalid: roleRef: Invalid value: rbac.RoleRef{APIGroup:"rbac.authorization.k8s.io", Kind:"${roleRef.kind}", Name:"${roleRef.name}"}: cannot change roleRef`);
        const subjects = (doc.subjects || []).map((s, i) => {
          if (!s.kind || !s.name) fail(`The ${kind} "${name}" is invalid: subjects[${i}].${!s.kind ? 'kind' : 'name'}: Required value`);
          if (s.kind === 'ServiceAccount' && kind === 'ClusterRoleBinding' && !s.namespace) fail(`The ClusterRoleBinding "${name}" is invalid: subjects[${i}].namespace: Required value`);
          const o = { kind: str(s.kind), name: str(s.name) }; if (s.namespace) o.namespace = str(s.namespace); if (s.apiGroup) o.apiGroup = str(s.apiGroup); return o;
        });
        vals = { roleRef, subjects, labels }; keys = ['subjects', 'labels'];
        break;
      }
      case 'ResourceQuota': {
        const hard = strMap(spec.hard, 'spec.hard');
        Object.keys(hard).forEach(k => { if (!['pods', 'requests.cpu', 'requests.memory', 'limits.cpu', 'limits.memory', 'cpu', 'memory', 'services', 'configmaps', 'secrets', 'persistentvolumeclaims', 'requests.storage'].includes(k)) fail(`The ResourceQuota "${name}" is invalid: spec.hard[${k}]: Invalid value: "${k}": must be a standard resource for quota`); });
        vals = { hard, labels }; keys = ['hard', 'labels'];
        break;
      }
      case 'PersistentVolumeClaim': {
        const want = spec.resources && spec.resources.requests && spec.resources.requests.storage;
        if (!want) fail(`The PersistentVolumeClaim "${name}" is invalid: spec.resources[storage]: Required value`);
        if (!Q.valid(str(want), 'mem')) fail(`The PersistentVolumeClaim "${name}" is invalid: spec.resources.requests[storage]: Invalid value: "${want}": quantities must match the regular expression '^([+-]?[0-9.]+)([eEinumkKMGTP]*[-+]?[0-9]*)$'`);
        if (!spec.accessModes || !spec.accessModes.length) fail(`The PersistentVolumeClaim "${name}" is invalid: spec.accessModes: Required value: at least 1 access mode is required`);
        const pspec = { accessModes: spec.accessModes.map(str), storageClassName: spec.storageClassName == null ? null : str(spec.storageClassName), resources: { requests: { storage: str(want) } } };
        if (existing && existing.terminating) fail(`Error from server (AlreadyExists): error when creating "${file}": object is being deleted: persistentvolumeclaims "${name}" already exists`);
        if (existing) {
          const sameExceptSize = stable(existing.spec.accessModes) === stable(pspec.accessModes) && (pspec.storageClassName == null || pspec.storageClassName === (existing.spec.storageClassName || existing.storageClassResolved));
          if (!sameExceptSize || existing.phase !== 'Bound' && stable(existing.spec) !== stable(Object.assign({}, pspec, { storageClassName: existing.spec.storageClassName }))) fail(`The PersistentVolumeClaim "${name}" is invalid: spec: Forbidden: spec is immutable after creation except resources.requests and volumeAttributesClassName for bound claims\n  core.PersistentVolumeClaimSpec{\n  \tAccessModes:      {${existing.spec.accessModes.map(x => `"${x}"`).join(', ')}},\n- \tStorageClassName: &"${existing.spec.storageClassName || existing.storageClassResolved}",\n+ \tStorageClassName: &"${pspec.storageClassName}",\n  }`);
          const nowMi = Q.mem(existing.spec.resources.requests.storage), newMi = Q.mem(pspec.resources.requests.storage);
          if (newMi < existing.capacityMi) fail(`The PersistentVolumeClaim "${name}" is invalid: spec.resources.requests.storage: Forbidden: field can not be less than status.capacity`);
          if (newMi > nowMi) {
            const sc = c.get('StorageClass', '', existing.storageClassResolved || existing.spec.storageClassName);
            if (!sc || !sc.allowVolumeExpansion) fail(`Error from server (Forbidden): error when applying patch:\nfor: "${file}": persistentvolumeclaims "${name}" is forbidden: only dynamically provisioned pvc can be resized and the storageclass that provisions the pvc must support resize`);
          }
          if (validateOnly()) break;
          const changed = newMi !== nowMi || stable(existing.labels) !== stable(labels);
          existing.spec.resources.requests.storage = pspec.resources.requests.storage; existing.labels = labels;
          return done(changed);
        }
        if (validateOnly()) break;
        c.createPVC({ ns, name, labels, accessModes: pspec.accessModes, storageClassName: pspec.storageClassName, size: pspec.resources.requests.storage });
        return done(true, true);
      }
      case 'StorageClass': {
        if (!doc.provisioner) fail(`The StorageClass "${name}" is invalid: provisioner: Required value`);
        if (existing && existing.provisioner !== doc.provisioner) fail(`The StorageClass "${name}" is invalid: provisioner: Forbidden: updates to provisioner are forbidden.`);
        vals = { provisioner: str(doc.provisioner), allowVolumeExpansion: !!doc.allowVolumeExpansion, reclaimPolicy: doc.reclaimPolicy || 'Delete', volumeBindingMode: doc.volumeBindingMode || 'Immediate', parameters: strMap(doc.parameters, 'parameters'), isDefault: annotations['storageclass.kubernetes.io/is-default-class'] === 'true', labels };
        keys = ['allowVolumeExpansion', 'labels', 'isDefault'];
        break;
      }
      case 'PodDisruptionBudget': {
        if (spec.minAvailable != null && spec.maxUnavailable != null) fail(`The PodDisruptionBudget "${name}" is invalid: spec: Invalid value: policy.PodDisruptionBudgetSpec{...}: minAvailable and maxUnavailable cannot be both set`);
        const selector = parseSelectorObj(kind, name, spec.selector, 'spec.selector');
        const iop = v => (v == null ? null : /%$/.test(String(v)) ? String(v) : Number(v));
        vals = { selector, minAvailable: iop(spec.minAvailable), maxUnavailable: spec.minAvailable == null ? iop(spec.maxUnavailable == null ? 1 : spec.maxUnavailable) : null, labels };
        keys = ['selector', 'minAvailable', 'maxUnavailable', 'labels'];
        break;
      }
      default: fail(`error: ${kind} objects can't be applied in this training cluster`);
    }
    if (validateOnly()) return res + ' ' + (existing ? 'configured' : 'created') + ' (dry run)';
    return save(vals, keys);
  }

  /* strategic-merge-ish patch: maps merge, lists of named objects merge by name, other lists replace */
  function merge(base, patch) {
    if (patch === null) return undefined;
    if (Array.isArray(patch)) {
      if (Array.isArray(base) && patch.every(x => x && typeof x === 'object' && x.name) && base.every(x => x && typeof x === 'object' && x.name)) {
        const out = base.map(x => clone(x));
        patch.forEach(p => { const i = out.findIndex(x => x.name === p.name); if (i >= 0) out[i] = merge(out[i], p); else out.push(clone(p)); });
        return out;
      }
      return clone(patch);
    }
    if (patch && typeof patch === 'object') {
      const out = base && typeof base === 'object' && !Array.isArray(base) ? clone(base) : {};
      Object.keys(patch).forEach(k => { const v = merge(out[k], patch[k]); if (v === undefined) delete out[k]; else out[k] = v; });
      return out;
    }
    return patch;
  }

  K.manifest = { toManifest, applyDoc, ApplyError, merge, API, RES, PLURAL };
})(window.K = window.K || {});

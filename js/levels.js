/* levels.js — the incidents. Each one is: setup (build a healthy cluster, then break it the way
   production breaks), ordered objectives with checks against real cluster state, and a postmortem.
   check(c, g): c is the cluster (engine.js), g the game (facts the player produced, see kubectl.js). */
(function (K) {
  'use strict';
  const DAY = 86400;
  const HOST = 'tickets.stagedoor.io';

  /* ---------- helpers for checks ---------- */
  const dep = (c, ns, n) => c.get('Deployment', ns, n);
  const podsOf = (c, ns, n) => { const d = dep(c, ns, n); return d ? c.podsOfDeployment(d) : []; };
  const healthy = (c, ns, n) => { const d = dep(c, ns, n); return !!d && d.replicas > 0 && c.rolloutComplete(d) && podsOf(c, ns, n).every(p => p.ready && p.phase === 'Running'); };
  const ctr = (c, ns, n) => { const d = dep(c, ns, n); return d ? d.template.spec.containers[0] : {}; };
  const envVal = (c, ns, n, k) => { const e = (ctr(c, ns, n).env || []).find(x => x.name === k); return e ? e.value : undefined; };
  const memLimit = (c, ns, n) => K.qty.mem(((ctr(c, ns, n).resources || {}).limits || {}).memory);
  const flowOk = (c, id, thr) => { const s = c.flowStats[id]; return !!s && s.ok >= (thr == null ? 0.99 : thr); };
  const firstPod = (c, ns, n, pred) => {
    const p = podsOf(c, ns, n).concat(c.list('Pod', ns).filter(q => q.labels.app === n)).filter(q => !q.deleting).filter(pred || (() => true)).sort((a, b) => (a.name < b.name ? -1 : 1))[0];
    return p ? p.name : '<pod>';
  };
  const failing = p => /BackOff|Err|Error|OOM|Pending|ContainerCreating|Init/.test(K.podStatus(p)) || !p.node;
  const policyExists = (c, ns, n) => !!c.get('NetworkPolicy', ns, n);
  const toolboxReaches = (c, url) => c.request(c.TOOLBOX, url).ok;
  const fromPod = (c, ns, n, url) => { const p = podsOf(c, ns, n).find(q => q.ready); return p ? c.request(c.srcOf(p), url) : { ok: false }; };

  /* ---------- the platform: nodes, add-ons, storage, RBAC defaults ---------- */
  const COREFILE = '.:53 {\n    errors\n    health {\n       lameduck 5s\n    }\n    ready\n    kubernetes cluster.local in-addr.arpa ip6.arpa {\n       pods insecure\n       fallthrough in-addr.arpa ip6.arpa\n       ttl 30\n    }\n    prometheus :9153\n    forward . /etc/resolv.conf {\n       max_concurrent 1000\n    }\n    cache 30\n    loop\n    reload\n    loadbalance\n}\n';
  const sys = (cpu, mem, lim) => ({ requests: { cpu, memory: mem }, limits: lim ? { memory: lim } : undefined });
  function platform(c, o) {
    o = o || {};
    for (let i = 1; i <= (o.nodes || 3); i++) c.addNode('node-' + i, (o.nodeOpts && o.nodeOpts[i]) || {});
    ['default', 'kube-node-lease', 'kube-public', 'kube-system', 'ingress-nginx'].forEach(n => c.addNamespace(n));
    [['shop', 'storefront'], ['payments', 'payments'], ['inventory', 'inventory']].concat((o.namespaces || []).map(n => [n, n])).forEach(([n, t]) => c.addNamespace(n, { team: t }));
    c.createService({ ns: 'default', name: 'kubernetes', clusterIP: '10.96.0.1', ports: [{ name: 'https', port: 443, targetPort: 6443 }], labels: { component: 'apiserver', provider: 'kubernetes' }, staticEndpoints: ['10.0.0.1:6443'] });
    c.createConfigMap('kube-system', 'coredns', { Corefile: COREFILE });
    c.createService({ ns: 'kube-system', name: 'kube-dns', clusterIP: K.CONST.DNS_IP, selector: { 'k8s-app': 'kube-dns' }, labels: { 'k8s-app': 'kube-dns' }, ports: [{ name: 'dns', port: 53, protocol: 'UDP' }, { name: 'dns-tcp', port: 53 }, { name: 'metrics', port: 9153 }] });
    c.createDeployment({ ns: 'kube-system', name: 'coredns', replicas: 2, labels: { 'k8s-app': 'kube-dns' }, spec: {
      containers: [{ name: 'coredns', image: 'registry.k8s.io/coredns/coredns:v1.12.1', args: ['-conf', '/etc/coredns/Corefile'], env: [], envFrom: [],
        ports: [{ containerPort: 53, name: 'dns', protocol: 'UDP' }, { containerPort: 53, name: 'dns-tcp', protocol: 'TCP' }], resources: sys('100m', '70Mi', '170Mi'), volumeMounts: [{ mountPath: '/etc/coredns', name: 'config-volume', readOnly: true }] }],
      volumes: [{ name: 'config-volume', configMap: { name: 'coredns', items: [{ key: 'Corefile', path: 'Corefile' }] } }], serviceAccountName: 'default' } });
    c.createDeployment({ ns: 'kube-system', name: 'metrics-server', replicas: 1, labels: { 'k8s-app': 'metrics-server' }, image: 'registry.k8s.io/metrics-server/metrics-server:v0.8.0', resources: sys('100m', '200Mi') });
    c.createDaemonSet({ ns: 'kube-system', name: 'kube-proxy', image: 'registry.k8s.io/kube-proxy:' + K.CONST.VERSION, labels: { 'k8s-app': 'kube-proxy' }, resources: sys('50m', '50Mi') });
    c.createDeployment({ ns: 'ingress-nginx', name: 'ingress-nginx-controller', replicas: 1, labels: { 'app.kubernetes.io/name': 'ingress-nginx' }, image: 'registry.k8s.io/ingress-nginx/controller:v1.13.1', port: 80, resources: sys('100m', '90Mi') });
    c.createService({ ns: 'ingress-nginx', name: 'ingress-nginx-controller', type: 'LoadBalancer', selector: { 'app.kubernetes.io/name': 'ingress-nginx' }, ports: [{ name: 'http', port: 80, targetPort: 80 }, { name: 'https', port: 443, targetPort: 80 }] });
    c.createStorageClass({ name: 'gp3', isDefault: true, allowVolumeExpansion: true, parameters: { type: 'gp3' }, volumeBindingMode: 'Immediate' });
    c.createStorageClass({ name: 'io2', allowVolumeExpansion: false, parameters: { type: 'io2', iopsPerGB: '50' } });
    const all = [{ apiGroups: ['*'], resources: ['*'], verbs: ['*'] }];
    const read = ['get', 'list', 'watch'], write = ['create', 'update', 'patch', 'delete'];
    const common = ['pods', 'services', 'configmaps', 'endpoints', 'persistentvolumeclaims', 'events'];
    [['cluster-admin', all], ['admin', [{ apiGroups: ['', 'apps', 'networking.k8s.io', 'rbac.authorization.k8s.io'], resources: ['*'], verbs: ['*'] }]],
      ['edit', [{ apiGroups: [''], resources: common.concat(['secrets']), verbs: read.concat(write) }, { apiGroups: ['apps'], resources: ['deployments', 'replicasets'], verbs: read.concat(write) }]],
      ['view', [{ apiGroups: [''], resources: common, verbs: read }, { apiGroups: ['apps'], resources: ['deployments', 'replicasets', 'daemonsets'], verbs: read }]]]
      .forEach(([name, rules]) => c.put(c.obj('ClusterRole', { name, rules, labels: { 'kubernetes.io/bootstrapping': 'rbac-defaults' } })));
    c.put(c.obj('ClusterRoleBinding', { name: 'cluster-admin', roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'cluster-admin' }, subjects: [{ apiGroup: 'rbac.authorization.k8s.io', kind: 'Group', name: 'system:masters' }] }));
  }

  /* one Stagedoor service: a Deployment plus (usually) a Service */
  function app(c, d) {
    const port = d.port === null ? null : (d.port || 8080);
    const ct = { name: d.name, image: d.image, env: (d.env || []).map(e => ({ name: e[0], value: e[1] })), envFrom: d.envFrom || [],
      ports: port ? [{ containerPort: port, name: d.portName || 'http', protocol: 'TCP' }] : [],
      resources: d.resources === undefined ? { requests: { cpu: '100m', memory: '128Mi' }, limits: { memory: '256Mi' } } : d.resources, volumeMounts: d.mounts || [] };
    if (d.readiness !== null && port) ct.readinessProbe = d.readiness || { httpGet: { path: '/healthz', port: d.portName || 'http' }, periodSeconds: 5 };
    if (d.liveness) ct.livenessProbe = d.liveness;
    if (d.startup) ct.startupProbe = d.startup;
    const spec = { containers: [ct], initContainers: d.init || [], volumes: d.volumes || [], serviceAccountName: d.sa || 'default', nodeSelector: d.nodeSelector || {}, tolerations: d.tolerations || [], imagePullSecrets: d.pullSecrets || [], restartPolicy: 'Always' };
    c.createDeployment({ ns: d.ns, name: d.name, replicas: d.replicas == null ? 2 : d.replicas, labels: { app: d.name, 'app.kubernetes.io/part-of': 'stagedoor' }, selector: { app: d.name }, podLabels: { app: d.name }, spec, strategy: d.strategy });
    if (port && !d.noService) c.createService({ ns: d.ns, name: d.name, selector: { app: d.name }, labels: { app: d.name }, ports: [{ name: d.portName || 'http', port: d.svcPort || port, targetPort: d.targetPort || d.portName || 'http' }] });
  }
  const pick = (o, k, base) => (o[k] === false ? null : Object.assign(base, o[k] || {}));
  /* the whole Stagedoor shop. Pass overrides per service, or false to leave one out. */
  function stagedoor(c, o) {
    o = o || {};
    const S = [
      pick(o, 'storefront', { ns: 'shop', name: 'storefront', image: 'stagedoor/storefront:5.3', replicas: 3, svcPort: 80 }),
      pick(o, 'checkout', { ns: 'shop', name: 'checkout', image: 'stagedoor/checkout:3.2', replicas: 3, svcPort: 80, env: [['PAYMENTS_URL', 'http://payments.payments:8080'], ['INVENTORY_URL', 'http://inventory.inventory:8080']] }),
      pick(o, 'payments', { ns: 'payments', name: 'payments', image: 'stagedoor/payments:2.7', replicas: 2 }),
      pick(o, 'inventory', { ns: 'inventory', name: 'inventory', image: 'stagedoor/inventory:4.0', replicas: 2, env: [['DB_HOST', 'seats-db']] }),
      pick(o, 'seatsdb', { ns: 'inventory', name: 'seats-db', image: 'postgres:16', replicas: 1, port: 5432, portName: 'postgres', env: [['POSTGRES_PASSWORD', 'local-only']], readiness: { tcpSocket: { port: 5432 }, periodSeconds: 5 },
        resources: { requests: { cpu: '250m', memory: '512Mi' }, limits: { memory: '1Gi' } }, strategy: { type: 'Recreate' },
        volumes: [{ name: 'data', persistentVolumeClaim: { claimName: 'seats-db-data' } }], mounts: [{ mountPath: '/var/lib/postgresql/data', name: 'data' }] }),
    ].filter(Boolean);
    if (S.some(s => s.name === 'seats-db')) c.createPVC({ ns: 'inventory', name: 'seats-db-data', size: o.dbSize || '20Gi', storageClassName: 'gp3', usedMi: o.dbUsed || 3100 });
    S.forEach(s => app(c, s));
    c.put(c.obj('Ingress', { name: 'tickets', namespace: 'shop', ingressClassName: 'nginx', labels: { app: 'stagedoor' }, tls: [{ hosts: [HOST], secretName: 'tickets-tls' }],
      rules: [{ host: HOST, paths: [{ path: '/', pathType: 'Prefix', backend: { name: 'storefront', port: 80, portName: null } }, { path: '/api/checkout', pathType: 'Prefix', backend: { name: 'checkout', port: o.checkoutIngressPort || 80, portName: null } }] }] }));
    c.addFlow({ id: 'storefront', label: 'Homepage', url: `https://${HOST}/`, rps: 300, perPod: 150 });
    c.addFlow({ id: 'checkout', label: 'Checkout', url: `https://${HOST}/api/checkout`, rps: 120, perPod: 80 });
  }
  function settle(c, days) { c.settle(16); c.clearEvents(); c.ageAll((days || 9) * DAY); }
  /* build healthy, age it, then break it so the incident looks minutes old */
  function breakNow(c, fn, ticks) { settle(c); fn(); c.settle(ticks || 10); }
  const patchCtr = (c, ns, n, fn) => { const d = dep(c, ns, n); fn(d.template.spec.containers[0], d.template.spec, d); };
  const netpol = (c, ns, name, spec) => c.put(c.obj('NetworkPolicy', Object.assign({ name, namespace: ns, ingress: null, egress: null }, spec)));
  const yaml = o => K.yaml.dump(o);

  const T = { 1: 'Triage', 2: 'Health checks and routing', 3: 'Networking and DNS', 4: 'Access and platform', 5: 'Capacity and storage', 6: 'Major incident' };

  K.TIERS = T;
  K.LEVELS = [
    /* ================= TIER 1: TRIAGE ================= */
    {
      id: 'crashloop', ticket: 'INC-101', sev: 'SEV-2', tier: 1, title: 'Checkout is crash looping', tags: ['CrashLoopBackOff', 'logs --previous', 'env vars'],
      alert: '[FIRING] CheckoutSuccessRate < 95% for 5m (shop/checkout)',
      story: "Welcome to the rotation. I'm Rhea, incident commander tonight. Someone tidied up checkout's config a few minutes ago, then deleted the checkout pods so they'd pick it up. Checkout is down hard. I'll walk you through the triage loop on this one.",
      concept: { title: 'The triage loop', body: '<b>get</b> shows what is unhealthy, <b>describe</b> shows what Kubernetes saw (state, exit code, events), and <b>logs</b> shows what the app said. A pod in <b>CrashLoopBackOff</b> starts, exits, and waits longer before each restart. The crash details live in the <i>previous</i> container: <code>kubectl logs &lt;pod&gt; --previous</code>.' },
      setup(c) {
        platform(c);
        c.createConfigMap('shop', 'checkout-env', { PAYMENTS_URL: 'http://payments.payments:8080', INVENTORY_URL: 'http://inventory.inventory:8080', LOG_LEVEL: 'info' });
        stagedoor(c, { checkout: { env: [], envFrom: [{ configMapRef: { name: 'checkout-env' } }] } });
        breakNow(c, () => {
          const cm = c.get('ConfigMap', 'shop', 'checkout-env');
          cm.data = { PAYMENT_URL: cm.data.PAYMENTS_URL, INVENTORY_URL: cm.data.INVENTORY_URL, LOG_LEVEL: 'info' };
          podsOf(c, 'shop', 'checkout').forEach(p => c.deleteObject('Pod', 'shop', p.name, true));
        }, 14);
      },
      objectives: [
        { text: 'See what is unhealthy in the <code>shop</code> namespace: <code>kubectl get pods -n shop</code>', hint: 'Add -n shop to look in that namespace. -A shows every namespace.', cmd: 'kubectl get pods -n shop', check: (c, g) => g.has('get:pods:in:shop') || g.has('get:pods:in:*') },
        { text: 'Describe one checkout pod. Read <b>State</b>, <b>Last State</b>, <b>Exit Code</b> and the Events at the bottom.', hint: 'kubectl describe pod <name> -n shop. Click a checkout pod on the map to paste its name.', cmd: c => `kubectl describe pod ${firstPod(c, 'shop', 'checkout')} -n shop`, check: (c, g) => g.has('describe:pod-of:checkout') },
        { text: 'Exit code 1 means the app quit on its own. Ask the app why: <code>kubectl logs &lt;pod&gt; -n shop --previous</code>', hint: '--previous shows the logs of the container that just crashed, not the one starting now.', cmd: c => `kubectl logs ${firstPod(c, 'shop', 'checkout')} -n shop --previous`, check: (c, g) => g.has('logs-prev:checkout') || g.has('logs-crashed:checkout') },
        { text: 'The pods get their environment from the <code>checkout-env</code> ConfigMap. Fix it so checkout starts. Payments lives at <code>http://payments.payments:8080</code>.', hint: 'Compare the key the app wants with the keys in the ConfigMap (kubectl describe configmap checkout-env -n shop). kubectl edit configmap checkout-env -n shop opens it in the editor; save, then kubectl apply -f the file.',
          cmd: 'kubectl create configmap checkout-env -n shop --from-literal=PAYMENTS_URL=http://payments.payments:8080 --from-literal=INVENTORY_URL=http://inventory.inventory:8080 --from-literal=LOG_LEVEL=info --dry-run=client -o yaml | kubectl apply -f -',
          check: c => healthy(c, 'shop', 'checkout'),
          feedback: c => (('PAYMENTS_URL' in c.get('ConfigMap', 'shop', 'checkout-env').data) ? 'ConfigMap fixed. The crashing containers read it again on their next restart attempt…' : null) },
        { text: 'Verify like a customer: <code>curl https://tickets.stagedoor.io/api/checkout</code>', hint: 'A 200 with "status":"ok" means checkout is back.', cmd: `curl https://${HOST}/api/checkout`, check: (c, g) => g.since(`curl:${HOST}:ok`) && flowOk(c, 'checkout') },
      ],
      learned: ['CrashLoopBackOff is a symptom, not a cause. Exit code and logs tell you the cause.', 'kubectl logs --previous shows the crashed container, which is usually the one you want.', 'Changing a ConfigMap does not roll a Deployment. Containers read it when they start, which is why deleting the pods turned a typo into an outage.'],
      postmortem: { q: 'What was the root cause?', options: ['The payments service was down', 'A renamed ConfigMap key meant the app could not find PAYMENTS_URL and exited at startup', 'Kubernetes killed the pods for using too much memory', 'The image tag did not exist'], answer: 1, explain: 'The cleanup renamed PAYMENTS_URL to PAYMENT_URL in the ConfigMap. Deleting the pods made every replica restart with the bad config at once, with none of the protection a rolling update gives you.' },
    },
    {
      id: 'bad-release', ticket: 'INC-102', sev: 'SEV-3', tier: 1, title: 'The release that never landed', tags: ['ImagePullBackOff', 'rollouts', 'rollback'],
      alert: '[FIRING] DeployPipelineTimeout: payments 2.9 not available after 10m',
      story: 'The deploy pipeline timed out shipping payments 2.9. Customers are fine for now, but the release is half-applied and nobody trusts it. Find out what happened and get us back to a known-good state.',
      concept: { title: 'Rolling updates protect you', body: 'A rolling update starts new pods before removing old ones, and only removes an old pod when a new one is <b>Ready</b>. If new pods can\'t start, the rollout stalls and the old pods keep serving. <code>kubectl rollout undo</code> returns to the previous revision.' },
      setup(c) {
        platform(c); stagedoor(c, { payments: { replicas: 3 } }); settle(c);
        const d = dep(c, 'payments', 'payments'); d.template.spec.containers[0].image = 'stagedoor/payments:2.9'; d.changeCause = 'deploy-bot: payments 2.9 (pipeline #4512)';
        c.settle(8);
      },
      objectives: [
        { text: 'Check the rollout: <code>kubectl rollout status deployment/payments -n payments</code>', hint: 'rollout status follows a rollout until it completes or stalls. Press Ctrl+C to stop watching.', cmd: 'kubectl rollout status deployment/payments -n payments', check: (c, g) => g.has('rollout:status:payments') },
        { text: 'Find out why the new pod can\'t start: describe it.', hint: 'The new pod is the one that isn\'t Running. Read the Events: Failed to pull image…', cmd: c => `kubectl describe pod ${firstPod(c, 'payments', 'payments', p => /Image|Err/.test(p.phase))} -n payments`, check: (c, g) => g.has('describe:pod-status:ImagePullBackOff') || g.has('describe:pod-status:ErrImagePull') },
        { text: 'Tag 2.9 was never pushed. Roll back to the last good revision.', hint: 'kubectl rollout undo deployment/<name> -n <ns>', cmd: 'kubectl rollout undo deployment/payments -n payments', check: c => ctr(c, 'payments', 'payments').image === 'stagedoor/payments:2.7' && healthy(c, 'payments', 'payments') },
        { text: 'Capture the history for the postmortem: <code>kubectl rollout history deployment/payments -n payments</code>', hint: 'History lists every revision and its change cause.', cmd: 'kubectl rollout history deployment/payments -n payments', check: (c, g) => g.since('rollout:history:payments') },
      ],
      learned: ['ImagePullBackOff means the kubelet could not pull the image: wrong tag, missing image, or no credentials.', 'A failed rolling update stalls instead of taking the service down, because old pods stay until new ones are Ready.', 'rollout undo restores the previous pod template. rollout history shows what changed.'],
      postmortem: { q: 'Why did customers see no errors even though the release failed?', options: ['The pipeline retried automatically', 'The rolling update never removed an old pod, because no new pod became Ready', 'Kubernetes cached the old image', 'Payments has no customers at night'], answer: 1, explain: 'With 3 replicas the default maxUnavailable rounds down to 0, so the Deployment only removes an old pod after a new one is Ready. None ever was, so all three old pods kept serving.' },
    },
    {
      id: 'oomkilled', ticket: 'INC-103', sev: 'SEV-2', tier: 1, title: 'Death by memory limit', tags: ['OOMKilled', 'exit 137', 'limits', 'kubectl top'],
      alert: '[FIRING] KubePodCrashLooping: inventory/inventory-* restarted 6 times in 10m',
      story: 'Inventory 4.1 went out this afternoon with a new seat-map cache. Since then its pods restart every minute or so, and checkout errors spike each time. No crash in the app logs, which is weird.',
      concept: { title: 'Requests, limits and the OOM killer', body: 'A memory <b>limit</b> is a hard ceiling. When a container goes over it, the kernel kills it: Kubernetes reports <b>OOMKilled</b> with <b>exit code 137</b> (128 + SIGKILL). The app gets no chance to log anything. <code>kubectl top pods</code> shows live usage.' },
      setup(c) { platform(c); stagedoor(c); breakNow(c, () => { dep(c, 'inventory', 'inventory').template.spec.containers[0].image = 'stagedoor/inventory:4.1'; }, 40); },
      objectives: [
        { text: 'Look at the inventory pods and their restart counts: <code>kubectl get pods -n inventory</code>', hint: 'RESTARTS climbing with no app error is a clue.', cmd: 'kubectl get pods -n inventory', check: (c, g) => g.has('get:pods:in:inventory') || g.has('get:pods:in:*') },
        { text: 'Describe an inventory pod. How did its last container die?', hint: 'Look at Last State: Reason and Exit Code.', cmd: c => `kubectl describe pod ${firstPod(c, 'inventory', 'inventory')} -n inventory`, check: (c, g) => g.has('describe:last-state:OOMKilled'), feedback: (c, g) => (g.has('describe:pod-of:inventory') && !g.has('describe:last-state:OOMKilled') ? 'Describe a pod that has restarted at least once to see Last State.' : null) },
        { text: 'Watch memory climb toward the limit: <code>kubectl top pods -n inventory</code>', hint: 'Run it a few times. Compare MEMORY with the 256Mi limit in describe.', cmd: 'kubectl top pods -n inventory', check: (c, g) => g.has('top:pod-of:inventory') },
        { text: 'The 4.1 cache needs about 400Mi. Give inventory enough memory, with a matching request.', hint: 'kubectl set resources deployment/inventory -n inventory --requests=memory=384Mi --limits=memory=512Mi', cmd: 'kubectl set resources deployment/inventory -n inventory --requests=memory=384Mi --limits=memory=512Mi', steady: 8,
          check: c => memLimit(c, 'inventory', 'inventory') >= 420 && healthy(c, 'inventory', 'inventory') && !podsOf(c, 'inventory', 'inventory').some(p => p.phase === 'OOMKilled'),
          feedback: c => (memLimit(c, 'inventory', 'inventory') && memLimit(c, 'inventory', 'inventory') < 420 ? `A ${K.qty.fmtMem(memLimit(c, 'inventory', 'inventory'))} limit is still below what the cache needs.` : null) },
      ],
      learned: ['OOMKilled with exit code 137 means the container exceeded its memory limit and the kernel killed it.', 'The app never logs an OOM kill, so describe (Last State) is where you see it.', 'Set the request near real usage and the limit with headroom above the peak.'],
      postmortem: { q: 'Exit code 137 means…', options: ['The app called exit(137)', 'The process received SIGKILL (128 + 9), here from the OOM killer', 'A liveness probe failed', 'The image was corrupted'], answer: 1, explain: 'Exit codes above 128 mean "killed by signal (code − 128)". Signal 9 is SIGKILL, which is what the kernel OOM killer sends. Liveness probe kills usually show 137 or 143 too, so read the Reason field to tell them apart.' },
    },
    {
      id: 'pending-cpu', ticket: 'INC-104', sev: 'SEV-3', tier: 1, title: 'Stuck in Pending', tags: ['Pending', 'scheduler', 'requests'],
      alert: '[FIRING] KubeDeploymentReplicasMismatch: shop/search 0/2 for 15m',
      story: 'The search team shipped a new service before going home. It has been 0/2 for fifteen minutes and their manager is asking why "Kubernetes is broken". It isn\'t, but let\'s prove it.',
      concept: { title: 'How the scheduler decides', body: 'The scheduler places a pod only on a node whose <b>allocatable</b> capacity minus everything already <b>requested</b> fits the pod\'s requests. Actual usage doesn\'t matter for placement. A pod that fits nowhere stays <b>Pending</b>, and the <code>FailedScheduling</code> event says exactly why.' },
      setup(c) { platform(c); stagedoor(c); breakNow(c, () => app(c, { ns: 'shop', name: 'search', image: 'stagedoor/search:1.0', replicas: 2, resources: { requests: { cpu: 3, memory: '256Mi' }, limits: { memory: '512Mi' } } }), 8); },
      objectives: [
        { text: 'Describe one of the <code>search</code> pods in <code>shop</code> and read the scheduler\'s event.', hint: 'kubectl get pods -n shop, then kubectl describe pod <search-pod> -n shop.', cmd: c => `kubectl describe pod ${firstPod(c, 'shop', 'search')} -n shop`, check: (c, g) => g.has('describe:pod-status:Pending') },
        { text: 'Compare what search asks for with what a node can offer: <code>kubectl describe nodes</code>', hint: 'Find Allocatable and the "Allocated resources" table.', cmd: 'kubectl describe nodes', check: (c, g) => g.has('describe:nodes') },
        { text: 'The manifest says <code>cpu: 3</code> (three whole cores). The team meant 300 millicores. Fix the request.', hint: 'kubectl set resources deployment/search -n shop --requests=cpu=300m', cmd: 'kubectl set resources deployment/search -n shop --requests=cpu=300m', check: c => healthy(c, 'shop', 'search') },
      ],
      learned: ['Pending means "not scheduled yet". The FailedScheduling event lists why each node was rejected.', 'Scheduling uses requests, not live usage and not limits.', 'cpu: 3 is three cores; 300m is three tenths of one.'],
      postmortem: { q: 'Which numbers does the scheduler compare when placing a pod?', options: ['Current CPU usage on each node', 'The pod\'s limits against node capacity', 'The pod\'s requests against each node\'s allocatable minus other pods\' requests', 'Whatever the HPA recommends'], answer: 2, explain: 'Placement is pure bookkeeping on requests. A node at 5% real CPU can still be "full" if pods have requested all of it, and an idle-looking cluster can have nowhere to put a big request.' },
    },

    /* ================= TIER 2: HEALTH CHECKS AND ROUTING ================= */
    {
      id: 'readiness-404', ticket: 'INC-201', sev: 'SEV-2', tier: 2, title: 'Half the homepage', tags: ['readiness', 'liveness', 'rollouts'],
      alert: '[FIRING] HomepageErrorRate > 40% for 5m (ingress tickets.stagedoor.io /)',
      story: 'storefront 5.4 started rolling out six minutes ago. Since then about half of homepage requests fail, and the rollout isn\'t moving. 5.4 has the new seat map marketing promised for tonight, so a rollback is the last resort.',
      concept: { title: 'Readiness and liveness probes', body: 'A <b>readiness</b> probe decides whether a pod receives traffic; failing it removes the pod from Service endpoints. A <b>liveness</b> probe decides whether the container is restarted. Both call an endpoint the app must actually serve. Change the endpoint in the app without changing the probe, and healthy pods look dead.' },
      setup(c) {
        platform(c);
        stagedoor(c, { storefront: { replicas: 2, strategy: { type: 'RollingUpdate', rollingUpdate: { maxSurge: '25%', maxUnavailable: '50%' } }, liveness: { httpGet: { path: '/healthz', port: 'http' }, initialDelaySeconds: 10, periodSeconds: 10, failureThreshold: 3 } } });
        settle(c);
        dep(c, 'shop', 'storefront').template.spec.containers[0].image = 'stagedoor/storefront:5.4';
        c.settle(10);
      },
      objectives: [
        { text: 'See what state the storefront rollout is in.', hint: 'kubectl rollout status deployment/storefront -n shop, or kubectl get pods -n shop.', cmd: 'kubectl get pods -n shop', check: (c, g) => g.has('rollout:status:storefront') || g.has('get:pods:in:shop') || g.has('get:deployments:in:shop') },
        { text: 'Find out why the new 5.4 pods never become Ready.', hint: 'Describe a storefront pod that shows 0/1 and read the Unhealthy events.', cmd: c => `kubectl describe pod ${firstPod(c, 'shop', 'storefront', p => !p.ready)} -n shop`, check: (c, g) => g.has('describe:pod-of:storefront') },
        { text: 'The probe gets a 404. Ask a 5.4 pod which health endpoints it serves.', hint: 'kubectl logs <a 5.4 storefront pod> -n shop. The app prints its endpoints at startup.', cmd: c => `kubectl logs ${firstPod(c, 'shop', 'storefront', p => /5\.4/.test(p.spec.containers[0].image))} -n shop`, check: (c, g) => g.has('logs:storefront') },
        { text: 'Fix forward: point both probes at the endpoints 5.4 really serves.', hint: '5.4 serves /readyz for readiness and /livez for liveness. Use kubectl edit deployment/storefront -n shop, or kubectl patch with a containers list that includes "name": "storefront".',
          cmd: `kubectl patch deployment storefront -n shop -p '{"spec":{"template":{"spec":{"containers":[{"name":"storefront","readinessProbe":{"httpGet":{"path":"/readyz","port":"http"}},"livenessProbe":{"httpGet":{"path":"/livez","port":"http"}}}]}}}}'`,
          check: c => { const ct = ctr(c, 'shop', 'storefront'); return /5\.4$/.test(ct.image) && ct.readinessProbe && ['/readyz', '/livez'].includes(ct.readinessProbe.httpGet && ct.readinessProbe.httpGet.path) && (!ct.livenessProbe || ['/readyz', '/livez'].includes(ct.livenessProbe.httpGet && ct.livenessProbe.httpGet.path)) && healthy(c, 'shop', 'storefront'); },
          feedback: c => (!/5\.4$/.test(ctr(c, 'shop', 'storefront').image) ? 'You rolled back. That stops the bleeding, but marketing needs 5.4 tonight: fix the probes on 5.4.' : null) },
        { text: 'Confirm the homepage error rate is back to zero.', hint: 'Watch the SLO panel, or curl https://tickets.stagedoor.io/ a few times.', cmd: `curl https://${HOST}/`, check: c => flowOk(c, 'storefront'), steady: 3 },
      ],
      learned: ['A failing readiness probe removes a pod from endpoints; a failing liveness probe restarts it.', 'Probe paths are part of the app\'s contract. Change them together with the app.', 'maxUnavailable decides how much capacity a stuck rollout can cost you.'],
      postmortem: { q: 'Why did half the requests fail instead of all of them?', options: ['The ingress retried', 'maxUnavailable: 50% let the rollout remove one of two old pods; the remaining one could only serve half the load', 'Readiness probes only run half the time', 'One node was down'], answer: 1, explain: 'With 2 replicas and maxUnavailable 50%, the Deployment removed one old pod immediately. The new pods never became Ready, so one old pod carried a homepage that needs two. A lower maxUnavailable would have made this a non-event.' },
    },
    {
      id: 'slow-start', ticket: 'INC-202', sev: 'SEV-3', tier: 2, title: 'Killed before it could start', tags: ['liveness', 'startupProbe', 'CrashLoopBackOff'],
      alert: '[FIRING] KubePodNotReady: shop/pricing-* not ready for 15m',
      story: 'pricing is a new Java service for dynamic fares. It works on every laptop, but in the cluster it never becomes Ready and restarts forever. The team swears there is no crash.',
      concept: { title: 'Startup probes', body: 'A liveness probe that starts checking before the app is up will kill it mid-startup, over and over. A <b>startupProbe</b> holds off liveness and readiness until the app has started once, with its own generous budget (<code>failureThreshold × periodSeconds</code>). After that, liveness stays fast and strict.' },
      setup(c) {
        platform(c); stagedoor(c);
        breakNow(c, () => app(c, { ns: 'shop', name: 'pricing', image: 'stagedoor/pricing:6.0', replicas: 2, resources: { requests: { cpu: '250m', memory: '512Mi' }, limits: { memory: '768Mi' } }, liveness: { httpGet: { path: '/healthz', port: 'http' }, initialDelaySeconds: 15, periodSeconds: 5, failureThreshold: 3 } }), 40);
      },
      objectives: [
        { text: 'Find out what keeps restarting <code>pricing</code> in <code>shop</code>.', hint: 'Describe a pricing pod. Read the Unhealthy and Killing events.', cmd: c => `kubectl describe pod ${firstPod(c, 'shop', 'pricing')} -n shop`, check: (c, g) => g.has('describe:pod-of:pricing') },
        { text: 'Read the logs of the killed container. Did the app crash, or was it stopped mid-startup?', hint: 'kubectl logs <pod> -n shop --previous. Look at the last lines.', cmd: c => `kubectl logs ${firstPod(c, 'shop', 'pricing', p => p.restarts > 0)} -n shop --previous`, check: (c, g) => g.has('logs-prev:pricing') },
        { text: 'pricing needs about 45 seconds to start. Give it that time without weakening liveness once it is running.', hint: 'Add a startupProbe on /healthz with periodSeconds 5 and failureThreshold 30 (up to 150s to start).',
          cmd: `kubectl patch deployment pricing -n shop -p '{"spec":{"template":{"spec":{"containers":[{"name":"pricing","startupProbe":{"httpGet":{"path":"/healthz","port":"http"},"periodSeconds":5,"failureThreshold":30}}]}}}}'`,
          steady: 5,
          check: c => { const ct = ctr(c, 'shop', 'pricing'); const sp = ct.startupProbe, lp = ct.livenessProbe; const budget = sp ? (sp.initialDelaySeconds || 0) + (sp.periodSeconds || 10) * (sp.failureThreshold || 3) : 0; return (budget >= 60 || (lp && (lp.initialDelaySeconds || 0) >= 50)) && healthy(c, 'shop', 'pricing'); },
          feedback: c => { const sp = ctr(c, 'shop', 'pricing').startupProbe; return sp && (sp.periodSeconds || 10) * (sp.failureThreshold || 3) < 60 ? 'The startup probe exists, but its budget is shorter than the startup time.' : null; } },
        { text: 'Verify from inside the cluster: <code>curl pricing.shop:8080/healthz</code>', hint: 'Your shell lives in the default namespace, so use the name.namespace form.', cmd: 'curl pricing.shop:8080/healthz', check: (c, g) => g.matchSince(/^curl:pricing\.shop(\.svc(\.cluster\.local)?)?:ok$/) },
      ],
      learned: ['Liveness probes that start too early turn a slow start into an endless restart loop.', 'startupProbe gives slow apps a generous one-time budget; liveness takes over afterwards.', 'Exit code 143 (SIGTERM) plus "failed liveness probe" in events means Kubernetes stopped it, not that it crashed.'],
      postmortem: { q: 'Why is a startupProbe better than a 60 second initialDelaySeconds on liveness?', options: ['It isn\'t; they are identical', 'It only waits as long as needed and keeps liveness fast afterwards; a long initialDelay delays detection after every restart too', 'startupProbe disables liveness forever', 'initialDelaySeconds is deprecated'], answer: 1, explain: 'A startup probe ends as soon as the app answers, then normal liveness checks begin. A big initialDelaySeconds always waits the full time, and it applies again after every restart.' },
    },
    {
      id: 'targetport', ticket: 'INC-203', sev: 'SEV-1', tier: 2, title: 'Endpoints, but no answer', tags: ['Services', 'targetPort', 'exec'],
      alert: '[FIRING] CheckoutSuccessRate < 50% for 2m (shop/checkout)  · payments 2.8 deployed 4m ago',
      story: 'Payments shipped 2.8 four minutes ago. Every payments pod is Running and Ready, its dashboards are green, and yet checkout cannot pay for anything. The payments team says "not us". Find the hop that\'s broken.',
      concept: { title: 'Services, ports and endpoints', body: 'A Service forwards <code>port</code> to each endpoint\'s <code>targetPort</code>. A numeric targetPort is taken on faith: if the app moved to another port, endpoints still look perfect but connections are refused. A <b>named</b> targetPort (like <code>http</code>) follows the container port with that name.' },
      setup(c) {
        platform(c); stagedoor(c, { payments: { targetPort: 8080 } });
        breakNow(c, () => patchCtr(c, 'payments', 'payments', ct => { ct.image = 'stagedoor/payments:2.8'; ct.ports = [{ containerPort: 9090, name: 'http', protocol: 'TCP' }]; }), 14);
      },
      objectives: [
        { text: 'Reproduce it from the outside.', hint: 'curl https://tickets.stagedoor.io/api/checkout and read the error detail.', cmd: `curl https://${HOST}/api/checkout`, check: (c, g) => g.has(`curl:${HOST}:502`) },
        { text: 'Checkout says payments refused the connection. Does the payments Service have endpoints?', hint: 'kubectl get endpoints -n payments, or kubectl describe service payments -n payments.', cmd: 'kubectl describe service payments -n payments', check: (c, g) => g.has('get:endpoints') || g.has('describe:services:payments') || g.has('describe:endpoints') },
        { text: 'Endpoints are there, yet connections fail. See it from a checkout pod\'s point of view.', hint: 'kubectl exec <checkout-pod> -n shop -- curl -s http://payments.payments:8080/healthz', cmd: c => `kubectl exec ${firstPod(c, 'shop', 'checkout')} -n shop -- curl -s http://payments.payments:8080/healthz`, check: (c, g) => g.match(/^exec:checkout:curl:payments/) },
        { text: 'Find the port payments 2.8 actually listens on.', hint: 'kubectl logs on a payments pod, or the Port line in kubectl describe pod.', cmd: c => `kubectl logs ${firstPod(c, 'payments', 'payments')} -n payments`, check: (c, g) => g.has('logs:payments') || g.has('describe:pod-of:payments') },
        { text: 'Fix the Service so traffic reaches the port the app listens on, and keeps doing so next time it moves.', hint: 'Set targetPort to the container port\'s name, http. kubectl patch service payments -n payments -p \'{"spec":{"ports":[{"name":"http","port":8080,"targetPort":"http"}]}}\'',
          cmd: `kubectl patch service payments -n payments -p '{"spec":{"ports":[{"name":"http","port":8080,"targetPort":"http"}]}}'`, check: c => flowOk(c, 'checkout'), steady: 3 },
      ],
      learned: ['Ready endpoints only prove the selector matched; they don\'t prove anything listens on targetPort.', 'kubectl exec <pod> -- curl shows the network exactly as that pod sees it.', 'Name your container ports and target them by name.'],
      postmortem: { q: 'Why did the payments readiness probe pass while the Service failed?', options: ['Probes skip the network', 'The probe targeted the named port http (9090); the Service sent traffic to the hard-coded 8080', 'Readiness probes are cached', 'The Service selector was wrong'], answer: 1, explain: 'The probe followed the named container port to 9090. The Service still pointed at 8080, a number nobody updated when the app moved.' },
    },
    {
      id: 'deploy-errors', ticket: 'INC-204', sev: 'SEV-3', tier: 2, title: 'Errors on every deploy', tags: ['readiness', 'zero downtime', 'rollouts'],
      alert: '[TICKET] Product: "the homepage shows a 502 for a few seconds every time we deploy"',
      story: 'Not a fire, a slow burn: every storefront deploy produces a burst of 502s. Product found it in the error budget report. Reproduce it, fix it, and prove that deploys are clean now.',
      concept: { title: 'Zero-downtime deploys need readiness', body: 'Without a readiness probe, Kubernetes marks a pod Ready as soon as its container <i>starts</i>, not when the app is listening. Traffic arrives during startup and fails. A readiness probe holds the pod out of the Service until the app really answers.' },
      setup(c) { platform(c); stagedoor(c, { storefront: { readiness: null } }); settle(c); },
      onTick(c, g) {
        const d = dep(c, 'shop', 'storefront'), s = c.flowStats.storefront;
        if (!d || !s) return;
        const st = g.state;
        if (!c.rolloutComplete(d)) { if (!st.rolling) { st.rolling = true; st.cur = 0; } st.tail = 5; st.cur += s.failed; }
        else if (st.rolling) {
          st.cur += s.failed;
          if (--st.tail <= 0) { st.rolling = false; st.rollouts = (st.rollouts || 0) + 1; st.last = { failed: st.cur, probe: !!ctr(c, 'shop', 'storefront').readinessProbe, seq: g.seq }; }
        }
      },
      objectives: [
        { text: 'Reproduce it: restart storefront (a deploy without code changes) and watch the error panel.', hint: 'kubectl rollout restart deployment/storefront -n shop. Wait until the rollout is done.', cmd: 'kubectl rollout restart deployment/storefront -n shop', check: (c, g) => g.state.last && g.state.last.failed > 0,
          feedback: (c, g) => (g.state.rolling ? 'Rollout in progress. Watch the homepage error count…' : null) },
        { text: 'Why does traffic reach pods that aren\'t listening yet? Inspect storefront\'s container spec.', hint: 'kubectl describe deployment storefront -n shop. Is there a Readiness line?', cmd: 'kubectl describe deployment storefront -n shop', check: (c, g) => g.has('describe:deployments:storefront') || g.has('describe:pod-of:storefront') || g.has('get:deployments:storefront:yaml') },
        { text: 'Add a readiness probe so pods only get traffic once the app answers on <code>/healthz</code>.', hint: 'kubectl patch deployment storefront -n shop with a readinessProbe (httpGet /healthz on port http, periodSeconds 2).',
          cmd: `kubectl patch deployment storefront -n shop -p '{"spec":{"template":{"spec":{"containers":[{"name":"storefront","readinessProbe":{"httpGet":{"path":"/healthz","port":"http"},"periodSeconds":2}}]}}}}'`,
          check: c => !!ctr(c, 'shop', 'storefront').readinessProbe && healthy(c, 'shop', 'storefront') },
        { text: 'Prove it: deploy again. This time the rollout must finish with zero failed requests.', hint: 'kubectl rollout restart deployment/storefront -n shop, then wait for it to finish.', cmd: 'kubectl rollout restart deployment/storefront -n shop',
          check: (c, g) => g.since('rollout:restart:storefront') && g.state.last && g.state.last.probe && g.state.last.seq > g.activatedAt && g.state.last.failed === 0,
          feedback: (c, g) => (g.state.rolling ? 'Rollout in progress…' : g.state.last && g.state.last.failed > 0 && g.state.last.seq > g.activatedAt ? `That rollout still dropped ${g.state.last.failed} requests. Is the probe checking the right port and path?` : null) },
      ],
      learned: ['No readiness probe means "Ready as soon as the process starts".', 'Rolling updates are only zero-downtime when readiness reflects reality.', 'Measure deploy impact; "it\'s only a few seconds" adds up in the error budget.'],
      postmortem: { q: 'Before the fix, when did Kubernetes consider a new storefront pod Ready?', options: ['When the app answered /healthz', 'As soon as the container process started', 'After 30 seconds', 'When the old pod terminated'], answer: 1, explain: 'With no readiness probe, Ready means "container running". storefront needs about 8 seconds to start listening, and the ingress sent it real traffic during that window.' },
    },

    /* ================= TIER 3: NETWORKING AND DNS ================= */
    {
      id: 'dns-namespace', ticket: 'INC-301', sev: 'SEV-1', tier: 3, title: 'No such host', tags: ['DNS', 'namespaces', 'search path'],
      alert: '[FIRING] CheckoutSuccessRate < 5% for 3m (shop/checkout)',
      story: 'Inventory finished migrating to its own namespace last sprint, and the old inventory Service in shop was cleaned up an hour ago. Checkout has been failing ever since. Nobody touched checkout.',
      concept: { title: 'How cluster DNS resolves short names', body: 'Every pod\'s <code>/etc/resolv.conf</code> searches <code>&lt;its-namespace&gt;.svc.cluster.local</code> first. So <code>inventory</code> from a pod in <code>shop</code> means <code>inventory.shop</code>. Across namespaces, use <code>name.namespace</code> or the full <code>name.namespace.svc.cluster.local</code>.' },
      setup(c) { platform(c); stagedoor(c, { checkout: { env: [['PAYMENTS_URL', 'http://payments.payments:8080'], ['INVENTORY_URL', 'http://inventory:8080']] } }); settle(c); },
      objectives: [
        { text: 'Read what checkout itself is saying.', hint: 'kubectl logs deployment/checkout -n shop', cmd: 'kubectl logs deployment/checkout -n shop', check: (c, g) => g.has('logs:checkout') },
        { text: 'Test name resolution from inside a checkout pod.', hint: 'kubectl exec <checkout-pod> -n shop -- nslookup inventory', cmd: c => `kubectl exec ${firstPod(c, 'shop', 'checkout')} -n shop -- nslookup inventory`, check: (c, g) => g.match(/^exec:checkout:nslookup:inventory/) },
        { text: 'Find a name for inventory that resolves from the shop namespace.', hint: 'Try inventory.inventory from the same pod. Also look at its /etc/resolv.conf (exec … -- cat /etc/resolv.conf).', cmd: c => `kubectl exec ${firstPod(c, 'shop', 'checkout')} -n shop -- nslookup inventory.inventory`, check: (c, g) => g.match(/^exec:checkout:nslookup:inventory\.inventory.*:ok$/) },
        { text: 'Point checkout at that name.', hint: 'kubectl set env deployment/checkout -n shop INVENTORY_URL=http://inventory.inventory:8080', cmd: 'kubectl set env deployment/checkout -n shop INVENTORY_URL=http://inventory.inventory:8080', check: c => /inventory\.inventory/.test(envVal(c, 'shop', 'checkout', 'INVENTORY_URL') || '') && flowOk(c, 'checkout'), steady: 3 },
      ],
      learned: ['Short service names resolve in the caller\'s namespace, not the service\'s.', 'kubectl exec <pod> -- nslookup <name> tests DNS exactly as the app sees it.', 'When you move a service between namespaces, every client\'s URL is part of the migration.'],
      postmortem: { q: 'Why did "inventory" work until an hour ago?', options: ['CoreDNS cached it', 'A Service named inventory still existed in shop until the cleanup removed it', 'The DNS TTL expired', 'Checkout was restarted'], answer: 1, explain: 'The short name always meant inventory.shop. It worked only because the old Service in shop still existed and forwarded somewhere useful. The cleanup removed the last thing holding the stale URL up.' },
    },
    {
      id: 'default-deny', ticket: 'INC-302', sev: 'SEV-1', tier: 3, title: 'Default deny', tags: ['NetworkPolicy', 'timeouts', 'least privilege'],
      alert: '[FIRING] CheckoutSuccessRate < 5% for 3m  · change CHG-2291 (security: default-deny in payments) completed 5m ago',
      story: 'Security rolled out default-deny ingress for the payments namespace five minutes ago, as part of PCI hardening. Checkout immediately started failing. The security lead is adamant: default-deny stays. Make checkout work inside the new rules.',
      concept: { title: 'NetworkPolicy', body: 'Once any policy selects a pod for <b>Ingress</b>, only traffic some policy explicitly allows can reach it. Blocked packets are dropped, so clients see <b>timeouts</b>, not refusals. A peer with both <code>namespaceSelector</code> and <code>podSelector</code> in the same list item means "these pods in those namespaces". Every namespace has the label <code>kubernetes.io/metadata.name</code>.' },
      setup(c, g) {
        platform(c); stagedoor(c); settle(c);
        netpol(c, 'payments', 'default-deny-ingress', { podSelector: {}, policyTypes: ['Ingress'], labels: { 'change': 'CHG-2291' } });
        c.settle(3);
        g.files.set('allow-checkout.yaml', [
          '# Allow checkout (pods labelled app=checkout in the shop namespace)',
          '# to reach payments on TCP 8080. Fill in the "from" list.',
          '# Hint: namespaces carry the label kubernetes.io/metadata.name: <name>',
          '# Careful: an empty "from" list allows traffic from EVERYWHERE.',
          'apiVersion: networking.k8s.io/v1', 'kind: NetworkPolicy', 'metadata:', '  name: allow-checkout', '  namespace: payments', 'spec:',
          '  podSelector:', '    matchLabels:', '      app: payments', '  policyTypes:', '  - Ingress', '  ingress:', '  - from: []', '    ports:', '    - protocol: TCP', '      port: 8080', ''].join('\n'));
      },
      objectives: [
        { text: 'From a checkout pod, try to reach payments.', hint: 'kubectl exec <checkout-pod> -n shop -- curl -s http://payments.payments:8080/healthz', cmd: c => `kubectl exec ${firstPod(c, 'shop', 'checkout')} -n shop -- curl -s http://payments.payments:8080/healthz`, check: (c, g) => g.match(/^exec:checkout:curl:payments.*:timeout$/) },
        { text: 'A timeout, not a refusal. Rule out DNS from the same pod.', hint: 'kubectl exec <checkout-pod> -n shop -- nslookup payments.payments', cmd: c => `kubectl exec ${firstPod(c, 'shop', 'checkout')} -n shop -- nslookup payments.payments`, check: (c, g) => g.match(/^exec:checkout:nslookup:payments.*:ok$/) },
        { text: 'List and read the network policies in <code>payments</code>.', hint: 'kubectl describe networkpolicy -n payments', cmd: 'kubectl describe networkpolicy -n payments', check: (c, g) => g.has('get:networkpolicies') || g.has('describe:networkpolicies') },
        { text: 'Allow checkout, and only checkout, to reach payments on 8080. Finish <code>allow-checkout.yaml</code> and apply it. Default-deny stays.', hint: 'In the from list add one item with namespaceSelector (kubernetes.io/metadata.name: shop) AND podSelector (app: checkout) together. Then kubectl apply -f allow-checkout.yaml.',
          cmd: '(edit allow-checkout.yaml: replace "from: []" with a peer that has namespaceSelector kubernetes.io/metadata.name: shop and podSelector app: checkout)\nkubectl apply -f allow-checkout.yaml',
          check: c => policyExists(c, 'payments', 'default-deny-ingress') && flowOk(c, 'checkout') && !toolboxReaches(c, 'http://payments.payments:8080/healthz'),
          feedback: c => (!policyExists(c, 'payments', 'default-deny-ingress') ? 'Security needs default-deny-ingress back in place.' : toolboxReaches(c, 'http://payments.payments:8080/healthz') ? 'Too broad: even your debug shell in the default namespace can reach payments now.' : null) },
      ],
      learned: ['NetworkPolicy drops traffic silently, so blocked connections time out.', 'Policies are additive allow-lists; you fix a deny by adding a narrow allow, not by deleting the deny.', 'namespaceSelector and podSelector in one peer item are ANDed; in two items they are ORed.'],
      postmortem: { q: 'What would "from: []" (or omitting from) have done?', options: ['Blocked everything', 'Allowed traffic from any source on 8080, defeating the default-deny', 'Allowed only same-namespace traffic', 'Been rejected by the API server'], answer: 1, explain: 'An ingress rule with no from list matches every source. It would have fixed checkout and quietly undone the security change.' },
    },
    {
      id: 'coredns-down', ticket: 'INC-303', sev: 'SEV-1', tier: 3, title: 'It\'s always DNS', tags: ['CoreDNS', 'kube-system', 'ConfigMaps'],
      alert: '[FIRING] CheckoutSuccessRate < 5%  · [FIRING] KubePodCrashLooping kube-system/coredns-*',
      story: 'A platform engineer added a stub domain to the cluster DNS config and deleted the CoreDNS pods "so they pick it up". Then went to dinner. Checkout is down; the homepage oddly still works.',
      concept: { title: 'Cluster DNS', body: 'CoreDNS runs as pods in <code>kube-system</code> behind the <code>kube-dns</code> Service (10.96.0.10). Its configuration, the <b>Corefile</b>, lives in a ConfigMap. If CoreDNS can\'t parse it, it exits, and every name lookup in the cluster times out. Traffic that doesn\'t use DNS keeps working, which is a clue.' },
      setup(c) {
        platform(c); stagedoor(c); settle(c);
        const cm = c.get('ConfigMap', 'kube-system', 'coredns');
        cm.data.Corefile = cm.data.Corefile.replace('forward . /etc/resolv.conf', 'forward . /etc/resolve.conf');
        c.list('Pod', 'kube-system').filter(p => /^coredns/.test(p.name)).forEach(p => c.deleteObject('Pod', 'kube-system', p.name, true));
        c.settle(8);
      },
      objectives: [
        { text: 'Is it just checkout? Test DNS from your own shell.', hint: 'nslookup payments.payments', cmd: 'nslookup payments.payments', check: (c, g) => g.match(/^nslookup:.*:timeout$/) },
        { text: 'Every lookup times out. Check the cluster DNS pods.', hint: 'kubectl get pods -n kube-system', cmd: 'kubectl get pods -n kube-system', check: (c, g) => g.has('get:pods:in:kube-system') || g.has('get:pods:in:*') },
        { text: 'Read why CoreDNS won\'t start.', hint: 'kubectl logs <coredns-pod> -n kube-system', cmd: c => `kubectl logs ${firstPod(c, 'kube-system', 'coredns')} -n kube-system`, check: (c, g) => g.has('logs:coredns') || g.has('logs-prev:coredns') },
        { text: 'Fix the Corefile in the <code>coredns</code> ConfigMap and apply it.', hint: 'kubectl edit configmap coredns -n kube-system opens coredns-configmap.yaml. Fix the forward line, save, then kubectl apply -f coredns-configmap.yaml.',
          cmd: 'kubectl edit configmap coredns -n kube-system\n(in coredns-configmap.yaml, change /etc/resolve.conf to /etc/resolv.conf)\nkubectl apply -f coredns-configmap.yaml',
          check: c => !K.apps.validateCorefile(c.get('ConfigMap', 'kube-system', 'coredns').data.Corefile || '') && healthy(c, 'kube-system', 'coredns'),
          feedback: c => (!K.apps.validateCorefile(c.get('ConfigMap', 'kube-system', 'coredns').data.Corefile || '') ? 'The Corefile parses now. CoreDNS picks it up on its next restart attempt…' : null) },
        { text: 'Verify that checkout works again.', hint: 'curl https://tickets.stagedoor.io/api/checkout', cmd: `curl https://${HOST}/api/checkout`, check: c => flowOk(c, 'checkout'), steady: 3 },
      ],
      learned: ['If every lookup times out everywhere, look at CoreDNS in kube-system first.', 'Config in a ConfigMap is not validated by Kubernetes; the consumer finds the typo at startup.', 'The ingress talks to pod IPs directly, which is why the homepage survived a DNS outage.'],
      postmortem: { q: 'Why did the homepage keep working while checkout failed?', options: ['The homepage is cached by a CDN', 'The ingress controller routes to endpoint IPs without DNS; checkout resolves payments and inventory by name', 'storefront has its own DNS server', 'Luck'], answer: 1, explain: 'ingress-nginx reads endpoints from the API and connects to pod IPs. Checkout needs DNS to find its dependencies, so it failed as soon as CoreDNS did.' },
    },
    {
      id: 'egress-dns', ticket: 'INC-304', sev: 'SEV-1', tier: 3, title: 'Lockdown', tags: ['NetworkPolicy', 'egress', 'DNS'],
      alert: '[FIRING] CheckoutSuccessRate < 5%  · change CHG-2307 (egress lockdown for shop) completed 4m ago',
      story: 'Round two of PCI hardening: an egress lockdown for shop. It only allows traffic to payments and inventory on 8080. Checkout died the moment it applied. This time CoreDNS is perfectly healthy.',
      concept: { title: 'Egress policies and DNS', body: 'An <b>Egress</b> policy limits where selected pods may connect. DNS is a connection too: UDP and TCP port 53 to the kube-dns pods in <code>kube-system</code>. Forget it and every lookup from those pods times out, while DNS works fine everywhere else.' },
      setup(c, g) {
        platform(c); stagedoor(c); settle(c);
        const to = ns => ({ to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': ns } } }], ports: [{ protocol: 'TCP', port: 8080 }] });
        netpol(c, 'shop', 'egress-lockdown', { podSelector: {}, policyTypes: ['Egress'], egress: [to('payments'), to('inventory')], labels: { change: 'CHG-2307' } });
        c.settle(3);
        g.files.set('allow-dns.yaml', ['# Let every pod in shop reach cluster DNS.', '# Fill in "egress": allow UDP and TCP 53 to pods labelled k8s-app=kube-dns', '# in the kube-system namespace.', 'apiVersion: networking.k8s.io/v1', 'kind: NetworkPolicy', 'metadata:', '  name: allow-dns', '  namespace: shop', 'spec:', '  podSelector: {}', '  policyTypes:', '  - Egress', '  egress: []', ''].join('\n'));
      },
      objectives: [
        { text: 'Read checkout\'s logs.', hint: 'kubectl logs deployment/checkout -n shop', cmd: 'kubectl logs deployment/checkout -n shop', check: (c, g) => g.has('logs:checkout') },
        { text: 'Lookups time out for checkout. Does DNS work from your own shell?', hint: 'nslookup payments.payments', cmd: 'nslookup payments.payments', check: (c, g) => g.match(/^nslookup:.*:ok$/) },
        { text: 'DNS is up. Confirm the failure from inside a checkout pod.', hint: 'kubectl exec <checkout-pod> -n shop -- nslookup payments.payments', cmd: c => `kubectl exec ${firstPod(c, 'shop', 'checkout')} -n shop -- nslookup payments.payments`, check: (c, g) => g.match(/^exec:checkout:nslookup:.*:timeout$/) },
        { text: 'Read the lockdown policy.', hint: 'kubectl describe networkpolicy egress-lockdown -n shop', cmd: 'kubectl describe networkpolicy egress-lockdown -n shop', check: (c, g) => g.has('describe:networkpolicies') || g.has('get:networkpolicies:egress-lockdown:yaml') },
        { text: 'Let shop pods reach cluster DNS. Finish <code>allow-dns.yaml</code> and apply it. The lockdown stays.', hint: 'One egress rule: to a peer with namespaceSelector kubernetes.io/metadata.name: kube-system and podSelector k8s-app: kube-dns, ports UDP 53 and TCP 53.',
          cmd: '(edit allow-dns.yaml: add an egress rule to kube-dns pods in kube-system on UDP and TCP 53)\nkubectl apply -f allow-dns.yaml',
          check: c => policyExists(c, 'shop', 'egress-lockdown') && flowOk(c, 'checkout') && !fromPod(c, 'shop', 'checkout', 'http://api.psp.example/v1/charges').ok,
          feedback: c => (!policyExists(c, 'shop', 'egress-lockdown') ? 'Security needs egress-lockdown back.' : fromPod(c, 'shop', 'checkout', 'http://api.psp.example/v1/charges').ok ? 'Too broad: checkout can reach the internet now. Scope the rule to kube-dns on port 53.' : null) },
      ],
      learned: ['An egress lockdown must explicitly allow DNS (UDP and TCP 53 to kube-dns).', 'Compare the failing pod with a healthy vantage point to find where the problem lives.', 'Policies add up: a new allow-dns policy fixes the gap without touching the lockdown.'],
      postmortem: { q: 'Why did "nslookup" work from your shell but not from checkout?', options: ['Your shell uses a different DNS server', 'The egress policy only selected pods in shop; your debug shell runs in default', 'CoreDNS blocks pods by name', 'Checkout caches failures'], answer: 1, explain: 'NetworkPolicies apply to the pods they select. The lockdown selected every pod in shop and allowed nothing to port 53, so only shop pods lost DNS.' },
    },

    /* ================= TIER 4: ACCESS AND PLATFORM ================= */
    {
      id: 'rbac', ticket: 'INC-401', sev: 'SEV-3', tier: 4, title: 'Forbidden', tags: ['RBAC', 'ServiceAccounts', 'auth can-i'],
      alert: '[FIRING] FeatureFlagsStale: flag-sync has not synced for 20m',
      story: 'flag-sync watches ConfigMaps and pushes feature flags to the shop. Platform moved it from staging into shop this morning, Role and RoleBinding included, "copy-pasted from staging, same as always". It has crashed ever since, and tonight\'s on-sale flag can\'t flip.',
      concept: { title: 'RBAC', body: 'A pod talks to the API as its <b>ServiceAccount</b> (<code>system:serviceaccount:&lt;ns&gt;:&lt;name&gt;</code>). A <b>Role</b> lists allowed verbs on resources; a <b>RoleBinding</b> grants it to <i>subjects</i>. For a ServiceAccount subject, the namespace in the binding must be the account\'s namespace. <code>kubectl auth can-i … --as=…</code> asks the API server directly.' },
      setup(c) {
        platform(c); stagedoor(c);
        c.put(c.obj('ServiceAccount', { name: 'flag-sync', namespace: 'shop' }));
        c.put(c.obj('Role', { name: 'flag-reader', namespace: 'shop', rules: [{ apiGroups: [''], resources: ['configmaps'], verbs: ['get', 'list', 'watch'] }] }));
        c.put(c.obj('RoleBinding', { name: 'flag-sync-reads-flags', namespace: 'shop', roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: 'flag-reader' }, subjects: [{ kind: 'ServiceAccount', name: 'flag-sync', namespace: 'staging' }] }));
        c.createConfigMap('shop', 'flags-onsale', { 'onsale.enabled': 'false' }, { 'stagedoor.io/flags': 'true' });
        breakNow(c, () => app(c, { ns: 'shop', name: 'flag-sync', image: 'stagedoor/flag-sync:1.4', replicas: 1, port: 8081, sa: 'flag-sync', noService: true, resources: { requests: { cpu: '50m', memory: '64Mi' }, limits: { memory: '128Mi' } } }), 20);
      },
      objectives: [
        { text: 'Find out why <code>flag-sync</code> keeps dying.', hint: 'kubectl logs <flag-sync-pod> -n shop --previous', cmd: c => `kubectl logs ${firstPod(c, 'shop', 'flag-sync')} -n shop --previous`, check: (c, g) => g.has('logs-prev:flag-sync') || g.has('logs-crashed:flag-sync') },
        { text: 'Ask the API server whether flag-sync\'s identity may list ConfigMaps in shop.', hint: 'kubectl auth can-i list configmaps -n shop --as=system:serviceaccount:shop:flag-sync', cmd: 'kubectl auth can-i list configmaps -n shop --as=system:serviceaccount:shop:flag-sync', check: (c, g) => g.match(/^auth:can-i:system:serviceaccount:shop:flag-sync:(list|watch|get):configmaps:/) },
        { text: 'A Role and a RoleBinding exist. Find out why they don\'t apply.', hint: 'kubectl describe rolebinding -n shop. Compare the subject with the identity in the error.', cmd: 'kubectl describe rolebinding flag-sync-reads-flags -n shop', check: (c, g) => g.has('describe:rolebindings') || g.has('get:rolebindings:flag-sync-reads-flags:yaml') },
        { text: 'Fix the binding so flag-sync can read ConfigMaps in shop, and nothing more.', hint: 'The subject\'s namespace is wrong. Patch it (subjects are mutable, roleRef is not), or create a new rolebinding with --serviceaccount=shop:flag-sync.',
          cmd: `kubectl patch rolebinding flag-sync-reads-flags -n shop --type=json -p '[{"op":"replace","path":"/subjects/0/namespace","value":"shop"}]'`, steady: 3,
          check: c => { const sa = { kind: 'ServiceAccount', namespace: 'shop', name: 'flag-sync' }; return c.can(sa, 'list', 'configmaps', 'shop') && c.can(sa, 'watch', 'configmaps', 'shop') && !c.can(sa, 'list', 'secrets', 'shop') && !c.can(sa, 'delete', 'pods', 'shop') && healthy(c, 'shop', 'flag-sync'); },
          feedback: c => { const sa = { kind: 'ServiceAccount', namespace: 'shop', name: 'flag-sync' }; return c.can(sa, 'list', 'secrets', 'shop') || c.can(sa, 'delete', 'pods', 'shop') ? 'That works, but flag-sync can now do far more than read ConfigMaps. Least privilege, please.' : c.can(sa, 'list', 'configmaps', 'shop') ? 'Permission granted. Waiting for flag-sync to restart and sync…' : null; } },
      ],
      learned: ['Pods act as their ServiceAccount; the identity string appears in every Forbidden error.', 'kubectl auth can-i --as tests permissions without guessing.', 'A RoleBinding subject for a ServiceAccount must name the account\'s own namespace.'],
      postmortem: { q: 'Why didn\'t the existing RoleBinding grant access?', options: ['The Role had the wrong verbs', 'Its subject was the flag-sync ServiceAccount in staging, a different identity than shop\'s flag-sync', 'RoleBindings need a restart', 'ConfigMaps require a ClusterRole'], answer: 1, explain: 'ServiceAccounts are namespaced: staging:flag-sync and shop:flag-sync are different identities. The copied binding granted the right permissions to the wrong one.' },
    },
    {
      id: 'quota', ticket: 'INC-402', sev: 'SEV-2', tier: 4, title: 'Scale-up refused', tags: ['ResourceQuota', 'admission', 'FailedCreate'],
      alert: '[PAGE] Rhea: on-sale for the farewell tour opens in 15 minutes. Pre-scale checkout.',
      story: 'Big night. The farewell-tour on-sale opens in fifteen minutes and checkout needs headroom before the queue releases. This should be a one-liner.',
      concept: { title: 'ResourceQuota', body: 'A <b>ResourceQuota</b> caps the total requests, limits or object counts in a namespace. It is enforced at <b>admission</b>: a pod that would exceed it is rejected before it exists, so there is nothing Pending to describe. The rejection appears as a <code>FailedCreate</code> event on the ReplicaSet.' },
      setup(c) {
        platform(c);
        stagedoor(c, { storefront: { resources: { requests: { cpu: '200m', memory: '256Mi' }, limits: { memory: '512Mi' } } }, checkout: { resources: { requests: { cpu: '250m', memory: '512Mi' }, limits: { memory: '768Mi' } } } });
        app(c, { ns: 'shop', name: 'loadtest', image: 'stagedoor/loadtest:1.0', replicas: 3, port: null, noService: true, resources: { requests: { cpu: '500m', memory: '1Gi' }, limits: { memory: '1Gi' } } });
        settle(c, 9);
        c.put(c.obj('ResourceQuota', { name: 'shop-compute', namespace: 'shop', hard: { 'requests.cpu': '3', 'requests.memory': '6Gi', pods: '20' } }));
      },
      objectives: [
        { text: 'Scale checkout to 6 replicas.', hint: 'kubectl scale deployment checkout -n shop --replicas=6', cmd: 'kubectl scale deployment checkout -n shop --replicas=6', check: c => dep(c, 'shop', 'checkout').replicas >= 6 },
        { text: 'It\'s stuck and nothing is Pending. Find out where the missing pods went.', hint: 'Pods that are never created leave events on their ReplicaSet: kubectl describe rs -n shop, or kubectl get events -n shop.', cmd: 'kubectl get events -n shop --sort-by=.lastTimestamp', check: (c, g) => g.has('describe:replicasets') || g.has('get:events') },
        { text: 'Check the namespace quota.', hint: 'kubectl describe quota -n shop', cmd: 'kubectl describe quota -n shop', check: (c, g) => g.has('get:resourcequotas') || g.has('describe:resourcequotas') || g.has('describe:namespaces:shop') },
        { text: 'Free quota without raising it (finance owns the quota). Something in shop shouldn\'t be there.', hint: 'kubectl get deployments -n shop. One of them is a load test that finished nine days ago.', cmd: 'kubectl delete deployment loadtest -n shop',
          check: c => { const q = c.get('ResourceQuota', 'shop', 'shop-compute'); return !!q && q.hard['requests.cpu'] === '3' && q.hard['requests.memory'] === '6Gi' && c.deploymentStatus(dep(c, 'shop', 'checkout')).ready >= 6; },
          feedback: c => { const q = c.get('ResourceQuota', 'shop', 'shop-compute'); return !q || q.hard['requests.cpu'] !== '3' || q.hard['requests.memory'] !== '6Gi' ? 'Finance owns that quota. Put it back to requests.cpu=3, requests.memory=6Gi.' : null; } },
      ],
      learned: ['Quota rejections happen at admission, so the evidence is a FailedCreate event, not a Pending pod.', 'kubectl describe quota shows used versus hard limits.', 'Forgotten workloads hold quota and node capacity forever.'],
      postmortem: { q: 'Why were there no Pending pods to describe?', options: ['The scheduler deleted them', 'The API server refused to create them because they would exceed the quota', 'They were evicted', 'The HPA scaled them away'], answer: 1, explain: 'Quota is admission control. The ReplicaSet controller asked to create a pod and the API server said no, so no pod object ever existed.' },
    },
    {
      id: 'registry-auth', ticket: 'INC-403', sev: 'SEV-3', tier: 4, title: '401 from the registry', tags: ['imagePullSecrets', 'Secrets', 'private registry'],
      alert: '[FIRING] DeployPipelineTimeout: payments → registry.stagedoor.io migration',
      story: 'We\'re moving payments images to our private registry. The pipeline switched the image and added an imagePullSecret, and the rollout stalled. The shop team has been pulling from the same registry for months without trouble.',
      concept: { title: 'Pulling from a private registry', body: 'The kubelet pulls images with credentials from the pod\'s <code>imagePullSecrets</code>: Secrets of type <code>kubernetes.io/dockerconfigjson</code> <b>in the pod\'s own namespace</b>. A missing or wrong secret shows up as <code>ErrImagePull</code> with <b>401 Unauthorized</b>.' },
      setup(c) {
        platform(c); stagedoor(c);
        c.registryCreds['registry.stagedoor.io'] = 'sd_pull_7Hq2x9Lw';
        c.createSecret('shop', 'regcred', { '.dockerconfigjson': JSON.stringify({ auths: { 'registry.stagedoor.io': { username: 'robot$shop-pull', password: 'sd_pull_7Hq2x9Lw', auth: K.b64.encode('robot$shop-pull:sd_pull_7Hq2x9Lw') } } }) }, 'kubernetes.io/dockerconfigjson');
        settle(c);
        const d = dep(c, 'payments', 'payments');
        d.template.spec.containers[0].image = 'registry.stagedoor.io/payments:2.7'; d.template.spec.imagePullSecrets = [{ name: 'regcred' }]; d.changeCause = 'deploy-bot: move payments to registry.stagedoor.io';
        c.settle(8);
      },
      objectives: [
        { text: 'Find the error on the new payments pod.', hint: 'Describe the payments pod that isn\'t Running. Read the pull events.', cmd: c => `kubectl describe pod ${firstPod(c, 'payments', 'payments', p => /Image|Err/.test(p.phase))} -n payments`, check: (c, g) => g.has('describe:pod-status:ImagePullBackOff') || g.has('describe:pod-status:ErrImagePull') },
        { text: 'The pod references a pull secret. Does it exist where the pod runs?', hint: 'kubectl get secrets -n payments', cmd: 'kubectl get secrets -n payments', check: (c, g) => g.has('get:secrets:in:payments') },
        { text: 'Copy shop\'s working registry credentials into payments.', hint: 'kubectl get secret regcred -n shop -o yaml > regcred.yaml, change the namespace in the file, then kubectl apply -f regcred.yaml.',
          cmd: 'kubectl get secret regcred -n shop -o yaml > regcred.yaml\n(in regcred.yaml, change namespace: shop to namespace: payments)\nkubectl apply -f regcred.yaml',
          check: c => !!c.get('Secret', 'payments', 'regcred') && !!c.pullCheck({ kind: 'Pod', name: 'pull-check', namespace: 'payments', spec: { imagePullSecrets: [{ name: 'regcred' }] } }, 'registry.stagedoor.io/payments:2.7').ok },
        { text: 'Make sure the rollout finishes.', hint: 'The kubelet retries the pull on its own. kubectl rollout status deployment/payments -n payments', cmd: 'kubectl rollout status deployment/payments -n payments', check: c => /^registry\.stagedoor\.io/.test(ctr(c, 'payments', 'payments').image) && healthy(c, 'payments', 'payments'), steady: 2 },
      ],
      learned: ['imagePullSecrets are looked up in the pod\'s namespace only.', '401 Unauthorized from the registry means missing or wrong credentials, not a missing image.', 'kubectl get -o yaml, edit, apply is the quickest way to copy an object between namespaces.'],
      postmortem: { q: 'Why did shop pull fine from the same registry?', options: ['shop uses a different registry mirror', 'shop had its own regcred Secret; Secrets are namespaced and payments had none', 'The registry whitelists shop', 'Image caching'], answer: 1, explain: 'Secrets don\'t cross namespaces. The pipeline added the reference to payments but never created the secret there.' },
    },
    {
      id: 'tainted-pool', ticket: 'INC-404', sev: 'SEV-3', tier: 4, title: 'The PCI node pool', tags: ['taints', 'tolerations', 'nodeSelector'],
      alert: '[FIRING] KubeDeploymentRolloutStuck: payments/payments',
      story: 'Compliance wants payments isolated on its own PCI node pool by the end of the week. Platform added node-4, tainted it so nothing else lands there, and set a nodeSelector on payments. The rollout has been stuck since.',
      concept: { title: 'Taints and tolerations', body: 'A <b>taint</b> on a node repels pods. Only pods with a matching <b>toleration</b> may schedule there. A <b>nodeSelector</b> is the opposite direction: it restricts a pod to nodes with certain labels. Dedicated pools need both: the selector to go there, the toleration to be allowed in.' },
      setup(c) {
        platform(c, { nodes: 4, nodeOpts: { 4: { labels: { pool: 'payments' }, taints: [{ key: 'dedicated', value: 'payments', effect: 'NoSchedule' }], type: 'm7i.large' } } });
        stagedoor(c); settle(c);
        const d = dep(c, 'payments', 'payments'); d.template.spec.nodeSelector = { pool: 'payments' }; d.changeCause = 'platform: pin payments to the PCI pool';
        c.settle(6);
      },
      objectives: [
        { text: 'Find out why the new payments pod can\'t be placed.', hint: 'Describe the Pending payments pod and read FailedScheduling.', cmd: c => `kubectl describe pod ${firstPod(c, 'payments', 'payments', p => !p.node)} -n payments`, check: (c, g) => g.has('describe:pod-status:Pending') },
        { text: 'Inspect the PCI node.', hint: 'kubectl describe node node-4. Look at Labels and Taints.', cmd: 'kubectl describe node node-4', check: (c, g) => g.has('describe:nodes:node-4') },
        { text: 'Let payments onto the pool. When you\'re done, every payments pod must run on node-4.', hint: 'Add a toleration for dedicated=payments:NoSchedule to the pod template (kubectl patch or kubectl edit).',
          cmd: `kubectl patch deployment payments -n payments -p '{"spec":{"template":{"spec":{"tolerations":[{"key":"dedicated","operator":"Equal","value":"payments","effect":"NoSchedule"}]}}}}'`,
          check: c => healthy(c, 'payments', 'payments') && podsOf(c, 'payments', 'payments').every(p => p.node === 'node-4'),
          feedback: c => (healthy(c, 'payments', 'payments') && podsOf(c, 'payments', 'payments').some(p => p.node !== 'node-4') ? 'Payments runs, but not only on node-4. Compliance needs the nodeSelector kept.' : null) },
        { text: 'Verify payments still works end to end.', hint: 'curl https://tickets.stagedoor.io/api/checkout', cmd: `curl https://${HOST}/api/checkout`, check: c => flowOk(c, 'checkout'), steady: 2 },
      ],
      learned: ['FailedScheduling counts each reason per node: taints, selectors and resources.', 'A taint keeps others out; a toleration only permits a pod in, it doesn\'t attract it.', 'Dedicated pools use a nodeSelector (or affinity) plus a toleration.'],
      postmortem: { q: 'If payments had the toleration but no nodeSelector, where could it run?', options: ['Only on node-4', 'On any node, including node-4', 'Nowhere', 'Only on untainted nodes'], answer: 1, explain: 'A toleration removes the barrier; it doesn\'t pull the pod toward the node. Without the selector, payments could land anywhere.' },
    },

    /* ================= TIER 5: CAPACITY AND STORAGE ================= */
    {
      id: 'pvc-pending', ticket: 'INC-501', sev: 'SEV-3', tier: 5, title: 'Unbound', tags: ['PersistentVolumeClaims', 'StorageClass', 'pvc-protection'],
      alert: '[FIRING] KubePodNotReady: analytics/reports-db-* Pending for 30m',
      story: 'The analytics team deployed reports-db from a manifest they copied from another company\'s blog post. It has been Pending for half an hour. Their manifest is in reports-pvc.yaml.',
      concept: { title: 'Dynamic provisioning', body: 'A <b>PersistentVolumeClaim</b> asks for storage from a <b>StorageClass</b>, whose provisioner creates a volume and binds it. A pod can\'t be scheduled until its claims are bound. A claim\'s class can\'t be changed after creation, and a claim in use by a pod stays <b>Terminating</b> until that pod is gone (<code>kubernetes.io/pvc-protection</code>).' },
      setup(c, g) {
        platform(c, { namespaces: ['analytics'] }); stagedoor(c);
        settle(c);
        c.createPVC({ ns: 'analytics', name: 'reports-data', size: '50Gi', storageClassName: 'fast-ssd' });
        app(c, { ns: 'analytics', name: 'reports-db', image: 'postgres:16', replicas: 1, port: 5432, portName: 'postgres', env: [['POSTGRES_PASSWORD', 'analytics-only']], readiness: { tcpSocket: { port: 5432 }, periodSeconds: 5 },
          resources: { requests: { cpu: '250m', memory: '512Mi' }, limits: { memory: '1Gi' } }, strategy: { type: 'Recreate' }, volumes: [{ name: 'data', persistentVolumeClaim: { claimName: 'reports-data' } }], mounts: [{ mountPath: '/var/lib/postgresql/data', name: 'data' }] });
        c.settle(10);
        g.files.set('reports-pvc.yaml', yaml({ apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: 'reports-data', namespace: 'analytics' }, spec: { accessModes: ['ReadWriteOnce'], storageClassName: 'fast-ssd', resources: { requests: { storage: '50Gi' } } } }));
      },
      objectives: [
        { text: 'Find out why the reports-db pod is Pending.', hint: 'kubectl describe pod <reports-db-pod> -n analytics', cmd: c => `kubectl describe pod ${firstPod(c, 'analytics', 'reports-db')} -n analytics`, check: (c, g) => g.has('describe:pod-of:reports-db') },
        { text: 'Look at the claim it\'s waiting for.', hint: 'kubectl describe pvc reports-data -n analytics', cmd: 'kubectl describe pvc reports-data -n analytics', check: (c, g) => g.has('describe:persistentvolumeclaims') || g.has('get:persistentvolumeclaims') },
        { text: 'Which StorageClasses does this cluster actually have?', hint: 'kubectl get storageclass', cmd: 'kubectl get storageclass', check: (c, g) => g.has('get:storageclasses') || g.has('describe:storageclasses') },
        { text: 'Recreate <code>reports-data</code> with a class that exists. (storageClassName can\'t be edited in place.)', hint: 'Scale reports-db to 0 and wait until its pod is gone, or the claim stays Terminating while the pod uses it. Then delete the claim, fix reports-pvc.yaml (gp3) and apply it.',
          cmd: 'kubectl scale deployment reports-db -n analytics --replicas=0\n(wait until kubectl get pods -n analytics shows no reports-db pod)\nkubectl delete pvc reports-data -n analytics\n(in reports-pvc.yaml, set storageClassName: gp3)\nkubectl apply -f reports-pvc.yaml',
          check: c => { const p = c.get('PersistentVolumeClaim', 'analytics', 'reports-data'); return !!p && !p.terminating && p.phase === 'Bound' && ['gp3', 'io2'].includes(p.storageClassResolved); },
          feedback: c => { const p = c.get('PersistentVolumeClaim', 'analytics', 'reports-data'); return p && p.terminating ? 'The claim is stuck Terminating: a pod still references it (kubernetes.io/pvc-protection). Scale reports-db to 0.' : null; } },
        { text: 'Bring reports-db back up.', hint: 'kubectl scale deployment reports-db -n analytics --replicas=1', cmd: 'kubectl scale deployment reports-db -n analytics --replicas=1', check: c => healthy(c, 'analytics', 'reports-db') },
      ],
      learned: ['"pod has unbound immediate PersistentVolumeClaims" means look at the PVC, then its StorageClass.', 'A PVC\'s storage class is immutable; recreate the claim to change it.', 'pvc-protection keeps a claim Terminating while any pod uses it, even a Pending one.'],
      postmortem: { q: 'Why did deleting the claim while reports-db existed leave it Terminating?', options: ['Deletes are slow on AWS', 'The pvc-protection finalizer waits until no pod references the claim', 'The PV had Retain policy', 'You lacked RBAC'], answer: 1, explain: 'Kubernetes refuses to pull storage out from under a pod. The finalizer is removed only once no pod (Pending ones included) references the claim.' },
    },
    {
      id: 'disk-full', ticket: 'INC-502', sev: 'SEV-1', tier: 5, title: 'No space left on device', tags: ['volumes', 'expansion', 'init containers', 'cascades'],
      alert: '[FIRING] CheckoutSuccessRate < 5%  · [FIRING] InventoryErrors  · [FIRING] KubePodCrashLooping inventory/seats-db',
      story: 'Three alerts at once, two teams paged, and everybody is blaming somebody else. Checkout says inventory is down. Inventory says the database is down. Find the actual root cause before the next on-sale.',
      concept: { title: 'Cascading failures and volume expansion', body: 'When many things fail together, follow the dependencies down to the one that fails on its own. <b>Init containers</b> run before the app and often wait for dependencies (Init:0/1). If a StorageClass has <code>allowVolumeExpansion: true</code>, you can grow a claim by raising <code>spec.resources.requests.storage</code>; modern CSI drivers resize the filesystem online.' },
      setup(c) {
        platform(c);
        stagedoor(c, { dbSize: '2Gi', dbUsed: 1700, inventory: { init: [{ name: 'wait-for-db', image: 'busybox:1.37', command: ['sh', '-c', 'until nc -z seats-db 5432; do echo waiting for seats-db; sleep 2; done'], env: [], envFrom: [], ports: [], resources: {}, volumeMounts: [] }] } });
        breakNow(c, () => { c.get('PersistentVolumeClaim', 'inventory', 'seats-db-data').usedMi = 2040; }, 12);
        const p = podsOf(c, 'inventory', 'inventory')[0]; if (p) c.deleteObject('Pod', 'inventory', p.name, true);
        c.settle(5);
      },
      objectives: [
        { text: 'Find every unhealthy pod across namespaces.', hint: 'kubectl get pods -A', cmd: 'kubectl get pods -A', check: (c, g) => g.has('get:pods:all-ns') || (g.has('get:pods:in:inventory')) },
        { text: 'One inventory pod is stuck in <code>Init:0/1</code>. Read its init container\'s logs.', hint: 'kubectl logs <pod> -n inventory -c wait-for-db', cmd: c => `kubectl logs ${firstPod(c, 'inventory', 'inventory', p => /^Init/.test(p.phase))} -n inventory -c wait-for-db`, check: (c, g) => g.has('logs-init:inventory') },
        { text: 'It\'s waiting for seats-db, which is crash looping. Find out why.', hint: 'kubectl logs <seats-db-pod> -n inventory --previous', cmd: c => `kubectl logs ${firstPod(c, 'inventory', 'seats-db')} -n inventory --previous`, check: (c, g) => g.has('logs-prev:seats-db') || g.has('logs-crashed:seats-db') },
        { text: 'The disk is full. Check the claim and whether its StorageClass allows growing it.', hint: 'kubectl get pvc -n inventory, then kubectl get storageclass (ALLOWVOLUMEEXPANSION).', cmd: 'kubectl get pvc -n inventory\nkubectl get storageclass', check: (c, g) => (g.has('get:persistentvolumeclaims') || g.has('describe:persistentvolumeclaims')) && (g.has('get:storageclasses') || g.has('describe:storageclasses')) },
        { text: 'Expand <code>seats-db-data</code> to 10Gi and get checkout working.', hint: 'kubectl patch pvc seats-db-data -n inventory -p \'{"spec":{"resources":{"requests":{"storage":"10Gi"}}}}\'',
          cmd: `kubectl patch pvc seats-db-data -n inventory -p '{"spec":{"resources":{"requests":{"storage":"10Gi"}}}}'`, steady: 3,
          check: c => { const p = c.get('PersistentVolumeClaim', 'inventory', 'seats-db-data'); return !!p && p.capacityMi >= 10240 && healthy(c, 'inventory', 'seats-db') && healthy(c, 'inventory', 'inventory') && flowOk(c, 'checkout'); },
          feedback: c => { const p = c.get('PersistentVolumeClaim', 'inventory', 'seats-db-data'); return p && p.resizing ? 'The volume is resizing…' : p && p.capacityMi >= 10240 ? 'Volume expanded. Waiting for seats-db, inventory and checkout to recover…' : null; } },
      ],
      learned: ['In a cascade, the component failing for its own reason is the root cause; the rest are victims.', 'Init:0/1 means an init container hasn\'t finished. Read it with logs -c <init-container>.', 'Expandable StorageClasses let you grow a claim in place by raising its request.'],
      postmortem: { q: 'Which alert pointed at the root cause?', options: ['CheckoutSuccessRate', 'InventoryErrors', 'seats-db CrashLoopBackOff', 'All equally'], answer: 2, explain: 'Checkout failed because inventory failed, and inventory failed because seats-db was down. Only seats-db failed for its own reason: its volume was full.' },
    },
    {
      id: 'noisy-neighbor', ticket: 'INC-503', sev: 'SEV-2', tier: 5, title: 'Noisy neighbour', tags: ['QoS classes', 'SystemOOM', 'evictions', 'requests'],
      alert: '[FIRING] KubePodCrashLooping shop/checkout-* · shop/storefront-* restarts with no deploy in 9 days',
      story: 'Checkout and storefront keep restarting, but nobody has deployed either in nine days and their memory graphs are flat. Analytics launched a nightly export job on node-2 yesterday. Coincidence?',
      concept: { title: 'QoS classes and node memory', body: 'Pods without any requests or limits are <b>BestEffort</b>: the scheduler reserves nothing for them, and when a node runs out of memory the kernel kills them first. <b>Burstable</b> pods have requests; <b>Guaranteed</b> pods have requests equal to limits. Under pressure the kubelet also <b>evicts</b> pods using more than they requested.' },
      setup(c) {
        platform(c, { namespaces: ['analytics'], nodeOpts: { 2: { labels: { disk: 'nvme' } } } });
        c.settle(4);
        app(c, { ns: 'analytics', name: 'report-export', image: 'stagedoor/report-export:0.9', replicas: 1, port: null, noService: true, nodeSelector: { disk: 'nvme' }, resources: { requests: { cpu: '500m', memory: '2800Mi' }, limits: { memory: '3400Mi' } } });
        c.settle(3);
        stagedoor(c, { storefront: { resources: {} }, checkout: { resources: {} } });
        c.settle(30); c.clearEvents(); c.ageAll(DAY); c.settle(8);
      },
      objectives: [
        { text: 'Look at restart counts in <code>shop</code>.', hint: 'kubectl get pods -n shop -o wide (the NODE column matters).', cmd: 'kubectl get pods -n shop -o wide', check: (c, g) => g.has('get:pods:in:shop') || g.has('get:pods:in:*') },
        { text: 'Describe a restarting pod on node-2. How did it die, and does it even have a memory limit?', hint: 'Look at Last State, Limits/Requests and QoS Class.', cmd: c => `kubectl describe pod ${firstPod(c, 'shop', 'checkout', p => p.node === 'node-2') !== '<pod>' ? firstPod(c, 'shop', 'checkout', p => p.node === 'node-2') : firstPod(c, 'shop', 'storefront', p => p.node === 'node-2')} -n shop`,
          check: (c, g) => g.has('describe:last-state:OOMKilled') },
        { text: 'No limit, yet OOMKilled. Look at the node it ran on.', hint: 'kubectl describe node node-2. Read the events and Allocated resources.', cmd: 'kubectl describe node node-2', check: (c, g) => g.has('describe:nodes') },
        { text: 'Find the memory hog on that node.', hint: 'kubectl top pods -A --sort-by=memory', cmd: 'kubectl top pods -A --sort-by=memory', check: (c, g) => g.has('top:pod-of:report-export') || g.has('get:pods:in:analytics') || g.has('describe:pod-of:report-export') },
        { text: 'Stop the bleeding: the export can wait until morning. Scale it to zero.', hint: 'kubectl scale deployment report-export -n analytics --replicas=0', cmd: 'kubectl scale deployment report-export -n analytics --replicas=0', check: c => dep(c, 'analytics', 'report-export').replicas === 0 },
        { text: 'Make it durable: give checkout and storefront memory requests and limits so the scheduler accounts for them.', hint: 'kubectl set resources deployment/checkout -n shop --requests=cpu=100m,memory=128Mi --limits=memory=256Mi (and the same for storefront).',
          cmd: 'kubectl set resources deployment/checkout -n shop --requests=cpu=100m,memory=128Mi --limits=memory=256Mi\nkubectl set resources deployment/storefront -n shop --requests=cpu=100m,memory=128Mi --limits=memory=256Mi', steady: 5,
          check: c => ['checkout', 'storefront'].every(n => K.sim.qosOf(dep(c, 'shop', n).template.spec) !== 'BestEffort' && healthy(c, 'shop', n)) && flowOk(c, 'checkout') && flowOk(c, 'storefront') },
        { text: 'Clean up the evicted pods the incident left behind.', hint: 'kubectl get pods -A --field-selector=status.phase=Failed, then delete them with the same selector per namespace.', cmd: 'kubectl delete pods -n analytics --field-selector=status.phase=Failed\nkubectl delete pods -n shop --field-selector=status.phase=Failed',
          check: c => !c.list('Pod').some(p => p.status === 'Failed' && !c.isSystemNs(p.namespace)) },
      ],
      learned: ['BestEffort pods get no reserved memory and are the kernel\'s first OOM victims.', 'OOMKilled with no limit set means the whole node ran out: look for SystemOOM on the node.', 'Requests are a promise to the scheduler. Every production pod should have them.'],
      postmortem: { q: 'Why could report-export be placed on node-2 next to checkout?', options: ['Analytics has priority', 'checkout and storefront requested no memory, so the scheduler saw node-2 as nearly empty', 'node-2 was cordoned', 'The scheduler ignores memory'], answer: 1, explain: 'The scheduler only counts requests. BestEffort pods requested nothing, so node-2 looked free even though they were using memory, and report-export used up the rest.' },
    },
    {
      id: 'pdb-drain', ticket: 'INC-504', sev: 'SEV-4', tier: 5, title: 'The drain that wouldn\'t', tags: ['drain', 'PodDisruptionBudget', 'maintenance'],
      alert: '[MAINTENANCE] CHG-2330: kernel patch for CVE-2026-1182 on node-2, window closes in 30m',
      story: 'Routine maintenance: drain node-2 so the kernel patch can go on, then put it back. The window is short. You\'ve done this a hundred times.',
      concept: { title: 'PodDisruptionBudgets', body: '<code>kubectl drain</code> evicts pods through the <b>Eviction API</b>, which honours <b>PodDisruptionBudgets</b>. A PDB with <code>minAvailable</code> equal to the replica count allows zero voluntary disruptions, so drain retries forever. Add headroom, or loosen the budget, but don\'t bypass it.' },
      setup(c) {
        platform(c); stagedoor(c, { payments: { replicas: 3 } });
        c.put(c.obj('PodDisruptionBudget', { name: 'payments', namespace: 'payments', selector: { matchLabels: { app: 'payments' } }, minAvailable: 3, maxUnavailable: null }));
        settle(c);
      },
      objectives: [
        { text: 'Drain node-2: <code>kubectl drain node-2 --ignore-daemonsets</code>', hint: 'DaemonSet pods (kube-proxy) can\'t be evicted, hence --ignore-daemonsets.', cmd: 'kubectl drain node-2 --ignore-daemonsets', check: (c, g) => g.has('drain-pdb-blocked') || g.has('drain:node-2'),
          feedback: (c, g) => (g.has('drain-blocked') ? 'Drain refused to start. Read the error: which flag does it ask for?' : null) },
        { text: 'The drain keeps retrying. Find the budget that blocks it. (Ctrl+C stops watching.)', hint: 'kubectl get pdb -A', cmd: 'kubectl get pdb -A', check: (c, g) => g.has('get:poddisruptionbudgets') || g.has('describe:poddisruptionbudgets') },
        { text: 'Allow one voluntary disruption without reducing how many payments pods stay up.', hint: 'Scale payments to 4. (Relaxing the PDB to minAvailable: 2 also works, if the payments team agrees.)', cmd: 'kubectl scale deployment payments -n payments --replicas=4',
          check: c => { const b = c.get('PodDisruptionBudget', 'payments', 'payments'); return !!b && c.pdbStatus(b).allowed >= 1; },
          feedback: c => (!c.get('PodDisruptionBudget', 'payments', 'payments') ? 'Deleting the budget removes the protection for the next person. Put it back and add headroom instead.' : null) },
        { text: 'Finish the drain.', hint: 'Run the drain again (or let a running one finish).', cmd: 'kubectl drain node-2 --ignore-daemonsets', check: c => c.node('node-2').unschedulable && !c.list('Pod').some(p => p.node === 'node-2' && c.active(p) && !(p.owner && p.owner.kind === 'DaemonSet')) },
        { text: 'Patching is done. Return node-2 to service.', hint: 'kubectl uncordon node-2', cmd: 'kubectl uncordon node-2', check: c => !c.node('node-2').unschedulable && healthy(c, 'payments', 'payments') && !!c.get('PodDisruptionBudget', 'payments', 'payments') },
      ],
      learned: ['drain uses the Eviction API, which respects PodDisruptionBudgets; kubectl delete pod does not.', 'minAvailable equal to replicas means "never", which blocks every node operation.', 'Add capacity first, then drain: availability stays intact the whole time.'],
      postmortem: { q: 'Why not just kubectl delete the blocked payments pod?', options: ['delete is slower', 'It bypasses the PDB and drops payments below the availability the owners asked for', 'delete doesn\'t work during drains', 'It would delete the Deployment'], answer: 1, explain: 'Plain deletes ignore PDBs. It would have worked, at the cost of exactly the outage the budget exists to prevent. Headroom keeps the promise.' },
    },
    {
      id: 'hpa-blind', ticket: 'INC-505', sev: 'SEV-1', tier: 5, title: 'The autoscaler is blind', tags: ['HPA', 'requests', 'metrics'],
      alert: '[FIRING] CheckoutSuccessRate < 40%  · on-sale traffic 4× normal',
      story: 'The queue for the farewell tour just opened. Checkout traffic is four times normal and we\'re dropping most of it. Checkout has an autoscaler for exactly this, but it hasn\'t added a single pod.',
      concept: { title: 'How the HPA computes utilization', body: 'The HPA computes CPU utilization as usage <i>divided by the CPU request</i>. If any container has no CPU request, utilization is undefined: TARGETS shows <code>&lt;unknown&gt;</code> and the HPA does nothing. Desired replicas = ceil(current × current% ÷ target%).' },
      setup(c) {
        platform(c); stagedoor(c, { checkout: { replicas: 2, resources: {} } });
        c.createHPA({ ns: 'shop', name: 'checkout', target: 'checkout', min: 2, max: 12, cpu: 60 });
        settle(c);
        c.flow('checkout').rps = 500; c.settle(4);
      },
      objectives: [
        { text: 'Check the autoscaler.', hint: 'kubectl get hpa -n shop', cmd: 'kubectl get hpa -n shop', check: (c, g) => g.has('get:horizontalpodautoscalers') },
        { text: 'TARGETS shows <code>&lt;unknown&gt;</code>. Find out why.', hint: 'kubectl describe hpa checkout -n shop. Read the conditions and events.', cmd: 'kubectl describe hpa checkout -n shop', check: (c, g) => g.has('describe:horizontalpodautoscalers') },
        { text: 'Give checkout CPU and memory requests (200m CPU and 128Mi is right for checkout).', hint: 'kubectl set resources deployment/checkout -n shop --requests=cpu=200m,memory=128Mi', cmd: 'kubectl set resources deployment/checkout -n shop --requests=cpu=200m,memory=128Mi', check: c => K.qty.cpu(((ctr(c, 'shop', 'checkout').resources || {}).requests || {}).cpu) > 0 },
        { text: 'Let the autoscaler catch up until no checkout requests are dropped.', hint: 'Watch kubectl get hpa -n shop and the SLO panel. It scales in steps.', cmd: 'kubectl get hpa -n shop', check: c => flowOk(c, 'checkout') && dep(c, 'shop', 'checkout').replicas > 2, steady: 4 },
      ],
      learned: ['HPA CPU targets are a percentage of the request, so no request means no autoscaling.', 'describe hpa shows ScalingActive=False and the exact missing request.', 'The HPA grows in steps; capacity planning still matters for the first minutes of a spike.'],
      postmortem: { q: 'Checkout uses 120m of CPU with a 200m request. What utilization does the HPA see?', options: ['12%', '60%', '120%', 'It depends on the node'], answer: 1, explain: 'Utilization is usage ÷ request: 120m ÷ 200m = 60%. That is why the request has to be set, and set honestly.' },
    },

    /* ================= TIER 6: MAJOR INCIDENT ================= */
    {
      id: 'onsale', ticket: 'INC-601', sev: 'SEV-1', tier: 6, title: 'On-sale night', tags: ['multi-fault', 'ingress', 'NetworkPolicy', 'OOMKilled'],
      alert: '[FIRING] CheckoutSuccessRate 0%  · on-sale opens in 10 minutes',
      story: 'Three teams shipped "small" changes this afternoon: an ingress cleanup, a payments policy refactor, and inventory 4.1. Checkout is at zero and the biggest on-sale of the year opens in ten minutes. You know the loop. I\'ll stay out of your way.',
      concept: { title: 'Follow the request', body: 'Customer → Ingress → Service → endpoint pod → app → its dependencies. Fix the first broken hop you find, then test again: the next failure is usually hiding behind it. Don\'t stop when the error changes; stop when the error rate is zero and stays there.' },
      setup(c) {
        platform(c);
        stagedoor(c);
        breakNow(c, () => {
          c.get('Ingress', 'shop', 'tickets').rules[0].paths[1].backend.port = 8080;
          netpol(c, 'payments', 'default-deny-ingress', { podSelector: {}, policyTypes: ['Ingress'] });
          netpol(c, 'payments', 'allow-checkout', { podSelector: { matchLabels: { app: 'payments' } }, policyTypes: ['Ingress'], ingress: [{ from: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'shop' } }, podSelector: { matchLabels: { app: 'checkout-api' } } }], ports: [{ protocol: 'TCP', port: 8080 }] }] });
          dep(c, 'inventory', 'inventory').template.spec.containers[0].image = 'stagedoor/inventory:4.1';
        }, 30);
      },
      objectives: [
        { text: 'Customers can\'t check out. Find the first broken hop and fix it.', hint: 'curl -i https://tickets.stagedoor.io/api/checkout. A 503 from nginx means the ingress can\'t use its backend: kubectl describe ingress tickets -n shop.',
          cmd: `kubectl patch ingress tickets -n shop --type=json -p '[{"op":"replace","path":"/spec/rules/0/http/paths/1/backend/service/port/number","value":80}]'`,
          check: c => { const r = c.ingressRoute(HOST, '/api/checkout'); if (!r) return false; const svc = c.get('Service', r.ing.namespace, r.path.backend.name); return !!svc && svc.name === 'checkout' && svc.ports.some(p => (r.path.backend.portName ? p.name === r.path.backend.portName : p.port === r.path.backend.port)); } },
        { text: 'Checkout answers now, with errors. Follow the request to its next dependency and fix that hop. Keep payments locked down.', hint: 'Read the 502 detail, then kubectl describe networkpolicy -n payments. Compare the allowed labels with the real checkout pod labels.',
          cmd: `kubectl patch networkpolicy allow-checkout -n payments --type=json -p '[{"op":"replace","path":"/spec/ingress/0/from/0/podSelector/matchLabels/app","value":"checkout"}]'`,
          check: c => { const r = fromPod(c, 'shop', 'checkout', 'http://payments.payments:8080/v1/status'); return r.ok && r.status < 400 && policyExists(c, 'payments', 'default-deny-ingress') && !toolboxReaches(c, 'http://payments.payments:8080/healthz'); },
          feedback: c => (!policyExists(c, 'payments', 'default-deny-ingress') ? 'default-deny-ingress must stay.' : toolboxReaches(c, 'http://payments.payments:8080/healthz') ? 'Payments is reachable from everywhere now. Narrow it to checkout.' : null) },
        { text: 'Still errors. Keep following the request path.', hint: 'Look at inventory: restarts, Last State, and kubectl top pods -n inventory.',
          cmd: 'kubectl set resources deployment/inventory -n inventory --requests=memory=384Mi --limits=memory=512Mi',
          check: c => memLimit(c, 'inventory', 'inventory') >= 420 && healthy(c, 'inventory', 'inventory') },
        { text: 'Hold the line: checkout must stay above 99% for a full minute.', hint: 'Watch the SLO panel. If it dips, something is still flapping.', cmd: 'kubectl get pods -A', check: c => flowOk(c, 'checkout') && flowOk(c, 'storefront'), steady: 20 },
      ],
      learned: ['Multi-fault incidents unmask one layer at a time; re-test after every fix.', 'An ingress 503 points at its backend Service: name, port, endpoints.', 'Stale labels in NetworkPolicies fail closed, which is safe but still an outage.'],
      postmortem: { q: 'What made this incident hard?', options: ['One very obscure bug', 'Three independent changes failing on different layers, each hidden behind the previous one', 'A Kubernetes bug', 'Missing monitoring'], answer: 1, explain: 'Each fix revealed the next failure: ingress port, then a policy with a stale label, then an under-sized memory limit. Change freezes before big events exist for a reason.' },
    },
  ];
})(window.K = window.K || {});

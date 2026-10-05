#!/usr/bin/env node
/* Plays every incident from start to finish using each step's own solution, with three random seeds,
   then throws a pile of valid and broken commands at every incident to make sure nothing crashes.
   Usage: node tests/play-all-incidents.js [incident-id]     (no dependencies needed) */
'use strict';
const path = require('path');

global.window = {};
['yaml', 'apps', 'engine', 'manifest', 'kubectl', 'game', 'levels'].forEach(f => require(path.join(__dirname, '..', 'js', f + '.js')));
const K = global.window.K;
const only = process.argv[2];

let failures = 0;
const fail = msg => { failures++; console.log('  FAIL ' + msg); };

/* Steps that need a human edit. Solutions mark them with a line starting with "(". */
const edit = (file, from, to) => g => {
  const t = g.files.get(file);
  if (t == null) throw new Error(`${file} does not exist yet`);
  if (!t.includes(from)) { if (t.includes(to)) return; throw new Error(`"${from}" not found in ${file}`); }
  g.files.set(file, t.replace(from, to));
};
const MANUAL = {
  'default-deny': edit('allow-checkout.yaml', '  - from: []', '  - from:\n    - namespaceSelector:\n        matchLabels:\n          kubernetes.io/metadata.name: shop\n      podSelector:\n        matchLabels:\n          app: checkout'),
  'coredns-down': edit('coredns-configmap.yaml', '/etc/resolve.conf', '/etc/resolv.conf'),
  'egress-dns': edit('allow-dns.yaml', '  egress: []', '  egress:\n  - to:\n    - namespaceSelector:\n        matchLabels:\n          kubernetes.io/metadata.name: kube-system\n      podSelector:\n        matchLabels:\n          k8s-app: kube-dns\n    ports:\n    - protocol: UDP\n      port: 53\n    - protocol: TCP\n      port: 53'),
  'registry-auth': edit('regcred.yaml', 'namespace: shop', 'namespace: payments'),
  'pvc-pending': edit('reports-pvc.yaml', 'storageClassName: fast-ssd', 'storageClassName: gp3'),
};

function playLevel(index, seed) {
  const g = new K.Game({ seed });
  g.loadLevel(index);
  const L = g.level;
  let ticks = 0;
  const transcript = [];
  const run = line => {
    const res = g.run(line);
    transcript.push('$ ' + line, ...(res.lines || []).map(l => (l.c === 'err' ? '! ' : '  ') + l.t));
    return res;
  };
  const runStep = () => {
    const cmd = g.solutionCommand() || '';
    for (const line of cmd.split('\n').filter(Boolean)) {
      if (line.startsWith('(wait')) { for (let t = 0; t < 8; t++) { g.tick(); ticks++; } transcript.push('# ' + line); }
      else if (line.startsWith('(')) { if (!MANUAL[L.id]) throw new Error('no MANUAL hook for ' + L.id); MANUAL[L.id](g); transcript.push('# ' + line); }
      else run(line);
    }
  };
  try {
    for (let step = 0; step < L.objectives.length; step++) {
      if (g.objIndex !== step) { fail(`${L.id}: expected to be on step ${step + 1}, but on ${g.objIndex + 1}`); return { ok: false, transcript }; }
      runStep();
      const cmd = g.solutionCommand() || '';
      const safe = /^(kubectl (get|describe|top|logs|rollout (status|history)|auth|exec)|curl|nslookup)\b/.test(cmd);
      for (let attempt = 0; attempt < 3 && g.objIndex === step; attempt++) {
        for (let t = 0; t < 70 && g.objIndex === step; t++) {
          g.tick(); ticks++;
          if (safe && t % 3 === 2 && g.objIndex === step) runStep();
        }
        if (g.objIndex === step && safe) runStep();
      }
      if (g.objIndex === step) {
        fail(`${L.id} (seed ${seed}): stuck on step ${step + 1}: ${L.objectives[step].text.replace(/<[^>]+>/g, '')}${g.feedback ? ' [' + g.feedback + ']' : ''}`);
        return { ok: false, transcript, g };
      }
    }
  } catch (e) { fail(`${L.id} (seed ${seed}): threw ${e.stack.split('\n').slice(0, 4).join(' | ')}`); return { ok: false, transcript }; }
  if (!g.completed) { fail(`${L.id}: all steps passed but the incident never closed`); return { ok: false, transcript }; }
  if (g.stars !== 3) fail(`${L.id}: expected 3 stars without reveals, got ${g.stars}`);
  return { ok: true, ticks, transcript, g };
}

/* Every incident must actually be broken at the start: the first objective that checks
   cluster health must not already pass. */
function brokenAtStart(index) {
  const g = new K.Game({ seed: 5 }); g.loadLevel(index);
  for (let t = 0; t < 3; t++) g.tick();
  return !g.completed && g.objIndex === 0;
}

console.log('Playing every incident with its own solutions');
K.LEVELS.forEach((L, i) => {
  if (only && L.id !== only) return;
  if (!brokenAtStart(i)) fail(`${L.id}: first step completed with no player action`);
  for (const seed of [1, 42, 2026]) {
    const r = playLevel(i, seed);
    if (!r.ok) { console.log(r.transcript.slice(-50).join('\n')); break; }
    if (seed === 1) console.log(`  ok   ${L.ticket} ${L.title.padEnd(32)} ${String(r.ticks).padStart(4)} ticks  ${Math.round(r.g.cluster.impact.failed)} failed requests`);
  }
});

/* ---------- fuzz: commands must never throw ---------- */
const FUZZ = [
  'kubectl', 'k get po', 'kubectl get all -A', 'kubectl get pods -A -o wide', 'kubectl get pods -n shop -o yaml', 'kubectl get svc -A -o json',
  'kubectl get deploy,rs,po -n shop --show-labels', 'kubectl get ep -A', 'kubectl get events -A', 'kubectl get events -n shop --sort-by=.lastTimestamp',
  'kubectl get events -A --field-selector type=Warning', 'kubectl get hpa -A', 'kubectl get cm,secrets -A', 'kubectl get ns', 'kubectl get nodes -o wide',
  'kubectl get pods -n shop -l app=checkout', 'kubectl get pods -A --field-selector=status.phase=Failed', "kubectl get pods -n shop -o jsonpath='{.items[*].metadata.name}'",
  'kubectl get pods -n shop -o custom-columns=NAME:.metadata.name,NODE:.spec.nodeName', 'kubectl get pod nope', 'kubectl get pdos', 'kubectl gte pods',
  'kubectl get ingress -A', 'kubectl get netpol -A', 'kubectl get sa,roles,rolebindings -A', 'kubectl get clusterroles', 'kubectl get clusterrolebindings -o wide',
  'kubectl get quota -A', 'kubectl get pvc,pv -A', 'kubectl get sc', 'kubectl get pdb -A', 'kubectl get nodes node-1 -o yaml',
  'kubectl describe pods -n shop', 'kubectl describe nodes', 'kubectl describe svc -n shop', 'kubectl describe deploy -n payments', 'kubectl describe rs -n shop',
  'kubectl describe ns shop', 'kubectl describe hpa -A', 'kubectl describe cm coredns -n kube-system', 'kubectl describe node nope', 'kubectl describe ingress -n shop',
  'kubectl describe netpol -A', 'kubectl describe netpol -n payments', 'kubectl describe sa default -n shop', 'kubectl describe role -n shop', 'kubectl describe rolebinding -n shop',
  'kubectl describe clusterrole view', 'kubectl describe quota -n shop', 'kubectl describe pvc -n inventory', 'kubectl describe pv', 'kubectl describe sc gp3', 'kubectl describe pdb -n payments',
  'kubectl top pods', 'kubectl top nodes', 'kubectl top pods -A --sort-by=memory', 'kubectl top pods -n shop --containers', 'kubectl explain deployment', 'kubectl explain pods.spec.containers.livenessProbe',
  'kubectl api-resources', 'kubectl version', 'kubectl cluster-info', 'kubectl config view', 'kubectl config get-contexts', 'kubectl config use-context nope',
  'kubectl logs', 'kubectl logs nope', 'kubectl logs deploy/checkout -n shop', 'kubectl logs deploy/checkout -n shop --previous', 'kubectl logs -n shop -l app=checkout --tail=5',
  'kubectl logs deploy/inventory -n inventory -c wait-for-db', 'kubectl logs deploy/coredns -n kube-system', 'kubectl -n shop get pods',
  'kubectl exec deploy/checkout -n shop -- curl -s http://payments.payments:8080/healthz', 'kubectl exec deploy/checkout -n shop -- nslookup inventory',
  'kubectl exec deploy/checkout -n shop -- nc -zv inventory.inventory 8080', 'kubectl exec deploy/checkout -n shop -- env', 'kubectl exec deploy/checkout -n shop -- cat /etc/resolv.conf',
  'kubectl exec deploy/checkout -n shop -- df -h', 'kubectl exec deploy/checkout -n shop -- sh', 'kubectl exec deploy/checkout -n shop -- sh -c "wget -qO- http://payments.payments:8080/v1/status"',
  'kubectl exec deploy/checkout -n shop -- bogus', 'kubectl exec -it nope -- sh', 'kubectl exec deploy/seats-db -n inventory -- df -h', 'kubectl exec deploy/coredns -n kube-system -- ls /etc/coredns',
  'kubectl auth can-i list pods', 'kubectl auth can-i list configmaps -n shop --as=system:serviceaccount:shop:flag-sync', 'kubectl auth can-i --list --as=system:serviceaccount:shop:default -n shop',
  'kubectl auth can-i get deployments.apps -n shop --as=jane', 'kubectl auth whoami', 'kubectl auth nope',
  'kubectl rollout history deploy/checkout -n shop', 'kubectl rollout history deploy/checkout -n shop --revision=1', 'kubectl rollout status deploy/nope',
  'kubectl rollout restart deployment/storefront -n shop', 'kubectl rollout undo deploy/storefront -n shop --to-revision=99', 'kubectl rollout pause deploy/storefront -n shop', 'kubectl rollout resume deploy/storefront -n shop',
  'kubectl scale deploy checkout -n shop', 'kubectl scale deploy checkout -n shop --replicas=-1', 'kubectl scale deploy storefront -n shop --replicas=4', 'kubectl scale svc web --replicas=2',
  'kubectl set image deploy/storefront -n shop nope=nginx', 'kubectl set image deploy/storefront -n shop storefront=stagedoor/storefront:5.3', 'kubectl set image', 'kubectl set env deploy/checkout -n shop --list',
  'kubectl set env deploy/checkout -n shop FOO=bar', 'kubectl set env deploy/checkout -n shop FOO-', 'kubectl set resources deploy/storefront -n shop --limits=memory=512mb',
  'kubectl set resources deploy/storefront -n shop --limits=cpu=100m --requests=cpu=2', 'kubectl set resources deploy/storefront -n shop --requests=memory=128Mi',
  "kubectl patch deploy storefront -n shop -p '{\"spec\":{\"replicas\":3}}'", "kubectl patch deploy storefront -n shop -p '{bad json'", "kubectl patch deploy storefront -n shop --type=json -p '[{\"op\":\"replace\",\"path\":\"/spec/replicas\",\"value\":2}]'",
  "kubectl patch svc payments -n payments -p '{\"spec\":{\"ports\":[{\"name\":\"http\",\"port\":8080,\"targetPort\":\"http\"}]}}'", "kubectl patch node node-1 -p '{\"spec\":{\"unschedulable\":true}}'",
  "kubectl patch pvc seats-db-data -n inventory -p '{\"spec\":{\"resources\":{\"requests\":{\"storage\":\"1Gi\"}}}}'", "kubectl patch pvc seats-db-data -n inventory -p '{\"spec\":{\"storageClassName\":\"io2\"}}'",
  'kubectl expose deploy storefront -n shop --name=sf2 --port=80 --target-port=http', 'kubectl expose pod nope --port=80',
  'kubectl label pods --all tier=front', 'kubectl label deploy storefront -n shop team=noodles', 'kubectl annotate deploy storefront -n shop kubernetes.io/change-cause=test',
  'kubectl run x --image=does-not-exist', 'kubectl run y --image=busybox -- sleep 3600', 'kubectl run z --image="bad image"', 'kubectl run Bad --image=nginx',
  'kubectl run pg --image=postgres', 'kubectl run w --image=nginx --dry-run=client -o yaml', 'kubectl run v --image=nginx -it --rm',
  'kubectl create deployment d1 --image=nginx --replicas=2', 'kubectl create deploy --image=nginx', 'kubectl create ns qa', 'kubectl create ns qa',
  'kubectl create configmap c1 --from-literal=A=1 --from-literal=B=2', 'kubectl create cm c2 --from-literal=bad', 'kubectl create secret tls t',
  'kubectl create secret generic s1 --from-literal=P=x -o yaml --dry-run=client', 'kubectl create secret docker-registry rc -n shop --docker-server=registry.stagedoor.io --docker-username=u --docker-password=p',
  'kubectl create sa bot -n shop', 'kubectl create role r1 -n shop --verb=get,list --resource=configmaps,deployments.apps', 'kubectl create role r2 -n shop --verb=get',
  'kubectl create rolebinding rb1 -n shop --role=r1 --serviceaccount=shop:bot', 'kubectl create rolebinding rb2 -n shop --role=r1 --serviceaccount=bot',
  'kubectl create clusterrolebinding crb --clusterrole=view --user=jane', 'kubectl create quota q1 -n qa --hard=pods=2,requests.cpu=1', 'kubectl create pdb p1 -n shop --selector=app=checkout --min-available=1',
  'kubectl create service clusterip x', 'kubectl create job j --image=busybox', 'kubectl apply -f nope.yaml', 'kubectl apply', 'kubectl delete', 'kubectl delete pod nope',
  'kubectl delete svc kubernetes', 'kubectl delete ns default', 'kubectl delete ns shop', 'kubectl delete node node-1', 'kubectl delete pods -n qa --all', 'kubectl delete pods -A --field-selector=status.phase=Failed',
  'kubectl delete pod y --force --grace-period=0', 'kubectl delete deploy d1', 'kubectl delete clusterrole view', 'kubectl delete ns qa', 'kubectl cordon', 'kubectl cordon nope',
  'kubectl cordon node-3', 'kubectl drain node-3', 'kubectl drain node-3 --ignore-daemonsets --force --delete-emptydir-data', 'kubectl uncordon node-3',
  'kubectl taint nodes node-3 dedicated=x:NoSchedule', 'kubectl taint nodes node-3 dedicated=x:NoSchedule', 'kubectl taint nodes node-3 dedicated:NoSchedule-', 'kubectl taint nodes node-3 bad', 'kubectl taint nodes node-3 nope-',
  'kubectl autoscale deploy storefront -n shop', 'kubectl autoscale deploy storefront -n shop --max=1 --min=3', 'kubectl autoscale deploy storefront -n shop --max=4',
  'kubectl edit deploy storefront -n shop', 'kubectl edit nope', 'kubectl port-forward svc/web 8080:80', 'kubectl debug x', 'kubectl get pods -A -w',
  'kubectl get pods -A | grep -v Running', 'kubectl get pods -A | grep -iE "crash|err" | wc -l', 'kubectl get deploy storefront -n shop -o yaml > sf.yaml', 'cat sf.yaml', 'kubectl apply -f sf.yaml',
  'kubectl get secret -n shop -o yaml > s.yaml', 'kubectl apply -f s.yaml', 'kubectl delete -f sf.yaml', 'kubectl apply -f sf.yaml', 'echo hello | base64', 'echo aGVsbG8= | base64 -d', 'echo !!! | base64 -d',
  'curl', 'curl https://tickets.stagedoor.io/', 'curl -i https://tickets.stagedoor.io/api/checkout', 'curl -s -o /dev/null -w "%{http_code}" https://tickets.stagedoor.io/', 'curl -v https://nope.stagedoor.io/',
  'curl storefront.shop', 'curl payments.payments:8080/healthz', 'curl payments:8080', 'curl 10.96.0.1', 'curl https://kubernetes', 'curl localhost', 'curl ht!tp://x', 'curl seats-db.inventory:5432',
  'wget -qO- payments.payments:8080/healthz', 'nslookup payments.payments', 'nslookup nope', 'dig +short storefront.shop', 'nslookup', 'runbook', 'help',
  'ls', 'ls -l', 'cat', 'cat nope', 'touch a.yaml', 'cp a.yaml b.yaml', 'rm a.yaml b.yaml', 'rm nope', 'edit', 'vim x.yaml', 'sudo kubectl get pods', 'docker ps', 'helm install', 'ssh node-1', 'ping payments',
  'kubect get pods', 'whoami', 'pwd', 'exit', 'clear', '"unterminated', 'kubectl get pods |', 'kubectl get pods >', 'kubectl get pods > ../etc/passwd', 'kubectl get pods 2>/dev/null',
  'kubectl -n nope get pods', 'kubectl get pods -n', 'kubectl config set-context --current --namespace=shop', 'kubectl get pods', 'kubectl config set-context --current --namespace=default',
  'hint', 'solution',
];
const BAD_YAML = [
  'apiVersion: v1\nkind: Service\nmetadata:\n  name: x\nspec:\n  ports:\n  - port: 80\n   targetPort: 8080\n',
  'kind: Deployment\nmetadata:\n  name: d\n',
  'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: d\nspec:\n  selector:\n    matchLabels:\n      app: a\n  template:\n    metadata:\n      labels:\n        app: b\n    spec:\n      containers:\n      - name: c\n        image: nginx\n',
  'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: d\nspec:\n  selector:\n    matchLabels:\n      app: a\n  template:\n    metadata:\n      labels:\n        app: a\n    spec:\n      containers:\n      - name: c\n        image: nginx\n        livenessprobe:\n          httpGet:\n            path: /\n            port: 80\n',
  'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: d\nspec:\n  selector:\n    matchLabels:\n      app: a\n  template:\n    metadata:\n      labels:\n        app: a\n    spec:\n      containers:\n      - name: c\n        image: nginx\n        resources:\n          requests:\n            cpu: 2\n          limits:\n            cpu: 500m\n            memory: 1gb\n',
  'apiVersion: v1\nkind: Secret\nmetadata:\n  name: s\ndata:\n  P: not-base64!!\n',
  'apiVersion: batch/v1\nkind: Job\nmetadata:\n  name: j\n',
  'apiVersion: v1\nkind: Pod\nmetadata:\n  name: Bad_Name\nspec:\n  containers: []\n',
  'apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: np\nspec:\n  podSelector: {}\n  ingress:\n  - from:\n    - {}\n',
  'apiVersion: networking.k8s.io/v1\nkind: Ingress\nmetadata:\n  name: i\nspec:\n  rules:\n  - host: x.stagedoor.io\n    http:\n      paths:\n      - path: /\n        backend:\n          service:\n            name: storefront\n            port:\n              number: 80\n',
  'apiVersion: rbac.authorization.k8s.io/v1\nkind: RoleBinding\nmetadata:\n  name: rb\nsubjects:\n- kind: ServiceAccount\n  name: x\n',
  'apiVersion: v1\nkind: PersistentVolumeClaim\nmetadata:\n  name: p\nspec:\n  resources:\n    requests:\n      storage: 1Gi\n',
  'apiVersion: policy/v1\nkind: PodDisruptionBudget\nmetadata:\n  name: p\nspec:\n  minAvailable: 1\n  maxUnavailable: 1\n  selector:\n    matchLabels:\n      app: x\n',
  '\tkind: Pod\n', 'just a string', '- a\n- b\n', 'a: [1, 2\n', 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cm\n  namespace: nope\ndata:\n  a: "1"\n',
];

console.log('Fuzzing the shell on every incident');
K.LEVELS.forEach((L, i) => {
  if (only && L.id !== only) return;
  const g = new K.Game({ seed: 7 });
  g.loadLevel(i);
  let crashed = false;
  const tryRun = line => {
    try {
      const r = g.run(line);
      if (r.stream) for (let t = 0; t < 5; t++) { g.tick(); r.stream.tick(); }
    } catch (e) { crashed = true; fail(`${L.id}: "${line.replace(/\n/g, '\\n')}" threw ${e.stack.split('\n').slice(0, 3).join(' | ')}`); }
  };
  FUZZ.forEach(tryRun);
  BAD_YAML.forEach((y, j) => { g.files.set(`bad${j}.yaml`, y); tryRun(`kubectl apply -f bad${j}.yaml`); });
  Array.from(g.files.keys()).forEach(f => /\.ya?ml$/.test(f) && tryRun(`kubectl apply -f ${f}`));
  try { for (let t = 0; t < 40; t++) g.tick(); } catch (e) { crashed = true; fail(`${L.id}: tick threw ${e.message}`); }
  if (!crashed) console.log(`  ok   ${L.ticket} survived ${FUZZ.length + BAD_YAML.length} commands`);
});

console.log(failures ? `\n${failures} failure(s)` : '\nAll incidents playable, no crashes.');
process.exit(failures ? 1 : 0);

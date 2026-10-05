# Blast Radius

A Kubernetes incident-response game. You're the on-call SRE at Stagedoor, a concert-ticketing company, and production keeps breaking. You work 22 realistic incidents by typing real `kubectl` against a cluster simulated in your browser, while a live map and customer-traffic meters show the damage spreading or shrinking.

It's the advanced follow-up to [Desired State](https://github.com/aboualyXcode/k8s-desired-state). Desired State teaches the concepts; Blast Radius assumes them and asks you to debug.

Everything runs in the browser. There's no backend, no real cluster and no build step, so GitHub Pages can host it as plain files.

**Play it at [aboualyxcode.github.io/k8s-blast-radius](https://aboualyxcode.github.io/k8s-blast-radius/).** The source is at [github.com/aboualyXcode/k8s-blast-radius](https://github.com/aboualyXcode/k8s-blast-radius).

## What makes it different

- **Failures emerge; they aren't scripted.** Each container image has a behavioural profile: startup time, memory curve, health endpoints, dependencies, API permissions it needs, disk usage. The simulator applies the real rules and the incident follows. A liveness probe that fires before a 45-second Java startup kills it. A Guaranteed pod next to BestEffort pods gets them OOM-killed. A missing DNS egress rule times out every lookup.
- **One network model for everything.** Your `curl`, `kubectl exec … -- curl`, readiness probes, each service's calls to its dependencies, and the simulated customer traffic all go through the same path: DNS and its search domains, Services and named target ports, endpoints, NetworkPolicies, and the Ingress, which returns 404, 502, 503 or 504.
- **Customer impact is measured.** Error-rate meters for the homepage and checkout update every tick, and the postmortem reports time to resolve and failed requests.
- **Fixes have to hold.** Many steps only complete after the system has stayed healthy for several checks, so a fix that flaps doesn't count.
- **Shortcuts are refused.** Deleting the default-deny policy, widening a NetworkPolicy to everyone, raising a quota finance owns, binding `cluster-admin`, or deleting a PodDisruptionBudget all get pushback.
- **Guidance fades.** Tier 1 shows the commands in the step text. By tier 6 you only get a goal, and three faults are layered so each fix reveals the next.

## The incidents

**Tier 1: Triage**

| Incident | Sev | Title | Topics |
|---|---|---|---|
| INC-101 | SEV-2 | Checkout is crash looping | CrashLoopBackOff, logs --previous, env vars |
| INC-102 | SEV-3 | The release that never landed | ImagePullBackOff, rollouts, rollback |
| INC-103 | SEV-2 | Death by memory limit | OOMKilled, exit 137, limits, kubectl top |
| INC-104 | SEV-3 | Stuck in Pending | Pending, scheduler, requests |

**Tier 2: Health checks and routing**

| Incident | Sev | Title | Topics |
|---|---|---|---|
| INC-201 | SEV-2 | Half the homepage | readiness, liveness, rollouts |
| INC-202 | SEV-3 | Killed before it could start | liveness, startupProbe, CrashLoopBackOff |
| INC-203 | SEV-1 | Endpoints, but no answer | Services, targetPort, exec |
| INC-204 | SEV-3 | Errors on every deploy | readiness, zero downtime, rollouts |

**Tier 3: Networking and DNS**

| Incident | Sev | Title | Topics |
|---|---|---|---|
| INC-301 | SEV-1 | No such host | DNS, namespaces, search path |
| INC-302 | SEV-1 | Default deny | NetworkPolicy, timeouts, least privilege |
| INC-303 | SEV-1 | It's always DNS | CoreDNS, kube-system, ConfigMaps |
| INC-304 | SEV-1 | Lockdown | NetworkPolicy, egress, DNS |

**Tier 4: Access and platform**

| Incident | Sev | Title | Topics |
|---|---|---|---|
| INC-401 | SEV-3 | Forbidden | RBAC, ServiceAccounts, auth can-i |
| INC-402 | SEV-2 | Scale-up refused | ResourceQuota, admission, FailedCreate |
| INC-403 | SEV-3 | 401 from the registry | imagePullSecrets, Secrets, private registry |
| INC-404 | SEV-3 | The PCI node pool | taints, tolerations, nodeSelector |

**Tier 5: Capacity and storage**

| Incident | Sev | Title | Topics |
|---|---|---|---|
| INC-501 | SEV-3 | Unbound | PersistentVolumeClaims, StorageClass, pvc-protection |
| INC-502 | SEV-1 | No space left on device | volumes, expansion, init containers, cascades |
| INC-503 | SEV-2 | Noisy neighbour | QoS classes, SystemOOM, evictions, requests |
| INC-504 | SEV-4 | The drain that wouldn't | drain, PodDisruptionBudget, maintenance |
| INC-505 | SEV-1 | The autoscaler is blind | HPA, requests, metrics |

**Tier 6: Major incident**

| Incident | Sev | Title | Topics |
|---|---|---|---|
| INC-601 | SEV-1 | On-sale night | multi-fault, ingress, NetworkPolicy, OOMKilled |

Each incident ends with a postmortem: time to resolve, customer impact, what to remember and a root-cause question. Hints are free; revealing a command costs a star.

## Commands you can use

Most of everyday kubectl works, with realistic output and errors:

- **Reading state:** `get` (with `-o wide|yaml|json|jsonpath|custom-columns`, `-l`, `--field-selector`, `-A`, `-w`), `describe`, `logs` (with `--previous`, `-c`, `--tail`), `top`, `events`.
- **Inside pods:** `exec`, running curl, wget, nslookup, dig, nc, env, cat, ls or df.
- **Changing things:**
  - `apply`, `create`, `edit`, `patch` (strategic merge and JSON patch);
  - `set image|env|resources`, `scale`, `rollout status|history|undo|restart|pause|resume`;
  - `delete`, `label`, `annotate`, `expose`, `autoscale`.
- **Nodes and access:** `cordon`, `uncordon`, `drain` (respects PodDisruptionBudgets and keeps retrying), `taint`, `auth can-i` (with `--as` and `--list`), `auth whoami`.

The shell also has pipes, `>` redirection, `grep`, `wc`, `head`, `tail`, `base64` and a file editor. `runbook` prints the triage loop.

Simulated resource kinds: Pods, Deployments (rolling and Recreate), ReplicaSets, DaemonSets, Services, Endpoints, Ingresses, NetworkPolicies, ConfigMaps, Secrets (including docker-registry), ServiceAccounts, Roles, RoleBindings, ClusterRoles, ClusterRoleBindings, ResourceQuotas, PersistentVolumeClaims, PersistentVolumes, StorageClasses, PodDisruptionBudgets, HorizontalPodAutoscalers, Nodes, Namespaces and Events.

## Play it locally

Open `index.html` in a browser; it works straight from disk. If your browser is strict about local files, serve the folder and visit http://localhost:8000:

```sh
python3 -m http.server 8000
```

## Put it on GitHub Pages

The live game at https://aboualyxcode.github.io/k8s-blast-radius/ is served by GitHub Pages straight from this repository, with no build step. Every push to `main` republishes it.

To run your own copy:

1. Fork this repository, or push a clone of it to an empty repository of yours. On a free account it needs to be public for Pages.
2. In the repository, open Settings, then Pages. Under "Build and deployment", set Source to "Deploy from a branch", choose `main` and `/ (root)`, and save.
3. After a minute or two the game is live at `https://<your-username>.github.io/<repository-name>/`, and the Pages settings screen shows the link.

`.nojekyll` tells Pages to serve the files as they are. `.github/workflows/test.yml` plays every incident on each push and pull request.

## Project layout

```
index.html                    page structure
css/style.css                 all styling
js/yaml.js                    small YAML parser and printer
js/apps.js                    the container registry: one behavioural profile per image
js/engine.js                  the cluster: scheduler, kubelet, probes, OOM and evictions, controllers,
                              quotas, RBAC, storage, NetworkPolicy, DNS, Ingress, HPA, PDBs, traffic
js/manifest.js                kubectl apply: validation, immutable fields, YAML output for every kind
js/kubectl.js                 the shell: kubectl, exec, curl, nslookup, pipes, files
js/game.js                    runs an incident: objectives, steady-state checks, stars, impact
js/levels.js                  the platform, the Stagedoor services, and the 22 incidents
js/ui.js                      everything on screen
tests/play-all-incidents.js   plays every incident and fuzzes the shell (Node.js, no dependencies)
tests/transcript.js           prints what a player sees for given commands, for writing incidents
```

The simulation never touches the page, and the page only changes the cluster through the commands a player types, which is what lets the whole game be tested headlessly.

## Add an incident

Incidents are plain objects in `js/levels.js`. The usual shape is: build the healthy Stagedoor platform, age it, then break it so the incident looks minutes old.

```js
{
  id: 'my-incident', ticket: 'INC-305', sev: 'SEV-2', tier: 3, title: 'Short title', tags: ['topic'],
  alert: '[FIRING] What the pager says',
  story: 'What Rhea tells the player.',
  concept: { title: 'Runbook entry', body: 'A short explanation. <b>HTML</b> is allowed.' },
  setup(c, g) {
    platform(c); stagedoor(c);
    breakNow(c, () => { /* change the cluster the way production breaks */ });
  },
  objectives: [
    {
      text: 'A goal, not a command.',
      hint: 'A nudge, often with the command.',
      cmd: 'kubectl ...',                        // the solution; the test suite plays it
      check: (c, g) => flowOk(c, 'checkout'),    // inspect cluster state or player facts
      steady: 3,                                 // optional: must hold for 3 ticks
      feedback: c => null,                       // optional nudge while the check fails
    },
  ],
  learned: ['One sentence per idea.'],
  postmortem: { q: 'A question?', options: ['A', 'B', 'C', 'D'], answer: 1, explain: 'Why B is right.' },
},
```

In `check`, `c` is the cluster and `g` is the game. Prefer checking real state: deployment health, flow success rates, `c.can(...)` for RBAC, `c.request(...)` for reachability. For investigation steps, `g.has(fact)` and `g.match(/regex/)` check what the player has done. Facts are recorded in `kubectl.js` wherever you see `this.fact(...)`, for example `describe:pod-of:checkout`, `logs-prev:checkout`, `exec:checkout:nslookup:inventory:nxdomain` or `curl:tickets.stagedoor.io:502`.

In `cmd`, a line starting with `(` is a manual action such as editing a file. Give the test suite a matching hook in `MANUAL`, or start the line with `(wait` to let time pass.

New failure modes usually belong in `js/apps.js` as image behaviour, not in the engine.

## Tests

```sh
node tests/play-all-incidents.js            # every incident
node tests/play-all-incidents.js oomkilled  # just one
```

The suite does three things:
- It checks that every incident starts broken.
- It plays each incident from start to finish with three random seeds, using each step's own `cmd`, and requires three stars.
- It runs about 280 valid and deliberately broken commands and manifests against every incident, to make sure nothing throws.

URL parameters for working on incidents: `?tick=200` speeds up the clock (milliseconds per tick, default 1000), `?seed=42` makes the randomness repeatable, and a hash such as `#coredns-down` opens an incident by its `id`.

## How real is it?

The rules follow Kubernetes wherever they matter for debugging:

- **Scheduling:** the scheduler filters on node allocatable minus requested resources, taints, nodeSelector and unbound claims, and reports the same `FailedScheduling` reasons.
- **Probes and containers:** the kubelet runs startup, liveness and readiness probes with their real defaults and thresholds, applies CrashLoopBackOff backoff, and enforces memory limits (OOMKilled, exit 137).
- **Node memory:** under memory pressure, the kernel kills by QoS-based `oom_score_adj` and the kubelet evicts the pod furthest over its request.
- **Admission:** quotas and missing ServiceAccounts reject pods before they exist.
- **Rollouts:** rolling updates honour maxSurge and maxUnavailable.
- **Storage:** claims are provisioned, protected while in use, and expanded online.
- **Network:** NetworkPolicies are evaluated per peer and per port and drop traffic, so clients see timeouts. DNS uses the pod's namespace search path.

Some things are simplified:
- Only the first container in a pod has behaviour.
- Simulated time runs at three seconds per tick.
- CPU limits don't throttle.
- StatefulSets, Jobs, CronJobs, CRDs and the Gateway API aren't modelled yet.

All of these are good candidates for new incidents.

## Credits

Fonts are Bricolage Grotesque and JetBrains Mono from Google Fonts, with system fonts as a fallback offline. Stagedoor and everyone in it are fictional.

Kubernetes is a registered trademark of The Linux Foundation. This project is independent and isn't affiliated with or endorsed by The Linux Foundation or the Kubernetes project.

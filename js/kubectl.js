/* kubectl.js — the in-browser shell: a broad subset of kubectl plus the Unix tools an
   on-call engineer reaches for (curl, nslookup, grep, base64), and exec into pods. */
(function (K) {
  'use strict';
  const { matches, selects, nameFromImage, resolveImage, podRequests, portNum, clone, API_GROUP, CLUSTER_KINDS } = K.sim;
  const M = K.manifest, Q = K.qty;

  const TYPES = [
    { key: 'pods', kind: 'Pod', names: ['pods', 'pod', 'po'], ns: true },
    { key: 'services', kind: 'Service', names: ['services', 'service', 'svc'], ns: true },
    { key: 'deployments', kind: 'Deployment', names: ['deployments', 'deployment', 'deploy', 'deployments.apps', 'deployment.apps'], ns: true },
    { key: 'replicasets', kind: 'ReplicaSet', names: ['replicasets', 'replicaset', 'rs', 'replicasets.apps'], ns: true },
    { key: 'daemonsets', kind: 'DaemonSet', names: ['daemonsets', 'daemonset', 'ds'], ns: true },
    { key: 'nodes', kind: 'Node', names: ['nodes', 'node', 'no'], ns: false },
    { key: 'namespaces', kind: 'Namespace', names: ['namespaces', 'namespace', 'ns'], ns: false },
    { key: 'configmaps', kind: 'ConfigMap', names: ['configmaps', 'configmap', 'cm'], ns: true },
    { key: 'secrets', kind: 'Secret', names: ['secrets', 'secret'], ns: true },
    { key: 'endpoints', kind: 'Endpoints', names: ['endpoints', 'endpoint', 'ep', 'endpointslices', 'endpointslice'], ns: true },
    { key: 'events', kind: 'Event', names: ['events', 'event', 'ev'], ns: true },
    { key: 'horizontalpodautoscalers', kind: 'HorizontalPodAutoscaler', names: ['horizontalpodautoscalers', 'horizontalpodautoscaler', 'hpa'], ns: true },
    { key: 'ingresses', kind: 'Ingress', names: ['ingresses', 'ingress', 'ing'], ns: true },
    { key: 'networkpolicies', kind: 'NetworkPolicy', names: ['networkpolicies', 'networkpolicy', 'netpol'], ns: true },
    { key: 'serviceaccounts', kind: 'ServiceAccount', names: ['serviceaccounts', 'serviceaccount', 'sa'], ns: true },
    { key: 'roles', kind: 'Role', names: ['roles', 'role'], ns: true },
    { key: 'rolebindings', kind: 'RoleBinding', names: ['rolebindings', 'rolebinding'], ns: true },
    { key: 'clusterroles', kind: 'ClusterRole', names: ['clusterroles', 'clusterrole'], ns: false },
    { key: 'clusterrolebindings', kind: 'ClusterRoleBinding', names: ['clusterrolebindings', 'clusterrolebinding'], ns: false },
    { key: 'resourcequotas', kind: 'ResourceQuota', names: ['resourcequotas', 'resourcequota', 'quota'], ns: true },
    { key: 'persistentvolumeclaims', kind: 'PersistentVolumeClaim', names: ['persistentvolumeclaims', 'persistentvolumeclaim', 'pvc'], ns: true },
    { key: 'persistentvolumes', kind: 'PersistentVolume', names: ['persistentvolumes', 'persistentvolume', 'pv'], ns: false },
    { key: 'storageclasses', kind: 'StorageClass', names: ['storageclasses', 'storageclass', 'sc'], ns: false },
    { key: 'poddisruptionbudgets', kind: 'PodDisruptionBudget', names: ['poddisruptionbudgets', 'poddisruptionbudget', 'pdb'], ns: true },
  ];
  const typeOf = w => TYPES.find(t => t.names.includes(String(w).toLowerCase())) || null;
  const typeByKind = kind => TYPES.find(t => t.kind === kind);
  const VERBS = ['get', 'describe', 'logs', 'exec', 'top', 'events', 'run', 'create', 'apply', 'delete', 'edit', 'patch', 'scale', 'expose', 'set', 'rollout', 'label', 'annotate',
    'cordon', 'uncordon', 'drain', 'taint', 'autoscale', 'auth', 'cluster-info', 'explain', 'config', 'version', 'api-resources', 'port-forward', 'debug'];
  const SHELL = ['kubectl', 'k', 'help', 'hint', 'solution', 'clear', 'ls', 'cat', 'edit', 'curl', 'nslookup', 'dig', 'echo', 'base64', 'grep', 'wc', 'head', 'tail', 'runbook'];
  const VALUE_FLAGS = new Set(['namespace', 'selector', 'output', 'filename', 'image', 'replicas', 'port', 'target-port', 'type', 'name', 'from-literal', 'from-file', 'labels', 'env', 'min', 'max',
    'cpu-percent', 'cpu', 'to-revision', 'revision', 'container', 'grace-period', 'timeout', 'sort-by', 'tail', 'restart', 'context', 'protocol', 'field-selector', 'patch', 'as', 'limits', 'requests',
    'verb', 'resource', 'role', 'clusterrole', 'serviceaccount', 'user', 'group', 'hard', 'docker-server', 'docker-username', 'docker-password', 'docker-email', 'min-available', 'max-unavailable',
    'max-time', 'write-out', 'since', 'class', 'rule', 'overrides']);
  const SHORT = { n: 'namespace', l: 'selector', o: 'output', f: 'filename', c: 'container', A: 'all-namespaces', w: 'watch', p: 'previous', i: 'stdin', t: 'tty', m: 'max-time', s: 'silent', v: 'verbose', I: 'head', L: 'location', k: 'insecure', q: 'quiet' };
  const SHORT_VALUE = new Set(['n', 'l', 'o', 'f', 'c', 'm']);
  const MULTI = new Set(['from-literal', 'from-file', 'env', 'image', 'verb', 'resource', 'serviceaccount', 'user', 'group']);
  void MULTI;

  function levenshtein(a, b) {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
  }
  function suggest(word, list) {
    let best = null, bd = 3;
    for (const w of list) { const x = levenshtein(word, w); if (x < bd) { bd = x; best = w; } }
    return best;
  }
  function tokenize(line) {
    const out = []; let cur = '', q = null, has = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) { if (ch === q) q = null; else if (ch === '\\' && q === '"' && i + 1 < line.length) cur += line[++i]; else cur += ch; continue; }
      if (ch === '"' || ch === "'") { q = ch; has = true; continue; }
      if (/\s/.test(ch)) { if (cur || has) out.push(cur); cur = ''; has = false; continue; }
      cur += ch;
    }
    if (q) return { error: 'unexpected EOF while looking for matching `' + q + "'" };
    if (cur || has) out.push(cur);
    return { tokens: out };
  }
  function splitPipeline(line) {
    const segs = []; let cur = '', q = null, redirect = null;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) { if (ch === q) q = null; cur += ch; continue; }
      if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
      if (ch === '|') { segs.push(cur); cur = ''; continue; }
      if (ch === '>') { redirect = line.slice(i + 1).replace(/^>/, '').trim(); break; }
      cur += ch;
    }
    segs.push(cur);
    return { segs: segs.map(s => s.trim()), redirect };
  }
  function parseArgs(tokens) {
    const pos = [], flags = {}, multi = {};
    const add = (k, v) => { k = SHORT[k] && k.length === 1 ? SHORT[k] : k; flags[k] = v; (multi[k] = multi[k] || []).push(v); };
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t === '--') { flags['--'] = tokens.slice(i + 1); break; }
      if (t.startsWith('--')) {
        const eq = t.indexOf('=');
        let k = eq >= 0 ? t.slice(2, eq) : t.slice(2), v = eq >= 0 ? t.slice(eq + 1) : undefined;
        if (k === 'all-namespaces') v = true;
        if (v === undefined) v = VALUE_FLAGS.has(k) && i + 1 < tokens.length ? tokens[++i] : true;
        add(k, v);
      } else if (t.length > 1 && t[0] === '-' && !/^-\d/.test(t)) {
        const ch = t[1];
        if (SHORT_VALUE.has(ch)) { let v = t.slice(2).replace(/^=/, ''); if (!v && i + 1 < tokens.length) v = tokens[++i]; add(ch, v); }
        else for (const x of t.slice(1)) add(x, true);
      } else pos.push(t);
    }
    return { pos, flags, multi };
  }
  function human(sec) {
    sec = Math.max(0, Math.round(sec));
    if (sec < 120) return sec + 's';
    const m = Math.floor(sec / 60);
    if (m < 10) return sec % 60 ? `${m}m${sec % 60}s` : `${m}m`;
    if (m < 180) return m + 'm';
    const h = Math.floor(sec / 3600);
    if (h < 8) return m % 60 ? `${h}h${m % 60}m` : `${h}h`;
    if (h < 48) return h + 'h';
    const d = Math.floor(h / 24);
    if (h < 192) return h % 24 ? `${d}d${h % 24}h` : `${d}d`;
    return d + 'd';
  }
  function table(headers, rows) {
    const all = [headers].concat(rows);
    const w = headers.map((_, i) => Math.max.apply(null, all.map(r => String(r[i] == null ? '' : r[i]).length)));
    return all.map(r => r.map((c, i) => (i === r.length - 1 ? String(c == null ? '' : c) : String(c == null ? '' : c).padEnd(w[i] + 3))).join('').trimEnd()).join('\n');
  }
  const labelStr = l => (l && Object.keys(l).length ? Object.keys(l).sort().map(k => k + '=' + l[k]).join(',') : '<none>');
  function parseSelector(s) {
    const parts = String(s).split(',').map(x => x.trim()).filter(Boolean).map(p => {
      let m;
      if ((m = /^([^!=]+)!=(.*)$/.exec(p))) return l => l[m[1]] !== m[2];
      if ((m = /^([^=]+)==?(.*)$/.exec(p))) return l => l[m[1].trim()] === m[2].trim();
      if (p[0] === '!') return l => !(p.slice(1) in l);
      return l => p in l;
    });
    return labels => parts.every(f => f(labels || {}));
  }
  function podStatus(p) {
    if (p.deleting) return 'Terminating';
    if (p.status === 'Failed') return p.reason || 'Error';
    if (p.status === 'Succeeded') return 'Completed';
    if (!p.node) return 'Pending';
    return p.phase === 'Pending' ? 'ContainerCreating' : p.phase;
  }
  K.podStatus = podStatus;
  const readyStr = p => { const n = p.spec.containers.length; return `${p.ready ? n : p.phase === 'Running' && n > 1 ? n - 1 : 0}/${n}`; };
  const parseKV = (s, sep) => { const i = String(s).indexOf(sep || '='); return i < 0 ? null : [s.slice(0, i), s.slice(i + 1)]; };
  const fmtCpu = Q.fmtCpu, fmtMem = Q.fmtMem;
  const probeStr = (pr, ct) => {
    if (!pr) return null;
    const h = pr.httpGet ? `http-get http://:${pr.httpGet.port}${pr.httpGet.path || '/'}` : pr.tcpSocket ? `tcp-socket :${pr.tcpSocket.port}` : pr.exec ? `exec [${(pr.exec.command || []).join(' ')}]` : `grpc <pod>:${pr.grpc.port}`;
    void ct;
    return `${h} delay=${pr.initialDelaySeconds || 0}s timeout=${pr.timeoutSeconds || 1}s period=${pr.periodSeconds || 10}s #success=${pr.successThreshold || 1} #failure=${pr.failureThreshold || 3}`;
  };
  const MASK = { PAYMENTS_URL: 1 };
  void MASK;

  class Shell {
    constructor(game) { this.g = game; }
    get c() { return this.g.cluster; }
    fact(f) { this.g.fact(f); }

    /* entry point: pipelines and > redirection */
    exec(line) {
      const { segs, redirect } = splitPipeline(line);
      let stdin = null, out = [], extra = {};
      for (let i = 0; i < segs.length; i++) {
        const tk = tokenize(segs[i]);
        if (tk.error) return { lines: [{ t: 'bash: ' + tk.error, c: 'err' }] };
        if (!tk.tokens.length) { if (segs.length > 1) return { lines: [{ t: "bash: syntax error near unexpected token `|'", c: 'err' }] }; continue; }
        const r = this.run(tk.tokens, stdin, i === segs.length - 1 && !redirect) || {};
        const lines = r.lines || [];
        const errs = lines.filter(l => l.c === 'err' || l.c === 'warn');
        const std = lines.filter(l => l.c !== 'err' && l.c !== 'warn');
        if (i < segs.length - 1) { out = out.concat(errs); stdin = std.map(l => l.t).join('\n'); }
        else { out = out.concat(lines); extra = r; }
      }
      if (redirect) {
        const target = redirect.replace(/^&?\d?/, '').trim() || redirect;
        if (target === '/dev/null') return { lines: out.filter(l => l.c === 'err' || l.c === 'warn') };
        if (!/^[\w.\-]+$/.test(target)) return { lines: [{ t: 'bash: ' + (target || 'syntax error near unexpected token `newline\''), c: 'err' }] };
        const std = out.filter(l => l.c !== 'err' && l.c !== 'warn');
        this.g.files.set(target, std.map(l => l.t).join('\n') + (std.length ? '\n' : ''));
        this.fact('file:' + target);
        return { lines: out.filter(l => l.c === 'err' || l.c === 'warn'), files: true };
      }
      return Object.assign({}, extra, { lines: out });
    }

    run(t, stdin, last) {
      const cmd = t[0], args = t.slice(1);
      const L = []; const o = (s, c) => { String(s).split('\n').forEach(x => L.push({ t: x, c: c || '' })); };
      const r = extra => Object.assign({ lines: L }, extra || {});
      switch (cmd) {
        case 'kubectl': case 'k': this.c.activity.apiserver++; return this.kubectl(args, o, r, stdin, last);
        case 'clear': return { lines: [], clear: true };
        case 'help': o(HELP); return r();
        case 'runbook': o(RUNBOOK); this.fact('runbook'); return r();
        case 'ls': { const f = Array.from(this.g.files.keys()).sort(); if (args.includes('-l') || args.includes('-la')) f.forEach(n => o(`-rw-r--r--  1 oncall  oncall  ${String(this.g.files.get(n).length).padStart(5)}  ${n}`)); else if (f.length) o(f.join('  ')); return r(); }
        case 'cat': {
          if (!args.length && stdin != null) { o(stdin); return r(); }
          for (const n of args) { if (this.g.files.has(n)) { o(this.g.files.get(n).replace(/\n$/, '')); this.fact('cat:' + n); } else o(`cat: ${n}: No such file or directory`, 'err'); }
          return r();
        }
        case 'edit': case 'vim': case 'vi': case 'nano': case 'code': case 'emacs': {
          const n = args[0];
          if (!n) { o(`${cmd}: which file? Try: edit <file>   (files: ${Array.from(this.g.files.keys()).join(', ') || 'none yet'})`, 'err'); return r(); }
          if (!this.g.files.has(n)) this.g.files.set(n, '');
          o(`Opening ${n} in the editor…`, 'dim'); return r({ editor: n });
        }
        case 'touch': args.forEach(n => { if (!this.g.files.has(n)) this.g.files.set(n, ''); }); return r({ files: true });
        case 'rm': args.filter(a => a[0] !== '-').forEach(n => { if (!this.g.files.delete(n)) o(`rm: cannot remove '${n}': No such file or directory`, 'err'); }); return r({ files: true });
        case 'cp': { const [a1, b1] = args.filter(a => a[0] !== '-'); if (!this.g.files.has(a1)) o(`cp: cannot stat '${a1}': No such file or directory`, 'err'); else { this.g.files.set(b1, this.g.files.get(a1)); } return r({ files: true }); }
        case 'echo': { const nl = args[0] === '-n'; o((nl ? args.slice(1) : args).join(' ')); return r(); }
        case 'base64': {
          const input = (stdin || '').trim();
          if (args.includes('-d') || args.includes('--decode') || args.includes('-D')) {
            try { o(K.b64.decode(input)); this.fact('base64-decode'); } catch (e) { o('base64: invalid input', 'err'); }
          } else o(K.b64.encode(stdin || ''));
          return r();
        }
        case 'grep': {
          const a = parseArgs(args); const pat = a.pos[0];
          if (!pat) { o('usage: grep [-iv] PATTERN', 'err'); return r(); }
          const ci = a.flags.i, inv = a.flags.v;
          let re = null; try { re = a.flags.E || /[|^$\\[]/.test(pat) ? new RegExp(pat, ci ? 'i' : '') : null; } catch (e) { re = null; }
          (stdin || '').split('\n').forEach(l => { const hit = re ? re.test(l) : ci ? l.toLowerCase().includes(pat.toLowerCase()) : l.includes(pat); if (hit !== !!inv) o(l); });
          return r();
        }
        case 'wc': { const lines = (stdin || '').split('\n').filter((x, i, arr) => i < arr.length - 1 || x); o(args.includes('-l') ? String(lines.length) : `${lines.length} ${(stdin || '').split(/\s+/).filter(Boolean).length} ${(stdin || '').length}`); return r(); }
        case 'head': case 'tail': {
          const a = parseArgs(args); const n = Number(a.flags.n || (a.pos[0] && /^-?\d+$/.test(a.pos[0]) ? Math.abs(a.pos[0]) : 10)) || 10;
          const lines = (stdin || '').split('\n'); o((cmd === 'head' ? lines.slice(0, n) : lines.slice(-n)).join('\n')); return r();
        }
        case 'curl': case 'wget': return this.curl(args, o, r, this.c.TOOLBOX, cmd);
        case 'nslookup': case 'dig': case 'host': return this.nslookup(args, o, r, this.c.TOOLBOX, cmd);
        case 'whoami': o('oncall: SRE on the Stagedoor platform team'); return r();
        case 'pwd': o('/home/oncall'); return r();
        case 'exit': case 'logout': o('The pager is still on your belt. 📟', 'dim'); return r();
        case 'sudo': o('Nice try. Cluster permissions come from RBAC, not sudo. Drop the sudo and try again.', 'warn'); return r();
        case 'ping': o(`ping: ${args[0] || 'host'}: Service IPs are virtual and don't answer ICMP. Try curl or nslookup instead.`, 'warn'); return r();
        case 'docker': case 'podman': case 'crictl': o(`There's no ${cmd} here. You're working through the API server; use kubectl logs, describe and exec.`, 'warn'); return r();
        case 'ssh': o('No SSH to production nodes. Everything you need is in kubectl describe node, events and logs.', 'warn'); return r();
        case 'helm': case 'kustomize': case 'k9s': case 'stern': o(`${cmd} isn't installed in this incident shell. Everything here is plain kubectl.`, 'warn'); return r();
        default: {
          const s = suggest(cmd, SHELL.concat(['kubectl']));
          o(`bash: ${cmd}: command not found`, 'err');
          if (s) o(`did you mean '${s}'?`, 'dim');
          return r();
        }
      }
    }

    /* ---------------- kubectl ---------------- */
    kubectl(args, o, r, stdin, last) {
      const c = this.c;
      if (!args.length || args[0] === '--help' || args[0] === '-h') { o(KUBECTL_HELP); return r(); }
      // allow global flags before the verb: kubectl -n shop get pods
      let pre = [];
      while (args.length && args[0][0] === '-' && !['--help', '-h'].includes(args[0])) {
        pre.push(args[0]);
        if (['-n', '--namespace', '--context', '--as'].includes(args[0]) && args[1]) pre.push(args[1]), args = args.slice(1);
        args = args.slice(1);
      }
      if (!args.length) { o(KUBECTL_HELP); return r(); }
      const verb = args[0];
      const a = parseArgs(pre.concat(args.slice(1)));
      a.multi = a.multi || {};
      const nsFlag = typeof a.flags.namespace === 'string' ? a.flags.namespace : null;
      const ns = nsFlag || c.currentNamespace;
      const E = m => o(m, 'err');
      if (a.flags.namespace === true) { E("error: flag needs an argument: 'n' in -n"); return r(); }
      const need = (obj, kind, name) => { if (!obj) { E(`Error from server (NotFound): ${M.PLURAL[kind] || kind.toLowerCase() + 's'} "${name}" not found`); return false; } return true; };
      const target = (pos, i) => {
        const p = pos[i]; if (!p) return null;
        if (p.includes('/')) { const [tw, n] = p.split('/'); return { type: typeOf(tw), tw, name: n, used: 1 }; }
        return { type: typeOf(p), tw: p, name: pos[i + 1], used: 2 };
      };
      const badType = tw => { E(`error: the server doesn't have a resource type "${tw}"`); const s = suggest(String(tw), [].concat.apply([], TYPES.map(t => t.names))); if (s) o(`did you mean '${s}'?`, 'dim'); return r(); };
      const nsCheck = () => { if (!c.nsExists(ns)) { E(`Error from server (NotFound): namespaces "${ns}" not found`); return false; } return true; };
      if (nsFlag && !['get', 'describe', 'logs', 'exec', 'top', 'events', 'auth', 'config', 'delete', 'apply', 'create'].includes(verb) && !c.nsExists(ns)) { E(`Error from server (NotFound): namespaces "${ns}" not found`); return r(); }
      if (nsFlag) this.fact('ns-flag:' + nsFlag);

      switch (verb) {
        case 'version': o(`Client Version: ${K.CONST.VERSION}\nKustomize Version: v5.7.1\nServer Version: ${K.CONST.VERSION}`); return r();
        case 'cluster-info':
          o('Kubernetes control plane is running at https://api.stagedoor-prod.internal:6443', 'ok');
          o('CoreDNS is running at https://api.stagedoor-prod.internal:6443/api/v1/namespaces/kube-system/services/kube-dns:dns/proxy');
          o(''); o("To further debug and diagnose cluster problems, use 'kubectl cluster-info dump'.", 'dim');
          this.fact('cluster-info'); return r();
        case 'api-resources':
          o(table(['NAME', 'SHORTNAMES', 'APIVERSION', 'NAMESPACED', 'KIND'], TYPES.filter(t => t.kind !== 'Event').map(t => [t.key, t.names.filter(n => n.length <= 6 && n !== t.key && !n.endsWith('s') && n !== t.kind.toLowerCase()).join(','), M.API[t.kind] || 'v1', String(t.ns), t.kind])));
          return r();
        case 'explain': {
          const parts = (a.pos[0] || '').split('.');
          const t = typeOf(parts[0]);
          if (!t) { if (!a.pos[0]) { E('error: You must specify the type of resource to explain.'); return r(); } return badType(a.pos[0]); }
          const field = parts.slice(1).join('.');
          o(`GROUP:      ${(M.API[t.kind] || 'v1').includes('/') ? M.API[t.kind].split('/')[0] : ''}\nKIND:       ${t.kind}\nVERSION:    ${(M.API[t.kind] || 'v1').split('/').pop()}\n`);
          if (field && EXPLAIN_FIELDS[field.replace(/^spec\.(template\.spec\.)?/, '')]) { o(`FIELD: ${field.split('.').pop()}\n\nDESCRIPTION:`); o('    ' + EXPLAIN_FIELDS[field.replace(/^spec\.(template\.spec\.)?/, '')]); }
          else { o('DESCRIPTION:'); o('    ' + (EXPLAIN[t.kind] || 'A Kubernetes object.')); }
          this.fact('explain:' + t.key); return r();
        }
        case 'get': return this.get(a, ns, nsFlag, o, r, last);
        case 'events': return this.get(Object.assign({}, a, { pos: ['events'] }), ns, nsFlag, o, r, last);
        case 'describe': return this.describe(a, ns, o, r, target, badType);
        case 'logs': return this.logs(a, ns, o, r);
        case 'top': return this.top(a, ns, o, r);
        case 'config': return this.config(a, o, r);
        case 'exec': return this.execPod(a, ns, o, r);
        case 'auth': return this.auth(a, ns, o, r);
        case 'debug': o('kubectl debug needs an interactive terminal, which this simulator does not have. Use kubectl exec <pod> -- <command> to run one command inside a pod.', 'warn'); return r();
        case 'port-forward': o("port-forward isn't needed here: this terminal already runs inside the cluster. Try: curl <service>.<namespace>:<port>", 'warn'); return r();
        case 'edit': {
          const tg = target(a.pos, 0);
          if (!tg || !tg.name) { E('error: you must specify a resource to edit, e.g. kubectl edit deployment/checkout'); return r(); }
          if (!tg.type) return badType(tg.tw);
          const obj = this.findObj(tg.type, ns, tg.name);
          if (!need(obj, tg.type.kind, tg.name)) return r();
          const file = `${tg.name}-${tg.type.kind.toLowerCase()}.yaml`;
          this.g.files.set(file, K.yaml.dump(M.toManifest(c, obj, true)));
          this.fact('edit:' + tg.type.key + ':' + tg.name);
          o(`kubectl edit opens your $EDITOR. Here, ${file} opens in the editor instead. Save it, then run: kubectl apply -f ${file}`, 'dim');
          return r({ editor: file, files: true });
        }
        case 'patch': return this.patch(a, ns, o, r, target, badType);
        case 'run': {
          const name = a.pos[0]; const image = a.flags.image;
          if (!name) { E('error: NAME is required for run'); return r(); }
          if (!image || image === true) { E('error: required flag(s) "image" not set'); return r(); }
          if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name)) { E(`The Pod "${name}" is invalid: metadata.name: Invalid value: "${name}": a lowercase RFC 1123 subdomain must consist of lower case alphanumeric characters, '-' or '.'`); return r(); }
          if (!nsCheck()) return r();
          const labels = typeof a.flags.labels === 'string' ? Object.fromEntries(a.flags.labels.split(',').map(x => x.split('='))) : { run: name };
          const env = (a.multi.env || []).filter(x => typeof x === 'string').map(x => { const kv = parseKV(x); return { name: kv ? kv[0] : x, value: kv ? kv[1] : '' }; });
          const restart = typeof a.flags.restart === 'string' ? a.flags.restart : 'Always';
          const cmdArgs = a.flags['--'] || [];
          const spec = c.podSpec({ name, image, env, port: a.flags.port ? Number(a.flags.port) : null, command: cmdArgs.length ? cmdArgs : undefined });
          spec.restartPolicy = restart;
          if (a.flags['dry-run']) { this.dry(a, o, { apiVersion: 'v1', kind: 'Pod', metadata: { labels, name, namespace: nsFlag || undefined }, spec: { containers: [Object.assign({ image, name, resources: {} }, cmdArgs.length ? { command: cmdArgs } : {})], dnsPolicy: 'ClusterFirst', restartPolicy: restart }, status: {} }, 'pod/' + name); return r(); }
          if (c.get('Pod', ns, name)) { E(`Error from server (AlreadyExists): pods "${name}" already exists`); return r(); }
          const err = c.admitPod(ns, name, spec);
          if (err) { E('Error from server (Forbidden): ' + err); return r(); }
          c.makePod({ ns, name, labels, spec });
          o(`pod/${name} created`, 'ok');
          if (a.flags.stdin || a.flags.tty || a.flags.rm) o('(interactive sessions are not simulated, so the pod was created without attaching. Use kubectl exec <pod> -- <command>)', 'dim');
          this.fact('run:' + name); return r();
        }
        case 'create': return this.create(a, ns, nsFlag, o, r, nsCheck, stdin);
        case 'apply': return this.applyFiles(a, ns, nsFlag, o, r, 'apply', stdin);
        case 'delete': return this.del(a, ns, o, r, badType, stdin);
        case 'scale': {
          const tg = target(a.pos, 0);
          const n = Number(a.flags.replicas);
          if (!tg) { E('error: resource(s) were provided, but no name was specified'); return r(); }
          if (a.flags.replicas == null) { E('error: required flag(s) "replicas" not set'); return r(); }
          if (!tg.type) return badType(tg.tw);
          if (!['Deployment', 'ReplicaSet'].includes(tg.type.kind)) { E(`error: cannot scale ${tg.type.key} in this simulator (try a deployment)`); return r(); }
          if (!Number.isInteger(n) || n < 0) { E(`error: invalid --replicas value "${a.flags.replicas}"`); return r(); }
          const obj = c.get(tg.type.kind, ns, tg.name);
          if (!need(obj, tg.type.kind, tg.name)) return r();
          obj.replicas = n; c.activity.etcd++;
          o(`${M.RES[obj.kind]}/${obj.name} scaled`, 'ok');
          if (c.list('HorizontalPodAutoscaler', ns).some(h => h.target.name === obj.name)) o('note: an autoscaler manages this deployment and will override the replica count', 'dim');
          this.fact('scale:' + obj.name); return r();
        }
        case 'expose': {
          const tg = target(a.pos, 0);
          if (!tg || !tg.name) { E('error: You must provide the resource to expose, e.g. kubectl expose deployment web --port=80'); return r(); }
          if (!tg.type) return badType(tg.tw);
          const obj = this.findObj(tg.type, ns, tg.name);
          if (!need(obj, tg.type.kind, tg.name)) return r();
          let selector = obj.kind === 'Pod' ? obj.labels : obj.selector;
          if (!selector || !Object.keys(selector).length) { E(`error: couldn't retrieve selectors via --selector flag or introspection: the ${obj.kind.toLowerCase()} has no labels and cannot be exposed`); return r(); }
          selector = Object.fromEntries(Object.entries(selector).filter(([k]) => k !== 'pod-template-hash'));
          const ct = obj.template ? obj.template.spec.containers[0] : obj.spec && obj.spec.containers[0];
          const port = a.flags.port ? Number(a.flags.port) : ct && ct.ports && ct.ports[0] && ct.ports[0].containerPort;
          if (!port) { E("error: couldn't find port via --port flag or introspection"); return r(); }
          const types = { clusterip: 'ClusterIP', nodeport: 'NodePort', loadbalancer: 'LoadBalancer' };
          const type = types[String(a.flags.type || 'ClusterIP').toLowerCase()];
          if (!type) { E(`error: Service "${tg.name}" is invalid: spec.type: Unsupported value: "${a.flags.type}"`); return r(); }
          const name = typeof a.flags.name === 'string' ? a.flags.name : obj.name;
          const targetPort = a.flags['target-port'] ? (/^\d+$/.test(a.flags['target-port']) ? Number(a.flags['target-port']) : a.flags['target-port']) : port;
          if (a.flags['dry-run']) { this.dry(a, o, { apiVersion: 'v1', kind: 'Service', metadata: { labels: obj.labels, name, namespace: nsFlag || undefined }, spec: { ports: [{ port, protocol: 'TCP', targetPort }], selector, type: a.flags.type ? type : undefined }, status: { loadBalancer: {} } }, 'service/' + name); return r(); }
          if (c.get('Service', ns, name)) { E(`Error from server (AlreadyExists): services "${name}" already exists`); return r(); }
          c.createService({ ns, name, labels: Object.assign({}, obj.labels), selector, type, ports: [{ port, targetPort, protocol: 'TCP' }] });
          o(`service/${name} exposed`, 'ok'); this.fact('expose:' + name); return r();
        }
        case 'set': return this.set(a, ns, o, r, target, badType, need);
        case 'rollout': return this.rollout(a, ns, o, r, target, badType, last);
        case 'label': case 'annotate': {
          const tg = target(a.pos, 0);
          if (!tg || !tg.name) { E('error: one or more resources must be specified as <resource> <name> or <resource>/<name>'); return r(); }
          if (!tg.type) return badType(tg.tw);
          const obj = this.findObj(tg.type, ns, tg.name);
          if (!need(obj, tg.type.kind, tg.name)) return r();
          const pairs = a.pos.slice(tg.used);
          if (!pairs.length) { E(`error: at least one ${verb === 'label' ? 'label' : 'annotation'} update is required`); return r(); }
          const field = verb === 'label' ? 'labels' : 'annotations';
          obj[field] = obj[field] || {};
          let removed = false;
          for (const pr of pairs) {
            if (pr.endsWith('-')) { delete obj[field][pr.slice(0, -1)]; removed = true; continue; }
            const kv = parseKV(pr); if (!kv) { E(`error: invalid ${verb === 'label' ? 'label' : 'annotation'} spec: ${pr}`); return r(); }
            if (kv[0] in obj[field] && obj[field][kv[0]] !== kv[1] && !a.flags.overwrite) { E(`error: '${kv[0]}' already has a value (${obj[field][kv[0]]}), and --overwrite is false`); return r(); }
            obj[field][kv[0]] = kv[1];
          }
          if (verb === 'annotate' && obj.kind === 'Deployment' && obj.annotations['kubernetes.io/change-cause']) obj.changeCause = obj.annotations['kubernetes.io/change-cause'];
          c.activity.etcd++;
          o(`${M.RES[obj.kind] || obj.kind.toLowerCase()}/${obj.name} ${removed && pairs.every(p => p.endsWith('-')) ? 'un' + verb + 'ed' : verb === 'label' ? 'labeled' : 'annotated'}`, 'ok');
          this.fact(verb + ':' + obj.name); return r();
        }
        case 'cordon': case 'uncordon': {
          const n = c.node(a.pos[0]);
          if (!a.pos[0]) { E(`error: USAGE: kubectl ${verb} NODE`); return r(); }
          if (!n) { E(`Error from server (NotFound): nodes "${a.pos[0]}" not found`); return r(); }
          const want = verb === 'cordon';
          if (n.unschedulable === want) o(`node/${n.name} already ${verb}ed`);
          else { n.unschedulable = want; c.activity.etcd++; c.event(n, 'Normal', want ? 'NodeNotSchedulable' : 'NodeSchedulable', `Node ${n.name} status is now: ${want ? 'NodeNotSchedulable' : 'NodeSchedulable'}`, 'kubelet'); o(`node/${n.name} ${verb}ed`, 'ok'); }
          this.fact(verb + ':' + n.name); return r();
        }
        case 'drain': return this.drain(a, o, r, last);
        case 'taint': return this.taint(a, o, r);
        case 'autoscale': {
          const tg = target(a.pos, 0);
          if (!tg || !tg.name) { E('error: you must specify a deployment, e.g. kubectl autoscale deployment web --min=2 --max=10 --cpu-percent=50'); return r(); }
          if (!tg.type || tg.type.kind !== 'Deployment') return tg.type ? (E('error: this simulator can autoscale deployments only'), r()) : badType(tg.tw);
          const d = c.get('Deployment', ns, tg.name);
          if (!need(d, 'Deployment', tg.name)) return r();
          const max = Number(a.flags.max), min = a.flags.min != null ? Number(a.flags.min) : 1;
          if (!max || max < 1) { E(`error: --max=MAXPODS is required and must be at least 1, max: ${a.flags.max == null ? 0 : a.flags.max}`); return r(); }
          if (min > max) { E(`error: --max=MAXPODS must be larger or equal to --min=MINPODS, max: ${max}, min: ${min}`); return r(); }
          const cpu = a.flags['cpu-percent'] != null ? Number(a.flags['cpu-percent']) : a.flags.cpu != null ? parseInt(a.flags.cpu, 10) : 80;
          const name = typeof a.flags.name === 'string' ? a.flags.name : d.name;
          if (c.get('HorizontalPodAutoscaler', ns, name)) { E(`Error from server (AlreadyExists): horizontalpodautoscalers.autoscaling "${name}" already exists`); return r(); }
          c.createHPA({ ns, name, target: d.name, min, max, cpu });
          o(`horizontalpodautoscaler.autoscaling/${name} autoscaled`, 'ok'); this.fact('autoscale:' + d.name); return r();
        }
        default: {
          const s = suggest(verb, VERBS);
          E(`error: unknown command "${verb}" for "kubectl"`);
          if (s) o(`\nDid you mean this?\n        ${s}`, 'dim');
          return r();
        }
      }
    }

    findObj(type, ns, name) {
      const c = this.c;
      if (type.kind === 'Node') return c.node(name);
      if (type.kind === 'Namespace') return c.namespaces.get(name) || null;
      if (type.kind === 'Endpoints' || type.kind === 'Event') return null;
      return c.get(type.kind, ns, name);
    }
    dry(a, o, manifest, res) {
      const fmt = a.flags.output;
      const clean = JSON.parse(JSON.stringify(manifest));
      if (fmt === 'yaml') o(K.yaml.dump(clean).replace(/\n$/, ''));
      else if (fmt === 'json') o(JSON.stringify(clean, null, 2));
      else o(res + ' created (dry run)');
      this.fact('dry-run');
    }
    /* change an object through its manifest so every edit goes through the same validation as apply */
    reapply(obj, mutate, o) {
      const c = this.c;
      const m = M.toManifest(c, obj, true);
      if (obj.kind === 'Deployment' && obj.annotations) m.metadata.annotations = Object.assign({}, obj.annotations);
      const next = mutate(m) || m;
      try {
        const line = M.applyDoc(c, next, { file: '-', ns: obj.namespace, mode: 'apply' });
        return { ok: true, changed: !/unchanged$/.test(line), line };
      } catch (e) {
        if (!(e instanceof M.ApplyError)) throw e;
        o(e.message.replace(/error when (creating|applying patch)[^:]*: /, ''), 'err');
        return { ok: false };
      }
    }
    patch(a, ns, o, r, target, badType) {
      const E = m => o(m, 'err');
      const tg = target(a.pos, 0);
      if (!tg || !tg.name) { E('error: you must specify a resource and a patch, e.g. kubectl patch deployment checkout -p \'{"spec":{"replicas":3}}\''); return r(); }
      if (!tg.type) return badType(tg.tw);
      const obj = this.findObj(tg.type, ns, tg.name);
      if (!obj) { E(`Error from server (NotFound): ${M.PLURAL[tg.type.kind] || tg.type.key} "${tg.name}" not found`); return r(); }
      const raw = typeof a.flags.patch === 'string' ? a.flags.patch : a.flags.previous ? a.pos[tg.used] : undefined;
      if (typeof raw !== 'string') { E('error: must specify --patch or --patch-file containing the contents of the patch'); return r(); }
      let patch;
      try { patch = JSON.parse(raw); } catch (e) {
        try { patch = K.yaml.parseAll(raw)[0]; } catch (e2) { patch = null; }
        if (!patch || typeof patch !== 'object') { E(`error: unable to parse "${raw}": yaml: did not find expected node content`); return r(); }
      }
      if (tg.type.kind === 'Node') {
        if (patch.spec && 'unschedulable' in patch.spec) obj.unschedulable = !!patch.spec.unschedulable;
        if (patch.spec && patch.spec.taints) obj.taints = clone(patch.spec.taints);
        o(`node/${obj.name} patched`, 'ok'); return r();
      }
      const type = a.flags.type || 'strategic';
      const res = this.reapply(obj, m => {
        if (type === 'json') {
          if (!Array.isArray(patch)) throw new M.ApplyError('error: unable to parse patch: json patches must be a list of operations');
          patch.forEach(op => {
            const path = String(op.path || '').split('/').slice(1).map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'));
            let cur = m;
            for (let i = 0; i < path.length - 1; i++) { if (cur[path[i]] == null) cur[path[i]] = /^\d+$/.test(path[i + 1]) ? [] : {}; cur = cur[path[i]]; }
            const k = path[path.length - 1];
            if (op.op === 'remove') { if (Array.isArray(cur)) cur.splice(Number(k), 1); else delete cur[k]; }
            else if (Array.isArray(cur) && (k === '-' || op.op === 'add')) { if (k === '-') cur.push(op.value); else cur.splice(Number(k), 0, op.value); }
            else cur[k] = op.value;
          });
          return m;
        }
        return M.merge(m, patch);
      }, o);
      if (res.ok) { o(`${M.RES[obj.kind]}/${obj.name} ${res.changed ? 'patched' : 'patched (no change)'}`, 'ok'); this.fact('patch:' + obj.name); }
      return r();
    }
    set(a, ns, o, r, target, badType, need) {
      const c = this.c, E = m => o(m, 'err');
      const sub = a.pos[0];
      if (!['image', 'env', 'resources', 'serviceaccount', 'sa'].includes(sub)) { E(sub ? `error: unknown command "${sub}" for "kubectl set" (supported: image, env, resources, serviceaccount)` : 'error: you must specify a subcommand: image, env, resources, serviceaccount'); return r(); }
      const tg = target(a.pos, 1);
      if (!tg || !tg.name) { E(`error: you must specify a resource, e.g. kubectl set ${sub} deployment/checkout ...`); return r(); }
      if (!tg.type) return badType(tg.tw);
      const obj = this.findObj(tg.type, ns, tg.name);
      if (!need(obj, tg.type.kind, tg.name)) return r();
      if (obj.kind !== 'Deployment' && obj.kind !== 'Pod') { E(`error: set ${sub} supports deployments and pods in this simulator`); return r(); }
      const rest = a.pos.slice(1 + tg.used);
      const cname = typeof a.flags.container === 'string' ? a.flags.container : null;
      const pickC = cts => { const hits = cname ? cts.filter(x => x.name === cname || cname === '*') : cts; if (!hits.length) { E(`error: unable to find container named "${cname}"`); o(`containers: ${cts.map(x => x.name).join(', ')}`, 'dim'); } return hits; };
      if (sub === 'env' && a.flags.list) {
        const cts = obj.kind === 'Deployment' ? obj.template.spec.containers : obj.spec.containers;
        cts.forEach(ct => { o(`# ${M.RES[obj.kind]}/${obj.name}, container ${ct.name}`); (ct.envFrom || []).forEach(ef => o(`# ${ef.configMapRef ? 'ConfigMap' : 'Secret'} ${(ef.configMapRef || ef.secretRef).name}`)); (ct.env || []).forEach(e => o(e.valueFrom ? `# ${e.name} from ${Object.keys(e.valueFrom)[0]}` : `${e.name}=${e.value}`)); });
        this.fact('set-env-list:' + obj.name); return r();
      }
      if (obj.kind === 'Pod' && sub !== 'image') { E(`The Pod "${obj.name}" is invalid: spec: Forbidden: pod updates may not change fields other than \`spec.containers[*].image\`. Change the Deployment that owns it instead.`); return r(); }
      let failed = false;
      const res = this.reapply(obj, m => {
        const ps = obj.kind === 'Deployment' ? m.spec.template.spec : m.spec;
        const cts = pickC(ps.containers);
        if (!cts.length) { failed = true; return m; }
        if (sub === 'image') {
          if (!rest.length) { E('error: at least one image update is required'); failed = true; return m; }
          for (const pr of rest) {
            const kv = parseKV(pr);
            if (!kv) { E(`error: invalid image update "${pr}": expected <container>=<image>`); failed = true; return m; }
            const hits = kv[0] === '*' ? ps.containers : ps.containers.concat(ps.initContainers || []).filter(x => x.name === kv[0]);
            if (!hits.length) { E(`error: unable to find container named "${kv[0]}"`); o(`containers in ${obj.name}: ${ps.containers.map(x => x.name).join(', ')}`, 'dim'); failed = true; return m; }
            hits.forEach(x => { x.image = kv[1]; });
          }
        } else if (sub === 'env') {
          if (!rest.length) { E('error: at least one environment variable must be provided'); failed = true; return m; }
          for (const ct of cts) {
            ct.env = ct.env || [];
            for (const pr of rest) {
              if (pr.endsWith('-') && !pr.includes('=')) { ct.env = ct.env.filter(e => e.name !== pr.slice(0, -1)); continue; }
              const kv = parseKV(pr);
              if (!kv || !kv[0]) { E(`error: invalid env: ${pr}`); failed = true; return m; }
              const e = ct.env.find(x => x.name === kv[0]);
              if (e) { delete e.valueFrom; e.value = kv[1]; } else ct.env.push({ name: kv[0], value: kv[1] });
            }
            if (!ct.env.length) delete ct.env;
          }
        } else if (sub === 'resources') {
          const parse = s => { const out = {}; if (typeof s !== 'string') return null; for (const part of s.split(',')) { const kv = parseKV(part); if (!kv) return null; out[kv[0]] = kv[1]; } return out; };
          const lim = a.flags.limits != null ? parse(a.flags.limits) : {}, req = a.flags.requests != null ? parse(a.flags.requests) : {};
          if (lim === null || req === null || (!Object.keys(lim).length && !Object.keys(req).length)) { E('error: you must specify an update to requests or limits, e.g. --limits=memory=512Mi --requests=cpu=100m,memory=256Mi'); failed = true; return m; }
          for (const ct of cts) {
            ct.resources = ct.resources || {};
            if (Object.keys(lim).length) ct.resources.limits = Object.assign({}, ct.resources.limits, lim);
            if (Object.keys(req).length) ct.resources.requests = Object.assign({}, ct.resources.requests, req);
          }
        } else {
          if (!rest[0]) { E('error: serviceaccount is required'); failed = true; return m; }
          ps.serviceAccountName = rest[0];
        }
        return m;
      }, o);
      if (failed || !res.ok) return r();
      const what = { image: 'image updated', env: 'env updated', resources: 'resource requirements updated', serviceaccount: 'serviceaccount updated', sa: 'serviceaccount updated' }[sub];
      if (res.changed) o(`${M.RES[obj.kind]}/${obj.name} ${what}`, 'ok');
      else o(`${M.RES[obj.kind]}/${obj.name} unchanged`, 'dim');
      this.fact(`set-${sub}:${obj.name}`);
      return r();
    }

    /* ---------- get ---------- */
    fieldFilter(fs) {
      if (!fs || fs === true) return null;
      const parts = String(fs).split(',').map(p => { const m = /^([\w.]+)(!=|==|=)(.*)$/.exec(p.trim()); return m ? { path: m[1], neg: m[2] === '!=', val: m[3] } : null; }).filter(Boolean);
      const read = (x, path) => {
        if (x.eventRow) return { type: x.type, reason: x.reason, 'involvedObject.name': x.name, 'involvedObject.kind': x.kind }[path];
        if (path === 'status.phase' && x.kind === 'Pod') return x.status === 'Failed' ? 'Failed' : x.status === 'Succeeded' ? 'Succeeded' : !x.node || x.phase !== 'Running' && !/CrashLoop|Error|OOMKilled/.test(x.phase) ? (x.phase === 'Running' ? 'Running' : 'Pending') : 'Running';
        if (path === 'spec.nodeName') return x.node || '';
        if (path === 'metadata.name') return x.name;
        if (path === 'metadata.namespace') return x.namespace;
        return undefined;
      };
      return x => parts.every(p => (String(read(x, p.path)) === p.val) !== p.neg);
    }
    collect(type, ns, allNs, names, sel, fs) {
      const c = this.c;
      let objs;
      if (type.kind === 'Node') objs = c.nodes.slice();
      else if (type.kind === 'Namespace') objs = Array.from(c.namespaces.values());
      else if (type.kind === 'Endpoints') objs = c.list('Service', allNs ? null : ns).map(s => ({ kind: 'Endpoints', name: s.name, namespace: s.namespace, created: s.created, svc: s, labels: s.labels }));
      else if (type.kind === 'Event') objs = c.events.filter(e => allNs || e.namespace === ns || (e.kind === 'Node' && ns === 'default')).map(e => Object.assign({ eventRow: true }, e));
      else objs = c.list(type.kind, allNs || !type.ns ? null : ns);
      if (sel) { const f = parseSelector(sel); objs = objs.filter(x => f(x.labels)); }
      const ff = this.fieldFilter(fs); if (ff) objs = objs.filter(ff);
      if (type.kind !== 'Event') objs.sort((x, y) => (x.namespace || '').localeCompare(y.namespace || '') || (x.name < y.name ? -1 : 1));
      if (!names.length) return { objs, missing: [] };
      const found = [], missing = [];
      names.forEach(n => { const x = objs.find(q => q.name === n); if (x) found.push(x); else missing.push(n); });
      return { objs: found, missing };
    }
    endpointList(svc) {
      if (svc.staticEndpoints) return svc.staticEndpoints;
      const out = [];
      for (const sp of svc.ports) for (const p of this.c.endpointsFor(svc, sp)) { const s = p.ip + ':' + this.c.targetPortOf(p, sp); if (!out.includes(s)) out.push(s); }
      return out;
    }
    restartsStr(p) { return p.restarts ? `${p.restarts} (${human(this.c.now - p.lastRestartAt)} ago)` : '0'; }
    rowsFor(type, objs, opt) {
      const c = this.c, age = x => human(c.now - x.created), wide = opt.wide;
      const nm = x => (opt.prefix ? opt.prefix + '/' : '') + x.name;
      let h, rows;
      switch (type.kind) {
        case 'Pod':
          h = ['NAME', 'READY', 'STATUS', 'RESTARTS', 'AGE'].concat(wide ? ['IP', 'NODE', 'NOMINATED NODE', 'READINESS GATES'] : []);
          rows = objs.map(p => [nm(p), readyStr(p), podStatus(p), this.restartsStr(p), age(p)].concat(wide ? [p.ip || '<none>', p.node || '<none>', '<none>', '<none>'] : []));
          break;
        case 'Deployment':
          h = ['NAME', 'READY', 'UP-TO-DATE', 'AVAILABLE', 'AGE'].concat(wide ? ['CONTAINERS', 'IMAGES', 'SELECTOR'] : []);
          rows = objs.map(d => { const s = c.deploymentStatus(d); return [nm(d), `${s.ready}/${d.replicas}`, s.updated, s.available, age(d)].concat(wide ? [d.template.spec.containers.map(x => x.name).join(','), d.template.spec.containers.map(x => x.image).join(','), labelStr(d.selector)] : []); });
          break;
        case 'ReplicaSet':
          h = ['NAME', 'DESIRED', 'CURRENT', 'READY', 'AGE'].concat(wide ? ['CONTAINERS', 'IMAGES', 'SELECTOR'] : []);
          rows = objs.map(rs => { const pods = c.podsOfRS(rs); return [nm(rs), rs.replicas, pods.length, pods.filter(p => p.ready).length, age(rs)].concat(wide ? [rs.template.spec.containers.map(x => x.name).join(','), rs.template.spec.containers.map(x => x.image).join(','), labelStr(rs.selector)] : []); });
          break;
        case 'DaemonSet':
          h = ['NAME', 'DESIRED', 'CURRENT', 'READY', 'UP-TO-DATE', 'AVAILABLE', 'NODE SELECTOR', 'AGE'];
          rows = objs.map(ds => { const pods = c.list('Pod', ds.namespace).filter(p => p.owner && p.owner.name === ds.name && !p.deleting); const rd = pods.filter(p => p.ready).length; return [nm(ds), c.nodes.filter(n => n.ready).length, pods.length, rd, pods.length, rd, 'kubernetes.io/os=linux', age(ds)]; });
          break;
        case 'Service':
          h = ['NAME', 'TYPE', 'CLUSTER-IP', 'EXTERNAL-IP', 'PORT(S)', 'AGE'].concat(wide ? ['SELECTOR'] : []);
          rows = objs.map(s => [nm(s), s.type, s.clusterIP, s.type === 'LoadBalancer' ? (s.externalIP || '<pending>') : '<none>', s.ports.map(p => p.port + (p.nodePort ? ':' + p.nodePort : '') + '/' + p.protocol).join(','), age(s)].concat(wide ? [labelStr(s.selector)] : []));
          break;
        case 'Node':
          h = ['NAME', 'STATUS', 'ROLES', 'AGE', 'VERSION'].concat(wide ? ['INTERNAL-IP', 'EXTERNAL-IP', 'OS-IMAGE', 'KERNEL-VERSION', 'CONTAINER-RUNTIME'] : []);
          rows = objs.map(n => [nm(n), (n.ready ? 'Ready' : 'NotReady') + (n.unschedulable ? ',SchedulingDisabled' : ''), '<none>', age(n), K.CONST.VERSION].concat(wide ? [n.ip, '<none>', 'Bottlerocket OS 1.42.0 (aws-k8s-1.34)', '6.1.141', 'containerd://2.0.6+bottlerocket'] : []));
          break;
        case 'Namespace': h = ['NAME', 'STATUS', 'AGE']; rows = objs.map(n => [nm(n), n.phase, age(n)]); break;
        case 'ConfigMap': h = ['NAME', 'DATA', 'AGE']; rows = objs.map(x => [nm(x), Object.keys(x.data).length, age(x)]); break;
        case 'Secret': h = ['NAME', 'TYPE', 'DATA', 'AGE']; rows = objs.map(x => [nm(x), x.type || 'Opaque', Object.keys(x.data).length, age(x)]); break;
        case 'ServiceAccount': h = ['NAME', 'SECRETS', 'AGE']; rows = objs.map(x => [nm(x), 0, age(x)]); break;
        case 'Endpoints':
          h = ['NAME', 'ENDPOINTS', 'AGE'];
          rows = objs.map(e => { const l = this.endpointList(e.svc); return [nm(e), l.length ? l.slice(0, 3).join(',') + (l.length > 3 ? ` + ${l.length - 3} more...` : '') : '<none>', age(e)]; });
          break;
        case 'Event':
          h = ['LAST SEEN', 'TYPE', 'REASON', 'OBJECT', 'MESSAGE'];
          rows = objs.map(e => [human(c.now - e.last), e.type, e.reason, `${e.kind.toLowerCase()}/${e.name}`, e.message]);
          break;
        case 'HorizontalPodAutoscaler':
          h = ['NAME', 'REFERENCE', 'TARGETS', 'MINPODS', 'MAXPODS', 'REPLICAS', 'AGE'];
          rows = objs.map(x => { const d = c.get('Deployment', x.namespace, x.target.name); return [nm(x), 'Deployment/' + x.target.name, `cpu: ${x.current == null ? '<unknown>' : x.current + '%'}/${x.targetCPU}%`, x.min, x.max, d ? d.replicas : 0, age(x)]; });
          break;
        case 'Ingress':
          h = ['NAME', 'CLASS', 'HOSTS', 'ADDRESS', 'PORTS', 'AGE'];
          rows = objs.map(x => [nm(x), x.ingressClassName || '<none>', x.rules.map(r => r.host || '*').join(','), 'a1b2c3d4e5-1234567890.eu-west-1.elb.amazonaws.com', x.tls ? '80, 443' : '80', age(x)]);
          break;
        case 'NetworkPolicy': h = ['NAME', 'POD-SELECTOR', 'AGE']; rows = objs.map(x => [nm(x), labelStr((x.podSelector || {}).matchLabels).replace('<none>', ''), age(x)]); break;
        case 'Role': case 'ClusterRole': h = ['NAME', 'CREATED AT']; rows = objs.map(x => [nm(x), c.ts(x.created)]); break;
        case 'RoleBinding': case 'ClusterRoleBinding':
          h = ['NAME', 'ROLE', 'AGE'].concat(wide ? ['USERS', 'GROUPS', 'SERVICEACCOUNTS'] : []);
          rows = objs.map(x => [nm(x), `${x.roleRef.kind}/${x.roleRef.name}`, age(x)].concat(wide ? [x.subjects.filter(s => s.kind === 'User').map(s => s.name).join(','), x.subjects.filter(s => s.kind === 'Group').map(s => s.name).join(','), x.subjects.filter(s => s.kind === 'ServiceAccount').map(s => `${s.namespace || x.namespace}/${s.name}`).join(',')] : []));
          break;
        case 'ResourceQuota':
          h = ['NAME', 'AGE', 'REQUEST', 'LIMIT'];
          rows = objs.map(x => {
            const u = c.quotaUsage(x.namespace), f = (k, v) => /cpu/.test(k) ? fmtCpu(v) : /memory/.test(k) ? fmtMem(v) : String(v);
            const part = keys => keys.filter(k => k in x.hard).map(k => `${k}: ${f(k, u[k] || 0)}/${x.hard[k]}`).join(', ');
            return [nm(x), age(x), part(['pods', 'requests.cpu', 'requests.memory', 'cpu', 'memory']), part(['limits.cpu', 'limits.memory'])];
          });
          break;
        case 'PersistentVolumeClaim':
          h = ['NAME', 'STATUS', 'VOLUME', 'CAPACITY', 'ACCESS MODES', 'STORAGECLASS', 'VOLUMEATTRIBUTESCLASS', 'AGE'];
          rows = objs.map(x => [nm(x), x.terminating ? 'Terminating' : x.phase, x.volumeName || '', x.phase === 'Bound' ? fmtMem(x.capacityMi) : '', x.phase === 'Bound' ? x.spec.accessModes.map(m => ({ ReadWriteOnce: 'RWO', ReadOnlyMany: 'ROX', ReadWriteMany: 'RWX', ReadWriteOncePod: 'RWOP' }[m] || m)).join(',') : '', x.spec.storageClassName || x.storageClassResolved || '<unset>', '<unset>', age(x)]);
          break;
        case 'PersistentVolume':
          h = ['NAME', 'CAPACITY', 'ACCESS MODES', 'RECLAIM POLICY', 'STATUS', 'CLAIM', 'STORAGECLASS', 'AGE'];
          rows = objs.map(x => [nm(x), fmtMem(x.capacityMi), 'RWO', x.reclaimPolicy, x.status, `${x.claim.namespace}/${x.claim.name}`, x.storageClass, age(x)]);
          break;
        case 'StorageClass':
          h = ['NAME', 'PROVISIONER', 'RECLAIMPOLICY', 'VOLUMEBINDINGMODE', 'ALLOWVOLUMEEXPANSION', 'AGE'];
          rows = objs.map(x => [nm(x) + (x.isDefault ? ' (default)' : ''), x.provisioner, x.reclaimPolicy, x.volumeBindingMode, String(x.allowVolumeExpansion), age(x)]);
          break;
        case 'PodDisruptionBudget':
          h = ['NAME', 'MIN AVAILABLE', 'MAX UNAVAILABLE', 'ALLOWED DISRUPTIONS', 'AGE'];
          rows = objs.map(x => [nm(x), x.minAvailable != null ? x.minAvailable : 'N/A', x.maxUnavailable != null ? x.maxUnavailable : 'N/A', c.pdbStatus(x).allowed, age(x)]);
          break;
        default: h = ['NAME', 'AGE']; rows = objs.map(x => [nm(x), age(x)]);
      }
      if (opt.allNs && type.ns) { h = ['NAMESPACE'].concat(h); rows = rows.map((row, i) => [objs[i].namespace].concat(row)); }
      if (opt.showLabels) { h = h.concat(['LABELS']); rows = rows.map((row, i) => row.concat([labelStr(objs[i].labels)])); }
      return table(h, rows);
    }
    get(a, ns, nsFlag, o, r, last) {
      const c = this.c, E = m => o(m, 'err');
      if (!a.pos.length) { E('You must specify the type of resource to get. Use "kubectl api-resources" for a complete list of supported resources.'); return r(); }
      const allNs = !!a.flags['all-namespaces'];
      const fmt = typeof a.flags.output === 'string' ? a.flags.output : null;
      const sel = typeof a.flags.selector === 'string' ? a.flags.selector : null;
      const fs = a.flags['field-selector'];
      let groups = [];
      if (a.pos[0].includes('/')) {
        for (const p of a.pos) {
          const [tw, n] = p.split('/'); const t = typeOf(tw);
          if (!t) { E(`error: the server doesn't have a resource type "${tw}"`); return r(); }
          let g = groups.find(x => x.type === t); if (!g) groups.push(g = { type: t, names: [] }); g.names.push(n);
        }
      } else {
        const words = a.pos[0] === 'all' ? ['pods', 'services', 'daemonsets', 'deployments', 'replicasets', 'hpa'] : a.pos[0].split(',');
        for (const w of words) {
          const t = typeOf(w);
          if (!t) { E(`error: the server doesn't have a resource type "${w}"`); const s = suggest(w, [].concat.apply([], TYPES.map(x => x.names))); if (s) o(`did you mean '${s}'?`, 'dim'); return r(); }
          groups.push({ type: t, names: a.pos.slice(1) });
        }
      }
      if (!allNs && groups.some(g => g.type.ns) && !c.nsExists(ns)) { E(`Error from server (NotFound): namespaces "${ns}" not found`); return r(); }
      const prefix = groups.length > 1 || a.pos[0] === 'all';
      for (const g of groups) {
        const k = g.type.key;
        this.fact('get:' + k);
        this.fact(`get:${k}:in:${allNs ? '*' : ns}`);
        if (fmt === 'wide') this.fact(`get:${k}:wide`);
        if (fmt === 'yaml' || fmt === 'json') this.fact(`get:${k}:${fmt}`);
        if (a.flags['show-labels']) this.fact(`get:${k}:show-labels`);
        if (allNs) this.fact(`get:${k}:all-ns`);
        if (sel) this.fact(`get:${k}:selector`);
        if (fs) this.fact(`get:${k}:field-selector`);
        g.names.forEach(n => { this.fact(`get:${k}:${n}`); if (fmt === 'yaml' || fmt === 'json') this.fact(`get:${k}:${n}:${fmt}`); });
      }
      if (a.flags.watch && last) {
        const g = groups[0];
        if (groups.length > 1 || g.type.kind !== 'Pod') { E('error: watch is only supported on pods in this simulator'); return r(); }
        this.fact('get:pods:watch');
        return this.watchPods(g, ns, allNs, sel, o, r);
      }
      let printed = 0, docs = [], missingAny = false;
      groups.forEach(g => {
        let res = this.collect(g.type, ns, allNs || !g.type.ns, g.names, sel, fs);
        if (g.type.kind === 'Event' && a.flags['sort-by']) res.objs.sort((x, y) => x.last - y.last);
        if (res.missing.length) missingAny = true;
        res.missing.forEach(n => E(`Error from server (NotFound): ${M.PLURAL[g.type.kind] || g.type.key} "${n}" not found`));
        if (!res.objs.length) return;
        if (g.type.kind === 'Pod') res.objs.forEach(p => { this.fact(`saw:pod:${c.workloadOf(p)}:${podStatus(p)}`); });
        if (fmt === 'yaml' || fmt === 'json' || (fmt && /^(jsonpath|custom-columns)/.test(fmt))) {
          res.objs.forEach(x => docs.push(x.eventRow ? { apiVersion: 'v1', kind: 'Event', metadata: { name: x.name, namespace: x.namespace }, involvedObject: { kind: x.kind, name: x.name }, reason: x.reason, message: x.message, type: x.type, count: x.count }
            : x.kind === 'Endpoints' ? { apiVersion: 'v1', kind: 'Endpoints', metadata: { name: x.name, namespace: x.namespace }, subsets: [{ addresses: this.endpointList(x.svc).map(e => ({ ip: e.split(':')[0] })), notReadyAddresses: c.notReadyFor(x.svc).map(p => ({ ip: p.ip })) }] }
            : M.toManifest(c, x, false)));
          return;
        }
        if (fmt === 'name') { res.objs.forEach(x => o(`${M.RES[x.kind] || g.type.kind.toLowerCase()}/${x.name}`)); printed++; return; }
        if (printed) o('');
        o(this.rowsFor(g.type, res.objs, { wide: fmt === 'wide', allNs: allNs && g.type.ns, showLabels: !!a.flags['show-labels'], prefix: prefix ? (M.RES[g.type.kind] || g.type.kind.toLowerCase()) : null }));
        printed++;
        if (g.type.kind === 'Endpoints') o('Warning: v1 Endpoints is deprecated in v1.33+; use discovery.k8s.io/v1 EndpointSlice', 'warn');
      });
      if (docs.length) {
        const one = docs.length === 1 && groups.length === 1 && groups[0].names.length === 1;
        const val = one ? docs[0] : { apiVersion: 'v1', items: docs, kind: 'List', metadata: { resourceVersion: '' } };
        if (fmt === 'yaml') o(K.yaml.dump(val, { sortKeys: true }).replace(/\n$/, ''));
        else if (fmt === 'json') o(JSON.stringify(val, null, 4));
        else if (/^custom-columns/.test(fmt)) {
          const cols = fmt.replace(/^custom-columns=/, '').split(',').map(x => x.split(':'));
          const pick = (obj, p) => p.replace(/^\./, '').split(/\.|\[(\d+|\*)\]/).filter(Boolean).reduce((x, k) => (x == null ? undefined : k === '*' ? x : x[k]), obj);
          o(table(cols.map(cc => cc[0]), docs.map(d0 => cols.map(cc => { const v = pick(d0, cc[1] || ''); return v == null ? '<none>' : typeof v === 'object' ? JSON.stringify(v) : String(v); }))));
        } else {
          const path = fmt.replace(/^jsonpath=/, '').replace(/^'|'$/g, '').replace(/^\{|\}$/g, '').replace(/^\./, '');
          const pick = (obj, p) => p.split(/\.|\[(\d+|\*)\]/).filter(Boolean).reduce((x, k) => (x == null ? undefined : k === '*' ? x : x[k]), obj);
          const v = one ? pick(val, path) : docs.map(d0 => { const x = pick(d0, path.replace(/^items\[\*\]\./, '')); return typeof x === 'object' ? JSON.stringify(x) : x; }).join(' ');
          o(v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
        }
        printed++;
      }
      if (!printed && !missingAny) o(allNs || !groups.some(g => g.type.ns) ? 'No resources found' : `No resources found in ${ns} namespace.`, 'dim');
      return r();
    }
    watchPods(g, ns, allNs, sel, o, r) {
      const self = this;
      const snap = () => { const m = {}; self.collect(g.type, ns, allNs, [], sel).objs.forEach(p => { m[p.name] = podStatus(p) + '|' + p.ready + '|' + p.restarts; }); return m; };
      const res = this.collect(g.type, ns, allNs, g.names, sel);
      if (res.objs.length) o(this.rowsFor(g.type, res.objs, { allNs })); else o(`No resources found in ${ns} namespace.`, 'dim');
      let prev = snap(), ticks = 0;
      return r({ stream: {
        label: 'kubectl get pods -w',
        tick() {
          ticks++;
          const cur = snap(), lines = [];
          for (const p of self.collect(g.type, ns, allNs, [], sel).objs) if (prev[p.name] !== cur[p.name]) lines.push({ t: self.rowsFor(g.type, [p], { allNs }).split('\n')[1], c: '' });
          prev = cur;
          return { lines, done: ticks > 150 };
        },
      } });
    }

    /* ---------- describe ---------- */
    eventsBlock(kind, ns, name) {
      const c = this.c;
      const evs = c.eventsFor(kind, ns, name).slice(-14);
      if (!evs.length) return 'Events:  <none>';
      const rows = evs.map(e => ['  ' + e.type, e.reason, e.count > 1 ? `${human(c.now - e.last)} (x${e.count} over ${human(c.now - e.first)})` : human(c.now - e.last), e.source, e.message]);
      return 'Events:\n' + table(['  Type', 'Reason', 'Age', 'From', 'Message'], [['  ----', '------', '----', '----', '-------']].concat(rows));
    }
    describe(a, ns, o, r, target, badType) {
      const c = this.c, E = m => o(m, 'err');
      const tg = target(a.pos, 0);
      if (!tg) { E('You must specify the type of resource to describe. Use "kubectl api-resources" for a complete list of supported resources.'); return r(); }
      if (!tg.type) return badType(tg.tw);
      if (tg.type.ns && !c.nsExists(ns)) { E(`Error from server (NotFound): namespaces "${ns}" not found`); return r(); }
      let objs;
      if (tg.name) {
        const x = this.findObj(tg.type, ns, tg.name);
        objs = x ? [x] : this.collect(tg.type, ns, !tg.type.ns, [], null).objs.filter(q => q.name.startsWith(tg.name));
        if (!objs.length) { E(`Error from server (NotFound): ${M.PLURAL[tg.type.kind] || tg.type.key} "${tg.name}" not found`); return r(); }
      } else objs = this.collect(tg.type, ns, !tg.type.ns, [], typeof a.flags.selector === 'string' ? a.flags.selector : null).objs;
      if (!objs.length) { o(`No resources found in ${ns} namespace.`, 'dim'); return r(); }
      this.fact('describe:' + tg.type.key);
      objs.slice(0, 12).forEach((x, i) => {
        if (i) o('\n');
        this.fact(`describe:${tg.type.key}:${x.name}`);
        if (x.kind === 'Pod') { this.fact('describe:pod-status:' + podStatus(x)); this.fact('describe:pod-of:' + c.workloadOf(x)); if (x.lastState) this.fact('describe:last-state:' + x.lastState.reason); }
        if (x.kind === 'Endpoints') { o(this.describeOne(x.svc)); return; }
        o(this.describeOne(x));
      });
      return r();
    }
    describeContainers(L, cts, pod, init) {
      const c = this.c;
      cts.forEach((ct, idx) => {
        L.push(`  ${ct.name}:`);
        if (pod && pod.node) L.push(`    Container ID:   containerd://${K.sim.fnv1a(pod.uid + ct.name).toString(16)}${K.sim.fnv1a(ct.name + pod.uid).toString(16)}`);
        L.push(`    Image:          ${ct.image}`);
        if (ct.ports && ct.ports.length) L.push(`    Port:           ${ct.ports.map(p => p.containerPort + '/' + (p.protocol || 'TCP') + (p.name ? ` (${p.name})` : '')).join(', ')}`);
        else L.push('    Port:           <none>');
        L.push('    Host Port:      ' + (ct.ports && ct.ports.length ? '0/TCP' : '<none>'));
        if (ct.command) L.push(`    Command:\n${ct.command.map(x => '      ' + x).join('\n')}`);
        if (ct.args) L.push(`    Args:\n${ct.args.map(x => '      ' + x).join('\n')}`);
        if (pod) {
          if (init) {
            const doneI = idx < pod.init || pod.phase === 'Running' || /PodInitializing|CrashLoop|Error|OOMKilled/.test(pod.phase);
            if (doneI) { L.push('    State:          Terminated'); L.push('      Reason:       Completed'); L.push('      Exit Code:    0'); L.push('    Ready:          True'); }
            else if (idx === pod.init && /^Init:/.test(pod.phase)) { L.push('    State:          Running'); L.push(`      Started:      ${c.ts(pod.created)}`); L.push('    Ready:          False'); }
            else { L.push('    State:          Waiting'); L.push('      Reason:       PodInitializing'); L.push('    Ready:          False'); }
            L.push('    Restart Count:  0');
          } else if (idx === 0) {
            const st = podStatus(pod);
            if (pod.status === 'Failed') { L.push('    State:          Terminated'); L.push(`      Reason:       ${pod.reason === 'Evicted' ? 'ContainerStatusUnknown' : 'Error'}`); L.push('      Exit Code:    137'); }
            else if (st === 'Running') { L.push('    State:          Running'); L.push(`      Started:      ${c.ts(pod.startedAt || pod.created)}`); }
            else if (['Completed', 'Error', 'OOMKilled'].includes(st) && pod.lastState) { L.push('    State:          Terminated'); L.push(`      Reason:       ${pod.lastState.reason}`); L.push(`      Exit Code:    ${pod.lastState.exitCode}`); L.push(`      Started:      ${c.ts(pod.lastState.startedAt)}`); L.push(`      Finished:     ${c.ts(pod.lastState.finishedAt)}`); }
            else { L.push('    State:          Waiting'); L.push(`      Reason:       ${st === 'Unknown' ? 'NodeLost' : /^Init:|PodInitializing|Pending/.test(st) ? 'PodInitializing' : st}`); }
            if (pod.lastState && pod.restarts) {
              L.push('    Last State:     Terminated'); L.push(`      Reason:       ${pod.lastState.reason}`); L.push(`      Exit Code:    ${pod.lastState.exitCode}`);
              L.push(`      Started:      ${c.ts(pod.lastState.startedAt)}`); L.push(`      Finished:     ${c.ts(pod.lastState.finishedAt)}`);
            }
            L.push(`    Ready:          ${pod.ready ? 'True' : 'False'}`);
            L.push(`    Restart Count:  ${pod.restarts}`);
          } else {
            L.push(`    State:          ${pod.phase === 'Running' ? 'Running' : 'Waiting'}`); L.push(`    Ready:          ${pod.phase === 'Running' ? 'True' : 'False'}`); L.push('    Restart Count:  0');
          }
        }
        const res = ct.resources || {};
        ['limits', 'requests'].forEach(k => { if (res[k] && Object.keys(res[k]).length) { L.push(`    ${k[0].toUpperCase() + k.slice(1)}:`); Object.keys(res[k]).forEach(x => L.push(`      ${(x + ':').padEnd(9)} ${res[k][x]}`)); } });
        if (ct.livenessProbe) L.push(`    Liveness:       ${probeStr(ct.livenessProbe)}`);
        if (ct.readinessProbe) L.push(`    Readiness:      ${probeStr(ct.readinessProbe)}`);
        if (ct.startupProbe) L.push(`    Startup:        ${probeStr(ct.startupProbe)}`);
        const env = (ct.env || []).map(e => `      ${e.name}:  ${e.valueFrom ? (e.valueFrom.secretKeyRef ? `<set to the key '${e.valueFrom.secretKeyRef.key}' in secret '${e.valueFrom.secretKeyRef.name}'>  Optional: false` : e.valueFrom.configMapKeyRef ? `<set to the key '${e.valueFrom.configMapKeyRef.key}' of config map '${e.valueFrom.configMapKeyRef.name}'>  Optional: false` : `(v1:${(e.valueFrom.fieldRef || {}).fieldPath})`) : e.value}`);
        const ef = (ct.envFrom || []).map(e => `      ${e.configMapRef ? e.configMapRef.name + '  ConfigMap' : e.secretRef.name + '  Secret'}  Optional: ${!!(e.configMapRef || e.secretRef).optional}`);
        if (ef.length) { L.push('    Environment Variables from:'); ef.forEach(l => L.push(l)); }
        if (env.length) { L.push('    Environment:'); env.forEach(l => L.push(l)); } else L.push('    Environment:    <none>');
        const mounts = (ct.volumeMounts || []).map(m => `      ${m.mountPath} from ${m.name} (${m.readOnly ? 'ro' : 'rw'})`);
        L.push('    Mounts:'); mounts.forEach(l => L.push(l));
        L.push(`      /var/run/secrets/kubernetes.io/serviceaccount from kube-api-access-${(pod ? pod.uid : 'xxxxx').slice(0, 5)} (ro)`);
      });
    }
    volumesBlock(L, spec) {
      L.push('Volumes:');
      (spec.volumes || []).forEach(v => {
        L.push(`  ${v.name}:`);
        if (v.persistentVolumeClaim) { L.push('    Type:       PersistentVolumeClaim (a reference to a PersistentVolumeClaim in the same namespace)'); L.push(`    ClaimName:  ${v.persistentVolumeClaim.claimName}`); L.push(`    ReadOnly:   ${!!v.persistentVolumeClaim.readOnly}`); }
        else if (v.configMap) { L.push('    Type:      ConfigMap (a volume populated by a ConfigMap)'); L.push(`    Name:      ${v.configMap.name}`); L.push(`    Optional:  ${!!v.configMap.optional}`); }
        else if (v.secret) { L.push('    Type:        Secret (a volume populated by a Secret)'); L.push(`    SecretName:  ${v.secret.secretName}`); L.push(`    Optional:    ${!!v.secret.optional}`); }
        else if (v.emptyDir) { L.push('    Type:       EmptyDir (a temporary directory that shares a pod\'s lifetime)'); L.push('    Medium:'); L.push(`    SizeLimit:  ${(v.emptyDir && v.emptyDir.sizeLimit) || '<unset>'}`); }
        else L.push(`    Type:  ${Object.keys(v).filter(k => k !== 'name')[0]}`);
      });
      L.push('  kube-api-access:\n    Type:                    Projected (a volume that contains injected data from multiple sources)\n    TokenExpirationSeconds:  3607');
    }
    describeOne(x) {
      const c = this.c, L = [];
      const kv = (k, v, w) => L.push((k + ':').padEnd(w || 18) + (v == null || v === '' ? '<none>' : v));
      const labels = (k, l, w) => { const s = l && Object.keys(l).length ? Object.keys(l).sort().map(q => q + '=' + l[q]) : ['<none>']; kv(k, s[0], w); s.slice(1).forEach(q => L.push(''.padEnd(w || 18) + q)); };
      const tols = t => (t || []).map(x => `${x.key || ''}${x.operator === 'Exists' ? '' : '=' + (x.value || '')}${x.effect ? ':' + x.effect : ''}${x.operator === 'Exists' ? ' op=Exists' : ''}`).join('\n                             ') || '<none>';
      switch (x.kind) {
        case 'Pod': {
          const st = podStatus(x);
          kv('Name', x.name, 29); kv('Namespace', x.namespace, 29); kv('Priority', '0', 29); kv('Service Account', x.spec.serviceAccountName || 'default', 29);
          kv('Node', x.node ? `${x.node}/${c.node(x.node) ? c.node(x.node).ip : ''}` : '<none>', 29); kv('Start Time', x.node ? c.ts(x.created) : '<none>', 29);
          labels('Labels', x.labels, 29); kv('Annotations', Object.keys(x.annotations || {}).map(k => `${k}: ${x.annotations[k]}`).join('\n' + ''.padEnd(29)) || '<none>', 29);
          kv('Status', x.deleting ? 'Terminating (lasts 30s)' : x.status === 'Failed' ? 'Failed' : x.status === 'Succeeded' ? 'Succeeded' : !x.node || /ContainerCreating|Pending|Init:|PodInitializing|ErrImagePull|ImagePullBackOff|InvalidImageName|CreateContainerConfigError/.test(x.phase) ? 'Pending' : 'Running', 29);
          if (x.reason) kv('Reason', x.reason, 29);
          if (x.message) kv('Message', x.message, 29);
          kv('IP', x.ip, 29); kv('IPs', x.ip ? '\n  IP:  ' + x.ip : '<none>', 29);
          if (x.owner) kv('Controlled By', `${x.owner.kind}/${x.owner.name}`, 29);
          if ((x.spec.initContainers || []).length) { L.push('Init Containers:'); this.describeContainers(L, x.spec.initContainers, x, true); }
          L.push('Containers:'); this.describeContainers(L, x.spec.containers, x, false);
          L.push('Conditions:'); L.push('  Type                        Status');
          [['PodReadyToStartContainers', !!x.node && x.phase !== 'Pending'], ['Initialized', !!x.node && !/^Init:/.test(x.phase)], ['Ready', x.ready], ['ContainersReady', x.ready], ['PodScheduled', !!x.node]].forEach(([t, s]) => L.push('  ' + t.padEnd(28) + (s ? 'True' : 'False')));
          this.volumesBlock(L, x.spec);
          kv('QoS Class', x.qos, 29);
          kv('Node-Selectors', labelStr(x.spec.nodeSelector), 29);
          kv('Tolerations', ((x.spec.tolerations || []).length ? tols(x.spec.tolerations) + '\n                             ' : '') + 'node.kubernetes.io/not-ready:NoExecute op=Exists for 300s\n                             node.kubernetes.io/unreachable:NoExecute op=Exists for 300s', 29);
          L.push(this.eventsBlock('Pod', x.namespace, x.name));
          void st;
          break;
        }
        case 'Deployment': {
          const s = c.deploymentStatus(x), rs = c.rsOf(x), cur = c.newRSOf(x);
          kv('Name', x.name, 24); kv('Namespace', x.namespace, 24); kv('CreationTimestamp', c.ts(x.created), 24);
          labels('Labels', x.labels, 24); kv('Annotations', `deployment.kubernetes.io/revision: ${x.revision || 1}`, 24);
          kv('Selector', labelStr(x.selector), 24);
          kv('Replicas', `${x.replicas} desired | ${s.updated} updated | ${s.replicas} total | ${s.available} available | ${s.unavailable} unavailable`, 24);
          kv('StrategyType', x.strategy.type, 24); kv('MinReadySeconds', '0', 24);
          if (x.strategy.type === 'RollingUpdate') kv('RollingUpdateStrategy', `${x.strategy.rollingUpdate.maxUnavailable} max unavailable, ${x.strategy.rollingUpdate.maxSurge} max surge`, 24);
          L.push('Pod Template:'); labels('  Labels', x.template.labels, 18);
          if (x.template.annotations && Object.keys(x.template.annotations).length) kv('  Annotations', Object.keys(x.template.annotations).map(k => `${k}: ${x.template.annotations[k]}`).join('\n                  '), 18);
          kv('  Service Account', x.template.spec.serviceAccountName || 'default', 18);
          if ((x.template.spec.initContainers || []).length) { L.push('  Init Containers:'); this.describeContainers(L, x.template.spec.initContainers, null, true); }
          L.push('  Containers:'); this.describeContainers(L, x.template.spec.containers, null, false);
          if ((x.template.spec.volumes || []).length) { const VL = []; this.volumesBlock(VL, x.template.spec); VL.slice(0, -1).forEach(l => L.push('  ' + l)); }
          kv('  Node-Selectors', labelStr(x.template.spec.nodeSelector), 18); kv('  Tolerations', tols(x.template.spec.tolerations), 18);
          L.push('Conditions:'); L.push('  Type             Status  Reason'); L.push('  ----             ------  ------');
          const avOk = s.available >= x.replicas - Math.floor(x.replicas * 0.25);
          L.push(`  Available        ${avOk ? 'True ' : 'False'}   ${avOk ? 'MinimumReplicasAvailable' : 'MinimumReplicasUnavailable'}`);
          L.push(`  Progressing      ${x.deadlineExceeded ? 'False' : 'True '}   ${x.deadlineExceeded ? 'ProgressDeadlineExceeded' : c.rolloutComplete(x) ? 'NewReplicaSetAvailable' : 'ReplicaSetUpdated'}`);
          if (rs.some(q => q.failedCreate)) L.push('  ReplicaFailure   True    FailedCreate');
          const olds = rs.filter(q => q !== cur && c.podsOfRS(q).length);
          kv('OldReplicaSets', olds.length ? olds.map(q => `${q.name} (${c.podsOfRS(q).length}/${q.replicas} replicas created)`).join(', ') : '<none>', 17);
          kv('NewReplicaSet', cur ? `${cur.name} (${c.podsOfRS(cur).length}/${cur.replicas} replicas created)` : '<none>', 17);
          L.push(this.eventsBlock('Deployment', x.namespace, x.name));
          break;
        }
        case 'ReplicaSet': {
          const pods = c.podsOfRS(x);
          kv('Name', x.name, 14); kv('Namespace', x.namespace, 14); kv('Selector', labelStr(x.selector), 14); labels('Labels', x.labels, 14);
          kv('Annotations', `deployment.kubernetes.io/revision: ${x.revision}`, 14); kv('Controlled By', 'Deployment/' + x.owner, 14);
          kv('Replicas', `${pods.length} current / ${x.replicas} desired`, 14);
          const bad = pods.filter(p => /Error|BackOff|Err|OOM/.test(p.phase)).length;
          kv('Pods Status', `${pods.filter(p => p.phase === 'Running').length} Running / ${pods.length - pods.filter(p => p.phase === 'Running').length - bad} Waiting / 0 Succeeded / ${bad} Failed`, 14);
          L.push('Pod Template:'); labels('  Labels', x.template.labels, 11); L.push('  Containers:'); this.describeContainers(L, x.template.spec.containers, null, false);
          if (x.failedCreate) { L.push('Conditions:'); L.push('  Type             Status  Reason'); L.push('  ----             ------  ------'); L.push('  ReplicaFailure   True    FailedCreate'); }
          L.push(this.eventsBlock('ReplicaSet', x.namespace, x.name));
          break;
        }
        case 'Service': {
          kv('Name', x.name, 26); kv('Namespace', x.namespace, 26); labels('Labels', x.labels, 26); kv('Annotations', '<none>', 26);
          kv('Selector', x.selector ? labelStr(x.selector) : '<none>', 26); kv('Type', x.type, 26); kv('IP Family Policy', 'SingleStack', 26); kv('IP Families', 'IPv4', 26);
          kv('IP', x.clusterIP, 26); kv('IPs', x.clusterIP, 26);
          if (x.externalIP) kv('LoadBalancer Ingress', x.externalIP, 26);
          x.ports.forEach(p => {
            kv('Port', `${p.name || '<unset>'}  ${p.port}/${p.protocol}`, 26); kv('TargetPort', `${p.targetPort}/${p.protocol}`, 26);
            if (p.nodePort) kv('NodePort', `${p.name || '<unset>'}  ${p.nodePort}/${p.protocol}`, 26);
            const eps = c.endpointsFor(x, p).map(q => q.ip + ':' + c.targetPortOf(q, p));
            kv('Endpoints', x.staticEndpoints ? x.staticEndpoints.join(',') : eps.length ? eps.join(',') : '', 26);
          });
          kv('Session Affinity', 'None', 26); kv('Internal Traffic Policy', 'Cluster', 26);
          L.push(this.eventsBlock('Service', x.namespace, x.name));
          break;
        }
        case 'Node': {
          const pods = c.list('Pod').filter(p => p.node === x.name && !p.deleting && p.status !== 'Failed');
          const al = c.nodeAllocated(x);
          kv('Name', x.name, 20); kv('Roles', '<none>', 20); labels('Labels', x.labels, 20);
          const taints = (x.taints || []).map(t => `${t.key}${t.value ? '=' + t.value : ''}:${t.effect}`);
          if (!x.ready) taints.push('node.kubernetes.io/unreachable:NoExecute', 'node.kubernetes.io/unreachable:NoSchedule');
          if (x.unschedulable) taints.push('node.kubernetes.io/unschedulable:NoSchedule');
          if (x.memPressure) taints.push('node.kubernetes.io/memory-pressure:NoSchedule');
          kv('Taints', taints.join('\n' + ''.padEnd(20)) || '<none>', 20);
          kv('Unschedulable', String(!!x.unschedulable), 20);
          L.push('Conditions:'); L.push('  Type             Status   Reason                       Message');
          L.push('  ----             ------   ------                       -------');
          if (x.ready) {
            L.push(x.memPressure ? '  MemoryPressure   True     KubeletHasInsufficientMemory kubelet has insufficient memory available' : '  MemoryPressure   False    KubeletHasSufficientMemory   kubelet has sufficient memory available');
            L.push('  DiskPressure     False    KubeletHasNoDiskPressure     kubelet has no disk pressure');
            L.push('  PIDPressure      False    KubeletHasSufficientPID      kubelet has sufficient PID available');
            L.push('  Ready            True     KubeletReady                 kubelet is posting ready status');
          } else ['MemoryPressure', 'DiskPressure', 'PIDPressure', 'Ready'].forEach(t => L.push(`  ${t.padEnd(17)}Unknown  NodeStatusUnknown            Kubelet stopped posting node status.`));
          L.push('Addresses:'); L.push(`  InternalIP:  ${x.ip}`); L.push(`  Hostname:    ${x.name}`);
          L.push('Capacity:'); L.push(`  cpu:     ${fmtCpu(x.cpuM)}`); L.push(`  memory:  ${fmtMem(x.memMi)}`); L.push(`  pods:    ${x.maxPods}`);
          L.push('Allocatable:'); L.push(`  cpu:     ${fmtCpu(x.allocCpu)}`); L.push(`  memory:  ${fmtMem(x.allocMem)}`); L.push(`  pods:    ${x.maxPods}`);
          L.push(`Non-terminated Pods:          (${pods.length} in total)`);
          if (pods.length) L.push(table(['  Namespace', 'Name', 'CPU Requests', 'CPU Limits', 'Memory Requests', 'Memory Limits', 'Age'], [['  ---------', '----', '------------', '----------', '---------------', '-------------', '---']].concat(pods.map(p => {
            const rq = podRequests(p.spec), pct = (v, t) => `${Math.round((v / t) * 100)}%`;
            return ['  ' + p.namespace, p.name, `${fmtCpu(rq.cpu)} (${pct(rq.cpu, x.cpuM)})`, `${fmtCpu(rq.lcpu)} (${pct(rq.lcpu, x.cpuM)})`, `${fmtMem(rq.mem)} (${pct(rq.mem, x.memMi)})`, `${fmtMem(rq.lmem)} (${pct(rq.lmem, x.memMi)})`, human(c.now - p.created)];
          }))));
          const lim = pods.reduce((s, p) => { const q = podRequests(p.spec); s.cpu += q.lcpu; s.mem += q.lmem; return s; }, { cpu: 0, mem: 0 });
          L.push('Allocated resources:'); L.push('  (Total limits may be over 100 percent, i.e., overcommitted.)');
          L.push(table(['  Resource', 'Requests', 'Limits'], [['  --------', '--------', '------'], ['  cpu', `${fmtCpu(al.cpu)} (${Math.round(al.cpu / x.allocCpu * 100)}%)`, `${fmtCpu(lim.cpu)} (${Math.round(lim.cpu / x.cpuM * 100)}%)`], ['  memory', `${fmtMem(al.mem)} (${Math.round(al.mem / x.allocMem * 100)}%)`, `${fmtMem(lim.mem)} (${Math.round(lim.mem / x.memMi * 100)}%)`]]));
          L.push(this.eventsBlock('Node', 'default', x.name));
          break;
        }
        case 'ConfigMap': case 'Secret': {
          kv('Name', x.name, 14); kv('Namespace', x.namespace, 14); labels('Labels', x.labels, 14); kv('Annotations', '<none>', 14);
          if (x.kind === 'Secret') { L.push(''); kv('Type', x.type || 'Opaque', 6); L.push('', 'Data', '===='); Object.keys(x.data).forEach(k => L.push(`${k}:  ${x.data[k].length} bytes`)); }
          else { L.push('', 'Data', '===='); Object.keys(x.data).forEach(k => L.push(k + ':', '----', x.data[k], '')); L.push('BinaryData', '====', '', 'Events:  <none>'); }
          break;
        }
        case 'Namespace': {
          kv('Name', x.name, 8); labels('Labels', x.labels, 8); kv('Annotations', '<none>', 8); kv('Status', x.phase, 8);
          const qs = c.list('ResourceQuota', x.name);
          if (!qs.length) L.push('', 'No resource quota.');
          qs.forEach(q => { L.push('', 'Resource Quotas'); L.push(`  Name:    ${q.name}`); this.quotaTable(L, q, '  '); });
          L.push('', 'No LimitRange resource.');
          break;
        }
        case 'ResourceQuota': kv('Name', x.name, 11); kv('Namespace', x.namespace, 11); this.quotaTable(L, x, ''); break;
        case 'HorizontalPodAutoscaler': {
          const d = c.get('Deployment', x.namespace, x.target.name);
          kv('Name', x.name, 52); kv('Namespace', x.namespace, 52); kv('Reference', 'Deployment/' + x.target.name, 52);
          L.push('Metrics:                                             ( current / target )');
          L.push(`  resource cpu on pods  (as a percentage of request):  ${x.current == null ? '<unknown>' : x.current + '%'} / ${x.targetCPU}%`);
          kv('Min replicas', x.min, 52); kv('Max replicas', x.max, 52); kv('Deployment pods', d ? `${c.deploymentStatus(d).replicas} current / ${d.replicas} desired` : '0 current / 0 desired', 52);
          L.push('Conditions:'); L.push('  Type            Status  Reason                   Message'); L.push('  ----            ------  ------                   -------');
          L.push('  AbleToScale     True    SucceededGetScale        the HPA controller was able to get the target\'s current scale');
          L.push(x.problem ? `  ScalingActive   False   FailedGetResourceMetric  the HPA was unable to compute the replica count: ${x.problem}` : '  ScalingActive   True    ValidMetricFound         the HPA was able to successfully calculate a replica count from cpu resource utilization (percentage of request)');
          L.push(this.eventsBlock('HorizontalPodAutoscaler', x.namespace, x.name));
          break;
        }
        case 'Ingress': {
          kv('Name', x.name, 18); labels('Labels', x.labels, 18); kv('Namespace', x.namespace, 18); kv('Address', 'a1b2c3d4e5-1234567890.eu-west-1.elb.amazonaws.com', 18); kv('Ingress Class', x.ingressClassName || '<none>', 18); kv('Default backend', '<default>', 18);
          L.push('Rules:'); L.push('  Host                 Path  Backends'); L.push('  ----                 ----  --------');
          x.rules.forEach(rl => {
            L.push(`  ${rl.host || '*'}`);
            rl.paths.forEach(p => {
              const svc = c.get('Service', x.namespace, p.backend.name);
              const sp = svc && svc.ports.find(q => (p.backend.portName ? q.name === p.backend.portName : q.port === p.backend.port));
              const eps = sp ? c.endpointsFor(svc, sp).map(q => q.ip + ':' + c.targetPortOf(q, sp)) : [];
              L.push(`                       ${p.path}   ${p.backend.name}:${p.backend.portName || p.backend.port} (${!svc ? `<error: services "${p.backend.name}" not found>` : !sp ? `<error: service port ${p.backend.portName || p.backend.port} not found>` : eps.length ? eps.join(',') : '<none>'})`);
            });
          });
          kv('Annotations', Object.keys(x.annotations || {}).map(k => `${k}: ${x.annotations[k]}`).join('\n' + ''.padEnd(18)) || '<none>', 18);
          L.push('Events:  <none>');
          break;
        }
        case 'NetworkPolicy': {
          kv('Name', x.name, 14); kv('Namespace', x.namespace, 14); kv('Created on', c.ts(x.created), 14); labels('Labels', x.labels, 14); kv('Annotations', '<none>', 14);
          L.push('Spec:');
          L.push(`  PodSelector:     ${Object.keys((x.podSelector || {}).matchLabels || {}).length ? labelStr(x.podSelector.matchLabels) : '<none> (Allowing the specific traffic to all pods in this namespace)'}`);
          const peer = p => [p.namespaceSelector ? `NamespaceSelector: ${labelStr((p.namespaceSelector || {}).matchLabels).replace('<none>', '<none>')}` : null, p.podSelector ? `PodSelector: ${labelStr((p.podSelector || {}).matchLabels)}` : null, p.ipBlock ? `IPBlock:\n        CIDR: ${p.ipBlock.cidr}\n        Except: ${(p.ipBlock.except || []).join(', ')}` : null].filter(Boolean).join('\n      ');
          const portsS = ps => (ps && ps.length ? ps.map(p => `${p.port == null ? '<any>' : p.port}/${p.protocol || 'TCP'}`).join(', ') : '<any> (traffic allowed to all ports)');
          if (x.policyTypes.includes('Ingress')) {
            L.push('  Allowing ingress traffic:');
            if (!x.ingress || !x.ingress.length) L.push('    <none> (Selected pods are isolated for ingress connectivity)');
            (x.ingress || []).forEach((rl, i) => { if (i) L.push('    ----------'); L.push(`    To Port: ${portsS(rl.ports)}`); L.push('    From:'); if (!rl.from || !rl.from.length) L.push('      <any> (traffic not restricted by source)'); else rl.from.forEach(p => L.push('      ' + peer(p))); });
          } else L.push('  Not affecting ingress traffic');
          if (x.policyTypes.includes('Egress')) {
            L.push('  Allowing egress traffic:');
            if (!x.egress || !x.egress.length) L.push('    <none> (Selected pods are isolated for egress connectivity)');
            (x.egress || []).forEach((rl, i) => { if (i) L.push('    ----------'); L.push(`    To Port: ${portsS(rl.ports)}`); L.push('    To:'); if (!rl.to || !rl.to.length) L.push('      <any> (traffic not restricted by destination)'); else rl.to.forEach(p => L.push('      ' + peer(p))); });
          } else L.push('  Not affecting egress traffic');
          L.push(`  Policy Types: ${x.policyTypes.join(', ')}`);
          break;
        }
        case 'ServiceAccount':
          kv('Name', x.name, 20); kv('Namespace', x.namespace, 20); labels('Labels', x.labels, 20); kv('Annotations', '<none>', 20); kv('Image pull secrets', '<none>', 20); kv('Mountable secrets', '<none>', 20); kv('Tokens', '<none>', 20); L.push('Events:              <none>');
          break;
        case 'Role': case 'ClusterRole':
          kv('Name', x.name, 13); labels('Labels', x.labels, 13); kv('Annotations', '<none>', 13);
          L.push('PolicyRule:');
          L.push(table(['  Resources', 'Non-Resource URLs', 'Resource Names', 'Verbs'], [['  ---------', '-----------------', '--------------', '-----']].concat((x.rules || []).map(rl => ['  ' + rl.resources.map(rs => rs + (rl.apiGroups && rl.apiGroups[0] ? '.' + rl.apiGroups[0] : '')).join(', '), '[]', `[${(rl.resourceNames || []).join(' ')}]`, `[${rl.verbs.join(' ')}]`]))));
          break;
        case 'RoleBinding': case 'ClusterRoleBinding':
          kv('Name', x.name, 13); labels('Labels', x.labels, 13); kv('Annotations', '<none>', 13);
          L.push('Role:'); L.push(`  Kind:  ${x.roleRef.kind}`); L.push(`  Name:  ${x.roleRef.name}`);
          L.push('Subjects:'); L.push(table(['  Kind', 'Name', 'Namespace'], [['  ----', '----', '---------']].concat(x.subjects.map(s => ['  ' + s.kind, s.name, s.namespace || '']))));
          break;
        case 'PersistentVolumeClaim': {
          kv('Name', x.name, 15); kv('Namespace', x.namespace, 15); kv('StorageClass', x.spec.storageClassName || x.storageClassResolved || '', 15);
          kv('Status', x.terminating ? 'Terminating (lasts 41s)' : x.phase, 15); kv('Volume', x.volumeName || '', 15); labels('Labels', x.labels, 15);
          kv('Annotations', x.phase === 'Bound' ? 'pv.kubernetes.io/bind-completed: yes\n               volume.kubernetes.io/storage-provisioner: ebs.csi.aws.com' : '<none>', 15);
          kv('Finalizers', '[kubernetes.io/pvc-protection]', 15);
          kv('Capacity', x.phase === 'Bound' ? fmtMem(x.capacityMi) : '', 15); kv('Access Modes', x.phase === 'Bound' ? x.spec.accessModes.map(m => ({ ReadWriteOnce: 'RWO', ReadWriteMany: 'RWX' }[m] || m)).join(',') : '', 15); kv('VolumeMode', 'Filesystem', 15);
          const users = c.list('Pod', x.namespace).filter(p => c.active(p) && (p.spec.volumes || []).some(v => v.persistentVolumeClaim && v.persistentVolumeClaim.claimName === x.name));
          kv('Used By', users.map(p => p.name).join('\n               ') || '<none>', 15);
          if (x.resizing) { L.push('Conditions:'); L.push('  Type       Status  Message'); L.push('  ----       ------  -------'); L.push('  Resizing   True    '); }
          L.push(this.eventsBlock('PersistentVolumeClaim', x.namespace, x.name));
          break;
        }
        case 'PersistentVolume':
          kv('Name', x.name, 17); kv('StorageClass', x.storageClass, 17); kv('Status', x.status, 17); kv('Claim', `${x.claim.namespace}/${x.claim.name}`, 17); kv('Reclaim Policy', x.reclaimPolicy, 17); kv('Access Modes', 'RWO', 17); kv('Capacity', fmtMem(x.capacityMi), 17);
          L.push('Source:'); L.push('    Type:              CSI (a Container Storage Interface (CSI) volume source)'); L.push('    Driver:            ebs.csi.aws.com'); L.push(`    VolumeHandle:      vol-0${K.sim.fnv1a(x.name).toString(16)}`);
          L.push('Events:            <none>');
          break;
        case 'StorageClass':
          kv('Name', x.name, 22); kv('IsDefaultClass', x.isDefault ? 'Yes' : 'No', 22); kv('Provisioner', x.provisioner, 22); kv('Parameters', Object.keys(x.parameters || {}).map(k => `${k}=${x.parameters[k]}`).join(','), 22);
          kv('AllowVolumeExpansion', x.allowVolumeExpansion ? 'True' : 'False', 22); kv('MountOptions', '<none>', 22); kv('ReclaimPolicy', x.reclaimPolicy, 22); kv('VolumeBindingMode', x.volumeBindingMode, 22); L.push('Events:                <none>');
          break;
        case 'PodDisruptionBudget': {
          const s = c.pdbStatus(x);
          kv('Name', x.name, 16); kv('Namespace', x.namespace, 16);
          if (x.minAvailable != null) kv('Min available', x.minAvailable, 16); else kv('Max unavailable', x.maxUnavailable, 16);
          kv('Selector', labelStr((x.selector || {}).matchLabels), 16);
          L.push('Status:'); L.push(`    Allowed disruptions:  ${s.allowed}`); L.push(`    Current:              ${s.healthy}`); L.push(`    Desired:              ${s.desired}`); L.push(`    Total:                ${s.expected}`);
          L.push(this.eventsBlock('PodDisruptionBudget', x.namespace, x.name));
          break;
        }
        default: L.push(K.yaml.dump(M.toManifest(c, x, false)));
      }
      return L.join('\n');
    }
    quotaTable(L, q, pad) {
      const u = this.c.quotaUsage(q.namespace), f = (k, v) => /cpu/.test(k) ? fmtCpu(v) : /memory/.test(k) ? fmtMem(v) : String(v);
      L.push(table([pad + 'Resource', 'Used', 'Hard'], [[pad + '--------', '----', '----']].concat(Object.keys(q.hard).sort().map(k => [pad + k, f(k, u[k] || 0), q.hard[k]]))));
    }

    /* ---------- logs, top, config ---------- */
    logs(a, ns, o, r) {
      const c = this.c, E = m => o(m, 'err');
      let name = a.pos[0];
      if (!name) { E("error: expected 'logs [-f] [-p] (POD | TYPE/NAME) [-c CONTAINER]'."); return r(); }
      let p = null;
      if (!c.nsExists(ns)) { E(`Error from server (NotFound): namespaces "${ns}" not found`); return r(); }
      if (typeof a.flags.selector === 'string') {
        const f = parseSelector(a.flags.selector); const ps = c.list('Pod', ns).filter(q => f(q.labels) && !q.deleting);
        if (!ps.length) { o('No resources found in ' + ns + ' namespace.', 'dim'); return r(); }
        p = ps[0]; name = p.name;
      } else if (name.includes('/')) {
        const [tw, n] = name.split('/'); const t = typeOf(tw);
        if (t && t.kind === 'Deployment') {
          const d = c.get('Deployment', ns, n);
          if (!d) { E(`error: error from server (NotFound): deployments.apps "${n}" not found in namespace "${ns}"`); return r(); }
          const ps = c.podsOfDeployment(d); p = ps.find(q => q.phase === 'Running') || ps[0];
          if (!p) { E(`error: timed out waiting for the condition`); return r(); }
          o(`Found ${ps.length} pods, using pod/${p.name}`, 'dim');
        } else if (t && t.kind === 'Pod') p = c.get('Pod', ns, n);
        else if (!t) { E(`error: the server doesn't have a resource type "${tw}"`); return r(); }
        name = n;
      } else p = c.get('Pod', ns, name);
      if (!p) { E(`Error from server (NotFound): pods "${name}" not found`); return r(); }
      const cname = typeof a.flags.container === 'string' ? a.flags.container : null;
      const inits = p.spec.initContainers || [];
      const all = inits.concat(p.spec.containers);
      if (!cname && p.spec.containers.length > 1) o(`Defaulted container "${p.spec.containers[0].name}" out of: ${all.map(x => x.name).join(', ')}`, 'dim');
      const ct = cname ? all.find(x => x.name === cname) : p.spec.containers[0];
      if (!ct) { E(`error: container ${cname} is not valid for pod ${p.name}`); return r(); }
      const wl = c.workloadOf(p);
      this.fact('logs'); this.fact('logs:' + wl);
      if (inits.includes(ct)) {
        this.fact('logs-init:' + wl);
        const lines = p.initLogs || [];
        if (lines.length) o(lines.join('\n'));
        return r();
      }
      if (ct !== p.spec.containers[0]) { o('(sidecar is healthy; nothing interesting here)', 'dim'); return r(); }
      if (a.flags.previous) {
        this.fact('logs-prev:' + wl);
        if (!p.restarts) { E(`Error from server (BadRequest): previous terminated container "${ct.name}" in pod "${p.name}" not found`); return r(); }
        o(p.prevLogs.join('\n')); return r();
      }
      if (p.status === 'Failed') { E(`Error from server (BadRequest): container "${ct.name}" in pod "${p.name}" is not available`); return r(); }
      if (!p.node || /^(Pending|ContainerCreating|ErrImagePull|ImagePullBackOff|CreateContainerConfigError|InvalidImageName|PodInitializing)$/.test(p.phase) || /^Init:/.test(p.phase)) {
        const why = { ErrImagePull: 'trying and failing to pull image', ImagePullBackOff: 'trying and failing to pull image', CreateContainerConfigError: 'CreateContainerConfigError', InvalidImageName: 'InvalidImageName' }[p.phase] || (/^Init:/.test(p.phase) ? 'PodInitializing' : 'ContainerCreating');
        E(`Error from server (BadRequest): container "${ct.name}" in pod "${p.name}" is waiting to start: ${why}`); return r();
      }
      let lines = p.logs.slice();
      if (a.flags.tail != null) lines = lines.slice(-Number(a.flags.tail));
      if (lines.length) o(lines.join('\n'));
      if (p.phase === 'CrashLoopBackOff' || p.phase === 'Error' || p.phase === 'OOMKilled') this.fact('logs-crashed:' + wl);
      return r();
    }
    top(a, ns, o, r) {
      const c = this.c, what = typeOf(a.pos[0] || '');
      if (!what || !['Pod', 'Node'].includes(what.kind)) { o('error: usage: kubectl top pods [-n ns] [-A] [--containers] | kubectl top nodes', 'err'); return r(); }
      if (!c.list('Pod', 'kube-system').some(p => /metrics-server/.test(p.name) && p.ready)) { o('error: Metrics API not available', 'err'); return r(); }
      if (what.kind === 'Node') {
        o(table(['NAME', 'CPU(cores)', 'CPU(%)', 'MEMORY(bytes)', 'MEMORY(%)'], c.nodes.map(n => {
          if (!n.ready) return [n.name, '<unknown>', '<unknown>', '<unknown>', '<unknown>'];
          const pods = c.list('Pod').filter(p => p.node === n.name);
          const cpu = 140 + pods.reduce((s, p) => s + c.podCpu(p), 0), mem = K.CONST.SYSTEM_RESERVED_MEM + pods.reduce((s, p) => s + (p.phase === 'Running' ? p.memMi : 0), 0);
          return [n.name, cpu + 'm', Math.round(cpu / n.cpuM * 100) + '%', mem + 'Mi', Math.round(mem / n.memMi * 100) + '%'];
        })));
        this.fact('top:nodes'); return r();
      }
      const allNs = !!a.flags['all-namespaces'];
      let pods = c.list('Pod', allNs ? null : ns).filter(p => p.phase === 'Running' && !p.deleting);
      if (typeof a.flags.selector === 'string') { const f = parseSelector(a.flags.selector); pods = pods.filter(p => f(p.labels)); }
      if (a.pos[1]) pods = pods.filter(p => p.name === a.pos[1]);
      pods.sort((x, y) => (a.flags['sort-by'] === 'memory' ? y.memMi - x.memMi : a.flags['sort-by'] === 'cpu' ? c.podCpu(y) - c.podCpu(x) : x.name < y.name ? -1 : 1));
      if (!pods.length) { o(allNs ? 'No resources found' : `No resources found in ${ns} namespace.`, 'dim'); return r(); }
      const rows = pods.map(p => [p.name].concat(a.flags.containers ? [p.spec.containers[0].name] : []).concat([c.podCpu(p) + 'm', p.memMi + 'Mi']));
      const head = ['NAME'].concat(a.flags.containers ? ['NAME'] : []).concat(['CPU(cores)', 'MEMORY(bytes)']);
      o(table(allNs ? ['NAMESPACE'].concat(head) : head, allNs ? rows.map((x, i) => [pods[i].namespace].concat(x)) : rows));
      this.fact('top:pods'); pods.forEach(p => this.fact('top:pod-of:' + c.workloadOf(p)));
      return r();
    }
    config(a, o, r) {
      const c = this.c, sub = a.pos[0], E = m => o(m, 'err');
      if (sub === 'set-context') {
        if (!a.flags.current && a.pos[1] !== K.CONST.CONTEXT) { E('error: you must specify a context name or --current'); return r(); }
        if (typeof a.flags.namespace === 'string') { c.currentNamespace = a.flags.namespace; this.fact('config:set-namespace:' + a.flags.namespace); }
        o(`Context "${K.CONST.CONTEXT}" modified.`, 'ok'); return r();
      }
      if (sub === 'current-context') { o(K.CONST.CONTEXT); return r(); }
      if (sub === 'get-contexts') { o(table(['CURRENT', 'NAME', 'CLUSTER', 'AUTHINFO', 'NAMESPACE'], [['*', K.CONST.CONTEXT, K.CONST.CONTEXT, 'oncall', c.currentNamespace]])); return r(); }
      if (sub === 'use-context') { if (a.pos[1] === K.CONST.CONTEXT) o(`Switched to context "${K.CONST.CONTEXT}".`, 'ok'); else E(`error: no context exists with the name: "${a.pos[1] || ''}"`); return r(); }
      if (sub === 'view') { o(`apiVersion: v1\nclusters:\n- cluster:\n    server: https://api.stagedoor-prod.internal:6443\n  name: ${K.CONST.CONTEXT}\ncontexts:\n- context:\n    cluster: ${K.CONST.CONTEXT}\n    namespace: ${c.currentNamespace}\n    user: oncall\n  name: ${K.CONST.CONTEXT}\ncurrent-context: ${K.CONST.CONTEXT}\nkind: Config\nusers:\n- name: oncall\n  user:\n    token: REDACTED`); return r(); }
      E('error: supported here: kubectl config current-context | get-contexts | view | set-context --current --namespace=<ns>'); return r();
    }

    /* ---------- create / apply / delete ---------- */
    create(a, ns, nsFlag, o, r, nsCheck, stdin) {
      const c = this.c, E = m => o(m, 'err');
      if (a.flags.filename) return this.applyFiles(a, ns, nsFlag, o, r, 'create', stdin);
      let what = a.pos[0], name = a.pos[1];
      if (!what) { E('error: you must specify a resource to create, e.g. kubectl create deployment web --image=nginx'); return r(); }
      what = what.toLowerCase();
      const md = n => Object.assign({ name: n }, nsFlag ? { namespace: nsFlag } : {});
      const list = k => [].concat(...(a.multi[k] || []).filter(x => typeof x === 'string').map(x => x.split(',')));
      let doc = null;
      const needName = () => { if (!name) { E('error: exactly one NAME is required, got 0'); return false; } return true; };
      if (['deployment', 'deploy'].includes(what)) {
        if (!needName()) return r();
        const image = a.flags.image;
        if (!image || image === true) { E('error: required flag(s) "image" not set'); return r(); }
        const replicas = a.flags.replicas != null ? Number(a.flags.replicas) : 1;
        doc = { apiVersion: 'apps/v1', kind: 'Deployment', metadata: Object.assign(md(name), { labels: { app: name } }), spec: { replicas, selector: { matchLabels: { app: name } }, template: { metadata: { labels: { app: name } }, spec: { containers: [Object.assign({ name: nameFromImage(image), image, resources: {} }, a.flags.port ? { ports: [{ containerPort: Number(a.flags.port) }] } : {})] } } } };
      } else if (['namespace', 'ns'].includes(what)) {
        if (!needName()) return r();
        doc = { apiVersion: 'v1', kind: 'Namespace', metadata: { name } };
      } else if (['serviceaccount', 'sa'].includes(what)) {
        if (!needName()) return r();
        doc = { apiVersion: 'v1', kind: 'ServiceAccount', metadata: md(name) };
      } else if (['configmap', 'cm'].includes(what) || what === 'secret') {
        let nm = name, kind = 'ConfigMap', type;
        const data = {};
        if (what === 'secret') {
          kind = 'Secret'; nm = a.pos[2];
          if (name === 'docker-registry') {
            const srv = a.flags['docker-server'], user = a.flags['docker-username'], pass = a.flags['docker-password'];
            if (!nm) { E('error: exactly one NAME is required, got 0'); return r(); }
            if (typeof user !== 'string' || typeof pass !== 'string') { E('error: missing either `--docker-username` and `--docker-password` or `--from-file`'); return r(); }
            const server = typeof srv === 'string' ? srv.replace(/^https?:\/\//, '').replace(/\/.*$/, '') : 'https://index.docker.io/v1/';
            data['.dockerconfigjson'] = JSON.stringify({ auths: { [server]: { username: user, password: pass, auth: K.b64.encode(user + ':' + pass) } } });
            type = 'kubernetes.io/dockerconfigjson';
          } else if (name === 'generic') type = 'Opaque';
          else { E(name === 'tls' ? 'error: TLS secrets are not simulated here; use: kubectl create secret generic NAME --from-literal=KEY=VALUE' : 'error: use: kubectl create secret generic|docker-registry NAME ...'); return r(); }
        }
        if (!nm) { E('error: exactly one NAME is required, got 0'); return r(); }
        for (const x of a.multi['from-literal'] || []) { const kv = parseKV(String(x)); if (!kv || !kv[0]) { E(`error: invalid literal source ${x}, expected key=value`); return r(); } data[kv[0]] = kv[1]; }
        for (const f of a.multi['from-file'] || []) {
          const [k, path] = String(f).includes('=') ? f.split('=') : [f, f];
          if (!this.g.files.has(path)) { E(`error: error reading ${path}: no such file or directory`); return r(); }
          data[k] = this.g.files.get(path);
        }
        doc = { apiVersion: 'v1', kind, metadata: md(nm) };
        if (kind === 'Secret') { doc.type = type; doc.data = {}; Object.keys(data).forEach(k => { doc.data[k] = K.b64.encode(data[k]); }); } else doc.data = data;
      } else if (['role', 'clusterrole'].includes(what)) {
        if (!needName()) return r();
        const verbs = list('verb'), resources = list('resource');
        if (!verbs.length) { E('error: at least one verb must be specified'); return r(); }
        if (!resources.length) { E('error: at least one resource must be specified'); return r(); }
        const byGroup = {};
        resources.forEach(rs => { const [res, ...g] = rs.split('.'); const group = g.length ? g.join('.') : (API_GROUP[res] || ''); (byGroup[group] = byGroup[group] || []).push(res); });
        doc = { apiVersion: 'rbac.authorization.k8s.io/v1', kind: what === 'role' ? 'Role' : 'ClusterRole', metadata: what === 'role' ? md(name) : { name }, rules: Object.keys(byGroup).map(g => ({ apiGroups: [g], resources: byGroup[g], verbs })) };
      } else if (['rolebinding', 'clusterrolebinding'].includes(what)) {
        if (!needName()) return r();
        const role = a.flags.role, crole = a.flags.clusterrole;
        if (what === 'clusterrolebinding' && typeof crole !== 'string') { E('error: required flag(s) "clusterrole" not set'); return r(); }
        if (what === 'rolebinding' && typeof role !== 'string' && typeof crole !== 'string') { E('error: exactly one of clusterrole or role must be specified'); return r(); }
        const subjects = [];
        for (const s of list('serviceaccount')) { const p = s.split(':'); if (p.length !== 2 || !p[0] || !p[1]) { E(`error: serviceaccount must be <namespace>:<name>`); return r(); } subjects.push({ kind: 'ServiceAccount', name: p[1], namespace: p[0] }); }
        list('user').forEach(u => subjects.push({ apiGroup: 'rbac.authorization.k8s.io', kind: 'User', name: u }));
        list('group').forEach(u => subjects.push({ apiGroup: 'rbac.authorization.k8s.io', kind: 'Group', name: u }));
        doc = { apiVersion: 'rbac.authorization.k8s.io/v1', kind: what === 'rolebinding' ? 'RoleBinding' : 'ClusterRoleBinding', metadata: what === 'rolebinding' ? md(name) : { name },
          roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: typeof role === 'string' && what === 'rolebinding' ? 'Role' : 'ClusterRole', name: typeof role === 'string' && what === 'rolebinding' ? role : crole }, subjects };
      } else if (['quota', 'resourcequota'].includes(what)) {
        if (!needName()) return r();
        const hard = {}; String(a.flags.hard || '').split(',').filter(Boolean).forEach(x => { const kv = parseKV(x); if (kv) hard[kv[0]] = kv[1]; });
        doc = { apiVersion: 'v1', kind: 'ResourceQuota', metadata: md(name), spec: { hard } };
      } else if (['poddisruptionbudget', 'pdb'].includes(what)) {
        if (!needName()) return r();
        if (typeof a.flags.selector !== 'string') { E('error: a selector must be specified'); return r(); }
        const ml = {}; a.flags.selector.split(',').forEach(x => { const kv = parseKV(x); if (kv) ml[kv[0]] = kv[1]; });
        const spec = { selector: { matchLabels: ml } };
        if (a.flags['min-available'] != null) spec.minAvailable = /%$/.test(a.flags['min-available']) ? a.flags['min-available'] : Number(a.flags['min-available']);
        else if (a.flags['max-unavailable'] != null) spec.maxUnavailable = /%$/.test(a.flags['max-unavailable']) ? a.flags['max-unavailable'] : Number(a.flags['max-unavailable']);
        else { E('error: one of min-available or max-unavailable must be specified'); return r(); }
        doc = { apiVersion: 'policy/v1', kind: 'PodDisruptionBudget', metadata: md(name), spec };
      } else if (what === 'service' || what === 'svc') { E('error: try kubectl expose deployment <name> --port=80 (it builds the right selector for you), or write a manifest and kubectl apply -f'); return r(); }
      else if (['job', 'cronjob', 'statefulset'].includes(what)) { E(`error: ${what} is a real Kubernetes kind, but this training cluster doesn't simulate it yet`); return r(); }
      else { E(`error: unknown or unsupported type "${what}" for kubectl create. Supported: deployment, namespace, serviceaccount, configmap, secret generic|docker-registry, role, rolebinding, clusterrole, clusterrolebinding, quota, poddisruptionbudget, -f <file>`); return r(); }

      if (a.flags['dry-run']) { const kindRes = M.RES[doc.kind] || doc.kind.toLowerCase(); this.dry(a, o, doc, kindRes.split('.')[0] + '/' + doc.metadata.name); return r(); }
      if (doc.kind !== 'Namespace' && !CLUSTER_KINDS.includes(doc.kind) && !nsCheck()) return r();
      try {
        const line = M.applyDoc(c, doc, { file: '-', ns, nsFlag, mode: 'create' });
        o(line, 'ok');
        this.fact(`create:${doc.kind.toLowerCase()}:${doc.metadata.name}`);
      } catch (e) {
        if (!(e instanceof M.ApplyError)) throw e;
        o(e.message.replace(/error when creating "-": /, ''), 'err');
      }
      return r();
    }
    readDocs(a, o, stdin) {
      const f = a.flags.filename;
      if (!f || f === true) { o('error: must specify one of -f and -k', 'err'); return null; }
      let text;
      if (f === '-') text = stdin || '';
      else if (this.g.files.has(f)) text = this.g.files.get(f);
      else if (/^https?:\/\//.test(f)) { o(`error: unable to read URL "${f}": this incident shell has no internet access; save the manifest to a file first`, 'err'); return null; }
      else { o(`error: the path "${f}" does not exist`, 'err'); return null; }
      try { return { docs: K.yaml.parseAll(text).flatMap(d => (d && d.kind === 'List' && Array.isArray(d.items) ? d.items : [d])), file: f }; } catch (e) { o(`error: error parsing ${f}: error converting YAML to JSON: yaml: ${e.message}`, 'err'); return null; }
    }
    applyFiles(a, ns, nsFlag, o, r, mode, stdin) {
      const rd = this.readDocs(a, o, stdin); if (!rd) return r();
      if (!rd.docs.length) { o('error: no objects passed to ' + mode, 'err'); return r(); }
      for (const doc of rd.docs) {
        try {
          if (doc && doc.metadata) { delete doc.metadata.uid; delete doc.metadata.creationTimestamp; delete doc.metadata.resourceVersion; }
          const line = M.applyDoc(this.c, doc, { file: rd.file, ns, nsFlag, mode, dryRun: !!a.flags['dry-run'] });
          o(line, 'ok');
          this.fact(`${mode}:${doc.kind}:${doc.metadata.name}`); this.fact(mode + '-file:' + rd.file);
        } catch (e) {
          if (!(e instanceof M.ApplyError)) throw e;
          o(e.message, 'err');
          this.fact(mode + '-error:' + rd.file);
        }
      }
      return r();
    }
    del(a, ns, o, r, badType, stdin) {
      const E = m => o(m, 'err');
      const force = !!a.flags.force && String(a.flags['grace-period']) === '0';
      if (a.flags.filename) {
        const rd = this.readDocs(a, o, stdin); if (!rd) return r();
        rd.docs.forEach(doc => {
          const t = doc && typeByKind(doc.kind); const n = doc && doc.metadata && doc.metadata.name;
          if (!t || !n) { E('error: unable to recognize object in ' + rd.file); return; }
          this.deleteOne(t, (doc.metadata.namespace || ns), n, o, force);
        });
        return r();
      }
      if (!a.pos.length) { E('error: You must provide one or more resources by argument or filename.\nExample resource specifications include:\n   \'-f rsrc.yaml\'\n   \'--filename=rsrc.json\'\n   \'<resource> <name>\'\n   \'<resource>\''); return r(); }
      let items = [];
      if (a.pos[0].includes('/')) { for (const p of a.pos) { const [tw, n] = p.split('/'); const t = typeOf(tw); if (!t) return badType(tw); items.push([t, n]); } }
      else {
        const t = typeOf(a.pos[0]); if (!t) return badType(a.pos[0]);
        let names = a.pos.slice(1);
        if (a.flags.all || a.flags.selector || a.flags['field-selector']) names = this.collect(t, ns, !!a.flags['all-namespaces'], [], typeof a.flags.selector === 'string' ? a.flags.selector : null, a.flags['field-selector']).objs.map(x => x.name);
        if (!names.length) { if (a.flags.all || a.flags.selector || a.flags['field-selector']) o('No resources found', 'dim'); else E('error: resource(s) were provided, but no name was specified'); return r(); }
        items = names.map(n => [t, n]);
      }
      if (force) o('Warning: Immediate deletion does not wait for confirmation that the running resource has been terminated. The resource may continue to run on the cluster indefinitely.', 'warn');
      items.forEach(([t, n]) => this.deleteOne(t, ns, n, o, force));
      return r();
    }
    deleteOne(t, ns, n, o, force) {
      const c = this.c, E = m => o(m, 'err');
      if (t.kind === 'Node') { E(`This training cluster won't delete nodes; the autoscaler owns them. Try: kubectl cordon ${n} / kubectl drain ${n}`); return; }
      if (t.kind === 'Namespace') {
        if (!c.namespaces.has(n)) { E(`Error from server (NotFound): namespaces "${n}" not found`); return; }
        if (['default', 'kube-system', 'kube-public', 'kube-node-lease', 'ingress-nginx'].includes(n) || c.list('Deployment', n).some(d => !/^loadtest/.test(d.name))) { E(`Error from server (Forbidden): namespaces "${n}" is forbidden: deleting a namespace that runs production workloads is blocked by the admission policy "protect-prod-namespaces"`); return; }
        c.deleteObject('Namespace', null, n, force); o(`namespace "${n}" deleted`, 'ok'); this.fact('deleted:Namespace:' + n); return;
      }
      if (['Endpoints', 'Event', 'PersistentVolume'].includes(t.kind)) { E(`error: deleting ${t.key} isn't supported here`); return; }
      const obj = c.get(t.kind, ns, n);
      if (!obj) { E(`Error from server (NotFound): ${M.PLURAL[t.kind]} "${n}" not found`); return; }
      if (t.kind === 'Service' && n === 'kubernetes' && ns === 'default') { E('The API server recreates the "kubernetes" service immediately. Leave it be.'); return; }
      if (t.kind === 'ClusterRole' && /^(cluster-admin|admin|edit|view)$/.test(n)) { E(`Error from server (Forbidden): clusterroles.rbac.authorization.k8s.io "${n}" is forbidden: built-in role protected by policy`); return; }
      if (t.kind === 'Pod') { this.fact('deleted-pod-of:' + c.workloadOf(obj)); if (obj.status === 'Failed') this.fact('deleted-failed-pod'); }
      c.deleteObject(t.kind, ns, n, force);
      o(`${M.RES[t.kind] || t.kind.toLowerCase()} "${n}" ${force ? 'force deleted' : 'deleted'}${t.kind === 'Namespace' ? '' : ns !== 'default' && t.ns ? ` from ${ns} namespace` : ''}`, 'ok');
      this.fact(`deleted:${t.kind}:${n}`);
    }

    /* ---------- rollout ---------- */
    rollout(a, ns, o, r, target, badType, last) {
      const c = this.c, E = m => o(m, 'err');
      const sub = a.pos[0];
      if (!['status', 'history', 'undo', 'restart', 'pause', 'resume'].includes(sub)) { E(sub ? `error: unknown command "${sub}" for "kubectl rollout" (supported: status, history, undo, restart, pause, resume)` : 'error: you must specify a subcommand: status, history, undo, restart, pause, resume'); return r(); }
      const tg = target(a.pos, 1);
      if (!tg || !tg.name) { E('error: required resource not specified, e.g. kubectl rollout ' + sub + ' deployment/checkout'); return r(); }
      if (!tg.type) return badType(tg.tw);
      if (tg.type.kind !== 'Deployment') { E(`error: no rollout ${sub} available for ${tg.type.key} in this simulator; try a deployment`); return r(); }
      const d = c.get('Deployment', ns, tg.name);
      if (!d) { E(`Error from server (NotFound): deployments.apps "${tg.name}" not found`); return r(); }
      this.fact('rollout:' + sub); this.fact(`rollout:${sub}:${d.name}`);
      if (sub === 'history') {
        const rss = c.rsOf(d).sort((x, y) => x.revision - y.revision);
        if (a.flags.revision) {
          const rs = rss.find(x => String(x.revision) === String(a.flags.revision));
          if (!rs) { E('error: unable to find the specified revision'); return r(); }
          const L = [`deployment.apps/${d.name} with revision #${rs.revision}`, 'Pod Template:', `  Labels:       ${labelStr(rs.template.labels)}`];
          if (rs.changeCause) L.push(`  Annotations:  kubernetes.io/change-cause: ${rs.changeCause}`);
          L.push('  Containers:'); this.describeContainers(L, rs.template.spec.containers, null, false);
          o(L.join('\n')); return r();
        }
        o(`deployment.apps/${d.name} `); o(table(['REVISION', 'CHANGE-CAUSE'], rss.map(x => [x.revision, x.changeCause || '<none>'])));
        return r();
      }
      if (sub === 'undo') {
        const rss = c.rsOf(d).sort((x, y) => y.revision - x.revision);
        const cur = c.newRSOf(d);
        const to = a.flags['to-revision'] ? rss.find(x => String(x.revision) === String(a.flags['to-revision'])) : rss.find(x => x !== cur);
        if (!to) { E(a.flags['to-revision'] ? `error: unable to find specified revision ${a.flags['to-revision']} in history` : `error: no rollout history found for deployment "${d.name}"`); return r(); }
        if (to === cur) { o(`deployment.apps/${d.name} skipped rollback (current template already matches revision ${to.revision})`); return r(); }
        const tl = Object.assign({}, to.template.labels); delete tl['pod-template-hash'];
        d.template = { labels: tl, annotations: clone(to.template.annotations || {}), spec: clone(to.template.spec) };
        d.changeCause = to.changeCause; d.paused = false;
        c.activity.etcd++; o(`deployment.apps/${d.name} rolled back`, 'ok'); this.fact('rolled-back:' + d.name);
        return r();
      }
      if (sub === 'restart') {
        d.template.annotations = Object.assign({}, d.template.annotations, { 'kubectl.kubernetes.io/restartedAt': c.ts(c.now) });
        c.activity.etcd++; o(`deployment.apps/${d.name} restarted`, 'ok'); return r();
      }
      if (sub === 'pause' || sub === 'resume') {
        const want = sub === 'pause';
        if (!!d.paused === want) { E(`error: deployments.apps "${d.name}" is ${want ? 'already paused' : 'not paused'}`); return r(); }
        d.paused = want; o(`deployment.apps/${d.name} ${want ? 'paused' : 'resumed'}`, 'ok'); return r();
      }
      const first = c.rolloutMessage(d);
      if (first.done || !last || a.flags.watch === 'false') { o(first.msg, first.error ? 'err' : first.done ? 'ok' : ''); if (first.done && !first.error) this.fact('rollout:status:done:' + d.name); return r(); }
      o(first.msg);
      const self = this; let prev = first.msg, ticks = 0;
      return r({ stream: {
        label: 'kubectl rollout status',
        tick() {
          ticks++;
          const m = c.rolloutMessage(d), lines = [];
          if (m.msg !== prev) { lines.push({ t: m.msg, c: m.error ? 'err' : m.done ? 'ok' : '' }); prev = m.msg; }
          if (m.done && !m.error) self.fact('rollout:status:done:' + d.name);
          return { lines, done: m.done || ticks > 200 };
        },
      } });
    }

    /* ---------- node maintenance ---------- */
    drain(a, o, r, last) {
      const c = this.c, E = m => o(m, 'err');
      const n = c.node(a.pos[0]);
      if (!a.pos[0]) { E('error: USAGE: kubectl drain NODE [--ignore-daemonsets] [--delete-emptydir-data] [--force]'); return r(); }
      if (!n) { E(`Error from server (NotFound): nodes "${a.pos[0]}" not found`); return r(); }
      if (!n.unschedulable) { n.unschedulable = true; c.event(n, 'Normal', 'NodeNotSchedulable', `Node ${n.name} status is now: NodeNotSchedulable`, 'kubelet'); o(`node/${n.name} cordoned`, 'ok'); }
      else o(`node/${n.name} already cordoned`);
      this.fact('cordon:' + n.name);
      const pods = () => c.list('Pod').filter(p => p.node === n.name && !p.deleting && p.status !== 'Failed' && p.status !== 'Succeeded');
      const ds = pods().filter(p => p.owner && p.owner.kind === 'DaemonSet');
      const bare = pods().filter(p => !p.owner);
      const errs = [];
      if (ds.length && !a.flags['ignore-daemonsets']) errs.push(`cannot delete DaemonSet-managed Pods (use --ignore-daemonsets to ignore): ${ds.map(p => p.namespace + '/' + p.name).join(', ')}`);
      if (bare.length && !a.flags.force) errs.push(`cannot delete Pods that declare no controller (use --force to override): ${bare.map(p => p.namespace + '/' + p.name).join(', ')}`);
      const ed = pods().filter(p => (p.spec.volumes || []).some(v => v.emptyDir));
      if (ed.length && !a.flags['delete-emptydir-data']) errs.push(`cannot delete Pods with local storage (use --delete-emptydir-data to override): ${ed.map(p => p.namespace + '/' + p.name).join(', ')}`);
      if (errs.length) {
        E(`error: unable to drain node "${n.name}" due to error: [${errs.join(', ')}], continuing command...`);
        E(`There are pending nodes to be drained:\n ${n.name}`); errs.forEach(x => E(x));
        this.fact('drain-blocked'); return r();
      }
      const warn = [];
      if (ds.length) warn.push(`ignoring DaemonSet-managed Pods: ${ds.map(p => p.namespace + '/' + p.name).join(', ')}`);
      if (bare.length) warn.push(`deleting Pods that declare no controller: ${bare.map(p => p.namespace + '/' + p.name).join(', ')}`);
      if (warn.length) o('Warning: ' + warn.join('; '), 'warn');
      const self = this;
      const announced = new Set();
      const pass = out => {
        const budgets = new Map();
        const todo = pods().filter(p => !(p.owner && p.owner.kind === 'DaemonSet'));
        let blocked = 0;
        for (const p of todo) {
          if (!announced.has(p.uid)) { out(`evicting pod ${p.namespace}/${p.name}`, ''); announced.add(p.uid); }
          const pdbs = c.list('PodDisruptionBudget', p.namespace).filter(b => selects(b.selector, p.labels));
          const okToEvict = pdbs.every(b => { if (!budgets.has(b.uid)) budgets.set(b.uid, c.pdbStatus(b).allowed); return !p.ready || budgets.get(b.uid) > 0; });
          if (!okToEvict) { blocked++; out(`error when evicting pods/"${p.name}" -n "${p.namespace}" (will retry after 5s): Cannot evict pod as it would violate the pod's disruption budget.`, 'err'); self.fact('drain-pdb-blocked'); continue; }
          pdbs.forEach(b => { if (p.ready) budgets.set(b.uid, budgets.get(b.uid) - 1); });
          c.markDeleting(p); c.activity.controllers++;
          c.event(p, 'Normal', 'Evicted', 'Evicted by the eviction API during drain', 'kubectl-drain');
          out(`pod/${p.name} evicted`, '');
        }
        return blocked;
      };
      const blocked = pass((t, cl) => o(t, cl));
      const finished = () => !pods().some(p => !(p.owner && p.owner.kind === 'DaemonSet')) || pods().every(p => p.owner && p.owner.kind === 'DaemonSet');
      if (!blocked) { o(`node/${n.name} drained`, 'ok'); this.fact('drain:' + n.name); return r(); }
      if (!last) { E(`error: unable to drain node "${n.name}": ${blocked} pod(s) blocked by a PodDisruptionBudget`); return r(); }
      let ticks = 0;
      return r({ stream: {
        label: 'kubectl drain',
        tick() {
          ticks++;
          const lines = [];
          if (ticks % 2 === 0) pass((t, cl) => lines.push({ t, c: cl }));
          if (finished()) { lines.push({ t: `node/${n.name} drained`, c: 'ok' }); self.fact('drain:' + n.name); return { lines, done: true }; }
          if (ticks > 150) { lines.push({ t: `error: unable to drain node "${n.name}": global timeout reached`, c: 'err' }); return { lines, done: true }; }
          return { lines, done: false };
        },
      } });
    }
    taint(a, o, r) {
      const c = this.c, E = m => o(m, 'err');
      if (!['nodes', 'node', 'no'].includes(a.pos[0])) { E('error: at least one taint update is required. Usage: kubectl taint nodes NODE key=value:Effect'); return r(); }
      const n = c.node(a.pos[1]);
      if (!a.pos[1]) { E('error: at least one node must be specified'); return r(); }
      if (!n) { E(`Error from server (NotFound): nodes "${a.pos[1]}" not found`); return r(); }
      const specs = a.pos.slice(2);
      if (!specs.length) { E('error: at least one taint update is required'); return r(); }
      let removed = false, added = false;
      for (const s of specs) {
        if (s.endsWith('-')) {
          const body = s.slice(0, -1), [kv, eff] = body.split(':'), key = kv.split('=')[0];
          const before = n.taints.length;
          n.taints = n.taints.filter(t => !(t.key === key && (!eff || t.effect === eff)));
          if (n.taints.length === before) { E(`error: taint "${body}" not found`); return r(); }
          removed = true; continue;
        }
        const m = /^([^=:]+)(?:=([^:]*))?:(NoSchedule|PreferNoSchedule|NoExecute)$/.exec(s);
        if (!m) { E(`error: invalid taint spec: ${s}, unknown taint effect or format, expected key=value:Effect`); return r(); }
        const ex = n.taints.find(t => t.key === m[1] && t.effect === m[3]);
        if (ex && !a.flags.overwrite) { E(`error: node ${n.name} already has ${m[1]} taint(s) with same effect(s) and --overwrite is false`); return r(); }
        if (ex) ex.value = m[2] || undefined; else n.taints.push(JSON.parse(JSON.stringify({ key: m[1], value: m[2] || undefined, effect: m[3] })));
        added = true;
      }
      if (added && n.taints.some(t => t.effect === 'NoExecute')) {
        c.list('Pod').filter(p => p.node === n.name && !p.deleting && !(p.owner && p.owner.kind === 'DaemonSet') && n.taints.some(t => t.effect === 'NoExecute' && !K.sim.tolerates(p.spec.tolerations, t))).forEach(p => { c.event(p, 'Normal', 'TaintManagerEviction', `Marking for deletion Pod ${p.namespace}/${p.name}`, 'taint-eviction-controller'); c.markDeleting(p); });
      }
      o(`node/${n.name} ${removed && !added ? 'untainted' : 'tainted'}`, 'ok');
      this.fact('taint:' + n.name);
      return r();
    }

    /* ---------- RBAC ---------- */
    auth(a, ns, o, r) {
      const c = this.c, E = m => o(m, 'err');
      const sub = a.pos[0];
      const who = c.parseSubject(typeof a.flags.as === 'string' ? a.flags.as : null);
      const whoStr = who.kind === 'ServiceAccount' ? `system:serviceaccount:${who.namespace}:${who.name}` : who.name;
      if (sub === 'whoami') { o(table(['ATTRIBUTE', 'VALUE'], [['Username', whoStr], ['Groups', `[${(who.groups || ['system:serviceaccounts', 'system:serviceaccounts:' + who.namespace, 'system:authenticated']).join(' ')}]`]])); return r(); }
      if (sub !== 'can-i') { E('error: supported here: kubectl auth can-i VERB RESOURCE [--as=...] [-n ns] | kubectl auth can-i --list | kubectl auth whoami'); return r(); }
      if (a.flags.list) {
        const rules = c.rulesFor(who, a.flags['all-namespaces'] ? null : ns).map(x => x.rule);
        if (who.kind === 'ServiceAccount') rules.push({ apiGroups: ['authorization.k8s.io'], resources: ['selfsubjectaccessreviews'], verbs: ['create'] });
        o(table(['Resources', 'Non-Resource URLs', 'Resource Names', 'Verbs'], rules.map(rl => [rl.resources.map(x => x + (rl.apiGroups && rl.apiGroups[0] && rl.apiGroups[0] !== '*' ? '.' + rl.apiGroups[0] : '')).join(', '), '[]', `[${(rl.resourceNames || []).join(' ')}]`, `[${rl.verbs.join(' ')}]`])));
        this.fact(`auth:list:${whoStr}`); return r();
      }
      const verb = a.pos[1], resRaw = a.pos[2];
      if (!verb || !resRaw) { E('error: you must specify two arguments: verb resource or verb resource/resourceName.\nSee \'kubectl auth can-i -h\' for help and examples.'); return r(); }
      let resource = resRaw.split('/')[0], group;
      const t = typeOf(resource.split('.')[0]);
      if (resource.includes('.') && !t) { const p = resource.split('.'); resource = p[0]; group = p.slice(1).join('.'); }
      else if (t) { group = API_GROUP[t.key] != null ? API_GROUP[t.key] : ''; resource = t.key; }
      if (resRaw.split('/')[1] === 'log' || resRaw.split('/')[1] === 'exec') resource = resource + '/' + resRaw.split('/')[1];
      const nsUse = a.flags['all-namespaces'] ? null : ns;
      const yes = c.can(who, verb, resource, nsUse, group);
      o(yes ? 'yes' : 'no', yes ? 'ok' : '');
      this.fact(`auth:can-i:${whoStr}:${verb}:${resource}:${nsUse || '*'}:${yes ? 'yes' : 'no'}`);
      this.fact(`auth:can-i:${yes ? 'yes' : 'no'}`);
      return r();
    }

    /* ---------- exec: run one command inside a pod ---------- */
    execPod(a, ns, o, r) {
      const c = this.c, E = m => o(m, 'err');
      let name = a.pos[0];
      if (!name) { E('error: pod, type/name or --filename must be specified'); return r(); }
      let p = null;
      if (name.includes('/')) {
        const [tw, n] = name.split('/'); const t = typeOf(tw);
        if (t && t.kind === 'Deployment') { const d = c.get('Deployment', ns, n); if (!d) { E(`Error from server (NotFound): deployments.apps "${n}" not found`); return r(); } p = c.podsOfDeployment(d).find(q => q.phase === 'Running') || c.podsOfDeployment(d)[0]; }
        else p = c.get('Pod', ns, n);
        name = n;
      } else p = c.get('Pod', ns, name);
      if (!p) { E(`Error from server (NotFound): pods "${name}" not found`); return r(); }
      let cmd = a.flags['--'] || a.pos.slice(1);
      if (!cmd.length) { E('error: you must specify at least one command for the container'); return r(); }
      const cname = typeof a.flags.container === 'string' ? a.flags.container : p.spec.containers[0].name;
      if (!p.spec.containers.some(x => x.name === cname)) { E(`error: unable to upgrade connection: container ${cname} not found in pod ${p.name}`); return r(); }
      if (p.phase !== 'Running' || p.deleting) {
        if (!p.node || /ContainerCreating|Pending|Init:|PodInitializing|ImagePull|ErrImage|CreateContainerConfigError/.test(p.phase)) E(`error: unable to upgrade connection: container not found ("${cname}")`);
        else E(`error: Internal error occurred: unable to upgrade connection: container not found ("${cname}")`);
        return r();
      }
      if (/^(sh|bash|ash|\/bin\/sh|\/bin\/bash)$/.test(cmd[0])) {
        if (cmd[1] === '-c' && cmd[2]) { const tk = tokenize(cmd[2]); if (tk.error) { E('sh: ' + tk.error); return r(); } cmd = tk.tokens; }
        else { o(`Interactive shells aren't simulated. Run a single command instead, for example:\n  kubectl exec ${p.name}${ns !== c.currentNamespace ? ' -n ' + ns : ''} -- curl -s http://payments:8080/healthz\n  kubectl exec ${p.name}${ns !== c.currentNamespace ? ' -n ' + ns : ''} -- nslookup payments`, 'warn'); return r(); }
      }
      const src = c.srcOf(p), wl = c.workloadOf(p);
      const tool = cmd[0].replace(/^.*\//, ''), args = cmd.slice(1);
      this.fact(`exec:${wl}`); this.fact(`exec:${wl}:${tool}`);
      const prof = c.profileOf(p);
      switch (tool) {
        case 'curl': case 'wget': return this.curl(args, o, r, src, tool, wl);
        case 'nslookup': case 'dig': case 'host': case 'getent': return this.nslookup(tool === 'getent' ? args.slice(1) : args, o, r, src, tool, wl);
        case 'nc': case 'ncat': case 'telnet': {
          const pos = args.filter(x => x[0] !== '-');
          const [host, port] = pos;
          if (!host || !port) { E('usage: nc -zv HOST PORT'); return r(); }
          const res = c.request(src, `tcp://${host}:${port}`);
          if (res.ok) { o(`${host} (${res.ip || host}:${port}) open`, 'ok'); this.fact(`exec:${wl}:nc:${host}:open`); }
          else { E(res.kind === 'nxdomain' || res.kind === 'dns-timeout' ? `nc: bad address '${host}'` : `nc: ${host} (${res.ip || host}:${port}): ${res.kind === 'timeout' ? 'Operation timed out' : 'Connection refused'}`); this.fact(`exec:${wl}:nc:${host}:fail`); }
          return r();
        }
        case 'env': case 'printenv': {
          const env = Object.assign({ PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOSTNAME: p.name }, p.env, { KUBERNETES_SERVICE_HOST: '10.96.0.1', KUBERNETES_SERVICE_PORT: '443', HOME: '/root' });
          if (args[0]) { if (args[0] in env) o(env[args[0]]); return r(); }
          Object.keys(env).forEach(k => o(`${k}=${env[k]}`));
          return r();
        }
        case 'cat': {
          for (const f of args) {
            if (f === '/etc/resolv.conf') o(`search ${p.namespace}.svc.cluster.local svc.cluster.local cluster.local eu-west-1.compute.internal\nnameserver ${K.CONST.DNS_IP}\noptions ndots:5`);
            else if (f === '/etc/hosts') o(`127.0.0.1\tlocalhost\n${p.ip}\t${p.name}`);
            else if (p.files && f in p.files) o(p.files[f].replace(/\n$/, ''));
            else E(`cat: can't open '${f}': No such file or directory`);
          }
          this.fact(`exec:${wl}:cat`);
          return r();
        }
        case 'ls': {
          const dir = (args.filter(x => x[0] !== '-')[0] || '/').replace(/\/$/, '');
          const kids = Object.keys(p.files || {}).filter(f => f.startsWith(dir + '/')).map(f => f.slice(dir.length + 1).split('/')[0]);
          if (kids.length) o(Array.from(new Set(kids)).join('  ')); else if (dir === '' || dir === '/') o('bin  dev  etc  home  lib  proc  root  run  sys  tmp  usr  var'); else E(`ls: ${dir}: No such file or directory`);
          return r();
        }
        case 'df': {
          const rows = [['Filesystem', 'Size', 'Used', 'Available', 'Use%', 'Mounted on'], ['overlay', '79.9G', '21.3G', '58.6G', '27%', '/']];
          (p.spec.containers.find(x => x.name === cname).volumeMounts || []).forEach(vm => {
            const v = (p.spec.volumes || []).find(x => x.name === vm.name);
            if (v && v.persistentVolumeClaim) {
              const pvc = c.get('PersistentVolumeClaim', p.namespace, v.persistentVolumeClaim.claimName);
              if (pvc) { const pct = Math.min(100, Math.round(pvc.usedMi / pvc.capacityMi * 100)); rows.push([`/dev/nvme${1 + K.sim.fnv1a(pvc.name) % 4}n1`, fmtMem(pvc.capacityMi).replace('i', ''), fmtMem(pvc.usedMi).replace('i', ''), fmtMem(Math.max(0, pvc.capacityMi - pvc.usedMi)).replace('i', ''), pct + '%', vm.mountPath]); }
            } else if (v && (v.configMap || v.secret)) rows.push(['tmpfs', '7.6G', '12.0K', '7.6G', '0%', vm.mountPath]);
          });
          rows.push(['tmpfs', '7.6G', '12.0K', '7.6G', '0%', '/var/run/secrets/kubernetes.io/serviceaccount']);
          o(table(rows[0], rows.slice(1)));
          this.fact(`exec:${wl}:df`);
          return r();
        }
        case 'hostname': o(p.name); return r();
        case 'ps': o(`PID   USER     TIME  COMMAND\n    1 app       0:${String(Math.min(59, Math.floor((c.now - (p.startedAt || c.now)) / 60))).padStart(2, '0')} ${(p.spec.containers[0].command || [prof && prof.kind === 'tcp' ? 'postgres' : '/app/server']).join(' ')}`); return r();
        case 'echo': o(args.join(' ')); return r();
        case 'date': o(new Date(c.baseTime).toUTCString()); return r();
        case 'whoami': o('app'); return r();
        default: E(`error: Internal error occurred: Internal error occurred: error executing command in container: failed to exec in container: failed to start exec "${K.sim.fnv1a(p.uid + tool).toString(16)}": OCI runtime exec failed: exec failed: unable to start container process: exec: "${cmd[0]}": executable file not found in $PATH: unknown`); return r();
      }
    }

    /* ---------- curl & DNS tools (from the debug toolbox, or inside a pod via exec) ---------- */
    curl(args, o, r, src, tool, wl) {
      const c = this.c;
      let url = null, silent = false, include = false, head = false, verbose = false, out = null, wfmt = null, quiet = false;
      for (let i = 0; i < args.length; i++) {
        const t = args[i];
        if (t === '-o' || t === '-O' || t === '--output') { out = args[++i]; continue; }
        if (t === '-w' || t === '--write-out') { wfmt = args[++i]; continue; }
        if (['-m', '--max-time', '--connect-timeout', '-X', '--request', '-H', '--header', '-d', '--data', '-u', '-A'].includes(t)) { i++; continue; }
        if (/^-[a-zA-Z]+$/.test(t)) {
          if (/s/.test(t)) silent = true; if (/i/.test(t)) include = true; if (/I/.test(t)) head = true; if (/v/.test(t)) verbose = true; if (/q/.test(t)) quiet = true;
          if (/O/.test(t) && tool === 'wget') out = '-';
          continue;
        }
        if (t.startsWith('--')) { if (t === '--silent') silent = true; if (t === '--include') include = true; if (t === '--head') head = true; if (t === '--verbose') verbose = true; continue; }
        if (t.startsWith('-O') && tool === 'wget') { out = t.slice(2) || '-'; continue; }
        url = url || t;
      }
      void quiet; void silent;
      if (!url) { o(tool === 'wget' ? 'BusyBox v1.37.0 multi-call binary.\n\nUsage: wget [-cqS] [-O FILE] URL' : "curl: try 'curl <service>.<namespace>:<port>/<path>' (for example: curl https://tickets.stagedoor.io/)", 'err'); return r(); }
      const u = c.parseUrl(url);
      if (!u) { o(tool === 'wget' ? `wget: bad address '${url}'` : 'curl: (3) URL rejected: Malformed input to a URL function', 'err'); return r(); }
      const fromSrc = /stagedoor\.io$/.test(u.host) && src === c.TOOLBOX ? c.INTERNET : src;
      const res = c.request(fromSrc, url);
      const host = u.host.toLowerCase();
      const facts = s => { this.fact(`curl:${host}:${s}`); if (wl) this.fact(`exec:${wl}:curl:${host}:${s}`); };
      const ms = res.kind === 'timeout' ? 5001 + Math.floor(c.rng() * 3) : 1 + Math.floor(c.rng() * 4);
      if (verbose && res.ip) o(`*   Trying ${res.ip}:${u.port}...`, 'dim');
      if (!res.ok) {
        const msg = tool === 'wget' ? ({ 'dns-timeout': `wget: bad address '${u.host}'`, nxdomain: `wget: bad address '${u.host}'`, refused: `wget: can't connect to remote host (${res.ip || u.host}): Connection refused`, timeout: 'wget: download timed out', empty: 'wget: error getting response: Connection reset by peer' }[res.kind])
          : ({ 'dns-timeout': `curl: (6) Could not resolve host: ${u.host}`, nxdomain: `curl: (6) Could not resolve host: ${u.host}`, refused: `curl: (7) Failed to connect to ${u.host} port ${u.port} after ${ms} ms: Couldn't connect to server`, timeout: `curl: (28) Failed to connect to ${u.host} port ${u.port} after ${ms} ms: Timeout was reached`, empty: 'curl: (52) Empty reply from server' }[res.kind]);
        o(msg || `curl: (7) Failed to connect to ${u.host} port ${u.port}`, 'err');
        if (res.kind === 'nxdomain' && src === c.TOOLBOX && u.host.split('.').length === 1 && c.list('Service').some(s => s.name === u.host)) o(`hint: short names resolve in the caller's namespace. This debug shell lives in "default"; use ${u.host}.<namespace>`, 'dim');
        if (res.kind === 'timeout' && !verbose) o('(curl gave up after its 5 second connect timeout)', 'dim');
        facts('fail'); facts(res.kind);
        return r();
      }
      if (res.tcp) { o('curl: (1) Received HTTP/0.9 when not allowed', 'err'); facts('fail'); return r(); }
      const reason = { 200: 'OK', 403: 'Forbidden', 404: 'Not Found', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Temporarily Unavailable', 504: 'Gateway Time-out' }[res.status] || '';
      if (tool === 'wget' && res.status >= 400) { o(`wget: server returned error: HTTP/1.1 ${res.status} ${reason}`, 'err'); facts('fail'); facts(String(res.status)); return r(); }
      const hdr = [`HTTP/1.1 ${res.status} ${reason}`, `date: ${new Date(c.baseTime).toUTCString()}`, `content-type: ${/^</.test(res.body || '') ? 'text/html' : 'application/json'}`, `content-length: ${(res.body || '').length}`];
      if (res.ingress) hdr.push('server: ingress-nginx');
      if (verbose) { o(`* Connected to ${u.host} (${res.ip || '203.0.113.10'}) port ${u.port}`, 'dim'); o(`> GET ${u.path} HTTP/1.1\n> Host: ${u.host}\n>`, 'dim'); hdr.forEach(h0 => o('< ' + h0, 'dim')); }
      else if (include || head) { hdr.forEach(h0 => o(h0)); o(''); }
      if (!head && out !== '/dev/null' && res.body != null) o(res.body, res.status < 400 ? 'ok' : '');
      if (wfmt) o(wfmt.replace(/%\{http_code\}/g, String(res.status)).replace(/\\n/g, ''));
      if (res.status >= 500 && res.why && res.ingress) this.fact('ingress-why:' + res.why);
      facts(String(res.status)); facts(res.status < 400 ? 'ok' : 'fail');
      if (res.pod) { this.fact(`curl:${host}:pod:${res.pod.name}`); if (res.status < 400) this.fact(`curl-ok:${c.workloadOf(res.pod)}`); }
      return r();
    }
    nslookup(args, o, r, src, tool, wl) {
      const c = this.c;
      const short = args.includes('+short');
      const name = args.filter(x => x[0] !== '-' && x[0] !== '+' && x[0] !== '@')[0];
      if (!name) { o(`usage: ${tool} NAME`, 'err'); return r(); }
      const res = c.resolveName(src, name);
      const facts = s => { this.fact(`nslookup:${name}:${s}`); if (wl) this.fact(`exec:${wl}:nslookup:${name}:${s}`); };
      const fq = n => (n.includes('.') && !/\.svc$/.test(n) ? n : `${n.split('.')[0]}.${res.svc ? res.svc.namespace : (src.ns || 'default')}.svc.cluster.local`);
      if (res.err === 'dns-timeout') {
        o(tool === 'dig' ? `;; communications error to ${K.CONST.DNS_IP}#53: timed out\n;; communications error to ${K.CONST.DNS_IP}#53: timed out\n;; no servers could be reached` : ';; connection timed out; no servers could be reached', 'err');
        facts('timeout'); return r();
      }
      if (res.err) {
        if (tool === 'dig') o(short ? '' : `;; ->>HEADER<<- opcode: QUERY, status: NXDOMAIN, id: ${K.sim.fnv1a(name) % 65535}\n;; QUESTION SECTION:\n;${name}.\t\tIN\tA`);
        else o(`Server:\t\t${K.CONST.DNS_IP}\nAddress:\t${K.CONST.DNS_IP}#53\n\n** server can't find ${name.includes('.') ? name : name + '.' + (src.ns || 'default') + '.svc.cluster.local'}: NXDOMAIN`, 'err');
        facts('nxdomain'); return r();
      }
      const ip = res.svc ? res.svc.clusterIP : res.pod ? res.pod.ip : '203.0.113.' + (10 + K.sim.fnv1a(name) % 200);
      const full = res.svc ? `${res.svc.name}.${res.svc.namespace}.svc.cluster.local` : res.external ? name : fq(name);
      if (tool === 'dig') o(short ? ip : `;; ANSWER SECTION:\n${full}.\t30\tIN\tA\t${ip}\n\n;; SERVER: ${K.CONST.DNS_IP}#53(${K.CONST.DNS_IP}) (UDP)`, 'ok');
      else o(`Server:\t\t${K.CONST.DNS_IP}\nAddress:\t${K.CONST.DNS_IP}#53\n\n${res.external ? 'Non-authoritative answer:\n' : ''}Name:\t${full}\nAddress: ${ip}`, 'ok');
      facts('ok');
      return r();
    }
  }

  const HELP = [
    'Everything below runs against a production-like cluster simulated in your browser.',
    '',
    'Triage          kubectl get pods -n <ns> [-o wide] [-A]       kubectl get events -n <ns> --sort-by=.lastTimestamp',
    '                kubectl describe <type> <name> -n <ns>        kubectl logs <pod> [-c container] [--previous]',
    '                kubectl top pods|nodes [--sort-by=memory]     kubectl get <type> <name> -o yaml',
    'Inside a pod    kubectl exec <pod> -n <ns> -- curl -s http://<svc>:<port>/<path>',
    '                kubectl exec <pod> -n <ns> -- nslookup <name>  | nc -zv <host> <port> | env | df -h | cat <file>',
    'Network         curl https://tickets.stagedoor.io/   (from outside)    curl <svc>.<ns>:<port>   nslookup <svc>.<ns>',
    '                kubectl get endpoints|ingress|networkpolicy -n <ns>',
    'Change things   kubectl set image|env|resources deployment/<name> ...    kubectl edit <type>/<name>  (then apply)',
    '                kubectl patch <type> <name> -p \'{"spec":{...}}\'          kubectl apply -f <file>',
    '                kubectl scale deployment <name> --replicas=N          kubectl rollout status|history|undo|restart deploy/<name>',
    '                kubectl delete <type> <name> [-l k=v] [--field-selector status.phase=Failed]',
    'Access          kubectl auth can-i <verb> <resource> -n <ns> --as=system:serviceaccount:<ns>:<sa>',
    '                kubectl create role|rolebinding|serviceaccount|secret docker-registry ...',
    'Nodes           kubectl cordon|uncordon|drain <node> --ignore-daemonsets     kubectl taint nodes <node> k=v:NoSchedule[-]',
    'Context         kubectl config set-context --current --namespace=<ns>       (or add -n <ns> to any command)',
    '',
    'Shell           ls  cat  edit <file>  cp  grep  wc  head  tail  base64 -d  > file',
    'Game            runbook (the triage loop)   hint (a nudge)   solution (reveals the command, costs a star)   clear',
    '',
    "Tips: 'k' is an alias for kubectl. Tab completes. ↑/↓ browse history. Click a pod or Service on the map to paste its name.",
  ].join('\n');
  const RUNBOOK = [
    'THE TRIAGE LOOP (Stagedoor SRE runbook, page 1)',
    '',
    '1. Confirm the symptom yourself.     curl the public URL; read the alert; check the SLO panel.',
    '2. Find what is unhealthy.           kubectl get pods -A | grep -v Running   ·   kubectl get deploy -n <ns>',
    '3. Ask Kubernetes why.               kubectl describe pod <pod>  → read State, Last State, Events (bottom)',
    '                                     kubectl get events -n <ns> --sort-by=.lastTimestamp',
    '4. Ask the app why.                  kubectl logs <pod> [--previous]  (previous = the container that crashed)',
    '5. Follow the request path.          Ingress → Service → Endpoints → Pod port → app → its dependencies',
    '                                     kubectl exec <pod> -- curl / nslookup / nc to see what the pod sees',
    '6. Mitigate first, then fix.         rollback, scale, or restore config. Then make the fix durable.',
    '7. Verify.                           Errors stop, pods Ready, restarts stop climbing, SLO recovers.',
    '',
    'Status cheat sheet',
    '  Pending ............... not scheduled: resources, taints, nodeSelector, PVC not bound, quota',
    '  ContainerCreating ..... scheduled; mounting volumes or pulling (check FailedMount events)',
    '  ImagePullBackOff ...... wrong tag, missing image, or registry auth (imagePullSecrets)',
    '  CreateContainerConfigError  a referenced ConfigMap/Secret or key is missing',
    '  CrashLoopBackOff ...... the app keeps exiting: logs --previous and Last State exit code',
    '  OOMKilled / 137 ....... memory limit exceeded (or the node ran out: SystemOOM)',
    '  Running 0/1 ........... readiness probe failing; pod gets no traffic',
    '  Init:0/1 .............. an init container is still waiting or failing (logs -c <init>)',
    '  Evicted ............... kubelet removed it under node pressure',
  ].join('\n');
  const KUBECTL_HELP = 'kubectl controls the Kubernetes cluster manager.\n\nBasic: get, describe, logs, exec, top, events\nDeploy: create, apply, edit, patch, set, rollout, scale, delete, label, annotate, expose, autoscale\nCluster: cordon, uncordon, drain, taint, auth, cluster-info, config\nOther: explain, api-resources, version\n\nUsage:\n  kubectl [command] [TYPE] [NAME] [flags]\n\nType "help" for examples, or "runbook" for the triage loop.';
  const EXPLAIN = {
    Pod: 'Pod is a collection of containers that can run on a host. This resource is created by clients and scheduled onto hosts.',
    Deployment: 'Deployment enables declarative updates for Pods and ReplicaSets.',
    ReplicaSet: 'ReplicaSet ensures that a specified number of pod replicas are running at any given time.',
    DaemonSet: 'DaemonSet represents the configuration of a daemon set.',
    Service: 'Service is a named abstraction of software service consisting of a port that the proxy listens on, and the selector that determines which pods will answer requests sent through the proxy.',
    Node: 'Node is a worker node in Kubernetes. Each node will have a unique identifier in the cache (i.e. in etcd).',
    Namespace: 'Namespace provides a scope for Names. Use of multiple namespaces is optional.',
    ConfigMap: 'ConfigMap holds configuration data for pods to consume.',
    Secret: 'Secret holds secret data of a certain type. The total bytes of the values in the Data field must be less than MaxSecretSize bytes. Values are base64-encoded, not encrypted.',
    Endpoints: 'Endpoints is a collection of endpoints that implement the actual service.',
    Event: 'Event is a report of an event somewhere in the cluster.',
    HorizontalPodAutoscaler: 'HorizontalPodAutoscaler is the configuration for a horizontal pod autoscaler, which automatically manages the replica count of any resource implementing the scale subresource based on the metrics specified.',
    Ingress: 'Ingress is a collection of rules that allow inbound connections to reach the endpoints defined by a backend. An Ingress can be configured to give services externally-reachable urls, load balance traffic, terminate SSL, offer name based virtual hosting etc.',
    NetworkPolicy: 'NetworkPolicy describes what network traffic is allowed for a set of Pods. Once a pod is selected by a policy for a direction, only traffic explicitly allowed by some policy is permitted in that direction.',
    ServiceAccount: 'ServiceAccount binds together: a name, understood by users, and perhaps by peripheral systems, for an identity; a principal that can be authenticated and authorized.',
    Role: 'Role is a namespaced, logical grouping of PolicyRules that can be referenced as a unit by a RoleBinding.',
    RoleBinding: 'RoleBinding references a role, but does not contain it. It adds who information via Subjects and namespace information by which namespace it exists in.',
    ClusterRole: 'ClusterRole is a cluster level, logical grouping of PolicyRules that can be referenced as a unit by a RoleBinding or ClusterRoleBinding.',
    ClusterRoleBinding: 'ClusterRoleBinding references a ClusterRole, but not contain it. It can reference a ClusterRole in the global namespace, and adds who information via Subject.',
    ResourceQuota: 'ResourceQuota sets aggregate quota restrictions enforced per namespace.',
    PersistentVolumeClaim: 'PersistentVolumeClaim is a user\'s request for and claim to a persistent volume.',
    PersistentVolume: 'PersistentVolume (PV) is a storage resource provisioned by an administrator or dynamically by a StorageClass.',
    StorageClass: 'StorageClass describes the parameters for a class of storage for which PersistentVolumes can be dynamically provisioned. allowVolumeExpansion controls whether claims can be resized.',
    PodDisruptionBudget: 'PodDisruptionBudget is an object to define the max disruption that can be caused to a collection of pods. Voluntary evictions (like kubectl drain) are refused when they would break it.',
  };
  const EXPLAIN_FIELDS = {
    'containers.livenessProbe': 'Periodic probe of container liveness. Container will be restarted if the probe fails.',
    'containers.readinessProbe': 'Periodic probe of container service readiness. Container will be removed from service endpoints if the probe fails.',
    'containers.startupProbe': 'StartupProbe indicates that the Pod has successfully initialized. If specified, no other probes are executed until this completes successfully. If this probe fails, the Pod will be restarted, just as if the livenessProbe failed. Use it for slow-starting containers.',
    'containers.resources': 'Compute Resources required by this container. requests are what the scheduler reserves; limits are enforced at runtime (CPU is throttled, memory over the limit is OOM-killed).',
    'containers.resources.limits': 'Limits describes the maximum amount of compute resources allowed. A container that exceeds its memory limit is killed (OOMKilled, exit code 137).',
    'containers.resources.requests': 'Requests describes the minimum amount of compute resources required. The scheduler only places a pod on a node with enough unrequested capacity.',
    tolerations: "If specified, the pod's tolerations. A toleration lets the pod schedule onto nodes with matching taints.",
    nodeSelector: "NodeSelector is a selector which must be true for the pod to fit on a node. Selector which must match a node's labels for the pod to be scheduled on that node.",
    imagePullSecrets: 'ImagePullSecrets is an optional list of references to secrets in the same namespace to use for pulling any of the images used by this PodSpec.',
    serviceAccountName: 'ServiceAccountName is the name of the ServiceAccount to use to run this pod. Its RBAC bindings decide what the pod may do through the API.',
    strategy: 'The deployment strategy to use to replace existing pods with new ones. RollingUpdate (default) or Recreate.',
    initContainers: 'List of initialization containers. They run to completion, in order, before the app containers start.',
  };

  /* completion candidates for the UI */
  function completions(game, line) {
    const words = line.split(/\s+/); const cur = words[words.length - 1];
    const before = words.slice(0, -1);
    const c = game.cluster;
    let cands;
    const isK = ['kubectl', 'k'].includes(before[0]);
    if (before.length === 0) cands = SHELL.concat(['kubectl']);
    else if (isK && before.length === 1) cands = VERBS;
    else if (isK && before.length === 2 && ['get', 'describe', 'delete', 'explain', 'edit', 'label', 'annotate', 'patch'].includes(before[1])) cands = ['pods', 'deployments', 'replicasets', 'services', 'endpoints', 'ingresses', 'networkpolicies', 'nodes', 'namespaces', 'configmaps', 'secrets', 'serviceaccounts', 'roles', 'rolebindings', 'clusterroles', 'clusterrolebindings', 'events', 'hpa', 'pvc', 'pv', 'storageclasses', 'resourcequotas', 'pdb', 'all'];
    else if (isK && before.length === 2 && before[1] === 'auth') cands = ['can-i', 'whoami'];
    else if (isK && before.length === 2 && before[1] === 'set') cands = ['image', 'env', 'resources', 'serviceaccount'];
    else if (isK && before.length === 2 && before[1] === 'rollout') cands = ['status', 'history', 'undo', 'restart', 'pause', 'resume'];
    else if (isK && before.length === 2 && before[1] === 'create') cands = ['deployment', 'namespace', 'serviceaccount', 'configmap', 'secret', 'role', 'rolebinding', 'clusterrole', 'clusterrolebinding', 'quota', 'poddisruptionbudget'];
    else if (cur.startsWith('-')) cands = ['--all-namespaces', '--show-labels', '--image=', '--replicas=', '--port=', '--target-port=', '--namespace=', '--selector=', '--field-selector=', '--from-literal=', '--ignore-daemonsets', '--delete-emptydir-data', '--force', '--dry-run=client', '--overwrite', '--previous', '--limits=', '--requests=', '--as=', '--list', '--verb=', '--resource=', '--role=', '--serviceaccount=', '--docker-server=', '--docker-username=', '--docker-password=', '--sort-by=', '--tail=', '--to-revision=', '--current', '-o', '-n', '-A', '-l', '-f', '-c', '-w', '-p'];
    else {
      const pref = cur.includes('/') ? cur.split('/')[0] + '/' : '';
      const nsList = Array.from(c.namespaces.keys());
      const base = [].concat(
        c.list('Pod').map(p => p.name), c.list('Deployment').map(d => d.name), c.list('Service').map(s => s.name), c.nodes.map(n => n.name), nsList,
        ['ConfigMap', 'Secret', 'Ingress', 'NetworkPolicy', 'ServiceAccount', 'Role', 'RoleBinding', 'PersistentVolumeClaim', 'ResourceQuota', 'PodDisruptionBudget', 'HorizontalPodAutoscaler', 'StorageClass'].reduce((acc, k) => acc.concat(c.list(k).map(x => x.name)), []),
        Array.from(game.files.keys()), ['curl', 'nslookup', 'env', 'cat', 'df', 'nc', 'deployment', 'generic', 'docker-registry', 'nodes', 'tickets.stagedoor.io']);
      cands = Array.from(new Set(base.map(x => pref + x)));
    }
    return cands.filter(x => x.startsWith(cur) && x !== cur);
  }

  K.Shell = Shell;
  K.shellUtil = { tokenize, parseArgs, human, table, completions, typeOf, TYPES };
})(window.K = window.K || {});

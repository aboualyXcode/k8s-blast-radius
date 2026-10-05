// prints what a player would see for each step's solution: node tests/transcript.js <id> [maxLines]
/* usage: node tests/transcript.js <incident-id> [maxLines] "kubectl get pods -A" "..." */
'use strict';
global.window = {};
['yaml', 'apps', 'engine', 'manifest', 'kubectl', 'game', 'levels'].forEach(f => require(require('path').join(__dirname, '..', 'js', f + '.js')));
const K = global.window.K;
const id = process.argv[2], max = Number(process.argv[3] || 40);
const g = new K.Game({ seed: 1 }); g.loadLevel(K.LEVELS.findIndex(l => l.id === id));
const run = l => { const r = g.run(l); console.log('$ ' + l); (r.lines || []).slice(0, max).forEach(x => console.log((x.c === 'err' ? '! ' : '  ') + x.t)); };
for (const extra of process.argv.slice(4)) run(extra);

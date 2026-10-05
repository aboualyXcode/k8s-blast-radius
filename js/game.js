/* game.js — runs an incident: owns the cluster, the shell, objectives, scoring and impact. No DOM here. */
(function (K) {
  'use strict';

  class Game {
    constructor(opts) {
      this.opts = opts || {};
      this.handlers = {};
      this.levels = K.LEVELS;
    }
    on(evt, fn) { (this.handlers[evt] = this.handlers[evt] || []).push(fn); return this; }
    emit(evt, data) { (this.handlers[evt] || []).forEach(fn => fn(data)); }

    loadLevel(index) {
      this.index = Math.max(0, Math.min(index, this.levels.length - 1));
      this.level = this.levels[this.index];
      this.cluster = new K.Cluster({ seed: this.opts.seed != null ? this.opts.seed + this.index : undefined });
      this.shell = new K.Shell(this);
      this.files = new Map();
      this.facts = new Map(); this.seq = 0;
      this.objIndex = 0; this.activatedAt = 0; this.steadyTicks = 0;
      this.revealed = new Set(); this.hinted = new Set();
      this.timers = []; this.state = {}; this.completed = false; this.feedback = null;
      this.level.setup(this.cluster, this);
      this.cluster.activity = K.Cluster.blankActivity();
      this.cluster.impact = { failed: 0, total: 0 };
      this.startTick = this.cluster.tickCount; this.endTick = null; this.commands = 0;
      this.emit('level', this.level);
    }

    /* facts: things the player has done */
    fact(name) {
      this.seq++;
      const f = this.facts.get(name) || { count: 0, seq: 0 };
      f.count++; f.seq = this.seq;
      this.facts.set(name, f);
      this.emit('fact', name);
    }
    has(name) { return this.facts.has(name); }
    since(name) { const f = this.facts.get(name); return !!f && f.seq > this.activatedAt; }
    count(name) { const f = this.facts.get(name); return f ? f.count : 0; }
    countPrefix(prefix) { let n = 0; this.facts.forEach((_, k) => { if (k.startsWith(prefix)) n++; }); return n; }
    match(re) { for (const k of this.facts.keys()) if (re.test(k)) return true; return false; }
    matchSince(re) { for (const [k, f] of this.facts) if (f.seq > this.activatedAt && re.test(k)) return true; return false; }

    after(ticks, fn) { this.timers.push({ at: this.cluster.tickCount + ticks, fn }); }
    page(title, body) { this.emit('page', { title, body }); }

    get objective() { return this.level.objectives[this.objIndex] || null; }
    get stars() { const n = this.revealed.size; return n === 0 ? 3 : n <= 2 ? 2 : 1; }
    get elapsed() { return ((this.endTick != null ? this.endTick : this.cluster.tickCount) - this.startTick) * K.CONST.TICK_SECONDS; }

    run(line) {
      const raw = line.trim();
      if (!raw) return { lines: [] };
      this.commands++;
      let res;
      if (raw === 'hint') res = this.hintLines();
      else if (raw === 'solution') res = this.solutionLines();
      else res = this.shell.exec(raw);
      this.check(false);
      return res;
    }
    hintLines() {
      const ob = this.objective;
      if (!ob) return { lines: [{ t: 'All objectives are done.', c: 'dim' }] };
      this.hinted.add(this.objIndex);
      return { lines: [{ t: 'Hint: ' + ob.hint, c: 'hint' }, { t: "Still stuck? Type 'solution' to see the command (costs a star).", c: 'dim' }] };
    }
    solutionCommand() {
      const ob = this.objective; if (!ob) return null;
      return typeof ob.cmd === 'function' ? ob.cmd(this.cluster, this) : ob.cmd;
    }
    reveal() { if (this.objective) { this.revealed.add(this.objIndex); this.emit('reveal', this.objIndex); } return this.solutionCommand(); }
    solutionLines() {
      const cmd = this.reveal();
      if (!cmd) return { lines: [{ t: 'All objectives are done.', c: 'dim' }] };
      const lines = cmd.split('\n');
      return { lines: lines.map((l, i) => ({ t: (i ? '     ' : 'Try: ') + l, c: 'hint' })), suggest: lines.find(l => l && !l.startsWith('(')) || null };
    }

    tick() {
      if (!this.cluster) return;
      this.cluster.step();
      const due = this.timers.filter(t => t.at <= this.cluster.tickCount);
      this.timers = this.timers.filter(t => t.at > this.cluster.tickCount);
      due.forEach(t => t.fn(this.cluster, this));
      if (this.level.onTick) this.level.onTick(this.cluster, this);
      this.check(true);
    }

    /* Objectives with `steady: n` must hold for n consecutive ticks, so a fix that flaps doesn't count. */
    check(fromTick) {
      if (this.completed) return;
      const ob = this.objective;
      if (!ob) return;
      let ok = false;
      try { ok = !!ob.check(this.cluster, this); } catch (e) { ok = false; }
      if (ob.steady) {
        if (fromTick) this.steadyTicks = ok ? this.steadyTicks + 1 : 0;
        else if (!ok) this.steadyTicks = 0;
        ok = ok && this.steadyTicks >= ob.steady;
      }
      if (ok) {
        const done = this.objIndex;
        this.objIndex++; this.steadyTicks = 0;
        this.activatedAt = this.seq;
        this.feedback = null;
        if (ob.onComplete) ob.onComplete(this.cluster, this);
        this.emit('objective', done);
        if (this.objIndex >= this.level.objectives.length) {
          this.completed = true; this.endTick = this.cluster.tickCount;
          this.emit('complete', { index: this.index, stars: this.stars, elapsed: this.elapsed, impact: Object.assign({}, this.cluster.impact) });
        }
      } else {
        let fb = null;
        try { fb = ob.feedback ? ob.feedback(this.cluster, this) : null; } catch (e) { fb = null; }
        if (!fb && ob.steady && this.steadyTicks > 0) fb = `Looking good. Holding steady for ${this.steadyTicks} of ${ob.steady} checks…`;
        if (fb !== this.feedback) { this.feedback = fb; this.emit('feedback', fb); }
      }
    }
  }

  K.Game = Game;
})(window.K = window.K || {});

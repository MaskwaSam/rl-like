/**
 * Sound: sampled where a real recording matters (engine, boost, impacts, goal), synthesised where
 * a clean tonal or noise sweep works better (jump/dodge whooshes, skid, wind, beeps). Samples are
 * CC0 assets listed in public/CREDITS.md; if one fails to load its synthesised stand-in plays
 * instead.
 *
 * Every layer is driven by what the player is doing, and there is no ambience: with no input and
 * the car at rest the mix is silent.
 *
 * An AudioContext can only start from a user gesture, so `start()` is called when the player
 * leaves the menu (a click or key press).
 */

export interface SoundFrame {
  /** Car speed in uu/s. */
  speedUU: number;
  /** Throttle input, -1..1. */
  throttle: number;
  boosting: boolean;
  /** True on the frame boost starts. */
  boostStarted: boolean;
  grounded: boolean;
  supersonic: boolean;
  jumped: boolean;
  doubleJumped: boolean;
  dodged: boolean;
  /** Vertical impact speed in uu/s on the frame the car lands, 0 otherwise. */
  landedSpeedUU: number;
  /** 0..1 tyre slip intensity (powerslide or sideways sliding). */
  skid: number;
  /** 0 = none, 1 = small pad, 2 = big pad. */
  padCollected: 0 | 1 | 2;
  /** Relative speed of a car-ball hit this frame in uu/s, 0 if none. */
  ballHitSpeedUU: number;
  /** Ball hitting the arena this frame, uu/s along the normal, 0 if none. */
  ballBounceSpeedUU: number;
  goal: boolean;
  /** Car hitting a wall this frame, uu/s, 0 if none. */
  wallHitSpeedUU: number;
  /** Car-car bump this frame, relative uu/s, 0 if none. */
  carBumpSpeedUU: number;
  /** Kickoff countdown: 1 = a number ticked, 2 = "go", 0 = nothing. */
  countdown: 0 | 1 | 2;
  /** Distance from the camera to the ball in metres, for hit attenuation. */
  ballDistance: number;
}

const SAMPLE_FILES = {
  engineLow: 'engine_low.wav',
  engineHigh: 'engine_high.wav',
  boostLoop: 'boost_loop.ogg',
  boostIgnite: 'boost_ignite.ogg',
  ballHit0: 'ball_hit_0.ogg',
  ballHit1: 'ball_hit_1.ogg',
  ballHit2: 'ball_hit_2.ogg',
  carHit0: 'car_hit_0.ogg',
  carHit1: 'car_hit_1.ogg',
  carHit2: 'car_hit_2.ogg',
  landHard: 'land_hard.ogg',
  landSoft: 'land_soft.ogg',
  goalCrunch: 'goal_crunch.ogg',
  goalBoom: 'goal_boom.ogg',
  padSmall: 'pad_small.ogg',
  padBig: 'pad_big.ogg',
  countTick: 'count_tick.ogg',
  countGo: 'count_go.ogg',
} as const;
type SampleName = keyof typeof SAMPLE_FILES;

interface NoiseLayer {
  filter: BiquadFilterNode;
  gain: GainNode;
}

interface Loop {
  src: AudioBufferSourceNode;
  gain: GainNode;
}

export class SoundManager {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfxBus!: GainNode;
  private readonly samples = new Map<SampleName, AudioBuffer>();
  private loading: Promise<void> | null = null;

  // Engine: two sampled loops crossfaded by rpm, or a synth fallback.
  private engineLow: Loop | null = null;
  private engineHigh: Loop | null = null;
  private engineSynthGain!: GainNode;
  private engineSynthFilter!: BiquadFilterNode;
  private engineOsc!: OscillatorNode;
  private engineOsc2!: OscillatorNode;
  private boostLoop: Loop | null = null;
  private boostNoise!: NoiseLayer;
  private roll!: NoiseLayer;
  private skid!: NoiseLayer;
  private wind!: NoiseLayer;
  private noiseBuffer!: AudioBuffer;
  private volume = 0.6;
  private lastHitAt = 0;
  private lastCarHitAt = 0;

  get started(): boolean {
    return this.ctx !== null;
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.ctx) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  /** Create the graph. Must be called from a user gesture the first time. */
  start(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    // Gentle limiter so stacked impacts do not clip.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.knee.value = 20;
    comp.ratio.value = 6;
    comp.attack.value = 0.003;
    comp.release.value = 0.15;
    this.master.connect(comp).connect(ctx.destination);
    this.sfxBus = ctx.createGain();
    this.sfxBus.connect(this.master);

    // Synth engine (fallback until samples arrive, or forever if they never do).
    this.engineSynthGain = ctx.createGain();
    this.engineSynthGain.gain.value = 0;
    this.engineSynthFilter = ctx.createBiquadFilter();
    this.engineSynthFilter.type = 'lowpass';
    this.engineSynthFilter.frequency.value = 500;
    this.engineSynthFilter.Q.value = 1.5;
    this.engineOsc = ctx.createOscillator();
    this.engineOsc.type = 'sawtooth';
    this.engineOsc.frequency.value = 55;
    this.engineOsc2 = ctx.createOscillator();
    this.engineOsc2.type = 'square';
    this.engineOsc2.frequency.value = 82;
    const osc2Gain = ctx.createGain();
    osc2Gain.gain.value = 0.35;
    this.engineOsc.connect(this.engineSynthFilter);
    this.engineOsc2.connect(osc2Gain).connect(this.engineSynthFilter);
    this.engineSynthFilter.connect(this.engineSynthGain).connect(this.sfxBus);
    this.engineOsc.start();
    this.engineOsc2.start();

    this.noiseBuffer = makeNoise(ctx, 1.0);
    this.boostNoise = this.noiseLayer('bandpass', 900, 0.7);
    this.roll = this.noiseLayer('lowpass', 220, 0.5);
    this.skid = this.noiseLayer('bandpass', 1400, 1.2);
    this.wind = this.noiseLayer('lowpass', 500, 0.4);

    this.loading = this.loadSamples();
  }

  private async loadSamples(): Promise<void> {
    const ctx = this.ctx!;
    const base = `${import.meta.env.BASE_URL}sounds/`;
    await Promise.all(
      (Object.keys(SAMPLE_FILES) as SampleName[]).map(async (name) => {
        try {
          const res = await fetch(base + SAMPLE_FILES[name]);
          if (!res.ok) return;
          const buf = await ctx.decodeAudioData(await res.arrayBuffer());
          this.samples.set(name, buf);
        } catch {
          /* keep the synth stand-in */
        }
      }),
    );
    // Start the sampled loops once decoded.
    const eLow = this.samples.get('engineLow');
    const eHigh = this.samples.get('engineHigh');
    if (eLow && eHigh) {
      this.engineLow = this.startLoop(eLow, this.sfxBus);
      this.engineHigh = this.startLoop(eHigh, this.sfxBus);
    }
    const boost = this.samples.get('boostLoop');
    if (boost) this.boostLoop = this.startLoop(boost, this.sfxBus);
  }

  private startLoop(buffer: AudioBuffer, bus: AudioNode): Loop {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(gain).connect(bus);
    src.start();
    return { src, gain };
  }

  private noiseLayer(type: BiquadFilterType, freq: number, q: number): NoiseLayer {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(filter).connect(gain).connect(this.sfxBus);
    src.start();
    return { filter, gain };
  }

  /** Play a one-shot sample with gain and playback-rate variation. Returns false if not loaded. */
  private play(name: SampleName, gain: number, rate = 1, bus: AudioNode = this.sfxBus, when = 0): boolean {
    const buf = this.samples.get(name);
    const ctx = this.ctx;
    if (!buf || !ctx) return false;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(bus);
    src.start(ctx.currentTime + when);
    return true;
  }

  private playAny(names: SampleName[], gain: number, rate = 1): boolean {
    return this.play(names[Math.floor(Math.random() * names.length)], gain, rate);
  }

  update(f: SoundFrame): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const ratio = Math.min(1, f.speedUU / 2300);
    const throttle = Math.abs(f.throttle);

    // Engine. Sampled: low loop for idle/cruise, high loop blended in with speed; pitch follows
    // speed and throttle like a CVT. Level is modest: the engine is a bed, not the lead.
    if (this.engineLow && this.engineHigh) {
      const rpm = 0.15 + 0.85 * ratio + 0.1 * throttle; // 0.15..1.1
      const rate = 0.7 + rpm * 0.9;
      this.engineLow.src.playbackRate.setTargetAtTime(rate, t, 0.08);
      this.engineHigh.src.playbackRate.setTargetAtTime(rate * 0.95, t, 0.08);
      // No constant idle term: standing still with no throttle is silent.
      const level = (0.12 * throttle + 0.07 * ratio) * (f.grounded ? 1 : 0.75);
      const blend = Math.min(1, Math.max(0, (ratio - 0.25) / 0.6));
      this.engineLow.gain.gain.setTargetAtTime(level * (1 - blend * 0.7), t, 0.08);
      this.engineHigh.gain.gain.setTargetAtTime(level * blend, t, 0.08);
      this.engineSynthGain.gain.setTargetAtTime(0, t, 0.05);
    } else {
      const targetFreq = 55 + 205 * ratio + 15 * throttle;
      this.engineOsc.frequency.setTargetAtTime(targetFreq, t, 0.08);
      this.engineOsc2.frequency.setTargetAtTime(targetFreq * 1.5, t, 0.08);
      this.engineSynthFilter.frequency.setTargetAtTime(350 + 1800 * ratio + 400 * throttle, t, 0.1);
      this.engineSynthGain.gain.setTargetAtTime((0.035 * throttle + 0.022 * ratio) * (f.grounded ? 1 : 0.7), t, 0.08);
    }

    // Tyres rolling on the floor: quiet low rumble that grows with speed, gone in the air.
    this.roll.gain.gain.setTargetAtTime(f.grounded ? 0.05 * Math.pow(ratio, 0.7) : 0, t, 0.08);
    this.roll.filter.frequency.setTargetAtTime(180 + 300 * ratio, t, 0.1);

    // Boost: sampled roar with a little noise on top for air; ignition burst on start.
    if (this.boostLoop) {
      // Release fast and land exactly on zero: setTargetAtTime only approaches its target, so a
      // tap used to leave the roar humming for half a second after the boost had stopped.
      const g = this.boostLoop.gain.gain;
      if (f.boosting) g.setTargetAtTime(0.45, t, 0.02);
      else if (g.value > 0.0005) {
        g.cancelScheduledValues(t);
        g.setValueAtTime(g.value, t);
        g.linearRampToValueAtTime(0, t + 0.05);
      }
      this.boostLoop.src.playbackRate.setTargetAtTime(0.9 + 0.3 * ratio, t, 0.1);
      this.boostNoise.gain.gain.setTargetAtTime(f.boosting ? 0.08 : 0, t, f.boosting ? 0.03 : 0.02);
    } else {
      this.boostNoise.gain.gain.setTargetAtTime(f.boosting ? 0.28 : 0, t, f.boosting ? 0.04 : 0.03);
    }
    this.boostNoise.filter.frequency.setTargetAtTime(700 + 900 * ratio, t, 0.1);
    if (f.boostStarted && !this.play('boostIgnite', 0.35, 1.4)) this.noiseBurst(0.12, 2500, 0.18, 'bandpass');

    // Skid while powersliding or sliding sideways.
    this.skid.gain.gain.setTargetAtTime(0.22 * f.skid, t, 0.05);
    this.skid.filter.frequency.setTargetAtTime(1100 + 700 * ratio, t, 0.1);

    // Supersonic wind.
    this.wind.gain.gain.setTargetAtTime(f.supersonic ? 0.12 : ratio > 0.8 ? 0.04 * (ratio - 0.8) * 5 : 0, t, 0.15);

    // RL's weighting: the first jump is the loud one, the second a lighter flick.
    if (f.jumped) {
      this.whoosh(420, 1500, 0.18, 0.4);
      this.thump(150, 0.09, 0.18);
    }
    if (f.doubleJumped) this.whoosh(900, 2100, 0.11, 0.13);
    if (f.dodged) {
      this.whoosh(300, 1800, 0.32, 0.26);
      this.thump(140, 0.08, 0.12);
    }
    if (f.landedSpeedUU > 0) {
      const k = Math.min(1, f.landedSpeedUU / 1200);
      if (k > 0.45) this.play('landHard', 0.25 + 0.45 * k, 0.8 + 0.2 * Math.random());
      else this.play('landSoft', 0.3 + 0.4 * k, 0.6 + 0.2 * Math.random());
      this.thump(70, 0.1 + 0.05 * k, 0.1 + 0.25 * k);
    }
    // Pad pickups are a background detail in RL, not an event: keep them barely there.
    if (f.padCollected === 2) {
      if (!this.play('padBig', 0.14, 1.3)) this.chime([784, 1047], 0.05, 0.06);
    } else if (f.padCollected === 1) {
      if (!this.play('padSmall', 0.07, 1.7)) this.chime([1175], 0.04, 0.035);
    }
    if (f.ballHitSpeedUU > 0 && t - this.lastHitAt > 0.05) {
      this.lastHitAt = t;
      const k = Math.min(1, f.ballHitSpeedUU / 3000);
      const att = 1 / (1 + f.ballDistance / 25);
      if (!this.playAny(['ballHit0', 'ballHit1', 'ballHit2'], (0.35 + 0.65 * k) * att, 0.75 + 0.25 * (1 - k))) this.ballHit(0.15 + 0.55 * k, 1 - 0.5 * k);
      this.thump(60, 0.14, 0.4 * k * att); // body of a hard hit
    }
    if (f.ballBounceSpeedUU > 200 && t - this.lastHitAt > 0.05) {
      this.lastHitAt = t;
      const k = Math.min(1, f.ballBounceSpeedUU / 3000);
      const att = 1 / (1 + f.ballDistance / 25);
      if (!this.playAny(['ballHit0', 'ballHit1', 'ballHit2'], (0.2 + 0.4 * k) * att, 0.6 + 0.2 * (1 - k))) this.ballHit(0.08 + 0.35 * k, 0.8 - 0.4 * k);
    }
    if (f.wallHitSpeedUU > 300 && t - this.lastCarHitAt > 0.08) {
      this.lastCarHitAt = t;
      const k = Math.min(1, f.wallHitSpeedUU / 2300);
      if (!this.playAny(['carHit0', 'carHit1', 'carHit2'], 0.25 + 0.6 * k, 0.8 + 0.3 * Math.random())) this.noiseBurst(0.12, 400, 0.5 * k);
      this.thump(90, 0.1, 0.25 * k);
    }
    if (f.carBumpSpeedUU > 0 && t - this.lastCarHitAt > 0.08) {
      this.lastCarHitAt = t;
      const k = Math.min(1, f.carBumpSpeedUU / 2300);
      if (!this.playAny(['carHit0', 'carHit1', 'carHit2'], 0.3 + 0.5 * k, 0.7 + 0.2 * Math.random())) this.noiseBurst(0.1, 500, 0.4 * k);
      this.thump(70, 0.13, 0.3 * k);
    }
    if (f.countdown === 1) {
      if (!this.play('countTick', 0.6, 1)) this.beep(880, 0.09, 0.18);
    } else if (f.countdown === 2) {
      if (!this.play('countGo', 0.7, 1)) this.beep(1320, 0.28, 0.2);
    }
    if (f.goal) {
      this.goalHorn();
      if (!this.play('goalCrunch', 0.7, 0.9)) this.explosion();
      this.play('goalBoom', 0.8, 1);
    }
  }

  /** A demolition: the heavy crunch plus a low boom, louder than any other impact. */
  demolition(): void {
    if (!this.ctx) return;
    if (!this.play('goalCrunch', 0.85, 0.75)) this.explosion();
    this.play('goalBoom', 0.6, 1.3);
    this.thump(52, 0.35, 0.45);
  }

  // ---------------------------------------------------------------------------
  // Synthesised one-shots (fallbacks and tonal layers)
  // ---------------------------------------------------------------------------

  private thump(freq: number, dur: number, gain: number): void {
    if (gain <= 0.001) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq * 2, t);
    osc.frequency.exponentialRampToValueAtTime(freq, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(g).connect(this.sfxBus);
    osc.start(t);
    osc.stop(t + dur);
  }

  private beep(freq: number, dur: number, gain: number): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = freq;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = freq * 3;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
    g.gain.setValueAtTime(gain, t + dur * 0.7);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(filter).connect(g).connect(this.sfxBus);
    osc.start(t);
    osc.stop(t + dur);
  }

  private noiseBurst(dur: number, filterFreq: number, gain: number, type: BiquadFilterType = 'lowpass'): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = filterFreq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(filter).connect(g).connect(this.sfxBus);
    src.start(t);
    src.stop(t + dur);
  }

  /** Air whoosh: band-passed noise whose centre sweeps up then fades. */
  private whoosh(fromHz: number, toHz: number, dur: number, gain: number): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 1.4;
    filter.frequency.setValueAtTime(fromHz, t);
    filter.frequency.exponentialRampToValueAtTime(toHz, t + dur * 0.55);
    filter.frequency.exponentialRampToValueAtTime(fromHz * 0.8, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + dur * 0.25);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(filter).connect(g).connect(this.sfxBus);
    src.start(t);
    src.stop(t + dur);
  }

  private ballHit(gain: number, pitchScale: number): void {
    this.noiseBurst(0.06, 1800 * pitchScale, gain * 0.8);
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(220 * pitchScale, t);
    osc.frequency.exponentialRampToValueAtTime(110 * pitchScale, t + 0.12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
    osc.connect(g).connect(this.sfxBus);
    osc.start(t);
    osc.stop(t + 0.14);
  }

  private chime(freqs: number[], step: number, gain: number): void {
    const ctx = this.ctx!;
    freqs.forEach((f, i) => {
      const t = ctx.currentTime + i * step;
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, t + step * 2.2);
      osc.connect(g).connect(this.sfxBus);
      osc.start(t);
      osc.stop(t + step * 2.3);
    });
  }

  private explosion(): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(900, t);
    filter.frequency.exponentialRampToValueAtTime(80, t + 0.7);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.8);
    src.connect(filter).connect(g).connect(this.sfxBus);
    src.start(t);
    src.stop(t + 0.8);
    this.thump(45, 0.5, 0.4);
  }

  private goalHorn(): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    for (const [f, delay] of [
      [196, 0],
      [247, 0.0],
      [294, 0.0],
      [392, 0.25],
    ] as [number, number][]) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = f;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 1200;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t + delay);
      g.gain.exponentialRampToValueAtTime(0.1, t + delay + 0.03);
      g.gain.setValueAtTime(0.1, t + delay + 0.6);
      g.gain.exponentialRampToValueAtTime(0.001, t + delay + 1.1);
      osc.connect(filter).connect(g).connect(this.sfxBus);
      osc.start(t + delay);
      osc.stop(t + delay + 1.15);
    }
  }
}

function makeNoise(ctx: AudioContext, seconds: number): AudioBuffer {
  const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

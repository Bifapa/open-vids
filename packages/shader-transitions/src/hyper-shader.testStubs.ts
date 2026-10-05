// Test doubles shared by the preview and engine-mode specs; never imported by the bundle.
import { vi } from "vitest";

type Vars = Record<string, unknown>;

interface Tween {
  kind: "set" | "fromTo" | "to";
  target: unknown;
  from?: Vars;
  vars: Vars;
  at: number;
}

const lengthOf = (tween: Tween): number =>
  typeof tween.vars.duration === "number" ? tween.vars.duration : 0;

// The slice of a paused GSAP timeline init() touches: tweens that report a duration, and
// a playhead that renders the scene opacity tweens onto the DOM.
export class FakeTimeline {
  // The timeline interface init() accepts is open-ended.
  [key: string]: unknown;
  private now = 0;
  private isPaused = true;
  private readonly tweens: Tween[] = [];
  private readonly calls: { fn: () => void; at: number }[] = [];

  constructor(private readonly opts: { onUpdate?: () => void } = {}) {}

  private render(time: number): void {
    for (const tween of this.tweens) {
      if (typeof tween.target !== "string" || time < tween.at) continue;
      const el = document.querySelector<HTMLElement>(tween.target);
      if (!el) continue;
      const to = Number(tween.vars.opacity);
      if (tween.kind === "set") {
        el.style.opacity = String(to);
        continue;
      }
      const from = Number(tween.from?.opacity);
      const span = lengthOf(tween);
      const progress = span === 0 ? 1 : Math.min(1, (time - tween.at) / span);
      el.style.opacity = String(from + (to - from) * progress);
    }
  }

  paused(): boolean {
    return this.isPaused;
  }

  duration(): number {
    return Math.max(
      0,
      ...this.tweens.map((tween) => tween.at + lengthOf(tween)),
      ...this.calls.map((call) => call.at),
    );
  }

  play(): this {
    this.isPaused = false;
    return this;
  }

  pause(): this {
    this.isPaused = true;
    return this;
  }

  time(t: number, suppressEvents?: boolean): this;
  time(): number;
  time(t?: number, suppressEvents = false): number | this {
    return t === undefined ? this.now : this.totalTime(t, suppressEvents);
  }

  totalTime(t: number, suppressEvents?: boolean): this;
  totalTime(): number;
  totalTime(t?: number, suppressEvents = false): number | this {
    if (t === undefined) return this.now;
    const from = this.now;
    this.now = t;
    this.render(t);
    if (!suppressEvents) {
      for (const { fn, at } of this.calls) {
        if ((from < at && at <= t) || (t < at && at <= from)) fn();
      }
    }
    this.opts.onUpdate?.();
    return this;
  }

  seek(position: number | string, suppressEvents?: boolean): this {
    this.time(Number(position), suppressEvents);
    return this;
  }

  call(fn: () => void, _args: null, at: number): this {
    this.calls.push({ fn, at });
    return this;
  }

  from(target: string, vars: Vars, at = 0): this {
    this.tweens.push({ kind: "fromTo", target, from: vars, vars: {}, at });
    return this;
  }

  set(target: string, vars: Vars, at = 0): this {
    this.tweens.push({ kind: "set", target, vars, at });
    return this;
  }

  to(target: Vars, vars: Vars, at: number): this {
    this.tweens.push({ kind: "to", target, vars, at });
    return this;
  }

  fromTo(target: string, from: Vars, vars: Vars, at = 0): this {
    this.tweens.push({ kind: "fromTo", target, from, vars, at });
    return this;
  }
}

export function stubGsap(): void {
  vi.stubGlobal("gsap", {
    timeline: (opts?: { onUpdate?: () => void }) => new FakeTimeline(opts),
    set: () => {},
    to: () => {},
    fromTo: () => {},
  });
}

/** A WebGL context whose every call succeeds; `calls` counts how often each method ran. */
export function stubWebGl(available: boolean): { calls: Map<string, number> } {
  vi.stubGlobal("CanvasRenderingContext2D", class {});
  const calls = new Map<string, number>();
  const gl = new Proxy(
    {},
    {
      get: (_target, key) => {
        if (key === "getShaderParameter" || key === "getProgramParameter") return () => true;
        if (key === "isContextLost") return () => false;
        return () => {
          calls.set(String(key), (calls.get(String(key)) ?? 0) + 1);
          return {};
        };
      },
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(((type: string) =>
    available && type === "webgl" ? gl : null) as HTMLCanvasElement["getContext"]);
  return { calls };
}

export function mountScenes(ids: string[], rootAttrs = ""): void {
  document.body.innerHTML = `<div data-composition-id="main" data-width="640" data-height="360" ${rootAttrs}>${ids
    .map((id) => `<div id="${id}" class="scene clip">${id}</div>`)
    .join("")}</div>`;
}

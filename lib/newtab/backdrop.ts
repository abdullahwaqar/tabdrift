/**
 * The page background: Paper's grain gradient shader, a picture, or a plain
 * color. One instance owns the #backdrop element for the life of the page.
 */
import {
    defaultObjectSizing,
    defaultPatternSizing,
    GrainGradientShapes,
    getShaderColorFromString,
    getShaderNoiseTexture,
    grainGradientFragmentShader,
    ShaderFitOptions,
    ShaderMount,
} from "@paper-design/shaders";
import { loadBackgroundImage } from "./image-store";
import type { GradientSettings, NewTabSettings } from "./settings";

/**
 * The blob shape in @paper-design/shaders 0.0.81 calls clamp(0., 1., x) with the arguments in the
 * wrong order (GLSL is clamp(x, min, max)). With min > max the result is undefined, so some GPUs draw
 * the blob and others draw nothing. min(1., x) is what it means (x is a length, never negative).
 * The replacement only touches that exact call, so it does nothing once the upstream shader is fixed.
 */
const FRAGMENT_SHADER = grainGradientFragmentShader.replaceAll("clamp(0., 1., length(", "min(1., length(");

/** Shapes drawn as one centered object. The rest are repeating patterns. */
const OBJECT_SHAPES = new Set(["corners", "ripple", "blob", "sphere"]);

/**
 * Animation time is taken from the wall clock (wrapped to this period), so
 * every new tab picks up the motion where the last one left it instead of
 * restarting from the same frame.
 */
const TIME_PERIOD_MS = 20 * 60 * 1000;

/**
 * The gradient drifts slowly, so drawing it on every screen refresh (60 to 144 times a second) is
 * wasted GPU work. Frames are drawn at most this often instead.
 */
const MAX_FPS = 30;

/**
 * Upper bound on pixels shaded per frame. The gradient is soft and grainy, so on very large or
 * high-density screens it is drawn a little below full resolution and scaled up, which looks the same
 * and costs a fraction of the work. 2560x1600 covers a 1440p screen at full resolution.
 */
const MAX_PIXELS = 2560 * 1600;

/** With no mouse or keyboard activity for this long, the gradient stops moving until there is some. */
const IDLE_MS = 60 * 1000;

/** Where each color of the stand-in gradient sits: x %, y %, and how far it spreads. */
const SPOTS: [number, number, number][] = [
    [18, 22, 62],
    [82, 28, 58],
    [72, 84, 64],
    [22, 80, 56],
    [52, 48, 46],
    [94, 62, 42],
    [6, 52, 42],
];

/**
 * A still, plain CSS look-alike of the gradient. Starting the WebGL shader (context, compile, first
 * frame) takes a moment, and this is what fills the page until it is ready, or for good if WebGL isn't there.
 */
function standInGradient(g: GradientSettings): string {
    const spots = g.colors.map((color, i) => {
        const [x, y, size] = SPOTS[i % SPOTS.length] ?? [50, 50, 50];
        return `radial-gradient(circle at ${x}% ${y}%, ${color} 0, transparent ${size}%)`;
    });
    return [...spots, g.colorBack].join(", ");
}

function nextFrames(count: number): Promise<void> {
    return new Promise((resolve) => {
        const step = (left: number) => (left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1)));
        step(count);
    });
}

type Background = NewTabSettings["background"];

export class Backdrop {
    private readonly root: HTMLElement;
    private readonly standInEl: HTMLDivElement;
    private readonly shaderEl: HTMLDivElement;
    private readonly imageEl: HTMLDivElement;
    private mount: ShaderMount | null = null;
    private noise: HTMLImageElement | null = null;
    private shaderFailed = false;
    private imageUrl: string | null = null;
    private loadedImageVersion = -1;
    private reducedMotion: MediaQueryList;
    private current: Background | null = null;
    /** Bumped on every apply, so a slow image load can't overwrite a newer choice. */
    private generation = 0;
    /** Animation time in ms, advanced by our own frame loop rather than the shader's. */
    private frame = 0;
    private animSpeed = 0;
    private lastTick = 0;
    private tickTimer: ReturnType<typeof setTimeout> | null = null;
    private tickFrame: number | null = null;
    private lastActivity = performance.now();
    /** Set while something covers the page (the search overlay), so there is nothing to see moving. */
    private held = false;

    constructor(root: HTMLElement) {
        this.root = root;
        this.standInEl = document.createElement("div");
        this.standInEl.className = "backdrop-layer backdrop-fallback";
        this.shaderEl = document.createElement("div");
        this.shaderEl.className = "backdrop-layer backdrop-shader";
        this.imageEl = document.createElement("div");
        this.imageEl.className = "backdrop-layer backdrop-image";
        root.append(this.standInEl, this.shaderEl, this.imageEl);

        this.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
        this.reducedMotion.addEventListener("change", () => {
            if (this.current?.mode === "gradient") {
                this.animSpeed = this.effectiveSpeed(this.current.gradient);
                this.syncAnimation();
            }
        });
        // Only animate while someone can be looking at it: the tab is showing and its window has focus.
        // A new tab left open behind other windows, or on another screen while you work elsewhere, holds still.
        document.addEventListener("visibilitychange", () => this.syncAnimation());
        window.addEventListener("focus", () => this.syncAnimation());
        window.addEventListener("blur", () => this.syncAnimation());
        const onActivity = () => {
            this.lastActivity = performance.now();
            if (this.tickTimer === null && this.tickFrame === null) {
                this.syncAnimation();
            }
        };
        for (const type of ["pointermove", "pointerdown", "keydown", "wheel", "focus"]) {
            window.addEventListener(type, onActivity, { passive: true, capture: true });
        }
    }

    /** True when the system asks for less motion. The gradient then holds still whatever its speed. */
    get motionReduced(): boolean {
        return this.reducedMotion.matches;
    }

    /** True if WebGL 2 isn't available, so the animated gradient can't be drawn. */
    get gradientUnavailable(): boolean {
        return this.shaderFailed;
    }

    async apply(bg: Background): Promise<void> {
        const generation = ++this.generation;
        this.current = bg;
        this.root.dataset.mode = bg.mode;

        if (bg.mode === "solid") {
            this.root.style.backgroundColor = bg.solid;
            this.show();
            this.pauseShader();
            return;
        }

        if (bg.mode === "image") {
            this.root.style.backgroundColor = "#101014";
            this.pauseShader();
            this.imageEl.style.setProperty("--dim", String(bg.imageDim));
            this.imageEl.style.setProperty("--blur", `${bg.imageBlur}px`);
            const url = await this.imageFor(bg.imageVersion);
            if (generation !== this.generation) {
                return;
            }
            this.imageEl.style.backgroundImage = url ? `url("${url}")` : "";
            this.show(...(url ? [this.imageEl] : []));
            return;
        }

        this.root.style.backgroundColor = bg.gradient.colorBack;
        this.standInEl.style.background = standInGradient(bg.gradient);
        const shaderShown = this.shaderEl.classList.contains("visible");
        if (!shaderShown) {
            // Colors on screen right away. The shader takes over once it has drawn its first frame.
            this.show(this.standInEl);
        }

        await this.applyGradient();
        if (generation !== this.generation || !this.mount || shaderShown) {
            return;
        }
        await nextFrames(2);
        if (generation !== this.generation) {
            return;
        }
        this.show(this.standInEl, this.shaderEl);
    }

    private show(...layers: HTMLElement[]) {
        for (const el of [this.standInEl, this.shaderEl, this.imageEl]) {
            el.classList.toggle("visible", layers.includes(el));
        }
    }

    private pauseShader() {
        this.syncAnimation();
    }

    /** Freezes the gradient while something covers the page, and lets it move again after. */
    hold(on: boolean) {
        this.held = on;
        if (!on) {
            this.lastActivity = performance.now();
        }
        this.syncAnimation();
    }

    private shouldAnimate(): boolean {
        return (
            this.mount !== null &&
            this.current?.mode === "gradient" &&
            this.animSpeed > 0 &&
            !this.held &&
            !document.hidden &&
            document.hasFocus() &&
            performance.now() - this.lastActivity < IDLE_MS
        );
    }

    /** Starts or stops the frame loop to match shouldAnimate(). */
    private syncAnimation() {
        if (!this.shouldAnimate()) {
            if (this.tickTimer !== null) {
                clearTimeout(this.tickTimer);
                this.tickTimer = null;
            }
            if (this.tickFrame !== null) {
                cancelAnimationFrame(this.tickFrame);
                this.tickFrame = null;
            }
            return;
        }
        if (this.tickTimer === null && this.tickFrame === null) {
            this.lastTick = performance.now();
            this.scheduleTick();
        }
    }

    /**
     * Waits out most of the frame interval with a timer, so the browser can idle in between,
     * then draws in the next animation frame so the update lines up with the screen.
     */
    private scheduleTick() {
        this.tickTimer = setTimeout(
            () => {
                this.tickTimer = null;
                this.tickFrame = requestAnimationFrame(this.tick);
            },
            1000 / MAX_FPS - 8,
        );
    }

    private tick = (now: number) => {
        this.tickFrame = null;
        if (!this.shouldAnimate() || !this.mount) {
            return;
        }
        this.frame += (now - this.lastTick) * this.animSpeed;
        this.lastTick = now;
        this.mount.setFrame(this.frame);
        this.scheduleTick();
    };

    private effectiveSpeed(g: GradientSettings): number {
        return this.reducedMotion.matches ? 0 : g.speed;
    }

    private uniformsFor(g: GradientSettings, noise: HTMLImageElement) {
        const sizing = OBJECT_SHAPES.has(g.shape) ? defaultObjectSizing : defaultPatternSizing;
        return {
            u_colorBack: getShaderColorFromString(g.colorBack),
            u_colors: g.colors.map((c) => getShaderColorFromString(c)),
            u_colorsCount: g.colors.length,
            u_softness: g.softness,
            u_intensity: g.intensity,
            u_noise: g.noise,
            u_shape: GrainGradientShapes[g.shape],
            u_noiseTexture: noise,
            u_fit: ShaderFitOptions[sizing.fit],
            u_scale: g.scale,
            u_rotation: g.rotation,
            u_offsetX: sizing.offsetX,
            u_offsetY: sizing.offsetY,
            u_originX: sizing.originX,
            u_originY: sizing.originY,
            u_worldWidth: sizing.worldWidth,
            u_worldHeight: sizing.worldHeight,
        };
    }

    private async noiseTexture(): Promise<HTMLImageElement | null> {
        if (this.noise) {
            return this.noise;
        }
        const img = getShaderNoiseTexture();
        if (!img) {
            return null;
        }
        // The shader refuses images that haven't finished loading.
        await img.decode();
        this.noise = img;
        return img;
    }

    private async applyGradient() {
        if (this.shaderFailed) {
            return;
        }
        const noise = await this.noiseTexture();
        if (!noise) {
            this.shaderFailed = true;
            return;
        }
        if (!this.mount) {
            // Starting the shader compiles it on the main thread, which can take a while on some GPU
            // drivers. Let the page, with its stand-in gradient, reach the screen first.
            await nextFrames(2);
        }
        // Use the latest choice: it may have changed, or moved on to a picture, while we waited.
        const g = this.current?.mode === "gradient" ? this.current.gradient : null;
        if (!g) {
            return;
        }
        const uniforms = this.uniformsFor(g, noise);
        const wasStill = this.animSpeed === 0;
        this.animSpeed = this.effectiveSpeed(g);

        if (this.mount) {
            if (this.animSpeed === 0) {
                // A still gradient always shows the same frame, whatever moment it was stopped at.
                this.frame = 0;
                this.mount.setFrame(0);
            } else if (wasStill) {
                this.frame = (Date.now() % TIME_PERIOD_MS) * this.animSpeed;
            }
            this.mount.setUniforms(uniforms);
            this.syncAnimation();
            return;
        }

        try {
            // A moving gradient starts from the wall clock, so each new tab picks up where the last one was.
            this.frame = this.animSpeed === 0 ? 0 : (Date.now() % TIME_PERIOD_MS) * this.animSpeed;
            // Speed 0: the shader never runs its own frame loop. Ours (above) draws at MAX_FPS, only when visible.
            // minPixelRatio 1: Paper's default of 2 draws four times the pixels on a standard screen.
            this.mount = new ShaderMount(
                this.shaderEl,
                FRAGMENT_SHADER,
                uniforms,
                { alpha: false, premultipliedAlpha: false, antialias: false, powerPreference: "low-power" },
                0,
                this.frame,
                1,
                MAX_PIXELS,
            );
        } catch (err) {
            console.error("[tabdrift] grain gradient unavailable:", err);
            this.shaderFailed = true;
            this.mount = null;
        }
        this.syncAnimation();
    }

    /** Object URL for the stored picture, reloaded only when a different one was saved. */
    private async imageFor(version: number): Promise<string | null> {
        if (version === this.loadedImageVersion) {
            return this.imageUrl;
        }
        const blob = version > 0 ? await loadBackgroundImage().catch(() => null) : null;
        if (this.imageUrl) {
            URL.revokeObjectURL(this.imageUrl);
        }
        this.imageUrl = blob ? URL.createObjectURL(blob) : null;
        this.loadedImageVersion = version;
        return this.imageUrl;
    }
}

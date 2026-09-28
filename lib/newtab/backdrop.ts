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

const FRAGMENT_SHADER = grainGradientFragmentShader.replaceAll("clamp(0., 1., length(", "min(1., length(");

/** Shapes drawn as one centered object. The rest are repeating patterns. */
const OBJECT_SHAPES = new Set(["corners", "ripple", "blob", "sphere"]);

/**
 * Animation time is taken from the wall clock (wrapped to this period), so
 * every new tab picks up the motion where the last one left it instead of
 * restarting from the same frame.
 */
const TIME_PERIOD_MS = 20 * 60 * 1000;

type Background = NewTabSettings["background"];

export class Backdrop {
    private readonly root: HTMLElement;
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

    constructor(root: HTMLElement) {
        this.root = root;
        this.shaderEl = document.createElement("div");
        this.shaderEl.className = "backdrop-layer backdrop-shader";
        this.imageEl = document.createElement("div");
        this.imageEl.className = "backdrop-layer backdrop-image";
        root.append(this.shaderEl, this.imageEl);

        this.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
        this.reducedMotion.addEventListener("change", () => {
            if (this.current?.mode === "gradient" && this.mount) {
                this.mount.setSpeed(this.effectiveSpeed(this.current.gradient));
            }
        });
    }

    /** True when the system asks for less motion. The gradient then holds still whatever its speed. */
    get motionReduced(): boolean {
        return this.reducedMotion.matches;
    }

    /** True if WebGL 2 isn't available, so the gradient can't be drawn. */
    get gradientUnavailable(): boolean {
        return this.shaderFailed;
    }

    async apply(bg: Background): Promise<void> {
        const generation = ++this.generation;
        this.current = bg;
        this.root.dataset.mode = bg.mode;

        if (bg.mode === "solid") {
            this.root.style.backgroundColor = bg.solid;
            this.showLayer(null);
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
            this.showLayer(url ? this.imageEl : null);
            return;
        }

        this.root.style.backgroundColor = bg.gradient.colorBack;
        await this.applyGradient(bg.gradient);
        if (generation !== this.generation) {
            return;
        }
        this.showLayer(this.mount ? this.shaderEl : null);
    }

    private showLayer(layer: HTMLElement | null) {
        for (const el of [this.shaderEl, this.imageEl]) {
            el.classList.toggle("visible", el === layer);
        }
    }

    private pauseShader() {
        this.mount?.setSpeed(0);
    }

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

    private async applyGradient(g: GradientSettings) {
        if (this.shaderFailed) {
            return;
        }
        const noise = await this.noiseTexture();
        if (!noise) {
            this.shaderFailed = true;
            return;
        }
        const uniforms = this.uniformsFor(g, noise);
        const speed = this.effectiveSpeed(g);

        if (this.mount) {
            this.mount.setUniforms(uniforms);
            this.mount.setSpeed(speed);
            return;
        }

        try {
            // The wall-clock start frame only matters while it moves. A still gradient always shows frame 0.
            const frame = speed === 0 ? 0 : (Date.now() % TIME_PERIOD_MS) * speed;
            this.mount = new ShaderMount(this.shaderEl, FRAGMENT_SHADER, uniforms, { alpha: false, premultipliedAlpha: false }, speed, frame);
        } catch (err) {
            console.error("[tabdrift] grain gradient unavailable:", err);
            this.shaderFailed = true;
            this.mount = null;
        }
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

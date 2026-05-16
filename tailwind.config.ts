import type { Config } from "tailwindcss";

// Tailwind extends mapped to the M3 CSS variables in app/globals.css.
// Using `<alpha-value>` lets utilities like `bg-primary/10` still work on
// var-backed colors via Tailwind's modern CSS variable color syntax.
const m3Color = (name: string) => `rgb(from var(--md-${name}) r g b / <alpha-value>)`;

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        primary: m3Color("primary"),
        "on-primary": m3Color("on-primary"),
        "primary-container": m3Color("primary-container"),
        "on-primary-container": m3Color("on-primary-container"),
        secondary: m3Color("secondary"),
        "on-secondary": m3Color("on-secondary"),
        "secondary-container": m3Color("secondary-container"),
        "on-secondary-container": m3Color("on-secondary-container"),
        tertiary: m3Color("tertiary"),
        "on-tertiary": m3Color("on-tertiary"),
        error: m3Color("error"),
        "on-error": m3Color("on-error"),
        "error-container": m3Color("error-container"),
        "on-error-container": m3Color("on-error-container"),
        background: m3Color("background"),
        "on-background": m3Color("on-background"),
        surface: m3Color("surface"),
        "on-surface": m3Color("on-surface"),
        "surface-variant": m3Color("surface-variant"),
        "on-surface-variant": m3Color("on-surface-variant"),
        outline: m3Color("outline"),
        "outline-variant": m3Color("outline-variant"),
        "surface-lowest": m3Color("surface-container-lowest"),
        "surface-low": m3Color("surface-container-low"),
        "surface-container": m3Color("surface-container"),
        "surface-high": m3Color("surface-container-high"),
        "surface-highest": m3Color("surface-container-highest"),
        brand: "var(--md-brand)", // decorative; no alpha math needed
      },
      borderRadius: {
        "m3-xs": "4px",
        "m3-sm": "8px",
        "m3-md": "12px",
        "m3-lg": "16px",
        "m3-xl": "28px",
      },
      boxShadow: {
        // M3 elevations 1–3, tuned for light surfaces. Dark mode falls back to
        // tonal surface colors carrying the elevation cue.
        "m3-1": "0 1px 2px 0 rgb(0 0 0 / 0.08), 0 1px 3px 1px rgb(0 0 0 / 0.06)",
        "m3-2": "0 1px 2px 0 rgb(0 0 0 / 0.10), 0 2px 6px 2px rgb(0 0 0 / 0.08)",
        "m3-3": "0 4px 8px 3px rgb(0 0 0 / 0.08), 0 1px 3px 0 rgb(0 0 0 / 0.08)",
      },
      fontFamily: {
        sans: ["var(--font-inter)", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};

export default config;

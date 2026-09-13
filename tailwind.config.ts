import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "#0A0A12",
        navy: {
          DEFAULT: "#0F1224",
          deep: "#0A0A12",
          mid: "#12162A",
          surface: "#161A2E",
          elevated: "#1C2140",
        },
        violet: {
          DEFAULT: "#7B6EF6",
          soft: "#9B8CFF",
          deep: "#5B4FDB",
          glow: "#6C5CE7",
          signal: "#8B7CFF",
        },
        chalk: {
          DEFAULT: "#E8E6F2",
          muted: "#9B98B0",
          faint: "#6B6880",
        },
        success: "#4ADE80",
        danger: "#F87171",
        accent: {
          receive: "#60A5FA",
          request: "#FBBF24",
          exchange: "#A78BFA",
          withdraw: "#34D399",
        },
      },
      fontFamily: {
        sans: ["var(--font-numans)", "system-ui", "sans-serif"],
        display: [
          "var(--font-numans)",
          "system-ui",
          "sans-serif",
        ],
        mono: [
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Monaco",
          "Consolas",
          "Liberation Mono",
          "Courier New",
          "monospace",
        ],
      },

      borderRadius: {
        pill: "9999px",
        card: "1.25rem",
        glass: "1.5rem",
      },
      boxShadow: {
        glass: "0 8px 32px rgba(10, 10, 18, 0.45)",
        "glass-soft": "0 4px 24px rgba(108, 92, 231, 0.12)",
        bloom: "0 8px 28px rgba(123, 110, 246, 0.35)",
        "violet-glow": "0 0 24px rgba(123, 110, 246, 0.45)",
      },
      backgroundImage: {
        "violet-gradient":
          "linear-gradient(135deg, #9B8CFF 0%, #7B6EF6 45%, #5B4FDB 100%)",
        "mesh-ambient":
          "radial-gradient(ellipse 80% 60% at 50% 0%, rgba(123, 110, 246, 0.35) 0%, transparent 60%), radial-gradient(ellipse 60% 50% at 80% 80%, rgba(91, 79, 219, 0.25) 0%, transparent 55%), radial-gradient(ellipse 50% 40% at 15% 70%, rgba(108, 92, 231, 0.2) 0%, transparent 50%)",
        "gradient-rim":
          "linear-gradient(135deg, rgba(155, 140, 255, 0.9), rgba(91, 79, 219, 0.4), rgba(155, 140, 255, 0.7))",
      },
      transitionTimingFunction: {
        sleek: "cubic-bezier(0.32, 0.72, 0, 1)",
      },
      keyframes: {
        "pulse-dot": {
          "0%, 100%": { opacity: "0.4", transform: "scale(0.9)" },
          "50%": { opacity: "1", transform: "scale(1)" },
        },
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
      },
      animation: {
        "pulse-dot": "pulse-dot 2.4s cubic-bezier(0.32, 0.72, 0, 1) infinite",
        shimmer: "shimmer 2.2s cubic-bezier(0.32, 0.72, 0, 1) infinite",
      },
    },
  },
  plugins: [],
};

export default config;

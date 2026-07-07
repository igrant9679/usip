import React, { createContext, useContext, useEffect, useState } from "react";

type Theme = "light" | "dark";

/**
 * Selectable colour palettes. Each maps to a `data-theme` attribute on <html>
 * whose CSS variables live in index.css ("Theme presets"). "teal" is the
 * original default and applies NO attribute. `swatch` is the representative
 * colour shown in pickers.
 */
export const PALETTES = [
  { id: "teal", label: "Teal", swatch: "#14B89A" },
  { id: "indigo", label: "Indigo", swatch: "#4F46E5" },
  { id: "violet", label: "Violet", swatch: "#8B5CF6" },
  { id: "rose", label: "Rose", swatch: "#E11D48" },
  { id: "amber", label: "Amber", swatch: "#F59E0B" },
  { id: "ocean", label: "Ocean", swatch: "#0284C7" },
  { id: "graphite", label: "Graphite", swatch: "#475569" },
] as const;
export type PaletteId = (typeof PALETTES)[number]["id"];

interface ThemeContextType {
  theme: Theme;
  toggleTheme?: () => void;
  switchable: boolean;
  palette: PaletteId;
  setPalette: (p: PaletteId) => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

interface ThemeProviderProps {
  children: React.ReactNode;
  defaultTheme?: Theme;
  switchable?: boolean;
}

const isPalette = (v: string | null): v is PaletteId =>
  !!v && PALETTES.some((p) => p.id === v);

export function ThemeProvider({
  children,
  defaultTheme = "light",
  switchable = false,
}: ThemeProviderProps) {
  const [theme, setTheme] = useState<Theme>(() => {
    if (switchable) {
      const stored = localStorage.getItem("theme");
      return (stored as Theme) || defaultTheme;
    }
    return defaultTheme;
  });

  const [palette, setPaletteState] = useState<PaletteId>(() => {
    const stored = localStorage.getItem("palette");
    return isPalette(stored) ? stored : "teal";
  });

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "dark") {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }

    if (switchable) {
      localStorage.setItem("theme", theme);
    }
  }, [theme, switchable]);

  useEffect(() => {
    const root = document.documentElement;
    // Default teal = no attribute (keeps the original stylesheet untouched).
    if (palette === "teal") delete root.dataset.theme;
    else root.dataset.theme = palette;
    localStorage.setItem("palette", palette);
  }, [palette]);

  const toggleTheme = switchable
    ? () => {
        setTheme(prev => (prev === "light" ? "dark" : "light"));
      }
    : undefined;

  const setPalette = (p: PaletteId) => setPaletteState(p);

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme, switchable, palette, setPalette }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within ThemeProvider");
  }
  return context;
}

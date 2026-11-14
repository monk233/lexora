import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { messages as en } from "./messages.en";
import { messages as zh } from "./messages.zh";

/* React i18n runtime. Behaviour intentionally mirrors the legacy
 * `web/shared/i18n.js` (LP.t / LP.i18n.applyStatic) so migrated windows keep the
 * exact same strings:
 *   lookup current locale -> fall back to en -> fall back to the key itself;
 *   `{name}` is replaced only when the key exists in params, unknown
 *   placeholders stay literal.
 */

export type Locale = "zh" | "en";
export type TParams = Record<string, string | number>;

const packs: Record<Locale, Record<string, string>> = { zh, en };

/** Match a BCP-47 tag against the supported locales; unsupported tags match nothing. */
function matchLocale(value: unknown): Locale | undefined {
  const raw = String(value ?? "")
    .trim()
    .toLowerCase();
  if (raw.startsWith("zh")) return "zh";
  if (raw.startsWith("en")) return "en";
  return undefined;
}

/** Map any BCP-47 tag onto a supported locale; unsupported tags become "en". */
export function normalizeLocale(value: unknown): Locale {
  return matchLocale(value) ?? "en";
}

function interpolate(text: string, params?: TParams): string {
  if (!params) return text;
  return text.replace(/\{([a-zA-Z0-9_]+)\}/g, (match: string, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
  );
}

/* Own-property lookup: prototype members such as `constructor`, `toString` or
 * `__proto__` must never resolve to a message, they fall through to the key. */
function lookup(locale: Locale, key: string): string | undefined {
  const pack = packs[locale];
  return Object.prototype.hasOwnProperty.call(pack, key) ? pack[key] : undefined;
}

/** Resolve `key` for `locale`, falling back to en and then to the key itself. */
export function translate(locale: Locale, key: string, params?: TParams): string {
  const text = lookup(locale, key) ?? lookup("en", key);
  if (text === undefined) return String(key);
  return interpolate(String(text), params);
}

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string, params?: TParams) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({
  initialLocale,
  children,
}: {
  initialLocale: Locale;
  children: ReactNode;
}) {
  const [locale, setLocaleState] = useState<Locale>(() => normalizeLocale(initialLocale));
  /* Unsupported input is ignored rather than coerced, matching legacy
   * LP.i18n.setLocale, which no-ops when normalize() returns "". */
  const setLocale = useCallback((next: Locale) => {
    const resolved = matchLocale(next);
    if (resolved) setLocaleState(resolved);
  }, []);
  const t = useCallback((key: string, params?: TParams) => translate(locale, key, params), [locale]);
  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);

  /* Render stays side-effect free: the document language is synced after commit. */
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
  }, [locale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useT(): I18nContextValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useT must be used inside I18nProvider");
  return value;
}

/* For non-React content (markdown output, imperative panels). Mirrors
 * LP.i18n.applyStatic from web/shared/i18n.js: text, title, aria-label and
 * placeholder are all translated in place. `data-i18n-html` is deliberately not
 * ported: innerHTML from message packs is unnecessary XSS surface. */
export function applyStaticToDom(root: ParentNode, t: (key: string) => string): void {
  root.querySelectorAll("[data-i18n]").forEach((node) => {
    const key = node.getAttribute("data-i18n");
    if (key) node.textContent = t(key);
  });
  root
    .querySelectorAll("[data-i18n-title], [data-i18n-aria-label], [data-i18n-placeholder]")
    .forEach((node) => {
      const titleKey = node.getAttribute("data-i18n-title");
      if (titleKey) node.setAttribute("title", t(titleKey));
      const ariaKey = node.getAttribute("data-i18n-aria-label");
      if (ariaKey) node.setAttribute("aria-label", t(ariaKey));
      const placeholderKey = node.getAttribute("data-i18n-placeholder");
      if (placeholderKey) node.setAttribute("placeholder", t(placeholderKey));
    });
}

/* One picker skill row (C36): drag handle, icon, label, prompt/search actions
 * and the per-row enable switch.
 *
 * The switch keeps the legacy `settings.aria.enableSkill` label so the row is
 * operable without the visual label, and disabled rows stay visible but are not
 * draggable (`data-disabled`, legacy `is-disabled` + `draggable=false`).
 */
import type { ReactNode } from "react";
import {
  ArrowUpRight,
  BookOpen,
  Briefcase,
  Code,
  Copy,
  Earth,
  GripVertical,
  Hash,
  Languages,
  LayoutGrid,
  Lightbulb,
  List,
  MessageCircle,
  Pencil,
  Pen,
  PenLine,
  Pin,
  Quote,
  ScanEye,
  ScanText,
  Scroll,
  Search,
  Sparkles,
  Square,
  Star,
  Type,
  Volume2,
  WandSparkles,
  Zap,
  type LucideIcon,
} from "lucide-react";

import { Switch } from "@/components/ui/switch";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { SkillMeta } from "@/lib/settings/skills";

import type { DragHandlers } from "./useDragReorder";

/** Built-in + legacy-alias icon names used by the rows we render today. */
const ICONS: Record<string, LucideIcon> = {
  languages: Languages,
  list: List,
  lightbulb: Lightbulb,
  "wand-sparkles": WandSparkles,
  "volume-2": Volume2,
  copy: Copy,
  "scan-eye": ScanEye,
  search: Search,
  sparkles: Sparkles,
  pin: Pin,
  square: Square,
  "arrow-up-right": ArrowUpRight,
  pen: Pen,
  "pen-line": PenLine,
  type: Type,
  hash: Hash,
  "layout-grid": LayoutGrid,
  "scan-text": ScanText,
  scroll: Scroll,
  "message-circle": MessageCircle,
  zap: Zap,
  "book-open": BookOpen,
  earth: Earth,
  code: Code,
  quote: Quote,
  briefcase: Briefcase,
  star: Star,
};

export interface SkillRowProps {
  meta: SkillMeta;
  label: string;
  description?: string;
  enabled: boolean;
  dragging: boolean;
  dropTarget: boolean;
  custom: boolean;
  canDrag: boolean;
  onToggle: (enabled: boolean) => void;
  drag: DragHandlers;
  onPromptToggle: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  promptOpen: boolean;
  promptNode?: ReactNode;
  searchBadge?: ReactNode;
}

export function SkillRow({
  meta,
  label,
  description,
  enabled,
  dragging,
  dropTarget,
  custom,
  canDrag,
  onToggle,
  drag,
  onPromptToggle,
  onEdit,
  onDelete,
  promptOpen,
  promptNode,
  searchBadge,
}: SkillRowProps) {
  const { t } = useT();
  const Icon = ICONS[meta.icon] ?? Sparkles;
  const hasPrompt = (meta.promptSlots?.length ?? 0) > 0;

  return (
    <li
      data-skill={meta.id}
      data-testid={`skill-row-${meta.id}`}
      data-disabled={enabled ? undefined : "true"}
      className={cn(
        "rounded-md border bg-card transition-shadow",
        !enabled && "opacity-60",
        dragging && "opacity-40",
        dropTarget && "ring-1 ring-primary"
      )}
      {...drag}
    >
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        <span
          role="img"
          aria-label={t(
            enabled ? "settings.aria.dragReorder" : "settings.aria.dragReorderDisabled"
          )}
          title={t(
            enabled ? "settings.aria.dragReorder" : "settings.aria.dragReorderDisabled"
          )}
          draggable={canDrag}
          data-testid={`skill-handle-${meta.id}`}
          className={cn("shrink-0 text-muted-foreground", canDrag ? "cursor-grab" : "cursor-default")}
        >
          <GripVertical className="h-4 w-4" aria-hidden="true" />
        </span>
        <span aria-hidden="true" className="shrink-0 text-muted-foreground">
          <Icon className="h-4 w-4" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium">{label}</span>
          {description ? (
            <span className="line-clamp-1 text-xs text-muted-foreground">{description}</span>
          ) : null}
        </div>
        {hasPrompt ? (
          <button
            type="button"
            aria-label={t("settings.action.editPrompt")}
            aria-expanded={promptOpen}
            title={t("settings.action.editPrompt")}
            data-prompt-toggle={meta.id}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={onPromptToggle}
          >
            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        ) : null}
        {searchBadge}
        {custom && onEdit ? (
          <button
            type="button"
            aria-label={t("settings.action.editSkill")}
            title={t("settings.action.editSkill")}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={onEdit}
          >
            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        ) : null}
        {custom && onDelete ? (
          <button
            type="button"
            aria-label={t("settings.aria.deleteSkill", { name: label })}
            title={t("settings.action.deleteSkill")}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={onDelete}
          >
            ×
          </button>
        ) : null}
        <Switch
          checked={enabled}
          aria-label={t("settings.aria.enableSkill", { name: label })}
          onCheckedChange={onToggle}
        />
      </div>
      {promptOpen && promptNode ? <div className="px-2.5 pb-2.5">{promptNode}</div> : null}
    </li>
  );
}

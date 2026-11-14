/* Card scaffold shared by the six settings sections (S1/S8).
 *
 * The `<section data-card={id} aria-labelledby>` shape is the contract later
 * tasks (and the shell tests) rely on, so cards never hand-roll their outer
 * element. Visual tokens stay on the spec side: white surface, 1px border,
 * 12px radius, no shadow or gradient.
 */
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export interface SectionCardProps {
  id: string;
  title: string;
  description?: string;
  badge?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function SectionCard({
  id,
  title,
  description,
  badge,
  children,
  className,
}: SectionCardProps) {
  return (
    <section
      data-card={id}
      aria-labelledby={`${id}-title`}
      className={cn(
        "rounded-xl border bg-card text-card-foreground",
        className
      )}
    >
      <div className="flex items-start justify-between gap-4 px-6 pb-4 pt-5">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id={`${id}-title`} className="text-base font-semibold leading-tight">
            {title}
          </h2>
          {description ? (
            <p className="text-sm text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {badge ? <div className="flex shrink-0 items-center gap-2">{badge}</div> : null}
      </div>
      <div className="px-6 pb-5">{children}</div>
    </section>
  );
}

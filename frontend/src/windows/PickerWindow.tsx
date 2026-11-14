export type PickerSurface = "panel" | "toolbar";

export function PickerWindow({ surface = "panel" }: { surface?: PickerSurface }) {
  return (
    <div data-testid="surface" className="h-full w-full bg-background text-foreground">
      {surface}
    </div>
  );
}

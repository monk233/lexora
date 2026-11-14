/* Two-step confirmation for destructive buttons (inventory §S6, assertion 39).
 *
 * The legacy page armed a button for four seconds: the first click swapped the
 * label to "确认…", a second click within the window ran the action, and the
 * timeout disarmed it silently. `armed` is the render-time signal for that
 * label swap; `arm()` is both the first and the confirming click.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export const ARMED_CONFIRM_MS = 4000;

export interface ArmedConfirm {
  armed: boolean;
  /** First call arms, a second call within `timeoutMs` confirms. */
  arm: () => void;
  /** Disarm without confirming (Esc, another action taking focus, unmount). */
  cancel: () => void;
}

export function useArmedConfirm(
  onConfirm: () => void,
  timeoutMs: number = ARMED_CONFIRM_MS
): ArmedConfirm {
  const [armed, setArmed] = useState(false);
  /* The ref keeps `arm` stable and immune to a stale render closure; without it
   * two clicks in the same tick would both see `armed === false`. */
  const armedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onConfirmRef = useRef(onConfirm);
  onConfirmRef.current = onConfirm;

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const setArmedState = useCallback((next: boolean) => {
    armedRef.current = next;
    setArmed(next);
  }, []);

  const cancel = useCallback(() => {
    clearTimer();
    setArmedState(false);
  }, [clearTimer, setArmedState]);

  const arm = useCallback(() => {
    if (armedRef.current) {
      clearTimer();
      setArmedState(false);
      onConfirmRef.current();
      return;
    }
    clearTimer();
    setArmedState(true);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setArmedState(false);
    }, timeoutMs);
  }, [clearTimer, setArmedState, timeoutMs]);

  useEffect(() => clearTimer, [clearTimer]);

  return { armed, arm, cancel };
}

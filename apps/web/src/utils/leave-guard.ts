/*
 * Leaving the editor while the design is still locked to you is allowed,
 * but never silent: the app asks first (see docs/AGENT_API.md, "Lock
 * model"). The editor registers a guard; App consults it on every hash
 * change and puts the editor's address back while the question is open.
 */

type Guard = (targetHash: string) => boolean;

let guard: Guard | null = null;
let bypass = false;

/** Registered by the editor: returns true to hold a navigation (and ask). */
export function setLeaveGuard(next: Guard | null): void {
  guard = next;
}

/** True when navigating to `targetHash` must wait for the person's answer. */
export function shouldHoldNavigation(targetHash: string): boolean {
  if (bypass) {
    bypass = false;
    return false;
  }
  return guard?.(targetHash) ?? false;
}

/** Navigates without asking (after the person chose how to leave). */
export function leaveTo(targetHash: string): void {
  bypass = true;
  window.location.hash = targetHash;
}

/**
 * The life of one mounted screen. What a screen does after an await (navigate
 * after a save, focus a field) goes through `active`, so a response that
 * arrives after the user left starts nothing. Stores keep their own state:
 * their data and their writes do not depend on any screen.
 */
export interface ScreenScope {
  readonly active: boolean;
  dispose(): void;
}

export function createScreenScope(): ScreenScope {
  let active = true;
  return {
    get active() {
      return active;
    },
    dispose() {
      active = false;
    },
  };
}

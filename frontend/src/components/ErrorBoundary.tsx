import { Component, type ReactNode } from 'react';
import { Button } from './Button';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Catches render errors (including a page chunk that cannot be downloaded).
 * "Try again" reloads the page, so stores that may hold the data that broke
 * the screen start over. `RouteBoundary` gives each page its own, reset on
 * every route change; the one in App.tsx only catches the shell.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override render() {
    if (this.state.error === null) return this.props.children;
    return (
      <div className="mx-auto flex min-h-64 max-w-md flex-col items-center justify-center gap-4 p-6 text-center">
        <div role="alert" data-testid="error-boundary" className="space-y-2">
          <h1 className="text-xl font-semibold">Something went wrong</h1>
          <p className="text-slate-600">The page could not be displayed. Reloading usually fixes it.</p>
        </div>
        <Button onClick={() => window.location.reload()} data-testid="error-boundary-reload">
          Try again
        </Button>
      </div>
    );
  }
}

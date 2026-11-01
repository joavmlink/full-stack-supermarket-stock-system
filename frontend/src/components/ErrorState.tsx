import { Button } from './Button';
import { Notice } from './feedback';

/** A failed load, with "Retry" when the user can do something about it. */
export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <Notice tone="error" role="alert" testId="error-state">
      <p>{message}</p>
      {onRetry && (
        <Button variant="secondary" className="mt-3" onClick={onRetry} data-testid="retry-button">
          Retry
        </Button>
      )}
    </Notice>
  );
}

import { useEffect } from 'react';

const APP_NAME = 'Supermarket Stock';

/** "Products · Supermarket Stock": screen readers announce it and tabs show where the user is. */
export function useDocumentTitle(title: string) {
  useEffect(() => {
    document.title = `${title} · ${APP_NAME}`;
  }, [title]);
}

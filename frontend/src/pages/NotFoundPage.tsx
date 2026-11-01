import { Link } from 'react-router';
import { textLinkClass } from '../components/feedback';

export default function NotFoundPage() {
  return (
    <section data-testid="not-found" className="space-y-3">
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <p className="text-slate-600">The page you are looking for does not exist.</p>
      <Link to="/" className={textLinkClass}>
        Go to products
      </Link>
    </section>
  );
}

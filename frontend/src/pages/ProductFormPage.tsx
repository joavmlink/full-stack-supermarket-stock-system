import { useEffect } from 'react';
import { Link, useParams } from 'react-router';
import { useStore } from 'zustand';
import type { Product } from '../api/types';
import { Button } from '../components/Button';
import { EditorActions } from '../components/EditorActions';
import { EditorGate } from '../components/EditorGate';
import { Notice, PageHeader, WriteStatus, textLinkClass } from '../components/feedback';
import { SelectField, TextAreaField, TextField } from '../components/fields';
import { useDocumentTitle } from '../hooks/use-document-title';
import { useEditorForm } from '../hooks/use-editor-form';
import {
  PRODUCT_LABELS,
  PRODUCT_LIMITS,
  emptyProductForm,
  productFieldsToForm,
  productToForm,
  validateProductForm,
} from '../lib/forms';
import { categoriesStore, productEditorStore } from '../stores';
import { editorDraft } from '../stores/editor-store';

/** Create (`/products/new`) and edit (`/products/:id/edit`); admins only. */
export default function ProductFormPage() {
  const { id = null } = useParams();
  const title = id === null ? 'New product' : 'Edit product';
  useDocumentTitle(title);

  useEffect(() => {
    void categoriesStore.getState().load();
  }, []);

  return (
    <section className="max-w-2xl" data-testid="product-form-page">
      <PageHeader title={title}>
        <Link to="/" className={textLinkClass}>
          Back to products
        </Link>
      </PageHeader>
      <EditorGate
        store={productEditorStore}
        id={id}
        errorText="Could not load the product."
        notFound={
          <div className="space-y-2" data-testid="product-not-found">
            <p className="font-semibold">Product not found.</p>
            <p className="text-slate-600">It may have been deleted.</p>
          </div>
        }
      >
        {(product) => <ProductForm product={product} />}
      </EditorGate>
    </section>
  );
}

function ProductForm({ product }: { product: Product | null }) {
  const categories = useStore(categoriesStore, (state) => state.items);
  const categoriesStatus = useStore(categoriesStore, (state) => state.status);
  const form = useEditorForm(productEditorStore, {
    initial: () => {
      // A save still unfinished from an earlier visit shows what it sent.
      const draft = editorDraft(productEditorStore.getState());
      if (draft !== undefined) return productFieldsToForm(draft);
      return product === null ? emptyProductForm() : productToForm(product);
    },
    validate: validateProductForm,
    labels: PRODUCT_LABELS,
    doneTo: '/',
  });
  const { values, save, busy } = form;

  const noCategories = categoriesStatus === 'loaded' && categories.length === 0;

  return (
    <form onSubmit={form.onSubmit} noValidate className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 sm:p-6" data-testid="product-form">
      {noCategories && (
        <Notice tone="warning" role="status">
          Every product needs a category.{' '}
          <Link to="/categories" className={textLinkClass}>
            Create a category first
          </Link>
          .
        </Notice>
      )}
      <fieldset disabled={busy} className="space-y-4">
        <SelectField label="Category" value={values.categoryId} onChange={form.set('categoryId')} error={form.errorOf('categoryId')} testId="product-category">
          <option value="">Choose a category</option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
          {product !== null && !categories.some((category) => category.id === product.category.id) && (
            <option value={product.category.id}>{product.category.name}</option>
          )}
        </SelectField>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="Name"
            value={values.name}
            onChange={form.set('name')}
            error={form.errorOf('name')}
            maxLength={PRODUCT_LIMITS.name}
            testId="product-name-input"
          />
          <TextField
            label="Brand"
            value={values.brand}
            onChange={form.set('brand')}
            error={form.errorOf('brand')}
            maxLength={PRODUCT_LIMITS.brand}
            testId="product-brand"
          />
        </div>
        <TextAreaField
          label="Description (optional)"
          value={values.description}
          onChange={form.set('description')}
          error={form.errorOf('description')}
          maxLength={PRODUCT_LIMITS.description}
          testId="product-description"
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="Price (ARS)"
            inputMode="decimal"
            autoComplete="off"
            placeholder="1.234,56"
            value={values.price}
            onChange={form.set('price')}
            error={form.errorOf('price')}
            hint="Use a comma for decimals, like 1.234,56."
            testId="product-price-input"
          />
          <TextField
            label="Quantity in stock"
            inputMode="numeric"
            autoComplete="off"
            value={values.quantity}
            onChange={form.set('quantity')}
            error={form.errorOf('quantity')}
            hint={product === null ? 'Initial stock (recorded as an adjustment).' : 'A change is recorded as an adjustment.'}
            testId="product-quantity"
          />
        </div>
      </fieldset>

      <WriteStatus state={save} onRetry={form.retrySave} explainedOnFields={form.explainedOnFields} testId="save-status" />
      {save.status === 'rejected' && save.code === 'PRODUCT_VERSION_CONFLICT' && (
        <Button variant="secondary" onClick={() => void productEditorStore.getState().reload()} data-testid="load-latest">
          Load the latest version (replaces your changes)
        </Button>
      )}

      <EditorActions form={form} noun="product" deleteQuestion={product === null ? null : `Delete ${product.name}?`} />
    </form>
  );
}

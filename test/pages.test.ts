/**
 * Pages payload contract (protocol v1).
 *
 * `pages` is read-only access to the **signed-in user's own** storefronts and
 * the products on them. The interesting assertions are therefore about its
 * edges rather than its happy path: that an id the user does not own is an
 * authorization answer and not a "not found", that a product payload carries
 * no identifier two micro-apps could join on, and that a malformed pageId
 * never reaches the wire.
 *
 * The wire-level vectors live in protocol/vectors/methods/ and are run by
 * test/protocol/methods.test.ts; what is covered here is the page-side
 * behaviour of the typed wrappers.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { HoomiError, ScopeNotGrantedError, UnsupportedError, type HoomiProduct } from '../src/index.js';
import { createTestHoomi, type TestHoomi } from '../src/testing/index.js';

let active: TestHoomi[] = [];
const make = (...args: Parameters<typeof createTestHoomi>): TestHoomi => {
  const t = createTestHoomi(...args);
  active.push(t);
  return t;
};

afterEach(() => {
  for (const t of active) t.cleanup();
  active = [];
});

const pagesCalls = (host: TestHoomi['host']) => host.calls.filter((c) => c.method.startsWith('pages.'));

describe('pages.list', () => {
  it('answers with the user-owned pages under "pages" and sends no params', async () => {
    const { hoomi, host } = make();
    const { pages } = await hoomi.pages.list();

    expect(Array.isArray(pages)).toBe(true);
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({ id: 1 });
    expect(typeof pages[0]?.name).toBe('string');
    expect(typeof pages[0]?.followers).toBe('number');
    expect(host.calls.find((c) => c.method === 'pages.list')?.params).toEqual({});
  });

  it('reflects a seeded set of owned pages', async () => {
    const { hoomi } = make({
      pages: [
        { page: { id: 7, name: 'Toko Bunga', followers: 3 } },
        { page: { id: 9, name: 'Warung Kopi', category: 'Food', followers: 0 } },
      ],
    });
    const { pages } = await hoomi.pages.list();
    expect(pages.map((p) => p.id)).toEqual([7, 9]);
    // Absent optionals are omitted, not sent as null.
    expect(Object.keys(pages[0] ?? {}).sort()).toEqual(['followers', 'id', 'name']);
  });

  it('an empty seed is an empty list, not an error', async () => {
    const { hoomi } = make({ pages: [] });
    expect(await hoomi.pages.list()).toEqual({ pages: [] });
  });
});

describe('pages.get', () => {
  it('resolves to the page object itself, not a wrapper', async () => {
    const { hoomi, host } = make();
    const page = await hoomi.pages.get({ pageId: 1 });
    expect(page.id).toBe(1);
    expect(page).not.toHaveProperty('page');
    expect(host.calls.find((c) => c.method === 'pages.get')?.params).toEqual({ pageId: 1 });
  });

  it('answers E_SCOPE_DENIED for a page the user does not own', async () => {
    const { hoomi } = make();
    const err = await hoomi.pages.get({ pageId: 999_999 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScopeNotGrantedError);
    expect((err as HoomiError).code).toBe('E_SCOPE_DENIED');
  });

  it('gives the same answer for an unowned page and one that does not exist', async () => {
    // If those two differed, pages.get would be an enumeration oracle over
    // every Page in Hoomi — which is the whole reason this namespace is
    // scoped to the user's own storefronts.
    const { hoomi } = make({ pages: [{ page: { id: 4, name: 'Mine', followers: 1 } }] });
    const someoneElse = await hoomi.pages.get({ pageId: 5 }).catch((e: unknown) => e);
    const nonexistent = await hoomi.pages.get({ pageId: 8_000_001 }).catch((e: unknown) => e);
    expect((someoneElse as HoomiError).code).toBe('E_SCOPE_DENIED');
    expect((nonexistent as HoomiError).code).toBe((someoneElse as HoomiError).code);
  });

  it('rejects a malformed pageId BEFORE it reaches the wire', async () => {
    const { hoomi, host } = make();
    await hoomi.ready();

    // TypeScript cannot express "positive integer", so 1.5 type-checks fine.
    const bad: unknown[] = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '1', null, undefined, 2 ** 53];
    for (const pageId of bad) {
      const err = await hoomi.pages.get({ pageId } as never).catch((e: unknown) => e);
      expect((err as HoomiError).code, `pageId=${String(pageId)}`).toBe('E_INVALID_PARAMS');
      expect((err as HoomiError).message).toContain('pageId');
    }
    expect(pagesCalls(host)).toEqual([]);
    expect(host.frames.filter((f) => f.frame.includes('pages.get'))).toEqual([]);
  });

  it('requires pageId at the type level too', async () => {
    const { hoomi } = make();
    // @ts-expect-error — pageId is required.
    const err = await hoomi.pages.get({}).catch((e: unknown) => e);
    expect((err as HoomiError).code).toBe('E_INVALID_PARAMS');
  });
});

describe('pages.listProducts', () => {
  it('answers with the products under "products", each echoing its pageId', async () => {
    const { hoomi, host } = make();
    const { products } = await hoomi.pages.listProducts({ pageId: 1 });
    expect(products).toHaveLength(1);
    expect(products[0]?.pageId).toBe(1);
    expect(host.calls.find((c) => c.method === 'pages.listProducts')?.params).toEqual({ pageId: 1 });
  });

  it('prices are integer minor units and never a string', async () => {
    const { hoomi } = make();
    const { products } = await hoomi.pages.listProducts({ pageId: 1 });
    for (const product of products) {
      // The catalogue stores prices as strings; the host parses them, so a
      // string price is a host bug the SDK must not paper over.
      expect(typeof product.priceMinor).toBe('number');
      expect(Number.isSafeInteger(product.priceMinor)).toBe(true);
      expect(typeof product.currency).toBe('string');
      expect(product).not.toHaveProperty('price');
    }
  });

  it('a product payload carries NO user or seller identifier', async () => {
    const { hoomi } = make();
    const { products } = await hoomi.pages.listProducts({ pageId: 1 });
    const product = products[0] as HoomiProduct;

    // These are the signed-in user's own products: there is no counterparty to
    // name, and a stable id here would be something two micro-apps could join
    // on. The v1 product shape is exactly these keys.
    expect(Object.keys(product).sort()).toEqual([
      'currency',
      'description',
      'id',
      'imageUrls',
      'name',
      'pageId',
      'priceMinor',
      'stock',
    ]);
    for (const key of Object.keys(product)) {
      expect(key, `product must not carry "${key}"`).not.toMatch(/user|seller|owner|account|merchant/i);
    }
  });

  it('an unowned pageId is E_SCOPE_DENIED, not an empty product list', async () => {
    const { hoomi } = make();
    const err = await hoomi.pages.listProducts({ pageId: 999_999 }).catch((e: unknown) => e);
    expect((err as HoomiError).code).toBe('E_SCOPE_DENIED');
  });

  it('validates pageId page-side, like get', async () => {
    const { hoomi, host } = make();
    const err = await hoomi.pages.listProducts({ pageId: -3 }).catch((e: unknown) => e);
    expect((err as HoomiError).code).toBe('E_INVALID_PARAMS');
    expect(pagesCalls(host)).toEqual([]);
  });

  it('an owned page with nothing listed answers an empty array', async () => {
    const { hoomi } = make({ pages: [{ page: { id: 2, name: 'Empty Shelf', followers: 0 } }] });
    expect(await hoomi.pages.listProducts({ pageId: 2 })).toEqual({ products: [] });
  });
});

describe('pages availability', () => {
  it('a host with no pages provider answers E_UNSUPPORTED, not E_NOT_IMPLEMENTED', async () => {
    // E_UNSUPPORTED is permanent for this host build, so the SDK may cache it
    // and hide the feature; E_NOT_IMPLEMENTED would mean version skew.
    const { hoomi } = make({ capabilities: ['lifecycle', 'ui', 'storage', 'system'] });
    expect(hoomi.hasCapability('pages')).toBe(false);
    const err = await hoomi.pages.list().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnsupportedError);
    expect((err as HoomiError).code).toBe('E_UNSUPPORTED');
  });

  it('without the pages scope every method is E_SCOPE_DENIED', async () => {
    const { hoomi } = make({ scopes: ['profile'] });
    for (const call of [hoomi.pages.list(), hoomi.pages.get({ pageId: 1 }), hoomi.pages.listProducts({ pageId: 1 })]) {
      const err = await call.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ScopeNotGrantedError);
    }
  });

  it('setPages replaces what the user owns', async () => {
    const { hoomi, host } = make();
    expect((await hoomi.pages.list()).pages.map((p) => p.id)).toEqual([1]);
    host.setPages([{ page: { id: 42, name: 'Rebranded', followers: 12 }, products: [] }]);
    expect((await hoomi.pages.list()).pages.map((p) => p.id)).toEqual([42]);
    // ...and page 1 is now somebody else's.
    const err = await hoomi.pages.get({ pageId: 1 }).catch((e: unknown) => e);
    expect((err as HoomiError).code).toBe('E_SCOPE_DENIED');
  });
});
